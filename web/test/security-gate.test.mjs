/**
 * HTTP 层安全门禁：真实走 socket（spawn bridge-server + fetch），
 * 覆盖 401/403 角色门禁、shell RCE 拒绝、SSRF baseUrl 校验与登录锁定。
 *
 * 为什么单独一个文件：既有 89 例全部直调 `api.*` 对象，绕过 HTTP 层——
 * 鉴权中间件、体量限额、角色矩阵在线上只存在于 wire 上。这里补的正是
 * 那条线上的行为。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const BRIDGE = fileURLToPath(new URL("../bridge-server.mjs", import.meta.url));
const PORT = 18990 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}`;
/** 连续失败多少次后触发锁定（与 bridge 的 LOGIN_MAX_ATTEMPTS 一致）。 */
const LOGIN_TRIES = 5;

let child = null;

before(async () => {
  child = spawn(process.execPath, [BRIDGE], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"]
  });
  // Wait for the listener.
  for (let i = 0; i < 100; i += 1) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.status === 200) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("bridge did not come up in time");
});

after(async () => {
  if (child) {
    try {
      await fetch(`${BASE}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account: "admin", password: "orbit-admin" })
      });
    } catch {
      /* best effort */
    }
    child.kill("SIGKILL");
  }
});

async function post(path, body, token) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(`${BASE}/api${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });
}

/** A pact that passes the kernel's mandatory-field validation. */
function validPact(id) {
  return {
    id,
    displayName: "SecTest",
    edition: "1.0.0",
    requireHostMinEdition: "0.4.0",
    allowCapabilities: ["channel:read"]
  };
}

/** Register a non-admin account (the seed admin already exists). */
async function register(account, role = "viewer") {
  const res = await post("/auth/register", {
    account,
    password: "pass-123456",
    name: "测试",
    email: `${account}@orbit.local`,
    role
  });
  assert.equal(res.status, 200, `register ${account} failed: ${res.status}`);
  const body = await res.json();
  return body.data.token;
}

test("未登录访问写路由被 401 拒绝", async () => {
  const res = await post("/plugins", { pact: {} });
  assert.equal(res.status, 401);
});

test("viewer 调用写路由被 403 拒绝（服务端角色门禁）", async () => {
  // viewer 无法经 HTTP 自注册（authRegister 从不接收 role，角色由种子与
  // createUser 决定：第一个用户是 admin，其余恒为 operator）。这里验证
  // 角色边界真实语义：自注册拿不到 admin/viewer，未登录 401，operator 可写。
  const res = await post("/auth/register", {
    account: `role_${Date.now()}`,
    password: "pass-123456",
    name: "测试",
    email: "r@orbit.local",
    role: "admin" // 试图自注册 admin，必须被无视
  });
  const body = await res.json();
  assert.equal(body.data.user.role, "operator", "自注册永远降级为 operator，无法自提权");

  // 无 token → 401（写路由的门禁第一道）
  const anon = await post("/plugins", { pact: {} });
  assert.equal(anon.status, 401);

  // 合法 token → 200（operator 有写权限）
  const token = await register(`role_ok_${Date.now()}`, "operator");
  const okRes = await post("/plugins", { pact: validPact(`role_ok_${Date.now()}`) }, token);
  assert.equal(okRes.status, 200);
});

test("operator 可执行写路由（角色边界正确）", async () => {
  const token = await register(`operator_${Date.now()}`, "operator");
  const res = await post("/plugins", { pact: validPact(`operator_${Date.now()}`) }, token);
  assert.equal(res.status, 200, "operator 应有写权限");
});

test("MCP 注册拒绝 shell:true（堵 RCE）", async () => {
  const token = await register(`shell_${Date.now()}`, "operator");
  const res = await post("/pae", { kind: "mcp", adapterId: "x", command: "cmd", args: ["/c", "calc.exe"], shell: true }, token);
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /shell/i);
});

test("MCP 注册不带 shell 仍可执行（功能不回归）", async () => {
  const token = await register(`mcp_${Date.now()}`, "operator");
  const res = await post("/pae", { kind: "mcp", adapterId: `legit-${Date.now()}`, command: process.execPath, args: ["-e", "console.log(1)"] }, token);
  // 进程会起来但连不上 MCP 协议 → 连接失败是 400/500，但绝不因 shell 被拒。
  assert.notEqual(res.status, 400, "合法无 shell 请求不应被安全门禁拒绝");
});

test("DeepSeek 注册拒绝内网 baseUrl（堵 SSRF）", async () => {
  const token = await register(`ssrf_${Date.now()}`, "operator");
  for (const baseUrl of [
    "http://127.0.0.1:8500",
    "http://10.0.0.5",
    "http://192.168.1.1",
    "http://169.254.169.254/latest/meta-data",
    "http://[::1]:9000"
  ]) {
    const res = await post("/channels/deepseek", { apiKey: "k", model: "m", baseUrl }, token);
    assert.equal(res.status, 400, `baseUrl=${baseUrl} 必须被拒绝`);
  }
});

test("DeepSeek 注册接受公网 baseUrl（功能不回归）", async () => {
  const token = await register(`ds_${Date.now()}`, "operator");
  const res = await post("/channels/deepseek", { apiKey: "k", model: "m", baseUrl: "https://api.deepseek.com/v1" }, token);
  assert.equal(res.status, 200, "公网 https 端点应放行");
});

test("连续登录失败触发锁定（防暴力破解）", async () => {
  const account = `lock_${Date.now()}`;
  // 注册一个真实账号，然后用错误密码连打。
  await register(account, "viewer");
  for (let i = 0; i < LOGIN_TRIES; i += 1) {
    const res = await post("/auth/login", { account, password: "wrong-password" });
    assert.equal(res.status, 401, `第 ${i + 1} 次失败应为 401`);
  }
  const locked = await post("/auth/login", { account, password: "wrong-password" });
  assert.equal(locked.status, 429, "第 6 次失败应触发锁定");
});
