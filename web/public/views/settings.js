/**
 * 系统设置
 *
 * 权限在这里是**显式可见**的：角色矩阵表直接列出 admin / operator / viewer
 * 各自能做什么，当前角色高亮。用户因此不需要猜"为什么这个按钮是灰的"——
 * 矩阵就是答案。
 *
 * 动效开关是唯一写进 localStorage 的偏好：一个以"确定性"为卖点的产品，
 * 也应该允许用户关掉动画（前庭敏感 / 低性能设备）。
 */
import { api } from "../api.js";
import { el, esc, badge, toast, motionEnabled, setMotion, confirmDialog, currentUserInfo } from "../app.js";
import { ROLE_MATRIX, ROLE_LABEL, can } from "../lib.js";

const SECTIONS = [
  { id: "appearance", label: "外观与体验", icon: "◐" },
  { id: "host", label: "主机生命周期", icon: "▷" },
  { id: "access", label: "权限矩阵", icon: "⚿" },
  { id: "danger", label: "危险操作", icon: "⚠" }
];

const ACTION_LABEL = {
  host: "启停主机",
  workflow: "编排与执行",
  market: "插件市场",
  audit: "审计导出",
  billing: "账单",
  settings: "系统设置"
};

export async function renderSettings(root) {
  const me = currentUserInfo() ?? {};
  const role = me.role ?? "viewer";

  const wrap = el("div", "");
  const grid = el("div", "settings-grid");

  const nav = el("div", "settings-nav");
  const panels = new Map();
  for (const s of SECTIONS) {
    const btn = el("button", `btn ghost`, `<span class="ico">${esc(s.icon)}</span>${esc(s.label)}`);
    btn.type = "button";
    btn.style.justifyContent = "flex-start";
    btn.addEventListener("click", () => show(s.id));
    nav.append(btn);
    panels.set(s.id, el("div", ""));
  }

  /* ---- 外观 ---- */
  const appearance = panels.get("appearance");
  appearance.append(row(
    "界面动效",
    "关闭后所有过渡与动画停摆（偏好存本地）。",
    (() => {
      const sw = el("div", `sw${motionEnabled() ? " on" : ""}`);
      sw.setAttribute("role", "switch");
      sw.addEventListener("click", () => {
        const on = !motionEnabled();
        setMotion(on);
        sw.classList.toggle("on", on);
        toast(on ? "已开启动效" : "已关闭动效", "ok", 1500);
      });
      return sw;
    })()
  ));
  appearance.append(row(
    "命令面板",
    "任何页面按 Ctrl/⌘ + K 或 / 唤起，全键盘可达。",
    badge("常开", "ok")
  ));
  appearance.append(row(
    "会话令牌",
    "存于 localStorage；服务端会话失效时自动回到登录页。",
    badge("Bearer", "neutral")
  ));

  /* ---- 主机 ---- */
  const hostPanel = panels.get("host");
  const health = await api.health().catch(() => ({ running: false, version: "—" }));
  hostPanel.append(row(
    "主机状态",
    `OrbitRuntimeHost · v${health.version} · ${health.running ? "运行中" : "已停止"}`,
    badge(health.running ? "运行中" : "已停止", health.running ? "ok" : "neutral")
  ));
  const hostOps = el("div", "row");
  for (const [text, fn, cls] of [
    ["启动主机", () => api.boot().then(() => toast("主机已启动", "ok")), "primary"],
    ["停止主机", () => api.shutdown().then(() => toast("主机已停止（严格反序释放）", "warn")), ""],
    ["重启主机", async () => {
      const h = await api.health().catch(() => ({ running: false }));
      if (h.running) await api.shutdown();
      await api.boot();
      toast("主机已重启", "ok");
    }, ""]
  ]) {
    if (!can(role, "host")) continue;
    const b = el("button", `btn sm ${cls}`, esc(text));
    b.type = "button";
    b.addEventListener("click", async () => {
      b.disabled = true;
      try { await fn(); } catch (err) { toast(err.message, "err"); } finally { b.disabled = false; }
    });
    hostOps.append(b);
  }
  if (!can(role, "host")) hostOps.append(el("span", "hint", "当前角色无权启停主机（见权限矩阵）"));
  hostPanel.append(row("生命周期操作", "自底向上装配 / 严格反序释放。", hostOps));

  /* ---- 权限矩阵 ---- */
  const access = panels.get("access");
  const roles = Object.keys(ROLE_MATRIX);
  const actions = Object.keys(ROLE_MATRIX.admin);
  const tblWrap = el("div", "tbl-wrap");
  const tbl = el("table", "tbl");
  tbl.innerHTML = `<thead><tr><th>能力</th>${roles
    .map((r) => `<th class="${r === role ? "num" : ""}">${esc(ROLE_LABEL[r] ?? r)}${r === role ? "（当前）" : ""}</th>`)
    .join("")}</tr></thead>`;
  const tbody = el("tbody");
  for (const a of actions) {
    tbody.append(el("tr", "", `
      <td>${esc(ACTION_LABEL[a] ?? a)}</td>
      ${roles.map((r) => `<td class="${r === role ? "num" : ""}">${ROLE_MATRIX[r][a]
        ? badge("允许", "ok")
        : badge("禁止", "neutral")}</td>`).join("")}`));
  }
  tbl.append(tbody);
  tblWrap.append(tbl);
  access.append(el("div", "setting-row", `<div class="sr-body">
      <div class="sr-title">角色能力矩阵</div>
      <div class="sr-desc">当前角色：${esc(ROLE_LABEL[role] ?? role)}（${esc(me.account ?? "—")}）。首个注册的账号为管理员，自助注册固定为操作员。</div>
    </div>`));
  access.append(tblWrap);

  /* ---- 危险操作 ---- */
  const danger = panels.get("danger");
  const resetBtn = el("button", "btn sm danger", "重置插件区");
  resetBtn.type = "button";
  resetBtn.disabled = !can(role, "market");
  resetBtn.addEventListener("click", async () => {
    const ok = await confirmDialog("重置插件区", "确认清空全部已注册插件？依赖图会重建，此操作不可撤销。", "重置");
    if (!ok) return;
    try {
      await api.resetPlugins();
      toast("插件区已重置", "ok");
    } catch (err) { toast(err.message, "err"); }
  });
  danger.append(row("重置插件区", "清空全部插件并重建依赖图（沙箱与账本不受影响）。", resetBtn));

  const unplugBtn = el("button", "btn sm danger", "移除真实模型通道");
  unplugBtn.type = "button";
  unplugBtn.disabled = !can(role, "host");
  unplugBtn.addEventListener("click", async () => {
    const ok = await confirmDialog("移除模型通道", "确认移除已接入的 DeepSeek 通道？将回退到内置 mock 通道。", "移除");
    if (!ok) return;
    try {
      await api.removeDeepSeek();
      toast("已回退到内置通道", "ok");
    } catch (err) { toast(err.message, "err"); }
  });
  danger.append(row("移除真实模型通道", "回退到内置 mock 通道（用于验证降级路径）。", unplugBtn));

  const content = el("div", "");
  grid.append(nav, content);
  wrap.append(grid);
  root.append(wrap);

  function show(id) {
    [...nav.children].forEach((b, i) => b.classList.toggle("primary", SECTIONS[i].id === id));
    content.replaceChildren(panels.get(id));
  }
  show("appearance");

  return { dispose() {}, refresh: () => renderSettings(root) };
}

function row(title, desc, control) {
  const r = el("div", "setting-row");
  const body = el("div", "sr-body");
  body.append(el("div", "sr-title", esc(title)));
  body.append(el("div", "sr-desc", esc(desc)));
  r.append(body, control);
  return r;
}
