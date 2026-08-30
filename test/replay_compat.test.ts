import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ChannelHub } from "../src/channel/ChannelHub";
import { FileChannel } from "../src/channel/providers/FileChannel";
import { ShellChannel } from "../src/channel/providers/ShellChannel";
import { OpenAICompatChannel, LlmChannelFaultError } from "../src/channel/providers/openai_compat_channel";
import { RecordJournal } from "../src/replay/record_journal";
import { ReplayEngine } from "../src/replay/replay_engine";
import { saveRecordJournal, loadRecordJournal } from "../src/replay/persistence";
import { SeededRng } from "../src/replay/injectors";
import { PaeAdapterRegistry } from "../src/pae/PaeAdapterRegistry";
import { PaeChannel } from "../src/pae/PaeChannel";
import { JsPaeAdapter } from "../src/pae/adapters/JsPaeAdapter";
import { McpPaeAdapter } from "../src/pae/adapters/mcp/McpPaeAdapter";
import { InMemoryMcpTransport } from "../src/pae/adapters/mcp/transport";
import { MCP_PROTOCOL_VERSION } from "../src/pae/adapters/mcp/protocol";
import { OpenApiPaeAdapter } from "../src/pae/adapters/openapi/OpenApiPaeAdapter";
import { InMemoryHttpTransport } from "../src/pae/adapters/openapi/transport";
import { digestInputs } from "../src/utils/digest";
import { ChannelKind, ChannelCallCtx, ReplayMode } from "../src/types/orbitDomain";

/**
 * W2 gate: the replay-compatibility suite. Every new channel mechanism MUST
 * pass "record → replay, byte-identical, zero side effects, zero external
 * calls" before it is allowed into the kernel (kernel charter, axiom A1).
 * CI treats this file as a merge gate.
 *
 * Every script is executed twice: once with replayMode "record" (real
 * channels, outputs journaled) and once with "replay" (journal injection,
 * channels never run). Byte-identity and reconciliation are then asserted.
 */

const NODE = process.execPath;

function makeCtx(mode: ReplayMode, overrides: Partial<ChannelCallCtx> = {}): ChannelCallCtx {
  return { traceMarkId: "t-compat", maxWaitMs: 30_000, replayMode: mode, ...overrides };
}

/**
 * Run one script twice against the same hub: first in record mode (real
 * channels), then in replay mode (journal injection). Returns both outputs
 * plus the reconciliation report over the two journals.
 */
async function recordThenReplay<T>(
  hub: ChannelHub,
  script: (mode: ReplayMode) => Promise<T>
): Promise<{ live: T; replayed: T; recordJournal: RecordJournal; reconcileDigestChain: boolean }> {
  const recordJournal = new RecordJournal();
  hub.attachRecordJournal(recordJournal);
  const live = await script("record");

  const replayJournal = new RecordJournal();
  hub.attachRecordJournal(replayJournal);
  hub.attachReplayEngine(new ReplayEngine(recordJournal));
  const replayed = await script("replay");

  const report = new ReplayEngine(recordJournal).reconcile(recordJournal.snapshot(), replayJournal.snapshot());
  return { live, replayed, recordJournal, reconcileDigestChain: report.digestChainConsistent };
}

// ---------------------------------------------------------------------------
// FileChannel
// ---------------------------------------------------------------------------

test("replay_compat FileChannel: record → delete disk → replay is byte-identical with zero IO", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-compat-file-"));
  const hub = new ChannelHub();
  hub.registerBuiltInChannel(ChannelKind.FILE_SYSTEM, new FileChannel({ rootDir: root }));
  await hub.setupAllBuiltInChannels(makeCtx("record"));

  const script = async (mode: ReplayMode) => {
    const bytes = await hub.fireChannelCall<number>(ChannelKind.FILE_SYSTEM, makeCtx(mode), "writeTextFile", "data/a.txt", "orbit replay proof");
    const content = await hub.fireChannelCall<string>(ChannelKind.FILE_SYSTEM, makeCtx(mode), "readTextFile", "data/a.txt");
    const listing = await hub.fireChannelCall<string[]>(ChannelKind.FILE_SYSTEM, makeCtx(mode), "listDir", "data");
    const stat = await hub.fireChannelCall<{ exists: boolean; kind: string; modifiedAt: string | null }>(
      ChannelKind.FILE_SYSTEM,
      makeCtx(mode),
      "statPath",
      "data/a.txt"
    );
    return { bytes, content, listing, stat };
  };

  const { live, replayed, recordJournal, reconcileDigestChain } = await recordThenReplay(hub, script);
  assert.equal(live.content, "orbit replay proof");
  assert.deepEqual(replayed, live);
  assert.equal(reconcileDigestChain, true);

  // The proof of "zero IO on replay": wipe the directory, replay again, and
  // the outputs still come back identical from the journal alone.
  await fs.rm(root, { recursive: true, force: true });
  const replayJournal2 = new RecordJournal();
  hub.attachRecordJournal(replayJournal2);
  hub.attachReplayEngine(new ReplayEngine(recordJournal)); // start a new replay session
  const replayed2 = await script("replay");
  assert.deepEqual(replayed2, live);
  assert.equal(
    new ReplayEngine(recordJournal).reconcile(recordJournal.snapshot(), replayJournal2.snapshot()).digestChainConsistent,
    true
  );

  await hub.teardown();
});

test("replay_compat FileChannel: a read of a missing file records null and replays null", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-compat-miss-"));
  const hub = new ChannelHub();
  hub.registerBuiltInChannel(ChannelKind.FILE_SYSTEM, new FileChannel({ rootDir: root }));
  await hub.setupAllBuiltInChannels(makeCtx("record"));

  const { live, replayed, reconcileDigestChain } = await recordThenReplay(hub, (mode) =>
    hub.fireChannelCall<string | null>(ChannelKind.FILE_SYSTEM, makeCtx(mode), "readTextFile", "ghost.txt")
  );
  assert.equal(live, null);
  assert.equal(replayed, null);
  assert.equal(reconcileDigestChain, true);

  await hub.teardown();
  await fs.rm(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// ShellChannel
// ---------------------------------------------------------------------------

test("replay_compat ShellChannel: replay reproduces the result without executing anything", async () => {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-compat-shell-"));
  const sideEffect = path.join(workDir, "side-effect.txt");
  const hub = new ChannelHub();
  hub.registerBuiltInChannel(ChannelKind.SHELL_EXEC, new ShellChannel({ allowedCommands: [NODE], workDir, timeoutMs: 15_000 }));
  await hub.setupAllBuiltInChannels(makeCtx("record"));

  // The command has an observable side effect: it writes a file.
  const script = async (mode: ReplayMode) => {
    return hub.fireChannelCall<{ stdout: string; exitCode: number }>(
      ChannelKind.SHELL_EXEC,
      makeCtx(mode),
      "execCommand",
      NODE,
      ["-e", `require("fs").writeFileSync(${JSON.stringify(sideEffect)}, "executed"); process.stdout.write("cmd-output-42")`]
    );
  };

  const { live, replayed, recordJournal, reconcileDigestChain } = await recordThenReplay(hub, script);
  assert.equal(live.stdout, "cmd-output-42");
  assert.equal(live.exitCode, 0);
  assert.deepEqual(replayed, live);
  assert.equal(reconcileDigestChain, true);

  // Zero-execution proof: delete the side-effect file, replay again — the
  // result is still served from the journal and the file is NOT recreated.
  await fs.rm(sideEffect, { force: true });
  const replayJournal2 = new RecordJournal();
  hub.attachRecordJournal(replayJournal2);
  hub.attachReplayEngine(new ReplayEngine(recordJournal)); // new replay session
  const replayed2 = await script("replay");
  assert.deepEqual(replayed2, live);
  assert.equal(await fs.stat(sideEffect).then(() => true, () => false), false, "replay must not re-execute commands");

  await hub.teardown();
  await fs.rm(workDir, { recursive: true, force: true });
});

test("replay_compat ShellChannel: whitelist denials are deterministic pre-execution failures", async () => {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-compat-deny-"));
  const hub = new ChannelHub();
  hub.registerBuiltInChannel(ChannelKind.SHELL_EXEC, new ShellChannel({ allowedCommands: [NODE], workDir }));
  await hub.setupAllBuiltInChannels(makeCtx("record"));

  await assert.rejects(
    hub.fireChannelCall(ChannelKind.SHELL_EXEC, makeCtx("record"), "execCommand", "rm", ["-rf", "/"]),
    /not whitelisted/
  );
  await hub.teardown();
  await fs.rm(workDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// OpenAICompatChannel
// ---------------------------------------------------------------------------

test("replay_compat OpenAICompat: replay makes zero HTTP calls", async () => {
  let fetchCalls = 0;
  const hub = new ChannelHub();
  hub.registerBuiltInChannel(
    ChannelKind.LLM_ACCESS,
    new OpenAICompatChannel({
      apiKey: "sk-test",
      baseUrl: "https://replay.test",
      fetchImpl: (async () => {
        fetchCalls += 1;
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({ choices: [{ message: { role: "assistant", content: "the recorded answer" } }] })
        } as unknown as Response;
      }) as typeof fetch
    })
  );
  await hub.setupAllBuiltInChannels(makeCtx("record"));

  const { live, replayed, reconcileDigestChain } = await recordThenReplay(hub, (mode) =>
    hub.fireChannelCall<string>(ChannelKind.LLM_ACCESS, makeCtx(mode), "chatRound", "what is determinism?")
  );
  assert.equal(live, "the recorded answer");
  assert.equal(replayed, live);
  assert.equal(reconcileDigestChain, true);
  assert.equal(fetchCalls, 1, "replay must not touch the network");
  await hub.teardown();
});

test("replay_compat OpenAICompat: retry-then-success records only the final output", async () => {
  let attempt = 0;
  const hub = new ChannelHub();
  hub.registerBuiltInChannel(
    ChannelKind.LLM_ACCESS,
    new OpenAICompatChannel({
      apiKey: "sk-test",
      baseUrl: "https://retry.test",
      maxRetries: 2,
      initialRetryDelayMs: 1,
      fetchImpl: (async () => {
        attempt += 1;
        if (attempt <= 2) {
          return {
            ok: false,
            status: 429,
            statusText: "Too Many Requests",
            json: async () => ({ error: { message: "slow down" } })
          } as unknown as Response;
        }
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({ choices: [{ message: { role: "assistant", content: "after retries" } }] })
        } as unknown as Response;
      }) as typeof fetch
    })
  );
  await hub.setupAllBuiltInChannels(makeCtx("record"));

  const { live, replayed, recordJournal, reconcileDigestChain } = await recordThenReplay(hub, (mode) =>
    hub.fireChannelCall<string>(ChannelKind.LLM_ACCESS, makeCtx(mode), "chatRound", "hi")
  );
  assert.equal(live, "after retries");
  assert.equal(replayed, live);
  assert.equal(recordJournal.size(), 1, "internal retries must not leak into the journal");
  assert.equal(attempt, 3, "3 HTTP attempts happened during record (2 failures + 1 success)");
  assert.equal(reconcileDigestChain, true);
  await hub.teardown();
});

// ---------------------------------------------------------------------------
// Cross-channel interleaving + persistence
// ---------------------------------------------------------------------------

test("replay_compat multi-channel: interleaved LLM/File/Shell calls replay in order", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-compat-multi-"));
  const hub = new ChannelHub();
  hub.registerBuiltInChannel(ChannelKind.FILE_SYSTEM, new FileChannel({ rootDir: root }));
  hub.registerBuiltInChannel(ChannelKind.SHELL_EXEC, new ShellChannel({ allowedCommands: [NODE], workDir: root }));
  hub.registerBuiltInChannel(
    ChannelKind.LLM_ACCESS,
    new OpenAICompatChannel({
      apiKey: "sk-test",
      baseUrl: "https://multi.test",
      fetchImpl: (async () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ choices: [{ message: { role: "assistant", content: "llm says 7" } }] })
      })) as unknown as typeof fetch
    })
  );
  await hub.setupAllBuiltInChannels(makeCtx("record"));

  const script = async (mode: ReplayMode) => {
    await hub.fireChannelCall(ChannelKind.FILE_SYSTEM, makeCtx(mode), "writeTextFile", "in.txt", "3+4=");
    const llm = await hub.fireChannelCall<string>(ChannelKind.LLM_ACCESS, makeCtx(mode), "chatRound", "3+4=?");
    const calc = await hub.fireChannelCall<{ stdout: string }>(
      ChannelKind.SHELL_EXEC,
      makeCtx(mode),
      "execCommand",
      NODE,
      ["-e", "process.stdout.write(String(3+4))"]
    );
    await hub.fireChannelCall(ChannelKind.FILE_SYSTEM, makeCtx(mode), "writeTextFile", "out.txt", `${llm} ${calc.stdout}`);
    return hub.fireChannelCall<string>(ChannelKind.FILE_SYSTEM, makeCtx(mode), "readTextFile", "out.txt");
  };

  const { live, replayed, recordJournal, reconcileDigestChain } = await recordThenReplay(hub, script);
  assert.equal(live, "llm says 7 7");
  assert.equal(replayed, live);
  assert.equal(recordJournal.size(), 5);
  // Channel kinds interleave in the exact recorded order.
  assert.deepEqual(
    recordJournal.snapshot().map((r) => r.channelKind),
    [ChannelKind.FILE_SYSTEM, ChannelKind.LLM_ACCESS, ChannelKind.SHELL_EXEC, ChannelKind.FILE_SYSTEM, ChannelKind.FILE_SYSTEM]
  );
  assert.equal(reconcileDigestChain, true);
  await hub.teardown();
  await fs.rm(root, { recursive: true, force: true });
});

test("replay_compat persistence: save → load → replay across engine instances", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-compat-persist-"));
  const traceFile = path.join(root, "trace.jsonl");

  // "Process 1": record and persist.
  const hub1 = new ChannelHub();
  hub1.registerBuiltInChannel(ChannelKind.FILE_SYSTEM, new FileChannel({ rootDir: path.join(root, "fs") }));
  await hub1.setupAllBuiltInChannels(makeCtx("record"));
  const recordJournal = new RecordJournal();
  hub1.attachRecordJournal(recordJournal);
  const live = await hub1.fireChannelCall<number>(ChannelKind.FILE_SYSTEM, makeCtx("record"), "writeTextFile", "a.txt", "persisted");
  const liveRead = await hub1.fireChannelCall<string>(ChannelKind.FILE_SYSTEM, makeCtx("record"), "readTextFile", "a.txt");
  await saveRecordJournal(recordJournal, traceFile);
  await hub1.teardown();

  // "Process 2": fresh hub, no FileChannel registered at all; pure replay.
  const loaded = await loadRecordJournal(traceFile);
  const hub2 = new ChannelHub();
  const replayJournal = new RecordJournal();
  hub2.attachRecordJournal(replayJournal);
  hub2.attachReplayEngine(new ReplayEngine(loaded));
  const replayedWrite = await hub2.fireChannelCall<number>(ChannelKind.FILE_SYSTEM, makeCtx("replay"), "writeTextFile", "a.txt", "persisted");
  const replayedRead = await hub2.fireChannelCall<string>(ChannelKind.FILE_SYSTEM, makeCtx("replay"), "readTextFile", "a.txt");

  assert.equal(replayedWrite, live);
  assert.equal(replayedRead, liveRead);
  const report = new ReplayEngine(loaded).reconcile(recordJournal.snapshot(), replayJournal.snapshot());
  assert.equal(report.digestChainConsistent, true);
  await hub2.teardown();
  await fs.rm(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// PAE adaptation surface (W15) — merge gate for foreign runtimes
// ---------------------------------------------------------------------------

test("replay_compat PAE: replay serves foreign tool output without entering the adapter", async () => {
  let foreignCalls = 0;
  const registry = new PaeAdapterRegistry();
  registry.register(
    new JsPaeAdapter({
      adapterId: "compat-tools",
      sourceEdition: "1.0.0",
      tools: [
        {
          name: "renderCard",
          capability: "channel:read",
          handler: (args) => {
            foreignCalls += 1;
            return { title: String(args[0]), items: [1, 2, 3] };
          }
        }
      ]
    })
  );

  const hub = new ChannelHub();
  hub.registerBuiltInChannel(ChannelKind.PAE_TOOL, new PaeChannel(registry));
  await hub.setupAllBuiltInChannels(makeCtx("record"));

  const { live, replayed, reconcileDigestChain } = await recordThenReplay(hub, async (mode) =>
    hub.fireChannelCall<{ title: string; items: number[] }>(
      ChannelKind.PAE_TOOL,
      makeCtx(mode),
      "renderCard",
      "orbit"
    )
  );

  assert.deepEqual(replayed, live);
  assert.equal(JSON.stringify(replayed), JSON.stringify(live), "byte-identical");
  assert.equal(foreignCalls, 1, "the foreign runtime runs exactly once, during recording");
  assert.ok(reconcileDigestChain);
  await hub.teardown();
});

test("replay_compat PAE: an unregistered adapter is not needed to replay its trace", async () => {
  const registry = new PaeAdapterRegistry();
  registry.register(
    new JsPaeAdapter({
      adapterId: "ephemeral",
      tools: [{ name: "onceOnly", handler: () => "recorded-value" }]
    })
  );
  const channel = new PaeChannel(registry);
  const hub = new ChannelHub();
  hub.registerBuiltInChannel(ChannelKind.PAE_TOOL, channel);
  await hub.setupAllBuiltInChannels(makeCtx("record"));

  const recordJournal = new RecordJournal();
  hub.attachRecordJournal(recordJournal);
  const live = await hub.fireChannelCall<string>(ChannelKind.PAE_TOOL, makeCtx("record"), "onceOnly");
  assert.equal(live, "recorded-value");

  // The adapter goes away entirely — as it would on a machine that lacks the
  // foreign runtime, its credentials, or the network to reach it.
  registry.unregister("ephemeral");
  channel.syncTools();
  assert.deepEqual(channel.installedTools(), []);

  hub.attachReplayEngine(new ReplayEngine(recordJournal));
  const replayed = await hub.fireChannelCall<string>(ChannelKind.PAE_TOOL, makeCtx("replay"), "onceOnly");
  assert.equal(replayed, live, "replay depends on the journal, never on the foreign runtime");
  await hub.teardown();
});

test("replay_compat PAE: adapters run with Math.random poisoned", async () => {
  const registry = new PaeAdapterRegistry();
  registry.register(
    new JsPaeAdapter({
      adapterId: "seeded-tools",
      tools: [
        {
          name: "seededPick",
          // Determinism arrives through the injected context; an adapter that
          // minted its own randomness would break replay, so the charter test
          // poisons the global source while the call runs.
          handler: (_args, ctx) => Math.floor((ctx.rng?.next() ?? 0) * 100)
        }
      ]
    })
  );
  const hub = new ChannelHub();
  hub.registerBuiltInChannel(ChannelKind.PAE_TOOL, new PaeChannel(registry));
  await hub.setupAllBuiltInChannels(makeCtx("record", { rng: new SeededRng(7) }));

  const originalRandom = Math.random;
  Math.random = () => {
    throw new Error("bare Math.random inside a pae adapter (charter violation)");
  };
  try {
    const first = await hub.fireChannelCall<number>(ChannelKind.PAE_TOOL, makeCtx("record"), "seededPick");
    assert.equal(typeof first, "number");
  } finally {
    Math.random = originalRandom;
  }
  await hub.teardown();
});

// ---------------------------------------------------------------------------
// Charter guard: no bare randomness anywhere in the new channel paths
// ---------------------------------------------------------------------------

test("replay_compat charter: channels run with Math.random poisoned (no bare randomness)", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-compat-random-"));
  let poisonedAttempts = 0;
  const hub = new ChannelHub();
  hub.registerBuiltInChannel(ChannelKind.FILE_SYSTEM, new FileChannel({ rootDir: root }));
  hub.registerBuiltInChannel(ChannelKind.SHELL_EXEC, new ShellChannel({ allowedCommands: [NODE], workDir: root }));
  hub.registerBuiltInChannel(
    ChannelKind.LLM_ACCESS,
    new OpenAICompatChannel({
      apiKey: "sk-test",
      baseUrl: "https://random.test",
      maxRetries: 1,
      initialRetryDelayMs: 1,
      fetchImpl: (async () => {
        // Alternate failures so the retry path also runs under the poison.
        poisonedAttempts += 1;
        if (poisonedAttempts % 2 === 1) {
          return { ok: false, status: 503, statusText: "Service Unavailable", json: async () => ({ error: { message: "transient" } }) } as unknown as Response;
        }
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({ choices: [{ message: { role: "assistant", content: "poison-safe" } }] })
        } as unknown as Response;
      }) as typeof fetch
    })
  );
  await hub.setupAllBuiltInChannels(makeCtx("record"));

  const originalRandom = Math.random;
  Math.random = () => {
    throw new Error("bare Math.random inside a channel (charter violation)");
  };
  try {
    const file = await hub.fireChannelCall<string>(ChannelKind.FILE_SYSTEM, makeCtx("record"), "readTextFile", "missing.txt");
    assert.equal(file, null);
    const shell = await hub.fireChannelCall<{ exitCode: number }>(
      ChannelKind.SHELL_EXEC,
      makeCtx("record"),
      "execCommand",
      NODE,
      ["-e", "process.stdout.write('ok')"]
    );
    assert.equal(shell.exitCode, 0);
    const llm = await hub.fireChannelCall<string>(ChannelKind.LLM_ACCESS, makeCtx("record"), "chatRound", "hi");
    assert.equal(llm, "poison-safe");
  } finally {
    Math.random = originalRandom;
  }

  await hub.teardown();
  await fs.rm(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fault-classification interplay with record mode
// ---------------------------------------------------------------------------

test("replay_compat: a recorded LLM fault is not swallowed by record mode", async () => {
  const hub = new ChannelHub();
  hub.registerBuiltInChannel(
    ChannelKind.LLM_ACCESS,
    new OpenAICompatChannel({
      apiKey: "sk-test",
      baseUrl: "https://fault.test",
      maxRetries: 0,
      fetchImpl: (async () => ({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        json: async () => ({ error: { message: "bad key" } })
      })) as unknown as typeof fetch
    })
  );
  await hub.setupAllBuiltInChannels(makeCtx("record"));

  const recordJournal = new RecordJournal();
  hub.attachRecordJournal(recordJournal);
  await assert.rejects(
    hub.fireChannelCall(ChannelKind.LLM_ACCESS, makeCtx("record"), "chatRound", "hi"),
    (err: unknown) => {
      assert.ok(err instanceof LlmChannelFaultError);
      assert.equal(err.faultKind, "auth");
      return true;
    }
  );
  assert.equal(recordJournal.size(), 0, "failed calls are never journaled");
  await hub.teardown();
});

test("replay_compat: digest of identical inputs matches across channels and runs", () => {
  const a = digestInputs("x", 1, { k: "v" });
  const b = digestInputs("x", 1, { k: "v" });
  const c = digestInputs("x", 2, { k: "v" });
  assert.equal(a, b);
  assert.notEqual(a, c);
});

// ---------------------------------------------------------------------------
// MCP adaptation surface (W16) — merge gate for cross-process foreign runtimes
// ---------------------------------------------------------------------------

test("replay_compat MCP: replay serves the peer's output without re-entering the process", async () => {
  let peerCalls = 0;
  const transport = new InMemoryMcpTransport((method: string, params: unknown) => {
    if (method === "initialize") {
      return { protocolVersion: MCP_PROTOCOL_VERSION, serverInfo: { name: "compat-mcp", version: "1.0.0" } };
    }
    if (method === "notifications/initialized") return {};
    if (method === "tools/list") return { tools: [{ name: "renderCard", description: "render a card" }] };
    if (method === "tools/call") {
      peerCalls += 1;
      const p = params as { arguments: Record<string, unknown> };
      return { content: [{ type: "text", text: `card:${String(p.arguments.title)}` }] };
    }
    throw new Error(`unexpected method ${method}`);
  });

  const registry = new PaeAdapterRegistry();
  const adapter = new McpPaeAdapter({
    adapterId: "mcp-compat",
    sourceEdition: "1.0.0",
    transport
  });
  await adapter.setup(makeCtx("record"));
  registry.register(adapter);

  const hub = new ChannelHub();
  hub.registerBuiltInChannel(ChannelKind.PAE_TOOL, new PaeChannel(registry));
  await hub.setupAllBuiltInChannels(makeCtx("record"));

  const { live, replayed, reconcileDigestChain } = await recordThenReplay(hub, async (mode) =>
    hub.fireChannelCall<string>(ChannelKind.PAE_TOOL, makeCtx(mode), "renderCard", { title: "orbit" })
  );

  assert.equal(live, "card:orbit");
  assert.equal(replayed, live);
  assert.equal(JSON.stringify(replayed), JSON.stringify(live), "byte-identical across a process boundary");
  assert.equal(peerCalls, 1, "the peer is entered exactly once, during recording");
  assert.ok(reconcileDigestChain);
  await hub.teardown();
});

test("replay_compat MCP: a trace replays after its peer is gone", async () => {
  const transport = new InMemoryMcpTransport((method: string) => {
    if (method === "initialize") {
      return { protocolVersion: MCP_PROTOCOL_VERSION, serverInfo: { name: "mcp", version: "1.0.0" } };
    }
    if (method === "notifications/initialized") return {};
    if (method === "tools/list") return { tools: [{ name: "remoteLookup" }] };
    return { content: [{ type: "text", text: "remote-value" }] };
  });
  const registry = new PaeAdapterRegistry();
  const adapter = new McpPaeAdapter({
    adapterId: "mcp-ephemeral",
    sourceEdition: "1.0.0",
    transport
  });
  await adapter.setup(makeCtx("record"));
  registry.register(adapter);

  const channel = new PaeChannel(registry);
  const hub = new ChannelHub();
  hub.registerBuiltInChannel(ChannelKind.PAE_TOOL, channel);
  await hub.setupAllBuiltInChannels(makeCtx("record"));

  const recordJournal = new RecordJournal();
  hub.attachRecordJournal(recordJournal);
  const live = await hub.fireChannelCall<string>(
    ChannelKind.PAE_TOOL,
    makeCtx("record"),
    "remoteLookup",
    {}
  );
  assert.equal(live, "remote-value");

  /*
   * The MCP server is shut down and its adapter removed — as it would be on a
   * machine that lacks the peer, its credentials, or the network to reach it.
   * Replaying must depend on the journal alone.
   */
  registry.unregister("mcp-ephemeral");
  channel.syncTools();
  await registry.drainReleases();
  assert.equal(transport.closed, true, "the peer is released when its adapter goes away");

  hub.attachReplayEngine(new ReplayEngine(recordJournal));
  const replayed = await hub.fireChannelCall<string>(
    ChannelKind.PAE_TOOL,
    makeCtx("replay"),
    "remoteLookup",
    {}
  );
  assert.equal(replayed, live, "replay needs the journal, never the foreign process");
  await hub.teardown();
});

// ---------------------------------------------------------------------------
// OpenAPI adaptation surface (W17) — merge gate for foreign REST runtimes
// ---------------------------------------------------------------------------

const OPENAPI_DOC = {
  openapi: "3.0.1",
  info: { title: "Compat Pet", version: "2.0.0" },
  servers: [{ url: "https://api.petstore.test/v1" }],
  paths: {
    "/echo": {
      get: {
        operationId: "echoTool",
        parameters: [{ name: "msg", in: "query", required: true }]
      }
    }
  }
};

test("replay_compat OpenAPI: replay serves the server's output without re-entering the network", async () => {
  let peerCalls = 0;
  const transport = new InMemoryHttpTransport((req) => {
    peerCalls += 1;
    return { status: 200, body: JSON.stringify({ url: req.url }) };
  });

  const registry = new PaeAdapterRegistry();
  const adapter = new OpenApiPaeAdapter({
    adapterId: "openapi-compat",
    document: OPENAPI_DOC,
    transport
  });
  await adapter.setup(makeCtx("record"));
  registry.register(adapter);

  const hub = new ChannelHub();
  hub.registerBuiltInChannel(ChannelKind.PAE_TOOL, new PaeChannel(registry));
  await hub.setupAllBuiltInChannels(makeCtx("record"));

  const { live, replayed, reconcileDigestChain } = await recordThenReplay(hub, async (mode) =>
    hub.fireChannelCall<string>(ChannelKind.PAE_TOOL, makeCtx(mode), "echoTool", { msg: "orbit" })
  );

  assert.deepEqual(live, { url: "https://api.petstore.test/v1/echo?msg=orbit" });
  assert.deepEqual(replayed, live);
  assert.equal(peerCalls, 1, "the server is entered exactly once, during recording");
  assert.ok(reconcileDigestChain);
  await hub.teardown();
});

test("replay_compat OpenAPI: a trace replays after the server is gone", async () => {
  const transport = new InMemoryHttpTransport(() => ({
    status: 200,
    body: JSON.stringify({ url: "https://api.petstore.test/v1/echo?msg=gone" })
  }));
  const registry = new PaeAdapterRegistry();
  const adapter = new OpenApiPaeAdapter({
    adapterId: "openapi-ephemeral",
    document: OPENAPI_DOC,
    transport
  });
  await adapter.setup(makeCtx("record"));
  registry.register(adapter);

  const channel = new PaeChannel(registry);
  const hub = new ChannelHub();
  hub.registerBuiltInChannel(ChannelKind.PAE_TOOL, channel);
  await hub.setupAllBuiltInChannels(makeCtx("record"));

  const recordJournal = new RecordJournal();
  hub.attachRecordJournal(recordJournal);
  const live = await hub.fireChannelCall<string>(
    ChannelKind.PAE_TOOL,
    makeCtx("record"),
    "echoTool",
    { msg: "gone" }
  );
  assert.deepEqual(live, { url: "https://api.petstore.test/v1/echo?msg=gone" });

  /*
   * The API server is shut down and its adapter removed — as it would be on a
   * machine that lacks the endpoint, its credentials, or the network to reach
   * it. Replaying must depend on the journal alone.
   */
  registry.unregister("openapi-ephemeral");
  channel.syncTools();

  hub.attachReplayEngine(new ReplayEngine(recordJournal));
  const replayed = await hub.fireChannelCall<{ url: string }>(
    ChannelKind.PAE_TOOL,
    makeCtx("replay"),
    "echoTool",
    { msg: "gone" }
  );
  assert.deepEqual(replayed, live, "replay needs the journal, never the foreign server");
  await hub.teardown();
});
