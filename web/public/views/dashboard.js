/**
 * 灵域总览 · 任务式工作台
 *
 * 首屏要回答的是"现在能干活吗、接下来做什么"，而不是把十几个页面的入口
 * 再抄一遍（那是侧栏和命令面板的职责）。因此首屏只有五件事：
 *
 *   1. 系统健康 —— 一个结论，带得出这个结论的每一条理由
 *   2. 关键指标 —— 数字本身，配一个可点进去的快捷入口
 *   3. 下一步   —— 基于真实状态推导的可执行入口，不是说明文字
 *   4. 现场证据 —— 最近任务与最近追踪，供快速核对
 *   5. 通道画像 —— 成本/延迟/质量，成本路由的输入
 *
 * 数据全部来自 /api/dashboard（桥接的一次性聚合），视图不做二次推导；
 * 健康结论与下一步由 lib.js 的纯函数产出，界面与单测共用同一份判定。
 */
import { api } from "../api.js";
import { el, esc, fmtTime, badge, empty, card, toast, go } from "../app.js";
import { taskStatusMeta, taskKindMeta } from "../lib.js";

const HEALTH_TEXT = {
  ok: "全部能力面就绪：通道、契约、沙箱、治理均已装配，可直接跑一轮 Agent 并回放验证。",
  warn: "主机已运行，但存在待处理项——按下方建议逐步补齐即可进入就绪状态。",
  err: "存在阻断项：在补齐之前，部分能力面无法工作。"
};

/* 指标卡顶栏色沿用影响域图的通道色板：绿=通道、紫=插件、青=沙箱、橙=接驳。 */
const METRICS = [
  { key: "channels", label: "能力通道", route: "channels", color: "#3cf2a8" },
  { key: "plugins", label: "已注册插件", route: "plugins", color: "#b78bff" },
  { key: "boxes", label: "Agent 沙箱", route: "boxes", color: "#39e6ff" },
  { key: "tools", label: "外来工具", route: "pae", color: "#ff9d4d" },
  { key: "traces", label: "追踪事件", route: "trace", color: "var(--gold)" },
  { key: "tasks", label: "阵法任务", route: "tasks", color: "var(--brand-2)" },
  { key: "docs", label: "知识切片", route: "knowledge", color: "var(--ok)" },
  { key: "workflows", label: "编排阵法", route: "workflow", color: "var(--brand-1)" }
];

export async function renderDashboard(root) {
  const wrap = el("div", "");

  let d;
  try {
    d = await api.dashboard();
  } catch (err) {
    wrap.append(
      el("div", "alert err", `<span>⚠</span><span class="msg">无法连接桥接服务：${esc(err.message)}</span>`)
    );
    root.append(wrap);
    return { dispose() {} };
  }

  const health = d.systemIssues ?? { level: "warn", issues: [] };
  const pae = d.pae ?? { enabled: false, adapters: 0, tools: 0 };

  /* ---------- 1. 系统健康 ---------- */

  wrap.append(
    el("div", `alert ${health.level}`, `
      <span>${health.level === "ok" ? "●" : health.level === "warn" ? "◐" : "○"}</span>
      <span class="msg"><b>${
        health.level === "ok" ? "系统就绪" : health.level === "warn" ? "可运行（有告警）" : "不可用"
      }</b> · ${esc(HEALTH_TEXT[health.level] ?? "")}
      <span class="hint">OrbitRuntimeHost v${esc(d.version)} · 已运行 ${esc(fmtDuration(d.uptimeSec))} · 累计 ${esc(d.runCounter)} 轮</span></span>`)
  );

  if (health.issues.length > 0) {
    const list = el("div", "ver-list");
    for (const issue of health.issues) {
      list.append(el("div", "ver-item", `
        ${badge(issue.level === "err" ? "阻断" : "告警", issue.level === "err" ? "err" : "warn")}
        <span class="ver-meta"><b>${esc(issue.text)}</b> — ${esc(issue.detail)}</span>`));
    }
    wrap.append(el("div", "section-gap"), card(`<h3>待处理项</h3><span class="sub">${health.issues.length} 条 · 由内核状态推导</span>`, list));
  }

  /* ---------- 2. 关键指标 ---------- */

  const values = {
    channels: d.channels.length,
    plugins: d.plugins.length,
    boxes: d.boxes.length,
    tools: pae.tools ?? 0,
    traces: d.traceCount,
    tasks: d.tasks.total,
    docs: d.counts.docs,
    workflows: d.counts.workflows
  };
  const foots = {
    channels: `${d.channels.filter((c) => c.type === "plugin").length} 个由插件覆盖`,
    plugins: "pact 三重校验通过",
    boxes: "独立预算执行环境",
    tools: pae.enabled ? `${pae.adapters} 个适配器` : "未接入",
    traces: `累计运行 ${d.runCounter} 轮`,
    tasks: statusLine(d.tasks.byStatus),
    docs: `${d.counts.kbs} 个知识库`,
    workflows: `${d.counts.templates} 个灵仆模板`
  };

  const statGrid = el("div", "stat-grid");
  for (const m of METRICS) {
    const c = el("div", "stat-card");
    c.style.setProperty("--sc", m.color);
    c.append(
      el("div", "sc-label", esc(m.label)),
      el("div", "sc-value", esc(values[m.key] ?? 0)),
      el("div", "sc-foot", esc(foots[m.key] ?? ""))
    );
    const quick = el("button", "sc-quick", "→");
    quick.title = "前往";
    quick.type = "button";
    quick.addEventListener("click", () => go(m.route));
    c.append(quick);
    statGrid.append(c);
  }

  wrap.append(el("div", "section-gap"), statGrid);

  /* ---------- 3. 下一步 ---------- */

  const steps = d.nextSteps ?? [];
  const stepList = el("div", "ver-list");
  steps.forEach((s, i) => {
    const item = el("button", `ver-item${s.primary ? " current" : ""}`, `
      <span class="ver-no">${i + 1}</span>
      <span class="ver-meta"><b>${esc(s.title)}</b><br>${esc(s.desc)}</span>
      <span class="hint">${s.action === "boot" ? "立即执行" : "前往"} →</span>`);
    item.type = "button";
    item.style.cursor = "pointer";
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
      go(s.route);
    });
    stepList.append(item);
  });

  /* ---------- 4 & 5. 现场证据 ---------- */

  const taskCard = card(
    `<h3>最近任务</h3><span class="sub">${d.tasks.total} 个 · 点击查看详情</span>`,
    d.tasks.recent.length === 0
      ? empty("还没有任务，去实例或编排页跑一轮", "⧉")
      : taskTable(d.tasks.recent)
  );

  const traceCard = card(
    `<h3>最近追踪</h3><span class="sub">${d.traceCount} 条 · 仅显示前 6 条</span>`,
    (() => {
      const list = el("div", "mini-trace");
      for (const entry of (d.recentTrace ?? [])) {
        const cls = entry.entryClass ?? "OTHER";
        const who = entry.pluginUnitId ?? entry.agentBoxId ?? "host";
        const payload = JSON.stringify(entry.factPayload ?? {});
        list.append(el("div", "t-entry", `
          <span class="t-time mono">${fmtTime(entry.occurredAt)}</span>
          <span class="t-class ec-${esc(cls)}">${esc(cls)}</span>
          <span class="t-payload mono">${esc(who)} ${esc(payload.slice(0, 70))}${payload.length > 70 ? "…" : ""}</span>`));
      }
      return list;
    })()
  );

  const channelCard = card(`<h3>通道画像</h3><span class="sub">成本路由的输入</span>`, el("div", "tbl-wrap", `
    <table class="tbl">
      <thead><tr><th>通道</th><th>提供方</th><th class="num">成本</th><th class="num">延迟</th><th class="num">质量</th></tr></thead>
      <tbody>
        ${d.channels
          .map(
            (c) => `
          <tr>
            <td class="mono">${esc(c.kind)}</td>
            <td>${badge(c.type === "builtin" ? "builtin" : "plugin", c.type === "builtin" ? "neutral" : "violet")}</td>
            <td class="num">${esc(c.cost.costPerCall)}</td>
            <td class="num">${esc(c.cost.latencyMs)}ms</td>
            <td class="num">${esc(c.cost.quality)}</td>
          </tr>`
          )
          .join("")}
      </tbody>
    </table>`));

  const spendCard = card(`<h3>灵能余额</h3><span class="sub">每次能力调用实时计量</span>`, (() => {
    const b = d.billing;
    const pct = b.grant > 0 ? Math.max(0, Math.min(100, (b.balance / b.grant) * 100)) : 0;
    const box = el("div", "");
    box.append(el("div", "spread", `
      <span class="sc-value" style="font-size:26px">${esc(b.balance)}</span>
      <span class="hint">已消耗 ${esc(b.total)} / ${esc(b.grant)}</span>`));
    const bar = el("div", `progress mt8${b.lowBalance ? " warn" : ""}`);
    const fill = el("i");
    fill.style.width = `${pct}%`;
    bar.append(fill);
    box.append(bar);
    box.append(el("div", "hint mt8", `今日消耗 ${b.todaySpend} · 较昨日 ${b.delta >= 0 ? "+" : ""}${b.delta}`));
    const link = el("button", "btn sm mt8", "查看账单 →");
    link.type = "button";
    link.addEventListener("click", () => go("billing"));
    box.append(link);
    return box;
  })());

  wrap.append(
    el("div", "section-gap"),
    card(`<h3>下一步</h3><span class="sub">基于当前内核状态推导</span>`, stepList)
  );

  const lower = el("div", "grid cols-2 mt16");
  lower.append(taskCard, el("div", "", [spendCard, el("div", "section-gap"), traceCard]));
  wrap.append(lower);
  wrap.append(el("div", "section-gap"), channelCard);

  root.append(wrap);

  async function refresh() {
    root.replaceChildren();
    return renderDashboard(root);
  }

  return { dispose() {}, refresh };
}

function taskTable(tasks) {
  const table = el("div", "tbl-wrap", "");
  const tbl = el("table", "tbl");
  tbl.innerHTML = `<thead><tr><th>任务</th><th>类型</th><th>状态</th><th class="num">耗时</th></tr></thead>`;
  const tbody = el("tbody");
  for (const t of tasks) {
    const meta = taskStatusMeta(t.status);
    const kind = taskKindMeta(t.kind);
    const tr = el("tr", "", `
      <td>${esc(t.title)}<div class="hint mono">${esc(t.id)}</div></td>
      <td>${esc(kind.label)}</td>
      <td>${badge(meta.label, meta.tone)}</td>
      <td class="num">${t.endedAt && t.startedAt ? `${Math.max(0, t.endedAt - t.startedAt)}ms` : "—"}</td>`);
    tr.style.cursor = "pointer";
    tr.addEventListener("click", () => go("tasks"));
    tbody.append(tr);
  }
  tbl.append(tbody);
  table.append(tbl);
  return table;
}

function statusLine(byStatus) {
  const parts = Object.entries(byStatus ?? {}).map(([k, v]) => `${taskStatusMeta(k).label} ${v}`);
  return parts.length ? parts.join(" · ") : "暂无任务";
}

function fmtDuration(sec) {
  const s = Math.max(0, Number(sec) || 0);
  if (s < 60) return `${s} 秒`;
  if (s < 3600) return `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
  return `${Math.floor(s / 3600)} 时 ${Math.floor((s % 3600) / 60)} 分`;
}
