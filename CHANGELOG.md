# Changelog

All notable changes to Orbit Agent Runtime are documented here. This project
follows a pre-alpha versioning scheme: `v0.x.minor` marks a release wave,
`patch` marks fixes. Until `v1.0` the public API is not yet stability-promised.

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
