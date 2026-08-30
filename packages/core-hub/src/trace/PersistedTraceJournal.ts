import { TraceJournal } from "./TraceJournal";
import type { TraceJournalEntry } from "@orbit/infra-common";
import { walAppend, walCompact, walLineCount, walRecover, walRecoverSync } from "../persistence/wal";

/**
 * A `TraceJournal` that mirrors every append to an append-only WAL on disk, so
 * the audit/behavior log survives a process restart.
 *
 * Same model as {@link PersistedRecordJournal}: the in-memory journal is the
 * source of truth; the WAL is a durable, fire-and-forget mirror. The exact
 * `entryUid` / `occurredAt` written are preserved on recovery (via
 * `restoreSnapshot`), so reloaded entries are byte-identical to the originals
 * and never perturb replay or audit ordering.
 */
export class PersistedTraceJournal extends TraceJournal {
  private readonly filePath?: string;
  private writeChain: Promise<void> = Promise.resolve();
  /**
   * The first write the fire-and-forget chain lost, if any.
   *
   * An append must not reject — a failed disk write cannot abort the call that
   * produced the entry — so the failure is parked here and re-raised by
   * {@link flush}. Without it, `flush()` awaits a chain whose rejection has
   * already been swallowed and reports success while the audit entry was
   * silently dropped.
   */
  private lastError: unknown = null;

  public constructor(filePath?: string) {
    super();
    this.filePath = filePath;
  }

  public override append(raw: Omit<TraceJournalEntry, "entryUid" | "occurredAt">): TraceJournalEntry {
    const entry = super.append(raw);
    if (this.filePath) {
      const target = this.filePath;
      // A missed append must not abort the live call, so the write stays
      // fire-and-forget: the error is parked for flush() instead of thrown here.
      this.enqueue(() => walAppend(target, entry));
    }
    return entry;
  }

  public override flush(): Promise<void> {
    return this.writeChain.then(() => {
      if (this.lastError !== null) throw this.lastError;
    });
  }

  /**
   * Queue a durable write behind every previous one, keeping the chain
   * unbroken: the chain itself never rejects, so a later append is never
   * skipped because an earlier write failed. The failure is retained for
   * {@link flush} instead — the FIRST one, since that is the root cause and the
   * rest are usually the same fault repeated.
   */
  private enqueue(task: () => Promise<void>): void {
    this.writeChain = this.writeChain.then(task).catch((err: unknown) => {
      if (this.lastError === null) this.lastError = err;
    });
  }

  /**
   * Rewrite the WAL from the in-memory entries, atomically. Heals a
   * crash-truncated tail and materialises whatever retention the caller applied
   * via {@link retainLast}. Ordered through the write chain.
   *
   * @returns the number of lines on disk afterwards (0 when not durable).
   */
  public compact(): Promise<number> {
    if (!this.filePath) return Promise.resolve(0);
    const target = this.filePath;
    const run = this.writeChain.then(() => walCompact(target, this.snapshot()));
    // The chain stays unbroken for later writes (hence the swallowed
    // rejection), but a failed compaction is durable data loss all the same —
    // park it so flush() reports it rather than losing it here.
    this.writeChain = run.then(
      () => undefined,
      (err: unknown) => {
        if (this.lastError === null) this.lastError = err;
      }
    );
    return run;
  }

  /**
   * Retention policy for the audit log: keep only the newest `keep` entries and
   * compact the WAL to match, so the durable log is bounded instead of growing
   * without limit across restarts. An audit trail that fills the disk is an
   * outage, so the bound is explicit and caller-driven rather than implicit.
   *
   * @returns the number of entries retained.
   */
  public async retainLast(keep: number): Promise<number> {
    if (!Number.isInteger(keep) || keep < 0) {
      throw new RangeError(`retainLast expects a non-negative integer, received ${String(keep)}`);
    }
    const all = this.snapshot();
    this.restoreSnapshot(keep === 0 ? [] : all.slice(Math.max(0, all.length - keep)));
    await this.compact();
    return this.snapshot().length;
  }

  /** Load any WAL entries persisted under this path (called once at boot). */
  public override async load(): Promise<void> {
    if (!this.filePath) return;
    const recovered = await walRecover(this.filePath, isTraceJournalEntry);
    this.restoreSnapshot(recovered);
    await this.healIfNeeded(recovered.length);
  }

  /**
   * Rewrite the WAL only when recovery had to drop a crash-truncated tail.
   *
   * Recovery ignores that partial line, but it stays on disk — and once this run
   * appends, it sits in the *interior*, where an invalid line is a hard fault.
   * Healing at load time closes that window; the count check keeps a healthy log
   * from being rewritten on every boot.
   *
   * @returns true when the log was rewritten.
   */
  public async healIfNeeded(recoveredCount: number): Promise<boolean> {
    if (!this.filePath) return false;
    if ((await walLineCount(this.filePath)) === recoveredCount) return false;
    await this.compact();
    return true;
  }

  /** Recover a persisted journal from disk (synchronous; for non-async callers). */
  public static recoverSync(filePath: string): PersistedTraceJournal {
    const journal = new PersistedTraceJournal(filePath);
    journal.restoreSnapshot(walRecoverSync(filePath, isTraceJournalEntry));
    return journal;
  }

  /** Recover a persisted journal from disk (asynchronous). */
  public static async recover(filePath: string): Promise<PersistedTraceJournal> {
    const journal = new PersistedTraceJournal(filePath);
    journal.restoreSnapshot(await walRecover(filePath, isTraceJournalEntry));
    return journal;
  }
}

function isTraceJournalEntry(value: unknown): value is TraceJournalEntry {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.entryUid === "string" &&
    v.entryUid !== "" &&
    typeof v.entryClass === "string" &&
    v.entryClass !== "" &&
    typeof v.occurredAt === "number" &&
    (v.occurredAt as number) >= 0 &&
    typeof v.traceMarkId === "string" &&
    v.traceMarkId !== "" &&
    typeof v.factPayload === "object" &&
    v.factPayload !== null &&
    !Array.isArray(v.factPayload)
  );
}
