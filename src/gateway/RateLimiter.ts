/**
 * Pure-function rate limiter (W11).
 *
 * Rate-limiting in a deterministic kernel is subtle: a wall-clock window would
 * make the live decision non-reproducible. Instead the limiter models rate as a
 * **call-count budget** advanced deterministically per plugin — no `Math.random`,
 * no `Date.now`, no I/O. The decision is computed and RECORDED at record time;
 * on replay the limiter is bypassed and the recorded `rateLimited` value is
 * restored verbatim (see CapabilityGateway). This keeps replay byte-identical
 * (axioms A1/A2) while still capturing the governance observation truthfully.
 */

export interface RateLimitConfig {
  /** Calls a plugin may make before it is limited within one window. */
  maxCallsPerWindow: number;
  /**
   * Window length in calls. Pure and replay-safe: the limiter is a token bucket
   * keyed by call count, not wall-clock time. A fresh window begins when the
   * recorded usage is reset between independent sessions.
   */
  windowSizeCalls: number;
}

export const DEFAULT_RATE_LIMIT_CONFIG: RateLimitConfig = {
  maxCallsPerWindow: 100,
  windowSizeCalls: 100
};

export class RateLimiter {
  /** Deterministic per-plugin usage counter. */
  private readonly used = new Map<string, number>();

  public constructor(private readonly config: RateLimitConfig = DEFAULT_RATE_LIMIT_CONFIG) {}

  /** Calls still allowed for a plugin (never negative). */
  public remaining(pluginId: string): number {
    const u = this.used.get(pluginId) ?? 0;
    return Math.max(0, this.config.maxCallsPerWindow - u);
  }

  /** Whether the NEXT call from this plugin would be rate-limited. */
  public isLimited(pluginId: string): boolean {
    return this.remaining(pluginId) <= 0;
  }

  /** Consume one token; returns false (without over-consuming) when limited. */
  public acquire(pluginId: string): boolean {
    if (this.isLimited(pluginId)) return false;
    this.used.set(pluginId, (this.used.get(pluginId) ?? 0) + 1);
    return true;
  }

  /** Reset one plugin's window, or the whole limiter when no id is given. */
  public reset(pluginId?: string): void {
    if (pluginId) this.used.delete(pluginId);
    else this.used.clear();
  }
}
