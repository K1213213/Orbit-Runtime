/**
 * Benchmark — gateway call latency & throughput.
 *
 * Measures the cost of one governed `capabilityInvoke` end to end (pact check,
 * trip check, rate limiter, token budget, routing decision, channel dispatch,
 * journal append). The reference for VISION's performance budget is a gateway
 * overhead of ≤5% of the channel call itself; the mock channel is
 * deliberately trivial, so what this measures is close to the raw boundary
 * cost.
 *
 * Run: node benchmarks/gateway.mjs
 */
import { OrbitRuntimeHost, ChannelKind } from "../dist/src/index.js";
import { makeUniqueMark } from "../dist/src/index.js";

const N = Number(process.env.N || 20_000);
const warmup = Math.floor(N / 10);

async function main() {
  const host = new OrbitRuntimeHost();
  await host.bootHost();
  host.registerPlugin({
    id: "bench.gateway",
    displayName: "Gateway Benchmark",
    edition: "1.0.0",
    requireHostMinEdition: "1.0.0",
    allowCapabilities: ["channel:read"]
  });
  host.beginRecording(); // journal append included in every measured call

  const ctx = { traceMarkId: makeUniqueMark(), pluginUnitId: "bench.gateway", maxWaitMs: 5000 };
  const invoke = () =>
    host.capabilityInvoke({
      kind: ChannelKind.MEM_KV_STORE,
      pluginId: "bench.gateway",
      funcName: "readEntry",
      args: ["bench-key"],
      mode: "record",
      ctx
    });

  for (let i = 0; i < warmup; i += 1) await invoke();

  const t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i += 1) await invoke();
  const t1 = process.hrtime.bigint();
  const ns = Number(t1 - t0);
  const perCallUs = ns / N / 1000;

  console.log("=== gateway capabilityInvoke (record mode) ===");
  console.log(`calls       : ${N}`);
  console.log(`total       : ${(ns / 1e6).toFixed(1)} ms`);
  console.log(`throughput  : ${Math.round((N / ns) * 1e9)} calls/s`);
  console.log(`p50-ish     : ${perCallUs.toFixed(1)} µs/call (mean)`);

  await host.shutdownHost();
  // A threshold keeps the budget honest on this machine; loosen it for CI-only
  // boxes, tighten it on a clean runner.
  if (perCallUs > 2000) {
    console.error(`WARN: gateway call above 2000µs (${perCallUs.toFixed(0)}µs) — investigate`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
