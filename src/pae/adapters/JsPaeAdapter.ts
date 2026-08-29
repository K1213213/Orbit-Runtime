import { DeterminismLevel } from "../../types/orbitDomain";
import { PaeAdapterRejectError, PaeToolMissingError } from "../types";
import type { CapabilityKey } from "../../types/orbitDomain";
import type {
  IPaeAdapter,
  PaeAdapterMeta,
  PaeFidelity,
  PaeInvokeCtx,
  PaeIsolationLevel,
  PaeToolDescriptor
} from "../types";

/** A single in-process tool implementation. */
export interface JsToolSpec {
  name: string;
  /** Capability the caller must hold; defaults to `channel:read`. */
  capability?: CapabilityKey;
  /**
   * Replay contract. Defaults to `IO_BOUND` — the conservative choice, since a
   * JS handler may well touch the outside world. Declare `DETERMINISTIC` only
   * for genuinely pure handlers.
   */
  determinism?: DeterminismLevel;
  /**
   * Mapping fidelity. Defaults to `full`: a JS handler runs in the kernel's own
   * language and value space, so nothing is lost in translation. A handler that
   * *does* degrade something must say so and explain it.
   */
  fidelity?: PaeFidelity;
  fidelityNote?: string;
  description?: string;
  /**
   * The implementation. Randomness and time must come from `ctx.rng` /
   * `ctx.clock`; reaching for `Math.random` or `Date.now` breaks replay.
   */
  handler: (args: unknown[], ctx: PaeInvokeCtx) => unknown | Promise<unknown>;
}

export interface JsPaeAdapterConfig {
  adapterId: string;
  /** Semver edition of the tool bundle; enters the pact and the fingerprint. */
  sourceEdition?: string;
  /** In-process by nature; overridable for hosts that add their own guarding. */
  isolation?: PaeIsolationLevel;
  tools: JsToolSpec[];
}

/**
 * JS adapter — the first and simplest PAE family (W15).
 *
 * It adapts plain in-process JavaScript/TypeScript functions, which makes it
 * the reference implementation of the adapter contract: no transport, no
 * serialization, no protocol negotiation, so the only thing it demonstrates is
 * the *contract itself* (declare a surface, map it faithfully, execute nothing
 * the gateway has not authorized).
 *
 * Because the foreign side is the same process, fidelity is `full` by default
 * and isolation is `L0`. Isolation is a property of the adapter, not of the
 * kernel: L2 (subprocess) arrives as a separate adapter family without changing
 * a line of the gateway.
 */
export class JsPaeAdapter implements IPaeAdapter {
  public readonly meta: PaeAdapterMeta;
  private readonly tools = new Map<string, JsToolSpec>();

  public constructor(config: JsPaeAdapterConfig) {
    if (!config?.adapterId) {
      throw new PaeAdapterRejectError("js pae adapter requires an adapterId");
    }
    if (!Array.isArray(config.tools) || config.tools.length === 0) {
      throw new PaeAdapterRejectError(`js pae adapter ${config.adapterId} requires at least one tool`, undefined, config.adapterId);
    }
    this.meta = {
      adapterId: config.adapterId,
      kind: "js",
      sourceEdition: config.sourceEdition ?? "1.0.0",
      isolation: config.isolation ?? "L0"
    };
    for (const spec of config.tools) {
      if (typeof spec?.handler !== "function") {
        throw new PaeAdapterRejectError(
          `js pae tool ${String(spec?.name)} has no handler`,
          undefined,
          config.adapterId
        );
      }
      if (this.tools.has(spec.name)) {
        throw new PaeAdapterRejectError(
          `js pae adapter ${config.adapterId} declares tool ${spec.name} twice`,
          undefined,
          config.adapterId
        );
      }
      this.tools.set(spec.name, spec);
    }
  }

  /** Static surface, sorted by name so the derived hash is order-independent. */
  public describe(): PaeToolDescriptor[] {
    return [...this.tools.values()]
      .map((spec) => ({
        name: spec.name,
        capability: spec.capability ?? "channel:read",
        determinism: spec.determinism ?? DeterminismLevel.IO_BOUND,
        fidelity: spec.fidelity ?? "full",
        description: spec.description,
        fidelityNote: spec.fidelityNote
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  public async invoke(toolName: string, args: unknown[], ctx: PaeInvokeCtx): Promise<unknown> {
    const spec = this.tools.get(toolName);
    if (!spec) {
      throw new PaeToolMissingError(
        `js pae adapter ${this.meta.adapterId} has no tool ${toolName}`,
        ctx.traceMarkId,
        this.meta.adapterId
      );
    }
    return spec.handler(args, ctx);
  }
}
