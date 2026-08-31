# Security Policy

## Supported versions

Security fixes are applied to the latest release on `main`. Only the most
recent release receives backported fixes.

| Version | Supported |
| ------- | --------- |
| 0.4.x   | ✅        |
| 0.3.x   | ✅        |

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

## Web console (bridge server)

The console is a **developer tool bound to loopback** and is not a hardened
multi-tenant surface. Know its bounds before exposing it beyond `127.0.0.1`:

- The seed administrator `admin / orbit-admin` is printed in the startup banner.
  Change it before any deployment that other people can reach.
- Self-registration is open (the first account is the administrator; every
  later account is an `operator`); login is rate-limited per (source IP,
  account) — 5 failures lock the account for 30 seconds.
- Mutating routes are gated server-side by role: `viewer` is read-only,
  `operator` covers day-to-day operations, `admin` adds account management.
- MCP registration rejects `shell: true` (no shell command strings — start
  `npx`-style servers via `node` + the CLI's full path), and model `baseUrl`
  must not point at loopback, link-local or private ranges (SSRF guard).
