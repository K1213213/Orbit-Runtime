import { test } from "node:test";
import assert from "node:assert/strict";
import { DeepSeekChannel, OpenAICompatChannel } from "../src/channel/providers/openai_compat_channel";

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

test("DeepSeekChannel: requires an api key field (empty allowed for unauthenticated endpoints)", () => {
  assert.throws(() => new DeepSeekChannel({ apiKey: undefined as unknown as string }), /apiKey/);
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
  await assert.rejects(channel.chatRound("hi"), /LLM API error 401: invalid key/);
});

test("DeepSeekChannel: non-JSON responses fail with a friendly error", async () => {
  const channel = new DeepSeekChannel({
    apiKey: "sk-test",
    fetchImpl: (async () => ({
      ok: false,
      status: 502,
      statusText: "Bad Gateway",
      json: async () => {
        throw new SyntaxError("Unexpected token '<'");
      }
    })) as unknown as typeof fetch
  });
  await assert.rejects(channel.chatRound("hi"), /LLM API returned a non-JSON response \(HTTP 502\)/);
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

test("OpenAICompatChannel: works against any compatible endpoint", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const channel = new OpenAICompatChannel({
    apiKey: "sk-ollama",
    baseUrl: "http://localhost:11434/v1",
    model: "llama3",
    fetchImpl: fakeFetchOk("local answer", calls)
  });
  const out = await channel.chatRound("hi");
  assert.equal(out, "local answer");
  assert.equal(calls[0].url, "http://localhost:11434/v1/chat/completions");
  const body = JSON.parse(String(calls[0].init.body)) as { model: string };
  assert.equal(body.model, "llama3");
});

test("OpenAICompatChannel: requires an api key field (empty allowed for unauthenticated endpoints)", () => {
  assert.throws(
    () => new OpenAICompatChannel({ apiKey: undefined as unknown as string, baseUrl: "https://x" }),
    /apiKey/
  );
  // empty key is legal: local endpoints like Ollama need no auth
  const channel = new OpenAICompatChannel({ apiKey: "", baseUrl: "http://localhost:11434/v1" });
  assert.ok(channel);
});

test("OpenAICompatChannel: omits Authorization header when key is empty", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const channel = new OpenAICompatChannel({
    apiKey: "",
    baseUrl: "http://localhost:11434/v1",
    fetchImpl: fakeFetchOk("local", calls)
  });
  await channel.chatRound("hi");
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers.Authorization, undefined);
});

test("OpenAICompatChannel: timeout surfaces a friendly error", async () => {
  const timeoutError = new Error("The operation was aborted due to timeout");
  timeoutError.name = "TimeoutError";
  const channel = new OpenAICompatChannel({
    apiKey: "sk-test",
    baseUrl: "https://x",
    fetchImpl: (async () => {
      throw timeoutError;
    }) as unknown as typeof fetch
  });
  await assert.rejects(channel.chatRound("hi"), /timed out/);
});
