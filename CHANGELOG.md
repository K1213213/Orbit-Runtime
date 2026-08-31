# Changelog

All notable changes to Orbit Agent Runtime are documented here. This project
follows a pre-alpha versioning scheme: `v0.x.minor` marks a release wave,
`patch` marks fixes. Until `v1.0` the public API is not yet stability-promised.

## [0.3.0] — 2026-08-31 · Monorepo package extraction (W21–W23)

The single `src/` tree is now a TypeScript Project-References monorepo. The
public API (`src/index.ts`) is unchanged; the split is internal only.

### Changed
- Repo restructured into npm workspaces: `@orbit/infra-common`,
  `@orbit/core-hub`, `@orbit/sandbox-runtime`, `@orbit/pae-engine`, plus the
  root host in `src/`. Cross-package imports use the `@orbit/*` specifier.
- `npm run build` now runs `tsc -b` across all packages; each package has its own
  `tsconfig.json` (`composite: true`) with `references` to its dependencies.
- `npm install` links the workspaces via `node_modules/@orbit/*` symlinks.

### Migration
- Same commands as before: `npm install`, `npm run build`, `npm test`,
  `npm run test:console`. No public API change, no replay-contract regression.
- Clean from-scratch build passes (290 kernel tests + 89 console tests,
  strict compile zero errors).

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

### W17 — OpenAPI adapter (REST APIs as PAE tools)
- **`spec.ts` — pure document mapping.** An OpenAPI 3.x / Swagger 2.x document
  is parsed into a tool surface (`parseOpenApiDocument`): one tool per
  (method, path) operation, `operationId` used verbatim and a registry-safe
  `method_path` name synthesized when absent, path-level parameters merged into
  each operation, and cookie parameters rejected outright (the kernel never
  attaches ambient credentials). Malformed structure is a hard error, exactly
  like MCP's `parseToolList`. Request building (`buildHttpRequest`) is also
  pure: required path parameters must be present and are URL-encoded in place,
  query keys are serialised in sorted order so identical arguments produce an
  identical URL (digest stability), and remaining keys become the JSON body when
  the operation declares one — leftovers without a body are a hard error, never
  silently dropped. `resolveDocumentBaseUrl` reads `servers[0]` / swagger
  `schemes+host+basePath` as a fallback.
- **`transport.ts` — injected HTTP seam.** `IHttpTransport` mirrors the MCP
  transport contract; `InMemoryHttpTransport` makes the adapter's semantics
  testable without a network, and `FetchHttpTransport` is the real path
  (platform `fetch`, per-request deadline, default headers, injectable
  `fetchImpl` for tests).
- **`OpenApiPaeAdapter`** — `kind: "openapi"`, `isolation: "L2"`, remote API is
  `IO_BOUND` like MCP. Unlike MCP there is no live handshake: the surface is
  read statically from the document, so a malformed spec (or an adapter with no
  resolvable base URL) fails at construction, before any call is routed to it.
  `baseUrl` is configuration first, the document's server a fallback. Default
  fidelity is **`reduced`** with an honest note: validation is remote (only
  required path parameters are enforced locally; query/header/body pass
  through), and an HTTP response is collapsed to a single JSON/text value with
  status code and headers dropped; a non-2xx status raises `PaeRemoteError`
  with the status and a bounded body tail. Per-operation overrides
  (`OpenApiOperationOverride`) and `toolNamePrefix` follow the MCP pattern.
- Public API: `OpenApiPaeAdapter`, `OPENAPI_DEFAULT_FIDELITY_NOTE`,
  `InMemoryHttpTransport`, `FetchHttpTransport`, `parseOpenApiDocument`,
  `buildHttpRequest`, `normaliseHttpResponse`, `resolveDocumentBaseUrl`.

### W18 — Cordis adapter (isolated plugin hosts)
- **`protocol.ts` — host-defined wire format, pure.** A Cordis isolated
  instance (VISION: 事件锁在域内，跨域为事务) is a plugin host process with no
  standardised protocol, so the kernel defines one. The envelope borrows
  JSON-RPC 2.0's discipline (id, result XOR error) but is deliberately
  self-contained — adapter families stay independent, and a protocol revision
  here cannot ripple into MCP. `decodeFrame` skips blank/log lines and rejects
  envelope violations; `parseCordisToolList` treats a malformed host as a hard
  error; `normaliseCordisToolResult` passes host results through verbatim.
- **`transport.ts` — injected seam.** `ICordisTransport` + in-memory
  implementation for network-free tests, and `ChildProcessCordisTransport`
  (spawn `node` host, newline-delimited JSON, correlated responses, caller
  deadlines, in-flight requests failed when the host dies, bounded stderr tail
  surfaced on failure). Same responsibilities as the MCP stdio transport.
- **`CordisPaeAdapter`** — `kind: "cordis"`, `isolation: "L2"`, `IO_BOUND` like
  every cross-process family. `setup()` performs the `initialize` handshake,
  adopts the host-reported version as `sourceEdition` (semver-guarded, `0.0.0`
  placeholder until then), then discovers the tool surface via `tools/list`.
  Default fidelity is **`reduced`** with an honest note: validation is remote
  (the announced `input` shape is not locally enforced), results are whatever
  JSON the host returns, and the host's internal events and services stay
  inside the isolated instance. `toolNamePrefix` and per-tool overrides follow
  the MCP pattern. Closes the W15–W18 difficulty ladder: JS (L0) → MCP (L2,
  standard protocol) → OpenAPI (L2, stateless) → Cordis (L2, host-defined
  protocol).
- Public API: `CordisPaeAdapter`, `CORDIS_DEFAULT_FIDELITY_NOTE`,
  `InMemoryCordisTransport`, `ChildProcessCordisTransport`, `encodeFrame`,
  `decodeFrame`, `parseCordisToolList`, `normaliseCordisToolResult`.

### W19 — Graph-driven isolation domains (VISION 2.3 double isolation)
- **`allocate.ts` — pure graph → plan.** `impactClosureSizes` computes every
  node's failure impact (reverse-reachability closure on the impact graph).
  `allocateDomains` turns the graph into a domain plan: a node whose impact
  closure exceeds `maxImpactClosure` is **escalated** to its own L2 domain
  (`iso:<unit>`), the rest are packed into deterministic `shared:<n>` chunks of
  at most `maxDomainSize`. Independence is what makes co-location safe — nodes
  with no path between them cannot affect each other, so sharing a process adds
  no *logical* blast; the threshold is the accepted *process-level* blast
  contract. The plan is a partition, deterministic, and auto-escalates as the
  graph grows.
- **`protocol.ts` / `transport.ts` — L2 host wire format, pure + injected.**
  `units/list` surface parsing (malformed hosts are a hard error, duplicate
  unit ids rejected, tool names deduplicated globally as `unitId:tool`) and
  `units/call` result pass-through. `IDomainTransport` + in-memory
  implementation + `ChildProcessDomainTransport` (spawn `node`, framing,
  correlation, deadlines, dead-host in-flight failure, stderr tail).
- **`hostShim.ts` — the built-in pure-unit host.** A source string spawned via
  `node -e` by the default transport factory; serves pure units (`echo`, `calc`)
  selected by the `ORBIT_DOMAIN_UNITS` env var. The kernel never ships code into
  the child — a real deployment swaps this for a bootstrap script that loads its
  own plugins and announces them via the same protocol.
- **`IsolationDomain` / `IsolationDomainManager`** — the physical layer: setup
  handshake + unit discovery, `invokeUnit` routing, and a **sync that is a
  diff, not a rebuild** — unchanged domains keep their child processes, removed
  domains are awaited before release. `teardownAll` releases everything.
- **`DomainChannel`** — the gateway surface, the same shape as `PaeChannel`:
  every unit tool is installed as a method named `${unitId}:${tool}` (unit ids
  are globally unique because the plan is a partition), so a domain call travels
  `capabilityInvoke(DOMAIN_TOOL) → hub → channel → manager → host process` and
  lands in the journal as an `IO_BOUND` inject call. Replay needs neither the
  domain nor its child process.
- Public API: `allocateDomains`, `impactClosureSizes`, `IsolationDomain`,
  `IsolationDomainManager`, `DomainChannel`, `InMemoryDomainTransport`,
  `ChildProcessDomainTransport`, `DOMAIN_HOST_SHIM`, `DOMAIN_HOST_VERSION`,
  the protocol functions, and `ChannelKind.DOMAIN_TOOL`.

### W20 — Cross-domain transactions & graph-driven allocation as host state
- **`transaction.ts` — the settlement record.** VISION 2.1 declares every
  capability call an atomic transaction; 2.2 adds that interaction *between*
  isolation domains is a gateway transaction whose events can be reconciled.
  `beginTransaction` / `markExecuted` / `settleTransaction` / `reconcileTransactions`
  implement that with no clock, no randomness and no I/O. Transaction ids are
  `dtx:<seq>`, so a run replays to the same id stream. Reconciliation groups by
  (source domain → target domain) and detects two failure shapes from the
  records alone: **orphans** (a hop crossed a boundary and never settled) and
  **refusals** (refused before execution — not an error, but a wall of them
  means the plan no longer matches the graph).
- **`IsolationDomainManager.invokeUnit` is now transactional.** Every hop opens
  a transaction (decision: is the unit assigned, at what isolation level),
  executes, and settles with its outcome — success or failure. A refused hop is
  *recorded as rejected* rather than thrown away, so "the plan no longer matches
  the graph" is visible in the ledger, not only in a stack trace. Latency is
  measured through an injected clock; `txnLedger()` / `reconcile()` /
  `ledgerHash()` / `clearLedger()` expose the record.
- **The plan becomes host state.** `OrbitRuntimeHost` owns the domain manager:
  graph mutations (`registerPlugin`, `spawnAgentBox`, `unregisterPaeToolAdapter`)
  mark the plan stale via `domainsStale()`, and `allocateIsolationDomains()`
  syncs it (a diff, so re-running changes nothing) and publishes the surface on
  `ChannelKind.DOMAIN_TOOL` — registering that channel happens only on
  allocation, so a host that never allocates domains keeps its previous hub
  surface and fingerprint byte for byte.
- **Backward-compatible fingerprint.** `RunVersionFingerprint.domainPlanHash` is
  *omitted* while no plan exists (the W15/W16 PAE rule applied to the physical
  layer), and `host.runFingerprint()` is now public for drift diagnosis.
- **Replay does not re-enter a domain.** The frozen output is injected at the
  gateway, so the child process is untouched and no transaction is opened —
  asserted directly in the replay gate.
- Public API: `allocateIsolationDomains`, `domainPlan`, `domains`, `domainsStale`,
  `invokeDomainUnit`, `domainLedger`, `reconcileDomainTransactions`,
  `releaseIsolationDomains`, `runFingerprint`, plus the transaction functions and
  types.

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

### Console feature transformation — 2026-08-30 (W16+, continued)

User-facing completion pass driven by the no-xianxia professional-console
design doc (`74d2a10`). All product copy, navigation, status and type
vocabulary is fully de-xianxia'd and professional.

- **Knowledge base upload rebuilt** — drag-and-drop / batch / folder upload panel
  with chunk-size + overlap parameters wired end-to-end through `kbUpload`;
  per-file status pipeline (排队 → 解析中 → 切片中 → 向量化中 → 完成/失败),
  global progress and an index-build animation. Contract test added.
- **Settings extended** — model-adapter section (DeepSeek / OpenAI-compatible
  endpoints, key, model, temperature) and security section (password change,
  logout); permission matrix already present.
- **Templates & instances** — copy-as-new-template, side-by-side version compare
  (diff vs previous revision), instance detail drawer with the full field set
  and quick actions.
- **RAG** — slow-motion step replay with replay-focus step selection.
- **Cross-cutting** — dashboard rebuilt as a data board with charts, global
  responsive breakpoints, 404/403 state pages, login/register completion
  (remember-me, validation, agreement), PDF audit export.
- Tests: console suite **80 → 81** green; kernel 205 unchanged.

### Console style restoration — 2026-08-30 (fix)

Two user-visible defects traced to the `826c150` full stylesheet rewrite
(`6bf2249`):

1. **Login page leaked register-only fields** (nickname/email/confirm/agree).
   Layered root cause: the fields never received an initial `hidden` state
   (it was only assigned inside `toggle()`), and even with `hidden` set,
   `.field{display:flex}` / `.shell{display:grid}` override the UA stylesheet's
   `[hidden]` rule. Fixed by assigning `hidden = true` at creation plus a
   global `[hidden], .hidden { display:none !important }` rule.
2. **Early-wave views (pae / channels / graph / replay / routing) lost all
   styling** — the rewrite dropped every legacy selector still referenced by
   those views. Restored as an explicit compatibility layer (~200 lines) with
   token aliases (`--coupler` / `--purple` / `--text-2` → current tokens) and
   the legacy selectors.
- **New gate test** `web/test/css-coverage.test.mjs`: every class referenced by
  a view module must be defined in `styles.css`, the `[hidden]` rule must stay
  `!important`, and the legacy compat tokens must remain defined — a full
  stylesheet rewrite can no longer silently strand a view. Console suite
  **81 → 84** green.

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
