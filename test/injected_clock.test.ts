/**
 * Determinism regression for every time-dependent decision that reaches a
 * recorded value (charter A1).
 *
 * A component that reads the real clock makes its outcome depend on *when* the
 * run happened, so two recordings of the same input can disagree and replay
 * reports a drift that never existed. Both components here therefore take an
 * injected `ClockSource`, and with a frozen clock their behaviour must be
 * perfectly constant — with a pushed clock it must flip exactly where the
 * configured window says it should, and nowhere else.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { TripProtector, MemoryKvChannel, ChannelHub } from "../src/index";
import { TripState, ChannelKind, ChannelCallCtx, DeterminismLevel } from "@orbit/infra-common";

/** A clock the test drives by hand, so no assertion can depend on real time. */
class ManualClock {
  private current: number;

  public constructor(start = 1_000_000) {
    this.current = start;
  }

  public now(): number {
    return this.current;
  }

  public advance(ms: number): void {
    this.current += ms;
  }
}

function makeCtx(overrides: Partial<ChannelCallCtx> = {}): ChannelCallCtx {
  return { traceMarkId: "t-1", maxWaitMs: 1000, ...overrides };
}

/* --------------------------------------------------------- TripProtector */

test("trip protector: a frozen clock keeps the trip decision constant", async () => {
  const clock = new ManualClock();
  const trip = new TripProtector(1, 10_000, clock);
  const fail = async (): Promise<string> => {
    throw new Error("boom");
  };

  await assert.rejects(trip.execWithProtect(fail));
  assert.equal(trip.snapshot().state, TripState.TRIPPED);

  // The clock never moves, so the cooldown never elapses — no matter how many
  // times the decision is read, or how long the test actually takes.
  for (let i = 0; i < 50; i += 1) {
    assert.equal(trip.preCallCheck(), false);
  }
  await assert.rejects(trip.execWithProtect(fail), /trip protector active/);
});

test("trip protector: advancing the injected clock past the cooldown flips the decision", async () => {
  const clock = new ManualClock();
  const trip = new TripProtector(1, 10_000, clock);
  const fail = async (): Promise<string> => {
    throw new Error("boom");
  };

  await assert.rejects(trip.execWithProtect(fail));
  assert.equal(trip.snapshot().state, TripState.TRIPPED);

  // One millisecond short of the window: still blocked.
  clock.advance(10_000);
  assert.equal(trip.preCallCheck(), false, "the cooldown is strict (>)");

  // Across the boundary: the probe is allowed again.
  clock.advance(1);
  assert.equal(trip.preCallCheck(), true);
  assert.equal(await trip.execWithProtect(async () => "ok"), "ok");
  assert.equal(trip.snapshot().state, TripState.NORMAL);
});

test("trip protector: the recorded trippedAt comes from the injected clock, not the wall clock", async () => {
  const clock = new ManualClock(5_000);
  const trip = new TripProtector(2, 1_000, clock);
  const fail = async (): Promise<string> => {
    throw new Error("boom");
  };

  await assert.rejects(trip.execWithProtect(fail));
  await assert.rejects(trip.execWithProtect(fail));
  assert.equal(trip.snapshot().state, TripState.TRIPPED);

  // Wall-clock time here is ~now (a huge number); the injected clock reads
  // 5000. If the protector had taken its timestamp from Date.now(), advancing
  // the injected clock by ~1s would not come close to the cooldown.
  clock.advance(999);
  assert.equal(trip.preCallCheck(), false);
  clock.advance(2);
  assert.equal(trip.preCallCheck(), true);
});

test("trip protector: no injected clock keeps the previous real-clock behaviour", async () => {
  const trip = new TripProtector(1, 20);
  const fail = async (): Promise<string> => {
    throw new Error("boom");
  };
  await assert.rejects(trip.execWithProtect(fail));
  assert.equal(trip.snapshot().state, TripState.TRIPPED);
  assert.equal(trip.preCallCheck(), false);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(trip.preCallCheck(), true, "the cooldown still elapses on the real clock");
});

/* -------------------------------------------------------- MemoryKvChannel */

test("kv channel: a frozen clock makes TTL reads perfectly reproducible", async () => {
  const clock = new ManualClock();
  const kv = new MemoryKvChannel(clock);
  await kv.setup(makeCtx());

  await kv.writeEntry("k", "v", 1_000);
  // Read repeatedly at the same instant: the value never flips, so a recording
  // of this script is byte-identical every time.
  for (let i = 0; i < 50; i += 1) {
    assert.equal(await kv.readEntry("k"), "v");
  }
  await kv.teardown();
});

test("kv channel: TTL expiry is decided by the injected clock", async () => {
  const clock = new ManualClock();
  const kv = new MemoryKvChannel(clock);
  await kv.setup(makeCtx());

  await kv.writeEntry("k", "v", 1_000);

  // Exactly at the expiry instant: not yet expired (the check is strict >).
  clock.advance(1_000);
  assert.equal(await kv.readEntry("k"), "v");

  // One millisecond past: expired, and the entry is evicted.
  clock.advance(1);
  assert.equal(await kv.readEntry("k"), null);
  await kv.teardown();
});

test("kv channel: ttl <= 0 never expires, whatever the injected clock does", async () => {
  const clock = new ManualClock();
  const kv = new MemoryKvChannel(clock);
  await kv.setup(makeCtx());

  await kv.writeEntry("forever", "v", 0);
  await kv.writeEntry("negative", "v", -5);
  clock.advance(Number.MAX_SAFE_INTEGER / 2);
  assert.equal(await kv.readEntry("forever"), "v");
  assert.equal(await kv.readEntry("negative"), "v");
  await kv.teardown();
});

test("kv channel: the expiration timestamp is written from the injected clock", async () => {
  const clock = new ManualClock(7_000);
  const kv = new MemoryKvChannel(clock);
  await kv.setup(makeCtx());

  // Written at t=7000 with a 1000ms TTL -> expires just after t=8000.
  await kv.writeEntry("k", "v", 1_000);
  clock.advance(900);
  assert.equal(await kv.readEntry("k"), "v", "t=7900: still live");
  clock.advance(100);
  assert.equal(await kv.readEntry("k"), "v", "t=8000: boundary, still live");
  clock.advance(1);
  assert.equal(await kv.readEntry("k"), null, "t=8001: expired");
  await kv.teardown();
});

/* ------------------------------------------------- setup() idempotency */

test("kv channel: a second setup() replaces the sweep timer instead of leaking it", async () => {
  const kv = new MemoryKvChannel(new ManualClock());
  const ctx = makeCtx();

  await kv.setup(ctx);
  const timer = (kv as unknown as { sweepTimer: NodeJS.Timeout | null }).sweepTimer;
  assert.ok(timer, "setup installs a sweep timer");

  await kv.setup(ctx);
  const second = (kv as unknown as { sweepTimer: NodeJS.Timeout | null }).sweepTimer;
  assert.ok(second, "the second setup installs a fresh timer");
  // The original interval must have been cleared — otherwise it keeps firing
  // for the lifetime of the process, sweeping a map nobody owns any more.
  assert.notEqual(second, timer);

  // Teardown clears the live one, so no sweeper survives the channel.
  await kv.teardown();
  assert.equal((kv as unknown as { sweepTimer: NodeJS.Timeout | null }).sweepTimer, null);
});

test("kv channel: teardown after two setup() calls leaves no live handle", async () => {
  const kv = new MemoryKvChannel(new ManualClock());
  await kv.setup(makeCtx());
  await kv.setup(makeCtx());
  await kv.teardown();
  // If the first timer had survived, the process could not exit while it was
  // still armed; asserting the handle is gone is the observable proxy.
  assert.equal((kv as unknown as { sweepTimer: NodeJS.Timeout | null }).sweepTimer, null);
});

/* -------------------------------------------- hub-level reproducibility */

test("kv channel over the hub: the same frozen-clock script records identical outputs", async () => {
  async function run(): Promise<Array<string | null>> {
    const clock = new ManualClock();
    const kv = new MemoryKvChannel(clock);
    const hub = new ChannelHub();
    hub.registerBuiltInChannel(ChannelKind.MEM_KV_STORE, kv);
    await hub.setupAllBuiltInChannels(makeCtx());
    await hub.fireChannelCall<void>(ChannelKind.MEM_KV_STORE, makeCtx(), "writeEntry", "k", "v", 1_000);

    const first = await hub.fireChannelCall<string>(ChannelKind.MEM_KV_STORE, makeCtx(), "readEntry", "k");
    clock.advance(1_001);
    const second = await hub.fireChannelCall<string>(ChannelKind.MEM_KV_STORE, makeCtx(), "readEntry", "k");
    await hub.teardown();
    return [first, second];
  }

  // Two independent runs of the same script: identical, because the only clock
  // involved is the one the test drives.
  assert.deepEqual(await run(), ["v", null]);
  assert.deepEqual(await run(), ["v", null]);
});

test("kv channel exposes its IO-bound determinism metadata", async () => {
  const kv = new MemoryKvChannel(new ManualClock());
  assert.equal(kv.determinismMeta.determinism, DeterminismLevel.IO_BOUND);
  assert.equal(kv.determinismMeta.replayPolicy, "inject");
});
