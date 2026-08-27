import type { ChannelCallCtx } from "../types/orbitDomain";

/**
 * A capability channel. Hosts dispatch method calls through the channel hub;
 * implementors must release any owned resources in teardown().
 */
export interface IChannelProvider {
  setup(ctx: ChannelCallCtx): Promise<void>;
  teardown(): Promise<void>;
}
