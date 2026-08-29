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
  SHELL_EXEC = "shell-exec"
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
