import { DeterminismLevel } from "@orbit/infra-common";
import type { ChannelCallCtx } from "@orbit/infra-common";
import type { ChannelRuntimeMeta } from "@orbit/core-hub";
import type { IChannelProvider } from "@orbit/core-hub";
import type { PaeAdapterRegistry } from "./PaeAdapterRegistry";
import type { PaeInvokeCtx } from "./types";

/**
 * The bridge that makes PAE adapters reachable only through the kernel's own
 * plumbing (W15).
 *
 * Rather than inventing a second invocation path for foreign runtimes, the
 * whole adaptation surface is published as ONE capability channel. Each
 * registered tool is installed as a method on this provider, so a foreign call
 * is dispatched exactly like a native one:
 *
 * ```
 * capabilityInvoke(PAE_TOOL, toolName)      // gateway: decision + journal
 *   └── ChannelHub.fireChannelCall           // timeout + capability gate
 *         └── PaeChannel[toolName]           // installed dispatcher
 *               └── registry.invoke          // adapter → foreign runtime
 * ```
 *
 * Three properties fall out of this shape for free, which is the entire reason
 * for choosing it:
 *
 * - the recorded `funcName` is the real tool name, so a trace stays readable
 *   and the input digest has the same meaning as for native calls;
 * - the capability gate can be evaluated per tool (read vs write), so foreign
 *   tools are governed at the same granularity as native methods;
 * - replay is served by the journal before the provider is even consulted, so
 *   replaying a trace needs neither the foreign runtime nor its credentials.
 *
 * Determinism is declared `IO_BOUND` with `inject`: the kernel makes no
 * assumption about a foreign runtime's purity, so the recorded snapshot is
 * always what replay serves.
 */
export class PaeChannel implements IChannelProvider {
  public readonly determinismMeta: ChannelRuntimeMeta = {
    determinism: DeterminismLevel.IO_BOUND,
    replayPolicy: "inject"
  };

  private baseCtx: ChannelCallCtx | null = null;
  /** Tool names currently installed as dispatch methods on this instance. */
  private readonly installed = new Set<string>();

  public constructor(private readonly registry: PaeAdapterRegistry) {}

  public async setup(ctx: ChannelCallCtx): Promise<void> {
    this.baseCtx = ctx;
    await this.registry.setupAll(this.adapterCtx());
    this.syncTools();
  }

  public async teardown(): Promise<void> {
    await this.registry.teardownAll();
    const surface = this.mutableSurface();
    for (const name of this.installed) delete surface[name];
    this.installed.clear();
    this.baseCtx = null;
  }

  /**
   * Reconcile the installed dispatch methods with the registry. Idempotent, so
   * the host may call it after every adapter registration — including after
   * `setup`, since adapters may be added to a running host.
   */
  public syncTools(): void {
    const surface = this.mutableSurface();
    for (const tool of this.registry.listTools()) {
      if (this.installed.has(tool.name)) continue;
      surface[tool.name] = (...args: unknown[]): Promise<unknown> =>
        this.registry.invoke(tool.name, args, this.adapterCtx());
      this.installed.add(tool.name);
    }
    for (const name of [...this.installed]) {
      if (this.registry.lookup(name)) continue;
      delete surface[name];
      this.installed.delete(name);
    }
  }

  /** Tool names currently dispatchable through this channel. */
  public installedTools(): string[] {
    return [...this.installed].sort();
  }

  /**
   * Context handed to adapters. Determinism sources are forwarded from the
   * channel context rather than created here — an adapter must never mint its
   * own randomness or clock (charter axiom A1).
   */
  private adapterCtx(): PaeInvokeCtx {
    const ctx = this.baseCtx;
    return {
      traceMarkId: ctx?.traceMarkId ?? "pae-unbound",
      pluginUnitId: ctx?.pluginUnitId,
      maxWaitMs: ctx?.maxWaitMs ?? 10_000,
      rng: ctx?.rng,
      clock: ctx?.clock
    };
  }

  /**
   * Tool dispatchers are installed as own properties because a tool name is
   * only known at runtime; `ChannelHub` resolves methods by name through the
   * same indexed view. This single cast is the price of that dynamism and is
   * confined to the two lines that manage the property lifecycle.
   */
  private mutableSurface(): Record<string, unknown> {
    return this as unknown as Record<string, unknown>;
  }
}
