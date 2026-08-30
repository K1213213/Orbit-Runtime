/**
 * Orbit Console · 纯函数工具库（无 DOM 依赖，可在 Node 中直接单测）
 *
 * 前端视图与桥接服务共用的无副作用逻辑都集中在这里：文本转义、徽章渲染、
 * 时间格式化，以及 PAE 工具模板目录（描述符，不含真实 handler——handler
 * 始终由桥接服务端按模板 id 构造，浏览器无法下发函数）。
 */

/* ------------------------------------------------------------------ */
/* 文本 / 格式化                                                        */
/* ------------------------------------------------------------------ */

export function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function fmtTime(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}

export function fmtDate(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function shortId(id, n = 26) {
  return id.length > n ? id.slice(0, n) + "…" : id;
}

/**
 * 神经徽章的 HTML 字符串。tone 对应 styles.css 中的 .badge.<tone>。
 */
export function badge(text, tone = "neutral") {
  return `<span class="badge ${tone}">${esc(text)}</span>`;
}

/* ------------------------------------------------------------------ */
/* PAE 保真度                                                           */
/* ------------------------------------------------------------------ */

/** 与内核 FIDELITY_RANK 保持一致（full ≻ reduced ≻ lossy）。 */
export const FIDELITY_RANK = { full: 2, reduced: 1, lossy: 0 };

export const FIDELITY_LABEL = {
  full: "完整映射",
  reduced: "降损映射",
  lossy: "有损映射"
};

export const FIDELITY_TONE = {
  full: "ok",
  reduced: "warn",
  lossy: "err"
};

/* ------------------------------------------------------------------ */
/* PAE 工具模板目录（描述符，纯数据）                                   */
/* ------------------------------------------------------------------ */
/**
 * 每个模板描述「一个可被外来运行时接入的内核能力」的默认契约。
 * handler 由桥接服务端按 id 构造，这里只持有描述与默认值，便于 UI 预览、
 * 表单默认值与单测共用同一份事实来源。
 *
 * needsCtx 标记该工具是否需要内核注入的确定性源（rng / clock），
 * 用于界面诚实提示「该工具本身不可纯重放，靠快照注入保证回放一致」。
 */
export const PAE_TEMPLATES = {
  echo: {
    label: "回声",
    description: "原样返回首个入参，验证外来调用已落入内核网关与 RecordJournal。",
    capability: "channel:read",
    determinism: "deterministic",
    fidelity: "full",
    argHint: "任意字符串",
    resultHint: "与入参相同",
    example: "hello orbit"
  },
  reverse: {
    label: "逆序",
    description: "将字符串按字符逆序返回。",
    capability: "channel:read",
    determinism: "deterministic",
    fidelity: "full",
    argHint: "字符串",
    resultHint: "逆序后的字符串",
    example: "orbit"
  },
  upper: {
    label: "大写",
    description: "将字符串转为大写。",
    capability: "channel:read",
    determinism: "deterministic",
    fidelity: "full",
    argHint: "字符串",
    resultHint: "大写字符串",
    example: "hello"
  },
  lower: {
    label: "小写",
    description: "将字符串转为小写。",
    capability: "channel:read",
    determinism: "deterministic",
    fidelity: "full",
    argHint: "字符串",
    resultHint: "小写字符串",
    example: "WORLD"
  },
  length: {
    label: "长度",
    description: "返回首个入参的字符串长度（数值）。",
    capability: "channel:read",
    determinism: "deterministic",
    fidelity: "full",
    argHint: "字符串",
    resultHint: "整数长度",
    example: "orbit-runtime"
  },
  hash: {
    label: "SHA-256",
    description: "对入参做 SHA-256 摘要，返回 64 位十六进制。",
    capability: "channel:read",
    determinism: "deterministic",
    fidelity: "full",
    argHint: "任意字符串",
    resultHint: "64 位 hex 摘要",
    example: "orbit"
  },
  base64: {
    label: "Base64 编码",
    description: "将入参 UTF-8 字符串做 Base64 编码。",
    capability: "channel:read",
    determinism: "deterministic",
    fidelity: "full",
    argHint: "字符串",
    resultHint: "Base64 文本",
    example: "orbit agent"
  },
  json: {
    label: "JSON 美化",
    description: "将 JSON 字符串解析并以 2 空格缩进重新序列化。",
    capability: "channel:read",
    determinism: "deterministic",
    fidelity: "full",
    argHint: "JSON 字符串",
    resultHint: "美化后的 JSON",
    example: '{"a":1,"b":[2,3]}'
  },
  add: {
    label: "数值求和",
    description: "对入参数组中的数值求和（非数值按 0 处理）。",
    capability: "channel:read",
    determinism: "deterministic",
    fidelity: "full",
    argHint: "逗号分隔数字",
    resultHint: "数值和",
    example: "1,2,3,4"
  },
  now: {
    label: "当前时刻",
    description: "返回内核注入时钟的当前毫秒时间戳。",
    capability: "channel:read",
    determinism: "io-bound",
    fidelity: "full",
    argHint: "（无）",
    resultHint: "毫秒时间戳",
    example: "",
    needsCtx: "clock"
  },
  random: {
    label: "确定性随机",
    description: "返回内核注入的 SeededRng 产生的 [0,1) 浮点，回放靠快照注入保持确定。",
    capability: "channel:read",
    determinism: "stochastic",
    fidelity: "full",
    argHint: "（无）",
    resultHint: "[0,1) 浮点",
    example: "",
    needsCtx: "rng"
  },
  uuid: {
    label: "UUID 风格序列",
    description: "基于注入 RNG 生成 8-4-4 风格的可复现序列号。",
    capability: "channel:read",
    determinism: "stochastic",
    fidelity: "full",
    argHint: "（无）",
    resultHint: "形如 4f3a-9c21 的序列",
    example: "",
    needsCtx: "rng"
  }
};

export const PAE_TEMPLATE_IDS = Object.keys(PAE_TEMPLATES);

/**
 * 由模板 id 推导一个 PAE 工具描述符（纯函数，供 UI 预览与单测）。
 * overrides 可覆盖任意字段；若覆盖后的 fidelity 非 full，必须提供
 * fidelityNote——与内核「诚实门禁」一致，降级不得静默。
 *
 * @throws 当模板 id 未知，或降级却未给 fidelityNote。
 */
export function describePaeTool(templateId, name, overrides = {}) {
  const tpl = PAE_TEMPLATES[templateId];
  if (!tpl) throw new Error(`unknown pae template: ${templateId}`);
  const fidelity = overrides.fidelity ?? tpl.fidelity;
  const fidelityNote = fidelity === "full" ? undefined : (overrides.fidelityNote ?? tpl.fidelityNote);
  if (fidelity !== "full" && !fidelityNote) {
    throw new Error(`pae tool "${name ?? templateId}" maps at fidelity "${fidelity}" without a fidelityNote`);
  }
  return {
    name: name ?? templateId,
    capability: overrides.capability ?? tpl.capability,
    determinism: overrides.determinism ?? tpl.determinism,
    fidelity,
    fidelityNote,
    description: tpl.description
  };
}

/* ------------------------------------------------------------------ */
/* 信息架构 · 分组导航模型                                              */
/* ------------------------------------------------------------------ */
/**
 * 九个能力面不是九个并列页面，而是三种用户意图：
 *
 *   运行时 —— 我要看/驱动正在跑的东西
 *   构件   —— 我要接入某种能力
 *   治理   —— 我要证明/复现/控制成本
 *
 * 平铺导航把这三者混在一起，用户只能靠图标猜。分组后每组有明确意图，
 * 命令面板也按同一模型索引，两处信息架构不会走偏。
 */
export const NAV_GROUPS = [
  {
    id: "runtime",
    label: "运行时",
    desc: "观察并驱动正在运行的 Agent",
    items: [
      { path: "overview", title: "总览", icon: "◈", keywords: "overview home 首页 总览 工作台 dashboard" },
      { path: "boxes", title: "沙箱对话", icon: "▣", keywords: "box sandbox agent 沙箱 对话 执行" },
      { path: "trace", title: "追踪日志", icon: "≡", keywords: "trace log event 追踪 日志 事件 审计" }
    ]
  },
  {
    id: "artifacts",
    label: "构件",
    desc: "接入外部能力与外来运行时",
    items: [
      { path: "plugins", title: "插件注册", icon: "◱", keywords: "plugin pact 插件 协议 注册 清单" },
      { path: "channels", title: "模型通道", icon: "⊡", keywords: "channel llm model provider 模型 通道 deepseek" },
      { path: "pae", title: "异构适配", icon: "❖", keywords: "pae adapter mcp openapi 异构 适配 外来 接驳" }
    ]
  },
  {
    id: "governance",
    label: "治理",
    desc: "证明隔离、复现执行、控制成本",
    items: [
      { path: "graph", title: "影响域图", icon: "✧", keywords: "graph isolation dependency 影响域 依赖 隔离 血缘" },
      { path: "replay", title: "回放台", icon: "↻", keywords: "replay deterministic 回放 重放 对账 digest" },
      { path: "routing", title: "成本路由", icon: "⌁", keywords: "routing cost budget 成本 路由 预算 token" }
    ]
  }
];

/** 扁平化索引，供路由查找与命令面板使用。 */
export const NAV_ITEMS = NAV_GROUPS.flatMap((g) =>
  g.items.map((i) => ({ ...i, group: g.id, groupLabel: g.label }))
);

export function navItemOf(path) {
  return NAV_ITEMS.find((i) => i.path === path) ?? null;
}

/** 全部导航路径（分组顺序即展示顺序）。 */
export const NAV_PATHS = NAV_ITEMS.map((i) => i.path);

/**
 * 导航里声明了、却没有渲染器的路径。
 *
 * 这条存在的理由是一次真实事故：`channels` 视图在路由表里，但导航没有
 * 对应按钮，整页不可达且没人发现。把"声明"和"可达"的对齐做成可断言的
 * 函数，这类漂移就会在测试里失败，而不是等用户点不到。
 */
export function missingRenderers(navPaths, availablePaths) {
  const available = new Set(availablePaths);
  return navPaths.filter((p) => !available.has(p));
}

/* ------------------------------------------------------------------ */
/* 命令面板 · 模糊匹配                                                  */
/* ------------------------------------------------------------------ */
/**
 * 子序列模糊匹配打分。返回 -1 表示不匹配，分数越大越靠前。
 *
 * 打分规则（刻意保守，宁可少匹配也不错配）：
 *   · 完整子串命中 → 高分，且越靠前越高（前缀命中再加权）
 *   · 否则退化为子序列匹配，连续字符额外加权
 *   · 词首（分隔符后）命中额外加权，让 "ro" 优先命中 "成本路由" 而非别的
 *
 * 中英文都按字符处理，因此无需分词即可工作。
 */
export function fuzzyScore(query, text) {
  const q = String(query ?? "").trim().toLowerCase();
  const t = String(text ?? "").toLowerCase();
  if (q === "") return 0;
  if (t === "") return -1;

  const direct = t.indexOf(q);
  if (direct !== -1) {
    return 1000 + (direct === 0 ? 500 : 0) - direct * 3;
  }

  let cursor = 0;
  let score = 0;
  let streak = 0;
  let firstAt = -1;
  for (const ch of q) {
    const at = t.indexOf(ch, cursor);
    if (at === -1) return -1;
    if (firstAt === -1) firstAt = at;
    if (at === cursor && cursor > 0) {
      streak += 1;
      score += 8 + streak * 4;
    } else {
      streak = 0;
      score += 4;
    }
    const prev = at > 0 ? t[at - 1] : "";
    if (at === 0 || /[\s\-_/.:]/.test(prev)) score += 6;
    cursor = at + 1;
  }
  return score + Math.max(0, 40 - firstAt);
}

/**
 * 在一个候选集里检索。候选项形如
 *   { id, title, subtitle?, group?, keywords? }
 * 返回按分数降序、同分按原序稳定的结果。
 */
export function searchCommands(query, items) {
  const scored = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const haystacks = [item.title, item.subtitle, item.group, item.keywords];
    let best = -1;
    for (const h of haystacks) {
      if (h === undefined || h === null || h === "") continue;
      const s = fuzzyScore(query, String(h));
      if (s > best) best = s;
    }
    if (best >= 0) scored.push({ item, score: best, order: i });
  }
  scored.sort((a, b) => (b.score - a.score) || (a.order - b.order));
  return scored.map((s) => s.item);
}

/* ------------------------------------------------------------------ */
/* 命令行参数解析                                                       */
/* ------------------------------------------------------------------ */
/**
 * 把一行命令参数文本切成参数数组，支持双引号 / 单引号包裹含空格的单个参数。
 *
 * 用于 MCP 服务器的 args 输入：用户填 `-y @modelcontextprotocol/server-x`
 * 或 `--dir "C:/Program Files/data"`，都需要正确切成数组再交给 stdio 传输层。
 * 放在这里是因为它纯粹且容易写错，值得被单测钉住。
 */
export function parseArgv(text) {
  const src = String(text ?? "").trim();
  if (src === "") return [];
  const out = [];
  /* The closing quote is optional on purpose: a user who types
     `--dir "C:/Program Files` forgot a character, and keeping a stray quote in
     the argument would silently produce a path that does not exist. Treating
     the remainder as one argument is the forgiving, still-predictable choice. */
  const re = /"([^"]*)"?|'([^']*)'?|(\S+)/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    out.push(m[1] ?? m[2] ?? m[3]);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 系统健康推导                                                         */
/* ------------------------------------------------------------------ */
/**
 * 把 /api/state 的原始快照推导成"现在能不能干活"的结论。
 *
 * 控制台不该只是把数字铺出来让用户自己判断——状态页的价值在于结论。
 * 这里只做推导不做渲染，因此可以被单测覆盖。
 */
export function deriveSystemHealth(state) {
  const issues = [];
  const push = (id, level, text, detail) => issues.push({ id, level, text, detail });

  if (!state || !state.running) {
    push("host-down", "err", "主机未运行", "所有能力面均不可用，先启动主机。");
  }

  const channels = state?.channels ?? [];
  if (state?.running && channels.length === 0) {
    push("no-channel", "err", "没有可用通道", "Agent 无法调用任何外部能力。");
  }

  const plugins = state?.plugins ?? [];
  if (state?.running && plugins.length === 0) {
    push("no-plugin", "warn", "尚未注册插件", "能力契约层空闲，可注册一个插件观察四重校验。");
  }

  const sandboxes = state?.sandboxes ?? [];
  if (state?.running && sandboxes.length === 0) {
    push("no-box", "warn", "没有活跃沙箱", "去沙箱对话页创建 Agent 并跑一轮。");
  }

  const pae = state?.pae;
  if (state?.running && pae && !pae.enabled) {
    push("no-adapter", "warn", "未接入外来运行时", "异构适配页可接入 MCP 服务器或 JS 工具集。");
  }

  if (state?.running && (state?.traceCount ?? 0) === 0) {
    push("no-trace", "warn", "尚无追踪事件", "跑一轮沙箱对话即可产生可审计的事件流。");
  }

  const level = issues.some((i) => i.level === "err")
    ? "err"
    : issues.some((i) => i.level === "warn")
      ? "warn"
      : "ok";

  return { level, healthy: level === "ok", issues };
}

/* ------------------------------------------------------------------ */
/* 下一步建议                                                           */
/* ------------------------------------------------------------------ */
/**
 * 基于当前状态推导"接下来该做什么"。
 *
 * 顺序即优先级：先让它能跑，再让它有东西可跑，最后才谈治理。
 * 每条都带 route，因此可以直接点进去执行——建议不是说明文字，是入口。
 */
export function suggestNextSteps(state, limit = 4) {
  const steps = [];
  const running = Boolean(state?.running);

  if (!running) {
    steps.push({
      id: "boot",
      title: "启动主机",
      desc: "自底向上装配通道 → 契约 → 熔断 → 沙箱 → 主机。",
      route: "overview",
      action: "boot",
      primary: true
    });
    return steps.slice(0, limit);
  }

  if ((state?.sandboxes ?? []).length === 0) {
    steps.push({
      id: "create-box",
      title: "创建 Agent 沙箱并跑一轮",
      desc: "观察循环预算、独立 trace ID 与通道化模型调用。",
      route: "boxes",
      primary: true
    });
  }

  if ((state?.plugins ?? []).length === 0) {
    steps.push({
      id: "register-plugin",
      title: "注册第一个插件",
      desc: "字段 / 版本 / 能力三重校验，未声明能力一律拒绝。",
      route: "plugins",
      primary: true
    });
  }

  const pae = state?.pae;
  if (pae && !pae.enabled) {
    steps.push({
      id: "connect-adapter",
      title: "接入一个外来运行时",
      desc: "MCP 服务器或 JS 工具集，经网关接驳为能力通道。",
      route: "pae",
      primary: true
    });
  }

  if ((state?.traceCount ?? 0) > 0) {
    steps.push({
      id: "replay",
      title: "录制并回放一次运行",
      desc: "零模型调用重放，字节级一致 + digest 链对账。",
      route: "replay",
      primary: false
    });
  }

  steps.push({
    id: "inspect-graph",
    title: "查看影响域图",
    desc: "点击节点，故障沿血缘反向扩散至全部受影响后代。",
    route: "graph",
    primary: false
  });

  return steps.slice(0, limit);
}
