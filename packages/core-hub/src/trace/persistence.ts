import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { TraceJournalEntry } from "@orbit/infra-common";
import { TraceJournal } from "./TraceJournal";
import { TraceFileInvalidError } from "../replay/persistence";

/** Magic marker on the first line of every persisted trace journal file. */
const TRACE_MAGIC = "orbit-trace";
const TRACE_VERSION = 1;

interface TraceFileHeader {
  magic: string;
  version: number;
  entryCount: number;
}

/**
 * W2-era JSONL persistence for the audit/behavior journal, mirroring the
 * replay `RecordJournal` format. Writes are atomic (temp file + rename) so a
 * crash mid-save never leaves a half-written file; loading validates the header
 * and every entry and refuses anything malformed.
 *
 * Note: live durability during a run uses the append-only WAL (`wal.ts`) via
 * `PersistedTraceJournal`; this pair is the explicit checkpoint / export path,
 * symmetric with `saveRecordJournal` / `loadRecordJournal`.
 */
export async function saveTraceJournal(journal: TraceJournal, filePath: string): Promise<number> {
  const entries = journal.snapshot();
  const header: TraceFileHeader = { magic: TRACE_MAGIC, version: TRACE_VERSION, entryCount: entries.length };
  const lines = [JSON.stringify(header), ...entries.map((e) => JSON.stringify(e))];
  const abs = path.resolve(filePath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.tmp`;
  await fs.writeFile(tmp, `${lines.join("\n")}\n`, "utf8");
  await fs.rename(tmp, abs);
  return entries.length;
}

/** Load an audit journal back from disk into a fresh `TraceJournal`. */
export async function loadTraceJournal(filePath: string): Promise<TraceJournal> {
  let text: string;
  try {
    text = await fs.readFile(filePath, "utf8");
  } catch (err) {
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new TraceFileInvalidError(`trace file not found: ${filePath}`);
    }
    throw err;
  }
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  if (lines.length === 0) throw new TraceFileInvalidError("trace file is empty", 0);

  const header = parseJsonLine<TraceFileHeader>(lines[0], 1);
  if (header.magic !== TRACE_MAGIC) throw new TraceFileInvalidError("not an orbit trace file (bad magic)", 1);
  if (header.version !== TRACE_VERSION) throw new TraceFileInvalidError(`unsupported trace version: ${header.version}`, 1);
  if (typeof header.entryCount !== "number" || header.entryCount !== lines.length - 1) {
    throw new TraceFileInvalidError(
      `header entryCount (${header.entryCount}) does not match the file (${lines.length - 1} entries)`,
      1
    );
  }

  const entries: TraceJournalEntry[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const entry = parseJsonLine<TraceJournalEntry>(lines[i], i + 1);
    validateEntry(entry, i + 1);
    entries.push(entry);
  }
  const journal = new TraceJournal();
  journal.restoreSnapshot(entries);
  return journal;
}

// ----------------------------------------------------------------- internals

function parseJsonLine<T>(line: string, lineNo: number): T {
  try {
    return JSON.parse(line) as T;
  } catch {
    throw new TraceFileInvalidError(`line ${lineNo} is not valid JSON`, lineNo);
  }
}

function validateEntry(entry: TraceJournalEntry, lineNo: number): void {
  if (typeof entry.entryUid !== "string" || entry.entryUid === "") {
    throw new TraceFileInvalidError("entry missing entryUid", lineNo);
  }
  if (typeof entry.entryClass !== "string" || entry.entryClass === "") {
    throw new TraceFileInvalidError("entry missing entryClass", lineNo);
  }
  if (typeof entry.occurredAt !== "number" || entry.occurredAt < 0) {
    throw new TraceFileInvalidError(`entry has invalid occurredAt: ${String(entry.occurredAt)}`, lineNo);
  }
  if (typeof entry.traceMarkId !== "string" || entry.traceMarkId === "") {
    throw new TraceFileInvalidError("entry missing traceMarkId", lineNo);
  }
  if (typeof entry.factPayload !== "object" || entry.factPayload === null || Array.isArray(entry.factPayload)) {
    throw new TraceFileInvalidError("entry missing factPayload object", lineNo);
  }
}
