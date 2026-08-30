/**
 * 阵法编排 · 工作流 DAG 画布
 *
 * 画布是可编辑的，但**图必须先通过校验才允许保存或执行**（validateWorkflow）：
 * 唯一起点、存在终点、无悬空连线、顺序流不成环。回流是显式的——只有标记
 * 为"迭代边"的连线才允许成环，执行器据此限次重入，因此"画错了"和"刻意
 * 迭代"在数据结构上就是两件事。
 *
 * 执行结果以慢镜头回放（按 nodeLog 逐条推进节点状态），因为编排的价值
 * 一半在于"它到底走了哪条路径"：分支命中了哪个条件、迭代重入了几次、
 * 在哪一步失败——这些只有回放才看得见。
 */
import { api } from "../api.js";
import { el, esc, badge, toast, empty, modal, confirmDialog, fmtTime } from "../app.js";
import { WF_NODE_TYPES, validateWorkflow, topoOrder } from "../kb.js";

const NODE_W = 168;
const NODE_H = 84;
const REPLAY_MS = 420;

export async function renderWorkflow(root) {
  const wrap = el("div", "");

  let workflows = [];
  let wf = null;
  let selected = null;
  let mode = "select";     // select | connect | delete
  let connectFrom = null;
  let scale = 1;
  let pan = { x: 0, y: 0 };
  let tools = [];
  let runState = null;     // 最近一次运行
  let replayTimer = null;

  try {
    workflows = await api.workflows();
    tools = (await api.pae().catch(() => ({ tools: [] }))).tools ?? [];
  } catch (err) {
    root.append(el("div", "alert err", `<span>⚠</span><span class="msg">无法加载工作流：${esc(err.message)}</span>`));
    return { dispose() {} };
  }

  /* ---------------- 工具栏 ---------------- */

  const sel = el("select", "select");
  sel.style.maxWidth = "220px";
  const refreshSel = () => {
    sel.replaceChildren();
    for (const w of workflows) {
      const o = el("option", "", `${esc(w.name)}（${w.nodeCount} 节点）`);
      o.value = w.id;
      sel.append(o);
    }
    if (wf) sel.value = wf.id;
  };
  refreshSel();
  sel.addEventListener("change", () => load(sel.value));

  const btn = (text, cls, fn) => {
    const b = el("button", `btn sm ${cls}`, esc(text));
    b.type = "button";
    b.addEventListener("click", fn);
    return b;
  };

  const typeSel = el("select", "select");
  typeSel.style.maxWidth = "130px";
  for (const [k, meta] of Object.entries(WF_NODE_TYPES)) {
    const o = el("option", "", `${esc(meta.label)}`);
    o.value = k;
    typeSel.append(o);
  }
  typeSel.value = "agent";

  const validateBadge = el("span", "badge neutral", "—");
  const setValidateBadge = (text, tone) => {
    validateBadge.className = `badge ${tone}`;
    validateBadge.textContent = text;
  };
  const runInput = el("input", "input");
  runInput.placeholder = "运行输入（传给起点节点）";
  runInput.style.maxWidth = "240px";

  const toolbar = el("div", "wf-toolbar");
  toolbar.append(
    sel,
    btn("＋ 新建", "", () => createWorkflow()),
    btn("保存", "primary", () => save()),
    btn("删除", "danger", () => remove()),
    el("span", "hint", "│"),
    typeSel,
    btn("＋ 节点", "", () => addNode(typeSel.value)),
    btn("配置", "", () => { if (selected) openConfig(selected); else toast("先选中一个节点", "err"); }),
    btn("连线", "", () => toggleConnect()),
    btn("删元素", "danger", () => toggleDelete()),
    el("span", "grow spread"),
    validateBadge,
    runInput,
    btn("▶ 运行", "primary", () => run())
  );

  /* ---------------- 画布 ---------------- */

  const canvasWrap = el("div", "wf-canvas-wrap");
  canvasWrap.append(el("div", "wf-grid"));

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "wf-canvas");
  svg.innerHTML = `
    <defs>
      <linearGradient id="wf-flow-grad" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" stop-color="#6366F1" />
        <stop offset="100%" stop-color="#38BDF8" />
      </linearGradient>
    </defs>`;
  const edgeGroup = document.createElementNS("http://www.w3.org/2000/svg", "g");
  svg.append(edgeGroup);

  const world = el("div", "");
  world.style.cssText = "position:absolute;inset:0;transform-origin:0 0";
  canvasWrap.append(svg, world);

  const zoomBox = el("div", "wf-pan-zoom");
  zoomBox.append(
    btn("＋", "", () => { scale = Math.min(1.6, scale + 0.1); applyTransform(); }),
    btn("－", "", () => { scale = Math.max(0.5, scale - 0.1); applyTransform(); }),
    btn("⤢", "", () => { scale = 1; pan = { x: 0, y: 0 }; applyTransform(); })
  );

  const legend = el("div", "wf-legend");
  legend.innerHTML = `
    <span><i style="background:#6B7280"></i>待执行</span>
    <span><i style="background:#6366F1"></i>执行中</span>
    <span><i style="background:#22D3EE"></i>完成</span>
    <span><i style="background:#FB923C"></i>迭代</span>
    <span><i style="background:#EF4444"></i>失败</span>
    <span><i style="background:#FB923C;opacity:.6"></i>迭代边（可回流）</span>`;

  const shell = el("div", "wf-shell");
  shell.append(toolbar, canvasWrap, zoomBox, legend);

  /* ---------------- 校验 / 日志 / 结果 ---------------- */

  const checksBox = el("div", "");
  const logBox = el("div", "");
  const resultBox = el("div", "");

  const lower = el("div", "grid cols-2 mt16");
  lower.append(
    cardOf("图校验", checksBox),
    el("div", "", [cardOf("执行日志", logBox), el("div", "section-gap"), cardOf("运行结果", resultBox)])
  );

  wrap.append(shell, lower);
  root.append(wrap);

  /* ---------------- 画布交互 ---------------- */

  canvasWrap.addEventListener("mousedown", (e) => {
    if (e.target.closest(".wf-node")) return;
    const start = { x: e.clientX, y: e.clientY, pan: { ...pan } };
    canvasWrap.classList.add("panning");
    const move = (ev) => {
      pan = { x: start.pan.x + (ev.clientX - start.x), y: start.pan.y + (ev.clientY - start.y) };
      applyTransform();
    };
    const up = () => {
      canvasWrap.classList.remove("panning");
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  });

  function applyTransform() {
    const t = `translate(${pan.x}px, ${pan.y}px) scale(${scale})`;
    world.style.transform = t;
    edgeGroup.setAttribute("transform", `translate(${pan.x} ${pan.y}) scale(${scale})`);
  }

  /* ---------------- 渲染 ---------------- */

  function render() {
    stopReplay();
    world.replaceChildren();
    edgeGroup.replaceChildren();

    for (const edge of wf.edges) drawEdge(edge);
    for (const node of wf.nodes) world.append(nodeEl(node));

    const check = validateWorkflow(wf);
    const order = topoOrder(wf);
    const blocking = check.errors.some((x) => x.level === "err");
    setValidateBadge(
      blocking ? "校验未通过" : check.errors.length ? "可运行（有告警）" : "校验通过",
      blocking ? "err" : check.errors.length ? "warn" : "ok"
    );

    const list = el("div", "ver-list");
    if (check.errors.length === 0) {
      list.append(el("div", "ver-item", `${badge("通过", "ok")}<span class="ver-meta">结构合法：唯一起点、存在终点、顺序流无环、无悬空连线。</span>`));
    } else {
      for (const err of check.errors) {
        list.append(el("div", "ver-item", `
          ${badge(err.level === "err" ? "阻断" : "告警", err.level === "err" ? "err" : "warn")}
          <span class="ver-meta">${esc(err.text)}</span>`));
      }
    }
    list.append(el("div", "ver-item", `
      ${badge("执行序", "neutral")}
      <span class="ver-meta mono">${order ? order.join(" → ") : "顺序流存在环，无法拓扑排序"}</span>`));
    checksBox.replaceChildren(list);
  }

  function nodeEl(node) {
    const meta = WF_NODE_TYPES[node.type] ?? { label: node.type, sigil: "?" };
    const state = runState?.nodeStates?.[node.id] ?? "idle";
    const n = el("div", `wf-node st-${state}${selected === node.id ? " selected" : ""}`, `
      <div class="wn-sigil">${esc(meta.sigil)}</div>
      <div class="wn-head">
        <span class="wn-title">${esc(node.title || node.id)}</span>
      </div>
      <div class="wn-type">${esc(meta.label)}</div>
      <div class="wn-sub">${esc(nodeSub(node))}</div>
      <div class="wn-meta"><span>${esc(node.id)}</span></div>`);
    n.style.left = `${node.x}px`;
    n.style.top = `${node.y}px`;
    n.dataset.nodeId = node.id;

    n.addEventListener("mousedown", (e) => {
      e.stopPropagation();
      if (mode === "connect") {
        if (!connectFrom) {
          connectFrom = node.id;
          toast(`已选起点 ${node.id}，再点一次目标节点（按住 Shift 建立迭代边）`, "accent", 2500);
        } else {
          addEdge(connectFrom, node.id, e.shiftKey ? "loop" : "flow");
          connectFrom = null;
        }
        return;
      }
      if (mode === "delete") {
        removeElement(node.id, null);
        return;
      }
      selected = node.id;
      render();
      startDrag(node, e);
    });

    n.addEventListener("dblclick", () => openConfig(node));
    return n;
  }

  function startDrag(node, e) {
    const start = { x: e.clientX, y: e.clientY, nx: node.x, ny: node.y };
    const move = (ev) => {
      node.x = Math.max(0, Math.round(start.nx + (ev.clientX - start.x) / scale));
      node.y = Math.max(0, Math.round(start.ny + (ev.clientY - start.y) / scale));
      const el2 = world.querySelector(`[data-node-id="${node.id}"]`);
      if (el2) {
        el2.style.left = `${node.x}px`;
        el2.style.top = `${node.y}px`;
      }
      redrawEdges();
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }

  function drawEdge(edge) {
    const a = wf.nodes.find((n) => n.id === edge.from);
    const b = wf.nodes.find((n) => n.id === edge.to);
    if (!a || !b) return;
    const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
    g.setAttribute("class", `wf-edge${edge.kind === "loop" ? " loop" : ""}`);
    g.dataset.from = edge.from;
    g.dataset.to = edge.to;

    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", edgePath(a, b, edge.kind));
    g.append(path);

    const dash = document.createElementNS("http://www.w3.org/2000/svg", "path");
    dash.setAttribute("class", "wf-dash");
    dash.setAttribute("d", path.getAttribute("d"));
    dash.setAttribute("stroke", edge.kind === "loop" ? "rgba(251,146,60,0.9)" : "url(#wf-flow-grad)");
    dash.setAttribute("stroke-width", "2");
    dash.setAttribute("fill", "none");
    dash.setAttribute("stroke-dasharray", "6 6");
    g.append(dash);

    g.addEventListener("click", () => {
      if (mode === "delete") {
        wf.edges = wf.edges.filter((e) => !(e.from === edge.from && e.to === edge.to));
        render();
        return;
      }
      edge.kind = edge.kind === "loop" ? "flow" : "loop";
      toast(`连线 ${edge.from} → ${edge.to} 切换为${edge.kind === "loop" ? "迭代边（允许回流）" : "顺序流"}`, "accent", 2000);
      render();
    });
    edgeGroup.append(g);
  }

  function redrawEdges() {
    edgeGroup.replaceChildren();
    for (const edge of wf.edges) drawEdge(edge);
  }

  function edgePath(a, b, kind) {
    const x1 = a.x + NODE_W;
    const y1 = a.y + NODE_H / 2;
    const x2 = b.x;
    const y2 = b.y + NODE_H / 2;
    if (kind === "loop") {
      /* 迭代边走外侧弧线，与顺序流在视觉上区分开 */
      const cx = (x1 + x2) / 2;
      return `M ${x1} ${y1} C ${cx + 60} ${y1 - 90}, ${cx - 60} ${y2 + 90}, ${x2} ${y2}`;
    }
    const dx = Math.max(40, Math.abs(x2 - x1) * 0.45);
    return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
  }

  /* ---------------- 图编辑 ---------------- */

  function nodeSub(node) {
    if (node.type === "agent") return node.config?.instruct ?? "未配置人设";
    if (node.type === "tool") return node.config?.toolName ? `工具：${node.config.toolName}` : "未选择工具";
    if (node.type === "branch") {
      const conds = node.config?.conditions ?? [];
      return conds.length ? conds.map((c) => c.match || "默认").join(" / ") : "无条件（等同顺序）";
    }
    return WF_NODE_TYPES[node.type]?.desc ?? "";
  }

  function addNode(type) {
    const id = `${type[0]}${Date.now().toString(36).slice(-4)}`;
    wf.nodes.push({
      id,
      type,
      title: WF_NODE_TYPES[type].label,
      x: 80 + (wf.nodes.length % 4) * 200,
      y: 80 + Math.floor(wf.nodes.length / 4) * 140,
      config: type === "branch" ? { conditions: [], defaultTo: null } : {}
    });
    selected = id;
    render();
    toast(`已添加${WF_NODE_TYPES[type].label}节点 ${id}`, "ok", 1500);
  }

  function addEdge(from, to, kind) {
    if (from === to) { toast("节点不能连到自己", "err"); return; }
    if (wf.edges.some((e) => e.from === from && e.to === to)) { toast("该连线已存在", "err"); return; }
    wf.edges.push({ from, to, kind });
    render();
    toast(`已连接 ${from} → ${to}（${kind === "loop" ? "迭代边" : "顺序流"}）`, "ok", 1500);
  }

  function removeElement(nodeId) {
    wf.nodes = wf.nodes.filter((n) => n.id !== nodeId);
    wf.edges = wf.edges.filter((e) => e.from !== nodeId && e.to !== nodeId);
    if (selected === nodeId) selected = null;
    render();
  }

  function toggleConnect() {
    mode = mode === "connect" ? "select" : "connect";
    connectFrom = null;
    toast(mode === "connect" ? "连线模式：点起点 → 点终点（Shift 建迭代边）" : "已退出连线模式", "accent", 2000);
  }

  function toggleDelete() {
    mode = mode === "delete" ? "select" : "delete";
    toast(mode === "delete" ? "删除模式：点节点或连线即删除" : "已退出删除模式", "accent", 2000);
  }

  function openConfig(node) {
    const body = el("div", "");
    const titleF = el("input", "input");
    titleF.value = node.title ?? "";

    const cfg = node.config ?? (node.config = {});
    const extra = el("div", "");
    let collect = () => {};

    if (node.type === "agent") {
      const instructF = el("textarea", "input");
      instructF.value = cfg.instruct ?? "";
      const promptF = el("textarea", "input");
      promptF.value = cfg.prompt ?? "";
      extra.append(field("人设指令 instruct", instructF), field("提示词前缀 prompt", promptF));
      collect = () => { cfg.instruct = instructF.value; cfg.prompt = promptF.value; };
    } else if (node.type === "tool") {
      const toolSel = el("select", "select");
      if (tools.length === 0) toolSel.append(el("option", "", "（尚未接驳任何外来工具）"));
      for (const t of tools) toolSel.append(el("option", "", esc(t.name)));
      if (cfg.toolName) toolSel.value = cfg.toolName;
      const argsF = el("textarea", "input");
      argsF.value = cfg.argsJson ?? "";
      argsF.placeholder = '{"city":"Beijing"}';
      extra.append(
        field("工具 toolName", toolSel),
        field("参数 JSON（可空，默认把上游输出作为位置参数）", argsF),
        el("div", "hint", "工具必须先经「异构适配」接驳；未接驳的工具在执行时会被拒绝。")
      );
      collect = () => { cfg.toolName = toolSel.value; cfg.argsJson = argsF.value; };
    } else if (node.type === "branch") {
      const condsBox = el("div", "ver-list");
      const conds = cfg.conditions ?? (cfg.conditions = []);
      const rerender = () => {
        condsBox.replaceChildren();
        conds.forEach((c, i) => {
          const matchF = el("input", "input");
          matchF.value = c.match ?? "";
          matchF.placeholder = "命中文本（包含匹配）";
          const toSel = el("select", "select");
          for (const n of wf.nodes) {
            if (n.id === node.id) continue;
            const o = el("option", "", `${esc(n.title || n.id)}（${esc(n.id)}）`);
            o.value = n.id;
            toSel.append(o);
          }
          toSel.value = c.to ?? "";
          const del = el("button", "btn sm danger", "✕");
          del.type = "button";
          del.addEventListener("click", () => { conds.splice(i, 1); rerender(); });
          matchF.addEventListener("input", () => { c.match = matchF.value; });
          toSel.addEventListener("change", () => { c.to = toSel.value; });
          const rowEl = el("div", "ver-item");
          rowEl.append(matchF, toSel, del);
          condsBox.append(rowEl);
        });
      };
      rerender();
      const addCond = el("button", "btn sm", "＋ 条件");
      addCond.type = "button";
      addCond.addEventListener("click", () => { conds.push({ match: "", to: wf.nodes[0]?.id ?? "" }); rerender(); });

      const defSel = el("select", "select");
      defSel.append(el("option", "", "（无默认出边）"));
      for (const n of wf.nodes) {
        if (n.id === node.id) continue;
        const o = el("option", "", `${esc(n.title || n.id)}（${esc(n.id)}）`);
        o.value = n.id;
        defSel.append(o);
      }
      if (cfg.defaultTo) defSel.value = cfg.defaultTo;
      defSel.addEventListener("change", () => { cfg.defaultTo = defSel.value || null; });

      extra.append(
        field("命中条件（自上而下取第一条命中）", condsBox),
        addCond,
        field("默认出边 defaultTo", defSel)
      );
      /* 条件与默认出边在选择时即时写入，这里无需再收集 */
    } else {
      extra.append(el("div", "hint", `${WF_NODE_TYPES[node.type].label}节点无需额外配置。`));
      extra._collect = () => {};
    }

    body.append(field("节点标题", titleF), extra);

    const m = modal(`配置节点 · ${node.id}（${WF_NODE_TYPES[node.type].label}）`, body, el("div", "row"));
    const cancel = el("button", "btn", "取消");
    const ok = el("button", "btn primary", "保存配置");
    cancel.type = ok.type = "button";
    cancel.addEventListener("click", () => m.close());
    ok.addEventListener("click", () => {
      node.title = titleF.value.trim() || node.title;
      collect();
      m.close();
      render();
      toast("节点配置已更新（记得点“保存”落库）", "accent", 2500);
    });
    m.foot.append(cancel, ok);
  }

  /* ---------------- 运行与慢镜头回放 ---------------- */

  async function run() {
    if (!wf?.id) { toast("请先保存工作流", "err"); return; }
    const check = validateWorkflow(wf);
    if (!check.valid) {
      toast("图校验未通过，无法执行", "err", 3000);
      return;
    }
    runInput.disabled = true;
    logBox.replaceChildren(el("div", "hint", "执行中：按 nodeLog 逐条回放节点状态…"));
    resultBox.replaceChildren(el("div", "hint", "—"));
    try {
      const run = await api.workflowRun(wf.id, { input: runInput.value.trim() });
      runState = run;
      renderLog(run);
      renderResult(run);
      replay(run);
      toast(`执行完成：${run.nodeLog.length} 步 · ${run.ms}ms`, run.status === "done" ? "ok" : "warn");
    } catch (err) {
      logBox.replaceChildren(el("div", "alert err", `<span>✕</span><span class="msg">${esc(err.message)}</span>`));
      toast(`执行失败：${err.message}`, "err", 5000);
    } finally {
      runInput.disabled = false;
    }
  }

  function renderLog(run) {
    const tl = el("div", "timeline");
    for (const l of run.nodeLog) {
      const node = wf.nodes.find((n) => n.id === l.nodeId);
      const tone = l.status === "done" ? "ok" : l.status === "failed" ? "err" : l.status === "iterate" ? "warn" : "violet";
      tl.append(el("div", `tl-item ${tone}`, `
        <div class="tl-head">
          <b>${esc(node?.title || l.nodeId)}</b>
          <span class="t-time">${esc(fmtTime(l.at))}${l.ms != null ? ` · ${l.ms}ms` : ""}</span>
        </div>
        <div class="tl-body">${esc(l.detail || "—")}</div>`));
    }
    if (run.nodeLog.length === 0) tl.append(empty("没有执行记录", "·"));
    logBox.replaceChildren(tl);
  }

  function renderResult(run) {
    const box = el("div", "");
    box.append(el("dl", "kv", `
      <dt>运行 ID</dt><dd>${esc(run.id)}</dd>
      <dt>任务</dt><dd>${esc(run.taskId)}</dd>
      <dt>状态</dt><dd>${esc(run.status)}</dd>
      <dt>步数</dt><dd>${esc(run.nodeLog.length)}</dd>
      <dt>耗时</dt><dd>${esc(run.ms)} ms</dd>`));
    if (run.error) box.append(el("div", "mt8 alert err", `<span>✕</span><span class="msg">${esc(run.error)}</span>`));
    if (run.convergedAtLimit) {
      box.append(el("div", "mt8 alert warn", `<span>◐</span><span class="msg">迭代达到上限后收敛：结果取最后一轮输出，未显式到达终点。</span>`));
    }
    if (run.result) {
      box.append(el("div", "mt8 sub", "收势输出"));
      box.append(el("pre", "codeblock mt8", esc(String(run.result))));
    }
    resultBox.replaceChildren(box);
  }

  /** 慢镜头：按 nodeLog 顺序推进节点状态，让"走了哪条路径"看得见。 */
  function replay(run) {
    stopReplay();
    let i = 0;
    const step = () => {
      if (i >= run.nodeLog.length) {
        /* 收尾：按 nodeStates 落定最终态 */
        const snapshot = { nodeStates: run.nodeStates };
        runState = { ...runState, nodeStates: snapshot.nodeStates };
        render();
        return;
      }
      const entry = run.nodeLog[i++];
      const states = {};
      for (const n of wf.nodes) states[n.id] = "idle";
      for (let j = 0; j < i; j++) {
        const past = run.nodeLog[j];
        states[past.nodeId] = past.status === "running" ? "running"
          : past.status === "iterate" ? "iterate"
            : past.status === "failed" ? "failed" : "done";
      }
      states[entry.nodeId] = "running";
      runState = { ...runState, nodeStates: states };
      render();
      edgeGroup.querySelectorAll(".wf-edge").forEach((g) => {
        g.classList.toggle("hot", g.dataset.from === entry.nodeId);
        g.classList.toggle("done", g.dataset.to === entry.nodeId);
      });
      replayTimer = setTimeout(step, REPLAY_MS);
    };
    step();
  }

  function stopReplay() {
    if (replayTimer) {
      clearTimeout(replayTimer);
      replayTimer = null;
    }
  }

  /* ---------------- 增删查存 ---------------- */

  async function load(id) {
    stopReplay();
    try {
      wf = await api.workflowGet(id);
    } catch (err) {
      toast(err.message, "err");
      return;
    }
    runState = null;
    selected = null;
    sel.value = id;
    logBox.replaceChildren(el("div", "hint", "尚未运行。填好输入后点「▶ 运行」。"));
    resultBox.replaceChildren(el("div", "hint", "—"));
    render();
  }

  async function createWorkflow() {
    const nameF = el("input", "input");
    nameF.placeholder = "如：三段式评审阵";
    const descF = el("input", "input");
    descF.placeholder = "一句话说明这个阵法做什么";
    const m = modal("新建工作流", el("div", "", [field("名称 *", nameF), field("描述", descF)]), el("div", "row"));
    const cancel = el("button", "btn", "取消");
    const ok = el("button", "btn primary", "创建");
    cancel.type = ok.type = "button";
    cancel.addEventListener("click", () => m.close());
    ok.addEventListener("click", async () => {
      if (!nameF.value.trim()) { toast("名称为必填", "err"); return; }
      try {
        const list = await api.workflowSave({
          name: nameF.value.trim(),
          desc: descF.value.trim(),
          nodes: [
            { id: "s1", type: "start", title: "起势", x: 60, y: 200, config: {} },
            { id: "e1", type: "end", title: "收势", x: 560, y: 200, config: {} }
          ],
          edges: [{ from: "s1", to: "e1", kind: "flow" }]
        });
        workflows = list;
        refreshSel();
        m.close();
        await load(list.find((w) => w.name === nameF.value.trim())?.id ?? list[list.length - 1].id);
        toast("工作流已创建（默认起势 → 收势）", "ok");
      } catch (err) { toast(err.message, "err", 4000); }
    });
    m.foot.append(cancel, ok);
    nameF.focus();
  }

  async function save() {
    if (!wf) return;
    const check = validateWorkflow(wf);
    if (!check.valid) {
      const ok = await confirmDialog("校验未通过", "存在阻断级问题，仍然保存为草稿？执行前必须先修复。", "存为草稿");
      if (!ok) return;
    }
    try {
      workflows = await api.workflowSave({
        id: wf.id,
        name: wf.name,
        desc: wf.desc,
        nodes: wf.nodes,
        edges: wf.edges
      });
      refreshSel();
      toast("工作流已保存", "ok");
    } catch (err) {
      toast(err.message, "err", 5000);
    }
  }

  async function remove() {
    if (!wf?.id) return;
    const ok = await confirmDialog("删除工作流", `确认删除「${wf.name}」？此操作不可撤销。`, "删除");
    if (!ok) return;
    try {
      workflows = await api.workflowRemove(wf.id);
      refreshSel();
      if (workflows[0]) await load(workflows[0].id);
      else {
        wf = null;
        world.replaceChildren(empty("还没有工作流，先新建一个", "❋"));
        edgeGroup.replaceChildren();
      }
      toast("工作流已删除", "ok");
    } catch (err) { toast(err.message, "err"); }
  }

  if (workflows[0]) await load(workflows[0].id);

  return {
    dispose() { stopReplay(); },
    refresh: () => renderWorkflow(root)
  };
}

function cardOf(title, body) {
  const c = el("div", "card");
  c.append(el("div", "card-head", `<h3>${esc(title)}</h3>`), el("div", "card-body", body));
  return c;
}

function field(text, control) {
  const f = el("div", "field");
  f.append(el("label", "", esc(text)));
  f.append(control);
  return f;
}
