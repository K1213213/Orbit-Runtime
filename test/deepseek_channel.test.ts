import { test } from "node:test";
import assert from "node:assert/strict";
import { DeepSeekChannel } from "../src/channel/providers/deepseek_channel";

/** Minimal fake fetch returning a canned chat completion. */
function fakeFetchOk(content: string, calls: { url: string; init: RequestInit }[]): typeof fetch {
  return (async (url: unknown, init: unknown) => {
    calls.push({ url: String(url), init: init as RequestInit });
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ choices: [{ message: { role: "assistant", content } }] })
    } as unknown as Response;
  }) as typeof fetch;
}

function fakeFetchError(status: number, message: string): typeof fetch {
  return (async () => ({
    ok: false,
    status,
    statusText: "ERR",
    json: async () => ({ error: { message } })
  })) as unknown as typeof fetch;
}

test("DeepSeekChannel: requires an api key", () => {
  assert.throws(() => new DeepSeekChannel({ apiKey: "" }), /apiKey/);
});

test("DeepSeekChannel: chatRound posts OpenAI-compatible payload and returns content", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const channel = new DeepSeekChannel({
    apiKey: "sk-test",
    model: "deepseek-chat",
    fetchImpl: fakeFetchOk("reproducibility is trust", calls)
  });
  const out = await channel.chatRound("why?");
  assert.equal(out, "reproducibility is trust");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.deepseek.com/chat/completions");
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer sk-test");
  const body = JSON.parse(String(calls[0].init.body)) as { model: string; messages: { role: string }[]; stream: boolean };
  assert.equal(body.model, "deepseek-chat");
  assert.equal(body.messages[0].role, "user");
  assert.equal(body.stream, false);
});

test("DeepSeekChannel: surfaces API errors", async () => {
  const channel = new DeepSeekChannel({ apiKey: "sk-bad", fetchImpl: fakeFetchError(401, "invalid key") });
  await assert.rejects(channel.chatRound("hi"), /DeepSeek API error 401: invalid key/);
});

test("DeepSeekChannel: rejects empty completions", async () => {
  const channel = new DeepSeekChannel({
    apiKey: "sk-test",
    fetchImpl: (async () => ({ ok: true, status: 200, statusText: "OK", json: async () => ({ choices: [] }) })) as unknown as typeof fetch
  });
  await assert.rejects(channel.chatRound("hi"), /no content/);
});

test("DeepSeekChannel: replay contract is stochastic + inject", () => {
  const channel = new DeepSeekChannel({ apiKey: "sk-test", fetchImpl: fakeFetchOk("x", []) });
  assert.deepEqual(channel.determinismMeta, { determinism: "stochastic", seedable: true, replayPolicy: "inject" });
});
