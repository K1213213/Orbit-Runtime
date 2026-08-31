import type { IChannelProvider } from "../IChannelProvider";
import type { ChannelCallCtx } from "@orbit/infra-common";
import type { ChannelRuntimeMeta } from "../../replay/determinism";
import { DeterminismLevel } from "@orbit/infra-common";

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

  public async setup(_ctx: ChannelCallCtx): Promise<void> {
    this.sweepTimer = setInterval(() => this.sweepExpiredEntries(), SWEEP_INTERVAL_MS);
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
    const expireTimestamp = ttlMs > 0 ? Date.now() + ttlMs : null;
    this.innerKvMap.set(key, { payloadText, expireTimestamp });
  }

  public async readEntry(key: string): Promise<string | null> {
    const entry = this.innerKvMap.get(key);
    if (!entry) return null;
    if (entry.expireTimestamp !== null && Date.now() > entry.expireTimestamp) {
      this.innerKvMap.delete(key);
      return null;
    }
    return entry.payloadText;
  }

  public async removeEntry(key: string): Promise<void> {
    this.innerKvMap.delete(key);
  }

  private sweepExpiredEntries(): void {
    const now = Date.now();
    for (const [key, entry] of this.innerKvMap.entries()) {
      if (entry.expireTimestamp !== null && now > entry.expireTimestamp) {
        this.innerKvMap.delete(key);
      }
    }
  }
}
