# Developer guide · writing a replayable channel

> Audience: you want to add a new external capability (a model provider, a
> database, a tool) to Orbit and have it **replayable** — recordable on a live
> run and reproducible with zero real calls.

Orbit's whole value proposition is *reproducibility*. A channel is replayable
when, given the same input, the recorded output can be replayed verbatim. This
guide shows the three things a channel must do to earn that property.

---

## 1. The channel contract

Every capability is an `IChannelProvider`. You implement a fixed interface and
declare a **determinism contract**:

```ts
import type { ChannelCallCtx } from "../types/orbitDomain";
import type { ChannelRuntimeMeta } from "../replay/determinism";
import type { IChannelProvider } from "../IChannelProvider";

export class MyChannel implements IChannelProvider {
  public readonly determinismMeta: ChannelRuntimeMeta = {
    // see §2 — pick the right level for your capability
    determinism: DeterminismLevel.IO_BOUND,
    replayPolicy: "inject"
  };

  public async setup(_ctx: ChannelCallCtx): Promise<void> { /* acquire resources */ }
  public async teardown(): Promise<void> { /* release resources */ }

  // ... your capability methods, dispatched dynamically by the hub ...
}
```

The hub calls your methods by name through `fireChannelCall(kind, ctx, funcName, ...args)`.
Method dispatch is **dynamic** — the host does not know your method names at
compile time, so name them clearly and keep them JSON-serializable in/out.

## 2. Pick a determinism level

This is the replay contract. Get it wrong and replay will silently drift.

| Level | Meaning | Replay strategy | Example |
|---|---|---|---|
| `DETERMINISTIC` | same input ⇒ same output, no external state | recompute on replay | a pure hash, a formatter |
| `STOCHASTIC` | sampling/randomness inside | inject a seed via `ctx.rng`; **never call `Math.random`** | an LLM completion |
| `IO_BOUND` | touches external state (disk, process, network) | snapshot the output and **inject** it on replay | File / Shell / LLM |

```ts
import { DeterminismLevel } from "../types/orbitDomain";

determinismMeta = { determinism: DeterminismLevel.STOCHASTIC, replayPolicy: "seed" };
```

**The single hard rule:** a channel must never call `Math.random()` or
`Date.now()` directly. It must read its randomness/clock from the injected
`ctx.rng` / `ctx.clock`. This is a宪章 (VISION) gate — the `replay_compat`
suite poisons `Math.random` and fails any channel that touches it.

## 3. How record / replay actually work

```
RECORD:  script -> hub.fireChannelCall -> your method runs -> output appended to RecordJournal
REPLAY:  script -> hub.fireChannelCall (replayMode="replay")
                       -> replay FAST PATH serves the recorded output
                       -> your method is NEVER called
```

Two consequences:

1. **Replay never executes your code.** It needs only the recorded output
   snapshot. A trace can replay on a machine with none of your dependencies
   installed — no credentials, no tools, no network.
2. **Your output must be JSON-serializable.** The hub snapshots it with
   `structuredClone` into the journal; on replay it is injected back as-is.
   Return plain objects/arrays/strings, not class instances or `Buffer`
   (encode `Buffer` as base64 if you must).

## 4. A minimal IO_BOUND example

```ts
export class EchoChannel implements IChannelProvider {
  public readonly determinismMeta = {
    determinism: DeterminismLevel.IO_BOUND,
    replayPolicy: "inject" as const
  };
  public async setup(): Promise<void> {}
  public async teardown(): Promise<void> {}

  /** Returns a plain object so it snapshots and reconciles cleanly. */
  public async echo(text: string): Promise<{ echoed: string; at: number }> {
    return { echoed: text, at: Date.now() }; // Date.now is fine here:
                                              // replay injects the snapshot,
                                              // your code does not run on replay
  }
}
```

Trap: if `echo` returned a class instance, `structuredClone` would flatten it
and replay would inject a plain object — your caller would get the wrong type.
Return plain shapes.

## 5. Wire it in (two ways)

**A. Host API** — register as a plugin-ext channel; it overrides the built-in
of the same `ChannelKind`:

```ts
host.channelHub.registerPluginExtChannel(ChannelKind.MEM_KV_STORE, new EchoChannel());
await host.channelHub.getEffectiveChannel(ChannelKind.MEM_KV_STORE)!.setup(ctx);
```

**B. `orbit` CLI** — add it to `orbit.config.json` under `file` / `shell` /
`llm`, or extend the CLI's `buildHost()` in `bin/orbit.mjs` for a new
`ChannelKind`. The CLI records/replays your channel for free once it is
registered.

## 6. Prove it replays (required)

Every new channel needs a `replay_compat` case. The pattern:

```ts
test("EchoChannel: record -> replay is byte-identical, zero real calls", async () => {
  const host = new OrbitRuntimeHost();
  await host.bootHost();
  host.channelHub.registerPluginExtChannel(ChannelKind.MEM_KV_STORE, new EchoChannel());

  // record
  const journal = host.beginRecording();
  const out1 = await host.channelHub.fireChannelCall(ChannelKind.MEM_KV_STORE, recCtx(), "echo", "hi");

  // replay — no EchoChannel instance, output served from journal
  const replayJournal = host.beginRecording();
  host.attachReplayEngine(journal);
  const out2 = await host.channelHub.fireChannelCall(ChannelKind.MEM_KV_STORE, repCtx(), "echo", "hi");

  assert.deepEqual(out2, out1);
  const report = new ReplayEngine(journal).reconcile(journal.snapshot(), replayJournal.snapshot());
  assert.equal(report.digestChainConsistent, true);
});
```

If you can delete the channel implementation and the replay still returns
identical output, the channel is replayable. That is the bar.

## 7. Checklist before opening a PR

- [ ] `determinismMeta` set to the correct level
- [ ] no `Math.random` / `Date.now` used for *decisions* (only for telemetry that is never replayed)
- [ ] all capability methods return JSON-serializable plain values
- [ ] side effects (writes) return small deterministic values so they reconcile
- [ ] a `replay_compat`-style test exists (record → zero-call replay → reconcile)
- [ ] `npm test` green; `npm run build` strict-clean; zero new runtime deps
