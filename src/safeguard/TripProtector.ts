import { TripProtectionBlockError } from "../core/orbitDomainError";
import { TripState } from "../types/orbitDomain";

/**
 * 跳闸保护器：故障状态机，替代熔断器；
 * N次连续失败后进入跳闸；超时后进入探测模式；探测成功恢复正常
 */
export class TripProtector {
  private runState: TripState;
  private consecutiveFailureCount: number;
  private probeSuccessCount: number;
  private readonly failureTriggerThreshold: number;
  private readonly probeCoolDownMs: number;
  private trippedAtTimestamp: number;

  /**
   * @param failureTriggerThreshold 连续失败多少次触发跳闸
   * @param probeCoolDownMs 跳闸后冷却多久进入探测模式
   */
  constructor(failureTriggerThreshold = 5, probeCoolDownMs = 10000) {
    this.runState = TripState.NORMAL;
    this.consecutiveFailureCount = 0;
    this.probeSuccessCount = 0;
    this.failureTriggerThreshold = failureTriggerThreshold;
    this.probeCoolDownMs = probeCoolDownMs;
    this.trippedAtTimestamp = 0;
  }

  public async execWithProtect<T>(targetLogic: () => Promise<T>): Promise<T> {
    if (this.runState === TripState.TRIPPED) {
      const now = Date.now();
      if (now - this.trippedAtTimestamp > this.probeCoolDownMs) {
        this.runState = TripState.PROBE;
      } else {
        throw new TripProtectionBlockError("Trip protector active, execution blocked");
      }
    }

    try {
      const result = await targetLogic();
      this.handleBusinessSuccess();
      return result;
    } catch (err) {
      this.handleBusinessFail();
      throw err;
    }
  }

  private handleBusinessSuccess(): void {
    if (this.runState === TripState.PROBE) {
      this.probeSuccessCount += 1;
      // Agent业务场景：探测一次成功即恢复正常，区别通用库N次策略
      if (this.probeSuccessCount >= 1) {
        this.runState = TripState.NORMAL;
        this.consecutiveFailureCount = 0;
        this.probeSuccessCount = 0;
      }
    } else {
      this.consecutiveFailureCount = 0;
    }
  }

  private handleBusinessFail(): void {
    this.consecutiveFailureCount += 1;
    this.probeSuccessCount = 0;
    if (this.runState === TripState.PROBE || this.consecutiveFailureCount >= this.failureTriggerThreshold) {
      this.runState = TripState.TRIPPED;
      this.trippedAtTimestamp = Date.now();
    }
  }

  /** 获取保护器当前状态副本 */
  public peekStatusCopy(): { runState: TripState; consecutiveFailureCount: number } {
    return {
      runState: this.runState,
      consecutiveFailureCount: this.consecutiveFailureCount
    };
  }
}
