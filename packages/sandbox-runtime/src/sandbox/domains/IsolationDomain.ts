import type { ClockSource, RngSource } from "@orbit/infra-common";
import { DomainRemoteError, DomainUnitMissingError } from "./errors";
import {
  DOMAIN_PROTOCOL_VERSION,
  isDomainResponse,
  normaliseDomainResult,
  parseUnitList,
  domainRemoteErrorOf,
  type DomainUnitDefinition
} from "./protocol";
import { unwrapDomainResponse, type IDomainTransport } from "./transport";

/** Per-call context handed to a domain. Determinism sources are forwarded, never minted. */
export interface DomainInvokeCtx {
  traceMarkId: string;
  maxWaitMs: number;
  rng?: RngSource;
  clock?: ClockSource;
  /**
   * The calling plugin unit, when the caller is itself a unit. A cross-domain
   * transaction records it so a hop is attributable at both ends (W20).
   */
  pluginUnitId?: string;
}

/** Identity reported by a host during handshake; `null` before `setup`. */
export interface DomainHostInfo {
  name?: string;
  version?: string;
  protocolVersion?: string;
}

export interface IsolationDomainConfig {
  /** Stable domain id from the allocation plan (`iso:<unit>` / `shared:<n>`). */
  domainId: string;
  /** Physical isolation level. W19 only ever creates L2 (own process). */
  isolation: "L2";
  transport: IDomainTransport;
  /** Per-call deadline when the caller supplies none. */
  defaultTimeoutMs?: number;
}

/**
 * A managed L2 isolation domain (W19).
 *
 * Owns exactly one host connection (usually a child process) and the units that
 * host serves. The lifecycle mirrors the cross-process adapters: `setup()`
 * performs the `initialize` handshake and discovers the unit surface via
 * `units/list`; `invokeUnit()` dispatches through the transport; `teardown()`
 * releases the host. The domain itself introduces no nondeterminism — units are
 * executed in the child, and the kernel records the result like any other
 * IO_BOUND call.
 */
export class IsolationDomain {
  public readonly meta: { domainId: string; isolation: "L2" };
  private readonly unitTools = new Map<string, Set<string>>();
  private host: DomainHostInfo | null = null;
  private connected = false;

  public constructor(private readonly config: IsolationDomainConfig) {
    if (!config?.domainId) {
      throw new DomainUnitMissingError("isolation domain requires a domainId");
    }
    if (!config?.transport) {
      throw new DomainUnitMissingError(`isolation domain ${config.domainId} requires a transport`);
    }
    this.meta = { domainId: config.domainId, isolation: config.isolation };
  }

  public get domainId(): string {
    return this.config.domainId;
  }

  public get isConnected(): boolean {
    return this.connected;
  }

  public get hostInfo(): DomainHostInfo | null {
    return this.host;
  }

  public async setup(ctx: DomainInvokeCtx): Promise<void> {
    if (this.connected) return;
    const timeout = this.config.defaultTimeoutMs ?? ctx.maxWaitMs;

    const initResult = unwrapDomainResponse(
      await this.config.transport.request(
        "initialize",
        {
          protocolVersion: DOMAIN_PROTOCOL_VERSION,
          clientInfo: { name: "orbit-agent-runtime", domainId: this.config.domainId }
        },
        timeout
      ),
      "initialize"
    );
    this.host = readHostInfo(initResult);

    const listResult = unwrapDomainResponse(
      await this.config.transport.request("units/list", {}, timeout),
      "units/list"
    );
    this.buildSurface(parseUnitList(listResult));
    this.connected = true;
  }

  /** Units hosted by this domain, sorted by id, each with sorted tool names. */
  public describeUnits(): Array<{ unitId: string; tools: string[] }> {
    return [...this.unitTools.entries()]
      .map(([unitId, tools]) => ({ unitId, tools: [...tools].sort() }))
      .sort((a, b) => a.unitId.localeCompare(b.unitId));
  }

  public async invokeUnit(unitId: string, tool: string, args: unknown[], ctx: DomainInvokeCtx): Promise<unknown> {
    const tools = this.unitTools.get(unitId);
    if (!tools || !tools.has(tool)) {
      if (!this.connected && this.unitTools.size > 0) {
        throw new DomainRemoteError(
          `domain ${this.config.domainId} is not connected; call setup() before invoking ${unitId}:${tool}`,
          ctx.traceMarkId,
          this.config.domainId
        );
      }
      throw new DomainUnitMissingError(
        `domain ${this.config.domainId} has no unit or tool ${unitId}:${tool}`,
        ctx.traceMarkId,
        this.config.domainId
      );
    }

    const response = await this.config.transport.request(
      "units/call",
      { unitId, tool, arguments: toArguments(args, unitId, tool, this.config.domainId) },
      this.config.defaultTimeoutMs ?? ctx.maxWaitMs
    );
    if (!isDomainResponse(response)) {
      throw new DomainRemoteError(
        `domain ${this.config.domainId} returned a malformed response for ${unitId}:${tool}`,
        ctx.traceMarkId,
        this.config.domainId
      );
    }
    const remoteError = domainRemoteErrorOf(response);
    if (remoteError) {
      throw new DomainRemoteError(
        `domain tool ${unitId}:${tool} reported a failure: ${remoteError.message}`,
        ctx.traceMarkId,
        this.config.domainId
      );
    }
    return normaliseDomainResult(response.result).value;
  }

  public async teardown(): Promise<void> {
    this.connected = false;
    this.unitTools.clear();
    this.host = null;
    await this.config.transport.close();
  }

  /* ---------------------------------------------------------------- */

  private buildSurface(units: DomainUnitDefinition[]): void {
    this.unitTools.clear();
    for (const unit of units) {
      this.unitTools.set(unit.id, new Set(unit.tools.map((t) => t.name)));
    }
  }
}

function readHostInfo(result: unknown): DomainHostInfo | null {
  if (typeof result !== "object" || result === null) return null;
  const r = result as Record<string, unknown>;
  const info: DomainHostInfo = {};
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
 * Units take named arguments; the kernel channel passes a positional array.
 * Strict mapping: a single plain-object argument, or empty (no arguments).
 */
function toArguments(args: unknown[], unitId: string, tool: string, domainId: string): Record<string, unknown> {
  if (args.length === 0) return {};
  const first = args[0];
  if (typeof first === "object" && first !== null && !Array.isArray(first)) {
    return first as Record<string, unknown>;
  }
  throw new DomainUnitMissingError(
    `domain tool ${unitId}:${tool} (domain ${domainId}) expects a single named-argument object; received ${
      Array.isArray(first) ? "an array" : typeof first
    }`
  );
}
