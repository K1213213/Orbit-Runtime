# Orbit Agent Runtime · 升级方案阻断项解决设计

> 对应文档：《研发架构设计与开发计划》《详细设计文档：内核网关+PAE异构适配体系》
> 本文解决评审发现的两个阻断项：**A. 确定性重放 × 新架构兼容性**、**B. 代码迁移策略**。
> 原则：护城河优先（确定性重放不可牺牲）、功能先于结构、任何一步可回退。

---

## A. 确定性重放 × 新架构兼容性设计

### A.0 问题精确化

确定性重放的契约：**同一输入序列 → 同一调用序列**（orderIndex 一一对应），重放时按序注入输出快照，签名不匹配即 `ReplayDriftError`。

升级方案引入的非确定性源及其对 digest 链的破坏：

| 破坏源 | 破坏机制 | 严重度 |
|---|---|---|
| Token 三级压缩 | 压缩改变送入 LLM 的文本 → inputDigest 漂移；若压缩器含随机/时间依赖则不可重放 | 高 |
| 行为采集器契约修正 | 运行时修改 Pact（权限/预算）→ 校验决策变化 → 调用序列变化 | 高 |
| 隔离域子进程调度 | 跨进程调用若绕过网关，不进 RecordJournal → 重放缺号 | 高 |
| 限流 | 时间窗口判定在 record/replay 两次执行中可能不同 → 调用序列变化 | 中 |
| Token 消耗统计 | 纯记账，不影响调用序列 | 无 |

### A.1 设计原则（四条硬约束）

1. **确定性边界在网关，不在插件**：所有非确定性决策（校验/压缩/路由/限流/预算）在统一网关入口产生并被记录；插件与适配器无权自行引入不确定性。
2. **新机制的确定性由实现保证，不是靠自觉**：压缩器必须是纯函数（同输入同输出，禁随机/禁时间依赖）；限流与采集在重放模式下旁路。
3. **记录决策 + 注入结果**：网关每次调用记录"决策快照 + 执行结果"，重放时先恢复决策、再注入输出——预算压缩/熔断/路由按记录时原样重放。
4. **轨迹绑定版本指纹**：内核版本、pact 版本、Token 配置、PAE 开关的哈希进入运行指纹；配置漂移与调用漂移分开诊断。

### A.2 机制设计：网关调用记录（GatewayCallRecord）

现有 `ReplayCallRecord` 升级（`decision` 与 `runFingerprint` 均为可选字段，旧记录向后兼容可重放）：

```ts
interface RunVersionFingerprint {
  kernelVersion: string;
  pactVersions: Record<string, string>;   // pluginId -> pact version
  tokenConfigHash: string;                 // Token 预算/压缩阈值配置指纹
  paeEnabled: boolean;
}

interface GatewayCallRecord {
  // —— 现有字段（通道级）——
  entryUid: string;
  orderIndex: number;
  channelKind: ChannelKind;
  funcName: string;
  inputDigest: string;
  outputSnapshot: unknown;
  durationMs: number;
  // —— 新增：网关决策快照（升级后）——
  decision?: {
    tripAllowed: boolean;              // 熔断放行结果
    pactPass: boolean;                 // 契约校验结果（含 Schema）
    budget: { allow: boolean; strategy: "normal" | "shrink" | "stop" };
    compression: { level: "conservative" | "normal" | "aggressive"; applied: boolean };
    route: "native" | "pae";           // 原生 / PAE 适配路由
    rateLimited: boolean;              // 限流判定（replay 旁路，记录原值）
  };
  runFingerprint?: RunVersionFingerprint;
}
```

重放语义：按 orderIndex 依次（1）校验 `runFingerprint` 一致 →（2）恢复 `decision`（四重校验直接查表，不实时计算）→（3）注入 `outputSnapshot`。任何一步不一致 → 明确报错类别（配置漂移 / 决策漂移 / 调用漂移），不再是笼统的 digest 不匹配。

### A.3 各破坏源的落地约束

**① Token 预算引擎（压缩器纯函数化）**
- `TokenBudgetEngine.shrinkContext()` 必须是纯函数：同输入上下文 + 同阈值配置 → 同压缩结果。禁止随机、禁止 `Date.now()` 参与决策。
- 阈值（0.7 / 0.4）来自配置；配置内容哈希进 `runFingerprint.tokenConfigHash`。
- record 模式下压缩正常发生（inputDigest = digest(压缩后文本)）；replay 时同配置同输入走同一纯函数 → digest 一致。
- 测试强制：压缩器单测断言"同输入双跑结果逐字节一致"；CI 拦截任何含 `Math.random` / `Date.now` 的压缩实现（代码评审清单项）。

**② 行为采集器（三模式语义）**
| 模式 | 行为 |
|---|---|
| record | 只采集不修改（记录调用/资源/成本到 TraceJournal） |
| live | 采集 + 生成契约修正提案（**人工审核后** apply） |
| replay | 完全旁路（重放是注入的调用，不污染行为基线——否则重放千次会伪造千次调用记录） |

- 契约修正 `apply` 是**注册期事件**：apply 后启动新的运行窗口（新 record/replay），**已记录轨迹绑定旧 pact 版本**，经 `runFingerprint.pactVersions` 区分，互不影响。

**③ 隔离域子进程调度**
- PAE 适配器（MCP/Cordis/JS/OpenAPI）**只能通过网关代理与内核交互**（架构铁律已有），跨进程调用天然进入 RecordJournal。
- 隔离域内插件同样遵守通道契约：随机经注入 `RngSource`、时钟经 `ClockSource`，禁止直调 `Math.random` / `Date.now`——与现有通道约定一致，子进程不引入额外非确定性。

**④ 限流（重放旁路）**
- `rateLimitCheck` 是实时保护，不是业务语义。record 模式记录判定结果到 `decision.rateLimited`；replay 模式**不实时计算**，直接恢复记录值。保证 record/replay 调用序列一致。

**⑤ Token 消耗统计**
- 纯记账（`budget.used += ...`），不参与调用序列 → 无需特殊处理；统计事件照常进 TraceJournal。

### A.4 统一网关入口（capabilityInvoke）= 确定性边界

方案要求的新组件 `capabilityInvoke` 统一入口，恰好是确定性边界的落点：**所有非确定性源在入口处被记录、在重放时被恢复**。实施时：

```ts
// 网关统一入口：四重校验 → 记录决策 → 执行 → 记录结果 → 审计
async function capabilityInvoke(traceId, taskId, pluginId, capabilityName, args, mode: ReplayMode) {
  const orderIndex = recorder.nextOrderIndex();
  if (mode === "replay") {
    // 重放：恢复决策 + 注入输出（不执行任何实时校验/调用）
    return recorder.replay(orderIndex, capabilityName);
  }
  // record/live：实时四重校验，决策入记录
  const decision = {
    tripAllowed: tripProtector.preCallCheck(pluginId),
    pactPass: pactValidator.validateRuntime(pluginId, capabilityName, args).pass,
    budget: tokenBudget.beforeLlmCall(taskId, context),
    rateLimited: rateLimit.check(pluginId),
    route: routeResolver.resolve(pluginId)
  };
  recorder.recordDecision(orderIndex, decision);
  // ……执行（原生 / PAE 代理），结果入记录，审计埋点……
}
```

> 当前代码落点：`ChannelHub.fireChannelCall` 是事实上的通道闸口，`capabilityInvoke` 在其之上加"校验层 + 决策记录层"，不推翻现有通道机制。

### A.5 测试策略（replay 兼容性测试套件）

新增 `test/replay_compat.test.ts`，对**每个新机制**强制"record → replay 逐字节一致"：

| 用例 | 断言 |
|---|---|
| 压缩开启时 record/replay | 同输入同配置，output 一致，digest 链一致 |
| 压缩器纯函数性 | 同输入双跑，压缩结果逐字节相同 |
| 限流开启时 record/replay | record 被限流的调用在 replay 中同样被限流（决策恢复） |
| 行为采集 record 模式 | 只采集不修改，pact 不变 |
| 行为采集 replay 模式 | 完全旁路，不产生行为记录 |
| 契约修正 apply 后 | 新窗口正常重放，旧轨迹指纹区分、互不污染 |
| 版本指纹漂移 | 配置变化 → 报"配置漂移"而非 digest 漂移 |

CI 新增门禁：以上用例全绿才允许合并——**新机制进入内核的前提是 replay 兼容**。

### A.6 结论

确定性边界从通道层提升到网关层后，确定性重放从"通道特性"升级为"**运行时全链路特性**"：预算压缩、熔断、路由、限流全部可重放、可审计。这是对手（DSH 无任何重放能力）无法复制的组合壁垒——**升级不但不牺牲护城河，反而加固了它**。

---

## B. 代码迁移策略（三段式渐进迁移）

### B.0 决策

不采用方案文档的"Monorepo 先行"，采用**先加层、后抽包、最后工具链**的三段式。理由：当前 1450 行内核干净、59 测试全绿、web 控制台在跑；一次性重构会让"新功能开发"与"结构重构"叠加成双倍风险，且无法回退。

### B.1 阶段 1：增量加层（保持单包，2-4 周）

- 现有文件路径**一律不动**（现有测试/demo/web 零改动继续绿）。
- 新增目录（单包内）：
  - `src/gateway/` → `capabilityInvoke` 统一入口 + 决策记录（A.4）
  - `src/token-budget/` → TokenBudgetEngine（纯函数压缩器）
  - `src/pae/` → 四类适配器 + 动态 Pact + 隔离域 + 行为采集
  - `src/api/` → REST 网关（复用现有 bridge-server 演进）
- 现有模块原地扩展：`PluginPactVerifier` 加 Schema 校验、`TraceJournal` 加异步批量落盘、`TripProtector` 阈值进 Pact。
- 里程碑：**PAE 跑通 + 网关统一入口上线，Monorepo 未动**。

### B.2 阶段 2：接口稳定后抽包（2-3 周）

- 用 **TypeScript Project References** 划分包边界（编译期强制依赖方向，替代目录约定）。
- 抽包顺序**自底向上**，每抽一个包全量回归（59+ 测试 + 双 demo + web）通过才继续：
  1. `infra-common`：`src/types` + `src/utils` + `src/core`（错误体系）
  2. `core-hub`：`channel` + `pact` + `safeguard` + `trace` + `replay` + `graph` + `routing` + 新 `gateway`
  3. `sandbox-runtime`：`sandbox`
  4. `pae-engine`：`pae`（对外无依赖的纯适配层，最易抽）
- **抽包期间公共 API（`src/index.ts`）保持不变**——包内部重构不破坏外部使用。

### B.3 阶段 3：Monorepo 工具链（1-2 周）

- pnpm workspace + 各包独立 version/test。
- 现有资产映射：

| 现有 | 目标包 | 改动 |
|---|---|---|
| src/types + utils + core | infra-common | 平移 |
| src/channel/pact/safeguard/trace/replay/graph/routing + core/orbitRuntimeHost | core-hub | 平移 + 统一入口 |
| src/sandbox | sandbox-runtime | 平移 |
| src/pae | pae-engine | 平移 |
| web/* | admin-console | bridge-server 保留为 dev 桥 |
| demo-* / test | examples / 各包 tests | 分布 |

### B.4 门禁（每阶段）

- 阶段 1 结束：新功能测试全绿、现有测试零回归、web 控制台可用。
- 阶段 2 结束：抽包后公共 API 无变化、全量测试全绿、构建产物行为一致。
- 阶段 3 结束：pnpm 安装/构建/测试全链路跑通，CI 更新为 workspace 模式。

---

## C. 实施顺序建议

1. **先做 A 的 A.4 落地**：`capabilityInvoke` 统一入口 + 决策记录（它是确定性边界，也是 B 阶段 2 抽包的骨架）。
2. 并行启动 TokenBudgetEngine（纯函数压缩器，独立可测）。
3. PAE 按"JS 适配器 → MCP 适配器 → Cordis 隔离"顺序（难度递增），每类适配器带 replay 兼容测试。
4. B 的三阶段穿插在功能稳定间隙进行，不在功能开发高峰并发。

> 任何一步失败可回退：单包阶段无结构性改动，抽包阶段每包独立可回退，工具链阶段不影响源码。
