import { ChannelHub } from "../channel/ChannelHub";
import { MemoryKvChannel } from "../channel/providers/MemoryKvChannel";
import { LlmMockChannel } from "../channel/providers/LlmMockChannel";
import { TraceJournal } from "../trace/TraceJournal";
import { PluginSandboxGuard } from "../safeguard/PluginSandboxGuard";
import { PluginPactVerifier } from "../pact/PluginPactVerifier";
import { SandboxPool } from "../sandbox/SandboxPool";
import { ImpactDomainGraph } from "../graph/impact_domain";
import { CostRouter } from "../routing/cost_routing";
import { RecordJournal } from "../replay/record_journal";
import { ReplayEngine } from "../replay/replay_engine";
import { makeUniqueMark } from "../utils/versionIdGen";
import type { AgentSandbox } from "../sandbox/AgentSandbox";
import { ChannelKind, ChannelCallCtx, PluginUnitPact, AgentBoxConfig, CapabilityKey } from "../types/orbitDomain";

const HOST_DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Top-level assembly: wires every component bottom-up and owns the host
 * lifecycle. Components stay public for advanced scenarios (custom channels,
 * audit), but day-to-day use should go through the facade methods below.
 */
export class OrbitRuntimeHost {
  public readonly channelHub: ChannelHub;
  public readonly traceJournal: TraceJournal;
  public readonly pluginSandboxGuard: PluginSandboxGuard;
  public readonly pluginPactVerifier: PluginPactVerifier;
  public readonly sandboxPool: SandboxPool;
  /** M3: dependency graph feeding isolation decisions. */
  public readonly impactGraph: ImpactDomainGraph;
  /** M4: cost profiles and budget routing. */
  public readonly costRouter: CostRouter;

  public constructor() {
    this.costRouter = new CostRouter();
    this.channelHub = new ChannelHub();
    this.traceJournal = new TraceJournal();
    this.impactGraph = new ImpactDomainGraph();
    this.pluginPactVerifier = new PluginPactVerifier();
    this.pluginSandboxGuard = new PluginSandboxGuard(this.traceJournal, (pluginId) =>
      Math.max(2, 5 - this.impactGraph.outDegree(pluginId))
    );
    this.sandboxPool = new SandboxPool(this.channelHub, this.traceJournal, this.costRouter);

    // Close the capability loop: plugin-originated channel calls must pass the
    // declared-capability check. Injected as a function so the channel layer
    // never depends on the pact layer above it.
    this.channelHub.attachCapabilityGate((pluginUnitId, kind, funcName) =>
      this.pluginPactVerifier.hasCapability(pluginUnitId, requiredCapability(kind, funcName))
    );

    this.channelHub.registerBuiltInChannel(ChannelKind.MEM_KV_STORE, new MemoryKvChannel());
    this.channelHub.registerBuiltInChannel(ChannelKind.LLM_ACCESS, new LlmMockChannel());
    this.costRouter.register(ChannelKind.MEM_KV_STORE, { costPerCall: 0, latencyMs: 1, quality: 1 });
    this.costRouter.register(ChannelKind.LLM_ACCESS, { costPerCall: 1, latencyMs: 320, quality: 1 });
  }

  public async bootHost(): Promise<void> {
    await this.channelHub.setupAllBuiltInChannels(this.newHostCtx());
  }

  /** Reverse-order teardown: pool -> pact -> guards -> channels -> journal -> graph. */
  public async shutdownHost(): Promise<void> {
    this.sandboxPool.clear();
    this.pluginPactVerifier.clear();
    this.pluginSandboxGuard.releaseAllGuard();
    await this.channelHub.teardown();
    this.traceJournal.clear();
    this.impactGraph.clear();
  }

  // Facade -----------------------------------------------------------

  /** Register a plugin; its declared channel deps feed the impact graph (M3). */
  public registerPlugin(pact: PluginUnitPact): void {
    this.pluginPactVerifier.registerPluginUnit(pact, makeUniqueMark());
    this.impactGraph.addNode(pact.id);
    for (const dep of pact.declareChannelDeps ?? []) {
      this.impactGraph.addEdge(pact.id, dep);
    }
  }

  /** Spawn an agent sandbox; its channel deps feed the impact graph (M3). */
  public spawnAgentBox(cfg: AgentBoxConfig): AgentSandbox {
    const box = this.sandboxPool.spawnSandbox(cfg);
    this.impactGraph.addNode(cfg.agentBoxId);
    for (const dep of cfg.channelDeps ?? []) {
      this.impactGraph.addEdge(cfg.agentBoxId, dep);
    }
    return box;
  }

  /** M2: open a recording window; sandboxes running in "record" mode fill it. */
  public beginRecording(): RecordJournal {
    const journal = new RecordJournal();
    this.channelHub.attachRecordJournal(journal);
    return journal;
  }

  /** M2: attach a replay engine over a previously recorded journal. */
  public attachReplayEngine(journal: RecordJournal): ReplayEngine {
    const engine = new ReplayEngine(journal);
    this.channelHub.attachReplayEngine(engine);
    return engine;
  }

  /** M3: nodes that would be affected if the given node fails (reachability closure). */
  public isolationDomain(nodeId: string): string[] {
    return [...this.impactGraph.closure(nodeId)];
  }

  /** M3: isolation theorem query — two nodes are provably independent. */
  public areIsolated(a: string, b: string): boolean {
    return this.impactGraph.areIndependent(a, b);
  }

  /** M4: choose the cheapest channel that fits the budget and latency target. */
  public routeChannel(kinds: ChannelKind[], budget: number, maxLatencyMs: number): ChannelKind | undefined {
    return this.costRouter.choose(kinds, budget, maxLatencyMs);
  }

  private newHostCtx(): ChannelCallCtx {
    return { traceMarkId: makeUniqueMark(), maxWaitMs: HOST_DEFAULT_TIMEOUT_MS };
  }
}

/** Minimal mapping from a channel method to its required capability. */
function requiredCapability(kind: ChannelKind, funcName: string): CapabilityKey {
  if (kind === ChannelKind.MEM_KV_STORE) {
    return funcName === "writeEntry" || funcName === "removeEntry" ? "channel:write" : "channel:read";
  }
  if (kind === ChannelKind.FILE_SYSTEM) {
    const writes = new Set(["writeTextFile", "appendTextFile", "removePath", "makeDir"]);
    return writes.has(funcName) ? "channel:write" : "channel:read";
  }
  if (kind === ChannelKind.SHELL_EXEC) {
    // Executing commands is treated as a mutating capability by default.
    return "channel:write";
  }
  return "channel:read";
}
