import { ChannelHub } from "@orbit/core-hub";
import { TraceJournal } from "@orbit/core-hub";
import { CycleLimitReachedError, BudgetExhaustedError } from "@orbit/infra-common";
import { makeUniqueMark } from "@orbit/infra-common";
import type { CostRouter } from "@orbit/core-hub";
import { ChannelKind, ChannelCallCtx, AgentBoxConfig, AgentBoxId, TraceMarkId, ReplayMode } from "@orbit/infra-common";

const DEFAULT_CHANNEL_TIMEOUT_MS = 8_000;

/**
 * One agent's execution sandbox: bounded cycle count, a fresh trace id per
 * round, and channel-mediated model access (never a direct LLM dependency).
 * The configured replayMode drives deterministic record/replay execution;
 * a per-cycle cost budget (M4) is enforced before each channel call.
 */
export class AgentSandbox {
  public readonly agentBoxId: AgentBoxId;
  public readonly boxAlias: string;
  public readonly baseInstruct: string;
  public readonly maxCycleRun: number;
  private readonly replayMode: ReplayMode;
  private readonly budgetPerCycle?: number;
  private readonly costRouter?: CostRouter;
  private cycleCount = 0;

  public constructor(
    cfg: AgentBoxConfig,
    private readonly channelHub: ChannelHub,
    private readonly traceJournal: TraceJournal,
    costRouter?: CostRouter
  ) {
    this.agentBoxId = cfg.agentBoxId;
    this.boxAlias = cfg.boxAlias;
    this.baseInstruct = cfg.baseInstruct;
    this.maxCycleRun = cfg.maxCycleRun;
    this.replayMode = cfg.replayMode ?? "live";
    this.budgetPerCycle = cfg.budgetPerCycle;
    this.costRouter = costRouter;
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

    const channelKind = this.pickChannel(traceMarkId);

    const ctx: ChannelCallCtx = {
      traceMarkId,
      agentBoxId: this.agentBoxId,
      maxWaitMs: DEFAULT_CHANNEL_TIMEOUT_MS,
      replayMode: this.replayMode
    };

    const llmOutput = await this.channelHub.fireChannelCall<string>(
      channelKind,
      ctx,
      "chatRound",
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

  /** M4: route to the cheapest fitting channel; fail when the budget cannot buy any. */
  private pickChannel(traceMarkId: TraceMarkId): ChannelKind {
    if (this.budgetPerCycle === undefined || !this.costRouter) {
      return ChannelKind.LLM_ACCESS;
    }
    const chosen = this.costRouter.choose([ChannelKind.LLM_ACCESS], this.budgetPerCycle, DEFAULT_CHANNEL_TIMEOUT_MS);
    if (chosen === undefined) {
      throw new BudgetExhaustedError(
        `agent sandbox ${this.agentBoxId} budget ${this.budgetPerCycle} too low for any channel`,
        traceMarkId,
        this.agentBoxId
      );
    }
    return chosen;
  }
}
