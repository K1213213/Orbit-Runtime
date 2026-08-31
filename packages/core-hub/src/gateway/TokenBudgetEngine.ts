import { createHash } from "node:crypto";
import { deflateSync, inflateSync } from "node:zlib";

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
  /** Serialized-byte threshold above which the stored output snapshot is
   * compressed at rest (deflate). A storage optimization, not a semantic trim. */
  compressThresholdBytes: number;
  /** Master switch; when false the engine is a no-op pass-through. */
  enabled: boolean;
}

export const DEFAULT_TOKEN_BUDGET_CONFIG: TokenBudgetConfig = {
  maxTokensPerCall: 8192,
  compressAboveTokens: 4096,
  trimRatio: { conservative: 0.9, normal: 0.75, aggressive: 0.5 },
  compressThresholdBytes: 2048,
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
   * Payload-aware storage-compression decision. Pure function of the output's
   * serialized size and the config — no RNG, no clock. Decides whether the
   * stored snapshot should be compressed at rest and at which level. The actual
   * (de)compression is performed by `packSnapshot` / `decompressPayload`; this
   * method only chooses the policy so the decision can be recorded verbatim and
   * replayed without re-execution.
   */
  public decideCompression(output: unknown): { level: CompressionLevel; applied: boolean } {
    if (!this.config.enabled) return { level: "normal", applied: false };
    const bytes = serializedByteLength(output);
    if (bytes <= this.config.compressThresholdBytes) return { level: "normal", applied: false };
    if (bytes > this.config.compressThresholdBytes * 4) return { level: "aggressive", applied: true };
    if (bytes > this.config.compressThresholdBytes * 2) return { level: "normal", applied: true };
    return { level: "conservative", applied: true };
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

/** Serialized UTF-8 byte length of a value (its JSON form). */
export function serializedByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value ?? null), "utf8");
}

/** Compressed storage envelope for a recorded output snapshot. */
export interface CompressedPayload {
  __orbitCompressed: "v1";
  algo: "deflate";
  level: CompressionLevel;
  /** Original serialized byte length (before deflate). */
  bytes: number;
  /** Bytes saved vs the raw JSON form (negative when deflate did not help). */
  saved: number;
  /** base64 of the deflated JSON. */
  data: string;
}

/** Type guard for a compressed storage envelope. */
export function isCompressedPayload(v: unknown): v is CompressedPayload {
  return typeof v === "object" && v !== null && (v as { __orbitCompressed?: unknown }).__orbitCompressed === "v1";
}

/**
 * Pure deterministic compression of a value into a storage envelope. Uses the
 * built-in `node:zlib` deflate (no external deps, fully deterministic given
 * the input). The envelope round-trips exactly through `decompressPayload`.
 */
export function compressPayload(value: unknown, level: CompressionLevel): CompressedPayload {
  const json = JSON.stringify(value ?? null);
  const raw = Buffer.byteLength(json, "utf8");
  const deflated = deflateSync(Buffer.from(json, "utf8"));
  return {
    __orbitCompressed: "v1",
    algo: "deflate",
    level,
    bytes: raw,
    saved: raw - deflated.length,
    data: deflated.toString("base64")
  };
}

/** Inverse of `compressPayload` — restores the exact original value. */
export function decompressPayload(p: CompressedPayload): unknown {
  const buf = Buffer.from(p.data, "base64");
  return JSON.parse(inflateSync(buf).toString("utf8"));
}

/**
 * Compress a recorded output for storage ONLY when it actually saves space.
 * Returns the storage form (`served`) plus an honest `applied` flag and the
 * measured byte savings; when deflate does not help, the original is kept
 * untouched (so small payloads are never bloated by an envelope).
 */
export function packSnapshot(
  output: unknown,
  level: CompressionLevel
): { served: unknown; applied: boolean; bytesSaved: number } {
  const env = compressPayload(output, level);
  if (env.saved <= 0) return { served: output, applied: false, bytesSaved: 0 };
  return { served: env, applied: true, bytesSaved: env.saved };
}
