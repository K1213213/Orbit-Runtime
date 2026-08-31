import { createHash } from "node:crypto";

const UNDEFINED_MARKER = "__undefined__";

/** Canonical SHA-256 digest of call inputs; stable across identical argument lists. */
export function digestInputs(...args: unknown[]): string {
  const canonical = JSON.stringify(args, (_key, value) => (value === undefined ? UNDEFINED_MARKER : value));
  return createHash("sha256").update(canonical).digest("hex");
}
