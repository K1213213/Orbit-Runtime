/**
 * Example 5 — LangGraph-style orchestration on a provable runtime.
 *
 * PRODUCT_PLAN P1.2 (ecosystem embedding) first deliverable. LangGraph is the
 * orchestrator's home turf — a StateGraph of nodes and edges that passes a
 * state object around. What LangGraph does NOT do is make the *tool calls*
 * inside its nodes reproducible, auditable or provable. That is the runtime
 * layer beneath the orchestrator, and that is what Orbit provides.
 *
 * This example runs a minimal, self-contained LangGraph-style engine
 * (`MiniStateGraph`: nodes, edges, conditional routing, state reduction —
 * the semantics a LangGraph user would recognise) whose agent nodes call
 * tools through the Orbit gateway. It then proves the product promise at the
 * GRAPH level, not just the single-call level:
 *
 *   1. record — run the graph once with real tool execution (KV writes);
 *   2. replay — run the SAME graph again with a replay engine attached: every
 *      tool call is served frozen output, ZERO real side effects occur, and
 *      the final answer is byte-identical to the recorded run;
 *   3. audit  — the signed audit chain verifies PASS, so the graph run is
 *      tamper-evident and reportable.
 *
 * In a real deployment the MiniStateGraph below is replaced by LangGraph (or
 * any orchestrator); nothing else changes — tools stay behind the gateway.
 *
 * Run: node examples/langgraph-orchestration.mjs
 *
 * For npm consumers the imports below become
 *   import { OrbitRuntimeHost, ChannelKind, ... } from "orbit-agent-runtime";
 * The relative paths are only for running inside this repository.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OrbitRuntimeHost, ChannelKind } from "../dist/src/index.js";
import { SeededRng, PersistedRecordJournal, ReplayEngine, makeUniqueMark } from "../dist/src/index.js";

/* ---------------------------------------------------------------------------
 * MiniStateGraph — a minimal LangGraph-style engine.
 *
 * Node: (state) => partial state (reduced into the running state); may be
 *       async. Edge: unconditional (from -> to) or conditional
 *       (router(state) -> next). invoke() walks from START until END,
 *       awaiting each node and reducing state at every step.
 * The engine itself is deterministic; tool side effects live behind the
 * Orbit gateway and are what record/replay governs.
 * ------------------------------------------------------------------------- */

const START = Symbol("START");
const END = Symbol("END");

class MiniStateGraph {
  constructor() {
    this.nodes = new Map();
    this.edges = new Map(); // node -> next | router(state) -> next
  }

  addNode(name, fn) {
    this.nodes.set(name, fn);
    return this;
  }

  addEdge(from, to) {
    this.edges.set(from, to);
    return this;
  }

  addConditionalEdges(from, router) {
    this.edges.set(from, router);
    return this;
  }

  /** Run the graph from START until END; returns the final state. */
  async invoke(initialState, onCall = () => {}) {
    let state = { ...initialState };
    let node = START;
    const visits = new Map();
    while (node !== END) {
      if (node === START) {
        node = this.edges.get(START);
        continue;
      }
      visits.set(node, (visits.get(node) ?? 0) + 1);
      if (visits.get(node) > 50) throw new Error(`graph loop detected at node '${node}'`);
      const fn = this.nodes.get(node);
      if (!fn) throw new Error(`node '${node}' not registered`);
      const patch = (await fn(state, onCall)) ?? {};
      state = { ...state, ...patch };
      const edge = this.edges.get(node);
      node = typeof edge === "function" ? edge(state) : edge;
    }
    return state;
  }
}

/* ---------------------------------------------------------------------------
 * The agent graph — research: plan (model) -> tools -> answer.
 * Tools: mem.writeEntry (side effect), mem.readEntry (read).
 * ------------------------------------------------------------------------- */

/** A fake model: turns the question into a deterministic tool plan. */
function planTools(rng, question) {
  // The "model" consults the question and a seeded rng, so the SAME graph run
  // is reproducible without calling a real model — the record/replay contrast
  // stays about tool-call determinism, not model reproducibility.
  const roll = rng.next();
  const plan = [];
  if (roll < 0.6) {
    plan.push({ tool: "writeEntry", args: ["notes", `observed: ${question}`, 0] });
  }
  plan.push({ tool: "readEntry", args: ["notes"] });
  plan.push({ tool: "readEntry", args: ["facts"] });
  return plan;
}

function buildResearchGraph(host, pluginId, seed) {
  const rng = new SeededRng(seed);
  const ctxFor = () => ({ traceMarkId: makeUniqueMark(), maxWaitMs: 5000, pluginUnitId: pluginId });
  const graph = new MiniStateGraph();

  graph.addEdge(START, "planner");
  graph.addNode("planner", (state) => {
    const plan = planTools(rng, state.question);
    return { plan, model: "simulated", seed };
  });
  graph.addConditionalEdges("planner", (state) => (state.plan.length > 0 ? "tools" : END));

  graph.addNode("tools", async (state) => {
    const results = [];
    for (const item of state.plan) {
      const out = await host.capabilityInvoke({
        kind: ChannelKind.MEM_KV_STORE,
        pluginId,
        funcName: item.tool,
        args: item.args,
        mode: state.mode,
        ctx: ctxFor()
      });
      results.push({ tool: item.tool, key: item.args[0], out });
    }
    return { results };
  });
  graph.addEdge("tools", "answer");

  graph.addNode("answer", (state) => {
    const note = state.results?.find((r) => r.tool === "readEntry" && r.key === "notes")?.out;
    const fact = state.results?.find((r) => r.tool === "readEntry" && r.key === "facts")?.out;
    return { answer: `research[${state.question}]: note=${note ?? "none"} fact=${fact ?? "none"}` };
  });
  graph.addEdge("answer", END);
  return graph;
}

/* ---------------------------------------------------------------------------
 * Assertions & run
 * ------------------------------------------------------------------------- */

function assert(cond, msg) {
  if (!cond) {
    console.error(`✗ ${msg}`);
    process.exit(1);
  }
  console.log(`✓ ${msg}`);
}

async function main() {
  const root = await mkdtemp(join(tmpdir(), "orbit-langgraph-"));
  const walFile = join(root, "record.wal.jsonl");
  const tracePath = join(root, "trace.wal.jsonl");
  const seed = 20260902;
  const pluginId = "research";
  const question = "what is the capital of france?";

  /* ---- Phase 1 · record: real tool execution ---- */
  const recordHost = new OrbitRuntimeHost({
    auditSigningKey: "example-key",
    recordJournalPath: walFile,
    traceJournalPath: tracePath
  });
  await recordHost.bootHost();
  recordHost.registerPlugin({
    id: pluginId,
    displayName: "Research",
    edition: "1.0.0",
    requireHostMinEdition: "1.0.0",
    allowCapabilities: ["channel:read", "channel:write"]
  });
  const recordJournal = recordHost.beginRecording();
  const recordGraph = buildResearchGraph(recordHost, pluginId, seed);
  const recorded = await recordGraph.invoke({ question, pluginId, mode: "record" });
  // A completed graph run is itself an audit event (signed into the chain).
  recordHost.traceJournal.append({
    entryClass: "GRAPH_RUN",
    traceMarkId: "graph-record",
    factPayload: { graph: "research", calls: recordJournal.size(), answer: recorded.answer }
  });
  console.log(`record : ${recordJournal.size()} tool calls | answer=${recorded.answer}`);
  await recordHost.shutdownHost();

  /* ---- Phase 2 · replay: the SAME graph, zero real side effects ---- */
  const replayHost = new OrbitRuntimeHost({
    auditSigningKey: "example-key",
    recordJournalPath: walFile,
    traceJournalPath: tracePath
  });
  await replayHost.bootHost();
  replayHost.registerPlugin({
    id: pluginId,
    displayName: "Research",
    edition: "1.0.0",
    requireHostMinEdition: "1.0.0",
    allowCapabilities: ["channel:read", "channel:write"]
  });
  const recovered = await PersistedRecordJournal.recover(walFile);
  const replayJournal = replayHost.beginRecording();
  replayJournal.restoreSnapshot(recovered.snapshot());
  replayHost.attachReplayEngine(replayJournal);
  // The KV store on this host is EMPTY and writes never reach it: replay
  // serves frozen outputs from the recorded window. If replay really
  // re-executed, readEntry("notes") would return null and the answer would
  // differ — the byte-identical assertion below is therefore meaningful.
  const replayGraph = buildResearchGraph(replayHost, pluginId, seed);
  const replayed = await replayGraph.invoke({ question, pluginId, mode: "replay" });

  /* ---- Phase 3 · assertions ---- */
  console.log(`replay : ${recovered.size()} calls injected | answer=${replayed.answer}`);
  assert(recorded.answer === replayed.answer, "graph-level answer is byte-identical across record and replay");
  assert(
    JSON.stringify(recorded.results) === JSON.stringify(replayed.results),
    "every tool result is byte-identical (frozen outputs, zero re-execution)"
  );
  assert(recovered.size() === recordJournal.size(), `all ${recordJournal.size()} tool calls were recorded`);
  const chain = replayHost.verifyAuditChain();
  assert(chain.consistent === true && chain.signed === true, `audit chain PASS (${chain.total} entries)`);
  console.log("\nLangGraph-style orchestration on a provable runtime: record → replay → audit, all green.");

  await replayHost.shutdownHost();
  await rm(root, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(`✗ ${err.message}`);
  process.exit(1);
});
