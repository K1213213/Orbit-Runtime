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
| **v0.3.0** | W15–W26 | **生态接入**：PAE 适配器 + 抽包 Monorepo | MCP 插件经网关接入且四重校验不降级；pnpm workspace 全链路绿 |

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
| **W15 ✅** · W16–W18 | **W15 完成（2026-08-29）**：PAE 契约层 + 注册表 + PaeChannel + JsPaeAdapter；外来 JS 运行时经网关代理、四重校验、replay 零重入；适配面配置哈希进指纹。W16–W18：MCP → OpenAPI → Cordis 隔离实例 | UPGRADE §C.3 |
| W19–W20 | 隔离域 L2（子进程）+ 图驱动域分配 | VISION 升级三 |
| W21–W23 | 三段式抽包：Project References 划界 → 自底向上抽（infra-common → core-hub → sandbox-runtime → pae-engine），每包全量回归 | UPGRADE B.1–B.2 |
| W24–W26 | pnpm workspace + 各包独立 version/test + admin-console 包 + v0.3.0 发布 | UPGRADE B.3 |

**波次 3 门禁**：抽包期间 `src/index.ts` 公共 API 不变 · 每抽一包全量回归通过才继续 · PAE 通道治理不降级（保真度标注完整）。

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

- **质量**：测试数（基线 176，只增不减）· strict 编译错误（0）· replay_compat 用例数
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
