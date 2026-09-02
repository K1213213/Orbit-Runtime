import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { stableJson } from "./audit_chain";

/**
 * W35 — compliance report signing (audit-grade, asymmetric).
 *
 * The compliance report (W33) becomes a *signed document*: a third party
 * holding only the public key can verify that the report was produced by the
 * operator and has not been altered — no shared secret, no access to the
 * original system. This is the step that turns an internal tool output into
 * something an external auditor can actually accept.
 *
 * Scheme: ED25519 (node:crypto native, zero dependencies). A seed (32 bytes,
 * hex) deterministically derives the key pair, so operators can back up a
 * seed and re-derive the key on any machine. The signature covers a stable
 * digest of the report body (key-sorted JSON of everything except the `sig`
 * field), and carries the public-key fingerprint so a verifier can tell
 * which key should have signed it.
 *
 * Determinism: derivation and digesting are pure functions; signing uses
 * node's deterministic ed25519 (no random nonce), so the same report and key
 * always produce the same signature — verifiable anywhere.
 */

export interface ReportSignature {
  algorithm: "ed25519";
  /** Stable digest (hex) of the signed body. */
  digest: string;
  /** ED25519 signature (base64). */
  signature: string;
  /** sha256 of the public key (hex), so the report names its signer. */
  publicKeyFingerprint: string;
}

export interface ReportKeyPair {
  /** PEM (PKCS8) private key — used to sign. */
  privateKeyPem: string;
  /** PEM (SPKI) public key — handed to verifiers. */
  publicKeyPem: string;
}

/**
 * Derive a deterministic ED25519 key pair from a 32-byte hex seed.
 * RFC 8410: an ed25519 private key IS the 32-byte seed, wrapped as
 * PKCS8 → SEQUENCE { INTEGER 0, SEQUENCE { OID 1.3.101.112 },
 * OCTET STRING { OCTET STRING { seed } } }.
 */
export function deriveReportKeyPair(seed: string): ReportKeyPair {
  const seedBuf = Buffer.from(seed, "hex");
  if (seedBuf.length !== 32) {
    throw new Error(`report signing seed must be 32 bytes of hex, got ${seedBuf.length} bytes`);
  }
  // 302e 02 01 00 3005 0603 2b6570 0422 0420 <seed>
  const privateDer = Buffer.concat([
    Buffer.from("302e020100300506032b657004220420", "hex"),
    seedBuf
  ]);
  const privateKey = createPrivateKey({ key: privateDer, format: "der", type: "pkcs8" });
  const publicKey = createPublicKey(privateKey);
  return {
    // Trim the trailing newline node adds to PEM exports so a PEM survives
    // file round-trips byte-identically (fingerprints must not drift).
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString().trim(),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString().trim()
  };
}

/** Public-key fingerprint (hex) — names the signer on the report. */
export function publicKeyFingerprint(publicKeyPem: string): string {
  return createHash("sha256").update(publicKeyPem).digest("hex").slice(0, 16);
}

/** The signed body of a report (everything except `sig`). */
export function reportBody(report: Record<string, unknown>): string {
  const { sig: _sig, ...body } = report;
  return stableJson(body);
}

/**
 * Sign a compliance report. `seed` is the 32-byte hex operator key; the
 * returned report carries a `sig` field. Pure: same report + seed → same sig.
 */
export function signComplianceReport(
  report: Record<string, unknown>,
  seed: string
): Record<string, unknown> & { sig: ReportSignature } {
  const pair = deriveReportKeyPair(seed);
  const body = reportBody(report);
  const digest = createHash("sha256").update(body).digest("hex");
  const signature = sign(null, Buffer.from(body, "utf8"), pair.privateKeyPem).toString("base64");
  const sig: ReportSignature = {
    algorithm: "ed25519",
    digest,
    signature,
    publicKeyFingerprint: publicKeyFingerprint(pair.publicKeyPem)
  };
  return { ...report, sig };
}

/** Verify a signed report against the public key PEM. */
export function verifyComplianceReport(
  report: Record<string, unknown>,
  publicKeyPem: string
): { ok: boolean; reason?: string } {
  const sig = report.sig as ReportSignature | undefined;
  if (!sig || sig.algorithm !== "ed25519") {
    return { ok: false, reason: "report carries no ed25519 signature" };
  }
  const fp = publicKeyFingerprint(publicKeyPem);
  if (fp !== sig.publicKeyFingerprint) {
    return {
      ok: false,
      reason: `signer mismatch (report key ${sig.publicKeyFingerprint}, verifier ${fp})`
    };
  }
  const body = reportBody(report);
  const digest = createHash("sha256").update(body).digest("hex");
  if (digest !== sig.digest) {
    return { ok: false, reason: "report body digest does not match the signature" };
  }
  const valid = verify(null, Buffer.from(body, "utf8"), publicKeyPem, Buffer.from(sig.signature, "base64"));
  return valid ? { ok: true } : { ok: false, reason: "signature invalid for this public key" };
}
