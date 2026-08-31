/**
 * Orbit Console · 知识库 / 工作流 / RAG 纯逻辑库（无 DOM 依赖，可在 Node 单测）
 *
 * 与 lib.js 同一纪律：凡是"决定数据长什么样"的规则都不落在视图或服务器
 * 的过程代码里，而是收拢成纯函数，让浏览器与桥接服务共享同一份事实，
 * 并能在 node:test 里直接钉住行为。
 *
 * 检索采用确定性词法索引（BM25）——零依赖、可重放，与内核的确定性
 * 气质一致；不引入任何向量服务，排序结果只由 (语料, 查询, 参数) 决定。
 */

/* ------------------------------------------------------------------ */
/* 文本处理                                                            */
/* ------------------------------------------------------------------ */

/**
 * 中英混排分词：CJK 单字成词，拉丁/数字按词边界切分，统一小写。
 * 纯函数、无词典依赖，同样的输入永远得到同样的词元序列。
 */
export function tokenize(text) {
  const src = String(text ?? "");
  const out = [];
  let buf = "";
  const flush = () => {
    if (buf) { out.push(buf.toLowerCase()); buf = ""; }
  };
  for (const ch of src) {
    if (/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(ch)) {
      flush();
      out.push(ch.toLowerCase());
    } else if (/[\p{L}\p{N}_]/u.test(ch)) {
      buf += ch;
    } else {
      flush();
    }
  }
  flush();
  return out;
}

/** 停用词表：极小集合，只去掉对检索无贡献的高频虚词（中英各留高频）。 */
/* 中文按单字成词，停用词也必须是单字才会命中；多字中文（什么/怎么/如何…）
   会被 tokenize 拆开，因此这里把它们拆成组成单字，避免"永远不命中"的死条目。 */
const STOPWORDS = new Set([
  "the", "a", "an", "of", "to", "and", "or", "is", "are", "in", "on", "for",
  "with", "as", "by", "at", "be", "it", "this", "that", "from", "was", "were",
  "的", "了", "和", "是", "在", "有", "对", "从", "被", "与", "或", "及",
  "请", "什", "么", "怎", "如", "何", "哪", "些", "可", "以"
]);

export function contentTokens(text) {
  return tokenize(text).filter((t) => !STOPWORDS.has(t) && t.length > 0);
}

/* ------------------------------------------------------------------ */
/* 切片                                                                */
/* ------------------------------------------------------------------ */

/**
 * 可视化切片：按目标长度 + 重叠率切分文本，段落边界优先。
 *
 * 规则（刻意朴素、可预测，UI 展示的参数就是这里真实生效的参数）：
 *   · 先按空行切成段落，段落不跨片（段落即语义单元）
 *   · 单段超长时在句读处二次切分，尽量不在词中截断
 *   · overlap 只在同一原文段的相邻片之间生效，绝不跨段拼接
 *
 * 返回 [{ index, text, charStart, charStartInDoc }]；charStartInDoc 相对
 * 原文，供溯源高亮使用。
 */
export function chunkText(text, { size = 320, overlap = 0.15 } = {}) {
  const src = String(text ?? "");
  const target = Math.max(40, Math.floor(Number(size) || 320));
  const ov = Math.min(0.5, Math.max(0, Number(overlap) || 0));
  const ovChars = Math.floor(target * ov);

  const paragraphs = src.split(/\n\s*\n/).filter((p) => p.trim().length > 0);
  const chunks = [];

  for (let pi = 0; pi < paragraphs.length; pi++) {
    const para = paragraphs[pi];
    const docStart = src.indexOf(para);
    const pieces = splitParagraph(para, target);
    let prevTail = "";
    for (let i = 0; i < pieces.length; i++) {
      const body = (i > 0 && ovChars > 0 ? prevTail : "") + pieces[i];
      prevTail = pieces[i].slice(Math.max(0, pieces[i].length - ovChars));
      const localStart = para.indexOf(pieces[i]);
      chunks.push({
        index: chunks.length,
        para: pi,
        text: body,
        charStartInDoc: docStart + Math.max(0, localStart - (i > 0 ? prevTail.length : 0)),
        length: body.length
      });
    }
  }
  return chunks;
}

/** 单段内二次切分：句读优先，超长句按 target 硬切但避让空白。 */
function splitParagraph(para, target) {
  if (para.length <= target) return [para];
  const sentences = para.match(/[^。！？!?\.…\n]+[。！？!?\.…]*/g) ?? [para];
  const pieces = [];
  let cur = "";
  for (const s of sentences) {
    if (cur && (cur + s).length > target) {
      pieces.push(cur.trim());
      cur = s;
    } else {
      cur += s;
    }
    while (cur.length > target * 1.6) {
      pieces.push(cur.slice(0, target).trim());
      cur = cur.slice(target);
    }
  }
  if (cur.trim()) pieces.push(cur.trim());
  return pieces.filter(Boolean);
}

/* ------------------------------------------------------------------ */
/* 确定性词法索引（BM25）                                              */
/* ------------------------------------------------------------------ */

/**
 * 由切片构建倒排索引。文档即切片；同一知识库的所有切片共享一个索引。
 * 结构是纯 JSON（Map 序列化后的普通对象），桥接重启后可原样重建。
 */
export function buildIndex(chunks) {
  const docs = [];
  const df = new Map();
  for (const chunk of chunks) {
    const tokens = contentTokens(chunk.text);
    const tf = new Map();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
    docs.push({ chunkIndex: chunk.index ?? docs.length, len: tokens.length, tf });
  }
  const avgLen = docs.length ? docs.reduce((a, d) => a + d.len, 0) / docs.length : 0;
  return { docs, df, avgLen, total: docs.length };
}

/**
 * BM25 检索。返回按分数降序的前 k 条 [{ chunkIndex, score }]。
 * k1/b 采用常见默认 (1.2, 0.75)；分数只由语料与查询决定。
 */
export function searchIndex(index, query, k = 5) {
  if (!index || index.total === 0) return [];
  const k1 = 1.2;
  const b = 0.75;
  const N = index.total;
  const qTokens = contentTokens(query);
  if (qTokens.length === 0) return [];
  const scored = [];
  for (const doc of index.docs) {
    let score = 0;
    const seen = new Set();
    for (const t of qTokens) {
      if (seen.has(t)) continue;
      seen.add(t);
      const f = doc.tf.get(t);
      if (!f) continue;
      const n = index.df.get(t) ?? 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + b * (doc.len / (index.avgLen || 1)))));
    }
    if (score > 0) scored.push({ chunkIndex: doc.chunkIndex, score: Number(score.toFixed(4)) });
  }
  scored.sort((a, b2) => b2.score - a.score || a.chunkIndex - b2.chunkIndex);
  return scored.slice(0, Math.max(1, k));
}

/** 查询词在切片内的高亮区间（字符 offset），供溯源双向定位。 */
export function highlightRanges(chunkText_, query) {
  const ranges = [];
  for (const raw of contentTokens(query)) {
    const needle = raw.toLowerCase();
    const hay = String(chunkText_ ?? "").toLowerCase();
    let at = hay.indexOf(needle);
    while (at !== -1) {
      ranges.push([at, at + needle.length]);
      at = hay.indexOf(needle, at + needle.length);
    }
  }
  return mergeRanges(ranges);
}

function mergeRanges(ranges) {
  if (ranges.length === 0) return [];
  ranges.sort((a, b) => a[0] - b[0]);
  const out = [ranges[0].slice()];
  for (let i = 1; i < ranges.length; i++) {
    const last = out[out.length - 1];
    if (ranges[i][0] <= last[1]) last[1] = Math.max(last[1], ranges[i][1]);
    else out.push(ranges[i].slice());
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* RAG 八步管线                                                        */
/* ------------------------------------------------------------------ */

/**
 * Agentic RAG 的步骤骨架。步骤是数据而非过程——执行器（桥接）按序填充
 * 每步的状态与细节，界面只负责渲染。这里定义步骤目录与「补搜」判定。
 */
export const RAG_STEPS = [
  { id: "parse", label: "解析查询", desc: "分词、去停用词，确定检索语言空间。" },
  { id: "retrieve", label: "初检", desc: "BM25 词法检索，取 top-k 切片。" },
  { id: "assess", label: "评估充分性", desc: "检索分数与覆盖度判定是否需要补搜。" },
  { id: "refine", label: "补搜改写", desc: "覆盖不足时改写查询，触发迭代回流。" },
  { id: "rerank", label: "重排", desc: "按分数与来源多样性重排切片。" },
  { id: "synthesize", label: "合成答案", desc: "经内核 llm-access 通道合成结构化回答。" },
  { id: "ground", label: "溯源装配", desc: "答案与切片双向锚定，生成引用。" },
  { id: "audit", label: "归档审计", desc: "整次推演落入事件流，可慢镜头复盘。" }
];

/**
 * 充分性判定：初检结果是否足够好。
 * 朴素而可解释——top1 分数过低或命中切片过少即判不足，触发一次补搜。
 * maxRefines 限制迭代轮数，防止无限回流。
 */
export function assessSufficiency(hits, { minTopScore = 1.2, minHits = 2, refined = 0, maxRefines = 1 } = {}) {
  const top = hits[0]?.score ?? 0;
  const enough = hits.length >= minHits && top >= minTopScore;
  const canRefine = !enough && refined < maxRefines;
  return { enough, top, count: hits.length, canRefine };
}

/* ------------------------------------------------------------------ */
/* 工作流图模型与校验                                                   */
/* ------------------------------------------------------------------ */

/**
 * 工作流图：{ nodes: [{id, type, title, config, x, y}], edges: [{from, to, kind}] }
 * kind: "flow"（顺序流）| "loop"（迭代回流）
 *
 * 节点类型：
 *   start   起点（唯一）
 *   agent   推演节点：跑一个沙箱周期
 *   tool    工具节点：调一个 PAE 工具
 *   branch  分支：按条件走第一条命中的出边
 *   end     终点
 */
export const WF_NODE_TYPES = {
  start: { label: "起点", sigil: "✦", desc: "工作流唯一入口" },
  agent: { label: "推演", sigil: "◈", desc: "绑定模板，执行一个沙箱周期" },
  tool: { label: "工具", sigil: "◇", desc: "调用已接驳的 PAE 外来工具" },
  branch: { label: "分支", sigil: "⁂", desc: "按出边条件分流（包含匹配）" },
  end: { label: "终点", sigil: "◉", desc: "工作流终点" }
};

/**
 * 图校验：结构合法才允许保存/执行。
 * 返回 { valid, errors: [{ level, text }] }，level: "err" | "warn"。
 */
export function validateWorkflow(wf) {
  const errors = [];
  const nodes = wf?.nodes ?? [];
  const edges = wf?.edges ?? [];

  if (nodes.length === 0) {
    errors.push({ level: "err", text: "画布为空：至少需要一个起点与一个终点。" });
    return { valid: false, errors };
  }

  const ids = new Set(nodes.map((n) => n.id));
  if (ids.size !== nodes.length) errors.push({ level: "err", text: "存在重复的节点 id。" });

  const starts = nodes.filter((n) => n.type === "start");
  if (starts.length === 0) errors.push({ level: "err", text: "缺少起点节点。" });
  if (starts.length > 1) errors.push({ level: "err", text: "起点必须唯一，当前有 " + starts.length + " 个。" });
  if (!nodes.some((n) => n.type === "end")) errors.push({ level: "err", text: "缺少终点节点。" });

  for (const e of edges) {
    if (!ids.has(e.from) || !ids.has(e.to)) {
      errors.push({ level: "err", text: `连线 ${e.from} → ${e.to} 悬空（端点不存在）。` });
    }
    if (e.from === e.to) errors.push({ level: "err", text: `节点 ${e.from} 连到了自己。` });
  }

  /* 环检测：flow 边不允许成环；loop 边是显式回流，刻意豁免 */
  const flowAdj = new Map();
  for (const n of nodes) flowAdj.set(n.id, []);
  for (const e of edges) if (e.kind !== "loop") flowAdj.get(e.from)?.push(e.to);
  const cycle = findCycle(nodes.map((n) => n.id), flowAdj);
  if (cycle) errors.push({ level: "err", text: `顺序流成环：${cycle.join(" → ")}。回流请用橙色迭代边。` });

  /* 可达性：从 start 出发，不可达的节点报警（不阻断——可能是草稿） */
  if (starts.length === 1) {
    const reach = reachable(starts[0].id, edges);
    const orphan = nodes.filter((n) => !reach.has(n.id)).map((n) => n.title || n.id);
    if (orphan.length > 0) {
      errors.push({ level: "warn", text: `不可达节点（未连接到主线）：${orphan.join("、")}。` });
    }
  }

  /* 分支节点至少两条出边才有意义 */
  for (const n of nodes.filter((n) => n.type === "branch")) {
    const out = edges.filter((e) => e.from === n.id);
    if (out.length < 2) errors.push({ level: "warn", text: `分支「${n.title || n.id}」只有 ${out.length} 条出边，形同顺序节点。` });
  }

  return { valid: errors.every((e) => e.level !== "err"), errors };
}

function findCycle(ids, adj) {
  const state = new Map(); // 0=未访问 1=栈中 2=完成
  const stack = [];
  let found = null;
  function dfs(u) {
    if (found) return;
    state.set(u, 1);
    stack.push(u);
    for (const v of adj.get(u) ?? []) {
      if (state.get(v) === 1) {
        const at = stack.indexOf(v);
        found = stack.slice(at).concat(v);
        return;
      }
      if (!state.has(v)) dfs(v);
    }
    stack.pop();
    state.set(u, 2);
  }
  for (const id of ids) if (!state.has(id)) dfs(id);
  return found;
}

function reachable(from, edges) {
  const seen = new Set([from]);
  const queue = [from];
  while (queue.length) {
    const cur = queue.shift();
    for (const e of edges) {
      if (e.from === cur && !seen.has(e.to)) {
        seen.add(e.to);
        queue.push(e.to);
      }
    }
  }
  return seen;
}

/**
 * 拓扑执行序（flow 边）。loop 边不参与排序——迭代语义由执行器解释。
 * 稳定：ready 队列始终按节点在 nodes 数组中的原始顺序插入，确定性可重放。
 * 返回 null 表示顺序流有环。
 */
export function topoOrder(wf) {
  const nodes = wf?.nodes ?? [];
  const edges = (wf?.edges ?? []).filter((e) => e.kind !== "loop");
  const seq = nodes.map((n) => n.id); // 原始顺序，稳定基准
  const indeg = new Map(nodes.map((n) => [n.id, 0]));
  for (const e of edges) indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  const ready = seq.filter((id) => (indeg.get(id) ?? 0) === 0);
  const out = [];
  while (ready.length) {
    const cur = ready.shift();
    out.push(cur);
    for (const e of edges) {
      if (e.from === cur) {
        indeg.set(e.to, (indeg.get(e.to) ?? 1) - 1);
        if (indeg.get(e.to) === 0) insertStable(ready, e.to, seq);
      }
    }
  }
  return out.length === nodes.length ? out : null;
}

function insertStable(ready, id, seq) {
  const idx = seq.indexOf(id);
  let i = 0;
  while (i < ready.length && seq.indexOf(ready[i]) < idx) i++;
  ready.splice(i, 0, id);
}

/**
 * 分支求值：确定性包含匹配。
 * branch.config.conditions = [{ match, to }]，取第一条 match 为空或命中
 * 累积输出的出边；全不命中走 defaultTo。
 */
export function evalBranch(branchNode, edges, accumulated) {
  const conds = branchNode?.config?.conditions ?? [];
  const outEdges = edges.filter((e) => e.from === branchNode.id);
  for (const c of conds) {
    if (!c.match || String(accumulated ?? "").includes(c.match)) {
      const hit = outEdges.find((e) => e.to === c.to);
      if (hit) return hit.to;
    }
  }
  const fallback = outEdges.find((e) => e.to === branchNode?.config?.defaultTo);
  return (fallback ?? outEdges[0])?.to ?? null;
}
