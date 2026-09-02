#!/usr/bin/env node
/**
 * orbit — command line interface for Orbit Agent Runtime.
 *
 * Three commands form the deterministic-replay loop:
 *   orbit record <script>            Run a script against a live kernel and
 *                                    capture every channel call into a trace.
 *   orbit replay <trace>             Re-run the recorded script with ZERO
 *                                    real channel calls, then reconcile the
 *                                    replayed chain against the original.
 *   orbit diff <a> <trace-b>         Compare two traces and locate the first
 *                                    digest-chain breakpoint.
 *
 * Zero third-party dependencies: only Node built-ins. The kernel is loaded
 * from the compiled CommonJS bundle via createRequire so the CLI works both
 * from the repo (node bin/orbit.mjs) and after `npm i -g`.
 *
 * Usage:
 *   orbit record <script.js> [--out trace.jsonl] [--config orbit.config.json]
 *   orbit replay <trace.jsonl> [--via script.js] [--config orbit.config.json]
 *   orbit diff <a.jsonl> <b.jsonl>
 *   orbit --version
 *   orbit help
 *
 * Every command accepts --json for machine-readable output.
 */

import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as fs from "node:fs";
import * as path from "node:path";

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PKG = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));

// Load the compiled kernel (CommonJS). Named exports are reachable through the
// default-import interop object.
const orbit = require("../dist/src/index.js");
const {
  OrbitRuntimeHost,
  ChannelKind,
  ReplayEngine,
  saveRecordJournal,
  loadRecordJournal,
  TraceFileInvalidError,
  OpenAICompatChannel,
  FileChannel,
  ShellChannel,
  digestInputs
} = orbit;

// ----------------------------------------------------------------- helpers

function out(obj) {
  process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
}

function fail(msg, code) {
  process.stderr.write(`orbit: ${msg}\n`);
  process.exitCode = code;
}

function isJsonFlag(v) {
  return v === true || v === "true";
}

/** Minimal argv parser: positionals + `--key value` / `--key=value` / `--flag`. */
function parseArgs(argv) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const key = a.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          flags[key] = next;
          i += 1;
        } else {
          flags[key] = true;
        }
      }
    } else {
      positionals.push(a);
    }
  }
  return { positionals, flags };
}

function mergeDeep(target, src) {
  if (typeof src !== "object" || src === null) return target;
  for (const k of Object.keys(src)) {
    const v = src[k];
    if (
      typeof v === "object" &&
      v !== null &&
      !Array.isArray(v) &&
      typeof target[k] === "object" &&
      target[k] !== null
    ) {
      mergeDeep(target[k], v);
    } else {
      target[k] = v;
    }
  }
  return target;
}

/** Drop secrets before persisting the config into a trace's meta file. */
function sanitizeConfig(cfg) {
  const clean = JSON.parse(JSON.stringify(cfg));
  if (clean.llm) delete clean.llm.apiKey;
  if (clean.shell) delete clean.shell.apiKey;
  return clean;
}

/**
 * Resolve the runtime configuration.
 * Priority (low -> high): built-in defaults < orbit.config.json < env vars.
 */
function loadConfig(configPath) {
  const base = {
    llm: { kind: "mock" },
    file: { enabled: false },
    shell: { enabled: false }
  };
  const file = configPath
    ? path.resolve(process.cwd(), configPath)
    : path.join(process.cwd(), "orbit.config.json");
  if (fs.existsSync(file)) {
    let userCfg;
    try {
      userCfg = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (err) {
      throw new Error(`invalid JSON in ${file}: ${err.message}`);
    }
    mergeDeep(base, userCfg || {});
  }

  if (process.env.ORBIT_LLM_BASE_URL) {
    base.llm = {
      kind: "openai-compat",
      baseUrl: process.env.ORBIT_LLM_BASE_URL,
      apiKey: process.env.ORBIT_LLM_API_KEY ?? "",
      model: process.env.ORBIT_LLM_MODEL ?? "deepseek-chat"
    };
  }
  if (process.env.ORBIT_FILE_ROOT) {
    base.file = { enabled: true, rootDir: process.env.ORBIT_FILE_ROOT };
  }
  if (process.env.ORBIT_SHELL_ALLOW) {
    base.shell = {
      enabled: true,
      allowedCommands: process.env.ORBIT_SHELL_ALLOW.split(",").map((s) => s.trim()).filter(Boolean),
      envAllowlist: process.env.ORBIT_SHELL_ENV
        ? process.env.ORBIT_SHELL_ENV.split(",").map((s) => s.trim()).filter(Boolean)
        : []
    };
  }
  return base;
}

/**
 * Assemble a kernel host from a config: register LLM / File / Shell channels
 * as requested, set them up, then boot the host (which wires built-ins).
 */
async function buildHost(config) {
  const host = new OrbitRuntimeHost();
  const hostCtx = { traceMarkId: `orbit-cli-${Date.now()}`, maxWaitMs: 30_000 };

  if (config.llm && config.llm.kind === "openai-compat") {
    const ch = new OpenAICompatChannel({
      apiKey: config.llm.apiKey ?? "",
      baseUrl: config.llm.baseUrl,
      model: config.llm.model
    });
    host.channelHub.registerPluginExtChannel(ChannelKind.LLM_ACCESS, ch);
    await ch.setup(hostCtx);
  }
  if (config.file && config.file.enabled) {
    const ch = new FileChannel({ rootDir: config.file.rootDir });
    host.channelHub.registerPluginExtChannel(ChannelKind.FILE_SYSTEM, ch);
    await ch.setup(hostCtx);
  }
  if (config.shell && config.shell.enabled) {
    const ch = new ShellChannel({
      allowedCommands: config.shell.allowedCommands,
      envAllowlist: config.shell.envAllowlist,
      workDir: config.shell.workDir,
      timeoutMs: config.shell.timeoutMs
    });
    host.channelHub.registerPluginExtChannel(ChannelKind.SHELL_EXEC, ch);
    await ch.setup(hostCtx);
  }

  await host.bootHost();
  return host;
}

/**
 * The context handed to a user script. `call` fires a channel method under the
 * current mode (record or replay); no pluginUnitId is set, so the capability
 * gate is skipped — CLI scripts are trusted host-level code. `llm.chat` is
 * sugar over the LLM channel.
 */
function makeScriptContext(host, replayMode) {
  let seq = 0;
  const call = (kind, funcName, ...args) => {
    const ctx = { traceMarkId: `orbit-cli-call-${seq++}`, maxWaitMs: 60_000, replayMode };
    return host.channelHub.fireChannelCall(kind, ctx, funcName, ...args);
  };
  return {
    host,
    hub: host.channelHub,
    ChannelKind,
    call,
    llm: {
      chat: (prompt, opts) => {
        const ctx = { traceMarkId: `orbit-cli-llm-${seq++}`, maxWaitMs: 60_000, replayMode };
        return host.channelHub.fireChannelCall(ChannelKind.LLM_ACCESS, ctx, "chatRound", prompt, opts);
      }
    }
  };
}

/** Import a user script and invoke its default-exported async function(ctx). */
async function runScript(scriptPath, ctx) {
  const abs = path.resolve(process.cwd(), scriptPath);
  let mod;
  try {
    mod = await import(pathToFileURL(abs).href);
  } catch (err) {
    throw new Error(
      `failed to load script ${scriptPath}: ${err.message}` +
        "\n(orbit CLI runs JavaScript modules only — compile TypeScript first, e.g. with tsx/tsc)"
    );
  }
  const fn = mod.default ?? mod;
  if (typeof fn !== "function") {
    throw new Error(`script ${scriptPath} must default-export an async function: export default async (ctx) => { ... }`);
  }
  return fn(ctx);
}

// ----------------------------------------------------------------- commands

async function cmdRecord(scriptPath, opts) {
  if (!scriptPath) {
    fail("record requires <script>", 2);
    return;
  }
  const config = loadConfig(opts.config);
  const host = await buildHost(config);
  const journal = host.beginRecording();
  const ctx = makeScriptContext(host, "record");
  const startedAt = Date.now();
  try {
    await runScript(scriptPath, ctx);
    const outPath = opts.out
      ? path.resolve(process.cwd(), opts.out)
      : path.resolve(process.cwd(), "orbit-trace.jsonl");
    const count = await saveRecordJournal(journal, outPath);
    const meta = {
      script: scriptPath,
      orbitVersion: PKG.version,
      nodeVersion: process.version,
      createdAt: new Date().toISOString(),
      recordCount: count,
      config: sanitizeConfig(config)
    };
    const metaPath = `${outPath}.meta.json`;
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    const ms = Date.now() - startedAt;
    if (isJsonFlag(opts.json)) {
      out({ ok: true, trace: outPath, meta: metaPath, calls: count, elapsedMs: ms });
    } else {
      process.stdout.write(
        `✓ recorded ${count} channel calls from ${scriptPath}\n` +
          `  trace : ${outPath}\n` +
          `  meta  : ${metaPath}\n` +
          `  took  : ${ms}ms\n`
      );
    }
  } finally {
    await host.shutdownHost();
  }
}

async function cmdReplay(tracePath, opts) {
  if (!tracePath) {
    fail("replay requires <trace>", 2);
    return;
  }
  const abs = path.resolve(process.cwd(), tracePath);
  let journal;
  try {
    journal = await loadRecordJournal(abs);
  } catch (err) {
    if (err instanceof TraceFileInvalidError) {
      fail(err.message, 2);
      return;
    }
    throw err;
  }

  const metaPath = `${abs}.meta.json`;
  let script = opts.via;
  let replayConfig = null;
  if (fs.existsSync(metaPath)) {
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    if (!script) script = meta.script;
    replayConfig = meta.config || null;
  }
  if (!script) {
    fail(`trace ${tracePath} has no driving script; re-run record or pass --via <script>`, 2);
    return;
  }

  const config = replayConfig || loadConfig(opts.config);
  const host = await buildHost(config);
  const replayJournal = host.beginRecording();
  host.attachReplayEngine(journal);
  const ctx = makeScriptContext(host, "replay");
  try {
    await runScript(script, ctx);
  } finally {
    await host.shutdownHost();
  }

  const report = new ReplayEngine(journal).reconcile(journal.snapshot(), replayJournal.snapshot());
  if (isJsonFlag(opts.json)) {
    out({ ok: report.digestChainConsistent, ...report });
  } else {
    process.stdout.write(
      `replay of ${tracePath}\n` +
        `  original calls : ${report.originalCount}\n` +
        `  replayed calls : ${report.replayedCount}\n`
    );
    if (report.digestChainConsistent) {
      process.stdout.write("  result         : ✓ VERIFIED — digest chain consistent\n");
    } else {
      process.stdout.write(`  result         : ✗ DRIFT at call #${report.driftAtOrderIndex}\n`);
      process.exitCode = 1;
    }
  }
}

async function cmdDiff(aPath, bPath, opts) {
  if (!aPath || !bPath) {
    fail("diff requires <a> <b>", 2);
    return;
  }
  const A = await loadRecordJournal(path.resolve(process.cwd(), aPath));
  const B = await loadRecordJournal(path.resolve(process.cwd(), bPath));
  const a = A.snapshot();
  const b = B.snapshot();
  const n = Math.min(a.length, b.length);

  let firstDrift = -1;
  let driftField = null;
  let driftA = null;
  let driftB = null;
  for (let i = 0; i < n; i += 1) {
    const x = a[i];
    const y = b[i];
    if (x.channelKind !== y.channelKind) {
      firstDrift = i; driftField = "channelKind"; driftA = x.channelKind; driftB = y.channelKind; break;
    }
    if (x.funcName !== y.funcName) {
      firstDrift = i; driftField = "funcName"; driftA = x.funcName; driftB = y.funcName; break;
    }
    if (x.inputDigest !== y.inputDigest) {
      firstDrift = i; driftField = "inputDigest"; driftA = x.inputDigest; driftB = y.inputDigest; break;
    }
    if (digestInputs(x.outputSnapshot) !== digestInputs(y.outputSnapshot)) {
      firstDrift = i; driftField = "outputSnapshot"; driftA = "(digest differs)"; driftB = "(digest differs)"; break;
    }
  }

  const consistent = firstDrift === -1;
  const report = {
    a: aPath,
    b: bPath,
    aCount: a.length,
    bCount: b.length,
    lengthMatch: a.length === b.length,
    firstDriftIndex: firstDrift,
    driftField,
    consistent
  };
  if (isJsonFlag(opts.json)) {
    out(report);
  } else {
    process.stdout.write(`diff ${aPath}  vs  ${bPath}\n  calls: a=${a.length} b=${b.length}\n`);
    if (consistent) {
      process.stdout.write("  result: ✓ identical call chains\n");
    } else {
      process.stdout.write(`  result: ✗ divergence at call #${firstDrift} (${driftField})\n`);
      process.stdout.write(`    a: ${driftA}\n`);
      process.stdout.write(`    b: ${driftB}\n`);
      process.exitCode = 1;
    }
  }
}

async function cmdAudit(tracePath, opts) {
  if (!tracePath) {
    fail("audit requires <trace.wal.jsonl>", 2);
    return;
  }
  const file = path.resolve(process.cwd(), tracePath);
  const journal = new orbit.PersistedTraceJournal(file);
  await journal.load();
  const entries = journal.snapshot();
  if (!opts.key) {
    const summary = {
      file,
      entries: entries.length,
      signed: false,
      note: "pass --key <hmac-key> to verify the chain signature"
    };
    if (isJsonFlag(opts.json)) {
      out(summary);
    } else {
      process.stdout.write(`audit ${file}\n  entries : ${entries.length}\n  signed  : no key given — pass --key to verify the chain\n`);
    }
    return;
  }
  const report = orbit.verifyAuditChain(entries, opts.key);
  if (isJsonFlag(opts.json)) {
    out({ file, ...report });
  } else {
    process.stdout.write(`audit ${file}\n  entries : ${report.total}\n  signed  : ${report.signed}\n`);
    if (report.consistent) {
      process.stdout.write("  result  : ✓ audit chain consistent (no tampering detected)\n");
    } else {
      process.stdout.write(`  result  : ✗ chain broken at entry #${report.brokenAt} — ${report.brokenReason}\n`);
      process.exitCode = 1;
    }
  }
}

async function cmdVerifyReport(reportPath, opts) {
  if (!reportPath) {
    fail("verify-report requires <report.json>", 2);
    return;
  }
  if (!opts["public-key"]) {
    fail("verify-report requires --public-key <pem|hex-seed>", 2);
    return;
  }
  const file = path.resolve(process.cwd(), reportPath);
  const report = JSON.parse(await fs.promises.readFile(file, "utf8"));
  // The public key may be a PEM file path, an inline PEM string, or the
  // operator's 32-byte hex seed (from which the public key is derived
  // deterministically).
  const keyArg = opts["public-key"];
  let publicKeyPem = keyArg;
  const looksLikePath = !keyArg.includes("-----BEGIN") && keyArg.includes(".");
  if (looksLikePath) {
    publicKeyPem = (await fs.promises.readFile(path.resolve(process.cwd(), keyArg), "utf8")).trim();
  }
  if (!publicKeyPem.includes("-----BEGIN")) {
    publicKeyPem = orbit.deriveReportKeyPair(publicKeyPem).publicKeyPem;
  }
  const result = orbit.verifyComplianceReport(report, publicKeyPem);
  if (isJsonFlag(opts.json)) {
    out({ file, ok: result.ok, reason: result.reason ?? null });
  } else if (result.ok) {
    process.stdout.write(`verify-report ${file}\n  result : ✓ signature valid (ed25519 · ${report.sig.publicKeyFingerprint})\n`);
  } else {
    process.stdout.write(`verify-report ${file}\n  result : ✗ ${result.reason}\n`);
    process.exitCode = 1;
  }
}

function printUsage() {
  process.stdout.write(
    `orbit ${PKG.version} — deterministic-replay CLI for Orbit Agent Runtime

Usage:
  orbit record <script.js> [--out trace.jsonl] [--config orbit.config.json]
  orbit replay <trace.jsonl> [--via script.js] [--config orbit.config.json]
  orbit diff <a.jsonl> <b.jsonl>
  orbit audit <trace.wal.jsonl> [--key <hmac-key>] [--json]
  orbit verify-report <report.json> --public-key <pem|hex-seed> [--json]
  orbit --version
  orbit help

Options:
  --out <path>     Output trace path for record (default: ./orbit-trace.jsonl)
  --via <script>   Driving script for replay (default: read from trace meta)
  --config <path>  Config file (default: ./orbit.config.json)
  --json           Machine-readable output

Script contract:
  export default async function (ctx) {
    const reply = await ctx.llm.chat("hello");
    const prev  = await ctx.call(ctx.ChannelKind.MEM_KV_STORE, "readEntry", "k");
    return { reply, prev };
  }

Config (orbit.config.json) — all keys optional:
  { "llm": { "kind": "mock" | "openai-compat", "baseUrl": "...", "model": "..." },
    "file": { "enabled": true, "rootDir": "./sandbox-fs" },
    "shell": { "enabled": true, "allowedCommands": ["node","echo"], "envAllowlist": ["PATH"] } }
  Env overrides: ORBIT_LLM_BASE_URL / ORBIT_LLM_API_KEY / ORBIT_LLM_MODEL,
                 ORBIT_FILE_ROOT, ORBIT_SHELL_ALLOW (csv) / ORBIT_SHELL_ENV (csv).
`
  );
}

// --------------------------------------------------------------------- entry

async function main() {
  const { positionals, flags } = parseArgs(process.argv.slice(2));
  const cmd = positionals.shift();
  const json = isJsonFlag(flags.json);

  try {
    switch (cmd) {
      case "record":
        await cmdRecord(positionals[0], { out: flags.out, config: flags.config, json });
        break;
      case "replay":
        await cmdReplay(positionals[0], { via: flags.via, config: flags.config, json });
        break;
      case "diff":
        await cmdDiff(positionals[0], positionals[1], { json });
        break;
      case "audit":
        await cmdAudit(positionals[0], { key: flags.key, json });
        break;
      case "verify-report":
        await cmdVerifyReport(positionals[0], { "public-key": flags["public-key"], json });
        break;
      case "help":
      case undefined:
        printUsage();
        break;
      case "--version":
      case "version":
        process.stdout.write(`${PKG.version}\n`);
        break;
      default:
        fail(`unknown command: ${cmd}`, 2);
        printUsage();
    }
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err), 1);
  }
}

main();
