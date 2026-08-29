# Pull request

## Summary
<!-- What and why. -->

## Architecture gate (VISION.md) — check all that apply
- [ ] New mechanism preserves **A1 reproducible** (record → zero-call replay still matches)
- [ ] New mechanism preserves **A2 provable** (impact graph updated if dependencies change)
- [ ] New mechanism preserves **A3 accountable** (effects recorded in the ledger / trace journal)
- [ ] No `Math.random` / `Date.now` used for replay-relevant decisions
- [ ] `npm test` green; `npm run build` strict-clean
- [ ] Zero new **runtime** dependencies (CLI uses Node built-ins only)
- [ ] Docs / README updated

## Test plan
- [ ] Unit tests added/updated
- [ ] `replay_compat` case added for any new channel
- [ ] Manual `orbit record` / `replay` / `diff` verified if CLI-relevant
