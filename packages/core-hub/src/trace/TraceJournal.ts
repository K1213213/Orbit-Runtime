import { makeUniqueMark } from "@orbit/infra-common";
import type { TraceJournalEntry, TraceMarkId } from "@orbit/infra-common";
import { chainFieldsOf, chainTailOf, firstChainHash } from "../audit/audit_chain";

/**
 * Append-only behavior journal. Reads always return copies so callers cannot
 * mutate internal state; snapshots support audit and replay scenarios.
 *
 * W30: when constructed with a signing key, every appended entry is linked
 * into an audit hash chain (`prevHash`/`chainHash`, see audit_chain.ts) so a
 * tampered audit trail is detectable. Without a key the journal records no
 * chain fields at all — the pre-W30 behaviour, byte for byte.
 */
export class TraceJournal {
  private readonly entryList: TraceJournalEntry[] = [];
  /** W30: next append links from this hash (null when unsigned). */
  private chainTail: string | null = null;

  public constructor(private readonly chainKey?: string) {}

  public append(raw: Omit<TraceJournalEntry, "entryUid" | "occurredAt">): TraceJournalEntry {
    const entry: TraceJournalEntry = { ...raw, entryUid: makeUniqueMark(), occurredAt: Date.now() };
    if (this.chainKey) {
      const prev = this.chainTail ?? firstChainHash(this.chainKey);
      const fields = chainFieldsOf(this.chainKey, prev, entry);
      entry.prevHash = fields.prevHash;
      entry.chainHash = fields.chainHash;
      this.chainTail = fields.chainHash;
    }
    this.entryList.push(entry);
    return entry;
  }

  public entries(): TraceJournalEntry[] {
    return [...this.entryList];
  }

  public byTraceMark(traceMarkId: TraceMarkId): TraceJournalEntry[] {
    return this.entryList.filter((entry) => entry.traceMarkId === traceMarkId);
  }

  public byAgentBox(agentBoxId: string): TraceJournalEntry[] {
    return this.entryList.filter((entry) => entry.agentBoxId === agentBoxId);
  }

  public byPluginUnit(pluginUnitId: string): TraceJournalEntry[] {
    return this.entryList.filter((entry) => entry.pluginUnitId === pluginUnitId);
  }

  public byEntryClass(entryClass: string): TraceJournalEntry[] {
    return this.entryList.filter((entry) => entry.entryClass === entryClass);
  }

  public snapshot(): TraceJournalEntry[] {
    return [...this.entryList];
  }

  public restoreSnapshot(snapshot: TraceJournalEntry[]): void {
    this.entryList.length = 0;
    this.entryList.push(...snapshot);
    // W30: a restored journal continues the chain from its last entry; a
    // journal without chain fields stays unsigned.
    this.chainTail = chainTailOf(snapshot);
  }

  /**
   * Durability hook. The base journal is in-memory only, so load/flush are
   * no-ops. `PersistedTraceJournal` overrides them to recover from, and drain
   * writes to, its append-only WAL.
   */
  public load(): Promise<void> {
    return Promise.resolve();
  }

  public clear(): void {
    this.entryList.length = 0;
    this.chainTail = null;
  }

  public flush(): Promise<void> {
    return Promise.resolve();
  }
}
