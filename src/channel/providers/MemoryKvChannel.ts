import type { IChannelProvider } from "../IChannelProvider";
import type { ChannelCallCtx } from "../../types/orbitDomain";

/**
 * 内存KV能力通道，支持TTL自动过期回收
 */
type KvStoreEntry = {
  payloadText: string;
  expireTimestamp: number | null;
};

export class MemoryKvChannel implements IChannelProvider {
  private innerKvMap = new Map<string, KvStoreEntry>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  public async setup(_ctx: ChannelCallCtx): Promise<void> {
    // 每5秒扫描清理过期KV条目
    this.sweepTimer = setInterval(() => this.sweepExpiredEntries(), 5000);
  }

  public async teardown(): Promise<void> {
    if (this.sweepTimer !== null) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    this.innerKvMap.clear();
  }

  /** ttlMs=0代表永久有效 */
  public async writeEntry(key: string, payloadText: string, ttlMs: number): Promise<void> {
    const expire = ttlMs > 0 ? Date.now() + ttlMs : null;
    this.innerKvMap.set(key, { payloadText, expireTimestamp: expire });
  }

  public async readEntry(key: string): Promise<string | null> {
    const item = this.innerKvMap.get(key);
    if (!item) return null;
    if (item.expireTimestamp !== null && Date.now() > item.expireTimestamp) {
      this.innerKvMap.delete(key);
      return null;
    }
    return item.payloadText;
  }

  public async removeEntry(key: string): Promise<void> {
    this.innerKvMap.delete(key);
  }

  private sweepExpiredEntries(): void {
    const nowTs = Date.now();
    for (const [k, entry] of this.innerKvMap.entries()) {
      if (entry.expireTimestamp !== null && nowTs > entry.expireTimestamp) {
        this.innerKvMap.delete(k);
      }
    }
  }
}
