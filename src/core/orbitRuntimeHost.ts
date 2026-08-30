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
import { RateLimiter, DEFAULT_RATE_LIMIT_CONFIG } from "../gateway/RateLimiter";
import { BehaviorCollector } from "../gateway/BehaviorCollector";
import { PaeAdapterRegistry } from "../pae/PaeAdapterRegistry";
import { PaeChannel } from "../pae/PaeChannel";
import type { IPaeAdapter, PaeFidelity, PaeToolDescriptor } from "../pae/types";
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
  /** W11: pure-function rate limiter (call-count budget, replay-safe). */
  public readonly rateLimiter: RateLimiter;
  /** W11: behavior collector (record / live-proposal / replay-bypass). */
  public readonly behaviorCollector: BehaviorCollector;
  /** W7: unified gateway entry — the determinism boundary (capabilityInvoke). */
  public readonly gateway: CapabilityGateway;
  /** W15: registry of foreign-runtime adapters (the adaptation surface). */
  public readonly paeRegistry: PaeAdapterRegistry;
  /** W15: the channel that publishes the adaptation surface to the hub. */
  public readonly paeChannel: PaeChannel;
  /** W8: kinds served by a PAE adapter; routing flips to "pae" when non-empty. */
  private readonly paeAdapterKinds = new Set<ChannelKind>();

  public constructor() {
    this.costRouter = new CostRouter();
    this.tokenBudget = new TokenBudgetEngine();
    this.rateLimiter = new RateLimiter();
    this.behaviorCollector = new BehaviorCollector();
    this.paeRegistry = new PaeAdapterRegistry();
    this.paeChannel = new PaeChannel(this.paeRegistry);
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
      this.pluginPactVerifier.hasCapability(pluginUnitId, this.requiredCapabilityFor(kind, funcName))
    );

    // W7: wire the gateway. Checkers are injected (not concrete components) so
    // the gateway stays above the pact/safeguard layers. tripAllowed routes
    // through the gateway's own per-plugin trip map. W8: budget / compression /
    // route / tokenConfigHash are now derived from the real TokenBudgetEngine
    // and channel registry instead of literal stubs.
    const checkers: GatewayCheckers = {
      tripAllowed: (pluginId) => this.tripPreCheckFor(pluginId),
      pactPass: (pluginId, kind, funcName) =>
        this.pluginPactVerifier.hasCapability(pluginId, this.requiredCapabilityFor(kind, funcName)),
      budgetDecision: (pluginId) => this.tokenBudget.budgetPolicy(pluginId),
      rateLimited: (pluginId) => this.rateLimiter.isLimited(pluginId),
      // W15: a call on the adaptation channel is by definition PAE-routed; the
      // legacy "any adapter kind declared" rule is kept for callers that only
      // announce a routing intent without registering a real adapter.
      route: (_pluginId, kind) =>
        kind === ChannelKind.PAE_TOOL || this.paeAdapterKinds.size > 0 ? "pae" : "native",
      compression: (output) => this.tokenBudget.decideCompression(output),
      fingerprint: () => ({
        kernelVersion: KERNEL_VERSION,
        pactVersions: {},
        tokenConfigHash: this.tokenBudget.configHash(),
        paeEnabled: this.paeAdapterKinds.size > 0,
        // Omitted while no adapter is registered, so traces produced by hosts
        // that never touch PAE keep exactly the fingerprint they had before.
        ...(this.paeRegistry.isEmpty() ? {} : { paeAdaptersHash: this.paeRegistry.configHash() })
      }),
      accountTokens: (pluginId, output) => {
        if (typeof output === "string") {
          this.tokenBudget.account(pluginId, this.tokenBudget.estimateTokens(output));
        }
      },
      estimateTokens: (output) => (typeof output === "string" ? this.tokenBudget.estimateTokens(output) : 0),
      consumeRateLimit: (pluginId) => {
        this.rateLimiter.acquire(pluginId);
      }
    };
    this.gateway = new CapabilityGateway(this.channelHub, checkers);
    // W11: collectors/hooks live inside the gateway; attach the host-owned one.
    this.gateway.attachCollector(this.behaviorCollector);

    this.channelHub.registerBuiltInChannel(ChannelKind.MEM_KV_STORE, new MemoryKvChannel());
    this.channelHub.registerBuiltInChannel(ChannelKind.LLM_ACCESS, new LlmMockChannel());
    // W15: the adaptation surface is a built-in channel with no tools until an
    // adapter is registered — foreign runtimes get no private path in.
    this.channelHub.registerBuiltInChannel(ChannelKind.PAE_TOOL, this.paeChannel);
    this.costRouter.register(ChannelKind.MEM_KV_STORE, { costPerCall: 0, latencyMs: 1, quality: 1 });
    this.costRouter.register(ChannelKind.LLM_ACCESS, { costPerCall: 1, latencyMs: 320, quality: 1 });
    // Adaptation costs more than a native call (an extra hop, possibly a
    // process boundary) and is priced accordingly for budget routing.
    this.costRouter.register(ChannelKind.PAE_TOOL, { costPerCall: 2, latencyMs: 40, quality: 1 });
  }

  /**
   * Capability required by a channel method. Native channels map statically;
   * PAE tools are resolved through the registry so a foreign tool is governed
   * at the same granularity as a native method (read vs write), never wholesale.
   * An unknown tool is treated as a write — the conservative default — so a
   * mis-registered surface fails closed.
   */
  private requiredCapabilityFor(kind: ChannelKind, funcName: string): CapabilityKey {
    if (kind === ChannelKind.PAE_TOOL) {
      return this.paeRegistry.capabilityOf(funcName) ?? "channel:write";
    }
    return requiredCapability(kind, funcName);
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
    // Channel teardown already released every adapter (PaeChannel.teardown);
    // dropping the registry afterwards leaves no dangling foreign surface.
    this.paeRegistry.clear();
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

  /**
   * W15: attach a real foreign-runtime adapter.
   *
   * The adapter is validated, indexed and published as tools on the PAE
   * channel, and a **dynamic pact** is derived from its declared surface and
   * registered like any hand-written plugin manifest. That is what keeps the
   * promise of "MCP-grade ecosystem reach without a governance downgrade": the
   * foreign tool now passes the same capability check, trip protection, budget
   * accounting and recording as a native channel method, because it *is* one.
   *
   * @returns the derived pact (already registered unless `registerPact: false`).
   */
  public registerPaeToolAdapter(
    adapter: IPaeAdapter,
    opts: { registerPact?: boolean; requireHostMinEdition?: string } = {}
  ): PluginUnitPact {
    this.paeRegistry.register(adapter, makeUniqueMark());
    this.paeChannel.syncTools();
    this.paeAdapterKinds.add(ChannelKind.PAE_TOOL);
    const pact = this.paeRegistry.derivePact(adapter.meta.adapterId, {
      requireHostMinEdition: opts.requireHostMinEdition
    });
    if (opts.registerPact !== false) {
      this.registerPlugin(pact);
    }
    return pact;
  }

  /**
   * Register an adapter whose surface is only knowable *after* a handshake.
   *
   * `registerPaeToolAdapter` resolves the capability surface at registration
   * time, which presupposes that the surface already exists. An MCP server
   * announces its tools over the wire, so there is nothing to resolve until the
   * connection is up. This variant connects first, lets the adapter discover
   * what the peer actually exposes, and then registers exactly that.
   *
   * The handshake is not a governance bypass: registration still runs the same
   * static validation and still derives a dynamic pact from the *discovered*
   * surface, so a server that later announces a new tool is configuration drift
   * on the next replay rather than a silently expanded capability.
   */
  public async connectPaeToolAdapter(
    adapter: IPaeAdapter,
    opts: { registerPact?: boolean; requireHostMinEdition?: string; maxWaitMs?: number } = {}
  ): Promise<PluginUnitPact> {
    if (adapter.setup) {
      await adapter.setup({
        traceMarkId: makeUniqueMark(),
        maxWaitMs: opts.maxWaitMs ?? HOST_DEFAULT_TIMEOUT_MS
      });
    }
    return this.registerPaeToolAdapter(adapter, {
      registerPact: opts.registerPact,
      requireHostMinEdition: opts.requireHostMinEdition
    });
  }

  /**
   * Detach an adapter: its tools stop being dispatchable, its derived pact is
   * revoked, and the routing flag clears once the surface is empty. A trace
   * recorded while it was present then replays as configuration drift, not as
   * a mysterious digest mismatch.
   *
   * Resources held by the adapter are released in the background; use
   * `releasePaeToolAdapter` when you need to wait for that to complete (for
   * example before the process exits, or in a test that asserts a subprocess
   * is gone).
   */
  public unregisterPaeToolAdapter(adapterId: string): void {
    this.paeRegistry.unregister(adapterId);
    this.paeChannel.syncTools();
    this.pluginPactVerifier.unregisterPluginUnit(adapterId);
    this.impactGraph.removeNode(adapterId);
    if (this.paeRegistry.isEmpty()) {
      this.paeAdapterKinds.delete(ChannelKind.PAE_TOOL);
    }
  }

  /**
   * Detach an adapter and await its release.
   *
   * Same as `unregisterPaeToolAdapter`, plus a wait for `teardown` to finish —
   * the difference matters for adapters that own an OS process (MCP), where
   * "unregistered" and "peer actually shut down" are separated by real time.
   */
  public async releasePaeToolAdapter(adapterId: string): Promise<void> {
    this.unregisterPaeToolAdapter(adapterId);
    await this.paeRegistry.drainReleases();
  }

  /**
   * Connect adapters registered after `bootHost`. Idempotent — adapters that
   * are already connected are skipped, so it is safe to call after every batch
   * of registrations.
   */
  public async bootPaeAdapters(): Promise<void> {
    await this.paeRegistry.setupAll({
      traceMarkId: makeUniqueMark(),
      maxWaitMs: HOST_DEFAULT_TIMEOUT_MS
    });
    this.paeChannel.syncTools();
  }

  /**
   * Capability negotiation for a foreign tool: returns the descriptor when the
   * mapping is at least as faithful as required, otherwise throws. Callers make
   * an informed choice instead of silently receiving a degraded result.
   */
  public negotiatePaeTool(toolName: string, minFidelity: PaeFidelity = "full"): PaeToolDescriptor {
    return this.paeRegistry.negotiate(toolName, minFidelity, makeUniqueMark());
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
