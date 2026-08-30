/**
 * Orbit Console · 应用外壳
 *
 * 职责：数据驱动的分组导航、hash 路由、命令面板（Cmd+K）、主机状态轮询，
 * 以及视图共用的 DOM 助手。
 *
 * 导航由 `lib.js` 的 NAV_GROUPS 生成，而不是在 HTML 里手抄按钮——历史上
 * 出现过路由存在却无入口、整页不可达的事故，数据驱动让"声明"与"可达"
 * 不可能再分家。
 */
import { api } from "./api.js";
import {
  NAV_GROUPS,
  NAV_ITEMS,
  NAV_PATHS,
  missingRenderers,
  searchCommands
} from "./lib.js";
import { esc } from "./lib.js";

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
/* 视图注册表 → 路由表                                                  */
/* ------------------------------------------------------------------ */

const VIEW_RENDERERS = {
  overview: renderOverview,
  boxes: renderBoxes,
  trace: renderTrace,
  plugins: renderPlugins,
  channels: renderChannels,
  pae: renderPae,
  graph: renderGraph,
  replay: renderReplay,
  routing: renderRouting
};

/*
 * Fail loudly rather than shipping an unreachable page. The palette and the
 * sidebar are both generated from this data, so a missing renderer is the only
 * remaining way for a declared view to be unreachable.
 */
const UNRENDERABLE = missingRenderers(NAV_PATHS, Object.keys(VIEW_RENDERERS));

const routes = NAV_ITEMS.filter((i) => VIEW_RENDERERS[i.path]).map((i) => ({
  path: i.path,
  title: i.title,
  icon: i.icon,
  group: i.group,
  groupLabel: i.groupLabel,
  render: VIEW_RENDERERS[i.path]
}));

/* ------------------------------------------------------------------ */
/* DOM 助手                                                            */
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

export function loading(text = "加载中…") {
  return el("div", "loading", `<span class="spinner"></span>${esc(text)}`);
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

export function toast(message, tone = "accent", duration = 3200) {
  const root = document.getElementById("toast-root");
  if (!root) return;
  const t = el("div", `toast ${tone}`, esc(message));
  root.append(t);
  setTimeout(() => t.remove(), duration);
}

/* 纯函数工具集中在 lib.js，这里统一再导出，视图无需改动 import 来源。 */
export * from "./lib.js";

/* ------------------------------------------------------------------ */
/* 侧边导航（由 NAV_GROUPS 生成）                                        */
/* ------------------------------------------------------------------ */

const navEl = document.getElementById("nav");

function buildNav() {
  if (!navEl) return;
  navEl.replaceChildren();
  for (const group of NAV_GROUPS) {
    const items = group.items.filter((i) => VIEW_RENDERERS[i.path]);
    if (items.length === 0) continue;
    navEl.append(el("div", "nav-group-label", esc(group.label)));
    for (const item of items) {
      const btn = el("button", "nav-item", `
        <span class="nav-ico">${esc(item.icon)}</span>
        <span class="nav-label">${esc(item.title)}</span>`);
      btn.dataset.route = item.path;
      btn.title = group.desc;
      navEl.append(btn);
    }
  }
}

/* ------------------------------------------------------------------ */
/* 路由                                                                 */
/* ------------------------------------------------------------------ */

const viewEl = document.getElementById("view");
const titleEl = document.getElementById("page-title");

let currentView = null;
let currentRoute = null;

function currentPath() {
  const m = location.hash.match(/#!?\/([a-z]+)/);
  return m ? m[1] : "overview";
}

function markActive(path) {
  if (!navEl) return;
  for (const item of navEl.querySelectorAll(".nav-item")) {
    item.classList.toggle("active", item.dataset.route === path);
  }
}

/*
 * Navigation must be serialized. Two navigations can overlap in real life:
 * boot() sets location.hash (which fires an async hashchange -> navigate)
 * and then awaits navigate() itself. Without the chain, the second call's
 * replaceChildren() lands while the first render() is still suspended at an
 * await; when the first render resumes it appends on top, leaving the page
 * with two copies of every card. Chaining forces each render to finish
 * before the next one clears and redraws the container.
 */
let navChain = Promise.resolve();
function navigate() {
  const run = navChain.then(doNavigate, doNavigate);
  navChain = run.then(() => {}, () => {});
  return run;
}

async function doNavigate() {
  const path = currentPath();
  const route = routes.find((r) => r.path === path) ?? routes[0];
  currentRoute = route;
  markActive(route.path);
  if (titleEl) titleEl.textContent = route.title;

  if (currentView && currentView.dispose) {
    try { currentView.dispose(); } catch { /* a failing teardown must not block navigation */ }
  }
  currentView = null;

  const loadingNode = loading();
  viewEl.replaceChildren(loadingNode);
  try {
    currentView = await route.render(viewEl);
  } catch (err) {
    console.error("render failed", err);
    viewEl.replaceChildren(
      el("div", "alert err", `<span>✕</span><span class="msg">视图渲染失败：${esc(err.message ?? String(err))}</span>`)
    );
  } finally {
    /*
     * Drop the placeholder unconditionally. Views *append* to the container
     * rather than clearing it, so without this the spinner stays parked above
     * the rendered page for the rest of the session. It must be a `finally`:
     * a view that throws leaves the placeholder behind too, and that is
     * precisely when a stuck spinner is most confusing.
     */
    loadingNode.remove();
  }
  if (currentView && currentView.afterMount) currentView.afterMount();
}

async function refreshCurrentView() {
  if (currentView && currentView.refresh) {
    viewEl.replaceChildren();
    try {
      currentView = await currentView.refresh(viewEl);
    } catch (err) {
      toast(`刷新失败：${err.message}`, "err");
    }
  } else {
    await navigate();
  }
}

function go(path) {
  if (!routes.some((r) => r.path === path)) return;
  location.hash = `#/${path}`;
}

if (navEl) {
  navEl.addEventListener("click", (e) => {
    const item = e.target.closest(".nav-item");
    if (item) go(item.dataset.route);
  });
}

window.addEventListener("hashchange", navigate);

/* ------------------------------------------------------------------ */
/* 主机动作                                                             */
/* ------------------------------------------------------------------ */

async function hostBoot() {
  await api.boot();
  toast("主机已启动（自底向上装配完成）", "ok");
  await refreshAll();
}

async function hostShutdown() {
  await api.shutdown();
  toast("主机已关闭（严格反序释放）", "warn");
  await refreshAll();
}

async function hostRestart() {
  const health = await api.health().catch(() => ({ running: false }));
  if (health.running) await api.shutdown();
  await api.boot();
  toast("主机已重启（内核反序关闭后重新装配）", "ok");
  await refreshAll();
}

async function refreshAll() {
  await pollHost();
  await refreshCurrentView();
}

/* ------------------------------------------------------------------ */
/* 命令面板                                                             */
/* ------------------------------------------------------------------ */

const paletteEl = document.getElementById("palette");
const paletteInputEl = document.getElementById("palette-input");
const paletteListEl = document.getElementById("palette-list");

const ACTIONS = [
  {
    id: "act-boot",
    title: "启动主机",
    subtitle: "自底向上装配内核",
    group: "动作",
    keywords: "boot start 启动 主机 运行",
    run: () => hostBoot()
  },
  {
    id: "act-shutdown",
    title: "停止主机",
    subtitle: "严格反序释放资源",
    group: "动作",
    keywords: "shutdown stop 停止 关闭 主机",
    run: () => hostShutdown()
  },
  {
    id: "act-restart",
    title: "重启主机",
    subtitle: "反序关闭后重新装配",
    group: "动作",
    keywords: "restart reboot 重启 主机",
    run: () => hostRestart()
  },
  {
    id: "act-refresh",
    title: "刷新当前视图",
    subtitle: "重新拉取内核状态",
    group: "动作",
    keywords: "refresh reload 刷新 重载",
    run: () => refreshCurrentView()
  }
];

const PALETTE_ITEMS = [
  ...NAV_ITEMS.map((i) => ({
    id: `nav-${i.path}`,
    title: i.title,
    /*
     * No subtitle: the group is already shown in its own column, and repeating
     * it turned every row into "回放台 治理 … 治理". A subtitle earns its place
     * only when it adds something the title and group do not.
     */
    group: i.groupLabel,
    keywords: i.keywords,
    icon: i.icon,
    run: () => go(i.path)
  })),
  ...ACTIONS
];

let paletteOpen = false;
let paletteResults = [];
let paletteIndex = 0;

function openPalette() {
  if (!paletteEl) return;
  paletteOpen = true;
  paletteEl.classList.add("open");
  paletteInputEl.value = "";
  renderPalette("");
  paletteInputEl.focus();
}

function closePalette() {
  if (!paletteEl) return;
  paletteOpen = false;
  paletteEl.classList.remove("open");
  paletteInputEl.blur();
}

function renderPalette(query) {
  paletteResults = searchCommands(query, PALETTE_ITEMS);
  if (paletteIndex >= paletteResults.length) paletteIndex = 0;
  paletteListEl.replaceChildren();

  if (paletteResults.length === 0) {
    paletteListEl.append(el("div", "palette-empty", "没有匹配的视图或动作"));
    return;
  }

  paletteResults.forEach((item, i) => {
    const row = el("button", "palette-item" + (i === paletteIndex ? " sel" : ""), `
      <span class="pi-ico">${esc(item.icon ?? "⌘")}</span>
      <span class="pi-main">
        <span class="pi-title">${esc(item.title)}</span>
        <span class="pi-sub">${esc(item.subtitle ?? "")}</span>
      </span>
      <span class="pi-group">${esc(item.group ?? "")}</span>`);
    row.type = "button";
    row.addEventListener("click", () => runPaletteItem(i));
    row.addEventListener("mousemove", () => {
      if (paletteIndex === i) return;
      paletteIndex = i;
      updatePaletteSelection();
    });
    paletteListEl.append(row);
  });
}

function updatePaletteSelection() {
  const rows = paletteListEl.querySelectorAll(".palette-item");
  rows.forEach((r, i) => r.classList.toggle("sel", i === paletteIndex));
  const sel = rows[paletteIndex];
  if (sel) sel.scrollIntoView({ block: "nearest" });
}

function runPaletteItem(index) {
  const item = paletteResults[index];
  if (!item) return;
  closePalette();
  Promise.resolve(item.run()).catch((err) => toast(`执行失败：${err.message}`, "err"));
}

if (paletteEl) {
  paletteInputEl.addEventListener("input", () => {
    paletteIndex = 0;
    renderPalette(paletteInputEl.value);
  });

  paletteInputEl.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (paletteResults.length === 0) return;
      paletteIndex = (paletteIndex + 1) % paletteResults.length;
      updatePaletteSelection();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (paletteResults.length === 0) return;
      paletteIndex = (paletteIndex - 1 + paletteResults.length) % paletteResults.length;
      updatePaletteSelection();
    } else if (e.key === "Enter") {
      e.preventDefault();
      runPaletteItem(paletteIndex);
    } else if (e.key === "Escape") {
      e.preventDefault();
      closePalette();
    }
  });

  paletteEl.addEventListener("click", (e) => {
    if (e.target === paletteEl) closePalette();
  });
}

/* 全局键盘：Cmd/Ctrl+K 唤起面板，Esc 关闭 */
window.addEventListener("keydown", (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? "");

  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    if (paletteOpen) closePalette();
    else openPalette();
    return;
  }
  if (e.key === "Escape" && paletteOpen) {
    e.preventDefault();
    closePalette();
    return;
  }
  /* 斜杠快速唤起：仅在未输入时生效，避免抢走文本输入 */
  if (e.key === "/" && !typing && !paletteOpen) {
    e.preventDefault();
    openPalette();
  }
});

const paletteBtn = document.getElementById("btn-palette");
if (paletteBtn) paletteBtn.addEventListener("click", openPalette);

/* ------------------------------------------------------------------ */
/* 主机状态轮询                                                         */
/* ------------------------------------------------------------------ */

const pillEl = document.getElementById("host-pill");
const pillTextEl = document.getElementById("host-pill-text");
const pillDotEl = document.getElementById("host-dot");
const portHintEl = document.getElementById("port-hint");

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
  } catch {
    pillEl.classList.add("error");
    pillEl.classList.remove("running", "stopped");
    pillTextEl.textContent = "桥接服务不可达";
    portHintEl.textContent = "";
  }
}

const restartBtn = document.getElementById("btn-restart");
if (restartBtn) {
  restartBtn.addEventListener("click", async () => {
    restartBtn.disabled = true;
    restartBtn.innerHTML = `<span class="ico">⟳</span> 重启中…`;
    try {
      await hostRestart();
    } catch (err) {
      toast(`重启失败：${err.message}`, "err");
    } finally {
      restartBtn.disabled = false;
      restartBtn.innerHTML = `<span class="ico">⟳</span> 重启主机`;
    }
  });
}

/* ------------------------------------------------------------------ */
/* 启动                                                                 */
/* ------------------------------------------------------------------ */

(async function boot() {
  buildNav();

  if (UNRENDERABLE.length > 0) {
    console.error("[orbit] 导航声明了但没有渲染器：", UNRENDERABLE.join(", "));
    toast(`导航项缺失渲染器：${UNRENDERABLE.join(", ")}`, "err", 8000);
  }

  if (!location.hash) location.hash = "#/overview";
  await pollHost();
  await navigate();
  setInterval(pollHost, 6000);
})();
