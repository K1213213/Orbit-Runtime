import { PluginPactRejectError } from "../core/orbitDomainError";
import { checkHostEditionRequirement } from "../utils/versionIdGen";
import type { PluginUnitPact, PluginUnitId, TraceMarkId, CapabilityKey } from "../types/orbitDomain";

/** Validates plugin manifests and answers capability queries for the hub. */
export class PluginPactVerifier {
  private readonly registeredPluginMap = new Map<PluginUnitId, PluginUnitPact>();

  /** Field completeness + host edition compatibility + capability declaration. */
  public verifyPact(pact: PluginUnitPact, traceMarkId: TraceMarkId): void {
    if (!pact.id || !pact.displayName || !pact.edition) {
      throw new PluginPactRejectError("plugin pact missing mandatory fields", traceMarkId, pact.id);
    }
    if (!checkHostEditionRequirement(pact.edition, pact.requireHostMinEdition)) {
      throw new PluginPactRejectError(
        `plugin ${pact.id} does not satisfy host edition requirement`,
        traceMarkId,
        pact.id
      );
    }
    if (!Array.isArray(pact.allowCapabilities)) {
      throw new PluginPactRejectError("allowCapabilities must be an array", traceMarkId, pact.id);
    }
  }

  public registerPluginUnit(pact: PluginUnitPact, traceMarkId: TraceMarkId): void {
    this.verifyPact(pact, traceMarkId);
    if (this.registeredPluginMap.has(pact.id)) {
      throw new PluginPactRejectError(`plugin ${pact.id} already registered`, traceMarkId, pact.id);
    }
    this.registeredPluginMap.set(pact.id, pact);
  }

  public unregisterPluginUnit(pluginId: PluginUnitId): void {
    this.registeredPluginMap.delete(pluginId);
  }

  public hasCapability(pluginId: PluginUnitId, capability: CapabilityKey): boolean {
    const pact = this.registeredPluginMap.get(pluginId);
    if (!pact) return false;
    return pact.allowCapabilities.includes(capability);
  }

  public listPluginIds(): PluginUnitId[] {
    return Array.from(this.registeredPluginMap.keys());
  }

  public clear(): void {
    this.registeredPluginMap.clear();
  }
}
