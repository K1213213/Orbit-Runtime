import { createHash } from "node:crypto";
import { parseEdition } from "../utils/versionIdGen";
import { ChannelKind, DeterminismLevel } from "../types/orbitDomain";
import type { CapabilityKey, PluginUnitPact } from "../types/orbitDomain";
import {
  FIDELITY_RANK,
  PaeAdapterRejectError,
  PaeFidelityRejectError,
  PaeToolMissingError
} from "./types";
import type {
  IPaeAdapter,
  PaeAdapterMeta,
  PaeFidelity,
  PaeInvokeCtx,
  PaeToolDescriptor
} from "./types";

/** A tool resolved to the adapter that serves it. */
export interface PaeToolBinding {
  adapter: IPaeAdapter;
  tool: PaeToolDescriptor;
}

/**
 * Tool names that would shadow the channel/provider surface once the registry
 * is exposed through `PaeChannel` (where a tool name becomes a method name).
 * Rejecting them at registration keeps the dispatch unambiguous.
 */
const RESERVED_TOOL_NAMES = new Set([
  "setup",
  "teardown",
  "determinismMeta",
  "constructor",
  "prototype",
  "then",
  "toString",
  "valueOf",
  "syncTools",
  "attachContext"
]);

const TOOL_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_.:-]{0,63}$/;

/**
 * Registry of PAE adapters (W15) — the static half of the adaptation engine.
 *
 * Everything expensive happens once, at registration: the adapter's capability
 * surface is validated, indexed by tool name, and frozen into a configuration
 * hash. Afterwards the hot path is a single `Map` lookup, which is what keeps
 * the gateway overhead budget (≤5%, VISION §3.2 mechanism 2) achievable while
 * still checking every call.
 *
 * The registry deliberately owns no governance: it decides *what exists* and
 * *how faithfully it is mapped*, never *whether a call is allowed*. Permission,
 * budget, rate limiting and recording stay in the gateway above it.
 */
export class PaeAdapterRegistry {
  private readonly adapters = new Map<string, IPaeAdapter>();
  /** toolName -> binding. Flat by design: a tool name is globally unique. */
  private readonly toolIndex = new Map<string, PaeToolBinding>();
  /** Adapters whose optional `setup` already ran; keeps `setupAll` idempotent. */
  private readonly setupDone = new Set<string>();

  /**
   * Register an adapter after full static validation. Validation is strict on
   * purpose — a malformed adapter must fail at registration, never mid-trace:
   *
   * - identity: unique `adapterId`, semver `sourceEdition`
   * - surface: at least one tool, syntactically valid and non-reserved names,
   *   globally unique across adapters
   * - honesty: any fidelity below `full` must be documented (`fidelityNote`)
   */
  public register(adapter: IPaeAdapter, traceMarkId?: string): void {
    const meta = adapter.meta;
    if (!meta || !meta.adapterId || !meta.kind || !meta.sourceEdition || !meta.isolation) {
      throw new PaeAdapterRejectError("pae adapter meta is incomplete", traceMarkId, meta?.adapterId);
    }
    if (this.adapters.has(meta.adapterId)) {
      throw new PaeAdapterRejectError(`pae adapter ${meta.adapterId} already registered`, traceMarkId, meta.adapterId);
    }
    if (!parseEdition(meta.sourceEdition)) {
      throw new PaeAdapterRejectError(
        `pae adapter ${meta.adapterId} sourceEdition "${meta.sourceEdition}" is not semver`,
        traceMarkId,
        meta.adapterId
      );
    }

    const tools = adapter.describe();
    if (!Array.isArray(tools) || tools.length === 0) {
      throw new PaeAdapterRejectError(
        `pae adapter ${meta.adapterId} exposes no tools`,
        traceMarkId,
        meta.adapterId
      );
    }

    const seenLocally = new Set<string>();
    for (const tool of tools) {
      validateTool(tool, meta, traceMarkId);
      if (seenLocally.has(tool.name)) {
        throw new PaeAdapterRejectError(
          `pae adapter ${meta.adapterId} declares tool ${tool.name} twice`,
          traceMarkId,
          meta.adapterId
        );
      }
      const clash = this.toolIndex.get(tool.name);
      if (clash) {
        throw new PaeAdapterRejectError(
          `pae tool name ${tool.name} already served by adapter ${clash.adapter.meta.adapterId}`,
          traceMarkId,
          meta.adapterId
        );
      }
      seenLocally.add(tool.name);
    }

    this.adapters.set(meta.adapterId, adapter);
    for (const tool of tools) {
      this.toolIndex.set(tool.name, { adapter, tool: { ...tool } });
    }
  }

  /** Remove an adapter and every tool it served. */
  public unregister(adapterId: string): void {
    if (!this.adapters.delete(adapterId)) return;
    this.setupDone.delete(adapterId);
    for (const [name, binding] of [...this.toolIndex]) {
      if (binding.adapter.meta.adapterId === adapterId) this.toolIndex.delete(name);
    }
  }

  public has(adapterId: string): boolean {
    return this.adapters.has(adapterId);
  }

  public isEmpty(): boolean {
    return this.adapters.size === 0;
  }

  public get(adapterId: string): IPaeAdapter | undefined {
    return this.adapters.get(adapterId);
  }

  /** Adapter provenance, sorted by id for deterministic reporting. */
  public listAdapters(): PaeAdapterMeta[] {
    return [...this.adapters.values()]
      .map((a) => ({ ...a.meta }))
      .sort((a, b) => a.adapterId.localeCompare(b.adapterId));
  }

  /** Whole capability surface, sorted by tool name for deterministic reporting. */
  public listTools(): PaeToolDescriptor[] {
    return [...this.toolIndex.values()]
      .map((b) => ({ ...b.tool }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** O(1) resolution of a tool name to its adapter. */
  public lookup(toolName: string): PaeToolBinding | undefined {
    return this.toolIndex.get(toolName);
  }

  /** Capability a caller must hold to invoke a tool (undefined if unknown). */
  public capabilityOf(toolName: string): CapabilityKey | undefined {
    return this.toolIndex.get(toolName)?.tool.capability;
  }

  /**
   * Capability negotiation with informed choice (VISION §3.2 mechanism 1): the
   * caller states the lowest fidelity it will accept and either gets the
   * descriptor — which documents exactly what is reduced — or a hard error. A
   * downgrade is never applied silently.
   */
  public negotiate(toolName: string, minFidelity: PaeFidelity = "full", traceMarkId?: string): PaeToolDescriptor {
    const binding = this.toolIndex.get(toolName);
    if (!binding) {
      throw new PaeToolMissingError(`pae tool ${toolName} is not registered`, traceMarkId);
    }
    const actual = binding.tool.fidelity;
    if (FIDELITY_RANK[actual] < FIDELITY_RANK[minFidelity]) {
      throw new PaeFidelityRejectError(
        toolName,
        minFidelity,
        actual,
        `pae tool ${toolName} maps at fidelity "${actual}" (${binding.tool.fidelityNote ?? "no note"}), caller requires "${minFidelity}"`,
        traceMarkId
      );
    }
    return { ...binding.tool };
  }

  /**
   * Derive a `PluginUnitPact` from an adapter's declared surface — the
   * "dynamic pact" that lets a foreign plugin pass the same four checks as a
   * native one (VISION §4: MCP coverage *without* governance downgrade).
   *
   * The capability set is the union of its tools' capabilities, always
   * including `channel:read` because reaching the PAE channel at all is a read
   * of the adapter surface.
   */
  public derivePact(adapterId: string, opts: { requireHostMinEdition?: string } = {}): PluginUnitPact {
    const adapter = this.adapters.get(adapterId);
    if (!adapter) {
      throw new PaeAdapterRejectError(`pae adapter ${adapterId} is not registered`, undefined, adapterId);
    }
    const caps = new Set<CapabilityKey>(["channel:read"]);
    for (const tool of adapter.describe()) caps.add(tool.capability);
    return {
      id: adapterId,
      displayName: `pae:${adapter.meta.kind}:${adapterId}`,
      edition: adapter.meta.sourceEdition,
      requireHostMinEdition: opts.requireHostMinEdition ?? "0.0.0",
      allowCapabilities: [...caps].sort(),
      declareChannelDeps: [ChannelKind.PAE_TOOL]
    };
  }

  /**
   * Deterministic hash of the whole adaptation surface. Enters the run-version
   * fingerprint, so replaying a trace against a *different* set of adapters is
   * reported as configuration drift instead of surfacing later as an
   * inexplicable digest mismatch. Order-independent by construction.
   */
  public configHash(): string {
    const canonical = this.listAdapters().map((meta) => ({
      adapterId: meta.adapterId,
      kind: meta.kind,
      sourceEdition: meta.sourceEdition,
      isolation: meta.isolation,
      tools: this.listTools()
        .filter((t) => this.toolIndex.get(t.name)?.adapter.meta.adapterId === meta.adapterId)
        .map((t) => ({
          name: t.name,
          capability: t.capability,
          determinism: t.determinism,
          fidelity: t.fidelity
        }))
    }));
    return createHash("sha256").update(JSON.stringify(canonical)).digest("hex").slice(0, 16);
  }

  /**
   * Dispatch a foreign call. Pure delegation: the gateway has already decided
   * whether the call may happen, so the registry only resolves and forwards.
   */
  public invoke(toolName: string, args: unknown[], ctx: PaeInvokeCtx): Promise<unknown> {
    const binding = this.toolIndex.get(toolName);
    if (!binding) {
      throw new PaeToolMissingError(`pae tool ${toolName} is not registered`, ctx.traceMarkId);
    }
    return binding.adapter.invoke(toolName, args, ctx);
  }

  /**
   * Setup every adapter that needs a connection. Idempotent: an adapter added
   * to an already-booted host is set up on the next call, and one that is
   * already connected is not set up twice.
   */
  public async setupAll(ctx: PaeInvokeCtx): Promise<void> {
    for (const adapter of this.adapters.values()) {
      const id = adapter.meta.adapterId;
      if (this.setupDone.has(id)) continue;
      if (adapter.setup) await adapter.setup(ctx);
      this.setupDone.add(id);
    }
  }

  /** Release every adapter, then forget the setup state. */
  public async teardownAll(): Promise<void> {
    for (const adapter of this.adapters.values()) {
      if (adapter.teardown) await adapter.teardown();
    }
    this.setupDone.clear();
  }

  public clear(): void {
    this.adapters.clear();
    this.toolIndex.clear();
    this.setupDone.clear();
  }
}

/** Registration-time validation of a single tool descriptor. */
function validateTool(tool: PaeToolDescriptor, meta: PaeAdapterMeta, traceMarkId?: string): void {
  if (!tool || typeof tool.name !== "string" || !TOOL_NAME_PATTERN.test(tool.name)) {
    throw new PaeAdapterRejectError(
      `pae adapter ${meta.adapterId} declares an invalid tool name ${String(tool?.name)}`,
      traceMarkId,
      meta.adapterId
    );
  }
  if (RESERVED_TOOL_NAMES.has(tool.name)) {
    throw new PaeAdapterRejectError(
      `pae tool name ${tool.name} is reserved by the channel surface`,
      traceMarkId,
      meta.adapterId
    );
  }
  if (tool.capability !== "channel:read" && tool.capability !== "channel:write") {
    throw new PaeAdapterRejectError(
      `pae tool ${tool.name} declares an unknown capability ${String(tool.capability)}`,
      traceMarkId,
      meta.adapterId
    );
  }
  const levels: DeterminismLevel[] = [
    DeterminismLevel.DETERMINISTIC,
    DeterminismLevel.STOCHASTIC,
    DeterminismLevel.IO_BOUND
  ];
  if (!levels.includes(tool.determinism)) {
    throw new PaeAdapterRejectError(
      `pae tool ${tool.name} declares an unknown determinism level ${String(tool.determinism)}`,
      traceMarkId,
      meta.adapterId
    );
  }
  if (!(tool.fidelity in FIDELITY_RANK)) {
    throw new PaeAdapterRejectError(
      `pae tool ${tool.name} declares an unknown fidelity ${String(tool.fidelity)}`,
      traceMarkId,
      meta.adapterId
    );
  }
  // Honesty gate: a downgrade must be documented, otherwise the caller cannot
  // make the informed choice the charter promises.
  if (tool.fidelity !== "full" && !tool.fidelityNote) {
    throw new PaeAdapterRejectError(
      `pae tool ${tool.name} maps at fidelity "${tool.fidelity}" without a fidelityNote`,
      traceMarkId,
      meta.adapterId
    );
  }
}
