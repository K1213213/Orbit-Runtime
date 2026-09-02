/**
 * Orbit Console · REST API 客户端
 * 所有请求都指向同源 bridge server（/api/*）。
 * 会话令牌存 localStorage；401 时由 app.js 引导回登录页。
 */

const BASE = "";
const TOKEN_KEY = "orbit.session";

export function getToken() {
  try { return localStorage.getItem(TOKEN_KEY) ?? sessionStorage.getItem(TOKEN_KEY); } catch { return null; }
}
/**
 * 写入会话令牌。persist=true（默认，勾选"记住我"）存 localStorage，
 * 关闭浏览器后仍保留；persist=false 仅存 sessionStorage，关闭标签页即失效。
 */
export function setToken(token, persist = true) {
  try {
    if (token) {
      const store = persist ? localStorage : sessionStorage;
      const other = persist ? sessionStorage : localStorage;
      store.setItem(TOKEN_KEY, token);
      other.removeItem(TOKEN_KEY);
    } else {
      localStorage.removeItem(TOKEN_KEY);
      sessionStorage.removeItem(TOKEN_KEY);
    }
  } catch { /* 隐私模式下静默降级为内存会话 */ }
}

async function request(method, path, body) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const token = getToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON fallthrough */
  }
  if (res.status === 401) {
    const err = new Error(json?.error ?? "未登录或会话已过期");
    err.status = 401;
    throw err;
  }
  if (!res.ok || !json || json.ok !== true) {
    const msg = json?.error ?? `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return json.data;
}

function qs(params) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

export const api = {
  /* ---- 认证 ---- */
  login: (account, password) => request("POST", "/api/auth/login", { account, password }),
  register: (payload) => request("POST", "/api/auth/register", payload),
  me: () => request("GET", "/api/auth/me"),
  logout: () => request("POST", "/api/auth/logout"),
  changePassword: (oldPassword, newPassword) => request("POST", "/api/auth/password", { oldPassword, newPassword }),

  health: () => request("GET", "/api/health"),
  state: () => request("GET", "/api/state"),
  boot: () => request("POST", "/api/host/boot"),
  shutdown: () => request("POST", "/api/host/shutdown"),

  channels: () => request("GET", "/api/channels"),
  registerPluginChannel: (kind) => request("POST", "/api/channels/plugin", { kind }),
  removePluginChannel: (kind) => request("POST", "/api/channels/plugin/remove", { kind }),
  registerDeepSeek: (apiKey, model, temperature, baseUrl) => request("POST", "/api/channels/deepseek", { apiKey, model, temperature, baseUrl }),
  removeDeepSeek: () => request("POST", "/api/channels/deepseek/remove"),

  plugins: () => request("GET", "/api/plugins"),
  registerPlugin: (pact) => request("POST", "/api/plugins", { pact }),
  resetPlugins: () => request("DELETE", "/api/plugins"),

  boxes: () => request("GET", "/api/boxes"),
  spawnBox: (config) => request("POST", "/api/boxes", { config }),
  runBox: (boxId, input) => request("POST", `/api/boxes/${encodeURIComponent(boxId)}/run`, { input }),
  resetBox: (boxId) => request("POST", `/api/boxes/${encodeURIComponent(boxId)}/reset`),
  removeBox: (boxId) => request("DELETE", `/api/boxes/${encodeURIComponent(boxId)}`),

  trace: (params = {}) => request("GET", `/api/trace${qs(params)}`),
  replayDemo: () => request("POST", "/api/replay/demo"),

  graph: () => request("GET", "/api/graph"),
  isolation: (node) => request("GET", `/api/graph/isolation${qs({ node })}`),
  checkIsolation: (a, b) => request("POST", "/api/graph/check", { a, b }),

  routingProfiles: () => request("GET", "/api/routing/profiles"),
  simulateRoute: (budget, maxLatencyMs) => request("POST", "/api/routing/simulate", { budget, maxLatencyMs }),

  /* ---- PAE · Plugin Adaptation Engine (W15) ---- */

  pae: () => request("GET", "/api/pae"),
  registerPae: (payload) => request("POST", "/api/pae", payload),
  invokePae: (toolName, args) => request("POST", "/api/pae/invoke", { toolName, args }),
  negotiatePae: (toolName, minFidelity) => request("POST", "/api/pae/negotiate", { toolName, minFidelity }),
  removePae: (adapterId) => request("DELETE", `/api/pae/${encodeURIComponent(adapterId)}`),

  /* ---- 任务中心 ---- */
  tasks: (params = {}) => request("GET", `/api/tasks${qs(params)}`),
  task: (id) => request("GET", `/api/tasks/${encodeURIComponent(id)}`),
  abortTask: (id) => request("POST", `/api/tasks/${encodeURIComponent(id)}/abort`),

  /* ---- 模板 ---- */
  templates: () => request("GET", "/api/templates"),
  saveTemplate: (payload) => request("POST", "/api/templates", payload),
  templateVersions: (id) => request("GET", `/api/templates/${encodeURIComponent(id)}/versions`),
  rollbackTemplate: (id, version) => request("POST", `/api/templates/${encodeURIComponent(id)}/rollback`, { version }),
  removeTemplate: (id) => request("DELETE", `/api/templates/${encodeURIComponent(id)}`),

  /* ---- 知识库 ---- */
  kbList: () => request("GET", "/api/kb"),
  kbCreate: (payload) => request("POST", "/api/kb", payload),
  kbDetail: (id) => request("GET", `/api/kb/${encodeURIComponent(id)}`),
  kbRemove: (id) => request("DELETE", `/api/kb/${encodeURIComponent(id)}`),
  kbUpload: (id, payload) => request("POST", `/api/kb/${encodeURIComponent(id)}/docs`, payload),
  kbDoc: (kbId, docId) => request("GET", `/api/kb/${encodeURIComponent(kbId)}/docs/${encodeURIComponent(docId)}`),
  kbSearch: (id, query, k) => request("POST", `/api/kb/${encodeURIComponent(id)}/search`, { query, k }),

  /* ---- RAG 推演 ---- */
  ragRuns: (kbId) => request("GET", `/api/rag${qs({ kb: kbId })}`),
  ragRun: (payload) => request("POST", "/api/rag", payload),
  ragDetail: (id) => request("GET", `/api/rag/${encodeURIComponent(id)}`),

  /* ---- 工作流 ---- */
  workflows: () => request("GET", "/api/workflows"),
  workflowSave: (payload) => request("POST", "/api/workflows", payload),
  workflowGet: (id) => request("GET", `/api/workflows/${encodeURIComponent(id)}`),
  workflowRemove: (id) => request("DELETE", `/api/workflows/${encodeURIComponent(id)}`),
  workflowRun: (id, payload) => request("POST", `/api/workflows/${encodeURIComponent(id)}/run`, payload),
  workflowRunDetail: (runId) => request("GET", `/api/workflow-runs/${encodeURIComponent(runId)}`),

  /* ---- 账单 / 审计 / 通知 ---- */
  billing: () => request("GET", "/api/billing"),
  audit: (params = {}) => request("GET", `/api/audit${qs(params)}`),
  auditExport: (format, params = {}) => request("GET", `/api/audit/export${qs({ format, ...params })}`),
  auditChain: () => request("GET", "/api/audit/chain"),
  replayTimeline: () => request("GET", "/api/replay/timeline"),
  replayFork: (body) => request("POST", "/api/replay/fork", body),
  complianceReport: () => request("GET", "/api/compliance"),
  complianceExport: (format) => request("GET", `/api/compliance/export${qs({ format })}`),
  compliancePublicKey: () => request("GET", "/api/compliance/public-key"),
  notifications: () => request("GET", "/api/notifications"),
  notificationsRead: (ids) => request("POST", "/api/notifications/read", { ids }),

  /* ---- 大盘 ---- */
  dashboard: () => request("GET", "/api/dashboard")
};
