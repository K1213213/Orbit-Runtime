import { ChannelHub } from "../channel/ChannelHub";
import { TraceJournal } from "../trace/TraceJournal";
import { CycleLimitReachedError } from "../core/orbitDomainError";
import { makeUniqueMark } from "../utils/versionIdGen";
import { ChannelKind, ChannelCallCtx, AgentBoxConfig, AgentBoxId, TraceMarkId } from "../types/orbitDomain";

const DEFAULT_CHANNEL_TIMEOUT_MS = 8_000;

/**
 * One agent's execution sandbox: bounded cycle count, a fresh trace id per
 * round, and channel-mediated model access (never a direct LLM dependency).
 */
export class AgentSandbox {
  public readonly agentBoxId: AgentBoxId;
  public readonly boxAlias: string;
  public readonly baseInstruct: string;
  public readonly maxCycleRun: number;
  private cycleCount = 0;

  public constructor(
    cfg: AgentBoxConfig,
    private readonly channelHub: ChannelHub,
    private readonly traceJournal: TraceJournal
  ) {
    this.agentBoxId = cfg.agentBoxId;
    this.boxAlias = cfg.boxAlias;
    this.baseInstruct = cfg.baseInstruct;
    this.maxCycleRun = cfg.maxCycleRun;
  }

  /** Run one reasoning cycle; throws CycleLimitReachedError when the budget is spent. */
  public async runSingleCycle(userInputText: string): Promise<string> {
    const traceMarkId: TraceMarkId = makeUniqueMark();
    this.cycleCount += 1;

    if (this.cycleCount > this.maxCycleRun) {
      this.traceJournal.append({
        entryClass: "AGENT_CYCLE_LIMIT_HIT",
        traceMarkId,
        agentBoxId: this.agentBoxId,
        factPayload: { currentCycle: this.cycleCount, maxCycle: this.maxCycleRun }
      });
      throw new CycleLimitReachedError(
        `agent sandbox ${this.agentBoxId} reached cycle limit ${this.maxCycleRun}`,
        traceMarkId,
        this.agentBoxId
      );
    }

    const ctx: ChannelCallCtx = {
      traceMarkId,
      agentBoxId: this.agentBoxId,
      maxWaitMs: DEFAULT_CHANNEL_TIMEOUT_MS
    };

    const llmOutput = await this.channelHub.fireChannelCall<string>(
      ChannelKind.LLM_ACCESS,
      ctx,
      "simulateChatRound",
      `${this.baseInstruct}\nUser:${userInputText}`
    );

    this.traceJournal.append({
      entryClass: "AGENT_SINGLE_CYCLE_EXEC",
      traceMarkId,
      agentBoxId: this.agentBoxId,
      factPayload: { userInputText, llmOutput, cycleCounter: this.cycleCount }
    });
    return llmOutput;
  }

  public cycleCountNow(): number {
    return this.cycleCount;
  }

  public resetCycleCount(): void {
    this.cycleCount = 0;
  }
}
