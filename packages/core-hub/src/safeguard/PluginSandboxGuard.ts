import { TripProtector } from "./TripProtector";
import { TraceJournal } from "../trace/TraceJournal";
import type { TraceMarkId, PluginUnitId, ClockSource } from "@orbit/infra-common";

/**
 * Runs plugin business logic under a per-plugin trip protector and records
 * failures into the trace journal, so a failing plugin cannot take down the
 * host or other plugins. An optional threshold resolver derives per-plugin
 * protection strictness from the impact graph (M3): the wider a plugin's
 * influence, the stricter its trip threshold.
 */
export class PluginSandboxGuard {
  private readonly pluginTripMap = new Map<PluginUnitId, TripProtector>();

  /**
   * @param clock Passed down to every {@link TripProtector} this guard creates,
   *   so the trip cooldown is driven by the host's injected clock rather than
   *   the wall clock (see TripProtector's constructor). Optional: omitting it
   *   keeps the previous real-clock behaviour.
   */
  public constructor(
    private readonly traceJournal: TraceJournal,
    private readonly thresholdResolver?: (pluginUnitId: string) => number,
    private readonly clock?: ClockSource
  ) {}

  public async runPluginSafe<T>(
    pluginUnitId: PluginUnitId,
    traceMarkId: TraceMarkId,
    business: () => Promise<T>
  ): Promise<T> {
    let protector = this.pluginTripMap.get(pluginUnitId);
    if (!protector) {
      const threshold = this.thresholdResolver?.(pluginUnitId);
      // `undefined` leaves TripProtector's own threshold/cooldown defaults in
      // place; only the clock is threaded through.
      protector = new TripProtector(threshold, undefined, this.clock);
      this.pluginTripMap.set(pluginUnitId, protector);
    }

    try {
      return await protector.execWithProtect(business);
    } catch (err) {
      this.traceJournal.append({
        entryClass: "PLUGIN_UNIT_EXCEPTION",
        traceMarkId,
        pluginUnitId,
        factPayload: { errMsg: err instanceof Error ? err.message : String(err) }
      });
      throw err;
    }
  }

  public releaseAllGuard(): void {
    this.pluginTripMap.clear();
  }
}
