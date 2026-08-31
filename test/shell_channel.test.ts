import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ShellChannel } from "@orbit/core-hub";
import { ChannelCallFaultError } from "@orbit/infra-common";
import type { ChannelCallCtx } from "@orbit/infra-common";

const NODE = process.execPath;

function makeCtx(): ChannelCallCtx {
  return { traceMarkId: "t-shell", maxWaitMs: 30_000 };
}

async function makeChannel(extra: Partial<ConstructorParameters<typeof ShellChannel>[0]> = {}): Promise<{
  channel: ShellChannel;
  workDir: string;
}> {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-shell-"));
  const channel = new ShellChannel({ allowedCommands: [NODE], workDir, timeoutMs: 15_000, ...extra });
  await channel.setup(makeCtx());
  return { channel, workDir };
}

/** node -e "<script>" helper: argv-safe (no shell involved). */
function nodeArgs(script: string): string[] {
  return ["-e", script];
}

test("ShellChannel: requires an allowedCommands array", () => {
  assert.throws(() => new ShellChannel({ allowedCommands: undefined as unknown as string[] }), /allowedCommands/);
});

test("ShellChannel: execCommand runs a whitelisted command and captures stdout", async () => {
  const { channel, workDir } = await makeChannel();
  const result = await channel.execCommand(NODE, nodeArgs("process.stdout.write('hello from orbit')"));
  assert.equal(result.stdout, "hello from orbit");
  assert.equal(result.stderr, "");
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  await fs.rm(workDir, { recursive: true, force: true });
});

test("ShellChannel: non-whitelisted commands are rejected before spawn", async () => {
  const { channel, workDir } = await makeChannel();
  await assert.rejects(
    channel.execCommand("definitely-not-whitelisted"),
    (err: unknown) => {
      assert.ok(err instanceof ChannelCallFaultError);
      assert.match(err.message, /not whitelisted/);
      return true;
    }
  );
  // Whitelisted by exact match only: adding path components does not slip through.
  await assert.rejects(channel.execCommand(`${NODE}.exe`), /not whitelisted/);
  await fs.rm(workDir, { recursive: true, force: true });
});

test("ShellChannel: non-zero exit codes are data, not faults", async () => {
  const { channel, workDir } = await makeChannel();
  const result = await channel.execCommand(NODE, nodeArgs("process.stderr.write('boom'); process.exit(3)"));
  assert.equal(result.exitCode, 3);
  assert.equal(result.stderr, "boom");
  await fs.rm(workDir, { recursive: true, force: true });
});

test("ShellChannel: the child runs inside workDir", async () => {
  const { channel, workDir } = await makeChannel();
  const result = await channel.execCommand(NODE, nodeArgs("process.stdout.write(process.cwd())"));
  assert.equal(result.stdout, workDir);
  await fs.rm(workDir, { recursive: true, force: true });
});

test("ShellChannel: non-allowlisted environment variables never leak to the child", async () => {
  const { channel, workDir } = await makeChannel();
  process.env.ORBIT_SHELL_TEST_SECRET = "do-not-leak";
  try {
    const probe = "process.stdout.write(process.env.ORBIT_SHELL_TEST_SECRET === undefined ? 'missing' : process.env.ORBIT_SHELL_TEST_SECRET)";
    const bare = await channel.execCommand(NODE, nodeArgs(probe));
    assert.equal(bare.stdout, "missing");

    const withSecret = new ShellChannel({
      allowedCommands: [NODE],
      workDir,
      envAllowlist: ["ORBIT_SHELL_TEST_SECRET"]
    });
    await withSecret.setup(makeCtx());
    const rich = await withSecret.execCommand(NODE, nodeArgs(probe));
    assert.equal(rich.stdout, "do-not-leak");
  } finally {
    delete process.env.ORBIT_SHELL_TEST_SECRET;
  }
  await fs.rm(workDir, { recursive: true, force: true });
});

test("ShellChannel: runaway processes are killed by the timeout", async () => {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-shell-to-"));
  const channel = new ShellChannel({
    allowedCommands: [NODE],
    workDir,
    timeoutMs: 700
  });
  await channel.setup(makeCtx());
  const result = await channel.execCommand(NODE, nodeArgs("setInterval(() => {}, 1000)"));
  assert.equal(result.timedOut, true);
  assert.equal(result.exitCode, -1);
  await fs.rm(workDir, { recursive: true, force: true });
});

test("ShellChannel: oversized output is truncated with a marker", async () => {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-shell-cap-"));
  const channel = new ShellChannel({
    allowedCommands: [NODE],
    workDir,
    maxOutputBytes: 64
  });
  await channel.setup(makeCtx());
  const result = await channel.execCommand(NODE, nodeArgs("process.stdout.write('a'.repeat(4096))"));
  assert.equal(result.truncated, true);
  assert.ok(result.stdout.length <= 64 + 32); // cap + marker overhead
  assert.match(result.stdout, /output truncated/);
  await fs.rm(workDir, { recursive: true, force: true });
});

test("ShellChannel: spawn failure of a whitelisted-but-missing binary is a fault", async () => {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-shell-miss-"));
  const ghost = path.join(workDir, "no-such-binary");
  const channel = new ShellChannel({ allowedCommands: [ghost], workDir, timeoutMs: 3_000 });
  await channel.setup(makeCtx());
  await assert.rejects(
    channel.execCommand(ghost, []),
    (err: unknown) => {
      assert.ok(err instanceof ChannelCallFaultError);
      return true;
    }
  );
  await fs.rm(workDir, { recursive: true, force: true });
});

test("ShellChannel: args must be an array of strings (no shell strings)", async () => {
  const { channel, workDir } = await makeChannel();
  await assert.rejects(
    channel.execCommand(NODE, "echo hello" as unknown as string[]),
    /array of strings/
  );
  await assert.rejects(
    channel.execCommand(NODE, [42 as unknown as string]),
    /array of strings/
  );
  await fs.rm(workDir, { recursive: true, force: true });
});

test("ShellChannel: listAllowedCommands returns a sorted copy", async () => {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-shell-list-"));
  const channel = new ShellChannel({ allowedCommands: ["b.cmd", "a.cmd"], workDir });
  assert.deepEqual(channel.listAllowedCommands(), ["a.cmd", "b.cmd"]);
  await fs.rm(workDir, { recursive: true, force: true });
});

test("ShellChannel: replay contract is io-bound + inject", async () => {
  const { channel, workDir } = await makeChannel();
  assert.deepEqual(channel.determinismMeta, { determinism: "io-bound", replayPolicy: "inject" });
  await channel.teardown();
  await fs.rm(workDir, { recursive: true, force: true });
});
