import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DOMAIN_HOST_SHIM,
  ChannelHub,
  ChannelKind,
  ChildProcessDomainTransport,
  DomainChannel,
  DomainRemoteError,
  DomainUnitMissingError,
  ImpactDomainGraph,
  InMemoryDomainTransport,
  IsolationDomain,
  IsolationDomainManager,
  allocateDomains,
  decodeDomainFrame,
  encodeDomainFrame,
  impactClosureSizes,
  isDomainResponse,
  normaliseDomainResult,
  parseUnitList,
  domainRemoteErrorOf
} from "../src/index";
import type { DomainInvokeCtx } from "../src/index";

/**
 * W19 — isolation domain suite (graph-driven L2 allocation).
 *
 * Four layers under test:
 *
 * 1. **allocation** — the pure graph → plan mapping: impact-closure escalation,
 *    deterministic shared packing, and the auto-escalate-on-growth property;
 * 2. **protocol** — pure framing and unit-list parsing;
 * 3. **transport** — in-memory and real `node` child processes (the built-in
 *    pure-unit host), so L2 is exercised without hand-rolled subprocess code;
 * 4. **domain + manager + channel** — lifecycle, sync diff (start/keep/stop),
 *    routing, and the gateway surface that makes domain calls recorded and
 *    replayed like any other IO_BOUND call.
 */

const CTX: DomainInvokeCtx = { traceMarkId: "tm-domain", maxWaitMs: 1000 };

/** A graph where `dependent` depends on `dependency`. */
function chain(...ids: string[]): ImpactDomainGraph {
  const g = new ImpactDomainGraph();
  for (const id of ids) g.addNode(id);
  for (let i = 1; i < ids.length; i += 1) {
    g.addEdge(ids[i - 1], ids[i]); // earlier depends on later
  }
  return g;
}

// ---------------------------------------------------------------------------
// Allocation (pure)
// ---------------------------------------------------------------------------

test("domain allocation: independent leaves share one domain", () => {
  const g = new ImpactDomainGraph();
  g.addNode("a");
  g.addNode("b");
  g.addNode("c");
  const plan = allocateDomains(g);
  assert.deepEqual(plan.domains, [{ id: "shared:0", isolation: "L2", units: ["a", "b", "c"] }]);
  assert.deepEqual(plan.escalated, []);
});

test("domain allocation: a large impact closure escalates to its own domain", () => {
  const g = chain("a", "b", "c"); // a→b→c: closure(c)={a,b}=2, closure(b)={a}=1
  const plan = allocateDomains(g);
  const iso = plan.domains.find((d) => d.id === "iso:c");
  assert.deepEqual(iso, { id: "iso:c", isolation: "L2", units: ["c"] });
  assert.ok(plan.escalated.includes("c"));
  // a and b are shareable and connected → one shared domain.
  const shared = plan.domains.find((d) => d.id.startsWith("shared:"));
  assert.deepEqual(shared?.units, ["a", "b"]);
});

test("domain allocation: closure sizes are the reverse-reachability counts", () => {
  const g = chain("a", "b", "c");
  const sizes = impactClosureSizes(g);
  assert.equal(sizes.get("a"), 0);
  assert.equal(sizes.get("b"), 1);
  assert.equal(sizes.get("c"), 2);
});

test("domain allocation: a growing graph auto-escalates a previously shared node", () => {
  const g = new ImpactDomainGraph();
  g.addNode("x");
  g.addNode("y");
  g.addNode("z");
  const before = allocateDomains(g);
  assert.deepEqual(before.escalated, []);
  // z gains two dependents → closure size 2 > 1 → escalated on the next plan.
  g.addEdge("x", "z");
  g.addEdge("y", "z");
  const after = allocateDomains(g);
  assert.deepEqual(after.escalated, ["z"]);
  assert.ok(after.domains.some((d) => d.id === "iso:z"));
});

test("domain allocation: shared domains chunk to maxDomainSize", () => {
  const g = new ImpactDomainGraph();
  for (const id of ["a", "b", "c", "d", "e"]) g.addNode(id);
  const plan = allocateDomains(g, { maxDomainSize: 2 });
  assert.deepEqual(
    plan.domains.map((d) => d.units),
    [["a", "b"], ["c", "d"], ["e"]]
  );
});

test("domain allocation: equal graphs always produce equal plans", () => {
  const g1 = chain("a", "b", "c", "d");
  const g2 = chain("a", "b", "c", "d");
  assert.deepEqual(allocateDomains(g1), allocateDomains(g2));
});

test("domain allocation: the plan is a partition of every node", () => {
  const g = chain("a", "b", "c");
  g.addNode("solo");
  const plan = allocateDomains(g);
  const seen = new Set<string>();
  for (const d of plan.domains) {
    for (const unit of d.units) {
      assert.ok(!seen.has(unit), `unit ${unit} appears twice`);
      seen.add(unit);
    }
  }
  assert.deepEqual([...seen].sort(), ["a", "b", "c", "solo"]);
});

// ---------------------------------------------------------------------------
// Protocol
// ---------------------------------------------------------------------------

test("domain protocol: a message serialises to a single line", () => {
  const line = encodeDomainFrame({ jsonrpc: "2.0", id: 1, method: "units/list", params: {} });
  assert.ok(!line.includes("\n"));
  assert.deepEqual(JSON.parse(line), { jsonrpc: "2.0", id: 1, method: "units/list", params: {} });
});

test("domain protocol: unparseable and non-envelope lines are skipped, not fatal", () => {
  assert.equal(decodeDomainFrame(""), null);
  assert.equal(decodeDomainFrame("noise"), null);
  assert.equal(decodeDomainFrame(JSON.stringify({ jsonrpc: "2.0", id: 1 })), null, "neither result nor error");
  assert.equal(decodeDomainFrame(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1, error: { message: "x" } })), null);
  const ok = decodeDomainFrame(JSON.stringify({ jsonrpc: "2.0", id: 5, result: { units: [] } }));
  assert.deepEqual(ok, { jsonrpc: "2.0", id: 5, result: { units: [] } });
});

test("domain protocol: unit list validation rejects a malformed host", () => {
  assert.throws(() => parseUnitList(null), /not an object/);
  assert.throws(() => parseUnitList({ units: "nope" }), /not an array/);
  assert.throws(() => parseUnitList({ units: [{ id: "" }] }), /no usable unit id/);
  assert.throws(() => parseUnitList({ units: [{ id: "u", tools: [] }, { id: "u", tools: [] }] }), /duplicate unit id u/);
  assert.throws(() => parseUnitList({ units: [{ id: "u", tools: "nope" }] }), /has no "tools" array/);
  assert.throws(
    () => parseUnitList({ units: [{ id: "u", tools: [{ name: "t" }, { name: "t" }] }] }),
    /duplicate tool u:t/
  );
  const ok = parseUnitList({ units: [{ id: "u", tools: [{ name: "t", description: "d" }] }] });
  assert.deepEqual(ok, [{ id: "u", tools: [{ name: "t", description: "d" }] }]);
});

test("domain protocol: results pass through verbatim, undefined becomes null", () => {
  assert.deepEqual(normaliseDomainResult({ a: 1 }), { value: { a: 1 }, degraded: false });
  assert.deepEqual(normaliseDomainResult(undefined), { value: null, degraded: false });
  assert.equal(isDomainResponse({ jsonrpc: "2.0", id: 1, error: { message: "x" } }), true);
  assert.equal(domainRemoteErrorOf({ jsonrpc: "2.0", id: 1, error: { message: "x" } })?.message, "x");
});

// ---------------------------------------------------------------------------
// Transport — in memory
// ---------------------------------------------------------------------------

test("domain transport: in-memory round-trips and rejects after close", async () => {
  let seen: unknown = null;
  const t = new InMemoryDomainTransport((method, params) => {
    seen = { method, params };
    return { ok: true };
  });
  const res = await t.request("ping", { x: 1 }, 1000);
  assert.deepEqual(res.result, { ok: true });
  assert.deepEqual(seen, { method: "ping", params: { x: 1 } });
  await t.close();
  await assert.rejects(() => t.request("ping", {}, 1));
});

test("domain transport: in-memory deadline is enforced via the injected clock", async () => {
  let now = 0;
  const t = new InMemoryDomainTransport(
    async () => {
      now += 5000;
      return { ok: true };
    },
    { clock: { now: () => now } }
  );
  await assert.rejects(() => t.request("slow", {}, 1000), /timed out/);
});

// ---------------------------------------------------------------------------
// Transport — child process (real L2, built-in pure-unit host)
// ---------------------------------------------------------------------------

function spawnBuiltinHost(units: string) {
  return new ChildProcessDomainTransport({
    command: process.execPath,
    args: ["-e", DOMAIN_HOST_SHIM],
    env: { ORBIT_DOMAIN_UNITS: units }
  });
}

test("domain transport: the built-in host serves units over a real child process", async () => {
  const transport = spawnBuiltinHost("echo,calc");
  try {
    const init = await transport.request("initialize", {}, 10_000);
    assert.deepEqual((init.result as { hostInfo: { name: string } }).hostInfo.name, "orbit-domain-host");
    const list = await transport.request("units/list", {}, 10_000);
    const units = (list.result as { units: Array<{ id: string }> }).units.map((u) => u.id).sort();
    assert.deepEqual(units, ["calc", "echo"]);
    const call = await transport.request("units/call", { unitId: "echo", tool: "sum", arguments: { numbers: [1, 2, 3] } }, 10_000);
    assert.equal(call.result, 6);
  } finally {
    await transport.close();
  }
  assert.equal(transport.closed, true);
});

test("domain transport: a dead host fails in-flight requests instead of hanging", async () => {
  const transport = new ChildProcessDomainTransport({
    command: process.execPath,
    args: ["-e", "process.exit(3);"]
  });
  await transport.start();
  await new Promise((r) => setTimeout(r, 300));
  await assert.rejects(transport.request("units/list", {}, 2_000), DomainRemoteError);
  await transport.close();
});

test("domain transport: a host that dies on startup says why", async () => {
  const transport = new ChildProcessDomainTransport({
    command: process.execPath,
    args: ["-e", "console.error('boom: domain fixture exploded'); process.exit(1);"]
  });
  await transport.start();
  await new Promise((r) => setTimeout(r, 400));
  await assert.rejects(
    transport.request("initialize", {}, 2_000),
    (err: unknown) => {
      assert.ok(err instanceof DomainRemoteError);
      assert.match(err.message, /fixture exploded/, "the host's last words reach the caller");
      return true;
    }
  );
  await transport.close();
});

// ---------------------------------------------------------------------------
// Domain + manager — lifecycle, sync diff, routing
// ---------------------------------------------------------------------------

test("domain: an IsolationDomain talks to the built-in host end to end", async () => {
  const domain = new IsolationDomain({
    domainId: "shared:0",
    isolation: "L2",
    transport: spawnBuiltinHost("echo")
  });
  await domain.setup(CTX);
  assert.equal(domain.isConnected, true);
  assert.equal(domain.hostInfo?.name, "orbit-domain-host");
  assert.deepEqual(domain.describeUnits(), [{ unitId: "echo", tools: ["echo", "sum"] }]);
  assert.equal(await domain.invokeUnit("echo", "sum", [{ numbers: [10, 20, 30] }], CTX), 60);
  await assert.rejects(() => domain.invokeUnit("nope", "sum", [], CTX), DomainUnitMissingError);
  await assert.rejects(() => domain.invokeUnit("echo", "nope", [], CTX), DomainUnitMissingError);
  await domain.teardown();
  assert.equal(domain.isConnected, false);
});

test("domain manager: syncDomains allocates, routes and diffs start/keep/stop", async () => {
  const graph = new ImpactDomainGraph();
  for (const id of ["echo", "calc"]) graph.addNode(id);

  const manager = new IsolationDomainManager({
    transportFactory: () => spawnBuiltinHost("echo,calc"),
    defaultTimeoutMs: 10_000
  });
  try {
    // First sync: two independent units → one shared domain.
    const plan1 = await manager.syncDomains(graph, CTX);
    assert.equal(plan1.domains.length, 1);
    assert.equal(manager.domainsOf().length, 1);
    assert.deepEqual(manager.assignedUnits().sort(), ["calc", "echo"]);
    assert.deepEqual(
      manager.surface().map((s) => `${s.unitId}:${s.tool}`),
      ["calc:add", "calc:mul", "echo:echo", "echo:sum"]
    );

    // Routing through the manager.
    assert.equal(await manager.invokeUnit("echo", "sum", [{ numbers: [1, 2] }], CTX), 3);
    assert.equal(await manager.invokeUnit("calc", "mul", [{ a: 3, b: 4 }], CTX), 12);

    // Graph grows: a third node with a large impact closure → new iso domain;
    // the existing shared domain is KEPT (same domain id, not restarted).
    graph.addNode("hub");
    graph.addEdge("echo", "hub");
    graph.addEdge("calc", "hub");
    const plan2 = await manager.syncDomains(graph, CTX);
    const ids2 = manager.domainsOf().map((d) => d.domainId).sort();
    assert.ok(ids2.includes("iso:hub"), "the escalated node gets its own domain");
    assert.ok(ids2.includes("shared:0"), "the existing shared domain is kept");
    assert.equal(manager.domainsOf().length, 2);
    // The kept domain still routes.
    const echoed = await manager.invokeUnit("echo", "echo", [{ x: 1 }], CTX);
    assert.deepEqual(echoed, { echo: { x: 1 } });

    // A node is removed → the iso domain is stopped.
    graph.removeNode("hub");
    const plan3 = await manager.syncDomains(graph, CTX);
    assert.equal(plan3.domains.length, 1);
    assert.deepEqual(manager.domainsOf().map((d) => d.domainId), ["shared:0"]);
    await assert.rejects(() => manager.invokeUnit("hub", "echo", [], CTX), DomainUnitMissingError);
  } finally {
    await manager.teardownAll();
  }
  assert.deepEqual(manager.domainsOf(), []);
});

test("domain manager: invoking an unassigned unit fails closed", async () => {
  const graph = new ImpactDomainGraph();
  graph.addNode("echo");
  const manager = new IsolationDomainManager({ transportFactory: () => spawnBuiltinHost("echo") });
  try {
    await manager.syncDomains(graph, CTX);
    await assert.rejects(() => manager.invokeUnit("ghost", "echo", [], CTX), DomainUnitMissingError);
  } finally {
    await manager.teardownAll();
  }
});

// ---------------------------------------------------------------------------
// Gateway surface
// ---------------------------------------------------------------------------

test("domain channel: domain units are dispatchable through the hub", async () => {
  const graph = new ImpactDomainGraph();
  for (const id of ["echo", "calc"]) graph.addNode(id);
  const manager = new IsolationDomainManager({ transportFactory: () => spawnBuiltinHost("echo,calc") });
  try {
    await manager.syncDomains(graph, { traceMarkId: "tm-hub", maxWaitMs: 10_000 });
    const hub = new ChannelHub();
    hub.registerBuiltInChannel(ChannelKind.DOMAIN_TOOL, new DomainChannel(manager));
    await hub.setupAllBuiltInChannels({ traceMarkId: "tm-hub", maxWaitMs: 10_000 });
    const out = await hub.fireChannelCall<number>(
      ChannelKind.DOMAIN_TOOL,
      { traceMarkId: "tm-hub", maxWaitMs: 10_000 },
      "echo:sum",
      { numbers: [2, 2] }
    );
    assert.equal(out, 4);
    await hub.teardown();
  } finally {
    await manager.teardownAll();
  }
});
