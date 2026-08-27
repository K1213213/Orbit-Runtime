/**
 * Orbit Agent Runtime · DeepSeek demo
 *
 * Drives a REAL DeepSeek model through the kernel, then replays the run with
 * zero API calls, byte-identical output — the product P0.1 first milestone.
 *
 * Run:  DEEPSEEK_API_KEY=sk-xxx npm run demo:deepseek
 *       DEEPSEEK_MODEL=deepseek-reasoner npm run demo:deepseek (optional)
 */
import { OrbitRuntimeHost } from "./src/core/orbitRuntimeHost";
import { DeepSeekChannel } from "./src/channel/providers/deepseek_channel";
import { ChannelKind, AgentBoxConfig } from "./src/types/orbitDomain";

const PROMPT = "Reply with exactly one short sentence explaining why reproducibility matters for AI agents.";

function boxConfig(id: string, replayMode: AgentBoxConfig["replayMode"]): AgentBoxConfig {
  return {
    agentBoxId: `box.${id}`,
    boxAlias: `${id}-agent`,
    baseInstruct: "You are a concise assistant.",
    maxCycleRun: 5,
    replayMode
  };
}

async function main(): Promise<void> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    console.error("DEEPSEEK_API_KEY is not set. Get one at https://platform.deepseek.com");
    process.exitCode = 1;
    return;
  }

  const host = new OrbitRuntimeHost();
  await host.bootHost();

  // Plugin-first precedence: the real DeepSeek channel overrides the built-in mock.
  host.channelHub.registerPluginExtChannel(
    ChannelKind.LLM_ACCESS,
    new DeepSeekChannel({ apiKey, model: process.env.DEEPSEEK_MODEL ?? "deepseek-chat" })
  );

  console.log("=== Orbit Agent Runtime · DeepSeek demo ===");
  console.log("");

  // Live run (record window): real model call.
  const journal = host.beginRecording();
  const recordBox = host.spawnAgentBox(boxConfig("record", "record"));
  const t0 = performance.now();
  const live = await recordBox.runSingleCycle(PROMPT);
  const liveMs = Math.round(performance.now() - t0);
  console.log(`[live]   1 model call · ${liveMs}ms`);
  console.log(`        ${live}`);
  console.log("");

  // Replay run: zero API calls, output injected from the journal.
  const replayedJournal = host.beginRecording();
  host.attachReplayEngine(journal);
  const replayBox = host.spawnAgentBox(boxConfig("replay", "replay"));
  const t1 = performance.now();
  const replayed = await replayBox.runSingleCycle(PROMPT);
  const replayMs = Math.round(performance.now() - t1);
  console.log(`[replay] 0 model calls · ${replayMs}ms`);
  console.log(`        ${replayed}`);
  console.log("");

  const identical = live === replayed;
  console.log(`[check]  byte-identical: ${identical}`);
  console.log(`[result] ${identical ? "REPLAY VERIFIED" : "REPLAY FAILED"} · speedup ${liveMs / Math.max(replayMs, 1)}x`);

  await host.shutdownHost();
}

main().catch((err: unknown) => {
  console.error("demo failed:", err);
  process.exitCode = 1;
});
