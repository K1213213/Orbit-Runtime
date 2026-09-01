/**
 * Governance profiles (W29) — the four-tier governance model of VISION §3.1,
 * shipped as concrete, switchable configuration.
 *
 * The profiles scale *governance strength* without ever cutting capability
 * (axiom: the Sandbox tier is 100% capability-complete). Each profile resolves
 * to a plain configuration object consumed by the kernel's mechanisms — rate
 * limiter, trip protector, token compression, PAE admission and trace
 * durability — so "switch profile" is a declarative operation, not a rewrite.
 *
 * Determinism note: profiles are a *config-drift* surface, not a decision
 * surface. The profile name is hashed into the run fingerprint, so a trace
 * recorded under one profile refuses to replay under another
 * (`RunFingerprintDriftError`) — exactly the same contract as
 * `tokenConfigHash`. None of the per-profile numbers touch the recorded
 * decision values on a *given* profile, so replay stays byte-identical.
 */

/** The shipped profile names. `standard` is the default. */
export type GovernanceProfileName = "sandbox" | "standard" | "strict";

/** Token compression strength, mapped onto TokenBudgetEngine settings. */
export type CompressionStrength = "off" | "normal" | "aggressive";

/** Rate-limit numbers (call-count budget per window — see RateLimiter). */
export interface GovernanceLimiterConfig {
  maxCallsPerWindow: number;
  windowSizeCalls: number;
}

/**
 * Trip-protector numbers. The *threshold* is the base value that the host
 * softens by a plugin's dependency out-degree (a plugin with more declared
 * dependencies trips sooner); the *cooldown* is the probe delay in ms.
 */
export interface GovernanceTripConfig {
  failureThreshold: number;
  cooldownMs: number;
}

/** Trace durability contract chosen by the profile. */
export type TraceDurability = "memory" | "optional" | "required";

/** Adapter kinds admitted by the profile; "all" or an explicit list. */
export type PaeAdmission = "all" | readonly string[];

export interface GovernanceProfile {
  readonly name: GovernanceProfileName;
  /** Token compression: off (sandbox) / normal (standard) / aggressive (strict). */
  readonly compression: CompressionStrength;
  readonly limiter: GovernanceLimiterConfig;
  readonly trip: GovernanceTripConfig;
  readonly paeAdmission: PaeAdmission;
  readonly traceDurability: TraceDurability;
}

/** Sandbox — development: everything on, nothing aggressive. */
const SANDBOX: GovernanceProfile = {
  name: "sandbox",
  compression: "off",
  limiter: { maxCallsPerWindow: 1000, windowSizeCalls: 1000 },
  trip: { failureThreshold: 5, cooldownMs: 30_000 },
  paeAdmission: "all",
  traceDurability: "memory"
};

/**
 * Standard — the default: the exact numbers the kernel shipped before W29.
 *
 * `paeAdmission` is "all": the governance axiom is that tiers scale *strength*,
 * never capability — the PAE surface stays 100% available on the default tier
 * (safety is already carried by fidelity negotiation, the capability gate and
 * the adaptation-surface hash). Only `strict` closes the foreign-runtime
 * surface, as a compliance choice.
 */
const STANDARD: GovernanceProfile = {
  name: "standard",
  compression: "normal",
  limiter: { maxCallsPerWindow: 100, windowSizeCalls: 100 },
  trip: { failureThreshold: 5, cooldownMs: 10_000 },
  paeAdmission: "all",
  traceDurability: "optional"
};

/** Strict — compliance: only the provable path, durability mandatory. */
const STRICT: GovernanceProfile = {
  name: "strict",
  compression: "aggressive",
  limiter: { maxCallsPerWindow: 60, windowSizeCalls: 60 },
  trip: { failureThreshold: 3, cooldownMs: 5_000 },
  paeAdmission: [],
  traceDurability: "required"
};

const PROFILES: Readonly<Record<GovernanceProfileName, GovernanceProfile>> = {
  sandbox: SANDBOX,
  standard: STANDARD,
  strict: STRICT
};

/** Resolve a profile by name; defaults to `standard`. */
export function resolveGovernanceProfile(name?: GovernanceProfileName): GovernanceProfile {
  return name === undefined ? STANDARD : PROFILES[name] ?? STANDARD;
}

/** Stable digest of a profile for the run fingerprint (config-drift surface). */
export function governanceProfileHash(profile: GovernanceProfile): string {
  return stableJsonHash({
    n: profile.name,
    c: profile.compression,
    l: [profile.limiter.maxCallsPerWindow, profile.limiter.windowSizeCalls],
    t: [profile.trip.failureThreshold, profile.trip.cooldownMs],
    p: profile.paeAdmission === "all" ? "*" : [...profile.paeAdmission].sort(),
    d: profile.traceDurability
  });
}

/** Small, dependency-free stable JSON digest (FNV-1a over the canonical string). */
function stableJsonHash(value: unknown): string {
  const json = JSON.stringify(value);
  let h = 0x811c9dc5;
  for (let i = 0; i < json.length; i += 1) {
    h ^= json.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `g${(h >>> 0).toString(36)}`;
}
