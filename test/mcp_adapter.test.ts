import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ChannelKind,
  DeterminismLevel,
  InMemoryMcpTransport,
  McpPaeAdapter,
  MCP_PROTOCOL_VERSION,
  OrbitRuntimeHost,
  PaeAdapterRejectError,
  PaeAdapterRegistry,
  PaeRemoteError,
  PaeToolMissingError,
  RunFingerprintDriftError,
  StdioMcpTransport,
  decodeJsonRpc,
  encodeJsonRpc,
  isRemoteToolError,
  normaliseToolResult,
  parseToolList
} from "../src/index";
import type { IPaeAdapter, PaeInvokeCtx } from "../src/index";

/**
 * W16 — MCP adapter suite.
 *
 * Three layers are under test, and keeping them separate is the point:
 *
 * 1. **protocol** — pure parsing rules, so the untrusted-input handling can be
 *    verified without any I/O;
 * 2. **transport** — correlation, deadlines and closure, exercised in memory so
 *    the suite stays deterministic and platform-independent;
 * 3. **adapter + host** — that a discovered foreign surface is registered,
 *    governed, recorded and replayed exactly like a native one, and that the
 *    OS process behind it is actually released.
 */

const CTX: PaeInvokeCtx = { traceMarkId: "tm-mcp", maxWaitMs: 1000 };

interface ToolDef {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/** A fake MCP peer. Counts `tools/call` arrivals so replay can assert zero. */
function fakePeer(tools: ToolDef[], state: { calls: number } = { calls: 0 }) {
  return (method: string, params: unknown): unknown => {
    switch (method) {
      case "initialize":
        return {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "fake-mcp", version: "3.1.4" }
        };
      case "notifications/initialized":
        return {};
      case "tools/list":
        return { tools };
      case "tools/call": {
        state.calls += 1;
        const p = params as { name: string; arguments: Record<string, unknown> };
        return { content: [{ type: "text", text: `${p.name}:${JSON.stringify(p.arguments)}` }] };
      }
      default:
        throw new Error(`unexpected method ${method}`);
    }
  };
}

function makeAdapter(
  tools: ToolDef[],
  state: { calls: number } = { calls: 0 },
  opts: { toolNamePrefix?: string; fidelity?: "full" | "reduced" | "lossy"; tools?: unknown[] } = {}
): McpPaeAdapter {
  return new McpPaeAdapter({
    adapterId: "mcp-tools",
    sourceEdition: "1.0.0",
    transport: new InMemoryMcpTransport(fakePeer(tools, state)),
    toolNamePrefix: opts.toolNamePrefix,
    ...(opts.fidelity ? { fidelity: opts.fidelity } : {}),
    ...(opts.tools ? { tools: opts.tools as never } : {})
  });
}

// ---------------------------------------------------------------------------
// Protocol
// ---------------------------------------------------------------------------

test("mcp protocol: a message serialises to a single line", () => {
  const line = encodeJsonRpc({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  assert.ok(!line.includes("\n"), "stdio framing breaks on embedded newlines");
  assert.deepEqual(JSON.parse(line), { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
});

test("mcp protocol: unparseable and non-envelope lines are skipped, not fatal", () => {
  assert.equal(decodeJsonRpc(""), null, "keep-alive blank line");
  assert.equal(decodeJsonRpc("not json at all"), null, "server log noise on the stream");
  assert.equal(decodeJsonRpc(JSON.stringify({ jsonrpc: "1.0", id: 1, result: {} })), null);
  assert.equal(decodeJsonRpc(JSON.stringify({ jsonrpc: "2.0", id: 1 })), null, "neither result nor error");
  assert.equal(
    decodeJsonRpc(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {}, error: { code: 1, message: "x" } })),
    null,
    "a response cannot be both"
  );
  const ok = decodeJsonRpc(JSON.stringify({ jsonrpc: "2.0", id: 7, result: { ok: true } }));
  assert.deepEqual(ok, { jsonrpc: "2.0", id: 7, result: { ok: true } });
});

test("mcp protocol: tool list validation rejects a malformed peer", () => {
  assert.throws(() => parseToolList(null), /not an object/);
  assert.throws(() => parseToolList({ tools: "nope" }), /not an array/);
  assert.throws(() => parseToolList({ tools: [{ name: "" }] }), /no usable name/);
  assert.throws(() => parseToolList({ tools: [{ name: "a" }, { name: "a" }] }), /duplicate tool name/);
  const ok = parseToolList({ tools: [{ name: "search", description: "d", inputSchema: { type: "object" } }] });
  assert.deepEqual(ok, [{ name: "search", description: "d", inputSchema: { type: "object" } }]);
});

test("mcp protocol: text content maps to a value, non-text is preserved and flagged", () => {
  assert.deepEqual(normaliseToolResult({ structuredContent: { a: 1 } }), {
    value: { a: 1 },
    degraded: false
  });
  assert.equal(normaliseToolResult({ content: [{ type: "text", text: "hi" }] }).value, "hi");
  assert.deepEqual(
    normaliseToolResult({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }).value,
    ["a", "b"]
  );
  assert.equal(normaliseToolResult({ content: [] }).value, null);

  const image = normaliseToolResult({ content: [{ type: "image", data: "AAA", mimeType: "image/png" }] });
  assert.equal(image.degraded, true, "an image cannot be coerced into JSON without loss");
  assert.match(image.note!, /non-text content blocks/);
  assert.deepEqual(image.value, [{ type: "image", data: "AAA", mimeType: "image/png" }]);
});

test("mcp protocol: a tool-level failure is recognised as an error, not a value", () => {
  assert.equal(isRemoteToolError({ isError: true, content: [] }), true);
  assert.equal(isRemoteToolError({ content: [{ type: "text", text: "fine" }] }), false);
  assert.equal(isRemoteToolError(null), false);
});

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

test("mcp transport: request correlating and notify work in memory", async () => {
  const seen: string[] = [];
  const t = new InMemoryMcpTransport((method) => {
    seen.push(method);
    return { echoed: method };
  });
  const res = await t.request("tools/list", {}, 100);
  assert.deepEqual(res.result, { echoed: "tools/list" });
  await t.notify("notifications/initialized");
  assert.deepEqual(seen, ["tools/list", "notifications/initialized"]);
  await t.close();
  assert.equal(t.closed, true);
});

test("mcp transport: a closed transport refuses further traffic", async () => {
  const t = new InMemoryMcpTransport(() => ({}));
  await t.close();
  await assert.rejects(t.request("tools/list", {}, 100), PaeRemoteError);
  await assert.rejects(t.notify("notifications/initialized"), PaeRemoteError);
  await t.close();
});

test("mcp transport: the caller's deadline is enforced", async () => {
  let now = 0;
  const clock = { now: () => now };
  const t = new InMemoryMcpTransport(
    () => {
      now += 5_000;
      return {};
    },
    { clock }
  );
  await assert.rejects(t.request("tools/list", {}, 100), /exceeded 100ms/);
});

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

test("mcp adapter: handshake discovers the surface and records the peer identity", async () => {
  const adapter = makeAdapter([
    { name: "zeta", description: "z" },
    { name: "alpha", description: "a" }
  ]);
  await adapter.setup(CTX);
  assert.equal(adapter.isConnected, true);
  assert.deepEqual(adapter.serverInfo, {
    protocolVersion: MCP_PROTOCOL_VERSION,
    name: "fake-mcp",
    version: "3.1.4"
  });
  assert.deepEqual(
    adapter.describe().map((t) => t.name),
    ["alpha", "zeta"],
    "surface is sorted so the config hash is order-independent"
  );
});

test("mcp adapter: isolation is L2 and determinism defaults to io-bound", async () => {
  const adapter = makeAdapter([{ name: "search" }]);
  await adapter.setup(CTX);
  assert.equal(adapter.meta.kind, "mcp");
  assert.equal(adapter.meta.isolation, "L2", "the peer is a separate OS process");
  assert.equal(adapter.describe()[0].determinism, DeterminismLevel.IO_BOUND);
});

test("mcp adapter: fidelity defaults to reduced and says why", async () => {
  const adapter = makeAdapter([{ name: "search" }]);
  await adapter.setup(CTX);
  const tool = adapter.describe()[0];
  assert.equal(tool.fidelity, "reduced", "argument validation is remote, so full would be a false claim");
  assert.match(tool.fidelityNote!, /validated by the remote server/);
});

test("mcp adapter: invoking a tool marshals named arguments to the peer", async () => {
  const state = { calls: 0 };
  const adapter = makeAdapter([{ name: "search" }], state);
  await adapter.setup(CTX);
  const out = await adapter.invoke("search", [{ q: "orbit", limit: 2 }], CTX);
  assert.equal(out, 'search:{"q":"orbit","limit":2}');
  assert.equal(state.calls, 1);
});

test("mcp adapter: an unknown tool is a missing-tool error", async () => {
  const adapter = makeAdapter([{ name: "search" }]);
  await adapter.setup(CTX);
  await assert.rejects(adapter.invoke("nope", [{}], CTX), PaeToolMissingError);
});

test("mcp adapter: invoking before the handshake fails loudly", async () => {
  const adapter = makeAdapter([{ name: "search" }], { calls: 0 }, {
    tools: [{ name: "search" }]
  });
  assert.equal(adapter.describe().length, 1, "a declared surface exists before connecting");
  await assert.rejects(adapter.invoke("search", [{}], CTX), PaeRemoteError);
});

test("mcp adapter: a non-object argument is rejected rather than silently wrapped", async () => {
  const adapter = makeAdapter([{ name: "search" }]);
  await adapter.setup(CTX);
  await assert.rejects(adapter.invoke("search", ["orbit"], CTX), PaeAdapterRejectError);
  await assert.rejects(adapter.invoke("search", [[1, 2]], CTX), PaeAdapterRejectError);
});

test("mcp adapter: a peer-reported tool failure becomes a remote error", async () => {
  const adapter = new McpPaeAdapter({
    adapterId: "mcp-fail",
    sourceEdition: "1.0.0",
    transport: new InMemoryMcpTransport((method) => {
      if (method === "initialize") {
        return { protocolVersion: MCP_PROTOCOL_VERSION, serverInfo: { name: "f", version: "1" } };
      }
      if (method === "tools/list") return { tools: [{ name: "boom" }] };
      return { isError: true, content: [{ type: "text", text: "peer exploded" }] };
    })
  });
  await adapter.setup(CTX);
  await assert.rejects(adapter.invoke("boom", [{}], CTX), (err: unknown) => {
    assert.ok(err instanceof PaeRemoteError);
    assert.match(err.message, /peer exploded/);
    return true;
  });
});

test("mcp adapter: a name prefix keeps two servers from colliding", async () => {
  const adapter = makeAdapter([{ name: "search" }], { calls: 0 }, { toolNamePrefix: "fs_" });
  await adapter.setup(CTX);
  assert.deepEqual(
    adapter.describe().map((t) => t.name),
    ["fs_search"]
  );
  assert.equal(await adapter.invoke("fs_search", [{}], CTX), "search:{}");
});

test("mcp adapter: teardown releases the transport and resets the surface", async () => {
  const state = { calls: 0 };
  const transport = new InMemoryMcpTransport(fakePeer([{ name: "search" }], state));
  const adapter = new McpPaeAdapter({
    adapterId: "mcp-tools",
    sourceEdition: "1.0.0",
    transport,
    tools: [{ name: "search" }]
  });
  await adapter.setup(CTX);
  assert.equal(adapter.describe().length, 1);
  await adapter.teardown();
  assert.equal(transport.closed, true);
  assert.equal(adapter.isConnected, false);
  await assert.rejects(adapter.invoke("search", [{}], CTX), PaeRemoteError);
});

// ---------------------------------------------------------------------------
// Host integration
// ---------------------------------------------------------------------------

test("mcp host: a discovered surface is registered and governed like a native tool", async () => {
  const host = new OrbitRuntimeHost();
  await host.bootHost();
  const state = { calls: 0 };
  const adapter = makeAdapter([{ name: "mcpSearch" }], state);
  const pact = await host.connectPaeToolAdapter(adapter);

  assert.equal(pact.id, "mcp-tools");
  assert.ok(pact.allowCapabilities.includes("channel:read"));
  assert.ok(pact.declareChannelDeps?.includes(ChannelKind.PAE_TOOL));

  const journal = host.beginRecording();
  const out = await host.capabilityInvoke({
    kind: ChannelKind.PAE_TOOL,
    pluginId: "mcp-tools",
    funcName: "mcpSearch",
    args: [{ q: "orbit" }],
    mode: "record"
  });
  assert.equal(out, 'mcpSearch:{"q":"orbit"}');
  assert.equal(state.calls, 1);

  const rec = journal.get(0)!;
  assert.equal(rec.channelKind, ChannelKind.PAE_TOOL);
  assert.equal(rec.decision!.route, "pae");
  assert.ok(rec.runFingerprint!.paeAdaptersHash, "the discovered surface is fingerprinted");
  await host.shutdownHost();
});

test("mcp host: releasing an adapter closes the peer it owns", async () => {
  const host = new OrbitRuntimeHost();
  await host.bootHost();
  const transport = new InMemoryMcpTransport(fakePeer([{ name: "mcpPing" }]));
  const adapter = new McpPaeAdapter({
    adapterId: "mcp-tools",
    sourceEdition: "1.0.0",
    transport
  });
  await host.connectPaeToolAdapter(adapter);
  assert.equal(transport.closed, false);

  await host.releasePaeToolAdapter("mcp-tools");
  assert.equal(transport.closed, true, "an adapter's OS process must not outlive its registration");
  await host.shutdownHost();
});

test("mcp host: a changed adaptation surface replays as configuration drift", async () => {
  const host = new OrbitRuntimeHost();
  await host.bootHost();
  host.registerPlugin({
    id: "reader",
    displayName: "Reader",
    edition: "1.0.0",
    requireHostMinEdition: "0.2.0",
    allowCapabilities: ["channel:read"]
  });
  await host.connectPaeToolAdapter(makeAdapter([{ name: "mcpSearch" }]));

  const journal = host.beginRecording();
  await host.capabilityInvoke({
    kind: ChannelKind.PAE_TOOL,
    pluginId: "mcp-tools",
    funcName: "mcpSearch",
    args: [{ q: "x" }],
    mode: "record"
  });

  await host.releasePaeToolAdapter("mcp-tools");
  await host.connectPaeToolAdapter(makeAdapter([{ name: "mcpSearch" }, { name: "mcpOther" }]));

  host.attachReplayEngine(journal);
  await assert.rejects(
    host.capabilityInvoke({
      kind: ChannelKind.PAE_TOOL,
      pluginId: "mcp-tools",
      funcName: "mcpSearch",
      args: [{ q: "x" }],
      mode: "replay"
    }),
    (err: unknown) => {
      assert.ok(err instanceof RunFingerprintDriftError);
      assert.equal(err.driftField, "paeAdaptersHash");
      return true;
    }
  );
  await host.shutdownHost();
});

test("mcp host: a remote failure surfaces through the gateway, not as a silent null", async () => {
  const host = new OrbitRuntimeHost();
  await host.bootHost();
  host.registerPlugin({
    id: "reader",
    displayName: "Reader",
    edition: "1.0.0",
    requireHostMinEdition: "0.2.0",
    allowCapabilities: ["channel:read"]
  });
  const adapter = new McpPaeAdapter({
    adapterId: "mcp-boom",
    sourceEdition: "1.0.0",
    transport: new InMemoryMcpTransport((method) => {
      if (method === "initialize") {
        return { protocolVersion: MCP_PROTOCOL_VERSION, serverInfo: { name: "f", version: "1" } };
      }
      if (method === "tools/list") return { tools: [{ name: "mcpBoom" }] };
      return { isError: true, content: [{ type: "text", text: "disk on fire" }] };
    })
  });
  await host.connectPaeToolAdapter(adapter);
  await assert.rejects(
    host.capabilityInvoke({
      kind: ChannelKind.PAE_TOOL,
      pluginId: "mcp-boom",
      funcName: "mcpBoom",
      args: [{}],
      mode: "live"
    }),
    /disk on fire/
  );
  await host.shutdownHost();
});

// ---------------------------------------------------------------------------
// stdio transport (real subprocess)
// ---------------------------------------------------------------------------

test("mcp stdio transport: drives a real child process over newline-delimited JSON", async () => {
  const fixture = [
    'let buf = "";',
    'process.stdin.setEncoding("utf8");',
    'process.stdin.on("data", (c) => {',
    "  buf += c;",
    "  let i;",
    '  while ((i = buf.indexOf("\\n")) !== -1) {',
    "    const line = buf.slice(0, i);",
    "    buf = buf.slice(i + 1);",
    '    if (!line.trim()) continue;',
    "    const m = JSON.parse(line);",
    '    const send = (r) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: r }) + "\\n");',
    '    if (m.method === "initialize") send({ protocolVersion: "2024-11-05", serverInfo: { name: "stdio-fixture", version: "1.0.0" } });',
    '    else if (m.method === "tools/list") send({ tools: [{ name: "ping", description: "ping" }] });',
    '    else if (m.method === "tools/call") send({ content: [{ type: "text", text: "pong" }] });',
    "  }",
    "});"
  ].join("\n");

  const transport = new StdioMcpTransport({
    command: process.execPath,
    args: ["-e", fixture]
  });
  const adapter = new McpPaeAdapter({
    adapterId: "mcp-stdio",
    sourceEdition: "1.0.0",
    transport
  });
  try {
    await adapter.setup({ traceMarkId: "tm-stdio", maxWaitMs: 10_000 });
    assert.deepEqual(
      adapter.describe().map((t) => t.name),
      ["ping"]
    );
    assert.equal(adapter.serverInfo?.name, "stdio-fixture");
    assert.equal(await adapter.invoke("ping", [{}], { traceMarkId: "tm-stdio", maxWaitMs: 10_000 }), "pong");
  } finally {
    await adapter.teardown();
  }
  assert.equal(transport.closed, true);
});

test("mcp stdio transport: a dead peer fails in-flight requests instead of hanging", async () => {
  const transport = new StdioMcpTransport({
    command: process.execPath,
    args: ["-e", "process.exit(3);"]
  });
  await transport.start();
  await new Promise((r) => setTimeout(r, 300));
  await assert.rejects(transport.request("tools/list", {}, 2_000), PaeRemoteError);
  await transport.close();
});

test("mcp stdio transport: a peer that dies on startup says why", async () => {
  /*
   * Regression guard: stderr was originally discarded, so a server that failed
   * during startup reported nothing but its exit code — undiagnosable. The tail
   * is kept for exactly this case.
   */
  const transport = new StdioMcpTransport({
    command: process.execPath,
    args: ["-e", "console.error('boom: fixture exploded'); process.exit(1);"]
  });
  await transport.start();
  await new Promise((r) => setTimeout(r, 400));
  await assert.rejects(
    transport.request("initialize", {}, 2_000),
    (err: unknown) => {
      assert.ok(err instanceof PaeRemoteError);
      assert.match(err.message, /fixture exploded/, "the peer's last words reach the caller");
      return true;
    }
  );
  await transport.close();
});

// ---------------------------------------------------------------------------
// Registry interaction
// ---------------------------------------------------------------------------

test("mcp registry: an empty surface cannot be registered", () => {
  const registry = new PaeAdapterRegistry();
  const adapter: IPaeAdapter = new McpPaeAdapter({
    adapterId: "mcp-empty",
    sourceEdition: "1.0.0",
    transport: new InMemoryMcpTransport(() => ({ tools: [] }))
  });
  assert.throws(() => registry.register(adapter), PaeAdapterRejectError);
});

test("mcp registry: unregistering releases the adapter it held", async () => {
  const registry = new PaeAdapterRegistry();
  const transport = new InMemoryMcpTransport(fakePeer([{ name: "mcpSearch" }]));
  const adapter = new McpPaeAdapter({
    adapterId: "mcp-tools",
    sourceEdition: "1.0.0",
    transport,
    tools: [{ name: "mcpSearch" }]
  });
  registry.register(adapter);
  assert.equal(registry.lookup("mcpSearch") !== undefined, true);

  registry.unregister("mcp-tools");
  assert.equal(registry.lookup("mcpSearch"), undefined);
  await registry.drainReleases();
  assert.equal(transport.closed, true, "releases are awaited, not dropped");
});
