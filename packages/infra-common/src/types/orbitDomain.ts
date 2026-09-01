/** Global domain contracts for the Orbit runtime kernel. */

export type TraceMarkId = string;
export type PluginUnitId = string;
export type AgentBoxId = string;

/** Built-in capability channel kinds. */
export enum ChannelKind {
  MEM_KV_STORE = "mem-kv-store",
  LLM_ACCESS = "llm-access",
  /** W1: real filesystem access jailed to a root directory. */
  FILE_SYSTEM = "file-system",
  /** W2: real command execution behind a command whitelist. */
  SHELL_EXEC = "shell-exec",
  /**
   * W15: the PAE adaptation surface. Foreign runtimes (JS / MCP / OpenAPI /
   * Cordis) are published as tools on this single channel so every
   * heterogeneous call travels the gateway → hub path and lands in the journal.
   */
  PAE_TOOL = "pae-tool",
  /**
   * W19: the isolation-domain surface. Units hosted in L2 child-process domains
   * (graph-driven allocation) are published here; every call is an IO_BOUND
   * gateway transaction like any other cross-process call.
   */
  DOMAIN_TOOL = "domain-tool"
}

/** Determinism level declared by a channel (the replay contract). */
export enum DeterminismLevel {
  /** Pure function: same input always yields the same output. */
  DETERMINISTIC = "deterministic",
  /** Contains randomness; needs a seed injected via ctx.rng. */
  STOCHASTIC = "stochastic",
  /** Touches external state; needs its output snapshot injected on replay. */
  IO_BOUND = "io-bound"
}

/**
 * The gateway's recorded decision snapshot for a single capability call.
 * Captured at record time and RESTORED (never recomputed) on replay, so the
 * governance decision becomes part of the reproducible trace.
 */
export interface GatewayDecision {
  /** Whether the trip protector allowed the call up front. */
  tripAllowed: boolean;
  /** Whether the plugin's declared pact covered the invoked capability. */
  pactPass: boolean;
  /** Token-budget decision for the call (allow / shrink / stop). */
  budget: { allow: boolean; strategy: "normal" | "shrink" | "stop" };
  /**
   * Context-compression policy recorded for the call. `applied` reflects
   * whether the stored output snapshot was actually compressed at rest (a
   * storage optimization, transparent to the consumer); `bytesSaved` is the
   * measured saving when `applied` is true.
   */
  compression: { level: "conservative" | "normal" | "aggressive"; applied: boolean; bytesSaved?: number };
  /** Routing decision: native channel vs PAE adapter. */
  route: "native" | "pae";
  /** Whether the call was rate-limited at record time. */
  rateLimited: boolean;
}

/** Configuration fingerprint recorded with each call to detect config drift. */
export interface RunVersionFingerprint {
  kernelVersion: string;
  /** pluginId -> pact version, so old traces stay distinguishable. */
  pactVersions: Record<string, string>;
  /** Hash of token-budget / compression thresholds. */
  tokenConfigHash: string;
  paeEnabled: boolean;
  /**
   * W15: hash of the registered PAE adaptation surface (adapter identities,
   * editions, isolation levels and tool contracts). Optional so traces recorded
   * before the adaptation engine existed stay replayable; when present, a
   * changed surface is reported as configuration drift rather than surfacing
   * later as an unexplained digest mismatch.
   */
  paeAdaptersHash?: string;
  /**
   * W20: hash of the allocated isolation-domain plan (domain ids plus their
   * units). Optional for the same reason as `paeAdaptersHash`: a host that
   * never allocates domains keeps the exact fingerprint it had before the
   * physical layer existed, so old traces stay replayable.
   */
  domainPlanHash?: string;
  /**
   * W29: hash of the resolved governance tier (VISION §3.1). Optional for the
   * same reason as the other hash fields: a `standard` host — the default —
   * keeps the exact pre-W29 fingerprint, and only a non-default tier
   * (`sandbox` / `strict`) becomes a config-drift surface. Present means "this
   * trace was recorded under a tier whose governance numbers must be identical
   * on replay".
   */
  governanceProfileHash?: string;
}

/**
 * Structured observation of a single governed call, gathered by the
 * BehaviorCollector (W11). Captures the governance decisions that actually
 * applied so they can be audited, replayed, or used to seed online governance
 * tuning. Pure data — no behavior of its own.
 */
export interface BehaviorNote {
  channelKind: string;
  funcName: string;
  pluginId?: string;
  /** Routing that served the call. */
  route: "native" | "pae";
  compression: { level: "conservative" | "normal" | "aggressive"; applied: boolean; bytesSaved: number };
  budget: { allow: boolean; strategy: "normal" | "shrink" | "stop" };
  /** Whether the call was rate-limited at record time. */
  rateLimited: boolean;
  /** Estimated tokens of a string output (omitted for non-string outputs). */
  tokensEstimated?: number;
  /** Which collector phase produced this note. */
  recordedAtMode: "record" | "live";
}

/** Execution mode of a channel call. */
export type ReplayMode = "live" | "record" | "replay";

/** Injectable random source; channels must not call Math.random directly. */
export interface RngSource {
  /** Uniform pseudo-random number in [0, 1). */
  next(): number;
}

/** Injectable clock; channels must not call Date.now directly. */
export interface ClockSource {
  now(): number;
}

/** Per-call context; every channel call must carry one. */
export interface ChannelCallCtx {
  traceMarkId: TraceMarkId;
  agentBoxId?: AgentBoxId;
  pluginUnitId?: PluginUnitId;
  maxWaitMs: number;
  /** M2: determinism injection for record/replay. */
  replayMode?: ReplayMode;
  rng?: RngSource;
  clock?: ClockSource;
}

/** One trace journal entry. */
export interface TraceJournalEntry {
  entryUid: string;
  entryClass: string;
  occurredAt: number;
  traceMarkId: TraceMarkId;
  pluginUnitId?: PluginUnitId;
  agentBoxId?: AgentBoxId;
  factPayload: Record<string, unknown>;
  /**
   * W30: hash-chain linkage (audit integrity). Present only when the journal
   * was constructed with a signing key. `prevHash` is the previous entry's
   * `chainHash` (or the genesis seed for the first entry); `chainHash` is
   * HMAC-SHA256(key, prevHash + canonical entry content). Optional per the
   * backward-compat rule: entries recorded without a key carry no chain
   * fields, so old journals stay byte-identical and replay untouched.
   */
  prevHash?: string;
  chainHash?: string;
}

/** Capabilities a plugin unit may declare. */
export type CapabilityKey = "channel:read" | "channel:write";

/** Plugin manifest: identity, edition compatibility and declared capabilities. */
export interface PluginUnitPact {
  id: PluginUnitId;
  displayName: string;
  edition: string;
  requireHostMinEdition: string;
  allowCapabilities: CapabilityKey[];
  /** M3: channels this plugin depends on, feeding the impact domain graph. */
  declareChannelDeps?: ChannelKind[];
}

/** Agent sandbox configuration. */
export interface AgentBoxConfig {
  agentBoxId: AgentBoxId;
  boxAlias: string;
  baseInstruct: string;
  maxCycleRun: number;
  /** M2: execution mode used to build the per-call context. */
  replayMode?: ReplayMode;
  /** M3: channels this sandbox consumes, feeding the impact domain graph. */
  channelDeps?: ChannelKind[];
  /** M4: abstract cost budget per reasoning cycle. */
  budgetPerCycle?: number;
}

/** Trip protector state. */
export enum TripState {
  NORMAL = "normal",
  TRIPPED = "tripped",
  PROBE = "probe"
}
