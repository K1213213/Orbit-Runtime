/**
 * Teardown must be total even when a component fails to release.
 *
 * Both loops below used to `await` each release directly, so the first throw
 * skipped every release behind it — and skipped the final `clear()`. Since each
 * of those components may own a child process, one failing MCP teardown was
 * enough to leak the entire remaining surface.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  ChannelHub,
  PaeAdapterRegistry,
  ChildProcessDomainTransport,
  ChildProcessCordisTransport,
  ChannelKind,
  ChannelCallCtx,
  DeterminismLevel
} from "../src/index";
import type { IPaeAdapter, PaeInvokeCtx, PaeToolDescriptor } from "@orbit/pae-engine";

function makeCtx(overrides: Partial<ChannelCallCtx> = {}): ChannelCallCtx {
  return { traceMarkId: "t-1", maxWaitMs: 1000, ...overrides };
}

/* ------------------------------------------------------------ ChannelHub */

test("channel hub: a throwing teardown does not strand the channels behind it", async () => {
  const released: string[] = [];
  const mk = (id: string, throws: boolean) => ({
    setup: async () => {},
    teardown: async () => {
      released.push(id);
      if (throws) throw new Error(`${id} exploded`);
    },
    determinismMeta: { determinism: DeterminismLevel.DETERMINISTIC }
  });

  const hub = new ChannelHub();
  hub.registerBuiltInChannel(ChannelKind.MEM_KV_STORE, mk("kv", true));
  hub.registerBuiltInChannel(ChannelKind.LLM_ACCESS, mk("llm", false));
  hub.registerPluginExtChannel(ChannelKind.FILE_STORE, mk("file", false));

  // Does not reject: a failed release is contained, not propagated.
  await hub.teardown();

  assert.deepEqual(released, ["kv", "llm", "file"], "every channel was released");
  // clear() ran despite the failure, so nothing is left registered.
  assert.equal(hub.getEffectiveChannel(ChannelKind.LLM_ACCESS), undefined);
  assert.equal(hub.getEffectiveChannel(ChannelKind.FILE_STORE), undefined);
  assert.deepEqual(hub.listCallContexts(), []);
});

test("channel hub: teardown still releases everything when the last channel throws", async () => {
  const released: string[] = [];
  const mk = (id: string, throws: boolean) => ({
    setup: async () => {},
    teardown: async () => {
      released.push(id);
      if (throws) throw new Error(`${id} exploded`);
    },
    determinismMeta: { determinism: DeterminismLevel.DETERMINISTIC }
  });

  const hub = new ChannelHub();
  hub.registerBuiltInChannel(ChannelKind.MEM_KV_STORE, mk("kv", false));
  hub.registerPluginExtChannel(ChannelKind.FILE_STORE, mk("file", true));

  await hub.teardown();
  assert.deepEqual(released, ["kv", "file"]);
  assert.equal(hub.getEffectiveChannel(ChannelKind.MEM_KV_STORE), undefined);
});

test("channel hub: teardown is idempotent on an empty hub", async () => {
  const hub = new ChannelHub();
  await hub.teardown();
  await hub.teardown();
});

/* ----------------------------------------------------- PaeAdapterRegistry */

function fakeAdapter(adapterId: string, toolName: string, onTeardown: () => Promise<void>): IPaeAdapter {
  const tool: PaeToolDescriptor = {
    name: toolName,
    capability: "channel:read",
    determinism: DeterminismLevel.IO_BOUND,
    fidelity: "full",
    description: "teardown fixture"
  };
  return {
    meta: { adapterId, kind: "mcp", sourceEdition: "1.0.0", isolation: "subprocess" },
    describe: () => [tool],
    invoke: async (): Promise<unknown> => null,
    teardown: onTeardown
  };
}

test("pae registry: a throwing teardown does not strand the adapters behind it", async () => {
  const released: string[] = [];
  const registry = new PaeAdapterRegistry();

  registry.register(
    fakeAdapter("bad", "badTool", async () => {
      released.push("bad");
      throw new Error("bad exploded");
    })
  );
  registry.register(
    fakeAdapter("good-1", "goodTool1", async () => {
      released.push("good-1");
    })
  );
  registry.register(
    fakeAdapter("good-2", "goodTool2", async () => {
      released.push("good-2");
    })
  );

  await registry.teardownAll();

  assert.deepEqual(released, ["bad", "good-1", "good-2"], "every adapter was released");
  // The setup bookkeeping was cleared, so a re-registered adapter is set up afresh.
  assert.deepEqual(registry.listAdapters().map((a) => a.adapterId), ["bad", "good-1", "good-2"]);
  registry.clear();
  assert.equal(registry.isEmpty(), true);
});

test("pae registry: an adapter without teardown is skipped harmlessly", async () => {
  const registry = new PaeAdapterRegistry();
  const adapter = fakeAdapter("no-teardown", "toolX", async () => {});
  delete (adapter as { teardown?: () => Promise<void> }).teardown;
  registry.register(adapter);
  await registry.teardownAll();
  assert.equal(registry.listAdapters().length, 1);
});

/* ------------------------------------------- child process reaping (close) */

async function tempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/** True when no live process answers to `pid`. */
function pidIsGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    // ESRCH: gone. EPERM: alive but owned by someone else — treat as alive.
    return (err as NodeJS.ErrnoException).code === "ESRCH";
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the child to be reaped");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * A host script that publishes its own pid and then either exits cleanly when
 * stdin closes, or ignores stdin and has to be killed.
 */
function hostScript(pidFile: string, exitsOnStdinEnd: boolean): string {
  const marker = JSON.stringify(pidFile);
  const behaviour = exitsOnStdinEnd
    ? `process.stdin.resume(); process.stdin.on("end", () => process.exit(0));`
    : `setInterval(() => {}, 50);`;
  return `require("node:fs").writeFileSync(${marker}, String(process.pid)); ${behaviour}`;
}

test("domain transport: close() reaps a child that exits when stdin closes", async () => {
  const dir = await tempDir("orbit-close-");
  const pidFile = path.join(dir, "child.pid");
  const transport = new ChildProcessDomainTransport({
    command: process.execPath,
    args: ["-e", hostScript(pidFile, true)]
  });
  await transport.start();
  await waitFor(() => fs.access(pidFile).then(() => true, () => false));

  const pid = Number(await fs.readFile(pidFile, "utf8"));
  assert.ok(pid > 0, "the host published its pid");
  assert.equal(pidIsGone(pid), false, "the host is running before close()");

  await transport.close();
  // The whole point: once close() resolves the child is actually gone, not
  // merely signalled — otherwise it outlives the kernel that spawned it.
  await waitFor(() => pidIsGone(pid));
  assert.equal(transport.closed, true);
  await fs.rm(dir, { recursive: true, force: true });
});

test("domain transport: close() kills a child that ignores stdin instead of hanging", async () => {
  const dir = await tempDir("orbit-close-");
  const pidFile = path.join(dir, "child.pid");
  const transport = new ChildProcessDomainTransport({
    command: process.execPath,
    args: ["-e", hostScript(pidFile, false)]
  });
  await transport.start();
  await waitFor(() => fs.access(pidFile).then(() => true, () => false));
  const pid = Number(await fs.readFile(pidFile, "utf8"));

  await transport.close();
  // A hostile host cannot be asked nicely, so the grace window must expire and
  // the process must be killed — close() must neither hang nor leak it.
  await waitFor(() => pidIsGone(pid));
  await fs.rm(dir, { recursive: true, force: true });
});

test("cordis transport: close() reaps a child that exits when stdin closes", async () => {
  const dir = await tempDir("orbit-close-");
  const pidFile = path.join(dir, "child.pid");
  const transport = new ChildProcessCordisTransport({
    command: process.execPath,
    args: ["-e", hostScript(pidFile, true)]
  });
  await transport.start();
  await waitFor(() => fs.access(pidFile).then(() => true, () => false));

  const pid = Number(await fs.readFile(pidFile, "utf8"));
  assert.equal(pidIsGone(pid), false, "the host is running before close()");

  await transport.close();
  await waitFor(() => pidIsGone(pid));
  assert.equal(transport.closed, true);
  await fs.rm(dir, { recursive: true, force: true });
});

test("cordis transport: close() kills a child that ignores stdin instead of hanging", async () => {
  const dir = await tempDir("orbit-close-");
  const pidFile = path.join(dir, "child.pid");
  const transport = new ChildProcessCordisTransport({
    command: process.execPath,
    args: ["-e", hostScript(pidFile, false)]
  });
  await transport.start();
  await waitFor(() => fs.access(pidFile).then(() => true, () => false));
  const pid = Number(await fs.readFile(pidFile, "utf8"));

  await transport.close();
  await waitFor(() => pidIsGone(pid));
  await fs.rm(dir, { recursive: true, force: true });
});

test("child transports: close() before start() is a safe no-op", async () => {
  const domain = new ChildProcessDomainTransport({ command: process.execPath, args: ["-e", ""] });
  await domain.close();
  assert.equal(domain.closed, true);

  const cordis = new ChildProcessCordisTransport({ command: process.execPath, args: ["-e", ""] });
  await cordis.close();
  assert.equal(cordis.closed, true);
});

test("child transports: close() is idempotent", async () => {
  const dir = await tempDir("orbit-close-");
  const pidFile = path.join(dir, "child.pid");
  const transport = new ChildProcessDomainTransport({
    command: process.execPath,
    args: ["-e", hostScript(pidFile, true)]
  });
  await transport.start();
  await transport.close();
  await transport.close();
  assert.equal(transport.closed, true);
  await fs.rm(dir, { recursive: true, force: true });
});

// Guard the assumption behind the pid probe itself: without it, every test
// above could pass for the wrong reason.
test("fixture: the pid probe distinguishes a live child from a dead one", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 50)"], {
    stdio: ["pipe", "pipe", "pipe"]
  });
  await new Promise<void>((resolve) => child.on("spawn", () => resolve()));
  assert.equal(pidIsGone(child.pid!), false, "a live child is detected as live");
  child.kill("SIGKILL");
  await waitFor(() => pidIsGone(child.pid!));
});
