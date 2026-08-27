/**
 * 总览视图：运行状态统计 + 六大机制导航 + 最近追踪流。
 */
import { api } from "../api.js";
import { el, esc, fmtTime, badge, empty, loading, card } from "../app.js";

const MECHANISMS = [
  {
    route: "channels",
    tag: "CHANNEL",
    title: "能力通道",
    desc: "所有外部能力（记忆 KV / LLM）都抽象为通道，插件可运行时覆盖内置通道（plugin-first）。"
  },
  {
    route: "plugins",
    tag: "PACT",
    title: "插件协议",
    desc: "插件清单强制校验：字段完整性、主机版本兼容、能力声明闭环，未声明能力一律拒绝。"
  },
  {
    route: "boxes",
    tag: "SANDBOX",
    title: "沙箱执行",
    desc: "每 Agent 独立沙箱：循环次数预算（防死循环）、每轮独立 trace ID、通道化模型调用。"
  },
  {
    route: "safeguard",
    tag: "GUARD",
    title: "熔断保护",
    desc: "每插件故障状态机 NORMAL→TRIPPED→PROBE，插件崩溃绝不拖垮主机。"
  },
  {
    route: "trace",
    tag: "TRACE",
    title: "追踪日志",
    desc: "追加式行为日志：全链路记录 + 快照/恢复，按 trace / 沙箱过滤，可审计、可复现。"
  },
  {
    route: "replay",
    tag: "REPLAY",
    title: "确定性回放",
    desc: "录制一次运行，零模型调用回放，字节级一致 + 银行式对账（digest chain 校验）。"
  },
  {
    route: "graph",
    tag: "ISOLATION",
    title: "影响域图",
    desc: "插件/通道/沙箱依赖图，故障影响 = 反向可达闭包，闭包之外可证明互不影响。"
  },
  {
    route: "routing",
    tag: "ROUTING",
    title: "成本路由",
    desc: "通道声明成本/延迟/质量，Agent 在每轮预算内自动选择最便宜的可用通道。"
  }
];

const MECH_ROUTE = {
  channels: "channels",
  pact: "plugins",
  sandbox: "boxes",
  guard: "boxes",
  trace: "trace",
  replay: "replay",
  isolation: "graph",
  routing: "routing"
};

export async function renderOverview(root) {
  const wrap = el("div", "");

  let state;
  try {
    state = await api.state();
  } catch (err) {
    wrap.append(el("div", "alert err", `<span>⚠</span><span class="msg">无法连接桥接服务：${esc(err.message)}</span>`));
    root.append(wrap);
    return { dispose() {} };
  }

  const stats = el("div", "grid cols-4");
  const mkStat = (label, value, foot, color = "var(--accent)") => {
    const s = el("div", "stat");
    s.style.setProperty("--accent", color);
    s.innerHTML = `<div class="label">${label}</div><div class="value">${esc(value)}</div><div class="foot">${esc(foot)}</div>`;
    return s;
  };
  stats.append(
    mkStat("能力通道", state.channels.length, `${state.channels.filter((c) => c.type === "plugin").length} 个由插件覆盖`, "var(--accent)"),
    mkStat("已注册插件", state.plugins.length, "pact 校验通过", "var(--accent-2)"),
    mkStat("Agent 沙箱", state.sandboxes.length, "独立执行环境", "var(--purple)"),
    mkStat("追踪事件", state.traceCount, `累计运行 ${state.runCounter} 轮`, "var(--pink)")
  );

  const banner = el("div", "alert info mt16", `
    <span>◈</span>
    <span class="msg"><b>Orbit Agent Runtime</b> · Deterministic · Provable · Governable —
    零依赖的插件化 Agent 运行时内核。下方六大机制均可在对应页面实际操作验证。</span>`);

  const mechWrap = el("div", "mech-grid mt16");
  for (const m of MECHANISMS) {
    const card = el("div", "mech", `
      <div class="mech-head"><h4>${esc(m.title)}</h4><span class="mech-tag">${m.tag}</span></div>
      <p>${esc(m.desc)}</p>`);
    card.addEventListener("click", () => { location.hash = `#/${MECH_ROUTE[m.route]}`; });
    mechWrap.append(card);
  }

  const traceCard = card(
    `<h3>最近追踪</h3><span class="sub">${state.traceCount} 条 · 仅显示前 6 条</span>`,
    (() => {
      if (state.traceCount === 0) return empty("暂无追踪事件，去沙箱对话页跑一轮试试", "◌");
      const list = el("div", "mini-trace");
      state.trace.slice(0, 6).forEach((entry) => {
        const cls = entry.entryClass || "OTHER";
        const who = entry.pluginUnitId ?? entry.agentBoxId ?? "host";
        const payload = JSON.stringify(entry.factPayload ?? {});
        list.append(el("div", "t-entry", `
          <span class="t-time mono">${fmtTime(entry.occurredAt)}</span>
          <span class="t-class ec-${cls}">${esc(cls)}</span>
          <span class="t-payload mono">${esc(who)} ${esc(payload.slice(0, 90))}${payload.length > 90 ? "…" : ""}</span>`));
      });
      return list;
    })()
  );

  const hostCard = card(
    `<h3>主机生命周期</h3>`,
    el("div", "", `
      <div class="row">
        ${badge(state.running ? "RUNNING" : "STOPPED", state.running ? "ok" : "warn")}
        <span class="muted mono">OrbitRuntimeHost · v0.1.0</span>
      </div>
      <p class="hint mt12">启动：自底向上装配 Channel → Pact → Guard → Sandbox → Host；
      关闭：严格反序释放（pool → pact → guard → channels → journal → graph）。</p>`)
  );

  const channelCard = card(
    `<h3>通道画像</h3>`,
    (() => {
      const tbl = el("div", "tbl-wrap", `
        <table class="tbl">
          <thead><tr><th>通道</th><th>提供方</th><th>成本</th><th>延迟</th><th>质量</th></tr></thead>
          <tbody>
            ${state.channels.map((c) => `
              <tr>
                <td class="mono">${esc(c.kind)}</td>
                <td>${badge(c.type === "builtin" ? "builtin" : "plugin", c.type === "builtin" ? "neutral" : "violet")}</td>
                <td class="mono">${c.cost.costPerCall}</td>
                <td class="mono">${c.cost.latencyMs}ms</td>
                <td class="mono">${c.cost.quality}</td>
              </tr>`).join("")}
          </tbody>
        </table>`);
      return tbl;
    })()
  );

  wrap.append(banner, stats, mechWrap);
  const lower = el("div", "grid cols-2 mt16");
  lower.append(traceCard, el("div", "", [hostCard, channelCard]));
  wrap.append(lower);
  root.append(wrap);

  return {
    dispose() {},
    refresh: () => renderOverview(root)
  };
}
