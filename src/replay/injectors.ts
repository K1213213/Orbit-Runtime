import type { RngSource, ClockSource } from "../types/orbitDomain";

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

/** Live defaults used when no injection is configured. */
export const SYSTEM_RNG: RngSource = { next: () => Math.random() };
export const SYSTEM_CLOCK: ClockSource = { now: () => Date.now() };
