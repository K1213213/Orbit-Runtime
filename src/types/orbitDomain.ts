/**
 * Orbit‑Agent‑Host 领域契约定义
 * 第二阶段定稿：链路、插件、沙箱、通道、防护状态全部类型
 */

export type TraceMarkId = string;
export type PluginUnitId = string;
export type AgentBoxId = string;

/**
 * 系统能力通道分类枚举
 */
export enum ChannelKind {
  MEM_KV_STORE = "mem‑kv‑store",
  LLM_ACCESS = "llm‑access"
}

/**
 * 通道调用上下文，每一次跨组件通道调用必须透传
 */
export interface ChannelCallCtx {
  traceMarkId: TraceMarkId;
  agentBoxId?: AgentBoxId;
  pluginUnitId?: PluginUnitId;
  maxWaitMs: number;
}

/**
 * 轨迹日志条目，替代通用KernelEvent
 */
export interface TraceJournalEntry {
  entryUid: string;
  entryClass: string;
  occurredAt: number;
  traceMarkId: TraceMarkId;
  pluginUnitId?: PluginUnitId;
  agentBoxId?: AgentBoxId;
  factPayload: Record<string, unknown>;
}

/**
 * 插件单元描述规约 manifest
 */
export interface PluginUnitPact {
  id: PluginUnitId;
  displayName: string;
  edition: string;
  requireHostMinEdition: string;
  allowCapabilities: Array<"channel:write" | "channel:read" | "sandbox:spawn">;
}

/**
 * Agent沙箱启动配置
 */
export interface AgentBoxConfig {
  agentBoxId: AgentBoxId;
  boxAlias: string;
  baseInstruct: string;
  maxCycleRun: number;
}

/**
 * 跳闸保护器状态（原熔断器状态）
 */
export enum TripState {
  NORMAL = "normal",
  TRIPPED = "tripped",
  PROBE = "probe"
}
