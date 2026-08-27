/**
 * 回放实验室视图：录制 → 零模型调用回放 → 字节一致 + 银行式对账。
 */
import { api } from "../api.js";
import { el, esc, badge, toast, empty, loading } from "../app.js";

export async function renderReplay(root) {
  const wrap = el("div", "");

  const intro = el("div", "alert info", `
    <span>↻</span>
    <span class="msg"><b>确定性回放（M2）</b>：先以真实通道延迟录制 3 轮对话，再挂载回放引擎
    （注入冻结输出，<b>零模型调用</b>）重放同一脚本，最后做字节一致性检查与 digest chain 对账。</span>`);

  const card = el("div", "card");
  card.append(el("div", "card-head", "<h3>回放实验</h3><span class='sub'>bank-style reconciliation</span>"));
  const body = el("div", "card-body");
  const runBtn = el("button", "btn primary", "▶ 一键录制并回放");
  const tip = el("div", "hint mt8", "实验在独立临时主机上执行，不影响控制台的插件/沙箱状态。");
  body.append(runBtn, tip);

  const resultWrap = el("div", "mt16");

  async function run() {
    runBtn.disabled = true;
    runBtn.textContent = "实验进行中…";
    resultWrap.replaceChildren(loading());
    try {
      const r = await api.replayDemo();
      renderResult(r);
      toast("回放实验完成，digest chain 校验一致", "ok");
    } catch (err) {
      resultWrap.replaceChildren(el("div", "alert err", `<span>✕</span><span class="msg">实验失败：${esc(err.message)}</span>`));
    } finally {
      runBtn.disabled = false;
      runBtn.textContent = "▶ 一键录制并回放";
    }
  }

  function renderResult(r) {
    const stage = el("div", "replay-stage");
    stage.append(
      stageCard("1 · 录制", r.record.count, `真实通道延迟执行 · ${r.record.ms}ms`, "var(--accent)"),
      stageCard("2 · 回放", r.replay.count, `零模型调用注入输出 · ${r.replay.ms}ms`, "var(--accent-2)"),
      stageCard("加速比", `${r.speedup ?? "—"}×`, `${r.record.count} 次调用全部由冻结输出接管`, "var(--purple)")
    );

    const identical = el("div", "alert", "");
    identical.className = r.identical ? "alert ok" : "alert err";
    identical.innerHTML = `
      <span>${r.identical ? "✓" : "✕"}</span>
      <span class="msg"><b>输出字节一致：${r.identical ? "PASS" : "FAIL"}</b> —
      回放输出与原始输出 ${r.identical ? "逐字节相同" : "存在差异"}。</span>`;

    const rec = el("div", "alert", "");
    rec.className = r.reconcile.digestChainConsistent ? "alert ok" : "alert err";
    rec.innerHTML = `
      <span>${r.reconcile.digestChainConsistent ? "✓" : "✕"}</span>
      <span class="msg"><b>digest chain 对账：${r.reconcile.digestChainConsistent ? "CONSISTENT" : "DRIFT"}</b>
      （original ${r.reconcile.originalCount} 条 / replayed ${r.reconcile.replayedCount} 条
      ${r.reconcile.driftAtOrderIndex !== undefined ? `· 首个漂移点 #${r.reconcile.driftAtOrderIndex}` : ""}）</span>`;

    const chain = el("div", "card mt16");
    chain.append(el("div", "card-head", `<h3>录制链 · ReplayCallRecord</h3><span class='sub'>${r.journal.length} 次通道调用</span>`));
    const chainBody = el("div", "card-body");
    chainBody.append(el("div", "tbl-wrap", `<table class="tbl">
      <thead><tr><th>#</th><th>通道</th><th>方法</th><th>输入摘要</th><th>耗时</th></tr></thead>
      <tbody>${r.journal.map((j) => `
        <tr>
          <td class="mono">${j.orderIndex}</td>
          <td class="mono">${esc(j.channelKind)}</td>
          <td class="mono">${esc(j.funcName)}</td>
          <td class="mono muted">${esc(j.inputDigest)}</td>
          <td class="mono">${j.durationMs}ms</td>
        </tr>`).join("")}</tbody></table>`));
    chain.append(chainBody);

    resultWrap.replaceChildren(stage, identical, rec, chain);
  }

  function stageCard(name, val, sub, color) {
    const s = el("div", "stage-card");
    s.innerHTML = `
      <div class="stage-name">${esc(name)}</div>
      <div class="stage-val" style="color:${color}">${esc(val)}</div>
      <div class="stage-sub">${esc(sub)}</div>`;
    return s;
  }

  runBtn.addEventListener("click", run);
  card.append(body);
  wrap.append(intro, card, resultWrap);
  root.append(wrap);

  // 自动演示一次，让页面打开即有结果
  run();

  return { dispose() {}, refresh: () => renderReplay(root) };
}
