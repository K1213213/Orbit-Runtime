/**
 * 灵能账单
 *
 * 计量口径只有一处：桥接在**内核调用真实发生之后**记账（沙箱周期、网关
 * capabilityInvoke），单位取自通道声明的 costPerCall。因此这里没有"预估
 * 费用"——每个数字背后都是一次真实发生过的调用。
 *
 * 账本推导（deriveBilling）是 lib.js 的纯函数，服务端导出报告与前端展示
 * 共用同一份口径，数字对不上时只有一份实现可查。
 */
import { api } from "../api.js";
import { el, esc, empty, card, fmtTime, fmtDate, go } from "../app.js";

export async function renderBilling(root) {
  const wrap = el("div", "");

  let b;
  try {
    b = await api.billing();
  } catch (err) {
    root.append(el("div", "alert err", `<span>⚠</span><span class="msg">无法加载账单：${esc(err.message)}</span>`));
    return { dispose() {} };
  }

  /* ---- 指标 ---- */
  const statGrid = el("div", "stat-grid");
  statGrid.append(
    statCard("当前余额", b.balance, `${b.lowBalance ? "余额偏低" : "健康"} · 初始额度 ${b.grant}`, b.lowBalance ? "warn" : "ok"),
    statCard("累计消耗", b.total, `每笔能力调用实时计量`, "neutral"),
    statCard("今日消耗", b.todaySpend, `昨日 ${b.yesterdaySpend}`, "neutral"),
    (() => {
      const c = el("div", "stat-card");
      c.style.setProperty("--sc", "var(--brand-2)");
      const pctText = b.deltaPct === null ? "无昨日基数" : `${b.delta >= 0 ? "+" : ""}${b.deltaPct}%`;
      c.append(
        el("div", "sc-label", "日环比"),
        el("div", "sc-value", esc(b.delta >= 0 ? `+${b.delta}` : String(b.delta))),
        el("div", `sc-trend ${b.delta >= 0 ? "up" : "down"}`, esc(pctText)),
        el("div", "sc-foot", b.delta >= 0 ? "高于昨日" : "低于昨日")
      );
      return c;
    })()
  );

  /* ---- 7 日趋势 ---- */
  const chartCard = card(`<h3>近 7 日消耗</h3><span class="sub">空窗日补零，趋势线不断裂</span>`, (() => {
    const box = el("div", "");
    box.append(lineChart(b.trend));
    box.append(el("div", "chart-legend", `<span><i style="background:var(--brand-2)"></i>灵能单位 / 日</span><span class="hint">峰值 ${Math.max(0, ...b.trend.map((t) => t.units))}</span>`));
    return box;
  })());

  /* ---- 排行榜 ---- */
  const rankCard = card(`<h3>消耗排行</h3><span class="sub">按实例与任务聚合</span>`, el("div", "grid cols-2", [
    rankTable("实例", b.topBoxes, "box"),
    rankTable("任务", b.topTasks, "task")
  ]));

  /* ---- 明细 ---- */
  const detailCard = card(`<h3>账本明细</h3><span class="sub">最近 ${b.entries.length} 条</span>`, (() => {
    if (b.entries.length === 0) return empty("还没有消耗记录，跑一轮实例或推演即可产生计量", "⌾");
    const tblWrap = el("div", "tbl-wrap");
    const tbl = el("table", "tbl");
    tbl.innerHTML = `<thead><tr><th>时间</th><th>通道</th><th>原因</th><th>实例</th><th>任务</th><th class="num">单位</th></tr></thead>`;
    const tbody = el("tbody");
    for (const e of b.entries.slice(0, 60)) {
      tbody.append(el("tr", "", `
        <td class="mono">${esc(fmtDate(e.ts))} ${esc(fmtTime(e.ts))}</td>
        <td class="mono">${esc(e.channel)}</td>
        <td>${esc(e.reason || "—")}</td>
        <td class="mono">${esc(e.box || "—")}</td>
        <td class="mono">${esc(e.task || "—")}</td>
        <td class="num">${esc(e.units)}</td>`));
    }
    tbl.append(tbody);
    tblWrap.append(tbl);
    return tblWrap;
  })());

  const parts = [statGrid, el("div", "section-gap"), el("div", "grid cols-2", [chartCard, rankCard]), el("div", "section-gap"), detailCard];
  if (b.lowBalance) {
    parts.unshift(
      el("div", "alert warn", `<span>⚠</span><span class="msg">灵能余额低于 100：成本路由仍会工作，但建议到「成本路由」页收紧预算约束。</span>`),
      el("div", "section-gap")
    );
  }
  wrap.append(...parts);

  root.append(wrap);

  async function refresh() {
    root.replaceChildren();
    return renderBilling(root);
  }

  return { dispose() {}, refresh };
}

function statCard(label, value, foot, tone) {
  const c = el("div", "stat-card");
  c.style.setProperty("--sc", `var(--${tone === "warn" ? "warn" : tone === "ok" ? "ok" : "brand-2"})`);
  c.append(
    el("div", "sc-label", esc(label)),
    el("div", "sc-value", esc(value)),
    el("div", "sc-foot", esc(foot))
  );
  const quick = el("button", "sc-quick", "→");
  quick.title = "前往成本路由";
  quick.type = "button";
  quick.addEventListener("click", () => go("routing"));
  c.append(quick);
  return c;
}

function rankTable(title, rows, kind) {
  const max = Math.max(1, ...rows.map((r) => r.units));
  const box = el("div", "");
  box.append(el("div", "sub", esc(title)));
  if ((rows ?? []).length === 0) {
    box.append(empty("暂无数据", "·"));
    return box;
  }
  const list = el("div", "ver-list mt8");
  for (const r of rows) {
    const item = el("div", "ver-item", `<span class="ver-meta mono">${esc(r.id)}</span>`);
    item.append(el("span", "hint mono", `${esc(r.units)}`));
    list.append(item);
    const bar = el("div", "progress");
    const fill = el("i");
    fill.style.width = `${(r.units / max) * 100}%`;
    bar.append(fill);
    list.append(bar);
  }
  box.append(list);
  return box;
}

/**
 * 7 日折线：纯 SVG、无第三方库。
 * 坐标由数据决定，因此同一份数据永远画出同一条线——与项目"确定性"一致。
 */
function lineChart(trend) {
  const W = 520;
  const H = 200;
  const pad = { l: 36, r: 12, t: 12, b: 26 };
  const max = Math.max(1, ...trend.map((t) => t.units));
  const innerW = W - pad.l - pad.r;
  const innerH = H - pad.t - pad.b;
  const x = (i) => pad.l + (trend.length === 1 ? innerW / 2 : (i / (trend.length - 1)) * innerW);
  const y = (v) => pad.t + innerH - (v / max) * innerH;

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "chart-line");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("preserveAspectRatio", "none");

  for (let g = 0; g <= 3; g++) {
    const gy = pad.t + (innerH / 3) * g;
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", String(pad.l));
    line.setAttribute("x2", String(W - pad.r));
    line.setAttribute("y1", String(gy));
    line.setAttribute("y2", String(gy));
    line.setAttribute("stroke", "rgba(148,163,184,0.12)");
    line.setAttribute("stroke-width", "1");
    svg.append(line);
  }

  const pts = trend.map((t, i) => `${x(i).toFixed(1)},${y(t.units).toFixed(1)}`).join(" ");
  const poly = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
  poly.setAttribute("points", pts);
  poly.setAttribute("fill", "none");
  poly.setAttribute("stroke", "var(--brand-2)");
  poly.setAttribute("stroke-width", "2");
  poly.setAttribute("stroke-linejoin", "round");
  svg.append(poly);

  trend.forEach((t, i) => {
    const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    dot.setAttribute("cx", x(i).toFixed(1));
    dot.setAttribute("cy", y(t.units).toFixed(1));
    dot.setAttribute("r", "3");
    dot.setAttribute("fill", "var(--brand-1)");
    svg.append(dot);

    const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
    label.setAttribute("x", x(i).toFixed(1));
    label.setAttribute("y", String(H - 8));
    label.setAttribute("text-anchor", "middle");
    label.setAttribute("fill", "#6B7280");
    label.setAttribute("font-size", "10");
    label.textContent = t.day;
    svg.append(label);
  });

  return svg;
}
