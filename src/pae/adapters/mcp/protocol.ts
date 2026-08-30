/**
 * MCP wire format — JSON-RPC 2.0 (W16).
 *
 * Everything in this file is a pure function over plain data: no transport, no
 * clock, no randomness. That is deliberate. The MCP adapter is the first PAE
 * family that talks to *another process*, which means it is also the first one
 * that has to parse untrusted input. Keeping the parsing rules here — where they
 * can be unit-tested without spawning anything — is what makes the transport
 * layer thin enough to trust.
 *
 * Protocol reference: MCP revision `2024-11-05` (stdio transport,
 * newline-delimited JSON).
 */

export const MCP_PROTOCOL_VERSION = "2024-11-05";

/** A request that expects a correlated response. */
export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

/** A fire-and-forget message (e.g. `notifications/initialized`). */
export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: JsonRpcErrorObject;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

/** One entry of an MCP `tools/list` result. */
export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/** Outcome of normalising an MCP `tools/call` result into kernel value space. */
export interface NormalisedToolResult {
  value: unknown;
  /**
   * True when the remote result could not be mapped losslessly — typically
   * because it carried non-text content blocks. The adapter turns this into a
   * documented `reduced` fidelity rather than dropping the data silently.
   */
  degraded: boolean;
  note?: string;
}

/**
 * Serialise one message. MCP over stdio is newline-delimited JSON, so a message
 * must never contain a raw newline; `JSON.stringify` guarantees that.
 */
export function encodeJsonRpc(message: JsonRpcMessage): string {
  return JSON.stringify(message);
}

/**
 * Parse one line of a JSON-RPC stream.
 *
 * Returns `null` for a line that is not a well-formed JSON-RPC response. A
 * server may legitimately emit blank keep-alive lines or unrelated log output on
 * the same stream, so an unparseable line is skipped rather than fatal — but a
 * line that *is* JSON yet violates the envelope is rejected, because that means
 * the peer is broken and continuing would silently mis-route responses.
 */
export function decodeJsonRpc(line: string): JsonRpcResponse | null {
  const trimmed = line.trim();
  if (trimmed === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!isJsonRpcResponse(parsed)) return null;
  return parsed;
}

/** Structural check for a response envelope (result XOR error). */
export function isJsonRpcResponse(value: unknown): value is JsonRpcResponse {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.jsonrpc !== "2.0") return false;
  if (typeof v.id !== "number" && typeof v.id !== "string") return false;
  const hasResult = Object.prototype.hasOwnProperty.call(v, "result");
  const hasError = Object.prototype.hasOwnProperty.call(v, "error");
  if (hasResult && hasError) return false;
  if (!hasResult && !hasError) return false;
  if (hasError && !isJsonRpcErrorObject(v.error)) return false;
  return true;
}

function isJsonRpcErrorObject(value: unknown): value is JsonRpcErrorObject {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.code === "number" && typeof v.message === "string";
}

/** The error object of a response, if the peer reported a failure. */
export function remoteErrorOf(response: JsonRpcResponse): JsonRpcErrorObject | null {
  return response.error ?? null;
}

/**
 * Validate and normalise an MCP `tools/list` result.
 *
 * The remote server is untrusted input. A malformed tool list is a hard error
 * rather than a best-effort filter: advertising a half-understood tool surface
 * would let callers invoke something the adapter cannot actually describe, and
 * that is exactly the kind of silent capability drift the pact layer exists to
 * prevent.
 */
export function parseToolList(result: unknown): McpToolDefinition[] {
  if (typeof result !== "object" || result === null) {
    throw new Error("mcp tools/list: result is not an object");
  }
  const raw = (result as Record<string, unknown>).tools;
  if (!Array.isArray(raw)) {
    throw new Error("mcp tools/list: `tools` is missing or not an array");
  }
  const seen = new Set<string>();
  return raw.map((entry, i) => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`mcp tools/list: entry ${i} is not an object`);
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.name !== "string" || e.name.trim() === "") {
      throw new Error(`mcp tools/list: entry ${i} has no usable name`);
    }
    if (seen.has(e.name)) {
      throw new Error(`mcp tools/list: duplicate tool name ${e.name}`);
    }
    seen.add(e.name);
    const tool: McpToolDefinition = { name: e.name };
    if (typeof e.description === "string") tool.description = e.description;
    if (typeof e.inputSchema === "object" && e.inputSchema !== null) {
      tool.inputSchema = e.inputSchema as Record<string, unknown>;
    }
    return tool;
  });
}

/**
 * Map an MCP `tools/call` result into the kernel's value space.
 *
 * MCP models a result as a list of typed content blocks (text, image,
 * resource). The kernel's value space is plain JSON with no notion of a content
 * block, so the mapping is:
 *
 * - `structuredContent` present → used verbatim (nothing is lost).
 * - all blocks textual → the text of a single block, or an array of texts.
 * - any non-text block → the raw block list is preserved and the result is
 *   flagged `degraded`, because coercing an image into JSON would destroy it.
 *
 * A result flagged `isError` is NOT turned into a value; the caller is expected
 * to raise it as a remote failure.
 */
export function normaliseToolResult(result: unknown): NormalisedToolResult {
  if (typeof result !== "object" || result === null) {
    return { value: result ?? null, degraded: false };
  }
  const r = result as Record<string, unknown>;

  if (Object.prototype.hasOwnProperty.call(r, "structuredContent")) {
    return { value: r.structuredContent ?? null, degraded: false };
  }

  const content = r.content;
  if (!Array.isArray(content)) {
    return { value: r, degraded: false };
  }
  if (content.length === 0) {
    return { value: null, degraded: false };
  }

  const blocks = content.filter(
    (b): b is Record<string, unknown> => typeof b === "object" && b !== null
  );
  const allText = blocks.every((b) => b.type === "text" && typeof b.text === "string");

  if (allText) {
    const texts = blocks.map((b) => b.text as string);
    return { value: texts.length === 1 ? texts[0] : texts, degraded: false };
  }

  const kinds = [...new Set(blocks.map((b) => String(b.type ?? "unknown")))].sort();
  return {
    value: content,
    degraded: true,
    note: `MCP result carries non-text content blocks (${kinds.join(", ")}); the raw block list is returned instead of coercing it into JSON.`
  };
}

/** A `tools/call` result that the remote flagged as a tool-level failure. */
export function isRemoteToolError(result: unknown): boolean {
  if (typeof result !== "object" || result === null) return false;
  return (result as Record<string, unknown>).isError === true;
}
