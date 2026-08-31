import { promises as fs, readFileSync, existsSync } from "node:fs";
import * as path from "node:path";
import { OrbitDomainError } from "@orbit/infra-common";

/**
 * Crash-safe append-only JSONL substrate for journal durability.
 *
 * Every journal entry is one JSON line. A write appends a single line, so the
 * only thing a crash mid-write can leave behind is a *partial final line*.
 * Recovery is therefore tolerant of exactly one truncated trailing line (it is
 * dropped, never parsed) while any corrupt or structurally invalid *interior*
 * line is treated as a genuine fault and rejected. This is the same guarantee
 * class as an append-only write-ahead log: the in-memory journal stays the
 * source of truth for correctness; the WAL is its durable mirror.
 */
export class WalFileInvalidError extends OrbitDomainError {
  constructor(message: string, public readonly lineNo?: number) {
    super(message, "WAL_FILE_INVALID");
  }
}

/** Append one entry as a single JSON line. Creates parent directories. */
export async function walAppend(filePath: string, entry: unknown): Promise<void> {
  const abs = path.resolve(filePath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.appendFile(abs, `${JSON.stringify(entry)}\n`, "utf8");
}

/**
 * Truncate a WAL to empty, creating its parent directories. Used when a *new*
 * durable window opens: the previous window's lines must not bleed into it.
 * Enqueue this ahead of the append chain so ordering is guaranteed.
 */
export async function walReset(filePath: string): Promise<void> {
  const abs = path.resolve(filePath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, "", "utf8");
}

/**
 * Atomically rewrite a WAL so it contains exactly `entries`, in order.
 *
 * Two jobs: it *heals* a file whose tail was truncated by a crash (the partial
 * line is dropped at recovery but stays on disk until a rewrite removes it), and
 * it *bounds* growth when a caller applies a retention policy. The write is
 * temp-file + rename, so a crash during compaction leaves the previous
 * generation intact rather than a half-written log.
 *
 * @returns the number of lines written.
 */
export async function walCompact(filePath: string, entries: readonly unknown[]): Promise<number> {
  const abs = path.resolve(filePath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  const body = entries.length === 0 ? "" : `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`;
  const tmp = `${abs}.compact.tmp`;
  await fs.writeFile(tmp, body, "utf8");
  await fs.rename(tmp, abs);
  return entries.length;
}

/**
 * Number of non-blank lines physically present in a WAL (0 when missing).
 *
 * Compared against the count returned by recovery this answers "does this file
 * need healing?" — a mismatch means recovery dropped a crash-truncated tail that
 * is still on disk. Callers use it to avoid rewriting a healthy log on boot.
 */
export async function walLineCount(filePath: string): Promise<number> {
  return (await readLines(filePath)).length;
}

/** Read every non-blank line of a WAL file; a missing file yields []. */
async function readLines(filePath: string): Promise<string[]> {
  let text: string;
  try {
    text = await fs.readFile(filePath, "utf8");
  } catch (err) {
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return text.split("\n").filter((line) => line.trim() !== "");
}

function recoverFromLines<T>(
  lines: string[],
  validate: (value: unknown) => value is T
): T[] {
  const out: T[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const isLast = i === lines.length - 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(lines[i]);
    } catch {
      // A truncated final line from a crash is dropped, not fatal.
      if (isLast) return out;
      throw new WalFileInvalidError(`line ${i + 1} is not valid JSON`, i + 1);
    }
    if (!validate(parsed)) {
      // A half-written final entry may parse yet be incomplete; drop it.
      if (isLast) return out;
      throw new WalFileInvalidError(`line ${i + 1} failed structural validation`, i + 1);
    }
    out.push(parsed as T);
  }
  return out;
}

/**
 * Recover a WAL into typed entries. Tolerant of a single truncated trailing
 * line; rejects any corrupt or invalid interior line as {@link WalFileInvalidError}.
 */
export async function walRecover<T>(
  filePath: string,
  validate: (value: unknown) => value is T
): Promise<T[]> {
  const lines = await readLines(filePath);
  return recoverFromLines(lines, validate);
}

/** Synchronous variant of {@link walRecover}, for callers that cannot await. */
export function walRecoverSync<T>(
  filePath: string,
  validate: (value: unknown) => value is T
): T[] {
  if (!existsSync(filePath)) return [];
  const text = readFileSync(filePath, "utf8");
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  return recoverFromLines(lines, validate);
}
