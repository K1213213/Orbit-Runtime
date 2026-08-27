/**
 * Domain error hierarchy. Every error carries an error token plus optional
 * trace/plugin ids so the journal can attribute failures precisely.
 */
export class OrbitDomainError extends Error {
  public readonly errorToken: string;
  public readonly traceMarkId?: string;
  public readonly pluginUnitId?: string;

  constructor(message: string, errorToken: string, traceMarkId?: string, pluginUnitId?: string) {
    super(message);
    this.name = this.constructor.name;
    this.errorToken = errorToken;
    this.traceMarkId = traceMarkId;
    this.pluginUnitId = pluginUnitId;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Plugin pact validation failed. */
export class PluginPactRejectError extends OrbitDomainError {
  constructor(message: string, traceMarkId?: string, pluginUnitId?: string) {
    super(message, "PLUGIN_PACT_REJECT", traceMarkId, pluginUnitId);
  }
}

/** Capability channel call failed (missing channel, timeout, capability denied). */
export class ChannelCallFaultError extends OrbitDomainError {
  constructor(message: string, traceMarkId?: string, pluginUnitId?: string) {
    super(message, "CHANNEL_CALL_FAULT", traceMarkId, pluginUnitId);
  }
}

/** Trip protector is open and rejected the execution. */
export class TripProtectionBlockError extends OrbitDomainError {
  constructor(message: string, traceMarkId?: string, pluginUnitId?: string) {
    super(message, "TRIP_PROTECTION_BLOCK", traceMarkId, pluginUnitId);
  }
}

/** Sandbox creation rejected (e.g. duplicate id). */
export class SandboxSpawnRejectError extends OrbitDomainError {
  constructor(message: string, traceMarkId?: string) {
    super(message, "SANDBOX_SPAWN_REJECT", traceMarkId);
  }
}

/** Agent exceeded its per-run cycle budget. */
export class CycleLimitReachedError extends OrbitDomainError {
  constructor(message: string, traceMarkId?: string, agentBoxId?: string) {
    super(message, "CYCLE_LIMIT_REACHED", traceMarkId);
  }
}
