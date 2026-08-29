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
  /**
   * Routing decision: native channel vs PAE adapter. `kind` is optional so
   * existing checker implementations keep compiling; hosts that adapt foreign
   * runtimes use it to answer per channel instead of globally (W15).
   */
  route: (pluginId: string, kind?: ChannelKind) => "native" | "pae";
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
  /**
   * Optional deterministic token estimate for an output (used to enrich the
   * behavior note). Optional so gateways without a budget engine can omit it.
   */
  estimateTokens?: (output: unknown) => number;
  /**
   * Optional hook advancing the rate limiter after a live call's decision is
   * captured. Replay bypasses this (the recorded `rateLimited` value is
   * restored instead), so omit it for gateways that don't enforce rate limits.
   */
  consumeRateLimit?: (pluginId: string) => void;
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

/** Thrown when a recorded governance DECISION no longer holds under the current
 * configuration (e.g. a capability pact was revoked since recording, so the
 * replay would weaken governance). Distinct from config drift (a version/fingerprint
 * change) and call drift (a data/signature mismatch) — the three form the
 * W13 error taxonomy. */
export class DecisionDriftError extends OrbitDomainError {
  public constructor(
    public readonly decisionField: "pactPass" | "route" | "budget" | "compression" | "tripAllowed" | "rateLimited",
    message: string,
    traceMarkId?: string
  ) {
    super(message, "DECISION_DRIFT", traceMarkId);
  }
}

export type { GatewayDecision, RunVersionFingerprint, CapabilityKey };
