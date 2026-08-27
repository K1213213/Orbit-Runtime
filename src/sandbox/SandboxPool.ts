import { AgentSandbox } from "./AgentSandbox";
import { ChannelHub } from "../channel/ChannelHub";
import { TraceJournal } from "../trace/TraceJournal";
import { SandboxSpawnRejectError } from "../core/orbitDomainError";
import type { CostRouter } from "../routing/cost_routing";
import type { AgentBoxConfig, AgentBoxId } from "../types/orbitDomain";

/** Manages the lifecycle of agent sandboxes: spawn, lookup, removal, release. */
export class SandboxPool {
  private readonly sandboxStore = new Map<AgentBoxId, AgentSandbox>();

  public constructor(
    private readonly channelHub: ChannelHub,
    private readonly traceJournal: TraceJournal,
    private readonly costRouter?: CostRouter
  ) {}

  public spawnSandbox(cfg: AgentBoxConfig): AgentSandbox {
    if (this.sandboxStore.has(cfg.agentBoxId)) {
      throw new SandboxSpawnRejectError(`agent sandbox ${cfg.agentBoxId} already exists`);
    }
    const box = new AgentSandbox(cfg, this.channelHub, this.traceJournal, this.costRouter);
    this.sandboxStore.set(cfg.agentBoxId, box);
    return box;
  }

  public get(boxId: AgentBoxId): AgentSandbox | undefined {
    return this.sandboxStore.get(boxId);
  }

  public remove(boxId: AgentBoxId): void {
    this.sandboxStore.delete(boxId);
  }

  public listSandboxIds(): AgentBoxId[] {
    return Array.from(this.sandboxStore.keys());
  }

  public clear(): void {
    this.sandboxStore.clear();
  }
}
