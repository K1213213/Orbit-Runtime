import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { RecordJournal } from "../src/replay/record_journal";
import { ReplayEngine } from "../src/replay/replay_engine";
import { saveRecordJournal, loadRecordJournal, TraceFileInvalidError } from "../src/replay/persistence";
import { digestInputs } from "../src/utils/digest";
import { ChannelKind } from "../src/types/orbitDomain";

async function tempTracePath(name: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-trace-"));
  return path.join(dir, name);
}

function journalWithCalls(): RecordJournal {
  const journal = new RecordJournal();
  journal.append({
    channelKind: ChannelKind.LLM_ACCESS,
    funcName: "chatRound",
    inputDigest: digestInputs("hello"),
    outputSnapshot: "hello-back",
    durationMs: 320
  });
  journal.append({
    channelKind: ChannelKind.FILE_SYSTEM,
    funcName: "readTextFile",
    inputDigest: digestInputs("a.txt"),
    outputSnapshot: "file-content",
    durationMs: 2
  });
  return journal;
}

test("persistence: save + load roundtrips a journal intact", async () => {
  const file = await tempTracePath("trace.jsonl");
  const original = journalWithCalls();
  const count = await saveRecordJournal(original, file);
  assert.equal(count, 2);

  const loaded = await loadRecordJournal(file);
  assert.equal(loaded.size(), 2);
  const engine = new ReplayEngine(loaded);
  const out = engine.replayCall(ChannelKind.LLM_ACCESS, "chatRound", digestInputs("hello"), 0);
  assert.equal(out, "hello-back");
  const fileOut = engine.replayCall(ChannelKind.FILE_SYSTEM, "readTextFile", digestInputs("a.txt"), 1);
  assert.equal(fileOut, "file-content");
  await fs.rm(path.dirname(file), { recursive: true, force: true });
});

test("persistence: file format is JSONL with a header line", async () => {
  const file = await tempTracePath("trace.jsonl");
  await saveRecordJournal(journalWithCalls(), file);
  const lines = (await fs.readFile(file, "utf8")).split("\n").filter((l) => l.trim() !== "");
  assert.equal(lines.length, 3);
  const header = JSON.parse(lines[0]) as { magic: string; version: number; recordCount: number };
  assert.deepEqual(header, { magic: "orbit-trace", version: 1, recordCount: 2 });
  const first = JSON.parse(lines[1]) as { funcName: string; orderIndex: number };
  assert.equal(first.funcName, "chatRound");
  assert.equal(first.orderIndex, 0);
  await fs.rm(path.dirname(file), { recursive: true, force: true });
});

test("persistence: save creates parent directories and is atomic (no .tmp left behind)", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-trace-dir-"));
  const file = path.join(dir, "nested", "deep", "trace.jsonl");
  await saveRecordJournal(journalWithCalls(), file);
  const entries = await fs.readdir(path.dirname(file));
  assert.deepEqual(entries, ["trace.jsonl"]);
  await fs.rm(dir, { recursive: true, force: true });
});

test("persistence: empty journal saves and loads back empty", async () => {
  const file = await tempTracePath("empty.jsonl");
  await saveRecordJournal(new RecordJournal(), file);
  const loaded = await loadRecordJournal(file);
  assert.equal(loaded.size(), 0);
  await fs.rm(path.dirname(file), { recursive: true, force: true });
});

test("persistence: missing file throws TraceFileInvalidError", async () => {
  await assert.rejects(
    loadRecordJournal(path.join(os.tmpdir(), "orbit-trace-nope.jsonl")),
    (err: unknown) => {
      assert.ok(err instanceof TraceFileInvalidError);
      assert.match(err.message, /not found/);
      return true;
    }
  );
});

test("persistence: non-trace files are rejected (bad magic)", async () => {
  const file = await tempTracePath("foreign.jsonl");
  await fs.writeFile(file, '{"hello":"world"}\n', "utf8");
  await assert.rejects(loadRecordJournal(file), (err: unknown) => {
    assert.ok(err instanceof TraceFileInvalidError);
    assert.match(err.message, /bad magic/);
    return true;
  });
  await fs.rm(path.dirname(file), { recursive: true, force: true });
});

test("persistence: recordCount mismatch is rejected", async () => {
  const file = await tempTracePath("mismatch.jsonl");
  const original = journalWithCalls();
  await saveRecordJournal(original, file);
  const lines = (await fs.readFile(file, "utf8")).split("\n").filter((l) => l.trim() !== "");
  const header = JSON.parse(lines[0]) as { magic: string; version: number; recordCount: number };
  header.recordCount = 99;
  lines[0] = JSON.stringify(header);
  await fs.writeFile(file, `${lines.join("\n")}\n`, "utf8");
  await assert.rejects(loadRecordJournal(file), (err: unknown) => {
    assert.ok(err instanceof TraceFileInvalidError);
    assert.match(err.message, /recordCount/);
    return true;
  });
  await fs.rm(path.dirname(file), { recursive: true, force: true });
});

test("persistence: tampered record content is caught by replay digest", async () => {
  const file = await tempTracePath("tampered.jsonl");
  await saveRecordJournal(journalWithCalls(), file);
  const lines = (await fs.readFile(file, "utf8")).split("\n").filter((l) => l.trim() !== "");
  const record = JSON.parse(lines[1]) as { outputSnapshot: unknown };
  record.outputSnapshot = "tampered";
  lines[1] = JSON.stringify(record);
  await fs.writeFile(file, `${lines.join("\n")}\n`, "utf8");

  // Structural load succeeds; the tampering surfaces at replay as a drift.
  const loaded = await loadRecordJournal(file);
  const engine = new ReplayEngine(loaded);
  const out = engine.replayCall(ChannelKind.LLM_ACCESS, "chatRound", digestInputs("hello"), 0);
  assert.equal(out, "tampered");
  const report = engine.reconcile(journalWithCalls().snapshot(), loaded.snapshot());
  assert.equal(report.digestChainConsistent, false);
  assert.equal(report.driftAtOrderIndex, 0);
  await fs.rm(path.dirname(file), { recursive: true, force: true });
});

test("persistence: orderIndex discontinuity is rejected", async () => {
  const file = await tempTracePath("gap.jsonl");
  const lines = [
    JSON.stringify({ magic: "orbit-trace", version: 1, recordCount: 2 }),
    JSON.stringify({
      entryUid: "a",
      orderIndex: 0,
      channelKind: ChannelKind.LLM_ACCESS,
      funcName: "chatRound",
      inputDigest: "d0",
      outputSnapshot: "x",
      durationMs: 1
    }),
    JSON.stringify({
      entryUid: "b",
      orderIndex: 5,
      channelKind: ChannelKind.LLM_ACCESS,
      funcName: "chatRound",
      inputDigest: "d1",
      outputSnapshot: "y",
      durationMs: 1
    })
  ];
  await fs.writeFile(file, `${lines.join("\n")}\n`, "utf8");
  await assert.rejects(loadRecordJournal(file), (err: unknown) => {
    assert.ok(err instanceof TraceFileInvalidError);
    assert.match(err.message, /continuity/);
    return true;
  });
  await fs.rm(path.dirname(file), { recursive: true, force: true });
});

test("persistence: malformed JSON lines are rejected with line numbers", async () => {
  const file = await tempTracePath("broken.jsonl");
  await fs.writeFile(file, '{"magic":"orbit-trace","version":1,"recordCount":1}\nnot-json\n', "utf8");
  await assert.rejects(loadRecordJournal(file), (err: unknown) => {
    assert.ok(err instanceof TraceFileInvalidError);
    assert.equal(err.lineNo, 2);
    return true;
  });
  await fs.rm(path.dirname(file), { recursive: true, force: true });
});

test("persistence: a truncated (half-written) file fails recordCount validation", async () => {
  const file = await tempTracePath("truncated.jsonl");
  await saveRecordJournal(journalWithCalls(), file);
  const lines = (await fs.readFile(file, "utf8")).split("\n").filter((l) => l.trim() !== "");
  await fs.writeFile(file, `${lines.slice(0, 2).join("\n")}\n`, "utf8"); // header + 1 of 2 records
  await assert.rejects(loadRecordJournal(file), (err: unknown) => {
    assert.ok(err instanceof TraceFileInvalidError);
    assert.match(err.message, /recordCount/);
    return true;
  });
  await fs.rm(path.dirname(file), { recursive: true, force: true });
});
