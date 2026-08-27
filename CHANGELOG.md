# Changelog

All notable changes to Orbit Agent Runtime are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/), versions
follow [SemVer](https://semver.org/).

## [0.1.0] - 2026-08-27

First open-source release. The kernel implements all six first-generation
mechanisms plus the three differentiation pillars (deterministic replay,
provable isolation, governed routing).

### Added

- **Kernel (M1)**
  - Layered kernel with strict one-way dependencies: `types → utils → core →
    channel/pact/safeguard/trace → sandbox → runtime_host`
  - Capability channels (`ChannelHub`): built-in + plugin channels, plugin
    precedence, timeout truncation, fallback, call-context pool
  - Built-in channels: in-memory KV with TTL (`MemoryKvChannel`), mock LLM
    with configurable latency (`LlmMockChannel`)
  - Plugin pact validation (`PluginPactVerifier`): mandatory fields, host
    edition compatibility, capability declarations
  - Trip protection (`TripProtector` / `PluginSandboxGuard`): per-plugin
    three-state fault machine (NORMAL → TRIPPED → PROBE), failures journaled
  - Trace journal (`TraceJournal`): append-only records, snapshot/restore,
    filters by trace mark and agent box
  - Agent sandbox (`AgentSandbox` / `SandboxPool`): cycle budget, per-round
    trace id, channel-mediated model calls
  - Capability gate: plugin-originated channel calls checked against declared
    capabilities (injected function keeps layering strict)
  - Public entry (`src/index.ts`), facade host API (`registerPlugin`,
    `spawnAgentBox`, `bootHost`, `shutdownHost`)
- **M2 — Deterministic replay**
  - Determinism contract (`ChannelRuntimeMeta`, `DeterminismLevel`)
  - Injectable PRNG / clock (`SeededRng` mulberry32, `FixedClock`) and the
    "no direct `Math.random` / `Date.now`" channel convention
  - `RecordJournal` (append-only call records, order-indexed) and
    `ReplayEngine` (frozen-output injection, `ReplayDriftError`, bank-style
    `reconcile` with digest-chain verification)
  - Host recording windows (`beginRecording`) and replay attachment
    (`attachReplayEngine`); sandbox `replayMode` drives record/replay
  - Demo: 3 cycles recorded with real latency (~978 ms) then replayed in
    2 ms with zero model calls, byte-identical, `REPLAY VERIFIED`
- **M3 — Impact domain graph**
  - `ImpactDomainGraph`: dependency edges, failure impact = reverse
    reachability closure, isolation theorem (`areIndependent`)
  - Capability-closure static verification: declared channel deps must be
    covered by declared capabilities
  - Per-plugin trip thresholds derived from dependency breadth
    (wider dependency → stricter protection)
- **M4 — Cost-aware routing**
  - `CostRouter` with channel cost/latency/quality profiles; cheapest
    fitting channel selection under budget + latency constraints
  - Per-cycle sandbox budget with `BudgetExhaustedError`
- **Engineering**
  - Zero runtime dependencies; dev deps only `typescript` + `@types/node`
  - `node:test` suite (29 tests), demos (`demo-host`, `demo-replay`)
  - Bilingual README (`README.md`, `README.zh-CN.md`), architecture diagram
    and design doc (`docs/`), Apache-2.0 license

### Changed

- Unified domain-error hierarchy; cycle-limit and duplicate-sandbox now throw
  typed errors instead of returning magic strings
- Normalized naming (no `*Copy` suffixes), ASCII-only encoding, magic numbers
  extracted to named constants

## [Unreleased]

- M5: benchmarks, plugin examples, CI pipeline, publishing
