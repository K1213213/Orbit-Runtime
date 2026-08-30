/**
 * Cross-domain transaction ledger (W20).
 *
 * VISION 2.1 declares every capability call an atomic transaction —
 * `decision (validation / budget / routing) + execution + result + audit` —
 * and 2.2 adds that **interaction between isolation domains is a gateway
 * transaction whose cross-domain events can be reconciled**.
 *
 * This module is that settlement record. It is pure: no clock, no randomness,
 * no I/O. Transaction ids are derived from an injected sequence, so a run
 * replays to the same id stream, and the ledger can be reconciled after the
 * fact from nothing but the records themselves.
 *
 * What a domain transaction settles:
 *   - the **decision**: is the target unit assigned to a domain, is that domain
 *     up, and what isolation level does the hop cross;
 *   - the **execution**: one call into one domain;
 *   - the **result**: value or failure;
 *   - the **audit**: the pair (source domain → target domain) is what makes
 *     cross-domain blast radius countable after the fact.
 */

import type { DomainIsolationLevel } from "./allocate";
import type { DomainInvokeCtx } from "./IsolationDomain";

/** Transaction id prefix. Sequential, therefore replay-stable. */
const TXN_PREFIX = "dtx";

/** Lifecycle of a cross-domain call. */
export type DomainTxnState =
  /** Decision taken, execution not finished (reconciliation: an orphan). */
  | "decided"
  /** Executed but not yet settled with an outcome. */
  | "executed"
  /** Completed with a value. */
  | "settled"
  /** Refused before execution — the call never crossed the domain boundary. */
  | "rejected"
  /** Crossed the boundary and failed there. */
  | "failed";

/** The domain-layer decision that governs the hop. */
export interface DomainTxnDecision {
  /** Domain that owns the target unit; "—" when no domain owns it. */
  targetDomain: string;
  /** Isolation level of the target domain. */
  isolation: DomainIsolationLevel | "—";
  /** Whether the hop may proceed. */
  allowed: boolean;
  /** Why it was refused (present when `allowed` is false). */
  reason?: string;
}

export interface DomainTransaction {
  txnId: string;
  traceMarkId: string;
  /** Domain of the calling unit ("host" when the caller is not in the plan). */
  sourceDomain: string;
  /** Calling plugin unit, when known. */
  sourceUnit?: string;
  targetDomain: string;
  targetUnit: string;
  tool: string;
  decision: DomainTxnDecision;
  state: DomainTxnState;
  /** Tokens charged for this hop, when the caller accounted them. */
  costTokens?: number;
  latencyMs?: number;
  /** Failure message, when the state is "failed". */
  error?: string;
}

export interface BeginTransactionInput {
  seq: number;
  ctx: DomainInvokeCtx;
  targetUnit: string;
  tool: string;
  decision: DomainTxnDecision;
  /** Calling plugin unit, when the caller is known. */
  sourceUnit?: string;
  /** Domain of the calling unit, when the caller is itself hosted in a domain. */
  sourceDomain?: string;
}

/** Deterministic transaction id: `dtx:<seq>`. */
export function newTxnId(seq: number): string {
  if (!Number.isInteger(seq) || seq < 0) {
    throw new Error(`domain txn sequence must be a non-negative integer, received ${String(seq)}`);
  }
  return `${TXN_PREFIX}:${seq}`;
}

/**
 * Open a transaction: the decision has been taken (allowed or refused) and the
 * call has not run yet. A refused call is closed immediately — it never becomes
 * an orphan, because no execution was owed.
 */
export function beginTransaction(input: BeginTransactionInput): DomainTransaction {
  const txn: DomainTransaction = {
    txnId: newTxnId(input.seq),
    traceMarkId: input.ctx.traceMarkId,
    sourceDomain: input.sourceDomain ?? "host",
    targetDomain: input.decision.targetDomain,
    targetUnit: input.targetUnit,
    tool: input.tool,
    decision: input.decision,
    state: input.decision.allowed ? "decided" : "rejected"
  };
  if (input.sourceUnit !== undefined) txn.sourceUnit = input.sourceUnit;
  if (input.decision.reason !== undefined) txn.decision = { ...input.decision };
  return txn;
}

/** Mark the hop as executed (crossed the boundary) before the outcome is known. */
export function markExecuted(txn: DomainTransaction): DomainTransaction {
  if (txn.state !== "decided") {
    return txn; // a refused transaction has nothing to execute
  }
  return { ...txn, state: "executed" };
}

export interface SettlementOutcome {
  ok: boolean;
  costTokens?: number;
  latencyMs?: number;
  error?: string;
}

/** Close a transaction with its outcome. Terminal: settled or failed. */
export function settleTransaction(txn: DomainTransaction, outcome: SettlementOutcome): DomainTransaction {
  if (txn.state === "rejected" || txn.state === "settled" || txn.state === "failed") {
    return txn; // already terminal — settling twice is a no-op, not a corruption
  }
  const next: DomainTransaction = { ...txn, state: outcome.ok ? "settled" : "failed" };
  if (outcome.costTokens !== undefined) next.costTokens = outcome.costTokens;
  if (outcome.latencyMs !== undefined) next.latencyMs = outcome.latencyMs;
  if (!outcome.ok) next.error = outcome.error ?? "domain call failed";
  return next;
}

/* ------------------------------------------------------------------ */
/* Reconciliation                                                      */
/* ------------------------------------------------------------------ */

export interface DomainPairBalance {
  sourceDomain: string;
  targetDomain: string;
  calls: number;
  settled: number;
  failed: number;
  rejected: number;
  /** Calls that crossed the boundary but were never settled. Must be 0. */
  unsettled: number;
}

export interface DomainReconciliation {
  /** True when every transaction is terminal and every pair balances. */
  balanced: boolean;
  pairs: DomainPairBalance[];
  /** Txn ids still open (decided/executed) — a transaction boundary leak. */
  orphans: string[];
  /** Txn ids refused before execution. */
  rejected: string[];
  totals: { transactions: number; settled: number; failed: number; rejected: number };
}

/**
 * Reconcile the ledger: group by (source → target) and check that every call
 * that crossed a domain boundary paid for it with an outcome.
 *
 * Two failure shapes are detectable from the records alone, with no clock and
 * no host consultation:
 *
 * - **orphans** — decided or executed but never settled: a hop started and the
 *   transaction boundary leaked (a dropped promise, a crashed domain);
 * - **rejects** — refused before execution. Not an error by itself, but a
 *   sudden wall of them means the plan no longer matches the graph.
 */
export function reconcileTransactions(txns: readonly DomainTransaction[]): DomainReconciliation {
  const byPair = new Map<string, DomainPairBalance>();
  const orphans: string[] = [];
  const rejected: string[] = [];
  let settled = 0;
  let failed = 0;

  for (const txn of txns) {
    const key = `${txn.sourceDomain}→${txn.targetDomain}`;
    let row = byPair.get(key);
    if (!row) {
      row = {
        sourceDomain: txn.sourceDomain,
        targetDomain: txn.targetDomain,
        calls: 0,
        settled: 0,
        failed: 0,
        rejected: 0,
        unsettled: 0
      };
      byPair.set(key, row);
    }
    row.calls += 1;
    if (txn.state === "settled") {
      settled += 1;
      row.settled += 1;
    } else if (txn.state === "failed") {
      failed += 1;
      row.failed += 1;
    } else if (txn.state === "rejected") {
      row.rejected += 1;
      rejected.push(txn.txnId);
    } else {
      row.unsettled += 1;
      orphans.push(txn.txnId);
    }
  }

  const pairs = [...byPair.values()].sort((a, b) =>
    a.sourceDomain === b.sourceDomain
      ? a.targetDomain.localeCompare(b.targetDomain)
      : a.sourceDomain.localeCompare(b.sourceDomain)
  );

  return {
    balanced: orphans.length === 0,
    pairs,
    orphans: orphans.sort(),
    rejected: rejected.sort(),
    totals: { transactions: txns.length, settled, failed, rejected: rejected.length }
  };
}

/** Stable hash of a transaction ledger — for drift checks and fingerprints. */
export function ledgerHash(txns: readonly DomainTransaction[]): string {
  const parts = txns.map(
    (t) =>
      `${t.txnId}|${t.sourceDomain}->${t.targetDomain}|${t.targetUnit}:${t.tool}|${t.state}|${t.error ?? ""}`
  );
  return stableHash(parts.join("\n"));
}

/** FNV-1a 32-bit, hex encoded — deterministic, dependency-free. */
export function stableHash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
