/**
 * Orbit Agent Runtime · 项目启动演示入口
 *
 * 覆盖全部核心机制：
 *   1. 宿主生命周期（boot → shutdown 反向释放）
 *   2. 插件规约校验（字段 / 版本 / 权限声明）
 *   3. 权限能力裁决（声明内放行、未声明拒绝）
 *   4. 智能体沙箱运行（通道化模型调用）
 *   5. 循环上限保护（防死循环）
 *   6. 插件故障物理隔离（单点故障不击穿内核）
 *   7. 全链路轨迹日志（快照可查）
 *
 * 运行：npm run demo
 */
import { OrbitRuntimeHost } from "./src/core/orbitRuntimeHost";
import { ChannelKind, AgentBoxConfig, PluginUnitPact, ChannelCallCtx } from "./src/types/orbitDomain";
import { makeUniqueMark } from "./src/utils/versionIdGen";

async function main(): Promise<void> {
  console.log("=== Orbit Agent Runtime · 演示入口 ===");
  console.log("");

  // 1) 宿主启动：自底向上装配全部组件
  const host = new OrbitRuntimeHost();
  await host.bootHost();
  console.log("[boot] 宿主启动完成：内置通道已注册（MEM_KV_STORE / LLM_ACCESS）");

  // 2) 插件规约校验与注册
  const registerTrace = makeUniqueMark();
  const weatherPlugin: PluginUnitPact = {
    id: "plugin.weather",
    displayName: "Weather Lookup Plugin",
    edition: "1.2.0",
    requireHostMinEdition: "1.0.0",
    allowCapabilities: ["channel:read"]
  };
  host.pluginPactVerifier.registerPluginUnit(weatherPlugin, registerTrace);
  console.log(`[pact] 插件规约校验通过并注册：${weatherPlugin.id}（v${weatherPlugin.edition}，能力: channel:read）`);

  // 3) 权限能力裁决：声明内放行，未声明拒绝
  const pluginCtx: ChannelCallCtx = {
    traceMarkId: makeUniqueMark(),
    pluginUnitId: "plugin.weather",
    maxWaitMs: 5000
  };
  const llmOut = await host.channelHub.fireChannelCall<string>(
    ChannelKind.LLM_ACCESS,
    pluginCtx,
    "simulateChatRound",
    "Hello Orbit"
  );
  console.log(`[cap] 插件调用 LLM 通道（channel:read）→ 放行成功：${llmOut}`);
  try {
    await host.channelHub.fireChannelCall<void>(
      ChannelKind.MEM_KV_STORE,
      pluginCtx,
      "writeEntry",
      "demo-key",
      "demo-value",
      0
    );
    console.log("[cap] 未声明 channel:write 却被放行 —— 不应发生！");
  } catch (err) {
    console.log(`[cap] 插件调用 KV 写（未声明 channel:write）→ 被能力裁决拒绝：${(err as Error).message}`);
  }

  // 4) 智能体沙箱运行（模型调用全部走通道）
  const boxCfg: AgentBoxConfig = {
    agentBoxId: "box.demo-1",
    boxAlias: "demo-agent",
    baseInstruct: "You are a demo assistant.",
    maxCycleRun: 2
  };
  const box = host.sandboxPool.spawnSandbox(boxCfg);
  console.log(`[sandbox] 沙箱创建：${box.boxAlias}（循环上限 ${box.maxCycleRun}）`);
  console.log(`[sandbox] 第 1 轮输出：${await box.runSingleCycle("tell me a joke")}`);

  // 5) 循环上限保护
  console.log(`[sandbox] 第 2 轮输出：${await box.runSingleCycle("what is orbit")}`);
  console.log(`[sandbox] 第 3 轮（超限）→ ${await box.runSingleCycle("one more round")}`);

  // 6) 插件故障物理隔离：单点故障不击穿内核
  try {
    await host.pluginSandboxGuard.runPluginSafe("plugin.weather", makeUniqueMark(), async () => {
      throw new Error("simulated plugin crash");
    });
  } catch (err) {
    console.log(`[guard] 插件异常已被隔离并自动落轨迹：${(err as Error).message}`);
  }
  console.log(`[guard] 插件故障后宿主/沙箱继续运行：${await box.runSingleCycle("still alive?")}`);

  // 7) 全链路轨迹日志
  const journal = host.traceJournal.dumpJournalCopy();
  console.log(`[trace] 轨迹共 ${journal.length} 条：`);
  for (const entry of journal) {
    const who = entry.pluginUnitId ?? entry.agentBoxId ?? "-";
    console.log(`   · [${entry.entryClass}] ${who} ${JSON.stringify(entry.factPayload)}`);
  }

  // 8) 宿主停止：反向顺序释放全部资源
  await host.shutdownHost();
  console.log("");
  console.log("[shutdown] 宿主已停止，沙箱池/插件注册/防护器/通道/轨迹全部释放");
}

main().catch((err: unknown) => {
  console.error("demo failed:", err);
  process.exit(1);
});
