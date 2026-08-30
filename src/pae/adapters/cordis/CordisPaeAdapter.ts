import { DeterminismLevel } from "../../../types/orbitDomain";
import { KERNEL_VERSION, parseEdition } from "../../../utils/versionIdGen";
import {
  PaeAdapterRejectError,
  PaeRemoteError,
  PaeToolMissingError
} from "../../types";
import type { CapabilityKey } from "../../../types/orbitDomain";
import type {
  IPaeAdapter,
  PaeAdapterMeta,
  PaeFidelity,
  PaeInvokeCtx,
  PaeToolDescriptor
} from "../../types";
import {
  CORDIS_PROTOCOL_VERSION,
  isCordisResponse,
  normaliseCordisToolResult,
  parseCordisToolList,
  remoteErrorOf,
  type CordisToolDefinition
} from "./protocol";
import { unwrapCordisResponse, type ICordisTransport } from "./transport";

/**
 * Why a Cordis host tool is `reduced` by default.
 *
 * Two things genuinely do not survive the crossing, and both would be invisible
 * to a caller if we claimed otherwise:
 *
 * 1. **Validation is remote.** `tools/list` announces an `input` shape, but the
 *    kernel does not enforce it — a malformed call fails inside the plugin
 *    instance, not at the gateway. A caller who assumes "the pact checked my
 *    arguments" is wrong.
 * 2. **The result is the host's own value space.** A Cordis tool returns
 *    whatever JSON the plugin produces; the kernel passes it through verbatim,
 *    with no contract on its shape. And the host's *internal* events and
 *    services stay inside the isolated instance — nothing from the plugin's
 *    runtime reaches the kernel except through this channel (VISION: 事件锁在
 *    域内).
 *
 * Saying `full` here would be the same damaging false claim every other
 * reduced-by-default family avoids.
 */
export const CORDIS_DEFAULT_FIDELITY_NOTE =
  "Cordis host tools are validated by the remote plugin instance, not by the kernel: the input shape announced by tools/list is not enforced locally, results are whatever JSON the host returns (passed through verbatim), and the host's internal events and services stay inside the isolated instance.";

/** Per-tool tuning of the discovered surface. Keyed by the *remote* name. */
export interface CordisToolOverride {
  /** Remote tool name, exactly as announced by `tools/list`. */
  name: string;
  /** Expose it under a different name; also bypasses `toolNamePrefix`. */
  exposeAs?: string;
  capability?: CapabilityKey;
  determinism?: DeterminismLevel;
  /** Override the family default. `full` is permitted but must be honest. */
  fidelity?: PaeFidelity;
  fidelityNote?: string;
  description?: string;
}

export interface CordisPaeAdapterConfig {
  adapterId: string;
  /** Edition of the host; overwritten by the handshake-reported version. */
  sourceEdition?: string;
  transport: ICordisTransport;
  /**
   * Declare the surface up front instead of (or before) asking the host.
   * Discovery at `setup()` still wins once it runs.
   */
  tools?: CordisToolOverride[];
  /**
   * Prefix prepended to every discovered tool name. Without it, two Cordis
   * hosts that both expose `send` collide, and the registry rejects the second.
   */
  toolNamePrefix?: string;
  /** Family-wide fidelity, applied to tools that carry no override. */
  fidelity?: PaeFidelity;
  fidelityNote?: string;
  /** Per-call deadline when the caller supplies none. */
  defaultTimeoutMs?: number;
}

interface CordisHostInfo {
  name?: string;
  version?: string;
  protocolVersion?: string;
}

/**
 * Cordis adapter (W18) — the fourth PAE family, and the one that closes the
 * "difficulty ladder": like MCP it crosses a process boundary with a handshake
 * and a dynamic tool surface, but unlike MCP the wire protocol is host-defined,
 * so the kernel defines it (see `protocol.ts`). The adapter still owns none of
 * the governance — the gateway remains the only thing that decides whether a
 * call is authorized — and the isolated instance's internal events never leak
 * into the kernel's value space.
 */
export class CordisPaeAdapter implements IPaeAdapter {
  public readonly meta: PaeAdapterMeta;
  private readonly overrides = new Map<string, CordisToolOverride>();
  private readonly remoteNames = new Map<string, string>();
  private descriptors: PaeToolDescriptor[] = [];
  private connected = false;
  private host: CordisHostInfo | null = null;

  public constructor(private readonly config: CordisPaeAdapterConfig) {
    if (!config?.adapterId) {
      throw new PaeAdapterRejectError("cordis pae adapter requires an adapterId");
    }
    if (!config?.transport) {
      throw new PaeAdapterRejectError(
        `cordis pae adapter ${config.adapterId} requires a transport`,
        undefined,
        config.adapterId
      );
    }
    for (const ov of config.tools ?? []) {
      if (typeof ov?.name !== "string" || ov.name.trim() === "") {
        throw new PaeAdapterRejectError(
          `cordis pae adapter ${config.adapterId} has a tool override with no name`,
          undefined,
          config.adapterId
        );
      }
      this.overrides.set(ov.name, ov);
    }
    this.meta = {
      adapterId: config.adapterId,
      kind: "cordis",
      /*
       * `0.0.0` rather than a word like "unknown": the registry requires a
       * semver edition, and a Cordis host's version is not knowable until the
       * handshake. `setup` overwrites it with the version the host actually
       * reports, so the pact and the run fingerprint carry the real thing.
       */
      sourceEdition: config.sourceEdition ?? "0.0.0",
      isolation: "L2"
    };
    this.descriptors = this.describeFromOverrides();
  }

  /** Identity reported by the host during handshake; `null` before `setup`. */
  public get hostInfo(): CordisHostInfo | null {
    return this.host;
  }

  public get isConnected(): boolean {
    return this.connected;
  }

  /**
   * Handshake, then discover the tool surface.
   *
   * Discovery happens here rather than in `describe()` because `describe()` is
   * synchronous by contract — the registry resolves the surface once, at
   * registration, precisely so that runtime lookups stay O(1).
   */
  public async setup(ctx: PaeInvokeCtx): Promise<void> {
    if (this.connected) return;
    const timeout = this.config.defaultTimeoutMs ?? ctx.maxWaitMs;

    const initResult = unwrapCordisResponse(
      await this.config.transport.request(
        "initialize",
        {
          protocolVersion: CORDIS_PROTOCOL_VERSION,
          clientInfo: { name: "orbit-agent-runtime", version: KERNEL_VERSION }
        },
        timeout
      ),
      "initialize"
    );
    this.host = readHostInfo(initResult);

    /*
     * Adopt the host's real edition now that it is known. The pact and the run
     * fingerprint both derive from `sourceEdition`, so recording "0.0.0" while
     * talking to a 2.3.4 host would make a host upgrade invisible to
     * fingerprint drift. Only a well-formed semver is adopted; anything else
     * keeps the placeholder rather than failing registration on the host's bad
     * manners.
     */
    const reported = this.host?.version;
    if (reported && parseEdition(reported)) {
      this.meta.sourceEdition = reported;
    }

    const listResult = unwrapCordisResponse(
      await this.config.transport.request("tools/list", {}, timeout),
      "tools/list"
    );
    this.buildSurface(parseCordisToolList(listResult));
    this.connected = true;
  }

  /** Static surface, sorted by name so the derived hash is order-independent. */
  public describe(): PaeToolDescriptor[] {
    return this.descriptors;
  }

  public async invoke(toolName: string, args: unknown[], ctx: PaeInvokeCtx): Promise<unknown> {
    const remoteName = this.remoteNames.get(toolName);
    if (!remoteName) {
      if (!this.connected && this.descriptors.length > 0) {
        throw new PaeRemoteError(
          `cordis adapter ${this.meta.adapterId} is not connected; call setup() before invoking ${toolName}`,
          ctx.traceMarkId,
          this.meta.adapterId
        );
      }
      throw new PaeToolMissingError(
        `cordis adapter ${this.meta.adapterId} has no tool ${toolName}`,
        ctx.traceMarkId,
        this.meta.adapterId
      );
    }

    const response = await this.config.transport.request(
      "tools/call",
      { name: remoteName, arguments: toArguments(args, toolName, this.meta.adapterId) },
      this.config.defaultTimeoutMs ?? ctx.maxWaitMs
    );
    if (!isCordisResponse(response)) {
      throw new PaeRemoteError(
        `cordis tool ${remoteName} returned a malformed response`,
        ctx.traceMarkId,
        this.meta.adapterId
      );
    }
    const remoteError = remoteErrorOf(response);
    if (remoteError) {
      throw new PaeRemoteError(
        `cordis tool ${remoteName} reported a failure: ${remoteError.message}`,
        ctx.traceMarkId,
        this.meta.adapterId
      );
    }
    return normaliseCordisToolResult(response.result).value;
  }

  public async teardown(): Promise<void> {
    this.connected = false;
    this.remoteNames.clear();
    this.host = null;
    this.descriptors = this.describeFromOverrides();
    await this.config.transport.close();
  }

  /* ---------------------------------------------------------------- */

  /** Surface from declared overrides only — available before any handshake. */
  private describeFromOverrides(): PaeToolDescriptor[] {
    return [...this.overrides.values()]
      .map((ov) => this.toDescriptor(ov.name, ov, undefined))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  private buildSurface(defs: CordisToolDefinition[]): void {
    const prefix = this.config.toolNamePrefix ?? "";
    const out: PaeToolDescriptor[] = [];
    this.remoteNames.clear();
    for (const def of defs) {
      const ov = this.overrides.get(def.name);
      const exposed = ov?.exposeAs ?? `${prefix}${def.name}`;
      if (this.remoteNames.has(exposed)) {
        throw new PaeAdapterRejectError(
          `cordis adapter ${this.meta.adapterId} maps two remote tools onto ${exposed}; set toolNamePrefix or an exposeAs override`,
          undefined,
          this.meta.adapterId
        );
      }
      this.remoteNames.set(exposed, def.name);
      out.push(this.toDescriptor(exposed, ov, def));
    }
    this.descriptors = out.sort((a, b) => a.name.localeCompare(b.name));
  }

  private toDescriptor(
    exposed: string,
    ov: CordisToolOverride | undefined,
    def: CordisToolDefinition | undefined
  ): PaeToolDescriptor {
    const fidelity = ov?.fidelity ?? this.config.fidelity ?? "reduced";
    const descriptor: PaeToolDescriptor = {
      name: exposed,
      capability: ov?.capability ?? "channel:read",
      determinism: ov?.determinism ?? DeterminismLevel.IO_BOUND,
      fidelity
    };
    const description = ov?.description ?? def?.description;
    if (description) descriptor.description = description;
    if (fidelity !== "full") {
      descriptor.fidelityNote =
        ov?.fidelityNote ?? this.config.fidelityNote ?? CORDIS_DEFAULT_FIDELITY_NOTE;
    } else if (ov?.fidelityNote) {
      descriptor.fidelityNote = ov.fidelityNote;
    }
    return descriptor;
  }
}

function readHostInfo(result: unknown): CordisHostInfo | null {
  if (typeof result !== "object" || result === null) return null;
  const r = result as Record<string, unknown>;
  const info: CordisHostInfo = {};
  if (typeof r.protocolVersion === "string") info.protocolVersion = r.protocolVersion;
  const host = r.hostInfo;
  if (typeof host === "object" && host !== null) {
    const h = host as Record<string, unknown>;
    if (typeof h.name === "string") info.name = h.name;
    if (typeof h.version === "string") info.version = h.version;
  }
  return info;
}

/**
 * Cordis tools take named arguments; the kernel channel passes a positional
 * array. The mapping is deliberately strict — silently wrapping a scalar would
 * paper over a caller bug and produce a confusing failure inside the host.
 */
function toArguments(args: unknown[], toolName: string, adapterId: string): Record<string, unknown> {
  if (args.length === 0) return {};
  const first = args[0];
  if (typeof first === "object" && first !== null && !Array.isArray(first)) {
    return first as Record<string, unknown>;
  }
  throw new PaeAdapterRejectError(
    `cordis tool ${toolName} (adapter ${adapterId}) expects a single named-argument object; received ${
      Array.isArray(first) ? "an array" : typeof first
    }`,
    undefined,
    adapterId
  );
}
