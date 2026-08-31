import type { ChannelKind } from "@orbit/infra-common";

/** Cost / latency / quality attributes a channel may declare. */
export interface ChannelCostMeta {
  /** Abstract cost units per call. */
  costPerCall: number;
  /** Expected latency per call in ms. */
  latencyMs: number;
  /** Quality score in [0, 1]. */
  quality: number;
}

/**
 * Budget-aware router: among candidate channels for the same capability,
 * picks the cheapest one that still fits the budget and latency target.
 */
export class CostRouter {
  public constructor(private readonly profiles = new Map<ChannelKind, ChannelCostMeta>()) {}

  public register(kind: ChannelKind, meta: ChannelCostMeta): void {
    this.profiles.set(kind, meta);
  }

  public choose(kinds: ChannelKind[], budget: number, maxLatencyMs: number): ChannelKind | undefined {
    let best: ChannelKind | undefined;
    let bestCost = Number.POSITIVE_INFINITY;
    for (const kind of kinds) {
      const meta = this.profiles.get(kind);
      if (!meta) continue;
      if (meta.costPerCall > budget || meta.latencyMs > maxLatencyMs) continue;
      if (meta.costPerCall < bestCost) {
        best = kind;
        bestCost = meta.costPerCall;
      }
    }
    return best;
  }
}
