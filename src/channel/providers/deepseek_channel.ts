import type { IChannelProvider } from "../IChannelProvider";
import type { ChannelRuntimeMeta } from "../../replay/determinism";
import { DeterminismLevel } from "../../types/orbitDomain";

export interface DeepSeekChannelConfig {
  /** DeepSeek API key (https://platform.deepseek.com). */
  apiKey: string;
  /** Model id; default "deepseek-chat". */
  model?: string;
  /** API base; default "https://api.deepseek.com". */
  baseUrl?: string;
  temperature?: number;
  maxTokens?: number;
  /** Stable-sampling seed passed to the API (OpenAI-compatible). */
  seed?: number;
  /** Per-call timeout in ms; default 30_000. */
  timeoutMs?: number;
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch;
}

const DEFAULT_BASE_URL = "https://api.deepseek.com";
const DEFAULT_MODEL = "deepseek-chat";
const DEFAULT_TIMEOUT_MS = 30_000;

interface ChatCompletionResponse {
  choices?: { message: { role: string; content: string } }[];
  error?: { message?: string };
}

/**
 * Real DeepSeek channel over the OpenAI-compatible chat completions API.
 * Zero runtime deps: uses the built-in fetch (Node >= 20).
 *
 * Determinism contract: stochastic (LLM sampling is not reproducible from a
 * seed alone), so replay relies on output-snapshot injection — which is
 * exactly what the record/replay machinery provides.
 */
export class DeepSeekChannel implements IChannelProvider {
  public readonly determinismMeta: ChannelRuntimeMeta = {
    determinism: DeterminismLevel.STOCHASTIC,
    seedable: true,
    replayPolicy: "inject"
  };

  private readonly model: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  public constructor(private readonly config: DeepSeekChannelConfig) {
    if (!config.apiKey) {
      throw new Error("DeepSeekChannel requires an apiKey");
    }
    this.model = config.model ?? DEFAULT_MODEL;
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  public async setup(): Promise<void> {}

  public async teardown(): Promise<void> {}

  /** Standard LLM channel method: one chat round against DeepSeek. */
  public async chatRound(rawPrompt: string): Promise<string> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: [{ role: "user", content: rawPrompt }],
      stream: false
    };
    if (this.config.temperature !== undefined) body.temperature = this.config.temperature;
    if (this.config.maxTokens !== undefined) body.max_tokens = this.config.maxTokens;
    if (this.config.seed !== undefined) body.seed = this.config.seed;

    const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.apiKey}`
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    });

    let data: ChatCompletionResponse;
    try {
      data = (await response.json()) as ChatCompletionResponse;
    } catch {
      throw new Error(`DeepSeek API returned a non-JSON response (HTTP ${response.status})`);
    }
    if (!response.ok || data.error) {
      throw new Error(`DeepSeek API error ${response.status}: ${data.error?.message ?? response.statusText}`);
    }
    const content = data.choices?.[0]?.message?.content;
    if (content === undefined) {
      throw new Error("DeepSeek API returned no content");
    }
    return content;
  }
}
