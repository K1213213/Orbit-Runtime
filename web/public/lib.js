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
