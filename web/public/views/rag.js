/**
 * 灵域推演 · Agentic RAG
 *
 * 八步管线的每一步都在界面上留下痕迹（状态 / 细节 / 耗时），因为"Agentic"
 * 的价值不在答案本身，而在**过程可复盘**：哪一步判定不足、为什么补搜、
 * 补搜把查询改写成了什么、答案锚定到哪些切片——全部可查。
 *
 * 两点刻意的诚实：
 *   · 没有配置真实模型时，合成走内核内置的 mock 通道，答案里会带 [Llm-Sim]
 *     前缀——不假装是模型说的；
 *   · 补搜最多一轮（maxRefines=1），判定不足也不能无限回流。
 */
import { api } from "../api.js";
import { el, esc, badge, toast, empty, card, fmtTime } from "../app.js";
import { RAG_STEPS } from "../kb.js";

const STEP_TONE = {
  done: { cls: "done", label: "完成", tone: "ok" },
  running: { cls: "active", label: "执行中", tone: "violet" },
  pending: { cls: "", label: "待执行", tone: "neutral" },
  skipped: { cls: "", label: "跳过", tone: "neutral" },
  failed: { cls: "", label: "失败", tone: "err" }
};

export async function renderRag(root) {
  const wrap = el("div", "");
  let kbs = [];
  try {
    kbs = await api.kbList();
  } catch (err) {
    root.append(el("div", "alert err", `<span>⚠</span><span class="msg">无法加载知识库：${esc(err.message)}</span>`));
    return { dispose() {} };
  }

  /* ---- 推演输入 ---- */
  const formCard = el("div", "card");
  const kbSel = el("select", "select");
  for (const kb of kbs) {
    const o = el("option", "", `${esc(kb.name)}（${kb.chunkCount} 切片）`);
    o.value = kb.id;
    kbSel.append(o);
  }
  const qF = el("textarea", "input");
  qF.rows = 3;
  qF.placeholder = "就这个知识库问一个问题。检索不足时会自动补搜一轮。";
  const kF = el("input", "input");
  kF.type = "number";
  kF.value = "4";
  kF.min = "1";
  kF.max = "10";

  const runBtn = el("button", "btn primary", "▶ 开始推演");
  runBtn.type = "button";
  runBtn.addEventListener("click", () => run());

  const body = el("div", "card-body");
  body.append(
    el("div", "grid cols-3", [field("知识库", kbSel), field("返回切片数 topK", kF)]),
    field("问题", qF),
    el("div", "row", [runBtn, el("span", "hint grow", "合成经内核 llm-access 通道；未配置真实模型时答案以 [Llm-Sim] 标注")])
  );
  formCard.append(el("div", "card-head", "<h3>灵域推演</h3><span class='sub'>解析 → 初检 → 评估 → 补搜 → 重排 → 合成 → 溯源 → 归档</span>"), body);

  /* ---- 结果区 ---- */
  const resultWrap = el("div", "mt16");

  /* ---- 历史 ---- */
  const historyCard = el("div", "card mt16");
  const historyBody = el("div", "card-body");
  historyCard.append(el("div", "card-head", "<h3>推演档案</h3><span class='sub' id='rag-hist-count'>—</span>"), historyBody);

  wrap.append(formCard, resultWrap, historyCard);
  root.append(wrap);

  async function run() {
    const question = qF.value.trim();
    if (!kbSel.value) { toast("请先选择知识库（若为空，去经卷库新建）", "err"); return; }
    if (!question) { toast("请输入问题", "err"); return; }
    runBtn.disabled = true;
    runBtn.textContent = "推演中…";
    resultWrap.replaceChildren(el("div", "alert", `<span class="spinner"></span><span class="msg">八步管线执行中：BM25 检索、充分性评估、按需补搜、经网关合成…</span>`));
    try {
      const run = await api.ragRun({ kbId: kbSel.value, question, topK: Number(kF.value || 4) });
      renderRun(run);
      toast(`推演完成：${run.hops} 轮补搜 · ${run.citations.length} 条引用 · ${run.ms}ms`, "ok");
    } catch (err) {
      resultWrap.replaceChildren(el("div", "alert err", `<span>✕</span><span class="msg">推演失败：${esc(err.message)}</span>`));
      toast(`推演失败：${err.message}`, "err", 5000);
    } finally {
      runBtn.disabled = false;
      runBtn.textContent = "▶ 开始推演";
      loadHistory();
    }
  }

  function renderRun(run) {
    const box = el("div", "");

    /* 八步管线 */
    const stepsCard = card(`<h3>八步管线</h3><span class="sub">${esc(run.id)} · 耗时 ${esc(run.ms)}ms · 补搜 ${esc(run.hops)} 轮</span>`, (() => {
      const list = el("div", "rag-steps");
      const byId = new Map((run.steps ?? []).map((s) => [s.id, s]));
      RAG_STEPS.forEach((def, i) => {
        const st = byId.get(def.id) ?? { status: "pending", detail: "", ms: null };
        const tone = STEP_TONE[st.status] ?? STEP_TONE.pending;
        const dot = st.status === "done" ? "✓" : st.status === "failed" ? "✕" : st.status === "skipped" ? "–" : String(i + 1);
        const step = el("div", `rag-step ${tone.cls}`, `
          <div class="rs-rail">
            <div class="rs-dot">${esc(dot)}</div>
            ${i < RAG_STEPS.length - 1 ? '<div class="rs-line"></div>' : ""}
          </div>
          <div class="rs-body">
            <div class="spread">
              <div class="rs-title">${esc(def.label)}</div>
              ${badge(tone.label, tone.tone)}${st.ms != null ? `<span class="hint mono">${esc(st.ms)}ms</span>` : ""}
            </div>
            <div class="rs-desc">${esc(def.desc)}</div>
            ${st.detail ? `<div class="rs-detail hint">${esc(st.detail)}</div>` : ""}
          </div>`);
        list.append(step);
      });
      return list;
    })());

    /* 答案与引用 */
    const answerBody = el("div", "");
    if (run.answer) {
      answerBody.append(el("div", "answer-card", esc(run.answer).replace(/\n/g, "<br>")));
    } else {
      answerBody.append(empty("本次推演没有产出答案", "✕"));
    }
    if (run.refinedQuery) {
      answerBody.append(el("div", "alert warn mt16", `
        <span>⟳</span><span class="msg"><b>查询已改写</b>（初检判定不足，触发补搜）：${esc(run.refinedQuery)}</span>`));
    }
    if (run.citations?.length) {
      answerBody.append(el("div", "sub mt16", `引用 ${run.citations.length} 条 · 点击展开原文`));
      for (const c of run.citations) {
        answerBody.append(el("div", "source-chip", `
          <div class="sc-head">
            <span class="hint mono">[${esc(c.index)}]</span>
            <b>${esc(c.docName)}</b>
            <span class="hint mono">片段 #${esc(c.chunkIndex)}</span>
            <span class="sc-score">${esc(c.score)}</span>
          </div>
          <div>${marked(c.text ?? "", c.ranges)}</div>`));
      }
    }
    const answerCard = card(`<h3>答案与溯源</h3><span class="sub">${esc(run.question)}</span>`, answerBody);

    box.append(el("div", "grid cols-2", [stepsCard, answerCard]));
    resultWrap.replaceChildren(box);
  }

  async function loadHistory() {
    let list = [];
    try {
      list = await api.ragRuns(kbSel.value || undefined);
    } catch { /* 历史加载失败不打扰主流程 */ }
    historyCard.querySelector("#rag-hist-count").textContent = `${list.length} 次推演`;
    if (list.length === 0) {
      historyBody.replaceChildren(empty("还没有推演记录", "✵"));
      return;
    }
    const tblWrap = el("div", "tbl-wrap");
    const tbl = el("table", "tbl");
    tbl.innerHTML = `<thead><tr><th>时间</th><th>问题</th><th>知识库</th><th class="num">补搜</th><th class="num">引用</th><th class="num">耗时</th></tr></thead>`;
    const tbody = el("tbody");
    for (const r of list) {
      const tr = el("tr", "", `
        <td class="mono">${fmtTime(r.createdAt)}</td>
        <td class="t-payload">${esc(r.question)}</td>
        <td>${esc(r.kbName)}</td>
        <td class="num">${esc(r.hops)}</td>
        <td class="num">${esc(r.citations?.length ?? r.hitCount ?? 0)}</td>
        <td class="num">${esc(r.ms ?? "—")}</td>`);
      tr.style.cursor = "pointer";
      tr.addEventListener("click", async () => {
        try {
          const detail = await api.ragDetail(r.id);
          renderRun({ ...detail, citations: (detail.citations ?? []).map((c, i) => ({ ...c, index: c.index ?? i + 1 })) });
        } catch (err) { toast(err.message, "err"); }
      });
      tbody.append(tr);
    }
    tbl.append(tbody);
    tblWrap.append(tbl);
    historyBody.replaceChildren(tblWrap);
  }

  kbSel.addEventListener("change", loadHistory);
  await loadHistory();

  return { dispose() {}, refresh: () => renderRag(root) };
}

function marked(text, ranges) {
  const src = String(text ?? "");
  const out = [];
  let at = 0;
  for (const [s, e] of ranges ?? []) {
    if (s > at) out.push(esc(src.slice(at, s)));
    out.push(`<mark>${esc(src.slice(s, e))}</mark>`);
    at = e;
  }
  out.push(esc(src.slice(at)));
  return out.join("");
}

function field(text, control) {
  const f = el("div", "field");
  f.append(el("label", "", esc(text)));
  f.append(control);
  return f;
}
