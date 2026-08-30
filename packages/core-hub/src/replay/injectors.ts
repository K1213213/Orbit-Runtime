import type { RngSource, ClockSource } from "@orbit/infra-common";

/** Deterministic PRNG (mulberry32): identical seed always yields the identical sequence. */
export class SeededRng implements RngSource {
  private state: number;

  public constructor(seed: number) {
    this.state = seed >>> 0;
  }

  public next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
}

/** Monotonic fixed clock: deterministic timestamps for replay. */
export class FixedClock implements ClockSource {
  private tick = 0;

  public constructor(private readonly base: number) {}

  public now(): number {
    return this.base + this.tick++;
  }
}

/**
 * Live defaults used when no injection is configured.
 *
 * INTERNAL — these read `Math.random()` / `Date.now()` directly, so they are the
 * one place in the kernel allowed to (charter A1). They exist as the fallback
 * for components that take an optional injected source, and are intentionally
 * not re-exported from the public facade: a caller who reaches for them gets
 * entropy that no journal can reproduce. Use {@link SeededRng} /
 * {@link FixedClock} for anything whose output is recorded.
 */
export const SYSTEM_RNG: RngSource = { next: () => Math.random() };
export const SYSTEM_CLOCK: ClockSource = { now: () => Date.now() };
