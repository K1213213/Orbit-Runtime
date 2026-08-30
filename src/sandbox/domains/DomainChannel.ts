import { DeterminismLevel } from "../../types/orbitDomain";
import type { ChannelCallCtx } from "../../types/orbitDomain";
import type { ChannelRuntimeMeta } from "../../replay/determinism";
import type { IChannelProvider } from "../../channel/IChannelProvider";
import type { IsolationDomainManager } from "./IsolationDomainManager";
import type { DomainInvokeCtx } from "./IsolationDomain";

/**
 * The bridge that makes isolation-domain units reachable only through the
 * kernel's own plumbing (W19).
 *
 * Exactly the same shape as `PaeChannel`: the whole physical-layer surface is
 * published as ONE capability channel. Each unit tool is installed as a method
 * named `${unitId}:${tool}` (unit ids are globally unique — the allocation
 * plan is a partition of the graph — so tool names cannot collide), and a call
 * travels:
 *
 * ```
 * capabilityInvoke(DOMAIN_TOOL, "echo:sum")      // gateway: decision + journal
 *   └── ChannelHub.fireChannelCall               // timeout + capability gate
 *         └── DomainChannel["echo:sum"]          // installed dispatcher
 *               └── manager.invokeUnit           // domain → host process
 * ```
 *
 * Replay is served by the journal before the provider is consulted, so
 * replaying a trace needs neither the domain host nor the child process.
 * Determinism is declared `IO_BOUND` with `inject`, like every cross-process
 * surface.
 */
export class DomainChannel implements IChannelProvider {
  public readonly determinismMeta: ChannelRuntimeMeta = {
    determinism: DeterminismLevel.IO_BOUND,
    replayPolicy: "inject"
  };

  private baseCtx: ChannelCallCtx | null = null;
  /** Tool names currently installed as dispatch methods on this instance. */
  private readonly installed = new Set<string>();

  public constructor(private readonly manager: IsolationDomainManager) {}

  public async setup(ctx: ChannelCallCtx): Promise<void> {
    this.baseCtx = ctx;
    this.syncTools();
  }

  public async teardown(): Promise<void> {
    await this.manager.teardownAll();
    const surface = this.mutableSurface();
    for (const name of this.installed) delete surface[name];
    this.installed.clear();
    this.baseCtx = null;
  }

  /**
   * Reconcile the installed dispatch methods with the manager's current unit
   * surface. Idempotent; call after `syncDomains`.
   */
  public syncTools(): void {
    const surface = this.mutableSurface();
    const valid = new Set<string>();
    for (const { unitId, tool } of this.manager.surface()) {
      const toolName = `${unitId}:${tool}`;
      valid.add(toolName);
      if (this.installed.has(toolName)) continue;
      surface[toolName] = (...args: unknown[]): Promise<unknown> =>
        this.manager.invokeUnit(unitId, tool, args, this.domainCtx());
      this.installed.add(toolName);
    }
    for (const name of [...this.installed]) {
      if (valid.has(name)) continue;
      delete surface[name];
      this.installed.delete(name);
    }
  }

  /** Tool names currently dispatchable through this channel, sorted. */
  public installedTools(): string[] {
    return [...this.installed].sort();
  }

  /* ---------------------------------------------------------------- */

  private domainCtx(): DomainInvokeCtx {
    const ctx = this.baseCtx;
    return {
      traceMarkId: ctx?.traceMarkId ?? "domain-unbound",
      maxWaitMs: ctx?.maxWaitMs ?? 10_000,
      rng: ctx?.rng,
      clock: ctx?.clock
    };
  }

  private mutableSurface(): Record<string, unknown> {
    return this as unknown as Record<string, unknown>;
  }
}
