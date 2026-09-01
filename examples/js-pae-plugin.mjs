/**
 * Example 2 — a JS plugin adapter (PAE, L0).
 *
 * External plain-JavaScript functions are mapped onto the kernel capability
 * contract through a JsPaeAdapter and published as tools on the single PAE
 * channel. Every call through the adapter is a gateway transaction: recorded,
 * replayed byte-identically, and the adapter surface is hashed into the run
 * fingerprint for drift detection.
 *
 * Run: node examples/js-pae-plugin.mjs
 *
 * The "plugin" here is an in-process function bundle (a foreign runtime in
 * embryo). See examples/mcp-adapter.mjs for a true out-of-process peer.
 */
import { OrbitRuntimeHost, ChannelKind } from "../dist/src/index.js";
import { JsPaeAdapter, SeededRng, DeterminismLevel } from "../dist/src/index.js";
import { makeUniqueMark } from "../dist/src/index.js";

/** The foreign tool bundle — deterministic by contract: no Math.random,
 *  no Date.now; randomness arrives via the injected SeededRng. */
function makeToolBundle() {
  const rng = new SeededRng(42);
  return {
    rollDie: () => {
      // Deterministic "die roll" for the given seed — replay reproduces it.
      const value = 1 + Math.floor(rng.next() * 6);
      return { face: value, seeded: true };
    },
    greet: (ctx, name) => `Hello, ${String(name)}!`,
    add: (ctx, a, b) => Number(a) + Number(b)
  };
}

async function main() {
  console.log("=== example 2 · JS plugin adapter (PAE L0) ===");

  const host = new OrbitRuntimeHost();
  await host.bootHost();
  console.log("[boot] host started");

  const bundle = makeToolBundle();
  const adapter = new JsPaeAdapter({
    adapterId: "example.dice",
    sourceEdition: "1.0.0",
    isolation: "L0",
    tools: [
      {
        name: "rollDie",
        capability: "channel:read",
        determinism: DeterminismLevel.DETERMINISTIC,
        fidelity: "full",
        description: "Roll a deterministic die (seeded)",
        handler: () => bundle.rollDie()
      },
      {
        name: "greet",
        capability: "channel:read",
        determinism: DeterminismLevel.DETERMINISTIC,
        fidelity: "full",
        description: "Greet someone",
        handler: (_ctx, name) => bundle.greet(_ctx, name)
      }
    ]
  });

  const pact = host.registerPaeToolAdapter(adapter);
  console.log(`[adapter] registered "${adapter.meta.adapterId}" -> pact "${pact.id}"`);
  console.log(`[adapter] tools: ${adapter.describe().map((t) => t.name).join(", ")}`);

  // The adapter surface is now a capability channel: foreign calls travel the
  // same gateway → hub path as any native channel call.
  const ctx = { traceMarkId: makeUniqueMark(), pluginUnitId: pact.id, maxWaitMs: 5000 };
  const roll = await host.capabilityInvoke({
    kind: ChannelKind.PAE_TOOL,
    pluginId: pact.id,
    funcName: "rollDie",
    args: [],
    mode: "live",
    ctx
  });
  console.log(`[live]   rollDie() -> ${JSON.stringify(roll)}`);

  // Record the same call, then replay it: the frozen output is injected and
  // the signature check guarantees the recorded run reproduces verbatim.
  const recordJournal = host.beginRecording();
  await host.capabilityInvoke({
    kind: ChannelKind.PAE_TOOL,
    pluginId: pact.id,
    funcName: "rollDie",
    args: [],
    mode: "record",
    ctx
  });
  const first = recordJournal.get(0).outputSnapshot;
  console.log(`[record] rollDie() journaled output -> ${JSON.stringify(first)}`);

  host.attachReplayEngine(
    new (await import("../dist/src/index.js")).ReplayEngine(recordJournal)
  );
  const replayed = await host.capabilityInvoke({
    kind: ChannelKind.PAE_TOOL,
    pluginId: pact.id,
    funcName: "rollDie",
    args: [],
    mode: "replay",
    ctx
  });
  console.log(`[replay] rollDie() injected output -> ${JSON.stringify(replayed)}`);
  if (JSON.stringify(replayed) !== JSON.stringify(first)) {
    console.error("FAIL: replayed output differs from the recorded one");
    process.exit(1);
  }

  // Drift surface: registering a different tool bundle changes the surface
  // hash, so a trace recorded under the old bundle no longer replays cleanly.
  console.log("[drift]  adapter surface is part of the run fingerprint");
  const fp = host.runFingerprint();
  console.log(`[drift]  paeAdaptersHash = ${fp.paeAdaptersHash ? "present" : "absent"}`);

  await host.shutdownHost();
  console.log("[shutdown] clean teardown");
  console.log("OK — foreign JS tools are governed, recorded and replayed verbatim");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
