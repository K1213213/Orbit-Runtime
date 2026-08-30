/**
 * 异构适配视图 · 接驳器工作室（W15 契约层 / W16 MCP）
 *
 * 把外来运行时接驳为内核能力通道，并在界面上如实呈现两条架构铁律：
 *   1) 适配器不经网关直达内核——所有调用走 capabilityInvoke，落入 RecordJournal；
 *   2) 适配器自身不引入非确定性——随机/时钟由内核注入，降级必须诚实标注。
 *
 * 两种家族的本质差异决定了表单差异：
 *   · JS    —— 进程内，工具面注册时即已知，可离线声明。
 *   · MCP   —— 跨进程，工具面只有握手后才知道，因此注册发生在连接之后；
 *              且参数由远端校验、返回值由 content 块映射，默认保真度 reduced。
 */
import { api } from "../api.js";
import { el, esc, badge, toast, empty } from "../app.js";
import { PAE_TEMPLATES, PAE_TEMPLATE_IDS, FIDELITY_LABEL, FIDELITY_TONE, parseArgv } from "../lib.js";

const DETERMINISM_LABEL = {
  deterministic: "纯函数",
  stochastic: "含随机",
  "io-bound": "IO 边界"
};

export async function renderPae(root) {
  const wrap = el("div", "");

  wrap.append(el("div", "alert info mt0", `
    <span>◈</span>
    <span class="msg"><b>异构适配 · PAE</b> —— 把任意外来运行时接驳为内核能力通道。
    注册即校验、调用必过网关、随机与时钟由内核注入；保真度降级须诚实声明，绝不静默。</span>`));

  /* ---- 统计 ---- */
  const stats = el("div", "grid cols-4 mt16");
  wrap.append(stats);

  /* ---- 左右两栏 ---- */
  const lower = el("div", "grid cols-2 mt16");
  const left = el("div");
  const right = el("div");
  lower.append(left, right);
  wrap.append(lower);

  /* ---- 调用台（全宽） ---- */
  const invokeCard = el("div", "card mt16");
  wrap.append(invokeCard);

  /* ---- 保真度协商（全宽） ---- */
  const negCard = el("div", "card mt16");
  wrap.append(negCard);

  /* ================= 注册表单 ================= */
  const form = el("form", "card");
  form.append(el("div", "card-head", "<h3>接驳适配器 · Adapter Studio</h3><span class='sub'>静态校验 + 动态 Pact + 保真度协商</span>"));
  const fbody = el("div", "card-body");

  let kind = "js";
  const tabJs = el("button", "pae-tab active", "JS 工具集");
  const tabMcp = el("button", "pae-tab", "MCP 服务器");
  tabJs.type = "button";
  tabMcp.type = "button";
  const tabs = el("div", "pae-tabs", [tabJs, tabMcp]);

  const jsPane = el("div", "pae-pane");
  const mcpPane = el("div", "pae-pane hidden");

  function selectKind(next) {
    kind = next;
    tabJs.classList.toggle("active", kind === "js");
    tabMcp.classList.toggle("active", kind === "mcp");
    jsPane.classList.toggle("hidden", kind !== "js");
    mcpPane.classList.toggle("hidden", kind !== "mcp");
  }
  tabJs.addEventListener("click", () => selectKind("js"));
  tabMcp.addEventListener("click", () => selectKind("mcp"));

  /* ---------- JS 面板 ---------- */
  const idF = input("text", "pae.demo.strings", "如 pae.demo.strings");
  const edF = input("text", "1.0.0", "semver，进入 Pact 与指纹");
  const isoF = select(["L0", "L1", "L2"], "L0");

  const toolNameF = input("text", "demoEcho", "工具名（全局唯一）");
  const tplF = select(PAE_TEMPLATE_IDS, "echo");
  const capF = select(["channel:read", "channel:write"], "channel:read");
  const detF = select(["deterministic", "stochastic", "io-bound"], "deterministic");
  const fidF = select(["full", "reduced", "lossy"], "full");
  const fidNoteF = el("textarea");
  fidNoteF.placeholder = "保真度非 full 时必填：说明具体降损或有损了什么";

  function syncTplPreview() {
    const tpl = PAE_TEMPLATES[tplF.value];
    if (!tpl) return;
    capF.value = tpl.capability;
    detF.value = tpl.determinism;
    fidF.value = tpl.fidelity;
    const noteWrap = jsPane.querySelector("#fid-note-field");
    if (noteWrap) noteWrap.style.display = tpl.fidelity === "full" ? "none" : "block";
    const hint = jsPane.querySelector("#tpl-hint");
    if (hint) hint.textContent = `${tpl.description}（示例入参：${tpl.example || "—"}）`;
  }
  tplF.addEventListener("change", syncTplPreview);
  fidF.addEventListener("change", syncTplPreview);

  const tplHint = el("div", "hint", "");
  tplHint.id = "tpl-hint";

  jsPane.append(
    el("div", "form-row", [
      field("适配器 ID *", idF),
      field("版本 sourceEdition *", edF),
      field("隔离等级 isolation", isoF)
    ]),
    el("hr", "rule"),
    el("div", "form-row", [field("工具名 *", toolNameF), field("工具模板 *", tplF)]),
    el("div", "form-row", [
      field("能力 capability", capF),
      field("确定性 determinism", detF),
      field("保真度 fidelity", fidF)
    ]),
    el("div", "field", [tplHint]),
    (() => {
      const f = el("div", "field", [label("降级说明 fidelityNote（保真度非 full 时必填）"), fidNoteF]);
      f.id = "fid-note-field";
      return f;
    })(),
    el("p", "hint", "JS 家族运行在内核进程内（L0），工具面在注册时即已确定，因此保真度默认 full。"),
    el("div", "mt16 row", [
      submitBtn("接驳适配器", async () => {
        const tool = {
          template: tplF.value,
          name: toolNameF.value.trim(),
          capability: capF.value,
          determinism: detF.value,
          fidelity: fidF.value,
          fidelityNote: fidF.value === "full" ? undefined : fidNoteF.value.trim()
        };
        const payload = {
          adapterId: idF.value.trim(),
          sourceEdition: edF.value.trim() || "1.0.0",
          isolation: isoF.value,
          tools: [tool]
        };
        try {
          await api.registerPae(payload);
          toast(`适配器 ${payload.adapterId} 已校验并通过网关接驳`, "ok");
          await refreshAll();
        } catch (err) {
          toast(`接驳被拒绝：${err.message}`, "err");
        }
      }),
      submitBtn("载入示例", () => {
        idF.value = "pae.demo.strings";
        edF.value = "1.0.0";
        isoF.value = "L0";
        toolNameF.value = "demoEcho";
        tplF.value = "echo";
        syncTplPreview();
        toast("已填入示例：一个 echo 工具", "accent");
      }, "ghost")
    ])
  );

  /* ---------- MCP 面板 ---------- */
  const mcpIdF = input("text", "mcp.local", "如 mcp.local");
  const mcpCmdF = input("text", "", "可执行文件：npx / node / python");
  const mcpArgsF = input("text", "", "参数：-y @modelcontextprotocol/server-x --dir C:\\data");
  const mcpPrefixF = input("text", "", "工具名前缀（可选，防多 server 撞名，如 fs_）");
  const mcpEdF = input("text", "unknown", "远端 server 版本");
  const mcpTimeoutF = input("number", "15000", "握手与调用超时 ms");
  const mcpShellF = el("input");
  mcpShellF.type = "checkbox";

  mcpPane.append(
    el("div", "form-row", [
      field("适配器 ID *", mcpIdF),
      field("启动命令 command *", mcpCmdF)
    ]),
    el("div", "field", [label("参数 args（空格分隔，引号可包裹含空格的单个参数）"), mcpArgsF]),
    el("div", "form-row", [
      field("工具名前缀 toolNamePrefix", mcpPrefixF),
      field("版本 sourceEdition", mcpEdF),
      field("超时 timeoutMs", mcpTimeoutF)
    ]),
    (() => {
      const row = el("label", "check-row");
      row.append(mcpShellF, el("span", "", "经系统 shell 启动（Windows 上 npx 为批处理脚本时需要）"));
      return row;
    })(),
    el("p", "hint", "MCP 服务器以独立进程运行（隔离等级 L2）。工具面只有握手后才知道，因此注册发生在连接之后——界面只会列出对端真正声明过的工具。默认保真度为 reduced 且必带说明：参数 schema 由远端校验而非内核，返回值由 MCP content 块映射为 JSON。"),
    el("div", "mt16 row", [
      submitBtn("连接 MCP 服务器", async () => {
        const adapterId = mcpIdF.value.trim();
        const command = mcpCmdF.value.trim();
        if (!adapterId) { toast("请填写适配器 ID", "warn"); return; }
        if (!command) { toast("请填写启动命令", "warn"); return; }
        const payload = {
          kind: "mcp",
          adapterId,
          command,
          args: parseArgv(mcpArgsF.value),
          sourceEdition: mcpEdF.value.trim() || "unknown",
          shell: mcpShellF.checked,
          timeoutMs: Number(mcpTimeoutF.value) || 15000
        };
        const prefix = mcpPrefixF.value.trim();
        if (prefix) payload.toolNamePrefix = prefix;
        try {
          const data = await api.registerPae(payload);
          const found = data.adapters.find((a) => a.adapterId === adapterId);
          toast(`已连接 MCP 服务器，发现 ${found?.toolCount ?? 0} 个工具并接驳至网关`, "ok");
          await refreshAll();
        } catch (err) {
          toast(`连接失败：${err.message}`, "err");
        }
      }),
      submitBtn("填入 stdio 示例", () => {
        mcpIdF.value = "mcp.local";
        mcpCmdF.value = "node";
        mcpArgsF.value = "-e \"let b='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>{b+=c;let i;while((i=b.indexOf('\\\\n'))!==-1){const l=b.slice(0,i);b=b.slice(i+1);if(!l.trim())continue;const m=JSON.parse(l);const s=r=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:r})+'\\\\n');if(m.method==='initialize')s({protocolVersion:'2024-11-05',serverInfo:{name:'orbit-demo',version:'1.0.0'}});else if(m.method==='tools/list')s({tools:[{name:'greet',description:'向指定名称问好'}]});else if(m.method==='tools/call')s({content:[{type:'text',text:'hello, '+(m.params.arguments.name||'world')}]});}}\"";
        mcpPrefixF.value = "demo_";
        mcpEdF.value = "1.0.0";
        toast("已填入可直接运行的本地 MCP 示例（内置 greet 工具）", "accent");
      }, "ghost")
    ])
  );

  fbody.append(tabs, jsPane, mcpPane);
  fbody.append(el("p", "hint", "内核铁律：适配器不直接对话内核——注册后其工具作为 pae-tool 通道方法，经 capabilityInvoke 落入 RecordJournal；随机/时钟由内核注入，禁用 Math.random / Date.now。"));
  form.append(fbody);
  left.append(form);

  /* ================= 适配器清单 ================= */
  const adapterCard = el("div", "card");
  adapterCard.append(el("div", "card-head", "<h3>已接驳适配器</h3><span class='sub' id='adapter-count'>—</span>"));
  const adapterTblBody = el("tbody");
  const adapterTbl = el("table", "tbl", `<thead><tr><th>适配器 ID</th><th>类型</th><th>隔离</th><th>版本</th><th>工具</th><th>操作</th></tr></thead>`);
  adapterTbl.append(adapterTblBody);
  adapterCard.append(el("div", "tbl-wrap", adapterTbl));
  right.append(adapterCard);

  /* ================= 工具面 ================= */
  const toolCard = el("div", "card mt16");
  toolCard.append(el("div", "card-head", "<h3>能力面 · Tool Surface</h3><span class='sub' id='tool-count'>—</span>"));
  const toolList = el("div", "pae-tool-list");
  toolCard.append(toolList);
  right.append(toolCard);

  /* ================= 调用台 ================= */
  invokeCard.append(el("div", "card-head", "<h3>调用台 · Invoke Console</h3><span class='sub'>经内核网关 capabilityInvoke(PAE_TOOL) 执行</span>"));
  const invBody = el("div", "card-body");
  const invToolF = select([], "—");
  const invArgF = input("text", "hello orbit", "JS 工具按位置传参；MCP 工具请填 JSON 对象，如 {\"name\":\"world\"}");
  const invOut = el("div", "pae-invoke-out");
  invOut.append(empty("选择一个已接驳工具并调用", "↻"));
  invBody.append(
    el("div", "form-row", [
      field("工具 *", invToolF),
      el("div", "field", [label("入参 arg"), invArgF])
    ]),
    el("div", "row mt12", [
      submitBtn("调用（经网关）", async () => {
        const toolName = invToolF.value;
        if (!toolName || toolName === "—") { toast("请先选择一个工具", "warn"); return; }
        try {
          const res = await api.invokePae(toolName, invArgF.value);
          renderInvokeResult(invOut, res);
        } catch (err) {
          renderInvokeResult(invOut, { error: err.message });
        }
      })
    ]),
    invOut
  );
  invokeCard.append(invBody);

  /* ================= 保真度协商 ================= */
  negCard.append(el("div", "card-head", "<h3>保真度协商 · Informed Choice</h3><span class='sub'>VISION §3.2 机制 1：声明最低可接受保真度，降级不得静默</span>"));
  const negBody = el("div", "card-body");
  const negToolF = select([], "—");
  const negMinF = select(["full", "reduced", "lossy"], "full");
  const negOut = el("div", "pae-neg-out");
  negOut.append(empty("选工具与最低保真度，验证诚实降级", "✧"));
  negBody.append(
    el("div", "form-row", [
      field("工具 *", negToolF),
      field("要求最低保真度 minFidelity", negMinF)
    ]),
    el("div", "row mt12", [
      submitBtn("协商", async () => {
        const toolName = negToolF.value;
        if (!toolName || toolName === "—") { toast("请先选择一个工具", "warn"); return; }
        try {
          const res = await api.negotiatePae(toolName, negMinF.value);
          renderNegotiation(negOut, res);
        } catch (err) {
          renderNegotiation(negOut, { rejected: err.message });
        }
      })
    ]),
    negOut
  );
  negCard.append(negBody);

  /* ---------- 渲染辅助 ---------- */
  function renderInvokeResult(node, res) {
    if (res.error) {
      node.replaceChildren(el("div", "alert err", `<span>✕</span><span class="msg">${esc(res.error)}</span>`));
      return;
    }
    const out = typeof res.output === "string" ? res.output : JSON.stringify(res.output, null, 2);
    node.replaceChildren(el("div", "", `
      <div class="pae-result-head">
        ${badge("PAE_TOOL", "coupler")}
        ${badge(`route: ${res.route}`, "coupler")}
        ${badge(`${res.ms.toFixed(2)}ms`, "neutral")}
        ${badge("replay: inject", "neutral")}
      </div>
      <pre class="pae-result">${esc(out)}</pre>
      <p class="hint">调用经 capabilityInvoke 落网关注册；PAE 工具声明 IO_BOUND + inject，回放由 RecordJournal 注入快照，零重入适配器。</p>`));
  }

  function renderNegotiation(node, res) {
    if (res.rejected) {
      node.replaceChildren(el("div", "alert warn", `<span>⚠</span><span class="msg">协商拒绝（诚实门禁生效）：${esc(res.rejected)}</span>`));
      return;
    }
    const d = res.negotiated;
    node.replaceChildren(el("div", "", `
      <div class="pae-result-head">
        ${badge(d.fidelity, FIDELITY_TONE[d.fidelity])}
        ${badge(d.capability, "accent")}
        ${badge(DETERMINISM_LABEL[d.determinism] ?? d.determinism, "neutral")}
      </div>
      <pre class="pae-result">${esc(JSON.stringify(d, null, 2))}</pre>
      ${d.fidelityNote ? `<p class="hint">降级说明：${esc(d.fidelityNote)}</p>` : ""}`));
  }

  function refreshTools(tools) {
    for (const sel of [invToolF, negToolF]) {
      const cur = sel.value;
      sel.replaceChildren(el("option", "", "—"));
      for (const t of tools) sel.append(el("option", "", t.name));
      if (tools.some((t) => t.name === cur)) sel.value = cur;
    }
    toolCard.querySelector("#tool-count").textContent = `${tools.length} 个工具 · 全部经网关治理`;
    if (tools.length === 0) {
      toolList.replaceChildren(empty("尚无工具——在左侧接驳一个适配器", "✧"));
      return;
    }
    toolList.replaceChildren(...tools.map((t) => el("div", "pae-tool", `
      <div class="pae-tool-main">
        <span class="mono pae-tool-name">${esc(t.name)}</span>
        ${badge(t.capability, "accent")}
        ${badge(DETERMINISM_LABEL[t.determinism] ?? t.determinism, "neutral")}
        ${badge(FIDELITY_LABEL[t.fidelity] ?? t.fidelity, FIDELITY_TONE[t.fidelity])}
      </div>
      <div class="pae-tool-desc">${esc(t.description ?? "")}${t.fidelityNote ? ` · <span class="pae-note">降级：${esc(t.fidelityNote)}</span>` : ""}</div>`)));
  }

  async function refreshAll() {
    try {
      const data = await api.pae();
      stats.replaceChildren(
        mkStat("已接驳适配器", data.adapters.length, data.paeEnabled ? "网关 route = pae" : "尚未启用", "var(--coupler)"),
        mkStat("能力工具", data.tools.length, "全部经网关治理", "var(--coupler)"),
        mkStat("保真度诚实", data.tools.filter((t) => t.fidelity !== "full" && t.fidelityNote).length, "降级均带 note", "var(--accent-2)"),
        mkStat("适配指纹", data.configHash ? shortHash(data.configHash) : "—", "变更即报配置漂移", "var(--purple)")
      );

      adapterCard.querySelector("#adapter-count").textContent = `${data.adapters.length} 个 · 每个有独立 Pact 与指纹`;
      if (data.adapters.length === 0) {
        adapterTblBody.replaceChildren(empty("尚未接驳适配器", "◈"));
      } else {
        adapterTblBody.innerHTML = data.adapters.map((a) => {
          const peer = a.serverInfo
            ? `<div class="mono peer">${esc(a.serverInfo.name ?? "unknown")}${a.serverInfo.version ? ` · v${esc(a.serverInfo.version)}` : ""}</div>`
            : "";
          return `
          <tr>
            <td class="mono">${esc(a.adapterId)}${peer}</td>
            <td>${badge(a.kind, "coupler")}</td>
            <td class="mono">${esc(a.isolation)}</td>
            <td class="mono">${esc(a.sourceEdition)}</td>
            <td class="mono">${a.toolCount}</td>
            <td><button class="btn sm danger" data-rm="${esc(a.adapterId)}">注销</button></td>
          </tr>`;
        }).join("");
        for (const b of adapterTblBody.querySelectorAll("[data-rm]")) {
          b.addEventListener("click", async () => {
            try {
              await api.removePae(b.dataset.rm);
              toast(`适配器 ${b.dataset.rm} 已注销，动态 Pact 撤销且对端已释放`, "ok");
              await refreshAll();
            } catch (err) { toast(err.message, "err"); }
          });
        }
      }
      refreshTools(data.tools);
    } catch (err) {
      wrap.append(el("div", "alert err", `<span>⚠</span><span class="msg">无法加载 PAE 状态：${esc(err.message)}</span>`));
    }
  }

  function mkStat(label, value, foot, color) {
    const s = el("div", "stat");
    s.style.setProperty("--accent", color);
    s.innerHTML = `<div class="label">${label}</div><div class="value">${esc(value)}</div><div class="foot">${esc(foot)}</div>`;
    return s;
  }

  function shortHash(h) { return h.length > 16 ? h.slice(0, 16) : h; }

  await refreshAll();
  syncTplPreview();
  root.append(wrap);

  return {
    dispose() {},
    refresh: async () => {
      root.replaceChildren();
      return renderPae(root);
    }
  };
}

/* ---- 表单小部件 ---- */
function label(text) {
  return el("label", "", `<span style="font-size:12px;color:var(--text-2);font-weight:550">${esc(text)}</span>`);
}
function input(type, value, placeholder) {
  const i = el("input");
  i.type = type;
  i.value = value;
  if (placeholder) i.placeholder = placeholder;
  return i;
}
function select(options, value) {
  const s = el("select");
  for (const o of options) {
    const opt = el("option", "", o);
    if (o === value) opt.selected = true;
    s.append(opt);
  }
  return s;
}
function field(text, control) {
  const f = el("div", "field");
  f.append(label(text), control);
  return f;
}
function submitBtn(text, fn, variant = "primary") {
  const b = el("button", `btn ${variant}`, text);
  b.type = "button";
  b.addEventListener("click", fn);
  return b;
}
