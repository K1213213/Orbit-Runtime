import type { AgentBoxConfig, AgentBoxId, TraceMarkId, ChannelCallCtx } from "../types/orbitDomain";
import { ChannelHub } from "../channel/ChannelHub";
import { TraceJournal } from "../trace/TraceJournal";
import { makeUniqueMark } from "../utils/versionIdGen";
import { ChannelKind } from "../types/orbitDomain";

/**
 * Agent独立沙箱实例，维护循环计数、指令上下文；单次业务循环执行
 */
export class AgentSandbox {
  public readonly agentBoxId: AgentBoxId;
  public readonly boxAlias: string;
  public readonly baseInstruct: string;
  public readonly maxCycleRun: number;
  private cycleCounter: number;
  private readonly channelHub: ChannelHub;
  private readonly traceJournal: TraceJournal;

  constructor(cfg: AgentBoxConfig, hub: ChannelHub, journal: TraceJournal) {
    this.agentBoxId = cfg.agentBoxId;
    this.boxAlias = cfg.boxAlias;
    this.baseInstruct = cfg.baseInstruct;
    this.maxCycleRun = cfg.maxCycleRun;
    this.cycleCounter = 0;
    this.channelHub = hub;
    this.traceJournal = journal;
  }

  /** 执行一轮思考处理周期 */
  public async runSingleCycle(userInputText: string): Promise<string> {
    const traceMarkId: TraceMarkId = makeUniqueMark();
    this.cycleCounter += 1;

    if (this.cycleCounter > this.maxCycleRun) {
      this.traceJournal.appendTrace({
        entryClass: "AGENT_CYCLE_LIMIT_HIT",
        traceMarkId,
        agentBoxId: this.agentBoxId,
        factPayload: { currentCycle: this.cycleCounter, maxCycle: this.maxCycleRun }
      });
      return "Sandbox halt: reached maximum cycle run limit";
    }

    const callCtx: ChannelCallCtx = {
      traceMarkId,
      agentBoxId: this.agentBoxId,
      maxWaitMs: 8000
    };

    const llmOutput = await this.channelHub.fireChannelCall<string>(
      ChannelKind.LLM_ACCESS,
      callCtx,
      "simulateChatRound",
      `${this.baseInstruct}\nUser:${userInputText}`
    );

    this.traceJournal.appendTrace({
      entryClass: "AGENT_SINGLE_CYCLE_EXEC",
      traceMarkId,
      agentBoxId: this.agentBoxId,
      factPayload: { userInputText, llmOutput, cycleCounter: this.cycleCounter }
    });
    return llmOutput;
  }

  public peekCycleCounter(): number {
    return this.cycleCounter;
  }

  public resetCycleCounter(): void {
    this.cycleCounter = 0;
  }
}
