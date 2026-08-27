import type { IChannelProvider } from "../IChannelProvider";
import type { ChannelCallCtx } from "../../types/orbitDomain";
import type { ChannelRuntimeMeta } from "../../replay/determinism";
import { DeterminismLevel } from "../../types/orbitDomain";

const DEFAULT_LATENCY_MS = 320;

/** Mock LLM channel for tests and demos; simulates network latency. */
export class LlmMockChannel implements IChannelProvider {
  public readonly determinismMeta: ChannelRuntimeMeta = {
    determinism: DeterminismLevel.DETERMINISTIC,
    replayPolicy: "inject"
  };

  public constructor(private readonly latencyMs: number = DEFAULT_LATENCY_MS) {}

  public async setup(_ctx: ChannelCallCtx): Promise<void> {}

  public async teardown(): Promise<void> {}

  public async chatRound(rawPrompt: string): Promise<string> {
    await this.delay(this.latencyMs);
    return `[Llm-Sim] Input content:${rawPrompt}`;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
