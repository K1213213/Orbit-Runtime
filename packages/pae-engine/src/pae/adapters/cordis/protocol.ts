/**
 * Cordis bridge wire format (W18).
 *
 * A Cordis "isolated instance" (VISION: 事件锁在域内，跨域为事务) is a plugin
 * host process with a *host-defined* protocol — unlike MCP there is no
 * standardised wire protocol to speak, so the kernel defines one. Everything in
 * this file is a pure function over plain data: no transport, no clock, no
 * randomness, for the same reason the MCP protocol layer is pure — the host is
 * untrusted input and the parsing rules must be unit-testable without spawning
 * anything.
 *
 * The envelope borrows JSON-RPC 2.0's discipline (id, result XOR error) but is
 * deliberately self-contained rather than importing the MCP protocol: adapter
 * families stay independent, and a future protocol revision here cannot ripple
 * into MCP.
 */

/** Version of the Orbit ↔ Cordis bridge protocol spoken by this adapter. */
export const CORDIS_PROTOCOL_VERSION = "1.0.0";

/** A request that expects a correlated response. */
export interface CordisRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

export interface CordisErrorObject {
  message: string;
  data?: unknown;
}

export interface CordisResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: CordisErrorObject;
}

/** One entry of a Cordis host `tools/list` result. */
export interface CordisToolDefinition {
  name: string;
  description?: string;
  /** Optional declared input shape; NOT enforced locally (remote validation). */
  input?: Record<string, unknown>;
}

/** Outcome of normalising a Cordis `tools/call` result into kernel value space. */
export interface NormalisedCordisResult {
  value: unknown;
  /** True when the host's result could not be mapped losslessly. */
  degraded: boolean;
  note?: string;
}

/**
 * Serialise one message. The wire is newline-delimited JSON, so a message must
 * never contain a raw newline; `JSON.stringify` guarantees that.
 */
export function encodeFrame(message: CordisRequest): string {
  return JSON.stringify(message);
}

/**
 * Parse one line of the stream.
 *
 * Returns `null` for a line that is not a well-formed response. A host may
 * legitimately emit blank keep-alive lines or log noise on the same stream, so
 * an unparseable line is skipped rather than fatal — but a line that *is* JSON
 * yet violates the envelope is rejected, because that means the peer is broken
 * and continuing would silently mis-route responses.
 */
export function decodeFrame(line: string): CordisResponse | null {
  const trimmed = line.trim();
  if (trimmed === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!isCordisResponse(parsed)) return null;
  return parsed;
}

/** Structural check for a response envelope (result XOR error). */
export function isCordisResponse(value: unknown): value is CordisResponse {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.jsonrpc !== "2.0") return false;
  if (typeof v.id !== "number" && typeof v.id !== "string") return false;
  const hasResult = Object.prototype.hasOwnProperty.call(v, "result");
  const hasError = Object.prototype.hasOwnProperty.call(v, "error");
  if (hasResult && hasError) return false;
  if (!hasResult && !hasError) return false;
  if (hasError && !isCordisErrorObject(v.error)) return false;
  return true;
}

function isCordisErrorObject(value: unknown): value is CordisErrorObject {
  if (typeof value !== "object" || value === null) return false;
  return typeof (value as Record<string, unknown>).message === "string";
}

/**
 * The error object of a response, if the host reported a failure.
 *
 * The name is protocol-qualified on purpose. Every wire protocol in the engine
 * owns an identically shaped predicate, and the package barrel is a flat public
 * surface; an unqualified `remoteErrorOf` would make the barrel ambiguous the
 * moment a second protocol lands — which is exactly what happened when the
 * package boundary was drawn. Qualified names keep the surface additive.
 */
export function cordisRemoteErrorOf(response: CordisResponse): CordisErrorObject | null {
  return response.error ?? null;
}

/**
 * Validate and normalise a Cordis `tools/list` result.
 *
 * The host is untrusted input. A malformed tool list is a hard error rather
 * than a best-effort filter, exactly as in MCP's `parseToolList`: advertising a
 * half-understood surface would let callers invoke something the adapter cannot
 * actually describe.
 */
export function parseCordisToolList(result: unknown): CordisToolDefinition[] {
  if (typeof result !== "object" || result === null) {
    throw new Error("cordis tools/list: result is not an object");
  }
  const raw = (result as Record<string, unknown>).tools;
  if (!Array.isArray(raw)) {
    throw new Error("cordis tools/list: `tools` is missing or not an array");
  }
  const seen = new Set<string>();
  return raw.map((entry, i) => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`cordis tools/list: entry ${i} is not an object`);
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.name !== "string" || e.name.trim() === "") {
      throw new Error(`cordis tools/list: entry ${i} has no usable name`);
    }
    if (seen.has(e.name)) {
      throw new Error(`cordis tools/list: duplicate tool name ${e.name}`);
    }
    seen.add(e.name);
    const tool: CordisToolDefinition = { name: e.name };
    if (typeof e.description === "string") tool.description = e.description;
    if (typeof e.input === "object" && e.input !== null) {
      tool.input = e.input as Record<string, unknown>;
    }
    return tool;
  });
}

/**
 * Map a Cordis `tools/call` result into the kernel's value space.
 *
 * The host contract is simple: the `result` of a successful call is an
 * arbitrary JSON value, passed through verbatim. Nothing is coerced, so the
 * only degradation possible is a host that returns a non-JSON-serialisable
 * result — which the framing layer already rejected — or a result whose shape
 * is opaque to the kernel; the fidelity note covers that honesty globally.
 */
export function normaliseCordisToolResult(result: unknown): NormalisedCordisResult {
  if (result === undefined) return { value: null, degraded: false };
  return { value: result, degraded: false };
}
