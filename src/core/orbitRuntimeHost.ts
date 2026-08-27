import { ChannelHub } from "../channel/ChannelHub";
import { MemoryKvChannel } from "../channel/providers/MemoryKvChannel";
import { LlmMockChannel } from "../channel/providers/LlmMockChannel";
import { TraceJournal } from "../trace/TraceJournal";
import { PluginSandboxGuard } from "../safeguard/PluginSandboxGuard";
import { PluginPactVerifier } from "../pact/PluginPactVerifier";
import { SandboxPool } from "../sandbox/SandboxPool";
import { makeUniqueMark } from "../utils/versionIdGen";
import type { AgentSandbox } from "../sandbox/AgentSandbox";
import { ChannelKind, ChannelCallCtx, PluginUnitPact, AgentBoxConfig, CapabilityKey } from "../types/orbitDomain";

const HOST_DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Top-level assembly: wires every component bottom-up and owns the host
 * lifecycle. Components stay public for advanced scenarios (custom channels,
 * audit), but day-to-day use should go through the facade methods below.
 */
export class OrbitRuntimeHost {
  public readonly channelHub: ChannelHub;
  public readonly traceJournal: TraceJournal;
  public readonly pluginSandboxGuard: PluginSandboxGuard;
  public readonly pluginPactVerifier: PluginPactVerifier;
  public readonly sandboxPool: SandboxPool;

  public constructor() {
    this.channelHub = new ChannelHub();
    this.traceJournal = new TraceJournal();
    this.pluginSandboxGuard = new PluginSandboxGuard(this.traceJournal);
    this.pluginPactVerifier = new PluginPactVerifier();
    this.sandboxPool = new SandboxPool(this.channelHub, this.traceJournal);

    // Close the capability loop: plugin-originated channel calls must pass the
    // declared-capability check. Injected as a function so the channel layer
    // never depends on the pact layer above it.
    this.channelHub.attachCapabilityGate((pluginUnitId, kind, funcName) =>
      this.pluginPactVerifier.hasCapability(pluginUnitId, requiredCapability(kind, funcName))
    );

    this.channelHub.registerBuiltInChannel(ChannelKind.MEM_KV_STORE, new MemoryKvChannel());
    this.channelHub.registerBuiltInChannel(ChannelKind.LLM_ACCESS, new LlmMockChannel());
  }

  public async bootHost(): Promise<void> {
    await this.channelHub.setupAllBuiltInChannels(this.newHostCtx());
  }

  /** Reverse-order teardown: pool -> pact -> guards -> channels -> journal. */
  public async shutdownHost(): Promise<void> {
    this.sandboxPool.clear();
    this.pluginPactVerifier.clear();
    this.pluginSandboxGuard.releaseAllGuard();
    await this.channelHub.teardown();
    this.traceJournal.clear();
  }

  // Facade -----------------------------------------------------------

  public registerPlugin(pact: PluginUnitPact): void {
    this.pluginPactVerifier.registerPluginUnit(pact, makeUniqueMark());
  }

  public spawnAgentBox(cfg: AgentBoxConfig): AgentSandbox {
    return this.sandboxPool.spawnSandbox(cfg);
  }

  private newHostCtx(): ChannelCallCtx {
    return { traceMarkId: makeUniqueMark(), maxWaitMs: HOST_DEFAULT_TIMEOUT_MS };
  }
}

/** Minimal mapping from a channel method to its required capability. */
function requiredCapability(kind: ChannelKind, funcName: string): CapabilityKey {
  if (kind === ChannelKind.MEM_KV_STORE) {
    return funcName === "writeEntry" || funcName === "removeEntry" ? "channel:write" : "channel:read";
  }
  return "channel:read";
}
