/**
 * Orbit Console · REST API 客户端
 * 所有请求都指向同源 bridge server（/api/*）。
 */

const BASE = "";

async function request(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON fallthrough */
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
  health: () => request("GET", "/api/health"),
  state: () => request("GET", "/api/state"),
  boot: () => request("POST", "/api/host/boot"),
  shutdown: () => request("POST", "/api/host/shutdown"),

  channels: () => request("GET", "/api/channels"),
  registerPluginChannel: (kind) => request("POST", "/api/channels/plugin", { kind }),
  removePluginChannel: (kind) => request("POST", "/api/channels/plugin/remove", { kind }),

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
  simulateRoute: (budget, maxLatencyMs) => request("POST", "/api/routing/simulate", { budget, maxLatencyMs })
};
