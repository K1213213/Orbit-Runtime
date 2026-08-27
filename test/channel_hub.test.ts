import { test } from "node:test";
import assert from "node:assert/strict";
import { ChannelHub } from "../src/channel/ChannelHub";
import { MemoryKvChannel } from "../src/channel/providers/MemoryKvChannel";
import { LlmMockChannel } from "../src/channel/providers/LlmMockChannel";
import { ChannelKind, ChannelCallCtx, DeterminismLevel } from "../src/types/orbitDomain";

function makeCtx(overrides: Partial<ChannelCallCtx> = {}): ChannelCallCtx {
  return { traceMarkId: "t-1", maxWaitMs: 1000, ...overrides };
}

test("内置通道注册后读写正常", async () => {
  const hub = new ChannelHub();
  hub.registerBuiltInChannel(ChannelKind.MEM_KV_STORE, new MemoryKvChannel());
  await hub.setupAllBuiltInChannels(makeCtx());
  await hub.fireChannelCall<void>(ChannelKind.MEM_KV_STORE, makeCtx(), "writeEntry", "k", "v", 0);
  const val = await hub.fireChannelCall<string>(ChannelKind.MEM_KV_STORE, makeCtx(), "readEntry", "k");
  assert.equal(val, "v");
  await hub.teardown();
});

test("插件扩展通道优先于内置通道", async () => {
  const hub = new ChannelHub();
  hub.registerBuiltInChannel(ChannelKind.LLM_ACCESS, new LlmMockChannel());
  const fake = {
    setup: async () => {},
    teardown: async () => {},
    simulateChatRound: async () => "fake-llm",
    determinismMeta: { determinism: DeterminismLevel.DETERMINISTIC }
  };
  hub.registerPluginExtChannel(ChannelKind.LLM_ACCESS, fake);
  const out = await hub.fireChannelCall<string>(
    ChannelKind.LLM_ACCESS,
    makeCtx({ maxWaitMs: 5000 }),
    "simulateChatRound",
    "hi"
  );
  assert.equal(out, "fake-llm");
  await hub.teardown();
});

test("重复注册内置通道被拒绝", () => {
  const hub = new ChannelHub();
  hub.registerBuiltInChannel(ChannelKind.MEM_KV_STORE, new MemoryKvChannel());
  assert.throws(() => hub.registerBuiltInChannel(ChannelKind.MEM_KV_STORE, new MemoryKvChannel()));
});

test("超时截断保护生效", async () => {
  const hub = new ChannelHub();
  const slow = {
    setup: async () => {},
    teardown: async () => {},
    hang: () => new Promise<void>(() => {}),
    determinismMeta: { determinism: DeterminismLevel.DETERMINISTIC }
  };
  hub.registerBuiltInChannel(ChannelKind.MEM_KV_STORE, slow);
  await assert.rejects(
    hub.fireChannelCall<void>(ChannelKind.MEM_KV_STORE, makeCtx({ maxWaitMs: 50 }), "hang"),
    /channel call exceeded/
  );
  await hub.teardown();
});

test("插件能力裁决：未声明权限被拒绝，宿主调用不受限", async () => {
  const hub = new ChannelHub();
  hub.registerBuiltInChannel(ChannelKind.MEM_KV_STORE, new MemoryKvChannel());
  hub.attachCapabilityGate((pluginId, kind, funcName) => {
    return !(kind === ChannelKind.MEM_KV_STORE && funcName === "writeEntry");
  });
  await assert.rejects(
    hub.fireChannelCall<void>(ChannelKind.MEM_KV_STORE, makeCtx({ pluginUnitId: "p1" }), "writeEntry", "k", "v", 0),
    /lacks capability for channel/
  );
  // 无 pluginUnitId 的宿主侧调用不受裁决限制
  await hub.fireChannelCall<void>(ChannelKind.MEM_KV_STORE, makeCtx(), "writeEntry", "k", "v", 0);
  await hub.teardown();
});
