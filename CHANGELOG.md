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

### W16 — MCP adapter (cross-process foreign runtimes)
- **MCP protocol layer** (`src/pae/adapters/mcp/protocol.ts`) — JSON-RPC 2.0
  envelopes, newline framing, `tools/list` validation and `tools/call` result
  normalisation as pure functions. Parsing untrusted peer output is exactly the
  kind of logic that must be testable without I/O, so it lives here.
- **Transports** (`src/pae/adapters/mcp/transport.ts`) — `IMcpTransport` with a
  stdio implementation (`node:child_process`, newline-delimited JSON, correlated
  responses, caller deadlines, in-flight requests failed when the peer dies) and
  an in-memory one so protocol behaviour is testable without a subprocess. A
  failing peer's stderr is kept as a bounded tail and attached to the error —
  previously a server that died on startup reported only its exit code, which is
  undiagnosable.
- **`McpPaeAdapter`** (`src/pae/adapters/mcp/McpPaeAdapter.ts`) — `kind: "mcp"`,
  `isolation: "L2"`, determinism `IO_BOUND`. `setup` performs the handshake and
  *then* discovers the tool surface, because a remote peer's capabilities are
  not knowable any earlier. The edition the peer reports is adopted as
  `sourceEdition` once known, so a server upgrade shows up as fingerprint drift
  instead of passing unnoticed.
- **Honest default fidelity** — MCP tools default to `reduced` with a mandatory
  note: the argument schema is enforced by the *peer*, not the kernel, and
  results are mapped from MCP `content[]` (non-text blocks preserved verbatim
  rather than coerced). Claiming `full` would be shorter; it would also be the
  most damaging false claim this adapter could make, because every downstream
  assumption rests on it.
- **Host** — `connectPaeToolAdapter` (handshake, then register the surface the
  peer actually announced) and `releasePaeToolAdapter` (unregister, then await
  teardown, so an MCP subprocess does not outlive its registration).
- **Registry fix** — `unregister` never called `adapter.teardown()`. Harmless for
  in-process adapters, but it meant an MCP peer stayed alive after its adapter
  was removed. Releases are now started on unregister and can be awaited via
  `drainReleases()`.
- New error type `PaeRemoteError` for peer/transport failures — distinct from
  registration-time rejection and from a missing tool name.

### Console
- **Adapter Studio** (`web/public/views/pae.js`) — the PAE surface becomes
  operable: pick a tool template, register the adapter, negotiate fidelity, then
  invoke the tool through the gateway and read back the routing decision, the
  elapsed time and the returned value. The view reuses the Bio-Lineage system
  with a new `--coupler` role (接驳橙 `#ff9d4d`) for foreign adapters.
- **MCP in the console** — a second adapter family alongside JS. Connecting
  spawns the server, completes the handshake and registers only the tools the
  peer actually announced; a failed handshake closes the child and leaves no
  registration behind. Discovered tools are shown with the peer's identity and
  their honest `reduced` fidelity.
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
- **Command palette** — `Ctrl/⌘+K` or `/` opens a fuzzy-searchable index of
  every view *and* every host action (boot / shutdown / restart / refresh).
  `↑` `↓` to move, `Enter` to run, `Esc` to close. Ranking is a pure function
  (`fuzzyScore`) and is unit-tested, including Chinese/English mixed queries.
- **Task-oriented overview** — the front page stopped restating the nine views
  and now answers two questions instead: *can this host work right now* (a health
  verdict with every reason behind it) and *what should I do next* (derived from
  real kernel state, each step a clickable action rather than prose). A stopped
  host gets exactly one suggestion: start it.
- **Grouped navigation, generated from data** — the sidebar is built from
  `NAV_GROUPS` in `lib.js`, not hand-written in HTML, and the palette indexes the
  same data. Nine flat pages became three intent groups: 运行时 / 构件 / 治理.
- **Fixes**:
  - `channels` had a route but no nav button — 模型通道 was unreachable.
  - `--accent` / `--accent-2` / `--purple` were referenced by the overview but
    never declared.
  - `/api/health` reported a hard-coded `0.1.0` while the kernel was at `0.2.0`;
    it now reads `KERNEL_VERSION`, so the console cannot go stale again.
  - The overview's 熔断保护 card pointed at a `safeguard` route that does not
    exist, silently sending the user to the sandbox page instead.
- **Front-end tests** (`web/test/`, `npm run test:console`, 49 cases) —
  `pae-catalog.test.mjs` (pure helpers + template catalog),
  `bridge-pae.test.mjs` (a real `OrbitRuntimeHost`, now including seven MCP cases
  driving a genuine subprocess peer), and `console-core.test.mjs` (navigation
  model, palette ranking, health derivation, next-step suggestions, argv
  parsing). `web/test/fixtures/mcp-stdio-server.mjs` is a minimal but real MCP
  server used to exercise the full cross-process path.

### Tests
- `test/pae_adapter.test.ts` (22 cases): registration validation, dynamic-pact
  derivation, fidelity-negotiation rejection, order-independent `configHash`,
  JS-adapter determinism, host routing decisions, write-tool lockdown for
  read-only callers, replay zero re-entry, and `paeAdaptersHash` drift.
- `test/mcp_adapter.test.ts` (27 cases): protocol framing and validation,
  `content[]` normalisation, transport correlation / deadlines / closure,
  handshake-driven discovery, `L2` + `IO_BOUND` defaults, honest `reduced`
  fidelity, `toolNamePrefix` collision avoidance, remote tool errors, host
  registration and drift, a real subprocess over stdio, and a dead or dying peer
  failing in-flight requests with its stderr attached.
- `test/replay_compat.test.ts` (+3 PAE, +2 MCP merge-gate cases): record→replay is
  byte-identical and the adapter runs exactly once; after unregistering an
  adapter its replay needs no implementation; a `Math.random` poison in the
  adapter body is caught; an MCP trace replays without re-entering the peer; a
  trace replays after its MCP peer has been shut down and released.
- Full kernel suite: **205 cases** green, strict compile zero errors
  (baseline 151 → 176 after W15 → 205 after W16; only grows).
- Full console suite (`npm run test:console`): **49 cases** green. Kernel and
  console suites are independent; a change on either side runs both.

### Console Platformization — 2026-08-30 (W16+, continued)

The web console stops being a passive viewer and becomes a platform: accounts,
knowledge, retrieval, orchestration and governance all live behind the bridge
and share one DOM-free source of truth with the browser.

- **Account & access layer** — `scrypt` password hashing with per-user salt,
  seeded administrator (`admin / orbit-admin`, first account is always admin so
  self-registration can never mint another), bearer-token sessions, password
  change with audit. Role matrix (`admin | operator | viewer`) is the single
  `can(role, action)`裁决入口; 403 surfaces and button-disabled states both ask
  it. Bridge routes: `POST /api/auth/{register,login,logout,password}`,
  `GET /api/auth/me`.
- **Knowledge base** (`web/public/kb.js`, zero deps) — paragraph-aware chunking
  (paragraphs never split, sentence-level fallback, overlap only inside a
  paragraph), a deterministic lexical BM25 index (no vector service, fully
  replayable), and query→chunk highlight ranges for two-way grounding. Chinese
  stop-words are stored as single characters because `tokenize` splits CJK into
  single chars — multi-char stop-words would otherwise never match. Bridge
  routes: `GET/POST/DELETE /api/kb`, `POST /api/kb/:id/docs`,
  `POST /api/kb/:id/search`, `GET /api/kb/:id`, `GET /api/kb/:id/docs/:doc`.
- **Agentic RAG pipeline** — an eight-step run (`RAG_STEPS`: parse → retrieve →
  assess → refine → rerank → synthesize → ground → audit) with a sufficiency
  gate (`assessSufficiency`) that triggers at most `maxRefines` deterministic
  query rewrites (high-frequency terms from the top hit), then synthesizes
  through the kernel's `llm-access` channel and grounds the answer with citations
  carrying highlight ranges. Bridge: `GET/POST /api/rag`, `GET /api/rag/:id`.
- **Workflow DAG editor** (`workflow.js`) — a canvas to compose start / agent /
  tool / branch / end nodes with flow and loop edges. Graph rules are pure
  functions: `validateWorkflow` (unique start, required end, no dangling/self
  edges, no flow-cycle — loop edges are exempt, orphan/under-branched warnings),
  `topoOrder` (stable Kahn sort using original node order), `evalBranch`
  (deterministic substring match). Bridge: `GET/POST /api/workflows`,
  `POST /api/workflows/:id/run`, `GET /api/workflow-runs/:id`.
- **Platform views & pure logic** — 13 view modules (`login, dashboard,
  instances, tasks, workflow, knowledge, rag, templates, market, audit, billing,
  settings, profile`) plus the pre-existing `channels/pae/routing/replay/graph`;
  all "what the user sees next" logic (navigation, command palette ranking,
  health derivation, next-step suggestions, billing aggregation, notification
  derivation, task-status vocabulary, role matrix) lives in DOM-free
  `web/public/lib.js` so it is assertable in Node. Fixed a dead-code bug: the
  multi-character CJK stop-word list could never match after `tokenize`.
- **Governance & observability** — billing aggregation (`deriveBilling`: balance,
  total, 7-day trend, per-box/per-task ranking, low-balance flag), audit trail
  export (`GET /api/audit/export` md/json), notification center
  (`deriveNotifications`), and a `GET /api/dashboard` roll-up.
- **Tests** — console suite grew **49 → 80** (`web/test/kb.test.mjs` for the KB /
  RAG / workflow pure logic, `web/test/console-platform.test.mjs` for billing /
  notifications / trends / roles / task vocabulary); an HTTP end-to-end smoke
  exercises login → KB create → upload → search → RAG → workflow save/run →
  billing → audit → notifications → dashboard with a 401 probe on a bad token.
  Full kernel suite unchanged at **205** cases green, strict compile zero errors.

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
