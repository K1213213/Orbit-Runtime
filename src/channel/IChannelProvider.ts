import type { ChannelCallCtx } from "../types/orbitDomain";
import type { ChannelRuntimeMeta } from "../replay/determinism";

/**
 * A capability channel. Hosts dispatch method calls through the channel hub;
 * implementors must release any owned resources in teardown() and declare
 * their determinism contract for replay support.
 */
export interface IChannelProvider {
  setup(ctx: ChannelCallCtx): Promise<void>;
  teardown(): Promise<void>;
  /** Determinism contract used by the record/replay machinery. */
  readonly determinismMeta: ChannelRuntimeMeta;
}
