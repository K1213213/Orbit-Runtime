/**
 * 数据总览 · 专业数据大盘
 *
 * 首屏定位为平台数据总控（区别于聊天型产品）：以实例 / 任务 / 工作流为核心，
 * 提供指标卡、运行实例矩阵、Token 消耗图表、最近任务、全局事件时间线。
 *
 * 数据全部来自 /api/dashboard（桥接一次性聚合），视图只做展示与轻量 SVG 图表，
 * 不做业务推导；健康结论由 lib.js 纯函数产出。
 */
import { api } from "../api.js";
import { el, esc, fmtTime, badge, empty, card, toast, go, confirmDialog } from "../app.js";
import { taskStatusMeta, taskKindMeta } from "../lib.js";

/* 实例消耗配色：用于环形图分片与图例 */
const BOX_COLORS = ["#6366F1", "#38BDF8", "#22D3EE", "#FB923C", "#EF4444", "#9CA3AF"];

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
  const b = d.billing ?? { balance: 0, grant: 0, todaySpend: 0, delta: 0, deltaPct: null, trend: [], topBoxes: [], topTasks: [] };
  const boxes = d.boxes ?? [];
  const runningCount = Math.max(0, Math.min(boxes.length, Number(d.running ?? boxes.length)));
  const offlineCount = Math.max(0, boxes.length - runningCount);
  const byStatus = d.tasks?.byStatus ?? {};

  /* ---------- 顶部健康条（专业后台惯用，非娱乐化） ---------- */
  const lvlText = health.level === "ok" ? "系统就绪" : health.level === "warn" ? "可运行（有告警）" : "不可用";
  wrap.append(
    el("div", `alert ${health.level}`, `
      <span>${health.level === "ok" ? "●" : health.level === "warn" ? "◐" : "○"}</span>
      <span class="msg"><b>${esc(lvlText)}</b>
      <span class="hint">OrbitRuntimeHost v${esc(d.version)} · 已运行 ${esc(fmtDuration(d.uptimeSec))} · 累计 ${esc(d.runCounter)} 轮</span></span>`)
  );

  /* ---------- 快捷操作 + 合规摘要（方案 D · 产品化首屏） ---------- */
  const quick = el("div", "row mt8");
  const makeGo = (label, route) => {
    const b = el("button", "btn sm", esc(label));
    b.type = "button";
    b.addEventListener("click", () => go(route));
    return b;
  };
  quick.append(makeGo("＋ 新建任务", "tasks"), makeGo("接入模型", "channels"), makeGo("导入知识", "knowledge"));
  const compLine = el("div", "hint grow");
  quick.append(compLine);
  api.complianceReport().then((r) => {
    const btn = makeGo("打开审计与合规 →", "trace");
    btn.className = "btn sm ghost";
    compLine.innerHTML = `<b>合规</b> · 审计 ${r.audit.status}（${r.audit.entries} 条）· 档位 ${esc(r.governance.profile)}${r.audit.status === "PASS" ? " · 链可出示" : ""}`;
    quick.append(btn);
  }).catch(() => {
    compLine.textContent = "合规报告暂不可用（需运行中的桥接宿主）";
  });

  wrap.append(quick);

  /* ---------- 模块1：四大核心指标卡 ---------- */
  const metrics = [
    {
      label: "智能体实例", value: boxes.length, route: "boxes",
      foot: `运行中 ${runningCount} · 离线 ${offlineCount}`, tone: "ok"
    },
    {
      label: "执行任务", value: d.tasks?.total ?? 0, route: "tasks",
      foot: `成功 ${byStatus.done ?? 0} · 异常 ${byStatus.failed ?? 0}`, tone: "violet"
    },
    {
      label: "知识库", value: d.counts?.docs ?? 0, route: "knowledge",
      foot: `${d.counts?.kbs ?? 0} 个知识库 · 已索引 ${d.counts?.docs ?? 0} 篇`, tone: "accent"
    },
    {
      label: "今日 Token 消耗", value: b.todaySpend, route: "billing",
      foot: `较昨日 ${b.delta >= 0 ? "+" : ""}${b.delta}${b.deltaPct != null ? `（${b.deltaPct}%）` : ""}`,
      tone: b.lowBalance ? "warn" : "ok"
    }
  ];
  const metricGrid = el("div", "metric-grid");
  for (const m of metrics) {
    const c = el("div", "metric-card");
    const quick = el("button", "mc-quick", "→");
    quick.type = "button";
    quick.title = "前往";
    quick.addEventListener("click", () => go(m.route));
    c.append(
      el("div", "mc-label", esc(m.label)),
      el("div", "mc-value", String(m.value)),
      el("div", `mc-foot ${m.tone === "warn" ? "warn" : ""}`, esc(m.foot)),
      quick
    );
    metricGrid.append(c);
  }
  wrap.append(el("div", "section-gap"), metricGrid);

  /* ---------- 模块2：运行实例状态矩阵 ---------- */
  const spendById = new Map((b.topBoxes ?? []).map((x) => [x.id, x.units]));
  const instanceCard = card(
    `<h3>运行实例状态矩阵</h3><span class="sub">${boxes.length} 个实例 · 点击查看详情</span>`,
    boxes.length === 0
      ? empty("暂无运行实例，去「智能体实例」创建一枚", "▣", "实例是平台的核心执行单元，每一轮推理都受循环预算约束并落入追踪日志。")
      : (() => {
          const grid = el("div", "instance-grid");
          for (const box of boxes) {
            const spend = spendById.get(box.agentBoxId);
            const card2 = el("div", "instance-card");
            const head = el("div", "ic-head", `
              <span class="ic-name">${esc(box.boxAlias ?? box.agentBoxId)}</span>
              ${badge("运行中", "ok")}`);
            const meta = el("div", "ic-meta", `
              <div><span class="hint">绑定模板</span> ${esc(box.baseInstruct ? "已绑定" : "未绑定")}</div>
              <div><span class="hint">当前任务</span> —</div>
              <div><span class="hint">今日消耗</span> ${spend != null ? esc(spend) : "—"}</div>
              <div><span class="hint">预算</span> 剩 ${Math.max(0, (box.maxCycleRun ?? 0) - (box.cycleNow ?? 0))} 轮</div>`);
            const actions = el("div", "ic-actions");
            const viewBtn = el("button", "btn sm", "查看");
            viewBtn.type = "button"; viewBtn.addEventListener("click", () => go("boxes"));
            const resetBtn = el("button", "btn sm ghost", "重启");
            resetBtn.type = "button";
            resetBtn.addEventListener("click", async () => {
              try { await api.resetBox(box.agentBoxId); toast("实例已重启", "ok"); await refresh(); }
              catch (e) { toast(`重启失败：${e.message}`, "err"); }
            });
            const stopBtn = el("button", "btn sm danger", "终止");
            stopBtn.type = "button";
            stopBtn.addEventListener("click", async () => {
              if (!(await confirmDialog("终止实例", `确认终止 ${box.boxAlias ?? box.agentBoxId}？该实例将移出运行池。`))) return;
              try { await api.removeBox(box.agentBoxId); toast("实例已终止", "ok"); await refresh(); }
              catch (e) { toast(`终止失败：${e.message}`, "err"); }
            });
            actions.append(viewBtn, resetBtn, stopBtn);
            card2.append(head, meta, actions);
            grid.append(card2);
          }
          return grid;
        })()
  );
  wrap.append(el("div", "section-gap"), instanceCard);

  /* ---------- 模块3：Token 消耗统计图表区 ---------- */
  const trendCard = card(`<h3>7 日消耗趋势</h3><span class="sub">单位 / 日</span>`, makeLineChart(b.trend ?? []));
  const ringCard = card(`<h3>实例消耗占比</h3><span class="sub">Top 实例</span>`, makeRingChart(b.topBoxes ?? []));
  const topCard = card(`<h3>Top5 高消耗任务</h3><span class="sub">按 Token 计</span>`, (() => {
    const list = el("ol", "rank-list");
    const arr = b.topTasks ?? [];
    if (arr.length === 0) return empty("暂无消耗记录", "⌾", "运行任务或 RAG 推演后将在此汇总。");
    for (const t of arr) {
      list.append(el("li", "rank-item", `
        <span class="rank-id mono">${esc(t.id)}</span>
        <span class="rank-val">${esc(t.units)}</span>`));
    }
    return list;
  })());
  wrap.append(el("div", "section-gap"), el("div", "grid cols-3", [trendCard, ringCard, topCard]));

  /* ---------- 模块4：最近任务列表（高密度表格） ---------- */
  const taskCard = card(
    `<h3>最近任务</h3><span class="sub">${d.tasks?.total ?? 0} 个 · 点击查看详情</span>`,
    d.tasks?.recent?.length === 0
      ? empty("还没有任务，去实例或编排页跑一轮", "⧉", "实例轮次、工作流编排与 RAG 推演都会在这里留下记录。")
      : taskTable(d.tasks.recent)
  );
  wrap.append(el("div", "section-gap"), taskCard);

  /* ---------- 模块5：全局事件时间线 ---------- */
  const traceCard = card(
    `<h3>全局事件时间线</h3><span class="sub">${d.traceCount ?? 0} 条 · 仅显示前 8 条</span>`,
    (() => {
      const list = el("div", "timeline");
      const entries = (d.recentTrace ?? []).slice(0, 8);
      if (entries.length === 0) return empty("暂无事件", "≡", "实例启动、任务执行、插件调用、知识库构建、异常报错与 Token 扣费都会在此留痕。");
      for (const e of entries) {
        const cls = e.entryClass ?? "OTHER";
        const who = e.pluginUnitId ?? e.agentBoxId ?? "host";
        const payload = JSON.stringify(e.factPayload ?? {});
        list.append(el("div", "tl-item", `
          <span class="tl-dot ec-${esc(cls)}"></span>
          <span class="tl-time mono">${fmtTime(e.occurredAt)}</span>
          <span class="tl-class">${esc(cls)}</span>
          <span class="tl-payload mono">${esc(who)} ${esc(payload.slice(0, 60))}${payload.length > 60 ? "…" : ""}</span>`));
      }
      return list;
    })()
  );
  wrap.append(el("div", "section-gap"), traceCard);

  root.append(wrap);

  async function refresh() {
    root.replaceChildren();
    return renderDashboard(root);
  }
  return { dispose() {}, refresh };
}

/* ------------------------------------------------------------------ */
/* 纯 SVG 图表（零依赖，可直接在 Node 单测中断言结构）                  */
/* ------------------------------------------------------------------ */

function makeLineChart(trend) {
  const W = 300, H = 96, pad = 8;
  const svg = el("svg", "chart-line");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("preserveAspectRatio", "none");
  const data = Array.isArray(trend) ? trend.map((t) => Number(t.units) || 0) : [];
  if (data.length === 0) {
    svg.innerHTML = `<text x="${W / 2}" y="${H / 2}" fill="#9CA3AF" font-size="11" text-anchor="middle">暂无数据</text>`;
    return svg;
  }
  const max = Math.max(1, ...data);
  const stepX = data.length > 1 ? (W - pad * 2) / (data.length - 1) : 0;
  const pts = data.map((v, i) => [pad + i * stepX, H - pad - (v / max) * (H - pad * 2)]);
  const line = pts.map((p) => p.join(",")).join(" ");
  const area = `${pad},${H - pad} ${line} ${pad + (data.length - 1) * stepX},${H - pad}`;
  svg.innerHTML = `
    <defs><linearGradient id="lineFill" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#6366F1" stop-opacity="0.35"/>
      <stop offset="100%" stop-color="#6366F1" stop-opacity="0"/>
    </linearGradient></defs>
    <polygon points="${area}" fill="url(#lineFill)"/>
    <polyline points="${line}" fill="none" stroke="#6366F1" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    ${pts.map((p, i) => `<circle cx="${p[0]}" cy="${p[1]}" r="2.4" fill="#38BDF8"/>`).join("")}
  `;
  return svg;
}

function makeRingChart(topBoxes) {
  const seg = (Array.isArray(topBoxes) ? topBoxes : []).slice(0, 6).map((x, i) => ({
    id: x.id, value: Number(x.units) || 0, color: BOX_COLORS[i % BOX_COLORS.length]
  }));
  const total = seg.reduce((a, s) => a + s.value, 0);
  const wrap = el("div", "ring-wrap");
  if (total === 0) {
    wrap.append(el("div", "hint", "暂无消耗数据"));
    return wrap;
  }
  const R = 42, C = 2 * Math.PI * R, cx = 50, cy = 50;
  const svg = el("svg", "chart-ring");
  svg.setAttribute("viewBox", "0 0 100 100");
  let offset = 0;
  const arcs = seg.map((s) => {
    const len = (s.value / total) * C;
    const arc = `<circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="${s.color}" stroke-width="12"
      stroke-dasharray="${len.toFixed(2)} ${(C - len).toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}"
      transform="rotate(-90 ${cx} ${cy})"/>`;
    offset += len;
    return arc;
  }).join("");
  svg.innerHTML = `<circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="#1E2230" stroke-width="12"/>${arcs}
    <text x="${cx}" y="${cy + 4}" fill="#E5E7EB" font-size="15" text-anchor="middle" font-weight="600">${total}</text>`;
  const legend = el("div", "ring-legend");
  seg.forEach((s, i) => {
    legend.append(el("div", "rl-item", `
      <span class="rl-dot" style="background:${BOX_COLORS[i % BOX_COLORS.length]}"></span>
      <span class="rl-id mono">${esc(s.id)}</span>
      <span class="rl-val">${s.value}</span>`));
  });
  wrap.append(svg, legend);
  return wrap;
}

function taskTable(tasks) {
  const table = el("div", "tbl-wrap", "");
  const tbl = el("table", "tbl");
  tbl.innerHTML = `<thead><tr>
    <th>任务</th><th>类型</th><th>状态</th><th class="num">耗时</th>
    <th class="num">Token</th><th>创建时间</th><th></th>
  </tr></thead>`;
  const tbody = el("tbody");
  for (const t of tasks) {
    const meta = taskStatusMeta(t.status);
    const kind = taskKindMeta(t.kind);
    const tr = el("tr", "", `
      <td>${esc(t.title)}<div class="hint mono">${esc(t.id)}</div></td>
      <td>${esc(kind.label)}</td>
      <td>${badge(meta.label, meta.tone)}</td>
      <td class="num">${t.endedAt && t.startedAt ? `${Math.max(0, t.endedAt - t.startedAt)}ms` : "—"}</td>
      <td class="num">${typeof t.units === "number" ? t.units : "—"}</td>
      <td>${esc(fmtTime(t.createdAt))}</td>
      <td><button class="btn sm ghost" type="button">查看</button></td>`);
    tr.style.cursor = "pointer";
    tr.addEventListener("click", () => go("tasks"));
    tbody.append(tr);
  }
  tbl.append(tbody);
  table.append(tbl);
  return table;
}

function fmtDuration(sec) {
  const s = Math.max(0, Number(sec) || 0);
  if (s < 60) return `${s} 秒`;
  if (s < 3600) return `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
  return `${Math.floor(s / 3600)} 时 ${Math.floor((s % 3600) / 60)} 分`;
}
