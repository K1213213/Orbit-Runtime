/** Public API surface of Orbit Agent Runtime. */

export { OrbitRuntimeHost } from "./core/orbitRuntimeHost";
export { ChannelHub } from "./channel/ChannelHub";
export type { CapabilityGate } from "./channel/ChannelHub";
export type { IChannelProvider } from "./channel/IChannelProvider";
export { MemoryKvChannel } from "./channel/providers/MemoryKvChannel";
export { LlmMockChannel } from "./channel/providers/LlmMockChannel";
export { DeepSeekChannel } from "./channel/providers/deepseek_channel";
export type { DeepSeekChannelConfig } from "./channel/providers/deepseek_channel";
export { PluginPactVerifier } from "./pact/PluginPactVerifier";
export { TripProtector } from "./safeguard/TripProtector";
export type { TripSnapshot } from "./safeguard/TripProtector";
export { PluginSandboxGuard } from "./safeguard/PluginSandboxGuard";
export { TraceJournal } from "./trace/TraceJournal";
export { AgentSandbox } from "./sandbox/AgentSandbox";
export { SandboxPool } from "./sandbox/SandboxPool";

export { SeededRng, FixedClock, SYSTEM_RNG, SYSTEM_CLOCK } from "./replay/injectors";
export { RecordJournal } from "./replay/record_journal";
export type { ReplayCallRecord } from "./replay/record_journal";
export { ReplayEngine, ReplayDriftError } from "./replay/replay_engine";
export type { ReconcileReport } from "./replay/replay_engine";
export type { ChannelRuntimeMeta } from "./replay/determinism";

export { ImpactDomainGraph } from "./graph/impact_domain";
export { CostRouter } from "./routing/cost_routing";
export type { ChannelCostMeta } from "./routing/cost_routing";

export { digestInputs } from "./utils/digest";

export * from "./types/orbitDomain";
export * from "./core/orbitDomainError";
export * from "./utils/versionIdGen";
