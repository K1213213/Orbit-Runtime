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
- **Provable isolation (M3)** — plugin/channel/sandbox dependencies as a graph; failure impact = reverse reachability closure, with an isolation theorem
- **Cost-aware routing (M4)** — channels declare cost/latency/quality; agents run under per-cycle budgets
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

## Getting started

```bash
npm install        # installs typescript + @types/node (dev only)
npm run build      # strict TypeScript compile → dist/
npm test           # build + run unit tests (node:test)
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
| M6 | **Open-source launch** — `orbit` CLI (`record`/`replay`/`diff`), docs site, first public release | Planned |

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
