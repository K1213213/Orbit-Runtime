/** Public API surface of Orbit Agent Runtime. */

export { OrbitRuntimeHost } from "./core/orbitRuntimeHost";
export type { OrbitRuntimeHostOptions } from "./core/orbitRuntimeHost";
export { ChannelHub } from "@orbit/core-hub";
export type { CapabilityGate } from "@orbit/core-hub";
export type { IChannelProvider } from "@orbit/core-hub";
export { MemoryKvChannel } from "@orbit/core-hub";
export { LlmMockChannel } from "@orbit/core-hub";
export { OpenAICompatChannel, DeepSeekChannel, LlmChannelFaultError, isRetryableLlmFault } from "@orbit/core-hub";
export type {
  OpenAICompatChannelConfig,
  DeepSeekChannelConfig,
  ChatMessage,
  ChatRoundOptions,
  LlmFaultKind
} from "@orbit/core-hub";
export { FileChannel } from "@orbit/core-hub";
export type { FileChannelConfig, FileStatInfo } from "@orbit/core-hub";
export { ShellChannel } from "@orbit/core-hub";
export type { ShellChannelConfig, ShellExecResult } from "@orbit/core-hub";
export { PluginPactVerifier } from "@orbit/core-hub";
export { TripProtector } from "@orbit/core-hub";
export type { TripSnapshot } from "@orbit/core-hub";
export { PluginSandboxGuard } from "@orbit/core-hub";
export { TraceJournal } from "@orbit/core-hub";
export { AgentSandbox } from "@orbit/sandbox-runtime";
export { SandboxPool } from "@orbit/sandbox-runtime";

// Deliberately NOT exported: SYSTEM_RNG / SYSTEM_CLOCK read Math.random() and
// Date.now() directly (see core-hub/src/replay/injectors.ts). Re-exporting them
// from this facade hands callers a way to feed un-injected entropy into a
// recorded call, which silently breaks determinism — the journal would differ
// between two recordings of the same input. SeededRng / FixedClock are the
// supported, reproducible sources.
export { SeededRng, FixedClock } from "@orbit/core-hub";
export { RecordJournal } from "@orbit/core-hub";
export type { ReplayCallRecord } from "@orbit/core-hub";
export { ReplayEngine, ReplayDriftError } from "@orbit/core-hub";
export type { ReconcileReport } from "@orbit/core-hub";
export { saveRecordJournal, loadRecordJournal, TraceFileInvalidError } from "@orbit/core-hub";
export type { ChannelRuntimeMeta } from "@orbit/core-hub";

// W27: journal durability — append-only WAL substrate, persisted journals and
// the explicit checkpoint/export pair for the audit journal.
export {
  walAppend,
  walCompact,
  walLineCount,
  walRecover,
  walRecoverSync,
  walReset,
  WalFileInvalidError
} from "@orbit/core-hub";
export { PersistedRecordJournal } from "@orbit/core-hub";
export { PersistedTraceJournal } from "@orbit/core-hub";
export { saveTraceJournal, loadTraceJournal } from "@orbit/core-hub";

// W7: unified gateway entry (determinism boundary) + its decision types.
// GatewayDecision / RunVersionFingerprint are re-exported from types/orbitDomain.
export { CapabilityGateway } from "@orbit/core-hub";
export type { GatewayInvokeParams } from "@orbit/core-hub";
export { RunFingerprintDriftError, DecisionDriftError } from "@orbit/core-hub";
export type { GatewayCheckers } from "@orbit/core-hub";
export type { GatewayCallRecord } from "@orbit/core-hub";

// W8: pure-function token budget + context compressor.
export { TokenBudgetEngine, DEFAULT_TOKEN_BUDGET_CONFIG, compressPayload, decompressPayload, isCompressedPayload, packSnapshot } from "@orbit/core-hub";
// W11: pure-function rate limiter + three-mode behavior collector.
export { RateLimiter, DEFAULT_RATE_LIMIT_CONFIG } from "@orbit/core-hub";
export type { RateLimitConfig } from "@orbit/core-hub";
export { BehaviorCollector } from "@orbit/core-hub";
export type { CollectorPhase } from "@orbit/core-hub";
// BehaviorNote is exported via `export * from "@orbit/infra-common"` below.
export type {
  TokenBudgetConfig,
  CompressionLevel,
  BudgetStrategy,
  CompressResult,
  BudgetDecision,
  CompressedPayload
} from "@orbit/core-hub";

// W15: PAE — the plugin adaptation engine (foreign runtimes as channels).
export { PaeAdapterRegistry } from "@orbit/pae-engine";
export type { PaeToolBinding } from "@orbit/pae-engine";
export { PaeChannel } from "@orbit/pae-engine";
export { JsPaeAdapter } from "@orbit/pae-engine";
export type { JsPaeAdapterConfig, JsToolSpec } from "@orbit/pae-engine";
// W16: MCP — the first adapter family that crosses a process boundary.
export { McpPaeAdapter, MCP_DEFAULT_FIDELITY_NOTE } from "@orbit/pae-engine";
export type { McpPaeAdapterConfig, McpToolOverride } from "@orbit/pae-engine";
export { InMemoryMcpTransport, StdioMcpTransport, unwrapResponse } from "@orbit/pae-engine";
export type { IMcpTransport, McpRequestHandler, StdioMcpTransportConfig } from "@orbit/pae-engine";
export {
  MCP_PROTOCOL_VERSION,
  decodeJsonRpc,
  encodeJsonRpc,
  isJsonRpcResponse,
  isRemoteToolError,
  jsonRpcRemoteErrorOf,
  normaliseToolResult,
  parseToolList
} from "@orbit/pae-engine";
export type {
  JsonRpcErrorObject,
  JsonRpcMessage,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
  McpToolDefinition,
  NormalisedToolResult
} from "@orbit/pae-engine";
// W17: OpenAPI — maps a foreign REST API onto the capability contract.
export { OpenApiPaeAdapter, OPENAPI_DEFAULT_FIDELITY_NOTE } from "@orbit/pae-engine";
export type { OpenApiPaeAdapterConfig, OpenApiOperationOverride } from "@orbit/pae-engine";
export { InMemoryHttpTransport, FetchHttpTransport } from "@orbit/pae-engine";
export type {
  IHttpTransport,
  HttpRequest,
  HttpResponse,
  HttpHandler,
  FetchHttpTransportOptions
} from "@orbit/pae-engine";
export { parseOpenApiDocument, resolveDocumentBaseUrl, buildHttpRequest, normaliseHttpResponse, isHttpSuccess, bodyTail } from "@orbit/pae-engine";
export type {
  OpenApiOperation,
  OpenApiParameter,
  ParsedOpenApiDocument,
  NormalisedHttpResponse
} from "@orbit/pae-engine";
// W18: Cordis — a host-defined protocol to an isolated plugin instance (L2).
export { CordisPaeAdapter, CORDIS_DEFAULT_FIDELITY_NOTE } from "@orbit/pae-engine";
export type { CordisPaeAdapterConfig, CordisToolOverride } from "@orbit/pae-engine";
export { InMemoryCordisTransport, ChildProcessCordisTransport, unwrapCordisResponse } from "@orbit/pae-engine";
export type {
  ICordisTransport,
  CordisRequestHandler,
  ChildProcessCordisTransportConfig
} from "@orbit/pae-engine";
export {
  CORDIS_PROTOCOL_VERSION,
  decodeFrame,
  encodeFrame,
  isCordisResponse,
  normaliseCordisToolResult,
  parseCordisToolList,
  cordisRemoteErrorOf,
  // Back-compatible alias: `remoteErrorOf` was the Cordis-specific helper
  // before the protocol families were given qualified names at the package
  // boundary. Kept so 0.2.x consumers do not break on the rename.
  cordisRemoteErrorOf as remoteErrorOf
} from "@orbit/pae-engine";
export type {
  CordisErrorObject,
  CordisRequest,
  CordisResponse,
  CordisToolDefinition,
  NormalisedCordisResult
} from "@orbit/pae-engine";
// W19: isolation domains — graph-driven L2 subprocess allocation (VISION 2.3).
export {
  allocateDomains,
  impactClosureSizes
} from "@orbit/sandbox-runtime";
export type {
  AllocateOptions,
  DomainIsolationLevel,
  IsolationDomainPlan,
  IsolationDomainSpec
} from "@orbit/sandbox-runtime";
export { IsolationDomain } from "@orbit/sandbox-runtime";
export type { DomainHostInfo, DomainInvokeCtx, IsolationDomainConfig } from "@orbit/sandbox-runtime";
export { IsolationDomainManager } from "@orbit/sandbox-runtime";
export type { DomainTransportFactory, IsolationDomainManagerOptions } from "@orbit/sandbox-runtime";
export { DomainChannel } from "@orbit/sandbox-runtime";
export { InMemoryDomainTransport, ChildProcessDomainTransport, unwrapDomainResponse } from "@orbit/sandbox-runtime";
export type {
  IDomainTransport,
  DomainRequestHandler,
  ChildProcessDomainTransportConfig
} from "@orbit/sandbox-runtime";
export {
  DOMAIN_PROTOCOL_VERSION,
  decodeDomainFrame,
  encodeDomainFrame,
  isDomainResponse,
  normaliseDomainResult,
  parseUnitList,
  domainRemoteErrorOf
} from "@orbit/sandbox-runtime";
export type {
  DomainErrorObject,
  DomainRequest,
  DomainResponse,
  DomainToolDefinition,
  DomainUnitDefinition,
  NormalisedDomainResult
} from "@orbit/sandbox-runtime";
export { DOMAIN_HOST_SHIM, DOMAIN_HOST_VERSION } from "@orbit/sandbox-runtime";
export { DomainRemoteError, DomainUnitMissingError } from "@orbit/sandbox-runtime";
// W20: cross-domain transactions — decision + execution + result + audit.
export {
  beginTransaction,
  markExecuted,
  newTxnId,
  reconcileTransactions,
  settleTransaction,
  ledgerHash,
  stableHash
} from "@orbit/sandbox-runtime";
export type {
  BeginTransactionInput,
  DomainPairBalance,
  DomainReconciliation,
  DomainTransaction,
  DomainTxnDecision,
  DomainTxnState,
  SettlementOutcome
} from "@orbit/sandbox-runtime";
export {
  PaeAdapterRejectError,
  PaeToolMissingError,
  PaeFidelityRejectError,
  PaeRemoteError,
  FIDELITY_RANK
} from "@orbit/pae-engine";
export type {
  IPaeAdapter,
  PaeAdapterKind,
  PaeAdapterMeta,
  PaeFidelity,
  PaeInvokeCtx,
  PaeIsolationLevel,
  PaeToolDescriptor
} from "@orbit/pae-engine";

export { ImpactDomainGraph } from "@orbit/sandbox-runtime";
export { CostRouter } from "@orbit/core-hub";
export type { ChannelCostMeta } from "@orbit/core-hub";

export { digestInputs } from "@orbit/infra-common";

export * from "@orbit/infra-common";
export * from "@orbit/infra-common";
export * from "@orbit/infra-common";
