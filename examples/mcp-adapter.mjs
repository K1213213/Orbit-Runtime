/**
 * Example 3 — an MCP adapter (PAE, L2, out-of-process).
 *
 * A real MCP server child process is spawned over stdio, passed through the
 * `initialize` handshake and `tools/list` discovery, and only then registered —
 * the console never advertises a tool the peer did not announce. Every call is
 * an IO_BOUND gateway transaction: recorded and replayed byte-identically even
 * after the peer is gone (replay injects the frozen output and never re-enters
 * the child).
 *
 * The peer is a tiny MCP server bundled with the repo:
 *   web/test/fixtures/mcp-stdio-server.mjs   (tools: greet, total)
 *
 * Run: node examples/mcp-adapter.mjs
 */
import { fileURLToPath } from "node:url";
import { OrbitRuntimeHost, ChannelKind } from "../dist/src/index.js";
import { McpPaeAdapter, StdioMcpTransport, ReplayEngine } from "../dist/src/index.js";
import { makeUniqueMark } from "../dist/src/index.js";

const PEER = fileURLToPath(new URL("../web/test/fixtures/mcp-stdio-server.mjs", import.meta.url));

async function main() {
  console.log("=== example 3 · MCP adapter (PAE L2) ===");
  console.log(`[peer]  spawning ${PEER}`);

  const host = new OrbitRuntimeHost();
  await host.bootHost();

  const transport = new StdioMcpTransport({ command: process.execPath, args: [PEER] });
  const adapter = new McpPaeAdapter({
    adapterId: "example.mcp",
    sourceEdition: "0.1.0",
    transport
  });

  // connect = handshake first, then register the *discovered* surface.
  const pact = await host.connectPaeToolAdapter(adapter, { maxWaitMs: 10_000 });
  const tools = adapter.describe().map((t) => t.name);
  console.log(`[adapter] connected; discovered tools: ${tools.join(", ")}`);
  if (!tools.includes("greet") || !tools.includes("total")) {
    console.error("FAIL: expected tools greet + total from the peer");
    process.exit(1);
  }

  const ctx = { traceMarkId: makeUniqueMark(), pluginUnitId: pact.id, maxWaitMs: 10_000 };

  // Live call: real child process, real JSON-RPC round trip.
  const live = await host.capabilityInvoke({
    kind: ChannelKind.PAE_TOOL,
    pluginId: pact.id,
    funcName: "greet",
    args: [{ name: "Orbit" }],
    mode: "live",
    ctx
  });
  console.log(`[live]   greet({name:"Orbit"}) -> ${JSON.stringify(live)}`);

  // Record a call, then kill the peer: replay must still reproduce verbatim,
  // because the frozen output is injected — the child is never re-entered.
  const recordJournal = host.beginRecording();
  await host.capabilityInvoke({
    kind: ChannelKind.PAE_TOOL,
    pluginId: pact.id,
    funcName: "total",
    args: [{ values: [1, 2, 3] }],
    mode: "record",
    ctx
  });
  const recorded = recordJournal.get(0).outputSnapshot;
  console.log(`[record] total([1,2,3]) journaled -> ${JSON.stringify(recorded)}`);

  // Kill the peer process but keep the registration: the surface stays part of
  // the fingerprint, so the trace still replays — with the frozen output
  // injected, the dead child is never re-entered.
  await adapter.teardown();
  console.log("[peer]   child process closed; adapter surface retained");

  host.attachReplayEngine(new ReplayEngine(recordJournal));
  const replayed = await host.capabilityInvoke({
    kind: ChannelKind.PAE_TOOL,
    pluginId: pact.id,
    funcName: "total",
    args: [{ values: [1, 2, 3] }],
    mode: "replay",
    ctx
  });
  console.log(`[replay] total([1,2,3]) injected -> ${JSON.stringify(replayed)}`);
  if (JSON.stringify(replayed) !== JSON.stringify(recorded)) {
    console.error("FAIL: replay after peer death differs from the recording");
    process.exit(1);
  }

  await host.shutdownHost();
  console.log("[shutdown] clean teardown");
  console.log("OK — MCP tools are governed, recorded and replayable after peer death");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
