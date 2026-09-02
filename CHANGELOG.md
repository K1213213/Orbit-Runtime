# Changelog

All notable changes to Orbit Agent Runtime are documented here. This project
follows a pre-alpha versioning scheme: `v0.x.minor` marks a release wave,
`patch` marks fixes. Until `v1.0` the public API is not yet stability-promised.

## [0.12.0] — 2026-09-02 · Console productization (方案 A + D)

The console stops presenting the kernel as a flat 17-item control plane and
starts presenting a product: the pages a user comes for are visible, the
mechanism pages are one disclosure away, and the naming speaks business
language. Kernel untouched — all changes are in the console shell.

### Changed (方案 A · progressive disclosure + naming)
- NAV_GROUPS regrouped from 5 kernel-themed groups into 4 user-shaped ones:
  - **工作台** (always visible): 工作台 / 智能体实例 / 任务中心
  - **证明** (always visible): 审计与合规 (the proof surface a customer sees)
  - **开发者控制台** (`collapsed: true`): the 11 mechanism pages — workflow,
    knowledge, 知识问答, templates, plugins, 模型接入, 外部工具接入, 用量账单,
    路由与预算, 重放调试台, 故障隔离图 — behind a native `<details>` toggle
  - **系统**: settings / profile
- Business-language renaming: 事件审计→审计与合规, 数据总览→工作台, 影响域图→
  故障隔离图, 成本路由→路由与预算, Token账单→用量账单, 回放台→重放调试台,
  模型适配→模型接入, 异构适配→外部工具接入, RAG推演工作台→知识问答.
- keywords updated so the command palette ranks under the new names.

### Added (方案 D · product first screen)
- Dashboard gains a quick-action row (new task / connect model / import
  knowledge) and a live compliance summary (tier + audit status + one click
  to the audit & compliance page).

### Verification
- Console suite: **109/109** (107 → +2 nav assertions; group-id tests updated
  for the new IA: replay/pae → developer, boxes → primary, trace → proof;
  new gates assert the collapsed developer group holds exactly the 11
  mechanism pages and the visible surface is the 6 product pages).
- Kernel: **430/430** unchanged. css-coverage green (new `.nav-group`
  styles added). npm pack v0.12.0.

## [0.11.0] — 2026-09-02 · Signed compliance reports (W35, P2)

The compliance report becomes a *signed document*: a third party holding only
the public key can verify that the report was produced by the operator and has
not been altered — no shared secret, no access to the original system. This is
the step that turns an internal tool output into something an external auditor
can accept.

### Added
- **`core-hub/audit/report_signing.ts`** — ED25519 report signing (node:crypto
  native, zero dependencies):
  - `deriveReportKeyPair(seed)` — a 32-byte hex seed deterministically derives
    the key pair (RFC 8410 PKCS8 wrap); operators back up a seed, verifiers get
    a PEM public key.
  - `signComplianceReport(report, seed)` — signs the stable key-sorted JSON
    body (everything except `sig`); ed25519 signing is deterministic, so the
    same report + seed always yields the same signature.
  - `verifyComplianceReport(report, publicKeyPem)` — checks signer
    fingerprint, body digest and the signature itself.
- **Console** — `GET /api/compliance/export?format=json` signs the report when
  `ORBIT_REPORT_SIGNING_KEY` is set; md/pdf exports carry a signature line;
  `GET /api/compliance/public-key` hands out the verifier key + fingerprint;
  the audit page report card shows live signing status.
- **CLI** — `orbit verify-report <report.json> --public-key <pem-file|seed>`:
  independent verification, non-zero exit on any tampering.
- **Tests** — `report_signing.test.ts`: seed determinism, round-trip, digest
  tamper detection, wrong-key rejection, unsigned rejection, signature
  mutation.

### Changed
- PEM exports are trimmed so a key survives file round-trips byte-identically
  (a trailing newline made fingerprints drift across write/read).

### Verification
- Kernel suite: **430/430** (423 → +7 report_signing). Console 107/107.
- CLI smoke: PEM verification `✓ signature valid`, a doctored report exits 1.

## [Unreleased] — Doc site (W34, M6b closeout)

The open-source launch's last code gap closes: the architecture documents
become a browsable static site, generated with the project's own zero
dependencies.

- **`tools/render-md.mjs`** — zero-dependency Markdown subset renderer
  (ATX headings, fenced code, pipe tables, blockquotes, lists, hr,
  paragraphs; inline bold / code / links). Pure functions, no I/O.
- **`tools/build-site.mjs`** — renders `README.md` + `docs/*.md` +
  `docs/blog/*` into a Bio-Lineage-themed static site under `site/` (9
  pages). `npm run docsite`; `site/` is git-ignored generated output.
- **CI** — new `Docsite tests + build` step (`npm run test:docsite`).
- **Tests** — `tools/render-md.test.mjs`, 8 cases including a real-doc
  golden check (architecture.md renders with no raw markdown leaking).
- Product version untouched (kernel/console zero change); CHANGELOG gains
  an `[Unreleased]` convention for tooling waves.

## [0.10.0] — 2026-09-02 · Compliance report (W33, PRODUCT_PLAN P2)

The audit story reaches its product conclusion: one exportable artifact that
states the governance tier, proves the audit chain and summarises the
governance interventions — the thing a third party can actually be shown.

### Added
- **Report model** (`web/public/lib.js`, DOM-free): `buildComplianceReport`
  folds the governance profile, the audit-chain report and the recording
  window into `{ meta, governance, audit, interventions, determinism,
  summary }`. Audit status derives honestly: `EMPTY` (no entries), `UNSIGNED`
  (no key — structure provable, integrity not), `PASS` (signed + consistent),
  `FAIL` (broken at entry N with the reason). `countInterventions` tallies the
  governance interventions from timeline steps (rate-limit / trip / pact /
  budget / compression).
- **Bridge endpoints**:
  - `GET /api/compliance` — live report JSON.
  - `GET /api/compliance/export?format=md|json|pdf` — downloadable report
    (PDF reuses the existing zero-dependency buildPdf; export is itself an
    audited action in the console event stream).
- **Console audit page** — a "合规报告" card under the audit-chain card:
  tier + audit status + intervention chips, and md / json / pdf export.

### Verification
- Console suite: **107/107** (103 → +4 compliance pure-function cases).
- Kernel unchanged and green: **423/423** (console/bridge wave).
- Smoke: a keyed strict host produces a `PASS` report with the entry count;
  an unsigned host reports `EMPTY`/`UNSIGNED` honestly.
- view-refs gate caught `badgeEl` used-but-not-imported in the audit view;
  added to its import.

### Migration
- New API only (`/api/compliance*`, lib functions). No kernel change.

## [0.9.0] — 2026-09-02 · Replay timeline (W32, PRODUCT_PLAN P1.1)

The first PRODUCT_PLAN P1 delivery: deterministic replay becomes a visual,
step-through debugging experience instead of a raw JSONL inspection.

### Added
- **Timeline model** (`web/public/lib.js`, DOM-free pure functions shared by
  bridge and views): `buildTimeline(records)` expands a recording window into
  ordered steps; `callFacts(record)` extracts channel/function/input digest/
  output summary/duration/token estimate plus governance facts (rate-limit,
  trip, pact, budget, compression, route); `flaggedSteps` isolates the
  governance-intervened steps; `summarizeValue` renders a bounded output.
- **Bridge endpoints**:
  - `GET /api/replay/timeline` — the host's live recording window as steps.
  - `POST /api/replay/fork { at }` — branch: keep `0..at`, discard the rest,
    continue live recording from `at` (the window's `orderIndex` continues).
- **Console replay page** — timeline card over the real window: step list with
  governance badges, step-through navigation (prev/next), per-step detail
  (input digest / output / duration / tokens / decisions) and a fork action
  that branches a new experiment from the selected step.
- **Console tests**: 6 new cases for the timeline pure functions
  (103 console total).

### Verification
- Kernel suite unchanged and green: **423/423** (this wave is console/bridge
  only — the kernel API surface is untouched, `RecordJournal.restoreSnapshot`
  already provides the fork primitive).
- Console suite: **103/103** green. css-coverage gate caught an unused
  `tl-step` class in the new view; removed.
- E2E smoke: 4-step window builds a timeline; fork at #1 keeps 0..1 and the
  next live call lands at orderIndex 2.

### Migration
- New API only: `replayTimeline` / `replayFork` bridge calls plus lib
  functions. No kernel change; no breaking change.

## [0.8.0] — 2026-09-01 · Trust assumption & contractification (W31)

The last two VISION §3.1 governance dimensions ship, closing the four-tier
model: every dimension in the table now has a code path.

### Added
- **Trust assumption → PAE isolation cap** (`GovernanceProfile.maxIsolationLevel`,
  L0 < L1 < L2): `strict` caps foreign adapters at L1 (no out-of-process
  children); `sandbox`/`standard` allow L2. `assertPaeAdmitted` checks kind
  admission AND isolation before any handshake. Honest note (architecture §12):
  with `strict`'s empty kind admission the kind gate fires first today — the
  cap is the defense-in-depth for future tier combinations that admit kinds
  but cap isolation.
- **Progressive contractification** (`schemaMode` + `validateArgsAgainstSchema`):
  - `PluginUnitPact.schema` and PAE tool `schema` declare an optional parameter
    contract (JSON-Schema subset: object/array/string/number/boolean, required,
    additionalProperties, maxItems).
  - Pure validator with precise first-failure location (`arg.payload.name`).
  - `sandbox` checks nothing; `standard` validates a declared schema before the
    call executes; `strict` REQUIRES a schema on every plugin
    (`registerPlugin` rejects schema-less plugins).
  - Gateway path: `capabilityInvoke` (now async, so the rejection is a promise
    rejection, never a synchronous throw) validates PAE tool arguments in
    record/live; **replay bypasses** — arguments were already checked at record
    time and injection stays a pure replay.
- Profile hash extended with the two new dimensions (cross-tier replay keeps
  refusing as config drift).

### Verification
- Clean `tsc -b`, strict, zero errors.
- Kernel suite: **423 cases** green (413 → +10 `governance_schema`). Console
  97/97. Examples 4/4.
- The strict-tier schema requirement surfaced as 2 pre-existing test fixes
  (W29 strict hosts registered schema-less plugins) — caught by full
  regression.

### Migration
- `schemaMode` is `optional` on sandbox, `declared` on standard: a default
  host only validates PAE tools that declare a schema — no behavioural change
  for existing plugins without schemas.

## [0.7.0] — 2026-09-01 · Audit hash chain (W30)

VISION §3.1's "落盘 + 签名" lands: the append-only audit log becomes
tamper-evident. This is the commercial core of the product story — "prove the
agent really did what it did" needs more than a file that anyone with write
access can edit.

### Added
- **Audit hash chain** (`core-hub/audit/audit_chain.ts`): every audit entry
  carries `prevHash` (previous entry's `chainHash`, genesis seed for the first)
  and `chainHash` = HMAC-SHA256(key, prevHash + canonical entry). Editing ANY
  entry — content, timestamp, or deleting one in the middle — breaks the chain
  at that entry and every entry after it. HMAC is a pure function and the
  canonical form is key-sorted JSON, so the hash is reproducible anywhere.
- **Host option** — `new OrbitRuntimeHost({ auditSigningKey })` signs the audit
  trail; without a key the journal records NO chain fields (pre-W30 behaviour,
  byte for byte). `host.verifyAuditChain()` proves integrity; `strict` tier now
  REQUIRES the signing key (construction fails without it) and refuses to boot
  on a broken recovered chain — an untrusted audit trail is an untrusted
  environment.
- **Recovery continuation** — restored entries keep their chain fields and
  `restoreSnapshot` rebuilds the chain tail, so a window continued across
  processes stays one unbroken chain.
- **`orbit audit <trace.wal.jsonl> [--key]` CLI command** — verifies a chain
  from the genesis seed; unsigned reports need a key, a broken chain exits
  non-zero with the break point and reason.
- **Console** — audit page "kernel audit chain" card (`GET /api/audit/chain`);
  the bridge signs when `ORBIT_AUDIT_SIGNING_KEY` is set.

### Changed
- `strict` governance now validates BOTH a durable trace path and a signing
  key at construction, and verifies the recovered chain at boot.
- `TraceJournal` accepts an optional signing key; `PersistedTraceJournal`
  threads it through (WAL mirrors the chained entries verbatim).

### Verification
- Clean `tsc -b`, strict, zero errors.
- Kernel suite: **413 cases** green (397 → +15 `audit_chain` + 1
  `replay_compat` merge gate: signing does not perturb replay — a keyed host
  records and replays byte-identically while the chain stays provable).
- Console suite: **97/97** green (css-coverage gate caught a missing `.strong`
  style for the new audit card; added). Examples: 4/4 green.

### Migration
- No API break: `auditSigningKey` is optional; unsigned hosts behave exactly
  as before.

## [0.6.0] — 2026-09-01 · Four-tier governance (W29)

VISION §3.1 — the four-tier governance model — stops being a design goal and
becomes concrete, switchable configuration. The last major "documented but not
shipped" architectural surface is closed.

### Added
- **`GovernanceProfile` contract** (`@orbit/infra-common/types/governance`):
  `sandbox` (development) / `standard` (default) / `strict` (compliance),
  resolved by `resolveGovernanceProfile()` and hashed by
  `governanceProfileHash()`. Each profile declares compression strength, rate
  limit, trip threshold/cooldown, PAE admission and trace durability.
- **Host option** — `new OrbitRuntimeHost({ governanceProfile: "strict" })`
  plus a read-only `host.currentGovernanceProfile` accessor. `strict`
  construction fails without a durable `traceJournalPath` (a compliance tier
  with an ephemeral audit trail is a contradiction).
- **Mechanism injection** — limiter and trip numbers come from the profile;
  `tokenBudgetConfigForProfile()` maps compression strength onto
  `TokenBudgetEngine` (off / normal / aggressive with halved thresholds);
  `tripThresholdForProfile()` softens the threshold by dependency out-degree
  (strict collapses to a floor of 1, standard/sandbox to 2).
- **PAE admission gate** — `registerPaeToolAdapter` / `connectPaeToolAdapter`
  check the adapter kind against the profile (sandbox + standard: all kinds;
  strict: none). `connect` gates BEFORE the handshake so a denied kind never
  spawns a child process.
- **Config-drift surface** — a non-default tier adds `governanceProfileHash`
  to the run fingerprint and `CapabilityGateway.verifyFingerprint` compares it
  (absent-on-both = compatible, same pattern as `paeAdaptersHash`). A trace
  recorded under one tier refuses to replay under another with
  `RunFingerprintDriftError`. The `standard` tier is omitted from the
  fingerprint, so default hosts keep the pre-W29 fingerprint byte for byte.
- **Console** — the settings panel shows the active tier and its concrete
  numbers (read-only; the tier is a construction-time decision).

### Changed
- The `standard` profile is the kernel's pre-W29 numbers **verbatim** — a
  default host behaves exactly as before (asserted by test).
- Engineering note on the VISION table: `standard` keeps the FULL PAE surface
  (`all` kinds) rather than "MCP + JS" — the governance axiom is that tiers
  scale strength, never capability, and the already-shipped OpenAPI/Cordis
  adapters must not silently disappear from the default tier. `strict` still
  closes the foreign-runtime surface as a compliance choice. See VISION §3.1
  "与原始表的偏差".
- `src/index.ts` three-way duplicate `export * from "@orbit/infra-common"` was
  collapsed to one line.

### Verification
- Clean `tsc -b`, strict mode, zero errors.
- Kernel suite: **397 cases** green (381 → +14 `governance_profile` + 2
  `replay_compat` merge gates: cross-tier replay refuses as config drift;
  same-tier replay stays byte-identical across hosts).
- Console suite: **97 cases** green (css-coverage gate caught a missing `.col`
  style for the new settings panel block; added).
- Examples unchanged and green.

### Migration
- No API break: `governanceProfile` is optional and defaults to `standard`,
  which resolves to the previous behaviour verbatim.

## [0.5.0] — 2026-09-01 · Engineering hardening & release prep (M5/M6)

The kernel is architecturally complete (VISION Phases 1–5 shipped); this wave
closes the product-hardening track so the release is not just complete but
provable and publishable.

### Added
- **`examples/`** — four runnable, assertion-gated walkthroughs:
  `custom-channel.mjs` (implement a channel, wire it in, prove
  record → replay byte-identical plus drift detection), `js-pae-plugin.mjs`
  (foreign JS tools through a governed channel), `mcp-adapter.mjs` (a real
  stdio child process, handshake-discovered, replayed after the peer is dead),
  and `cli-record-replay.mjs` (the three-command CLI loop). Each exits
  non-zero on failure, so the set doubles as CI smoke checks.
- **`benchmarks/`** — `gateway` (governed `capabilityInvoke` cost), `replay`
  (journal fast-path throughput), `wal` (durable append + flush), `pae`
  (L0 in-process vs L2 stdio-child latency), plus `run-all.mjs` and
  `npm run benchmark`. Sample numbers on Node 22: gateway ~82k calls/s
  (~12 µs), replay ~261k calls/s (~3.8 µs), WAL ~1.5k durable appends/s,
  L0 ~38 µs vs L2 ~176 µs (4.6× cross-process factor).
- **CI coverage closed**: the console suite (`npm run test:console`, 97
  cases) now runs in CI alongside the kernel suite; all four examples and all
  four benchmark suites run as smoke checks.
- **Package contents**: `examples/`, `benchmarks/` and `README.zh-CN.md` are
  now shipped in the npm tarball; `prepublishOnly` also runs the console
  suite.

### Changed
- `KERNEL_VERSION` and all six `package.json` files bumped to `0.5.0`;
  fingerprint assertion and README example updated.

### Migration
- No API change. The new npm scripts are additive
  (`npm run example:*`, `npm run benchmark`).

## [0.4.0] — 2026-08-31 · Journal durability (W27)

Closes the last architectural gap carried by the v0.3.0 documentation: journals
lived only in memory, so a restart erased the audit trail and any recorded run.
A replay-and-audit kernel whose log evaporates on restart is not a complete
architecture — this wave gives both journals a crash-safe write-ahead log.

### Added
- **Crash-safe WAL substrate** (`@orbit/core-hub`, `persistence/wal`): one JSON
  line per entry. A write appends a single line, so the only artifact a crash can
  leave is a *partial final line* — recovery drops exactly that, while any corrupt
  or structurally invalid **interior** line is a genuine fault and is rejected as
  `WalFileInvalidError` with its line number. `walAppend` / `walRecover` /
  `walRecoverSync` / `walReset` / `walCompact` / `walLineCount`.
- **`PersistedTraceJournal`** — the audit/behavior journal mirrored to a WAL.
  `load()` replays it at boot; `entryUid` and `occurredAt` are preserved verbatim,
  so recovered entries are byte-identical and never perturb audit ordering.
- **`PersistedRecordJournal`** — a recording window mirrored to a WAL. A recovered
  window continues `orderIndex` instead of restarting at 0, so a run split across
  processes replays as one uninterrupted sequence.
- **Host durability options** — `new OrbitRuntimeHost({ traceJournalPath,
  recordJournalPath, auditRetention })`. `bootHost` recovers, `shutdownHost`
  drains pending writes, `resumeRecording()` reopens a persisted window and
  `currentRecordJournal()` exposes it. Omitting the paths keeps the previous
  purely in-memory behavior, byte for byte.
- **Bounded audit retention** — `auditRetention` keeps the newest N entries and
  compacts the WAL to match, applied at boot and at shutdown, plus
  `pruneAuditLog()` for on-demand pruning. An audit log that fills the disk is an
  outage, so the bound is explicit and operator-chosen rather than implicit.
- **Self-healing logs** — `walCompact` / `compact()` / `healIfNeeded()` rewrite a
  log atomically (temp file + rename) from its surviving prefix.

### Fixed
- `loadTraceJournal` restored only the *last* entry of a saved journal: it called
  `restoreSnapshot([entry])` inside the read loop, replacing the chain on every
  iteration instead of accumulating it.
- A crash-truncated tail was tolerated by recovery but left on disk, so the next
  run's first append turned it into an **interior** invalid line — which is a hard
  fault, meaning one crash could make every later boot fail. Recovery now heals
  the file before the first append (`healIfNeeded`, a no-op on a healthy log).
- `bootHost` recovered the audit journal *after* channel setup, so audit entries
  emitted during setup were discarded by the recovered snapshot. Recovery now runs
  before anything can append.

### Verification
- Clean `tsc -b` composite build, strict mode, zero errors.
- Kernel suite: **348 cases** green (290 at v0.3.0 + 58 new).
- Console suite (`npm run test:console`): **89 cases** green.
- Charter gate A1: `test/replay_compat.test.ts` extended with WAL cases — a
  window persisted by one process replays byte-identically in another, a
  crash-truncated WAL replays its surviving prefix, and durability does not
  perturb the recorded bytes.

### Migration
- No public API change and no on-disk trace-format change; durability is opt-in
  per path. Existing v0.3.x traces replay unchanged.
- `KERNEL_VERSION` bumped to `0.4.0`; `DOMAIN_HOST_VERSION` derives from it.


## [0.3.0] — 2026-08-31 · v0.3.0 General Availability (W15–W26)

The v0.3.0 wave delivers the ecosystem-access track end to end: the Plugin
Adaptation Engine (foreign runtimes surfaced as governed capability channels),
graph-driven isolation domains with transactional cross-domain calls, the
TypeScript Project-References monorepo split, and the admin-console packaging.
The public API (`src/index.ts`) is unchanged across the split.

### Release summary
- **Plugin Adaptation Engine (W15–W18):** JS / MCP / OpenAPI / Cordis adapters,
  each a capability channel governed by the gateway (W15–W18 detail below).
- **Isolation domains (W19–W20):** graph-driven L2 domain allocation, an atomic
  cross-domain transaction ledger with orphan/refusal reconciliation, and the
  plan held as host state with diff-based sync.
- **Monorepo extraction (W21–W23):** the single `src/` tree split into npm
  workspaces (`@orbit/infra-common`, `@orbit/core-hub`, `@orbit/sandbox-runtime`,
  `@orbit/pae-engine`) plus the root host; `tsc -b` composite build.
- **Admin console packaged (W24–W26):** `web/` is now `@orbit/admin-console`
  (a private app workspace) with `start`/`test` scripts; the bridge imports the
  compiled kernel from `dist/`.

### Verification (v0.3.0 GA)
- Clean from-scratch `tsc -b` build, strict mode, zero errors.
- Kernel suite (`node --test dist/test/*.test.js`): **290 cases** green.
- Console suite (`npm run test:console`): **89 cases** green.
- No public API change, no replay-contract regression vs v0.2.x.

### Migration
- Commands unchanged: `npm install`, `npm run build`, `npm test`,
  `npm run test:console`, `npm run start:web`.
- `KERNEL_VERSION` bumped to `0.3.0`; `DOMAIN_HOST_VERSION` derives from it.
- pnpm migration (a roadmap refinement) is deferred — npm workspaces already
  satisfy the structural goal; see DEV_PLAN W24–W26.

### W15 — Plugin Adaptation Engine (PAE)

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
