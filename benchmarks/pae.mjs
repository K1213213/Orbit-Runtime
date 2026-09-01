/**
 * Benchmark — PAE adapter latency: L0 (in-process JS) vs L2 (stdio child).
 *
 * The same tool shape served two ways: in-process (L0, JsPaeAdapter) and as a
 * real child process (L2, MCP over stdio). The delta is the cross-process
 * round trip. VISION's budget is ≤15% overhead for an L2 adapter call against
 * the native channel path; the mock channel is trivial, so the absolute
 * numbers are the interesting part, not the ratio to native.
 *
 * Run: node benchmarks/pae.mjs
 */
import { fileURLToPath } from "node:url";
import { OrbitRuntimeHost, ChannelKind } from "../dist/src/index.js";
import { JsPaeAdapter, McpPaeAdapter, StdioMcpTransport } from "../dist/src/index.js";
import { makeUniqueMark } from "../dist/src/index.js";

const PEER = fileURLToPath(new URL("../web/test/fixtures/mcp-stdio-server.mjs", import.meta.url));
const N = Number(process.env.N || 2_000);

async function time(label, fn) {
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i += 1) await fn(i);
  const t1 = process.hrtime.bigint();
  const us = Number(t1 - t0) / N / 1000;
  console.log(`${label.padEnd(28)} ${us.toFixed(1).padStart(9)} µs/call  ${Math.round((N / Number(t1 - t0)) * 1e9)} calls/s`);
  return us;
}

async function main() {
  const host = new OrbitRuntimeHost();
  await host.bootHost();

  // L0 — in-process JS adapter.
  const jsAdapter = new JsPaeAdapter({
    adapterId: "bench.js",
    sourceEdition: "1.0.0",
    isolation: "L0",
    tools: [
      {
        name: "echo",
        capability: "channel:read",
        determinism: "deterministic",
        fidelity: "full",
        description: "echo the input",
        handler: (_ctx, x) => x
      }
    ]
  });
  const jsPact = host.registerPaeToolAdapter(jsAdapter);
  const jsCtx = { traceMarkId: makeUniqueMark(), pluginUnitId: jsPact.id, maxWaitMs: 5000 };
  const jsInvoke = (i) =>
    host.capabilityInvoke({
      kind: ChannelKind.PAE_TOOL,
      pluginId: jsPact.id,
      funcName: "echo",
      args: [`v${i}`],
      mode: "live",
      ctx: jsCtx
    });

  // L2 — real MCP child process.
  const mcpAdapter = new McpPaeAdapter({
    adapterId: "bench.mcp",
    sourceEdition: "0.1.0",
    transport: new StdioMcpTransport({ command: process.execPath, args: [PEER] })
  });
  const mcpPact = await host.connectPaeToolAdapter(mcpAdapter, { maxWaitMs: 10_000 });
  const mcpCtx = { traceMarkId: makeUniqueMark(), pluginUnitId: mcpPact.id, maxWaitMs: 10_000 };
  const mcpInvoke = (i) =>
    host.capabilityInvoke({
      kind: ChannelKind.PAE_TOOL,
      pluginId: mcpPact.id,
      funcName: "greet",
      args: [{ name: `v${i}` }],
      mode: "live",
      ctx: mcpCtx
    });

  console.log("=== PAE adapter latency (per governed call) ===");
  const l0 = await time("L0 JS (in-process)", jsInvoke);
  const l2 = await time("L2 MCP (stdio child)", mcpInvoke);
  console.log(`\nL2 / L0 cross-process factor: ${(l2 / l0).toFixed(1)}×`);

  await host.shutdownHost();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
