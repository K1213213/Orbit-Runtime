import { test } from "node:test";
import assert from "node:assert/strict";
import { OrbitRuntimeHost } from "../src/core/orbitRuntimeHost";
import { BudgetExhaustedError } from "@orbit/infra-common";
import { ChannelKind } from "@orbit/infra-common";

test("host: full lifecycle, plugin register and capability gate", async () => {
  const host = new OrbitRuntimeHost();
  await host.bootHost();
  host.registerPlugin({
    id: "plugin.demo",
    displayName: "Demo",
    edition: "1.0.0",
    requireHostMinEdition: "1.0.0",
    allowCapabilities: ["channel:read"],
    declareChannelDeps: [ChannelKind.LLM_ACCESS]
  });
  assert.deepEqual(host.pluginPactVerifier.listPluginIds(), ["plugin.demo"]);
  await host.shutdownHost();
  assert.equal(host.traceJournal.entries().length, 0);
});

test("host: sandbox cycle budget throws CycleLimitReachedError", async () => {
  const host = new OrbitRuntimeHost();
  await host.bootHost();
  const box = host.spawnAgentBox({
    agentBoxId: "box.t",
    boxAlias: "t",
    baseInstruct: "You are a test agent.",
    maxCycleRun: 1
  });
  await box.runSingleCycle("first");
  await assert.rejects(box.runSingleCycle("second"), /cycle limit 1/);
  await host.shutdownHost();
});

test("host: per-cycle cost budget throws BudgetExhaustedError", async () => {
  const host = new OrbitRuntimeHost();
  await host.bootHost();
  const box = host.spawnAgentBox({
    agentBoxId: "box.budget",
    boxAlias: "b",
    baseInstruct: "You are a test agent.",
    maxCycleRun: 5,
    budgetPerCycle: 0
  });
  await assert.rejects(box.runSingleCycle("anything"), BudgetExhaustedError);
  await host.shutdownHost();
});

test("host: isolation domain and independence queries over the impact graph", async () => {
  const host = new OrbitRuntimeHost();
  await host.bootHost();
  host.registerPlugin({
    id: "plugin.a",
    displayName: "A",
    edition: "1.0.0",
    requireHostMinEdition: "1.0.0",
    allowCapabilities: ["channel:read"],
    declareChannelDeps: [ChannelKind.LLM_ACCESS]
  });
  host.registerPlugin({
    id: "plugin.b",
    displayName: "B",
    edition: "1.0.0",
    requireHostMinEdition: "1.0.0",
    allowCapabilities: ["channel:write"],
    declareChannelDeps: [ChannelKind.MEM_KV_STORE]
  });
  // llm-access failure affects plugin.a only
  assert.deepEqual(host.isolationDomain("llm-access"), ["plugin.a"]);
  // a and b are provably independent
  assert.equal(host.areIsolated("plugin.a", "plugin.b"), true);
  await host.shutdownHost();
});

test("host: record window then replay reproduces identical output", async () => {
  const host = new OrbitRuntimeHost();
  await host.bootHost();

  const original = host.beginRecording();
  const recordBox = host.spawnAgentBox({
    agentBoxId: "box.r",
    boxAlias: "r",
    baseInstruct: "You are a test agent.",
    maxCycleRun: 5,
    replayMode: "record"
  });
  const live = await recordBox.runSingleCycle("ping");

  const replayed = host.beginRecording();
  host.attachReplayEngine(original);
  const replayBox = host.spawnAgentBox({
    agentBoxId: "box.p",
    boxAlias: "p",
    baseInstruct: "You are a test agent.",
    maxCycleRun: 5,
    replayMode: "replay"
  });
  const replayedOut = await replayBox.runSingleCycle("ping");

  assert.equal(replayedOut, live);
  assert.equal(original.size(), 1);
  assert.equal(replayed.size(), 1);
  await host.shutdownHost();
});
