/**
 * 登录 / 注册视图
 *
 * 这是会话的入口，也是唯一不需要令牌就能渲染的视图。两个刻意的选择：
 *
 *   1. **首账号即管理员**：种子账号 admin 在桥接启动时创建并打印在启动
 *      横幅上；自助注册永远只能成为操作员或观察者——特权来自种子，不来自
 *      表单里自称的角色（角色由桥接裁决，表单不提供该字段）。
 *   2. **背景粒子是确定性的**：线条位置与动画延迟写死在数组里。一个以
 *      "确定性"为卖点的产品，连装饰都不该每次刷新都长不一样。
 */
import { api, setToken } from "../api.js";
import { el, esc, toast } from "../app.js";

/* 背景粒子：固定坐标 + 固定延迟，刷新后画面完全一致。 */
const PARTICLES = [
  [8, 12, 240], [22, 40, 320], [35, 8, 180], [48, 55, 260],
  [61, 22, 300], [74, 68, 200], [88, 34, 340], [95, 12, 160]
];

export function renderLogin(root, onAuthed) {
  let mode = "login";

  const shell = el("div", "auth-shell");

  /* ---- 左：品牌叙事 ---- */
  const hero = el("div", "auth-hero");
  hero.append(orbSvg());
  const h1 = el("h1", "", "Orbit Agent Runtime");
  hero.append(h1);
  hero.append(el("p", "lead", "把不可复现的 agent bug，变成可以逐字节对账的证据链。控制台是内核能力面的操作界面——这里看到的每一个数字都来自真实内核状态，没有一处是演示用的假数据。"));

  const tags = el("div", "hero-tags");
  for (const t of [
    ["确定性重放", "录制 → 零模型调用回放 → 逐字节一致"],
    ["图隔离", "影响域图判定故障跨域传播"],
    ["成本路由", "预算与延迟约束下的通道择优"],
    ["异构接驳", "MCP / JS 外来工具经网关接入"]
  ]) {
    tags.append(el("div", "hero-tag", `<b>${esc(t[0])}</b>${esc(t[1])}`));
  }
  hero.append(tags);
  hero.append(particlesSvg());

  /* ---- 右：表单 ---- */
  const panel = el("div", "auth-panel");
  const card = el("div", "auth-card");

  const title = el("div", "auth-title", "登录控制台");
  const sub = el("div", "auth-sub", "种子账号：admin / orbit-admin（首个账号即管理员）");
  card.append(title, sub);

  const form = el("form");
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    submit();
  });

  const accountF = inputField("账号", "text", "admin");
  const passwordF = inputField("密码", "password", "orbit-admin");
  const nameF = inputField("昵称（可留空）", "text", "");
  const emailF = inputField("邮箱（可留空）", "text", "");
  nameF.hidden = true;
  emailF.hidden = true;

  const errBox = el("div", "field");
  const errMsg = el("div", "f-error", "");
  errBox.append(errMsg);
  errBox.hidden = true;

  const submitBtn = el("button", "btn primary wfull lg", "登录");
  submitBtn.type = "submit";

  form.append(accountF, passwordF, nameF, emailF, errBox, submitBtn);

  const foot = el("div", "auth-foot");
  const switchLink = el("a", "", "还没有账号？注册一个操作员账号");
  switchLink.addEventListener("click", (e) => {
    e.preventDefault();
    mode = mode === "login" ? "register" : "login";
    applyMode();
  });
  foot.append(switchLink);

  card.append(form, foot);
  panel.append(card);
  shell.append(hero, panel);
  root.append(shell);

  function applyMode() {
    const reg = mode === "register";
    title.textContent = reg ? "注册操作员账号" : "登录控制台";
    sub.textContent = reg
      ? "自助注册固定为操作员：可跑任务与编排，不能改系统配置、不能看账单。"
      : "种子账号：admin / orbit-admin（首个账号即管理员）";
    nameF.hidden = !reg;
    emailF.hidden = !reg;
    submitBtn.textContent = reg ? "注册并进入" : "登录";
    switchLink.textContent = reg ? "已有账号？返回登录" : "还没有账号？注册一个操作员账号";
    errBox.hidden = true;
    accountF.querySelector("input").focus();
  }

  async function submit() {
    const account = accountF.querySelector("input").value.trim();
    const password = passwordF.querySelector("input").value;
    errBox.hidden = true;
    submitBtn.disabled = true;
    submitBtn.textContent = mode === "register" ? "注册中…" : "登录中…";
    try {
      const data = mode === "register"
        ? await api.register({
            account,
            password,
            name: nameF.querySelector("input").value.trim(),
            email: emailF.querySelector("input").value.trim()
          })
        : await api.login(account, password);
      setToken(data.token);
      toast(`欢迎回来，${data.user.name}`, "ok");
      await onAuthed(data.user);
    } catch (err) {
      errMsg.textContent = err.message;
      errBox.hidden = false;
      submitBtn.disabled = false;
      submitBtn.textContent = mode === "register" ? "注册并进入" : "登录";
    }
  }

  return { dispose() {} };
}

function inputField(label, type, value) {
  const f = el("div", "field");
  f.append(el("label", "", esc(label)));
  const i = el("input", "input");
  i.type = type;
  i.value = value;
  i.autocomplete = type === "password" ? "current-password" : "off";
  f.append(i);
  return f;
}

function orbSvg() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "hero-orb");
  svg.setAttribute("viewBox", "0 0 40 40");
  svg.innerHTML = `
    <circle cx="20" cy="20" r="16" fill="none" stroke="currentColor" stroke-width="2.5" />
    <ellipse cx="20" cy="20" rx="7" ry="16" fill="none" stroke="currentColor" stroke-width="1.5" transform="rotate(58 20 20)" />
    <circle cx="20" cy="20" r="2.8" fill="currentColor" />`;
  return svg;
}

function particlesSvg() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "auth-particles");
  svg.setAttribute("viewBox", "0 0 100 100");
  svg.setAttribute("preserveAspectRatio", "none");
  for (const [x, y, r] of PARTICLES) {
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", String(x));
    line.setAttribute("y1", String(y));
    line.setAttribute("x2", String(x));
    line.setAttribute("y2", String(y + 6));
    line.style.animationDelay = `-${(r % 12)}s`;
    svg.append(line);
  }
  return svg;
}
