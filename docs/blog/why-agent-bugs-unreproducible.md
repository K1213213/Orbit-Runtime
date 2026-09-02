# Agent bug 为什么不可复现

> 一个真实场景：你让 Agent 跑一段脚本，它第三次写出了错误的文件路径，把生产库的一张表改坏了。你立刻重跑——结果对了。你再跑——又错了。你盯着日志翻了半小时，发现“出错的那个版本”根本没留下任何可重来的线索。
>
> 这不是你的问题，是 **Agent 运行时的本质缺陷**：它生来就不可复现。本文拆解不可复现的四个根源，并给出一个工程解法——确定性重放（deterministic replay）。

---

## 一、不可复现的四个根源

### 1. 模型采样的随机性

即使 prompt 一字不差，只要 `temperature > 0`（或没固定 `seed`），同一次调用两次返回也可能不同。更隐蔽的是 **top-p / top-k 采样**和推理引擎的 **KV-cache 调度差异**——它们在数学上幂等，在实际上却“看心情”。

传统做法的盲区：把 prompt 记下来不等于能把那次回答复现出来。你没有记录当时的 `seed`、当时的 `temperature`、当时的采样路径。

### 2. 工具的副作用

Agent 不是只读的。它会：

- 用 `ShellChannel` 执行命令、写文件、调外部 API
- 用 `FileChannel` 读写一个被“监狱”限制在 `rootDir` 内的文件系统
- 改数据库、发消息、下单

这些副作用是**不可逆且污染环境的**。重跑一次，不仅结果可能不同，连“现场”都被改写了——你没法回到出错前的那个状态。

### 3. 并发与时序

多 Agent、子 Agent、事件总线（event bus）一上场，调用顺序就不再是确定的：

- 调度器先跑 A 还是先跑 B？
- 事件广播到插件 1 和插件 2 的先后？
- 限流护栏在哪一次调用触发？

任何一个环节的时序抖动，都会让整条执行链分叉。

### 4. 隐性随机源（最容易被忽视）

`Math.random()`、`Date.now()`、未注入的时钟/RNG。它们藏在工具实现、缓存 key、重试抖动、ID 生成里。只要有一处裸随机，**重放从根上就不可能**——你无法“冻结”一个你不知道存在的变量。

---

## 二、为什么传统日志救不了

很多框架会说：“我们记录了 session log，可以回看。”

但 **log replay ≠ execution replay**。区别在于：

| | 日志回看（log replay） | 执行重放（execution replay） |
|---|---|---|
| 记录内容 | “发生了什么”（文本/事件） | 每次通道调用的 `(输入指纹, 输出快照, 顺序)` |
| 能否逐字节复现 | ❌ 缺输入指纹与输出对账 | ✅ 注入冻结输出，零真实调用 |
| 能否在无凭据环境复现 | ❌ 仍需真实模型/工具 | ✅ 只依赖录制日志 |

更深层的是架构死结。以主流 Agent harness（如 DeepSeek Harness 类项目）为例：它的插件是**无契约的裸插件**，事件总线是**网状广播**。`session log` 只能“回看”，无法“重演”——因为广播顺序、插件内部状态都不可控。**要补“重放”，需要重构内核**，而它的模型决定了“要么自由要么治理”，重放几乎不可能。

> 这不是“加个功能”的事，是“换内核范式”的事。

---

## 三、确定性重放的工程解法

Orbit Agent Runtime 的解法：把“复现”这件事下沉到**网关层**，而不是留给上层应用去碰运气。

### 3.1 录制：在网关统一拦截

所有通道调用（LLM、KV、文件、Shell）都经 `ChannelHub.fireChannelCall` 分发。在分发路径上，每次调用被记录为一个 `ReplayCallRecord`：

```ts
interface ReplayCallRecord {
  orderIndex: number;        // 全局调用顺序，保证调度确定性
  channelKind: ChannelKind;  // 如 LLM_ACCESS / FILE_SYSTEM / SHELL_EXEC
  funcName: string;          // 如 chatRound / writeTextFile
  inputDigest: string;       // 输入的指纹（哈希）
  outputSnapshot: unknown;   // 输出的完整快照
  durationMs: number;
}
```

关键是：**顺序（orderIndex）也一起记录了**。这样连“调度抖动”都被冻结。

### 3.2 重放：零真实调用

重放时，内核挂载 `ReplayEngine`，把每条调用指向录制日志里的冻结输出：

```ts
replayCall(kind, funcName, inputDigest, orderIndex) {
  const record = this.journal.get(orderIndex);
  // 签名校验：channelKind / funcName / inputDigest 必须一致
  if (record.channelKind !== kind || record.funcName !== funcName || record.inputDigest !== inputDigest) {
    throw new ReplayDriftError(`call #${orderIndex} signature mismatch`);
  }
  return structuredClone(record.outputSnapshot); // 注入冻结输出，不碰模型/工具/网络
}
```

这意味着：

- **不调模型、不跑工具、不连网络**——即使你机器上没装 API key、没装 `FileChannel`，也能纯重放。
- 一处签名不一致，立刻抛出 `ReplayDriftError`，告诉你“第几条调用开始对不上了”。

> 内核里有个反直觉但关键的设计：重放快速路径被放在“通道 provider 是否存在”的检查**之前**。也就是说，重放一个轨迹**不需要真实通道已安装**——只有能力门禁（capability gate）仍然强制，治理不降级。

### 3.3 digest 链对账：银行式核对

重放跑完，内核做一遍 `reconcile`——像银行对账那样逐条比对原始链与重放链：

```ts
interface ReconcileReport {
  originalCount: number;
  replayedCount: number;
  digestChainConsistent: boolean;
  driftAtOrderIndex?: number;   // 第一个分叉点
}
```

任一条的 `channelKind` / `funcName` / `inputDigest` / 输出 digest 不同，`digestChainConsistent` 立即变 `false`，并精确定位到 `driftAtOrderIndex`——这就是你调试的入口。

### 3.4 确定性边界在网关层

光记录不够。如果工具实现里藏了裸随机，录制本身就不确定。所以内核定义了**三档确定性契约**：

```ts
enum DeterminismLevel {
  DETERMINISTIC = "deterministic",  // 纯函数：同输入同输出
  STOCHASTIC    = "stochastic",     // 含随机：通过 ctx.rng 注入种子
  IO_BOUND      = "io-bound"        // 碰外部状态：重放时注入输出快照
}
```

随机数和时钟**不是直接用** `Math.random()` / `Date.now()`，而是从 `ctx` 注入：

```ts
// 注入器：可复现的 PRNG（mulberry32）与单调时钟
class SeededRng { /* seed 相同 → 序列完全相同 */ }
class FixedClock { /* now() 在 base 上单调 +1 */ }
```

任何通道若直接调 `Math.random` 都算违规。这一条被 **`replay_compat` CI 门禁套件**用“投毒测试”守住——在所有新通道上拦截裸随机，犯规即红。

---

## 四、三个公理

确定性重放只是第一公理。Orbit 的内核立在三公理之上，每条都带 CI 验证方式：

| 公理 | 内容 | 验证 |
|---|---|---|
| **A1 可复现** | 零外部调用重放，逐字节一致，digest 链防篡改 | `replay_compat` 测试套件逐机制用例 |
| **A2 可证明** | 故障影响 = 反向可达闭包，隔离定理 | 图论单测 + 注册期能力闭包校验 |
| **A3 可核算** | 成本/Token/延迟进统一账本，可重放核算 | 账本对账测试 |

> 任何改动，是让“可复现·可证明·可核算”更强，还是更弱——这是判定标准。

---

## 五、它能解决什么，不能解决什么（诚实边界）

**能：**

- 把一次出错的运行**冻结成文件**（`orbit-trace.jsonl` + 脱敏的 `.meta.json`），随时在任意机器上 100% 复现，无需凭据、无需工具。
- `diff` 两条轨迹，**精确定位第一个分叉点**——是 LLM 回答变了？是文件写入内容变了？还是调用顺序变了？
- 做 **Agent 回归测试**：把“黄金轨迹”存进仓库，每次改动后自动 replay 对账。
- 做 **事故复盘**：证明“当时确实发生了什么”，而不是靠回忆。

**不能：**

- 它**不自动修复 bug**。它给你一把手术刀，不替你开刀。
- 它**不保证模型产出正确**。它保证的是“可证明当时确实如此”——把不可言说的随机，变成可审计的事实。
- 它**不替代单元测试**。它管的是“端到端执行链的可复现”，单点逻辑还得靠单测。

---

## 六、动手试试

安装（发布后）：

```bash
npm i -g orbit-runtime
```

写一个脚本，默认导出一个 `async (ctx)` 函数：

```js
// my-agent.mjs
export default async function (ctx) {
  const plan = await ctx.llm.chat("分解这个需求");
  const cached = await ctx.call(ctx.ChannelKind.MEM_KV_STORE, "readEntry", "lastPlan");
  await ctx.call(ctx.ChannelKind.FILE_SYSTEM, "writeTextFile", "plan.md", plan);
  return { plan, cached };
}
```

录制 → 重放 → 比对，形成确定性闭环：

```bash
orbit record my-agent.mjs --out run1.jsonl   # 真实跑一遍，录下每条调用
orbit replay run1.jsonl                       # 零模型调用重放 + digest 链对账
orbit diff run1.jsonl run2.jsonl              # 定位两条运行的分歧点
```

在 Orbit 控制台（Web 管理台）里，同一个 demo 的真实运行约 300ms，而确定性重放只需约 1ms——因为重放根本不碰模型、不碰磁盘、不碰网络，只是把冻结的输出“还”给你。

---

## 结语

Agent bug 不可复现，不是因为开发者粗心，而是因为运行模型从根上假设了“非确定性是默认值”。

Orbit 的选择是反过来：**把确定性设为默认值，把非确定性变成需要显式声明的例外**（种子注入、输出快照）。于是“复现一个 bug”从“玄学”变成“读一个文件”。

这不会让 Orbit 变成“更强的 DeepSeek Harness”——它的功能面窄得多。但它会是**第一个把“可复现·可证明·可核算”做成内核公理的 Agent 运行时**。在 Agent 行为需要被证明正确的那一刻（金融合规、医疗、法律、事故复盘），没有替代品。

> 仓库即将在 GitHub 公开。如果你也受够了“那个 bug 再也复现不了”，欢迎来一起把确定性变成行业默认值。
