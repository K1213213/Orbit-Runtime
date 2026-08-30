/**
 * 登录 / 注册视图
 *
 * 会话入口，也是唯一不需要令牌即可渲染的视图。两个刻意选择：
 *   1. 首账号即管理员：种子 admin 由桥接创建并打印在启动横幅；自助注册永远
 *      只能是操作员或观察者，特权来自种子而非表单自称的角色。
 *   2. 背景粒子确定性：坐标与延迟写死，刷新后画面一致。
 *
 * 按设计文档第 3 节补全：记住我、忘记密码、确认密码、用户协议勾选（未勾选禁提交）、
 * 实时表单校验与绿色成功提示、登录按钮渐变流光加载态。
 */
import { api, setToken } from "../api.js";
import { el, esc, toast } from "../app.js";

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
  hero.append(el("h1", "", "Orbit Agent Runtime"));
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
  /* 动态科技特效层：扫描线自上而下、透视网格地面向前流动（CSS 驱动，确定性）。 */
  hero.append(el("div", "hero-scan"));
  hero.append(el("div", "hero-grid"));

  /* ---- 右：表单 ---- */
  const panel = el("div", "auth-panel");
  const card = el("div", "auth-card");

  const title = el("div", "auth-title", "登录控制台");
  const sub = el("div", "auth-sub", "种子账号：admin / orbit-admin（首个账号即管理员）");
  card.append(title, sub);

  const form = el("form");
  form.addEventListener("submit", (e) => { e.preventDefault(); submit(); });

  const accountF = field("账号 / 邮箱", "text", "admin");
  const passwordF = field("密码", "password", "orbit-admin");
  const nameF = field("昵称", "text", "");
  const emailF = field("邮箱", "text", "");
  const confirmF = field("确认密码", "password", "");
  /* 注册态专属字段初始即隐藏：hidden 只在 toggle() 里赋值的旧写法
     会让登录首屏把昵称/邮箱/确认密码/协议勾选全部渲染出来。 */
  nameF.root.hidden = true;
  emailF.root.hidden = true;
  confirmF.root.hidden = true;

  /* 登录态：记住我 + 忘记密码 */
  const rememberRow = el("div", "auth-options");
  const remember = el("label", "check-row");
  const rememberCb = el("input");
  rememberCb.type = "checkbox";
  rememberCb.checked = true;
  remember.append(rememberCb, el("span", "", "记住我"));
  const forgot = el("a", "link", "忘记密码");
  forgot.addEventListener("click", (e) => {
    e.preventDefault();
    toast("请联系管理员重置密码（本地演示环境未启用自助重置）", "warn");
  });
  rememberRow.append(remember, forgot);

  /* 注册态：用户协议勾选 */
  const agreeRow = el("div", "agree-row");
  agreeRow.hidden = true;
  const agreeCb = el("input");
  agreeCb.type = "checkbox";
  const agreeLabel = el("label", "check-row");
  agreeLabel.append(agreeCb, el("span", "", "我已阅读并同意《用户协议》与《隐私政策》"));
  agreeRow.append(agreeLabel);

  const errBox = el("div", "field");
  const errMsg = el("div", "f-error", "");
  errBox.append(errMsg);
  errBox.hidden = true;

  const okHint = el("div", "f-ok", "✓ 信息填写完整，可提交");
  okHint.hidden = true;

  const submitBtn = el("button", "btn primary wfull lg", "登录");
  submitBtn.type = "submit";

  form.append(
    accountF.root, passwordF.root, rememberRow,
    nameF.root, emailF.root, confirmF.root, agreeRow,
    errBox, okHint, submitBtn
  );

  const foot = el("div", "auth-foot");
  const switchLink = el("a", "", "还没有账号？注册一个操作员账号");
  switchLink.addEventListener("click", (e) => { e.preventDefault(); toggle(); });
  foot.append(switchLink);

  card.append(form, foot);
  panel.append(card);
  shell.append(hero, panel);
  root.append(shell);

  /* 实时校验 */
  for (const f of [accountF, passwordF, nameF, emailF, confirmF]) {
    f.input.addEventListener("input", () => { clearFormError(); refreshValidity(); });
  }
  agreeCb.addEventListener("change", refreshValidity);

  function toggle() {
    mode = mode === "login" ? "register" : "login";
    const reg = mode === "register";
    title.textContent = reg ? "注册操作员账号" : "登录控制台";
    sub.textContent = reg
      ? "自助注册固定为操作员：可跑任务与编排，不能改系统配置、不能看账单。"
      : "种子账号：admin / orbit-admin（首个账号即管理员）";
    nameF.root.hidden = !reg;
    emailF.root.hidden = !reg;
    confirmF.root.hidden = !reg;
    agreeRow.hidden = !reg;
    rememberRow.hidden = reg;
    submitBtn.textContent = reg ? "注册并进入" : "登录";
    switchLink.textContent = reg ? "已有账号？返回登录" : "还没有账号？注册一个操作员账号";
    clearFormError();
    refreshValidity();
    accountF.input.focus();
  }

  function validate() {
    const errors = {};
    const account = accountF.input.value.trim();
    const password = passwordF.input.value;
    if (!account) errors.account = "请输入账号或邮箱";
    if (!password) errors.password = "请输入密码";
    else if (password.length < 4) errors.password = "密码至少 4 位";

    if (mode === "register") {
      if (!nameF.input.value.trim()) errors.name = "请填写昵称";
      const email = emailF.input.value.trim();
      if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) errors.email = "邮箱格式不正确";
      if (confirmF.input.value !== password) errors.confirm = "两次输入的密码不一致";
      if (!agreeCb.checked) errors.agree = "请先同意用户协议";
    }
    return errors;
  }

  function refreshValidity() {
    const errors = validate();
    accountF.setErr(errors.account);
    passwordF.setErr(errors.password);
    nameF.setErr(errors.name);
    emailF.setErr(errors.email);
    confirmF.setErr(errors.confirm);
    const reg = mode === "register";
    const ok = Object.keys(errors).length === 0 && (!reg || agreeCb.checked);
    okHint.hidden = !ok;
    submitBtn.disabled = !ok;
    if (!ok) okHint.hidden = true;
  }

  function clearFormError() {
    errBox.hidden = true;
    errMsg.textContent = "";
  }

  async function submit() {
    const errors = validate();
    const keys = Object.keys(errors);
    if (keys.length) {
      accountF.setErr(errors.account);
      passwordF.setErr(errors.password);
      nameF.setErr(errors.name);
      emailF.setErr(errors.email);
      confirmF.setErr(errors.confirm);
      errMsg.textContent = errors[keys[0]];
      errBox.hidden = false;
      submitBtn.disabled = true;
      return;
    }
    clearFormError();
    okHint.hidden = true;
    submitBtn.disabled = true;
    submitBtn.classList.add("loading");
    submitBtn.textContent = mode === "register" ? "注册中…" : "登录中…";
    try {
      const account = accountF.input.value.trim();
      const password = passwordF.input.value;
      const data = mode === "register"
        ? await api.register({
            account,
            password,
            name: nameF.input.value.trim(),
            email: emailF.input.value.trim()
          })
        : await api.login(account, password);
      setToken(data.token, rememberCb.checked);
      toast(`欢迎，${data.user.name}`, "ok");
      await onAuthed(data.user);
    } catch (err) {
      errMsg.textContent = err.message;
      errBox.hidden = false;
      submitBtn.classList.remove("loading");
      submitBtn.disabled = false;
      submitBtn.textContent = mode === "register" ? "注册并进入" : "登录";
    }
  }

  /* 初始按登录态刷新一次可用性 */
  refreshValidity();
  return { dispose() {} };
}

/* 字段构造器：自带错误位，便于实时校验 */
function field(label, type, value) {
  const root = el("div", "field");
  const lab = el("label", "", esc(label));
  const input = el("input", "input");
  input.type = type;
  input.value = value;
  input.autocomplete = type === "password" ? "new-password" : "off";
  const err = el("div", "f-error", "");
  err.hidden = true;
  root.append(lab, input, err);
  return {
    root,
    input,
    setErr(msg) {
      if (msg) { err.textContent = msg; err.hidden = false; root.classList.add("invalid"); }
      else { err.hidden = true; root.classList.remove("invalid"); }
    }
  };
}

function orbSvg() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "hero-orb");
  svg.setAttribute("viewBox", "0 0 40 40");
  /*
   * 分层轨道球：基环 + 旋转虚线环（雷达感）+ 倾斜椭圆进动（陀螺仪感）+
   * 旋转扫描扇 + 脉冲核。全部由 CSS keyframes 驱动（确定性：无 JS 随机），
   * 动效开关 / prefers-reduced-motion 由全局规则统一关闭。
   */
  svg.innerHTML = `
    <g class="hero-orb-ring" transform="rotate(0 20 20)">
      <circle cx="20" cy="20" r="16" fill="none" stroke="currentColor" stroke-width="2.5" />
      <circle class="orb-dash" cx="20" cy="20" r="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-dasharray="20 7.5" stroke-linecap="round" />
    </g>
    <g transform="rotate(58 20 20)">
      <ellipse class="hero-orb-tilt" cx="20" cy="20" rx="7" ry="16" fill="none" stroke="currentColor" stroke-width="1.5" />
    </g>
    <path class="hero-orb-sweep" d="M20 20 L20 4 A16 16 0 0 1 31.31 8.69 Z" fill="currentColor" opacity="0.16" />
    <circle class="hero-orb-core" cx="20" cy="20" r="2.8" fill="currentColor" />`;
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
  /* 漂浮粒子点：延迟由硬编码数组推导（确定性），非裸随机。 */
  for (let i = 0; i < PARTICLES.length; i += 1) {
    const [x, y] = PARTICLES[i];
    const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    dot.setAttribute("class", "auth-particle-dot");
    dot.setAttribute("cx", String(x));
    dot.setAttribute("cy", String(y));
    dot.setAttribute("r", "0.9");
    dot.style.animationDelay = `${(i * 1.7) % 10}s`;
    svg.append(dot);
  }
  return svg;
}
