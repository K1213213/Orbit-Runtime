# Contributing to Orbit Agent Runtime

Thanks for considering a contribution. This project aims to stay small, focused
and dependency-free; please read the design notes in
[docs/architecture.md](./docs/architecture.md) before touching core code.

## Development setup

```bash
npm install
npm run build   # strict TypeScript compile
npm test        # run the node:test suite
npm run demo    # lifecycle demo
npm run demo:replay  # deterministic replay demo
```

## Coding style

- TypeScript, `strict: true`. No runtime dependencies.
- Concise English comments that explain **why**, never restate the code.
- Public API returns copies of internal state; internal maps stay private.
- Errors are `OrbitDomainError` subclasses with a stable `errorToken` — never
  bare `Error` or magic strings for control flow.
- Layered dependency: `types → utils → core → channel/pact/safeguard/trace →
  sandbox → runtime_host`. Never import upward; use injection to cross layers.

## Pull requests

1. Branch from `main`; keep the change small and single-purpose.
2. Add or update tests under `test/` for any behavior change (node:test).
3. Run `npm test` locally until green.
4. Open the PR with a clear description; the maintainers will review.

## Commit messages

Follow conventional commits: `feat:`, `fix:`, `refactor:`, `docs:`, `test:`,
`chore:`. Reference the affected module in the summary when relevant.

## License

By contributing you agree that your contributions are licensed under the
[Apache License 2.0](./LICENSE).
