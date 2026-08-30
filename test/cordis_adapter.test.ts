import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CORDIS_DEFAULT_FIDELITY_NOTE,
  CORDIS_PROTOCOL_VERSION,
  ChannelKind,
  ChildProcessCordisTransport,
  CordisPaeAdapter,
  DeterminismLevel,
  InMemoryCordisTransport,
  OrbitRuntimeHost,
  PaeAdapterRejectError,
  PaeAdapterRegistry,
  PaeChannel,
  PaeRemoteError,
  PaeToolMissingError,
  decodeFrame,
  encodeFrame,
  isCordisResponse,
  normaliseCordisToolResult,
  parseCordisToolList,
  remoteErrorOf
} from "../src/index";
import type { IPaeAdapter, PaeInvokeCtx } from "../src/index";

/**
 * W18 — Cordis adapter suite.
 *
 * Three layers under test, kept separate like the MCP suite:
 *
 * 1. **protocol** — pure framing and surface parsing, so the host-defined wire
 *    format is verifiable without any I/O;
 * 2. **transport** — correlation, deadlines and closure, exercised in memory and
 *    against real `node` child processes so the suite stays platform-independent
 *    while still proving L2;
 * 3. **adapter + host** — that a discovered foreign surface is registered,
 *    governed, recorded and replayed exactly like a native one, and that the
 *    child process behind it is actually released.
 */

const CTX: PaeInvokeCtx = { traceMarkId: "tm-cordis", maxWaitMs: 1000 };

interface ToolDef {
  name: string;
  description?: string;
  input?: Record<string, unknown>;
}

/** A fake Cordis host. Counts `tools/call` arrivals so replay can assert zero. */
function fakeHost(tools: ToolDef[], state: { calls: number } = { calls: 0 }) {
  return (method: string, params: unknown): unknown => {
    switch (method) {
      case "initialize":
        return {
          protocolVersion: CORDIS_PROTOCOL_VERSION,
          hostInfo: { name: "fake-cordis", version: "2.1.0" }
        };
      case "tools/list":
        return { tools };
      case "tools/call": {
        state.calls += 1;
        const p = params as { name: string; arguments: Record<string, unknown> };
        return { echoed: p.name, args: p.arguments };
      }
      default:
        throw new Error(`unexpected method ${method}`);
    }
  };
}

function makeAdapter(
  tools: ToolDef[],
  state: { calls: number } = { calls: 0 },
  opts: { toolNamePrefix?: string; tools?: unknown[]; id?: string } = {}
): CordisPaeAdapter {
  return new CordisPaeAdapter({
    adapterId: opts.id ?? "cordis-host",
    sourceEdition: "1.0.0",
    transport: new InMemoryCordisTransport(fakeHost(tools, state)),
    toolNamePrefix: opts.toolNamePrefix,
    ...(opts.tools ? { tools: opts.tools as never } : {})
  });
}

// ---------------------------------------------------------------------------
// Protocol
// ---------------------------------------------------------------------------

test("cordis protocol: a message serialises to a single line", () => {
  const line = encodeFrame({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  assert.ok(!line.includes("\n"), "stdio framing breaks on embedded newlines");
  assert.deepEqual(JSON.parse(line), { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
});

test("cordis protocol: unparseable and non-envelope lines are skipped, not fatal", () => {
  assert.equal(decodeFrame(""), null, "keep-alive blank line");
  assert.equal(decodeFrame("not json at all"), null, "host log noise on the stream");
  assert.equal(decodeFrame(JSON.stringify({ jsonrpc: "1.0", id: 1, result: {} })), null);
  assert.equal(decodeFrame(JSON.stringify({ jsonrpc: "2.0", id: 1 })), null, "neither result nor error");
  assert.equal(
    decodeFrame(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {}, error: { message: "x" } })),
    null,
    "a response cannot be both"
  );
  assert.equal(decodeFrame(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: 1 } })), null, "error needs a message");
  const ok = decodeFrame(JSON.stringify({ jsonrpc: "2.0", id: 7, result: { ok: true } }));
  assert.deepEqual(ok, { jsonrpc: "2.0", id: 7, result: { ok: true } });
});

test("cordis protocol: isCordisResponse and remoteErrorOf", () => {
  assert.equal(isCordisResponse({ jsonrpc: "2.0", id: 1, result: 3 }), true);
  assert.equal(isCordisResponse({ jsonrpc: "2.0", id: 1, result: 3, error: { message: "x" } }), false);
  const err = remoteErrorOf({ jsonrpc: "2.0", id: 1, error: { message: "boom", data: { k: 1 } } });
  assert.equal(err?.message, "boom");
  assert.equal(remoteErrorOf({ jsonrpc: "2.0", id: 1, result: 3 }), null);
});

test("cordis protocol: tool list validation rejects a malformed host", () => {
  assert.throws(() => parseCordisToolList(null), /not an object/);
  assert.throws(() => parseCordisToolList({ tools: "nope" }), /not an array/);
  assert.throws(() => parseCordisToolList({ tools: [{ name: "" }] }), /no usable name/);
  assert.throws(() => parseCordisToolList({ tools: [{ name: "a" }, { name: "a" }] }), /duplicate tool name/);
  const ok = parseCordisToolList({ tools: [{ name: "search", description: "d", input: { type: "object" } }] });
  assert.deepEqual(ok, [{ name: "search", description: "d", input: { type: "object" } }]);
});

test("cordis protocol: results pass through verbatim, undefined becomes null", () => {
  assert.deepEqual(normaliseCordisToolResult({ a: 1 }), { value: { a: 1 }, degraded: false });
  assert.deepEqual(normaliseCordisToolResult("text"), { value: "text", degraded: false });
  assert.deepEqual(normaliseCordisToolResult(undefined), { value: null, degraded: false });
});

// ---------------------------------------------------------------------------
// Transport — in memory
// ---------------------------------------------------------------------------

test("cordis transport: in-memory round-trips and rejects after close", async () => {
  let seen: unknown = null;
  const t = new InMemoryCordisTransport((method, params) => {
    seen = { method, params };
    return { echo: true };
  });
  const res = await t.request("ping", { x: 1 }, 1000);
  assert.deepEqual(res.result, { echo: true });
  assert.equal(res.jsonrpc, "2.0");
  assert.deepEqual(seen, { method: "ping", params: { x: 1 } });
  await t.close();
  await assert.rejects(() => t.request("ping", {}, 1));
});

test("cordis transport: in-memory deadline is enforced via the injected clock", async () => {
  let now = 0;
  const t = new InMemoryCordisTransport(
    async () => {
      now += 5000; // the handler takes 5s of fake time
      return { ok: true };
    },
    { clock: { now: () => now } }
  );
  await assert.rejects(() => t.request("slow", {}, 1000), /timed out/);
});

// ---------------------------------------------------------------------------
// Transport — child process (real L2)
// ---------------------------------------------------------------------------

function cordisChildFixture(tools: ToolDef[]) {
  return [
    "const tools = " + JSON.stringify(tools) + ";",
    "const readline = require('node:readline');",
    "const rl = readline.createInterface({ input: process.stdin, terminal: false });",
    "rl.on('line', (line) => {",
    "  if (!line.trim()) return;",
    "  const m = JSON.parse(line);",
    "  const send = (r) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: r }) + '\\n');",
    '  if (m.method === "initialize") send({ protocolVersion: "' + CORDIS_PROTOCOL_VERSION + '", hostInfo: { name: "stdio-cordis", version: "3.0.0" } });',
    '  else if (m.method === "tools/list") send({ tools });',
    '  else if (m.method === "tools/call") send({ name: m.params.name, args: m.params.arguments });',
    "});"
  ].join("\n");
}

test("cordis adapter: end-to-end against a real child process", async () => {
  const transport = new ChildProcessCordisTransport({
    command: process.execPath,
    args: ["-e", cordisChildFixture([{ name: "ping", description: "ping a host" }])]
  });
  const adapter = new CordisPaeAdapter({
    adapterId: "cordis-stdio",
    sourceEdition: "1.0.0",
    transport
  });
  try {
    await adapter.setup({ traceMarkId: "tm-stdio", maxWaitMs: 10_000 });
    assert.deepEqual(
      adapter.describe().map((t) => t.name),
      ["ping"]
    );
    assert.equal(adapter.hostInfo?.name, "stdio-cordis");
    assert.equal(adapter.meta.sourceEdition, "3.0.0", "the handshake-reported version is adopted");
    const out = await adapter.invoke("ping", [{ x: 1 }], { traceMarkId: "tm-stdio", maxWaitMs: 10_000 });
    assert.deepEqual(out, { name: "ping", args: { x: 1 } });
  } finally {
    await adapter.teardown();
  }
  assert.equal(transport.closed, true);
});

test("cordis transport: a dead host fails in-flight requests instead of hanging", async () => {
  const transport = new ChildProcessCordisTransport({
    command: process.execPath,
    args: ["-e", "process.exit(3);"]
  });
  await transport.start();
  await new Promise((r) => setTimeout(r, 300));
  await assert.rejects(transport.request("tools/list", {}, 2_000), PaeRemoteError);
  await transport.close();
});

test("cordis transport: a host that dies on startup says why", async () => {
  const transport = new ChildProcessCordisTransport({
    command: process.execPath,
    args: ["-e", "console.error('boom: fixture exploded'); process.exit(1);"]
  });
  await transport.start();
  await new Promise((r) => setTimeout(r, 400));
  await assert.rejects(
    transport.request("initialize", {}, 2_000),
    (err: unknown) => {
      assert.ok(err instanceof PaeRemoteError);
      assert.match(err.message, /fixture exploded/, "the host's last words reach the caller");
      return true;
    }
  );
  await transport.close();
});

// ---------------------------------------------------------------------------
// Adapter + host — registration, governance, recording, release
// ---------------------------------------------------------------------------

test("cordis adapter: rejects missing identity or transport", () => {
  assert.throws(() => new CordisPaeAdapter({ adapterId: "", transport: new InMemoryCordisTransport(() => ({})) }), /requires an adapterId/);
  assert.throws(() => new CordisPaeAdapter({ adapterId: "x" } as never), /requires a transport/);
});

test("cordis adapter: meta reports cordis kind, L2, adopted semver, reduced default fidelity", async () => {
  const a = makeAdapter([{ name: "render", description: "render a card" }]);
  assert.equal(a.meta.kind, "cordis");
  assert.equal(a.meta.isolation, "L2");
  assert.equal(a.meta.sourceEdition, "1.0.0", "pre-handshake placeholder is the config edition");
  await a.setup(CTX);
  assert.equal(a.meta.sourceEdition, "2.1.0", "handshake-reported version is adopted");
  const surface = a.describe();
  assert.equal(surface.length, 1);
  const render = surface[0];
  assert.equal(render.name, "render");
  assert.equal(render.fidelity, "reduced");
  assert.equal(render.determinism, DeterminismLevel.IO_BOUND);
  assert.equal(render.fidelityNote, CORDIS_DEFAULT_FIDELITY_NOTE);
  await a.teardown();
});

test("cordis adapter: unknown tool is PaeToolMissingError, host error is PaeRemoteError", async () => {
  const a = makeAdapter([{ name: "ok" }]);
  await a.setup(CTX);
  await assert.rejects(() => a.invoke("nope", [], CTX), (e: unknown) => e instanceof PaeToolMissingError);

  /*
   * A protocol-level failure: the host answers `tools/call` with an error
   * envelope (not a result payload). The in-memory transport wraps handler
   * returns as `result`, so a bespoke transport is needed to exercise the
   * adapter's remoteErrorOf path.
   */
  let closed = false;
  const failingTransport = {
    get closed() {
      return closed;
    },
    request: async (method: string): Promise<unknown> => {
      if (method === "initialize") {
        return { jsonrpc: "2.0", id: 1, result: { protocolVersion: CORDIS_PROTOCOL_VERSION, hostInfo: { name: "f", version: "1.0.0" } } };
      }
      if (method === "tools/list") {
        return { jsonrpc: "2.0", id: 1, result: { tools: [{ name: "boom" }] } };
      }
      return { jsonrpc: "2.0", id: 1, error: { message: "the plugin exploded" } };
    },
    close: async () => {
      closed = true;
    }
  };
  const failing = new CordisPaeAdapter({
    adapterId: "cordis-fail",
    transport: failingTransport as never
  });
  await failing.setup(CTX);
  await assert.rejects(() => failing.invoke("boom", [{}], CTX), (e: unknown) => {
    if (!(e instanceof PaeRemoteError)) return false;
    return /the plugin exploded/.test(e.message);
  });
  await failing.teardown();
  assert.equal(closed, true);
});

test("cordis adapter: teardown releases the transport", async () => {
  const transport = new InMemoryCordisTransport(fakeHost([{ name: "ping" }]));
  const a = new CordisPaeAdapter({ adapterId: "cordis-close", transport });
  await a.setup(CTX);
  assert.equal(a.isConnected, true);
  await a.teardown();
  assert.equal(a.isConnected, false);
  assert.equal(transport.closed, true);
});

test("cordis adapter: two hosts need a toolNamePrefix to avoid collision", async () => {
  const r1 = new PaeAdapterRegistry();
  const a1 = makeAdapter([{ name: "send" }], { calls: 0 }, { id: "cordis-a" });
  await a1.setup(CTX);
  r1.register(a1);
  const a2 = makeAdapter([{ name: "send" }], { calls: 0 }, { toolNamePrefix: "b_", id: "cordis-b" });
  await a2.setup(CTX);
  r1.register(a2);
  assert.equal(r1.listAdapters().length, 2);
  r1.unregister("cordis-a");
  r1.unregister("cordis-b");
});

test("cordis adapter: host routes a call through the gateway like a native tool", async () => {
  const adapter = makeAdapter([{ name: "translate" }]);
  const host = new OrbitRuntimeHost();
  await host.connectPaeToolAdapter(adapter);
  const out = await host.capabilityInvoke<{ echoed: string; args: unknown }>({
    kind: ChannelKind.PAE_TOOL,
    pluginId: "cordis-host",
    funcName: "translate",
    args: [{ text: "hello" }],
    mode: "record"
  });
  assert.deepEqual(out, { echoed: "translate", args: { text: "hello" } });
  await host.unregisterPaeToolAdapter("cordis-host");
});
