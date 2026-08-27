import type { IChannelProvider } from "../IChannelProvider";
import type { ChannelRuntimeMeta } from "../../replay/determinism";
import { DeterminismLevel } from "../../types/orbitDomain";

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
  /** Per-call timeout in ms; default 30_000. */
  timeoutMs?: number;
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch;
}

const DEFAULT_MODEL = "deepseek-chat";
const DEFAULT_TIMEOUT_MS = 30_000;

interface ChatCompletionResponse {
  choices?: { message: { role: string; content: string } }[];
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

  public constructor(protected readonly config: OpenAICompatChannelConfig) {
    if (config.apiKey === undefined || config.apiKey === null) {
      throw new Error("OpenAICompatChannel requires an apiKey (empty string is allowed for unauthenticated endpoints like Ollama)");
    }
    this.model = config.model ?? DEFAULT_MODEL;
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  public async setup(): Promise<void> {}

  public async teardown(): Promise<void> {}

  /** Standard LLM channel method: one chat round against the configured endpoint. */
  public async chatRound(rawPrompt: string): Promise<string> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: [{ role: "user", content: rawPrompt }],
      stream: false
    };
    if (this.config.temperature !== undefined) body.temperature = this.config.temperature;
    if (this.config.maxTokens !== undefined) body.max_tokens = this.config.maxTokens;
    if (this.config.seed !== undefined) body.seed = this.config.seed;

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.config.apiKey !== "") {
      headers.Authorization = `Bearer ${this.config.apiKey}`;
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
        throw new Error(`LLM API timed out after ${this.timeoutMs}ms`);
      }
      throw err;
    }

    let data: ChatCompletionResponse;
    try {
      data = (await response.json()) as ChatCompletionResponse;
    } catch {
      throw new Error(`LLM API returned a non-JSON response (HTTP ${response.status})`);
    }
    if (!response.ok || data.error) {
      throw new Error(`LLM API error ${response.status}: ${data.error?.message ?? response.statusText}`);
    }
    const content = data.choices?.[0]?.message?.content;
    if (content === undefined) {
      throw new Error("LLM API returned no content");
    }
    return content;
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
