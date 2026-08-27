import { TripProtector } from "./TripProtector";
import { TraceJournal } from "../trace/TraceJournal";
import type { TraceMarkId, PluginUnitId } from "../types/orbitDomain";

/**
 * 插件沙箱防护器：每个插件单元绑定独立跳闸保护器；捕获异常写入轨迹日志
 * 实现插件故障隔离，单个插件故障不击穿整个宿主运行时
 */
export class PluginSandboxGuard {
  private readonly pluginTripMap = new Map<PluginUnitId, TripProtector>();
  private readonly traceJournal: TraceJournal;

  constructor(journal: TraceJournal) {
    this.traceJournal = journal;
  }

  /** 在跳闸保护下执行插件业务逻辑；异常自动写入轨迹 */
  public async runPluginSafe<T>(
    pluginUnitId: PluginUnitId,
    traceMarkId: TraceMarkId,
    businessFunc: () => Promise<T>
  ): Promise<T> {
    let protector = this.pluginTripMap.get(pluginUnitId);
    if (!protector) {
      protector = new TripProtector();
      this.pluginTripMap.set(pluginUnitId, protector);
    }

    try {
      return await protector.execWithProtect(businessFunc);
    } catch (err) {
      this.traceJournal.appendTrace({
        entryClass: "PLUGIN_UNIT_EXCEPTION",
        traceMarkId,
        pluginUnitId,
        factPayload: {
          errMsg: err instanceof Error ? err.message : String(err)
        }
      });
      throw err;
    }
  }

  public releaseAllGuard(): void {
    this.pluginTripMap.clear();
  }
}
