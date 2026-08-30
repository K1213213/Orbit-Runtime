/**
 * 最小 MCP 服务器（测试夹具）：真实子进程，经 stdio 说 JSON-RPC 2.0。
 *
 * 用真实进程而非内存桩，是为了让桥接服务的 MCP 链路被端到端验证：spawn、
 * 换行分帧、initialize 握手、tools/list 发现、tools/call 调用、注销时回收，
 * 每一步都是真的。
 *
 * 暴露两个工具：
 *   greet({ name })  —— 文本回执
 *   total({ values }) —— 数值求和
 * 第三个工具 describe 了但刻意不存在，用于验证未知工具的错误路径。
 */
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    const send = (result) =>
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\n");

    if (msg.method === "initialize") {
      send({
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "fixture-mcp", version: "2.3.4" }
      });
    } else if (msg.method === "tools/list") {
      send({
        tools: [
          { name: "greet", description: "向指定名称问好", inputSchema: { type: "object" } },
          { name: "total", description: "对数值数组求和", inputSchema: { type: "object" } }
        ]
      });
    } else if (msg.method === "tools/call") {
      const args = msg.params?.arguments ?? {};
      if (msg.params?.name === "greet") {
        send({ content: [{ type: "text", text: `hello, ${args.name ?? "world"}` }] });
      } else if (msg.params?.name === "total") {
        send({ content: [{ type: "text", text: String((args.values ?? []).reduce((a, b) => a + b, 0)) }] });
      } else {
        send({ isError: true, content: [{ type: "text", text: `unknown tool: ${msg.params?.name}` }] });
      }
    }
  }
});
