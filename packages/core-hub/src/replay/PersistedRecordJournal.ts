import { RecordJournal } from "./record_journal";
import type { GatewayCallRecord } from "./record_journal";
import {
  walAppend,
  walCompact,
  walLineCount,
  walRecover,
  walRecoverSync,
  walReset
} from "../persistence/wal";

/**
 * A `RecordJournal` that mirrors every append to an append-only WAL on disk, so
 * a recorded run survives a process restart and can be replayed verbatim.
 *
 * The in-memory journal remains the source of truth for correctness; the WAL is
 * a durable mirror written fire-and-forget (serialised through a write chain so
 * lines never interleave). Call {@link flush} at shutdown to await the pending
 * chain. Recovery is crash-safe: {@link recoverSync}/{@link recover} drop a
 * single truncated trailing line and reject any corrupt interior line.
 */
export class PersistedRecordJournal extends RecordJournal {
  private readonly filePath?: string;
  private writeChain: Promise<void> = Promise.resolve();

  /**
   * @param filePath WAL path; omit to behave exactly like the in-memory base.
   * @param opts.truncate Start a *fresh* durable window by emptying the WAL
   *   first. The reset is enqueued as the head of the write chain, so it is
   *   always ordered before any append even though the constructor is sync.
   */
  public constructor(filePath?: string, opts?: { truncate?: boolean }) {
    super();
    this.filePath = filePath;
    if (filePath && opts?.truncate === true) {
      this.writeChain = walReset(filePath).catch(() => {
        /* surfaced via flush(); a failed reset must not abort construction */
      });
    }
  }

  public override append(record: Omit<GatewayCallRecord, "entryUid" | "orderIndex">): GatewayCallRecord {
    const entry = super.append(record);
    if (this.filePath) {
      const target = this.filePath;
      this.writeChain = this.writeChain
        .then(() => walAppend(target, entry))
        .catch(() => {
          /* surfaced via flush(); a missed append must not abort the live call */
        });
    }
    return entry;
  }

  public override flush(): Promise<void> {
    return this.writeChain;
  }

  /**
   * Rewrite the WAL from the in-memory chain, atomically.
   *
   * A recording window is append-only, so this never *drops* calls — its purpose
   * is to heal a file whose tail a crash truncated: recovery ignores the partial
   * line, and compaction physically removes it so the log is well-formed again.
   * Ordered through the write chain, so a concurrent append cannot race it.
   *
   * @returns the number of lines on disk afterwards (0 when not durable).
   */
  public compact(): Promise<number> {
    if (!this.filePath) return Promise.resolve(0);
    const target = this.filePath;
    const run = this.writeChain.then(() => walCompact(target, this.snapshot()));
    this.writeChain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  /**
   * Rewrite the WAL only when recovery had to drop a crash-truncated tail.
   *
   * Recovery is deliberately read-only, so the partial line survives on disk —
   * and once the resumed window appends, it sits in the *interior*, where an
   * invalid line is a hard fault. Healing before the first append closes that
   * window; the count check keeps a healthy log from being rewritten on boot.
   *
   * @returns true when the log was rewritten.
   */
  public async healIfNeeded(): Promise<boolean> {
    if (!this.filePath) return false;
    if ((await walLineCount(this.filePath)) === this.size()) return false;
    await this.compact();
    return true;
  }

  /** Recover a persisted journal from disk (synchronous; for non-async callers). */
  public static recoverSync(filePath: string): PersistedRecordJournal {
    const journal = new PersistedRecordJournal(filePath);
    journal.restoreSnapshot(walRecoverSync(filePath, isGatewayCallRecord));
    return journal;
  }

  /** Recover a persisted journal from disk (asynchronous). */
  public static async recover(filePath: string): Promise<PersistedRecordJournal> {
    const journal = new PersistedRecordJournal(filePath);
    journal.restoreSnapshot(await walRecover(filePath, isGatewayCallRecord));
    return journal;
  }
}

function isGatewayCallRecord(value: unknown): value is GatewayCallRecord {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.entryUid === "string" &&
    typeof v.orderIndex === "number" &&
    Number.isInteger(v.orderIndex) &&
    v.orderIndex >= 0 &&
    typeof v.channelKind === "string" &&
    v.channelKind !== "" &&
    typeof v.funcName === "string" &&
    v.funcName !== "" &&
    typeof v.inputDigest === "string" &&
    v.inputDigest !== "" &&
    typeof v.durationMs === "number" &&
    (v.durationMs as number) >= 0
  );
}
