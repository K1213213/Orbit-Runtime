import { OrbitDomainError } from "../core/orbitDomainError";
import { digestInputs } from "../utils/digest";
import type { ChannelKind, GatewayDecision } from "../types/orbitDomain";
import type { RecordJournal, ReplayCallRecord, GatewayCallRecord } from "./record_journal";

/** Replay drift: the recorded call sequence no longer matches the replayed execution. */
export class ReplayDriftError extends OrbitDomainError {
  constructor(message: string, traceMarkId?: string) {
    super(message, "REPLAY_DRIFT", traceMarkId);
  }
}

export interface ReconcileReport {
  originalCount: number;
  replayedCount: number;
  digestChainConsistent: boolean;
  /** False when a recorded gateway decision differs between the two chains. */
  decisionConsistent?: boolean;
  driftAtOrderIndex?: number;
}

/**
 * Replays recorded channel calls by injecting frozen outputs, so a run can be
 * reproduced with zero real model calls. Reconciliation verifies the replayed
 * chain against the original (bank-style account checking).
 */
export class ReplayEngine {
  public constructor(private readonly journal: RecordJournal) {}

  /** Return the frozen output of a recorded call; throw on signature drift. */
  public replayCall(kind: ChannelKind, funcName: string, inputDigest: string, orderIndex: number): unknown {
    const record = this.journal.get(orderIndex);
    if (!record) {
      throw new ReplayDriftError(`call #${orderIndex} missing in journal`);
    }
    if (record.channelKind !== kind || record.funcName !== funcName || record.inputDigest !== inputDigest) {
      throw new ReplayDriftError(`call #${orderIndex} signature mismatch: ${kind}.${funcName}`);
    }
    return structuredClone(record.outputSnapshot);
  }

  /** Compare the replayed chain with the original; locates the first drift if any. */
  public reconcile(original: GatewayCallRecord[], replayed: GatewayCallRecord[]): ReconcileReport {
    const report: ReconcileReport = {
      originalCount: original.length,
      replayedCount: replayed.length,
      digestChainConsistent: original.length === replayed.length
    };
    if (!report.digestChainConsistent) {
      report.driftAtOrderIndex = Math.min(original.length, replayed.length);
      return report;
    }
    for (let i = 0; i < original.length; i++) {
      const a = original[i];
      const b = replayed[i];
      const same =
        a.channelKind === b.channelKind &&
        a.funcName === b.funcName &&
        a.inputDigest === b.inputDigest &&
        digestInputs(a.outputSnapshot) === digestInputs(b.outputSnapshot) &&
        decisionDigest(a.decision) === decisionDigest(b.decision);
      if (!same) {
        report.digestChainConsistent = false;
        report.decisionConsistent = a.decision !== undefined || b.decision !== undefined ? false : true;
        report.driftAtOrderIndex = i;
        break;
      }
    }
    return report;
  }
}

/** Stable digest of a gateway decision, or "" when both sides lack one. */
function decisionDigest(d: GatewayDecision | undefined): string {
  if (!d) return "";
  return digestInputs(d);
}
