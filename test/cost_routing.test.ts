import { test } from "node:test";
import assert from "node:assert/strict";
import { CostRouter } from "../src/routing/cost_routing";
import { ChannelKind } from "../src/types/orbitDomain";

test("choose: picks the cheapest fitting channel", () => {
  const router = new CostRouter();
  router.register(ChannelKind.LLM_ACCESS, { costPerCall: 5, latencyMs: 100, quality: 1 });
  router.register(ChannelKind.MEM_KV_STORE, { costPerCall: 1, latencyMs: 10, quality: 0.9 });
  const kind = router.choose([ChannelKind.LLM_ACCESS, ChannelKind.MEM_KV_STORE], 10, 500);
  assert.equal(kind, ChannelKind.MEM_KV_STORE);
});

test("choose: budget filter rejects expensive channels", () => {
  const router = new CostRouter();
  router.register(ChannelKind.LLM_ACCESS, { costPerCall: 5, latencyMs: 100, quality: 1 });
  assert.equal(router.choose([ChannelKind.LLM_ACCESS], 3, 500), undefined);
});

test("choose: latency filter rejects slow channels", () => {
  const router = new CostRouter();
  router.register(ChannelKind.LLM_ACCESS, { costPerCall: 1, latencyMs: 320, quality: 1 });
  assert.equal(router.choose([ChannelKind.LLM_ACCESS], 10, 100), undefined);
});

test("choose: no candidates yields undefined", () => {
  const router = new CostRouter();
  assert.equal(router.choose([ChannelKind.LLM_ACCESS], 10, 500), undefined);
});
