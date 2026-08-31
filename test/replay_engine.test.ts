import { test } from "node:test";
import assert from "node:assert/strict";
import { SeededRng, FixedClock } from "@orbit/core-hub";
import { RecordJournal } from "@orbit/core-hub";
import { ReplayEngine, ReplayDriftError } from "@orbit/core-hub";
import { digestInputs } from "@orbit/infra-common";
import { ChannelHub } from "@orbit/core-hub";
import { LlmMockChannel } from "@orbit/core-hub";
import { ChannelKind, ChannelCallCtx } from "@orbit/infra-common";

function makeCtx(overrides: Partial<ChannelCallCtx> = {}): ChannelCallCtx {
  return { traceMarkId: "t-1", maxWaitMs: 5000, ...overrides };
}

test("SeededRng: same seed yields the identical sequence", () => {
  const a = new SeededRng(42);
  const b = new SeededRng(42);
  assert.deepEqual([a.next(), a.next(), a.next()], [b.next(), b.next(), b.next()]);
});

test("SeededRng: different seeds diverge", () => {
  const a = new SeededRng(1);
  const b = new SeededRng(2);
  assert.notEqual(a.next(), b.next());
});

test("FixedClock: monotonic deterministic timestamps", () => {
  const clock = new FixedClock(1_000);
  assert.equal(clock.now(), 1_000);
  assert.equal(clock.now(), 1_001);
  assert.equal(clock.now(), 1_002);
});

test("RecordJournal: append assigns orderIndex and supports lookup", () => {
  const journal = new RecordJournal();
  journal.append({ channelKind: ChannelKind.LLM_ACCESS, funcName: "f", inputDigest: "a", outputSnapshot: "x", durationMs: 1 });
  journal.append({ channelKind: ChannelKind.LLM_ACCESS, funcName: "f", inputDigest: "b", outputSnapshot: "y", durationMs: 1 });
  assert.equal(journal.size(), 2);
  assert.equal(journal.get(0)?.outputSnapshot, "x");
  assert.equal(journal.get(1)?.orderIndex, 1);
  assert.equal(journal.get(9), undefined);
});

test("ReplayEngine: replayCall serves the frozen output", () => {
  const journal = new RecordJournal();
  const engine = new ReplayEngine(journal);
  const digest = digestInputs("hello");
  journal.append({ channelKind: ChannelKind.LLM_ACCESS, funcName: "chatRound", inputDigest: digest, outputSnapshot: "hello-back", durationMs: 320 });
  const out = engine.replayCall(ChannelKind.LLM_ACCESS, "chatRound", digest, 0);
  assert.equal(out, "hello-back");
});

test("ReplayEngine: missing call and signature drift throw ReplayDriftError", () => {
  const journal = new RecordJournal();
  const engine = new ReplayEngine(journal);
  const digest = digestInputs("x");
  journal.append({ channelKind: ChannelKind.LLM_ACCESS, funcName: "chatRound", inputDigest: digest, outputSnapshot: "o", durationMs: 1 });
  assert.throws(() => engine.replayCall(ChannelKind.LLM_ACCESS, "chatRound", digest, 5), ReplayDriftError);
  assert.throws(() => engine.replayCall(ChannelKind.MEM_KV_STORE, "chatRound", digest, 0), ReplayDriftError);
});

test("Reconcile: identical chains pass, tampered output is located", () => {
  const journal = new RecordJournal();
  const digest = digestInputs("q");
  journal.append({ channelKind: ChannelKind.LLM_ACCESS, funcName: "f", inputDigest: digest, outputSnapshot: "answer", durationMs: 1 });
  const engine = new ReplayEngine(journal);

  const replayed = journal.snapshot();
  const ok = engine.reconcile(journal.snapshot(), replayed);
  assert.equal(ok.digestChainConsistent, true);

  const tampered = replayed.map((r) => ({ ...r, outputSnapshot: "tampered" }));
  const bad = engine.reconcile(journal.snapshot(), tampered);
  assert.equal(bad.digestChainConsistent, false);
  assert.equal(bad.driftAtOrderIndex, 0);
});

test("Hub integration: record then replay reproduces identical output", async () => {
  const hub = new ChannelHub();
  hub.registerBuiltInChannel(ChannelKind.LLM_ACCESS, new LlmMockChannel(1));
  await hub.setupAllBuiltInChannels(makeCtx());

  const journal = new RecordJournal();
  hub.attachRecordJournal(journal);
  const live = await hub.fireChannelCall<string>(ChannelKind.LLM_ACCESS, makeCtx({ replayMode: "record" }), "chatRound", "ping");
  assert.equal(journal.size(), 1);

  hub.attachReplayEngine(new ReplayEngine(journal));
  const replayed = await hub.fireChannelCall<string>(ChannelKind.LLM_ACCESS, makeCtx({ replayMode: "replay" }), "chatRound", "ping");
  assert.equal(replayed, live);

  await hub.teardown();
});
