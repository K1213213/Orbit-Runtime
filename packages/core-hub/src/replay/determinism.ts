import type { DeterminismLevel } from "@orbit/infra-common";

/**
 * Channel determinism contract. Providers declare how they behave under replay;
 * the hub uses this to decide whether a call can be injected or simulated.
 */
export interface ChannelRuntimeMeta {
  determinism: DeterminismLevel;
  /** stochastic channels: the seed is captured at record time and replayed. */
  seedable?: boolean;
  /** io-bound channels: how replay handles the call. */
  replayPolicy?: "inject" | "simulate";
}
