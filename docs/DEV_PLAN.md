# Orbit Agent Runtime · 研发计划（DEV_PLAN v1.0）

> 状态：**执行中** · 日期：2026-08-29 · 依据：PRODUCT_PLAN v1.1（开源产品轨道）+ UPGRADE_PLAN（架构升级）+ VISION（宪章门禁）
> 一句话：**6 周到开源发布（v0.1.0），再用 8 周落网关确定性边界（v0.2.0），最后 12 周接生态（v0.3.0）。**

---

## 0. 排期总决策：产品先行，架构随行

两条轨道存在真实的资源竞争：

| 轨道 | 内容 | 来源文档 |
|---|---|---|
| **T1 产品** | 真实 provider、File/Shell 通道、持久化、CLI、npm 发布、CI | PRODUCT_PLAN §5.2 / 开源就绪清单未勾 6 项 |
| **T2 架构** | capabilityInvoke 网关统一入口、TokenBudgetEngine、PAE 适配器、抽包 Monorepo | UPGRADE_PLAN A/B |

**决策：T1 全部完成并开源发布后，才启动 T2。** 理由：

1. **就绪清单即发布门槛**：P0.3 之前做 T2 是给未发布的项目加复杂度——没有用户就没有升级压力。
2. **T1 不欠架构债**：真实 provider/File/Shell 通道**复用现有通道契约**（DeterminismLevel + RecordJournal），确定性边界暂留通道层，重放语义零妥协——宪章 A1 不因先行而稀释。
3. **T2 的 A.4 网关入口是抽包骨架**（UPGRADE_PLAN §C.1），它晚做不损失什么，但早做会阻塞 T1 的发布窗口。
4. **每一步可回退**：T1 全部是加层（新 provider/新通道/CLI），不动内核结构。

**唯一例外**：T2 的 `replay_compat.test.ts` 测试套件（UPGRADE_PLAN A.5）提前到 T1 期间建立——它是空转门禁（每加一个新通道立即补 record→replay 用例），成本极低，防患于未然。

---

## 1. 三个 Release 波次

| 版本 | 时间盒 | 主题 | 发布退出标准 |
|---|---|---|---|
| **v0.1.0** | W1–W6 | **开源发布**：真能力 + CLI + npm | 就绪清单 14/14 勾满；陌生开发者按 README 10 分钟跑通 record→replay |
| **v0.2.0** | W7–W14 | **网关确定性边界**：capabilityInvoke + 决策记录 | 开启压缩/限流/熔断状态下的 record→replay 逐字节一致（replay_compat 全绿） |
| **v0.3.0** | W15–W26 | **生态接入**：PAE 适配器 + 抽包 Monorepo | MCP 插件经网关接入且四重校验不降级；monorepo workspace 全链路绿（npm workspaces；pnpm 迁移延后） |
| **v0.4.0** | W27 | **日志持久化**：审计日志与录制窗口的崩溃安全 WAL | 进程重启后审计轨迹与录制窗口存活；跨进程录制窗口重放逐字节一致；崩溃截断日志可恢复并自愈 |
| **v0.5.0** | W28 | **工程硬化与发布准备**：examples + benchmarks + CI 覆盖闭合 | 每个示例独立跑通且失败非零退出；每套基准可独立运行；CI 覆盖内核+控制台+示例+基准 |
| **v0.6.0** | W29 | **四档治理模式落地**：VISION §3.1 从设计目标变为可切换配置 | profile 契约 + 宿主选项 + 机制注入（限流/熔断/压缩/PAE 准入/轨迹持久化）+ 跨档重放报配置漂移；standard 与旧行为逐字一致 |

版本号策略：宪章前语义化版本不承诺稳定 API（pre-alpha），v0.x.minor = 波次，patch = 修复。

---

## 2. 逐周计划

### 波次 1 · v0.1.0 开源发布（W1–W6）

| 周 | 工作流 | 交付物 | 退出标准 |
|---|---|---|---|
| **W1** | ① `OpenAICompatChannel` 生产化：超时/重试/错误分类、STOCHASTIC 种子注入契约落地（`response_format`/`seed` 参数透传）② FileChannel（read/write/list，IO_BOUND 快照注入语义） | `src/channel/providers/*.ts` + 单测 | 真实 DeepSeek 跑通 5 步流程 record→replay 逐字节一致 |
| **W2** | ③ ShellChannel（命令白名单 + 超时 + IO_BOUND）④ `replay_compat.test.ts` 套件建立（File/Shell/OpenAICompat 各补用例）⑤ JSONL 轨迹持久化（RecordJournal 落盘/加载，跨进程重放） | Shell 通道 + `src/replay/persistence.ts` + JSONL 用例 | **P0.1 完成**：关掉网络重放跨进程轨迹，输出一致 |
| **W3** | ⑥ `orbit` CLI：`record <script>` / `replay <trace>` / `diff <a> <b>`（bin 字段 + shebang，零额外依赖） | `bin/orbit.mjs` + `package.json` bin | ✅ 本机三命令闭环；diff 能定位 digest 链断裂点（集成测试 4/4） |
| **W4** | ⑦ CLI 打磨：错误信息、退出码、`--json` 输出 ⑧ 快速上手文档（README Getting Started 重写为 CLI 优先）+ "写一个可重放通道"开发者指南 | docs/guide.md | ✅ 双语 README CLI 优先 + guide.md |
| **W5** | ⑨ CI（GitHub Actions：lint+build+test+demo，Node 20/22 双版本矩阵）⑩ npm 发包演练（dry-run）⑪ issue/PR 模板 | `.github/workflows/ci.yml` | ✅ CI 矩阵 + `npm publish --dry-run` 无告警 + 模板 |
| **W6** | ⑫ **公开发布**：npm publish、GitHub 仓库公开、landing README 首屏、技术博客《Agent bug 为什么不可复现》（已写：docs/blog/why-agent-bugs-unreproducible.md） | v0.1.0 tag | ⏳ 待用户动作：真实 npm publish + 仓库公开 + landing + demo 视频 |

**波次 1 门禁**（每周检查）：59+ 测试零回归 · strict 编译零错误 · 每个新通道带 replay 用例 · 零运行时依赖不破（CLI 用 node 内置模块）。

### 波次 2 · v0.2.0 网关确定性边界（W7–W14）

| 周 | 工作流 | 依据 |
|---|---|---|
| **W7 ✅ / W8 ✅** | **W7 完成（2026-08-29）**：`src/gateway/capabilityInvoke` 统一入口已落地——在 `ChannelHub.fireChannelCall` 之上加校验层 + `GatewayCallRecord`（decision + runFingerprint 可选字段，旧轨迹向后兼容）；record 写入决策、replay 还原决策并校验运行指纹（配置漂移报 `RunFingerprintDriftError`，与 digest 漂移分离）、重放重验能力门禁、零真实执行注入；7 用例网关测试全绿。**W8 完成**：`TokenBudgetEngine` 纯函数压缩器（禁 Math.random/Date.now）落地——确定性 token 估算 + 头截压缩 + 累计用量预算决策 + 配置哈希；宿主 `budgetDecision`/`compression`/`route`/`tokenConfigHash` 从字面 stub 改为由引擎/通道注册表计算，`registerPaeAdapter` 驱动 route 翻转、LLM 输出累计喂预算；网关测试新增 tokenConfigHash 漂移（RunFingerprintDriftError）/route 翻转/累计用量触发 budget shrink，引擎单测 7 例；全量 134 测试绿、strict 编译零错误 | UPGRADE A.2/A.4 |
| **W9–W10 ✅** | **W9–W10 完成（2026-08-29）**：压缩真正作用于落盘 payload——`TokenBudgetEngine` 新增 `packSnapshot`/`compressPayload`/`decompressPayload`/`isCompressedPayload`/`decideCompression`（node:zlib 确定性 deflate，零外部依赖）；网关 `execute` 按 payload 字节阈值压缩存储快照、`replay` 透明解压还原原始值，消费者始终拿到原值、重放逐字节一致（A1/A2 不被破坏）；`GatewayDecision.compression` 增加 `bytesSaved` 审计字段；宿主 compression checker 改为 payload 感知。引擎单测 3 例 + 网关端到端 1 例（大输出 applied=true+bytesSaved>0 且重放返回同一字符串），全量 138 测试绿、strict 编译零错误 | UPGRADE A.3① |
| **W11 ✅** | **W11 完成（2026-08-29）**：`RateLimiter` 纯函数调用计数限流（禁随机/禁时钟）落地；`rateLimited` 决策记录原值、重放旁路还原；`BehaviorCollector` 三模式（record 采集落盘 / live 提案不落盘 / replay 旁路）；宿主接线 RateLimiter + BehaviorCollector，checkers 增 estimateTokens/consumeRateLimit。单测 6 例（限流 3 + 采集 3） | UPGRADE A.3②④ |
| **W12 ✅** | **W12 完成（2026-08-29）**：`replay_compat` 网关确定性门禁扩充至 7 类用例（压缩/限流×2/采集×2/指纹漂移/决策漂移），全部进 CI 合并前置；与既有 W7-W9 网关测试共同构成 v0.2 边界门禁 | UPGRADE A.5 |
| **W13–W14 ✅** | **W13–W14 完成（2026-08-29）**：三分漂移分类上线——配置漂移 `RunFingerprintDriftError`、决策漂移 `DecisionDriftError`（pact 撤销重分类）、调用漂移 `ReplayDriftError`；`ReconcileReport` 增 `decisionDriftFields`；CHANGELOG/README/VISION/DEV_PLAN 同步；v0.2.0 发布（KERNEL_VERSION 与 package.json 升 0.2.0，tag v0.2.0）。全量 151 测试绿、strict 编译零错误 | UPGRADE A.2 |

**波次 2 门禁**：Architecture Gate 8 条逐项过（VISION）· replay_compat 全绿为合并前置 · 现有 v0.1 轨迹在 v0.2 内核上可重放（向后兼容验证）。

### 波次 3 · v0.3.0 生态接入与抽包（W15–W26，概要）

| 阶段 | 内容 | 依据 |
|---|---|---|
| **W15 ✅ / W16 ✅ / W17 ✅ / W18 ✅** | **W15 完成（2026-08-29）**：PAE 契约层 + 注册表 + PaeChannel + JsPaeAdapter；外来 JS 运行时经网关代理、四重校验、replay 零重入；适配面配置哈希进指纹。**W16 完成（2026-08-30）**：MCP 适配器（JSON-RPC 2.0 协议层 / stdio + memory 双传输 / McpPaeAdapter，L2 跨进程、握手后才发现工具面、默认 reduced 保真度且必带说明）；宿主新增 `connectPaeToolAdapter`（先握手后注册）与 `releasePaeToolAdapter`（注销并等待释放）；修复 `registry.unregister` 不调用 `teardown` 导致 MCP 子进程泄漏。**W17 完成（2026-08-30）**：OpenAPI 适配器（纯函数 spec 映射 / 注入式 HTTP 传输 / OpenApiPaeAdapter，L2、无实时握手、构造期即失败、默认 reduced 保真度且必带说明；详见进度日志）。**W18 完成（2026-08-30）**：Cordis 隔离实例适配器（宿主自定义协议纯函数层 / 注入式传输含子进程实现 / CordisPaeAdapter，L2、握手后动态发现、默认 reduced 保真度且必带说明；PAE 难度梯 W15–W18 闭环；详见进度日志）。**W19 完成（2026-08-30）**：隔离域物理层（见下一行） | UPGRADE §C.3 |
| **W19 ✅ / W20 ✅** | **W20 完成（2026-08-31）**：见下方进度日志。域间事务化调用（原子事务账本 + 对账）+ 图驱动分配进宿主状态（图变更置脏/条件性指纹/关闭释放）。W21 起三段式抽包 | VISION 升级三 |
| **W21–W23 ✅** | 三段式抽包：Project References 划界 → 自底向上抽（infra-common → core-hub → sandbox-runtime → pae-engine），每包全量回归 | UPGRADE B.1–B.2 |
| **W24–W26 ✅** | npm workspaces（pnpm 迁移延后）+ 各包独立 version（0.3.0）+ admin-console 包 + v0.3.0 发布（tag v0.3.0） | UPGRADE B.3 |

**波次 3 门禁**：抽包期间 `src/index.ts` 公共 API 不变 · 每抽一包全量回归通过才继续 · PAE 通道治理不降级（保真度标注完整）。

### 波次 4 · v0.4.0 日志持久化（W27）

v0.3.0 收口时，文档记录的最后一个架构空洞是**轨迹/录制日志无磁盘持久化**——一个以重放
与审计为核心的内核，日志随进程退出蒸发，架构不闭合。W27 关闭该缺口。

| 阶段 | 内容 | 依据 |
|---|---|---|
| **W27 ✅** | 崩溃安全 WAL 子层（一行一条 JSON，末行截断容忍 / 内部非法行硬拒）+ `PersistedTraceJournal` / `PersistedRecordJournal` + 宿主 `traceJournalPath` / `recordJournalPath` / `auditRetention` 接线 + 自愈压缩与有界留存 | 路线图空洞（见下方进度日志） |

**波次 4 门禁**：持久化按路径选择性开启，不传路径与 v0.3.x 行为逐字节一致 · 恢复保留
`entryUid`/`occurredAt`/`orderIndex` 故恢复条目逐字节一致 · `replay_compat` 补 WAL 门禁
（跨进程窗口重放一致 · 崩溃截断日志重放存活前缀 · 耐久化不扰动录制字节）。

### 波次 5 · v0.5.0 工程硬化与发布准备（M5/M6）

内核架构已完整（VISION Phase 1–5 全落地）；本波次收口产品硬化轨道，让发布
不止"完整"，而且"可证明、可发布"。

| 阶段 | 内容 | 依据 |
|---|---|---|
| **W28 ✅** | 工程硬化：`examples/`（4 个可运行示例：自定义通道 / JS-PAE / MCP / CLI 闭环，全部带断言、失败即非零退出）+ `benchmarks/`（网关 / 重放 / WAL / PAE 四套基准 + 汇总）+ CI 补前端套件与 examples/benchmarks smoke + npm 包内容补 examples/benchmarks/中文 README + `prepublishOnly` 补控制台套件 | M5/M6（见下方进度日志） |

**波次 5 门禁**：每个示例以 `node examples/*.mjs` 独立跑通且失败退出非零 · 每套基准可独立运行
且汇总脚本零错误 · CI 覆盖内核 + 控制台 + 示例 + 基准 · 干净从零 `tsc -b` 零错误 ·
全量内核与前端回归只增不减。

### 波次 6 · v0.6.0 四档治理模式落地（W29）

VISION §3.1 四档治理模式——最后一个"文档写了但没实现"的架构面——落地为可切换配置。

| 阶段 | 内容 | 依据 |
|---|---|---|
| **W29 ✅** | `GovernanceProfile` 契约（sandbox/standard/strict + `resolveGovernanceProfile` + `governanceProfileHash`）+ 宿主 `governanceProfile` 选项与 `currentGovernanceProfile` 访问器 + 机制注入（RateLimiter/TripProtector/TokenBudgetEngine）+ PAE 准入门（strict 关闭）+ strict 强制持久化轨迹 + 非默认档进指纹（跨档重放报配置漂移）+ 控制台设置页展示 | VISION §3.1（见下方进度日志） |

**波次 6 门禁**：`standard` 解析为 v0.5.x 数字**逐字一致**（测试断言）· 非默认档指纹省略原则
（standard 不出现字段）· 跨档重放 `RunFingerprintDriftError` 进 replay_compat 合并门禁 ·
strict 缺 `traceJournalPath` 构造期抛错 · 全量回归只增不减。

---

## 3. 贯穿性工作流（非周任务，持续）

| 工作流 | 节奏 | 内容 |
|---|---|---|
| **宪章门禁** | 每个 PR | Architecture Gate 8 条（replay 兼容/无裸随机/决策可记录/图更新/账本记账/分层合规/测试不回归/文档同步） |
| **控制台同步** | 每波次 | web 控制台跟进新能力（v0.2 加网关决策查看、v0.3 加 PAE 面板） |
| **用户反馈** | W6 起 | issue 分诊、种子用户设计伙伴沟通（PRODUCT_PLAN §11 的 2-3 个种子项目） |
| **性能预算** | v0.2 起 | 网关开销 ≤5%（VISION 机制 3），bench 脚本进 CI |

---

## 4. 风险登记

| 风险 | 概率 | 影响 | 对策 |
|---|---|---|---|
| 真实模型 API 的非确定性（temperature>0 时 seed 不保证） | 高 | W1 延期 | 契约明确：record 模式默认 `temperature=0` 或透传 seed；文档写清边界 |
| CLI 零依赖约束与开发者体验冲突 | 中 | W3 返工 | 只用 node 内置（fetch/util.parseArgs）；解析复杂参数用最小手写 argv 解析 |
| 波次 2 向后兼容失败（旧轨迹不可重放） | 中 | v0.2 信任受损 | decision/runFingerprint 均为可选字段 + W13 专项兼容测试 |
| 单人研发带宽（PRODUCT_PLAN §11：1 内核工程师） | 高 | 全线延期 | 波次串行设计即为此服务——任何时候只有一条主线；砍序不砍质（先砍 W13 错误分类，不砍 replay_compat） |
| 开源发布后涌入的 issue 挤占架构时间 | 中 | v0.2 延期 | 预留 W7 的 50% 做 issue 分诊节奏建立； Discussions 引导 Q&A |

---

## 5. 度量（每周站会看的数字）

- **质量**：测试数（**内核基线 290** · **前端基线 89**，均只增不减）· strict 编译错误（0）· replay_compat 用例数
- **进度**：就绪清单勾选数（W6 目标 14/14）· 波次退出标准达成状态
- **产品（W6 起）**：npm 周下载 · GitHub star · 首次 record→replay 成功率（目标 >70%）

---

## 6. 变更流程

本计划以周为粒度、以退出标准为验收。里程碑顺延 >1 周时：重排后续波次而不是压缩质量门禁（宪章优先级高于排期）。计划变更记录进本文件尾部 changelog。

| 日期 | 变更 |
|---|---|
| 2026-08-29 | v1.0 首版：确立"产品先行、架构随行"三波次排期 |
| 2026-08-29 | W1–W2 落地（commit 4a6585d）：provider 生产化 + File/Shell 通道 + JSONL 持久化 + replay_compat 门禁，59→119 测试 |
| 2026-08-29 | W3–W5 落地：orbit CLI 三命令（bin/orbit.mjs，零额外依赖）+ 集成测试 4 例 + CLI 优先 README/guide + CI 矩阵 + issue/PR 模板 + npm dry-run 通过。波次 1 工程完成，仅余 W6 真实发布（用户动作） |
| 2026-08-29 | W7–W8 落地：capabilityInvoke 统一网关确定性边界 + TokenBudgetEngine 纯函数压缩器/估算器；预算/路由/压缩决策与 tokenConfigHash 由引擎/注册表计算；run 指纹配置漂移（RunFingerprintDriftError）与 digest 漂移分离。引擎单测 7 例 + 网关测试 3 例，全量 134 测试绿，strict 编译零错误 |
| 2026-08-29 | W9–W10 落地：压缩真正作用于落盘 payload——packSnapshot/compressPayload/decompressPayload（node:zlib 确定性 deflate）接入网关 execute/replay，存储压缩对消费者透明、重放逐字节一致；GatewayDecision.compression 增 bytesSaved 审计字段；宿主 compression checker 改 payload 感知。引擎单测 3 例 + 网关端到端 1 例，全量 138 测试绿，strict 编译零错误 |
| 2026-08-29 | W11–W14 落地（v0.2.0）：RateLimiter 纯函数限流 + BehaviorCollector 三模式采集器；网关 rateLimited 决策记录原值/重放旁路、collector record 落盘/live 提案/replay 旁路；三分漂移分类（RunFingerprintDriftError/DecisionDriftError/ReplayDriftError）+ reconcile.decisionDriftFields；replay_compat 网关门禁扩至 7 类用例；CHANGELOG/README/VISION 同步更新；KERNEL_VERSION 与 package.json 升 0.2.0。单测 13 例（限流 3 + 采集 3 + A.5 网关 7），全量 151 测试绿，strict 编译零错误 |
| 2026-08-29 | W15 落地（v0.3.0 首波）：PAE 插件适配引擎契约层（src/pae/types.ts）+ PaeAdapterRegistry（静态校验/动态 Pact/保真度协商/配置哈希）+ PaeChannel（整体发布为能力通道，外来调用必经网关落入 RecordJournal）+ JsPaeAdapter（L0/full，注入式 RngSource/ClockSource）。两条架构铁律：适配器不直连内核、不引入非确定性。单测 22 例（pae_adapter）+ replay_compat 合并门禁 3 例，全量 176 测试绿，strict 编译零错误 |
| 2026-08-30 | **控制台同步（贯穿性工作流 §3 达成）**：web 控制台新增「异构适配 Adapter Studio」视图（`web/public/views/pae.js`），把 W15 抽象层做成可操作界面——模板化注册 → 动态 Pact → 保真度协商 → 经网关调用，调用结果显示 route/耗时/返回值；12 个工具模板集中于 DOM-free 的 `lib.js`，handler 由 bridge 注入且随机/时钟走 SeededRng + 注入 clock。bridge 增 `GET\|POST /api/pae`、`/invoke`、`/negotiate`、`DELETE /api/pae/:id`，PAE 状态进 `/api/state`、适配器节点进 `/api/graph`。修复：`channels` 路由无导航按钮导致模型通道不可达；overview 引用的 `--accent/--accent-2/--purple` 令牌从未定义；力导向布局用 `Math.random` 播种导致每次打开图布局乱跳（改为按节点 id 的 FNV-1a 确定性抖动）。新增 `--coupler` 接驳橙设计角色。前端单测 16 例（`npm run test:console`，纯目录逻辑 + 真实 host 集成），内核 176 例不变，strict 编译零错误 |
| 2026-08-30 | **W16 落地（MCP 适配器）**：`src/pae/adapters/mcp/` 三件套——`protocol.ts`（JSON-RPC 2.0 信封 / 换行分帧 / tools-list 校验 / content[] 归一化，全纯函数）、`transport.ts`（`IMcpTransport` + `StdioMcpTransport` 子进程 stdio + `InMemoryMcpTransport`，含请求关联、调用方 deadline、对端死亡即失败在途请求、失败时附 stderr 尾部）、`McpPaeAdapter.ts`（kind=mcp、isolation=L2、determinism=IO_BOUND；setup 内先完成 initialize 握手再 tools/list 发现工具面；采用对端上报版本作 sourceEdition；默认 fidelity=reduced 且必带说明——参数 schema 由远端校验、content[] 映射为 JSON）。宿主新增 `connectPaeToolAdapter`（先握手后注册）与 `releasePaeToolAdapter`（注销并 await teardown）；修复 `PaeAdapterRegistry.unregister` 从不调用 `adapter.teardown()` 导致 MCP 子进程泄漏（改为 unregister 时启动释放 + `drainReleases()` 等待）。新增 `PaeRemoteError`。单测 27 例（mcp_adapter）+ replay_compat 合并门禁 2 例，全量 205 测试绿，strict 编译零错误 |
| 2026-08-30 | **控制台改版（信息架构与工作流）**：九个平铺页面重构为三种用户意图分组（运行时 / 构件 / 治理），导航由 `lib.js` 的 `NAV_GROUPS` 数据驱动生成而非 HTML 手写，并新增 `missingRenderers` 断言使"声明了却渲染不出来"在测试中失败（源于 channels 不可达事故）。新增命令面板（`Ctrl/⌘+K` 或 `/`，模糊检索视图与主机动作，全键盘操作，排序由纯函数 `fuzzyScore` 实现）。首屏改为任务式工作台：系统健康结论（含每条理由）+ 由真实内核状态推导的下一步（`deriveSystemHealth` / `suggestNextSteps`）+ 关键指标 + 现场证据。Adapter Studio 支持 MCP 家族。修复：`/api/health` 硬编码 `0.1.0`（实际 0.2.0）改为读 `KERNEL_VERSION`；overview 的熔断保护卡片指向不存在的 `safeguard` 路由。前端单测 49 例，内核 205 例，strict 编译零错误 |
| 2026-08-30 | **控制台平台化（贯穿性工作流，本轮收口）**：控制台从"被动查看器"升级为平台——账户/知识库/RAG/编排/治理全部落地 bridge 且与浏览器共享同一份 DOM-free 事实。`web/public/kb.js`（零依赖）实现段落感知切片、确定性词法 BM25 索引、查询高亮区间、RAG 八步管线与充分性门禁（确定性补搜改写）、工作流图校验/拓扑/分支求值纯函数；`web/public/lib.js` 收拢账单聚合（`deriveBilling`）、通知推导（`deriveNotifications`）、指标环比（`trendOf`）、角色权限矩阵（`can`）、任务状态词汇。新增 13 个视图模块（login/dashboard/instances/tasks/workflow/knowledge/rag/templates/market/audit/billing/settings/profile）补齐此前遗留的"加载即失败"；认证用 scrypt+盐、种子管理员 `admin/orbit-admin`、Bearer 会话、角色矩阵单一裁决入口。bridge 增 `auth/*`、`/api/kb*`、`/api/rag*`、`/api/workflows*`、`/api/billing`、`/api/audit/export`、`/api/notifications`、`/api/dashboard`。修复：多字中文停用词因 `tokenize` 拆单字而永远不命中的死代码（改为单字）。前端单测 49→80（`kb.test.mjs`+`console-platform.test.mjs`），新增 HTTP 端到端冒烟覆盖 login→建库→上传→检索→RAG→工作流→账单→审计→通知→仪表盘 + 401 探测；内核 205 例不变，strict 编译零错误 |
| 2026-08-30 | **控制台功能改造（按无仙侠专业控制台设计文档，`74d2a10`）**：全站去仙侠命名（导航/状态/类型/视图文案全部专业化）。知识库上传重做——拖拽/批量/文件夹上传面板，chunk-size 与 overlap 参数经 `kbUpload` 端到端生效，单文件状态管线（排队→解析中→切片中→向量化中→完成/失败）+ 全局进度 + 建索引动画，并补契约测试；设置页增模型适配器（DeepSeek/OpenAI 兼容端点）与安全（改密/退出）区块；模板支持"复制为新模板"与相邻版本对比（diff vs prev）；实例详情抽屉补全字段集与快捷动作；RAG 增慢动作步骤回放与步骤聚焦；仪表盘重构为数据大盘（含图表）、全站响应式断点、404/403 状态页、登录注册补全（记住我/校验/协议）、审计导出加 PDF。前端单测 80→81，内核 205 例不变，strict 编译零错误 |
| 2026-08-30 | **控制台样式修复（`6bf2249`）**：修复 `826c150` 全量样式表重写引发的两个用户可见缺陷。① 登录页泄漏注册专属字段（昵称/邮箱/确认密码/协议）——双层根因：字段创建时从未赋初始 `hidden`（只在 `toggle()` 里赋值），且 `.field{display:flex}`/`.shell{display:grid}` 覆盖 UA 样式表的 `[hidden]` 规则；修复为创建即 `hidden=true` + 全局 `[hidden],.hidden{display:none!important}`。② 早期波次视图（pae/channels/graph/replay/routing）样式全丢——重写时丢掉了仍被引用的旧选择器；以显式兼容层（约 200 行，含 `--coupler`/`--purple`/`--text-2` 令牌别名）恢复。新增门禁测试 `css-coverage.test.mjs`：视图引用的每个 class 必须在 styles.css 中定义、`[hidden]` 规则必须保持 `!important`、兼容令牌必须存在——整表重写再也无法静默弃置视图。前端单测 81→84，内核 205 例不变 |
| 2026-08-30 | **W17 落地（OpenAPI 适配器）**：`src/pae/adapters/openapi/` 三件套——`spec.ts`（纯函数文档映射：OpenAPI 3.x/Swagger 2.x 解析为工具面，operationId 原样、缺失时合成 `method_path` 注册表安全名；路径级参数并入各操作；cookie 参数直接拒绝——适配器绝不携带环境凭据；`buildHttpRequest` 纯函数：必需 path 参数强制存在并 URL 编码、query 键按排序序列化保证同参同 URL（digest 稳定）、声明 requestBody 时剩余键成 JSON body、无 body 时剩余键硬报错绝不静默丢弃；`resolveDocumentBaseUrl` 读 `servers[0]`/swagger `schemes+host+basePath` 作回退）、`transport.ts`（`IHttpTransport` 注入式接缝，`InMemoryHttpTransport` 免网络测试 + `FetchHttpTransport` 真实路径：平台 fetch、按请求 deadline、默认头、可注入 fetchImpl）、`OpenApiPaeAdapter.ts`（kind=openapi、isolation=L2、IO_BOUND；与 MCP 不同无实时握手——表面静态取自文档，坏 spec 或缺 baseUrl 的适配器在构造期即失败，绝不等到首个调用；baseUrl 配置优先、文档 server 回退；默认 fidelity=reduced 且必带说明——校验在远端（本地只强制必需 path 参数）、HTTP 响应折叠为单一 JSON/文本值并丢弃状态码/头，非 2xx 抛 `PaeRemoteError` 附状态码与受限 body 尾部）。公共 API 导出 OpenApiPaeAdapter/传输双实现/四个纯函数。单测 21 例（openapi_adapter）+ replay_compat 合并门禁 2 例（记录时对端仅进入一次、对端消失后重放仍逐字节一致），全量 228 测试绿（内核 205→228），前端 84 例不变，strict 编译零错误 |
| 2026-08-30 | **W18 落地（Cordis 隔离实例适配器，PAE 难度梯收尾）**：`src/pae/adapters/cordis/` 三件套——`protocol.ts`（纯函数、**自包含**不依赖 MCP：Cordis 隔离实例无标准协议，内核自定——信封借 JSON-RPC 2.0 纪律（id、result XOR error）但独立成族；`decodeFrame` 跳过空行/日志噪音、拒绝信封违规；`parseCordisToolList` 坏宿主硬报错；`normaliseCordisToolResult` 宿主结果原样透传）、`transport.ts`（`ICordisTransport` + `InMemoryCordisTransport` 免进程测试 + `ChildProcessCordisTransport`：spawn node 宿主、换行分帧 JSON、请求关联、调用方 deadline、宿主死亡即失败在途请求、stderr 受限尾部失败时上抛——职责与 MCP stdio 传输镜像）、`CordisPaeAdapter.ts`（kind=cordis、isolation=L2、IO_BOUND；setup 内 initialize 握手 → 采用宿主上报版本为 sourceEdition（semver 守卫，之前占位 `0.0.0`）→ tools/list 发现工具面；默认 fidelity=reduced 且必带说明——校验在远端（声明的 input 形状本地不强制）、结果是宿主返回的任意 JSON、宿主内部事件与服务锁在隔离实例内（VISION 事件锁在域内）；toolNamePrefix 与逐工具 override 沿用 MCP 模式）。W15–W18 难度梯闭环：JS（L0）→ MCP（L2/标准协议）→ OpenAPI（L2/无状态）→ Cordis（L2/宿主自定义协议）。公共 API 导出 CordisPaeAdapter/传输双实现/协议纯函数。单测 16 例（cordis_adapter，含真实 node 子进程端到端 + 启动即死 stderr 诊断 + 注入时钟 deadline）+ replay_compat 合并门禁 2 例（记录时宿主仅进入一次、宿主消失后重放仍逐字节一致），全量 246 测试绿（内核 228→246），前端 84 例不变，strict 编译零错误 |
| 2026-08-30 | **W19 落地（图驱动隔离域，VISION 2.3 双层隔离物理层）**：`src/sandbox/domains/` —— `allocate.ts` 纯函数（`impactClosureSizes` 计算每节点故障影响=反向可达闭包；`allocateDomains`：闭包 > `maxImpactClosure`(默认1) 的节点**自动升 L2 独立域** `iso:<unit>`，其余按确定性分块 `shared:<n>`（≤`maxDomainSize` 默认3）；**关键语义**：可共享节点共置即安全——逻辑层已证明互不影响，进程级爆炸半径由阈值契约承担；plan 是划分、确定性、随图增长自动升级）、`protocol.ts`/`transport.ts`（`units/list` 面解析：坏宿主硬报错、单元 id 去重、工具名按 `unitId:tool` 全局去重；`IDomainTransport` + 内存实现 + `ChildProcessDomainTransport` 子进程实现：spawn node、分帧、关联、deadline、宿主死亡即失败在途请求、stderr 尾部）、`hostShim.ts`（内建纯函数宿主源码串，默认工厂 `node -e` spawn，`ORBIT_DOMAIN_UNITS` 选单元——内核绝不向子进程下发代码，真实部署换 bootstrap 脚本同协议接入）、`IsolationDomain`/`IsolationDomainManager`（setup 握手+发现、invokeUnit 路由、**syncDomains 是 diff 而非重建**：未变域不重启子进程、移除域 await 释放、teardownAll 全释放）、`DomainChannel`（镜像 PaeChannel：单元工具以 `${unitId}:${tool}` 安装——plan 是划分故 unitId 全局唯一无碰撞——调用走 `capabilityInvoke(DOMAIN_TOOL) → hub → channel → manager → 子进程` 落入 RecordJournal（IO_BOUND/inject），重放无需域或其子进程）。新增 `ChannelKind.DOMAIN_TOOL`（requiredCapability 默认 channel:read，无破坏）。单测 20 例（分配 7/协议 5/传输 5/域+管理器 3/网关 1，含真实子进程端到端）+ replay_compat 门禁 2 例（记录时宿主仅进入一次、域消失后重放仍逐字节一致），全量 268 测试绿（内核 246→268），前端 84 例不变，strict 编译零错误。设计教训：**连通分量打包是错的**——独立节点无边=各自成域，共享域退化为全隔离；正确语义是闭包小即安全共置，按排序分块 |

| 2026-08-31 | **W20 落地（域间事务化调用 + 图驱动域分配进宿主状态）**：`src/sandbox/domains/transaction.ts`——跨域调用的**原子事务账本**，`beginTransaction`（决策：单元归属/隔离级）→ `markExecuted`（跨界）→ `settleTransaction`（结算/失败），事务 id `dtx:<seq>` 确定性（重放得到同一 id 流）；`reconcileTransactions` 按 (源域→目标域) 分组对账，可从记录单独检出两类失败形状：**孤儿**（跨界未结算 = 事务边界泄漏）与**拒绝**（执行前被拒，本身非错误但成片出现说明 plan 与图失配）。`IsolationDomainManager.invokeUnit` 事务化：被拒的跳转**记为 rejected 而非丢弃**；延迟经注入时钟度量（`Date.now` 不进记录）；新增 `txnLedger/reconcile/ledgerHash/clearLedger`。宿主侧：图变更（registerPlugin/spawnAgentBox/unregisterPaeToolAdapter）置 `domainsStale()`，`allocateIsolationDomains()` 同步（diff 化，重跑零churn）并在**首次分配时才注册** `DOMAIN_TOOL` 通道；`RunVersionFingerprint.domainPlanHash` **缺省时省略**（沿用 W16 PAE 先例，未分配域的宿主指纹逐字节不变），`host.runFingerprint()` 转公开便于漂移诊断；`shutdownHost` 先 `releaseIsolationDomains()` 释放子进程。单测 20 例（domain_transaction：事务生命周期/拒绝/失败/对账孤儿/幂等哈希/宿主置脏与幂等分配/指纹兼容两次/关闭释放）+ replay_compat 门禁 2 例（跨域跳转 record→replay 逐字节一致且**重放不重入域（账本不新增）**、改输入为 call drift、释放全部域后仍可重放），全量 290 测试绿（内核 268→290），前端 89 不变，strict 编译零错误。**坑**：① 网关 replay 读的是自身挂载的 journal（非 ReplayEngine 的），测试里换 journal 会导致 "call #0 missing"；② 注入时钟冻结时延迟恒为 0，测延迟必须用递增时钟 |
| 2026-08-31 | **W21–W23 落地（三段式抽包 Monorepo）**：内核自 `src/` 单树重构为 npm workspaces + TypeScript Project References 四包——`@orbit/infra-common`（领域契约/纯工具/异常：`types`·`utils`·`core`）、`@orbit/core-hub`（通道/网关/replay/trace/pact/safeguard/routing）、`@orbit/sandbox-runtime`（沙箱/影响域图/隔离域）、`@orbit/pae-engine`（PAE 适配器族 JS/MCP/OpenAPI/Cordis）；宿主留在根 `src/`（`core/orbitRuntimeHost.ts` + `index.ts` 门面，公共 API 不变）。依赖分层无环：`infra-common → core-hub → {sandbox-runtime, pae-engine} → host`。流程：`git mv` 迁移模块 + 各包桶文件 `index.ts` 导出 + 跨包导入改写为 `@orbit/*` 限定符；各包 `composite:true` + `references` 指依赖，`tsc -b` 自底向上构建；`npm install` 经 `node_modules/@orbit/*` 符号链接接包。`npm run build` 改为 `tsc -b tsconfig.json`，`npm test` 不变。干净从零构建通过（EXIT=0：root 29 + 包 55 个 .js），内核 290 测试绿、前端 89 测试绿、strict 编译零错误，公共 API 与重放契约零回归。波次 3 门禁（抽包期间 `src/index.ts` 公共 API 不变 · 每抽一包全量回归 · PAE 治理不降级）达成 |
| 2026-08-31 | **W24–W26 落地（v0.3.0 发布）**：各包与根 `package.json` 版本升 0.3.0；`KERNEL_VERSION` 与 `DOMAIN_HOST_VERSION`（派生）同步升 0.3.0；`test/gateway.test.ts` 指纹断言同步。新增 `web/package.json`（`@orbit/admin-console`，private app workspace，含 `start`/`test` 脚本），根 `workspaces` 注册 `web` 并增 `start:web`/`test:web`；bridge 仍按相对路径 `../dist/src/core/orbitRuntimeHost.js` 引入编译内核。pnpm 迁移因运行环境无 pnpm/corepack 而**延后**——npm workspaces 已满足 Monorepo 结构目标，记为后续改进项。CHANGELOG 收敛为单一 `## [0.3.0]` GA 头（含 Release summary / Verification / Migration），W15–W20 与控制台各节降为 `###` 子节；README/README.zh-CN 目录结构与用例数（290/89）同步。干净从零 `tsc -b` 通过（strict 零错误）；内核 290 测试绿、前端 89 测试绿，公共 API 与重放契约零回归；`git tag v0.3.0`。v0.3.0 路线（W15–W26）收口 |
| 2026-08-31 | **W27 落地（日志持久化，v0.4.0）**：关闭路线图最后一个架构空洞——日志无磁盘持久化。`packages/core-hub/src/persistence/wal.ts` 崩溃安全 JSONL 子层：一次写入只追加**一整行**，故崩溃唯一残留形态是**末行被截断**；恢复据此严格二分——末行解析失败/结构不完整则**丢弃**，内部行非法则**硬拒**（`WalFileInvalidError` 带行号，因为内部行不可能被崩溃截断，静默跳过等于隐藏损坏）。`walAppend`/`walRecover`/`walRecoverSync`/`walReset`/`walCompact`（临时文件+rename 原子重写）/`walLineCount`。`PersistedTraceJournal` 与 `PersistedRecordJournal` 各以内存日志为**唯一真源**、WAL 为 fire-and-forget 镜像（`writeChain` 串行化防交错，`flush()` 关闭时 await）；恢复保留原始 `entryUid`/`occurredAt`/`orderIndex`，故恢复条目**逐字节一致**——跨进程续写的录制窗口 `orderIndex` 顺延而非归零，被进程边界切开的运行仍重放为一条连续序列。宿主接线 `OrbitRuntimeHostOptions{traceJournalPath, recordJournalPath, auditRetention}`：`bootHost` 先恢复再装配通道，`shutdownHost` 先排空在途写入再应用留存，`resumeRecording()` 续开持久窗口、`beginRecording()` 截断旧 WAL 开新窗口、`currentRecordJournal()` 只读暴露、`pruneAuditLog()` 按需裁剪。**三个真实缺陷**：① `loadTraceJournal` 在读取循环内反复 `restoreSnapshot([entry])`，每次替换整链导致只恢复**最后一条**；② **崩溃截断的末行留在磁盘上，本次运行首次追加后它变成「内部行」，而内部非法行是硬故障——即一次崩溃会让此后每次启动都失败**；修复为恢复路径在首次追加前 `healIfNeeded()`（比对物理行数与恢复条目数，不一致才原子重写，健康日志零重写）；③ `bootHost` 在通道装配**之后**才恢复审计日志，装配期产生的条目被恢复快照覆盖丢失，改为恢复先行。有界留存：append-only 日志无上限增长会打满磁盘（磁盘满是宕机），故 `auditRetention` 显式由运维选择，启动与关闭各应用一次；关闭路径顺序为**先 flush 再裁剪**——反了会让被排空的在途写入把文件重新顶过上界。新增测试 3 文件 58 例（`journal_wal` 33 / `trace_journal_persistence` 14 / `host_journal_persistence` 11）+ `replay_compat` 补 3 例 WAL 门禁；全量 348 测试绿（内核 290→348），前端 89 例不变，strict 编译零错误。版本升 0.4.0（`KERNEL_VERSION` + 6 个 package.json + 指纹断言 + README 示例），`docs/architecture.md` 新增 §9 日志持久化。**坑**：测试里断言「沙箱周期会产生 >N 条审计条目」是脆弱耦合（实际不足，应直接写入审计条目）；且失败测试若未 `shutdownHost()`，已 boot 的宿主留下活跃句柄会使 `node --test` 进程永不退出（表现为整个文件挂死而非报错） |
| 2026-09-01 | **W28 落地（工程硬化，v0.5.0）**：M5/M6 产品硬化轨道收口。**examples/** 4 个可运行示例（全部带断言、失败退出非零、可当 CI smoke）：`custom-channel.mjs`（实现 IChannelProvider → 注册 → record/replay 逐字节一致 + 篡改输入触发 ReplayDriftError）、`js-pae-plugin.mjs`（JsPaeAdapter L0，外来 JS 函数经网关治理，SeededRng 确定性骰子，适配面哈希进指纹）、`mcp-adapter.mjs`（真实 stdio 子进程，initialize→tools/list 握手后注册，record 后关子进程仍可逐字节重放——注入冻结输出不重入子进程）、`cli-record-replay.mjs`（驱动 bin/orbit.mjs 的 record→replay→diff 三命令，temp 目录自清理）。**benchmarks/** 4 套 + 汇总：gateway（capabilityInvoke 全链路含 journal，实测 ~12µs/call / 82k calls/s）、replay（journal 快路径 ~3.8µs / 261k calls/s）、wal（持久化 append+flush ~685µs/条）、pae（L0 in-process ~38µs vs L2 stdio-child ~176µs，跨进程因子 4.6×）；对照 VISION 性能预算。**CI 补闭合**：`.github/workflows/ci.yml` 增 `npm run test:console`（前端 97 例此前完全没进 CI——真实缺口）+ 4 示例 smoke + 4 基准 smoke（N 缩档跑）。**发布准备**：package.json `files` 补 examples/benchmarks/README.zh-CN.md，新增 `example:*`/`benchmark` scripts，`prepublishOnly` 补 `npm run test:console`。版本升 0.5.0（KERNEL_VERSION + 6 package.json + 指纹断言 + README 示例），CHANGELOG `[0.5.0]`。全量回归：内核 381（前轮审计后基线）+ 前端 97，干净从零 `tsc -b` 零错误。**坑**：示例里直接 `hub.attachRecordJournal` 不记录网关调用（gateway 有独立 journal，须走 `host.beginRecording`/`attachReplayEngine`）；`ReplayMode` 是纯类型无运行时值（示例用字符串字面量） |
| 2026-09-01 | **W29 落地（四档治理模式，v0.6.0）**：VISION §3.1 从"设计目标"变为"已落地"。`infra-common/types/governance.ts`：`GovernanceProfile` 契约（sandbox/standard/strict）+ `resolveGovernanceProfile`（缺省/未知 → standard）+ `governanceProfileHash`（FNV-1a，进指纹）。宿主 `governanceProfile` 选项 + `currentGovernanceProfile` 只读访问器；`strict` 构造缺 `traceJournalPath` 抛错（合规档必须有耐久审计轨迹）。机制注入：`tokenBudgetConfigForProfile`（off/normal/aggressive，aggressive 阈值减半）、`tripThresholdForProfile`（按依赖出度软化，strict 下限 1 / 其余 2）、RateLimiter 取 profile 数字；PAE 准入门 `assertPaeKindAdmitted` 在 register/connect 前检查（connect 在握手**之前**，拒绝对端不 spawn 子进程）；`RunVersionFingerprint.governanceProfileHash` 可选字段 + `CapabilityGateway.verifyFingerprint` 对比（双方缺省=兼容，同 paeAdaptersHash 模式）——**standard 档省略字段，默认宿主指纹与 v0.5.x 逐字节一致**。**落地裁决**：standard 的 paeAdmission 用 "all" 而非 VISION 原始表的 "MCP+JS"——治理公理"为治理不砍功能"优先，且 OpenAPI/Cordis 是已发布能力；偏差记录进 VISION §3.1"与原始表的偏差"。**控制台**：settings.js 主机面板新增治理档位只读展示，bridge `state()` 增 governance 字段；css-coverage 门禁抓到新增 `.col` class 未定义 → styles.css 补上。测试 +16：`governance_profile.test.ts` 14 例 + `replay_compat` 2 例合并门禁（sandbox 录制拒以 standard 重放 = config drift；同档跨宿主重放逐字节一致——坑：网关 replay 读自身挂载 journal，replay host 须 `beginRecording()` 后 restoreSnapshot 再 attach）。全量 **397 内核**（381→397）+ **97 前端**，干净从零 `tsc -b` 零错误。清理：src/index.ts 三行重复 `export *` 收敛为一行。**坑**：`decideCompression` 阈值是字节数非 token 数（测试载荷先写错）；standard 初版 paeAdmission=["js","mcp"] 破坏了 cordis/openapi 既有测试 → 全量回归抓出，改 "all"（"设计文档直接落地会踩既有能力"的典型） |
