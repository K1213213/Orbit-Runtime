/**
 * 成本路由视图（M4）：通道成本画像 + 预算/延迟约束下的路由模拟。
 */
import { api } from "../api.js";
import { el, esc, badge, toast, empty, loading } from "../app.js";

export async function renderRouting(root) {
  const wrap = el("div", "");

  /* ---- 通道画像 ---- */
  let profiles = [];
  try {
    profiles = await api.routingProfiles();
  } catch (err) {
    wrap.append(el("div", "alert err", `<span>⚠</span><span class="msg">${esc(err.message)}</span>`));
    root.append(wrap);
    return { dispose() {}, refresh: () => renderRouting(root) };
  }

  const tableCard = el("div", "card");
  tableCard.append(el("div", "card-head", "<h3>通道成本画像</h3><span class='sub'>cost / latency / quality 由通道声明（M4）</span>"));
  tableCard.append(el("div", "card-body", el("div", "tbl-wrap", `<table class="tbl">
    <thead><tr><th>通道</th><th>提供方</th><th>单次成本</th><th>预期延迟</th><th>质量</th></tr></thead>
    <tbody>
      ${profiles.map((p) => `
        <tr>
          <td class="mono">${esc(p.kind)}</td>
          <td>${badge(p.type === "builtin" ? "builtin" : "plugin", p.type === "builtin" ? "neutral" : "violet")}</td>
          <td class="mono">${p.costPerCall}</td>
          <td class="mono">${p.latencyMs}ms</td>
          <td class="mono">${p.quality}</td>
        </tr>`).join("")}
    </tbody></table>`)));

  /* ---- 模拟器 ---- */
  const simCard = el("div", "card mt16");
  simCard.append(el("div", "card-head", "<h3>预算路由模拟</h3><span class='sub'>在候选通道中选「满足预算与延迟约束」且最便宜的通道</span>"));
  const sBody = el("div", "card-body");

  const budgetRange = el("input");
  budgetRange.type = "range";
  budgetRange.min = "0";
  budgetRange.max = "3";
  budgetRange.step = "0.25";
  budgetRange.value = "1";
  const budgetVal = el("span", "slider-val", "1.0");

  const latencyRange = el("input");
  latencyRange.type = "range";
  latencyRange.min = "0";
  latencyRange.max = "800";
  latencyRange.step = "10";
  latencyRange.value = "500";
  const latencyVal = el("span", "slider-val", "500ms");

  sBody.append(
    el("div", "field", [
      el("label", "", "每轮成本预算 budget（成本 ≤ 预算 才可用）"),
      el("div", "slider-row", [budgetRange, budgetVal])
    ]),
    el("div", "field", [
      el("label", "", "最大可接受延迟 maxLatencyMs"),
      el("div", "slider-row", [latencyRange, latencyVal])
    ]),
    el("div", "mt8", [el("button", "btn primary", "模拟路由")])
  );

  const result = el("div", "mt16");
  sBody.append(result);
  simCard.append(sBody);

  budgetRange.addEventListener("input", () => { budgetVal.textContent = Number(budgetRange.value).toFixed(2); });
  latencyRange.addEventListener("input", () => { latencyVal.textContent = `${latencyRange.value}ms`; });

  async function simulate() {
    result.replaceChildren(loading());
    try {
      const r = await api.simulateRoute(Number(budgetRange.value), Number(latencyRange.value));
      render(r);
    } catch (err) {
      result.replaceChildren(el("div", "alert err", `<span>✕</span><span class="msg">${esc(err.message)}</span>`));
    }
  }

  function render(r) {
    const chosenMeta = r.chosen ? r.profiles.find((p) => p.kind === r.chosen) : null;
    const head = el("div");
    if (r.chosen) {
      head.className = "route-result";
      head.innerHTML = `
        <span style="font-size:22px">⌁</span>
        <div>
          <div class="route-name">${esc(r.chosen)}</div>
          <div class="route-desc">在预算 ${r.budget} / 延迟 ≤ ${r.maxLatencyMs}ms 约束下，选中了最便宜的可用通道（成本 ${chosenMeta?.costPerCall}，延迟 ${chosenMeta?.latencyMs}ms）</div>
        </div>`;
    } else {
      head.className = "alert err";
      head.innerHTML = `<span>✕</span><span class="msg"><b>无可用通道</b> —— 预算 ${r.budget} 买不起任何通道（LLM 单次成本 1）。调高预算试试。</span>`;
    }

    const table = el("div", "tbl-wrap mt12", `<table class="tbl">
      <thead><tr><th>候选</th><th>成本</th><th>延迟</th><th>质量</th><th>约束</th><th>选择</th></tr></thead>
      <tbody>${r.profiles.map((p) => `
        <tr style="${p.kind === r.chosen ? "background:rgba(34,211,238,0.06)" : ""}">
          <td class="mono">${esc(p.kind)}</td>
          <td class="mono">${p.costPerCall}</td>
          <td class="mono">${p.latencyMs}ms</td>
          <td class="mono">${p.quality}</td>
          <td>${p.fits ? badge("fits", "ok") : badge("over", "err")}</td>
          <td>${p.kind === r.chosen ? badge("✓ 选中", "accent") : ""}</td>
        </tr>`).join("")}</tbody></table>`);

    result.replaceChildren(head, table);
  }

  sBody.querySelector("button").addEventListener("click", simulate);
  simulate();

  wrap.append(tableCard, simCard);
  root.append(wrap);
  return { dispose() {}, refresh: () => renderRouting(root) };
}
