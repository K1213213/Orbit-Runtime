/**
 * Benchmark — replay throughput.
 *
 * The replay fast path serves frozen outputs straight from the journal: no
 * providers, no credentials, no tools. Measures how many replay calls a single
 * process can serve per second, which is the realistic ceiling for
 * reconciliation-driven verification pipelines.
 *
 * Run: node benchmarks/replay.mjs
 */
import { OrbitRuntimeHost, ChannelKind } from "../dist/src/index.js";
import { ReplayEngine, RecordJournal, digestInputs } from "../dist/src/index.js";
import { makeUniqueMark } from "../dist/src/index.js";

const N = Number(process.env.N || 100_000);

function seedJournal(count) {
  const journal = new RecordJournal();
  for (let i = 0; i < count; i += 1) {
    journal.append({
      channelKind: ChannelKind.MEM_KV_STORE,
      funcName: "readEntry",
      inputDigest: digestInputs(`k${i}`),
      outputSnapshot: `v${i}`,
      durationMs: 0
    });
  }
  return journal;
}

async function main() {
  const journal = seedJournal(N);
  const engine = new ReplayEngine(journal);

  const t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i += 1) {
    engine.replayCall(ChannelKind.MEM_KV_STORE, "readEntry", digestInputs(`k${i}`), i);
  }
  const t1 = process.hrtime.bigint();
  const ns = Number(t1 - t0);

  console.log("=== replay fast path ===");
  console.log(`calls       : ${N}`);
  console.log(`throughput  : ${Math.round((N / ns) * 1e9)} calls/s`);
  console.log(`per call    : ${(ns / N / 1000).toFixed(2)} µs`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
