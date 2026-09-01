# Orbit Agent Runtime · 架构说明

> 配套图：[architecture.svg](./architecture.svg)

本文以架构审查视角说明设计决策，而非重复注释。

## 0. 设计原则

1. **分层即依赖契约**：`types → utils → core → channel/pact/safeguard/trace → sandbox → runtime_host`，依赖只允许向下。任何"上层需要下层能力但方向不允许"的需求，一律通过**注入**解决，而非打破分层。
2. **封装默认私有**：所有内部 `Map`/`List` 私有，对外查询一律返回副本，外部无法篡改内核状态。
3. **错误是领域公民**：所有失败路径都是 `OrbitDomainError` 子类，携带 `errorToken` + `traceMarkId`（+ `pluginUnitId`），错误不是魔法字符串，不是裸 `Error`。
4. **资源生命周期闭环**：谁创建谁释放。定时器、通道、防护器、轨迹在 shutdown 时按依赖逆序回收，无残留。

## 1. 分层职责

| 层 | 职责 | 禁止事项 |
|---|---|---|
| types | 领域契约：类型/枚举/接口 | 不包含任何逻辑 |
| utils | 版本解析、唯一 ID 生成 | 不依赖任何业务层 |
| core | 统一异常体系 | 不含业务实现 |
| channel | 能力通道：注册/调度/超时/降级 | **不 import pact**（能力裁决经 `CapabilityGate` 注入） |
| pact | 插件规约三查：字段/版本/能力 | 不感知通道内部实现 |
| safeguard | 跳闸状态机 + 插件级故障隔离 | 不感知具体插件业务 |
| trace | 追加式轨迹日志、快照、筛选 | 不参与业务决策 |
| sandbox | 沙箱执行 + 池化管理 | 不直接调用 LLM/IO，一律走通道 |
| runtime_host | 组件装配、生命周期、门面 API | 不含业务逻辑，只做编排 |

## 2. 关键机制

### 2.1 能力通道（Channel）

所有外部能力（模型、存储、IO）抽象为通道。通道分两级：

- **内置通道**：内核自带（`MemoryKvChannel`、`LlmMockChannel`），稳定兜底；
- **插件扩展通道**：插件可覆盖同类型内置通道。

调用优先级：**插件通道优先 → 内置通道兜底**。每次调用自带**超时截断**（`maxWaitMs`）与可选**降级回退**（`fireChannelCallWithFallback`）。

方法派发是**有意动态**的：插件通道可暴露宿主编译期不可知的方法名，因此以运行时按名查找实现，断言收敛于一处并注释动机。

### 2.2 能力裁决（CapabilityGate）

插件的通道调用必须通过其 `allowCapabilities` 声明。`ChannelHub` 不持有 `PluginPactVerifier` 引用，而是由宿主在装配期注入一个裁决函数——**依赖方向保持 channel → (无) → pact**，同时权限闭环成立。这是"分层单向 + 跨层校验"的典型注入解法。

### 2.3 跳闸保护（TripProtector）

三态状态机：`NORMAL → TRIPPED → PROBE`。

- 连续失败达阈值 → 跳闸，直接快速失败；
- 冷却期后进入探测，**单次成功即恢复**（Agent 业务对瞬时抖动敏感，选择激进恢复策略，与通用熔断器的采样窗口策略刻意不同）；
- 每个插件拥有**独立保护器**（`PluginSandboxGuard` 内按插件 ID 维护 Map），单插件故障不扩散。

### 2.4 轨迹日志（TraceJournal）

追加式行为日志，覆盖宿主行为、沙箱运行、插件异常、通道调用。支持：

- 全量导出（`entries`）、按链路（`byTraceMark`）、按沙箱（`byAgentBox`）筛选；
- 快照保存与恢复（`snapshot` / `restoreSnapshot`），支撑审计与复盘。

### 2.5 沙箱与循环预算

每个智能体一个 `AgentSandbox`，持有独立循环计数。`cycleCount > maxCycleRun` 时抛 `CycleLimitReachedError`——**超限是错误不是返回值**，调用方必须显式处理，避免"halt 提示被当成正常输出"的隐蔽错误。每轮运行生成独立 `traceMarkId`，全链路可串接。

## 3. 运行时关键路径（一次 Agent 循环）

```
Client ──① runSingleCycle(input)──► AgentSandbox
                                        │ traceMarkId = gen(); cycleCount++
                                        ▼
AgentSandbox ──② fireChannelCall(LLM_ACCESS, ctx)──► ChannelHub
                                                        │
                                          ┌─────────────┤
                                          │ ③ CapabilityGate（仅当 ctx.pluginUnitId）
                                          │    未声明能力 → ChannelCallFaultError
                                          ▼
                                         ④ simulateChatRound(prompt)   [超时截断]
                                          │
                                          ▼
                                         llmOutput ──⑤ 返回──► AgentSandbox
                                                                   │
                                                                   ▼
                                             ⑥ journal.append(AGENT_SINGLE_CYCLE_EXEC)
```

关键点：沙箱**从不直接触达 LLM**，一切经通道；能力裁决、超时、轨迹三件事都在通道闸口完成，业务代码保持纯净。

## 4. 生命周期

**boot（自底向上）**：注册内置通道 + 注入 CapabilityGate → 全部通道 `setup`（KV 清扫定时器启动）→ 就绪。

**shutdown（自顶向下反向释放）**：沙箱池 `clear` → 规约表 `clear` → 防护器 `releaseAllGuard` → 通道 `teardown`（含定时器清理）→ 轨迹 `clear`。

## 5. 三支柱（M2–M4）落地

### 5.1 确定性重放（M2）

**问题**：LLM 采样、随机数、时钟、调度时序任意一个变化，同样输入跑两遍就是两个结果——Agent 的 bug 无法稳定复现。

**设计**：所有通道调用记录进 `RecordJournal`（按全局调用序号索引，输入摘要 + 输出冻结快照）；`ReplayEngine` 在重放模式下**查表注入**输出，零真实执行；对账（`reconcile`）按 digest 链校验重放轨迹与原始轨迹一致，任何篡改即报 `ReplayDriftError` 并定位到具体调用。

**契约**：通道声明 `determinismMeta`（deterministic / stochastic / io-bound）；约定通道不得直调 `Math.random` / `Date.now`，随机与时钟经注入的 `RngSource` / `ClockSource`（`SeededRng` / `FixedClock`）获取。

**实测**：3 轮循环真实执行 ~978ms → 重放 2ms，输出逐字节一致，`REPLAY VERIFIED`。

### 5.2 故障影响域图论内核（M3）

**问题**：传统隔离是"经验式统计保护"（熔断器），无法回答"谁坏了会波及谁"。

**设计**：依赖关系建模为有向图（`dependent → dependency`），故障沿**反向边**传播。节点 x 的故障影响域 = x 的反向可达闭包（`ImpactDomainGraph.closure`）；**隔离定理**：a、b 互不落入对方闭包 ⇔ 二者故障互不波及（`areIndependent`）。闭包外零干预、零降级。

**静态验证**：注册插件时断言"声明的通道依赖 ⊆ 声明的能力"（能力闭包校验），越权在注册期被图契约拦截。

**差异化阈值**：插件依赖面越广（`outDegree` 越大），跳闸阈值越严（`max(2, 5 - outDegree)`）——精算式风险定价。

### 5.3 成本感知路由（M4）

**问题**：模型调用昂贵，运行时没有成本治理。

**设计**：通道声明 `ChannelCostMeta`（成本 / 预期延迟 / 质量）；`CostRouter.choose` 在预算与延迟约束下选择最廉价候选；沙箱配置 `budgetPerCycle` 后，每轮调用前路由，预算不足抛 `BudgetExhaustedError`——**预测性治理（预算）与反应性保护（跳闸）双机制并存**。

## 6. 设计决策记录（ADR 摘要）

| 决策 | 备选 | 理由 |
|---|---|---|
| 通道方法动态派发 | 编译期方法表 | 插件方法名宿主不可预知；断言收敛单点 |
| 能力裁决用注入函数 | channel 直接依赖 pact | 保持 channel 层零反向依赖，杜绝循环 |
| 循环超限抛异常 | 返回提示字符串 | 错误必须显式可见，不能伪装成业务输出 |
| 探测单次成功即恢复 | 采样窗口统计 | Agent 场景对瞬时抖动敏感，激进恢复 |
| CommonJS + tsc | ESM/NodeNext | import 无扩展名，零打包零运行时依赖 |

## 7. 已知边界与演进

- 确定性重放目前覆盖**通道调用层**（模型/存储）；调度时序的确定性依赖串行执行，多沙箱并发时需确定性调度器（后续演进）；
- 影响域图基于静态声明（`declareChannelDeps` / `channelDeps`）构建，运行时动态依赖暂不自动发现；
- 成本路由当前是单能力多候选的最小闭环，多模型市场 / 跨通道竞价是自然扩展方向；
- 真实 LLM 通道（STOCHASTIC）的种子注入契约已就绪，等待第一个真实 provider 落地验证。

## 8. 仓库结构（Monorepo / 抽包）

内核从单一 `src/` 树重构为 npm workspaces + TypeScript Project References 四包，
公共 API（`src/index.ts`）保持不变，拆分仅在内核内部。

| 包 | 路径 | 职责 | 依赖 |
|---|---|---|---|
| `@orbit/infra-common` | `packages/infra-common` | 领域契约 / 纯工具 / 异常体系（`types`·`utils`·`core`） | — |
| `@orbit/core-hub` | `packages/core-hub` | 通道 / 网关 / replay / trace / pact / safeguard / routing | infra-common |
| `@orbit/sandbox-runtime` | `packages/sandbox-runtime` | 沙箱 / 影响域图 / 隔离域 | infra-common, core-hub |
| `@orbit/pae-engine` | `packages/pae-engine` | 插件适配引擎（JS / MCP / OpenAPI / Cordis） | infra-common, core-hub |
| 宿主（root） | `src/`（`core/orbitRuntimeHost.ts` + `index.ts`） | 组件装配与门面 | 全部包 |
| `@orbit/admin-console` *(app)* | `web/` | Web 管理控制台（经 bridge 驱动真实内核实例） | 宿主（`dist/`） |

依赖分层无环：`infra-common → core-hub → { sandbox-runtime, pae-engine } → host`。
各包 `composite: true` 且 `references` 指向依赖，`tsc -b` 自底向上构建；跨包导入一律
走 `@orbit/*` 限定符，`npm install` 经 `node_modules/@orbit/*` 符号链接接包。抽包期间
公共 API 与重放契约零回归（290 内核测试 + 89 前端测试全绿）。

## 9. 日志持久化（W27）

一个以「重放 + 审计」为核心的内核，如果日志随进程退出蒸发，架构是不闭合的。W27 给
两类日志各挂一份**崩溃安全的预写日志（WAL）**：审计日志 `TraceJournal` 与录制窗口
`RecordJournal`。

### 9.1 崩溃模型：为什么是「一行一条 JSON」

一次写入只追加**一整行**，因此崩溃唯一能留下的残留形态是**最后一行被截断**。恢复策略
由此可以严格二分，不需要校验和、不需要双写：

| 位置 | 形态 | 处置 | 理由 |
|---|---|---|---|
| 末行 | JSON 解析失败 / 结构不完整 | **丢弃** | 这正是崩溃的唯一可能残留 |
| 内部行 | 解析失败 / 结构非法 | **拒绝**（`WalFileInvalidError` 带行号） | 内部行不可能被崩溃截断 → 是真实故障，静默跳过等于隐藏损坏 |

### 9.2 真源与镜像

内存日志是**唯一真源**，WAL 是它的耐久镜像：写入是 fire-and-forget，经 `writeChain`
串行化以保证行不交错，`flush()` 在关闭时 await 挂起链。这样磁盘异常不会打断在途调用，
但关闭路径仍保证「最后一批条目不丢」。

恢复保留原始 `entryUid` / `occurredAt` / `orderIndex`，因此恢复出的条目与原条目**逐字节
一致**，既不扰动审计顺序，也不破坏重放：跨进程续写的录制窗口 `orderIndex` 顺延而非归零，
一次被进程边界切开的运行仍然重放为**一条连续序列**。

### 9.3 自愈：截断尾行必须在首次追加前物理清除

这是本层最容易踩空的一处。恢复虽然容忍截断的末行，但那一行**仍在磁盘上**；一旦本次运行
追加了新行，它就从「末行」变成了「内部行」——而内部非法行是硬故障。也就是说：**一次崩溃
会让此后每一次启动都失败**。

因此恢复路径在首次追加前调用 `healIfNeeded()`：比对「物理行数」与「恢复条目数」，不一致
才以 `walCompact` 从存活前缀原子重写（临时文件 + rename，崩在压缩中只会留下上一代完整
文件）。健康日志零重写，代价只有一次行数统计。

### 9.4 有界留存

append-only 日志无上限增长最终会打满磁盘，而磁盘满是一次宕机。留存因此是**显式的、由
运维选择的**，不设隐式默认：`auditRetention` 只保留最新 N 条并把 WAL 压缩到一致，在启动
与关闭各应用一次，另有 `pruneAuditLog()` 供长运行实例按需裁剪。关闭路径的顺序是先
`flush` 再裁剪——顺序反了，被排空的在途写入会把文件重新顶过上界。

### 9.5 接线与默认行为

```ts
const host = new OrbitRuntimeHost({
  traceJournalPath: ".orbit/trace.wal.jsonl",
  recordJournalPath: ".orbit/record.wal.jsonl",
  auditRetention: 10_000
});
await host.bootHost();          // 先恢复（含自愈）→ 再装配通道 → 续开录制窗口
await host.shutdownHost();      // 排空在途写入 → 应用留存 → 逐层拆卸
```

`bootHost` 的顺序是有意的：恢复会重建整条链，必须先于任何可能追加的动作，否则通道装配
期产生的审计条目会被恢复快照覆盖掉。

不传路径即退化为纯内存——与 v0.3.x 行为逐字节一致，持久化按路径**选择性开启**，磁盘轨迹
格式未变，旧轨迹照常重放。

## 10. 治理档位（W29，VISION §3.1 落地）

治理强度可切换，能力面永不砍——这是 VISION 公理，也是本轮实现的裁决原则。

### 10.1 契约与解析

`GovernanceProfile`（`infra-common/types/governance.ts`）把 VISION §3.1 的四档收敛为
纯配置对象，`resolveGovernanceProfile(name)` 解析，`governanceProfileHash()` 给指纹。

| 档位 | 压缩 | 限流（窗口计数） | 熔断 | PAE 准入 | 轨迹 |
|---|---|---|---|---|---|
| `sandbox` | off | 1000 | 5 次 / 冷却 30s | 全部 | 内存 |
| `standard`（默认） | normal | 100 | 5 次 / 冷却 10s | 全部 | 可选落盘 |
| `strict` | aggressive（阈值减半） | 60 | 3 次 / 冷却 5s（下限 1） | 关闭 | **强制落盘** |

`standard` 是 v0.5.x 数字的**逐字一致**（有测试断言）——默认宿主行为不因本机制而变。

### 10.2 注入与确定性

- 限流：`RateLimiter` 是**纯调用计数预算**（无墙钟窗口），profile 只改数量，机制不动——
  重放确定性是机制属性，档位只是参数。
- 熔断：`tripThresholdForProfile` 以 profile 阈值为基准，按插件依赖出度软化
  （strict 下限 1，其余 2）。
- 压缩：`tokenBudgetConfigForProfile` 映射到 `TokenBudgetEngine`（off/normal/aggressive）。
- PAE 准入：`assertPaeKindAdmitted` 在注册/连接**之前**检查；strict 关闭外部运行时，
  connect 路径在握手前拒绝（不 spawn 子进程）。
- 轨迹：strict 构造期强制 `traceJournalPath`，缺省即抛错。

### 10.3 指纹与配置漂移

非默认档把 `governanceProfileHash` 写入运行指纹；`verifyFingerprint` 对比（双方缺省 =
兼容，同 `paeAdaptersHash` 模式）。因此**跨档重放报 `RunFingerprintDriftError`**（配置
漂移），与 tokenConfigHash 同一契约。`standard` 档省略字段，默认宿主指纹与旧版逐字节一致。

### 10.4 与 VISION 原始表的偏差（工程裁决）

- **standard 的 PAE 准入为全部**而非原始表的 "MCP+JS"：治理公理"为治理不砍功能"优先，
  且 OpenAPI/Cordis 是已发布能力（初始按表实现反而破坏了 cordis/openapi 既有测试）。
- **限流数字的语义**："1000/min" 落地为"每窗口 1000 次"（纯计数窗口，保证可重放）。
- 信任推定 / Schema 校验 / 轨迹签名仍属演进面（隔离域分配与哈希链审计），未成为档位字段。
