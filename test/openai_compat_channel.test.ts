import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DeepSeekChannel,
  OpenAICompatChannel,
  LlmChannelFaultError,
  isRetryableLlmFault
} from "@orbit/core-hub";

interface RecordedCall {
  url: string;
  init: RequestInit;
}

/** Minimal fake fetch returning a canned chat completion. */
function fakeFetchOk(content: string, calls: RecordedCall[]): typeof fetch {
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

/** Fake fetch that fails N times with the given status, then succeeds. */
function fakeFetchRetrySequence(
  failures: { status: number; retryAfter?: string }[],
  finalContent: string,
  calls: RecordedCall[]
): typeof fetch {
  let attempt = 0;
  return (async (url: unknown, init: unknown) => {
    calls.push({ url: String(url), init: init as RequestInit });
    const failure = failures[attempt];
    attempt += 1;
    if (failure) {
      const headers = new Map<string, string>();
      if (failure.retryAfter !== undefined) headers.set("retry-after", failure.retryAfter);
      return {
        ok: false,
        status: failure.status,
        statusText: "ERR",
        headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
        json: async () => ({ error: { message: `attempt ${attempt} failed` } })
      } as unknown as Response;
    }
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ choices: [{ message: { role: "assistant", content: finalContent } }] })
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

// ------------------------------------------------------------- construction

test("DeepSeekChannel: requires an api key field (empty allowed for unauthenticated endpoints)", () => {
  assert.throws(() => new DeepSeekChannel({ apiKey: undefined as unknown as string }), /apiKey/);
});

// ------------------------------------------------------------- happy path

test("DeepSeekChannel: chatRound posts OpenAI-compatible payload and returns content", async () => {
  const calls: RecordedCall[] = [];
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

test("OpenAICompatChannel: works against any compatible endpoint", async () => {
  const calls: RecordedCall[] = [];
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
  const calls: RecordedCall[] = [];
  const channel = new OpenAICompatChannel({
    apiKey: "",
    baseUrl: "http://localhost:11434/v1",
    fetchImpl: fakeFetchOk("local", calls)
  });
  await channel.chatRound("hi");
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers.Authorization, undefined);
});

// ----------------------------------------------------- per-call options

test("chatRound: opts.messages replaces the single user prompt", async () => {
  const calls: RecordedCall[] = [];
  const channel = new OpenAICompatChannel({
    apiKey: "sk-test",
    baseUrl: "https://x",
    fetchImpl: fakeFetchOk("ok", calls)
  });
  await channel.chatRound("ignored-when-messages-present", {
    messages: [
      { role: "system", content: "be terse" },
      { role: "user", content: "hello" }
    ]
  });
  const body = JSON.parse(String(calls[0].init.body)) as { messages: { role: string; content: string }[] };
  assert.deepEqual(
    body.messages.map((m) => m.role),
    ["system", "user"]
  );
});

test("chatRound: per-call seed/temperature/maxTokens/response_format override config", async () => {
  const calls: RecordedCall[] = [];
  const channel = new OpenAICompatChannel({
    apiKey: "sk-test",
    baseUrl: "https://x",
    temperature: 0.9,
    fetchImpl: fakeFetchOk("ok", calls)
  });
  await channel.chatRound("hi", { temperature: 0, seed: 42, maxTokens: 128, responseFormat: "json" });
  const body = JSON.parse(String(calls[0].init.body)) as Record<string, unknown>;
  assert.equal(body.temperature, 0);
  assert.equal(body.seed, 42);
  assert.equal(body.max_tokens, 128);
  assert.deepEqual(body.response_format, { type: "json" });
});

// ------------------------------------------------------ fault taxonomy

test("fault taxonomy: retryable vs non-retryable kinds", () => {
  for (const kind of ["timeout", "network", "rate_limited", "server_error"] as const) {
    assert.equal(isRetryableLlmFault(kind), true, kind);
  }
  for (const kind of ["auth", "bad_request", "not_found", "no_content", "invalid_response"] as const) {
    assert.equal(isRetryableLlmFault(kind), false, kind);
  }
});

test("chatRound: HTTP 401 classifies as non-retryable auth fault", async () => {
  const channel = new DeepSeekChannel({ apiKey: "sk-bad", fetchImpl: fakeFetchError(401, "invalid key") });
  await assert.rejects(
    channel.chatRound("hi"),
    (err: unknown) => {
      assert.ok(err instanceof LlmChannelFaultError);
      assert.equal(err.faultKind, "auth");
      assert.equal(err.httpStatus, 401);
      assert.equal(err.retryable, false);
      assert.match(err.message, /LLM API error 401 \(auth\): invalid key/);
      return true;
    }
  );
});

test("chatRound: non-JSON error bodies classify by status", async () => {
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
  await assert.rejects(
    channel.chatRound("hi"),
    (err: unknown) => {
      assert.ok(err instanceof LlmChannelFaultError);
      assert.equal(err.faultKind, "server_error");
      assert.match(err.message, /502/);
      return true;
    }
  );
});

test("chatRound: network failures classify as retryable network fault", async () => {
  const channel = new DeepSeekChannel({
    apiKey: "sk-test",
    maxRetries: 1,
    initialRetryDelayMs: 1,
    fetchImpl: (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch
  });
  await assert.rejects(
    channel.chatRound("hi"),
    (err: unknown) => {
      assert.ok(err instanceof LlmChannelFaultError);
      assert.equal(err.faultKind, "network");
      assert.equal(err.attempts, 2); // 1 initial + 1 retry
      return true;
    }
  );
});

test("chatRound: rejects empty completions as no_content", async () => {
  const channel = new DeepSeekChannel({
    apiKey: "sk-test",
    fetchImpl: (async () => ({ ok: true, status: 200, statusText: "OK", json: async () => ({ choices: [] }) })) as unknown as typeof fetch
  });
  await assert.rejects(
    channel.chatRound("hi"),
    (err: unknown) => {
      assert.ok(err instanceof LlmChannelFaultError);
      assert.equal(err.faultKind, "no_content");
      return true;
    }
  );
});

test("chatRound: HTTP 200 with error payload classifies as invalid_response", async () => {
  const channel = new DeepSeekChannel({
    apiKey: "sk-test",
    fetchImpl: (async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ error: { message: "gateway says no" } })
    })) as unknown as typeof fetch
  });
  await assert.rejects(
    channel.chatRound("hi"),
    (err: unknown) => {
      assert.ok(err instanceof LlmChannelFaultError);
      assert.equal(err.faultKind, "invalid_response");
      return true;
    }
  );
});

test("chatRound: timeout surfaces a classified timeout fault", async () => {
  const timeoutError = new Error("The operation was aborted due to timeout");
  timeoutError.name = "TimeoutError";
  const channel = new OpenAICompatChannel({
    apiKey: "sk-test",
    baseUrl: "https://x",
    fetchImpl: (async () => {
      throw timeoutError;
    }) as unknown as typeof fetch
  });
  await assert.rejects(
    channel.chatRound("hi"),
    (err: unknown) => {
      assert.ok(err instanceof LlmChannelFaultError);
      assert.equal(err.faultKind, "timeout");
      assert.equal(err.retryable, true);
      return true;
    }
  );
});

// ---------------------------------------------------------- retry policy

test("retry: 429 twice then 200 succeeds on the third attempt", async () => {
  const calls: RecordedCall[] = [];
  const channel = new DeepSeekChannel({
    apiKey: "sk-test",
    maxRetries: 2,
    initialRetryDelayMs: 1,
    fetchImpl: fakeFetchRetrySequence([{ status: 429 }, { status: 429 }], "third time lucky", calls)
  });
  const out = await channel.chatRound("hi");
  assert.equal(out, "third time lucky");
  assert.equal(calls.length, 3);
});

test("retry: non-retryable auth fault never retries (single fetch call)", async () => {
  const calls: RecordedCall[] = [];
  const channel = new DeepSeekChannel({
    apiKey: "sk-bad",
    maxRetries: 3,
    initialRetryDelayMs: 1,
    fetchImpl: fakeFetchRetrySequence([{ status: 401 }], "never", calls)
  });
  await assert.rejects(channel.chatRound("hi"), (err: unknown) => {
    assert.ok(err instanceof LlmChannelFaultError);
    assert.equal(err.faultKind, "auth");
    return true;
  });
  assert.equal(calls.length, 1);
});

test("retry: exhausted retries report the attempt count", async () => {
  const calls: RecordedCall[] = [];
  const channel = new DeepSeekChannel({
    apiKey: "sk-test",
    maxRetries: 1,
    initialRetryDelayMs: 1,
    fetchImpl: fakeFetchRetrySequence([{ status: 500 }, { status: 500 }], "never", calls)
  });
  await assert.rejects(
    channel.chatRound("hi"),
    (err: unknown) => {
      assert.ok(err instanceof LlmChannelFaultError);
      assert.equal(err.faultKind, "server_error");
      assert.equal(err.attempts, 2);
      return true;
    }
  );
  assert.equal(calls.length, 2);
});

test("retry: Retry-After header is parsed onto the fault", async () => {
  const calls: RecordedCall[] = [];
  const channel = new DeepSeekChannel({
    apiKey: "sk-test",
    maxRetries: 0,
    initialRetryDelayMs: 1,
    fetchImpl: fakeFetchRetrySequence([{ status: 429, retryAfter: "3" }], "never", calls)
  });
  await assert.rejects(channel.chatRound("hi"), (err: unknown) => {
    assert.ok(err instanceof LlmChannelFaultError);
    assert.equal(err.retryAfterSeconds, 3);
    return true;
  });
});

test("retry: backoff is deterministic — no Math.random anywhere in the retry path", async () => {
  const calls: RecordedCall[] = [];
  const channel = new DeepSeekChannel({
    apiKey: "sk-test",
    maxRetries: 2,
    initialRetryDelayMs: 1,
    fetchImpl: fakeFetchRetrySequence([{ status: 429 }, { status: 500 }], "recovered", calls)
  });
  const originalRandom = Math.random;
  Math.random = () => {
    throw new Error("bare Math.random detected inside a channel (charter violation)");
  };
  try {
    const out = await channel.chatRound("hi");
    assert.equal(out, "recovered");
  } finally {
    Math.random = originalRandom;
  }
  assert.equal(calls.length, 3);
});

// ------------------------------------------------------ replay contract

test("DeepSeekChannel: replay contract is stochastic + inject", () => {
  const channel = new DeepSeekChannel({ apiKey: "sk-test", fetchImpl: fakeFetchOk("x", []) });
  assert.deepEqual(channel.determinismMeta, { determinism: "stochastic", seedable: true, replayPolicy: "inject" });
});
