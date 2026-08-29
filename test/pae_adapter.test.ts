import { test } from "node:test";
import assert from "node:assert/strict";

import {
  OrbitRuntimeHost,
  PaeAdapterRegistry,
  PaeAdapterRejectError,
  PaeFidelityRejectError,
  PaeToolMissingError,
  JsPaeAdapter,
  ChannelKind,
  DeterminismLevel,
  RunFingerprintDriftError,
  SeededRng
} from "../src/index";
import type { IPaeAdapter, PaeInvokeCtx, PaeToolDescriptor } from "../src/index";

/**
 * W15 — PAE (plugin adaptation engine) suite.
 *
 * Two things are under test, and they are separate concerns:
 *
 * 1. the registry's *static* contract (identity, surface validity, honest
 *    fidelity, deterministic configuration hash, dynamic pact derivation);
 * 2. the *runtime* guarantee that a foreign call is indistinguishable from a
 *    native one — same gateway decision, same journal entry, same replay
 *    semantics, and zero foreign execution while replaying.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A JS adapter with one read tool and one write tool. */
function makeEchoAdapter(counter?: { calls: number }): JsPaeAdapter {
  return new JsPaeAdapter({
    adapterId: "echo-tools",
    sourceEdition: "1.2.0",
    tools: [
      {
        name: "echoUpper",
        capability: "channel:read",
        determinism: DeterminismLevel.DETERMINISTIC,
        description: "uppercase the first argument",
        handler: (args) => {
          if (counter) counter.calls += 1;
          return String(args[0] ?? "").toUpperCase();
        }
      },
      {
        name: "storeNote",
        capability: "channel:write",
        determinism: DeterminismLevel.IO_BOUND,
        handler: (args) => {
          if (counter) counter.calls += 1;
          return { stored: true, note: args[0] };
        }
      }
    ]
  });
}

// ---------------------------------------------------------------------------
// Registry: static validation
// ---------------------------------------------------------------------------

test("pae registry: rejects a duplicate adapter id", () => {
  const registry = new PaeAdapterRegistry();
  registry.register(makeEchoAdapter());
  assert.throws(() => registry.register(makeEchoAdapter()), PaeAdapterRejectError);
});

test("pae registry: rejects a non-semver sourceEdition", () => {
  const registry = new PaeAdapterRegistry();
  const adapter = new JsPaeAdapter({
    adapterId: "weird-edition",
    sourceEdition: "2024-11-05",
    tools: [{ name: "ping", handler: () => "pong" }]
  });
  assert.throws(() => registry.register(adapter), (err: unknown) => {
    assert.ok(err instanceof PaeAdapterRejectError);
    assert.match(err.message, /not semver/);
    return true;
  });
});

test("pae registry: rejects a tool name that collides across adapters", () => {
  const registry = new PaeAdapterRegistry();
  registry.register(makeEchoAdapter());
  const clashing = new JsPaeAdapter({
    adapterId: "other-tools",
    tools: [{ name: "echoUpper", handler: () => "x" }]
  });
  assert.throws(() => registry.register(clashing), (err: unknown) => {
    assert.ok(err instanceof PaeAdapterRejectError);
    assert.match(err.message, /already served by adapter echo-tools/);
    return true;
  });
});

test("pae registry: rejects a tool name that would shadow the channel surface", () => {
  const registry = new PaeAdapterRegistry();
  const shadowing = new JsPaeAdapter({
    adapterId: "shadow",
    tools: [{ name: "teardown", handler: () => null }]
  });
  assert.throws(() => registry.register(shadowing), (err: unknown) => {
    assert.ok(err instanceof PaeAdapterRejectError);
    assert.match(err.message, /reserved/);
    return true;
  });
});

test("pae registry: an undocumented fidelity downgrade is refused", () => {
  const registry = new PaeAdapterRegistry();
  const silent = new JsPaeAdapter({
    adapterId: "silent-lossy",
    tools: [{ name: "guess", fidelity: "lossy", handler: () => 1 }]
  });
  assert.throws(() => registry.register(silent), (err: unknown) => {
    assert.ok(err instanceof PaeAdapterRejectError);
    assert.match(err.message, /without a fidelityNote/);
    return true;
  });

  // The same downgrade, documented, is accepted — the charter asks for informed
  // choice, not for perfection.
  const documented = new JsPaeAdapter({
    adapterId: "documented-lossy",
    tools: [
      {
        name: "guess",
        fidelity: "lossy",
        fidelityNote: "numeric results are rounded to integers",
        handler: () => 1
      }
    ]
  });
  registry.register(documented);
  assert.equal(registry.listTools()[0]!.fidelity, "lossy");
});

// ---------------------------------------------------------------------------
// Registry: derived pact, negotiation, configuration hash
// ---------------------------------------------------------------------------

test("pae registry: derived pact carries the union of tool capabilities", () => {
  const registry = new PaeAdapterRegistry();
  registry.register(makeEchoAdapter());
  const pact = registry.derivePact("echo-tools");
  assert.equal(pact.id, "echo-tools");
  assert.equal(pact.edition, "1.2.0");
  assert.deepEqual(pact.allowCapabilities, ["channel:read", "channel:write"]);
  assert.deepEqual(pact.declareChannelDeps, [ChannelKind.PAE_TOOL]);
});

test("pae registry: a read-only adapter still declares channel:read", () => {
  const registry = new PaeAdapterRegistry();
  registry.register(
    new JsPaeAdapter({
      adapterId: "writer-only",
      tools: [{ name: "writeThing", capability: "channel:write", handler: () => true }]
    })
  );
  const pact = registry.derivePact("writer-only");
  // Reaching the adaptation channel at all is a read of its surface, so the
  // derived pact must not be write-only (the pact verifier enforces closure).
  assert.deepEqual(pact.allowCapabilities, ["channel:read", "channel:write"]);
});

test("pae registry: fidelity negotiation refuses a downgrade and reports both levels", () => {
  const registry = new PaeAdapterRegistry();
  registry.register(
    new JsPaeAdapter({
      adapterId: "streamless",
      tools: [
        {
          name: "chatOnce",
          fidelity: "reduced",
          fidelityNote: "streaming collapsed into a single response",
          handler: () => "hello"
        }
      ]
    })
  );

  const accepted = registry.negotiate("chatOnce", "reduced");
  assert.equal(accepted.fidelity, "reduced");
  assert.match(accepted.fidelityNote!, /streaming/);

  assert.throws(() => registry.negotiate("chatOnce", "full"), (err: unknown) => {
    assert.ok(err instanceof PaeFidelityRejectError);
    assert.equal(err.required, "full");
    assert.equal(err.actual, "reduced");
    return true;
  });
  assert.throws(() => registry.negotiate("noSuchTool"), PaeToolMissingError);
});

test("pae registry: configuration hash is deterministic and order-independent", () => {
  const first = new PaeAdapterRegistry();
  first.register(makeEchoAdapter());
  first.register(new JsPaeAdapter({ adapterId: "zeta", tools: [{ name: "zz", handler: () => 0 }] }));

  const second = new PaeAdapterRegistry();
  second.register(new JsPaeAdapter({ adapterId: "zeta", tools: [{ name: "zz", handler: () => 0 }] }));
  second.register(makeEchoAdapter());

  assert.equal(first.configHash(), second.configHash(), "registration order must not change the hash");

  second.unregister("zeta");
  assert.notEqual(first.configHash(), second.configHash(), "a changed surface must change the hash");
});

test("pae registry: unregister drops the adapter and all of its tools", () => {
  const registry = new PaeAdapterRegistry();
  registry.register(makeEchoAdapter());
  assert.equal(registry.listTools().length, 2);
  registry.unregister("echo-tools");
  assert.ok(registry.isEmpty());
  assert.equal(registry.lookup("echoUpper"), undefined);
  assert.equal(registry.capabilityOf("storeNote"), undefined);
});

// ---------------------------------------------------------------------------
// Adapter contract
// ---------------------------------------------------------------------------

test("pae js adapter: unknown tool names fail with PaeToolMissingError", async () => {
  const adapter = makeEchoAdapter();
  const ctx: PaeInvokeCtx = { traceMarkId: "t", maxWaitMs: 1000 };
  await assert.rejects(adapter.invoke("nope", [], ctx), PaeToolMissingError);
});

test("pae js adapter: determinism sources come from the injected context", async () => {
  const adapter = new JsPaeAdapter({
    adapterId: "seeded",
    tools: [
      {
        name: "rollDie",
        determinism: DeterminismLevel.STOCHASTIC,
        handler: (_args, ctx) => Math.floor((ctx.rng?.next() ?? 0) * 6) + 1
      }
    ]
  });
  const ctx: PaeInvokeCtx = { traceMarkId: "t", maxWaitMs: 1000, rng: new SeededRng(42) };
  const other: PaeInvokeCtx = { traceMarkId: "t", maxWaitMs: 1000, rng: new SeededRng(42) };
  assert.equal(await adapter.invoke("rollDie", [], ctx), await adapter.invoke("rollDie", [], other));
});

// ---------------------------------------------------------------------------
// Host integration: a foreign call is a governed call
// ---------------------------------------------------------------------------

test("pae host: registering an adapter derives and installs a dynamic pact", async () => {
  const host = new OrbitRuntimeHost();
  await host.bootHost();
  const pact = host.registerPaeToolAdapter(makeEchoAdapter());

  assert.ok(host.pluginPactVerifier.listPluginIds().includes("echo-tools"));
  assert.ok(host.pluginPactVerifier.hasCapability("echo-tools", "channel:write"));
  assert.deepEqual(host.paeChannel.installedTools(), ["echoUpper", "storeNote"]);
  // The adapter is a graph node depending on the adaptation channel, so a
  // failure of that channel provably reaches the adapter — the foreign unit
  // participates in isolation reasoning exactly like a native one.
  assert.ok(host.isolationDomain(ChannelKind.PAE_TOOL).includes("echo-tools"));
  assert.equal(host.areIsolated("echo-tools", ChannelKind.MEM_KV_STORE), true);
  assert.equal(pact.displayName, "pae:js:echo-tools");
  await host.shutdownHost();
});

test("pae host: a foreign call is recorded with a full pae-routed decision", async () => {
  const host = new OrbitRuntimeHost();
  await host.bootHost();
  host.registerPaeToolAdapter(makeEchoAdapter());
  const journal = host.beginRecording();

  const out = await host.capabilityInvoke<string>({
    kind: ChannelKind.PAE_TOOL,
    pluginId: "echo-tools",
    funcName: "echoUpper",
    args: ["orbit"],
    mode: "live"
  });

  assert.equal(out, "ORBIT");
  assert.equal(journal.size(), 1);
  const rec = journal.get(0)!;
  assert.equal(rec.channelKind, ChannelKind.PAE_TOOL);
  assert.equal(rec.funcName, "echoUpper", "the trace names the real tool");
  assert.equal(rec.decision!.route, "pae");
  assert.equal(rec.decision!.pactPass, true);
  assert.equal(rec.decision!.tripAllowed, true);
  assert.equal(rec.behavior!.route, "pae");
  assert.ok(rec.runFingerprint!.paeEnabled);
  assert.ok(rec.runFingerprint!.paeAdaptersHash, "the adaptation surface is fingerprinted");
  await host.shutdownHost();
});

test("pae host: a write tool is blocked for a caller holding only read", async () => {
  const host = new OrbitRuntimeHost();
  await host.bootHost();
  // Registered WITHOUT its derived pact, so a hand-written read-only pact is
  // the only capability declaration in play.
  host.registerPaeToolAdapter(makeEchoAdapter(), { registerPact: false });
  host.registerPlugin({
    id: "echo-tools",
    displayName: "Echo (read-only)",
    edition: "1.0.0",
    requireHostMinEdition: "1.0.0",
    allowCapabilities: ["channel:read"]
  });

  // The read tool passes …
  assert.equal(
    await host.capabilityInvoke<string>({
      kind: ChannelKind.PAE_TOOL,
      pluginId: "echo-tools",
      funcName: "echoUpper",
      args: ["ok"],
      mode: "live"
    }),
    "OK"
  );
  // … while the write tool is refused: PAE tools are governed per tool, not
  // wholesale per channel.
  await assert.rejects(
    host.capabilityInvoke({
      kind: ChannelKind.PAE_TOOL,
      pluginId: "echo-tools",
      funcName: "storeNote",
      args: ["secret"],
      mode: "live"
    }),
    /lacks capability/
  );
  await host.shutdownHost();
});

test("pae host: unknown tool names fail closed at the capability gate", async () => {
  const host = new OrbitRuntimeHost();
  await host.bootHost();
  host.registerPaeToolAdapter(makeEchoAdapter(), { registerPact: false });
  host.registerPlugin({
    id: "echo-tools",
    displayName: "Echo (read-only)",
    edition: "1.0.0",
    requireHostMinEdition: "1.0.0",
    allowCapabilities: ["channel:read"]
  });
  // An unregistered tool resolves to the conservative write capability, so the
  // call is refused before anything is dispatched.
  await assert.rejects(
    host.capabilityInvoke({
      kind: ChannelKind.PAE_TOOL,
      pluginId: "echo-tools",
      funcName: "ghostTool",
      args: [],
      mode: "live"
    }),
    /lacks capability/
  );
  await host.shutdownHost();
});

test("pae host: negotiation surfaces at the host facade", async () => {
  const host = new OrbitRuntimeHost();
  await host.bootHost();
  host.registerPaeToolAdapter(
    new JsPaeAdapter({
      adapterId: "reduced-tools",
      tools: [
        {
          name: "summarize",
          fidelity: "reduced",
          fidelityNote: "no citations in the reduced mapping",
          handler: () => "summary"
        }
      ]
    })
  );
  assert.equal(host.negotiatePaeTool("summarize", "reduced").fidelity, "reduced");
  assert.throws(() => host.negotiatePaeTool("summarize", "full"), PaeFidelityRejectError);
  await host.shutdownHost();
});

test("pae host: adapters registered after boot are connected by bootPaeAdapters", async () => {
  const setupOrder: string[] = [];
  const lateAdapter: IPaeAdapter = {
    meta: { adapterId: "late", kind: "js", sourceEdition: "1.0.0", isolation: "L0" },
    describe: (): PaeToolDescriptor[] => [
      {
        name: "lateTool",
        capability: "channel:read",
        determinism: DeterminismLevel.DETERMINISTIC,
        fidelity: "full"
      }
    ],
    invoke: async () => "late-ok",
    setup: async () => {
      setupOrder.push("setup");
    },
    teardown: async () => {
      setupOrder.push("teardown");
    }
  };

  const host = new OrbitRuntimeHost();
  await host.bootHost(); // the adaptation channel boots with an empty surface
  host.registerPaeToolAdapter(lateAdapter);
  assert.deepEqual(setupOrder, [], "registration alone does not connect the adapter");

  await host.bootPaeAdapters();
  assert.deepEqual(setupOrder, ["setup"]);
  await host.bootPaeAdapters();
  assert.deepEqual(setupOrder, ["setup"], "connecting twice is a no-op");

  assert.equal(
    await host.capabilityInvoke<string>({
      kind: ChannelKind.PAE_TOOL,
      pluginId: "late",
      funcName: "lateTool",
      args: [],
      mode: "live"
    }),
    "late-ok"
  );

  await host.shutdownHost();
  assert.deepEqual(setupOrder, ["setup", "teardown"]);
});

test("pae host: unregistering an adapter revokes its tools and its pact", async () => {
  const host = new OrbitRuntimeHost();
  await host.bootHost();
  host.registerPaeToolAdapter(makeEchoAdapter());
  host.unregisterPaeToolAdapter("echo-tools");

  assert.deepEqual(host.paeChannel.installedTools(), []);
  assert.equal(host.pluginPactVerifier.hasCapability("echo-tools", "channel:read"), false);
  await assert.rejects(
    host.capabilityInvoke({
      kind: ChannelKind.PAE_TOOL,
      pluginId: "echo-tools",
      funcName: "echoUpper",
      args: ["x"],
      mode: "live"
    }),
    /lacks capability/
  );
  await host.shutdownHost();
});

// ---------------------------------------------------------------------------
// Determinism: record → replay with zero foreign execution
// ---------------------------------------------------------------------------

test("pae host: replay serves the recorded output and never re-enters the adapter", async () => {
  const counter = { calls: 0 };
  const host = new OrbitRuntimeHost();
  await host.bootHost();
  host.registerPaeToolAdapter(makeEchoAdapter(counter));

  const journal = host.beginRecording();
  const recorded = await host.capabilityInvoke<string>({
    kind: ChannelKind.PAE_TOOL,
    pluginId: "echo-tools",
    funcName: "echoUpper",
    args: ["replay-me"],
    mode: "record"
  });
  assert.equal(recorded, "REPLAY-ME");
  assert.equal(counter.calls, 1);

  host.attachReplayEngine(journal);
  const replayed = await host.capabilityInvoke<string>({
    kind: ChannelKind.PAE_TOOL,
    pluginId: "echo-tools",
    funcName: "echoUpper",
    args: ["replay-me"],
    mode: "replay"
  });

  assert.equal(replayed, recorded, "replay is byte-identical");
  assert.equal(counter.calls, 1, "the foreign runtime is never re-entered on replay");
  assert.equal(host.gateway.lastDecision!.route, "pae", "the recorded decision is restored");
  await host.shutdownHost();
});

test("pae host: replaying against a changed adaptation surface reports config drift", async () => {
  const host = new OrbitRuntimeHost();
  await host.bootHost();
  host.registerPaeToolAdapter(makeEchoAdapter());
  const journal = host.beginRecording();
  await host.capabilityInvoke({
    kind: ChannelKind.PAE_TOOL,
    pluginId: "echo-tools",
    funcName: "echoUpper",
    args: ["x"],
    mode: "record"
  });

  // A second adapter changes the surface hash without touching the recorded
  // call, so the mismatch must be classified as configuration drift.
  host.registerPaeToolAdapter(
    new JsPaeAdapter({ adapterId: "extra", tools: [{ name: "extraTool", handler: () => 1 }] })
  );

  host.attachReplayEngine(journal);
  await assert.rejects(
    host.capabilityInvoke({
      kind: ChannelKind.PAE_TOOL,
      pluginId: "echo-tools",
      funcName: "echoUpper",
      args: ["x"],
      mode: "replay"
    }),
    (err: unknown) => {
      assert.ok(err instanceof RunFingerprintDriftError);
      assert.equal(err.driftField, "paeAdaptersHash");
      return true;
    }
  );
  await host.shutdownHost();
});

test("pae host: traces recorded without any adapter keep their fingerprint shape", async () => {
  const host = new OrbitRuntimeHost();
  await host.bootHost();
  host.registerPlugin({
    id: "native-only",
    displayName: "Native",
    edition: "1.0.0",
    requireHostMinEdition: "1.0.0",
    allowCapabilities: ["channel:read"]
  });
  const journal = host.beginRecording();
  await host.capabilityInvoke({
    kind: ChannelKind.MEM_KV_STORE,
    pluginId: "native-only",
    funcName: "readEntry",
    args: ["k"],
    mode: "record"
  });
  // Backwards compatibility: hosts that never adapt a foreign runtime record
  // exactly the fingerprint they recorded before the engine existed.
  assert.equal(journal.get(0)!.runFingerprint!.paeAdaptersHash, undefined);
  assert.equal(journal.get(0)!.decision!.route, "native");
  await host.shutdownHost();
});
