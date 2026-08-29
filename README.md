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
- **Zero runtime dependencies** — pure TypeScript, strict mode, runs on Node.js ≥ 20

## Architecture

```
types (domain contracts)
   ↓
utils (version parsing / ID generation)
   ↓
core (domain errors)
   ↓
channel (capability channel layer)   pact (plugin pact layer)
safeguard (trip protection layer)    trace (trace journal layer)
   ↓
sandbox (agent sandbox layer)
   ↓
runtime_host (top-level host)
```

📐 Detailed diagrams & design rationale: [docs/architecture.md](./docs/architecture.md) · [architecture.svg](./docs/architecture.svg)

📜 Architecture charter (three axioms · governance profiles · kernel admission gate): [docs/VISION.md](./docs/VISION.md)
🗓 Dev plan (three release waves: open-source launch → gateway determinism boundary → ecosystem): [docs/DEV_PLAN.md](./docs/DEV_PLAN.md)
🛠 Upgrade plan & blocker resolutions: [docs/UPGRADE_PLAN.md](./docs/UPGRADE_PLAN.md)
📈 Product plan: [docs/PRODUCT_PLAN.md](./docs/PRODUCT_PLAN.md)

## Web console

[Orbit Console](./web/README.md) — a zero-dependency management console that
drives a real kernel instance over HTTP: lifecycle, channels, plugins,
sandboxes, trace, replay studio, impact graph and cost routing.

```bash
npm run build
node web/bridge-server.mjs        # http://127.0.0.1:8899
```

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
npm test           # build + run unit tests (node:test) — 120+ cases
npm run demo       # build + run demo-host.ts (full lifecycle demo)
npm run demo:replay  # deterministic replay: ~1s real run replayed in ~2ms
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

## Repository layout

```
src/
├── types/        # global domain contracts, enums, interfaces
├── utils/        # version parsing, ID generation
├── core/         # domain errors, runtime host (top-level assembly)
├── channel/      # capability channel abstraction + built-in providers
├── pact/         # plugin pact verification & registration
├── safeguard/    # trip protection, per-plugin fault isolation
├── trace/        # trace journal (records, snapshots, filters)
└── sandbox/      # agent sandbox + sandbox pool
demo-host.ts      # startup demonstration entry
test/             # unit tests (node:test)
```

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
