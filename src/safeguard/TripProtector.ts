import { TripProtectionBlockError } from "../core/orbitDomainError";
import { TripState } from "../types/orbitDomain";

const DEFAULT_FAILURE_THRESHOLD = 5;
const DEFAULT_COOLDOWN_MS = 10_000;

export interface TripSnapshot {
  state: TripState;
  consecutiveFailures: number;
}

/**
 * Per-plugin fault state machine: consecutive failures open the trip,
 * a cooldown then flips it to probe mode, and a single probe success
 * restores normal operation (agent workloads recover fast from blips).
 */
export class TripProtector {
  private state: TripState = TripState.NORMAL;
  private consecutiveFailures = 0;
  private probeSuccesses = 0;
  private trippedAt = 0;

  public constructor(
    private readonly failureThreshold: number = DEFAULT_FAILURE_THRESHOLD,
    private readonly cooldownMs: number = DEFAULT_COOLDOWN_MS
  ) {}

  public async execWithProtect<T>(target: () => Promise<T>): Promise<T> {
    if (this.state === TripState.TRIPPED) {
      if (Date.now() - this.trippedAt > this.cooldownMs) {
        this.state = TripState.PROBE;
      } else {
        throw new TripProtectionBlockError("trip protector active, execution blocked");
      }
    }

    try {
      const result = await target();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  public snapshot(): TripSnapshot {
    return { state: this.state, consecutiveFailures: this.consecutiveFailures };
  }

  /**
   * Read-only pre-check used by the gateway to record the trip decision
   * WITHOUT mutating state (the actual state transition happens inside
   * execWithProtect when the call runs). Returns whether a call is currently
   * allowed — a tripped protector flips to probe once its cooldown elapses.
   */
  public preCallCheck(): boolean {
    if (this.state === TripState.TRIPPED) {
      return Date.now() - this.trippedAt > this.cooldownMs;
    }
    return true;
  }

  private onSuccess(): void {
    if (this.state === TripState.PROBE) {
      this.probeSuccesses += 1;
      if (this.probeSuccesses >= 1) {
        this.state = TripState.NORMAL;
        this.consecutiveFailures = 0;
        this.probeSuccesses = 0;
      }
    } else {
      this.consecutiveFailures = 0;
    }
  }

  private onFailure(): void {
    this.consecutiveFailures += 1;
    this.probeSuccesses = 0;
    if (this.state === TripState.PROBE || this.consecutiveFailures >= this.failureThreshold) {
      this.state = TripState.TRIPPED;
      this.trippedAt = Date.now();
    }
  }
}
