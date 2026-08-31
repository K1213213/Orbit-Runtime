import { test } from "node:test";
import assert from "node:assert/strict";
import { TraceJournal } from "@orbit/core-hub";

test("append & entries: records carry uid and timestamp", () => {
  const journal = new TraceJournal();
  journal.append({ entryClass: "TEST_EVENT", traceMarkId: "t1", factPayload: { n: 1 } });
  const entries = journal.entries();
  assert.equal(entries.length, 1);
  assert.ok(entries[0].entryUid.length > 0);
  assert.ok(entries[0].occurredAt > 0);
});

test("filters: by trace mark / agent box / plugin unit / entry class", () => {
  const journal = new TraceJournal();
  journal.append({ entryClass: "AGENT_SINGLE_CYCLE_EXEC", traceMarkId: "t1", agentBoxId: "box.a", factPayload: {} });
  journal.append({ entryClass: "PLUGIN_UNIT_EXCEPTION", traceMarkId: "t1", pluginUnitId: "p1", factPayload: {} });
  journal.append({ entryClass: "AGENT_SINGLE_CYCLE_EXEC", traceMarkId: "t2", agentBoxId: "box.b", factPayload: {} });

  assert.equal(journal.byTraceMark("t1").length, 2);
  assert.equal(journal.byAgentBox("box.a").length, 1);
  assert.equal(journal.byPluginUnit("p1").length, 1);
  assert.equal(journal.byEntryClass("AGENT_SINGLE_CYCLE_EXEC").length, 2);
});

test("snapshot & restore: round-trips the journal", () => {
  const journal = new TraceJournal();
  journal.append({ entryClass: "A", traceMarkId: "t", factPayload: {} });
  const snapshot = journal.snapshot();
  journal.append({ entryClass: "B", traceMarkId: "t", factPayload: {} });
  journal.restoreSnapshot(snapshot);
  assert.equal(journal.entries().length, 1);
  assert.equal(journal.entries()[0].entryClass, "A");
});

test("entries returns a copy: external mutation is isolated", () => {
  const journal = new TraceJournal();
  journal.append({ entryClass: "A", traceMarkId: "t", factPayload: {} });
  const entries = journal.entries();
  entries.length = 0;
  assert.equal(journal.entries().length, 1);
});
