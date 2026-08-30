# Changelog

All notable changes to Orbit Agent Runtime are documented here. This project
follows a pre-alpha versioning scheme: `v0.x.minor` marks a release wave,
`patch` marks fixes. Until `v1.0` the public API is not yet stability-promised.

## [0.3.0] — 2026-08-29 · Plugin Adaptation Engine (W15)

First wave of the v0.3.0 ecosystem track: foreign runtimes are mapped onto the
kernel's capability contract through the Plugin Adaptation Engine (PAE), so the
kernel's governance, recording and replay machinery covers them without any
special-casing.

### Added
- **PAE contract layer** (`src/pae/types.ts`) — `PaeFidelity` (`full | reduced |
  lossy`), `PaeAdapterKind` (`js | mcp | openapi | cordis`), `PaeIsolationLevel`
  (`L0 | L1 | L2`), `PaeToolDescriptor`, `PaeAdapterMeta`, `PaeInvokeCtx`,
  `IPaeAdapter`, and the error types `PaeAdapterRejectError` /
  `PaeToolMissingError` / `PaeFidelityRejectError` (all `OrbitDomainError`).
  `FIDELITY_RANK` orders `full ≻ reduced ≻ lossy`.
- **`PaeAdapterRegistry`** (`src/pae/PaeAdapterRegistry.ts`) — registration-time
  static validation (complete meta, unique id, semver `sourceEdition`, ≥1 tool,
  name-pattern + reserved-name checks, globally unique tool names, and
  *documented* downgrades), dynamic `PluginUnitPact` derivation (capability union
  + forced `channel:read` + `declareChannelDeps: [PAE_TOOL]`), fidelity
  negotiation (`negotiate` rejects a tool below the caller's `minFidelity`),
  and `configHash()` — a SHA-256 (first 16 chars, order-independent) of the
  adapter surface that feeds the run fingerprint.
- **`PaeChannel`** (`src/pae/PaeChannel.ts`) — a registered adapter is surfaced
  as a single capability channel. Every foreign call therefore travels
  `capabilityInvoke → ChannelHub → registry → adapter` and lands in the
  `RecordJournal` with its governance decision attached; there is no side door.
- **`JsPaeAdapter`** (`src/pae/adapters/JsPaeAdapter.ts`) — the first concrete
  adapter family (in-process JS, `L0`, `full` by default). Handlers receive
  `(args, ctx)` where `rng` / `clock` are injected; reaching for `Math.random` /
  `Date.now` is a charter violation. Unknown tools throw `PaeToolMissingError`.
- **Two architectural invariants** enforced by construction: (1) adapters never
  talk to the kernel directly — they are a capability channel, so record/replay
  covers them; (2) adapters introduce no nondeterminism of their own — sources
  arrive through `PaeInvokeCtx`.
- **Config hash into fingerprint** — `RunVersionFingerprint.paeAdaptersHash`
  (optional) carries `PaeAdapterRegistry.configHash()`; a changed adapter surface
  is reported as `RunFingerprintDriftError("paeAdaptersHash", …)` rather than as a
  digest mismatch. When no adapter is registered the field is omitted, so v0.2.x
  traces keep their original fingerprint shape (backward compatible).
- Public API exports: `PaeAdapterRegistry`, `PaeChannel`, `JsPaeAdapter` (+ their
  config/spec types), the three PAE error classes, `FIDELITY_RANK`, and the
  `IPaeAdapter` / `PaeAdapterKind` / `PaeAdapterMeta` / `PaeFidelity` /
  `PaeInvokeCtx` / `PaeIsolationLevel` / `PaeToolDescriptor` types.

### Console
- **Adapter Studio** (`web/public/views/pae.js`) — the W15 surface becomes
  operable: pick a tool template, register the adapter, negotiate fidelity, then
  invoke the tool through the gateway and read back the routing decision, the
  elapsed time and the returned value. The view reuses the Bio-Lineage system
  with a new `--coupler` role (接驳橙 `#ff9d4d`) for foreign adapters.
- **12 tool templates** (`web/public/lib.js`) — `echo`, `reverse`, `upper`,
  `lower`, `length`, `hash`, `base64`, `json`, `add`, `now`, `random`, `uuid`.
  Templates are descriptors only; the bridge injects real handlers and routes
  `random` / `now` through `SeededRng` plus an injected clock, so the console
  never smuggles nondeterminism into the kernel.
- **Honesty gate in the UI** — selecting `reduced` / `lossy` turns
  `fidelityNote` into a required field; an undocumented downgrade cannot be
  registered from the console either.
- **Bridge server** — `GET|POST /api/pae`, `POST /api/pae/invoke`,
  `POST /api/pae/negotiate`, `DELETE /api/pae/:id`; PAE state surfaced in
  `/api/state` (enabled / adapter+tool counts / config hash) and in `/api/graph`
  (a `pae-tool` channel node plus one node per adapter, edged
  `adapter → pae-tool`).
- **Graph view** — new `pae` / `pae-adapter` node kinds with the coupler color,
  halo, layout band and legend entry.
- **Fixes** — the `channels` route existed in the router but had no nav button,
  making 模型通道 unreachable; it now has one. The `--accent` / `--accent-2` /
  `--purple` tokens referenced by the overview were undefined and are now
  declared.
- **Front-end tests** (`web/test/`, `npm run test:console`, 16 cases) —
  `pae-catalog.test.mjs` covers the pure helpers and the template catalog;
  `bridge-pae.test.mjs` drives a real `OrbitRuntimeHost` through register →
  invoke → negotiate → unregister. Pure logic lives in DOM-free `lib.js` so it
  is assertable in Node without a browser.

### Tests
- `test/pae_adapter.test.ts` (22 cases): registration validation, dynamic-pact
  derivation, fidelity-negotiation rejection, order-independent `configHash`,
  JS-adapter determinism, host routing decisions, write-tool lockdown for
  read-only callers, replay zero re-entry, and `paeAdaptersHash` drift.
- `test/replay_compat.test.ts` (+3 PAE merge-gate cases): record→replay is
  byte-identical and the adapter runs exactly once; after unregistering an
  adapter its replay needs no implementation; a `Math.random` poison in the
  adapter body is caught.
- Full suite: **176 cases** green, strict compile zero errors (baseline 151 →
  176, only grows).

## [0.2.0] — 2026-08-29 · Gateway determinism boundary (v0.2.0)

The unified gateway (`capabilityInvoke`) is now a complete, faithful determinism
boundary: every governance decision is recorded and replayed byte-identically,
and drift is reported in three distinct categories.

### Added
- **`RateLimiter`** (`src/gateway/RateLimiter.ts`) — pure-function (no
  `Math.random`/`Date.now`) call-count budget. The `rateLimited` decision is
  recorded at record time and replayed verbatim; the limiter is **bypassed** on
  replay so a fresh limiter never perturbs the reconstructed trace (axioms A1/A2).
- **`BehaviorCollector`** (`src/gateway/BehaviorCollector.ts`) — captures a
  structured `BehaviorNote` per call in three modes:
  - `record` — note is persisted on the `GatewayCallRecord` (with the trace).
  - `live` — note is returned as a proposal, not persisted.
  - `replay` — bypassed; the stored note is restored from the journal.
- **Three-way drift classification** (W13):
  - Config drift → `RunFingerprintDriftError` (kernel/pact/token/pae fingerprint).
  - Decision drift → `DecisionDriftError` (e.g. a capability pact revoked since
    recording — governance is never weakened on replay).
  - Call drift → `ReplayDriftError` (input/output signature mismatch).
  - `ReconcileReport` now carries `decisionDriftFields` listing the differing
    decision axes, distinct from config/call drift.
- **`replay_compat` gateway gate** (W12) — 7 CI cases proving byte-identical
  replay under compression / rate-limit / collector / fingerprint-drift /
  decision-drift. The determinism boundary is now a merge gate.
- `BehaviorNote` domain contract; `GatewayCallRecord.behavior?` field.
- Public API exports: `RateLimiter`, `DEFAULT_RATE_LIMIT_CONFIG`,
  `BehaviorCollector`, `DecisionDriftError`.
- `CONTRIBUTING.md` — documents the architecture gate (VISION §5) on every PR.

### Behavior
- The `compression` checker is now **payload-aware** (`decideCompression(output)`)
  and the recorded `compression.applied`/`bytesSaved` reflect the actual at-rest
  storage decision; small payloads are never bloated by an envelope.
- Budget/route/rate-limit/`tokenConfigHash` decisions are computed from the real
  `TokenBudgetEngine` and channel registry rather than literal stubs.

## [0.1.0] — 2026-08-29 · Open-source launch wave (v0.1.0)

First release-track engineering. The kernel is production-candidate for the
deterministic-replay use case.

### Added
- **`orbit` CLI** (`bin/orbit.mjs`, zero extra dependencies) with three commands:
  - `orbit record <script>` — run a script against a live kernel, capture every
    channel call into a JSONL trace + a `.meta.json` sidecar.
  - `orbit replay <trace>` — re-run the recorded script with **zero** real
    channel calls and reconcile the digest chain (bank-style verification).
  - `orbit diff <a> <b>` — compare two traces record-by-record and locate the
    first digest-chain breakpoint.
  - Every command supports `--json` and clean exit codes.
- **`OpenAICompatChannel` productionization** — 9-class fault taxonomy
  (`LlmChannelFaultError`), deterministic exponential backoff (no `Math.random`,
  `Retry-After` honored), internal retries that never leak into the record
  journal, and `chatRound` overrides (multi-turn `messages`, `seed`,
  `temperature`, `maxTokens`, `responseFormat`).
- **`FileChannel`** (`FILE_SYSTEM`) — filesystem access jailed to a root
  directory (path-escape / null-byte rejection), read/write/append/list/stat/
  remove/mkdir, size guards.
- **`ShellChannel`** (`SHELL_EXEC`) — command execution behind an exact-match
  whitelist, argv-array spawn (no shell-injection surface), empty child env
  unless allowlisted, hard timeout kill, per-stream output caps; non-zero exit
  is data, not a fault.
- **JSONL trace persistence** (`saveRecordJournal` / `loadRecordJournal`) —
  atomic write (tmp + rename), validated header / orderIndex / field checks,
  `TraceFileInvalidError`.
- **`replay_compat` gate suite** — 11 cases proving the宪章 (VISION) axioms on
  every new channel: delete-disk replay, side-effect non-re-execution,
  zero-HTTP replay, retry isolation, multi-channel ordering, cross-engine
  persistence replay, `Math.random` poison guard.
- **Developer guide** (`docs/guide.md`) — how to write a replayable channel.
- **CI** (`.github/workflows/ci.yml`) — Node 20/22 matrix: build, test, demos,
  and an `orbit` CLI smoke (record → replay → diff).
- **Issue / PR templates** enforcing the architecture gate (VISION) on every PR.

### Kernel fixes surfaced by the replay_compat gate
- `attachReplayEngine` now resets the replay call counter, so a second replay
  pass over the same journal starts from call #0 again.
- The replay fast path is checked **before** provider availability, so a trace
  replays on a machine with none of the real channels installed (credentials
  and tools not required). The capability gate still applies first — governance
  is not weakened.
