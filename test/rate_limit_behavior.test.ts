import { test } from "node:test";
import assert from "node:assert/strict";
import { RateLimiter, DEFAULT_RATE_LIMIT_CONFIG } from "../src/gateway/RateLimiter";
import { BehaviorCollector } from "../src/gateway/BehaviorCollector";
import type { BehaviorNote } from "../src/types/orbitDomain";
import type { GatewayCallRecord } from "../src/replay/record_journal";

// ---------------------------------------------------------------------------
// RateLimiter (W11): pure, deterministic, replay-safe call-count budget
// ---------------------------------------------------------------------------

test("rateLimiter: starts unlimited and decrements remaining on acquire", () => {
  const limiter = new RateLimiter({ maxCallsPerWindow: 3, windowSizeCalls: 3 });
  assert.equal(limiter.remaining("p1"), 3);
  assert.equal(limiter.isLimited("p1"), false);

  assert.equal(limiter.acquire("p1"), true);
  assert.equal(limiter.remaining("p1"), 2);
  assert.equal(limiter.acquire("p1"), true);
  assert.equal(limiter.remaining("p1"), 1);
  assert.equal(limiter.isLimited("p1"), false);
});

test("rateLimiter: becomes limited after the window is exhausted, and never over-consumes", () => {
  const limiter = new RateLimiter({ maxCallsPerWindow: 2, windowSizeCalls: 2 });
  assert.equal(limiter.acquire("p1"), true);
  assert.equal(limiter.acquire("p1"), true);
  assert.equal(limiter.remaining("p1"), 0);
  assert.equal(limiter.isLimited("p1"), true);
  // Exhausted: acquire fails and remaining stays at 0 (no negative / no overflow).
  assert.equal(limiter.acquire("p1"), false);
  assert.equal(limiter.remaining("p1"), 0);
  assert.equal(limiter.isLimited("p1"), true);
});

test("rateLimiter: per-plugin isolation and reset", () => {
  const limiter = new RateLimiter(DEFAULT_RATE_LIMIT_CONFIG);
  limiter.acquire("a");
  assert.equal(limiter.remaining("a"), DEFAULT_RATE_LIMIT_CONFIG.maxCallsPerWindow - 1);
  assert.equal(limiter.remaining("b"), DEFAULT_RATE_LIMIT_CONFIG.maxCallsPerWindow); // untouched
  limiter.reset("a");
  assert.equal(limiter.remaining("a"), DEFAULT_RATE_LIMIT_CONFIG.maxCallsPerWindow);
  limiter.reset();
  assert.equal(limiter.remaining("b"), DEFAULT_RATE_LIMIT_CONFIG.maxCallsPerWindow);
});

// ---------------------------------------------------------------------------
// BehaviorCollector (W11): three modes — record / live / replay
// ---------------------------------------------------------------------------

function sampleNote(): BehaviorNote {
  return {
    channelKind: "mem-kv-store",
    funcName: "readEntry",
    pluginId: "p1",
    route: "native",
    compression: { level: "normal", applied: false, bytesSaved: 0 },
    budget: { allow: true, strategy: "normal" },
    rateLimited: false,
    tokensEstimated: 0,
    recordedAtMode: "record"
  };
}

test("behaviorCollector: record mode attaches the note to the journal record", () => {
  const collector = new BehaviorCollector();
  const record = { behavior: undefined } as unknown as GatewayCallRecord;
  const ret = collector.collect("record", sampleNote(), record);
  assert.ok(ret);
  assert.equal(record.behavior?.channelKind, "mem-kv-store");
  assert.equal(record.behavior?.recordedAtMode, "record");
});

test("behaviorCollector: live mode returns a proposal and does NOT persist", () => {
  const collector = new BehaviorCollector();
  const note = sampleNote(); // note carries whatever mode the gateway set
  // Even if a record is passed, live mode must NOT attach to it (no persistence).
  const record = { behavior: undefined } as unknown as GatewayCallRecord;
  const ret = collector.collect("live", note, record);
  assert.ok(ret, "live mode still returns the proposal");
  assert.equal(record.behavior, undefined, "live mode never persists to the record");
});

test("behaviorCollector: replay mode is a bypass (returns null)", () => {
  const collector = new BehaviorCollector();
  const record = { behavior: undefined } as unknown as GatewayCallRecord;
  const ret = collector.collect("replay", sampleNote(), record);
  assert.equal(ret, null);
  // The stored record is left untouched by the bypass.
  assert.equal(record.behavior, undefined);
});
