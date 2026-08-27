/**
 * Orbit宿主领域异常集合
 * 所有业务异常均继承OrbitDomainError；携带链路标记用于轨迹日志记录
 */

export class OrbitDomainError extends Error {
  public readonly errorToken: string;
  public readonly traceMarkId?: string;
  public readonly pluginUnitId?: string;

  constructor(msg: string, errToken: string, traceMarkId?: string, pluginUnitId?: string) {
    super(msg);
    this.name = this.constructor.name;
    this.errorToken = errToken;
    this.traceMarkId = traceMarkId;
    this.pluginUnitId = pluginUnitId;
    Object.setPrototypeOf(this, OrbitDomainError.prototype);
  }
}

/** 插件单元规约校验失败 */
export class PluginPactRejectError extends OrbitDomainError {
  constructor(msg: string, traceMarkId?: string, pluginUnitId?: string) {
    super(msg, "PLUGIN_PACT_REJECT", traceMarkId, pluginUnitId);
  }
}

/** 能力通道调用异常 */
export class ChannelCallFaultError extends OrbitDomainError {
  constructor(msg: string, traceMarkId?: string, pluginUnitId?: string) {
    super(msg, "CHANNEL_CALL_FAULT", traceMarkId, pluginUnitId);
  }
}

/** 跳闸保护触发，拒绝执行 */
export class TripProtectionBlockError extends OrbitDomainError {
  constructor(msg: string, traceMarkId?: string, pluginUnitId?: string) {
    super(msg, "TRIP_PROTECTION_BLOCK", traceMarkId, pluginUnitId);
  }
}
