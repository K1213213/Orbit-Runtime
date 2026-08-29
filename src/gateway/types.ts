import { OrbitDomainError } from "../core/orbitDomainError";
import type { CapabilityKey, ChannelKind, GatewayDecision, RunVersionFingerprint } from "../types/orbitDomain";

/** Injected decision sources. The gateway stays above the pact/safeguard
 * layers by depending only on these abstract checkers, never on the concrete
 * components — same dependency direction rule as the channel capability gate. */
export interface GatewayCheckers {
  /** Whether a call from this plugin is currently allowed by the trip protector. */
  tripAllowed: (pluginId: string) => boolean;
  /** Whether the plugin's declared pact covers this capability. */
  pactPass: (pluginId: string, kind: ChannelKind, funcName: string) => boolean;
  /** Budget decision for an LLM-bound call (allow / shrink / stop). */
  budgetDecision: (pluginId: string) => { allow: boolean; strategy: "normal" | "shrink" | "stop" };
  /** Whether the call is currently rate-limited. */
  rateLimited: (pluginId: string) => boolean;
  /** Routing decision: native channel vs PAE adapter. */
  route: (pluginId: string) => "native" | "pae";
  /** Payload-aware context-compression decision (storage compression at rest). */
  compression: (output: unknown) => { level: "conservative" | "normal" | "aggressive"; applied: boolean };
  /** Build the run-version fingerprint for the current configuration. */
  fingerprint: () => RunVersionFingerprint;
  /**
   * Optional post-call hook: feed a call's output back to the budget engine so
   * cumulative token usage can drive later `budgetDecision` calls. Optional so
   * manual/test gateways that don't track usage can omit it.
   */
  accountTokens?: (pluginId: string, output: unknown) => void;
}

/** Thrown when a replayed trace was recorded under a different configuration.
 * Distinguishes config drift from digest drift so diagnosis is precise. */
export class RunFingerprintDriftError extends OrbitDomainError {
  public constructor(
    public readonly driftField: keyof RunVersionFingerprint | "pactVersions",
    message: string,
    traceMarkId?: string
  ) {
    super(message, "RUN_FINGERPRINT_DRIFT", traceMarkId);
  }
}

export type { GatewayDecision, RunVersionFingerprint, CapabilityKey };
