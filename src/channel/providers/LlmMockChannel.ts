import type { IChannelProvider } from "../IChannelProvider";
import type { ChannelCallCtx } from "../../types/orbitDomain";

/**
 * LLM访问模拟通道，用于单元测试与演示，内置网络延迟模拟
 */
export class LlmMockChannel implements IChannelProvider {
  public async setup(_ctx: ChannelCallCtx): Promise<void> {
  }

  public async teardown(): Promise<void> {
  }

  public async simulateChatRound(rawPrompt: string): Promise<string> {
    await this.mockIoDelay(320);
    return `[Llm‑Sim] Input content:${rawPrompt}`;
  }

  private mockIoDelay(waitMs: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, waitMs));
  }
}
