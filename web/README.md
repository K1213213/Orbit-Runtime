# Orbit Console · 前端管理控制台

> 为 **Orbit Agent Runtime**（零依赖的插件化 Agent 运行时内核）打造的 Web 管理控制台：
> 真实驱动内核实例，覆盖六大机制的操作、观察与验证。

## 视觉设计 · Bio-Lineage（生命脉络）

整套界面以原创设计概念"**生命脉络 Bio-Lineage**"为基底——把 Agent 运行时当作一个活的共生体：

| 角色 | 生命隐喻 | 配色 |
|---|---|---|
| 通道 | 血脉之源（祖源层） | 基因绿 `#3cf2a8` |
| 插件 | 神经节（突触脉冲） | 神经紫 `#b78bff` |
| 沙箱 | 细胞体（培养舱） | 等离子青 `#39e6ff` |
| 异构适配器 | 接驳器（异体接驳端口） | 接驳橙 `#ff9d4d` |
| 依赖边 | 血缘血脉线（弧形贝塞尔 + 粒子流动） | 父子色相渐变 |
| 故障 | 病变沿血缘反向扩散 | 猩红 `#ff5c7a` |
| 预算 | ATP 能量条 | 流动青紫渐变 |

首创技术细节（零依赖）：

- **细胞质背景**：多层径向渐变 + SVG `feTurbulence` 噪点肌理
- **玻璃拟态面板**：半透明 + `backdrop-filter` + 顶部高光线 + 内嵌细胞壁辉光
- **等离子能量按钮**：基于 `@property --angle` 的 `conic-gradient` 旋转能量环
- **血脉流动**：贝塞尔血缘线 + 父子色相 `linearGradient` + 沿 path 的 SMIL 粒子
- **病变扩散**：受影响边变猩红 + 加速流动 + 红色光晕
- **呼吸生命体征**：所有活性元素（状态灯、能量条、神经节棘突）都有呼吸动画

所有其他视图（总览、追踪、回放、路由等）通过同一套设计令牌自动继承新视觉。

## 特性一览

| 板块 | 说明 |
|---|---|
| **总览** | 任务式工作台：系统健康结论 + 基于真实状态推导的下一步 + 关键指标 + 最近追踪与通道画像 |
| **命令面板** | `Ctrl/⌘+K`（或 `/`）唤起，模糊检索全部视图与主机动作，↑↓/Enter 全键盘操作 |
| **插件注册** | Pact 表单注册（字段 / 版本 / 能力三重校验）、注册清单、插件通道覆盖演示（plugin-first） |
| **沙箱对话** | 创建 Agent 沙箱、逐轮对话、循环预算进度、预算耗尽隔离、轮次重置 / 释放 |
| **追踪日志** | 追加式全链路事件流、按沙箱 / 事件类型过滤、自动刷新、JSON 导出 |
| **回放台** | 录制 → 零模型调用回放 → 字节一致检查 + digest chain 银行式对账，一键演示 |
| **影响域图** | 力导向依赖图（插件 / 沙箱 / 通道 / 适配器）、点击节点高亮故障影响域（反向可达闭包）、隔离定理检查 |
| **成本路由** | 通道成本画像、预算 / 延迟约束下的最便宜通道路由模拟 |
| **异构适配** | PAE 适配器工作台：模板化注册外来工具 → 动态 Pact 推导 → 保真度协商 → 经网关调用，全程可观测 |

## 快速开始

```bash
# 1. 先构建内核（生成 dist/，bridge server 依赖它）
npm run build

# 2. 启动控制台（零依赖，仅用 node 内置模块）
node web/bridge-server.mjs
#   默认 http://127.0.0.1:8899
#   自定义端口：PORT=9000 node web/bridge-server.mjs
```

打开浏览器访问 `http://127.0.0.1:8899` 即可。

## 架构

```
┌──────────────────────────── 浏览器 SPA（web/public/）────────────────────────────┐
│  index.html · styles.css · app.js（hash 路由 + 命令面板） · api.js（fetch 封装）     │
│  lib.js（纯函数：导航模型 / 模糊匹配 / 健康推导 / PAE 模板，可被 Node 直接单测）      │
│  views/  overview · plugins · boxes · channels · trace · replay                     │
│          graph · routing · pae                                                      │
└──────────────────────────────────────┬────────────────────────────────────────────┘
                                       │ HTTP /api/*（JSON）
┌──────────────────────────────────────▼────────────────────────────────────────────┐
│  web/bridge-server.mjs（node:http，零第三方依赖）                                    │
│   · 静态文件服务 web/public/                                                        │
│   · REST 桥接：直接驱动真实 OrbitRuntimeHost（dist/ 编译产物）                        │
│   · 回放验证在独立临时主机上执行，不影响控制台状态                                     │
└──────────────────────────────────────┬────────────────────────────────────────────┘
                                       │ 直接调用
┌──────────────────────────────────────▼────────────────────────────────────────────┐
│  dist/src/  OrbitRuntimeHost · ChannelHub · PluginPactVerifier · TripProtector     │
│            TraceJournal · SandboxPool · ImpactDomainGraph · CostRouter            │
│            RecordJournal · ReplayEngine                                            │
│            PaeAdapterRegistry · PaeChannel · JsPaeAdapter · McpPaeAdapter          │
└────────────────────────────────────────────────────────────────────────────────────┘
```

设计决策：

- **零依赖双端方案**：内核的卖点之一是 "zero runtime dependencies"，前端刻意不引入
  React/Vite/Express 等任何第三方包，保持同一理念，`node web/bridge-server.mjs` 开箱即用。
- **真实联调而非 mock**：所有页面操作都作用于一个真实 `OrbitRuntimeHost` 实例，
  追踪日志、熔断、预算等行为就是内核的真实行为。
- **通道覆盖演示**：`POST /api/channels/plugin` 注册 echo 插件通道，可直观看到
  ChannelHub 的 plugin-first（插件通道优先于内置通道）。

## 信息架构

九个能力面不是九个并列页面，而是三种用户意图：

| 分组 | 意图 | 视图 |
|---|---|---|
| **运行时** | 观察并驱动正在跑的 Agent | 总览 · 沙箱对话 · 追踪日志 |
| **构件** | 接入某种外部能力 | 插件注册 · 模型通道 · 异构适配 |
| **治理** | 证明隔离、复现执行、控制成本 | 影响域图 · 回放台 · 成本路由 |

分组导航与命令面板**共用同一份数据**（`lib.js` 的 `NAV_GROUPS`），因此两处的
信息架构不可能走偏。侧栏按钮不是写在 HTML 里的，而是由这份数据在启动时生成——
这源于一次真实事故：`channels` 视图在路由表里，但导航没有对应按钮，整页不可达
且无人发现。现在"声明了却渲染不出来"会在测试里直接失败
（`missingRenderers`），而不是等用户点不到。

### 命令面板

`Ctrl/⌘+K`，或直接按 `/`：

- 检索范围同时覆盖**视图**与**主机动作**（启动 / 停止 / 重启 / 刷新）
- 模糊匹配中英文混排，支持按关键词命中标题里没有的同义词（搜 `mcp` 直达"异构适配"）
- `↑` `↓` 选择，`Enter` 执行，`Esc` 关闭，鼠标与键盘等价

### 首屏为什么是"下一步"

首屏不重复导航，而是回答两个问题：**现在能干活吗**、**接下来做什么**。
系统健康给出结论并列出得出该结论的每一条理由；下一步由真实内核状态推导
（`deriveSystemHealth` / `suggestNextSteps`），每条都是可直接点进去执行的操作，
不是说明文字。主机未运行时，它只给一条建议——先启动。

## 推荐体验路径

1. **插件注册** → 注册 `plugin.weather`（勾选 `channel:read` 与 `llm-access` 依赖）
2. **沙箱对话** → 创建 `box.agent-1`（循环预算 2），连发 3 条消息，观察第 3 轮被拒
3. **追踪日志** → 查看 `AGENT_SINGLE_CYCLE_EXEC` / `AGENT_CYCLE_LIMIT_HIT` 事件
4. **回放台** → 一键录制回放，观察 ~300ms → ~1ms 的加速比与 digest 对账
5. **影响域图** → 点击 `llm-access` 通道，查看依赖它的插件与沙箱全部高亮
6. **成本路由** → 把预算拉到 0.5，观察"预算买不起任何通道"
7. **异构适配** → 用 `hash` / `reverse` 模板注册一个适配器，调用它并观察 `route: pae`；
   再把保真度改成 `lossy` 但不填说明，看注册被诚实拒绝

## API 速览

```
GET  /api/health                    主机健康与版本
GET  /api/state                     控制台聚合状态
POST /api/host/boot | shutdown      主机生命周期
GET  /api/channels                  通道清单
POST /api/channels/plugin           插件通道覆盖（echo 演示）
GET|POST /api/plugins               插件注册 / 清单（DELETE 重置）
GET|POST /api/boxes                 沙箱池 / 创建（DELETE :id 释放）
POST /api/boxes/:id/run | reset     执行一轮 / 重置轮次
GET  /api/trace                     追踪事件（?box=&limit=）
POST /api/replay/demo               录制-回放-对账一键验证
GET  /api/graph                     依赖图（nodes + edges）
GET  /api/graph/isolation?node=     节点影响域（反向可达闭包）
POST /api/graph/check               隔离定理检查（a, b 是否互不影响）
GET  /api/routing/profiles          通道成本画像
POST /api/routing/simulate          预算路由模拟
GET  /api/pae                       PAE 适配器清单 + 工具面 + 配置哈希
POST /api/pae                       注册适配器（模板化工具规格）
POST /api/pae/invoke                经网关调用外来工具（返回路由决策 / 耗时 / 结果）
POST /api/pae/negotiate             保真度协商（工具是否达到所需保真度）
DELETE /api/pae/:id                 注销适配器并撤销其动态 Pact
```

## 异构适配工作台（Adapter Studio）

`#pae` 视图把内核的 **PAE（Plugin Adaptation Engine）** 完整暴露成可操作的界面。
它不是又一个表单页——它把"外来运行时如何被内核收编"这条链路拆成四步，每一步都可见：

支持**两种适配器家族**，差异决定了工作流差异：

| 家族 | 进程 | 工具面何时可知 | 默认保真度 |
|---|---|---|---|
| **JS 工具集** | 内核进程内（L0） | 注册时即可声明 | `full`（同语言、同值空间） |
| **MCP 服务器** | 独立子进程（L2） | 握手后由对端声明 | `reduced`（见下，且必带说明） |

MCP 默认 `reduced` 不是保守，是诚实：参数 `inputSchema` 由**远端**校验而非内核，
返回值由 MCP 的 `content[]` 块映射为 JSON，非文本块（图片 / 资源）原样保留而不强转。
声称 `full` 会是这个适配器能做出的最具破坏性的假声明，因为下游所有假设都建立在它之上。

**连接一个 MCP 服务器**：填启动命令与参数（如 `node mcp-server.mjs` 或
`npx -y @modelcontextprotocol/server-x`），点"连接"——控制台会真的 spawn 子进程、
完成 `initialize` 握手、`tools/list` 发现工具面，**然后**才注册。界面只会列出对端
真正声明过的工具。握手失败会关闭子进程且不留下任何注册痕迹。
Windows 上的 `npx` 是批处理脚本，此时勾选"经系统 shell 启动"。

```
① 选模板 → ② 注册适配器（动态 Pact）→ ③ 协商保真度 → ④ 经网关调用
   ↓              ↓                        ↓                ↓
工具规格        能力并集 + channel 依赖     full/reduced/lossy   capabilityInvoke
                                          诚实降级说明        → 落入 RecordJournal
```

**内置工具模板（12 个）**：`echo` `reverse` `upper` `lower` `length` `hash` `base64`
`json` `add` `now` `random` `uuid`。模板只描述**描述符**（能力 / 确定性 / 保真度），
真实 handler 由 bridge server 注入，且随机与时钟一律走 `SeededRng` / 注入式 clock——
界面上看起来是 `random` 和 `now`，底下依然是确定性可重放的。

**三条内核约束在界面上的对应**

| 内核铁律 | 界面表现 |
|---|---|
| 适配器不直连内核，整体发布为 `PaeChannel` | 调用结果里显示 `route: pae`，说明走了网关而非直连 |
| 不引入非确定性 | 模板声明 `determinism`（deterministic / io-bound / stochastic），随机类工具由注入源供数 |
| 保真度降级必须诚实 | 选 `reduced` / `lossy` 时 `fidelityNote` 变为必填，缺失则注册被拒 |

**配置哈希**：适配器列表实时显示 `configHash`（顺序无关的 SHA-256 前 16 位）。
它是运行指纹的一部分——改动适配面后旧轨迹重放会报配置漂移，而不是莫名的 digest 不匹配。

**影响域图联动**：注册适配器后，图中会出现 `pae-tool` 接驳通道节点与每个适配器节点，
边方向 `adapter → pae-tool`，与原生通道共享同一套血缘布局与故障扩散逻辑。

## 已知边界（内核 API 限制的折射）

- **图节点无动态移除**：`ImpactDomainGraph` 未暴露单节点删除 API，释放沙箱后该节点
  保留至主机重启（界面已提示）。
- **单插件删除**：同上原因，插件区提供"重置"而非逐个删除。
- **适配器可逐个注销**：PAE 注册表持有自己的索引，注销适配器会同步撤销其动态 Pact
  并从通道上摘掉工具方法，因此不受上面两条限制。
- 详见 Eno 架构评审报告中的 P1 建议。

## 目录结构

```
web/
├── bridge-server.mjs     # 零依赖 REST bridge + 静态服务（node:http）
├── README.md
├── test/                 # 前端单元测试（node:test，零依赖）
│   ├── pae-catalog.test.mjs    # 纯函数：转义 / 保真度秩 / 模板目录 / 描述符推导
│   └── bridge-pae.test.mjs     # 集成：真实 host 上的注册 → 调用 → 协商 → 注销
└── public/
    ├── index.html        # SPA 入口（深色工程控制台主题）
    ├── styles.css        # 设计令牌 + 组件样式
    ├── app.js            # hash 路由 + 布局 + 主机状态轮询
    ├── api.js            # fetch 封装
    ├── lib.js            # 纯函数工具 + PAE 模板目录（DOM-free，可单测）
    └── views/            # 8 个视图模块（ES Modules，零构建）
```

## 测试

```bash
npm run test:console     # 前端单元测试（49 例）
npm test                 # 内核全量测试（205 例）
```

测试策略与内核一致：**零第三方断言库**，直接使用 Node 内置 `node:test` + `node:assert`。

`lib.js` 刻意做成 DOM-free 纯模块——凡是"决定用户接下来看到什么"的逻辑
（导航模型、命令面板排序、健康判定、下一步推荐、参数解析）都放在里面，
因此可以在 Node 里被直接断言，而不必把业务规则锁死在浏览器里。

`web/test/fixtures/mcp-stdio-server.mjs` 是一个真实的最小 MCP 服务器（子进程 +
stdio + JSON-RPC），用于端到端验证 MCP 链路：spawn、换行分帧、握手、工具发现、
跨进程调用、注销时回收，每一步都是真的。

## 模型通道页

`#channels` 视图支持**任意 OpenAI 兼容端点**（DeepSeek / OpenAI / 通义 / Kimi / Ollama…）：

- API Key 仅存运行时内存，不落盘、不回显
- 填写 API 地址（baseUrl）即可切换提供方；留空 key 可用于本地无认证端点（如 Ollama）
- 注册后沙箱对话走真实模型，回放台仍零 API 调用精确重放
