# Orbit Agent Runtime

> **Deterministic · Provable · Governable**
> 面向插件化智能体的轻量运行内核：插件热注册、可证明的故障隔离、全链路轨迹溯源、沙箱化执行。

[English](./README.md) · **简体中文**

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

## Web 控制台

[Orbit Console](./web/README.md) — 零依赖的 Web 管理控制台，通过 HTTP 驱动真实内核实例：生命周期、通道、插件、沙箱、轨迹、确定性重放实验室、影响域图与成本路由。

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
| M5 | 基准测试、插件示例、CI、发布 | 进行中 |

## 与主流方案的设计取舍

- **DeepSeek Harness** 走"一切皆插件"的全插件化路线（50+ 包 monorepo）。Orbit 保持**固定内核 + 通道级插件**：自由度更低，但六大机制各自独立、可完整讲解与验证
- **熔断器库**（opossum/cockatiel）在单个调用点做统计保护；Orbit 在**插件维度**隔离，且每次状态迁移绑定轨迹日志
- **MCP** 标准化工具发现；Orbit 的通道集线器是更轻的进程内等价物，自带超时、降级与能力裁决

## 许可协议

[Apache License 2.0](./LICENSE)
