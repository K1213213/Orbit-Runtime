/**
 * W35 — compliance report signing (ED25519, audit-grade).
 *
 * A signed report is verifiable by any third party holding the public key —
 * no shared secret, no access to the original system. That is what makes a
 * compliance report acceptable to an external auditor.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  deriveReportKeyPair,
  signComplianceReport,
  verifyComplianceReport,
  publicKeyFingerprint
} from "../src/index";

const SEED = "a1b2c3d4e5f60718293a4b5c6d7e8f901a2b3c4d5e6f708192a3b4c5d6e7f8091";
const OTHER_SEED = "00000000000000000000000000000000000000000000000000000000000000ff";

function sampleReport(): Record<string, unknown> {
  return {
    meta: { product: "Orbit Agent Runtime", version: "0.11.0", generatedAt: "2026-09-02T00:00:00.000Z" },
    governance: {
      tier: "Strict（合规）", profile: "strict", compression: "aggressive",
      limiter: "60/60", trip: "3 次 / 5000ms", paeAdmission: "关闭",
      traceDurability: "required", maxIsolationLevel: "L1", schemaMode: "required"
    },
    audit: { entries: 7, signed: true, consistent: true, status: "PASS", text: "链一致" },
    interventions: { 限流: 1 },
    determinism: { calls: 4, flagged: 1 },
    summary: "审计链完整且已签名"
  };
}

test("report signing: seed deterministically derives a stable key pair", () => {
  const a = deriveReportKeyPair(SEED);
  const b = deriveReportKeyPair(SEED);
  assert.equal(a.privateKeyPem, b.privateKeyPem, "same seed -> same private key");
  assert.equal(a.publicKeyPem, b.publicKeyPem, "same seed -> same public key");
  const c = deriveReportKeyPair(OTHER_SEED);
  assert.notEqual(a.publicKeyPem, c.publicKeyPem, "different seed -> different key");
  assert.equal(publicKeyFingerprint(a.publicKeyPem), publicKeyFingerprint(b.publicKeyPem));
});

test("report signing: a valid seed must be 32 bytes of hex", () => {
  assert.throws(() => deriveReportKeyPair("short"), /32 bytes/);
  assert.throws(() => deriveReportKeyPair("zz".repeat(32)), /32 bytes/);
});

test("report signing: sign then verify round-trips", () => {
  const report = sampleReport();
  const signed = signComplianceReport(report, SEED);
  assert.ok(signed.sig, "report carries a signature");
  assert.equal(signed.sig.algorithm, "ed25519");
  assert.equal(signed.sig.publicKeyFingerprint, publicKeyFingerprint(deriveReportKeyPair(SEED).publicKeyPem));
  const verified = verifyComplianceReport(signed, deriveReportKeyPair(SEED).publicKeyPem);
  assert.equal(verified.ok, true, "a genuine signed report verifies");
});

test("report signing: signing is deterministic", () => {
  const s1 = signComplianceReport(sampleReport(), SEED);
  const s2 = signComplianceReport(sampleReport(), SEED);
  assert.equal(s1.sig.signature, s2.sig.signature, "same report + seed -> same signature");
});

test("report signing: tampering with the report body breaks verification", () => {
  const signed = signComplianceReport(sampleReport(), SEED);
  const tampered = {
    ...signed,
    meta: { ...(signed.meta as Record<string, unknown>), version: "0.99.0-evil" }
  } as Record<string, unknown>;
  const verified = verifyComplianceReport(tampered, deriveReportKeyPair(SEED).publicKeyPem);
  assert.equal(verified.ok, false);
  assert.match(verified.reason ?? "", /digest/);
});

test("report signing: the wrong key (or an unsigned report) fails", () => {
  const signed = signComplianceReport(sampleReport(), SEED);
  const wrongKey = verifyComplianceReport(signed, deriveReportKeyPair(OTHER_SEED).publicKeyPem);
  assert.equal(wrongKey.ok, false);
  assert.match(wrongKey.reason ?? "", /signer mismatch/);
  const unsigned = verifyComplianceReport(sampleReport(), deriveReportKeyPair(SEED).publicKeyPem);
  assert.equal(unsigned.ok, false);
  assert.match(unsigned.reason ?? "", /no ed25519 signature/);
});

test("report signing: a mutated signature fails", () => {
  const signed = signComplianceReport(sampleReport(), SEED);
  const broken = {
    ...signed,
    sig: { ...(signed.sig as object), signature: (signed.sig as { signature: string }).signature.replace(/^./, "A") }
  } as Record<string, unknown>;
  const verified = verifyComplianceReport(broken, deriveReportKeyPair(SEED).publicKeyPem);
  assert.equal(verified.ok, false);
});
