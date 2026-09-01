# Benchmarks

Performance observability for the kernel's hot paths, against the budgets in
[docs/VISION.md](../docs/VISION.md) (gateway overhead ≤5% of a channel call,
PAE L2 ≤15% overhead over native).

```bash
npm run benchmark        # every suite, one table
node benchmarks/gateway.mjs   # one suite at a time
```

| Suite | What it measures | Sample numbers (2026-09, Windows, Node 22) |
|---|---|---|
| `gateway.mjs` | One governed `capabilityInvoke` end to end (pact / trip / rate-limit / budget / decision / dispatch / journal), record mode | ~82k calls/s, ~12 µs/call |
| `replay.mjs` | Replay fast path — frozen outputs served straight from the journal | ~261k calls/s, ~3.8 µs/call |
| `wal.mjs` | Durable journal append → flush (in-memory append + serialised WAL mirror) | ~1.5k appends/s, ~685 µs each |
| `pae.mjs` | Adapter latency, L0 (in-process JS) vs L2 (stdio child process) | L0 ~38 µs, L2 ~176 µs, 4.6× cross-process factor |

Set `N` to scale a run: `N=100000 node benchmarks/gateway.mjs`.

Numbers are indicative, not a contract: they depend on the machine, the disk
and the channel workload. The suites are smoke-gated in CI (they must run to
completion); the budget assertions are deliberately loose so a slow shared
runner does not fail the build.
