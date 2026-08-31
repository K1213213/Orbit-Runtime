import { DeterminismLevel } from "@orbit/infra-common";
import { parseEdition } from "@orbit/infra-common";
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
  bodyTail,
  buildHttpRequest,
  isHttpSuccess,
  normaliseHttpResponse,
  parseOpenApiDocument,
  resolveDocumentBaseUrl,
  type OpenApiOperation
} from "./spec";
import type { HttpRequest, HttpResponse, IHttpTransport } from "./transport";

/**
 * Why an OpenAPI operation is `reduced` by default.
 *
 * Two things genuinely do not survive the crossing, and both would be invisible
 * to a caller if we claimed otherwise:
 *
 * 1. **Validation is remote.** The document declares parameter types, but the
 *    adapter only enforces that required *path* parameters are present — query,
 *    header and body values are passed through exactly as provided, and the
 *    server does the real validation.
 * 2. **HTTP semantics are collapsed.** A response is mapped to a single value:
 *    JSON when the body parses, the raw string otherwise. The status code and
 *    headers are metadata, not part of the returned value; a non-2xx response
 *    becomes an error.
 *
 * Saying `full` here would be the same damaging false claim MCP would make —
 * it is the claim every downstream assumption rests on.
 */
export const OPENAPI_DEFAULT_FIDELITY_NOTE =
  "OpenAPI operations are validated by the remote server, not by the kernel: the adapter only enforces presence of declared path parameters (query/header/body pass through as provided), and an HTTP response is mapped to a single JSON/text value with the status code and headers dropped.";

/** Per-operation tuning of the parsed surface. Keyed by the operation id. */
export interface OpenApiOperationOverride {
  /** Operation id exactly as parsed from the document (or synthesized). */
  operation: string;
  /** Expose it under a different name; also bypasses `toolNamePrefix`. */
  exposeAs?: string;
  capability?: CapabilityKey;
  determinism?: DeterminismLevel;
  /** Override the family default. `full` is permitted but must be honest. */
  fidelity?: PaeFidelity;
  fidelityNote?: string;
  description?: string;
}

export interface OpenApiPaeAdapterConfig {
  adapterId: string;
  /**
   * The OpenAPI/Swagger document (inline). Parsed at construction so a
   * malformed document fails registration fast.
   */
  document: unknown;
  /** Base URL for every request; overrides the document's own servers/host. */
  baseUrl?: string;
  /** Edition of the API behind the document; defaults to `info.version`. */
  sourceEdition?: string;
  /** The transport the adapter talks through (injected for testability). */
  transport: IHttpTransport;
  /**
   * Per-operation tuning. Keyed by the operation id (operationId or
   * synthesized `method_path`).
   */
  operationOverrides?: OpenApiOperationOverride[];
  /**
   * Prefix prepended to every exposed tool name. Without it, two OpenAPI
   * adapters that both expose `getUsers` collide in the registry.
   */
  toolNamePrefix?: string;
  /** Family-wide fidelity, applied to operations that carry no override. */
  fidelity?: PaeFidelity;
  fidelityNote?: string;
  /** Per-call deadline when the caller supplies none. */
  defaultTimeoutMs?: number;
}

/**
 * OpenAPI adapter (W17) — a REST surface, declared by an OpenAPI/Swagger
 * document, exposed as a PAE tool family.
 *
 * Where the MCP adapter performs a live handshake and tool discovery, this one
 * reads the surface statically from the document — no network round-trip is
 * needed to know what the adapter can do, so a malformed document fails at
 * construction, before any call is ever routed to it. The same two laws hold:
 * it never talks to the kernel directly, and it introduces no nondeterminism
 * of its own (the remote API is `IO_BOUND`, replayed from the journal).
 */
export class OpenApiPaeAdapter implements IPaeAdapter {
  public readonly meta: PaeAdapterMeta;
  private readonly overrides = new Map<string, OpenApiOperationOverride>();
  private readonly operations = new Map<string, OpenApiOperation>();
  private readonly baseUrl: string;
  private descriptors: PaeToolDescriptor[] = [];
  private connected = false;

  public constructor(private readonly config: OpenApiPaeAdapterConfig) {
    if (!config?.adapterId) {
      throw new PaeAdapterRejectError("openapi pae adapter requires an adapterId");
    }
    if (!config?.transport) {
      throw new PaeAdapterRejectError(
        `openapi pae adapter ${config.adapterId} requires a transport`,
        undefined,
        config.adapterId
      );
    }
    if (config.document === undefined || config.document === null) {
      throw new PaeAdapterRejectError(
        `openapi pae adapter ${config.adapterId} requires an OpenAPI document`,
        undefined,
        config.adapterId
      );
    }
    for (const ov of config.operationOverrides ?? []) {
      if (typeof ov?.operation !== "string" || ov.operation.trim() === "") {
        throw new PaeAdapterRejectError(
          `openapi pae adapter ${config.adapterId} has an operation override with no operation id`,
          undefined,
          config.adapterId
        );
      }
      this.overrides.set(ov.operation, ov);
    }

    /*
     * Parse now, not in `setup()`: unlike MCP the surface is fully known from
     * the document, and failing here means a malformed spec never even reaches
     * the registry.
     */
    let parsed;
    try {
      parsed = parseOpenApiDocument(config.document);
    } catch (err) {
      throw new PaeAdapterRejectError(
        `openapi pae adapter ${config.adapterId}: ${err instanceof Error ? err.message : String(err)}`,
        undefined,
        config.adapterId
      );
    }

    /*
     * The base URL is configuration first, document fallback second, and a
     * hard error when neither exists: an adapter that cannot name its endpoint
     * should fail registration, not the first call routed to it.
     */
    this.baseUrl = (config.baseUrl ?? resolveDocumentBaseUrl(config.document) ?? "").trim();
    if (this.baseUrl === "") {
      throw new PaeAdapterRejectError(
        `openapi pae adapter ${config.adapterId} needs a baseUrl (set config.baseUrl or a server/host in the document)`,
        undefined,
        config.adapterId
      );
    }
    this.buildSurface(parsed.operations);

    const edition =
      config.sourceEdition ??
      (parsed.info.version && parseEdition(parsed.info.version) ? parsed.info.version : undefined);
    this.meta = {
      adapterId: config.adapterId,
      kind: "openapi",
      sourceEdition: edition ?? "0.0.0",
      isolation: "L2"
    };
  }

  public get isConnected(): boolean {
    return this.connected;
  }

  /** No remote handshake: the surface comes from the document. Marks ready. */
  public async setup(_ctx: PaeInvokeCtx): Promise<void> {
    this.connected = true;
  }

  /** Static surface, sorted by name so the derived hash is order-independent. */
  public describe(): PaeToolDescriptor[] {
    return this.descriptors;
  }

  public async invoke(toolName: string, args: unknown[], ctx: PaeInvokeCtx): Promise<unknown> {
    const op = this.operations.get(toolName);
    if (!op) {
      if (!this.connected && this.descriptors.length > 0) {
        throw new PaeRemoteError(
          `openapi adapter ${this.meta.adapterId} is not connected; call setup() before invoking ${toolName}`,
          ctx.traceMarkId,
          this.meta.adapterId
        );
      }
      throw new PaeToolMissingError(
        `openapi adapter ${this.meta.adapterId} has no tool ${toolName}`,
        ctx.traceMarkId,
        this.meta.adapterId
      );
    }

    const baseUrl = this.baseUrl;
    let request: HttpRequest;
    try {
      request = buildHttpRequest(op, args, baseUrl, toolName, this.meta.adapterId);
    } catch (err) {
      throw new PaeAdapterRejectError(
        err instanceof Error ? err.message : String(err),
        ctx.traceMarkId,
        this.meta.adapterId
      );
    }

    const response: HttpResponse = await this.config.transport.send(
      request,
      this.config.defaultTimeoutMs ?? ctx.maxWaitMs
    );

    if (!isHttpSuccess(response.status)) {
      throw new PaeRemoteError(
        `openapi tool ${toolName} (adapter ${this.meta.adapterId}) returned HTTP ${response.status}: ${bodyTail(
          response.body
        )}`,
        ctx.traceMarkId,
        this.meta.adapterId
      );
    }
    return normaliseHttpResponse(response.status, response.body).value;
  }

  public async teardown(): Promise<void> {
    this.connected = false;
    await this.config.transport.close();
  }

  /* ---------------------------------------------------------------- */

  private buildSurface(operations: OpenApiOperation[]): void {
    const prefix = this.config.toolNamePrefix ?? "";
    const out: PaeToolDescriptor[] = [];
    this.operations.clear();
    for (const op of operations) {
      const ov = this.overrides.get(op.id);
      const exposed = ov?.exposeAs ?? `${prefix}${op.id}`;
      if (this.operations.has(exposed)) {
        throw new PaeAdapterRejectError(
          `openapi adapter ${this.meta?.adapterId ?? "(constructing)"} maps two operations onto ${exposed}; set toolNamePrefix or an exposeAs override`,
          undefined,
          this.meta?.adapterId
        );
      }
      this.operations.set(exposed, op);
      out.push(this.toDescriptor(exposed, ov, op));
    }
    this.descriptors = out.sort((a, b) => a.name.localeCompare(b.name));
  }

  private toDescriptor(
    exposed: string,
    ov: OpenApiOperationOverride | undefined,
    op: OpenApiOperation
  ): PaeToolDescriptor {
    const fidelity = ov?.fidelity ?? this.config.fidelity ?? "reduced";
    const descriptor: PaeToolDescriptor = {
      name: exposed,
      capability: ov?.capability ?? "channel:read",
      determinism: ov?.determinism ?? DeterminismLevel.IO_BOUND,
      fidelity
    };
    const description = ov?.description ?? op.summary ?? op.description;
    if (description) descriptor.description = description;
    if (fidelity !== "full") {
      descriptor.fidelityNote =
        ov?.fidelityNote ?? this.config.fidelityNote ?? OPENAPI_DEFAULT_FIDELITY_NOTE;
    } else if (ov?.fidelityNote) {
      descriptor.fidelityNote = ov.fidelityNote;
    }
    return descriptor;
  }
}
