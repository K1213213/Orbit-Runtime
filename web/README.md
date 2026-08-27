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
| **总览** | 运行时状态统计（通道 / 插件 / 沙箱 / 追踪）、六大机制导航、最近追踪流、主机生命周期控制 |
| **插件注册** | Pact 表单注册（字段 / 版本 / 能力三重校验）、注册清单、插件通道覆盖演示（plugin-first） |
| **沙箱对话** | 创建 Agent 沙箱、逐轮对话、循环预算进度、预算耗尽隔离、轮次重置 / 释放 |
| **追踪日志** | 追加式全链路事件流、按沙箱 / 事件类型过滤、自动刷新、JSON 导出 |
| **回放实验室** | 录制 → 零模型调用回放 → 字节一致检查 + digest chain 银行式对账，一键演示 |
| **影响域图** | 力导向依赖图（插件 / 沙箱 / 通道）、点击节点高亮故障影响域（反向可达闭包）、隔离定理检查 |
| **成本路由** | 通道成本画像、预算 / 延迟约束下的最便宜通道路由模拟 |

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
│  index.html · styles.css · app.js（hash 路由） · api.js（fetch 封装）               │
│  views/  overview · plugins · boxes · trace · replay · graph · routing            │
└──────────────────────────────────────┬────────────────────────────────────────────┘
                                       │ HTTP /api/*（JSON）
┌──────────────────────────────────────▼────────────────────────────────────────────┐
│  web/bridge-server.mjs（node:http，零第三方依赖）                                    │
│   · 静态文件服务 web/public/                                                        │
│   · REST 桥接：直接驱动真实 OrbitRuntimeHost（dist/ 编译产物）                        │
│   · 回放实验在独立临时主机上执行，不影响控制台状态                                     │
└──────────────────────────────────────┬────────────────────────────────────────────┘
                                       │ 直接调用
┌──────────────────────────────────────▼────────────────────────────────────────────┐
│  dist/src/  OrbitRuntimeHost · ChannelHub · PluginPactVerifier · TripProtector     │
│            TraceJournal · SandboxPool · ImpactDomainGraph · CostRouter            │
│            RecordJournal · ReplayEngine                                            │
└────────────────────────────────────────────────────────────────────────────────────┘
```

设计决策：

- **零依赖双端方案**：内核的卖点之一是 "zero runtime dependencies"，前端刻意不引入
  React/Vite/Express 等任何第三方包，保持同一理念，`node web/bridge-server.mjs` 开箱即用。
- **真实联调而非 mock**：所有页面操作都作用于一个真实 `OrbitRuntimeHost` 实例，
  追踪日志、熔断、预算等行为就是内核的真实行为。
- **通道覆盖演示**：`POST /api/channels/plugin` 注册 echo 插件通道，可直观看到
  ChannelHub 的 plugin-first（插件通道优先于内置通道）。

## 推荐体验路径

1. **插件注册** → 注册 `plugin.weather`（勾选 `channel:read` 与 `llm-access` 依赖）
2. **沙箱对话** → 创建 `box.agent-1`（循环预算 2），连发 3 条消息，观察第 3 轮被拒
3. **追踪日志** → 查看 `AGENT_SINGLE_CYCLE_EXEC` / `AGENT_CYCLE_LIMIT_HIT` 事件
4. **回放实验室** → 一键录制回放，观察 ~300ms → ~1ms 的加速比与 digest 对账
5. **影响域图** → 点击 `llm-access` 通道，查看依赖它的插件与沙箱全部高亮
6. **成本路由** → 把预算拉到 0.5，观察"预算买不起任何通道"

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
POST /api/replay/demo               录制-回放-对账一键实验
GET  /api/graph                     依赖图（nodes + edges）
GET  /api/graph/isolation?node=     节点影响域（反向可达闭包）
POST /api/graph/check               隔离定理检查（a, b 是否互不影响）
GET  /api/routing/profiles          通道成本画像
POST /api/routing/simulate          预算路由模拟
```

## 已知边界（内核 API 限制的折射）

- **图节点无动态移除**：`ImpactDomainGraph` 未暴露单节点删除 API，释放沙箱后该节点
  保留至主机重启（界面已提示）。
- **单插件删除**：同上原因，插件区提供"重置"而非逐个删除。
- 详见 Eno 架构评审报告中的 P1 建议。

## 目录结构

```
web/
├── bridge-server.mjs     # 零依赖 REST bridge + 静态服务（node:http）
├── README.md
└── public/
    ├── index.html        # SPA 入口（深色工程控制台主题）
    ├── styles.css        # 设计令牌 + 组件样式
    ├── app.js            # hash 路由 + 布局 + 主机状态轮询
    ├── api.js            # fetch 封装
    └── views/            # 7 个视图模块（ES Modules，零构建）
```
