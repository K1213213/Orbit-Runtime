# Orbit Agent Runtime

> **Deterministic · Provable · Governable**
> 面向插件化智能体的轻量运行内核：插件热注册、可证明的故障隔离、全链路轨迹溯源、沙箱化执行。

[English](./README.md) · **简体中文**

**项目状态：** `pre-alpha` · **许可证：** Apache-2.0 · **轨道：** 开源产品（见[路线图](#设计路线图)）

> Orbit 以**开源产品**（而非实验项目）的轨道推进：内核是产品级工程——strict TypeScript、
> 零运行时依赖、每个机制都有测试与架构宪章（[docs/VISION.md](./docs/VISION.md)）背书。
> 当前阶段：内核机制全部完成（M1–M4）→ 产品化攻坚（真实模型适配、持久化、CLI、npm 发布）。
> 欢迎按 [CONTRIBUTING.md](./CONTRIBUTING.md) 参与贡献。

Orbit Agent Runtime 是一套零第三方依赖的插件化智能体运行时宿主。所有外部能力（模型访问、存储、IO）统一抽象为**能力通道（Channel）**；智能体不直接调用任何能力，一切调用经由通道集线器调度。内核分层严格单向依赖，内部状态私有、对外只读副本。

## 核心特性

- **通道优先解耦** —— 内存 KV、LLM 等能力全部通道化；插件可运行时覆盖或扩展通道（插件通道优先，内置通道兜底）
- **插件规约校验** —— 必填字段完整性、宿主版本兼容、能力声明三重校验，非法插件注册即拦截
- **跳闸保护** —— 插件级故障状态机（正常 → 跳闸 → 探测），单插件故障永不击穿宿主
- **轨迹日志本** —— 全链路行为记录，支持快照保存与恢复，可审计、可复盘
- **沙箱池** —— 每智能体独立沙箱，循环上限防死循环，每轮运行独立追踪 ID
- **确定性重放（M2）** —— 记录一次运行后零模型调用精确重放，输出逐字节一致，digest 链对账校验
- **可证明隔离（M3）** —— 插件/通道/沙箱依赖建模为有向图，故障影响 = 反向可达闭包，附隔离定理
- **成本感知路由（M4）** —— 通道声明成本/延迟/质量，智能体按每轮预算调度
- **统一网关入口（W7）** —— `capabilityInvoke` 即确定性边界：每次调用的治理决策（熔断 / 契约 / 预算 / 限流 / 路由 / 压缩）被记录并在重放时还原，配置漂移与 digest 漂移被分别报告
- **Token 预算与压缩（W8）** —— `TokenBudgetEngine` 是纯函数（禁随机/禁时钟）的 token 估算器与确定性头截压缩器；预算/路由决策改由引擎与通道注册表计算，其阈值配置哈希进运行指纹以支持漂移检测
- **负载感知的存储压缩（W9）** —— 大体积记录输出经 `packSnapshot` 在落盘时透明 `deflate` 压缩（零外部依赖），而消费者始终拿到原始值、重放逐字节一致；`compression` 决策（`level` / `applied` / `bytesSaved`）被记录以供审计
- **限流与行为采集（W11）** —— `RateLimiter` 是纯函数（禁随机/禁时钟）的调用计数预算；`rateLimited` 决策被记录并在重放时逐字还原（重放旁路限流器）。`BehaviorCollector` 以三模式采集结构化 `BehaviorNote`——`record`（随轨迹落盘）/ `live`（提案，不落盘）/ `replay`（旁路）
- **三分漂移分类（W13）** —— 重放失败被区分为明确错误：配置漂移（`RunFingerprintDriftError`，版本/指纹）、决策漂移（`DecisionDriftError`，如契约被撤销）、调用漂移（`ReplayDriftError`，数据/签名）；对账另报 `decisionDriftFields`
- **`replay_compat` 确定性门禁（W12）** —— 27 例 CI 门禁证明网关边界在压缩/限流/采集/指纹漂移/决策漂移/PAE 适配器/持久化窗口下始终忠实：每个决策被记录、并重放逐字节一致
- **插件适配引擎 PAE（W15）** —— 外来运行时（进程内 JS，MCP / OpenAPI / Cordis）经适配器映射为内核能力契约，整体发布为单一能力通道；每次外来调用都是一笔网关事务，被记录并可逐字节重放。保真度诚实协商（`full | reduced | lossy`），适配面哈希进运行指纹以支持漂移检测
- **隔离域（W19）** —— 影响域图驱动物理层分配：故障闭包超阈值的单元获得独立 L2 子进程（`iso:<unit>`），其余确定性分块共置（`shared:<n>`）。同步是 diff 而非重建，域整体发布为单一能力通道，域调用被记录并可逐字节重放
- **跨域事务（W20）** —— 域间每一次跳转都是一笔原子网关事务：决策（归属/隔离级）+ 执行 + 结果 + 审计，按（源域→目标域）对账结算；孤儿（跨界未结算）与拒绝（执行前被拒）都能从记录单独检出；重放注入冻结输出而不重入域
- **日志持久化（W27）** —— 审计日志与录制窗口各挂一份崩溃安全的预写日志（WAL），进程重启不再擦除审计轨迹与已录制运行。一行一条 JSON，故崩溃唯一残留形态是「末行被截断」：恢复只丢弃那一行，而任何**内部**非法行按真实故障拒绝。恢复保留原始 id 与顺序，因此条目逐字节一致——被进程边界切开的录制窗口仍重放为一条连续运行
- **重放时间线（W32）** —— 控制台把录制窗口变成可视化 step-through 调试时间线：每步的治理徽标（限流/熔断/越权/预算/压缩/路由）、输入 digest + 输出 + 成本详情，以及从任一步分叉出新实验的按钮（PRODUCT_PLAN P1.1）
- **信任推定与契约化（W31）** —— VISION §3.1 最后两维落地：`strict` 把外来适配器封顶 L1（不跑子进程）并要求每个插件声明参数契约（`schema`）；`standard` 在调用前按声明校验参数；`sandbox` 零校验。四档模式全部维度都有代码实现
- **审计哈希链（W30）** —— append-only 审计日志的可信度只有文件权限那么高；哈希链让它可证明未被篡改。`new OrbitRuntimeHost({ auditSigningKey })` 后每条审计条目携带 HMAC-SHA256 的 `prevHash`/`chainHash` 链，`host.verifyAuditChain()` 证明完整性，`orbit audit <trace.wal> --key …` 从 CLI 验证，`strict` 档在链被篡改时拒绝启动。改动任何一条都会在该处及之后全部断裂
- **四档治理模式（W29）** —— VISION 的 Sandbox / Standard / Strict 档位从"设计目标"变为可切换配置：`new OrbitRuntimeHost({ governanceProfile: "strict" })` 一次声明限流、熔断、压缩、PAE 准入与轨迹持久化。`standard` 与旧版数字逐字一致；非默认档哈希进运行指纹，跨档重放报配置漂移而非静默分叉
- **零运行时依赖** —— 纯 TypeScript strict 模式，Node.js ≥ 20 直接运行

## 架构分层（严格单向依赖，禁止反向与循环）

```
types（领域契约）
   ↓
utils（版本解析 / ID 生成）
   ↓
core（领域异常）
   ↓
channel（能力通道层）   pact（插件规约层）
safeguard（安全防护层）  trace（轨迹溯源层）
   ↓
sandbox（智能体沙箱层）
   ↓
runtime_host（顶层宿主入口）
```

📐 详细架构图与设计决策说明：[docs/architecture.md](./docs/architecture.md) · [architecture.svg](./docs/architecture.svg)

📜 架构宪章（三条公理 · 四档治理 · 内核准入清单）：[docs/VISION.md](./docs/VISION.md)
🗓 研发计划（三个发布波次：开源发布 → 网关确定性边界 → 生态接入）：[docs/DEV_PLAN.md](./docs/DEV_PLAN.md)
🛠 升级方案与阻断项解决：[docs/UPGRADE_PLAN.md](./docs/UPGRADE_PLAN.md)
📈 产品规划：[docs/PRODUCT_PLAN.md](./docs/PRODUCT_PLAN.md)

## 插件适配引擎 PAE（W15）

外来运行时——今天为进程内 JS，后续 MCP / OpenAPI / Cordis——通过**插件适配引擎（PAE）**接入内核。适配层刻意保持极薄：适配器只持有对外来运行时的连接，并将其工具翻译为内核能力契约。两条规则让内核其余部分对"外来"毫不知情：

1. **适配器从不直连内核**：注册后的适配器整体发布为单一能力通道（`ChannelKind.PAE_TOOL`），因此每次外来调用都走 `capabilityInvoke → ChannelHub → 注册表 → 适配器`，并落入 `RecordJournal`。外来工具与原生通道接受**同一套**四重治理校验——能力门禁、预算、跳闸保护、重放。
2. **适配器不引入非确定性**：随机与时钟经 `PaeInvokeCtx`（`rng` / `clock`）注入；处理器若伸手去用 `Math.random` / `Date.now` 会破坏重放并被拒绝。

能力协商是显式的，而非静默：适配器若无法无损映射某外来工具，必须借 `fidelity`（`full | reduced | lossy`）声明，调用方亦可要求最低保真度；低于 `full` 必须附带 `fidelityNote`。注册表还会把整个适配面的 `configHash` 写进运行指纹，使工具集的变更被报告为配置漂移，而非 digest 不匹配。

```ts
import { OrbitRuntimeHost, JsPaeAdapter, ChannelKind } from "orbit-agent-runtime";

const host = new OrbitRuntimeHost();
await host.bootHost();

// 把一组进程内 JS 工具适配为内核能力通道。
const adapter = new JsPaeAdapter({
  adapterId: "echo-tools",
  sourceEdition: "1.0.0",
  tools: [{
    name: "echo",
    capability: "channel:write",
    handler: async (args) => ({ echoed: (args[0] as { text: string }).text })
  }]
});
host.registerPaeToolAdapter(adapter); // 外来工具面 → 派生 Pact，受门禁 + 记录

// 在智能体脚本内，外来工具就是一次普通通道调用：
//   const out = await ctx.call(ChannelKind.PAE_TOOL, "echo", [{ text: "hi" }]);
```

## 日志持久化（W27）

日志此前只存在于内存，进程重启即擦除审计轨迹与已录制运行。现在两类日志各挂一份崩溃安全
的预写日志——**按路径选择性开启**，不传路径则与此前的纯内存行为逐字节一致。

```ts
const host = new OrbitRuntimeHost({
  traceJournalPath: ".orbit/trace.wal.jsonl",   // 审计 / 行为日志
  recordJournalPath: ".orbit/record.wal.jsonl", // 录制窗口
  auditRetention: 10_000                        // 只保留最新 N 条
});

await host.bootHost();      // 先恢复（含自愈），再装配通道
// ... 运行智能体；上次的窗口被续开，orderIndex 顺延
await host.shutdownHost();  // 排空在途写入，再应用留存
```

几处值得知道的设计点：

- **崩溃模型决定了格式。** 一次写入只追加一整行，因此崩溃唯一能留下的是**被截断的末行**。
  恢复由此严格二分：丢弃那一行；而任何解析失败或结构非法的**内部行**按 `WalFileInvalidError`
  拒绝并带上行号——内部行不可能被崩溃截断，静默跳过等于隐藏真实损坏。
- **内存日志是唯一真源。** WAL 是 fire-and-forget 镜像，经写入链串行化以保证行不交错；
  `shutdownHost` 会 await 该链，正常关闭不丢条目。
- **恢复逐字节一致。** `entryUid`、`occurredAt`、`orderIndex` 均被保留，故续开的录制窗口
  索引顺延而非归零——被进程边界切开的运行仍重放为一条序列。
- **截断的末行在首次追加前被治愈。** 恢复虽容忍它，但那行仍在磁盘上；一旦本次运行追加新行，
  它就变成**内部**非法行，而那是硬故障。不处理的话，一次崩溃会让此后每次启动都失败。
  `healIfNeeded()` 从存活前缀原子重写文件，健康日志则零重写。
- **留存是显式的。** append-only 日志无上限增长终会打满磁盘，而磁盘满是一次宕机，因此
  `auditRetention` 由运维选择而非隐式默认；`pruneAuditLog()` 供长运行实例按需裁剪。

## Web 控制台

[Orbit Console](./web/README.md) — 零依赖的 Web 管理控制台，通过 HTTP 驱动真实内核实例：生命周期、通道、插件、沙箱、轨迹、回放台、影响域图与成本路由。

```bash
npm run build
node web/bridge-server.mjs        # http://127.0.0.1:8899
```

## 示例与基准（M5/M6）

**示例**（`./examples`）是可运行、带断言的走查——任一步失败即非零退出，可兼作 CI 冒烟：

```bash
node examples/custom-channel.mjs    # 实现通道 → record → replay 逐字节一致
node examples/js-pae-plugin.mjs     # 外来 JS 工具经网关治理（PAE L0）
node examples/mcp-adapter.mjs       # 真实 MCP 子进程，对端死后仍可逐字节重放（L2）
node examples/cli-record-replay.mjs # orbit CLI record → replay → diff 闭环
```

**基准**（`./benchmarks`，`npm run benchmark`）对照 VISION 性能预算观测热路径：

| 套件 | 测量内容 | 样例（Node 22） |
|---|---|---|
| `gateway` | 治理化 `capabilityInvoke` 全链路（record 模式） | ~82k calls/s（~12 µs） |
| `replay` | journal 快路径注入 | ~261k calls/s（~3.8 µs） |
| `wal` | 持久化 append + flush（WAL 镜像） | ~1.5k appends/s |
| `pae` | L0 进程内 vs L2 stdio 子进程适配器延迟 | ~38 µs vs ~176 µs（4.6×） |

## 快速开始 · 确定性重放闭环

产品的核心卖点是**可复现**：记录一次真实运行，用**零**模型调用重放它，并证明两条调用链逐字节一致。驱动它的就是 `orbit` CLI（零额外依赖，随包发布于 `bin/`，Node ≥ 20 即可运行）。

```bash
npm install        # 仅开发依赖（typescript + @types/node）
npm run build      # strict 编译 → dist/（同时产出 CLI）

# 1) 写一个脚本 —— 它拿到一个带通道访问能力的 ctx
cat > agent.mjs <<'EOF'
export default async function (ctx) {
  const reply = await ctx.llm.chat("summarize: the sky is blue");
  const seen  = await ctx.call(ctx.ChannelKind.MEM_KV_STORE, "readEntry", "last");
  return { reply, seen };
}
EOF

# 2) 记录真实运行 → 把每次通道调用捕获成轨迹
node bin/orbit.mjs record agent.mjs --out trace.jsonl
#   ✓ recorded 2 channel calls from agent.mjs
#   trace : trace.jsonl            （JSONL，原子写）
#   meta  : trace.jsonl.meta.json （驱动脚本 + 脱敏后的配置）

# 3) 重放（零真实调用）→ digest 链对账
node bin/orbit.mjs replay trace.jsonl
#   original calls : 2   replayed calls : 2
#   result         : ✓ VERIFIED — digest chain consistent

# 4) 对比两条轨迹 —— 定位首个分歧点
node bin/orbit.mjs diff trace.jsonl trace.jsonl
#   result: ✓ identical call chains
```

四条命令就是完整产品：一个陌生人十分钟内即可复现。每条命令都支持 `--json` 机器可读输出。

### 底层 API 与演示

```bash
npm test               # 构建 + 运行内核单元测试（node:test）—— 348 用例
npm run test:console   # 运行控制台前端单测（node:test）—— 89 用例
npm run demo           # 构建 + 运行演示入口（覆盖全部核心机制）
npm run demo:replay    # 确定性重放：约 1s 真实运行 → 约 2ms 重放
```

演示输出要点：

```
[cap] plugin -> LLM channel (channel:read): allowed
[cap] plugin -> KV write (undeclared channel:write): rejected
[sandbox] round 3 rejected (budget spent): agent sandbox box.demo-1 reached cycle limit 2
[guard] plugin crash isolated and journaled (host keeps running)
[trace] 5 entries: AGENT_SINGLE_CYCLE_EXEC / AGENT_CYCLE_LIMIT_HIT / PLUGIN_UNIT_EXCEPTION ...
```

## orbit CLI

三条命令构成确定性重放闭环。CLI 通过 `createRequire` 加载已编译内核，仅用 Node 内置模块。

```bash
orbit record <script.js> [--out trace.jsonl] [--config orbit.config.json]
orbit replay <trace.jsonl> [--via script.js] [--config orbit.config.json]
orbit diff <a.jsonl> <b.jsonl>
```

| 命令 | 作用 | 退出码 |
|---|---|---|
| `record` | 在真实内核上运行 `<script>`，把每次通道调用捕获为 JSONL 轨迹 + `.meta.json`（驱动脚本、脱敏配置、orbit/node 版本） | 成功 0 |
| `replay` | 用**零**真实通道调用重跑脚本，并把重放链与原始链对账（银行式 digest 校验） | 一致 0 · 漂移 1 |
| `diff` | 逐记录对比两条轨迹，报告首个断点（`channelKind` / `funcName` / `inputDigest` / `outputSnapshot`） | 一致 0 · 分歧 1 |

**脚本契约** —— 默认导出一个接收 `ctx` 的异步函数：

```js
export default async function (ctx) {
  const reply = await ctx.llm.chat("hello");                    // LLM_ACCESS.chatRound 的语法糖
  const prev  = await ctx.call(ctx.ChannelKind.MEM_KV_STORE, "readEntry", "k");
  return { reply, prev };
}
```

**配置** —— `orbit.config.json`（全部可选）选择真实能力；环境变量可覆盖以便快速试验：

```json
{
  "llm":   { "kind": "mock" | "openai-compat", "baseUrl": "…", "model": "…" },
  "file":  { "enabled": true, "rootDir": "./agent-workspace" },
  "shell": { "enabled": true, "allowedCommands": ["git","node"], "envAllowlist": ["PATH"] }
}
```

环境变量覆盖：`ORBIT_LLM_BASE_URL` / `ORBIT_LLM_API_KEY` / `ORBIT_LLM_MODEL`、
`ORBIT_FILE_ROOT`、`ORBIT_SHELL_ALLOW`（逗号列表）/ `ORBIT_SHELL_ENV`（逗号列表）。

> 一条录制好的轨迹，可以在**完全没有安装真实通道**的机器上重放——重放快速路径只从轨迹取数据，永远不需要 provider、凭据或工具。参见 [docs/guide.md](./docs/guide.md) 学习如何编写自己的可重放通道。

演示输出要点：

```
[cap] plugin -> LLM channel (channel:read): allowed
[cap] plugin -> KV write (undeclared channel:write): rejected
[sandbox] round 3 rejected (budget spent): agent sandbox box.demo-1 reached cycle limit 2
[guard] plugin crash isolated and journaled (host keeps running)
[trace] 5 entries: AGENT_SINGLE_CYCLE_EXEC / AGENT_CYCLE_LIMIT_HIT / PLUGIN_UNIT_EXCEPTION ...
```

## 目录结构（Monorepo）

内核以 npm workspaces + TypeScript Project References 组织为多包仓库，各层可独立
构建、版本与测试，而 `src/index.ts` 的公共 API 保持不变。

```
orbit-agent-runtime/
├── packages/
│   ├── infra-common/      # @orbit/infra-common —— 领域契约/纯工具/异常（types·utils·core）
│   ├── core-hub/          # @orbit/core-hub —— 通道/网关/replay/trace/pact/safeguard/routing
│   ├── sandbox-runtime/   # @orbit/sandbox-runtime —— 沙箱/影响域图/隔离域
│   └── pae-engine/        # @orbit/pae-engine —— 插件适配引擎（JS/MCP/OpenAPI/Cordis）
├── src/                   # 根宿主（core/orbitRuntimeHost.ts + index.ts 门面，公共 API 不变）
├── test/                  # 内核单元测试（node:test）
├── demo-host.ts           # 启动演示入口
└── web/                   # 零依赖管理控制台（bridge + SPA）
```

依赖分层无环：`infra-common → core-hub → {sandbox-runtime, pae-engine} → host`。

## 核心概念

| 概念 | 职责 |
|---|---|
| Channel | 外部能力的统一抽象；插件可覆盖内置通道（插件优先、内置兜底） |
| Pact | 插件清单：id、版本、宿主最低版本、能力声明 |
| TripProtector | 插件级故障状态机：连续失败跳闸 → 冷却 → 探测，单次成功即恢复 |
| TraceJournal | 追加式行为日志，快照保存/恢复，按链路/沙箱筛选 |
| AgentSandbox | 每智能体执行沙箱：循环计数、每轮独立追踪 ID、通道化模型调用 |
| SandboxPool | 沙箱生命周期管理：创建、查询、移除、释放 |

## 设计路线图

| 里程碑 | 内容 | 状态 |
|---|---|---|
| M1 | 工程骨架：tsconfig/package/测试/演示入口/能力裁决闭环 | ✅ 已完成 |
| M2 | **确定性重放** —— 记录非确定源，重放零调用精确复现，digest 链对账 | ✅ 已完成 |
| M3 | **影响域图论内核** —— 故障隔离建模为反向可达闭包，附隔离定理，注册期能力闭包静态验证 | ✅ 已完成 |
| M4 | **成本感知路由** —— 通道成本/延迟/质量档案，沙箱按轮预算调度 | ✅ 已完成 |
| M5 | 产品化攻坚：基准测试、插件示例、CI、npm 发布 | ✅ 已完成 |
| M6 | **开源发布** —— `orbit` CLI（`record`/`replay`/`diff`） | ✅ 已完成（CLI + audit 命令已交付） |
| M6b | **开源发布** —— 文档站 / 落地页、首个公开 npm 版本 | 待办（npm publish 一步之遥；`prepublishOnly` 已配好门禁） |

> M5/M6 对应 [docs/PRODUCT_PLAN.md](./docs/PRODUCT_PLAN.md) 的 P0 里程碑
> （P0.1 真能力落地 → P0.2 CLI 发布 → P0.3 开源发布）。

## 与主流方案的设计取舍

- **DeepSeek Harness** 走"一切皆插件"的全插件化路线（50+ 包 monorepo）。Orbit 保持**固定内核 + 通道级插件**：自由度更低，但六大机制各自独立、可完整讲解与验证
- **熔断器库**（opossum/cockatiel）在单个调用点做统计保护；Orbit 在**插件维度**隔离，且每次状态迁移绑定轨迹日志
- **MCP** 标准化工具发现；Orbit 的通道集线器是更轻的进程内等价物，自带超时、降级与能力裁决

## 许可协议

[Apache License 2.0](./LICENSE)

## 接入真实模型（DeepSeek）

内置 LLM 通道为测试用模拟实现；运行时将真实 DeepSeek provider 注册为插件扩展通道即可覆盖（插件通道优先于内置）：

```ts
import { OrbitRuntimeHost, DeepSeekChannel, ChannelKind } from "orbit-agent-runtime";

const host = new OrbitRuntimeHost();
await host.bootHost();
host.channelHub.registerPluginExtChannel(
  ChannelKind.LLM_ACCESS,
  new DeepSeekChannel({ apiKey: process.env.DEEPSEEK_API_KEY, model: "deepseek-chat" })
);
```

确定性重放无需改动：先记录真实运行，再零 API 调用精确重放、输出逐字节一致。

```bash
DEEPSEEK_API_KEY=sk-xxx npm run demo:deepseek
```

### 任意 OpenAI 兼容模型

`OpenAICompatChannel` 支持**任意** OpenAI 兼容端点——把 `baseUrl` 指过去即可：

```ts
import { OpenAICompatChannel } from "orbit-agent-runtime";

// DeepSeek / OpenAI / OpenAI / 通义 / Kimi / Ollama / vLLM ...
host.channelHub.registerPluginExtChannel(ChannelKind.LLM_ACCESS, new OpenAICompatChannel({
  apiKey: process.env.LLM_API_KEY,
  baseUrl: "https://dashscope.aliyuncs.com/compatible-mode", // 示例：通义千问
  model: "qwen-plus"
}));
```

非 OpenAI 协议（Anthropic Claude、Google Gemini）各需一个约 20 行的 `IChannelProvider` 适配器；重放/隔离/路由机制与协议无关。

生产化能力已内置：故障分类（`LlmChannelFaultError`——超时/网络/限流/服务端错误/鉴权/参数错误/未找到/空响应/无效响应），可重试故障用**确定性**指数退避重试（无 `Math.random`、尊重 `Retry-After`），内部重试不会泄漏进录制日志。

### 真实工具通道（文件 / Shell）

```ts
import { FileChannel, ShellChannel } from "orbit-agent-runtime";

// 文件访问，监禁在根目录内（路径越界即拒绝）。
host.channelHub.registerPluginExtChannel(ChannelKind.FILE_SYSTEM, new FileChannel({
  rootDir: "./agent-workspace"
}));

// 命令执行，精确匹配白名单；仅接受 argv 数组（无 shell 字符串 → 无注入面），
// 子进程默认空环境、硬超时与输出上限。
host.channelHub.registerPluginExtChannel(ChannelKind.SHELL_EXEC, new ShellChannel({
  allowedCommands: ["git", "node", process.execPath],
  workDir: "./agent-workspace",
  envAllowlist: ["PATH"]
}));
```

两者均为 `IO_BOUND` 通道：录制一次运行后重放，零磁盘访问、零进程启动。能力门禁映射：read/list/stat → `channel:read`，write/append/remove/mkdir/exec → `channel:write`。

### 轨迹持久化（JSONL）

```ts
import { saveRecordJournal, loadRecordJournal } from "orbit-agent-runtime";

await saveRecordJournal(journal, "trace.jsonl");   // 原子写（tmp + rename）
const restored = await loadRecordJournal("trace.jsonl"); // 校验加载
```

在**未安装真实通道**的新宿主上也能重放——重放快速路径直接从日志供给，不要求重放机器上存在通道实现、凭据或工具。
