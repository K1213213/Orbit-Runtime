import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { FileChannel } from "../src/channel/providers/FileChannel";
import { ChannelCallFaultError } from "../src/core/orbitDomainError";
import type { ChannelCallCtx } from "../src/types/orbitDomain";

function makeCtx(): ChannelCallCtx {
  return { traceMarkId: "t-file", maxWaitMs: 5000 };
}

async function makeChannel(rootDir?: string): Promise<{ channel: FileChannel; root: string }> {
  const root = rootDir ?? await fs.mkdtemp(path.join(os.tmpdir(), "orbit-file-"));
  const channel = new FileChannel({ rootDir: root });
  await channel.setup(makeCtx());
  return { channel, root };
}

test("FileChannel: requires a rootDir", () => {
  assert.throws(() => new FileChannel({ rootDir: "" }), /rootDir/);
  assert.throws(() => new FileChannel({ rootDir: undefined as unknown as string }), /rootDir/);
});

test("FileChannel: setup creates the root directory by default", async () => {
  const root = path.join(os.tmpdir(), `orbit-file-create-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  const channel = new FileChannel({ rootDir: root });
  await channel.setup(makeCtx());
  const stat = await fs.stat(root);
  assert.equal(stat.isDirectory(), true);
  await fs.rm(root, { recursive: true, force: true });
});

test("FileChannel: setup fails when root is missing and createRootDir is false", async () => {
  const channel = new FileChannel({ rootDir: path.join(os.tmpdir(), "orbit-file-missing-root"), createRootDir: false });
  await assert.rejects(channel.setup(makeCtx()), /does not exist/);
});

test("FileChannel: write → read roundtrip returns content and byte count", async () => {
  const { channel, root } = await makeChannel();
  const written = await channel.writeTextFile("notes/a.txt", "hello orbit");
  assert.equal(written, 11);
  assert.equal(await channel.readTextFile("notes/a.txt"), "hello orbit");
  await fs.rm(root, { recursive: true, force: true });
});

test("FileChannel: readTextFile returns null for missing files, does not throw", async () => {
  const { channel, root } = await makeChannel();
  assert.equal(await channel.readTextFile("nope.txt"), null);
  await fs.rm(root, { recursive: true, force: true });
});

test("FileChannel: writeFile creates parent directories", async () => {
  const { channel, root } = await makeChannel();
  await channel.writeTextFile("a/b/c/deep.txt", "deep");
  assert.equal(await channel.readTextFile("a/b/c/deep.txt"), "deep");
  await fs.rm(root, { recursive: true, force: true });
});

test("FileChannel: appendTextFile appends and creates missing files", async () => {
  const { channel, root } = await makeChannel();
  assert.equal(await channel.appendTextFile("log.txt", "line1\n"), 6);
  assert.equal(await channel.appendTextFile("log.txt", "line2\n"), 6);
  assert.equal(await channel.readTextFile("log.txt"), "line1\nline2\n");
  await fs.rm(root, { recursive: true, force: true });
});

test("FileChannel: listDir returns sorted entry names", async () => {
  const { channel, root } = await makeChannel();
  await channel.writeTextFile("b.txt", "1");
  await channel.writeTextFile("a.txt", "1");
  await channel.makeDir("zdir");
  assert.deepEqual(await channel.listDir("."), ["a.txt", "b.txt", "zdir"]);
  await fs.rm(root, { recursive: true, force: true });
});

test("FileChannel: listDir on a missing directory throws ChannelCallFaultError", async () => {
  const { channel, root } = await makeChannel();
  await assert.rejects(channel.listDir("missing"), (err: unknown) => {
    assert.ok(err instanceof ChannelCallFaultError);
    return true;
  });
  await fs.rm(root, { recursive: true, force: true });
});

test("FileChannel: statPath reports file, dir and missing states", async () => {
  const { channel, root } = await makeChannel();
  await channel.writeTextFile("f.txt", "12345");
  await channel.makeDir("d");

  const file = await channel.statPath("f.txt");
  assert.equal(file.exists, true);
  assert.equal(file.kind, "file");
  assert.equal(file.sizeBytes, 5);
  assert.ok(typeof file.modifiedAt === "string");

  const dir = await channel.statPath("d");
  assert.equal(dir.kind, "dir");

  const missing = await channel.statPath("ghost.txt");
  assert.deepEqual(missing, { exists: false, kind: "missing", sizeBytes: 0, modifiedAt: null });

  await fs.rm(root, { recursive: true, force: true });
});

test("FileChannel: removePath removes files; non-empty dirs need recursive", async () => {
  const { channel, root } = await makeChannel();
  await channel.writeTextFile("gone.txt", "x");
  await channel.removePath("gone.txt");
  assert.equal(await channel.readTextFile("gone.txt"), null);

  await channel.writeTextFile("tree/inner.txt", "x");
  await assert.rejects(channel.removePath("tree"), /ENOTEMPTY|EISDIR|Directory not empty/);
  await channel.removePath("tree", true);
  assert.deepEqual(await channel.statPath("tree"), { exists: false, kind: "missing", sizeBytes: 0, modifiedAt: null });
  await fs.rm(root, { recursive: true, force: true });
});

test("FileChannel: path jail rejects traversal beyond the root", async () => {
  const { channel, root } = await makeChannel();
  await assert.rejects(
    channel.readTextFile("../escape.txt"),
    (err: unknown) => {
      assert.ok(err instanceof ChannelCallFaultError);
      assert.match(err.message, /escapes the file channel root/);
      return true;
    }
  );
  await assert.rejects(channel.writeTextFile("..\\..\\escape.txt", "x"), /escapes the file channel root/);
  await assert.rejects(channel.listDir("../"), /escapes the file channel root/);
  await fs.rm(root, { recursive: true, force: true });
});

test("FileChannel: absolute paths are rejected unless they resolve inside the root", async () => {
  const { channel, root } = await makeChannel();
  await assert.rejects(channel.readTextFile(path.join(os.tmpdir(), "elsewhere.txt")), /escapes the file channel root/);
  // An in-root absolute path is fine (it resolves back inside the jail).
  const inRoot = path.join(root, "abs.txt");
  await channel.writeTextFile(inRoot, "ok");
  assert.equal(await channel.readTextFile(inRoot), "ok");
  await fs.rm(root, { recursive: true, force: true });
});

test("FileChannel: null bytes in paths are rejected upfront", async () => {
  const { channel, root } = await makeChannel();
  await assert.rejects(channel.readTextFile("bad\0path"), /null byte/);
  await fs.rm(root, { recursive: true, force: true });
});

test("FileChannel: size guard rejects oversized reads and writes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-file-limit-"));
  const channel = new FileChannel({ rootDir: root, maxFileBytes: 32 });
  await channel.setup(makeCtx());
  const big = "x".repeat(64);
  await assert.rejects(channel.writeTextFile("big.txt", big), /32 byte limit/);
  await fs.writeFile(path.join(root, "big2.txt"), big, "utf8");
  await assert.rejects(channel.readTextFile("big2.txt"), /32 byte limit/);
  await fs.rm(root, { recursive: true, force: true });
});

test("FileChannel: replay contract is io-bound + inject", async () => {
  const { channel, root } = await makeChannel();
  assert.deepEqual(channel.determinismMeta, { determinism: "io-bound", replayPolicy: "inject" });
  await channel.teardown();
  await fs.rm(root, { recursive: true, force: true });
});
