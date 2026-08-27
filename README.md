# Orbit Agent Runtime

> **Deterministic · Provable · Governable**
> A plugin-based agent runtime kernel with hot plugin registration, provable fault isolation, full-chain traceability and sandboxed execution.

Orbit Agent Runtime is a lightweight, dependency-free runtime host for plugin-based AI agents. All external capabilities (model access, storage, IO) are abstracted into **capability channels**; agents never call capabilities directly — everything goes through the channel hub. The kernel is layered with strict one-way dependencies, and every component is private with read-only copies exposed.

## Highlights

- **Channel-first decoupling** — all capabilities (memory KV, LLM) are channels; plugins can override or extend them at runtime
- **Plugin pact validation** — mandatory field completeness, host-edition compatibility, capability declarations
- **Trip protection** — per-plugin fault state machine (NORMAL → TRIPPED → PROBE), a plugin failure never takes down the host
- **Trace journal** — full-chain records with snapshot & replay for audit and debugging
- **Sandbox pool** — per-agent sandbox with cycle limits (anti-infinite-loop) and per-round trace IDs
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

## Getting started

```bash
npm install        # installs typescript + @types/node (dev only)
npm run build      # strict TypeScript compile → dist/
npm test           # build + run unit tests (node:test)
npm run demo       # build + run demo-host.ts (full lifecycle demo)
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

| Milestone | Content |
|---|---|
| M1 ✅ | Engineering skeleton: tsconfig, package, tests, demo entry, capability gate closed-loop |
| M2 | **Deterministic replay** — record non-determinism (model responses, seeds, clock), replay with zero model calls, reconcile via digest chain (DSH does not have this) |
| M3 | **Impact domain graph kernel** — fault isolation as reachability closure on a dependency graph, with an isolation theorem |
| M4 | **Cost-aware routing** — channels declare cost/latency/quality, agents run under budget constraints |
| M5 | Publication: docs, benchmarks, community |

## Design stance vs. existing frameworks

- **DeepSeek Harness** pursues "everything is a plugin" on a 50+-package monorepo. Orbit keeps a **fixed kernel + channel-level plugins** model — fewer degrees of freedom, but each of the six mechanisms can be fully explained and independently verified.
- **Circuit breaker libraries** (opossum/cockatiel) protect a single call site statistically. Orbit isolates at **plugin granularity** and binds every state transition to the trace journal.
- **MCP** standardizes tool discovery; Orbit's channel hub is a lighter, in-process equivalent with timeout, fallback and capability gating.

## License

[MIT](./LICENSE)
