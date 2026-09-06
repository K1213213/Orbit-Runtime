# Orbit Runtime：一个把"可复现 · 可证明 · 可核算"做成内核的 Agent 运行时

> 你的 Agent 在生产上跑得不错，直到某天下午：
>
> - 它删错了一张表，你想复现当时的操作——**重跑十次，结果次次不同**；
> - 复盘会上你拿出日志，安全团队问"谁能证明这日志没被改过"——**没人能答**；
> - 月底账单一万二，你问"哪个任务花的"——**只有一个总数**。
>
> 这三个问题不是运维疏忽，是运行时的能力缺口。Orbit Runtime 就是为了把它们变成"能回答"而写的。

---

## 一、它不是什么

先说边界，因为边界才是定位。

| 不做 | 原因 |
|---|---|
| Agent 编排框架 | 那是 LangGraph / Harness 的主场。Orbit 在它们**下面**——编排层调工具，工具调用由 Orbit 兜底 |
| 模型训练与推理 | 模型是通道背后的服务 |
| 自研工具生态 | 文件/命令/Web 走通道，MCP 生态走适配器复用，不重复造 |
| 可观测性平台 | 它记录"发生了什么"，Orbit 负责"能复现、能证明"——两者互补，不替代 |

一句话：**Orbit 是 Agent 的运行时内核，不是 Agent 框架**。你的编排代码不用改，把工具调用交给它就行。

---

## 二、三件事，三个公理

### 1. 可复现（Reproducible）

一次运行的所有非确定性决策与结果被完整记录；重放在**零外部调用**下复现，输出逐字节一致。

```js
import { OrbitRuntimeHost, ChannelKind } from "orbit-runtime";

const host = new OrbitRuntimeHost();
await host.bootHost();

const journal = host.beginRecording();               // 开始录
await host.capabilityInvoke({
  kind: ChannelKind.MEM_KV_STORE, pluginId: "demo", funcName: "readEntry",
  args: ["k"], mode: "record", ctx: { traceMarkId: "t1", maxWaitMs: 5000, pluginUnitId: "demo" }
});

host.attachReplayEngine(journal);                    // 挂上回放引擎
await host.capabilityInvoke({
  kind: ChannelKind.MEM_KV_STORE, pluginId: "demo", funcName: "readEntry",
  args: ["k"], mode: "replay", ctx: { traceMarkId: "t2", maxWaitMs: 5000, pluginUnitId: "demo" }
});   // 同一个调用，输出来自冻结快照，不碰存储、不碰网络
```

确定性边界在**网关层**而不是通道层——这是它能同时保证"通道可以随便写"和"重放必然一致"的原因。

### 2. 可证明（Provable）

故障隔离建模为**反向可达闭包**（谁的故障会影响谁，是图论问题不是感觉问题），注册期做能力闭包静态验证；审计轨迹带 HMAC 哈希链，改一条、删一条都会断裂并定位到条目：

```bash
orbit audit trace.wal.jsonl --key "$ORBIT_AUDIT_KEY"
# entries : 128
# signed  : true
# result  : ✓ audit chain consistent (no tampering detected)
```

### 3. 可核算（Accountable）

每次调用的路由、预算、压缩、限流决策都落在记录里，成本不再是月底的总数，而是可归因到单次调用：

```js
host.verifyAuditChain();      // { consistent: true, total: 128, signed: true }
```

---

## 三、一条刻度盘：从开发到合规

同一套代码，四档治理切换——开发时零摩擦，上线时收紧，合规档强制签名且**启动时验链，被篡改直接拒绝启动**：

| 档位 | 隔离级上限 | Schema | PAE 准入 | 轨迹持久化 |
|---|---|---|---|---|
| sandbox | L2 | 可选 | 全部 | 内存 |
| standard（默认） | L2 | 声明则校验 | 全部 | 可选 |
| strict | **L1** | **强制** | **关闭** | **强制** |

开发阶段用 sandbox 跑得飞快，金融/医疗场景切 strict——档位差异会进入运行指纹，所以**跨档重放会报配置漂移**，不会出现"在我机器上是合规的"。

---

## 四、五分钟上手

```bash
npm i orbit-runtime

# 1) 录一次真实运行（真实调模型、真实副作用）
orbit record my-agent.mjs --out run1.jsonl

# 2) 零调用重放 + digest 链对账（几百毫秒 → 一两毫秒）
orbit replay run1.jsonl

# 3) 两条运行哪里分叉了
orbit diff run1.jsonl run2.jsonl

# 4) 审计轨迹是否被改过
orbit audit trace.wal.jsonl --key "$ORBIT_AUDIT_KEY"
```

控制台（`npm run start:web`）默认只铺开产品面——**工作台 / 证明 / 系统**，图论、通道、适配器这些内核控制面收在"开发者控制台"折叠项里。给客户演示时，你看到的是审计与合规，不是架构师的画板。

---

## 五、谁该用，谁别用

**该用**：
- Agent 要动生产数据（删改、下单、发消息），你需要"出事后能说清"
- 处于金融/医疗/政务等需要举证的行业
- 想要调试体验替代日志翻查：同一段执行逐步回放，看每一步的输入、输出、治理决策

**别用**：
- 你在找 Agent 编排框架（去用 LangGraph，然后让它的工具调用走 Orbit）
- 你需要开箱即用的 SaaS 控制台（当前只有自托管的内核 + 本地控制台）
- 你的模型调用成本低于审计成本——那确实没必要

---

## 六、诚实的现状

- 处于 **pre-alpha**（v0.12.0）：内核机制完整、547 个测试全绿，但公开 API 尚不稳定，patch 版本可能调整
- **哈希链挡不住签发者撒谎**：持有密钥的人可以重签整条链。要防这个需要外部锚定（把链尾哈希写到 WORM 存储或时间戳服务）——**当前未实现**
- **没有 SaaS / 私有化商业版**：分层商业化是路线图，不是现有产品
- 控制台是**自托管**的本地管理台，不是多租户平台

把这些写在产品介绍里，是因为"能回答的问题"和"回答不了的问题"同样重要——你在评估它时，应该知道边界在哪。

---

## 结语

Agent 工程正在从"能不能跑通"走向"能不能负责"。跑通靠模型与框架，负责靠运行时。

Orbit 不做更强的编排，只做一件事：**让 Agent 的每一次行为都能被复现、被证明、被核算**。

- GitHub：<https://github.com/K1213213/Orbit-Runtime>
- 安装：`npm i orbit-runtime`
- 延伸阅读：[《Agent bug 为什么不可复现》](./why-agent-bugs-unreproducible.md) · [《日志是证据吗（审计哈希链）》](./audit-chain-provable-logs.md)
