import { test } from "node:test";
import assert from "node:assert/strict";
import { TraceJournal } from "@orbit/core-hub";
import { PluginSandboxGuard } from "@orbit/core-hub";

test("runPluginSafe: failure is isolated, journaled and rethrown", async () => {
  const journal = new TraceJournal();
  const guard = new PluginSandboxGuard(journal);
  await assert.rejects(
    guard.runPluginSafe("p1", "t1", async () => {
      throw new Error("boom");
    }),
    /boom/
  );
  const entries = journal.byEntryClass("PLUGIN_UNIT_EXCEPTION");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].pluginUnitId, "p1");
  assert.deepEqual(entries[0].factPayload, { errMsg: "boom" });
});

test("runPluginSafe: repeated failures trip the per-plugin protector", async () => {
  const journal = new TraceJournal();
  const guard = new PluginSandboxGuard(journal, () => 2); // strict threshold for this plugin
  const boom = async (): Promise<string> => {
    throw new Error("x");
  };
  await assert.rejects(guard.runPluginSafe("p1", "t1", boom));
  await assert.rejects(guard.runPluginSafe("p1", "t1", boom));
  // third call: protector is TRIPPED, blocked before running the business fn
  await assert.rejects(guard.runPluginSafe("p1", "t1", boom), /trip protector active/);
});

test("runPluginSafe: different plugins have independent protectors", async () => {
  const journal = new TraceJournal();
  const guard = new PluginSandboxGuard(journal, () => 2);
  const boom = async (): Promise<string> => {
    throw new Error("x");
  };
  await assert.rejects(guard.runPluginSafe("p1", "t1", boom));
  await assert.rejects(guard.runPluginSafe("p1", "t1", boom));
  // p1 is tripped, but p2 still executes fine
  const ok = await guard.runPluginSafe("p2", "t2", async () => "fine");
  assert.equal(ok, "fine");
});

test("releaseAllGuard: clears every protector", async () => {
  const journal = new TraceJournal();
  const guard = new PluginSandboxGuard(journal, () => 2);
  const boom = async (): Promise<string> => {
    throw new Error("x");
  };
  await assert.rejects(guard.runPluginSafe("p1", "t1", boom));
  await assert.rejects(guard.runPluginSafe("p1", "t1", boom));
  await assert.rejects(guard.runPluginSafe("p1", "t1", boom), /trip protector active/);
  guard.releaseAllGuard();
  const ok = await guard.runPluginSafe("p1", "t1", async () => "recovered");
  assert.equal(ok, "recovered");
});
