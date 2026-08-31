import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { TraceJournal, saveTraceJournal, loadTraceJournal, TraceFileInvalidError } from "../src/index";

async function tempTracePath(name: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-tracej-"));
  return path.join(dir, name);
}

function journalWithEntries(): TraceJournal {
  const journal = new TraceJournal();
  journal.append({ entryClass: "boot", traceMarkId: "t1", factPayload: { stage: "channels" } });
  journal.append({
    entryClass: "guard.trip",
    traceMarkId: "t2",
    pluginUnitId: "p1",
    agentBoxId: "box-1",
    factPayload: { reason: "quota" }
  });
  return journal;
}

test("trace checkpoint: save + load roundtrips the audit journal intact", async () => {
  const file = await tempTracePath("audit.jsonl");
  const original = journalWithEntries();
  assert.equal(await saveTraceJournal(original, file), 2);

  const loaded = await loadTraceJournal(file);
  assert.deepEqual(loaded.snapshot(), original.snapshot());
  assert.equal(loaded.byTraceMark("t2").length, 1);
  assert.equal(loaded.byAgentBox("box-1").length, 1);
  assert.equal(loaded.byPluginUnit("p1").length, 1);
  await fs.rm(path.dirname(file), { recursive: true, force: true });
});

test("trace checkpoint: file format is JSONL with a header line", async () => {
  const file = await tempTracePath("audit.jsonl");
  await saveTraceJournal(journalWithEntries(), file);
  const lines = (await fs.readFile(file, "utf8")).split("\n").filter((l) => l.trim() !== "");
  assert.equal(lines.length, 3);
  assert.deepEqual(JSON.parse(lines[0]), { magic: "orbit-trace", version: 1, entryCount: 2 });
  const first = JSON.parse(lines[1]) as { entryClass: string };
  assert.equal(first.entryClass, "boot");
  await fs.rm(path.dirname(file), { recursive: true, force: true });
});

test("trace checkpoint: save creates parent directories and leaves no .tmp behind", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-tracej-dir-"));
  const file = path.join(dir, "nested", "deep", "audit.jsonl");
  await saveTraceJournal(journalWithEntries(), file);
  assert.deepEqual(await fs.readdir(path.dirname(file)), ["audit.jsonl"]);
  await fs.rm(dir, { recursive: true, force: true });
});

test("trace checkpoint: an empty journal roundtrips as empty", async () => {
  const file = await tempTracePath("empty.jsonl");
  assert.equal(await saveTraceJournal(new TraceJournal(), file), 0);
  const loaded = await loadTraceJournal(file);
  assert.equal(loaded.entries().length, 0);
  await fs.rm(path.dirname(file), { recursive: true, force: true });
});

test("trace checkpoint: a missing file throws TraceFileInvalidError", async () => {
  await assert.rejects(loadTraceJournal(path.join(os.tmpdir(), "orbit-tracej-nope.jsonl")), (err: unknown) => {
    assert.ok(err instanceof TraceFileInvalidError);
    assert.match(err.message, /not found/);
    return true;
  });
});

test("trace checkpoint: foreign files are rejected (bad magic)", async () => {
  const file = await tempTracePath("foreign.jsonl");
  await fs.writeFile(file, '{"hello":"world"}\n', "utf8");
  await assert.rejects(loadTraceJournal(file), (err: unknown) => {
    assert.ok(err instanceof TraceFileInvalidError);
    assert.match(err.message, /bad magic/);
    return true;
  });
  await fs.rm(path.dirname(file), { recursive: true, force: true });
});

test("trace checkpoint: an entryCount mismatch is rejected", async () => {
  const file = await tempTracePath("mismatch.jsonl");
  await saveTraceJournal(journalWithEntries(), file);
  const lines = (await fs.readFile(file, "utf8")).split("\n").filter((l) => l.trim() !== "");
  lines[0] = JSON.stringify({ magic: "orbit-trace", version: 1, entryCount: 99 });
  await fs.writeFile(file, `${lines.join("\n")}\n`, "utf8");
  await assert.rejects(loadTraceJournal(file), (err: unknown) => {
    assert.ok(err instanceof TraceFileInvalidError);
    assert.match(err.message, /entryCount/);
    return true;
  });
  await fs.rm(path.dirname(file), { recursive: true, force: true });
});

test("trace checkpoint: an unsupported version is rejected", async () => {
  const file = await tempTracePath("future.jsonl");
  await fs.writeFile(file, `${JSON.stringify({ magic: "orbit-trace", version: 99, entryCount: 0 })}\n`, "utf8");
  await assert.rejects(loadTraceJournal(file), (err: unknown) => {
    assert.ok(err instanceof TraceFileInvalidError);
    assert.match(err.message, /unsupported trace version/);
    return true;
  });
  await fs.rm(path.dirname(file), { recursive: true, force: true });
});

test("trace checkpoint: malformed entry lines are rejected with line numbers", async () => {
  const file = await tempTracePath("broken.jsonl");
  await fs.writeFile(file, '{"magic":"orbit-trace","version":1,"entryCount":1}\nnot-json\n', "utf8");
  await assert.rejects(loadTraceJournal(file), (err: unknown) => {
    assert.ok(err instanceof TraceFileInvalidError);
    assert.equal(err.lineNo, 2);
    return true;
  });
  await fs.rm(path.dirname(file), { recursive: true, force: true });
});

test("trace checkpoint: an entry missing factPayload is rejected", async () => {
  const file = await tempTracePath("nopayload.jsonl");
  const lines = [
    JSON.stringify({ magic: "orbit-trace", version: 1, entryCount: 1 }),
    JSON.stringify({ entryUid: "u1", entryClass: "boot", occurredAt: 1, traceMarkId: "t1" })
  ];
  await fs.writeFile(file, `${lines.join("\n")}\n`, "utf8");
  await assert.rejects(loadTraceJournal(file), (err: unknown) => {
    assert.ok(err instanceof TraceFileInvalidError);
    assert.match(err.message, /factPayload/);
    return true;
  });
  await fs.rm(path.dirname(file), { recursive: true, force: true });
});

test("trace checkpoint: every entry is preserved (not just the last one)", async () => {
  const file = await tempTracePath("many.jsonl");
  const journal = new TraceJournal();
  for (let i = 0; i < 25; i += 1) {
    journal.append({ entryClass: `class-${i}`, traceMarkId: `t${i}`, factPayload: { i } });
  }
  await saveTraceJournal(journal, file);
  const loaded = await loadTraceJournal(file);
  assert.equal(loaded.entries().length, 25);
  loaded.entries().forEach((entry, i) => {
    assert.equal(entry.entryClass, `class-${i}`);
    assert.deepEqual(entry.factPayload, { i });
  });
  await fs.rm(path.dirname(file), { recursive: true, force: true });
});
