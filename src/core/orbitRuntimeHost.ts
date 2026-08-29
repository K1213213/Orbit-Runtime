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
import { KERNEL_VERSION } from "../utils/versionIdGen";
import { CapabilityGateway } from "../gateway/CapabilityGateway";
import { TokenBudgetEngine, DEFAULT_TOKEN_BUDGET_CONFIG } from "../gateway/TokenBudgetEngine";
import type { GatewayInvokeParams } from "../gateway/CapabilityGateway";
import type { GatewayCheckers } from "../gateway/types";
import type { AgentSandbox } from "../sandbox/AgentSandbox";
import { ChannelKind, ChannelCallCtx, PluginUnitPact, AgentBoxConfig, CapabilityKey, ReplayMode } from "../types/orbitDomain";

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
  /** W8: pure-function token budget + context compressor (single source of truth). */
  public readonly tokenBudget: TokenBudgetEngine;
  /** W7: unified gateway entry — the determinism boundary (capabilityInvoke). */
  public readonly gateway: CapabilityGateway;
  /** W8: kinds served by a PAE adapter; routing flips to "pae" when non-empty. */
  private readonly paeAdapterKinds = new Set<ChannelKind>();

  public constructor() {
    this.costRouter = new CostRouter();
    this.tokenBudget = new TokenBudgetEngine();
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

    // W7: wire the gateway. Checkers are injected (not concrete components) so
    // the gateway stays above the pact/safeguard layers. tripAllowed routes
    // through the gateway's own per-plugin trip map. W8: budget / compression /
    // route / tokenConfigHash are now derived from the real TokenBudgetEngine
    // and channel registry instead of literal stubs.
    const checkers: GatewayCheckers = {
      tripAllowed: (pluginId) => this.tripPreCheckFor(pluginId),
      pactPass: (pluginId, kind, funcName) =>
        this.pluginPactVerifier.hasCapability(pluginId, requiredCapability(kind, funcName)),
      budgetDecision: (pluginId) => this.tokenBudget.budgetPolicy(pluginId),
      rateLimited: () => false,
      route: () => (this.paeAdapterKinds.size > 0 ? "pae" : "native"),
      compression: (output) => this.tokenBudget.decideCompression(output),
      fingerprint: () => ({
        kernelVersion: KERNEL_VERSION,
        pactVersions: {},
        tokenConfigHash: this.tokenBudget.configHash(),
        paeEnabled: this.paeAdapterKinds.size > 0
      }),
      accountTokens: (pluginId, output) => {
        if (typeof output === "string") {
          this.tokenBudget.account(pluginId, this.tokenBudget.estimateTokens(output));
        }
      }
    };
    this.gateway = new CapabilityGateway(this.channelHub, checkers);

    this.channelHub.registerBuiltInChannel(ChannelKind.MEM_KV_STORE, new MemoryKvChannel());
    this.channelHub.registerBuiltInChannel(ChannelKind.LLM_ACCESS, new LlmMockChannel());
    this.costRouter.register(ChannelKind.MEM_KV_STORE, { costPerCall: 0, latencyMs: 1, quality: 1 });
    this.costRouter.register(ChannelKind.LLM_ACCESS, { costPerCall: 1, latencyMs: 320, quality: 1 });
  }

  /** Host-private trip pre-check delegating to the gateway's per-plugin map. */
  private tripPreCheckFor(pluginId: string): boolean {
    return this.gateway.tripPreCheck(pluginId);
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

  /**
   * W8: declare a PAE adapter for a channel kind. Once any adapter is
   * registered the gateway's `route` decision becomes "pae" for governed
   * calls, and the run fingerprint's `paeEnabled` flips — so a trace recorded
   * before PAE existed is detected as config drift, never as a digest mismatch.
   */
  public registerPaeAdapter(kind: ChannelKind): void {
    this.paeAdapterKinds.add(kind);
  }

  /** M2: open a recording window; sandboxes running in "record" mode fill it. */
  public beginRecording(): RecordJournal {
    const journal = new RecordJournal();
    this.channelHub.attachRecordJournal(journal);
    this.gateway.attachJournal(journal);
    return journal;
  }

  /** M2: attach a replay engine over a previously recorded journal. */
  public attachReplayEngine(journal: RecordJournal): ReplayEngine {
    const engine = new ReplayEngine(journal);
    this.channelHub.attachReplayEngine(engine);
    this.gateway.attachReplayEngine(engine);
    return engine;
  }

  /** W7: the unified gateway entry — deterministic boundary for governed calls. */
  public capabilityInvoke<T>(params: {
    kind: ChannelKind;
    pluginId?: string;
    funcName: string;
    args: unknown[];
    mode: ReplayMode;
    ctx?: Partial<ChannelCallCtx>;
  }): Promise<T> {
    return this.gateway.capabilityInvoke<T>(params as GatewayInvokeParams);
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
