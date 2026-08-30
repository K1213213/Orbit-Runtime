/**
 * Orbit Console · 应用外壳
 *
 * 职责：认证门禁（未登录渲染登录页，登录后装配控制台）、数据驱动的
 * 分组导航、hash 路由、命令面板（Cmd+K）、主机状态轮询、通知中心、
 * 全局动效开关，以及视图共用的 DOM 助手。
 *
 * 导航由 `lib.js` 的 NAV_GROUPS 生成，而不是在 HTML 里手抄按钮——历史上
 * 出现过路由存在却无入口、整页不可达的事故，数据驱动让"声明"与"可达"
 * 不可能再分家。
 */
import { api, getToken, setToken } from "./api.js";
import {
  NAV_GROUPS,
  NAV_ITEMS,
  NAV_PATHS,
  missingRenderers,
  searchCommands,
  ROLE_LABEL
} from "./lib.js";
import { esc } from "./lib.js";

import { renderLogin } from "./views/login.js";
import { renderDashboard } from "./views/dashboard.js";
import { renderInstances } from "./views/instances.js";
import { renderTasks } from "./views/tasks.js";
import { renderWorkflow } from "./views/workflow.js";
import { renderKnowledge } from "./views/knowledge.js";
import { renderRag } from "./views/rag.js";
import { renderTemplates } from "./views/templates.js";
import { renderMarket } from "./views/market.js";
import { renderChannels } from "./views/channels.js";
import { renderPae } from "./views/pae.js";
import { renderAudit } from "./views/audit.js";
import { renderBilling } from "./views/billing.js";
import { renderRouting } from "./views/routing.js";
import { renderReplay } from "./views/replay.js";
import { renderGraph } from "./views/graph.js";
import { renderSettings } from "./views/settings.js";
import { renderProfile } from "./views/profile.js";

/* ------------------------------------------------------------------ */
/* 视图注册表 → 路由表                                                  */
/* ------------------------------------------------------------------ */

const VIEW_RENDERERS = {
  overview: renderDashboard,
  boxes: renderInstances,
  tasks: renderTasks,
  workflow: renderWorkflow,
  knowledge: renderKnowledge,
  rag: renderRag,
  templates: renderTemplates,
  plugins: renderMarket,
  channels: renderChannels,
  pae: renderPae,
  trace: renderAudit,
  billing: renderBilling,
  routing: renderRouting,
  replay: renderReplay,
  graph: renderGraph,
  settings: renderSettings,
  profile: renderProfile
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

/** 骨架屏：与真实卡片同构的占位，加载态不再是裸转圈。 */
export function skeleton(rows = 1) {
  const sk = el("div", "skeleton");
  for (let i = 0; i < rows; i++) {
    const row = el("div", "sk-row");
    for (let j = 0; j < 4; j++) row.append(el("div", "sk-block sk-shimmer"));
    sk.append(row);
    sk.append(el("div", "sk-line sk-shimmer"), el("div", "sk-line sk-shimmer"));
  }
  return sk;
}

export function empty(text, big = "◌", hint = "") {
  const node = el("div", "empty", `<span class="big">${esc(big)}</span><span>${esc(text)}</span>`);
  if (hint) node.append(el("span", "hint", esc(hint)));
  return node;
}

export function card(head, body) {
  const c = el("div", "card");
  if (head) {
    const h = el("div", "card-head");
    if (typeof head === "string") h.innerHTML = head;
    else h.append(head);
    c.append(h);
  }
  if (body) c.append(el("div", "card-body", body));
  else c.append(el("div", "card-body"));
  return c;
}

export function toast(message, tone = "accent", duration = 3200) {
  const root = document.getElementById("toast-root");
  if (!root) return;
  const t = el("div", `toast ${tone}`, esc(message));
  root.append(t);
  setTimeout(() => t.remove(), duration);
}

/** 右侧抽屉（平板/手机自动转为底部抽屉，CSS 已处理）。返回 close()。 */
export function drawer(title, bodyContent, footContent) {
  const mask = el("div", "drawer-mask");
  const dr = el("div", "drawer");
  const head = el("div", "drawer-head", `<h3>${esc(title)}</h3>`);
  const closeBtn = el("button", "icon-btn", "✕");
  closeBtn.type = "button";
  closeBtn.addEventListener("click", () => close());
  head.append(closeBtn);
  const body = el("div", "drawer-body");
  if (typeof bodyContent === "string") body.innerHTML = bodyContent;
  else if (bodyContent) body.append(bodyContent);
  dr.append(head, body);
  if (footContent) {
    const foot = el("div", "drawer-foot");
    if (typeof footContent === "string") foot.innerHTML = footContent;
    else foot.append(footContent);
    dr.append(foot);
  }
  mask.append(dr);
  document.body.append(mask, dr);
  function close() {
    mask.remove();
    dr.remove();
  }
  mask.addEventListener("click", () => close());
  return { close, body, el: dr };
}

/** 居中模态。返回 { close, body, foot }。 */
export function modal(title, bodyContent, footContent) {
  const mask = el("div", "modal-mask");
  const m = el("div", "modal");
  const head = el("div", "modal-head", `<h3>${esc(title)}</h3>`);
  const closeBtn = el("button", "icon-btn", "✕");
  closeBtn.type = "button";
  closeBtn.addEventListener("click", () => close());
  head.append(closeBtn);
  const body = el("div", "modal-body");
  if (typeof bodyContent === "string") body.innerHTML = bodyContent;
  else if (bodyContent) body.append(bodyContent);
  m.append(head, body);
  let foot = null;
  if (footContent) {
    foot = el("div", "modal-foot");
    if (typeof footContent === "string") foot.innerHTML = footContent;
    else foot.append(footContent);
    m.append(foot);
  }
  mask.append(m);
  document.body.append(mask);
  function close() { mask.remove(); }
  mask.addEventListener("click", (e) => { if (e.target === mask) close(); });
  return { close, body, foot, el: m };
}

/** 确认对话框（替代原生 confirm，风格一致）。 */
export function confirmDialog(title, message, confirmText = "确认") {
  return new Promise((resolve) => {
    const foot = el("div", "row");
    const cancel = el("button", "btn", "取消");
    const ok = el("button", "btn danger", esc(confirmText));
    const m = modal(title, el("p", "", esc(message)), foot);
    cancel.type = "button";
    ok.type = "button";
    cancel.addEventListener("click", () => { m.close(); resolve(false); });
    ok.addEventListener("click", () => { m.close(); resolve(true); });
    foot.append(cancel, ok);
    ok.focus();
  });
}

/* 纯函数工具集中在 lib.js，这里统一再导出，视图无需改动 import 来源。 */
export * from "./lib.js";

/* ------------------------------------------------------------------ */
/* 全局动效开关                                                         */
/* ------------------------------------------------------------------ */

const MOTION_KEY = "orbit.motion";
export function motionEnabled() {
  try { return localStorage.getItem(MOTION_KEY) !== "off"; } catch { return true; }
}
export function setMotion(on) {
  try { localStorage.setItem(MOTION_KEY, on ? "on" : "off"); } catch { /* ignore */ }
  document.documentElement.dataset.motion = on ? "on" : "off";
}
setMotion(motionEnabled());

/* ------------------------------------------------------------------ */
/* 认证状态                                                             */
/* ------------------------------------------------------------------ */

let currentUser = null;
export function currentUserInfo() { return currentUser; }

const authRoot = document.getElementById("auth-root");
const shellEl = document.getElementById("shell");

function showLogin() {
  currentUser = null;
  shellEl.hidden = true;
  authRoot.hidden = false;
  authRoot.replaceChildren();
  renderLogin(authRoot, async (user) => {
    currentUser = user;
    authRoot.hidden = true;
    shellEl.hidden = false;
    bootShell();
  });
}

function showShell() {
  authRoot.hidden = true;
  shellEl.hidden = false;
  bootShell();
}

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
const topbarActions = document.getElementById("topbar-actions");

let currentView = null;
let currentRoute = null;
let shellBooted = false;

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
  if (!currentUser) return; /* 登录态在路由间切换时，等待门禁裁决 */

  let path = currentPath();
  let route = routes.find((r) => r.path === path);
  if (!route) route = routes[0];

  currentRoute = route;
  markActive(route.path);
  if (titleEl) titleEl.textContent = route.title;
  if (topbarActions) topbarActions.replaceChildren();

  if (currentView && currentView.dispose) {
    try { currentView.dispose(); } catch { /* a failing teardown must not block navigation */ }
  }
  currentView = null;

  const loadingNode = skeleton(1);
  viewEl.replaceChildren(loadingNode);
  try {
    currentView = await route.render(viewEl);
  } catch (err) {
    console.error("render failed", err);
    if (err?.status === 401) { showLogin(); return; }
    viewEl.replaceChildren(
      el("div", "alert err", `<span>✕</span><span class="msg">视图渲染失败：${esc(err.message ?? String(err))}</span>`)
    );
  } finally {
    /*
     * Drop the placeholder unconditionally. Views *append* to the container
     * rather than clearing it, so without this the skeleton stays parked above
     * the rendered page for the rest of the session.
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
      if (err?.status === 401) { showLogin(); return; }
      toast(`刷新失败：${err.message}`, "err");
    }
  } else {
    await navigate();
  }
}

export function go(path) {
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
    icon: "▷",
    run: () => hostBoot()
  },
  {
    id: "act-shutdown",
    title: "停止主机",
    subtitle: "严格反序释放资源",
    group: "动作",
    keywords: "shutdown stop 停止 关闭 主机",
    icon: "▢",
    run: () => hostShutdown()
  },
  {
    id: "act-restart",
    title: "重启主机",
    subtitle: "反序关闭后重新装配",
    group: "动作",
    keywords: "restart reboot 重启 主机",
    icon: "⟳",
    run: () => hostRestart()
  },
  {
    id: "act-refresh",
    title: "刷新当前视图",
    subtitle: "重新拉取内核状态",
    group: "动作",
    keywords: "refresh reload 刷新 重载",
    icon: "↻",
    run: () => refreshCurrentView()
  },
  {
    id: "act-logout",
    title: "退出登录",
    subtitle: "结束当前会话",
    group: "动作",
    keywords: "logout exit 退出 登出",
    icon: "⇥",
    run: async () => { await doLogout(); }
  }
];

const PALETTE_ITEMS = [
  ...NAV_ITEMS.map((i) => ({
    id: `nav-${i.path}`,
    title: i.title,
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
  Promise.resolve(item.run()).catch((err) => {
    if (err?.status === 401) { showLogin(); return; }
    toast(`执行失败：${err.message}`, "err");
  });
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
  if (e.key === "/" && !typing && !paletteOpen && !shellEl.hidden) {
    e.preventDefault();
    openPalette();
  }
});

const paletteBtn = document.getElementById("btn-palette");
if (paletteBtn) {
  paletteBtn.addEventListener("click", openPalette);
  paletteBtn.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openPalette(); }
  });
}

/* ------------------------------------------------------------------ */
/* 主机状态轮询                                                         */
/* ------------------------------------------------------------------ */

const pillEl = document.getElementById("host-pill");
const pillTextEl = document.getElementById("host-pill-text");
const portHintEl = document.getElementById("port-hint");

async function pollHost() {
  try {
    const s = await api.health();
    pillEl.classList.toggle("running", s.running);
    pillEl.classList.toggle("stopped", !s.running);
    pillEl.classList.remove("error");
    pillTextEl.textContent = s.running ? "主机运行中" : "主机已停止";
    portHintEl.textContent = `${location.host} · v${s.version}`;
  } catch (err) {
    if (err?.status === 401) return; /* 会话失效由 /api/auth/me 轮询处理 */
    pillEl.classList.add("error");
    pillEl.classList.remove("running", "stopped");
    pillTextEl.textContent = "桥接服务不可达";
    portHintEl.textContent = "";
  }
}

/* ------------------------------------------------------------------ */
/* 通知中心 / 用户菜单                                                  */
/* ------------------------------------------------------------------ */

const notifyBtn = document.getElementById("btn-notify");
const notifyPop = document.getElementById("notify-pop");
const notifyBadge = document.getElementById("notify-badge");
let notifyReadIds = new Set();
let notifyTimer = null;

export function markNotified(ids) {
  for (const id of ids) notifyReadIds.add(id);
  renderNotifyBadge();
}

async function pollNotifications() {
  if (!currentUser) return;
  try {
    const data = await api.notifications();
    renderNotifyBadge(data.unread);
    if (notifyPop.classList.contains("open")) renderNotifyPop(data.list);
  } catch { /* 静默：通知轮询失败不打扰用户 */ }
}

function renderNotifyBadge(unread) {
  const n = unread ?? [...notifyReadIds].length; /* 无服务端数据时不亮红点 */
  notifyBadge.textContent = n > 9 ? "9+" : String(n);
  notifyBtn.classList.toggle("has-notify", n > 0);
}

function renderNotifyPop(list) {
  notifyPop.replaceChildren();
  notifyPop.append(el("div", "po-head", `<b>消息通知</b><span>${list.length} 条</span>`));
  const box = el("div", "notify-list");
  if (list.length === 0) {
    box.append(empty("暂无通知", "🔔"));
  } else {
    for (const n of list.slice(0, 12)) {
      const item = el("div", `notify-item ${n.level}`, `
        <span class="nt-dot"></span>
        <span><span class="nt-title">${esc(n.title)}</span><br><span class="nt-sub">${esc(n.detail || "")}</span></span>`);
      if (n.route) item.addEventListener("click", () => { toggleNotify(false); go(n.route); });
      box.append(item);
    }
  }
  notifyPop.append(box);
}

function toggleNotify(force) {
  const open = force !== undefined ? force : !notifyPop.classList.contains("open");
  userPop.classList.remove("open");
  notifyPop.classList.toggle("open", open);
  if (open) api.notifications().then((d) => renderNotifyPop(d.list)).catch(() => {});
}

const userBtn = document.getElementById("btn-user");
const userPop = document.getElementById("user-pop");

function renderUserMenu() {
  const u = currentUser ?? { name: "…", role: "viewer" };
  document.getElementById("user-avatar").textContent = String(u.name ?? "·").slice(0, 1).toUpperCase();
  document.getElementById("user-name").textContent = u.name ?? "";

  userPop.replaceChildren();
  userPop.append(el("div", "po-head", `<b>${esc(u.name ?? "")}</b><span>${esc(ROLE_LABEL[u.role] ?? u.role ?? "")} · ${esc(u.email ?? "")}</span>`));
  const items = [
    { ico: "☺", text: "个人中心", run: () => go("profile") },
    { ico: "⚙", text: "系统设置", run: () => go("settings") },
    { ico: "⇥", text: "退出登录", danger: true, run: () => doLogout() }
  ];
  for (const it of items) {
    const b = el("button", `po-item${it.danger ? " danger" : ""}`, `<span class="ico">${esc(it.ico)}</span>${esc(it.text)}`);
    b.type = "button";
    b.addEventListener("click", () => { userPop.classList.remove("open"); it.run(); });
    userPop.append(b);
  }
}

function toggleUserMenu(force) {
  const open = force !== undefined ? force : !userPop.classList.contains("open");
  notifyPop.classList.remove("open");
  userPop.classList.toggle("open", open);
}

if (notifyBtn) notifyBtn.addEventListener("click", (e) => { e.stopPropagation(); toggleNotify(); });
if (userBtn) userBtn.addEventListener("click", (e) => { e.stopPropagation(); toggleUserMenu(); });
document.addEventListener("click", (e) => {
  if (!e.target.closest(".popover")) {
    notifyPop.classList.remove("open");
    userPop.classList.remove("open");
  }
});

async function doLogout() {
  try { await api.logout(); } catch { /* 会话可能已过期 */ }
  setToken(null);
  currentUser = null;
  if (notifyTimer) clearInterval(notifyTimer);
  showLogin();
}

/* 侧栏折叠 */
const sideMinBtn = document.getElementById("btn-side-min");
if (sideMinBtn) {
  sideMinBtn.addEventListener("click", () => {
    const min = shellEl.classList.toggle("side-min");
    sideMinBtn.textContent = min ? "⟩" : "⟨";
  });
}

const brandHome = document.getElementById("brand-home");
if (brandHome) brandHome.addEventListener("click", () => go("overview"));

/* ------------------------------------------------------------------ */
/* 启动                                                                 */
/* ------------------------------------------------------------------ */

function bootShell() {
  if (shellBooted) {
    renderUserMenu();
    navigate();
    return;
  }
  shellBooted = true;
  buildNav();

  if (UNRENDERABLE.length > 0) {
    console.error("[orbit] 导航声明了但没有渲染器：", UNRENDERABLE.join(", "));
    toast(`导航项缺失渲染器：${UNRENDERABLE.join(", ")}`, "err", 8000);
  }

  renderUserMenu();
  if (!location.hash) location.hash = "#/overview";
  pollHost();
  navigate();
  setInterval(pollHost, 6000);
  pollNotifications();
  notifyTimer = setInterval(pollNotifications, 15000);
}

(async function boot() {
  if (!getToken()) {
    showLogin();
    return;
  }
  try {
    currentUser = await api.me();
    showShell();
  } catch (err) {
    if (err?.status === 401) {
      setToken(null);
      showLogin();
    } else {
      /* 桥接暂时不可达：仍进入控制台，轮询会持续重试 */
      currentUser = { name: "离线", email: "", role: "viewer" };
      showShell();
      toast(`桥接服务不可达：${err.message}`, "err", 6000);
    }
  }
})();
