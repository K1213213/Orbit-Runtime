/**
 * Example 1 — a custom deterministic channel.
 *
 * Shows how a plugin-extendable capability channel is implemented and wired
 * into the host, then how the record → replay loop proves it byte-identical.
 *
 * The channel uppercases text ("shout"). It is trivially deterministic: no
 * random, no clock, no I/O — so a recorded call replays to exactly the same
 * output, and the digest-chain reconciliation reports no drift.
 *
 * Run: node examples/custom-channel.mjs
 *
 * For npm consumers the imports below become
 *   import { OrbitRuntimeHost, ChannelKind, ... } from "orbit-agent-runtime";
 * The relative paths are only for running inside this repository.
 */
import { OrbitRuntimeHost, ChannelKind } from "../dist/src/index.js";
import { makeUniqueMark, DeterminismLevel, RecordJournal, ReplayEngine } from "../dist/src/index.js";

class ShoutChannel {
  determinismMeta = {
    determinism: DeterminismLevel.DETERMINISTIC,
    replayPolicy: "inject"
  };

  async setup() {}
  async teardown() {}

  /** Uppercase the input. The only surface of the channel. */
  async shout(text) {
    return String(text).toUpperCase();
  }
}

async function main() {
  console.log("=== example 1 · custom deterministic channel ===");

  const host = new OrbitRuntimeHost();
  await host.bootHost();
  console.log("[boot] host started");

  // Register the channel as a plugin-extension of a real ChannelKind. Channel
  // kinds are the fixed capability vocabulary; plugins provide providers.
  host.channelHub.registerPluginExtChannel(ChannelKind.LLM_ACCESS, new ShoutChannel());
  console.log("[channel] ShoutChannel registered on LLM_ACCESS");

  // Every plugin must declare the capabilities it may use (capability gate).
  host.registerPlugin({
    id: "example.shout",
    displayName: "Shout Example",
    edition: "1.0.0",
    requireHostMinEdition: "1.0.0",
    allowCapabilities: ["channel:read"]
  });

  const ctx = { traceMarkId: makeUniqueMark(), pluginUnitId: "example.shout", maxWaitMs: 5000 };
  const call = (mode, text) =>
    host.capabilityInvoke({
      kind: ChannelKind.LLM_ACCESS,
      pluginId: "example.shout",
      funcName: "shout",
      args: [text],
      mode,
      ctx
    });

  const out = await call("live", "hello orbit");
  console.log(`[live]   shout("hello orbit") -> "${out}"`);

  // record mode: real channel calls, journaled verbatim through the gateway.
  const recordJournal = host.beginRecording();
  await call("record", "first");
  await call("record", "second");
  await call("record", "third");
  console.log(`[record] journal holds ${recordJournal.snapshot().length} call(s)`);

  // replay mode: attach the recorded journal as the injection source, then
  // re-run the SAME sequence. The gateway injects frozen outputs (zero channel
  // calls) and every call is signature-checked against the recorded chain —
  // a mismatch is a ReplayDriftError, so "no error" IS the byte-identical proof.
  host.attachReplayEngine(new ReplayEngine(recordJournal));
  const r1 = await call("replay", "first");
  const r2 = await call("replay", "second");
  const r3 = await call("replay", "third");
  console.log(`[replay] first/second/third -> "${r1}" / "${r2}" / "${r3}" (injected)`);

  // Drift detection: changing the input of the next call must be rejected.
  try {
    await call("replay", "tampered");
    console.error("FAIL: a drifted call was not rejected");
    process.exit(1);
  } catch (err) {
    console.log(`[drift]  tampered input rejected: ${err.constructor.name}`);
  }

  console.log("OK — custom channel records and replays byte-identically");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
