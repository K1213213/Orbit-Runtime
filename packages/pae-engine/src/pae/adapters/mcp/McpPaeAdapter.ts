import { DeterminismLevel } from "@orbit/infra-common";
import { KERNEL_VERSION, parseEdition } from "@orbit/infra-common";
import {
  PaeAdapterRejectError,
  PaeRemoteError,
  PaeToolMissingError
} from "../../types";
import type { CapabilityKey } from "@orbit/infra-common";
import type {
  IPaeAdapter,
  PaeAdapterMeta,
  PaeFidelity,
  PaeInvokeCtx,
  PaeToolDescriptor
} from "../../types";
import {
  MCP_PROTOCOL_VERSION,
  isRemoteToolError,
  normaliseToolResult,
  parseToolList,
  type McpToolDefinition
} from "./protocol";
import { unwrapResponse, type IMcpTransport } from "./transport";

/**
 * Why an MCP tool is `reduced` by default.
 *
 * Two things genuinely do not survive the crossing, and both would be invisible
 * to a caller if we claimed otherwise:
 *
 * 1. **Argument validation is remote.** `tools/list` announces an `inputSchema`,
 *    but the kernel does not enforce it — a malformed call fails inside the peer
 *    process, not at the gateway. A caller who assumes "the pact checked my
 *    arguments" is wrong.
 * 2. **Results are content blocks, not JSON.** MCP returns `content[]` (text,
 *    image, resource). Text maps cleanly; anything else is preserved verbatim
 *    rather than coerced, so the shape a caller receives can differ from the
 *    shape a native kernel tool returns.
 *
 * Saying `full` here would be the single most damaging false claim the adapter
 * could make, because it is the claim every downstream assumption rests on.
 */
export const MCP_DEFAULT_FIDELITY_NOTE =
  "MCP tools are validated by the remote server, not by the kernel: the inputSchema announced by tools/list is not enforced locally, and results are mapped from MCP content blocks into JSON (non-text blocks are preserved verbatim).";

/** Per-tool tuning of the discovered surface. Keyed by the *remote* name. */
export interface McpToolOverride {
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

export interface McpPaeAdapterConfig {
  adapterId: string;
  /** Edition of the remote server; enters the pact and the run fingerprint. */
  sourceEdition?: string;
  transport: IMcpTransport;
  /**
   * Declare the surface up front instead of (or before) asking the server.
   * Useful when the tool set is known and you want registration to work without
   * a live peer. Discovery at `setup()` still wins once it runs.
   */
  tools?: McpToolOverride[];
  /**
   * Prefix prepended to every discovered tool name. Without it, two MCP servers
   * that both expose `search` collide, and the registry rejects the second one.
   */
  toolNamePrefix?: string;
  /** Family-wide fidelity, applied to tools that carry no override. */
  fidelity?: PaeFidelity;
  fidelityNote?: string;
  /** Per-call deadline when the caller supplies none. */
  defaultTimeoutMs?: number;
  clientInfo?: { name: string; version: string };
}

interface McpServerInfo {
  name?: string;
  version?: string;
  protocolVersion?: string;
}

/**
 * MCP adapter (W16) — the first PAE family that crosses a process boundary.
 *
 * Where `JsPaeAdapter` is the reference for the *contract* (no transport, no
 * serialization), this one is the reference for *translation*: it owns a
 * protocol handshake, a discovery round-trip, argument marshalling and result
 * normalization, and it still owns none of the governance — the gateway remains
 * the only thing that decides whether a call is authorized.
 *
 * The transport is injected, which is what keeps this testable: the protocol
 * behaviour is exercised against an in-memory peer, and spawning a real
 * subprocess is a separate concern with its own thin implementation.
 */
export class McpPaeAdapter implements IPaeAdapter {
  public readonly meta: PaeAdapterMeta;
  private readonly overrides = new Map<string, McpToolOverride>();
  private readonly remoteNames = new Map<string, string>();
  private descriptors: PaeToolDescriptor[] = [];
  private connected = false;
  private server: McpServerInfo | null = null;

  public constructor(private readonly config: McpPaeAdapterConfig) {
    if (!config?.adapterId) {
      throw new PaeAdapterRejectError("mcp pae adapter requires an adapterId");
    }
    if (!config?.transport) {
      throw new PaeAdapterRejectError(
        `mcp pae adapter ${config.adapterId} requires a transport`,
        undefined,
        config.adapterId
      );
    }
    for (const ov of config.tools ?? []) {
      if (typeof ov?.name !== "string" || ov.name.trim() === "") {
        throw new PaeAdapterRejectError(
          `mcp pae adapter ${config.adapterId} has a tool override with no name`,
          undefined,
          config.adapterId
        );
      }
      this.overrides.set(ov.name, ov);
    }
    this.meta = {
      adapterId: config.adapterId,
      kind: "mcp",
      /*
       * `0.0.0` rather than a word like "unknown": the registry requires a
       * semver edition, and an MCP peer's version is not knowable until the
       * handshake. `setup` overwrites it with the version the peer actually
       * reports, so the pact and the run fingerprint carry the real thing.
       */
      sourceEdition: config.sourceEdition ?? "0.0.0",
      isolation: "L2"
    };
    this.descriptors = this.describeFromOverrides();
  }

  /** Identity reported by the peer during handshake; `null` before `setup`. */
  public get serverInfo(): McpServerInfo | null {
    return this.server;
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

    const initResult = unwrapResponse(
      await this.config.transport.request(
        "initialize",
        {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: this.config.clientInfo ?? {
            name: "orbit-agent-runtime",
            version: KERNEL_VERSION
          }
        },
        timeout
      ),
      "initialize"
    );
    this.server = readServerInfo(initResult);

    /*
     * Adopt the peer's real edition now that it is known. The pact and the run
     * fingerprint both derive from `sourceEdition`, so recording "0.0.0" while
     * talking to a 2.3.4 server would make a server upgrade invisible to
     * fingerprint drift — exactly the kind of silent change this field exists
     * to catch. Only a well-formed semver is adopted; anything else keeps the
     * placeholder rather than failing registration on the peer's bad manners.
     */
    const reported = this.server?.version;
    if (reported && parseEdition(reported)) {
      this.meta.sourceEdition = reported;
    }

    await this.config.transport.notify("notifications/initialized");

    const listResult = unwrapResponse(
      await this.config.transport.request("tools/list", {}, timeout),
      "tools/list"
    );
    this.buildSurface(parseToolList(listResult));
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
          `mcp adapter ${this.meta.adapterId} is not connected; call setup() before invoking ${toolName}`,
          ctx.traceMarkId,
          this.meta.adapterId
        );
      }
      throw new PaeToolMissingError(
        `mcp adapter ${this.meta.adapterId} has no tool ${toolName}`,
        ctx.traceMarkId,
        this.meta.adapterId
      );
    }

    const response = await this.config.transport.request(
      "tools/call",
      { name: remoteName, arguments: toArguments(args, toolName, this.meta.adapterId) },
      this.config.defaultTimeoutMs ?? ctx.maxWaitMs
    );
    const result = unwrapResponse(response, `tools/call ${remoteName}`);

    if (isRemoteToolError(result)) {
      throw new PaeRemoteError(
        `mcp tool ${remoteName} reported a failure: ${describeToolError(result)}`,
        ctx.traceMarkId,
        this.meta.adapterId
      );
    }
    return normaliseToolResult(result).value;
  }

  public async teardown(): Promise<void> {
    this.connected = false;
    this.remoteNames.clear();
    this.server = null;
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

  private buildSurface(defs: McpToolDefinition[]): void {
    const prefix = this.config.toolNamePrefix ?? "";
    const out: PaeToolDescriptor[] = [];
    this.remoteNames.clear();
    for (const def of defs) {
      const ov = this.overrides.get(def.name);
      const exposed = ov?.exposeAs ?? `${prefix}${def.name}`;
      if (this.remoteNames.has(exposed)) {
        throw new PaeAdapterRejectError(
          `mcp adapter ${this.meta.adapterId} maps two remote tools onto ${exposed}; set toolNamePrefix or an exposeAs override`,
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
    ov: McpToolOverride | undefined,
    def: McpToolDefinition | undefined
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
        ov?.fidelityNote ?? this.config.fidelityNote ?? MCP_DEFAULT_FIDELITY_NOTE;
    } else if (ov?.fidelityNote) {
      descriptor.fidelityNote = ov.fidelityNote;
    }
    return descriptor;
  }
}

function readServerInfo(result: unknown): McpServerInfo | null {
  if (typeof result !== "object" || result === null) return null;
  const r = result as Record<string, unknown>;
  const info: McpServerInfo = {};
  if (typeof r.protocolVersion === "string") info.protocolVersion = r.protocolVersion;
  const srv = r.serverInfo;
  if (typeof srv === "object" && srv !== null) {
    const s = srv as Record<string, unknown>;
    if (typeof s.name === "string") info.name = s.name;
    if (typeof s.version === "string") info.version = s.version;
  }
  return info;
}

/**
 * MCP tools take named arguments; the kernel channel passes a positional array.
 * The mapping is deliberately strict — silently wrapping a scalar would paper
 * over a caller bug and produce a confusing failure inside the peer instead.
 */
function toArguments(args: unknown[], toolName: string, adapterId: string): Record<string, unknown> {
  if (args.length === 0) return {};
  const first = args[0];
  if (typeof first === "object" && first !== null && !Array.isArray(first)) {
    return first as Record<string, unknown>;
  }
  throw new PaeAdapterRejectError(
    `mcp tool ${toolName} (adapter ${adapterId}) expects a single named-argument object; received ${Array.isArray(first) ? "an array" : typeof first}`,
    undefined,
    adapterId
  );
}

function describeToolError(result: unknown): string {
  if (typeof result !== "object" || result === null) return String(result);
  const content = (result as Record<string, unknown>).content;
  if (!Array.isArray(content)) return JSON.stringify(result);
  const texts = content
    .filter((b): b is Record<string, unknown> => typeof b === "object" && b !== null)
    .map((b) => (typeof b.text === "string" ? b.text : ""))
    .filter((t) => t !== "");
  return texts.length > 0 ? texts.join(" | ") : JSON.stringify(result);
}
