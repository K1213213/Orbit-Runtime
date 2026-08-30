import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ChannelKind,
  DomainRemoteError,
  DomainUnitMissingError,
  ImpactDomainGraph,
  InMemoryDomainTransport,
  IsolationDomain,
  IsolationDomainManager,
  OrbitRuntimeHost,
  beginTransaction,
  markExecuted,
  newTxnId,
  reconcileTransactions,
  settleTransaction,
  stableHash
} from "../src/index";
import type { DomainInvokeCtx, DomainTxnDecision } from "../src/index";

/**
 * W20 — cross-domain transactions (VISION 2.1/2.2/2.5).
 *
 * Three layers, the same split the rest of the kernel uses:
 *
 * 1. **pure ledger** — begin / execute / settle / reconcile, with no clock, no
 *    randomness and no I/O, so reconciliation is provable from the records;
 * 2. **manager** — every hop through a domain opens a transaction, executes,
 *    and settles (success or failure); a refused hop is *recorded*, not lost;
 * 3. **host** — the allocation plan becomes host state: graph mutations mark
 *    the plan stale, allocation is idempotent, and the fingerprint only grows a
 *    `domainPlanHash` once domains actually exist (backward compatible).
 */

const CTX: DomainInvokeCtx = { traceMarkId: "tm-txn", maxWaitMs: 1000 };

const ALLOWED: DomainTxnDecision = { targetDomain: "shared:0", isolation: "L2", allowed: true };
const REFUSED: DomainTxnDecision = {
  targetDomain: "—",
  isolation: "—",
  allowed: false,
  reason: "no isolation domain owns unit ghost"
};

/* ------------------------------------------------------------------ */
/* 1. Pure ledger                                                      */
/* ------------------------------------------------------------------ */

test("transaction: ids are sequential and deterministic", () => {
  assert.equal(newTxnId(0), "dtx:0");
  assert.equal(newTxnId(41), "dtx:41");
  assert.throws(() => newTxnId(-1), /non-negative integer/);
  assert.throws(() => newTxnId(1.5), /non-negative integer/);
});

test("transaction: an allowed hop opens in `decided`, a refused one closes as `rejected`", () => {
  const open = beginTransaction({ seq: 0, ctx: CTX, targetUnit: "echo", tool: "echo", decision: ALLOWED });
  assert.equal(open.state, "decided");
  assert.equal(open.txnId, "dtx:0");
  assert.equal(open.sourceDomain, "host", "an unknown caller is attributed to the host");
  assert.equal(open.targetDomain, "shared:0");

  const refused = beginTransaction({ seq: 1, ctx: CTX, targetUnit: "ghost", tool: "echo", decision: REFUSED });
  assert.equal(refused.state, "rejected");
  assert.equal(markExecuted(refused), refused, "a refused transaction executes nothing");
});

test("transaction: execute then settle is the only path to a terminal state", () => {
  const open = beginTransaction({ seq: 0, ctx: CTX, targetUnit: "echo", tool: "echo", decision: ALLOWED });
  const executed = markExecuted(open);
  assert.equal(executed.state, "executed");

  const settled = settleTransaction(executed, { ok: true, latencyMs: 3, costTokens: 2 });
  assert.equal(settled.state, "settled");
  assert.equal(settled.latencyMs, 3);
  assert.equal(settled.costTokens, 2);

  // Settling twice must not corrupt the record.
  assert.equal(settleTransaction(settled, { ok: false }), settled);
});

test("transaction: a failure is terminal and carries the reason", () => {
  const open = beginTransaction({ seq: 0, ctx: CTX, targetUnit: "echo", tool: "echo", decision: ALLOWED });
  const failed = settleTransaction(markExecuted(open), { ok: false, error: "host exited" });
  assert.equal(failed.state, "failed");
  assert.equal(failed.error, "host exited");
});

test("reconciliation: a balanced ledger has no orphans and correct pair counts", () => {
  const mk = (seq: number, src: string, tgt: string, ok: boolean) => {
    const t = beginTransaction({
      seq,
      ctx: CTX,
      targetUnit: "u",
      tool: "t",
      decision: { targetDomain: tgt, isolation: "L2", allowed: true },
      sourceDomain: src
    });
    return settleTransaction(markExecuted(t), { ok, error: ok ? undefined : "boom" });
  };
  const ledger = [mk(0, "host", "shared:0", true), mk(1, "host", "shared:0", false), mk(2, "host", "iso:x", true)];
  const r = reconcileTransactions(ledger);
  assert.equal(r.balanced, true);
  assert.deepEqual(r.orphans, []);
  assert.deepEqual(
    r.pairs.map((p) => `${p.sourceDomain}->${p.targetDomain}:${p.settled}/${p.failed}`),
    ["host->iso:x:1/0", "host->shared:0:1/1"]
  );
  assert.deepEqual(r.totals, { transactions: 3, settled: 2, failed: 1, rejected: 0 });
});

test("reconciliation: an unsettled hop is detected as an orphan", () => {
  const open = beginTransaction({ seq: 0, ctx: CTX, targetUnit: "u", tool: "t", decision: ALLOWED });
  const r = reconcileTransactions([markExecuted(open)]);
  assert.equal(r.balanced, false);
  assert.deepEqual(r.orphans, ["dtx:0"]);
});

test("reconciliation: refusals are counted without poisoning the balance", () => {
  const refused = beginTransaction({ seq: 7, ctx: CTX, targetUnit: "ghost", tool: "t", decision: REFUSED });
  const r = reconcileTransactions([refused]);
  assert.equal(r.balanced, true, "a refused hop never crossed the boundary, so it owes nothing");
  assert.deepEqual(r.rejected, ["dtx:7"]);
  assert.equal(r.totals.rejected, 1);
});

test("stableHash: equal ledgers hash equally, different ones differ", () => {
  const mk = () => beginTransaction({ seq: 0, ctx: CTX, targetUnit: "u", tool: "t", decision: ALLOWED });
  const a = settleTransaction(markExecuted(mk()), { ok: true });
  const b = settleTransaction(markExecuted(mk()), { ok: true });
  const c = settleTransaction(markExecuted(mk()), { ok: false, error: "x" });
  assert.equal(stableHash(JSON.stringify(a)), stableHash(JSON.stringify(b)));
  assert.notEqual(stableHash(JSON.stringify(a)), stableHash(JSON.stringify(c)));
});

/* ------------------------------------------------------------------ */
/* 2. Manager — every hop is a transaction                             */
/* ------------------------------------------------------------------ */

function memoryManager(clock: () => number) {
  const graph = new ImpactDomainGraph();
  graph.addNode("echo");
  graph.addNode("calc");
  const manager = new IsolationDomainManager({
    transportFactory: () =>
      new InMemoryDomainTransport((method: string, params: unknown) => {
        if (method === "initialize") {
          return { protocolVersion: "1.0.0", hostInfo: { name: "txn-host", version: "1.0.0" } };
        }
        if (method === "units/list") {
          return { units: [{ id: "echo", tools: [{ name: "sum" }] }, { id: "calc", tools: [{ name: "add" }] }] };
        }
        const p = params as { arguments: Record<string, unknown> };
        return p.arguments;
      }),
    clock: { now: clock }
  });
  return { manager, graph };
}

test("manager: a successful hop settles one transaction", async () => {
  // An injected clock that advances 5ms per read: the hop is measured twice
  // (start, end), so the settled latency is the injected delta.
  let now = 0;
  const { manager, graph } = memoryManager(() => (now += 5));
  await manager.syncDomains(graph, CTX);
  const out = await manager.invokeUnit("echo", "sum", [{ n: 1 }], CTX);
  assert.deepEqual(out, { n: 1 });

  const ledger = manager.txnLedger();
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].state, "settled");
  assert.equal(ledger[0].txnId, "dtx:0");
  assert.equal(ledger[0].latencyMs, 5, "latency comes from the injected clock, never Date.now()");
  assert.deepEqual(manager.reconcile().orphans, []);
});

test("manager: a refused hop is recorded as rejected and throws", async () => {
  const { manager, graph } = memoryManager(() => 0);
  await manager.syncDomains(graph, CTX);
  await assert.rejects(() => manager.invokeUnit("ghost", "sum", [], CTX), DomainUnitMissingError);

  const ledger = manager.txnLedger();
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].state, "rejected");
  assert.match(ledger[0].decision.reason ?? "", /no isolation domain owns unit ghost/);
  assert.equal(manager.reconcile().balanced, true, "nothing crossed a boundary");
  assert.equal(manager.reconcile().totals.rejected, 1);
});

test("manager: a failing host settles as failed and still fails the call", async () => {
  const graph = new ImpactDomainGraph();
  graph.addNode("broken");
  const manager = new IsolationDomainManager({
    transportFactory: () =>
      new InMemoryDomainTransport(() => {
        throw new DomainRemoteError("host exploded");
      })
  });
  await assert.rejects(() => manager.syncDomains(graph, CTX), DomainRemoteError);

  // A domain that never completed setup cannot be invoked; the plan still exists.
  await assert.rejects(() => manager.invokeUnit("broken", "x", [], CTX), DomainUnitMissingError);
  const ledger = manager.txnLedger();
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].state, "rejected");
});

test("manager: the ledger hashes identically for identical hop sequences", async () => {
  let now = 0;
  const a = memoryManager(() => now);
  const b = memoryManager(() => now);
  await a.manager.syncDomains(a.graph, CTX);
  await b.manager.syncDomains(b.graph, CTX);
  await a.manager.invokeUnit("echo", "sum", [{ n: 1 }], CTX);
  await b.manager.invokeUnit("echo", "sum", [{ n: 1 }], CTX);
  assert.equal(a.manager.ledgerHash(), b.manager.ledgerHash());
});

test("manager: clearLedger drops the records and restarts the sequence", async () => {
  const { manager, graph } = memoryManager(() => 0);
  await manager.syncDomains(graph, CTX);
  await manager.invokeUnit("echo", "sum", [{}], CTX);
  assert.equal(manager.txnLedger().length, 1);
  manager.clearLedger();
  assert.deepEqual(manager.txnLedger(), []);
  await manager.invokeUnit("echo", "sum", [{}], CTX);
  assert.equal(manager.txnLedger()[0].txnId, "dtx:0");
});

/* ------------------------------------------------------------------ */
/* 3. Host — the plan is host state                                    */
/* ------------------------------------------------------------------ */

test("host: the graph marks domains stale, allocation clears it and is idempotent", async () => {
  const host = new OrbitRuntimeHost();
  await host.bootHost();
  try {
    assert.equal(host.domainsStale(), false, "a host that never allocated has nothing stale");
    assert.equal(host.domainPlan(), null);

    host.registerPlugin({
      id: "p.alpha",
      displayName: "p.alpha",
      edition: "1.0.0",
      requireHostMinEdition: "0.2.0",
      allowCapabilities: ["channel:read", "channel:write"],
      declareChannelDeps: [ChannelKind.LLM_ACCESS]
    });
    assert.equal(host.domainsStale(), true, "registering a unit invalidates the plan");

    const plan = await host.allocateIsolationDomains({
      transportFactory: () =>
        new InMemoryDomainTransport(() => ({ units: [] })),
      maxImpactClosure: 1
    });
    assert.equal(plan.domains.length >= 1, true);
    assert.equal(host.domainsStale(), false, "allocation cleared the stale flag");
    assert.deepEqual(host.domainPlan(), plan);

    // Idempotent: the same graph yields the same plan hash and no churn.
    const again = await host.allocateIsolationDomains();
    assert.deepEqual(again, plan);
    assert.equal(host.domains().length, plan.domains.length);
  } finally {
    await host.shutdownHost();
  }
});

test("host: a host that never allocates domains keeps the old fingerprint shape", async () => {
  const host = new OrbitRuntimeHost();
  await host.bootHost();
  try {
    const fp = host.runFingerprint();
    assert.ok(!("domainPlanHash" in fp), "no domain plan ⇒ no domain field in the fingerprint");
    assert.ok("paeEnabled" in fp);
  } finally {
    await host.shutdownHost();
  }
});

test("host: once domains exist the fingerprint carries a stable plan hash", async () => {
  const host = new OrbitRuntimeHost();
  await host.bootHost();
  try {
    host.registerPlugin({
      id: "p.beta",
      displayName: "p.beta",
      edition: "1.0.0",
      requireHostMinEdition: "0.2.0",
      allowCapabilities: ["channel:read", "channel:write"],
      declareChannelDeps: [ChannelKind.LLM_ACCESS]
    });
    await host.allocateIsolationDomains({
      transportFactory: () => new InMemoryDomainTransport(() => ({ units: [] }))
    });
    const fp = host.runFingerprint();
    assert.equal(typeof fp.domainPlanHash, "string");
    assert.ok((fp.domainPlanHash as string).length > 0);

    // Re-allocating the same graph must not perturb the hash.
    await host.allocateIsolationDomains();
    assert.equal(host.runFingerprint().domainPlanHash, fp.domainPlanHash);
  } finally {
    await host.shutdownHost();
  }
});

test("host: domain reconciliation over an empty ledger is balanced", async () => {
  const host = new OrbitRuntimeHost();
  await host.bootHost();
  try {
    const r = host.reconcileDomainTransactions();
    assert.equal(r.balanced, true);
    assert.deepEqual(r.totals, { transactions: 0, settled: 0, failed: 0, rejected: 0 });
    assert.deepEqual(host.domainLedger(), []);
  } finally {
    await host.shutdownHost();
  }
});

test("host: invoking a domain unit is a recorded gateway transaction", async () => {
  const host = new OrbitRuntimeHost();
  await host.bootHost();
  try {
    host.registerPlugin({
      id: "p.gamma",
      displayName: "p.gamma",
      edition: "1.0.0",
      requireHostMinEdition: "0.2.0",
      allowCapabilities: ["channel:read", "channel:write"],
      declareChannelDeps: [ChannelKind.LLM_ACCESS]
    });
    // The unit lives in a domain host that answers with its argument object.
    await host.allocateIsolationDomains({
      transportFactory: () =>
        new InMemoryDomainTransport((method: string, params: unknown) => {
          if (method === "initialize") {
            return { protocolVersion: "1.0.0", hostInfo: { name: "unit-host", version: "1.0.0" } };
          }
          if (method === "units/list") {
            return { units: [{ id: "p.gamma", tools: [{ name: "ping" }] }] };
          }
          const p = params as { arguments: Record<string, unknown> };
          return { pong: p.arguments };
        }),
      maxImpactClosure: 1
    });

    const out = await host.invokeDomainUnit<{ pong: { hello: string } }>(
      "p.gamma",
      "ping",
      [{ hello: "world" }],
      { pluginUnitId: "p.gamma" }
    );
    assert.deepEqual(out.pong, { hello: "world" });

    const ledger = host.domainLedger();
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].state, "settled");
    assert.equal(ledger[0].targetUnit, "p.gamma");
    assert.equal(ledger[0].tool, "ping");
    const r = host.reconcileDomainTransactions();
    assert.equal(r.balanced, true);
    assert.deepEqual(r.pairs.map((p) => `${p.sourceDomain}->${p.targetDomain}`), [
      `${ledger[0].sourceDomain}->${ledger[0].targetDomain}`
    ]);
  } finally {
    await host.shutdownHost();
  }
});

test("host: shutdown releases the domains", async () => {
  const host = new OrbitRuntimeHost();
  await host.bootHost();
  host.registerPlugin({
    id: "p.delta",
    displayName: "p.delta",
    edition: "1.0.0",
    requireHostMinEdition: "0.2.0",
    allowCapabilities: ["channel:read", "channel:write"],
    declareChannelDeps: [ChannelKind.LLM_ACCESS]
  });
  await host.allocateIsolationDomains({
    transportFactory: () => new InMemoryDomainTransport(() => ({ units: [] }))
  });
  assert.equal(host.domains().length >= 1, true);
  await host.shutdownHost();
  assert.deepEqual(host.domains(), []);
  assert.equal(host.domainPlan(), null);
});

/* ------------------------------------------------------------------ */
/* 4. Direct domain transport sanity (kept next to the ledger tests)   */
/* ------------------------------------------------------------------ */

test("domain: a unit that reports no tools yields an empty surface", async () => {
  const domain = new IsolationDomain({
    domainId: "shared:0",
    isolation: "L2",
    transport: new InMemoryDomainTransport((method: string) =>
      method === "initialize"
        ? { protocolVersion: "1.0.0", hostInfo: { name: "empty", version: "1.0.0" } }
        : { units: [] }
    )
  });
  await domain.setup(CTX);
  assert.deepEqual(domain.describeUnits(), []);
  await domain.teardown();
});
