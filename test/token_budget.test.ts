import { test } from "node:test";
import assert from "node:assert/strict";
import { TokenBudgetEngine, DEFAULT_TOKEN_BUDGET_CONFIG } from "../src/gateway/TokenBudgetEngine";

// A tight config so thresholds are easy to assert against.
const TIGHT: typeof DEFAULT_TOKEN_BUDGET_CONFIG = {
  maxTokensPerCall: 100,
  compressAboveTokens: 50,
  trimRatio: { conservative: 0.9, normal: 0.5, aggressive: 0.25 },
  enabled: true
};

test("engine: token estimate is deterministic and punctuation-aware", () => {
  const e = new TokenBudgetEngine(TIGHT);
  assert.equal(e.estimateTokens(""), 0);
  assert.equal(e.estimateTokens("hello world"), 2);
  assert.equal(e.estimateTokens("the quick brown fox jumps"), 5);
  // Pure function: identical input -> identical output.
  assert.equal(e.estimateTokens("hello world"), e.estimateTokens("hello world"));
  // CJK letters also count as word-runs.
  assert.equal(e.estimateTokens("你好 世界"), 2);
});

test("engine: compress is a pure, deterministic head-trim (no invention/reorder)", () => {
  const e = new TokenBudgetEngine(TIGHT);
  const long = Array(60).fill("tok").join(" "); // 60 tokens > 50 threshold
  const a = e.compress(long, "normal");
  const b = e.compress(long, "normal");
  assert.equal(a.applied, true);
  assert.equal(a.level, "normal");
  // Deterministic: same output every call.
  assert.equal(a.text, b.text);
  assert.equal(a.estimatedTokens, 30); // keep 50% of 60
  // Head trim: the first 30 tokens are preserved verbatim.
  assert.equal(a.text, Array(30).fill("tok").join(" "));
});

test("engine: compress is a no-op below the threshold", () => {
  const e = new TokenBudgetEngine(TIGHT);
  const short = "one two three"; // 3 tokens
  const r = e.compress(short, "aggressive");
  assert.equal(r.applied, false);
  assert.equal(r.text, short);
});

test("engine: budgetPolicy reflects cumulative usage (normal -> shrink -> stop)", () => {
  const e = new TokenBudgetEngine(TIGHT); // compressAbove=50, max=100
  assert.deepEqual(e.budgetPolicy("p1"), { allow: true, strategy: "normal" });
  e.account("p1", 60); // now above compressAboveTokens
  assert.deepEqual(e.budgetPolicy("p1"), { allow: true, strategy: "shrink" });
  e.account("p1", 60); // now above maxTokensPerCall
  assert.deepEqual(e.budgetPolicy("p1"), { allow: false, strategy: "stop" });
});

test("engine: disabled config is a pass-through (always allow/normal)", () => {
  const e = new TokenBudgetEngine({ ...TIGHT, enabled: false });
  e.account("p1", 9999);
  assert.deepEqual(e.budgetPolicy("p1"), { allow: true, strategy: "normal" });
  assert.equal(e.compress("a b c d e".repeat(100)).applied, false);
});

test("engine: compressionPolicyFor scales with estimated size", () => {
  const e = new TokenBudgetEngine(TIGHT); // compressAbove=50
  assert.deepEqual(e.compressionPolicyFor(10), { level: "conservative", applied: false });
  assert.deepEqual(e.compressionPolicyFor(45), { level: "normal", applied: true });
  assert.deepEqual(e.compressionPolicyFor(80), { level: "aggressive", applied: true });
});

test("engine: configHash is stable per config and changes with the thresholds", () => {
  const a = new TokenBudgetEngine(DEFAULT_TOKEN_BUDGET_CONFIG).configHash();
  const b = new TokenBudgetEngine(DEFAULT_TOKEN_BUDGET_CONFIG).configHash();
  assert.equal(a, b); // stable across instances
  const c = new TokenBudgetEngine({ ...DEFAULT_TOKEN_BUDGET_CONFIG, maxTokensPerCall: 4096 }).configHash();
  assert.notEqual(a, c); // drift is detectable
});
