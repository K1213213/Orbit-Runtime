import { makeUniqueMark } from "@orbit/infra-common";
import type { ChannelKind, GatewayDecision, RunVersionFingerprint, BehaviorNote } from "@orbit/infra-common";

/** One recorded channel call; the atomic unit of replay. */
export interface ReplayCallRecord {
  entryUid: string;
  /** Global call order; reproducing the same order makes scheduling deterministic. */
  orderIndex: number;
  channelKind: ChannelKind;
  funcName: string;
  inputDigest: string;
  outputSnapshot: unknown;
  durationMs: number;
}

/**
 * A recorded call that also carries the gateway's decision snapshot and the
 * run-version fingerprint. `decision` / `runFingerprint` are optional so legacy
 * traces (recorded before the gateway existed) remain replayable.
 */
export interface GatewayCallRecord extends ReplayCallRecord {
  decision?: GatewayDecision;
  runFingerprint?: RunVersionFingerprint;
  /** Optional structured behavior observation captured by the collector (W11). */
  behavior?: BehaviorNote;
}

/** Append-only, indexable store of recorded channel calls. */
export class RecordJournal {
  private readonly records: ReplayCallRecord[] = [];

  public append(record: Omit<GatewayCallRecord, "entryUid" | "orderIndex">): GatewayCallRecord {
    const entry: GatewayCallRecord = {
      ...record,
      entryUid: makeUniqueMark(),
      orderIndex: this.records.length
    };
    this.records.push(entry);
    return entry;
  }

  public get(orderIndex: number): GatewayCallRecord | undefined {
    return this.records[orderIndex] as GatewayCallRecord | undefined;
  }

  public size(): number {
    return this.records.length;
  }

  /** Immutable copy of the chain, for reconciliation. */
  public snapshot(): GatewayCallRecord[] {
    return [...this.records] as GatewayCallRecord[];
  }

  public clear(): void {
    this.records.length = 0;
  }
}
