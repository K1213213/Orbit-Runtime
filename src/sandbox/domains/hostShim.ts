/**
 * The built-in L2 domain host (W19).
 *
 * A domain host is the child process that OWNS the plugin units assigned to an
 * isolation domain. The kernel never ships code into the child (no eval —
 * charter), so the built-in host serves a fixed set of pure units; a real
 * deployment replaces it with a bootstrap script that loads the project's own
 * plugins and announces them via the same protocol (`DOMAIN_PROTOCOL_VERSION`).
 *
 * The host is produced as a source string so it can be spawned with
 * `node -e <DOMAIN_HOST_SHIM>` by the default transport factory. Which units it
 * serves is configured through `ORBIT_DOMAIN_UNITS` (comma-separated ids;
 * absent = all built-ins). All units are pure functions — no randomness, no
 * clock — matching the kernel's determinism charter for subprocesses
 * (UPGRADE_PLAN ③隔离域子进程调度).
 */

import { KERNEL_VERSION } from "../../utils/versionIdGen";

/** Edition of the built-in host shim; embedded into the spawned source. */
export const DOMAIN_HOST_VERSION = KERNEL_VERSION;

const LINES = [
  "const VERSION = " + JSON.stringify(DOMAIN_HOST_VERSION) + ";",
  "const PROTOCOL = " + JSON.stringify("1.0.0") + ";",
  "// Built-in pure units: no randomness, no clock.",
  "const UNITS = {",
  "  echo: {",
  '    echo: { description: "echo its arguments back", run: (args) => ({ echo: args }) },',
  '    sum: { description: "sum an array of numbers", run: (args) => (Array.isArray(args.numbers) ? args.numbers.reduce((a, b) => a + (Number(b) || 0), 0) : null) }',
  "  },",
  "  calc: {",
  '    add: { description: "add two numbers", run: (args) => (Number(args.a) || 0) + (Number(args.b) || 0) },',
  '    mul: { description: "multiply two numbers", run: (args) => (Number(args.a) || 0) * (Number(args.b) || 0) }',
  "  }",
  "};",
  "const wanted = (process.env.ORBIT_DOMAIN_UNITS || '').split(',').map((s) => s.trim()).filter(Boolean);",
  "const serve = Object.keys(UNITS).filter((id) => wanted.length === 0 || wanted.includes(id));",
  "const unitsList = serve.map((id) => ({ id, tools: Object.entries(UNITS[id]).map(([name, t]) => ({ name, description: t.description })) }));",
  "const readline = require('node:readline');",
  "const rl = readline.createInterface({ input: process.stdin, terminal: false });",
  "rl.on('line', (line) => {",
  "  if (!line.trim()) return;",
  "  let m;",
  "  try { m = JSON.parse(line); } catch { return; }",
  "  const send = (payload) => process.stdout.write(JSON.stringify(Object.assign({ jsonrpc: '2.0', id: m.id }, payload)) + '\\n');",
  "  if (m.method === 'initialize') {",
  '    send({ result: { protocolVersion: PROTOCOL, hostInfo: { name: "orbit-domain-host", version: VERSION } } });',
  "    return;",
  "  }",
  "  if (m.method === 'units/list') {",
  "    send({ result: { units: unitsList } });",
  "    return;",
  "  }",
  "  if (m.method === 'units/call') {",
  "    const unit = m.params && m.params.unitId;",
  "    const tool = m.params && m.params.tool;",
  "    const hostUnit = UNITS[unit];",
  "    const hostTool = hostUnit && hostUnit[tool];",
  "    if (!hostUnit || !hostTool) {",
  "      send({ error: { message: 'unknown unit or tool: ' + unit + ':' + tool } });",
  "      return;",
  "    }",
  "    try {",
  "      send({ result: hostTool.run(m.params && m.params.arguments || {}) });",
  "    } catch (err) {",
  "      send({ error: { message: String(err && err.message || err) } });",
  "    }",
  "    return;",
  "  }",
  "  send({ error: { message: 'unknown method: ' + m.method } });",
  "});"
];

/** Source of the built-in host, ready for `node -e <DOMAIN_HOST_SHIM>`. */
export const DOMAIN_HOST_SHIM = LINES.join("\n");
