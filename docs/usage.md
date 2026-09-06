# 使用文档 · 快速上手

> Audience: 你想把 Orbit 用起来——从一条命令开始，跑通「录下来 → 重放到逐字节一致 →
> 出具可验签的合规报告」这条主线。控制台的操作说明单独放在[《控制台导览》](./console.html)。

Orbit 的核心主张只有三句：**可复现、可证明、可核算**。这份文档用一次真实的端到端流程，
把这三句落到你能敲的命令上。

---

## 1. 安装

Orbit 是一个 npm 包，**零运行时依赖**，装完即用：

```bash
npm install -g orbit-runtime       # 全局安装 CLI
# 或者在项目里
npm install orbit-runtime
```

它不要求你改任何脚本——你需要做的只是**写一个驱动脚本**，描述一次智能体回合要做什么。
先确认版本：

```bash
orbit --version   # orbit 0.12.0 — deterministic-replay CLI for Orbit Agent Runtime
```

> 说明：旧包名 `orbit-agent-runtime` 已弃用并引导迁移到 `orbit-runtime`。

---

## 2. 五分钟上手（CLI）

Orbit 的 CLI 只有四条主命令。我们把「录一段对话 → 原样重放 → 审计 → 出报告」走一遍。

### (1) 写一个驱动脚本

```js
// agent.mjs — 描述一次要做的动作，不关心它怎么被记录下来
export default async function (ctx) {
  const reply = await ctx.llm.chat("hello");
  const prev = await ctx.call(ctx.ChannelKind.MEM_KV_STORE, "readEntry", "k");
  return { reply, prev };
}
```

### (2) record —— 真实跑一遍，录进 trace

```bash
orbit record agent.mjs --out ./orbit-trace.jsonl
```

这一步会**真的调用**模型、真的读存储，然后把每个通道调用连同输出一起写进 `orbit-trace.jsonl`。

### (3) replay —— 零真实调用，逐字节复现

```bash
orbit replay ./orbit-trace.jsonl --via agent.mjs
```

重放时**不触碰任何外部通道**——模型、文件、shell 一律被 frozen 输出顶掉。判定标准只有一条：
如果重放结果和录制结果**逐字节一致**，这次运行就是可复现的；不一致就抛 `ReplayDriftError`。

### (4) diff —— 两段 trace 对账

```bash
orbit diff ./a.jsonl ./b.jsonl
```

想看两次运行到底差在哪一行？diff 会给出第一个分歧点的位置。

### (5) audit + verify-report —— 出具可验签的证据

```bash
orbit audit ./orbit-trace.wal.jsonl --key <hmac-key>
orbit verify-report ./report.json --public-key <pem|hex-seed>
```

`audit` 校验审计哈希链（HMAC + prevHash/chainHash），`verify-report` 用公钥验 ED25519 签名——
**第三方不需要你的密钥，就能确认这份报告没被改过**。

---

## 3. 三条主线对应三个承诺

| 你的问题 | Orbit 的答案 | 配套命令/接口 |
|:-:|---|:-:|
| 这个 bug 还能复现吗？ | **可复现**——record 冻结输出，replay 逐字节对账 | `orbit record` / `orbit replay` / `orbit diff` |
| 这条日志能当证据吗？ | **可证明**——审计条目走 HMAC 哈希链，篡改即断裂 | `orbit audit` / `host.verifyAuditChain()` |
| 这笔账算在谁头上？ | **可核算**——成本路由 + 治理决策 + 预算压缩限流 | `host` 配置 / `deriveBilling` |

---

## 4. 代码里怎么用（宿主 API）

CLI 只是薄壳。真正的能力在 `OrbitRuntimeHost`：

```ts
import { OrbitRuntimeHost } from "orbit-runtime";

const host = await OrbitRuntimeHost.create({
  governanceProfile: "strict",      // sandbox | standard | strict
  auditSigningKey: process.env.ORBIT_AUDIT_SIGNING_KEY, // strict 档强制
  traceJournalPath: "./orbit-trace.jsonl",
  recordJournalPath: "./orbit-record.jsonl",
  auditRetention: 1000,
});

// 1) 录一段受治理的调用
const journal = host.beginRecording();
const reply = await host.capabilityInvoke("llm", "chat", { messages: [...] });
const record = journal.size();

// 2) 校验审计链（链上每一条都是 HMAC 签过的）
const verdict = host.verifyAuditChain();
// { signer: "...", entries: 4, signed: true, consistent: true, firstBroken: null }

// 3) 出合规报告并签章（ED25519，seed 确定性派生密钥对）
const signed = signComplianceReport(buildComplianceReport(host), deriveReportKeyPair(seed));
const ok = verifyComplianceReport(signed, "public-key");
```

### 治理档位

| 档位 | 语义 | 关键约束 |
|:-:|---|---|
| `sandbox` | 准入最松，观察优先 | 不强制签名 |
| `standard` | 默认档，与 v0.5.x 逐字节一致 | PAE 准入 = all |
| `strict` | 准入最严，构造期即失败 | 强制 WAL 路径 + 审计签名 key |

---

## 5. 完整生命周期示例

仓库里有一个**从 boot 到签章报告**的完整流程 demo，边跑边看每个环节的输出：

```bash
node examples/full-lifecycle.mjs
```

它依次演示：Boot（strict 档强制 WAL + 签名）→ Record（受治理调用）→ 审计链验证 →
Replay（零调用、逐字节一致）→ 漂移检测（篡改输入被拒）→ 重启恢复（从 WAL 续开）→
签名合规报告（第三方可验）。

---

## 6. 下一步

- **想看界面？** 读下一页[《控制台导览》](./console.html)——17 个页面逐页截图说明。
- **想写自己的通道？** 读[《开发者指南》](./guide.html)——如何让新能力可复现。
- **想理解内核为什么这样设计？** 读[《架构宪章》](./VISION.html) 与[《内核设计》](./architecture.html)。
