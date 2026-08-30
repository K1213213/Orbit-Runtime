/**
 * PAE 桥接服务集成单测：驱动真实 OrbitRuntimeHost（经 bridge api 模块），
 * 覆盖注册 → 调用（经网关 capabilityInvoke）→ 保真度协商 → 注销 全链路，
 * 以及模板处理器与「诚实降级门禁」的端到端行为。
 *
 * 每个注册类用例都用 withAdapter 自清理（finally 中注销），避免共享 host
 * 上的适配器互相污染。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { api, host } from "../bridge-server.mjs";

const MCP_FIXTURE = fileURLToPath(new URL("./fixtures/mcp-stdio-server.mjs", import.meta.url));

before(async () => {
  // 触发 ensureRunning（首次 api 调用会装配内核）。
  await api.pae();
});

after(async () => {
  await host.shutdownHost();
});

const FULL = { capability: "channel:read", determinism: "deterministic", fidelity: "full" };

/** 注册一个单工具适配器，执行 fn，最后无论如何都注销，避免泄漏。 */
async function withAdapter(adapterId, tool, fn) {
  const res = await api.registerPae({ adapterId, sourceEdition: "1.0.0", isolation: "L0", tools: [tool] });
  try {
    return await fn(res);
  } finally {
    await api.removePae(adapterId);
  }
}

test("注册 echo 适配器并经由网关注接驳", async () => {
  const res = await withAdapter("it.echo", { template: "echo", name: "itEcho", ...FULL }, (r) => r);
  assert.equal(res.paeEnabled, true);
  assert.equal(res.adapters.length, 1);
  assert.equal(res.adapters[0].adapterId, "it.echo");
  assert.equal(res.tools.length, 1);
  assert.equal(res.tools[0].name, "itEcho");
  assert.equal(res.tools[0].template, "echo");
});

test("经 capabilityInvoke 调用 echo 返回入参，route=pae", async () => {
  const inv = await withAdapter("it.echo", { template: "echo", name: "itEcho", ...FULL }, async () => {
    return api.invokePae({ toolName: "itEcho", argText: "hello orbit" });
  });
  assert.equal(inv.output, "hello orbit");
  assert.equal(inv.route, "pae");
  assert.equal(inv.channel, "pae-tool");
  assert.ok(typeof inv.ms === "number");
});

test("调用台字符串入参不被吞：args(字符串) 与 argText 等价（回归：曾静默丢弃）", async () => {
  const inv = await withAdapter("it.echo", { template: "echo", name: "itEchoStr", ...FULL }, async () => {
    // 视图经 api.invokePae(toolName, 字符串) 发送，body 里是 args 而非 argText。
    return api.invokePae({ toolName: "itEchoStr", args: "hello via args" });
  });
  assert.equal(inv.output, "hello via args", "字符串 args 必须送达工具");
});

test("hash 模板确定性：相同入参两次结果一致且为 64 位 hex", async () => {
  const [a, b] = await withAdapter("it.hash", { template: "hash", name: "itHash", ...FULL }, async () => {
    const x = await api.invokePae({ toolName: "itHash", argText: "orbit" });
    const y = await api.invokePae({ toolName: "itHash", argText: "orbit" });
    return [x, y];
  });
  assert.equal(a.output, b.output);
  assert.match(a.output, /^[0-9a-f]{64}$/);
});

test("add 模板解析逗号数字并求和", async () => {
  const r = await withAdapter("it.add", { template: "add", name: "itAdd", ...FULL }, async () => {
    return api.invokePae({ toolName: "itAdd", argText: "1,2,3,4" });
  });
  assert.equal(r.output, 10);
});

test("保真度协商：full 工具满足 lossy/reduced，但 reduced 工具不满足 full", async () => {
  // full 工具：请求更高或更低的保真度都应放行（full 是上限）
  await withAdapter("it.negA", { template: "echo", name: "itNegA", ...FULL }, async () => {
    const lossy = await api.negotiatePae({ toolName: "itNegA", minFidelity: "lossy" });
    assert.equal(lossy.negotiated.fidelity, "full");
    const reduced = await api.negotiatePae({ toolName: "itNegA", minFidelity: "reduced" });
    assert.equal(reduced.negotiated.fidelity, "full");
  });

  // reduced 工具：请求 full 必须诚实拒绝（reduced < full）
  await withAdapter(
    "it.negB",
    { template: "echo", name: "itNegB", capability: "channel:read", determinism: "deterministic", fidelity: "reduced", fidelityNote: "仅回显首行" },
    async () => {
      const ok = await api.negotiatePae({ toolName: "itNegB", minFidelity: "reduced" });
      assert.equal(ok.negotiated.fidelity, "reduced");
      await assert.rejects(
        () => api.negotiatePae({ toolName: "itNegB", minFidelity: "full" }),
        /fidelity/
      );
    }
  );
});

test("注册拒绝：未知模板", async () => {
  await assert.rejects(
    () => api.registerPae({ adapterId: "it.bad", tools: [{ template: "nope", name: "n", fidelity: "full" }] }),
    /unknown pae template/
  );
});

test("注册拒绝：降级未带 fidelityNote（诚实门禁端到端）", async () => {
  await assert.rejects(
    () => api.registerPae({
      adapterId: "it.reduced",
      tools: [{ template: "echo", name: "r", capability: "channel:read", determinism: "deterministic", fidelity: "reduced" }]
    }),
    /fidelityNote/
  );
});

test("注销后适配面清空（自清理无泄漏）", async () => {
  const after = await withAdapter("it.tmp", { template: "echo", name: "itTmp", ...FULL }, async () => {
    const mid = await api.pae();
    assert.equal(mid.adapters.length, 1);
    return api.removePae("it.tmp");
  });
  assert.equal(after.adapters.length, 0);
  assert.equal(after.tools.length, 0);
});

/* ------------------------------------------------------------------ */
/* W16 · MCP：真实子进程经 stdio 接驳                                   */
/* ------------------------------------------------------------------ */

/** 连接夹具服务器，执行 fn，最后无论如何都注销（回收子进程）。 */
async function withMcp(adapterId, fn, extra = {}) {
  const res = await api.registerPae({
    kind: "mcp",
    adapterId,
    command: process.execPath,
    args: [MCP_FIXTURE],
    timeoutMs: 15000,
    ...extra
  });
  try {
    return await fn(res);
  } finally {
    await api.removePae(adapterId);
  }
}

test("MCP：连接真实子进程并发现其声明的工具面", async () => {
  const res = await withMcp("mcp.it", (r) => r);
  assert.equal(res.paeEnabled, true);
  assert.equal(res.adapters.length, 1);

  const adapter = res.adapters[0];
  assert.equal(adapter.adapterId, "mcp.it");
  assert.equal(adapter.kind, "mcp");
  assert.equal(adapter.isolation, "L2", "the peer is a separate OS process");
  assert.deepEqual(adapter.serverInfo, {
    protocolVersion: "2024-11-05",
    name: "fixture-mcp",
    version: "2.3.4"
  });

  assert.deepEqual(res.tools.map((t) => t.name), ["greet", "total"]);
});

test("MCP：发现的工具默认 reduced 保真度且带降级说明", async () => {
  const res = await withMcp("mcp.it", (r) => r);
  for (const tool of res.tools) {
    assert.equal(tool.fidelity, "reduced", "argument validation is remote, so full would be a lie");
    assert.match(tool.fidelityNote, /validated by the remote server/);
    assert.equal(tool.determinism, "io-bound", "a cross-process call is IO by definition");
  }
});

test("MCP：经网关注入 JSON 命名参数调用远端工具", async () => {
  const out = await withMcp("mcp.it", async () =>
    api.invokePae({ toolName: "greet", argText: '{"name":"orbit"}' })
  );
  assert.equal(out.output, "hello, orbit");
  assert.equal(out.route, "pae");
  assert.equal(out.channel, "pae-tool");
  assert.deepEqual(out.args, [{ name: "orbit" }]);
});

test("MCP：空入参视为无参数调用而非报错", async () => {
  const out = await withMcp("mcp.it", async () => api.invokePae({ toolName: "greet", argText: "" }));
  assert.equal(out.output, "hello, world");
});

test("MCP：非 JSON 入参被明确拒绝，不会带着脏参数打到对端", async () => {
  await withMcp("mcp.it", async () => {
    await assert.rejects(
      () => api.invokePae({ toolName: "greet", argText: "not json" }),
      /JSON 对象/
    );
  });
});

test("MCP：工具名前缀避免与另一个 server 撞名", async () => {
  const res = await withMcp("mcp.it", (r) => r, { toolNamePrefix: "fx_" });
  assert.deepEqual(res.tools.map((t) => t.name), ["fx_greet", "fx_total"]);
});

test("MCP：注销后工具面清空", async () => {
  const after = await withMcp("mcp.it", async () => api.removePae("mcp.it"));
  assert.equal(after.adapters.length, 0);
  assert.equal(after.tools.length, 0);
});

test("MCP：连接不可用的服务器时失败并把错误说清楚", async () => {
  await assert.rejects(
    () =>
      api.registerPae({
        kind: "mcp",
        adapterId: "mcp.dead",
        command: process.execPath,
        args: ["-e", "process.exit(3);"],
        timeoutMs: 5000
      }),
    /MCP 连接失败/
  );
  // 失败后不得留下任何注册痕迹
  const after = await api.pae();
  assert.equal(after.adapters.some((a) => a.adapterId === "mcp.dead"), false);
});
