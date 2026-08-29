/**
 * Integration test for the `orbit` CLI (bin/orbit.mjs).
 *
 * Exercises the full deterministic-replay loop through the real command line:
 *   record a script -> replay it with zero real calls -> verify the digest
 *   chain -> diff two traces and locate the first divergence.
 *
 * No network is touched: the default config uses the in-memory mock LLM and
 * the built-in KV channel, so record/replay stay fully deterministic.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const repoRoot = path.resolve(__dirname, "..", "..");
const cliPath = path.join(repoRoot, "bin", "orbit.mjs");
const nodeBin = process.execPath;

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runOrbit(args: string[], cwd: string): Promise<CliResult> {
  try {
    const { stdout, stderr } = await execFileAsync(nodeBin, [cliPath, ...args], {
      cwd,
      timeout: 30_000
    });
    return { code: 0, stdout, stderr };
  } catch (err: any) {
    return { code: err.code ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

const SCRIPT_PING = `export default async function (ctx) {
  const reply = await ctx.llm.chat("ping");
  const prev = await ctx.call(ctx.ChannelKind.MEM_KV_STORE, "readEntry", "k");
  return { reply, prev };
};
`;

const SCRIPT_PONG = `export default async function (ctx) {
  const reply = await ctx.llm.chat("pong");
  const prev = await ctx.call(ctx.ChannelKind.MEM_KV_STORE, "readEntry", "k");
  return { reply, prev };
};
`;

test("orbit record -> replay verifies the digest chain (zero real calls)", async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-cli-"));
  fs.writeFileSync(path.join(work, "ping.mjs"), SCRIPT_PING);

  const rec = await runOrbit(["record", "ping.mjs", "--out", "t.jsonl"], work);
  assert.equal(rec.code, 0, `record failed: ${rec.stderr}`);
  assert.ok(fs.existsSync(path.join(work, "t.jsonl")), "trace file not written");
  assert.ok(fs.existsSync(path.join(work, "t.jsonl.meta.json")), "meta file not written");
  assert.match(rec.stdout, /recorded 2 channel calls/);

  const rep = await runOrbit(["replay", "t.jsonl"], work);
  assert.equal(rep.code, 0, `replay failed: ${rep.stderr}`);
  assert.match(rep.stdout, /VERIFIED/);

  // JSON mode carries the reconcile report.
  const repJson = await runOrbit(["replay", "t.jsonl", "--json"], work);
  assert.equal(repJson.code, 0);
  const report = JSON.parse(repJson.stdout);
  assert.equal(report.digestChainConsistent, true);
  assert.equal(report.originalCount, 2);
  assert.equal(report.replayedCount, 2);
});

test("orbit diff: a trace is identical to itself", async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-cli-"));
  fs.writeFileSync(path.join(work, "ping.mjs"), SCRIPT_PING);
  await runOrbit(["record", "ping.mjs", "--out", "t.jsonl"], work);

  const d = await runOrbit(["diff", "t.jsonl", "t.jsonl"], work);
  assert.equal(d.code, 0, `diff failed: ${d.stderr}`);
  assert.match(d.stdout, /identical call chains/);
});

test("orbit diff: locates the first digest-chain breakpoint between two scripts", async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-cli-"));
  fs.writeFileSync(path.join(work, "ping.mjs"), SCRIPT_PING);
  fs.writeFileSync(path.join(work, "pong.mjs"), SCRIPT_PONG);
  await runOrbit(["record", "ping.mjs", "--out", "a.jsonl"], work);
  await runOrbit(["record", "pong.mjs", "--out", "b.jsonl"], work);

  const d = await runOrbit(["diff", "a.jsonl", "b.jsonl"], work);
  assert.equal(d.code, 1, "divergent traces should exit non-zero");
  assert.match(d.stdout, /divergence at call #0/);
  assert.match(d.stdout, /inputDigest/);

  const dj = await runOrbit(["diff", "a.jsonl", "b.jsonl", "--json"], work);
  const report = JSON.parse(dj.stdout);
  assert.equal(report.consistent, false);
  assert.equal(report.firstDriftIndex, 0);
  assert.equal(report.driftField, "inputDigest");
});

test("orbit replay fails clearly when no driving script is available", async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-cli-"));
  fs.writeFileSync(path.join(work, "ping.mjs"), SCRIPT_PING);
  await runOrbit(["record", "ping.mjs", "--out", "t.jsonl"], work);
  // Strip the meta so replay must rely on --via; without it, it should error.
  fs.rmSync(path.join(work, "t.jsonl.meta.json"));

  const rep = await runOrbit(["replay", "t.jsonl"], work);
  assert.equal(rep.code, 2, "replay without a script should exit 2");
  assert.match(rep.stderr, /no driving script/);
});
