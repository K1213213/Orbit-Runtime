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
export { RunFingerprintDriftError, DecisionDriftError } from "./gateway/types";
export type { GatewayCheckers } from "./gateway/types";
export type { GatewayCallRecord } from "./replay/record_journal";

// W8: pure-function token budget + context compressor.
export { TokenBudgetEngine, DEFAULT_TOKEN_BUDGET_CONFIG, compressPayload, decompressPayload, isCompressedPayload, packSnapshot } from "./gateway/TokenBudgetEngine";
// W11: pure-function rate limiter + three-mode behavior collector.
export { RateLimiter, DEFAULT_RATE_LIMIT_CONFIG } from "./gateway/RateLimiter";
export type { RateLimitConfig } from "./gateway/RateLimiter";
export { BehaviorCollector } from "./gateway/BehaviorCollector";
export type { CollectorPhase } from "./gateway/BehaviorCollector";
// BehaviorNote is exported via `export * from "./types/orbitDomain"` below.
export type {
  TokenBudgetConfig,
  CompressionLevel,
  BudgetStrategy,
  CompressResult,
  BudgetDecision,
  CompressedPayload
} from "./gateway/TokenBudgetEngine";

// W15: PAE — the plugin adaptation engine (foreign runtimes as channels).
export { PaeAdapterRegistry } from "./pae/PaeAdapterRegistry";
export type { PaeToolBinding } from "./pae/PaeAdapterRegistry";
export { PaeChannel } from "./pae/PaeChannel";
export { JsPaeAdapter } from "./pae/adapters/JsPaeAdapter";
export type { JsPaeAdapterConfig, JsToolSpec } from "./pae/adapters/JsPaeAdapter";
// W16: MCP — the first adapter family that crosses a process boundary.
export { McpPaeAdapter, MCP_DEFAULT_FIDELITY_NOTE } from "./pae/adapters/mcp/McpPaeAdapter";
export type { McpPaeAdapterConfig, McpToolOverride } from "./pae/adapters/mcp/McpPaeAdapter";
export { InMemoryMcpTransport, StdioMcpTransport, unwrapResponse } from "./pae/adapters/mcp/transport";
export type { IMcpTransport, McpRequestHandler, StdioMcpTransportConfig } from "./pae/adapters/mcp/transport";
export {
  MCP_PROTOCOL_VERSION,
  decodeJsonRpc,
  encodeJsonRpc,
  isJsonRpcResponse,
  isRemoteToolError,
  normaliseToolResult,
  parseToolList
} from "./pae/adapters/mcp/protocol";
export type {
  JsonRpcErrorObject,
  JsonRpcMessage,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
  McpToolDefinition,
  NormalisedToolResult
} from "./pae/adapters/mcp/protocol";
// W17: OpenAPI — maps a foreign REST API onto the capability contract.
export { OpenApiPaeAdapter, OPENAPI_DEFAULT_FIDELITY_NOTE } from "./pae/adapters/openapi/OpenApiPaeAdapter";
export type { OpenApiPaeAdapterConfig, OpenApiOperationOverride } from "./pae/adapters/openapi/OpenApiPaeAdapter";
export { InMemoryHttpTransport, FetchHttpTransport } from "./pae/adapters/openapi/transport";
export type {
  IHttpTransport,
  HttpRequest,
  HttpResponse,
  HttpHandler,
  FetchHttpTransportOptions
} from "./pae/adapters/openapi/transport";
export { parseOpenApiDocument, buildHttpRequest, normaliseHttpResponse, isHttpSuccess, bodyTail } from "./pae/adapters/openapi/spec";
export type {
  OpenApiOperation,
  OpenApiParameter,
  ParsedOpenApiDocument,
  NormalisedHttpResponse
} from "./pae/adapters/openapi/spec";
// W18: Cordis — a host-defined protocol to an isolated plugin instance (L2).
export { CordisPaeAdapter, CORDIS_DEFAULT_FIDELITY_NOTE } from "./pae/adapters/cordis/CordisPaeAdapter";
export type { CordisPaeAdapterConfig, CordisToolOverride } from "./pae/adapters/cordis/CordisPaeAdapter";
export { InMemoryCordisTransport, ChildProcessCordisTransport, unwrapCordisResponse } from "./pae/adapters/cordis/transport";
export type {
  ICordisTransport,
  CordisRequestHandler,
  ChildProcessCordisTransportConfig
} from "./pae/adapters/cordis/transport";
export {
  CORDIS_PROTOCOL_VERSION,
  decodeFrame,
  encodeFrame,
  isCordisResponse,
  normaliseCordisToolResult,
  parseCordisToolList,
  remoteErrorOf
} from "./pae/adapters/cordis/protocol";
export type {
  CordisErrorObject,
  CordisRequest,
  CordisResponse,
  CordisToolDefinition,
  NormalisedCordisResult
} from "./pae/adapters/cordis/protocol";
export {
  PaeAdapterRejectError,
  PaeToolMissingError,
  PaeFidelityRejectError,
  PaeRemoteError,
  FIDELITY_RANK
} from "./pae/types";
export type {
  IPaeAdapter,
  PaeAdapterKind,
  PaeAdapterMeta,
  PaeFidelity,
  PaeInvokeCtx,
  PaeIsolationLevel,
  PaeToolDescriptor
} from "./pae/types";

export { ImpactDomainGraph } from "./graph/impact_domain";
export { CostRouter } from "./routing/cost_routing";
export type { ChannelCostMeta } from "./routing/cost_routing";

export { digestInputs } from "./utils/digest";

export * from "./types/orbitDomain";
export * from "./core/orbitDomainError";
export * from "./utils/versionIdGen";
