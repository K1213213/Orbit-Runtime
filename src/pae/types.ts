import { OrbitDomainError } from "../core/orbitDomainError";
import type {
  CapabilityKey,
  ClockSource,
  DeterminismLevel,
  PluginUnitId,
  RngSource,
  TraceMarkId
} from "../types/orbitDomain";

/**
 * PAE — Plugin Adaptation Engine (W15).
 *
 * The adaptation layer that maps *foreign* runtimes (in-process JS, MCP
 * servers, OpenAPI endpoints, Cordis instances) onto the kernel's capability
 * contract. Two architectural laws govern everything in this directory:
 *
 * 1. **Adapters never talk to the kernel directly.** A registered adapter is
 *    surfaced as a capability channel (`PaeChannel`), so every foreign call
 *    travels `capabilityInvoke → ChannelHub → adapter` and therefore lands in
 *    the `RecordJournal` with its governance decision attached. There is no
 *    side door: an adapter that bypassed the gateway would produce a trace
 *    with a missing call number, which the replay cursor rejects.
 *
 * 2. **Adapters introduce no nondeterminism of their own.** Randomness and
 *    clocks arrive through the injected `PaeInvokeCtx` (`RngSource` /
 *    `ClockSource`); `Math.random` and `Date.now` are charter violations. The
 *    foreign side is treated as `IO_BOUND` by default, so replay injects the
 *    recorded snapshot instead of re-executing it.
 *
 * Capability negotiation is explicit rather than silent: an adapter that cannot
 * map a foreign tool losslessly must SAY so via `fidelity`, and callers may
 * demand a minimum fidelity (VISION §3.2 mechanism 1 — informed choice, never a
 * silent feature drop).
 */

/**
 * How faithfully an adapter maps a foreign capability onto the kernel contract.
 *
 * - `full`    — semantics preserved end to end; nothing is dropped.
 * - `reduced` — the capability works but part of its surface is unavailable
 *               (e.g. streaming collapsed into a single response).
 * - `lossy`   — the result itself may differ from the native one (e.g. a
 *               best-effort type coercion).
 *
 * Anything other than `full` MUST carry a `fidelityNote`; the registry rejects
 * an undocumented downgrade so callers can never be surprised.
 */
export type PaeFidelity = "full" | "reduced" | "lossy";

/** Families of foreign runtime the engine adapts (W15 ships `js`). */
export type PaeAdapterKind = "js" | "mcp" | "openapi" | "cordis";

/**
 * Physical isolation the adapter executes under (VISION §2.3 double isolation).
 * `L0` in-process, `L1` in-process with a guarded surface, `L2` separate OS
 * process. Logical isolation (the impact-domain closure) is orthogonal and
 * always applies.
 */
export type PaeIsolationLevel = "L0" | "L1" | "L2";

/** One foreign tool, described in kernel terms. */
export interface PaeToolDescriptor {
  /**
   * Tool name as exposed through the channel. This becomes the `funcName` of
   * the recorded call, so it must be unique across all registered adapters and
   * must not collide with the channel interface itself.
   */
  name: string;
  /** Capability the caller must hold to invoke it (drives the pact check). */
  capability: CapabilityKey;
  /** Replay contract of the underlying tool. */
  determinism: DeterminismLevel;
  /** Fidelity of the foreign → kernel mapping. */
  fidelity: PaeFidelity;
  /** Human-readable purpose (used by docs and the negotiation report). */
  description?: string;
  /** Mandatory when `fidelity !== "full"`: what exactly is reduced or lossy. */
  fidelityNote?: string;
}

/** Identity and provenance of an adapter, hashed into the run fingerprint. */
export interface PaeAdapterMeta {
  adapterId: string;
  kind: PaeAdapterKind;
  /** Version/edition of the foreign runtime behind the adapter. */
  sourceEdition: string;
  isolation: PaeIsolationLevel;
}

/**
 * Per-call context handed to an adapter. Mirrors `ChannelCallCtx` minus the
 * fields an adapter has no business seeing. Determinism sources are injected —
 * an adapter that reaches for `Math.random` / `Date.now` breaks axiom A1.
 */
export interface PaeInvokeCtx {
  traceMarkId: TraceMarkId;
  pluginUnitId?: PluginUnitId;
  maxWaitMs: number;
  rng?: RngSource;
  clock?: ClockSource;
}

/**
 * The adapter contract. Implementations are pure translation layers: they own
 * the connection to the foreign runtime and nothing else — no governance, no
 * recording, no budget. Those live in the gateway, above the channel.
 */
export interface IPaeAdapter {
  readonly meta: PaeAdapterMeta;
  /**
   * Full static capability surface, resolved once at registration time so that
   * runtime lookups stay O(1) (VISION §3.2 mechanism 2).
   */
  describe(): PaeToolDescriptor[];
  /** Invoke a foreign tool. Must reject unknown names with `PaeToolMissingError`. */
  invoke(toolName: string, args: unknown[], ctx: PaeInvokeCtx): Promise<unknown>;
  /** Optional connection setup (spawn a process, open a socket, ...). */
  setup?(ctx: PaeInvokeCtx): Promise<void>;
  /** Optional resource release; called during channel teardown. */
  teardown?(): Promise<void>;
}

/** An adapter failed registration-time static validation. */
export class PaeAdapterRejectError extends OrbitDomainError {
  public constructor(message: string, traceMarkId?: string, adapterId?: string) {
    super(message, "PAE_ADAPTER_REJECT", traceMarkId, adapterId);
  }
}

/** A tool name is not present in any registered adapter. */
export class PaeToolMissingError extends OrbitDomainError {
  public constructor(message: string, traceMarkId?: string, adapterId?: string) {
    super(message, "PAE_TOOL_MISSING", traceMarkId, adapterId);
  }
}

/**
 * A caller demanded a minimum fidelity the tool cannot provide. Raised by
 * `PaeAdapterRegistry.negotiate` so the downgrade surfaces at the call site
 * instead of silently degrading the result.
 */
export class PaeFidelityRejectError extends OrbitDomainError {
  public constructor(
    public readonly toolName: string,
    public readonly required: PaeFidelity,
    public readonly actual: PaeFidelity,
    message: string,
    traceMarkId?: string
  ) {
    super(message, "PAE_FIDELITY_REJECT", traceMarkId);
  }
}

/**
 * The foreign runtime failed to deliver — a transport breakdown, a protocol
 * error, or a tool-level error reported by the remote side.
 *
 * Deliberately distinct from the two registration-time errors:
 * `PaeAdapterRejectError` means "this adapter was never accepted", and
 * `PaeToolMissingError` means "that name is not on the surface". This one means
 * "the tool exists and the gateway authorized the call, but the peer did not
 * deliver" — a runtime condition, and one worth surfacing separately because it
 * is usually retryable and never fixable by changing the pact.
 */
export class PaeRemoteError extends OrbitDomainError {
  public constructor(message: string, traceMarkId?: string, adapterId?: string) {
    super(message, "PAE_REMOTE", traceMarkId, adapterId);
  }
}

/** Ordering used by fidelity negotiation: `full` ≻ `reduced` ≻ `lossy`. */
export const FIDELITY_RANK: Record<PaeFidelity, number> = {
  full: 2,
  reduced: 1,
  lossy: 0
};
