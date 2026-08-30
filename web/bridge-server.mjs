/**
 * Orbit Agent Runtime · Console Bridge Server
 *
 * A zero-dependency HTTP bridge that drives a REAL OrbitRuntimeHost instance
 * (built from ./dist) and serves the static console SPA in ./public.
 *
 * Run:  node web/bridge-server.mjs            (default port 8899)
 *       PORT=9000 node web/bridge-server.mjs  (custom port)
 *
 * Design notes:
 *  - Uses only node:http / node:fs / node:path — no third-party deps,
 *    consistent with the kernel's "zero runtime dependencies" stance.
 *  - The main host is a long-lived singleton; replay-studio demos run on
 *    throwaway hosts so they never pollute console state.
 *  - A few kernel registries are private; where no read-only accessor is
 *    exported (graph maps, channel hub maps) we mirror the data in this
 *    server's own registry. This is documented in the P1 findings.
 */
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { OrbitRuntimeHost } from "../dist/src/core/orbitRuntimeHost.js";
import { ChannelKind } from "../dist/src/types/orbitDomain.js";
import { RecordJournal } from "../dist/src/replay/record_journal.js";
import { ReplayEngine } from "../dist/src/replay/replay_engine.js";
import { DeepSeekChannel } from "../dist/src/channel/providers/openai_compat_channel.js";
import { createHash, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { JsPaeAdapter } from "../dist/src/pae/adapters/JsPaeAdapter.js";
import { SeededRng } from "../dist/src/replay/injectors.js";
import {
  PAE_TEMPLATES,
  describePaeTool,
  deriveBilling,
  deriveNotifications,
  deriveSystemHealth,
  suggestNextSteps
} from "./public/lib.js";
import {
  chunkText,
  buildIndex,
  searchIndex,
  highlightRanges,
  contentTokens,
  RAG_STEPS,
  assessSufficiency,
  validateWorkflow,
  topoOrder,
  evalBranch
} from "./public/kb.js";
import { KERNEL_VERSION } from "../dist/src/utils/versionIdGen.js";
import { McpPaeAdapter } from "../dist/src/pae/adapters/mcp/McpPaeAdapter.js";
import { StdioMcpTransport } from "../dist/src/pae/adapters/mcp/transport.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PUBLIC_DIR = join(__dirname, "public");
const PORT = Number(process.env.PORT ?? 8899);
const HOST = process.env.HOST ?? "127.0.0.1";

const REPLAY_CYCLES = ["tell me a joke", "what is orbit", "explain a capability channel"];

/* ------------------------------------------------------------------ */
/* Host singleton                                                      */
/* ------------------------------------------------------------------ */

const host = new OrbitRuntimeHost();
let running = false;

async function ensureRunning() {
  if (!running) {
    await host.bootHost();
    running = true;
  }
}

/** Channel registry mirrored here because ChannelHub keeps its maps private. */
const channelRegistry = new Map([
  ["mem-kv-store", { type: "builtin", label: "Memory KV Store", cost: { costPerCall: 0, latencyMs: 1, quality: 1 } }],
  ["llm-access", { type: "builtin", label: "LLM Mock Channel", cost: { costPerCall: 1, latencyMs: 320, quality: 1 } }]
]);

/** Plugin registry mirrored here because PluginPactVerifier keeps its map private. */
const pluginRegistry = new Map();

/** Per-cycle run counter for the dashboard. */
let runCounter = 0;

/** Sandbox → channel deps mirrored here (kernel graph has no node removal). */
const boxDeps = new Map();

/* ------------------------------------------------------------------ */
/* PAE · Plugin Adaptation Engine (W15)                                */
/* ------------------------------------------------------------------ */
/* tool name → template id, so the console knows how to format args and
   the graph can label the foreign surface. The kernel registry owns the
   real tool/adapter state; this is just the bridge-side bookkeeping. */
const paeToolMeta = new Map();

/* Deterministic seed source for PAE tools that need randomness. The seed
   advances per invoke so each call is reproducible *and* distinct, and the
   replay path never re-executes the adapter (snapshot injected). */
let paeSeed = 0x1a2b3c4d;

/**
 * Foreign tool implementations, keyed by template id. Every handler takes the
 * kernel-injected `(args, ctx)` and never touches Math.random / Date.now — the
 * contract the adapter contract promises (charter axiom A1).
 */
function rngHex(ctx, chars) {
  let s = "";
  for (let i = 0; i < chars; i++) s += Math.floor(ctx.rng.next() * 16).toString(16);
  return s;
}

const PAE_HANDLERS = {
  echo: (args) => args[0],
  reverse: (args) => String(args[0] ?? "").split("").reverse().join(""),
  upper: (args) => String(args[0] ?? "").toUpperCase(),
  lower: (args) => String(args[0] ?? "").toLowerCase(),
  length: (args) => String(args[0] ?? "").length,
  hash: (args) => createHash("sha256").update(String(args[0] ?? "")).digest("hex"),
  base64: (args) => Buffer.from(String(args[0] ?? ""), "utf8").toString("base64"),
  json: (args) => JSON.stringify(JSON.parse(String(args[0] ?? "{}")), null, 2),
  add: (args) => args.filter((n) => typeof n === "number" && !Number.isNaN(n)).reduce((a, b) => a + b, 0),
  now: (_args, ctx) => (ctx.clock ? ctx.clock.now() : Date.now()),
  random: (_args, ctx) => ctx.rng.next(),
  uuid: (_args, ctx) => `${rngHex(ctx, 8)}-${rngHex(ctx, 4)}-${rngHex(ctx, 4)}-${rngHex(ctx, 4)}-${rngHex(ctx, 12)}`
};

/**
 * Build a JsToolSpec from a UI payload. Reuses the same descriptor builder the
 * console uses (shared via lib.js) so the honesty gate — a non-full fidelity
 * MUST carry a fidelityNote — is enforced identically on both ends.
 */
function buildPaeToolSpec(tool) {
  const tpl = tool.template;
  if (!tpl || !PAE_TEMPLATES[tpl]) throw new Error(`unknown pae template: ${tpl}`);
  if (typeof PAE_HANDLERS[tpl] !== "function") throw new Error(`pae template "${tpl}" has no handler`);
  const descriptor = describePaeTool(tpl, tool.name, {
    capability: tool.capability,
    determinism: tool.determinism,
    fidelity: tool.fidelity,
    fidelityNote: tool.fidelityNote
  });
  return { ...descriptor, handler: PAE_HANDLERS[tpl] };
}

/* ------------------------------------------------------------------ */
/* Demo plugin channel (shows plugin-first precedence over built-ins)  */
/* ------------------------------------------------------------------ */

class EchoPluginChannel {
  // Aligns with the kernel's ChannelRuntimeMeta contract:
  // { determinism: DeterminismLevel; seedable?; replayPolicy? }
  determinismMeta = { determinism: "deterministic", replayPolicy: "inject" };
  async setup() {}
  async teardown() {}
  async chatRound(input) {
    const text = String(input);
    const lastLine = text.split("\n").filter(Boolean).pop() ?? text;
    return `[echo-plugin] ${lastLine.replace(/^User:/, "")}`;
  }
}

/* ------------------------------------------------------------------ */
/* Small JSON helpers                                                  */
/* ------------------------------------------------------------------ */

function ok(res, data, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ ok: true, data }));
}

function fail(res, error, status = 400) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ ok: false, error }));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) reject(new Error("payload too large"));
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

/* ------------------------------------------------------------------ */
/* Console domain state                                                */
/*                                                                     */
/* Everything below is bridge-side bookkeeping layered ON TOP of the   */
/* kernel — users/sessions, audit trail, spend ledger, task registry,  */
/* templates, knowledge bases and workflows. The kernel stays the only */
/* executor: every task that charges the ledger routes through a real  */
/* sandbox cycle or a real gateway capabilityInvoke.                   */
/* ------------------------------------------------------------------ */

/** Per-request context (actor attribution survives await interleaving). */
const actorCtx = new AsyncLocalStorage();
function currentActor() {
  return actorCtx.getStore()?.actor ?? "system";
}

const pad = (n, w = 4) => String(n).padStart(w, "0");

const ROLE_CN = { admin: "管理员", operator: "操作员", viewer: "观察者" };

/* ---- RAG run store ---- */

const ragRunsStore = new Map();
let ragSeq = 0;

/* ---- users & sessions ---- */

const users = new Map();    // account -> user record
const sessions = new Map(); // token -> { account, token, createdAt }

function hashPassword(password, salt) {
  return scryptSync(String(password), salt, 32).toString("hex");
}

function createUser({ account, password, name, email, role }) {
  if (typeof account !== "string" || !/^[a-zA-Z0-9_.-]{2,32}$/.test(account)) {
    throw new Error("账号需为 2–32 位字母、数字或 _ . - 组合");
  }
  if (users.has(account)) throw new Error(`账号 ${account} 已存在`);
  if (typeof password !== "string" || password.length < 6) throw new Error("密码至少 6 位");
  const salt = randomUUID().replace(/-/g, "");
  const user = {
    account,
    name: name || account,
    email: email || `${account}@orbit.local`,
    /* First account is the seeded administrator; self-registration can
       never mint another admin — privilege comes from the seed only. */
    role: users.size === 0 ? "admin" : role === "viewer" ? "viewer" : "operator",
    salt,
    hash: hashPassword(password, salt),
    createdAt: Date.now()
  };
  users.set(account, user);
  return user;
}

/* Seed administrator — printed on the boot banner so it is discoverable
   rather than secret knowledge. */
createUser({ account: "admin", password: "orbit-admin", name: "管理员", email: "admin@orbit.local" });

function publicUser(u) {
  return { account: u.account, name: u.name, email: u.email, role: u.role, createdAt: u.createdAt };
}

function verifyPassword(u, password) {
  const given = Buffer.from(hashPassword(password, u.salt), "hex");
  const want = Buffer.from(u.hash, "hex");
  return given.length === want.length && timingSafeEqual(given, want);
}

function openSession(account) {
  const token = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
  sessions.set(token, { account, token, createdAt: Date.now() });
  return token;
}

/* ---- audit trail ---- */

const auditLog = []; // append-only, capped at 1000
let auditSeq = 0;

const AUDIT_ROUTES = {
  "host.boot": "overview",
  "host.shutdown": "overview",
  "channel.register": "channels",
  "channel.remove": "channels",
  "plugin.register": "plugins",
  "plugin.reset": "plugins",
  "box.spawn": "boxes",
  "box.remove": "boxes",
  "template.save": "templates",
  "template.rollback": "templates",
  "template.remove": "templates",
  "workflow.save": "workflow",
  "workflow.remove": "workflow",
  "workflow.run": "workflow",
  "kb.create": "knowledge",
  "kb.upload": "knowledge",
  "kb.remove": "knowledge",
  "rag.run": "rag",
  "task.abort": "tasks",
  "pae.register": "pae",
  "pae.remove": "pae",
  "billing.low": "billing",
  "audit.export": "trace",
  "auth.password": "settings"
};

function audit(action, target, detail, level = "ok", kind = null) {
  auditSeq += 1;
  const event = {
    id: `ev-${pad(auditSeq, 5)}`,
    ts: Date.now(),
    actor: currentActor(),
    action,
    target: target ?? "",
    detail: detail ?? "",
    level,
    kind,
    route: AUDIT_ROUTES[action] ?? null
  };
  auditLog.push(event);
  if (auditLog.length > 1000) auditLog.splice(0, auditLog.length - 1000);
  return event;
}

function auditList(query = {}) {
  let events = auditLog.slice();
  if (query.level) events = events.filter((e) => e.level === query.level);
  if (query.action) events = events.filter((e) => e.action === query.action);
  if (query.actor) events = events.filter((e) => e.actor === query.actor);
  events.reverse();
  return events.slice(0, Number(query.limit ?? 200));
}

/* ---- spend ledger (Token 账本) ---- */

const SPARK_GRANT = 10_000;
const ledger = [];
const CHANNEL_UNIT_FALLBACK = { "pae-tool": 1 };
let lowBalanceAnnounced = false;

function channelUnits(kind) {
  return channelRegistry.get(kind)?.cost?.costPerCall ?? CHANNEL_UNIT_FALLBACK[kind] ?? 0;
}

/**
 * Tally one REAL capability call at the bridge boundary. Callers may only
 * invoke this right after a kernel call actually happened (sandbox cycle,
 * gateway invoke) — the ledger is a meter, not a price list.
 */
function charge(taskId, box, channel, reason) {
  const units = channelUnits(channel);
  ledger.push({ ts: Date.now(), task: taskId ?? null, box: box ?? null, channel, units, reason: reason ?? "" });
  if (!lowBalanceAnnounced) {
    const balance = SPARK_GRANT - ledger.reduce((a, e) => a + e.units, 0);
    if (balance < 500) {
      lowBalanceAnnounced = true;
      audit("billing.low", "wallet", `Token余额跌破 500（剩 ${balance}）`, "warn");
    }
  }
}

/* ---- task registry (六态任务) ---- */

const taskRegistry = new Map();
let taskSeq = 0;

function beginTask(kind, title, meta = {}) {
  taskSeq += 1;
  const id = `task-${pad(taskSeq)}`;
  const task = {
    id,
    kind,
    title,
    status: "queued",
    createdAt: Date.now(),
    startedAt: null,
    endedAt: null,
    steps: [],
    meta,
    result: null,
    error: null,
    abortRequested: false
  };
  taskRegistry.set(id, task);
  return task;
}

function taskStep(task, label, detail = "") {
  const step = { label, status: "running", detail, ms: null };
  task.steps.push(step);
  return step;
}

function finishTask(task, status, error = null) {
  task.status = status;
  task.endedAt = Date.now();
  task.error = error ? String(error?.message ?? error) : null;
  audit(`task.${status}`, task.id, `${task.title}`, status === "failed" ? "err" : status === "done" ? "ok" : "warn", task.kind);
}

function taskList(query = {}) {
  let list = [...taskRegistry.values()];
  if (query.status) list = list.filter((t) => t.status === query.status);
  if (query.kind) list = list.filter((t) => t.kind === query.kind);
  list.reverse();
  return list.slice(0, Number(query.limit ?? 100));
}

/* ---- notifications ---- */

const NOTIFY_TITLES = {
  "host.boot": "主机已启动",
  "host.shutdown": "主机已停止",
  "task.failed": "任务异常中断",
  "task.aborted": "任务被手动终止",
  "task.done": "任务完成",
  "template.rollback": "模板已回滚",
  "workflow.run": "工作流执行",
  "rag.run": "RAG推演完成",
  "billing.low": "Token余额预警",
  "channel.register": "通道提供方变更",
  "channel.remove": "通道提供方移除",
  "kb.upload": "知识库有新文档"
};

function notifyEvents() {
  return auditLog
    .filter((e) => e.level !== "ok" || NOTIFY_TITLES[e.action] !== undefined)
    .filter((e) => !(e.action === "task.done" && e.kind === "agent")) /* 单轮实例任务不刷通知 */
    .slice(-80)
    .map((e) => ({
      id: e.id,
      ts: e.ts,
      kind: e.action,
      level: e.level,
      title: NOTIFY_TITLES[e.action] ?? e.action,
      detail: [e.target, e.detail].filter(Boolean).join(" · "),
      route: e.route
    }));
}

const notifyRead = new Map(); // account -> Set<eventId>

/* ---- templates ---- */

const templates = new Map();
let templateSeq = 0;

function mkTemplate({ id, name, desc, snapshot, note }) {
  return {
    id,
    name,
    desc: desc ?? "",
    currentVersion: 1,
    versions: [{ version: 1, snapshot: structuredClone(snapshot), note: note ?? "初始版本", createdAt: Date.now() }]
  };
}

function seedTemplates() {
  const seeds = [
    {
      id: "tpl-zhike",
      name: "知客 · 通用问答",
      desc: "单通道 llm-access 的通用问答助手，适合首轮接入验证。",
      snapshot: {
        baseInstruct: "你是 Orbit 知客，用简洁准确的中文回答问题；不确定时明确说明，不编造。",
        maxCycleRun: 5,
        budgetPerCycle: 10,
        replayMode: "live",
        channelDeps: ["llm-access"]
      }
    },
    {
      id: "tpl-chihou",
      name: "斥候 · 信息侦察",
      desc: "双通道依赖（llm + KV 记忆），跨周期沉淀观察结论。",
      snapshot: {
        baseInstruct: "你是 Orbit 斥候，负责信息侦察与要点摘录，输出结构化要点列表。",
        maxCycleRun: 8,
        budgetPerCycle: 10,
        replayMode: "live",
        channelDeps: ["llm-access", "mem-kv-store"]
      }
    },
    {
      id: "tpl-jiangzuo",
      name: "匠作 · 代码工坊",
      desc: "低预算高轮次的工程助手，验证预算路由的降级路径。",
      snapshot: {
        baseInstruct: "你是 Orbit 匠作，一名严谨的工程助手：先给结论，再给依据。",
        maxCycleRun: 12,
        budgetPerCycle: 2,
        replayMode: "live",
        channelDeps: ["llm-access"]
      }
    }
  ];
  for (const s of seeds) templates.set(s.id, mkTemplate(s));
}
seedTemplates();

function templateSnapshot(body) {
  const deps = Array.isArray(body?.channelDeps) ? body.channelDeps.filter((d) => typeof d === "string") : ["llm-access"];
  return {
    baseInstruct: String(body?.baseInstruct ?? "You are a demo assistant."),
    maxCycleRun: Math.max(1, Math.min(50, Number(body?.maxCycleRun ?? 5))),
    budgetPerCycle: body?.budgetPerCycle === undefined || body?.budgetPerCycle === null
      ? undefined
      : Math.max(0, Number(body.budgetPerCycle)),
    replayMode: ["live", "record", "replay"].includes(body?.replayMode) ? body.replayMode : "live",
    channelDeps: deps
  };
}

/* ---- knowledge bases ---- */

const kbs = new Map();
let kbSeq = 0;

function kbAllChunks(kb) {
  const out = [];
  for (const doc of kb.docs) {
    for (const ch of doc.chunks) out.push({ ...ch, docId: doc.id, docName: doc.name });
  }
  return out;
}

function kbIndex(kb) {
  const stamp = `${kb.docs.length}:${kb.docs.reduce((a, d) => Math.max(a, d.createdAt), 0)}`;
  if (kb.indexCache?.stamp === stamp) return kb.indexCache;
  const chunks = kbAllChunks(kb);
  const index = buildIndex(chunks);
  kb.indexCache = { stamp, index, chunks };
  return kb.indexCache;
}

function kbSummary(kb) {
  const chunks = kbAllChunks(kb);
  return {
    id: kb.id,
    name: kb.name,
    desc: kb.desc,
    createdAt: kb.createdAt,
    docCount: kb.docs.length,
    chunkCount: chunks.length,
    docs: kb.docs.map((d) => ({ id: d.id, name: d.name, createdAt: d.createdAt, chunkCount: d.chunks.length }))
  };
}

function seedKb() {
  kbSeq += 1;
  const kb = {
    id: "kb-orbit-handbook",
    name: "Orbit 内核手册",
    desc: "运行时内核的第一手资料：三大支柱、插件契约与治理机制。",
    createdAt: Date.now(),
    nextIndex: 0,
    docs: [],
    indexCache: null
  };
  const docs = [
    {
      name: "运行时总览.md",
      content: [
        "Orbit Agent Runtime 是一个零运行时依赖的 TypeScript 插件化 agent runtime 内核，运行在 Node 20 及以上版本，采用 Apache-2.0 许可证。",
        "内核的三大支柱是：确定性重放（deterministic replay）、基于图的隔离（graph-based isolation）与成本感知路由（cost-aware routing）。三者共同构成 agent trust infrastructure 的地基。",
        "插件通过 Plugin Unit Pact 声明身份、版本兼容范围与能力面（channel:read / channel:write），并在注册时经过契约校验；未通过校验的插件无法进入影响域图。",
        "能力调用统一走 CapabilityGateway：网关是确定性边界，负责预算检查、限流、行为观测与录制/重放策略，任何通道调用都不允许绕过网关直连。",
        "内核提供 LLM 抽象通道 llm-access，任何 OpenAI 兼容端点（DeepSeek、Qwen、Kimi、GLM、Ollama 等）都可以通过 baseUrl、model 与 apiKey 三元组接入。"
      ].join("\n\n")
    },
    {
      name: "确定性重放.md",
      content: [
        "确定性重放要求同一输入在录制与重放两个阶段产生逐字节一致的输出。内核通过三件事保证这一点：注入式随机源（rng）、注入式时钟（clock），以及全局调用序（orderIndex）。",
        "录制阶段，RecordJournal 按发生顺序追加每条通道调用记录，包括通道种类、函数名、输入摘要与输出快照；重放阶段，ReplayEngine 按相同的 orderIndex 逐条注入快照，不再触碰真实通道。",
        "reconcile 是重放后的对账报告：逐条比对输入摘要与输出，任何不一致都会被点名，而不是笼统地宣告失败。",
        "宪章 A1 门禁要求：每新增一个机制，必须附带 record 到 replay 的逐字节一致测试用例，否则不予合入。"
      ].join("\n\n")
    },
    {
      name: "图隔离与成本路由.md",
      content: [
        "影响域图（impact graph）以节点表示沙箱、通道与插件，以边表示依赖方向。隔离判定基于图的闭包：两个节点若不存在公共依赖闭包，则视为相互独立，故障不会跨域传播。",
        "成本感知路由在每次能力调用时按预算（budgetPerCycle）与延迟上限筛选通道，选择满足约束的成本最低提供方；插件提供方可以覆盖内置通道并获得优先权。",
        "PAE（Plugin Adaptation Engine）把外部工具面适配为内核可治理的工具：适配器声明隔离级别（L0 进程内 / L2 跨进程）与保真度（full / reduced），非 full 保真度必须携带 fidelityNote，向调用方如实披露降级。",
        "MCP 适配器通过 stdio 或内存传输连接真实 MCP 服务器，握手成功后才注册工具面，控制台不会展示对端没有实际宣告的工具。"
      ].join("\n\n")
    }
  ];
  for (const d of docs) {
    kbSeq += 1;
    const chunks = chunkText(d.content).map((c) => ({ index: kb.nextIndex++, text: c.text }));
    kb.docs.push({ id: `doc-${pad(kbSeq)}`, name: d.name, createdAt: Date.now(), chunks });
  }
  kbs.set(kb.id, kb);
}
seedKb();

/* ---- workflows ---- */

const workflows = new Map();
const workflowRuns = new Map();
let wfRunSeq = 0;

function seedWorkflow() {
  workflows.set("wf-shuanghuan", {
    id: "wf-shuanghuan",
    name: "双环问答阵",
    desc: "首轮推演后由分支判定：模拟通道输出走补卦回路（橙色迭代边），真实模型输出直达终点。",
    updatedAt: Date.now(),
    nodes: [
      { id: "s1", type: "start", title: "起势", x: 60, y: 200, config: {} },
      {
        id: "a1",
        type: "agent",
        title: "首轮推演",
        x: 220,
        y: 200,
        config: { instruct: "你是 Orbit 工作流的首轮推演者，对输入给出简明回应。", prompt: "推演以下输入：" }
      },
      {
        id: "b1",
        type: "branch",
        title: "判定",
        x: 400,
        y: 200,
        config: { conditions: [{ match: "Llm-Sim", to: "a2" }], defaultTo: "e1" }
      },
      {
        id: "a2",
        type: "agent",
        title: "补卦推演",
        x: 400,
        y: 360,
        config: { instruct: "你是 Orbit 工作流的补充推演者，对上一轮结论做补充与修正。", prompt: "补充推演：" }
      },
      { id: "e1", type: "end", title: "收势", x: 580, y: 200, config: {} }
    ],
    edges: [
      { from: "s1", to: "a1", kind: "flow" },
      { from: "a1", to: "b1", kind: "flow" },
      { from: "b1", to: "a2", kind: "flow" },
      { from: "b1", to: "e1", kind: "flow" },
      { from: "a2", to: "a1", kind: "loop" }
    ]
  });
}
seedWorkflow();

/* ------------------------------------------------------------------ */
/* API handlers                                                        */
/* ------------------------------------------------------------------ */

const api = {
  /* ---- state & lifecycle ---- */

  async state() {
    await ensureRunning();
    const entries = host.traceJournal.entries();
    entries.sort((a, b) => b.occurredAt - a.occurredAt);
    return {
      running,
      channels: Array.from(channelRegistry.entries()).map(([kind, meta]) => ({ kind, ...meta })),
      plugins: pluginList(),
      sandboxes: listSandboxes(),
      traceCount: entries.length,
      trace: entries.slice(0, 6),
      runCounter,
      pae: {
        enabled: !host.paeRegistry.isEmpty(),
        adapters: host.paeRegistry.listAdapters().length,
        tools: host.paeRegistry.listTools().length,
        configHash: host.paeRegistry.isEmpty() ? null : host.paeRegistry.configHash()
      }
    };
  },

  async health() {
    return {
      running,
      /*
       * Read from the kernel rather than restating it: a hard-coded version
       * silently goes stale at every release (this one claimed 0.1.0 while the
       * kernel was already at 0.2.0, and the console dutifully displayed it).
       */
      version: KERNEL_VERSION,
      kernel: "OrbitRuntimeHost",
      uptimeSec: Math.round(process.uptime())
    };
  },

  async boot() {
    await ensureRunning();
    audit("host.boot", "kernel", "自底向上装配完成");
    return { running };
  },

  async shutdown() {
    if (running) {
      await host.shutdownHost();
      running = false;
      channelRegistry.clear();
      channelRegistry.set("mem-kv-store", { type: "builtin", label: "Memory KV Store", cost: { costPerCall: 0, latencyMs: 1, quality: 1 } });
      channelRegistry.set("llm-access", { type: "builtin", label: "LLM Mock Channel", cost: { costPerCall: 1, latencyMs: 320, quality: 1 } });
      pluginRegistry.clear();
      boxDeps.clear();
      runCounter = 0;
      audit("host.shutdown", "kernel", "严格反序释放（任务与账本历史保留）");
    }
    return { running };
  },

  /* ---- channels ---- */

  async channels() {
    await ensureRunning();
    return Array.from(channelRegistry.entries()).map(([kind, meta]) => ({ kind, ...meta }));
  },

  async registerPluginChannel(body) {
    await ensureRunning();
    const kind = body?.kind;
    if (kind !== ChannelKind.LLM_ACCESS && kind !== ChannelKind.MEM_KV_STORE) {
      throw new Error(`unsupported channel kind: ${kind}`);
    }
    if (channelRegistry.get(kind)?.type === "plugin") {
      throw new Error(`channel ${kind} already overridden by a plugin provider`);
    }
    host.channelHub.registerPluginExtChannel(kind, new EchoPluginChannel());
    const base = channelRegistry.get(kind);
    channelRegistry.set(kind, {
      ...base,
      type: "plugin",
      label: `${base.label} · echo-plugin`,
      cost: { ...base.cost, latencyMs: Math.max(1, Math.round(base.cost.latencyMs / 4)) }
    });
    audit("channel.register", kind, "echo-plugin 提供方覆盖（优先于内置）");
    return { kind, type: "plugin" };
  },

  async removePluginChannel(body) {
    const kind = body?.kind;
    if (!kind) throw new Error("kind required");
    if (channelRegistry.get(kind)?.type !== "plugin") {
      throw new Error(`channel ${kind} is not plugin-overridden`);
    }
    host.channelHub.removeExtChannel(kind);
    const base = channelRegistry.get(kind);
    channelRegistry.set(kind, {
      type: "builtin",
      label: kind === "llm-access" ? "LLM Mock Channel" : "Memory KV Store",
      cost: base?.cost ?? { costPerCall: 0, latencyMs: 1, quality: 1 }
    });
    audit("channel.remove", kind, "插件提供方已移除，回退内置通道");
    return { kind, type: "builtin" };
  },

  /* ---- real model provider (DeepSeek) ---- */

  async registerDeepSeekChannel(body) {
    await ensureRunning();
    const apiKey = body?.apiKey;
    if (apiKey === undefined || apiKey === null) throw new Error("apiKey required (empty allowed for unauthenticated endpoints like Ollama)");
    const model = body?.model ?? "deepseek-chat";
    // baseUrl optional: defaults to DeepSeek, but any OpenAI-compatible
    // endpoint works (OpenAI, Qwen, Kimi, GLM, Ollama, vLLM, ...).
    const baseUrl = body?.baseUrl || undefined;
    host.channelHub.registerPluginExtChannel(
      ChannelKind.LLM_ACCESS,
      new DeepSeekChannel({ apiKey, model, temperature: body?.temperature, baseUrl })
    );
    channelRegistry.set("llm-access", {
      type: "deepseek",
      label: `${baseUrl ?? "DeepSeek"} · ${model}`,
      cost: { costPerCall: 1, latencyMs: 800, quality: 0.98 }
    });
    audit("channel.register", "llm-access", `真实模型提供方接入：${baseUrl ?? "DeepSeek"} · ${model}`);
    return { kind: "llm-access", type: "deepseek", model, baseUrl: baseUrl ?? "https://api.deepseek.com" };
  },

  async removeDeepSeekChannel() {
    if (channelRegistry.get("llm-access")?.type !== "deepseek") {
      throw new Error("llm-access is not powered by DeepSeek");
    }
    host.channelHub.removeExtChannel("llm-access");
    channelRegistry.set("llm-access", {
      type: "builtin",
      label: "LLM Mock Channel",
      cost: { costPerCall: 1, latencyMs: 320, quality: 1 }
    });
    audit("channel.remove", "llm-access", "真实提供方已移除，回退模拟通道");
    return { kind: "llm-access", type: "builtin" };
  },

  /* ---- plugins ---- */

  async registerPlugin(body) {
    await ensureRunning();
    const pact = body?.pact;
    if (!pact) throw new Error("pact required");
    host.registerPlugin(pact);
    pluginRegistry.set(pact.id, { ...pact, registeredAt: Date.now() });
    audit("plugin.register", pact.id, `插件注册（${pact.edition}）`);
    return pluginList();
  },

  async plugins() {
    await ensureRunning();
    return pluginList();
  },

  async resetPlugins() {
    // Kernel currently offers no per-node removal on the impact graph, so a
    // "reset" clears the pact verifier and rebuilds the graph from scratch.
    host.pluginPactVerifier.clear();
    host.impactGraph.clear();
    pluginRegistry.clear();
    for (const [id, deps] of boxDeps) {
      host.impactGraph.addNode(id);
      for (const dep of deps) host.impactGraph.addEdge(id, dep);
    }
    return pluginList();
  },

  /* ---- sandboxes ---- */

  async spawnBox(body) {
    await ensureRunning();
    const cfg = body?.config;
    if (!cfg?.agentBoxId || !cfg?.boxAlias) throw new Error("agentBoxId and boxAlias required");
    const deps = cfg.channelDeps ?? [ChannelKind.LLM_ACCESS];
    host.spawnAgentBox({
      agentBoxId: cfg.agentBoxId,
      boxAlias: cfg.boxAlias,
      baseInstruct: cfg.baseInstruct ?? "You are a demo assistant.",
      maxCycleRun: Number(cfg.maxCycleRun ?? 5),
      replayMode: cfg.replayMode ?? "live",
      budgetPerCycle: cfg.budgetPerCycle !== undefined ? Number(cfg.budgetPerCycle) : undefined,
      channelDeps: deps
    });
    boxDeps.set(cfg.agentBoxId, deps);
    audit("box.spawn", cfg.agentBoxId, `沙箱生成（${deps.join(", ")}）`);
    return listSandboxes();
  },

  async boxes() {
    await ensureRunning();
    return listSandboxes();
  },

  /**
   * Run one sandbox cycle as a governed task: the six-state machine in the
   * task registry, ledger metering for the channel calls the cycle really
   * made, and an audit event on completion. The kernel still executes the
   * cycle — this wrapper only observes at the boundary.
   */
  async runBox(boxId, body) {
    await ensureRunning();
    const box = host.sandboxPool.get(boxId);
    if (!box) throw new Error(`sandbox ${boxId} not found`);
    const input = body?.input ?? "";
    runCounter += 1;
    const task = beginTask("agent", `实例轮次 · ${box.boxAlias || boxId}`, { box: boxId });
    const step = taskStep(task, "runSingleCycle", String(input).slice(0, 80));
    const cyclesBefore = box.cycleCountNow();
    const t0 = performance.now();
    task.status = "running";
    task.startedAt = Date.now();
    try {
      const output = await box.runSingleCycle(input);
      /* Meter every cycle the kernel actually executed during this call. */
      const cycles = box.cycleCountNow() - cyclesBefore;
      const routed = host.routeChannel(boxDeps.get(boxId) ?? [ChannelKind.LLM_ACCESS], 10, 10_000) ?? ChannelKind.LLM_ACCESS;
      for (let i = 0; i < Math.max(0, cycles); i++) charge(task.id, boxId, routed, "chatRound");
      step.status = "done";
      step.ms = Math.round(performance.now() - t0);
      task.result = {
        agentBoxId: box.agentBoxId,
        output,
        cycleNow: box.cycleCountNow(),
        maxCycle: box.maxCycleRun
      };
      finishTask(task, task.abortRequested ? "aborted" : "done");
      return { ...task.result, taskId: task.id, taskStatus: task.status };
    } catch (err) {
      step.status = "failed";
      step.detail = String(err?.message ?? err);
      finishTask(task, "failed", err);
      throw err;
    }
  },

  async resetBox(boxId) {
    const box = host.sandboxPool.get(boxId);
    if (!box) throw new Error(`sandbox ${boxId} not found`);
    box.resetCycleCount();
    return listSandboxes();
  },

  async removeBox(boxId) {
    host.sandboxPool.remove(boxId);
    boxDeps.delete(boxId);
    // Graph node removal is not yet exposed by the kernel; the node stays
    // until the host is restarted. This is surfaced in the UI.
    audit("box.remove", boxId, "沙箱已移除（图节点待内核支持移除）");
    return listSandboxes();
  },

  /* ---- trace journal ---- */

  async trace(query = {}) {
    await ensureRunning();
    let entries = host.traceJournal.entries();
    if (query.traceMark) entries = entries.filter((e) => e.traceMarkId === query.traceMark);
    if (query.box) entries = entries.filter((e) => e.agentBoxId === query.box);
    entries.sort((a, b) => b.occurredAt - a.occurredAt);
    return entries.slice(0, Number(query.limit ?? 500));
  },

  /* ---- replay studio (runs on a throwaway host) ---- */

  async replayDemo() {
    const lab = new OrbitRuntimeHost();
    await lab.bootHost();

    const originalJournal = lab.beginRecording();
    const recordBox = lab.spawnAgentBox({
      agentBoxId: "box.lab-record",
      boxAlias: "record-agent",
      baseInstruct: "You are a demo assistant.",
      maxCycleRun: 10,
      replayMode: "record"
    });
    const t0 = performance.now();
    const originals = [];
    for (const input of REPLAY_CYCLES) originals.push(await recordBox.runSingleCycle(input));
    const recordMs = performance.now() - t0;

    const replayedJournal = lab.beginRecording();
    lab.attachReplayEngine(originalJournal);
    const replayBox = lab.spawnAgentBox({
      agentBoxId: "box.lab-replay",
      boxAlias: "replay-agent",
      baseInstruct: "You are a demo assistant.",
      maxCycleRun: 10,
      replayMode: "replay"
    });
    const t1 = performance.now();
    const replays = [];
    for (const input of REPLAY_CYCLES) replays.push(await replayBox.runSingleCycle(input));
    const replayMs = performance.now() - t1;

    const identical = originals.every((out, i) => out === replays[i]);
    const report = new ReplayEngine(originalJournal).reconcile(originalJournal.snapshot(), replayedJournal.snapshot());

    await lab.shutdownHost();

    return {
      cycles: REPLAY_CYCLES,
      record: { outputs: originals, count: originalJournal.size(), ms: Math.round(recordMs) },
      replay: { outputs: replays, count: replayedJournal.size(), ms: Math.round(replayMs) },
      identical,
      reconcile: report,
      speedup: replayMs > 0 ? Number((recordMs / Math.max(replayMs, 1)).toFixed(1)) : null,
      journal: originalJournal.snapshot().map((r) => ({
        orderIndex: r.orderIndex,
        channelKind: r.channelKind,
        funcName: r.funcName,
        inputDigest: r.inputDigest.slice(0, 12) + "…",
        durationMs: r.durationMs
      }))
    };
  },

  /* ---- impact graph (M3) ---- */

  async graph() {
    await ensureRunning();
    const dependencies = host.impactGraph["dependencies"] ?? new Map();
    const dependents = host.impactGraph["dependents"] ?? new Map();
    const nodes = new Set([...dependencies.keys(), ...dependents.keys()]);
    const edges = [];
    for (const [dependent, depSet] of dependencies) {
      for (const dependency of depSet) edges.push({ from: dependent, to: dependency });
    }
    const knownChannels = new Set([...channelRegistry.keys()]);
    const nodeList = [...nodes].map((id) => {
      let kind = "sandbox";
      if (knownChannels.has(id)) kind = "channel";
      else if (pluginRegistry.has(id)) kind = "plugin";
      else if (id.startsWith("plugin.")) kind = "plugin";
      return { id, kind };
    });

    // PAE surface: the adaptation channel + one node per registered adapter,
    // wired adapter → pae-tool so the bloodline shows the foreign surface
    // feeding the capability channel it is published through.
    if (!host.paeRegistry.isEmpty()) {
      nodeList.push({ id: ChannelKind.PAE_TOOL, kind: "pae" });
      for (const m of host.paeRegistry.listAdapters()) {
        nodeList.push({ id: m.adapterId, kind: "pae-adapter" });
        edges.push({ from: m.adapterId, to: ChannelKind.PAE_TOOL });
      }
    }

    return { nodes: nodeList, edges };
  },

  async isolation(nodeId) {
    await ensureRunning();
    return { node: nodeId, closure: [...host.impactGraph.closure(nodeId)] };
  },

  async checkIsolation(body) {
    const a = body?.a;
    const b = body?.b;
    if (!a || !b) throw new Error("a and b required");
    return { a, b, independent: host.impactGraph.areIndependent(a, b) };
  },

  /* ---- cost routing (M4) ---- */

  async routingProfiles() {
    await ensureRunning();
    return Array.from(channelRegistry.entries()).map(([kind, meta]) => ({ kind, ...meta.cost, type: meta.type }));
  },

  async simulateRoute(body) {
    await ensureRunning();
    const budget = Number(body?.budget ?? 1);
    const maxLatencyMs = Number(body?.maxLatencyMs ?? 10_000);
    const chosen = host.routeChannel([ChannelKind.LLM_ACCESS], budget, maxLatencyMs) ?? null;
    const profiles = Array.from(channelRegistry.entries()).map(([kind, meta]) => ({
      kind,
      costPerCall: meta.cost.costPerCall,
      latencyMs: meta.cost.latencyMs,
      quality: meta.cost.quality,
      type: meta.type,
      fits: meta.cost.costPerCall <= budget && meta.cost.latencyMs <= maxLatencyMs
    }));
    return { budget, maxLatencyMs, chosen, profiles };
  },

  /* ---- PAE · Plugin Adaptation Engine (W15) ---- */

  async pae() {
    await ensureRunning();
    const adapters = host.paeRegistry.listAdapters().map((m) => {
      const instance = host.paeRegistry.get(m.adapterId);
      return {
        adapterId: m.adapterId,
        kind: m.kind,
        sourceEdition: m.sourceEdition,
        isolation: m.isolation,
        toolCount: instance?.describe().length ?? 0,
        // MCP peers identify themselves during the handshake; JS adapters have
        // no such notion, so this is null rather than absent.
        serverInfo: instance?.serverInfo ?? null
      };
    });
    const tools = host.paeRegistry.listTools().map((t) => ({
      name: t.name,
      capability: t.capability,
      determinism: t.determinism,
      fidelity: t.fidelity,
      fidelityNote: t.fidelityNote,
      description: t.description,
      template: paeToolMeta.get(t.name)?.template ?? null
    }));
    return {
      paeEnabled: !host.paeRegistry.isEmpty(),
      configHash: host.paeRegistry.isEmpty() ? null : host.paeRegistry.configHash(),
      adapters,
      tools
    };
  },

  async registerPae(body) {
    await ensureRunning();
    if (body?.kind === "mcp") return this.registerMcp(body);

    const adapterId = body?.adapterId;
    const tools = body?.tools;
    if (!adapterId) throw new Error("adapterId required");
    if (!Array.isArray(tools) || tools.length === 0) throw new Error("at least one tool required");
    const adapter = new JsPaeAdapter({
      adapterId,
      sourceEdition: body?.sourceEdition || "1.0.0",
      isolation: body?.isolation || "L0",
      tools: tools.map(buildPaeToolSpec)
    });
    host.registerPaeToolAdapter(adapter);
    for (const t of tools) paeToolMeta.set(t.name, { template: t.template });
    audit("pae.register", adapterId, `JS 适配器注册（${tools.length} 个工具）`);
    return this.pae();
  },

  /**
   * Connect a real MCP server over stdio.
   *
   * The peer is spawned, handed through `initialize` → `tools/list`, and only
   * registered once the surface is known — so the console never advertises a
   * tool the peer did not actually announce.
   *
   * Security note: the console is a local, developer-operated tool bound to
   * loopback, and letting the operator name the server they want to connect to
   * is the entire point of MCP. `shell` defaults to false so the command is
   * executed directly; enabling it (needed for `npx` on Windows) is an explicit
   * opt-in by the person already at the keyboard.
   */
  async registerMcp(body) {
    await ensureRunning();
    const adapterId = body?.adapterId;
    const command = body?.command;
    if (!adapterId) throw new Error("adapterId required");
    if (!command) throw new Error("command required — 启动 MCP 服务器的可执行文件");

    const args = Array.isArray(body?.args) ? body.args.map(String) : [];
    const timeoutMs = Number(body?.timeoutMs) || 15000;

    const transport = new StdioMcpTransport({
      command: String(command),
      args,
      shell: body?.shell === true,
      ...(body?.cwd ? { cwd: String(body.cwd) } : {})
    });

    const adapter = new McpPaeAdapter({
      adapterId,
      sourceEdition: body?.sourceEdition || "unknown",
      transport,
      ...(body?.toolNamePrefix ? { toolNamePrefix: String(body.toolNamePrefix) } : {}),
      defaultTimeoutMs: timeoutMs
    });

    try {
      await host.connectPaeToolAdapter(adapter, { maxWaitMs: timeoutMs });
    } catch (err) {
      /*
       * A failed handshake must not leave an orphan process behind. This is the
       * one place where "we never registered it" and "nothing is running" have
       * to be made true by hand.
       */
      await transport.close().catch(() => {});
      throw new Error(`MCP 连接失败：${err.message}`);
    }

    for (const t of adapter.describe()) paeToolMeta.set(t.name, { template: "mcp" });
    return this.pae();
  },

  async invokePae(body) {
    await ensureRunning();
    const toolName = body?.toolName;
    if (!toolName) throw new Error("toolName required");
    const meta = paeToolMeta.get(toolName);
    let args;
    if (Array.isArray(body?.args)) {
      /* New contract: the console sends positional args directly. */
      args = body.args;
    } else {
      /*
       * The console sends the typed argument as a string under `args`; older
       * callers used `argText`. Accept both — dropping it silently made the
       * Adapter Studio invoke console swallow user input.
       */
      const argText = String(body?.argText ?? body?.args ?? "");
      if (meta?.template === "add") {
        args = argText.split(",").map((s) => Number(s.trim())).filter((n) => !Number.isNaN(n));
      } else if (meta?.template === "mcp") {
        /*
         * MCP tools take named arguments, so the console sends a JSON object
         * rather than a positional string. Empty input is a legitimate call with
         * no arguments; anything unparseable is surfaced as-is so the caller can
         * see what they actually sent.
         */
        const text = argText.trim();
        try {
          args = [text === "" ? {} : JSON.parse(text)];
        } catch (err) {
          throw new Error(`MCP 工具入参需为 JSON 对象，如 {"name":"world"}（收到：${text.slice(0, 80)}）`);
        }
        if (args[0] === null || typeof args[0] !== "object" || Array.isArray(args[0])) {
          throw new Error(`MCP 工具入参需为 JSON 对象，如 {"name":"world"}`);
        }
      } else {
        args = [argText];
      }
    }
    // Honest determinism: rng/clock are injected, never minted by the adapter.
    const rng = new SeededRng(paeSeed++);
    const clock = { now: () => Date.now() };
    const t0 = performance.now();
    const output = await host.gateway.capabilityInvoke({
      kind: ChannelKind.PAE_TOOL,
      funcName: toolName,
      args,
      mode: "live",
      ctx: { rng, clock }
    });
    charge(null, null, ChannelKind.PAE_TOOL, toolName);
    return {
      toolName,
      args,
      output,
      ms: Number((performance.now() - t0).toFixed(2)),
      route: "pae",
      channel: ChannelKind.PAE_TOOL
    };
  },

  async negotiatePae(body) {
    await ensureRunning();
    const toolName = body?.toolName;
    if (!toolName) throw new Error("toolName required");
    const minFidelity = body?.minFidelity ?? "full";
    // Throws PaeFidelityRejectError on an honest downgrade; the router reports
    // it as a normal API error and the console shows the informed-choice gate.
    const negotiated = host.negotiatePaeTool(toolName, minFidelity);
    return { negotiated };
  },

  async removePae(adapterId) {
    await ensureRunning();
    if (!adapterId) throw new Error("adapterId required");
    const before = host.paeRegistry.get(adapterId)?.describe().map((t) => t.name) ?? [];
    /*
     * `release` rather than `unregister`: for an MCP adapter the difference is
     * real — unregister drops it from the index immediately, but the spawned
     * peer only actually exits once teardown has been awaited.
     */
    await host.releasePaeToolAdapter(adapterId);
    for (const name of before) paeToolMeta.delete(name);
    audit("pae.remove", adapterId, `适配器已释放（${before.length} 个工具下线）`);
    return this.pae();
  },

  /* ---- auth (session gate lives in the router, not here) ---- */

  async authRegister(body) {
    const user = createUser({
      account: body?.account,
      password: body?.password,
      name: body?.name,
      email: body?.email
    });
    audit("auth.register", user.account, `新用户注册（${ROLE_CN[user.role] ?? user.role}）`);
    const token = openSession(user.account);
    return { user: publicUser(user), token };
  },

  async authLogin(body) {
    const u = users.get(body?.account);
    if (!u || !verifyPassword(u, body?.password ?? "")) {
      audit("auth.login", String(body?.account ?? "?"), "登录失败（账号或密码错误）", "err");
      throw new Error("账号或密码错误");
    }
    const token = openSession(u.account);
    audit("auth.login", u.account, "登录成功");
    return { user: publicUser(u), token };
  },

  authMe(sess) {
    const u = users.get(sess.account);
    if (!u) throw new Error("会话对应的用户已不存在");
    return publicUser(u);
  },

  authLogout(sess) {
    sessions.delete(sess.token);
    audit("auth.logout", sess.account, "退出登录");
    return { ok: true };
  },

  authPassword(sess, body) {
    const u = users.get(sess.account);
    if (!u) throw new Error("会话对应的用户已不存在");
    if (!verifyPassword(u, body?.oldPassword ?? "")) throw new Error("原密码不正确");
    if (typeof body?.newPassword !== "string" || body.newPassword.length < 6) throw new Error("新密码至少 6 位");
    u.salt = randomUUID().replace(/-/g, "");
    u.hash = hashPassword(body.newPassword, u.salt);
    audit("auth.password", u.account, "密码已修改");
    return { ok: true };
  },

  /* ---- tasks ---- */

  tasks(query = {}) {
    return taskList(query);
  },

  task(id) {
    const t = taskRegistry.get(id);
    if (!t) throw new Error(`task ${id} not found`);
    return t;
  },

  /**
   * Abort is cooperative: execution is single-threaded, so a running task
   * only observes the request at its next await boundary (between workflow
   * nodes, between RAG steps, after a sandbox cycle). Queued-but-not-yet-
   * finished tasks abort immediately.
   */
  abortTask(id) {
    const t = taskRegistry.get(id);
    if (!t) throw new Error(`task ${id} not found`);
    if (t.status === "done" || t.status === "failed" || t.status === "aborted") {
      throw new Error(`task ${id} 已结束（${t.status}），无法终止`);
    }
    t.abortRequested = true;
    if (t.status === "queued") finishTask(t, "aborted");
    else audit("task.abort", t.id, `${t.title}（将在下一检查点生效）`, "warn", t.kind);
    return t;
  },

  /* ---- templates ---- */

  templates() {
    return [...templates.values()].map((t) => ({
      id: t.id,
      name: t.name,
      desc: t.desc,
      currentVersion: t.currentVersion,
      versionCount: t.versions.length,
      updatedAt: t.versions[t.versions.length - 1].createdAt,
      snapshot: t.versions[t.currentVersion - 1].snapshot
    }));
  },

  saveTemplate(body) {
    const name = String(body?.name ?? "").trim();
    if (!name) throw new Error("模板名称 required");
    const snapshot = templateSnapshot(body);
    let tpl = body?.id ? templates.get(body.id) : undefined;
    if (body?.id && !tpl) throw new Error(`template ${body.id} not found`);
    if (!tpl) {
      templateSeq += 1;
      const id = `tpl-${pad(templateSeq)}`;
      tpl = { id, name, desc: String(body?.desc ?? ""), currentVersion: 1, versions: [] };
      templates.set(id, tpl);
    }
    const version = tpl.versions.length + 1;
    tpl.versions.push({ version, snapshot: structuredClone(snapshot), note: String(body?.note ?? ""), createdAt: Date.now() });
    tpl.currentVersion = version;
    if (body?.name) tpl.name = name;
    if (body?.desc !== undefined) tpl.desc = String(body.desc);
    audit("template.save", tpl.id, `${tpl.name} → v${version}${body?.note ? `（${body.note}）` : ""}`);
    return this.templates();
  },

  templateVersions(id) {
    const tpl = templates.get(id);
    if (!tpl) throw new Error(`template ${id} not found`);
    return tpl.versions.map((v) => ({
      version: v.version,
      note: v.note,
      createdAt: v.createdAt,
      isCurrent: v.version === tpl.currentVersion,
      rollbackOf: v.rollbackOf ?? null,
      snapshot: v.snapshot
    }));
  },

  rollbackTemplate(id, body) {
    const tpl = templates.get(id);
    if (!tpl) throw new Error(`template ${id} not found`);
    const target = Number(body?.version);
    const src = tpl.versions.find((v) => v.version === target);
    if (!src) throw new Error(`template ${id} 没有 v${target}`);
    if (src.version === tpl.currentVersion) throw new Error(`v${target} 已是当前版本`);
    const version = tpl.versions.length + 1;
    /* Rollback appends a new version instead of mutating history — the
       version chain stays append-only and auditable. */
    tpl.versions.push({
      version,
      snapshot: structuredClone(src.snapshot),
      note: `回滚至 v${target}`,
      rollbackOf: target,
      createdAt: Date.now()
    });
    tpl.currentVersion = version;
    audit("template.rollback", tpl.id, `当前版本 v${version}（内容回滚自 v${target}）`, "warn");
    return this.templateVersions(id);
  },

  removeTemplate(id) {
    if (!templates.has(id)) throw new Error(`template ${id} not found`);
    templates.delete(id);
    audit("template.remove", id, "模板已删除");
    return this.templates();
  },

  /* ---- knowledge bases ---- */

  kbList() {
    return [...kbs.values()].map(kbSummary);
  },

  kbCreate(body) {
    const name = String(body?.name ?? "").trim();
    if (!name) throw new Error("知识库名称 required");
    kbSeq += 1;
    const kb = {
      id: `kb-${pad(kbSeq)}`,
      name,
      desc: String(body?.desc ?? ""),
      createdAt: Date.now(),
      nextIndex: 0,
      docs: [],
      indexCache: null
    };
    kbs.set(kb.id, kb);
    audit("kb.create", kb.id, `知识库创建：${name}`);
    return kbSummary(kb);
  },

  kbDetail(id) {
    const kb = kbs.get(id);
    if (!kb) throw new Error(`knowledge base ${id} not found`);
    const { index, chunks } = kbIndex(kb);
    return { ...kbSummary(kb), indexedChunks: index.total, sample: chunks.slice(0, 3).map((c) => ({ docName: c.docName, text: c.text.slice(0, 120) })) };
  },

  kbRemove(id) {
    if (!kbs.has(id)) throw new Error(`knowledge base ${id} not found`);
    kbs.delete(id);
    audit("kb.remove", id, "知识库已删除", "warn");
    return this.kbList();
  },

  kbUpload(id, body) {
    const kb = kbs.get(id);
    if (!kb) throw new Error(`knowledge base ${id} not found`);
    const name = String(body?.name ?? "").trim();
    const content = String(body?.content ?? "");
    if (!name) throw new Error("文档名称 required");
    if (!content.trim()) throw new Error("文档内容为空");
    if (content.length > 200_000) throw new Error("文档过长（上限 200,000 字符）");
    /* 切片参数由前端面板透传：切片大小（字符）与重叠率（0–0.5）。
       未传时回退到 chunkText 的默认（320 / 0.15），与 UI 默认值一致。 */
    const size = body?.chunkSize != null ? Number(body.chunkSize) : undefined;
    const overlap = body?.overlap != null ? Number(body.overlap) : undefined;
    kbSeq += 1;
    const chunks = chunkText(content, { size, overlap }).map((c) => ({ index: kb.nextIndex++, text: c.text }));
    if (chunks.length === 0) throw new Error("切片结果为空");
    const doc = { id: `doc-${pad(kbSeq)}`, name, createdAt: Date.now(), chunks };
    kb.docs.push(doc);
    kb.indexCache = null;
    audit("kb.upload", `${kb.id}/${doc.id}`, `《${name}》入库：${chunks.length} 个切片`);
    return { ...kbSummary(kb), uploaded: { id: doc.id, name, chunkCount: chunks.length, chunkSize: size, overlap } };
  },

  kbDoc(kbId, docId) {
    const kb = kbs.get(kbId);
    if (!kb) throw new Error(`knowledge base ${kbId} not found`);
    const doc = kb.docs.find((d) => d.id === docId);
    if (!doc) throw new Error(`document ${docId} not found`);
    return { id: doc.id, name: doc.name, createdAt: doc.createdAt, chunkCount: doc.chunks.length, chunks: doc.chunks };
  },

  kbSearch(id, body) {
    const kb = kbs.get(id);
    if (!kb) throw new Error(`knowledge base ${id} not found`);
    const query = String(body?.query ?? "").trim();
    if (!query) throw new Error("query required");
    const { chunks } = kbIndex(kb);
    const hits = searchIndex(kbIndex(kb).index, query, Math.max(1, Number(body?.k ?? 5)));
    return {
      query,
      total: chunks.length,
      hits: hits.map((h) => {
        const chunk = chunks.find((c) => c.index === h.chunkIndex);
        if (!chunk) return null;
        return {
          docId: chunk.docId,
          docName: chunk.docName,
          chunkIndex: h.chunkIndex,
          score: h.score,
          text: chunk.text,
          ranges: highlightRanges(chunk.text, query)
        };
      }).filter(Boolean)
    };
  },

  /* ---- RAG 推演 ---- */

  ragRuns(kbId) {
    let list = [...ragRunsStore.values()];
    if (kbId) list = list.filter((r) => r.kbId === kbId);
    list.reverse();
    return list.slice(0, 50).map(({ hits, ...rest }) => ({ ...rest, hitCount: hits.length }));
  },

  ragDetail(id) {
    const run = ragRunsStore.get(id);
    if (!run) throw new Error(`rag run ${id} not found`);
    return run;
  },

  /**
   * The eight-step pipeline from kb.js, executed for real:
   * BM25 retrieval is deterministic, sufficiency assessment decides the
   * single refine hop, and synthesis goes through the kernel's llm-access
   * gateway call (mock channel when no provider is registered — the answer
   * then honestly reads as [Llm-Sim]).
   */
  async ragRun(body) {
    await ensureRunning();
    const kb = kbs.get(body?.kbId);
    if (!kb) throw new Error(`knowledge base ${body?.kbId ?? "?"} not found`);
    const question = String(body?.question ?? "").trim();
    if (!question) throw new Error("question required");
    const topK = Math.max(1, Math.min(10, Number(body?.topK ?? 4)));

    ragSeq += 1;
    const runId = `rag-${pad(ragSeq)}`;
    const task = beginTask("rag", `RAG推演 · ${question.slice(0, 24)}`, { kbId: kb.id, question });
    const steps = RAG_STEPS.map((s) => ({ ...s, status: "pending", detail: "", ms: null }));
    const run = {
      id: runId,
      taskId: task.id,
      kbId: kb.id,
      kbName: kb.name,
      question,
      refinedQuery: null,
      hops: 0,
      steps,
      hits: [],
      answer: null,
      citations: [],
      createdAt: Date.now(),
      ms: null
    };
    ragRunsStore.set(runId, run);
    task.status = "running";
    task.startedAt = Date.now();
    const t0 = performance.now();

    const runStep = async (id, fn) => {
      const st = steps.find((s) => s.id === id);
      st.status = "running";
      const s0 = performance.now();
      try {
        const detail = await fn(st);
        st.status = "done";
        st.detail = detail ?? "";
        st.ms = Math.round(performance.now() - s0);
      } catch (err) {
        st.status = "failed";
        st.detail = String(err?.message ?? err);
        throw err;
      }
    };

    try {
      let query = question;
      await runStep("parse", () => {
        const tokens = contentTokens(question);
        if (tokens.length === 0) throw new Error("查询无法解析出有效词元");
        return `${tokens.length} 个词元`;
      });

      const lookup = () => {
        const { chunks } = kbIndex(kb);
        return searchIndex(kbIndex(kb).index, query, topK).map((h) => {
          const chunk = chunks.find((c) => c.index === h.chunkIndex);
          return chunk ? { docId: chunk.docId, docName: chunk.docName, chunkIndex: h.chunkIndex, score: h.score, text: chunk.text } : null;
        }).filter(Boolean);
      };

      let hits = [];
      await runStep("retrieve", () => {
        hits = lookup();
        if (hits.length === 0) throw new Error("初检无命中——知识库可能为空或与查询无关");
        return `top${hits.length}，最高分 ${hits[0].score}`;
      });

      let assessed = null;
      await runStep("assess", () => {
        assessed = assessSufficiency(hits);
        return assessed.enough ? `充分（top1=${assessed.top}，${assessed.count} 命中）` : `不足（top1=${assessed.top}，${assessed.count} 命中）`;
      });

      /* 补搜回流：查询改写是确定性的（取 top 命中切片中未入查询的高频词）。 */
      if (!assessed.enough && assessed.canRefine) {
        task.status = "iterating";
        await runStep("refine", () => {
          const qTokens = new Set(contentTokens(question));
          const extra = [...new Set(contentTokens(hits[0].text))].filter((t) => !qTokens.has(t)).slice(0, 3);
          query = [question, ...extra].join(" ");
          run.refinedQuery = query;
          run.hops = 1;
          return `改写为「${query}」（+${extra.join("、")}）`;
        });
        await runStep("retrieve", () => {
          hits = lookup();
          return `补检 top${hits.length}，最高分 ${hits[0]?.score ?? 0}`;
        });
      } else {
        const st = steps.find((s) => s.id === "refine");
        st.status = "skipped";
        st.detail = assessed.enough ? "初检已充分，无需补搜" : "补搜轮次已用尽";
      }

      await runStep("rerank", () => {
        hits = [...hits].sort((a, b) => b.score - a.score || a.chunkIndex - b.chunkIndex);
        const docs = new Set(hits.map((h) => h.docId));
        return `${hits.length} 切片 · 覆盖 ${docs.size} 个文档`;
      });

      await runStep("synthesize", async () => {
        const context = hits.map((h, i) => `[${i + 1}]（${h.docName} · 片段${h.chunkIndex}）${h.text}`).join("\n\n");
        const prompt = [
          "你是 Orbit RAG 推演引擎。仅依据下列检索结果回答问题，引用来源用 [编号] 标注；检索结果不足以回答时明确说明。",
          "",
          "检索结果：",
          context,
          "",
          `问题：${question}`
        ].join("\n");
        const out = await host.gateway.capabilityInvoke({
          kind: ChannelKind.LLM_ACCESS,
          funcName: "chatRound",
          args: [prompt],
          mode: "live",
          ctx: { rng: new SeededRng(paeSeed++), clock: { now: () => Date.now() } }
        });
        charge(task.id, null, ChannelKind.LLM_ACCESS, "rag.chatRound");
        run.answer = String(out);
        return `经 llm-access 通道合成（${channelRegistry.get("llm-access")?.label ?? "llm"}）`;
      });

      await runStep("ground", () => {
        run.citations = hits.map((h, i) => ({
          index: i + 1,
          docId: h.docId,
          docName: h.docName,
          chunkIndex: h.chunkIndex,
          score: h.score,
          /* 带上原文：溯源要能展开被引用切片本身，而不只是它的坐标。 */
          text: h.text,
          ranges: highlightRanges(h.text, question)
        }));
        return `${run.citations.length} 条引用已锚定`;
      });

      await runStep("audit", () => {
        audit("rag.run", runId, `「${question.slice(0, 40)}」· ${run.hops} 轮补搜 · ${run.citations.length} 条引用`, "ok", "rag");
        return "已落入事件流";
      });

      run.hits = hits;
      run.ms = Math.round(performance.now() - t0);
      task.result = { runId, answer: run.answer, citations: run.citations.length, hops: run.hops, ms: run.ms };
      finishTask(task, task.abortRequested ? "aborted" : "done");
      return run;
    } catch (err) {
      run.ms = Math.round(performance.now() - t0);
      finishTask(task, "failed", err);
      throw err;
    }
  },

  /* ---- workflows ---- */

  workflows() {
    return [...workflows.values()].map((w) => ({
      id: w.id,
      name: w.name,
      desc: w.desc,
      nodeCount: w.nodes.length,
      edgeCount: w.edges.length,
      updatedAt: w.updatedAt
    }));
  },

  workflowGet(id) {
    const w = workflows.get(id);
    if (!w) throw new Error(`workflow ${id} not found`);
    return w;
  },

  workflowSave(body) {
    const name = String(body?.name ?? "").trim();
    if (!name) throw new Error("工作流名称 required");
    const candidate = {
      id: body?.id ?? "",
      name,
      desc: String(body?.desc ?? ""),
      nodes: Array.isArray(body?.nodes) ? body.nodes : [],
      edges: Array.isArray(body?.edges) ? body.edges : []
    };
    const check = validateWorkflow(candidate);
    if (!check.valid) {
      throw new Error(`工作流校验未通过：${check.errors.filter((e) => e.level === "err").map((e) => e.text).join("；")}`);
    }
    if (!topoOrder(candidate)) throw new Error("顺序流存在环（loop 边之外的环不允许保存）");
    let wf = body?.id ? workflows.get(body.id) : undefined;
    if (body?.id && !wf) throw new Error(`workflow ${body.id} not found`);
    if (!wf) {
      wf = { ...candidate, id: `wf-${Date.now().toString(36)}` };
      workflows.set(wf.id, wf);
    } else {
      Object.assign(wf, candidate);
    }
    wf.updatedAt = Date.now();
    audit("workflow.save", wf.id, `${wf.name}（${wf.nodes.length} 节点 / ${wf.edges.length} 边）`);
    return this.workflows();
  },

  workflowRemove(id) {
    if (!workflows.has(id)) throw new Error(`workflow ${id} not found`);
    workflows.delete(id);
    audit("workflow.remove", id, "工作流已删除", "warn");
    return this.workflows();
  },

  /**
   * Execute a workflow on the real kernel. Agent nodes spawn throwaway
   * sandboxes (removed after the run), tool nodes go through the gateway,
   * branches evaluate deterministically. The run record carries an ordered
   * nodeLog — that is what the canvas replays in slow motion.
   */
  async workflowRun(id, body) {
    await ensureRunning();
    const wf = workflows.get(id);
    if (!wf) throw new Error(`workflow ${id} not found`);
    const check = validateWorkflow(wf);
    if (!check.valid) throw new Error(`工作流校验未通过：${check.errors.filter((e) => e.level === "err").map((e) => e.text).join("；")}`);
    const input = String(body?.input ?? "").trim() || "（空输入）";

    wfRunSeq += 1;
    const runId = `wfr-${pad(wfRunSeq)}`;
    const task = beginTask("workflow", `工作流编排 · ${wf.name}`, { workflowId: wf.id });
    const run = {
      id: runId,
      taskId: task.id,
      workflowId: wf.id,
      workflowName: wf.name,
      input,
      status: "running",
      startedAt: Date.now(),
      endedAt: null,
      nodeLog: [],
      nodeStates: {},
      result: null,
      error: null,
      ms: null
    };
    workflowRuns.set(runId, run);
    task.status = "running";
    task.startedAt = Date.now();
    const t0 = performance.now();

    const nodesById = new Map(wf.nodes.map((n) => [n.id, n]));
    const visits = new Map();
    const MAX_VISITS = 3;   /* loop edges re-enter a node at most twice */
    const MAX_STEPS = 32;   /* global step budget — the array guard-rail */
    const startNode = wf.nodes.find((n) => n.type === "start");
    const queue = [{ nodeId: startNode.id, input, viaLoop: false }];
    let steps = 0;
    let lastOutput = input;

    const log = (nodeId, status, detail, ms) =>
      run.nodeLog.push({ nodeId, status, detail: detail ?? "", ms: ms ?? null, at: Date.now(), seq: run.nodeLog.length });

    const spawnCycle = async (node, cycleInput) => {
      const boxId = `wf.${runId}.${node.id}`;
      host.spawnAgentBox({
        agentBoxId: boxId,
        boxAlias: node.title || node.id,
        baseInstruct: node.config?.instruct ?? "You are a workflow agent.",
        maxCycleRun: 1,
        replayMode: "live",
        channelDeps: [ChannelKind.LLM_ACCESS]
      });
      boxDeps.set(boxId, [ChannelKind.LLM_ACCESS]);
      try {
        const s0 = performance.now();
        const out = await host.sandboxPool.get(boxId).runSingleCycle(`${node.config?.prompt ?? ""}\n${cycleInput}`.trim());
        const routed = host.routeChannel([ChannelKind.LLM_ACCESS], 10, 10_000) ?? ChannelKind.LLM_ACCESS;
        charge(task.id, boxId, routed, "chatRound");
        return { out: String(out), ms: Math.round(performance.now() - s0) };
      } finally {
        host.sandboxPool.remove(boxId);
        boxDeps.delete(boxId);
      }
    };

    try {
      while (queue.length > 0) {
        if (steps >= MAX_STEPS) throw new Error(`执行步数超过上限 ${MAX_STEPS}（疑似回流失控）`);
        if (task.abortRequested) {
          run.status = "aborted";
          break;
        }
        steps += 1;
        const { nodeId, input: nodeInput, viaLoop } = queue.shift();
        const node = nodesById.get(nodeId);
        const visited = visits.get(nodeId) ?? 0;
        if (viaLoop && visited >= MAX_VISITS) {
          log(nodeId, "done", `迭代上限（${MAX_VISITS} 次），回流截断`);
          continue;
        }
        visits.set(nodeId, visited + 1);

        if (node.type === "start") {
          log(nodeId, "done", `输入：「${nodeInput.slice(0, 40)}」`);
        } else if (node.type === "agent") {
          log(nodeId, "running", visited > 0 ? `第 ${visited + 1} 次进入（迭代）` : "");
          const { out, ms } = await spawnCycle(node, nodeInput);
          lastOutput = out;
          log(nodeId, visited > 0 ? "iterate" : "done", out.slice(0, 120), ms);
        } else if (node.type === "tool") {
          const toolName = node.config?.toolName;
          log(nodeId, "running", toolName ?? "");
          if (!toolName) throw new Error(`工具节点 ${node.id}（${node.title}）未配置 toolName`);
          if (!host.paeRegistry.listTools().some((t) => t.name === toolName)) {
            throw new Error(`工具节点引用了未接驳的工具「${toolName}」——请先在接驳工作台注册`);
          }
          let toolArgs = [nodeInput];
          if (typeof node.config?.argsJson === "string" && node.config.argsJson.trim() !== "") {
            try {
              toolArgs = [JSON.parse(node.config.argsJson)];
            } catch {
              throw new Error(`工具节点 ${node.id} 的 argsJson 不是合法 JSON`);
            }
          }
          const out = await host.gateway.capabilityInvoke({
            kind: ChannelKind.PAE_TOOL,
            funcName: toolName,
            args: toolArgs,
            mode: "live",
            ctx: { rng: new SeededRng(paeSeed++), clock: { now: () => Date.now() } }
          });
          charge(task.id, null, ChannelKind.PAE_TOOL, toolName);
          lastOutput = String(out);
          log(nodeId, "done", lastOutput.slice(0, 120));
        } else if (node.type === "branch") {
          const next = evalBranch(node, wf.edges, lastOutput);
          const chosen = wf.edges.find((e) => e.from === nodeId && e.to === next);
          const cond = (node.config?.conditions ?? []).find((c) => c.to === next);
          log(nodeId, "done", `命中「${cond?.match || "默认"}」 → ${nodesById.get(next)?.title ?? next}`);
          if (next) queue.push({ nodeId: next, input: lastOutput, viaLoop: chosen?.kind === "loop" });
          continue;
        } else if (node.type === "end") {
          run.result = lastOutput;
          log(nodeId, "done", `收势输出：「${lastOutput.slice(0, 60)}」`);
          continue;
        }

        /* non-branch nodes: walk every outgoing edge, nodes-array order */
        for (const edge of wf.edges.filter((e) => e.from === nodeId)) {
          const target = nodesById.get(edge.to);
          if (!target) continue;
          queue.push({ nodeId: edge.to, input: lastOutput, viaLoop: edge.kind === "loop" });
        }
      }

      /* Derive per-node final states for the canvas. */
      for (const n of wf.nodes) {
        const entries = run.nodeLog.filter((l) => l.nodeId === n.id);
        if (entries.length === 0) run.nodeStates[n.id] = "idle";
        else if (entries.some((l) => l.status === "failed")) run.nodeStates[n.id] = "failed";
        else if (entries.some((l) => l.status === "iterate") || entries.length > 1) run.nodeStates[n.id] = "iterate";
        else run.nodeStates[n.id] = "done";
      }

      run.ms = Math.round(performance.now() - t0);
      run.endedAt = Date.now();
      if (run.status === "running") run.status = task.abortRequested ? "aborted" : "done";
      /* 迭代上限收敛（未显式到达终点）时，以最后一轮输出为结果——诚实但可用。 */
      if (run.result === null && lastOutput !== null) {
        run.result = lastOutput;
        run.convergedAtLimit = true;
      }
      task.result = { runId, nodes: run.nodeLog.length, result: run.result, ms: run.ms };
      finishTask(task, run.status === "failed" ? "failed" : run.status);
      audit("workflow.run", runId, `${wf.name} · ${run.nodeLog.length} 步 · ${run.ms}ms`, run.status === "done" ? "ok" : "warn", "workflow");
      return run;
    } catch (err) {
      run.status = "failed";
      run.error = String(err?.message ?? err);
      run.ms = Math.round(performance.now() - t0);
      run.endedAt = Date.now();
      finishTask(task, "failed", err);
      audit("workflow.run", runId, `${wf.name} 失败：${run.error}`, "err", "workflow");
      throw err;
    }
  },

  workflowRunDetail(runId) {
    const run = workflowRuns.get(runId);
    if (!run) throw new Error(`workflow run ${runId} not found`);
    return run;
  },

  /* ---- billing / audit / notifications / dashboard ---- */

  async billing() {
    await ensureRunning();
    const total = ledger.reduce((a, e) => a + e.units, 0);
    return { ...deriveBilling(ledger, { balance: SPARK_GRANT - total }), grant: SPARK_GRANT };
  },

  auditEvents(query = {}) {
    return auditList(query);
  },

  /* 零依赖生成合法多页 PDF（Helvetica/WinAnsi；非 ASCII 折叠为 '?'）。
     仅用于审计导出，不引入任何第三方库。 */
  pdfText(s) {
    return String(s ?? "").replace(/[^\x20-\x7E]/g, "?").replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  },
  buildPdf(textLines) {
    const pageH = 842, perPage = 50;
    const pages = [];
    for (let i = 0; i < textLines.length; i += perPage) pages.push(textLines.slice(i, i + perPage));
    if (pages.length === 0) pages.push([""]);

    const objs = {};
    const fontObj = 3;
    objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
    objs[fontObj] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
    let next = fontObj + 1;
    const pageObjNums = [], contentObjNums = [];
    for (let p = 0; p < pages.length; p++) { pageObjNums.push(next++); contentObjNums.push(next++); }
    objs[2] = `<< /Type /Pages /Kids [${pageObjNums.map((n) => `${n} 0 R`).join(" ")}] /Count ${pages.length} >>`;

    for (let p = 0; p < pages.length; p++) {
      const ops = [];
      let y = pageH - 50;
      for (const ln of pages[p]) { ops.push(`BT /F1 11 Tf 50 ${y} Td (${this.pdfText(ln)}) Tj ET`); y -= 15; }
      const stream = ops.join("\n");
      objs[pageObjNums[p]] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${fontObj} 0 R >> >> /Contents ${contentObjNums[p]} 0 R >>`;
      objs[contentObjNums[p]] = `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`;
    }

    const maxObj = next - 1;
    let pdf = "%PDF-1.4\n";
    const offsets = {};
    for (let i = 1; i <= maxObj; i++) {
      const seg = `${i} 0 obj\n${objs[i]}\nendobj\n`;
      offsets[i] = Buffer.byteLength(pdf);
      pdf += seg;
    }
    const xrefStart = Buffer.byteLength(pdf);
    let xref = `xref\n0 ${maxObj + 1}\n0000000000 65535 f \n`;
    for (let i = 1; i <= maxObj; i++) xref += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
    pdf += xref + `trailer\n<< /Size ${maxObj + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
    return pdf;
  },

  auditExport(format = "md", params = {}) {
    const events = auditList(params);
    const generatedAt = new Date().toISOString();
    if (format === "json") {
      const content = JSON.stringify({ generatedAt, actor: currentActor(), count: events.length, events }, null, 2);
      audit("audit.export", "json", `导出 ${events.length} 条事件`);
      return { format: "json", filename: `orbit-audit-${generatedAt.slice(0, 10)}.json`, mime: "application/json", content };
    }
    if (format === "pdf") {
      const lines = [
        "Orbit 事件审计报告",
        `生成时间: ${generatedAt}`,
        `操作者: ${currentActor()}`,
        `事件数: ${events.length}`,
        ""
      ];
      for (const e of events) {
        const t = new Date(e.ts).toISOString().replace("T", " ").slice(0, 19);
        lines.push(`[${t}] ${e.actor ?? "-"} ${e.action ?? "-"} ${e.target ?? "-"} (${e.level ?? "-"}) ${e.detail ?? ""}`);
      }
      audit("audit.export", "pdf", `导出 ${events.length} 条事件`);
      return { format: "pdf", filename: `orbit-audit-${generatedAt.slice(0, 10)}.pdf`, mime: "application/pdf", content: this.buildPdf(lines) };
    }
    const esc_ = (s) => String(s ?? "").replace(/\|/g, "\\|");
    const lines = [
      "# Orbit 事件审计报告",
      "",
      `- 生成时间：${generatedAt}`,
      `- 操作者：${currentActor()}`,
      `- 事件数：${events.length}`,
      "",
      "| 时间 | 操作者 | 动作 | 对象 | 级别 | 详情 |",
      "| --- | --- | --- | --- | --- | --- |"
    ];
    for (const e of events) {
      const t = new Date(e.ts).toISOString().replace("T", " ").slice(0, 19);
      lines.push(`| ${t} | ${esc_(e.actor)} | ${esc_(e.action)} | ${esc_(e.target)} | ${esc_(e.level)} | ${esc_(e.detail)} |`);
    }
    audit("audit.export", "md", `导出 ${events.length} 条事件`);
    return { format: "md", filename: `orbit-audit-${generatedAt.slice(0, 10)}.md`, mime: "text/markdown", content: lines.join("\n") };
  },

  notifications(sess) {
    const readIds = notifyRead.get(sess.account);
    return deriveNotifications(notifyEvents(), { readIds: readIds ? [...readIds] : [] });
  },

  notificationsRead(sess, body) {
    if (!Array.isArray(body?.ids)) throw new Error("ids（数组）required");
    let set = notifyRead.get(sess.account);
    if (!set) {
      set = new Set();
      notifyRead.set(sess.account, set);
    }
    for (const id of body.ids) set.add(String(id));
    return this.notifications(sess);
  },

  async dashboard() {
    await ensureRunning();
    const state = await this.state();
    const billingData = await this.billing();
    const byStatus = {};
    for (const t of taskRegistry.values()) byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
    const docCount = [...kbs.values()].reduce((a, kb) => a + kb.docs.length, 0);
    return {
      running,
      version: KERNEL_VERSION,
      uptimeSec: Math.round(process.uptime()),
      boxes: state.sandboxes,
      channels: state.channels,
      plugins: state.plugins,
      pae: state.pae,
      traceCount: state.traceCount,
      recentTrace: state.trace,
      runCounter,
      tasks: { total: taskRegistry.size, byStatus, recent: taskList({ limit: 6 }) },
      billing: billingData,
      systemIssues: deriveSystemHealth(state),
      nextSteps: suggestNextSteps(state),
      counts: { templates: templates.size, kbs: kbs.size, docs: docCount, workflows: workflows.size }
    };
  }
};

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function pluginList() {
  return [...pluginRegistry.values()].map((p) => ({
    id: p.id,
    displayName: p.displayName,
    edition: p.edition,
    requireHostMinEdition: p.requireHostMinEdition,
    allowCapabilities: p.allowCapabilities,
    declareChannelDeps: p.declareChannelDeps ?? [],
    registeredAt: p.registeredAt
  }));
}

function listSandboxes() {
  return host.sandboxPool.listSandboxIds().map((id) => {
    const box = host.sandboxPool.get(id);
    if (!box) return { agentBoxId: id, missing: true };
    return {
      agentBoxId: box.agentBoxId,
      boxAlias: box.boxAlias,
      baseInstruct: box.baseInstruct,
      maxCycleRun: box.maxCycleRun,
      cycleNow: box.cycleCountNow()
    };
  });
}

/* ------------------------------------------------------------------ */
/* Router                                                              */
/* ------------------------------------------------------------------ */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".map": "application/json"
};

async function serveStatic(urlPath, res) {
  const safe = normalize(urlPath).replace(/^(\.\.[/\\])+/, "");
  let filePath = join(PUBLIC_DIR, safe);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }
  try {
    if (urlPath === "/" || urlPath === "") filePath = join(PUBLIC_DIR, "index.html");
    const data = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": MIME[extname(filePath)] ?? "application/octet-stream",
      "Cache-Control": "no-store"
    });
    res.end(data);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("not found");
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
  const path = url.pathname;
  const method = req.method ?? "GET";
  const t0 = performance.now();
  res.on("finish", () => {
    console.log(`  ${method.padEnd(6)} ${path} -> ${res.statusCode} (${Math.round(performance.now() - t0)}ms)`);
  });

  try {
    if (path.startsWith("/api/")) {
      const seg = path.slice(5).split("/").filter(Boolean); // e.g. ["boxes","box.1","run"]
      const query = Object.fromEntries(url.searchParams);

      /* ---- session gate ------------------------------------------------
       * Only /api/auth/* and /api/health are open. Everything else needs a
       * Bearer token. (Direct `api.*` calls from the test suite bypass this
       * gate by design — the gate guards the wire, not the object.) */
      const auth = String(req.headers.authorization ?? "");
      const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
      const session = token ? sessions.get(token) : undefined;
      const isPublic = seg[0] === "auth" || seg[0] === "health";
      if (!isPublic && !session) return fail(res, "未登录或会话已过期", 401);
      if (token && !session && seg[0] === "auth" && (seg[1] === "me" || seg[1] === "logout" || seg[1] === "password")) {
        return fail(res, "未登录或会话已过期", 401);
      }

      const notFound = () => {
        const err = new Error(`no such api: ${method} ${path}`);
        err.status = 404;
        throw err;
      };
      const needSession = () => {
        if (!session) {
          const err = new Error("未登录或会话已过期");
          err.status = 401;
          throw err;
        }
        return session;
      };

      const dispatch = async () => {
        /* ---- auth ---- */
        if (seg[0] === "auth") {
          if (method === "POST" && seg[1] === "register") return api.authRegister(await readBody(req));
          if (method === "POST" && seg[1] === "login") return api.authLogin(await readBody(req));
          if (method === "GET" && seg[1] === "me" && seg.length === 2) return api.authMe(needSession());
          if (method === "POST" && seg[1] === "logout" && seg.length === 2) return api.authLogout(needSession());
          if (method === "POST" && seg[1] === "password" && seg.length === 2) return api.authPassword(needSession(), await readBody(req));
          notFound();
        }

        /* ---- state & lifecycle ---- */
        if (method === "GET" && seg[0] === "health") return api.health();
        if (method === "GET" && seg[0] === "state") return api.state();
        if (method === "POST" && seg[0] === "host" && seg[1] === "boot") return api.boot();
        if (method === "POST" && seg[0] === "host" && seg[1] === "shutdown") return api.shutdown();

        /* ---- channels ---- */
        if (method === "GET" && seg[0] === "channels" && seg.length === 1) return api.channels();
        if (method === "POST" && seg[0] === "channels" && seg[1] === "plugin" && seg[2] === "remove")
          return api.removePluginChannel(await readBody(req));
        if (method === "POST" && seg[0] === "channels" && seg[1] === "plugin" && seg.length === 2)
          return api.registerPluginChannel(await readBody(req));
        if (method === "POST" && seg[0] === "channels" && seg[1] === "deepseek" && seg[2] === "remove")
          return api.removeDeepSeekChannel();
        if (method === "POST" && seg[0] === "channels" && seg[1] === "deepseek" && seg.length === 2)
          return api.registerDeepSeekChannel(await readBody(req));

        /* ---- plugins ---- */
        if (method === "GET" && seg[0] === "plugins" && seg.length === 1) return api.plugins();
        if (method === "POST" && seg[0] === "plugins" && seg.length === 1) return api.registerPlugin(await readBody(req));
        if (method === "DELETE" && seg[0] === "plugins" && seg.length === 1) return api.resetPlugins();

        /* ---- sandboxes ---- */
        if (method === "GET" && seg[0] === "boxes" && seg.length === 1) return api.boxes();
        if (method === "POST" && seg[0] === "boxes" && seg.length === 1) return api.spawnBox(await readBody(req));
        if (method === "POST" && seg[0] === "boxes" && seg[1] && seg[2] === "run")
          return api.runBox(decodeURIComponent(seg[1]), await readBody(req));
        if (method === "POST" && seg[0] === "boxes" && seg[1] && seg[2] === "reset")
          return api.resetBox(decodeURIComponent(seg[1]));
        if (method === "DELETE" && seg[0] === "boxes" && seg[1])
          return api.removeBox(decodeURIComponent(seg[1]));

        /* ---- trace / replay / graph / routing ---- */
        if (method === "GET" && seg[0] === "trace") return api.trace(query);
        if (method === "POST" && seg[0] === "replay" && seg[1] === "demo") return api.replayDemo();
        if (method === "GET" && seg[0] === "graph" && seg.length === 1) return api.graph();
        if (method === "GET" && seg[0] === "graph" && seg[1] === "isolation")
          return api.isolation(decodeURIComponent(query.node ?? ""));
        if (method === "POST" && seg[0] === "graph" && seg[1] === "check") return api.checkIsolation(await readBody(req));
        if (method === "GET" && seg[0] === "routing" && seg[1] === "profiles") return api.routingProfiles();
        if (method === "POST" && seg[0] === "routing" && seg[1] === "simulate") return api.simulateRoute(await readBody(req));

        /* ---- PAE ---- */
        if (method === "GET" && seg[0] === "pae" && seg.length === 1) return api.pae();
        if (method === "POST" && seg[0] === "pae" && seg.length === 1) return api.registerPae(await readBody(req));
        if (method === "POST" && seg[0] === "pae" && seg[1] === "invoke" && seg.length === 2) return api.invokePae(await readBody(req));
        if (method === "POST" && seg[0] === "pae" && seg[1] === "negotiate" && seg.length === 2) return api.negotiatePae(await readBody(req));
        if (method === "DELETE" && seg[0] === "pae" && seg[1]) return api.removePae(decodeURIComponent(seg[1]));

        /* ---- tasks ---- */
        if (method === "GET" && seg[0] === "tasks" && seg.length === 1) return api.tasks(query);
        if (method === "GET" && seg[0] === "tasks" && seg[1] && seg.length === 2) return api.task(decodeURIComponent(seg[1]));
        if (method === "POST" && seg[0] === "tasks" && seg[1] && seg[2] === "abort")
          return api.abortTask(decodeURIComponent(seg[1]));

        /* ---- templates ---- */
        if (method === "GET" && seg[0] === "templates" && seg.length === 1) return api.templates();
        if (method === "POST" && seg[0] === "templates" && seg.length === 1) return api.saveTemplate(await readBody(req));
        if (method === "GET" && seg[0] === "templates" && seg[1] && seg[2] === "versions")
          return api.templateVersions(decodeURIComponent(seg[1]));
        if (method === "POST" && seg[0] === "templates" && seg[1] && seg[2] === "rollback")
          return api.rollbackTemplate(decodeURIComponent(seg[1]), await readBody(req));
        if (method === "DELETE" && seg[0] === "templates" && seg[1])
          return api.removeTemplate(decodeURIComponent(seg[1]));

        /* ---- knowledge bases ---- */
        if (method === "GET" && seg[0] === "kb" && seg.length === 1) return api.kbList();
        if (method === "POST" && seg[0] === "kb" && seg.length === 1) return api.kbCreate(await readBody(req));
        if (method === "DELETE" && seg[0] === "kb" && seg[1]) return api.kbRemove(decodeURIComponent(seg[1]));
        if (method === "POST" && seg[0] === "kb" && seg[1] && seg[2] === "docs")
          return api.kbUpload(decodeURIComponent(seg[1]), await readBody(req));
        if (method === "GET" && seg[0] === "kb" && seg[1] && seg[2] === "docs" && seg[3])
          return api.kbDoc(decodeURIComponent(seg[1]), decodeURIComponent(seg[3]));
        if (method === "POST" && seg[0] === "kb" && seg[1] && seg[2] === "search")
          return api.kbSearch(decodeURIComponent(seg[1]), await readBody(req));
        if (method === "GET" && seg[0] === "kb" && seg[1] && seg.length === 2)
          return api.kbDetail(decodeURIComponent(seg[1]));

        /* ---- RAG ---- */
        if (method === "GET" && seg[0] === "rag" && seg.length === 1) return api.ragRuns(query.kb);
        if (method === "POST" && seg[0] === "rag" && seg.length === 1) return api.ragRun(await readBody(req));
        if (method === "GET" && seg[0] === "rag" && seg[1]) return api.ragDetail(decodeURIComponent(seg[1]));

        /* ---- workflows ---- */
        if (method === "GET" && seg[0] === "workflows" && seg.length === 1) return api.workflows();
        if (method === "POST" && seg[0] === "workflows" && seg.length === 1) return api.workflowSave(await readBody(req));
        if (method === "DELETE" && seg[0] === "workflows" && seg[1]) return api.workflowRemove(decodeURIComponent(seg[1]));
        if (method === "POST" && seg[0] === "workflows" && seg[1] && seg[2] === "run")
          return api.workflowRun(decodeURIComponent(seg[1]), await readBody(req));
        if (method === "GET" && seg[0] === "workflows" && seg[1] && seg.length === 2)
          return api.workflowGet(decodeURIComponent(seg[1]));
        if (method === "GET" && seg[0] === "workflow-runs" && seg[1])
          return api.workflowRunDetail(decodeURIComponent(seg[1]));

        /* ---- billing / audit / notifications / dashboard ---- */
        if (method === "GET" && seg[0] === "billing") return api.billing();
        if (method === "GET" && seg[0] === "audit" && seg[1] === "export")
          return api.auditExport(String(query.format ?? "md"), query);
        if (method === "GET" && seg[0] === "audit" && seg.length === 1) return api.auditEvents(query);
        if (method === "GET" && seg[0] === "notifications" && seg.length === 1) return api.notifications(needSession());
        if (method === "POST" && seg[0] === "notifications" && seg[1] === "read")
          return api.notificationsRead(needSession(), await readBody(req));
        if (method === "GET" && seg[0] === "dashboard") return api.dashboard();

        notFound();
      };

      /* Actor attribution rides the async context so audit entries stay
         correct even when requests interleave at await points. */
      const data = await actorCtx.run({ actor: session?.account ?? "anonymous" }, dispatch);
      return ok(res, data);
    }

    if (method === "GET") return serveStatic(path, res);
    res.writeHead(405);
    res.end("method not allowed");
  } catch (err) {
    const msg = String(err?.message ?? err);
    const userError = /not found|required|lacks|too low|reached|failed|already|unsupported|invalid|已存在|不存在|需要|至少|不正确|为空|未通过|上限|无法|不能|非.*合法/.test(msg);
    const status = err?.status ?? (userError ? 400 : 500);
    fail(res, msg, status);
  }
});

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

async function start() {
  await ensureRunning();
  server.listen(PORT, HOST, () => {
    console.log("");
    console.log("  ╔══════════════════════════════════════════════════╗");
    console.log("  ║   Orbit Agent Runtime · Console                   ║");
    console.log(`  ║   http://${HOST}:${PORT}                       ║`);
    console.log("  ╚══════════════════════════════════════════════════╝");
    console.log("");
    console.log(`  kernel booted · channels: ${channelRegistry.size} · static: ${PUBLIC_DIR}`);
    console.log("  seed account: admin / orbit-admin （首个账号即管理员）");
    console.log("");
  });
}

/* Export the bridge surface so the console's own test suite can drive a real
   host without spawning the HTTP server (importing this module must not boot). */
export { api, host };

/* Only auto-start when executed directly as `node web/bridge-server.mjs`.
   Under `node --test`, the module is imported — never started. */
const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  start().catch((err) => {
    console.error("failed to start bridge server:", err);
    process.exitCode = 1;
  });
}
