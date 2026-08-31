import { makeUniqueMark } from "@orbit/infra-common";
import type { TraceJournalEntry, TraceMarkId } from "@orbit/infra-common";

/**
 * Append-only behavior journal. Reads always return copies so callers cannot
 * mutate internal state; snapshots support audit and replay scenarios.
 */
export class TraceJournal {
  private readonly entryList: TraceJournalEntry[] = [];

  public append(raw: Omit<TraceJournalEntry, "entryUid" | "occurredAt">): void {
    this.entryList.push({ ...raw, entryUid: makeUniqueMark(), occurredAt: Date.now() });
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
  }

  public clear(): void {
    this.entryList.length = 0;
  }
}
