/**
 * Benchmark runner — every suite, one summary table.
 *
 * Run: node benchmarks/run-all.mjs        (or: npm run benchmark)
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as path from "node:path";

const REPO = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const SUITES = ["gateway", "replay", "wal", "pae"];

console.log("Orbit Agent Runtime · benchmarks\n");
for (const suite of SUITES) {
  const file = path.join(REPO, "benchmarks", `${suite}.mjs`);
  const res = spawnSync(process.execPath, [file], { cwd: REPO, encoding: "utf8" });
  if (res.status !== 0) {
    console.error(res.stderr || res.stdout);
    process.exit(res.status ?? 1);
  }
  console.log(res.stdout.trim());
  console.log("");
}
console.log("done");
