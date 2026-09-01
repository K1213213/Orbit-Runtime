import { ChannelHub } from "@orbit/core-hub";
import { MemoryKvChannel } from "@orbit/core-hub";
import { LlmMockChannel } from "@orbit/core-hub";
import { TraceJournal, PersistedTraceJournal } from "@orbit/core-hub";
import { PluginSandboxGuard } from "@orbit/core-hub";
import { PluginPactVerifier } from "@orbit/core-hub";
import { SandboxPool } from "@orbit/sandbox-runtime";
import { ImpactDomainGraph } from "@orbit/sandbox-runtime";
import { CostRouter } from "@orbit/core-hub";
import { RecordJournal, PersistedRecordJournal } from "@orbit/core-hub";
import { ReplayEngine } from "@orbit/core-hub";
import { makeUniqueMark } from "@orbit/infra-common";
import { KERNEL_VERSION } from "@orbit/infra-common";
import { CapabilityGateway } from "@orbit/core-hub";
import { TokenBudgetEngine, DEFAULT_TOKEN_BUDGET_CONFIG } from "@orbit/core-hub";
import { RateLimiter, DEFAULT_RATE_LIMIT_CONFIG } from "@orbit/core-hub";
import { BehaviorCollector } from "@orbit/core-hub";
import { PaeAdapterRegistry } from "@orbit/pae-engine";
import { PaeChannel } from "@orbit/pae-engine";
import type { IPaeAdapter, PaeFidelity, PaeToolDescriptor } from "@orbit/pae-engine";
import type { GatewayInvokeParams } from "@orbit/core-hub";
import type { GatewayCheckers } from "@orbit/core-hub";
import { tripThresholdForProfile, tokenBudgetConfigForProfile } from "@orbit/core-hub";
import { verifyAuditChain } from "@orbit/core-hub";
import type { AuditChainReport } from "@orbit/core-hub";
import type { AgentSandbox } from "@orbit/sandbox-runtime";
import {
  ChannelKind, ChannelCallCtx, PluginUnitPact, AgentBoxConfig, CapabilityKey, ReplayMode
} from "@orbit/infra-common";
import {
  resolveGovernanceProfile,
  governanceProfileHash,
  type GovernanceProfile,
  type GovernanceProfileName
} from "@orbit/infra-common";
import type { RunVersionFingerprint } from "@orbit/infra-common";
import type { ClockSource } from "@orbit/infra-common";
// W20: the physical layer becomes host state.
import { IsolationDomainManager } from "@orbit/sandbox-runtime";
import { DomainChannel } from "@orbit/sandbox-runtime";
import type { DomainTransportFactory } from "@orbit/sandbox-runtime";
import type { IsolationDomainPlan } from "@orbit/sandbox-runtime";
import type { DomainInvokeCtx } from "@orbit/sandbox-runtime";
import type { DomainReconciliation, DomainTransaction } from "@orbit/sandbox-runtime";

const HOST_DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Durability options. When a path is supplied the corresponding journal is
 * mirrored to an append-only write-ahead log on disk and recovered on the next
 * boot, so a restart does not lose the audit trail or the recorded run. Omitting
 * a path (the default) keeps the journal purely in-memory — the original
 * behavior, and what every existing test relies on.
 */
export interface OrbitRuntimeHostOptions {
  /** Durable audit/behavior journal (trace) WAL path. */
  traceJournalPath?: string;
  /** Durable recording-window journal WAL path (recovered on boot). */
  recordJournalPath?: string;
  /**
   * Wall-clock source for every time-dependent decision that reaches a recorded
   * value (trip cooldown, channel TTLs). Injecting a frozen clock makes a
   * recording window reproducible; omitting it keeps the real clock, which is
   * the previous behaviour.
   */
  clock?: ClockSource;
  /**
   * Retention bound for the durable audit journal: keep at most this many
   * newest entries. An append-only audit log that grows without limit
   * eventually fills the disk, and a full disk is an outage — so the bound is
   * explicit and operator-chosen rather than an implicit default. Applied at
   * boot (after recovery) and at shutdown. Omit for unbounded retention.
   */
  auditRetention?: number;
  /**
   * W29: governance tier (VISION §3.1). `standard` is the default and resolves
   * to the kernel's pre-W29 numbers verbatim. `sandbox` disables token
   * compression, widens rate limits, admits every PAE adapter kind and keeps
   * the trace in memory. `strict` narrows rate limits, trips earlier, compresses
   * aggressively, admits NO foreign adapters and REQUIRES a durable trace path
   * (construction fails without one). The profile name is hashed into the run
   * fingerprint, so a trace recorded under one tier refuses to replay under
   * another (`RunFingerprintDriftError`).
   */
  governanceProfile?: GovernanceProfileName;
  /**
   * W30: HMAC-SHA256 signing key for the audit hash chain (VISION §3.1's
   * "落盘 + 签名"). When provided, every audit entry is linked with
   * `prevHash`/`chainHash` and `host.verifyAuditChain()` can prove the trail
   * has not been tampered with. Without a key the journal records no chain
   * fields at all (pre-W30 behaviour). The `strict` governance tier REQUIRES
   * a signing key — a compliance tier must be able to prove its audit trail.
   */
  auditSigningKey?: string;
}

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
  /**
   * W20: the physical layer — isolation domains allocated from the impact
   * graph. Created lazily: a host that never allocates domains keeps its
   * previous hub surface and fingerprint byte for byte.
   */
  private domainManager: IsolationDomainManager | null = null;
  /** W20: the gateway surface over the domain manager's units. */
  private domainChannel: DomainChannel | null = null;
  /** W20: the graph changed since the last allocation (plan needs a re-sync). */
  private domainsStaleFlag = false;
  /** W27: durable recording-window journal WAL path, if configured. */
  private readonly recordJournalPath?: string;
  /** Injected clock, threaded to every time-dependent decision that is recorded. */
  private readonly clock?: ClockSource;
  /** W27: the recording window currently attached to the gateway (for flush). */
  private activeRecordJournal: RecordJournal | null = null;
  /**
   * W27: the same instance as {@link traceJournal}, held at its durable type.
   * `traceJournal` stays declared as the base class on purpose — call sites must
   * not depend on durability — so retention/compaction needs its own handle.
   */
  private readonly durableTraceJournal: PersistedTraceJournal;
  /** W27: audit retention bound; undefined means unbounded. */
  private readonly auditRetention?: number;
  /** W29: resolved governance tier; drives limiter / trip / compression / PAE / durability. */
  private readonly governanceProfile: GovernanceProfile;
  /** W30: HMAC key for the audit hash chain; undefined = unsigned journal. */
  private readonly auditSigningKey?: string;

  public constructor(opts?: OrbitRuntimeHostOptions) {
    this.recordJournalPath = opts?.recordJournalPath;
    this.clock = opts?.clock;
    this.governanceProfile = resolveGovernanceProfile(opts?.governanceProfile);
    // A compliance tier with an ephemeral audit trail is a contradiction in
    // terms: fail at construction, not at the first reboot.
    if (
      this.governanceProfile.traceDurability === "required" &&
      !opts?.traceJournalPath
    ) {
      throw new Error(
        "governance profile 'strict' requires traceJournalPath — a compliance tier must have a durable audit trail"
      );
    }
    // W30: strict also requires the ability to PROVE the trail. The signing
    // key is what turns an append-only file into a tamper-evident one.
    if (this.governanceProfile.name === "strict" && !opts?.auditSigningKey) {
      throw new Error(
        "governance profile 'strict' requires auditSigningKey — a compliance tier must sign its audit chain"
      );
    }
    this.auditSigningKey = opts?.auditSigningKey;
    if (opts?.auditRetention !== undefined) {
      if (!Number.isInteger(opts.auditRetention) || opts.auditRetention < 0) {
        throw new RangeError(
          `auditRetention expects a non-negative integer, received ${String(opts.auditRetention)}`
        );
      }
      this.auditRetention = opts.auditRetention;
    }
    this.costRouter = new CostRouter();
    this.tokenBudget = new TokenBudgetEngine(tokenBudgetConfigForProfile(this.governanceProfile));
    this.rateLimiter = new RateLimiter({
      maxCallsPerWindow: this.governanceProfile.limiter.maxCallsPerWindow,
      windowSizeCalls: this.governanceProfile.limiter.windowSizeCalls
    });
    this.behaviorCollector = new BehaviorCollector();
    this.paeRegistry = new PaeAdapterRegistry();
    this.paeChannel = new PaeChannel(this.paeRegistry);
    this.channelHub = new ChannelHub();
    this.durableTraceJournal = new PersistedTraceJournal(opts?.traceJournalPath, this.auditSigningKey);
    this.traceJournal = this.durableTraceJournal;
    this.impactGraph = new ImpactDomainGraph();
    this.pluginPactVerifier = new PluginPactVerifier();
    this.pluginSandboxGuard = new PluginSandboxGuard(
      this.traceJournal,
      // W29: the trip threshold comes from the profile, softened by the
      // plugin's dependency out-degree (see tripThresholdForProfile).
      (pluginId) => tripThresholdForProfile(this.governanceProfile, this.impactGraph.outDegree(pluginId)),
      opts?.clock
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
      fingerprint: () => this.runFingerprint(),
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
    this.gateway = new CapabilityGateway(this.channelHub, checkers, opts?.clock);
    // W11: collectors/hooks live inside the gateway; attach the host-owned one.
    this.gateway.attachCollector(this.behaviorCollector);

    this.channelHub.registerBuiltInChannel(ChannelKind.MEM_KV_STORE, new MemoryKvChannel(this.clock));
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
    if (kind === ChannelKind.DOMAIN_TOOL) {
      // W20: a domain hop is a cross-process call into another unit's process.
      // The capability is not yet declared per unit tool, so the conservative
      // default governs — the same fail-closed rule the adapter surface uses.
      return "channel:write";
    }
    return requiredCapability(kind, funcName);
  }

  /** Host-private trip pre-check delegating to the gateway's per-plugin map. */
  private tripPreCheckFor(pluginId: string): boolean {
    return this.gateway.tripPreCheck(pluginId);
  }

  /**
   * The run-version fingerprint a recorded trace carries (W7, extended W15/W20).
   *
   * Both optional fields are **omitted rather than empty**: a host that never
   * registers an adapter or allocates a domain produces exactly the fingerprint
   * it produced before those layers existed, so a trace recorded on an older
   * kernel is reported as configuration drift — never as a mystery digest
   * mismatch.
   */
  public runFingerprint(): RunVersionFingerprint {
    return {
      kernelVersion: KERNEL_VERSION,
      pactVersions: {},
      tokenConfigHash: this.tokenBudget.configHash(),
      paeEnabled: this.paeAdapterKinds.size > 0,
      ...(this.paeRegistry.isEmpty() ? {} : { paeAdaptersHash: this.paeRegistry.configHash() }),
      ...(this.domainManager?.planOf() ? { domainPlanHash: this.domainManager.planHash() } : {}),
      // W29: only a NON-default tier is a fingerprint surface. `standard` is
      // omitted so a default host keeps its pre-W29 fingerprint byte for byte
      // (backward-compat rule: new hash fields are omitted, never empty).
      ...(this.governanceProfile.name === "standard"
        ? {}
        : { governanceProfileHash: governanceProfileHash(this.governanceProfile) })
    };
  }

  /**
   * W29: the resolved governance tier and its concrete numbers. Read-only —
   * the tier is a construction-time decision; switching it means constructing
   * a host with `governanceProfile`.
   */
  public get currentGovernanceProfile(): GovernanceProfile {
    return this.governanceProfile;
  }

  public async bootHost(): Promise<void> {
    // W27: recover durable journals *before* anything can append. A missing file
    // is normal (first boot) and leaves the journal empty; an existing file
    // replays its entries so the audit trail survives the restart. Recovery
    // rebuilds the whole chain, so it must precede channel setup — otherwise
    // setup-time audit entries would be overwritten by the recovered snapshot.
    await this.traceJournal.load();
    // W30: a compliance tier starts only against a PROVABLE audit trail. A
    // chain that fails verification after recovery means the log was edited
    // while the host was down — a strict tier refuses to run on it.
    if (this.governanceProfile.name === "strict" && this.auditSigningKey) {
      const report = this.verifyAuditChain();
      if (!report.consistent) {
        throw new Error(
          `governance profile 'strict' refuses to boot: audit chain broken at entry #${report.brokenAt} ` +
            `(${report.brokenReason})`
        );
      }
    }
    // Apply the retention bound to whatever the previous run left behind, before
    // this run starts appending. Compaction also physically removes a tail that
    // a crash truncated (recovery merely ignores it), so the log is well-formed
    // again from the first append of the new run.
    await this.pruneAuditLog();
    await this.channelHub.setupAllBuiltInChannels(this.newHostCtx());
    if (this.recordJournalPath) {
      await this.resumeRecording();
    }
  }

  /**
   * W30: prove the audit trail has not been tampered with. Recomputes the
   * hash chain from the genesis seed and reports the first broken entry.
   * An unsigned journal (no key configured) reports `signed: false` and is
   * vacuously consistent.
   */
  public verifyAuditChain(): AuditChainReport {
    if (!this.auditSigningKey) {
      return { consistent: true, total: this.traceJournal.entries().length, signed: false };
    }
    return verifyAuditChain(this.traceJournal.entries(), this.auditSigningKey);
  }

  /**
   * W27: enforce the configured audit-retention bound and compact the WAL.
   *
   * Called automatically at boot and shutdown; exposed so an operator can prune
   * a long-running host on demand without a restart.
   *
   * @returns the number of audit entries retained.
   */
  public async pruneAuditLog(): Promise<number> {
    if (this.auditRetention === undefined) {
      return this.traceJournal.entries().length;
    }
    return this.durableTraceJournal.retainLast(this.auditRetention);
  }

  /** Reverse-order teardown: pool -> pact -> guards -> channels -> journal -> graph. */
  public async shutdownHost(): Promise<void> {
    // W27: drain any pending WAL writes before tearing components down, so the
    // last recorded calls/audit entries are not lost on a clean shutdown.
    //
    // A drain that loses a write now reports it (see PersistedRecordJournal),
    // but the teardown below must still run to completion: aborting here would
    // leak every child process and foreign adapter the host owns. So the flush
    // failure is carried and re-raised only after the release is done — the
    // caller gets the signal *and* a clean process.
    let drainError: unknown = null;
    try {
      await this.activeRecordJournal?.flush();
    } catch (err) {
      drainError = err;
    }
    try {
      await this.traceJournal.flush();
    } catch (err) {
      drainError ??= err;
    }
    // Bound the log *at rest*: flush first so nothing pending is lost, then
    // apply retention. Order matters — pruning before the flush would let the
    // drained writes push the file back over the bound.
    await this.pruneAuditLog();
    this.sandboxPool.clear();
    this.pluginPactVerifier.clear();
    this.pluginSandboxGuard.releaseAllGuard();
    // W20: release the physical layer before the hubs — every domain host is a
    // real child process and must not outlive the kernel that spawned it.
    await this.releaseIsolationDomains();
    await this.channelHub.teardown();
    // Channel teardown already released every adapter (PaeChannel.teardown);
    // dropping the registry afterwards leaves no dangling foreign surface.
    this.paeRegistry.clear();
    this.traceJournal.clear();
    this.impactGraph.clear();
    if (drainError !== null) throw drainError;
  }

  // Facade -----------------------------------------------------------

  /** Register a plugin; its declared channel deps feed the impact graph (M3). */
  public registerPlugin(pact: PluginUnitPact): void {
    this.pluginPactVerifier.registerPluginUnit(pact, makeUniqueMark());
    this.impactGraph.addNode(pact.id);
    for (const dep of pact.declareChannelDeps ?? []) {
      this.impactGraph.addEdge(pact.id, dep);
    }
    // W20: the graph feeds domain allocation — a change invalidates the plan.
    this.domainsStaleFlag = true;
  }

  /** Spawn an agent sandbox; its channel deps feed the impact graph (M3). */
  public spawnAgentBox(cfg: AgentBoxConfig): AgentSandbox {
    const box = this.sandboxPool.spawnSandbox(cfg);
    this.impactGraph.addNode(cfg.agentBoxId);
    for (const dep of cfg.channelDeps ?? []) {
      this.impactGraph.addEdge(cfg.agentBoxId, dep);
    }
    // W20: same invalidation rule as `registerPlugin`.
    this.domainsStaleFlag = true;
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
    // W29: the governance tier admits adapter kinds explicitly. `strict`
    // admits none — a compliance tier has no foreign-runtime surface at all.
    this.assertPaeKindAdmitted(adapter.meta.kind);
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
   * W29: the governance gate for foreign adapters. `sandbox` admits every
   * kind; `standard` admits the documented set (js + mcp); `strict` admits
   * none. The check runs before any handshake or registration, so a denied
   * adapter is rejected outright rather than half-connected.
   */
  private assertPaeKindAdmitted(kind: string): void {
    const admission = this.governanceProfile.paeAdmission;
    if (admission === "all") return;
    if (admission.includes(kind)) return;
    throw new Error(
      `governance profile '${this.governanceProfile.name}' does not admit PAE adapter kind '${kind}' ` +
        `(admitted: ${admission.length === 0 ? "none" : admission.join(", ")})`
    );
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
    // W29: gate BEFORE the handshake — a denied kind must not spawn a child
    // process just to be rejected (registerPaeToolAdapter re-checks).
    this.assertPaeKindAdmitted(adapter.meta.kind);
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
    // W20: removing a node can shrink closures, so the plan must be recomputed.
    this.domainsStaleFlag = true;
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

  /**
   * M2: open a recording window; sandboxes running in "record" mode fill it.
   *
   * W27: when the host was constructed with `recordJournalPath`, the window is
   * durable — every recorded call is mirrored to the WAL. Opening a *new* window
   * truncates that WAL first (a fresh window must not inherit the previous
   * run's calls); use {@link resumeRecording} to continue a prior window instead.
   */
  public beginRecording(): RecordJournal {
    const journal = this.recordJournalPath
      ? new PersistedRecordJournal(this.recordJournalPath, { truncate: true })
      : new RecordJournal();
    this.activeRecordJournal = journal;
    this.channelHub.attachRecordJournal(journal);
    this.gateway.attachJournal(journal);
    return journal;
  }

  /**
   * W27: reopen the durable recording window persisted by a previous process.
   *
   * Recovers the WAL (crash-safe: a truncated trailing line is dropped) and
   * re-attaches it, so `orderIndex` continues from the recovered length and the
   * combined journal replays as one uninterrupted run. Without a configured
   * `recordJournalPath` this degrades to a plain in-memory window.
   */
  public async resumeRecording(): Promise<RecordJournal> {
    if (!this.recordJournalPath) return this.beginRecording();
    const journal = await PersistedRecordJournal.recover(this.recordJournalPath);
    // Heal the file before the resumed window appends to it: a crash-truncated
    // tail would otherwise sit in the *interior* once the next line lands, and an
    // invalid interior line is a hard fault. No-op when the log is healthy.
    await journal.healIfNeeded();
    this.activeRecordJournal = journal;
    this.channelHub.attachRecordJournal(journal);
    this.gateway.attachJournal(journal);
    return journal;
  }

  /**
   * W27: the recording window currently attached to the gateway, or `null` if
   * none was ever opened. After a boot with `recordJournalPath` configured this
   * is the journal recovered from the WAL, so callers can inspect or replay a
   * window persisted by a previous process without reopening it.
   */
  public currentRecordJournal(): RecordJournal | null {
    return this.activeRecordJournal;
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

  /* ------------------------------------------------------------------ */
  /* W20 · 图驱动域分配与域间事务化调用                                  */
  /* ------------------------------------------------------------------ */

  /** Whether the impact graph changed since the last domain allocation. */
  public domainsStale(): boolean {
    return this.domainsStaleFlag;
  }

  /**
   * Allocate isolation domains from the current impact graph and publish their
   * unit surface on the gateway (W19 channel, W20 host state).
   *
   * Idempotent for a given graph: the sync is a diff, so re-running after a
   * no-op graph change neither restarts child processes nor perturbs the plan
   * hash. Registering the channel happens here and only here — a host that
   * never allocates domains keeps its previous hub surface and fingerprint.
   */
  public async allocateIsolationDomains(
    opts: {
      transportFactory?: DomainTransportFactory;
      clock?: ClockSource;
      maxImpactClosure?: number;
      maxDomainSize?: number;
      defaultTimeoutMs?: number;
    } = {}
  ): Promise<IsolationDomainPlan> {
    let manager = this.domainManager;
    if (!manager) {
      manager = new IsolationDomainManager({
        transportFactory: opts.transportFactory,
        clock: opts.clock,
        defaultTimeoutMs: opts.defaultTimeoutMs,
        maxImpactClosure: opts.maxImpactClosure,
        maxDomainSize: opts.maxDomainSize
      });
      const channel = new DomainChannel(manager);
      this.domainManager = manager;
      this.domainChannel = channel;
      this.channelHub.registerBuiltInChannel(ChannelKind.DOMAIN_TOOL, channel);
      // A domain hop is a cross-process call: priced and timed like the
      // adaptation surface, so budget routing sees the real cost.
      this.costRouter.register(ChannelKind.DOMAIN_TOOL, { costPerCall: 2, latencyMs: 40, quality: 1 });
    }
    const plan = await manager.syncDomains(this.impactGraph, this.domainCtx(), opts);
    this.domainChannel?.syncTools();
    this.domainsStaleFlag = false;
    return plan;
  }

  /** The current domain plan, or `null` before the first allocation. */
  public domainPlan(): IsolationDomainPlan | null {
    return this.domainManager?.planOf() ?? null;
  }

  /** Running domains: id, units and isolation level, sorted. */
  public domains(): Array<{ domainId: string; units: string[]; isolation: string }> {
    return this.domainManager?.domainsOf() ?? [];
  }

  /**
   * Invoke a unit in its domain through the gateway — the cross-domain hop.
   * Recorded and replayed like any other governed call; settled in the domain
   * transaction ledger either way.
   */
  public invokeDomainUnit<T>(
    unitId: string,
    tool: string,
    args: unknown[] = [],
    opts: { pluginUnitId?: string; mode?: ReplayMode; ctx?: Partial<ChannelCallCtx> } = {}
  ): Promise<T> {
    return this.gateway.capabilityInvoke<T>({
      kind: ChannelKind.DOMAIN_TOOL,
      pluginId: opts.pluginUnitId,
      funcName: `${unitId}:${tool}`,
      args,
      mode: opts.mode ?? "live",
      ctx: opts.ctx
    } as GatewayInvokeParams);
  }

  /** The cross-domain transaction ledger (decision → execution → result). */
  public domainLedger(): readonly DomainTransaction[] {
    return this.domainManager?.txnLedger() ?? [];
  }

  /** Reconcile the ledger — cross-domain events must balance (VISION 2.2). */
  public reconcileDomainTransactions(): DomainReconciliation {
    return this.domainManager
      ? this.domainManager.reconcile()
      : {
          balanced: true,
          pairs: [],
          orphans: [],
          rejected: [],
          totals: { transactions: 0, settled: 0, failed: 0, rejected: 0 }
        };
  }

  /** Tear down every domain and release its host process. */
  public async releaseIsolationDomains(): Promise<void> {
    if (!this.domainManager) return;
    const manager = this.domainManager;
    this.domainManager = null;
    this.domainChannel = null;
    this.domainsStaleFlag = false;
    await manager.teardownAll();
  }

  /** Context for domain synchronization calls. */
  private domainCtx(): DomainInvokeCtx {
    const ctx = this.newHostCtx();
    return { traceMarkId: ctx.traceMarkId, maxWaitMs: ctx.maxWaitMs };
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
