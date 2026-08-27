import { AgentSandbox } from "./AgentSandbox";
import type { AgentBoxConfig, AgentBoxId } from "../types/orbitDomain";
import { ChannelHub } from "../channel/ChannelHub";
import { TraceJournal } from "../trace/TraceJournal";

/**
 * Agent沙箱池：统一管理全部Agent沙箱实例的创建、查询、销毁生命周期
 */
export class SandboxPool {
  private readonly sandboxStore = new Map<AgentBoxId, AgentSandbox>();
  private readonly channelHub: ChannelHub;
  private readonly traceJournal: TraceJournal;

  constructor(hub: ChannelHub, journal: TraceJournal) {
    this.channelHub = hub;
    this.traceJournal = journal;
  }

  /** 生成一个全新Agent沙箱实例放入池内 */
  public spawnSandbox(cfg: AgentBoxConfig): AgentSandbox {
    if (this.sandboxStore.has(cfg.agentBoxId)) {
      throw new Error(`Agent sandbox ${cfg.agentBoxId} already exists in pool`);
    }
    const boxIns = new AgentSandbox(cfg, this.channelHub, this.traceJournal);
    this.sandboxStore.set(cfg.agentBoxId, boxIns);
    return boxIns;
  }

  public pickSandbox(boxId: AgentBoxId): AgentSandbox | undefined {
    return this.sandboxStore.get(boxId);
  }

  public dropSandbox(boxId: AgentBoxId): void {
    this.sandboxStore.delete(boxId);
  }

  public getAllSandboxIdCopy(): AgentBoxId[] {
    return Array.from(this.sandboxStore.keys());
  }

  public releasePool(): void {
    this.sandboxStore.clear();
  }
}
