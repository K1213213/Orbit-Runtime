/**
 * 影响域图 · 血缘谱系视图（Bio-Lineage Graph，M3）
 *
 * 视觉语义（开创性设计 —— "血缘关系"状态图）：
 *   · 通道   = 血脉之源（祖源层，绿色）—— 能量核心
 *   · 插件   = 神经节（紫色）—— 继承父通道血脉
 *   · 沙箱   = 细胞体（青色）—— 继承父通道血脉
 *   · 依赖边 = 血缘血脉线：贝塞尔弧线 + 父子色相渐变 + 能量粒子沿血脉流动
 *   · 故障   = 病变：点击节点后猩红病变沿血缘反向扩散到受影响后代
 *
 * 技术：纯 SVG（渐变/滤镜/粒子 + CSS 动画），零依赖。
 */
import { api } from "../api.js";
import { el, esc, badge, toast, empty, loading } from "../app.js";

const NS = "http://www.w3.org/2000/svg";

/* 生命体色板（与 styles.css 令牌一致） */
const GENE = "#3cf2a8";        // 通道 · 基因绿
const PLASMA = "#39e6ff";      // 沙箱 · 等离子青
const NEURON = "#b78bff";      // 插件 · 神经紫
const LESION = "#ff5c7a";      // 病变 · 猩红
const KIND_COLOR = { plugin: NEURON, sandbox: PLASMA, channel: GENE };
const KIND_R = { plugin: 27, sandbox: 23, channel: 21 };

const W = 940;
const H = 520;

export async function renderGraph(root) {
  const wrap = el("div", "");

  const card = el("div", "card");
  card.append(el("div", "card-head", "<h3>血缘谱系 · 依赖与隔离域</h3><span class='sub'>点击任一节点 —— 猩红病变将沿血缘反向扩散至受影响后代（反向可达闭包）</span>"));

  const shell = el("div", "graph-shell");
  const side = el("div", "mt16");
  card.append(shell, el("div", "graph-legend", `
    <span class="lg" style="color:${GENE}"><span class="sw" style="background:${GENE};color:${GENE}"></span>血脉之源 · 通道</span>
    <span class="lg" style="color:${NEURON}"><span class="sw" style="background:${NEURON};color:${NEURON}"></span>神经节 · 插件</span>
    <span class="lg" style="color:${PLASMA}"><span class="sw" style="background:${PLASMA};color:${PLASMA}"></span>细胞体 · 沙箱</span>
    <span class="lg"><span class="sw" style="background:transparent;border:1.5px dashed rgba(57,230,255,.5);color:${PLASMA}"></span>血缘血脉线 dependent → dependency</span>
  `), side);

  /* ---- 隔离定理检查器 ---- */
  const checker = el("div", "card mt16");
  checker.append(el("div", "card-head", "<h3>隔离定理检查</h3><span class='sub'>两条血脉互不相通 ⇒ 故障互不传染（provably independent）</span>"));
  const cBody = el("div", "card-body");
  const selA = el("select");
  const selB = el("select");
  const checkBtn = el("button", "btn primary", "检查独立性");
  const cResult = el("div", "mt12");
  cBody.append(
    el("div", "check-pair", [
      fieldWrap("血脉节点 A", selA),
      fieldWrap("血脉节点 B", selB),
      el("div", "field", [checkBtn])
    ]),
    cResult
  );
  checker.append(cBody);

  wrap.append(card, checker);
  root.append(wrap);

  /* ---- 数据 ---- */
  let data;
  try {
    data = await api.graph();
  } catch (err) {
    wrap.append(el("div", "alert err", `<span>⚠</span><span class="msg">${esc(err.message)}</span>`));
    return { dispose() {}, refresh: () => renderGraph(root) };
  }

  if (data.nodes.length === 0) {
    shell.replaceChildren(empty("血脉图谱为空 — 注册插件或创建沙箱后，节点将作为后代加入图谱", "✧"));
    return { dispose() {}, refresh: () => renderGraph(root) };
  }

  /* ---- 力导向布局 + 通道置底（祖源层） ---- */
  /* 初始布局按类型分区，避免全部塌缩到通道周围：
     通道居中底部、插件左上区、沙箱右上区，互不重叠。力导向迭代再微调。 */
  const pluginBox = [];
  const sandboxBox = [];
  for (const n of data.nodes) {
    if (n.kind === "plugin") pluginBox.push(n);
    else if (n.kind === "sandbox") sandboxBox.push(n);
  }

  const nodes = data.nodes.map((n) => {
    let x, y;
    if (n.kind === "channel") {
      const idxCh = data.nodes.filter((m) => m.kind === "channel").indexOf(n);
      const chCount = data.nodes.filter((m) => m.kind === "channel").length;
      const span = Math.min(W * 0.5, chCount * 110);
      x = W / 2 + (idxCh - (chCount - 1) / 2) * (span / Math.max(1, chCount));
      y = H - 70;
    } else if (n.kind === "plugin") {
      const i = pluginBox.indexOf(n);
      x = W * 0.22 + (i % 2) * 60;
      y = H * 0.28 + Math.floor(i / 2) * 90;
    } else {
      const i = sandboxBox.indexOf(n);
      x = W * 0.78 + (i % 2) * 60;
      y = H * 0.28 + Math.floor(i / 2) * 90;
    }
    return {
      ...n,
      x: x + (Math.random() - 0.5) * 12,
      y: y + (Math.random() - 0.5) * 12,
      vx: 0,
      vy: 0
    };
  });
  const idx = new Map(nodes.map((n) => [n.id, n]));

  const REP = 5200, SPRING = 0.018, REST = 200, CENTER = 0.012, DAMP = 0.82;
  const MIN_DIST = 78; // 节点最小间距（硬斥力）
  for (let iter = 0; iter < 200; iter++) {
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j];
        let dx = b.x - a.x, dy = b.y - a.y;
        let d = Math.hypot(dx, dy) || 1;
        const base = REP / (d * d);
        let extra = 0;
        if (d < MIN_DIST) extra = (MIN_DIST - d) * 0.55; // 软核排斥：近距更强
        const f = base + extra;
        dx /= d; dy /= d;
        a.vx -= dx * f; a.vy -= dy * f;
        b.vx += dx * f; b.vy += dy * f;
      }
    }
    for (const e of data.edges) {
      const a = idx.get(e.from), b = idx.get(e.to);
      if (!a || !b) continue;
      let dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.hypot(dx, dy) || 1;
      const f = SPRING * (d - REST);
      dx /= d; dy /= d;
      a.vx += dx * f; a.vy += dy * f;
      b.vx -= dx * f; b.vy -= dy * f;
    }
    for (const n of nodes) {
      n.vx += (W / 2 - n.x) * CENTER;
      n.vy += (H / 2 - n.y) * CENTER;
      n.vx *= DAMP; n.vy *= DAMP;
      n.x += n.vx; n.y += n.vy;
    }
  }
  const maxY = Math.max(...nodes.map((n) => n.y));
  for (const n of nodes) if (n.kind === "channel") n.y = Math.min(H - 36, maxY + 36);

  /* ---- SVG 根 ---- */
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "血缘谱系依赖图");

  const defs = document.createElementNS(NS, "defs");
  svg.append(defs);
  const edgeG = document.createElementNS(NS, "g");
  const nodeG = document.createElementNS(NS, "g");
  svg.append(edgeG, nodeG);

  /* 滤镜：病变红光晕 */
  const blurF = document.createElementNS(NS, "filter");
  blurF.setAttribute("id", "lesion-glow");
  blurF.setAttribute("x", "-60%");
  blurF.setAttribute("y", "-60%");
  blurF.setAttribute("width", "220%");
  blurF.setAttribute("height", "220%");
  blurF.innerHTML = `<feGaussianBlur stdDeviation="7" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>`;
  defs.append(blurF);

  /* 细胞光晕渐变：每类型一个 */
  const haloDefs = {
    channel: makeRadial(defs, "halo-gene", GENE),
    plugin: makeRadial(defs, "halo-neuron", NEURON),
    sandbox: makeRadial(defs, "halo-plasma", PLASMA)
  };

  /* 血缘贝塞尔路径 */
  function bloodlinePath(a, b) {
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    // 弧线控制点：垂直方向偏置，形成族谱式的弯曲血脉
    const lift = Math.max(18, Math.min(60, len * 0.18));
    const dx = (b.x - a.x) / len;
    const dy = (b.y - a.y) / len;
    const cx = mx - dy * lift;
    const cy = my + dx * lift;
    return `M ${a.x.toFixed(1)} ${a.y.toFixed(1)} Q ${cx.toFixed(1)} ${cy.toFixed(1)} ${b.x.toFixed(1)} ${b.y.toFixed(1)}`;
  }

  /* ---- 血缘血脉边 ---- */
  const edgeEls = [];
  data.edges.forEach((e, i) => {
    const a = idx.get(e.from);
    const b = idx.get(e.to);
    if (!a || !b) return;
    const path = bloodlinePath(a, b);
    const colorA = KIND_COLOR[a.kind];
    const colorB = KIND_COLOR[b.kind];

    // 血脉渐变（父色 → 子色 = 遗传）
    const gid = `blood-${i}`;
    const grad = document.createElementNS(NS, "linearGradient");
    grad.setAttribute("id", gid);
    grad.setAttribute("x1", a.x); grad.setAttribute("y1", a.y);
    grad.setAttribute("x2", b.x); grad.setAttribute("y2", b.y);
    grad.setAttribute("gradientUnits", "userSpaceOnUse");
    grad.innerHTML = `<stop offset="0" stop-color="${colorA}" stop-opacity="0.9"/><stop offset="1" stop-color="${colorB}" stop-opacity="0.55"/>`;
    defs.append(grad);

    const line = document.createElementNS(NS, "path");
    line.classList.add("edge-line");
    line.setAttribute("d", path);
    line.setAttribute("stroke", `url(#${gid})`);
    line.setAttribute("fill", "none");

    // 血脉粒子：沿曲线流动的能量点（祖源色）
    const cell = document.createElementNS(NS, "circle");
    cell.classList.add("blood-cell");
    cell.setAttribute("r", 2.4);
    cell.setAttribute("fill", colorA);
    const motion = document.createElementNS(NS, "animateMotion");
    motion.setAttribute("dur", `${2.4 + (i % 4) * 0.5}s`);
    motion.setAttribute("repeatCount", "indefinite");
    motion.setAttribute("path", path);
    cell.append(motion);

    edgeG.append(line, cell);
    edgeEls.push({ line, cell, from: a, to: b });
  });

  /* ---- 细胞体节点 ---- */
  const nodeEls = [];
  for (const n of nodes) {
    const g = document.createElementNS(NS, "g");
    g.classList.add("graph-node");
    const r = KIND_R[n.kind];
    const color = KIND_COLOR[n.kind];

    // 光晕（halo）：径向渐变圆
    const halo = document.createElementNS(NS, "circle");
    halo.classList.add("cell-halo");
    halo.setAttribute("cx", n.x); halo.setAttribute("cy", n.y);
    halo.setAttribute("r", r * 2.6);
    halo.setAttribute("fill", `url(#${haloDefs[n.kind]})`);

    // 细胞膜：渐变描边圆
    const ring = document.createElementNS(NS, "circle");
    ring.classList.add("node-ring");
    ring.setAttribute("cx", n.x); ring.setAttribute("cy", n.y);
    ring.setAttribute("r", r);
    ring.setAttribute("fill", "rgba(7, 11, 19, 0.55)");
    ring.setAttribute("stroke", color);
    ring.setAttribute("stroke-width", n.kind === "plugin" ? 2.6 : 2.1);

    // 细胞核
    const core = document.createElementNS(NS, "circle");
    core.setAttribute("cx", n.x); core.setAttribute("cy", n.y);
    core.setAttribute("r", Math.max(4.5, r * 0.3));
    core.setAttribute("fill", color);
    core.setAttribute("filter", `drop-shadow(0 0 5px ${color})`);

    // 神经节棘突（插件独有：外圈脉冲点）
    if (n.kind === "plugin") {
      for (let k = 0; k < 6; k++) {
        const ang = (Math.PI * 2 * k) / 6 + 0.4;
        const spike = document.createElementNS(NS, "circle");
        spike.setAttribute("cx", n.x + Math.cos(ang) * (r + 7));
        spike.setAttribute("cy", n.y + Math.sin(ang) * (r + 7));
        spike.setAttribute("r", 1.6);
        spike.setAttribute("fill", color);
        spike.setAttribute("opacity", 0.7);
        g.append(spike);
      }
    }

    // 标签
    const label = document.createElementNS(NS, "text");
    label.classList.add("node-label");
    label.setAttribute("x", n.x);
    label.setAttribute("y", n.y + r + 16);
    label.setAttribute("text-anchor", "middle");
    label.textContent = n.id;

    // 点击热区
    const hit = document.createElementNS(NS, "circle");
    hit.classList.add("hit");
    hit.setAttribute("cx", n.x); hit.setAttribute("cy", n.y);
    hit.setAttribute("r", r + 11);
    hit.setAttribute("fill", "transparent");

    g.append(halo, ring, core, hit, label);
    nodeG.append(g);
    nodeEls.push({ g, node: n, ring, core, halo, label, color });
  }

  shell.append(svg);

  /* ---- 交互：病变扩散（血缘反向传播） ---- */
  const infoCard = el("div", "card mt16", "");
  infoCard.style.display = "none";
  side.append(infoCard);

  async function selectNode(id) {
    let closure = [];
    try {
      const r = await api.isolation(id);
      closure = r.closure;
    } catch (err) {
      toast(err.message, "err");
    }
    const impacted = new Set(closure);
    impacted.add(id);

    // 节点：病变着色
    for (const { g, node } of nodeEls) {
      const on = impacted.has(node.id);
      g.style.opacity = on ? 1 : 0.18;
      g.classList.toggle("lesioned", on && node.id === id);
      const ring = g.querySelector("circle.node-ring");
      if (on && node.id === id) {
        ring.setAttribute("r", KIND_R[node.kind] + 6);
        ring.setAttribute("stroke", LESION);
        ring.setAttribute("stroke-width", 3.4);
      } else if (on) {
        ring.setAttribute("r", KIND_R[node.kind] + 2);
        ring.setAttribute("stroke", "#fff");
        ring.setAttribute("stroke-width", 2.6);
      } else {
        ring.setAttribute("r", KIND_R[node.kind]);
        ring.setAttribute("stroke", g.__color ?? KIND_COLOR[node.kind]);
        ring.setAttribute("stroke-width", node.kind === "plugin" ? 2.6 : 2.1);
      }
    }
    // 边：猩红病变沿血缘扩散
    for (const { line, cell, from, to } of edgeEls) {
      const on = impacted.has(from.id) && impacted.has(to.id);
      line.classList.toggle("hit", on);
      line.classList.toggle("fade", !on);
      cell.style.opacity = on ? 1 : 0.15;
      cell.setAttribute("fill", on ? LESION : KIND_COLOR[from.kind]);
    }

    const node = idx.get(id);
    infoCard.style.display = "";
    const tone = node.kind === "plugin" ? "purple" : node.kind === "sandbox" ? "accent" : "ok";
    infoCard.innerHTML = `
      <div class="card-head"><h3>病变扩散域 · ${esc(id)}</h3><span class="sub">${badge(node.kind, tone)}</span></div>
      <div class="card-body">
        <p class="hint">病变沿血缘反向传播。当 ${esc(id)} 发生故障，以下 ${closure.length} 个血脉后代受影响：</p>
        ${closure.length === 0
          ? el("div", "alert ok", `<span>✓</span><span class="msg">无血脉后代 —— 该节点故障被完全隔离，血缘互不传染。</span>`).outerHTML
          : `<div class="row" style="gap:8px">${closure.map((c) => badge(c, "err")).join("")}</div>`}
        ${node.kind === "channel"
          ? `<p class="hint mt8">通道是血脉之源：它病变会沿血缘传染所有依赖它的插件与沙箱。</p>`
          : ""}
      </div>`;
  }

  for (const { g, node } of nodeEls) {
    g.addEventListener("click", () => selectNode(node.id));
    g.__color = KIND_COLOR[node.kind];
  }

  /* ---- 隔离定理检查 ---- */
  const fillSel = (sel) => {
    sel.innerHTML = "";
    nodes.forEach((n) => {
      const o = el("option");
      o.value = n.id;
      o.textContent = `${n.id}（${n.kind}）`;
      sel.append(o);
    });
  };
  fillSel(selA);
  fillSel(selB);
  if (nodes.length > 1) {
    selA.value = nodes[0].id;
    selB.value = nodes[1].id;
  }

  checkBtn.addEventListener("click", async () => {
    const a = selA.value, b = selB.value;
    if (a === b) {
      cResult.replaceChildren(el("div", "alert warn", `<span>!</span><span class="msg">请选择两条不同血脉上的节点。</span>`));
      return;
    }
    try {
      const r = await api.checkIsolation(a, b);
      const tone = r.independent ? "ok" : "err";
      const verdict = r.independent
        ? `${esc(a)} 与 ${esc(b)} <b>血脉互不相通</b>（任何一方病变都不会传染另一方）`
        : `${esc(a)} 与 ${esc(b)} <b>存在血缘关联</b>（病变可能沿血脉传播）`;
      cResult.replaceChildren(el("div", `alert ${tone}`, `<span>${r.independent ? "✓" : "✕"}</span><span class="msg">${verdict}</span>`));
    } catch (err) {
      cResult.replaceChildren(el("div", "alert err", `<span>✕</span><span class="msg">${esc(err.message)}</span>`));
    }
  });

  return { dispose() {}, refresh: () => renderGraph(root) };
}

/* 径向光晕渐变 */
function makeRadial(defs, id, color) {
  const g = document.createElementNS(NS, "radialGradient");
  g.setAttribute("id", id);
  g.innerHTML = `
    <stop offset="0%" stop-color="${color}" stop-opacity="0.4"/>
    <stop offset="55%" stop-color="${color}" stop-opacity="0.12"/>
    <stop offset="100%" stop-color="${color}" stop-opacity="0"/>`;
  defs.append(g);
  return id;
}

function fieldWrap(text, control) {
  const f = el("div", "field");
  if (text) f.append(el("label", "", text));
  f.append(control);
  return f;
}
