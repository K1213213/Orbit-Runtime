/**
 * Example 4 — the orbit CLI record → replay → diff loop.
 *
 * The CLI is the reproducibility story in three commands: record a script
 * against a live kernel, replay the trace with zero channel calls, and diff
 * two traces to locate the first digest-chain breakpoint.
 *
 * This file drives the CLI exactly as a user would, showing every command's
 * output. Run: node examples/cli-record-replay.mjs
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const REPO = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const ORBIT = path.join(REPO, "bin", "orbit.mjs");

/** A small agent script exercising both the LLM and the KV channel. */
const AGENT_SCRIPT = `
export default async (ctx) => {
  const a = await ctx.llm.chat("hello orbit");
  const b = await ctx.call(ctx.ChannelKind.MEM_KV_STORE, "readEntry", "alpha");
  const c = await ctx.call(ctx.ChannelKind.LLM_ACCESS, "chatRound", a);
  return { a, b, c };
};
`;

function run(args, label) {
  console.log(`\n$ orbit ${args.join(" ")}`);
  const res = spawnSync(process.execPath, [ORBIT, ...args], { cwd: REPO, encoding: "utf8" });
  if (res.status !== 0) {
    console.error(res.stderr || res.stdout);
    process.exit(res.status ?? 1);
  }
  console.log((res.stdout || "").trim().split("\n").slice(0, 8).join("\n"));
  return res.stdout;
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-example-"));
  const script = path.join(dir, "agent.mjs");
  const traceA = path.join(dir, "a.jsonl");
  const traceB = path.join(dir, "b.jsonl");
  fs.writeFileSync(script, AGENT_SCRIPT, "utf8");

  console.log("=== example 4 · orbit CLI record → replay → diff ===");
  console.log(`[trace] temp dir: ${dir}`);

  // 1) Record: run the script against a live kernel, capture every channel
  //    call into a trace file.
  run(["record", script, "--out", traceA], "record");

  // 2) Replay: re-run the recorded script with ZERO real channel calls and
  //    reconcile the replayed chain against the original.
  const replayOut = run(["replay", traceA], "replay");

  // 3) Diff: a trace compared with itself must be perfectly consistent.
  const diffOut = run(["diff", traceA, traceA], "diff");

  if (!/consistent|identical|一致/i.test(replayOut + diffOut)) {
    console.error("FAIL: replay/diff did not report a consistent chain");
    process.exit(1);
  }

  fs.rmSync(dir, { recursive: true, force: true });
  console.log("\nOK — record → replay → diff loop closed with a consistent chain");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
