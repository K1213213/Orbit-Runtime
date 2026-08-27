import { makeUniqueMark } from "../utils/versionIdGen";
import type { ChannelKind } from "../types/orbitDomain";

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

/** Append-only, indexable store of recorded channel calls. */
export class RecordJournal {
  private readonly records: ReplayCallRecord[] = [];

  public append(record: Omit<ReplayCallRecord, "entryUid" | "orderIndex">): ReplayCallRecord {
    const entry: ReplayCallRecord = {
      ...record,
      entryUid: makeUniqueMark(),
      orderIndex: this.records.length
    };
    this.records.push(entry);
    return entry;
  }

  public get(orderIndex: number): ReplayCallRecord | undefined {
    return this.records[orderIndex];
  }

  public size(): number {
    return this.records.length;
  }

  /** Immutable copy of the chain, for reconciliation. */
  public snapshot(): ReplayCallRecord[] {
    return [...this.records];
  }

  public clear(): void {
    this.records.length = 0;
  }
}
