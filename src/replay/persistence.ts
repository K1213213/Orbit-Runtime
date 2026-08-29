import { promises as fs } from "node:fs";
import * as path from "node:path";
import { OrbitDomainError } from "../core/orbitDomainError";
import { RecordJournal } from "./record_journal";
import type { ReplayCallRecord } from "./record_journal";
import type { ChannelKind } from "../types/orbitDomain";

/** Magic marker on the first line of every persisted trace file. */
const TRACE_MAGIC = "orbit-trace";
const TRACE_VERSION = 1;

/** A persisted trace file failed structural validation. */
export class TraceFileInvalidError extends OrbitDomainError {
  constructor(message: string, public readonly lineNo?: number) {
    super(message, "TRACE_FILE_INVALID");
  }
}

interface TraceFileHeader {
  magic: string;
  version: number;
  recordCount: number;
}

/**
 * W2: JSONL trace persistence — the substrate for cross-process /
 * cross-machine replay and the `orbit` CLI.
 *
 * File format:
 *   line 1: {"magic":"orbit-trace","version":1,"recordCount":N}
 *   line 2..N+1: one ReplayCallRecord per line, orderIndex == line order
 *
 * Writes are atomic (temp file + rename) so a crash mid-save never leaves a
 * half-written trace behind. Loading validates the header and every record,
 * including orderIndex continuity, and refuses anything malformed.
 */
export async function saveRecordJournal(journal: RecordJournal, filePath: string): Promise<number> {
  const records = journal.snapshot();
  const header: TraceFileHeader = { magic: TRACE_MAGIC, version: TRACE_VERSION, recordCount: records.length };
  const lines = [JSON.stringify(header), ...records.map((r) => JSON.stringify(r))];
  const absTarget = path.resolve(filePath);
  await fs.mkdir(path.dirname(absTarget), { recursive: true });
  const tmpPath = `${absTarget}.tmp`;
  await fs.writeFile(tmpPath, `${lines.join("\n")}\n`, "utf8");
  await fs.rename(tmpPath, absTarget);
  return records.length;
}

/** Load a trace file back into a fresh RecordJournal ready for replay. */
export async function loadRecordJournal(filePath: string): Promise<RecordJournal> {
  let text: string;
  try {
    text = await fs.readFile(filePath, "utf8");
  } catch (err) {
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new TraceFileInvalidError(`trace file not found: ${filePath}`);
    }
    throw err;
  }

  const lines = text.split("\n").filter((line) => line.trim() !== "");
  if (lines.length === 0) {
    throw new TraceFileInvalidError("trace file is empty", 0);
  }

  const header = parseJsonLine<TraceFileHeader>(lines[0], 1);
  if (header.magic !== TRACE_MAGIC) {
    throw new TraceFileInvalidError("not an orbit trace file (bad magic)", 1);
  }
  if (header.version !== TRACE_VERSION) {
    throw new TraceFileInvalidError(`unsupported trace version: ${header.version}`, 1);
  }
  if (typeof header.recordCount !== "number" || header.recordCount !== lines.length - 1) {
    throw new TraceFileInvalidError(
      `header recordCount (${header.recordCount}) does not match the file (${lines.length - 1} records)`,
      1
    );
  }

  const journal = new RecordJournal();
  for (let i = 1; i < lines.length; i += 1) {
    const record = parseJsonLine<ReplayCallRecord>(lines[i], i + 1);
    validateRecord(record, i + 1);
    if (record.orderIndex !== i - 1) {
      throw new TraceFileInvalidError(
        `record orderIndex ${record.orderIndex} breaks continuity (expected ${i - 1})`,
        i + 1
      );
    }
    journal.append({
      channelKind: record.channelKind,
      funcName: record.funcName,
      inputDigest: record.inputDigest,
      outputSnapshot: record.outputSnapshot,
      durationMs: record.durationMs
    });
  }
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

function validateRecord(record: ReplayCallRecord, lineNo: number): void {
  const kind = record.channelKind as unknown;
  if (typeof kind !== "string" || kind === "") {
    throw new TraceFileInvalidError("record missing channelKind", lineNo);
  }
  if (typeof record.funcName !== "string" || record.funcName === "") {
    throw new TraceFileInvalidError("record missing funcName", lineNo);
  }
  if (typeof record.inputDigest !== "string" || record.inputDigest === "") {
    throw new TraceFileInvalidError("record missing inputDigest", lineNo);
  }
  if (typeof record.orderIndex !== "number" || !Number.isInteger(record.orderIndex) || record.orderIndex < 0) {
    throw new TraceFileInvalidError(`record has invalid orderIndex: ${String(record.orderIndex)}`, lineNo);
  }
  if (typeof record.durationMs !== "number" || record.durationMs < 0) {
    throw new TraceFileInvalidError(`record has invalid durationMs: ${String(record.durationMs)}`, lineNo);
  }
  // outputSnapshot may be any JSON value, including null/undefined-shaped markers.
}
