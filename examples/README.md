# Examples

Run each example with a plain `node` — no build step, no extra dependencies:

```bash
# 1. a custom deterministic channel: wire it in, record, replay byte-identically
node examples/custom-channel.mjs

# 2. a JS plugin adapter (PAE, L0): foreign in-process tools through the gateway
node examples/js-pae-plugin.mjs

# 3. an MCP adapter (PAE, L2): a real stdio child process, handshake-discovered
node examples/mcp-adapter.mjs

# 4. the orbit CLI record → replay → diff loop, driven exactly as a user would
node examples/cli-record-replay.mjs
```

| Example | Shows |
|---|---|
| `custom-channel.mjs` | Implementing `IChannelProvider`, registering it, and proving the record → replay loop is byte-identical — plus drift detection when a call is tampered with |
| `js-pae-plugin.mjs` | Mapping plain JS functions onto the capability contract via `JsPaeAdapter`; the adapter surface becomes a governed channel whose output replays verbatim |
| `mcp-adapter.mjs` | Spawning a real MCP server child, `initialize` → `tools/list` handshake, recorded call, then replay **after the peer is dead** (the frozen output is injected, the child is never re-entered) |
| `cli-record-replay.mjs` | The three-command reproducibility story: `orbit record` → `orbit replay` (zero channel calls) → `orbit diff` (digest-chain reconciliation) |

The imports use relative paths so the examples run inside the repository;
after `npm i orbit-agent-runtime` they become plain package imports:

```js
import { OrbitRuntimeHost, ChannelKind } from "orbit-agent-runtime";
```

Every example exits non-zero on any failed assertion, so they can be used as
smoke checks in CI (`node examples/custom-channel.mjs && ...`).
