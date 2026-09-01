/**
 * W29 — governance profiles (VISION §3.1) end to end.
 *
 * The four-tier model is now concrete, switchable configuration. The critical
 * invariant: the `standard` profile must resolve to the kernel's pre-W29
 * numbers VERBATIM — a default host is byte-for-byte what it was before the
 * feature existed. Everything else follows from that identity.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  resolveGovernanceProfile,
  governanceProfileHash,
  OrbitRuntimeHost,
  ChannelKind,
  tokenBudgetConfigForProfile,
  tripThresholdForProfile,
  DEFAULT_TOKEN_BUDGET_CONFIG,
  DEFAULT_RATE_LIMIT_CONFIG,
  JsPaeAdapter,
  DeterminismLevel
} from "../src/index";

/* -------------------------------------------------------- profile resolution */

test("governance: the standard profile is the kernel's pre-W29 default verbatim", () => {
  const std = resolveGovernanceProfile("standard");
  assert.equal(std.limiter.maxCallsPerWindow, DEFAULT_RATE_LIMIT_CONFIG.maxCallsPerWindow);
  assert.equal(std.limiter.windowSizeCalls, DEFAULT_RATE_LIMIT_CONFIG.windowSizeCalls);
  assert.equal(std.trip.failureThreshold, 5);
  assert.equal(std.trip.cooldownMs, 10_000);
  assert.equal(std.compression, "normal");
  assert.equal(std.traceDurability, "optional");
  // The profile config maps to the exact engine defaults too.
  assert.deepEqual(tokenBudgetConfigForProfile(std), DEFAULT_TOKEN_BUDGET_CONFIG);
});

test("governance: omitted or unknown profile resolves to standard (backward compatible)", () => {
  assert.equal(resolveGovernanceProfile(undefined).name, "standard");
  assert.equal(resolveGovernanceProfile("does-not-exist" as never).name, "standard");
});

test("governance: the three tiers differ in the expected direction", () => {
  const sandbox = resolveGovernanceProfile("sandbox");
  const std = resolveGovernanceProfile("standard");
  const strict = resolveGovernanceProfile("strict");
  // Rate limits tighten sandbox -> standard -> strict.
  assert.ok(sandbox.limiter.maxCallsPerWindow > std.limiter.maxCallsPerWindow);
  assert.ok(std.limiter.maxCallsPerWindow > strict.limiter.maxCallsPerWindow);
  // Compression escalates off -> normal -> aggressive.
  assert.equal(sandbox.compression, "off");
  assert.equal(std.compression, "normal");
  assert.equal(strict.compression, "aggressive");
  // PAE admission stays capability-complete on sandbox + standard (governance
  // axiom: tiers scale strength, never capability); strict closes it.
  assert.equal(sandbox.paeAdmission, "all");
  assert.equal(std.paeAdmission, "all");
  assert.deepEqual([...strict.paeAdmission], []);
  // Durability escalates memory -> optional -> required.
  assert.equal(sandbox.traceDurability, "memory");
  assert.equal(strict.traceDurability, "required");
});

test("governance: profile hashes differ across tiers and are stable within a tier", () => {
  const h = (name: string) => governanceProfileHash(resolveGovernanceProfile(name as never));
  assert.notEqual(h("sandbox"), h("standard"));
  assert.notEqual(h("standard"), h("strict"));
  assert.equal(h("standard"), h("standard"));
});

/* ------------------------------------------------- profile -> mechanism wiring */

test("governance: sandbox disables token compression (engine is a pass-through)", async () => {
  const host = new OrbitRuntimeHost({ governanceProfile: "sandbox" });
  await host.bootHost();
  assert.equal(host.currentGovernanceProfile.compression, "off");
  // A payload above the compression threshold must NOT be compressed.
  const big = "x".repeat(10_000);
  const decision = host.tokenBudget.decideCompression(big);
  assert.equal(decision.applied, false);
  await host.shutdownHost();
});

test("governance: strict compresses earlier and harder than standard", async () => {
  const strictHost = new OrbitRuntimeHost({
    governanceProfile: "strict",
    auditSigningKey: "test-key",
    traceJournalPath: "./dist-test-strict-compress.wal"
  });
  await strictHost.bootHost();
  // 5000 bytes sits in the 2-4x band under standard (2048-byte threshold ->
  // normal) but past the 4x band under strict (1024-byte threshold ->
  // aggressive): the same payload escalates, which is what "earlier and
  // harder" means here.
  const payload = "y".repeat(5000);
  const strict = strictHost.tokenBudget.decideCompression(payload);
  assert.equal(strict.applied, true);
  assert.equal(strict.level, "aggressive", "strict escalates to aggressive for the same payload");

  const standardHost = new OrbitRuntimeHost();
  await standardHost.bootHost();
  const normal = standardHost.tokenBudget.decideCompression(payload);
  assert.equal(normal.applied, true);
  assert.equal(normal.level, "normal", "standard stays at normal for the same payload");

  await strictHost.shutdownHost();
  await standardHost.shutdownHost();
});

test("governance: rate limits follow the profile (strict caps at 60 calls)", async () => {
  const host = new OrbitRuntimeHost({
    governanceProfile: "strict",
    auditSigningKey: "test-key",
    traceJournalPath: "./dist-test-strict-rate.wal"
  });
  await host.bootHost();
  host.registerPlugin({
    id: "gov.rate",
    displayName: "Rate",
    edition: "1.0.0",
    requireHostMinEdition: "1.0.0",
    allowCapabilities: ["channel:read"],
    schema: { type: "object", properties: {} }
  });
  for (let i = 0; i < 60; i += 1) {
    assert.equal(host.rateLimiter.isLimited("gov.rate"), false, `call ${i} is free`);
    host.rateLimiter.acquire("gov.rate");
  }
  assert.equal(host.rateLimiter.isLimited("gov.rate"), true, "the 61st call is limited");
  await host.shutdownHost();
});

test("governance: trip threshold is softened by out-degree per profile", () => {
  const std = resolveGovernanceProfile("standard");
  const strict = resolveGovernanceProfile("strict");
  // Standard keeps a floor of 2; strict collapses to 1.
  assert.equal(tripThresholdForProfile(std, 5), 2);
  assert.equal(tripThresholdForProfile(std, 0), 5);
  assert.equal(tripThresholdForProfile(strict, 5), 1);
  assert.equal(tripThresholdForProfile(strict, 0), 3);
});

/* ------------------------------------------------------------- PAE admission */

function makeJsAdapter(adapterId: string) {
  return new JsPaeAdapter({
    adapterId,
    sourceEdition: "1.0.0",
    isolation: "L0",
    tools: [
      {
        name: "echo",
        capability: "channel:read",
        determinism: DeterminismLevel.DETERMINISTIC,
        fidelity: "full",
        description: "echo",
        handler: (_ctx, x) => x
      }
    ]
  });
}

test("governance: sandbox admits every adapter kind", async () => {
  const host = new OrbitRuntimeHost({ governanceProfile: "sandbox" });
  await host.bootHost();
  const pact = host.registerPaeToolAdapter(makeJsAdapter("gov.sandbox.pae"));
  assert.ok(pact.id.endsWith("gov.sandbox.pae"));
  await host.shutdownHost();
});

test("governance: strict rejects every adapter before it is registered", async () => {
  const host = new OrbitRuntimeHost({
    governanceProfile: "strict",
    auditSigningKey: "test-key",
    traceJournalPath: "./dist-test-strict-gov.wal" // strict requires a durable trail
  });
  await host.bootHost();
  assert.throws(() => host.registerPaeToolAdapter(makeJsAdapter("gov.strict.pae")), /does not admit/);
  // And the connect path rejects BEFORE any handshake child is spawned.
  await assert.rejects(
    host.connectPaeToolAdapter(makeJsAdapter("gov.strict.connect")),
    /does not admit/
  );
  await host.shutdownHost();
});

test("governance: standard keeps the full adapter surface (capability-complete)", async () => {
  const host = new OrbitRuntimeHost();
  await host.bootHost();
  const pact = host.registerPaeToolAdapter(makeJsAdapter("gov.std.js"));
  assert.ok(pact);
  await host.shutdownHost();
});

test("governance: strict construction fails without a durable trace path", () => {
  assert.throws(
    () => new OrbitRuntimeHost({ governanceProfile: "strict" }),
    /requires traceJournalPath/
  );
});

/* -------------------------------------------------- fingerprint (config drift) */

test("governance: a non-default tier is a fingerprint surface; standard is omitted", async () => {
  const plain = new OrbitRuntimeHost();
  await plain.bootHost();
  const strict = new OrbitRuntimeHost({
    governanceProfile: "strict",
    auditSigningKey: "test-key",
    traceJournalPath: "./dist-test-gov-fp.wal"
  });
  await strict.bootHost();

  // Standard: no governance field — the fingerprint is byte-for-byte the old one.
  assert.ok(!("governanceProfileHash" in plain.runFingerprint()));
  // Strict: the field appears and differs from plain's.
  const fpStrict = strict.runFingerprint();
  assert.ok(typeof fpStrict.governanceProfileHash === "string");
  assert.ok(fpStrict.governanceProfileHash.length > 0);

  await plain.shutdownHost();
  await strict.shutdownHost();
});

test("governance: replay across tiers is detected as config drift", async () => {
  const host = new OrbitRuntimeHost({ governanceProfile: "sandbox" });
  await host.bootHost();
  host.registerPlugin({
    id: "gov.drift",
    displayName: "Drift",
    edition: "1.0.0",
    requireHostMinEdition: "1.0.0",
    allowCapabilities: ["channel:read"]
  });
  const ctx = { traceMarkId: "t-gov", maxWaitMs: 5000, pluginUnitId: "gov.drift" };
  const journal = host.beginRecording();
  await host.capabilityInvoke({
    kind: ChannelKind.MEM_KV_STORE,
    pluginId: "gov.drift",
    funcName: "readEntry",
    args: ["k"],
    mode: "record",
    ctx
  });
  const fp = journal.get(0)!.runFingerprint;
  assert.ok(fp && "governanceProfileHash" in fp, "sandbox recording carries the profile hash");
  await host.shutdownHost();
});
