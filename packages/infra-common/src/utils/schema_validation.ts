/**
 * W31 — progressive parameter contract (Schema 校验).
 *
 * A tool's `schema` is a small, dependency-free shape description. Writing one
 * is an *optional enhancement*: the schema is checked at the gateway and a
 * call whose arguments do not match is rejected with a precise message. Not
 * writing one is fine on sandbox / standard; the `strict` governance tier
 * requires a schema for every plugin (a compliance tier must declare what it
 * accepts).
 *
 * Notation (mirrors a minimal JSON-Schema subset):
 *
 *   { "type": "object",
 *     "properties": { "name":  { "type": "string", "required": true },
 *                      "limit": { "type": "number" } },
 *     "additionalProperties": false }
 *
 *   { "type": "array", "items": { "type": "number" }, "maxItems": 10 }
 *
 * Supported value types: string / number / boolean / object / array / any.
 * Pure function: no random, no clock, no I/O.
 */

export interface SchemaValidationResult {
  ok: boolean;
  /** First failure message, when not ok. */
  error?: string;
  /** Dotted path of the failing argument, when not ok (e.g. "payload.name"). */
  path?: string;
}

export function validateArgsAgainstSchema(schema: Record<string, unknown>, args: unknown[]): SchemaValidationResult {
  const root = schema.type === "array" ? args : args[0];
  return checkValue(schema, root, "arg");
}

function checkValue(schema: Record<string, unknown>, value: unknown, path: string): SchemaValidationResult {
  const type = typeof schema.type === "string" ? schema.type : "any";

  if (type !== "any" && type !== "array" && value === undefined) {
    return { ok: false, error: `expected ${type}, got undefined`, path };
  }

  switch (type) {
    case "string":
      if (typeof value !== "string") return fail(path, type, value);
      return ok;
    case "number":
      if (typeof value !== "number" || Number.isNaN(value)) return fail(path, type, value);
      return ok;
    case "boolean":
      if (typeof value !== "boolean") return fail(path, type, value);
      return ok;
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return fail(path, type, value);
      }
      const props = (schema.properties as Record<string, Record<string, unknown>> | undefined) ?? {};
      const obj = value as Record<string, unknown>;
      for (const [key, sub] of Object.entries(props)) {
        const childPath = `${path}.${key}`;
        if (obj[key] === undefined) {
          if (sub.required === true) {
            return { ok: false, error: `missing required property '${key}'`, path: childPath };
          }
          continue;
        }
        const r = checkValue(sub, obj[key], childPath);
        if (!r.ok) return r;
      }
      if (schema.additionalProperties === false) {
        for (const key of Object.keys(value)) {
          if (!(key in props)) {
            return { ok: false, error: `unexpected property '${key}'`, path: `${path}.${key}` };
          }
        }
      }
      return ok;
    }
    case "array": {
      if (!Array.isArray(value)) return fail(path, type, value);
      const items = (schema.items as Record<string, unknown> | undefined) ?? { type: "any" };
      const max = typeof schema.maxItems === "number" ? schema.maxItems : Infinity;
      if (value.length > max) {
        return { ok: false, error: `array length ${value.length} exceeds maxItems ${max}`, path };
      }
      for (let i = 0; i < value.length; i += 1) {
        const r = checkValue(items, value[i], `${path}[${i}]`);
        if (!r.ok) return r;
      }
      return ok;
    }
    case "any":
    default:
      return ok;
  }
}

function fail(path: string, expected: string, value: unknown): SchemaValidationResult {
  return { ok: false, error: `expected ${expected}, got ${describe(value)}`, path };
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

const ok: SchemaValidationResult = { ok: true };
