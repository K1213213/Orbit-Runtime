/**
 * OpenAPI document mapping — pure functions (W17).
 *
 * Everything here operates on plain data: no transport, no clock, no
 * randomness. An OpenAPI/Swagger document is *untrusted input* exactly like an
 * MCP `tools/list` result, so the parsing rules live in a file that can be
 * unit-tested without any I/O. The adapter on top stays a thin translation
 * shell.
 *
 * Scope (deliberate, and honest about it):
 * - `openapi: 3.x` and `swagger: 2.x` documents are both accepted; only the
 *   structural subset the kernel maps onto tools is interpreted.
 * - `paths` → one tool per (method, path) operation. The base URL is resolved
 *   as a *fallback* only — `config.baseUrl` always wins; `servers[0]` (openapi
 *   3) or `schemes + host + basePath` (swagger 2) is used when the adapter is
 *   configured without one.
 * - Parameter `in` supports `path`, `query` and `header`. `cookie` is rejected
 *   with a clear error rather than silently dropped (the kernel never sends
 *   ambient credentials).
 */

/** One declared parameter of an operation. */
export interface OpenApiParameter {
  name: string;
  in: "path" | "query" | "header";
  required?: boolean;
  description?: string;
}

/** One (method, path) operation, described in adapter terms. */
export interface OpenApiOperation {
  /** Tool name — `operationId` when present, synthesized otherwise. */
  id: string;
  /** Lower-cased HTTP method. */
  method: string;
  /** Raw path template, e.g. `/users/{id}`. */
  path: string;
  parameters: OpenApiParameter[];
  hasRequestBody: boolean;
  summary?: string;
  description?: string;
}

/** Parsed surface of an OpenAPI document. */
export interface ParsedOpenApiDocument {
  operations: OpenApiOperation[];
  info: { title?: string; version?: string };
}

/** Methods the adapter will surface, lower-cased and ordered by this list. */
const HTTP_METHODS = [
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace"
] as const;

/** Characters that survive in a synthesized tool name (registry-safe). */
const UNSAFE_TOOL_CHARS = /[^A-Za-z0-9_.:-]/g;

/** How much of an error body to keep for diagnostics. */
export const BODY_TAIL_LIMIT = 2048;

/**
 * Parse and validate an OpenAPI document into the operation surface.
 *
 * Malformed structure is a hard error, not a best-effort filter, for the same
 * reason as MCP's `parseToolList`: advertising a half-understood surface would
 * let callers invoke something the adapter cannot actually describe.
 */
export function parseOpenApiDocument(doc: unknown): ParsedOpenApiDocument {
  if (typeof doc !== "object" || doc === null) {
    throw new Error("openapi document: not an object");
  }
  const d = doc as Record<string, unknown>;
  const version = typeof d.openapi === "string" ? d.openapi : typeof d.swagger === "string" ? d.swagger : undefined;
  if (version === undefined) {
    throw new Error("openapi document: neither `openapi` nor `swagger` version is present");
  }

  const info = readInfo(d.info);

  const paths = d.paths;
  if (typeof paths !== "object" || paths === null || Array.isArray(paths)) {
    throw new Error("openapi document: `paths` is missing or not an object");
  }

  const operations: OpenApiOperation[] = [];
  const seen = new Set<string>();

  for (const [pathTemplate, pathItem] of Object.entries(paths)) {
    if (typeof pathItem !== "object" || pathItem === null) {
      throw new Error(`openapi document: path ${pathTemplate} is not a path-item object`);
    }
    const item = pathItem as Record<string, unknown>;

    /*
     * Path-level parameters apply to every operation under the path; the spec
     * allows them to be shadowed per-operation, which merging order handles.
     */
    const sharedParams = Array.isArray(item.parameters)
      ? item.parameters.map((p, i) => readParameter(p, `${pathTemplate} (path-level) #${i}`))
      : [];

    for (const method of HTTP_METHODS) {
      const op = item[method];
      if (op === undefined) continue;
      if (typeof op !== "object" || op === null) {
        throw new Error(`openapi document: ${method.toUpperCase()} ${pathTemplate} is not an object`);
      }
      const o = op as Record<string, unknown>;

      const ownParams = Array.isArray(o.parameters)
        ? o.parameters.map((p, i) => readParameter(p, `${method.toUpperCase()} ${pathTemplate} #${i}`))
        : [];
      const parameters = mergeParameters(sharedParams, ownParams);

      const id =
        typeof o.operationId === "string" && o.operationId.trim() !== ""
          ? o.operationId
          : synthesizeOperationId(method, pathTemplate);
      if (seen.has(id)) {
        throw new Error(`openapi document: duplicate operation id ${id}`);
      }
      seen.add(id);

      const operation: OpenApiOperation = {
        id,
        method,
        path: pathTemplate,
        parameters,
        hasRequestBody:
          hasOwn(o, "requestBody") ||
          hasOwn(o, "body") /* swagger 2.0 spells it `body` */
      };
      if (typeof o.summary === "string") operation.summary = o.summary;
      if (typeof o.description === "string") operation.description = o.description;
      operations.push(operation);
    }
  }

  if (operations.length === 0) {
    throw new Error("openapi document: no operations under `paths`");
  }
  operations.sort((a, b) => a.id.localeCompare(b.id));
  return { operations, info };
}

/**
 * Build the HTTP request for one invocation.
 *
 * The argument contract mirrors MCP's: the kernel passes a positional array,
 * and the adapter maps `args[0]` — which must be a plain object of named
 * arguments. Rules, all strict:
 *
 * - every declared `path` parameter must be present in the arguments;
 * - declared `query`/`header` parameters are consumed when present;
 * - if the operation has a request body, the *remaining* keys become the JSON
 *   body (REST convention: body fields ride at the top level);
 * - if it has no request body, a remaining key is an unknown argument and a
 *   hard error — silently dropping it would paper over a caller bug;
 * - query keys are serialised in sorted order so identical arguments always
 *   produce an identical URL (digest stability, A1).
 */
export function buildHttpRequest(
  op: OpenApiOperation,
  args: unknown[],
  baseUrl: string,
  toolName: string,
  adapterId: string
): { method: string; url: string; headers: Record<string, string>; body?: string } {
  const named = toNamedArguments(args, toolName, adapterId);
  const headers: Record<string, string> = {};

  let path = op.path;
  for (const param of op.parameters) {
    if (param.in !== "path") continue;
    if (!hasOwn(named, param.name)) {
      throw new Error(
        `openapi tool ${toolName} (adapter ${adapterId}) is missing required path parameter ${param.name}`
      );
    }
    const raw = named[param.name];
    if (raw === undefined || raw === null || typeof raw === "object") {
      throw new Error(
        `openapi tool ${toolName} (adapter ${adapterId}) path parameter ${param.name} must be a scalar`
      );
    }
    path = path.replace(`{${param.name}}`, encodeURIComponent(String(raw)));
    delete named[param.name];
  }
  if (/\{[^}]*\}/.test(path)) {
    throw new Error(
      `openapi tool ${toolName} (adapter ${adapterId}) path ${op.path} still contains an unsubstituted parameter`
    );
  }

  const query = new URLSearchParams();
  for (const param of [...op.parameters].sort((a, b) => a.name.localeCompare(b.name))) {
    if (param.in !== "query") continue;
    if (!hasOwn(named, param.name)) continue;
    const raw = named[param.name];
    if (raw === undefined || raw === null || typeof raw === "object") {
      throw new Error(
        `openapi tool ${toolName} (adapter ${adapterId}) query parameter ${param.name} must be a scalar`
      );
    }
    query.append(param.name, String(raw));
    delete named[param.name];
  }

  for (const param of op.parameters) {
    if (param.in !== "header") continue;
    if (!hasOwn(named, param.name)) continue;
    const raw = named[param.name];
    if (raw === undefined || raw === null || typeof raw === "object") {
      throw new Error(
        `openapi tool ${toolName} (adapter ${adapterId}) header parameter ${param.name} must be a scalar`
      );
    }
    headers[param.name] = String(raw);
    delete named[param.name];
  }

  let body: string | undefined;
  const remaining = Object.keys(named);
  if (op.hasRequestBody) {
    if (remaining.length > 0) {
      body = JSON.stringify(named);
      headers["content-type"] = "application/json";
    }
  } else if (remaining.length > 0) {
    throw new Error(
      `openapi tool ${toolName} (adapter ${adapterId}) does not accept a request body; unknown argument(s): ${remaining
        .sort()
        .join(", ")}`
    );
  }

  const qs = query.toString();
  const url = `${baseUrl.replace(/\/+$/, "")}${path}${qs ? `?${qs}` : ""}`;
  return { method: op.method.toUpperCase(), url, headers, body };
}

/** Outcome of mapping an HTTP response body into kernel value space. */
export interface NormalisedHttpResponse {
  value: unknown;
  /**
   * True when the body was not JSON and is returned as a raw string. Covered by
   * the adapter's `reduced` fidelity note rather than dropped.
   */
  degraded: boolean;
  note?: string;
}

/**
 * Map an HTTP response body into the kernel's value space: JSON when the body
 * parses, the raw string otherwise. Status and headers are *not* part of the
 * value — that metadata loss is exactly what the fidelity note discloses.
 */
export function normaliseHttpResponse(status: number, body: string): NormalisedHttpResponse {
  const trimmed = body.trim();
  if (trimmed === "") return { value: null, degraded: false };
  try {
    return { value: JSON.parse(trimmed), degraded: false };
  } catch {
    return {
      value: body,
      degraded: true,
      note: "HTTP response body is not JSON; the raw string is returned instead of coercing it."
    };
  }
}

/** Bounded tail of a body, for error diagnostics. */
export function bodyTail(body: string, limit = BODY_TAIL_LIMIT): string {
  if (body.length <= limit) return body;
  return `${body.slice(0, limit)}… (${body.length} bytes total)`;
}

/** 2xx success check, shared by adapter and tests. */
export function isHttpSuccess(status: number): boolean {
  return status >= 200 && status < 300;
}

/**
 * Resolve the document's own base URL, if it declares one.
 *
 * Pure and conservative: openapi 3 reads `servers[0].url`, swagger 2 composes
 * `schemes[0] + "://" + host + basePath`. Anything else yields `undefined` —
 * the adapter then rejects the config at construction, because an adapter that
 * has no idea where its endpoint lives can only fail at call time, which is
 * strictly worse than failing at registration.
 */
export function resolveDocumentBaseUrl(doc: unknown): string | undefined {
  if (typeof doc !== "object" || doc === null) return undefined;
  const d = doc as Record<string, unknown>;
  if (typeof d.openapi === "string") {
    const servers = d.servers;
    if (!Array.isArray(servers) || servers.length === 0) return undefined;
    const first = servers[0];
    if (typeof first === "object" && first !== null) {
      const url = (first as Record<string, unknown>).url;
      if (typeof url === "string" && url !== "") return url;
    }
    return undefined;
  }
  if (typeof d.swagger === "string") {
    const host = typeof d.host === "string" ? d.host : "";
    if (host === "") return undefined;
    const schemes = Array.isArray(d.schemes) ? d.schemes.filter((s): s is string => typeof s === "string") : [];
    const scheme = schemes.length > 0 ? schemes[0] : "https";
    const basePath = typeof d.basePath === "string" ? d.basePath : "";
    return `${scheme}://${host}${basePath}`;
  }
  return undefined;
}

/* ------------------------------------------------------------------ */

function readInfo(info: unknown): { title?: string; version?: string } {
  if (typeof info !== "object" || info === null) return {};
  const i = info as Record<string, unknown>;
  const out: { title?: string; version?: string } = {};
  if (typeof i.title === "string") out.title = i.title;
  if (typeof i.version === "string") out.version = i.version;
  return out;
}

function readParameter(param: unknown, where: string): OpenApiParameter {
  if (typeof param !== "object" || param === null) {
    throw new Error(`openapi document: parameter at ${where} is not an object`);
  }
  const p = param as Record<string, unknown>;
  if (typeof p.name !== "string" || p.name.trim() === "") {
    throw new Error(`openapi document: parameter at ${where} has no usable name`);
  }
  const in_ = p.in;
  if (in_ !== "path" && in_ !== "query" && in_ !== "header" && in_ !== "cookie") {
    throw new Error(`openapi document: parameter ${p.name} at ${where} has unknown \`in\` ${String(in_)}`);
  }
  if (in_ === "cookie") {
    throw new Error(
      `openapi document: parameter ${p.name} at ${where} is a cookie parameter, which the kernel does not send (ambient credentials are never attached by an adapter)`
    );
  }
  const out: OpenApiParameter = { name: p.name, in: in_ };
  if (p.required === true) out.required = true;
  if (typeof p.description === "string") out.description = p.description;
  return out;
}

function mergeParameters(shared: OpenApiParameter[], own: OpenApiParameter[]): OpenApiParameter[] {
  const byKey = new Map<string, OpenApiParameter>();
  for (const p of [...shared, ...own]) byKey.set(`${p.in}:${p.name}`, p);
  return [...byKey.values()];
}

function synthesizeOperationId(method: string, pathTemplate: string): string {
  const cleaned = pathTemplate.replace(UNSAFE_TOOL_CHARS, "_").replace(/^_+|_+$/g, "");
  const candidate = `${method}_${cleaned}`.replace(UNSAFE_TOOL_CHARS, "_");
  return candidate.replace(/^_+/, "").slice(0, 60) || `${method}_root`;
}

function toNamedArguments(args: unknown[], toolName: string, adapterId: string): Record<string, unknown> {
  if (args.length === 0) return {};
  const first = args[0];
  if (typeof first === "object" && first !== null && !Array.isArray(first)) {
    return { ...(first as Record<string, unknown>) };
  }
  throw new Error(
    `openapi tool ${toolName} (adapter ${adapterId}) expects a single named-argument object; received ${
      Array.isArray(first) ? "an array" : typeof first
    }`
  );
}

function hasOwn(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}
