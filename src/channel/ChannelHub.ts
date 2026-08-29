import { ChannelCallFaultError } from "../core/orbitDomainError";
import { IChannelProvider } from "./IChannelProvider";
import { digestInputs } from "../utils/digest";
import { ChannelKind, ChannelCallCtx } from "../types/orbitDomain";
import type { ReplayEngine } from "../replay/replay_engine";
import type { RecordJournal } from "../replay/record_journal";

/** Injected by the host: decides whether a plugin may invoke a channel method. */
export type CapabilityGate = (pluginUnitId: string, kind: ChannelKind, funcName: string) => boolean;

/**
 * Central registry and dispatcher for capability channels.
 *
 * Plugin channels take precedence over built-ins. Every call is bounded by a
 * timeout; plugin-originated calls are additionally checked against the
 * capability gate (kept as an injected function so this layer never depends
 * on the pact layer above it).
 *
 * Record/replay: when a ReplayEngine is attached and the call context requests
 * replay mode, the call is served from the recorded journal with zero real
 * execution; in record mode the call output is appended to the journal.
 */
export class ChannelHub {
  private readonly builtInChannelMap = new Map<ChannelKind, IChannelProvider>();
  private readonly pluginExtChannelMap = new Map<ChannelKind, IChannelProvider>();
  private readonly callContextPool = new Map<string, ChannelCallCtx>();
  private capabilityGate: CapabilityGate | null = null;
  private replayEngine: ReplayEngine | null = null;
  private recordJournal: RecordJournal | null = null;
  private callCounter = 0;

  public attachCapabilityGate(gate: CapabilityGate): void {
    this.capabilityGate = gate;
  }

  /**
   * Attach the replay engine that serves "replay" mode calls. Attaching an
   * engine starts a new replay session: the replay order counter is reset so
   * a second pass over the same journal starts from call #0 again.
   */
  public attachReplayEngine(engine: ReplayEngine): void {
    this.replayEngine = engine;
    this.callCounter = 0;
  }

  /** Attach the journal that "record" mode calls are appended to. */
  public attachRecordJournal(journal: RecordJournal): void {
    this.recordJournal = journal;
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
    // Governance first: the capability gate applies to replayed calls too —
    // replay never bypasses declared capabilities.
    if (ctx.pluginUnitId && this.capabilityGate && !this.capabilityGate(ctx.pluginUnitId, kind, funcName)) {
      throw new ChannelCallFaultError(
        `plugin ${ctx.pluginUnitId} lacks capability for channel ${kind}`,
        ctx.traceMarkId,
        ctx.pluginUnitId
      );
    }

    // Replay fast path: serve the recorded output, never execute the channel.
    // Deliberately checked BEFORE provider availability — replaying a trace
    // must not require the real channel (or its credentials/tools) to be
    // installed on the replaying machine.
    if (ctx.replayMode === "replay" && this.replayEngine) {
      const orderIndex = this.callCounter++;
      const output = this.replayEngine.replayCall(kind, funcName, digestInputs(...inputArgs), orderIndex);
      this.recordCall(kind, funcName, digestInputs(...inputArgs), output, 0);
      return output as T;
    }

    const provider = this.getEffectiveChannel(kind);
    if (!provider) {
      throw new ChannelCallFaultError(`channel ${kind} is not available`, ctx.traceMarkId, ctx.pluginUnitId);
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

    const startedAt = Date.now();
    try {
      const output = await Promise.race([method.apply(provider, inputArgs), deadline]);
      if (ctx.replayMode === "record") {
        this.recordCall(kind, funcName, digestInputs(...inputArgs), output, Date.now() - startedAt);
      }
      return output as T;
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
    this.callCounter = 0;
  }

  private recordCall(kind: ChannelKind, funcName: string, inputDigest: string, output: unknown, durationMs: number): void {
    if (!this.recordJournal) return;
    this.recordJournal.append({
      channelKind: kind,
      funcName,
      inputDigest,
      outputSnapshot: structuredClone(output),
      durationMs
    });
  }
}
