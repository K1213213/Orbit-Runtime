# Security Policy

## Supported versions

Security fixes are applied to the latest release on `main`. Only the most
recent release receives backported fixes.

| Version | Supported |
| ------- | --------- |
| 0.1.x   | ✅        |

## Reporting a vulnerability

Please do **not** open a public issue for security problems. Report privately
to the maintainers via GitHub Security Advisories
(Repository → Security → Report a vulnerability), or open a draft advisory if
you prefer to coordinate disclosure.

Please include:

- the affected version(s)
- a minimal reproduction (code snippet or test)
- the impact and, if known, a proposed fix

We aim to acknowledge reports within 72 hours and to release a fix as soon as
a safe patch is available. When the issue is confirmed, a security advisory
will be published with the fix.

## Security model

- All internal state is private; public queries return copies.
- Plugin-originated channel calls must pass declared-capability checks.
- Every channel call is bounded by a timeout; timers are cleaned up in
  `finally` and teardown.
- Replay reconciliation detects any tampering of recorded call chains.
