/**
 * 总览视图 · 任务式工作台
 *
 * 首屏要回答的是"现在能干活吗、接下来做什么"，而不是把九个页面的入口
 * 再抄一遍（那是侧栏和命令面板的职责）。因此首屏只有四件事：
 *
 *   1. 系统健康 —— 一个结论，带得出这个结论的理由
 *   2. 下一步   —— 基于真实状态推导的可执行入口，不是说明文字
 *   3. 关键指标 —— 数字本身
 *   4. 现场证据 —— 最近追踪与通道画像，供快速核对
 */
import { api } from "../api.js";
import { el, esc, fmtTime, badge, empty, card, toast } from "../app.js";
import { NAV_GROUPS, deriveSystemHealth, suggestNextSteps } from "../lib.js";

const HEALTH_LABEL = { ok: "就绪", warn: "可运行", err: "不可用" };
const HEALTH_ICON = { ok: "●", warn: "◐", err: "○" };

export async function renderOverview(root) {
  const wrap = el("div", "");

  let state;
  let health = { version: "—", running: false };
  try {
    [state, health] = await Promise.all([api.state(), api.health()]);
  } catch (err) {
    wrap.append(
      el("div", "alert err", `<span>⚠</span><span class="msg">无法连接桥接服务：${esc(err.message)}</span>`)
    );
    root.append(wrap);
    return { dispose() {} };
  }

  /* ---------- 1. 系统健康 ---------- */

  const h = deriveSystemHealth(state);
  const pae = state.pae ?? { enabled: false, adapters: 0, tools: 0 };

  const healthBar = el("div", `health-bar ${h.level}`);
  const issues = h.issues.length
    ? el(
        "ul",
        "health-issues",
        h.issues.map((i) =>
          el("li", "", `<span class="hi-dot">◆</span><span><b>${esc(i.text)}</b> — ${esc(i.detail)}</span>`)
        )
      )
    : null;

  healthBar.append(
    el("div", "health-badge", `${HEALTH_ICON[h.level]} ${HEALTH_LABEL[h.level]}`),
    el(
      "div",
      "health-text",
      h.healthy
        ? "全部能力面就绪：通道、契约、沙箱、治理均已装配，可直接跑一轮 Agent 并回放验证。"
        : "系统存在待处理项，按下方建议逐步补齐即可进入就绪状态。"
    ),
    el("div", "health-meta", `OrbitRuntimeHost · v${esc(health.version)}`)
  );
  if (issues) healthBar.append(issues);

  /* ---------- 2. 下一步 ---------- */

  const steps = suggestNextSteps(state);
  const stepList = el("div", "next-steps");
  steps.forEach((s, i) => {
    const item = el("button", `step-item${s.primary ? " primary" : ""}`, `
      <span class="step-idx">${i + 1}</span>
      <span class="step-body">
        <span class="step-title">${esc(s.title)}</span>
        <span class="step-desc">${esc(s.desc)}</span>
      </span>
      <span class="step-go">→</span>`);
    item.type = "button";
    item.addEventListener("click", async () => {
      if (s.action === "boot") {
        try {
          await api.boot();
          toast("主机已启动（自底向上装配完成）", "ok");
          await refresh();
        } catch (err) {
          toast(`启动失败：${err.message}`, "err");
        }
        return;
      }
      location.hash = `#/${s.route}`;
    });
    stepList.append(item);
  });

  /* ---------- 3. 关键指标 ---------- */

  const pluginChannels = state.channels.filter((c) => c.type === "plugin").length;
  const metrics = [
    { label: "能力通道", value: state.channels.length, foot: `${pluginChannels} 个由插件覆盖`, color: "var(--gene)" },
    { label: "已注册插件", value: state.plugins.length, foot: "pact 三重校验通过", color: "var(--neuron)" },
    { label: "Agent 沙箱", value: state.sandboxes.length, foot: "独立预算执行环境", color: "var(--plasma)" },
    {
      label: "外来适配器",
      value: pae.adapters ?? 0,
      foot: pae.enabled ? `${pae.tools ?? 0} 个工具 · ${String(pae.configHash ?? "").slice(0, 8)}` : "未接入",
      color: "var(--coupler)"
    },
    { label: "追踪事件", value: state.traceCount, foot: `累计运行 ${state.runCounter} 轮`, color: "var(--pink)" }
  ];

  const statGrid = el("div", "stat-grid");
  for (const m of metrics) {
    const c = el("div", "stat-card");
    c.style.setProperty("--sc", m.color);
    c.append(
      el("div", "sc-label", esc(m.label)),
      el("div", "sc-value", esc(m.value)),
      el("div", "sc-foot", esc(m.foot))
    );
    statGrid.append(c);
  }

  /* ---------- 4. 现场证据 ---------- */

  const traceCard = card(
    `<h3>最近追踪</h3><span class="sub">${state.traceCount} 条 · 仅显示前 6 条</span>`,
    (() => {
      if (state.traceCount === 0) return empty("暂无追踪事件，去沙箱对话页跑一轮试试", "◌");
      const list = el("div", "mini-trace");
      for (const entry of state.trace.slice(0, 6)) {
        const cls = entry.entryClass || "OTHER";
        const who = entry.pluginUnitId ?? entry.agentBoxId ?? "host";
        const payload = JSON.stringify(entry.factPayload ?? {});
        list.append(el("div", "t-entry", `
          <span class="t-time mono">${fmtTime(entry.occurredAt)}</span>
          <span class="t-class ec-${cls}">${esc(cls)}</span>
          <span class="t-payload mono">${esc(who)} ${esc(payload.slice(0, 90))}${payload.length > 90 ? "…" : ""}</span>`));
      }
      return list;
    })()
  );

  const channelCard = card(`<h3>通道画像</h3>`, el("div", "tbl-wrap", `
    <table class="tbl">
      <thead><tr><th>通道</th><th>提供方</th><th>成本</th><th>延迟</th><th>质量</th></tr></thead>
      <tbody>
        ${state.channels
          .map(
            (c) => `
          <tr>
            <td class="mono">${esc(c.kind)}</td>
            <td>${badge(c.type === "builtin" ? "builtin" : "plugin", c.type === "builtin" ? "neutral" : "violet")}</td>
            <td class="mono">${esc(c.cost.costPerCall)}</td>
            <td class="mono">${esc(c.cost.latencyMs)}ms</td>
            <td class="mono">${esc(c.cost.quality)}</td>
          </tr>`
          )
          .join("")}
      </tbody>
    </table>`));

  /* 能力面速览：紧凑列表，导航职责交给侧栏与命令面板 */
  const mechList = el("div", "mech-list");
  for (const g of NAV_GROUPS) {
    for (const item of g.items) {
      const row = el("button", "mech-row", `
        <span class="mr-ico">${esc(item.icon)}</span>
        <span class="mr-title">${esc(item.title)}</span>
        <span class="mr-group">${esc(g.label)}</span>`);
      row.type = "button";
      row.addEventListener("click", () => { location.hash = `#/${item.path}`; });
      mechList.append(row);
    }
  }
  const mechCard = card(`<h3>能力面</h3><span class="sub">按意图分组 · 也可用 Ctrl+K 直接搜索</span>`, mechList);

  /* ---------- 装配 ---------- */

  wrap.append(
    healthBar,
    el("div", "section-gap"),
    card(`<h3>下一步</h3><span class="sub">基于当前内核状态推导</span>`, stepList),
    el("div", "section-gap"),
    statGrid
  );

  const lower = el("div", "grid cols-2 mt16");
  lower.append(traceCard, el("div", "", [channelCard, mechCard]));
  wrap.append(lower);

  root.append(wrap);

  async function refresh() {
    root.replaceChildren();
    return renderOverview(root);
  }

  return { dispose() {}, refresh };
}
