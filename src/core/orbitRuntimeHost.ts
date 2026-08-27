import { ChannelHub } from "../channel/ChannelHub";
import { MemoryKvChannel } from "../channel/providers/MemoryKvChannel";
import { LlmMockChannel } from "../channel/providers/LlmMockChannel";
import { TraceJournal } from "../trace/TraceJournal";
import { PluginSandboxGuard } from "../safeguard/PluginSandboxGuard";
import { PluginPactVerifier } from "../pact/PluginPactVerifier";
import { SandboxPool } from "../sandbox/SandboxPool";
import { ChannelKind, ChannelCallCtx } from "../types/orbitDomain";
import { makeUniqueMark } from "../utils/versionIdGen";

/**
 * Orbit运行时宿主：顶层组装入口
 * 自底向上实例全部组件；注册内置能力通道；统一宿主生命周期
 */
export class OrbitRuntimeHost {
  public readonly channelHub: ChannelHub;
  public readonly traceJournal: TraceJournal;
  public readonly pluginSandboxGuard: PluginSandboxGuard;
  public readonly pluginPactVerifier: PluginPactVerifier;
  public readonly sandboxPool: SandboxPool;

  constructor() {
    this.channelHub = new ChannelHub();
    this.traceJournal = new TraceJournal();
    this.pluginSandboxGuard = new PluginSandboxGuard(this.traceJournal);
    this.pluginPactVerifier = new PluginPactVerifier();
    this.sandboxPool = new SandboxPool(this.channelHub, this.traceJournal);

    // 权限裁决闭环：插件发起的通道调用必须先通过规约能力声明校验
    this.channelHub.attachCapabilityGate((pluginUnitId, kind, funcName) =>
      this.pluginPactVerifier.hasCapability(pluginUnitId, requiredCapabilityOf(kind, funcName))
    );

    this.channelHub.registerBuiltInChannel(ChannelKind.MEM_KV_STORE, new MemoryKvChannel());
    this.channelHub.registerBuiltInChannel(ChannelKind.LLM_ACCESS, new LlmMockChannel());
  }

  /** 宿主启动，执行全部内置通道setup */
  public async bootHost(): Promise<void> {
    const bootCtx: ChannelCallCtx = {
      traceMarkId: makeUniqueMark(),
      maxWaitMs: 10000
    };
    await this.channelHub.setupAllBuiltInChannels(bootCtx);
  }

  /** 宿主停止，反向顺序teardown释放全部资源 */
  public async shutdownHost(): Promise<void> {
    this.sandboxPool.releasePool();
    this.pluginPactVerifier.clearRegistry();
    this.pluginSandboxGuard.releaseAllGuard();
    await this.channelHub.teardown();
    this.traceJournal.clearAllTrace();
  }
}

/** 通道方法 → 所需能力声明的最小映射 */
function requiredCapabilityOf(
  kind: ChannelKind,
  funcName: string
): "channel:write" | "channel:read" | "sandbox:spawn" {
  if (kind === ChannelKind.MEM_KV_STORE) {
    return funcName === "writeEntry" || funcName === "removeEntry" ? "channel:write" : "channel:read";
  }
  return "channel:read";
}
