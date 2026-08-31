import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { OrbitRuntimeHost, ChannelKind, ReplayEngine } from "../src/index";

async function tempStateDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "orbit-host-state-"));
}

const DEMO_PACT = {
  id: "plugin.durable",
  displayName: "Durable",
  edition: "1.0.0",
  requireHostMinEdition: "1.0.0",
  allowCapabilities: ["channel:read" as const]
};

test("host durability: the audit journal survives a process restart", async () => {
  const dir = await tempStateDir();
  const tracePath = path.join(dir, "trace.wal.jsonl");

  // --- process #1: run a sandbox cycle, then shut down cleanly.
  const first = new OrbitRuntimeHost({ traceJournalPath: tracePath });
  await first.bootHost();
  const box = first.spawnAgentBox({
    agentBoxId: "box.durable",
    boxAlias: "d",
    baseInstruct: "You are a test agent.",
    maxCycleRun: 2
  });
  await box.runSingleCycle("first cycle");
  const liveEntries = first.traceJournal.snapshot();
  assert.ok(liveEntries.length > 0, "the cycle must produce audit entries");
  await first.shutdownHost();
  // shutdownHost clears the in-memory journal; the WAL is the durable record.
  assert.equal(first.traceJournal.entries().length, 0);

  // --- process #2: a fresh host over the same path recovers the audit trail.
  const second = new OrbitRuntimeHost({ traceJournalPath: tracePath });
  assert.equal(second.traceJournal.entries().length, 0, "nothing is read before boot");
  await second.bootHost();
  assert.deepEqual(second.traceJournal.snapshot(), liveEntries);
  await second.shutdownHost();

  await fs.rm(dir, { recursive: true, force: true });
});

test("host durability: a recorded window survives a restart and replays verbatim", async () => {
  const dir = await tempStateDir();
  const recordPath = path.join(dir, "record.wal.jsonl");

  // --- process #1: record two governed calls, then shut down.
  const first = new OrbitRuntimeHost({ recordJournalPath: recordPath });
  await first.bootHost();
  first.registerPlugin(DEMO_PACT);
  const journal = first.beginRecording();
  await first.capabilityInvoke({
    kind: ChannelKind.MEM_KV_STORE,
    pluginId: DEMO_PACT.id,
    funcName: "readEntry",
    args: ["alpha"],
    mode: "live"
  });
  await first.capabilityInvoke({
    kind: ChannelKind.MEM_KV_STORE,
    pluginId: DEMO_PACT.id,
    funcName: "readEntry",
    args: ["beta"],
    mode: "live"
  });
  assert.equal(journal.size(), 2);
  const recorded = journal.snapshot();
  await first.shutdownHost();

  // --- process #2: boot recovers the window; the calls replay byte-identically.
  const second = new OrbitRuntimeHost({ recordJournalPath: recordPath });
  await second.bootHost();
  const resumed = second.currentRecordJournal()!;
  assert.equal(resumed.size(), 2);
  assert.deepEqual(resumed.snapshot(), recorded);

  const engine = new ReplayEngine(resumed);
  assert.deepEqual(
    engine.replayCall(ChannelKind.MEM_KV_STORE, "readEntry", recorded[0].inputDigest, 0),
    recorded[0].outputSnapshot
  );
  await second.shutdownHost();

  await fs.rm(dir, { recursive: true, force: true });
});

test("host durability: resumeRecording continues the window instead of restarting it", async () => {
  const dir = await tempStateDir();
  const recordPath = path.join(dir, "record.wal.jsonl");

  const first = new OrbitRuntimeHost({ recordJournalPath: recordPath });
  await first.bootHost();
  first.registerPlugin(DEMO_PACT);
  first.beginRecording();
  await first.capabilityInvoke({
    kind: ChannelKind.MEM_KV_STORE,
    pluginId: DEMO_PACT.id,
    funcName: "readEntry",
    args: ["alpha"],
    mode: "live"
  });
  await first.shutdownHost();

  // A second process resumes and appends one more call to the same window.
  const second = new OrbitRuntimeHost({ recordJournalPath: recordPath });
  await second.bootHost(); // boot auto-resumes when a record path is configured
  second.registerPlugin(DEMO_PACT);
  const resumed = second.currentRecordJournal()!;
  assert.equal(resumed.size(), 1);
  await second.capabilityInvoke({
    kind: ChannelKind.MEM_KV_STORE,
    pluginId: DEMO_PACT.id,
    funcName: "readEntry",
    args: ["gamma"],
    mode: "live"
  });
  const combined = second.currentRecordJournal()!;
  assert.equal(combined.size(), 2);
  assert.deepEqual(
    combined.snapshot().map((r) => r.orderIndex),
    [0, 1],
    "orderIndex must continue, so the combined window replays as one run"
  );
  await second.shutdownHost();

  // A third process sees both calls on disk.
  const third = new OrbitRuntimeHost({ recordJournalPath: recordPath });
  await third.bootHost();
  assert.equal(third.currentRecordJournal()!.size(), 2);
  await third.shutdownHost();

  await fs.rm(dir, { recursive: true, force: true });
});

test("host durability: beginRecording opens a fresh window over an existing WAL", async () => {
  const dir = await tempStateDir();
  const recordPath = path.join(dir, "record.wal.jsonl");

  const first = new OrbitRuntimeHost({ recordJournalPath: recordPath });
  await first.bootHost();
  first.registerPlugin(DEMO_PACT);
  first.beginRecording();
  await first.capabilityInvoke({
    kind: ChannelKind.MEM_KV_STORE,
    pluginId: DEMO_PACT.id,
    funcName: "readEntry",
    args: ["alpha"],
    mode: "live"
  });
  await first.shutdownHost();

  // Explicitly opening a new window truncates the WAL first.
  const second = new OrbitRuntimeHost({ recordJournalPath: recordPath });
  await second.bootHost();
  second.registerPlugin(DEMO_PACT);
  const fresh = second.beginRecording();
  assert.equal(fresh.size(), 0, "a new window starts empty");
  await second.capabilityInvoke({
    kind: ChannelKind.MEM_KV_STORE,
    pluginId: DEMO_PACT.id,
    funcName: "readEntry",
    args: ["delta"],
    mode: "live"
  });
  await second.shutdownHost();

  const third = new OrbitRuntimeHost({ recordJournalPath: recordPath });
  await third.bootHost();
  const reloaded = third.currentRecordJournal()!;
  assert.equal(reloaded.size(), 1);
  assert.equal(reloaded.get(0)!.funcName, "readEntry");
  assert.equal(reloaded.get(0)!.orderIndex, 0);
  await third.shutdownHost();

  await fs.rm(dir, { recursive: true, force: true });
});

test("host durability: without paths the host stays purely in-memory (default behavior)", async () => {
  const host = new OrbitRuntimeHost();
  await host.bootHost();
  host.registerPlugin(DEMO_PACT);
  const journal = host.beginRecording();
  await host.capabilityInvoke({
    kind: ChannelKind.MEM_KV_STORE,
    pluginId: DEMO_PACT.id,
    funcName: "readEntry",
    args: ["k"],
    mode: "live"
  });
  assert.equal(journal.size(), 1);
  assert.equal(host.currentRecordJournal()!.size(), 1);
  await host.shutdownHost();
  assert.equal(host.traceJournal.entries().length, 0);
});

test("host durability: a healed audit WAL keeps recovering after the next run appends", async () => {
  const dir = await tempStateDir();
  const tracePath = path.join(dir, "trace.wal.jsonl");

  const first = new OrbitRuntimeHost({ traceJournalPath: tracePath });
  await first.bootHost();
  const box = first.spawnAgentBox({
    agentBoxId: "box.heal",
    boxAlias: "h",
    baseInstruct: "You are a test agent.",
    maxCycleRun: 1
  });
  await box.runSingleCycle("only cycle");
  const survivors = first.traceJournal.snapshot().length;
  await first.shutdownHost();

  // Crash mid-append leaves a partial trailing line.
  await fs.appendFile(tracePath, '{"entryUid":"partial","entryCl', "utf8");

  // Boot heals the file, so the partial line never becomes an interior line.
  const second = new OrbitRuntimeHost({ traceJournalPath: tracePath });
  await second.bootHost();
  assert.equal(second.traceJournal.entries().length, survivors);
  assert.ok(
    !(await fs.readFile(tracePath, "utf8")).includes('"entryUid":"partial"'),
    "the truncated tail must be physically removed, not merely ignored"
  );

  // This run appends more entries on top of the healed prefix.
  const box2 = second.spawnAgentBox({
    agentBoxId: "box.heal2",
    boxAlias: "h2",
    baseInstruct: "You are a test agent.",
    maxCycleRun: 1
  });
  await box2.runSingleCycle("second cycle");
  const afterSecond = second.traceJournal.snapshot();
  assert.ok(afterSecond.length > survivors, "the second run must add entries");
  await second.shutdownHost();

  // Without healing the partial line would now be interior — a hard fault.
  const third = new OrbitRuntimeHost({ traceJournalPath: tracePath });
  await third.bootHost();
  assert.deepEqual(third.traceJournal.snapshot(), afterSecond);
  await third.shutdownHost();

  await fs.rm(dir, { recursive: true, force: true });
});

test("host durability: a resumed recording window heals its truncated tail", async () => {
  const dir = await tempStateDir();
  const recordPath = path.join(dir, "record.wal.jsonl");

  const first = new OrbitRuntimeHost({ recordJournalPath: recordPath });
  await first.bootHost();
  first.registerPlugin(DEMO_PACT);
  first.beginRecording();
  await first.capabilityInvoke({
    kind: ChannelKind.MEM_KV_STORE,
    pluginId: DEMO_PACT.id,
    funcName: "readEntry",
    args: ["alpha"],
    mode: "live"
  });
  await first.shutdownHost();
  await fs.appendFile(recordPath, '{"entryUid":"partial","orderInd', "utf8");

  const second = new OrbitRuntimeHost({ recordJournalPath: recordPath });
  await second.bootHost();
  second.registerPlugin(DEMO_PACT);
  assert.equal(second.currentRecordJournal()!.size(), 1);
  await second.capabilityInvoke({
    kind: ChannelKind.MEM_KV_STORE,
    pluginId: DEMO_PACT.id,
    funcName: "readEntry",
    args: ["beta"],
    mode: "live"
  });
  const combined = second.currentRecordJournal()!.snapshot();
  await second.shutdownHost();

  // The window still replays as one uninterrupted run in a third process.
  const third = new OrbitRuntimeHost({ recordJournalPath: recordPath });
  await third.bootHost();
  const reloaded = third.currentRecordJournal()!;
  assert.deepEqual(reloaded.snapshot(), combined);
  const engine = new ReplayEngine(reloaded);
  assert.deepEqual(
    engine.replayCall(ChannelKind.MEM_KV_STORE, "readEntry", combined[1].inputDigest, 1),
    combined[1].outputSnapshot
  );
  await third.shutdownHost();

  await fs.rm(dir, { recursive: true, force: true });
});

test("host durability: auditRetention bounds the durable audit log across restarts", async () => {
  const dir = await tempStateDir();
  const tracePath = path.join(dir, "trace.wal.jsonl");

  const first = new OrbitRuntimeHost({ traceJournalPath: tracePath, auditRetention: 3 });
  await first.bootHost();
  // Drive the audit log directly: retention is about volume, and tying the
  // assertion to how many entries a sandbox cycle happens to emit would make
  // this test fail whenever unrelated instrumentation changes.
  for (let i = 0; i < 8; i += 1) {
    first.traceJournal.append({ entryClass: "tick", traceMarkId: `t${i}`, factPayload: { i } });
  }
  assert.ok(first.traceJournal.snapshot().length > 3, "the run must exceed the bound");
  const newest = first.traceJournal.snapshot().slice(-3);
  await first.shutdownHost(); // shutdown applies retention at rest

  const lines = (await fs.readFile(tracePath, "utf8")).split("\n").filter((l) => l.trim() !== "");
  assert.equal(lines.length, 3, "the WAL must be bounded on disk, not just in memory");

  const second = new OrbitRuntimeHost({ traceJournalPath: tracePath, auditRetention: 3 });
  await second.bootHost();
  assert.deepEqual(second.traceJournal.snapshot(), newest, "the newest entries are the survivors");
  await second.shutdownHost();

  await fs.rm(dir, { recursive: true, force: true });
});

test("host durability: pruneAuditLog is on-demand, and unbounded by default", async () => {
  const dir = await tempStateDir();
  const tracePath = path.join(dir, "trace.wal.jsonl");

  // Unbounded: pruning reports the current size and keeps every entry.
  const unbounded = new OrbitRuntimeHost({ traceJournalPath: tracePath });
  await unbounded.bootHost();
  for (let i = 0; i < 5; i += 1) {
    unbounded.traceJournal.append({ entryClass: "tick", traceMarkId: `u${i}`, factPayload: {} });
  }
  const total = unbounded.traceJournal.snapshot().length;
  assert.equal(await unbounded.pruneAuditLog(), total);
  assert.equal(unbounded.traceJournal.snapshot().length, total);
  await unbounded.shutdownHost();

  // Bounded: an operator can prune a long-running host without a restart.
  const bounded = new OrbitRuntimeHost({
    traceJournalPath: path.join(dir, "bounded.wal.jsonl"),
    auditRetention: 2
  });
  await bounded.bootHost();
  for (let i = 0; i < 5; i += 1) {
    bounded.traceJournal.append({ entryClass: "tick", traceMarkId: `b${i}`, factPayload: {} });
  }
  assert.equal(await bounded.pruneAuditLog(), 2);
  assert.deepEqual(
    bounded.traceJournal.snapshot().map((e) => e.traceMarkId),
    ["b3", "b4"]
  );
  await bounded.shutdownHost();

  await fs.rm(dir, { recursive: true, force: true });
});

test("host durability: an invalid auditRetention is rejected at construction", () => {
  assert.throws(() => new OrbitRuntimeHost({ auditRetention: -1 }), RangeError);
  assert.throws(() => new OrbitRuntimeHost({ auditRetention: 2.5 }), RangeError);
  assert.throws(() => new OrbitRuntimeHost({ auditRetention: Number.NaN }), RangeError);
  // Zero is legal: "keep no audit history on disk" is a valid operator choice.
  assert.doesNotThrow(() => new OrbitRuntimeHost({ auditRetention: 0 }));
});

test("host durability: a crash-truncated WAL still boots (partial tail dropped)", async () => {
  const dir = await tempStateDir();
  const tracePath = path.join(dir, "trace.wal.jsonl");

  const first = new OrbitRuntimeHost({ traceJournalPath: tracePath });
  await first.bootHost();
  const box = first.spawnAgentBox({
    agentBoxId: "box.crash",
    boxAlias: "c",
    baseInstruct: "You are a test agent.",
    maxCycleRun: 1
  });
  await box.runSingleCycle("only cycle");
  const survivors = first.traceJournal.snapshot().length;
  await first.shutdownHost();

  // Simulate a crash mid-append: a partial JSON line with no newline.
  await fs.appendFile(tracePath, '{"entryUid":"partial","entryCl', "utf8");

  const second = new OrbitRuntimeHost({ traceJournalPath: tracePath });
  await second.bootHost();
  assert.equal(second.traceJournal.entries().length, survivors);
  await second.shutdownHost();

  await fs.rm(dir, { recursive: true, force: true });
});
