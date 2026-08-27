import { makeUniqueMark } from "../utils/versionIdGen";
import type { TraceJournalEntry, TraceMarkId } from "../types/orbitDomain";

/**
 * 轨迹日志本：记录宿主全部关键行为、异常、沙箱运行记录；支持快照与状态回放
 * 所有对外查询均返回副本，外部代码不能直接修改内部日志数组
 */
export class TraceJournal {
  private readonly entryList: TraceJournalEntry[] = [];

  /** 写入一条轨迹记录，自动填充唯一uid与发生时间 */
  public appendTrace(rawFact: Omit<TraceJournalEntry, "entryUid" | "occurredAt">): void {
    const journalItem: TraceJournalEntry = {
      ...rawFact,
      entryUid: makeUniqueMark(),
      occurredAt: Date.now()
    };
    this.entryList.push(journalItem);
  }

  /** 获取完整日志副本 */
  public dumpJournalCopy(): TraceJournalEntry[] {
    return [...this.entryList];
  }

  public filterByTraceMark(traceMarkId: TraceMarkId): TraceJournalEntry[] {
    return this.entryList.filter(e => e.traceMarkId === traceMarkId);
  }

  public filterByAgentBox(boxId: string): TraceJournalEntry[] {
    return this.entryList.filter(e => e.agentBoxId === boxId);
  }

  /** 生成当前轨迹快照副本 */
  public captureSnapshotCopy(): TraceJournalEntry[] {
    return [...this.entryList];
  }

  /** 使用快照副本恢复日志状态 */
  public restoreFromSnapshotCopy(snapshot: TraceJournalEntry[]): void {
    this.entryList.length = 0;
    this.entryList.push(...snapshot);
  }

  public clearAllTrace(): void {
    this.entryList.length = 0;
  }
}
