import { createHmac } from "node:crypto";
import type { TraceJournalEntry } from "@orbit/infra-common";

/**
 * W30 — audit hash chain (anti-tamper audit trail).
 *
 * The durable audit journal is an append-only JSONL file: useful, but a file
 * with write access can be edited silently. A hash chain closes that hole the
 * cheap way — every entry carries `prevHash` (the previous entry's `chainHash`)
 * and `chainHash` = HMAC-SHA256(key, prevHash + canonical entry content), so
 * touching ANY entry (content, timestamp, or linkage) breaks the chain at that
 * point and every entry after it. Verification needs the same key, which the
 * operator keeps out of band — that is the "signature" half of VISION §3.1's
 * "落盘 + 签名".
 *
 * Determinism: HMAC is a pure function (no random, no clock, no I/O), and the
 * canonical form is a key-sorted JSON — given the same key, entry and
 * predecessor, the hash is reproducible anywhere.
 *
 * The chain fields are OPTIONAL on the entry type on purpose: a journal
 * without a key records no chain fields at all (backward-compat rule), so an
 * old journal is byte-identical and replay is untouched. The chain lives on
 * the audit/behavior log, which is observation — it never participates in the
 * recorded decision values, so it cannot perturb deterministic replay.
 */

/** Fixed seed for the first entry's `prevHash` (there is no entry #0). */
export const AUDIT_GENESIS_HASH = "orbit-audit-genesis";

/** Stable canonical form of everything that is NOT chain linkage. */
export function auditEntryBody(entry: TraceJournalEntry): string {
  const { prevHash: _p, chainHash: _c, ...body } = entry;
  return stableJson(body);
}

/** Stable, key-sorted JSON — the canonical serialization for the HMAC. */
export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${stableJson(obj[k])}`);
  return `{${parts.join(",")}}`;
}

/** HMAC-SHA256 digest (hex) of the canonical chain input. */
export function auditChainHash(key: string, prevHash: string, entry: TraceJournalEntry): string {
  return createHmac("sha256", key).update(`${prevHash}\u0000${auditEntryBody(entry)}`).digest("hex");
}

/** Chain fields for an entry, given the predecessor hash. */
export function chainFieldsOf(key: string, prevHash: string, entry: TraceJournalEntry): {
  prevHash: string;
  chainHash: string;
} {
  return { prevHash, chainHash: auditChainHash(key, prevHash, entry) };
}

/** First-chain hash to use as `prevHash` for the first entry of a journal. */
export function firstChainHash(key: string): string {
  return auditChainHash(key, AUDIT_GENESIS_HASH, {
    entryUid: "genesis",
    entryClass: "GENESIS",
    occurredAt: 0,
    traceMarkId: "genesis",
    factPayload: {}
  });
}

/**
 * Verify a whole chain from the genesis seed. Returns the first broken index
 * and why, or `consistent: true`. A chain with NO chain fields at all is
 * reported as `unsigned` (compatible but not signed); a MIXED chain (some
 * entries chained, some not) is a genuine fault.
 */
export interface AuditChainReport {
  consistent: boolean;
  total: number;
  /** Index of the first broken entry (0-based), when inconsistent. */
  brokenAt?: number;
  brokenReason?: string;
  /** True when every entry carries chain fields and they all verify. */
  signed: boolean;
}

export function verifyAuditChain(entries: TraceJournalEntry[], key: string): AuditChainReport {
  let prev = firstChainHash(key);
  // Only a chain that actually carried entries with linkage is "signed"; an
  // empty or bare journal is vacuously consistent but provably unsigned.
  let signed = false;
  for (let i = 0; i < entries.length; i += 1) {
    const e = entries[i];
    const hasChain = e.prevHash !== undefined && e.chainHash !== undefined;
    if (!hasChain) {
      if (i === 0 && entries.length === 1) {
        return { consistent: true, total: 1, signed: false };
      }
      return {
        consistent: false,
        total: entries.length,
        brokenAt: i,
        brokenReason: "entry carries no chain linkage (unsigned entry in a signed journal)",
        signed: false
      };
    }
    signed = true;
    if (e.prevHash !== prev) {
      return {
        consistent: false,
        total: entries.length,
        brokenAt: i,
        brokenReason: `prevHash mismatch (expected ${prev.slice(0, 10)}…, got ${(e.prevHash ?? "").slice(0, 10)}…)`,
        signed: true
      };
    }
    const expected = auditChainHash(key, prev, e);
    if (e.chainHash !== expected) {
      return {
        consistent: false,
        total: entries.length,
        brokenAt: i,
        brokenReason: "chainHash does not match the entry content (tampered or wrong key)",
        signed: true
      };
    }
    prev = e.chainHash;
  }
  return { consistent: true, total: entries.length, signed };
}

/**
 * The chain tail after a restore: the hash the NEXT append must link from.
 * `null` when the journal carries no chain (nothing to continue).
 */
export function chainTailOf(entries: TraceJournalEntry[]): string | null {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const e = entries[i];
    if (e.chainHash) return e.chainHash;
    if (e.prevHash === undefined) return null;
  }
  return null;
}
