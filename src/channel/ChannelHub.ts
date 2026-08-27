import { ChannelCallFaultError } from "../core/orbitDomainError";
import { IChannelProvider } from "./IChannelProvider";
import { ChannelKind, ChannelCallCtx } from "../types/orbitDomain";

/** Injected by the host: decides whether a plugin may invoke a channel method. */
export type CapabilityGate = (pluginUnitId: string, kind: ChannelKind, funcName: string) => boolean;

/**
 * Central registry and dispatcher for capability channels.
 *
 * Plugin channels take precedence over built-ins. Every call is bounded by a
 * timeout; plugin-originated calls are additionally checked against the
 * capability gate (kept as an injected function so this layer never depends
 * on the pact layer above it).
 */
export class ChannelHub {
  private readonly builtInChannelMap = new Map<ChannelKind, IChannelProvider>();
  private readonly pluginExtChannelMap = new Map<ChannelKind, IChannelProvider>();
  private readonly callContextPool = new Map<string, ChannelCallCtx>();
  private capabilityGate: CapabilityGate | null = null;

  public attachCapabilityGate(gate: CapabilityGate): void {
    this.capabilityGate = gate;
  }

  public registerBuiltInChannel(kind: ChannelKind, provider: IChannelProvider): void {
    if (this.builtInChannelMap.has(kind)) {
      throw new ChannelCallFaultError(`built-in channel ${kind} already registered`);
    }
    this.builtInChannelMap.set(kind, provider);
  }

  /** Register a plugin-provided channel; overrides the built-in of the same kind. */
  public registerPluginExtChannel(kind: ChannelKind, provider: IChannelProvider): void {
    this.pluginExtChannelMap.set(kind, provider);
  }

  public removeExtChannel(kind: ChannelKind): void {
    this.pluginExtChannelMap.delete(kind);
  }

  public getEffectiveChannel(kind: ChannelKind): IChannelProvider | undefined {
    return this.pluginExtChannelMap.get(kind) ?? this.builtInChannelMap.get(kind);
  }

  public saveCallContext(key: string, ctx: ChannelCallCtx): void {
    this.callContextPool.set(key, ctx);
  }

  public getCallContext(key: string): ChannelCallCtx | undefined {
    return this.callContextPool.get(key);
  }

  public deleteCallContext(key: string): void {
    this.callContextPool.delete(key);
  }

  public listCallContexts(): ChannelCallCtx[] {
    return Array.from(this.callContextPool.values());
  }

  /**
   * Invoke a channel method under timeout protection.
   *
   * Method dispatch is intentionally dynamic: plugin channels may expose
   * method names the host cannot know at compile time.
   */
  public async fireChannelCall<T>(
    kind: ChannelKind,
    ctx: ChannelCallCtx,
    funcName: string,
    ...inputArgs: unknown[]
  ): Promise<T> {
    const provider = this.getEffectiveChannel(kind);
    if (!provider) {
      throw new ChannelCallFaultError(`channel ${kind} is not available`, ctx.traceMarkId, ctx.pluginUnitId);
    }
    if (ctx.pluginUnitId && this.capabilityGate && !this.capabilityGate(ctx.pluginUnitId, kind, funcName)) {
      throw new ChannelCallFaultError(
        `plugin ${ctx.pluginUnitId} lacks capability for channel ${kind}`,
        ctx.traceMarkId,
        ctx.pluginUnitId
      );
    }

    const method = (provider as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>)[funcName];
    if (typeof method !== "function") {
      throw new ChannelCallFaultError(`method ${funcName} not found on channel ${kind}`, ctx.traceMarkId, ctx.pluginUnitId);
    }

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(new ChannelCallFaultError(`channel call exceeded ${ctx.maxWaitMs}ms`, ctx.traceMarkId, ctx.pluginUnitId));
      }, ctx.maxWaitMs);
    });

    try {
      return (await Promise.race([method.apply(provider, inputArgs), deadline])) as T;
    } finally {
      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  /** Invoke with a fallback handler used when the primary call fails. */
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

  /** Host startup: setup all built-in channels. */
  public async setupAllBuiltInChannels(baseCtx: ChannelCallCtx): Promise<void> {
    for (const provider of this.builtInChannelMap.values()) {
      await provider.setup(baseCtx);
    }
  }

  /** Tear down every channel and drop all pooled call contexts. */
  public async teardown(): Promise<void> {
    for (const provider of this.builtInChannelMap.values()) {
      await provider.teardown();
    }
    for (const provider of this.pluginExtChannelMap.values()) {
      await provider.teardown();
    }
    this.builtInChannelMap.clear();
    this.pluginExtChannelMap.clear();
    this.callContextPool.clear();
  }
}
