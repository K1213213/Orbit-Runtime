# Orbit Agent Runtime

> **Deterministic · Provable · Governable**
> A plugin-based agent runtime kernel with hot plugin registration, provable fault isolation, full-chain traceability and sandboxed execution.

**English** · [简体中文](./README.zh-CN.md)

**Project status:** `pre-alpha` · **License:** Apache-2.0 · **Track:** open-source product (see [roadmap](#roadmap))

> Orbit is developed as an **open-source product**, not a lab experiment. The kernel is
> production-track engineering: strict TypeScript, zero runtime dependencies, every
> mechanism backed by tests and an architecture charter
> ([docs/VISION.md](./docs/VISION.md)). Current phase: kernel mechanisms complete
> (M1–M4) → product hardening (real model adapters, persistence, CLI, npm publish).
> Contributions follow [CONTRIBUTING.md](./CONTRIBUTING.md).

Orbit Agent Runtime is a lightweight, dependency-free runtime host for plugin-based AI agents. All external capabilities (model access, storage, IO) are abstracted into **capability channels**; agents never call capabilities directly — everything goes through the channel hub. The kernel is layered with strict one-way dependencies, and every component is private with read-only copies exposed.

## Highlights

- **Channel-first decoupling** — all capabilities (memory KV, LLM) are channels; plugins can override or extend them at runtime
- **Plugin pact validation** — mandatory field completeness, host-edition compatibility, capability declarations
- **Trip protection** — per-plugin fault state machine (NORMAL → TRIPPED → PROBE), a plugin failure never takes down the host
- **Trace journal** — full-chain records with snapshot & replay for audit and debugging
- **Sandbox pool** — per-agent sandbox with cycle limits (anti-infinite-loop) and per-round trace IDs
- **Deterministic replay (M2)** — record a run, replay it with zero model calls, byte-identical output, bank-style reconciliation (digest-chain verified)
- **`orbit` CLI (M6)** — `record` / `replay` / `diff` over the kernel; reproducibility in three commands, zero extra dependencies
- **Provable isolation (M3)** — plugin/channel/sandbox dependencies as a graph; failure impact = reverse reachability closure, with an isolation theorem
- **Cost-aware routing (M4)** — channels declare cost/latency/quality; agents run under per-cycle budgets
- **Unified gateway (W7)** — `capabilityInvoke` is the determinism boundary: every call's governance decision (trip / pact / budget / rate-limit / route / compression) is recorded and restored on replay, and config drift is reported distinctly from digest drift
- **Token budget + compression (W8)** — `TokenBudgetEngine` is a pure-function (no `Math.random`/`Date.now`) token estimator and deterministic head-trim compressor; budget/route decisions are now computed from the engine and channel registry, and its threshold config is hashed into the run fingerprint for drift detection
- **Payload-aware storage compression (W9)** — large recorded outputs are transparently `deflate`-compressed at rest via `packSnapshot` (zero external deps), while the consumer always receives the original value and replay reproduces it byte-for-byte; the `compression` decision (`level` / `applied` / `bytesSaved`) is recorded for audit
- **Rate limiting + behavior collector (W11)** — `RateLimiter` is a pure-function (no `Math.random`/`Date.now`) call-count budget; the `rateLimited` decision is recorded and replayed verbatim (the limiter is bypassed on replay). `BehaviorCollector` captures a structured `BehaviorNote` in three modes — `record` (persisted on the trace), `live` (proposal, not persisted), `replay` (bypass)
- **Three-way drift classification (W13)** — replay failures are reported as distinct errors: config drift (`RunFingerprintDriftError`, version/fingerprint), decision drift (`DecisionDriftError`, e.g. a revoked pact), and call drift (`ReplayDriftError`, data/signature). Reconciliation also reports `decisionDriftFields`
- **`replay_compat` determinism gate (W12)** — a 27-case CI gate proves the gateway boundary stays faithful under compression / rate-limit / collector / fingerprint-drift / decision-drift / PAE adapters / durable WAL windows: every decision is recorded and replayed byte-identically
- **Plugin Adaptation Engine (W15)** — foreign runtimes (in-process JS, and later MCP / OpenAPI / Cordis) are mapped onto the kernel capability contract through adapters that surface as a single capability channel; every foreign call is a gateway transaction, recorded and replayed byte-identically. Fidelity is negotiated honestly (`full | reduced | lossy`), and the adapter surface is hashed into the run fingerprint for drift detection
- **Isolation domains (W19)** — the impact graph allocates the physical layer: a unit whose failure closure exceeds the threshold gets its own L2 child process (`iso:<unit>`), the rest share deterministic chunks (`shared:<n>`). The sync is a diff, not a rebuild, and domains are published as one capability channel, so a domain call is recorded and replayed byte-identically
- **Cross-domain transactions (W20)** — every hop between domains is an atomic gateway transaction: `decision (assignment / isolation) + execution + result + audit`, settled in a ledger that reconciles by (source → target) pair. Orphans (a hop that crossed a boundary and never settled) and refusals are both detectable from the records alone; replay injects the frozen output without re-entering the domain
- **Durable journals (W27)** — the audit journal and the recording window each mirror to a crash-safe write-ahead log, so a restart does not erase the audit trail or a recorded run. One JSON line per entry means the only artifact a crash can leave is a partial final line: recovery drops exactly that and rejects any invalid *interior* line as a genuine fault. Recovered entries keep their original ids and ordering, so they are byte-identical and a window split across processes replays as one uninterrupted run
- **Audit hash chain (W30)** — an append-only audit log is only as trustworthy as its file permissions; a hash chain makes it tamper-evident. With `new OrbitRuntimeHost({ auditSigningKey })` every audit entry carries HMAC-SHA256 `prevHash`/`chainHash` linkage, `host.verifyAuditChain()` proves integrity, `orbit audit <trace.wal> --key …` verifies from the CLI, and the `strict` tier refuses to boot on a broken chain. Editing any entry breaks the chain at that point and everything after it
- **Four-tier governance (W29)** — VISION's Sandbox / Standard / Strict tiers are switchable configuration, not a design goal: `new OrbitRuntimeHost({ governanceProfile: "strict" })` tunes rate limits, trip thresholds, compression, PAE admission and trace durability in one declaration. `standard` is the kernel's previous numbers verbatim; a non-default tier is hashed into the run fingerprint, so a trace recorded under one tier refuses to replay under another (config drift, not silent divergence)
- **Zero runtime dependencies** — pure TypeScript, strict mode, runs on Node.js ≥ 20

## Architecture

```
@orbit/infra-common      domain contracts · version parsing · domain errors
        ↓
@orbit/core-hub          channel · gateway (capabilityInvoke) · replay · trace
        ↓
@orbit/sandbox-runtime   sandbox · impact graph · isolation domains
@orbit/pae-engine        plugin adaptation engine (JS / MCP / OpenAPI / Cordis)
        ↓
host (src/)              assembly & facade (OrbitRuntimeHost)
```

📐 Detailed diagrams & design rationale: [docs/architecture.md](./docs/architecture.md) · [architecture.svg](./docs/architecture.svg)

📜 Architecture charter (three axioms · governance profiles · kernel admission gate): [docs/VISION.md](./docs/VISION.md)
🗓 Dev plan (three release waves: open-source launch → gateway determinism boundary → ecosystem): [docs/DEV_PLAN.md](./docs/DEV_PLAN.md)
🛠 Upgrade plan & blocker resolutions: [docs/UPGRADE_PLAN.md](./docs/UPGRADE_PLAN.md)
📈 Product plan: [docs/PRODUCT_PLAN.md](./docs/PRODUCT_PLAN.md)

## Plugin Adaptation Engine (W15)

Foreign runtimes — in-process JS today, MCP / OpenAPI / Cordis next — plug into
the kernel through the **Plugin Adaptation Engine (PAE)**. The adaptation layer
is deliberately thin: an adapter owns only the connection to the foreign runtime
and translates its tools into the kernel capability contract. Two rules make the
rest of the kernel unaware that anything foreign is happening:

1. **Adapters never call the kernel directly.** A registered adapter is surfaced
   as one capability channel (`ChannelKind.PAE_TOOL`), so every foreign call goes
   `capabilityInvoke → ChannelHub → registry → adapter` and lands in the
   `RecordJournal`. Foreign tools get the *same* four-way governance check as
   native channels — gating, budgeting, trip protection, replay.
2. **Adapters add no nondeterminism.** Randomness and clocks are injected through
   `PaeInvokeCtx` (`rng` / `clock`); a handler that reaches for `Math.random` /
   `Date.now` breaks replay and is rejected.

Capability negotiation is explicit, not silent: an adapter that cannot map a
foreign tool losslessly must say so via `fidelity` (`full | reduced | lossy`),
and a caller may demand a minimum fidelity. Anything below `full` must carry a
`fidelityNote`. The registry also derives a `configHash` of the whole adapter
surface into the run fingerprint, so a changed tool set reports as
configuration drift rather than as a digest mismatch.

```ts
import { OrbitRuntimeHost, JsPaeAdapter, ChannelKind } from "orbit-agent-runtime";

const host = new OrbitRuntimeHost();
await host.bootHost();

// Adapt a foreign in-process tool set as a kernel capability channel.
const adapter = new JsPaeAdapter({
  adapterId: "echo-tools",
  sourceEdition: "1.0.0",
  tools: [{
    name: "echo",
    capability: "channel:write",
    handler: async (args) => ({ echoed: (args[0] as { text: string }).text })
  }]
});
host.registerPaeToolAdapter(adapter); // foreign surface → derived Pact, gated + recorded

// Inside an agent script, a foreign tool is just another channel call:
//   const out = await ctx.call(ChannelKind.PAE_TOOL, "echo", [{ text: "hi" }]);
```

## Isolation domains & cross-domain transactions (W19–W20)

The physical layer is allocated from the graph, not from a static trust table:

```ts
const host = new OrbitRuntimeHost();
await host.bootHost();

host.registerPlugin({
  id: "p.worker",
  displayName: "p.worker",
  edition: "1.0.0",
  requireHostMinEdition: "0.7.0",
  allowCapabilities: ["channel:read", "channel:write"],
  declareChannelDeps: [ChannelKind.LLM_ACCESS]
});

// Graph → plan: closure > threshold ⇒ own L2 process; the rest share chunks.
// Omit `transportFactory` to use the built-in pure-unit host (node -e shim).
const plan = await host.allocateIsolationDomains({ maxImpactClosure: 1 });
plan.domains; // [{ id: "iso:p.worker", isolation: "L2", units: ["p.worker"] }, ...]

// A hop into a domain is a gateway transaction — recorded, replayed, settled.
const out = await host.invokeDomainUnit("p.worker", "ping", [{ hello: "world" }], {
  pluginUnitId: "p.worker"
});

host.domainLedger();                    // decision → execution → result
host.reconcileDomainTransactions();     // { balanced, pairs, orphans, rejected, totals }
host.runFingerprint();                  // gains `domainPlanHash` once domains exist
```

Three properties worth stating explicitly:

- **No bare randomness, no bare clock.** Coordinates and delays are hardcoded or
  derived from indices; latency is measured through an injected clock, so a
  ledger hashes identically for identical runs.
- **Backward compatible fingerprints.** `domainPlanHash` is *omitted* (not empty)
  while no plan exists, so traces from hosts that never allocate domains keep the
  exact fingerprint they had before the physical layer existed.
- **Replay never re-enters a domain.** The frozen output is injected at the
  gateway, so the child process is not touched and no transaction is opened —
  axiom A1 expressed on the ledger.

## Journal durability (W27)

Journals were in-memory only, so a restart erased the audit trail and any
recorded run. Both now carry a crash-safe write-ahead log — opt-in per path, and
omitting the paths keeps the previous purely in-memory behavior byte for byte.

```ts
const host = new OrbitRuntimeHost({
  traceJournalPath: ".orbit/trace.wal.jsonl",   // audit / behavior journal
  recordJournalPath: ".orbit/record.wal.jsonl", // recording window
  auditRetention: 10_000                        // keep the newest N entries
});

await host.bootHost();      // recover (and heal) first, then wire channels
// ... run the agent; a previous window is resumed, orderIndex continues
await host.shutdownHost();  // drain pending writes, then apply retention
```

Design points worth knowing:

- **The crash model justifies the format.** A write appends one whole line, so
  the only thing a crash can leave behind is a *partial final line*. Recovery is
  therefore a strict dichotomy: drop that trailing line, and reject any corrupt
  or structurally invalid **interior** line as `WalFileInvalidError` with its line
  number — an interior line cannot have been truncated by a crash, so skipping it
  silently would hide real corruption.
- **The in-memory journal stays the source of truth.** The WAL is a
  fire-and-forget mirror, serialised through a write chain so lines never
  interleave; `shutdownHost` awaits it, so a clean shutdown loses nothing.
- **Recovery is byte-identical.** `entryUid`, `occurredAt` and `orderIndex` are
  preserved, so a resumed recording window continues its index instead of
  restarting at 0 — a run split across processes replays as one sequence.
- **A truncated tail is healed before the first append.** Recovery tolerates it,
  but the line is still on disk: once this run appends, it becomes an *interior*
  invalid line, which is a hard fault. Left unhandled, one crash would make every
  later boot fail. `healIfNeeded()` rewrites the file atomically from the
  surviving prefix, and is a no-op on a healthy log.
- **Retention is explicit.** An append-only log that grows without limit
  eventually fills the disk, and a full disk is an outage, so `auditRetention` is
  an operator choice rather than an implicit default. `pruneAuditLog()` prunes a
  long-running host on demand.

## Web console

[Orbit Console](./web/README.md) — a zero-dependency management console that
drives a real kernel instance over HTTP: lifecycle, channels, plugins,
sandboxes, trace, replay studio, impact graph and cost routing.

```bash
npm run build
node web/bridge-server.mjs        # http://127.0.0.1:8899
```

## Examples & benchmarks

**Examples** (`./examples`) are runnable, assertion-gated walkthroughs — each
exits non-zero on any failed check, so they double as CI smoke tests:

```bash
node examples/custom-channel.mjs   # implement a channel → record → replay byte-identically
node examples/js-pae-plugin.mjs    # foreign JS tools through a governed channel (PAE L0)
node examples/mcp-adapter.mjs      # real MCP child process, replayed after the peer is dead (L2)
node examples/cli-record-replay.mjs # the orbit CLI record → replay → diff loop
```

**Benchmarks** (`./benchmarks`, `npm run benchmark`) observe the hot paths
against the budgets in [docs/VISION.md](./docs/VISION.md):

| Suite | What it measures | Sample (Node 22) |
|---|---|---|
| `gateway` | governed `capabilityInvoke` end to end (record mode) | ~82k calls/s (~12 µs) |
| `replay` | journal fast-path injection | ~261k calls/s (~3.8 µs) |
| `wal` | durable append + flush (WAL mirror) | ~1.5k appends/s |
| `pae` | L0 in-process vs L2 stdio-child adapter latency | ~38 µs vs ~176 µs (4.6×) |

## Repository layout (monorepo)

The kernel is organised as npm workspaces with TypeScript Project References, so
each layer builds, versions and tests in isolation while the public API at
`src/index.ts` stays unchanged.

| Package | Path | Responsibility | Depends on |
|---|---|---|---|
| `@orbit/infra-common` | `packages/infra-common` | Domain contracts, pure utils, error types | — |
| `@orbit/core-hub` | `packages/core-hub` | Channel / gateway / replay / trace / pact / safeguard / routing | infra-common |
| `@orbit/sandbox-runtime` | `packages/sandbox-runtime` | Agent sandboxes, impact-domain graph, isolation domains | infra-common, core-hub |
| `@orbit/pae-engine` | `packages/pae-engine` | Plugin Adaptation Engine (JS / MCP / OpenAPI / Cordis) | infra-common, core-hub |
| root host | `src/` (`core/orbitRuntimeHost.ts`, `index.ts`) | Component assembly & facade | all packages |
| `@orbit/admin-console` *(app)* | `web/` | Web admin console — drives a live kernel via the bridge server | root host (`dist/`) |

Build and test from the repo root — `npm install` wires the `@orbit/*` workspace
symlinks, then `tsc -b` builds bottom-up:

```bash
npm install          # dev deps + workspace links
npm run build        # tsc -b across all packages and the root
npm test             # build + kernel unit tests (node:test)
npm run test:console # web console unit tests (node:test)
```

> **Package manager:** the monorepo currently uses **npm workspaces**; the
> roadmap's pnpm migration is deferred (this runtime has no `pnpm`/`corepack`),
> but the package layout is identical and the switch is a drop-in later.

## Getting started — the deterministic-replay loop

The headline feature is *reproducibility*: record a real run, replay it with
**zero** model calls, and prove the two chains are byte-identical. You drive it
with the `orbit` CLI (zero extra dependencies — ships in `bin/`, runs on Node ≥ 20).

```bash
npm install        # dev deps only (typescript + @types/node)
npm run build      # strict TypeScript compile → dist/ (also builds the CLI)

# 1) write a script — it receives a ctx with channel access
cat > agent.mjs <<'EOF'
export default async function (ctx) {
  const reply = await ctx.llm.chat("summarize: the sky is blue");
  const seen  = await ctx.call(ctx.ChannelKind.MEM_KV_STORE, "readEntry", "last");
  return { reply, seen };
}
EOF

# 2) record a live run → captures every channel call into a trace
node bin/orbit.mjs record agent.mjs --out trace.jsonl
#   ✓ recorded 2 channel calls from agent.mjs
#   trace : trace.jsonl      (JSONL, atomic write)
#   meta  : trace.jsonl.meta.json  (driving script + sanitized config)

# 3) replay with ZERO real calls → reconcile the digest chain
node bin/orbit.mjs replay trace.jsonl
#   original calls : 2   replayed calls : 2
#   result         : ✓ VERIFIED — digest chain consistent

# 4) diff two traces — locate the first divergence
node bin/orbit.mjs diff trace.jsonl trace.jsonl
#   result: ✓ identical call chains
```

That is the whole product in four commands: a stranger can be reproducible in
under ten minutes. Every command accepts `--json` for machine-readable output.

### Lower-level API & demos

```bash
npm test               # build + run kernel unit tests (node:test) — 348 cases
npm run test:console   # web console unit tests (node:test) — 89 cases
npm run demo           # build + run demo-host.ts (full lifecycle demo)
npm run demo:replay    # deterministic replay: ~1s real run replayed in ~2ms
```

Expected demo output highlights:

```
[cap] plugin -> LLM channel (channel:read): allowed
[cap] plugin -> KV write (undeclared channel:write): rejected
[sandbox] round 3 rejected (budget spent): agent sandbox box.demo-1 reached cycle limit 2
[guard] plugin crash isolated and journaled (host keeps running)
[trace] 5 entries: AGENT_SINGLE_CYCLE_EXEC / AGENT_CYCLE_LIMIT_HIT / PLUGIN_UNIT_EXCEPTION ...
```

## orbit CLI

Three commands form the deterministic-replay loop. The CLI loads the compiled
kernel via `createRequire` and uses only Node built-ins.

```bash
orbit record <script.js> [--out trace.jsonl] [--config orbit.config.json]
orbit replay <trace.jsonl> [--via script.js] [--config orbit.config.json]
orbit diff <a.jsonl> <b.jsonl>
```

| Command | What it does | Exit code |
|---|---|---|
| `record` | Run `<script>` against a live kernel; capture every channel call into a JSONL trace + a `.meta.json` (driving script, sanitized config, orbit/node versions). | 0 on success |
| `replay` | Re-run the recorded script with **zero** real channel calls; reconcile the replayed chain against the original (bank-style digest check). | 0 verified · 1 drift |
| `diff` | Compare two traces record-by-record; report the first breakpoint (`channelKind` / `funcName` / `inputDigest` / `outputSnapshot`). | 0 identical · 1 divergent |

**Script contract** — default-export an async function receiving `ctx`:

```js
export default async function (ctx) {
  const reply = await ctx.llm.chat("hello");              // sugar over LLM_ACCESS.chatRound
  const prev  = await ctx.call(ctx.ChannelKind.MEM_KV_STORE, "readEntry", "k");
  return { reply, prev };
}
```

**Configuration** — `orbit.config.json` (all keys optional) selects real
capabilities; env vars override for quick experiments:

```json
{
  "llm":   { "kind": "mock" | "openai-compat", "baseUrl": "…", "model": "…" },
  "file":  { "enabled": true, "rootDir": "./agent-workspace" },
  "shell": { "enabled": true, "allowedCommands": ["git","node"], "envAllowlist": ["PATH"] }
}
```

Env overrides: `ORBIT_LLM_BASE_URL` / `ORBIT_LLM_API_KEY` / `ORBIT_LLM_MODEL`,
`ORBIT_FILE_ROOT`, `ORBIT_SHELL_ALLOW` (comma list) / `ORBIT_SHELL_ENV` (comma list).

> A recorded trace replays on a machine that has **none** of the real channels
> installed — the replay fast path serves from the journal and never needs
> providers, credentials or tools. See [docs/guide.md](./docs/guide.md) to
> write your own replayable channel.

## Admin console workspace

The kernel is split into npm workspaces — see
[Repository layout (monorepo)](#repository-layout-monorepo) above for the package
map. The web admin console lives at `web/` as the private `@orbit/admin-console`
app workspace, run with `npm run start:web`.

## Core concepts

| Concept | Role |
|---|---|
| Channel | Unified abstraction of an external capability; plugins can override built-in channels (plugin-first, built-in fallback) |
| Pact | Plugin manifest: id, edition, host min edition, declared capabilities |
| TripProtector | Per-plugin fault state machine: consecutive failures trip, cooldown then probe, single success recovers |
| TraceJournal | Append-only behavior journal with snapshot capture/restore and filters by trace / sandbox |
| AgentSandbox | Per-agent execution sandbox: cycle counter, per-round trace ID, channel-based model calls |
| SandboxPool | Lifecycle management of sandboxes: spawn, pick, drop, release |

## Roadmap

| Milestone | Content | Status |
|---|---|---|
| M1 | Engineering skeleton: tsconfig, package, tests, demo entry, capability gate closed-loop | ✅ Done |
| M2 | **Deterministic replay** — record non-determinism, replay with zero model calls, digest-chain reconciliation | ✅ Done |
| M3 | **Impact domain graph** — fault isolation as reverse reachability closure with an isolation theorem, static capability-closure verification | ✅ Done |
| M4 | **Cost-aware routing** — channel cost/latency/quality profiles, per-cycle sandbox budgets | ✅ Done |
| M5 | Product hardening: benchmarks, plugin examples, CI, npm publish | In progress |
| M6 | **Open-source launch** — `orbit` CLI (`record`/`replay`/`diff`), docs site, first public release | In progress (CLI shipped) |

> M5/M6 track the `P0` milestones in [docs/PRODUCT_PLAN.md](./docs/PRODUCT_PLAN.md)
> (P0.1 real capabilities → P0.2 CLI release → P0.3 open-source launch).

## Design stance vs. existing frameworks

- **DeepSeek Harness** pursues "everything is a plugin" on a 50+-package monorepo. Orbit keeps a **fixed kernel + channel-level plugins** model — fewer degrees of freedom, but each of the six mechanisms can be fully explained and independently verified.
- **Circuit breaker libraries** (opossum/cockatiel) protect a single call site statistically. Orbit isolates at **plugin granularity** and binds every state transition to the trace journal.
- **MCP** standardizes tool discovery; Orbit's channel hub is a lighter, in-process equivalent with timeout, fallback and capability gating.

## License

[Apache License 2.0](./LICENSE)

## Connect a real model (DeepSeek)

The built-in LLM channel is a mock for tests; swap in the real DeepSeek
provider (OpenAI-compatible, zero extra deps) at runtime — plugin channels
take precedence over built-ins:

```ts
import { OrbitRuntimeHost, DeepSeekChannel, ChannelKind } from "orbit-agent-runtime";

const host = new OrbitRuntimeHost();
await host.bootHost();
host.channelHub.registerPluginExtChannel(
  ChannelKind.LLM_ACCESS,
  new DeepSeekChannel({ apiKey: process.env.DEEPSEEK_API_KEY, model: "deepseek-chat" })
);
```

Deterministic replay works unchanged: record a live run, then replay with
zero API calls and byte-identical output.

```bash
DEEPSEEK_API_KEY=sk-xxx npm run demo:deepseek
```

### Any OpenAI-compatible model

`OpenAICompatChannel` works against **any** OpenAI-compatible endpoint —
just point `baseUrl` at it:

```ts
import { OpenAICompatChannel } from "orbit-agent-runtime";

// DeepSeek / OpenAI / Qwen / Kimi / GLM / Ollama / vLLM ...
host.channelHub.registerPluginExtChannel(ChannelKind.LLM_ACCESS, new OpenAICompatChannel({
  apiKey: process.env.LLM_API_KEY,
  baseUrl: "https://dashscope.aliyuncs.com/compatible-mode", // example: Qwen
  model: "qwen-plus"
}));
```

Non-OpenAI protocols (Anthropic Claude, Google Gemini) each need a small
`IChannelProvider` adapter (~20 lines); record/replay/isolation/routing are
protocol-agnostic.

Production hardening is built in: faults are classified
(`LlmChannelFaultError` — timeout / network / rate_limited / server_error /
auth / bad_request / not_found / no_content / invalid_response), retryable
faults are retried with a **deterministic** exponential backoff (no
`Math.random`, `Retry-After` honored), and internal retries never leak into
the record journal.

### Real tool channels (File / Shell)

```ts
import { FileChannel, ShellChannel } from "orbit-agent-runtime";

// Filesystem access jailed to a root directory (path escapes are rejected).
host.channelHub.registerPluginExtChannel(ChannelKind.FILE_SYSTEM, new FileChannel({
  rootDir: "./agent-workspace"
}));

// Command execution behind an exact-match whitelist; argv arrays only
// (no shell string → no injection surface), empty child env by default,
// hard timeout and output caps.
host.channelHub.registerPluginExtChannel(ChannelKind.SHELL_EXEC, new ShellChannel({
  allowedCommands: ["git", "node", process.execPath],
  workDir: "./agent-workspace",
  envAllowlist: ["PATH"]
}));
```

Both are `IO_BOUND` channels: record a run, then replay it with zero disk
access and zero process spawns. The capability gate maps
read/list/stat → `channel:read` and write/append/remove/mkdir/exec →
`channel:write`.

### Trace persistence (JSONL)

```ts
import { saveRecordJournal, loadRecordJournal } from "orbit-agent-runtime";

await saveRecordJournal(journal, "trace.jsonl");   // atomic write (tmp + rename)
const restored = await loadRecordJournal("trace.jsonl"); // validated load
```

Replay works on a fresh host **without the real channels installed** — the
replay fast path serves from the journal and never requires providers,
credentials or tools on the replaying machine.
