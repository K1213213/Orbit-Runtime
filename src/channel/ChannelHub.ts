import { ChannelCallFaultError } from "../core/orbitDomainError";
import { IChannelProvider } from "./IChannelProvider";
import { ChannelKind, ChannelCallCtx } from "../types/orbitDomain";

/**
 * 插件能力裁决函数：返回插件是否拥有对指定通道指定方法的调用权限。
 * 由宿主在装配期注入（pact 层在 channel 层之上，channel 层不反向依赖 pact 层）。
 */
export type CapabilityGate = (pluginUnitId: string, kind: ChannelKind, funcName: string) => boolean;

/**
 * 通道集线器：注册、注销、调度全部能力通道；超时截断、上下文管理、插件能力裁决
 * 内部容器全部私有；对外返回副本，避免外部篡改宿主内部状态
 */
export class ChannelHub {
  private readonly builtInChannelMap = new Map<ChannelKind, IChannelProvider>();
  private readonly pluginExtChannelMap = new Map<ChannelKind, IChannelProvider>();
  private readonly callContextPool = new Map<string, ChannelCallCtx>();
  private capabilityGate: CapabilityGate | null = null;

  /** 宿主装配期注入插件能力裁决器（不持有 pact 层引用，保持分层单向依赖） */
  public attachCapabilityGate(gate: CapabilityGate): void {
    this.capabilityGate = gate;
  }

  /** 注册宿主内置通道，禁止重复注册 */
  public registerBuiltInChannel(kind: ChannelKind, provider: IChannelProvider): void {
    if (this.builtInChannelMap.has(kind)) {
      throw new ChannelCallFaultError(`Built‑in channel [${kind}] already occupied`);
    }
    this.builtInChannelMap.set(kind, provider);
  }

  /** 注册插件扩展通道，允许覆盖 */
  public registerPluginExtChannel(kind: ChannelKind, provider: IChannelProvider): void {
    this.pluginExtChannelMap.set(kind, provider);
  }

  public removeExtChannel(kind: ChannelKind): void {
    this.pluginExtChannelMap.delete(kind);
  }

  /** 优先取插件扩展通道，无扩展则回退内置通道 */
  public getEffectiveChannel(kind: ChannelKind): IChannelProvider | undefined {
    if (this.pluginExtChannelMap.has(kind)) {
      return this.pluginExtChannelMap.get(kind);
    }
    return this.builtInChannelMap.get(kind);
  }

  public saveCallContext(ctxKey: string, ctx: ChannelCallCtx): void {
    this.callContextPool.set(ctxKey, ctx);
  }

  public pickCallContext(ctxKey: string): ChannelCallCtx | undefined {
    return this.callContextPool.get(ctxKey);
  }

  public dropCallContext(ctxKey: string): void {
    this.callContextPool.delete(ctxKey);
  }

  public listAllCallContextCopy(): ChannelCallCtx[] {
    return Array.from(this.callContextPool.values());
  }

  /**
   * 带超时保护调用通道方法
   */
  public async fireChannelCall<T>(
    kind: ChannelKind,
    ctx: ChannelCallCtx,
    funcName: string,
    ...inputArgs: unknown[]
  ): Promise<T> {
    const provider = this.getEffectiveChannel(kind);
    if (!provider) {
      throw new ChannelCallFaultError(`Channel [${kind}] is not available`, ctx.traceMarkId, ctx.pluginUnitId);
    }
    if (ctx.pluginUnitId && this.capabilityGate && !this.capabilityGate(ctx.pluginUnitId, kind, funcName)) {
      throw new ChannelCallFaultError(
        `Plugin [${ctx.pluginUnitId}] lacks declared capability for channel [${kind}]`,
        ctx.traceMarkId,
        ctx.pluginUnitId
      );
    }
    const targetFunc = (provider as unknown as Record<string, (...p: unknown[]) => Promise<T>>)[funcName];
    if (typeof targetFunc !== "function") {
      throw new ChannelCallFaultError(`Function ${funcName} not exist on channel ${kind}`, ctx.traceMarkId, ctx.pluginUnitId);
    }

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutGuard = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(new ChannelCallFaultError(`Channel call exceed maxWaitMs ${ctx.maxWaitMs}ms`, ctx.traceMarkId, ctx.pluginUnitId));
      }, ctx.maxWaitMs);
    });
    try {
      return await Promise.race([targetFunc.apply(provider, inputArgs), timeoutGuard]);
    } finally {
      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  /** 调用失败执行降级回退逻辑 */
  public async fireChannelCallWithFallback<T>(
    kind: ChannelKind,
    ctx: ChannelCallCtx,
    funcName: string,
    fallbackHandler: () => Promise<T>,
    ...inputArgs: unknown[]
  ): Promise<T> {
    try {
      return await this.fireChannelCall<T>(kind, ctx, funcName, ...inputArgs);
    } catch {
      return fallbackHandler();
    }
  }

  /** 宿主启动：批量setup全部内置通道 */
  public async setupAllBuiltInChannels(baseCtx: ChannelCallCtx): Promise<void> {
    for (const prov of this.builtInChannelMap.values()) {
      await prov.setup(baseCtx);
    }
  }

  /** 销毁全部通道，清空上下文池 */
  public async teardown(): Promise<void> {
    for (const prov of this.builtInChannelMap.values()) {
      await prov.teardown();
    }
    for (const prov of this.pluginExtChannelMap.values()) {
      await prov.teardown();
    }
    this.builtInChannelMap.clear();
    this.pluginExtChannelMap.clear();
    this.callContextPool.clear();
  }
}
