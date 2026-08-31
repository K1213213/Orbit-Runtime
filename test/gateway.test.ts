import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  OrbitRuntimeHost,
  CapabilityGateway,
  ChannelHub,
  RecordJournal,
  ReplayEngine,
  ChannelKind,
  FileChannel,
  LlmMockChannel,
  digestInputs,
  RunFingerprintDriftError,
  DecisionDriftError,
  ReplayDriftError,
  isCompressedPayload
} from "../src/index";
import type { GatewayCheckers } from "@orbit/core-hub";

function makeHost(): OrbitRuntimeHost {
  const host = new OrbitRuntimeHost();
  return host;
}

test("gateway: record computes and stores the full decision snapshot", async () => {
  const host = makeHost();
  await host.bootHost();
  host.registerPlugin({
    id: "p1",
    displayName: "P1",
    edition: "1.0.0",
    requireHostMinEdition: "1.0.0",
    allowCapabilities: ["channel:read"]
  });
  const journal = host.beginRecording();

  const out = await host.capabilityInvoke({
    kind: ChannelKind.MEM_KV_STORE,
    pluginId: "p1",
    funcName: "readEntry",
    args: ["k"],
    mode: "live"
  });

  assert.equal(journal.size(), 1);
  const rec = journal.get(0)!;
  assert.equal(rec.decision!.tripAllowed, true);
  assert.equal(rec.decision!.pactPass, true); // p1 declared channel:read
  assert.equal(rec.decision!.budget.strategy, "normal");
  assert.equal(rec.decision!.compression.level, "normal");
  assert.equal(rec.decision!.compression.applied, false);
  assert.equal(rec.decision!.route, "native");
  assert.equal(rec.decision!.rateLimited, false);
  assert.equal(rec.runFingerprint!.kernelVersion, "0.2.0");
  assert.equal(out, null); // key not set in the mock KV
  await host.shutdownHost();
});

test("gateway: replay restores the decision and returns the frozen output without re-executing", async () => {
  const host = makeHost();
  await host.bootHost();
  host.registerPlugin({
    id: "p1",
    displayName: "P1",
    edition: "1.0.0",
    requireHostMinEdition: "1.0.0",
    allowCapabilities: ["channel:read"]
  });
  const journal = host.beginRecording();
  const out = await host.capabilityInvoke({
    kind: ChannelKind.MEM_KV_STORE,
    pluginId: "p1",
    funcName: "readEntry",
    args: ["k"],
    mode: "live"
  });

  host.attachReplayEngine(journal);
  const replayed = await host.capabilityInvoke({
    kind: ChannelKind.MEM_KV_STORE,
    pluginId: "p1",
    funcName: "readEntry",
    args: ["k"],
    mode: "replay"
  });

  assert.deepEqual(replayed, out);
  assert.equal(host.gateway.lastDecision!.pactPass, true);
  await host.shutdownHost();
});

test("gateway: replay performs zero real I/O (deleted side-effect file is not recreated)", async () => {
  const host = makeHost();
  await host.bootHost();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gw-zeroio-"));
  host.channelHub.registerPluginExtChannel(ChannelKind.FILE_SYSTEM, new FileChannel({ rootDir: root }));
  host.registerPlugin({
    id: "f1",
    displayName: "F1",
    edition: "1.0.0",
    requireHostMinEdition: "1.0.0",
    allowCapabilities: ["channel:write"]
  });
  const journal = host.beginRecording();
  const wrote = await host.capabilityInvoke({
    kind: ChannelKind.FILE_SYSTEM,
    pluginId: "f1",
    funcName: "writeTextFile",
    args: ["a.txt", "hi"],
    mode: "live"
  });
  assert.equal(typeof wrote, "number"); // FileChannel.writeTextFile returns bytes written
  assert.equal(fs.existsSync(path.join(root, "a.txt")), true);

  fs.rmSync(path.join(root, "a.txt")); // wipe the side effect
  host.attachReplayEngine(journal);
  const replayed = await host.capabilityInvoke({
    kind: ChannelKind.FILE_SYSTEM,
    pluginId: "f1",
    funcName: "writeTextFile",
    args: ["a.txt", "hi"],
    mode: "replay"
  });

  assert.equal(replayed, wrote);
  // The file is NOT recreated — proof that replay injected the frozen output.
  assert.equal(fs.existsSync(path.join(root, "a.txt")), false);
  fs.rmSync(root, { recursive: true, force: true });
  await host.shutdownHost();
});

test("gateway: replay re-verifies the capability gate (revoked pact still blocks)", async () => {
  const host = makeHost();
  await host.bootHost();
  host.registerPlugin({
    id: "p1",
    displayName: "P1",
    edition: "1.0.0",
    requireHostMinEdition: "1.0.0",
    allowCapabilities: ["channel:read"]
  });
  const journal = host.beginRecording();
  await host.capabilityInvoke({
    kind: ChannelKind.MEM_KV_STORE,
    pluginId: "p1",
    funcName: "readEntry",
    args: ["k"],
    mode: "live"
  });

  // Revoke the capability, then replay — governance must not be weakened.
  // This is DECISION drift (the recorded pactPass no longer holds), reported
  // distinctly from config drift and call drift.
  host.pluginPactVerifier.unregisterPluginUnit("p1");
  host.attachReplayEngine(journal);
  await assert.rejects(
    host.capabilityInvoke({
      kind: ChannelKind.MEM_KV_STORE,
      pluginId: "p1",
      funcName: "readEntry",
      args: ["k"],
      mode: "replay"
    }),
    (e) => e instanceof DecisionDriftError && e.decisionField === "pactPass"
  );
  await host.shutdownHost();
});

test("gateway: a missing capability blocks the live call and records nothing", async () => {
  const host = makeHost();
  await host.bootHost();
  host.registerPlugin({
    id: "readonly",
    displayName: "RO",
    edition: "1.0.0",
    requireHostMinEdition: "1.0.0",
    allowCapabilities: ["channel:read"] // no channel:write
  });
  const journal = host.beginRecording();
  await assert.rejects(
    host.capabilityInvoke({
      kind: ChannelKind.MEM_KV_STORE,
      pluginId: "readonly",
      funcName: "writeEntry", // requires channel:write
      args: ["k", "v"],
      mode: "live"
    }),
    /lacks capability/
  );
  assert.equal(journal.size(), 0); // failed governance → not recorded
  await host.shutdownHost();
});

test("gateway: run-fingerprint drift reports a config-drift error (not digest drift)", async () => {
  const hub = new ChannelHub();
  const checkers: GatewayCheckers = {
    tripAllowed: () => true,
    pactPass: () => true,
    budgetDecision: () => ({ allow: true, strategy: "normal" }),
    rateLimited: () => false,
    route: () => "native",
    compression: () => ({ level: "normal", applied: false }),
    fingerprint: () => ({ kernelVersion: "0.1.0", pactVersions: {}, tokenConfigHash: "default", paeEnabled: false })
  };
  const gw = new CapabilityGateway(hub, checkers);
  const digest = digestInputs("k");
  const journal = new RecordJournal();
  journal.append({
    channelKind: ChannelKind.MEM_KV_STORE,
    funcName: "readEntry",
    inputDigest: digest,
    outputSnapshot: "v",
    durationMs: 0,
    decision: {
      tripAllowed: true,
      pactPass: true,
      budget: { allow: true, strategy: "normal" },
      compression: { level: "normal", applied: false },
      route: "native",
      rateLimited: false
    },
    // Recorded under a DIFFERENT kernel version.
    runFingerprint: { kernelVersion: "9.9.9", pactVersions: {}, tokenConfigHash: "default", paeEnabled: false }
  });
  gw.attachJournal(journal);

  await assert.rejects(
    gw.capabilityInvoke({ kind: ChannelKind.MEM_KV_STORE, funcName: "readEntry", args: ["k"], mode: "replay" }),
    (e) => e instanceof RunFingerprintDriftError && e.driftField === "kernelVersion"
  );
});

test("gateway: replay signature mismatch throws ReplayDriftError", async () => {
  const hub = new ChannelHub();
  const checkers: GatewayCheckers = {
    tripAllowed: () => true,
    pactPass: () => true,
    budgetDecision: () => ({ allow: true, strategy: "normal" }),
    rateLimited: () => false,
    route: () => "native",
    compression: () => ({ level: "normal", applied: false }),
    fingerprint: () => ({ kernelVersion: "0.1.0", pactVersions: {}, tokenConfigHash: "default", paeEnabled: false })
  };
  const gw = new CapabilityGateway(hub, checkers);
  const journal = new RecordJournal();
  journal.append({
    channelKind: ChannelKind.MEM_KV_STORE,
    funcName: "readEntry",
    inputDigest: digestInputs("k"),
    outputSnapshot: "v",
    durationMs: 0,
    decision: {
      tripAllowed: true,
      pactPass: true,
      budget: { allow: true, strategy: "normal" },
      compression: { level: "normal", applied: false },
      route: "native",
      rateLimited: false
    },
    runFingerprint: { kernelVersion: "0.1.0", pactVersions: {}, tokenConfigHash: "default", paeEnabled: false }
  });
  gw.attachJournal(journal);

  // Different input -> inputDigest mismatch -> ReplayDriftError.
  await assert.rejects(
    gw.capabilityInvoke({ kind: ChannelKind.MEM_KV_STORE, funcName: "readEntry", args: ["OTHER"], mode: "replay" }),
    (e) => e instanceof ReplayDriftError
  );
});

// W8: a token-config hash mismatch is reported as a distinct config-drift
// error (not a digest mismatch), proving the fingerprint catches threshold changes.
test("gateway: token-config-hash drift reports RunFingerprintDriftError(tokenConfigHash)", async () => {
  const hub = new ChannelHub();
  const checkers: GatewayCheckers = {
    tripAllowed: () => true,
    pactPass: () => true,
    budgetDecision: () => ({ allow: true, strategy: "normal" }),
    rateLimited: () => false,
    route: () => "native",
    compression: () => ({ level: "normal", applied: false }),
    fingerprint: () => ({ kernelVersion: "0.1.0", pactVersions: {}, tokenConfigHash: "RECORDED-HASH", paeEnabled: false })
  };
  const gw = new CapabilityGateway(hub, checkers);
  const journal = new RecordJournal();
  journal.append({
    channelKind: ChannelKind.MEM_KV_STORE,
    funcName: "readEntry",
    inputDigest: digestInputs("k"),
    outputSnapshot: "v",
    durationMs: 0,
    decision: {
      tripAllowed: true,
      pactPass: true,
      budget: { allow: true, strategy: "normal" },
      compression: { level: "normal", applied: false },
      route: "native",
      rateLimited: false
    },
    // Recorded under a DIFFERENT token-budget config.
    runFingerprint: { kernelVersion: "0.1.0", pactVersions: {}, tokenConfigHash: "RECORDED-HASH", paeEnabled: false }
  });
  gw.attachJournal(journal);
  // Replay-time checker reports a changed hash.
  const drifted: GatewayCheckers = { ...checkers, fingerprint: () => ({ kernelVersion: "0.1.0", pactVersions: {}, tokenConfigHash: "CURRENT-HASH", paeEnabled: false }) };
  const gw2 = new CapabilityGateway(hub, drifted);
  gw2.attachJournal(journal);

  await assert.rejects(
    gw2.capabilityInvoke({ kind: ChannelKind.MEM_KV_STORE, funcName: "readEntry", args: ["k"], mode: "replay" }),
    (e) => e instanceof RunFingerprintDriftError && e.driftField === "tokenConfigHash"
  );
});

// W8: route decision is computed from the PAE registry, not a literal stub.
test("gateway: route decision flips to 'pae' once a PAE adapter is registered", async () => {
  const host = makeHost();
  await host.bootHost();
  host.registerPlugin({
    id: "p1",
    displayName: "P1",
    edition: "1.0.0",
    requireHostMinEdition: "1.0.0",
    allowCapabilities: ["channel:read"]
  });
  const journal = host.beginRecording();
  await host.capabilityInvoke({ kind: ChannelKind.MEM_KV_STORE, pluginId: "p1", funcName: "readEntry", args: ["k"], mode: "live" });
  assert.equal(journal.get(0)!.decision!.route, "native");

  host.registerPaeAdapter(ChannelKind.LLM_ACCESS);
  await host.capabilityInvoke({ kind: ChannelKind.MEM_KV_STORE, pluginId: "p1", funcName: "readEntry", args: ["k2"], mode: "live" });
  assert.equal(journal.get(1)!.decision!.route, "pae");
  await host.shutdownHost();
});

// W8: cumulative LLM token usage drives the budget decision across calls.
test("gateway: cumulative LLM usage moves budget strategy normal -> shrink", async () => {
  const host = makeHost();
  await host.bootHost();
  class LongLlmChannel extends LlmMockChannel {
    public override async chatRound(): Promise<string> {
      return Array(5000).fill("word").join(" "); // ~5000 estimated tokens
    }
  }
  host.channelHub.registerPluginExtChannel(ChannelKind.LLM_ACCESS, new LongLlmChannel());
  host.registerPlugin({
    id: "llm1",
    displayName: "LLM1",
    edition: "1.0.0",
    requireHostMinEdition: "1.0.0",
    allowCapabilities: ["channel:read"]
  });
  const journal = host.beginRecording();
  await host.capabilityInvoke({ kind: ChannelKind.LLM_ACCESS, pluginId: "llm1", funcName: "chatRound", args: ["prompt"], mode: "live" });
  // First call: usage 0 -> normal (its own cost is accounted afterwards).
  assert.equal(journal.get(0)!.decision!.budget.strategy, "normal");
  await host.capabilityInvoke({ kind: ChannelKind.LLM_ACCESS, pluginId: "llm1", funcName: "chatRound", args: ["prompt"], mode: "live" });
  // Second call: ~5000 tokens already accounted (> compressAboveTokens) -> shrink.
  assert.equal(journal.get(1)!.decision!.budget.strategy, "shrink");
  await host.shutdownHost();
});

// W9: compression is actually applied to the STORED snapshot (not merely
// decided), yet the consumer receives the original value and replay reproduces
// it byte-for-byte — proof that storage compression preserves axioms A1/A2.
test("gateway: large output is compressed at rest while replay stays byte-identical", async () => {
  const host = makeHost();
  await host.bootHost();
  class BigLlmChannel extends LlmMockChannel {
    public override async chatRound(): Promise<string> {
      return "z".repeat(20000); // ~20 KB serialized -> exceeds compressThresholdBytes
    }
  }
  host.channelHub.registerPluginExtChannel(ChannelKind.LLM_ACCESS, new BigLlmChannel());
  host.registerPlugin({
    id: "llm2",
    displayName: "LLM2",
    edition: "1.0.0",
    requireHostMinEdition: "1.0.0",
    allowCapabilities: ["channel:read"]
  });
  const journal = host.beginRecording();
  const out = await host.capabilityInvoke({
    kind: ChannelKind.LLM_ACCESS,
    pluginId: "llm2",
    funcName: "chatRound",
    args: ["p"],
    mode: "live"
  });

  const rec = journal.get(0)!;
  assert.equal(rec.decision!.compression.applied, true);
  assert.ok((rec.decision!.compression.bytesSaved ?? 0) > 0);
  // The stored snapshot is the compressed envelope, NOT the raw 20 KB string.
  assert.equal(isCompressedPayload(rec.outputSnapshot), true);

  host.attachReplayEngine(journal);
  const replayed = await host.capabilityInvoke({
    kind: ChannelKind.LLM_ACCESS,
    pluginId: "llm2",
    funcName: "chatRound",
    args: ["p"],
    mode: "replay"
  });
  // Consumer-transparent: replay returns the identical original string.
  assert.equal(replayed, out);
  assert.equal(replayed, "z".repeat(20000));
  await host.shutdownHost();
});

// ===========================================================================
// W12 · A.5 gateway determinism gate (7 cases)
// Coverage: 压缩 / 限流 / 采集 / 指纹漂移 / 决策漂移. Every case proves the
// gateway stays a faithful determinism boundary: decisions are recorded, and
// replay restores them verbatim (rate limiter & collector are bypassed).
// ===========================================================================

// A.5 · 压缩: a small payload is NOT compressed at rest, yet replay is still
// byte-identical — the storage-compression decision is honest about savings.
test("A.5 gateway: small payload is left uncompressed at rest, replay byte-identical", async () => {
  const host = makeHost();
  await host.bootHost();
  host.registerPlugin({ id: "p1", displayName: "P1", edition: "1.0.0", requireHostMinEdition: "1.0.0", allowCapabilities: ["channel:read"] });
  const journal = host.beginRecording();
  const out = await host.capabilityInvoke({ kind: ChannelKind.MEM_KV_STORE, pluginId: "p1", funcName: "readEntry", args: ["k"], mode: "live" });
  const rec = journal.get(0)!;
  assert.equal(rec.decision!.compression.applied, false);
  assert.equal(isCompressedPayload(rec.outputSnapshot), false); // raw, never bloated
  host.attachReplayEngine(journal);
  const replayed = await host.capabilityInvoke({ kind: ChannelKind.MEM_KV_STORE, pluginId: "p1", funcName: "readEntry", args: ["k"], mode: "replay" });
  assert.deepEqual(replayed, out);
  await host.shutdownHost();
});

// A.5 · 限流 (recorded limited): the recorded decision is replayed verbatim
// even when the live limiter would now report "not limited" — replay bypasses.
test("A.5 gateway: rate-limited decision recorded as true is replayed verbatim (replay bypasses limiter)", async () => {
  const hub = new ChannelHub();
  const recordedLimited = true;
  const base: GatewayCheckers = {
    tripAllowed: () => true,
    pactPass: () => true,
    budgetDecision: () => ({ allow: true, strategy: "normal" }),
    rateLimited: () => recordedLimited,
    route: () => "native",
    compression: () => ({ level: "normal", applied: false }),
    fingerprint: () => ({ kernelVersion: "0.1.0", pactVersions: {}, tokenConfigHash: "default", paeEnabled: false })
  };
  const journal = new RecordJournal();
  journal.append({
    channelKind: ChannelKind.MEM_KV_STORE, funcName: "readEntry", inputDigest: digestInputs("k"), outputSnapshot: "v", durationMs: 0,
    decision: { tripAllowed: true, pactPass: true, budget: { allow: true, strategy: "normal" }, compression: { level: "normal", applied: false }, route: "native", rateLimited: recordedLimited },
    runFingerprint: { kernelVersion: "0.1.0", pactVersions: {}, tokenConfigHash: "default", paeEnabled: false }
  });
  const gw = new CapabilityGateway(hub, base);
  gw.attachJournal(journal);
  // Replay-time checker claims NOT limited; the recorded (limited) value must win.
  const replayGw = new CapabilityGateway(hub, { ...base, rateLimited: () => false });
  replayGw.attachJournal(journal);
  await replayGw.capabilityInvoke({ kind: ChannelKind.MEM_KV_STORE, funcName: "readEntry", args: ["k"], mode: "replay" });
  assert.equal(replayGw.lastDecision!.rateLimited, true);
});

// A.5 · 限流 (recorded not limited): symmetric — a recorded "false" is restored
// even when the live limiter would now report "limited".
test("A.5 gateway: rate-not-limited decision recorded as false is replayed verbatim (replay bypasses limiter)", async () => {
  const hub = new ChannelHub();
  const base: GatewayCheckers = {
    tripAllowed: () => true, pactPass: () => true,
    budgetDecision: () => ({ allow: true, strategy: "normal" }),
    rateLimited: () => false,
    route: () => "native",
    compression: () => ({ level: "normal", applied: false }),
    fingerprint: () => ({ kernelVersion: "0.1.0", pactVersions: {}, tokenConfigHash: "default", paeEnabled: false })
  };
  const journal = new RecordJournal();
  journal.append({
    channelKind: ChannelKind.MEM_KV_STORE, funcName: "readEntry", inputDigest: digestInputs("k"), outputSnapshot: "v", durationMs: 0,
    decision: { tripAllowed: true, pactPass: true, budget: { allow: true, strategy: "normal" }, compression: { level: "normal", applied: false }, route: "native", rateLimited: false },
    runFingerprint: { kernelVersion: "0.1.0", pactVersions: {}, tokenConfigHash: "default", paeEnabled: false }
  });
  const gw = new CapabilityGateway(hub, base);
  gw.attachJournal(journal);
  const replayGw = new CapabilityGateway(hub, { ...base, rateLimited: () => true });
  replayGw.attachJournal(journal);
  await replayGw.capabilityInvoke({ kind: ChannelKind.MEM_KV_STORE, funcName: "readEntry", args: ["k"], mode: "replay" });
  assert.equal(replayGw.lastDecision!.rateLimited, false);
});

// A.5 · 采集 (record mode): the behavior note is captured and persisted on the record.
test("A.5 gateway: behavior collector attaches a populated note on the record (record mode)", async () => {
  const host = makeHost();
  await host.bootHost();
  host.registerPlugin({ id: "p1", displayName: "P1", edition: "1.0.0", requireHostMinEdition: "1.0.0", allowCapabilities: ["channel:read"] });
  const journal = host.beginRecording();
  await host.capabilityInvoke({ kind: ChannelKind.MEM_KV_STORE, pluginId: "p1", funcName: "readEntry", args: ["k"], mode: "live" });
  const rec = journal.get(0)!;
  assert.ok(rec.behavior, "behavior note should be attached in record mode");
  assert.equal(rec.behavior!.route, "native");
  assert.equal(rec.behavior!.budget.strategy, "normal");
  assert.equal(rec.behavior!.rateLimited, false);
  assert.equal(rec.behavior!.compression.applied, false);
  assert.equal(rec.behavior!.recordedAtMode, "record");
  assert.equal(typeof rec.behavior!.tokensEstimated, "number");
  await host.shutdownHost();
});

// A.5 · 采集 (replay mode): replay bypasses the collector and restores the
// stored behavior note — it is never re-collected or cleared.
test("A.5 gateway: replay restores the stored behavior note (collector bypass)", async () => {
  const host = makeHost();
  await host.bootHost();
  host.registerPlugin({ id: "p1", displayName: "P1", edition: "1.0.0", requireHostMinEdition: "1.0.0", allowCapabilities: ["channel:read"] });
  const journal = host.beginRecording();
  const out = await host.capabilityInvoke({ kind: ChannelKind.MEM_KV_STORE, pluginId: "p1", funcName: "readEntry", args: ["k"], mode: "live" });
  assert.ok(journal.get(0)!.behavior, "behavior present after recording");

  host.attachReplayEngine(journal);
  const replayed = await host.capabilityInvoke({ kind: ChannelKind.MEM_KV_STORE, pluginId: "p1", funcName: "readEntry", args: ["k"], mode: "replay" });
  assert.deepEqual(replayed, out);
  // The stored note survives replay untouched (collector is bypassed).
  assert.ok(journal.get(0)!.behavior, "behavior note preserved across replay");
  assert.equal(journal.get(0)!.behavior!.recordedAtMode, "record");
  await host.shutdownHost();
});

// A.5 · 决策漂移: decision drift is reported distinctly from config/call drift
// via reconcile (here the rateLimited axis differs between the two chains).
test("A.5 gateway: decision drift reported via reconcile (decisionDriftFields)", () => {
  const original = new RecordJournal();
  original.append({
    channelKind: ChannelKind.MEM_KV_STORE, funcName: "readEntry", inputDigest: digestInputs("k"), outputSnapshot: "v", durationMs: 0,
    decision: { tripAllowed: true, pactPass: true, budget: { allow: true, strategy: "normal" }, compression: { level: "normal", applied: false }, route: "native", rateLimited: false },
    runFingerprint: { kernelVersion: "0.1.0", pactVersions: {}, tokenConfigHash: "default", paeEnabled: false }
  });
  const replayed = new RecordJournal();
  replayed.append({
    channelKind: ChannelKind.MEM_KV_STORE, funcName: "readEntry", inputDigest: digestInputs("k"), outputSnapshot: "v", durationMs: 0,
    decision: { tripAllowed: true, pactPass: true, budget: { allow: true, strategy: "normal" }, compression: { level: "normal", applied: false }, route: "native", rateLimited: true },
    runFingerprint: { kernelVersion: "0.1.0", pactVersions: {}, tokenConfigHash: "default", paeEnabled: false }
  });
  const report = new ReplayEngine(original).reconcile(original.snapshot(), replayed.snapshot());
  assert.equal(report.digestChainConsistent, false);
  assert.equal(report.decisionConsistent, false);
  assert.deepEqual(report.decisionDriftFields, ["rateLimited"]);
});

// A.5 · 指纹漂移: a changed PAE-enabled flag surfaces as config drift with the
// right field, never as a generic digest mismatch.
test("A.5 gateway: paeEnabled fingerprint drift reports RunFingerprintDriftError(paeEnabled)", async () => {
  const hub = new ChannelHub();
  const checkers: GatewayCheckers = {
    tripAllowed: () => true, pactPass: () => true,
    budgetDecision: () => ({ allow: true, strategy: "normal" }),
    rateLimited: () => false,
    route: () => "native",
    compression: () => ({ level: "normal", applied: false }),
    fingerprint: () => ({ kernelVersion: "0.1.0", pactVersions: {}, tokenConfigHash: "default", paeEnabled: false })
  };
  const journal = new RecordJournal();
  journal.append({
    channelKind: ChannelKind.MEM_KV_STORE, funcName: "readEntry", inputDigest: digestInputs("k"), outputSnapshot: "v", durationMs: 0,
    decision: { tripAllowed: true, pactPass: true, budget: { allow: true, strategy: "normal" }, compression: { level: "normal", applied: false }, route: "native", rateLimited: false },
    // Recorded WITH PAE enabled.
    runFingerprint: { kernelVersion: "0.1.0", pactVersions: {}, tokenConfigHash: "default", paeEnabled: true }
  });
  const gw = new CapabilityGateway(hub, checkers);
  gw.attachJournal(journal);
  await assert.rejects(
    gw.capabilityInvoke({ kind: ChannelKind.MEM_KV_STORE, funcName: "readEntry", args: ["k"], mode: "replay" }),
    (e) => e instanceof RunFingerprintDriftError && e.driftField === "paeEnabled"
  );
});
