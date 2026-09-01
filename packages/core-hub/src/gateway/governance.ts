import type { GovernanceProfile } from "@orbit/infra-common";
import { DEFAULT_TOKEN_BUDGET_CONFIG, type TokenBudgetConfig } from "./TokenBudgetEngine";

/**
 * W29 — map a governance profile onto the kernel mechanisms' concrete configs.
 *
 * These are pure functions so each profile's effect is unit-testable without a
 * host: given a profile, the mechanisms behave exactly as resolved here. The
 * `standard` profile must resolve to the kernel's pre-W29 defaults verbatim —
 * that identity is asserted in test/governance_profile.test.ts.
 */

/** Token/compression settings for a profile. `off` disables the engine. */
export function tokenBudgetConfigForProfile(profile: GovernanceProfile): TokenBudgetConfig {
  switch (profile.compression) {
    case "off":
      return { ...DEFAULT_TOKEN_BUDGET_CONFIG, enabled: false };
    case "aggressive":
      return {
        ...DEFAULT_TOKEN_BUDGET_CONFIG,
        // Trim sooner and harder: a compliance tier trades a little context
        // for a much tighter token footprint.
        compressAboveTokens: 2048,
        compressThresholdBytes: 1024,
        trimRatio: { ...DEFAULT_TOKEN_BUDGET_CONFIG.trimRatio, aggressive: 0.35 }
      };
    default:
      return DEFAULT_TOKEN_BUDGET_CONFIG;
  }
}

/**
 * Trip threshold softened by a plugin's dependency out-degree, per profile.
 *
 * The base is the profile's `failureThreshold`; a plugin that declares more
 * dependencies trips sooner (its failure takes more peers down). The floor
 * differs by profile: `strict` allows the threshold to collapse to 1 (the
 * first failure trips), `sandbox`/`standard` keep a floor of 2 so a single
 * transient blip does not open the trip.
 */
export function tripThresholdForProfile(profile: GovernanceProfile, outDegree: number): number {
  const floor = profile.name === "strict" ? 1 : 2;
  return Math.max(floor, profile.trip.failureThreshold - outDegree);
}
