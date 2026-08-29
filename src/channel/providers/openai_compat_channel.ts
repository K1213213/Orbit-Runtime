import type { IChannelProvider } from "../IChannelProvider";
import type { ChannelRuntimeMeta } from "../../replay/determinism";
import { DeterminismLevel } from "../../types/orbitDomain";
import { OrbitDomainError } from "../../core/orbitDomainError";

/** One chat message; roles follow the OpenAI-compatible convention. */
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * Per-call overrides for chatRound. All fields optional; anything unset falls
 * back to the channel-level config. The options object participates in the
 * call-input digest, so it must be a plain JSON-serializable value for
 * record/replay to match.
 */
export interface ChatRoundOptions {
  /** Full message list; when provided it replaces the single user prompt. */
  messages?: ChatMessage[];
  /** Stable-sampling seed (OpenAI-compatible `seed`). */
  seed?: number;
  temperature?: number;
  maxTokens?: number;
  responseFormat?: "text" | "json";
  stop?: string[];
}

/** Classification of an LLM channel fault; drives retry and caller handling. */
export type LlmFaultKind =
  | "timeout"
  | "network"
  | "rate_limited"
  | "server_error"
  | "auth"
  | "bad_request"
  | "not_found"
  | "no_content"
  | "invalid_response";

const RETRYABLE_FAULTS: ReadonlySet<LlmFaultKind> = new Set(["timeout", "network", "rate_limited", "server_error"]);

export function isRetryableLlmFault(kind: LlmFaultKind): boolean {
  return RETRYABLE_FAULTS.has(kind);
}

/** A classified LLM channel fault. errorToken: LLM_CHANNEL_FAULT. */
export class LlmChannelFaultError extends OrbitDomainError {
  public readonly faultKind: LlmFaultKind;
  public readonly httpStatus?: number;
  /** Number of HTTP attempts made before the fault surfaced (>= 1). */
  public readonly attempts: number;
  /** Parsed Retry-After header (seconds), present on 429 responses that carry it. */
  public readonly retryAfterSeconds?: number;

  public constructor(
    message: string,
    faultKind: LlmFaultKind,
    details: { httpStatus?: number; attempts?: number; traceMarkId?: string; retryAfterSeconds?: number } = {}
  ) {
    super(message, "LLM_CHANNEL_FAULT", details.traceMarkId);
    this.faultKind = faultKind;
    this.httpStatus = details.httpStatus;
    this.attempts = details.attempts ?? 1;
    this.retryAfterSeconds = details.retryAfterSeconds;
  }

  public get retryable(): boolean {
    return isRetryableLlmFault(this.faultKind);
  }
}

export interface OpenAICompatChannelConfig {
  /** API key; empty string is allowed for unauthenticated endpoints (e.g. local Ollama). */
  apiKey: string;
  /** API base URL, e.g. "https://api.openai.com" or "https://api.deepseek.com". */
  baseUrl: string;
  /** Model id. */
  model?: string;
  temperature?: number;
  maxTokens?: number;
  /** Stable-sampling seed passed to the API (OpenAI-compatible). */
  seed?: number;
  /** response_format: "json" enables JSON mode on endpoints that support it. */
  responseFormat?: "text" | "json";
  stop?: string[];
  /** Per-attempt timeout in ms; default 30_000. */
  timeoutMs?: number;
  /** Retries after a retryable fault (timeout/network/429/5xx); default 2. */
  maxRetries?: number;
  /** Base delay for the deterministic exponential backoff; default 500ms. */
  initialRetryDelayMs?: number;
  /** Upper bound for a single backoff delay; default 8_000ms. */
  maxRetryDelayMs?: number;
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch;
}

const DEFAULT_MODEL = "deepseek-chat";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_INITIAL_RETRY_DELAY_MS = 500;
const DEFAULT_MAX_RETRY_DELAY_MS = 8_000;

interface ChatCompletionResponse {
  choices?: { message?: { role?: string; content?: string } }[];
  error?: { message?: string };
}

/**
 * Real LLM channel over any OpenAI-compatible chat completions endpoint
 * (OpenAI, DeepSeek, Qwen, Kimi, GLM, Ollama, vLLM, ...). Zero runtime deps:
 * uses the built-in fetch (Node >= 20).
 *
 * Determinism contract: stochastic (LLM sampling is not reproducible from a
 * seed alone), so replay relies on output-snapshot injection — which is
 * exactly what the record/replay machinery provides.
 *
 * Retry policy: retryable faults (timeout / network / 429 / 5xx) are retried
 * with a DETERMINISTIC exponential backoff — no jitter, no Math.random — so
 * the same failure sequence always yields the same timing sequence
 * (kernel charter: no bare randomness inside channels). Retries are internal
 * to the channel: only the final successful output reaches the hub's record
 * journal, and in replay mode no HTTP attempt is made at all.
 *
 * Note: the hub-level timeout (ctx.maxWaitMs) wraps the whole chatRound call
 * including retries; give LLM calls a generous maxWaitMs.
 */
export class OpenAICompatChannel implements IChannelProvider {
  public readonly determinismMeta: ChannelRuntimeMeta = {
    determinism: DeterminismLevel.STOCHASTIC,
    seedable: true,
    replayPolicy: "inject"
  };

  private readonly model: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly initialRetryDelayMs: number;
  private readonly maxRetryDelayMs: number;

  public constructor(protected readonly config: OpenAICompatChannelConfig) {
    if (config.apiKey === undefined || config.apiKey === null) {
      throw new Error("OpenAICompatChannel requires an apiKey (empty string is allowed for unauthenticated endpoints like Ollama)");
    }
    this.model = config.model ?? DEFAULT_MODEL;
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.initialRetryDelayMs = config.initialRetryDelayMs ?? DEFAULT_INITIAL_RETRY_DELAY_MS;
    this.maxRetryDelayMs = config.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
  }

  public async setup(): Promise<void> {}

  public async teardown(): Promise<void> {}

  /**
   * Standard LLM channel method: one chat round against the configured endpoint.
   * `rawPrompt` becomes a single user message unless `opts.messages` supplies
   * a full conversation.
   */
  public async chatRound(rawPrompt: string, opts?: ChatRoundOptions): Promise<string> {
    const messages: ChatMessage[] = opts?.messages ?? [{ role: "user", content: rawPrompt }];

    let attempt = 0;
    for (;;) {
      attempt += 1;
      try {
        return await this.requestCompletion(messages, opts, attempt);
      } catch (err) {
        const fault = this.asLlmFault(err, attempt);
        if (fault === null || !fault.retryable || attempt > this.maxRetries) {
          throw fault ?? err;
        }
        await this.backoffBeforeRetry(fault, attempt);
      }
    }
  }

  // ---------------------------------------------------------------- internals

  private async requestCompletion(
    messages: ChatMessage[],
    opts: ChatRoundOptions | undefined,
    attempt: number
  ): Promise<string> {
    const cfg = this.config;
    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      stream: false
    };
    const temperature = opts?.temperature ?? cfg.temperature;
    const maxTokens = opts?.maxTokens ?? cfg.maxTokens;
    const seed = opts?.seed ?? cfg.seed;
    const responseFormat = opts?.responseFormat ?? cfg.responseFormat;
    const stop = opts?.stop ?? cfg.stop;
    if (temperature !== undefined) body.temperature = temperature;
    if (maxTokens !== undefined) body.max_tokens = maxTokens;
    if (seed !== undefined) body.seed = seed;
    if (responseFormat !== undefined) body.response_format = { type: responseFormat };
    if (stop !== undefined) body.stop = stop;

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (cfg.apiKey !== "") {
      headers.Authorization = `Bearer ${cfg.apiKey}`;
    }

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch (err) {
      if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
        throw new LlmChannelFaultError(`LLM request timed out after ${this.timeoutMs}ms`, "timeout", { attempts: attempt });
      }
      // fetch() rejects with TypeError on network failure (DNS, refused, offline).
      throw new LlmChannelFaultError(
        `LLM endpoint unreachable: ${err instanceof Error ? err.message : String(err)}`,
        "network",
        { attempts: attempt }
      );
    }

    let data: ChatCompletionResponse | null = null;
    let bodyParsed = true;
    try {
      data = (await response.json()) as ChatCompletionResponse;
    } catch {
      bodyParsed = false;
    }

    if (!response.ok) {
      const kind = this.classifyStatus(response.status);
      const retryAfterSeconds =
        kind === "rate_limited" ? this.parseRetryAfter(response.headers?.get("retry-after")) : undefined;
      const apiMessage = data?.error?.message;
      if (bodyParsed && apiMessage !== undefined) {
        throw new LlmChannelFaultError(
          `LLM API error ${response.status} (${kind}): ${apiMessage}`,
          kind,
          { httpStatus: response.status, attempts: attempt, retryAfterSeconds }
        );
      }
      throw new LlmChannelFaultError(
        `LLM API error ${response.status} (${kind}): ${response.statusText || "non-JSON body"}`,
        kind,
        { httpStatus: response.status, attempts: attempt, retryAfterSeconds }
      );
    }

    if (data?.error) {
      // Some gateways answer HTTP 200 with an error payload.
      throw new LlmChannelFaultError(
        `LLM API returned an error payload: ${data.error.message ?? "unknown"}`,
        "invalid_response",
        { httpStatus: response.status, attempts: attempt }
      );
    }

    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw new LlmChannelFaultError("LLM API returned no content", "no_content", {
        httpStatus: response.status,
        attempts: attempt
      });
    }
    return content;
  }

  private classifyStatus(status: number): LlmFaultKind {
    if (status === 429) return "rate_limited";
    if (status === 401 || status === 403) return "auth";
    if (status === 404) return "not_found";
    if (status >= 500) return "server_error";
    return "bad_request";
  }

  /** Retry-After in seconds; only integer seconds are honored (deterministic). */
  private parseRetryAfter(raw: string | null | undefined): number | undefined {
    if (raw === null || raw === undefined) return undefined;
    const seconds = Number.parseInt(raw, 10);
    return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
  }

  /** Deterministic backoff: base * 2^(attempt-1), capped, honoring Retry-After. */
  private async backoffBeforeRetry(fault: LlmChannelFaultError, attempt: number): Promise<void> {
    let delayMs = Math.min(this.initialRetryDelayMs * 2 ** (attempt - 1), this.maxRetryDelayMs);
    if (fault.faultKind === "rate_limited" && fault.retryAfterSeconds !== undefined) {
      delayMs = Math.max(delayMs, fault.retryAfterSeconds * 1_000);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
  }

  /** Normalize an unexpected throw into an LlmChannelFaultError when possible. */
  private asLlmFault(err: unknown, attempt: number): LlmChannelFaultError | null {
    if (err instanceof LlmChannelFaultError) return err;
    if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
      return new LlmChannelFaultError(`LLM request timed out after ${this.timeoutMs}ms`, "timeout", { attempts: attempt });
    }
    return null;
  }
}

/** DeepSeek preset: OpenAI-compatible endpoint with a sensible default model. */
export interface DeepSeekChannelConfig extends Omit<OpenAICompatChannelConfig, "baseUrl"> {
  baseUrl?: string;
}

export class DeepSeekChannel extends OpenAICompatChannel {
  public constructor(config: DeepSeekChannelConfig) {
    super({ ...config, baseUrl: config.baseUrl ?? "https://api.deepseek.com" });
  }
}
