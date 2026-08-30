import { test } from "node:test";
import assert from "node:assert/strict";

import {
  tokenize,
  contentTokens,
  chunkText,
  buildIndex,
  searchIndex,
  highlightRanges,
  RAG_STEPS,
  assessSufficiency,
  WF_NODE_TYPES,
  validateWorkflow,
  topoOrder,
  evalBranch
} from "../public/kb.js";

/**
 * Knowledge / workflow / RAG pure logic — the deterministic core shared by the
 * browser console and the bridge. Every result here depends only on (input,
 * args), so behavior can be pinned down without a DOM or a search engine.
 */

/* ----------------------------- 分词 ----------------------------- */

test("tokenize: 拉丁词按词边界、CJK 单字成词、统一小写", () => {
  assert.deepEqual(tokenize("Hello World!"), ["hello", "world"]);
  assert.deepEqual(tokenize("知识图谱引擎"), ["知", "识", "图", "谱", "引", "擎"]);
  assert.deepEqual(tokenize("RAG 检索"), ["rag", "检", "索"]);
});

test("tokenize: 空值安全", () => {
  assert.deepEqual(tokenize(null), []);
  assert.deepEqual(tokenize(""), []);
  assert.deepEqual(tokenize(undefined), []);
});

test("contentTokens: 去掉停用词与空串", () => {
  assert.deepEqual(contentTokens("the 知识库 的 检索"),
    ["知", "识", "库", "检", "索"]);
  // 单字中文停用词（含由多字疑问词拆出的 什/么/如/何）全部被滤除
  assert.deepEqual(contentTokens("请 什么 如何 怎么 哪些 可以"), []);
  assert.deepEqual(contentTokens("的 了 和 是 在 有"), []);
});

/* ----------------------------- 切片 ----------------------------- */

test("chunkText: 段落不跨片，索引连续且回带原文偏移", () => {
  const text = "第一段内容很短。\n\n第二段内容也很短。";
  const chunks = chunkText(text, { size: 320, overlap: 0.15 });
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].para, 0);
  assert.equal(chunks[1].para, 1);
  assert.equal(chunks[0].index, 0);
  assert.equal(chunks[1].index, 1);
  assert.ok(chunks[0].charStartInDoc >= 0);
  assert.ok(chunks[0].text.length > 0);
});

test("chunkText: 参数被夹紧，不会因恶意参数崩溃", () => {
  const chunks = chunkText("x".repeat(10), { size: -5, overlap: 9 });
  assert.ok(Array.isArray(chunks));
  assert.equal(chunks.length, 1);
});

/* --------------------------- BM25 检索 -------------------------- */

test("buildIndex + searchIndex: 命中含查询词的切片且分数降序", () => {
  const chunks = [
    { index: 0, text: "RAG 检索 与 知识库 构建方法" },
    { index: 1, text: "图数据库 的 索引 与 查询 优化" },
    { index: 2, text: "RAG 检索 的 评估 充分性 判定" }
  ];
  const idx = buildIndex(chunks);
  assert.equal(idx.total, 3);
  const hits = searchIndex(idx, "RAG 检索 知识库", 5);
  assert.ok(hits.length >= 1);
  assert.equal(hits[0].chunkIndex, 0);
  assert.ok(hits[0].score > 0);
  // 降序
  for (let i = 1; i < hits.length; i++) assert.ok(hits[i - 1].score >= hits[i].score);
});

test("searchIndex: 空索引或空查询返回空", () => {
  assert.deepEqual(searchIndex(null, "x"), []);
  assert.deepEqual(searchIndex({ total: 0, docs: [] }, "x"), []);
  const idx = buildIndex([{ index: 0, text: "hello world" }]);
  assert.deepEqual(searchIndex(idx, "的 请"), []); // 全是停用词
});

/* --------------------------- 高亮区间 -------------------------- */

test("highlightRanges: 返回合并后的字符偏移", () => {
  assert.deepEqual(highlightRanges("知识图谱引擎", "图谱"), [[2, 4]]);
  assert.deepEqual(highlightRanges("RAG rag rag", "rag"), [[0, 3], [4, 7], [8, 11]]);
  assert.deepEqual(highlightRanges("没有匹配词", "xyz"), []);
});

/* ----------------------------- RAG ----------------------------- */

test("RAG_STEPS: 八步管线且首末步骤固定", () => {
  assert.equal(RAG_STEPS.length, 8);
  assert.equal(RAG_STEPS[0].id, "parse");
  assert.equal(RAG_STEPS[RAG_STEPS.length - 1].id, "audit");
});

test("assessSufficiency: 充分/不足/可补搜三种分支", () => {
  const good = [{ score: 2.0 }, { score: 1.5 }];
  assert.deepEqual(assessSufficiency(good), { enough: true, top: 2.0, count: 2, canRefine: false });

  const weak = [{ score: 0.5 }];
  const r = assessSufficiency(weak, { minTopScore: 1.2, minHits: 2, refined: 0, maxRefines: 1 });
  assert.equal(r.enough, false);
  assert.equal(r.canRefine, true);

  const capped = assessSufficiency(weak, { refined: 1, maxRefines: 1 });
  assert.equal(capped.canRefine, false);
});

/* ----------------------------- 工作流 --------------------------- */

test("WF_NODE_TYPES: 五类节点齐全", () => {
  assert.deepEqual(Object.keys(WF_NODE_TYPES).sort(),
    ["agent", "branch", "end", "start", "tool"]);
});

test("validateWorkflow: 空画布非法", () => {
  const r = validateWorkflow({ nodes: [], edges: [] });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.text.includes("画布为空")));
});

test("validateWorkflow: 最小合法图通过", () => {
  const wf = {
    nodes: [
      { id: "s", type: "start", title: "开始" },
      { id: "a", type: "agent", title: "推演" },
      { id: "e", type: "end", title: "结束" }
    ],
    edges: [{ from: "s", to: "a" }, { from: "a", to: "e" }]
  };
  const r = validateWorkflow(wf);
  assert.equal(r.valid, true);
  assert.equal(r.errors.length, 0);
});

test("validateWorkflow: 重复 id / 缺起点 / 多起点 / 缺终点 均报错", () => {
  const dup = { nodes: [{ id: "x", type: "start" }, { id: "x", type: "end" }], edges: [] };
  assert.ok(validateWorkflow(dup).errors.some((e) => e.text.includes("重复")));

  const noStart = { nodes: [{ id: "a", type: "agent" }, { id: "e", type: "end" }], edges: [] };
  assert.ok(validateWorkflow(noStart).errors.some((e) => e.text.includes("起点")));

  const twoStarts = { nodes: [{ id: "s1", type: "start" }, { id: "s2", type: "start" }], edges: [] };
  assert.ok(validateWorkflow(twoStarts).errors.some((e) => e.text.includes("必须唯一")));

  const noEnd = { nodes: [{ id: "s", type: "start" }], edges: [] };
  assert.ok(validateWorkflow(noEnd).errors.some((e) => e.text.includes("终点")));
});

test("validateWorkflow: 悬空连线与自环报错", () => {
  const dangling = {
    nodes: [{ id: "s", type: "start" }, { id: "e", type: "end" }],
    edges: [{ from: "s", to: "ghost" }]
  };
  assert.ok(validateWorkflow(dangling).errors.some((e) => e.text.includes("悬空")));

  const self = {
    nodes: [{ id: "s", type: "start" }, { id: "e", type: "end" }],
    edges: [{ from: "s", to: "s" }]
  };
  assert.ok(validateWorkflow(self).errors.some((e) => e.text.includes("自己")));
});

test("validateWorkflow: 顺序流成环报错（loop 边豁免）", () => {
  const cyc = {
    nodes: [
      { id: "s", type: "start" }, { id: "a", type: "agent" }, { id: "b", type: "agent" }, { id: "e", type: "end" }
    ],
    edges: [{ from: "s", to: "a" }, { from: "a", to: "b" }, { from: "b", to: "a" }, { from: "a", to: "e" }]
  };
  const r = validateWorkflow(cyc);
  assert.ok(r.errors.some((e) => e.text.includes("成环")));

  // 把 b→a 改成 loop 边，环检测应豁免
  const withLoop = {
    nodes: [
      { id: "s", type: "start" }, { id: "a", type: "agent" }, { id: "b", type: "agent" }
    ],
    edges: [{ from: "a", to: "b" }, { from: "b", to: "a", kind: "loop" }]
  };
  assert.ok(!validateWorkflow(withLoop).errors.some((e) => e.level === "err" && e.text.includes("成环")));
});

test("validateWorkflow: 不可达节点与单出边分支报警（warn，不阻断）", () => {
  const wf = {
    nodes: [
      { id: "s", type: "start" },
      { id: "a", type: "agent" },
      { id: "e", type: "end" },
      { id: "orphan", type: "agent" },
      { id: "br", type: "branch" }
    ],
    edges: [{ from: "s", to: "a" }, { from: "a", to: "e" }, { from: "br", to: "e" }]
  };
  const r = validateWorkflow(wf);
  assert.equal(r.valid, true);
  assert.ok(r.errors.some((e) => e.level === "warn" && e.text.includes("不可达")));
  assert.ok(r.errors.some((e) => e.level === "warn" && e.text.includes("出边")));
});

test("topoOrder: 线性图返回依赖序；成环返回 null；loop 边不参与排序", () => {
  const linear = {
    nodes: [{ id: "s", type: "start" }, { id: "a", type: "agent" }, { id: "e", type: "end" }],
    edges: [{ from: "s", to: "a" }, { from: "a", to: "e" }]
  };
  assert.deepEqual(topoOrder(linear), ["s", "a", "e"]);

  const cyc = {
    nodes: [{ id: "s", type: "start" }, { id: "a", type: "agent" }],
    edges: [{ from: "s", to: "a" }, { from: "a", to: "s" }]
  };
  assert.equal(topoOrder(cyc), null);

  const looped = {
    nodes: [{ id: "s", type: "start" }, { id: "e", type: "end" }],
    edges: [{ from: "s", to: "e" }, { from: "e", to: "s", kind: "loop" }]
  };
  assert.deepEqual(topoOrder(looped), ["s", "e"]);
});

test("topoOrder: 稳定序——同层节点按原始顺序", () => {
  const wf = {
    nodes: [{ id: "s", type: "start" }, { id: "b", type: "agent" }, { id: "a", type: "agent" }, { id: "e", type: "end" }],
    edges: [{ from: "s", to: "b" }, { from: "s", to: "a" }, { from: "b", to: "e" }, { from: "a", to: "e" }]
  };
  assert.deepEqual(topoOrder(wf), ["s", "b", "a", "e"]);
});

test("evalBranch: 命中条件走对应出边，不命中走 defaultTo", () => {
  const node = {
    id: "br", type: "branch",
    config: { conditions: [{ match: "good", to: "x" }], defaultTo: "y" }
  };
  const edges = [
    { from: "br", to: "x" }, { from: "br", to: "y" }
  ];
  assert.equal(evalBranch(node, edges, "结果是 good 的"), "x");
  assert.equal(evalBranch(node, edges, "结果是 bad 的"), "y");
});

test("evalBranch: 空 match 视为命中；无匹配无默认走首条边", () => {
  const node = { id: "br", type: "branch", config: { conditions: [] } };
  const edges = [{ from: "br", to: "z" }, { from: "br", to: "w" }];
  assert.equal(evalBranch(node, edges, "anything"), "z");
});
