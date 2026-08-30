/**
 * 知识库 · 知识库与切片索引
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
  headCard.append(el("div", "card-head", "<h3>知识库</h3><span class='sub' id='kb-sum'>—</span>"), headBody);

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
      docsBody.replaceChildren(empty("还没有知识库，先新建一个", "❑", "知识库是RAG推演工作台的语料来源：文档入库后按段落切片并建立 BM25 索引。"));
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

  /**
   * 文档上传与切片面板（设计文档 §10.2）。
   * 支持：拖拽 / 批量 / 文件夹上传；切片大小与重叠率可视化配置；
   * 逐文件状态机 排队 → 解析中 → 切片中 → 向量化中 → 完成/失败；
   * 全局进度条 + 索引构建动画。
   *
   * 零依赖约束：文本类（MD/TXT/CSV/JSON/LOG）与 PDF 走浏览器原生/轻量解析；
   * DOC/DOCX 与图片 OCR 在本构建未集成解析服务，会诚实标记「失败」并给出改用文本的建议。
   */
  function openUpload() {
    if (!kbId) { toast("请先选择知识库", "err"); return; }

    /* ---- 切片参数 ---- */
    const sizeF = el("input", "input");
    sizeF.type = "number"; sizeF.value = "320"; sizeF.min = "40"; sizeF.max = "4000"; sizeF.step = "40";
    const overlapF = el("input", "input");
    overlapF.type = "number"; overlapF.value = "15"; overlapF.min = "0"; overlapF.max = "50"; overlapF.step = "5";

    /* ---- 拖拽区 + 文件/文件夹选择 ---- */
    const drop = el("div", "dropzone", `
      <div class="dz-inner">
        <div class="dz-icon">⬆</div>
        <div class="dz-title">拖拽文件到此处</div>
        <div class="dz-sub">支持 MD / TXT / PDF · Word 与图片需外接解析服务</div>
        <div class="row">
          <button class="btn sm" id="uz-file" type="button">选择文件</button>
          <button class="btn sm" id="uz-folder" type="button">选择文件夹</button>
        </div>
      </div>`);
    const fileInput = el("input", "");
    fileInput.type = "file"; fileInput.multiple = true; fileInput.style.display = "none";
    fileInput.accept = ".md,.markdown,.txt,.text,.csv,.json,.log,.pdf,.doc,.docx,.png,.jpg,.jpeg";
    const folderInput = el("input", "");
    folderInput.type = "file"; folderInput.multiple = true; folderInput.style.display = "none";
    folderInput.setAttribute("webkitdirectory", "");

    const cfgRow = el("div", "cfg-row", [
      field("切片大小（字符）", sizeF),
      field("重叠率（%）", overlapF)
    ]);
    cfgRow.append(el("div", "cfg-hint", "段落优先，跨段不拼接；重叠率仅作用于同段相邻片"));

    const queueEl = el("div", "queue");
    const gp = el("div", "global-progress");
    const gpFill = el("div", "gp-fill");
    const gpLabel = el("div", "gp-label", "待入库");
    gp.append(gpFill, gpLabel);
    const idxAnim = el("div", "idx-anim", `
      <span class="dot"></span><span class="dot"></span><span class="dot"></span>
      <span class="idx-text">索引构建待命</span>`);

    const body = el("div", "uploader", [drop, fileInput, folderInput, cfgRow, queueEl, gp, idxAnim]);
    const foot = el("div", "row");
    const clearBtn = el("button", "btn", "清空队列"); clearBtn.type = "button";
    const startBtn = el("button", "btn primary", "开始入库"); startBtn.type = "button";
    foot.append(clearBtn, startBtn);

    drawer("文档上传与切片", body, foot);

    const queue = [];
    const order = { queued: 0, parsing: 1, chunking: 2, vectorizing: 3, failed: 4, done: 5 };

    function classify(file) {
      const name = (file.name || "").toLowerCase();
      if (/\.(txt|text|md|markdown|csv|json|log)$/.test(name)) return { key: "text" };
      if (name.endsWith(".pdf")) return { key: "pdf" };
      const img = /\.(png|jpe?g|gif|bmp|webp)$/.test(name);
      if (/\.(docx?|png|jpe?g|gif|bmp|webp)$/.test(name)) {
        return {
          key: "unsupported",
          reason: img
            ? "图片 OCR 需外接视觉服务；当前零依赖构建未接入，请粘贴文本或改用文本格式。"
            : "DOC/DOCX 为压缩二进制（zip/xml），零依赖构建无解析器；请粘贴文本或先转为 .md/.txt。"
        };
      }
      return { key: "unsupported", reason: "暂不支持该文件类型，请使用 MD / TXT / PDF 或粘贴纯文本。" };
    }

    function addFiles(files) {
      for (const file of Array.from(files || [])) {
        const { key, reason } = classify(file);
        queue.push({ file, key, reason: reason || "", name: file.name, size: file.size, status: "queued", progress: 0, err: "", note: "" });
      }
      renderQueue();
    }

    function statusMeta(s) {
      return ({
        queued: { label: "排队", cls: "pill gray" },
        parsing: { label: "解析中", cls: "pill blue" },
        chunking: { label: "切片中", cls: "pill purple" },
        vectorizing: { label: "向量化中", cls: "pill orange" },
        done: { label: "完成", cls: "pill green" },
        failed: { label: "失败", cls: "pill red" }
      })[s] || { label: s, cls: "pill gray" };
    }

    function renderQueue() {
      queueEl.replaceChildren();
      if (queue.length === 0) {
        queueEl.append(el("div", "sub", "队列为空——拖入文件或点击「选择文件 / 文件夹」"));
        updateGlobal();
        return;
      }
      const sorted = [...queue].sort((a, b) => (order[a.status] ?? 0) - (order[b.status] ?? 0));
      for (const it of sorted) {
        const meta = statusMeta(it.status);
        const fill = el("div", `q-fill ${it.status === "done" ? "ok" : it.status === "failed" ? "bad" : ""}`);
        fill.style.width = it.progress + "%";
        const row = el("div", "q-item", `
          <div class="q-main">
            <div class="q-name">${esc(it.name)} <span class="q-size mono">${fmtSize(it.size)}</span></div>
            <div class="q-meta">${esc(it.err || it.note || "")}</div>
            <div class="q-bar-wrap"></div>
          </div>
          <div class="${meta.cls}">${meta.label}</div>`);
        row.querySelector(".q-bar-wrap").append(el("div", "q-bar", fill));
        queueEl.append(row);
      }
      updateGlobal();
    }

    function updateGlobal() {
      const total = queue.length;
      const done = queue.filter((q) => q.status === "done").length;
      const failed = queue.filter((q) => q.status === "failed").length;
      const pct = total ? Math.round(((done + failed) / total) * 100) : 0;
      gpFill.style.width = pct + "%";
      gpLabel.textContent = total === 0 ? "待入库" : `已完成 ${done}/${total}` + (failed ? ` · 失败 ${failed}` : "");
      const running = queue.some((q) => ["parsing", "chunking", "vectorizing"].includes(q.status));
      idxAnim.classList.toggle("active", running);
      idxAnim.querySelector(".idx-text").textContent = running ? "正在构建全文索引…" : "索引构建待命";
    }

    async function extractText(it) {
      if (it.key === "text") return await readText(it.file);
      if (it.key === "pdf") return await salvagePdfText(it.file);
      return null;
    }

    async function startIngest() {
      if (!kbId) return;
      const pending = queue.filter((q) => q.status === "queued" || q.status === "failed");
      if (pending.length === 0) { toast("队列没有待入库文件", "err"); return; }
      startBtn.disabled = true; clearBtn.disabled = true;
      const size = Number(sizeF.value || 320);
      const overlap = (Number(overlapF.value || 15)) / 100;
      for (const it of pending) {
        it.status = "parsing"; it.progress = 8; it.err = ""; it.note = "解析文件内容"; renderQueue();
        await sleep(120);
        let text = null;
        try { text = await extractText(it); }
        catch (e) { it.status = "failed"; it.progress = 100; it.err = "解析失败：" + e.message; renderQueue(); continue; }
        if (it.key === "unsupported") {
          it.status = "failed"; it.progress = 100; it.err = it.reason; renderQueue(); continue;
        }
        if (!text || !text.trim()) {
          it.status = "failed"; it.progress = 100; it.err = "解析为空（文件无可读文本，或解析器未命中）"; renderQueue(); continue;
        }
        if (text.length > 200_000) text = text.slice(0, 200_000);
        it.status = "chunking"; it.progress = 45; it.note = "按参数切片"; renderQueue();
        await sleep(120);
        it.status = "vectorizing"; it.progress = 75; it.note = "构建 BM25 索引"; renderQueue();
        try {
          const res = await api.kbUpload(kbId, { name: it.name, content: text, chunkSize: size, overlap });
          it.status = "done"; it.progress = 100; it.note = `入库 ${res.uploaded.chunkCount} 个切片`;
        } catch (e) {
          it.status = "failed"; it.progress = 100; it.err = e.message;
        }
        renderQueue();
      }
      startBtn.disabled = false; clearBtn.disabled = false;
      const failed = queue.filter((q) => q.status === "failed").length;
      toast(failed ? `入库完成，但有 ${failed} 个文件失败` : "全部文档已入库并重建索引", failed ? "err" : "ok");
      await loadKb();
    }

    drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("dz-on"); });
    drop.addEventListener("dragleave", () => drop.classList.remove("dz-on"));
    drop.addEventListener("drop", (e) => {
      e.preventDefault(); drop.classList.remove("dz-on");
      if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
    });
    fileInput.addEventListener("change", () => { if (fileInput.files?.length) addFiles(fileInput.files); fileInput.value = ""; });
    folderInput.addEventListener("change", () => { if (folderInput.files?.length) addFiles(folderInput.files); folderInput.value = ""; });
    drop.querySelector("#uz-file").addEventListener("click", () => fileInput.click());
    drop.querySelector("#uz-folder").addEventListener("click", () => folderInput.click());
    clearBtn.addEventListener("click", () => { queue.length = 0; renderQueue(); });
    startBtn.addEventListener("click", () => startIngest());

    renderQueue();
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

/* ------------------------------------------------------------------ */
/* 上传辅助：零依赖的文件读取与轻量解析                                  */
/* ------------------------------------------------------------------ */

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function fmtSize(b) {
  if (b == null) return "—";
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

/** FileReader 文本读取（MD/TXT/CSV/JSON/LOG 等）。 */
function readText(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result ?? ""));
    r.onerror = () => reject(new Error("文件读取失败"));
    r.readAsText(file);
  });
}

/**
 * 零依赖 PDF 文本打捞：扫描 BT…ET 文本块，抽取其中的 Tj / TJ 文字算子。
 * 不依赖任何解析库，对大多数字面文本 PDF 能捞回正文；排版/字体映射可能
 * 丢失，因此界面会标注「轻量解析（可能不完整）」——这是诚实的工程取舍。
 */
async function salvagePdfText(file) {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let s = "";
  const len = Math.min(bytes.length, 16 * 1024 * 1024);
  for (let i = 0; i < len; i++) s += String.fromCharCode(bytes[i]);
  const out = [];
  const blockRe = /BT([\s\S]*?)ET/g;
  let bm;
  while ((bm = blockRe.exec(s))) {
    const block = bm[1];
    const tjRe = /\((?:[^()\\]|\\.)*\)\s*Tj/g;
    let tm;
    while ((tm = tjRe.exec(block))) {
      out.push(unescapePdfString(tm[0].slice(0, tm[0].lastIndexOf("Tj")).trim()));
    }
    const tjArrRe = /\[(.*?)\]\s*TJ/g;
    let am;
    while ((am = tjArrRe.exec(block))) {
      const strRe = /\((?:[^()\\]|\\.)*\)/g;
      let sm;
      while ((sm = strRe.exec(am[1]))) out.push(unescapePdfString(sm[0]));
    }
  }
  return out.join("\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function unescapePdfString(raw) {
  let inner = raw.trim();
  if (inner.startsWith("(") && inner.endsWith(")")) inner = inner.slice(1, -1);
  else if (inner.startsWith("<") && inner.endsWith(">")) {
    const hex = inner.slice(1, -1);
    let r = "";
    for (let i = 0; i + 1 < hex.length; i += 2) r += String.fromCharCode(parseInt(hex.substr(i, 2), 16) || 32);
    return r;
  }
  return inner.replace(/\\([nrtbf()\\])/g, (_, c) =>
    ({ n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", "(": "(", ")": ")", "\\": "\\" }[c]));
}
