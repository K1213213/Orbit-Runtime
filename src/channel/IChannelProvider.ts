import type { ChannelCallCtx } from "../types/orbitDomain";

/**
 * 能力通道提供者接口
 * 所有通道实现强制实现初始化与资源销毁生命周期
 */
export interface IChannelProvider {
  /** 宿主启动阶段执行一次，完成通道资源初始化 */
  setup(ctx: ChannelCallCtx): Promise<void>;
  /** 宿主停止阶段执行，释放IO、定时器、缓存全部资源 */
  teardown(): Promise<void>;
}
