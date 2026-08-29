# Contributing to Orbit Agent Runtime

Orbit is developed as an **open-source product**, not a lab experiment. Every
change is held to the architecture charter ([docs/VISION.md](./docs/VISION.md))
and the three axioms it protects:

- **A1 · Reproducible** — a run can be replayed with zero external calls,
  byte-identical output, and a verifiable digest chain.
- **A2 · Provable** — fault impact is a graph reachability closure; isolation is
  formally decidable.
- **A3 · Accountable** — every call's cost / token / latency enters one resource
  ledger that can be replayed and reconciled.

## Architecture Gate (must pass before merge)

Every PR must satisfy the gate in [VISION §5](./docs/VISION.md). In short:

- [ ] `npm test` is green (build + `node --test`); **no regressions**, baseline
      only grows.
- [ ] Any new channel / mechanism has a `record → replay` byte-identical case in
      `test/replay_compat.test.ts` (or the gateway A.5 gate in
      `test/gateway.test.ts`).
- [ ] No bare `Math.random` / `Date.now` in non-deterministic paths; inject
      `RngSource` / `ClockSource` instead.
- [ ] Governance decisions are recorded in `GatewayCallRecord.decision`
      (trip / pact / budget / rate-limit / route / compression); replay restores
      them verbatim and bypasses live state (rate limiter, collector, budget
      accumulator) so reconstruction is deterministic.
- [ ] Drift is reported in three distinct ways: config (`RunFingerprintDriftError`),
      decision (`DecisionDriftError`), call (`ReplayDriftError`).
- [ ] Layering is respected — strict one-way dependencies, no cycles, no bypass
      of the `capabilityInvoke` gateway entry.
- [ ] PAE adapters (foreign runtimes) surface as a capability channel — they
      never call the kernel directly, inject `RngSource` / `ClockSource` (no
      `Math.random` / `Date.now`), declare their full tool surface, and negotiate
      `fidelity` honestly (`reduced` / `lossy` require a `fidelityNote`).
- [ ] `CHANGELOG.md` and the relevant charter/plan docs are updated.

## Workflow

1. Fork / branch from `main` (`feat/…`, `fix/…`, `docs/…`).
2. Keep the kernel **zero runtime dependencies** — only `node:` built-ins.
3. Strict TypeScript (`tsc -p tsconfig.json` with no errors).
4. Add tests beside the code you change; aim for a failing test before the fix.
5. Run `npm test` and `npm run build` locally before opening a PR.
6. Fill the PR template; it re-checks the Architecture Gate.

## Local setup

```bash
npm install        # dev deps only (typescript + @types/node)
npm run build      # strict compile → dist/
npm test           # build + unit tests (node:test)
npm run demo       # full lifecycle demo
```

## Code style

- TypeScript, `strict` mode, explicit types at module boundaries.
- No `any` in committed code; prefer precise domain types in `src/types`.
- Comments explain *why*, not *what*; reference the charter/plan when a design
  choice protects an axiom.
- Public API changes go through `src/index.ts`; keep backward compatibility or
  document the break in `CHANGELOG.md`.

## Reporting issues

Use the issue templates. For a bug, include the **trace** (`orbit replay` output
or the `RecordJournal`) — a replayable trace is worth more than a stack trace,
because it lets us reproduce deterministically.
