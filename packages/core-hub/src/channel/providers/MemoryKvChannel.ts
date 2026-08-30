import type { IChannelProvider } from "../IChannelProvider";
import type { ChannelCallCtx } from "@orbit/infra-common";
import type { ChannelRuntimeMeta } from "../../replay/determinism";
import { DeterminismLevel } from "@orbit/infra-common";
import type { ClockSource } from "@orbit/infra-common";

const SWEEP_INTERVAL_MS = 5_000;

interface KvEntry {
  payloadText: string;
  expireTimestamp: number | null;
}

/** In-memory KV channel with TTL: entries expire lazily on read and on a sweep timer. */
export class MemoryKvChannel implements IChannelProvider {
  public readonly determinismMeta: ChannelRuntimeMeta = {
    determinism: DeterminismLevel.IO_BOUND,
    replayPolicy: "inject"
  };

  private readonly innerKvMap = new Map<string, KvEntry>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * @param clock Drives TTL expiry. Injected because `readEntry`'s return value
   *   is recorded verbatim as the call's `outputSnapshot` and compared byte for
   *   byte on replay: with the real clock, a recording that crosses a TTL
   *   boundary returns `null` where the previous one returned the value, so two
   *   recordings of the same script disagree. Defaults to the real clock, which
   *   preserves the previous behaviour.
   */
  public constructor(private readonly clock: ClockSource = { now: () => Date.now() }) {}

  public async setup(_ctx: ChannelCallCtx): Promise<void> {
    // Idempotent: drop any previous sweep before installing a new one, or a
    // repeated setup() would leak an interval that keeps sweeping forever (and,
    // being a live handle, keeps the event loop — and the process — alive).
    if (this.sweepTimer !== null) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    this.sweepTimer = setInterval(() => this.sweepExpiredEntries(), SWEEP_INTERVAL_MS);
    // A background sweeper must never be the reason a host cannot exit.
    this.sweepTimer.unref();
  }

  public async teardown(): Promise<void> {
    if (this.sweepTimer !== null) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    this.innerKvMap.clear();
  }

  /** ttlMs <= 0 means the entry never expires. */
  public async writeEntry(key: string, payloadText: string, ttlMs: number): Promise<void> {
    const expireTimestamp = ttlMs > 0 ? this.clock.now() + ttlMs : null;
    this.innerKvMap.set(key, { payloadText, expireTimestamp });
  }

  public async readEntry(key: string): Promise<string | null> {
    const entry = this.innerKvMap.get(key);
    if (!entry) return null;
    if (entry.expireTimestamp !== null && this.clock.now() > entry.expireTimestamp) {
      this.innerKvMap.delete(key);
      return null;
    }
    return entry.payloadText;
  }

  public async removeEntry(key: string): Promise<void> {
    this.innerKvMap.delete(key);
  }

  private sweepExpiredEntries(): void {
    const now = this.clock.now();
    for (const [key, entry] of this.innerKvMap.entries()) {
      if (entry.expireTimestamp !== null && now > entry.expireTimestamp) {
        this.innerKvMap.delete(key);
      }
    }
  }
}
