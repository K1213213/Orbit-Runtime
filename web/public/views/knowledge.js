/**
 * 经卷库 · 知识库与切片索引
 *
 * 检索是**确定性词法索引（BM25）**，不是向量服务：分数只由 (语料, 查询, 参数)
 * 决定，同样的输入永远得到同样的排序——这与内核"可重放"的气质一致，也让
 * "为什么这条命中"可以被解释（分数 + 命中区间都展示出来）。
 *
 * 切片规则同样摆在明面上：目标长度与重叠率就是 UI 上的两个数字，参数改了
 * 生效的就是这两个数字，没有隐藏的二次切分。
 */
import { api } from "../api.js";
import { el, esc, toast, empty, drawer, modal, confirmDialog, fmtDate } from "../app.js";

export async function renderKnowledge(root) {
  const wrap = el("div", "");
  let kbId = null;

  /* ---- 知识库选择 + 新建 ---- */
  const headCard = el("div", "card");
  const headBody = el("div", "card-body");
  const sel = el("select", "select");
  sel.addEventListener("change", () => { kbId = sel.value; loadKb(); });

  const createBtn = el("button", "btn primary sm", "＋ 新建知识库");
  createBtn.type = "button";
  createBtn.addEventListener("click", () => openCreate());

  const removeBtn = el("button", "btn sm danger", "删除本库");
  removeBtn.type = "button";
  removeBtn.addEventListener("click", async () => {
    if (!kbId) return;
    const ok = await confirmDialog("删除知识库", `确认删除 ${kbId}？其中全部文档与切片将一并移除（不可恢复）。`, "删除");
    if (!ok) return;
    try {
      await api.kbRemove(kbId);
      toast("知识库已删除", "ok");
      await loadList();
    } catch (err) { toast(err.message, "err"); }
  });

  const headRow = el("div", "grid cols-3");
  headRow.append(field("知识库", sel), el("div", "row", [createBtn, removeBtn]));
  headBody.append(headRow);
  headCard.append(el("div", "card-head", "<h3>经卷库</h3><span class='sub' id='kb-sum'>—</span>"), headBody);

  /* ---- 文档与切片 ---- */
  const docsCard = el("div", "card mt16");
  const docsBody = el("div", "card-body");
  docsCard.append(el("div", "card-head", `
    <h3>文档与切片</h3><span class="sub" id="doc-sum">—</span>
    <div class="head-actions"><button class="btn sm primary" id="kb-upload-btn">＋ 入库文档</button></div>`), docsBody);

  /* ---- 检索试验台 ---- */
  const searchCard = el("div", "card mt16");
  const searchBody = el("div", "card-body");
  const qF = el("input", "input");
  qF.placeholder = "输入检索词，观察 BM25 分数与命中区间…";
  const kF = el("input", "input");
  kF.type = "number";
  kF.value = "5";
  kF.min = "1";
  kF.max = "20";
  const searchBtn = el("button", "btn primary", "检索");
  searchBtn.type = "button";
  searchBtn.addEventListener("click", () => search());
  qF.addEventListener("keydown", (e) => { if (e.key === "Enter") search(); });

  const searchRow = el("div", "grid cols-3");
  searchRow.append(field("检索词", qF), field("返回条数 k", kF), el("div", "field", [el("label", "", "　"), searchBtn]));
  const hits = el("div", "mt16");
  searchBody.append(searchRow, hits);
  searchCard.append(el("div", "card-head", "<h3>检索试验台</h3><span class='sub'>确定性 BM25 · 分数与命中区间如实呈现</span>"), searchBody);

  wrap.append(headCard, docsCard, searchCard);
  root.append(wrap);

  docsCard.querySelector("#kb-upload-btn").addEventListener("click", () => openUpload());

  async function loadList() {
    const list = await api.kbList();
    sel.replaceChildren();
    for (const kb of list) {
      const o = el("option", "", `${esc(kb.name)}（${kb.docCount} 文档 / ${kb.chunkCount} 切片）`);
      o.value = kb.id;
      sel.append(o);
    }
    if (!list.some((k) => k.id === kbId)) kbId = list[0]?.id ?? null;
    if (kbId) sel.value = kbId;
    headCard.querySelector("#kb-sum").textContent = `${list.length} 个知识库 · 索引在文档变更时惰性重建`;
    await loadKb();
  }

  async function loadKb() {
    hits.replaceChildren();
    if (!kbId) {
      docsBody.replaceChildren(empty("还没有知识库，先新建一个", "❑", "知识库是灵域推演的语料来源：文档入库后按段落切片并建立 BM25 索引。"));
      docsCard.querySelector("#doc-sum").textContent = "—";
      return;
    }
    let detail;
    try {
      detail = await api.kbDetail(kbId);
    } catch (err) {
      docsBody.replaceChildren(el("div", "alert err", `<span>⚠</span><span class="msg">${esc(err.message)}</span>`));
      return;
    }
    docsCard.querySelector("#doc-sum").textContent = `${detail.docCount} 文档 · ${detail.chunkCount} 切片 · 已索引 ${detail.indexedChunks}`;

    if (detail.docs.length === 0) {
      docsBody.replaceChildren(empty("本库还没有文档，点右上角入库一篇", "❑"));
      return;
    }
    const tblWrap = el("div", "tbl-wrap");
    const tbl = el("table", "tbl");
    tbl.innerHTML = `<thead><tr><th>文档</th><th class="num">切片</th><th>入库时间</th><th>操作</th></tr></thead>`;
    const tbody = el("tbody");
    for (const doc of detail.docs) {
      const tr = el("tr", "", `
        <td>${esc(doc.name)}</td>
        <td class="num">${esc(doc.chunkCount)}</td>
        <td class="mono">${esc(fmtDate(doc.createdAt))}</td>
        <td></td>`);
      const view = el("button", "btn sm", "查看切片");
      view.type = "button";
      view.addEventListener("click", () => openChunks(doc));
      tr.lastElementChild.append(view);
      tbody.append(tr);
    }
    tbl.append(tbody);
    tblWrap.append(tbl);
    docsBody.replaceChildren(tblWrap);
  }

  async function search() {
    const query = qF.value.trim();
    if (!kbId) { toast("请先选择知识库", "err"); return; }
    if (!query) { toast("请输入检索词", "err"); return; }
    searchBtn.disabled = true;
    try {
      const res = await api.kbSearch(kbId, query, Number(kF.value || 5));
      if (res.hits.length === 0) {
        hits.replaceChildren(empty(`「${query}」没有命中任何切片`, "◌", "BM25 是词法检索：查询词与语料没有共同词元即无分。"));
        return;
      }
      const list = el("div", "");
      list.append(el("div", "sub", `命中 ${res.hits.length} / 共 ${res.total} 切片（按分数降序）`));
      for (const h of res.hits) {
        const chip = el("div", "source-chip", `
          <div class="sc-head">
            <b>${esc(h.docName)}</b>
            <span class="hint mono">片段 #${esc(h.chunkIndex)}</span>
            <span class="sc-score">${esc(h.score)}</span>
          </div>
          <div>${marked(h.text, h.ranges)}</div>`);
        chip.addEventListener("click", () => openChunk(h));
        list.append(chip);
      }
      hits.replaceChildren(list);
    } catch (err) {
      toast(`检索失败：${err.message}`, "err");
    } finally {
      searchBtn.disabled = false;
    }
  }

  async function openChunks(doc) {
    let data;
    try {
      data = await api.kbDoc(kbId, doc.id);
    } catch (err) {
      toast(`加载失败：${err.message}`, "err");
      return;
    }
    const body = el("div", "");
    body.append(el("div", "sub", `${data.chunkCount} 个切片 · 段落优先、同段相邻片按 15% 重叠`));
    for (const c of data.chunks) {
      body.append(el("div", "source-chip mt8", `
        <div class="sc-head"><b>#${esc(c.index)}</b><span class="hint">${esc(c.text.length)} 字符</span></div>
        <div>${esc(c.text)}</div>`));
    }
    drawer(`《${doc.name}》切片`, body);
  }

  function openChunk(hit) {
    const body = el("div", "");
    body.append(el("div", "kv", `
      <dt>来源</dt><dd>${esc(hit.docName)}</dd>
      <dt>片段</dt><dd>#${esc(hit.chunkIndex)}</dd>
      <dt>分数</dt><dd>${esc(hit.score)}</dd>`));
    body.append(el("div", "source-chip mt16", marked(hit.text, hit.ranges)));
    drawer("切片溯源", body);
  }

  function openCreate() {
    const nameF = el("input", "input");
    nameF.placeholder = "如：产品 FAQ";
    const descF = el("textarea", "input");
    descF.placeholder = "一句话说明这个库装的是什么";
    const body = el("div", "", [field("名称 *", nameF), field("描述", descF)]);
    const m = modal("新建知识库", body, el("div", "row"));
    const cancel = el("button", "btn", "取消");
    const ok = el("button", "btn primary", "创建");
    cancel.type = ok.type = "button";
    cancel.addEventListener("click", () => m.close());
    ok.addEventListener("click", async () => {
      if (!nameF.value.trim()) { toast("名称为必填", "err"); return; }
      try {
        const kb = await api.kbCreate({ name: nameF.value.trim(), desc: descF.value.trim() });
        toast(`知识库「${kb.name}」已创建`, "ok");
        kbId = kb.id;
        m.close();
        await loadList();
      } catch (err) { toast(err.message, "err"); }
    });
    m.foot.append(cancel, ok);
    nameF.focus();
  }

  function openUpload() {
    if (!kbId) { toast("请先选择知识库", "err"); return; }
    const nameF = el("input", "input");
    nameF.placeholder = "如：接入指南.md";
    const contentF = el("textarea", "input");
    contentF.rows = 10;
    contentF.placeholder = "粘贴文档正文。空行分段——段落即语义单元，切片不会跨段拼接。";
    const body = el("div", "", [field("文档名 *", nameF), field("内容 *", contentF)]);
    const m = modal("文档入库", body, el("div", "row"));
    const cancel = el("button", "btn", "取消");
    const ok = el("button", "btn primary", "入库并重建索引");
    cancel.type = ok.type = "button";
    cancel.addEventListener("click", () => m.close());
    ok.addEventListener("click", async () => {
      if (!nameF.value.trim() || !contentF.value.trim()) { toast("文档名与内容均为必填", "err"); return; }
      ok.disabled = true;
      ok.textContent = "切片中…";
      try {
        const res = await api.kbUpload(kbId, { name: nameF.value.trim(), content: contentF.value });
        toast(`《${res.uploaded.name}》入库：${res.uploaded.chunkCount} 个切片`, "ok");
        m.close();
        await loadKb();
      } catch (err) {
        toast(err.message, "err");
        ok.disabled = false;
        ok.textContent = "入库并重建索引";
      }
    });
    m.foot.append(cancel, ok);
    nameF.focus();
  }

  try {
    await loadList();
  } catch (err) {
    wrap.append(el("div", "alert err", `<span>⚠</span><span class="msg">${esc(err.message)}</span>`));
  }

  return { dispose() {}, refresh: () => renderKnowledge(root) };
}

/** 按命中区间包裹 <mark>：先转义再插标签，避免把语料当 HTML 执行。 */
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
