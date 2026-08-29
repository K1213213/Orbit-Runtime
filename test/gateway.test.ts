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
  ChannelKind,
  FileChannel,
  LlmMockChannel,
  digestInputs,
  RunFingerprintDriftError,
  ReplayDriftError
} from "../src/index";
import type { GatewayCheckers } from "../src/gateway/types";

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
  assert.equal(rec.runFingerprint!.kernelVersion, "0.1.0");
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
    (e) => e instanceof ReplayDriftError
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
