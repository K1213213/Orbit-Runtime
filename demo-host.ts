/**
 * Orbit Agent Runtime · startup demonstration
 *
 * Walks through every core mechanism:
 *   1. host lifecycle (boot -> reverse-order shutdown)
 *   2. plugin pact validation (fields / edition / capabilities)
 *   3. capability gate (declared capability passes, undeclared is rejected)
 *   4. agent sandbox execution (channel-mediated model calls)
 *   5. cycle budget (anti-infinite-loop)
 *   6. per-plugin fault isolation (one plugin cannot take down the host)
 *   7. trace journal (auditable run records)
 *
 * Run: npm run demo
 */
import { OrbitRuntimeHost } from "./src/core/orbitRuntimeHost";
import { ChannelKind, ChannelCallCtx, AgentBoxConfig, PluginUnitPact } from "./src/types/orbitDomain";
import { makeUniqueMark } from "./src/utils/versionIdGen";

async function main(): Promise<void> {
  console.log("=== Orbit Agent Runtime · demo ===");
  console.log("");

  // 1) Boot the host (bottom-up assembly).
  const host = new OrbitRuntimeHost();
  await host.bootHost();
  console.log("[boot] host started; built-in channels registered (MEM_KV_STORE / LLM_ACCESS)");

  // 2) Plugin registration with pact validation.
  const weatherPlugin: PluginUnitPact = {
    id: "plugin.weather",
    displayName: "Weather Lookup Plugin",
    edition: "1.2.0",
    requireHostMinEdition: "1.0.0",
    allowCapabilities: ["channel:read"]
  };
  host.registerPlugin(weatherPlugin);
  console.log(`[pact] plugin registered: ${weatherPlugin.id} (v${weatherPlugin.edition}, caps: channel:read)`);

  // 3) Capability gate: declared capability passes, undeclared is rejected.
  const pluginCtx: ChannelCallCtx = {
    traceMarkId: makeUniqueMark(),
    pluginUnitId: "plugin.weather",
    maxWaitMs: 5_000
  };
  const llmOut = await host.channelHub.fireChannelCall<string>(
    ChannelKind.LLM_ACCESS,
    pluginCtx,
    "chatRound",
    "Hello Orbit"
  );
  console.log(`[cap] plugin -> LLM channel (channel:read): allowed, got "${llmOut}"`);
  try {
    await host.channelHub.fireChannelCall<void>(
      ChannelKind.MEM_KV_STORE,
      pluginCtx,
      "writeEntry",
      "demo-key",
      "demo-value",
      0
    );
    console.log("[cap] undeclared channel:write passed the gate — should never happen");
  } catch (err) {
    console.log(`[cap] plugin -> KV write (undeclared channel:write): rejected: ${(err as Error).message}`);
  }

  // 4) Agent sandbox execution (all model access goes through channels).
  const boxCfg: AgentBoxConfig = {
    agentBoxId: "box.demo-1",
    boxAlias: "demo-agent",
    baseInstruct: "You are a demo assistant.",
    maxCycleRun: 2
  };
  const box = host.spawnAgentBox(boxCfg);
  console.log(`[sandbox] created ${box.boxAlias} (cycle budget ${box.maxCycleRun})`);
  console.log(`[sandbox] round 1: ${await box.runSingleCycle("tell me a joke")}`);

  // 5) Cycle budget enforcement.
  console.log(`[sandbox] round 2: ${await box.runSingleCycle("what is orbit")}`);
  try {
    await box.runSingleCycle("one more round");
  } catch (err) {
    console.log(`[sandbox] round 3 rejected (budget spent): ${(err as Error).message}`);
  }

  // 6) Per-plugin fault isolation: a plugin crash never takes down the host.
  try {
    await host.pluginSandboxGuard.runPluginSafe("plugin.weather", makeUniqueMark(), async () => {
      throw new Error("simulated plugin crash");
    });
  } catch (err) {
    console.log(`[guard] plugin crash isolated and journaled: ${(err as Error).message}`);
  }
  // Host and sandbox remain healthy; renew the cycle budget and keep going.
  box.resetCycleCount();
  console.log(`[guard] host still healthy after plugin failure: ${await box.runSingleCycle("still alive?")}`);

  // 7) Trace journal dump.
  const journal = host.traceJournal.entries();
  console.log(`[trace] ${journal.length} entries:`);
  for (const entry of journal) {
    const who = entry.pluginUnitId ?? entry.agentBoxId ?? "-";
    console.log(`   · [${entry.entryClass}] ${who} ${JSON.stringify(entry.factPayload)}`);
  }

  // 8) Shutdown in reverse order.
  await host.shutdownHost();
  console.log("");
  console.log("[shutdown] host stopped; pool / pact / guards / channels / journal released");
}

main().catch((err: unknown) => {
  console.error("demo failed:", err);
  process.exitCode = 1;
});
