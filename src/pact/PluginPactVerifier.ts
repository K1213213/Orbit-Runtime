import { PluginPactRejectError } from "../core/orbitDomainError";
import { checkHostEditionRequirement } from "../utils/versionIdGen";
import type { PluginUnitPact, PluginUnitId, TraceMarkId } from "../types/orbitDomain";

/**
 * 插件规约校验器：校验manifest字段、宿主版本依赖、权限能力鉴权
 */
export class PluginPactVerifier {
  private readonly registeredPluginMap = new Map<PluginUnitId, PluginUnitPact>();

  /** 校验插件规约完整性 */
  public verifyPact(pact: PluginUnitPact, traceMarkId: TraceMarkId): void {
    if (!pact.id || !pact.displayName || !pact.edition) {
      throw new PluginPactRejectError("Plugin pact missing mandatory fields", traceMarkId, pact.id);
    }
    if (!checkHostEditionRequirement(pact.edition, pact.requireHostMinEdition)) {
      throw new PluginPactRejectError(
        `Plugin ${pact.id} host edition requirement unsatisfied`,
        traceMarkId,
        pact.id
      );
    }
    if (!Array.isArray(pact.allowCapabilities)) {
      throw new PluginPactRejectError("allowCapabilities must be array", traceMarkId, pact.id);
    }
  }

  /** 注册插件单元规约 */
  public registerPluginUnit(pact: PluginUnitPact, traceMarkId: TraceMarkId): void {
    this.verifyPact(pact, traceMarkId);
    if (this.registeredPluginMap.has(pact.id)) {
      throw new PluginPactRejectError(`Plugin ${pact.id} has already been registered`, traceMarkId, pact.id);
    }
    this.registeredPluginMap.set(pact.id, pact);
  }

  public unregisterPluginUnit(pluginId: PluginUnitId): void {
    this.registeredPluginMap.delete(pluginId);
  }

  /** 判断插件是否拥有指定能力权限 */
  public hasCapability(pluginId: PluginUnitId, capKey: string): boolean {
    const pact = this.registeredPluginMap.get(pluginId);
    if (!pact) return false;
    return pact.allowCapabilities.includes(capKey as PluginUnitPact["allowCapabilities"][number]);
  }

  /** 获取已注册插件ID副本 */
  public getRegisteredPluginIdCopy(): PluginUnitId[] {
    return Array.from(this.registeredPluginMap.keys());
  }

  public clearRegistry(): void {
    this.registeredPluginMap.clear();
  }
}
