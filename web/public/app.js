/**
 * Orbit Console · 应用入口
 * hash 路由 + 布局 + 通用 UI 组件 + 主机状态轮询。
 */
import { api } from "./api.js";
import { renderOverview } from "./views/overview.js";
import { renderChannels } from "./views/channels.js";
import { renderPlugins } from "./views/plugins.js";
import { renderBoxes } from "./views/boxes.js";
import { renderTrace } from "./views/trace.js";
import { renderReplay } from "./views/replay.js";
import { renderGraph } from "./views/graph.js";
import { renderRouting } from "./views/routing.js";
import { renderPae } from "./views/pae.js";

/* ------------------------------------------------------------------ */
/* 路由表                                                              */
/* ------------------------------------------------------------------ */

const routes = [
  { path: "overview", title: "总览", render: renderOverview },
  { path: "channels", title: "模型通道", render: renderChannels },
  { path: "plugins", title: "插件注册", render: renderPlugins },
  { path: "boxes", title: "沙箱对话", render: renderBoxes },
  { path: "trace", title: "追踪日志", render: renderTrace },
  { path: "replay", title: "回放台", render: renderReplay },
  { path: "graph", title: "影响域图", render: renderGraph },
  { path: "routing", title: "成本路由", render: renderRouting },
  { path: "pae", title: "异构适配", render: renderPae }
];

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

export function el(tag, cls, html) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (html !== undefined && html !== null) {
    if (typeof html === "string" || typeof html === "number") node.innerHTML = String(html);
    else if (Array.isArray(html)) node.append(...html);
    else node.append(html);
  }
  return node;
}

// 纯函数工具（esc / fmtTime / fmtDate / shortId / badge / PAE 目录）集中在
// lib.js，便于 Node 单测；这里统一再导出，视图无需改动 import 来源。
import { esc } from "./lib.js";
export * from "./lib.js";

export function loading() {
  const d = el("div", "loading", `<span class="spinner"></span>加载中…`);
  return d;
}

export function empty(text, big = "◌") {
  return el("div", "empty", `<span class="big">${big}</span>${esc(text)}`);
}

export function card(head, body) {
  const c = el("div", "card");
  if (head) {
    const h = el("div", "card-head");
    if (typeof head === "string") h.innerHTML = head;
    else h.append(head);
    c.append(h);
  }
  c.append(body);
  return c;
}

/* ------------------------------------------------------------------ */
/* Toast                                                               */
/* ------------------------------------------------------------------ */

export function toast(message, tone = "accent", duration = 3200) {
  const root = document.getElementById("toast-root");
  const t = el("div", `toast ${tone}`, esc(message));
  root.append(t);
  setTimeout(() => t.remove(), duration);
}

/* ------------------------------------------------------------------ */
/* 路由与状态轮询                                                       */
/* ------------------------------------------------------------------ */

const viewEl = document.getElementById("view");
const titleEl = document.getElementById("page-title");
const navEl = document.getElementById("nav");
const pillEl = document.getElementById("host-pill");
const pillTextEl = document.getElementById("host-pill-text");
const pillDotEl = document.getElementById("host-dot");
const portHintEl = document.getElementById("port-hint");

let currentView = null;

function currentPath() {
  const m = location.hash.match(/#!?\/([a-z]+)/);
  return m ? m[1] : "overview";
}

async function navigate() {
  const path = currentPath();
  const route = routes.find((r) => r.path === path) ?? routes[0];
  for (const item of navEl.querySelectorAll(".nav-item")) {
    item.classList.toggle("active", item.dataset.route === route.path);
  }
  titleEl.textContent = route.title;
  if (currentView && currentView.dispose) {
    try { currentView.dispose(); } catch { /* ignore */ }
  }
  viewEl.innerHTML = "";
  const loadingNode = el("div", "loading", `<span class="spinner"></span>加载中…`);
  viewEl.append(loadingNode);
  try {
    currentView = await route.render(viewEl);
  } catch (err) {
    console.error("render failed", err);
    viewEl.replaceChildren(el("div", "alert err", `<span>✕</span><span class="msg">视图渲染失败：${esc(err.message ?? String(err))}</span>`));
  } finally {
    loadingNode.remove();
  }
  if (currentView && currentView.afterMount) currentView.afterMount();
}

window.addEventListener("hashchange", navigate);

navEl.addEventListener("click", (e) => {
  const item = e.target.closest(".nav-item");
  if (!item) return;
  location.hash = `#/${item.dataset.route}`;
});

/* 主机状态轮询 */
let hostOk = false;

async function pollHost() {
  try {
    const s = await api.health();
    hostOk = s.running;
    pillEl.classList.toggle("running", s.running);
    pillEl.classList.toggle("stopped", !s.running);
    pillEl.classList.remove("error");
    pillTextEl.textContent = s.running ? "主机运行中" : "主机已停止";
    portHintEl.textContent = `${location.host} · v${s.version}`;
  } catch (err) {
    pillEl.classList.add("error");
    pillEl.classList.remove("running", "stopped");
    pillTextEl.textContent = "桥接服务不可达";
    portHintEl.textContent = String(err.message).slice(0, 40);
  }
}

document.getElementById("btn-restart").addEventListener("click", async () => {
  const btn = document.getElementById("btn-restart");
  btn.disabled = true;
  btn.innerHTML = `<span class="ico">⟳</span> 重启中…`;
  try {
    if (hostOk) await api.shutdown();
    await api.boot();
    toast("主机已重启（内核反序关闭后重新装配）", "ok");
    if (currentView && currentView.refresh) {
      viewEl.innerHTML = "";
      currentView = await currentView.refresh(viewEl);
    } else {
      await navigate();
    }
  } catch (err) {
    toast(`重启失败：${err.message}`, "err");
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<span class="ico">⟳</span> 重启主机`;
  }
});

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */

(async function boot() {
  if (!location.hash) location.hash = "#/overview";
  await pollHost();
  await navigate();
  setInterval(pollHost, 6000);
})();
