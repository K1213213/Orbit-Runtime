/**
 * Orbit Agent Runtime · deterministic replay demo
 *
 * Shows the core M2 capability: a real run is recorded into a journal, then
 * replayed with zero model calls, byte-identical output, and bank-style
 * reconciliation proving the two chains are consistent.
 *
 * Run: npm run demo:replay
 */
import { OrbitRuntimeHost } from "./src/core/orbitRuntimeHost";
import { ReplayEngine } from "./src/replay/replay_engine";
import { AgentBoxConfig } from "./src/types/orbitDomain";

const CYCLES = ["tell me a joke", "what is orbit", "explain a capability channel"];

function boxConfig(id: string, replayMode: AgentBoxConfig["replayMode"]): AgentBoxConfig {
  return {
    agentBoxId: `box.${id}`,
    boxAlias: `${id}-agent`,
    baseInstruct: "You are a demo assistant.",
    maxCycleRun: 10,
    replayMode
  };
}

async function main(): Promise<void> {
  console.log("=== Orbit Agent Runtime · deterministic replay demo ===");
  console.log("");

  const host = new OrbitRuntimeHost();
  await host.bootHost();

  // Window 1: record a real execution (channels run with simulated latency).
  const originalJournal = host.beginRecording();
  const recordBox = host.spawnAgentBox(boxConfig("record", "record"));

  const t0 = performance.now();
  const originals: string[] = [];
  for (const input of CYCLES) {
    originals.push(await recordBox.runSingleCycle(input));
  }
  const recordMs = performance.now() - t0;
  console.log(`[record] ${CYCLES.length} cycles executed with real channel latency in ${Math.round(recordMs)}ms`);
  console.log(`[record] journal captured ${originalJournal.size()} channel calls`);
  console.log("");

  // Window 2: replay the same script with zero real channel calls.
  const replayedJournal = host.beginRecording();
  host.attachReplayEngine(originalJournal);
  const replayBox = host.spawnAgentBox(boxConfig("replay", "replay"));

  const t1 = performance.now();
  const replays: string[] = [];
  for (const input of CYCLES) {
    replays.push(await replayBox.runSingleCycle(input));
  }
  const replayMs = performance.now() - t1;
  console.log(`[replay] ${CYCLES.length} cycles replayed from journal in ${Math.round(replayMs)}ms (zero model calls)`);
  console.log("");

  // Byte-identical check.
  const identical = originals.every((out, i) => out === replays[i]);
  console.log(`[check] outputs byte-identical: ${identical}`);

  // Bank-style reconciliation of the two call chains.
  const report = new ReplayEngine(originalJournal).reconcile(originalJournal.snapshot(), replayedJournal.snapshot());
  console.log(
    `[reconcile] original=${report.originalCount} replayed=${report.replayedCount} digestChain=${report.digestChainConsistent}`
  );
  console.log(`[result] ${report.digestChainConsistent && identical ? "REPLAY VERIFIED" : "REPLAY FAILED"}`);
  console.log("");
  console.log(`speedup: ${recordMs > 0 ? (recordMs / Math.max(replayMs, 1)).toFixed(1) : "n/a"}x`);

  await host.shutdownHost();
}

main().catch((err: unknown) => {
  console.error("demo failed:", err);
  process.exitCode = 1;
});
