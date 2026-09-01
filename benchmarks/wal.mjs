/**
 * Benchmark — durable journal (WAL) write throughput.
 *
 * Measures append → flush for a persisted record journal: the in-memory append
 * plus the fire-and-forget mirror through the serialised write chain. This is
 * the sustained audit-write budget a host can rely on before WAL pressure
 * becomes the bottleneck.
 *
 * Run: node benchmarks/wal.mjs
 */
import * as os from "node:os";
import * as path from "node:path";
import { promises as fs } from "node:fs";
import { PersistedRecordJournal, ChannelKind, digestInputs } from "../dist/src/index.js";

const N = Number(process.env.N || 50_000);

async function main() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-bench-wal-"));
  const file = path.join(dir, "bench.wal.jsonl");

  const journal = new PersistedRecordJournal(file);
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i += 1) {
    journal.append({
      channelKind: ChannelKind.MEM_KV_STORE,
      funcName: "readEntry",
      inputDigest: digestInputs(`k${i}`),
      outputSnapshot: `v${i}`,
      durationMs: 0
    });
  }
  await journal.flush();
  const t1 = process.hrtime.bigint();
  const ns = Number(t1 - t0);

  const bytes = (await fs.stat(file)).size;
  console.log("=== durable journal (WAL) append + flush ===");
  console.log(`appends     : ${N}`);
  console.log(`on disk     : ${(bytes / 1024).toFixed(0)} KiB`);
  console.log(`throughput  : ${Math.round((N / ns) * 1e9)} appends/s`);
  console.log(`per append  : ${(ns / N / 1000).toFixed(1)} µs`);

  await fs.rm(dir, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
