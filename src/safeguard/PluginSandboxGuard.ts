import { TripProtector } from "./TripProtector";
import { TraceJournal } from "../trace/TraceJournal";
import type { TraceMarkId, PluginUnitId } from "../types/orbitDomain";

/**
 * Runs plugin business logic under a per-plugin trip protector and records
 * failures into the trace journal, so a failing plugin cannot take down the
 * host or other plugins.
 */
export class PluginSandboxGuard {
  private readonly pluginTripMap = new Map<PluginUnitId, TripProtector>();

  public constructor(private readonly traceJournal: TraceJournal) {}

  public async runPluginSafe<T>(
    pluginUnitId: PluginUnitId,
    traceMarkId: TraceMarkId,
    business: () => Promise<T>
  ): Promise<T> {
    let protector = this.pluginTripMap.get(pluginUnitId);
    if (!protector) {
      protector = new TripProtector();
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
