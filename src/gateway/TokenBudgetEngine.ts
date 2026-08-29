import { createHash } from "node:crypto";

/**
 * Pure-function token budget + context compressor (W8).
 *
 * Every method is deterministic: no `Math.random`, no `Date.now`, no I/O.
 * Given identical inputs it always yields identical outputs, so the engine can
 * safely run BOTH at record time (to decide + record the governance choice)
 * and be described purely by its config hash on replay (no re-execution).
 *
 * It is the single source of truth for the gateway's `budget` and
 * `compression` decisions and for the `tokenConfigHash` field of the
 * run-version fingerprint (config-drift detection).
 */

export type CompressionLevel = "conservative" | "normal" | "aggressive";

/** Budget action recorded with a call. */
export type BudgetStrategy = "normal" | "shrink" | "stop";

export interface TokenBudgetConfig {
  /** Hard ceiling of estimated tokens for a single call; over this => stop. */
  maxTokensPerCall: number;
  /** Estimated-token threshold above which compression is proposed. */
  compressAboveTokens: number;
  /** Fraction of tokens kept when trimming, per compression level. */
  trimRatio: Record<CompressionLevel, number>;
  /** Master switch; when false the engine is a no-op pass-through. */
  enabled: boolean;
}

export const DEFAULT_TOKEN_BUDGET_CONFIG: TokenBudgetConfig = {
  maxTokensPerCall: 8192,
  compressAboveTokens: 4096,
  trimRatio: { conservative: 0.9, normal: 0.75, aggressive: 0.5 },
  enabled: true
};

export interface CompressResult {
  /** Possibly-trimmed text (unchanged when no compression was applied). */
  text: string;
  /** Whether a trim actually happened. */
  applied: boolean;
  /** Level that would/was applied. */
  level: CompressionLevel;
  /** Estimated tokens of the returned text. */
  estimatedTokens: number;
}

export interface BudgetDecision {
  allow: boolean;
  strategy: BudgetStrategy;
}

export class TokenBudgetEngine {
  /** Cumulative estimated tokens per plugin — advanced deterministically. */
  private readonly usage = new Map<string, number>();

  public constructor(private readonly config: TokenBudgetConfig = DEFAULT_TOKEN_BUDGET_CONFIG) {}

  /**
   * Deterministic token estimate. Unicode-aware: contiguous runs of letters /
   * numbers / underscore count as words, and every run of other non-space
   * characters contributes ~1 token per 4 chars. No RNG, no clock.
   */
  public estimateTokens(text: string): number {
    if (!text) return 0;
    const words = text.match(/[\p{L}\p{N}_]+/gu) ?? [];
    let tokens = words.length;
    const nonWord = text.replace(/[\p{L}\p{N}_\s]/gu, "");
    tokens += Math.ceil(nonWord.length / 4);
    return tokens;
  }

  /**
   * Pure deterministic compression: when the estimated size exceeds the
   * threshold, keep the first `keep` word-runs (deterministic head trim) and
   * drop the tail. Never invents or reorders content.
   */
  public compress(text: string, level: CompressionLevel = "normal"): CompressResult {
    const estimated = this.estimateTokens(text);
    if (!this.config.enabled || estimated <= this.config.compressAboveTokens) {
      return { text, applied: false, level, estimatedTokens: estimated };
    }
    const keep = Math.max(1, Math.floor(estimated * this.config.trimRatio[level]));
    const words = text.match(/[\p{L}\p{N}_]+/gu) ?? [];
    if (words.length <= keep) {
      return { text, applied: false, level, estimatedTokens: estimated };
    }
    const trimmed = words.slice(0, keep).join(" ");
    return { text: trimmed, applied: true, level, estimatedTokens: this.estimateTokens(trimmed) };
  }

  /** Advance a plugin's cumulative usage; deterministic given the inputs. */
  public account(pluginId: string, estimatedTokens: number): void {
    this.usage.set(pluginId, (this.usage.get(pluginId) ?? 0) + estimatedTokens);
  }

  /** Current cumulative estimated tokens for a plugin. */
  public usageOf(pluginId: string): number {
    return this.usage.get(pluginId) ?? 0;
  }

  /**
   * Budget decision derived from a plugin's CUMULATIVE usage vs thresholds.
   * Called pre-execution, so it reflects everything already accounted for; the
   * current call's own cost is added by the gateway afterwards.
   */
  public budgetPolicy(pluginId: string): BudgetDecision {
    if (!this.config.enabled) return { allow: true, strategy: "normal" };
    const used = this.usageOf(pluginId);
    if (used > this.config.maxTokensPerCall) return { allow: false, strategy: "stop" };
    if (used > this.config.compressAboveTokens) return { allow: true, strategy: "shrink" };
    return { allow: true, strategy: "normal" };
  }

  /** Default compression policy (no payload) — what the gateway records. */
  public compressionPolicy(): { level: CompressionLevel; applied: boolean } {
    return { level: "normal", applied: false };
  }

  /** Payload-aware compression policy for a given estimated size. */
  public compressionPolicyFor(estimatedTokens: number): { level: CompressionLevel; applied: boolean } {
    if (!this.config.enabled) return { level: "normal", applied: false };
    if (estimatedTokens > this.config.compressAboveTokens) return { level: "aggressive", applied: true };
    if (estimatedTokens > this.config.compressAboveTokens * 0.75) return { level: "normal", applied: true };
    return { level: "conservative", applied: false };
  }

  /**
   * Stable hash of the threshold config. Fed into RunVersionFingerprint so a
   * trace recorded under different budget/compression thresholds surfaces as a
   * clean config-drift (RunFingerprintDriftError), not a digest mismatch.
   */
  public configHash(): string {
    return createHash("sha256").update(JSON.stringify(this.config)).digest("hex").slice(0, 16);
  }

  /** Reset cumulative accounting (used between independent sessions/tests). */
  public reset(): void {
    this.usage.clear();
  }
}
