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

## Web 控制台

[Orbit Console](./web/README.md) — 零依赖的 Web 管理控制台，通过 HTTP 驱动真实内核实例：生命周期、通道、插件、沙箱、轨迹、回放台、影响域图与成本路由。

```bash
npm run build
node web/bridge-server.mjs        # http://127.0.0.1:8899
```

## 快速开始

```bash
npm install        # 安装 typescript + @types/node（仅开发依赖）
npm run build      # strict 编译 → dist/
npm test           # 构建 + 运行单元测试（node:test）
npm run demo       # 构建 + 运行演示入口（覆盖全部核心机制）
npm run demo:replay  # 确定性重放：约 1s 真实运行 → 约 2ms 重放
```

演示输出要点：

```
[cap] plugin -> LLM channel (channel:read): allowed
[cap] plugin -> KV write (undeclared channel:write): rejected
[sandbox] round 3 rejected (budget spent): agent sandbox box.demo-1 reached cycle limit 2
[guard] plugin crash isolated and journaled (host keeps running)
[trace] 5 entries: AGENT_SINGLE_CYCLE_EXEC / AGENT_CYCLE_LIMIT_HIT / PLUGIN_UNIT_EXCEPTION ...
```

## 目录结构

```
src/
├── types/        # 全局领域契约、枚举、接口
├── utils/        # 版本解析、唯一 ID 生成
├── core/         # 领域异常体系、顶层宿主组装
├── channel/      # 能力通道抽象与内置实现（内存KV / LLM模拟）
├── pact/         # 插件规约校验与注册
├── safeguard/    # 跳闸保护、插件级故障隔离
├── trace/        # 轨迹日志本（记录、快照、筛选）
├── sandbox/      # 智能体沙箱与运行池
└── index.ts      # 公共 API 出口
demo-host.ts      # 启动演示入口
test/             # 单元测试（node:test）
```

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
| M5 | 产品化攻坚：基准测试、插件示例、CI、npm 发布 | 进行中 |
| M6 | **开源发布** —— `orbit` CLI（`record`/`replay`/`diff`）、文档站、首个公开版本 | 已规划 |

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
