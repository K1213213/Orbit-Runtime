/**
 * 个人中心
 *
 * 只做三件与"我"有关的事：看自己的账号与权限、改密码、结束会话。
 * 权限不在这里重复定义——它与设置页的权限矩阵、服务端的角色判定共用
 * lib.js 的 ROLE_MATRIX，避免"界面说可以、接口说不可以"这类漂移。
 */
import { api, setToken } from "../api.js";
import { el, esc, badge, toast, fmtDate, confirmDialog, currentUserInfo } from "../app.js";
import { ROLE_LABEL, ROLE_MATRIX, can } from "../lib.js";

export async function renderProfile(root) {
  const wrap = el("div", "");

  let me = currentUserInfo();
  if (!me) {
    try {
      me = await api.me();
    } catch (err) {
      root.append(el("div", "alert err", `<span>⚠</span><span class="msg">无法加载账号信息：${esc(err.message)}</span>`));
      return { dispose() {} };
    }
  }

  /* ---- 账号卡片 ---- */
  const infoCard = el("div", "card");
  const infoBody = el("div", "card-body");
  const head = el("div", "row");
  head.append(el("div", "avatar lg", esc(String(me.name ?? "?").slice(0, 1).toUpperCase())));
  const meta = el("div", "grow");
  meta.append(el("div", "", `<b>${esc(me.name)}</b> ${badge(ROLE_LABEL[me.role] ?? me.role, me.role === "admin" ? "gold" : "violet")}`));
  meta.append(el("div", "hint", `${esc(me.email ?? "")} · @${esc(me.account)}`));
  head.append(meta);
  infoBody.append(head);

  const kv = el("dl", "kv mt16");
  kv.append(
    dt("账号", me.account),
    dt("昵称", me.name),
    dt("邮箱", me.email),
    dt("角色", `${ROLE_LABEL[me.role] ?? me.role}`),
    dt("创建时间", fmtDate(me.createdAt)),
    dt("可执行动作", Object.keys(ROLE_MATRIX[me.role] ?? {})
      .filter((a) => can(me.role, a))
      .map((a) => ({ host: "启停主机", workflow: "编排执行", market: "插件市场", audit: "审计导出", billing: "账单", settings: "系统设置" }[a] ?? a))
      .join("、") || "无")
  );
  infoBody.append(kv);
  infoCard.append(el("div", "card-head", "<h3>账号信息</h3><span class='sub'>权限由角色矩阵裁决</span>"), infoBody);

  /* ---- 修改密码 ---- */
  const pwdCard = el("div", "card mt16");
  const pwdBody = el("div", "card-body");
  const oldF = el("input", "input");
  oldF.type = "password";
  oldF.placeholder = "当前密码";
  const newF = el("input", "input");
  newF.type = "password";
  newF.placeholder = "新密码（至少 6 位）";
  const newF2 = el("input", "input");
  newF2.type = "password";
  newF2.placeholder = "再输入一次新密码";

  const submit = el("button", "btn primary", "修改密码");
  submit.type = "button";
  submit.addEventListener("click", async () => {
    if (!oldF.value) { toast("请输入当前密码", "err"); return; }
    if (newF.value.length < 6) { toast("新密码至少 6 位", "err"); return; }
    if (newF.value !== newF2.value) { toast("两次输入的新密码不一致", "err"); return; }
    submit.disabled = true;
    try {
      await api.changePassword(oldF.value, newF.value);
      toast("密码已修改（该动作已记入审计流）", "ok");
      oldF.value = newF.value = newF2.value = "";
    } catch (err) {
      toast(err.message, "err");
    } finally {
      submit.disabled = false;
    }
  });

  pwdBody.append(
    el("div", "grid cols-3", [field("当前密码", oldF), field("新密码", newF), field("确认新密码", newF2)]),
    el("div", "row", [submit])
  );
  pwdCard.append(el("div", "card-head", "<h3>修改密码</h3><span class='sub'>修改会记入事件溯源</span>"), pwdBody);

  /* ---- 会话 ---- */
  const sessCard = el("div", "card mt16");
  const sessBody = el("div", "card-body");
  const logout = el("button", "btn danger", "退出登录");
  logout.type = "button";
  logout.addEventListener("click", async () => {
    const ok = await confirmDialog("退出登录", "确认结束当前会话？未保存的表单内容会丢失。", "退出");
    if (!ok) return;
    try { await api.logout(); } catch { /* 会话可能已过期 */ }
    setToken(null);
    location.reload();
  });
  sessBody.append(el("div", "spread", `
    <div><div class="sr-title">当前会话</div><div class="hint">令牌存于本地；退出后需重新登录。</div></div>`));
  sessBody.lastElementChild.append(logout);
  sessCard.append(el("div", "card-head", "<h3>会话</h3>"), sessBody);

  wrap.append(infoCard, pwdCard, sessCard);
  root.append(wrap);

  return { dispose() {}, refresh: () => renderProfile(root) };
}

function dt(k, v) {
  const frag = document.createDocumentFragment();
  frag.append(el("dt", "", esc(k)), el("dd", "", esc(String(v ?? "—"))));
  return frag;
}

function field(text, control) {
  const f = el("div", "field");
  f.style.marginBottom = "0";
  f.append(el("label", "", esc(text)));
  f.append(control);
  return f;
}
