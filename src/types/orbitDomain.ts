/** Global domain contracts for the Orbit runtime kernel. */

export type TraceMarkId = string;
export type PluginUnitId = string;
export type AgentBoxId = string;

/** Built-in capability channel kinds. */
export enum ChannelKind {
  MEM_KV_STORE = "mem-kv-store",
  LLM_ACCESS = "llm-access"
}

/** Per-call context; every channel call must carry one. */
export interface ChannelCallCtx {
  traceMarkId: TraceMarkId;
  agentBoxId?: AgentBoxId;
  pluginUnitId?: PluginUnitId;
  maxWaitMs: number;
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
}

/** Agent sandbox configuration. */
export interface AgentBoxConfig {
  agentBoxId: AgentBoxId;
  boxAlias: string;
  baseInstruct: string;
  maxCycleRun: number;
}

/** Trip protector state. */
export enum TripState {
  NORMAL = "normal",
  TRIPPED = "tripped",
  PROBE = "probe"
}
