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
import { createHash } from "node:crypto";
import { JsPaeAdapter } from "../dist/src/pae/adapters/JsPaeAdapter.js";
import { SeededRng } from "../dist/src/replay/injectors.js";
import { PAE_TEMPLATES, describePaeTool } from "./public/lib.js";
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
    return { kind: "llm-access", type: "builtin" };
  },

  /* ---- plugins ---- */

  async registerPlugin(body) {
    await ensureRunning();
    const pact = body?.pact;
    if (!pact) throw new Error("pact required");
    host.registerPlugin(pact);
    pluginRegistry.set(pact.id, { ...pact, registeredAt: Date.now() });
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
    return listSandboxes();
  },

  async boxes() {
    await ensureRunning();
    return listSandboxes();
  },

  async runBox(boxId, body) {
    await ensureRunning();
    const box = host.sandboxPool.get(boxId);
    if (!box) throw new Error(`sandbox ${boxId} not found`);
    const input = body?.input ?? "";
    runCounter += 1;
    const output = await box.runSingleCycle(input);
    return {
      agentBoxId: box.agentBoxId,
      output,
      cycleNow: box.cycleCountNow(),
      maxCycle: box.maxCycleRun
    };
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
    const argText = String(body?.argText ?? "");
    let args;
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
    return this.pae();
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

      if (method === "GET" && seg[0] === "health") return ok(res, await api.health());
      if (method === "GET" && seg[0] === "state") return ok(res, await api.state());
      if (method === "POST" && seg[0] === "host" && seg[1] === "boot") return ok(res, await api.boot());
      if (method === "POST" && seg[0] === "host" && seg[1] === "shutdown") return ok(res, await api.shutdown());

      if (method === "GET" && seg[0] === "channels") return ok(res, await api.channels());
      if (method === "POST" && seg[0] === "channels" && seg[1] === "plugin" && seg[2] === "remove")
        return ok(res, await api.removePluginChannel(await readBody(req)));
      if (method === "POST" && seg[0] === "channels" && seg[1] === "plugin" && seg.length === 2)
        return ok(res, await api.registerPluginChannel(await readBody(req)));
      if (method === "POST" && seg[0] === "channels" && seg[1] === "deepseek" && seg[2] === "remove")
        return ok(res, await api.removeDeepSeekChannel());
      if (method === "POST" && seg[0] === "channels" && seg[1] === "deepseek" && seg.length === 2)
        return ok(res, await api.registerDeepSeekChannel(await readBody(req)));

      if (method === "GET" && seg[0] === "plugins") return ok(res, await api.plugins());
      if (method === "POST" && seg[0] === "plugins") return ok(res, await api.registerPlugin(await readBody(req)));
      if (method === "DELETE" && seg[0] === "plugins") return ok(res, await api.resetPlugins());

      if (method === "GET" && seg[0] === "boxes" && seg.length === 1) return ok(res, await api.boxes());
      if (method === "POST" && seg[0] === "boxes" && seg.length === 1) return ok(res, await api.spawnBox(await readBody(req)));
      if (method === "POST" && seg[0] === "boxes" && seg[1] && seg[2] === "run")
        return ok(res, await api.runBox(decodeURIComponent(seg[1]), await readBody(req)));
      if (method === "POST" && seg[0] === "boxes" && seg[1] && seg[2] === "reset")
        return ok(res, await api.resetBox(decodeURIComponent(seg[1])));
      if (method === "DELETE" && seg[0] === "boxes" && seg[1])
        return ok(res, await api.removeBox(decodeURIComponent(seg[1])));

      if (method === "GET" && seg[0] === "trace") {
        return ok(res, await api.trace(Object.fromEntries(url.searchParams)));
      }

      if (method === "POST" && seg[0] === "replay" && seg[1] === "demo") return ok(res, await api.replayDemo());

      if (method === "GET" && seg[0] === "graph" && seg.length === 1) return ok(res, await api.graph());
      if (method === "GET" && seg[0] === "graph" && seg[1] === "isolation")
        return ok(res, await api.isolation(decodeURIComponent(url.searchParams.get("node") ?? "")));
      if (method === "POST" && seg[0] === "graph" && seg[1] === "check")
        return ok(res, await api.checkIsolation(await readBody(req)));

      if (method === "GET" && seg[0] === "routing" && seg[1] === "profiles") return ok(res, await api.routingProfiles());
      if (method === "POST" && seg[0] === "routing" && seg[1] === "simulate")
        return ok(res, await api.simulateRoute(await readBody(req)));

      if (method === "GET" && seg[0] === "pae" && seg.length === 1) return ok(res, await api.pae());
      if (method === "POST" && seg[0] === "pae" && seg.length === 1) return ok(res, await api.registerPae(await readBody(req)));
      if (method === "POST" && seg[0] === "pae" && seg[1] === "invoke" && seg.length === 2) return ok(res, await api.invokePae(await readBody(req)));
      if (method === "POST" && seg[0] === "pae" && seg[1] === "negotiate" && seg.length === 2) return ok(res, await api.negotiatePae(await readBody(req)));
      if (method === "DELETE" && seg[0] === "pae" && seg[1]) return ok(res, await api.removePae(decodeURIComponent(seg[1])));

      return fail(res, `no such api: ${method} ${path}`, 404);
    }

    if (method === "GET") return serveStatic(path, res);
    res.writeHead(405);
    res.end("method not allowed");
  } catch (err) {
    const status = /not found|required|lacks|too low|reached|failed|already|unsupported|invalid/.test(String(err?.message)) ? 400 : 500;
    fail(res, err?.message ?? String(err), status);
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
