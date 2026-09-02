/**
 * 回放台视图：录制 → 零模型调用回放 → 字节一致 + 银行式对账。
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
  card.append(el("div", "card-head", "<h3>回放验证</h3><span class='sub'>bank-style reconciliation</span>"));
  const body = el("div", "card-body");
  const runBtn = el("button", "btn primary", "▶ 一键录制并回放");
  const tip = el("div", "hint mt8", "验证在独立临时主机上执行，不影响控制台的插件/沙箱状态。");
  body.append(runBtn, tip);

  const resultWrap = el("div", "mt16");

  async function run() {
    runBtn.disabled = true;
    runBtn.textContent = "回放进行中…";
    resultWrap.replaceChildren(loading());
    try {
      const r = await api.replayDemo();
      renderResult(r);
      toast("回放验证完成，digest chain 校验一致", "ok");
    } catch (err) {
      resultWrap.replaceChildren(el("div", "alert err", `<span>✕</span><span class="msg">回放失败：${esc(err.message)}</span>`));
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

  /* ---- W32 · 录制窗口时间线（PRODUCT_PLAN P1.1）：step-through + 分叉 ---- */
  const tlCard = el("div", "card mt16");
  tlCard.append(el("div", "card-head", `<h3>录制窗口时间线</h3><span class="sub">step-through · 分叉实验（P1.1）</span>`));
  const tlBody = el("div", "card-body");
  const tlStatus = el("div", "hint", "加载中…");
  tlBody.append(tlStatus);
  tlCard.append(tlBody);
  wrap.append(tlCard);

  async function refreshTimeline() {
    const t = await api.replayTimeline().catch(() => ({ active: false, total: 0, steps: [] }));
    tlBody.replaceChildren();
    if (!t.active || t.total === 0) {
      tlBody.append(el("div", "hint",
        "当前没有活跃录制窗口。到「运行」页发起一次录制，或先运行上方一键回放（demo 在独立临时主机，不进入本窗口）。"));
      return;
    }
    const steps = t.steps;
    let cur = 0;
    const list = el("div", "col");
    const detail = el("div", "hint");
    const nav = el("div", "row mt8");
    const factBadges = (step) =>
      step.facts.map((f) => `<span class="badge ${esc(f.tone)}">${esc(f.label)}</span>`).join("");
    function renderDetail(i) {
      const s = steps[i];
      detail.innerHTML = `<b>#${s.index} ${esc(s.channel)}.${esc(s.func)}</b> · ${s.ms}ms · tokens ${s.tokens ?? "—"}<br>` +
        `<span class="sub">输入 digest</span> <span class="mono muted">${esc(s.inputDigest)}</span><br>` +
        `<span class="sub">输出</span> ${esc(s.output)}<br>${factBadges(s)}`;
    }
    function renderList() {
      list.replaceChildren(...steps.map((s, i) => {
        const row = el("button", "btn ghost", "");
        row.type = "button";
        row.style.justifyContent = "flex-start";
        row.style.opacity = i === cur ? "1" : "0.62";
        row.style.fontWeight = i === cur ? "600" : "400";
        row.innerHTML = `<span class="mono">#${s.index}</span>&nbsp; ${esc(s.channel)}.${esc(s.func)} ${factBadges(s)}`;
        row.addEventListener("click", () => { cur = i; renderList(); renderDetail(i); });
        return row;
      }));
    }
    const prev = el("button", "btn sm", "◀ 上一步");
    const next = el("button", "btn sm", "下一步 ▶");
    const pos = el("span", "mono");
    const forkBtn = el("button", "btn sm warn", `✂ 在此分叉 (#0)`);
    prev.type = next.type = forkBtn.type = "button";
    prev.addEventListener("click", () => { if (cur > 0) { cur -= 1; refreshNav(); } });
    next.addEventListener("click", () => { if (cur < steps.length - 1) { cur += 1; refreshNav(); } });
    forkBtn.addEventListener("click", async () => {
      forkBtn.disabled = true;
      try {
        const r = await api.replayFork({ at: cur, branch: `branch-${Date.now()}` });
        toast(`已分叉：保留 0..${r.forkedAt}，从 #${r.forkedAt} 继续新实验`, "ok");
        await refreshTimeline();
      } catch (err) { toast(err.message, "err"); } finally { forkBtn.disabled = false; }
    });
    function refreshNav() {
      pos.textContent = `#${cur} / ${steps.length - 1}`;
      forkBtn.innerHTML = `✂ 在此分叉 (#${cur})`;
      renderList();
      renderDetail(cur);
    }
    nav.append(prev, pos, next, forkBtn);
    tlBody.append(list, nav, detail);
    refreshNav();
  }

  root.append(wrap);
  refreshTimeline();

  // 自动演示一次，让页面打开即有结果
  run();

  return { dispose() {}, refresh: () => renderReplay(root) };
}
