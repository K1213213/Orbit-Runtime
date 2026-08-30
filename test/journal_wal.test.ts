import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  walAppend,
  walCompact,
  walLineCount,
  walRecover,
  walRecoverSync,
  walReset,
  WalFileInvalidError,
  PersistedRecordJournal,
  PersistedTraceJournal,
  RecordJournal,
  TraceJournal,
  ReplayEngine,
  ChannelKind,
  digestInputs
} from "../src/index";

async function tempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/** Structural guard used by the generic-substrate tests. */
function isPair(value: unknown): value is { k: string; n: number } {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.k === "string" && typeof v.n === "number";
}

function seedRecordJournal(journal: RecordJournal): void {
  journal.append({
    channelKind: ChannelKind.LLM_ACCESS,
    funcName: "chatRound",
    inputDigest: digestInputs("hello"),
    outputSnapshot: "hello-back",
    durationMs: 12
  });
  journal.append({
    channelKind: ChannelKind.MEM_KV_STORE,
    funcName: "readEntry",
    inputDigest: digestInputs("k"),
    outputSnapshot: "v",
    durationMs: 1
  });
}

// --------------------------------------------------------------- WAL substrate

test("wal: append then recover roundtrips every line in order", async () => {
  const dir = await tempDir("orbit-wal-");
  const file = path.join(dir, "log.jsonl");
  await walAppend(file, { k: "a", n: 1 });
  await walAppend(file, { k: "b", n: 2 });
  await walAppend(file, { k: "c", n: 3 });

  const recovered = await walRecover(file, isPair);
  assert.deepEqual(recovered, [
    { k: "a", n: 1 },
    { k: "b", n: 2 },
    { k: "c", n: 3 }
  ]);
  await fs.rm(dir, { recursive: true, force: true });
});

test("wal: a missing file recovers as empty (first boot is not an error)", async () => {
  const dir = await tempDir("orbit-wal-");
  const missing = path.join(dir, "never-written.jsonl");
  assert.deepEqual(await walRecover(missing, isPair), []);
  assert.deepEqual(walRecoverSync(missing, isPair), []);
  await fs.rm(dir, { recursive: true, force: true });
});

test("wal: append creates parent directories", async () => {
  const dir = await tempDir("orbit-wal-");
  const file = path.join(dir, "nested", "deep", "log.jsonl");
  await walAppend(file, { k: "a", n: 1 });
  assert.deepEqual(await fs.readdir(path.dirname(file)), ["log.jsonl"]);
  await fs.rm(dir, { recursive: true, force: true });
});

test("wal: a truncated trailing line is dropped, not fatal (crash safety)", async () => {
  const dir = await tempDir("orbit-wal-");
  const file = path.join(dir, "log.jsonl");
  await walAppend(file, { k: "a", n: 1 });
  await walAppend(file, { k: "b", n: 2 });
  // Simulate a crash mid-append: a partial final line with no newline.
  await fs.appendFile(file, '{"k":"c","n":', "utf8");

  const recovered = await walRecover(file, isPair);
  assert.deepEqual(recovered, [
    { k: "a", n: 1 },
    { k: "b", n: 2 }
  ]);
  assert.deepEqual(walRecoverSync(file, isPair), recovered);
  await fs.rm(dir, { recursive: true, force: true });
});

test("wal: a structurally incomplete trailing line is also dropped", async () => {
  const dir = await tempDir("orbit-wal-");
  const file = path.join(dir, "log.jsonl");
  await walAppend(file, { k: "a", n: 1 });
  // Parses as JSON, but fails the structural guard — a half-written entry.
  await fs.appendFile(file, '{"k":"b"}\n', "utf8");
  assert.deepEqual(await walRecover(file, isPair), [{ k: "a", n: 1 }]);
  await fs.rm(dir, { recursive: true, force: true });
});

test("wal: a corrupt interior line is a genuine fault, rejected with its line number", async () => {
  const dir = await tempDir("orbit-wal-");
  const file = path.join(dir, "log.jsonl");
  await walAppend(file, { k: "a", n: 1 });
  await fs.appendFile(file, "not-json\n", "utf8");
  await walAppend(file, { k: "c", n: 3 });

  await assert.rejects(walRecover(file, isPair), (err: unknown) => {
    assert.ok(err instanceof WalFileInvalidError);
    assert.equal(err.lineNo, 2);
    assert.match(err.message, /not valid JSON/);
    return true;
  });
  assert.throws(() => walRecoverSync(file, isPair), WalFileInvalidError);
  await fs.rm(dir, { recursive: true, force: true });
});

test("wal: an invalid interior entry is rejected by structural validation", async () => {
  const dir = await tempDir("orbit-wal-");
  const file = path.join(dir, "log.jsonl");
  await walAppend(file, { k: "a", n: 1 });
  await fs.appendFile(file, '{"k":"b"}\n', "utf8"); // missing n
  await walAppend(file, { k: "c", n: 3 });

  await assert.rejects(walRecover(file, isPair), (err: unknown) => {
    assert.ok(err instanceof WalFileInvalidError);
    assert.equal(err.lineNo, 2);
    assert.match(err.message, /structural validation/);
    return true;
  });
  await fs.rm(dir, { recursive: true, force: true });
});

test("wal: reset truncates the log so a new window starts clean", async () => {
  const dir = await tempDir("orbit-wal-");
  const file = path.join(dir, "log.jsonl");
  await walAppend(file, { k: "a", n: 1 });
  await walReset(file);
  assert.deepEqual(await walRecover(file, isPair), []);
  await walAppend(file, { k: "z", n: 9 });
  assert.deepEqual(await walRecover(file, isPair), [{ k: "z", n: 9 }]);
  await fs.rm(dir, { recursive: true, force: true });
});

// ------------------------------------------------ PersistedRecordJournal

test("persisted record journal: appends are mirrored to the WAL and replay verbatim", async () => {
  const dir = await tempDir("orbit-precj-");
  const file = path.join(dir, "record.wal.jsonl");
  const journal = new PersistedRecordJournal(file);
  seedRecordJournal(journal);
  await journal.flush();

  const recovered = await PersistedRecordJournal.recover(file);
  assert.equal(recovered.size(), 2);
  // Byte-identical recovery: entryUid / orderIndex / payloads all preserved.
  assert.deepEqual(recovered.snapshot(), journal.snapshot());

  const engine = new ReplayEngine(recovered);
  assert.equal(engine.replayCall(ChannelKind.LLM_ACCESS, "chatRound", digestInputs("hello"), 0), "hello-back");
  assert.equal(engine.replayCall(ChannelKind.MEM_KV_STORE, "readEntry", digestInputs("k"), 1), "v");
  await fs.rm(dir, { recursive: true, force: true });
});

test("persisted record journal: writes are serialised so lines never interleave", async () => {
  const dir = await tempDir("orbit-precj-");
  const file = path.join(dir, "record.wal.jsonl");
  const journal = new PersistedRecordJournal(file);
  for (let i = 0; i < 40; i += 1) {
    journal.append({
      channelKind: ChannelKind.MEM_KV_STORE,
      funcName: "readEntry",
      inputDigest: digestInputs(`k${i}`),
      outputSnapshot: `v${i}`,
      durationMs: i
    });
  }
  await journal.flush();

  const lines = (await fs.readFile(file, "utf8")).split("\n").filter((l) => l.trim() !== "");
  assert.equal(lines.length, 40);
  const recovered = await PersistedRecordJournal.recover(file);
  assert.equal(recovered.size(), 40);
  recovered.snapshot().forEach((rec, i) => {
    assert.equal(rec.orderIndex, i);
    assert.equal(rec.outputSnapshot, `v${i}`);
  });
  await fs.rm(dir, { recursive: true, force: true });
});

test("persisted record journal: recovered window continues orderIndex without a gap", async () => {
  const dir = await tempDir("orbit-precj-");
  const file = path.join(dir, "record.wal.jsonl");
  const first = new PersistedRecordJournal(file);
  seedRecordJournal(first);
  await first.flush();

  const resumed = await PersistedRecordJournal.recover(file);
  const next = resumed.append({
    channelKind: ChannelKind.LLM_ACCESS,
    funcName: "chatRound",
    inputDigest: digestInputs("again"),
    outputSnapshot: "again-back",
    durationMs: 5
  });
  assert.equal(next.orderIndex, 2); // continues, does not restart at 0
  await resumed.flush();

  const reloaded = await PersistedRecordJournal.recover(file);
  assert.equal(reloaded.size(), 3);
  assert.deepEqual(
    reloaded.snapshot().map((r) => r.orderIndex),
    [0, 1, 2]
  );
  await fs.rm(dir, { recursive: true, force: true });
});

test("persisted record journal: truncate opens a fresh window over the same path", async () => {
  const dir = await tempDir("orbit-precj-");
  const file = path.join(dir, "record.wal.jsonl");
  const first = new PersistedRecordJournal(file);
  seedRecordJournal(first);
  await first.flush();

  const fresh = new PersistedRecordJournal(file, { truncate: true });
  fresh.append({
    channelKind: ChannelKind.MEM_KV_STORE,
    funcName: "writeEntry",
    inputDigest: digestInputs("k2"),
    outputSnapshot: true,
    durationMs: 1
  });
  await fresh.flush();

  const reloaded = await PersistedRecordJournal.recover(file);
  assert.equal(reloaded.size(), 1);
  assert.equal(reloaded.get(0)!.funcName, "writeEntry");
  await fs.rm(dir, { recursive: true, force: true });
});

test("persisted record journal: no path degrades to pure in-memory (flush is a no-op)", async () => {
  const journal = new PersistedRecordJournal();
  seedRecordJournal(journal);
  await journal.flush();
  assert.equal(journal.size(), 2);
});

test("persisted record journal: sync recovery matches async recovery", async () => {
  const dir = await tempDir("orbit-precj-");
  const file = path.join(dir, "record.wal.jsonl");
  const journal = new PersistedRecordJournal(file);
  seedRecordJournal(journal);
  await journal.flush();

  const sync = PersistedRecordJournal.recoverSync(file);
  const async_ = await PersistedRecordJournal.recover(file);
  assert.deepEqual(sync.snapshot(), async_.snapshot());
  await fs.rm(dir, { recursive: true, force: true });
});

// ------------------------------------------------- PersistedTraceJournal

test("persisted trace journal: audit entries survive a reload byte-identically", async () => {
  const dir = await tempDir("orbit-ptj-");
  const file = path.join(dir, "trace.wal.jsonl");
  const journal = new PersistedTraceJournal(file);
  journal.append({ entryClass: "boot", traceMarkId: "t1", factPayload: { stage: "channels" } });
  journal.append({ entryClass: "guard.trip", traceMarkId: "t2", pluginUnitId: "p1", factPayload: { reason: "quota" } });
  await journal.flush();

  const recovered = await PersistedTraceJournal.recover(file);
  assert.deepEqual(recovered.snapshot(), journal.snapshot());
  assert.equal(recovered.byPluginUnit("p1").length, 1);
  assert.equal(recovered.byEntryClass("boot").length, 1);
  await fs.rm(dir, { recursive: true, force: true });
});

test("persisted trace journal: load() replays the WAL into an existing instance", async () => {
  const dir = await tempDir("orbit-ptj-");
  const file = path.join(dir, "trace.wal.jsonl");
  const writer = new PersistedTraceJournal(file);
  writer.append({ entryClass: "boot", traceMarkId: "t1", factPayload: {} });
  await writer.flush();

  const reader = new PersistedTraceJournal(file);
  assert.equal(reader.entries().length, 0);
  await reader.load();
  assert.equal(reader.entries().length, 1);
  assert.equal(reader.entries()[0].entryClass, "boot");
  await fs.rm(dir, { recursive: true, force: true });
});

test("persisted trace journal: a truncated tail is dropped on recovery", async () => {
  const dir = await tempDir("orbit-ptj-");
  const file = path.join(dir, "trace.wal.jsonl");
  const journal = new PersistedTraceJournal(file);
  journal.append({ entryClass: "boot", traceMarkId: "t1", factPayload: {} });
  await journal.flush();
  await fs.appendFile(file, '{"entryClass":"half', "utf8");

  const recovered = await PersistedTraceJournal.recover(file);
  assert.equal(recovered.entries().length, 1);
  await fs.rm(dir, { recursive: true, force: true });
});

test("persisted trace journal: no path behaves exactly like the base journal", async () => {
  const journal = new PersistedTraceJournal();
  journal.append({ entryClass: "boot", traceMarkId: "t1", factPayload: {} });
  await journal.load();
  await journal.flush();
  assert.equal(journal.entries().length, 1);
});

test("base journals expose no-op durability hooks (uniform call sites)", async () => {
  const trace = new TraceJournal();
  const record = new RecordJournal();
  await trace.load();
  await trace.flush();
  await record.flush();
  assert.equal(trace.entries().length, 0);
  assert.equal(record.size(), 0);
});

// ------------------------------------------------------- compaction / retention

test("wal compact: rewrites the log to exactly the given entries, in order", async () => {
  const dir = await tempDir("orbit-walc-");
  const file = path.join(dir, "log.jsonl");
  await walAppend(file, { k: "a", n: 1 });
  await walAppend(file, { k: "b", n: 2 });
  await walAppend(file, { k: "c", n: 3 });

  const written = await walCompact(file, [
    { k: "b", n: 2 },
    { k: "c", n: 3 }
  ]);
  assert.equal(written, 2);
  assert.deepEqual(await walRecover(file, isPair), [
    { k: "b", n: 2 },
    { k: "c", n: 3 }
  ]);
  await fs.rm(dir, { recursive: true, force: true });
});

test("wal compact: an empty entry list yields an empty (not deleted) log", async () => {
  const dir = await tempDir("orbit-walc-");
  const file = path.join(dir, "log.jsonl");
  await walAppend(file, { k: "a", n: 1 });

  assert.equal(await walCompact(file, []), 0);
  assert.equal(await fs.readFile(file, "utf8"), "");
  assert.deepEqual(await walRecover(file, isPair), []);
  // The log stays usable: a later append starts a clean generation.
  await walAppend(file, { k: "z", n: 9 });
  assert.deepEqual(await walRecover(file, isPair), [{ k: "z", n: 9 }]);
  await fs.rm(dir, { recursive: true, force: true });
});

test("wal compact: physically heals a crash-truncated tail", async () => {
  const dir = await tempDir("orbit-walc-");
  const file = path.join(dir, "log.jsonl");
  await walAppend(file, { k: "a", n: 1 });
  await walAppend(file, { k: "b", n: 2 });
  await fs.appendFile(file, '{"k":"c","n":', "utf8");

  // Recovery tolerates the partial line, but it is still on disk...
  const surviving = await walRecover(file, isPair);
  assert.ok((await fs.readFile(file, "utf8")).includes('{"k":"c","n":'));

  // ...until a compaction rewrites the file from the surviving prefix.
  await walCompact(file, surviving);
  const healed = await fs.readFile(file, "utf8");
  assert.ok(!healed.includes('{"k":"c","n":'));
  assert.equal(healed.split("\n").filter((l) => l.trim() !== "").length, 2);
  assert.deepEqual(await walRecover(file, isPair), surviving);
  await fs.rm(dir, { recursive: true, force: true });
});

test("wal compact: leaves no temporary file behind and creates parent directories", async () => {
  const dir = await tempDir("orbit-walc-");
  const file = path.join(dir, "nested", "log.jsonl");
  await walCompact(file, [{ k: "a", n: 1 }]);
  assert.deepEqual(await fs.readdir(path.dirname(file)), ["log.jsonl"]);
  await fs.rm(dir, { recursive: true, force: true });
});

test("wal line count: a mismatch against recovery is what flags a log for healing", async () => {
  const dir = await tempDir("orbit-walc-");
  const file = path.join(dir, "log.jsonl");
  assert.equal(await walLineCount(file), 0, "a missing log counts as empty");

  await walAppend(file, { k: "a", n: 1 });
  await walAppend(file, { k: "b", n: 2 });
  assert.equal(await walLineCount(file), 2);
  assert.equal((await walRecover(file, isPair)).length, 2, "healthy: counts agree");

  await fs.appendFile(file, '{"k":"c","n":', "utf8");
  assert.equal(await walLineCount(file), 3);
  assert.equal((await walRecover(file, isPair)).length, 2, "damaged: counts disagree");

  await walCompact(file, await walRecover(file, isPair));
  assert.equal(await walLineCount(file), 2, "healed: counts agree again");
  await fs.rm(dir, { recursive: true, force: true });
});

test("persisted journals: healIfNeeded rewrites only a damaged log", async () => {
  const dir = await tempDir("orbit-heal-");
  const recordFile = path.join(dir, "record.wal.jsonl");
  const traceFile = path.join(dir, "trace.wal.jsonl");

  const writer = new PersistedRecordJournal(recordFile);
  seedRecordJournal(writer);
  await writer.flush();

  // Healthy log: no rewrite, and the bytes are left exactly as they were.
  const healthy = await PersistedRecordJournal.recover(recordFile);
  const before = await fs.readFile(recordFile, "utf8");
  assert.equal(await healthy.healIfNeeded(), false);
  assert.equal(await fs.readFile(recordFile, "utf8"), before);

  // Damaged log: rewritten from the surviving prefix.
  await fs.appendFile(recordFile, '{"entryUid":"half', "utf8");
  const damaged = await PersistedRecordJournal.recover(recordFile);
  assert.equal(await damaged.healIfNeeded(), true);
  assert.equal(await fs.readFile(recordFile, "utf8"), before);

  // Same contract on the trace side, driven through load().
  const trace = new PersistedTraceJournal(traceFile);
  trace.append({ entryClass: "boot", traceMarkId: "t1", factPayload: {} });
  await trace.flush();
  const traceBefore = await fs.readFile(traceFile, "utf8");
  await fs.appendFile(traceFile, '{"entryUid":"half', "utf8");

  const reader = new PersistedTraceJournal(traceFile);
  await reader.load(); // load() heals as part of recovery
  assert.equal(await fs.readFile(traceFile, "utf8"), traceBefore);
  assert.equal(await reader.healIfNeeded(reader.entries().length), false);

  // No path: healing is a no-op rather than an error.
  assert.equal(await new PersistedRecordJournal().healIfNeeded(), false);
  assert.equal(await new PersistedTraceJournal().healIfNeeded(0), false);
  await fs.rm(dir, { recursive: true, force: true });
});

test("persisted record journal: compact heals a truncated tail without losing calls", async () => {
  const dir = await tempDir("orbit-precj-");
  const file = path.join(dir, "record.wal.jsonl");
  const journal = new PersistedRecordJournal(file);
  seedRecordJournal(journal);
  await journal.flush();
  await fs.appendFile(file, '{"entryUid":"half', "utf8");

  const resumed = await PersistedRecordJournal.recover(file);
  assert.equal(resumed.size(), 2);
  assert.equal(await resumed.compact(), 2);

  const raw = await fs.readFile(file, "utf8");
  assert.ok(!raw.includes('{"entryUid":"half'));
  const reloaded = await PersistedRecordJournal.recover(file);
  assert.deepEqual(reloaded.snapshot(), resumed.snapshot());
  await fs.rm(dir, { recursive: true, force: true });
});

test("persisted record journal: compact is ordered after pending appends", async () => {
  const dir = await tempDir("orbit-precj-");
  const file = path.join(dir, "record.wal.jsonl");
  const journal = new PersistedRecordJournal(file);
  seedRecordJournal(journal);
  // Deliberately do not flush: compaction must queue behind the pending writes.
  assert.equal(await journal.compact(), 2);
  await journal.flush();

  const reloaded = await PersistedRecordJournal.recover(file);
  assert.deepEqual(reloaded.snapshot(), journal.snapshot());
  await fs.rm(dir, { recursive: true, force: true });
});

test("persisted record journal: compact is a no-op without a path", async () => {
  const journal = new PersistedRecordJournal();
  seedRecordJournal(journal);
  assert.equal(await journal.compact(), 0);
  assert.equal(journal.size(), 2);
});

test("persisted trace journal: retainLast bounds the durable audit log", async () => {
  const dir = await tempDir("orbit-ptj-");
  const file = path.join(dir, "trace.wal.jsonl");
  const journal = new PersistedTraceJournal(file);
  for (let i = 0; i < 10; i += 1) {
    journal.append({ entryClass: "tick", traceMarkId: `t${i}`, factPayload: { i } });
  }
  await journal.flush();
  assert.equal((await PersistedTraceJournal.recover(file)).entries().length, 10);

  assert.equal(await journal.retainLast(3), 3);
  assert.deepEqual(
    journal.entries().map((e) => e.traceMarkId),
    ["t7", "t8", "t9"]
  );

  const reloaded = await PersistedTraceJournal.recover(file);
  assert.deepEqual(reloaded.snapshot(), journal.snapshot());
  await fs.rm(dir, { recursive: true, force: true });
});

test("persisted trace journal: retainLast(0) clears memory and disk together", async () => {
  const dir = await tempDir("orbit-ptj-");
  const file = path.join(dir, "trace.wal.jsonl");
  const journal = new PersistedTraceJournal(file);
  journal.append({ entryClass: "boot", traceMarkId: "t1", factPayload: {} });
  await journal.flush();

  assert.equal(await journal.retainLast(0), 0);
  assert.equal(journal.entries().length, 0);
  assert.equal(await fs.readFile(file, "utf8"), "");
  // Still writable afterwards — retention does not retire the journal.
  journal.append({ entryClass: "boot", traceMarkId: "t2", factPayload: {} });
  await journal.flush();
  assert.equal((await PersistedTraceJournal.recover(file)).entries().length, 1);
  await fs.rm(dir, { recursive: true, force: true });
});

test("persisted trace journal: retainLast above the current size keeps everything", async () => {
  const dir = await tempDir("orbit-ptj-");
  const file = path.join(dir, "trace.wal.jsonl");
  const journal = new PersistedTraceJournal(file);
  journal.append({ entryClass: "boot", traceMarkId: "t1", factPayload: {} });
  journal.append({ entryClass: "boot", traceMarkId: "t2", factPayload: {} });
  await journal.flush();

  assert.equal(await journal.retainLast(50), 2);
  assert.deepEqual((await PersistedTraceJournal.recover(file)).snapshot(), journal.snapshot());
  await fs.rm(dir, { recursive: true, force: true });
});

test("persisted trace journal: retainLast rejects a non-integer or negative bound", async () => {
  const journal = new PersistedTraceJournal();
  await assert.rejects(() => journal.retainLast(-1), RangeError);
  await assert.rejects(() => journal.retainLast(1.5), RangeError);
  await assert.rejects(() => journal.retainLast(Number.NaN), RangeError);
});

test("persisted trace journal: compact heals a truncated tail and no-ops without a path", async () => {
  const dir = await tempDir("orbit-ptj-");
  const file = path.join(dir, "trace.wal.jsonl");
  const journal = new PersistedTraceJournal(file);
  journal.append({ entryClass: "boot", traceMarkId: "t1", factPayload: {} });
  await journal.flush();
  await fs.appendFile(file, '{"entryUid":"half', "utf8");

  const resumed = await PersistedTraceJournal.recover(file);
  assert.equal(await resumed.compact(), 1);
  assert.ok(!(await fs.readFile(file, "utf8")).includes('{"entryUid":"half'));

  assert.equal(await new PersistedTraceJournal().compact(), 0);
  await fs.rm(dir, { recursive: true, force: true });
});

// --------------------------------------------------- failed writes must surface

/**
 * A WAL path that cannot be written: its parent is a regular file, so the
 * `mkdir` inside every WAL write fails (EEXIST here, ENOTDIR on POSIX). Either
 * way the write is refused — the exact errno is the platform's business.
 */
async function unwritableWalPath(prefix: string): Promise<{ dir: string; file: string }> {
  const dir = await tempDir(prefix);
  const blocker = path.join(dir, "blocker");
  await fs.writeFile(blocker, "not a directory", "utf8");
  return { dir, file: path.join(blocker, "log.jsonl") };
}

test("persisted record journal: a lost append makes flush() reject", async () => {
  const { dir, file } = await unwritableWalPath("orbit-walfail-");
  const journal = new PersistedRecordJournal(file);
  // The append itself must not throw: a failed disk write cannot abort a call
  // that is already in flight.
  seedRecordJournal(journal);
  assert.equal(journal.size(), 2, "the in-memory journal is still the source of truth");

  await assert.rejects(journal.flush(), (err: unknown) => {
    assert.ok(err instanceof Error);
    return true;
  });
  await fs.rm(dir, { recursive: true, force: true });
});

test("persisted trace journal: a lost append makes flush() reject", async () => {
  const { dir, file } = await unwritableWalPath("orbit-walfail-");
  const journal = new PersistedTraceJournal(file);
  journal.append({ entryClass: "boot", traceMarkId: "t1", factPayload: {} });

  await assert.rejects(journal.flush(), (err: unknown) => {
    assert.ok(err instanceof Error);
    return true;
  });
  await fs.rm(dir, { recursive: true, force: true });
});

test("persisted journals: flush() stays rejected so a retry cannot report a false success", async () => {
  const { dir, file } = await unwritableWalPath("orbit-walfail-");
  const journal = new PersistedRecordJournal(file);
  seedRecordJournal(journal);

  await assert.rejects(journal.flush());
  // Sticky on purpose: once a write has been lost, no later flush may claim the
  // record is durable. Otherwise `shutdownHost` could report a clean shutdown
  // for a window it silently dropped.
  await assert.rejects(journal.flush());
  await fs.rm(dir, { recursive: true, force: true });
});

test("persisted record journal: a failed truncate surfaces through flush(), not the constructor", async () => {
  const { dir, file } = await unwritableWalPath("orbit-walfail-");
  // Constructing must not throw — a bad path is a durability problem to report
  // at flush time, not a reason the host cannot boot.
  const journal = new PersistedRecordJournal(file, { truncate: true });
  await assert.rejects(journal.flush());
  await fs.rm(dir, { recursive: true, force: true });
});

test("persisted record journal: a failed compaction is not swallowed before flush()", async () => {
  const { dir, file } = await unwritableWalPath("orbit-walfail-");
  const journal = new PersistedRecordJournal(file);
  seedRecordJournal(journal);

  // compact() rejects for its own caller...
  await assert.rejects(journal.compact());
  // ...and the failure is still parked for flush(), which is what a shutdown
  // path actually awaits.
  await assert.rejects(journal.flush());
  await fs.rm(dir, { recursive: true, force: true });
});

test("persisted trace journal: a failed compaction is not swallowed before flush()", async () => {
  const { dir, file } = await unwritableWalPath("orbit-walfail-");
  const journal = new PersistedTraceJournal(file);
  journal.append({ entryClass: "boot", traceMarkId: "t1", factPayload: {} });

  await assert.rejects(journal.compact());
  await assert.rejects(journal.flush());
  await fs.rm(dir, { recursive: true, force: true });
});

test("persisted record journal: healIfNeeded propagates a failed compaction", async () => {
  const { dir, file } = await unwritableWalPath("orbit-walfail-");
  const journal = new PersistedRecordJournal(file);
  seedRecordJournal(journal);

  // The line count (0) disagrees with size() (2), so healing is attempted and
  // the failed rewrite must not be quietly ignored.
  await assert.rejects(journal.healIfNeeded());
  await fs.rm(dir, { recursive: true, force: true });
});

test("persisted journals: a writable path still flushes cleanly (no false positives)", async () => {
  const dir = await tempDir("orbit-walok-");
  const file = path.join(dir, "record.wal.jsonl");
  const journal = new PersistedRecordJournal(file);
  seedRecordJournal(journal);
  await assert.doesNotReject(journal.flush());
  assert.equal((await PersistedRecordJournal.recover(file)).size(), 2);
  await fs.rm(dir, { recursive: true, force: true });
});

test("persisted journals: appends after a failure still queue (the chain never breaks)", async () => {
  const dir = await tempDir("orbit-walfail-");
  const blocker = path.join(dir, "blocker");
  await fs.writeFile(blocker, "not a directory", "utf8");
  const file = path.join(blocker, "log.jsonl");

  const journal = new PersistedRecordJournal(file);
  seedRecordJournal(journal);
  await assert.rejects(journal.flush());
  // A journal that stopped accepting work after one bad write would break the
  // live run as well as the durable one.
  journal.append({
    channelKind: ChannelKind.MEM_KV_STORE,
    funcName: "writeEntry",
    inputDigest: digestInputs("k3"),
    outputSnapshot: true,
    durationMs: 1
  });
  assert.equal(journal.size(), 3);
  await assert.rejects(journal.flush());
  await fs.rm(dir, { recursive: true, force: true });
});
