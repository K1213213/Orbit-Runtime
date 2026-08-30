/**
 * Isolation domain host wire format (W19).
 *
 * A domain host is a kernel-managed child process (L2) that owns plugin units.
 * Like every other cross-process boundary in this kernel, the wire format is a
 * pure-function layer: the host is untrusted input and the parsing rules must
 * be unit-testable without spawning anything.
 *
 * The envelope borrows JSON-RPC 2.0's discipline (id, result XOR error) and is
 * deliberately self-contained — the sandbox layer must not import the PAE
 * protocol, and a revision here cannot ripple into adapters.
 */

/** Version of the Orbit ↔ domain host protocol. */
export const DOMAIN_PROTOCOL_VERSION = "1.0.0";

/** A request that expects a correlated response. */
export interface DomainRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

export interface DomainErrorObject {
  message: string;
  data?: unknown;
}

export interface DomainResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: DomainErrorObject;
}

/** One tool of a unit, as announced by `units/list`. */
export interface DomainToolDefinition {
  name: string;
  description?: string;
}

/** One unit hosted by a domain, as announced by `units/list`. */
export interface DomainUnitDefinition {
  id: string;
  tools: DomainToolDefinition[];
}

/** Outcome of normalising a `units/call` result. */
export interface NormalisedDomainResult {
  value: unknown;
  degraded: boolean;
  note?: string;
}

/** Serialise one message. The wire is newline-delimited JSON. */
export function encodeDomainFrame(message: DomainRequest): string {
  return JSON.stringify(message);
}

/**
 * Parse one line of the stream. Blank keep-alive lines and log noise are
 * skipped; a line that *is* JSON yet violates the envelope is rejected, because
 * a broken host must fail loudly rather than silently mis-route responses.
 */
export function decodeDomainFrame(line: string): DomainResponse | null {
  const trimmed = line.trim();
  if (trimmed === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!isDomainResponse(parsed)) return null;
  return parsed;
}

/** Structural check for a response envelope (result XOR error). */
export function isDomainResponse(value: unknown): value is DomainResponse {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.jsonrpc !== "2.0") return false;
  if (typeof v.id !== "number" && typeof v.id !== "string") return false;
  const hasResult = Object.prototype.hasOwnProperty.call(v, "result");
  const hasError = Object.prototype.hasOwnProperty.call(v, "error");
  if (hasResult && hasError) return false;
  if (!hasResult && !hasError) return false;
  if (hasError && !isDomainErrorObject(v.error)) return false;
  return true;
}

function isDomainErrorObject(value: unknown): value is DomainErrorObject {
  if (typeof value !== "object" || value === null) return false;
  return typeof (value as Record<string, unknown>).message === "string";
}

/** The error object of a response, if the host reported a failure. */
export function domainRemoteErrorOf(response: DomainResponse): DomainErrorObject | null {
  return response.error ?? null;
}

/**
 * Validate and normalise a `units/list` result.
 *
 * The host is untrusted input. A malformed unit list is a hard error: a
 * half-understood surface would let callers invoke something the domain cannot
 * actually execute.
 */
export function parseUnitList(result: unknown): DomainUnitDefinition[] {
  if (typeof result !== "object" || result === null) {
    throw new Error("domain units/list: result is not an object");
  }
  const raw = (result as Record<string, unknown>).units;
  if (!Array.isArray(raw)) {
    throw new Error("domain units/list: `units` is missing or not an array");
  }
  const seenUnits = new Set<string>();
  const seenTools = new Set<string>();
  return raw.map((entry, i) => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`domain units/list: entry ${i} is not an object`);
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.id !== "string" || e.id.trim() === "") {
      throw new Error(`domain units/list: entry ${i} has no usable unit id`);
    }
    if (seenUnits.has(e.id)) {
      throw new Error(`domain units/list: duplicate unit id ${e.id}`);
    }
    seenUnits.add(e.id);
    const toolsRaw = e.tools;
    if (!Array.isArray(toolsRaw)) {
      throw new Error(`domain units/list: unit ${e.id} has no "tools" array`);
    }
    const tools: DomainToolDefinition[] = toolsRaw.map((t, j) => {
      if (typeof t !== "object" || t === null) {
        throw new Error(`domain units/list: unit ${e.id} tool ${j} is not an object`);
      }
      const tool = t as Record<string, unknown>;
      if (typeof tool.name !== "string" || tool.name.trim() === "") {
        throw new Error(`domain units/list: unit ${e.id} tool ${j} has no usable name`);
      }
      const globalName = `${e.id}:${tool.name}`;
      if (seenTools.has(globalName)) {
        throw new Error(`domain units/list: duplicate tool ${globalName}`);
      }
      seenTools.add(globalName);
      const out: DomainToolDefinition = { name: tool.name };
      if (typeof tool.description === "string") out.description = tool.description;
      return out;
    });
    return { id: e.id, tools };
  });
}

/**
 * Map a `units/call` result into the kernel's value space: the host contract is
 * that `result` is an arbitrary JSON value, passed through verbatim.
 */
export function normaliseDomainResult(result: unknown): NormalisedDomainResult {
  if (result === undefined) return { value: null, degraded: false };
  return { value: result, degraded: false };
}
