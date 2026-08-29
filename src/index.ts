/** Public API surface of Orbit Agent Runtime. */

export { OrbitRuntimeHost } from "./core/orbitRuntimeHost";
export { ChannelHub } from "./channel/ChannelHub";
export type { CapabilityGate } from "./channel/ChannelHub";
export type { IChannelProvider } from "./channel/IChannelProvider";
export { MemoryKvChannel } from "./channel/providers/MemoryKvChannel";
export { LlmMockChannel } from "./channel/providers/LlmMockChannel";
export { OpenAICompatChannel, DeepSeekChannel, LlmChannelFaultError, isRetryableLlmFault } from "./channel/providers/openai_compat_channel";
export type {
  OpenAICompatChannelConfig,
  DeepSeekChannelConfig,
  ChatMessage,
  ChatRoundOptions,
  LlmFaultKind
} from "./channel/providers/openai_compat_channel";
export { FileChannel } from "./channel/providers/FileChannel";
export type { FileChannelConfig, FileStatInfo } from "./channel/providers/FileChannel";
export { ShellChannel } from "./channel/providers/ShellChannel";
export type { ShellChannelConfig, ShellExecResult } from "./channel/providers/ShellChannel";
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
export { saveRecordJournal, loadRecordJournal, TraceFileInvalidError } from "./replay/persistence";
export type { ChannelRuntimeMeta } from "./replay/determinism";

// W7: unified gateway entry (determinism boundary) + its decision types.
// GatewayDecision / RunVersionFingerprint are re-exported from types/orbitDomain.
export { CapabilityGateway } from "./gateway/CapabilityGateway";
export type { GatewayInvokeParams } from "./gateway/CapabilityGateway";
export { RunFingerprintDriftError } from "./gateway/types";
export type { GatewayCheckers } from "./gateway/types";
export type { GatewayCallRecord } from "./replay/record_journal";

export { ImpactDomainGraph } from "./graph/impact_domain";
export { CostRouter } from "./routing/cost_routing";
export type { ChannelCostMeta } from "./routing/cost_routing";

export { digestInputs } from "./utils/digest";

export * from "./types/orbitDomain";
export * from "./core/orbitDomainError";
export * from "./utils/versionIdGen";
