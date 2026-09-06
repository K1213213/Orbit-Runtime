/**
 * Example 6 — the full lifecycle of one governed agent run, end to end.
 *
 * This is the "complete flow" demo: everything a production deployment goes
 * through, in one script, against the STRICT governance tier:
 *
 *   boot (WAL-persisted + audit-signed)          — 可证明的地基
 *   → governed capability calls (recorded)       — 可核算
 *   → audit chain verification (PASS)           — 链证轨迹
 *   → replay with ZERO channel calls            — 可复现
 *   → drift detection (tampered input rejected)
 *   → process restart → WAL recovery            — 崩溃安全
 *   → compliance report + ED25519 signature     — 可交付的证明
 *
 * Run: node examples/full-lifecycle.mjs
 *
 * For npm consumers the imports become
 *   import { OrbitRuntimeHost, ChannelKind, ... } from "orbit-runtime";
 */
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  OrbitRuntimeHost,
  ChannelKind,
  ReplayEngine,
  makeUniqueMark,
  DeterminismLevel,
  deriveReportKeyPair,
  signComplianceReport,
  verifyComplianceReport
} from "../dist/src/index.js";

/* ------------------------------------------------------------------ setup */

// strict 档的构造期硬约束：必须给 traceJournalPath（持久化）与 auditSigningKey（签名）。
// 给错配置它会在构造期就拒绝启动——治理不靠自觉。
const AUDIT_KEY = "demo-audit-key-0001";
// 报告签名种子：64 个 hex 字符（32 字节）。同一个种子永远派生同一对密钥。
const REPORT_SEED = "0f1e2d3c4b5a69788796a5b4c3d2e1f000112233445566778899aabbccddeeff";

/** A deterministic "summarizer" channel: joins words with a dash. */
class DashJoinChannel {
  determinismMeta = { determinism: DeterminismLevel.DETERMINISTIC, replayPolicy: "inject" };

  async setup() {}
  async teardown() {}

  /** The only surface: ["hello","orbit"] -> "hello-orbit". */
  async join(words) {
    return words.join("-");
  }
}

const PACT = {
  id: "demo.lifecycle",
  displayName: "Lifecycle Demo",
  edition: "1.0.0",
  requireHostMinEdition: "1.0.0",
  allowCapabilities: ["channel:read"],
  schema: { type: "object", properties: {} }
};

function must(cond, message) {
  if (!cond) {
    console.error(`FAIL: ${message}`);
    process.exit(1);
  }
}

async function main() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-lifecycle-"));
  const tracePath = path.join(dir, "trace.wal.jsonl");
  const recordPath = path.join(dir, "record.wal.jsonl");

  console.log("=== example 6 · full lifecycle (strict tier, end to end) ===");
  console.log(`[state ] temp dir: ${dir}`);

  /* ------------------------------------------------ 1. boot the governed host */

  const host = new OrbitRuntimeHost({
    governanceProfile: "strict",
    auditSigningKey: AUDIT_KEY,
    traceJournalPath: tracePath,
    recordJournalPath: recordPath
  });
  await host.bootHost();
  host.channelHub.registerPluginExtChannel(ChannelKind.LLM_ACCESS, new DashJoinChannel());
  host.registerPlugin(PACT);
  console.log("[boot  ] strict host: trace durability required, audit chain signed");

  const ctx = { traceMarkId: makeUniqueMark(), pluginUnitId: PACT.id, maxWaitMs: 5000 };
  const call = (mode, words) =>
    host.capabilityInvoke({
      kind: ChannelKind.LLM_ACCESS,
      pluginId: PACT.id,
      funcName: "join",
      args: [words],
      mode,
      ctx
    });

  /* --------------------------------------- 2. record a governed agent session */

  const journal = host.beginRecording();
  const session = [
    ["hello", "orbit"],
    ["record", "then", "replay"],
    ["byte", "identical"],
    ["audit", "chain"]
  ];
  const liveOutputs = [];
  for (const words of session) {
    liveOutputs.push(await call("record", words));
    // 治理事件随每次调用落审计：这条 append 走的是与宿主内核完全相同的
    // journal 管道（HMAC 链在 append 时自动织入）。
    host.traceJournal.append({
      entryClass: "CAPABILITY",
      traceMarkId: ctx.traceMarkId,
      factPayload: { pluginId: PACT.id, funcName: "join", args: words, mode: "record" }
    });
  }
  console.log(`[record] ${journal.size()} governed calls journaled`);
  must(journal.size() === session.length, "every recorded call must be journaled");

  /* ------------------------------------------ 3. verify the audit hash chain */

  const chain = host.verifyAuditChain();
  console.log(
    `[audit ] entries=${chain.total} signed=${chain.signed} consistent=${chain.consistent}`
  );
  must(chain.consistent && chain.signed, "the audit chain must verify PASS while signed");

  /* ------------------------------ 4. replay: zero channel calls, no drift */

  host.attachReplayEngine(new ReplayEngine(journal));
  for (let i = 0; i < session.length; i += 1) {
    const replayed = await call("replay", session[i]);
    must(
      replayed === liveOutputs[i],
      `replay output drifted at call #${i}: ${replayed} !== ${liveOutputs[i]}`
    );
  }
  console.log(`[replay] ${session.length}/${session.length} outputs byte-identical (zero channel calls)`);

  // Drift detection: change the input of the next call — the gateway rejects it.
  try {
    await call("replay", ["tampered", "input"]);
    must(false, "a drifted replay call was not rejected");
  } catch (err) {
    console.log(`[drift ] tampered input rejected: ${err.constructor.name}`);
  }

  /* --------------------------------- 5. restart: the WAL survives the process */

  const liveEntries = host.traceJournal.snapshot();
  const recorded = journal.snapshot();
  await host.shutdownHost();
  console.log(`[down  ] host shut down; ${liveEntries.length} audit entries live in the WAL`);

  const revived = new OrbitRuntimeHost({
    governanceProfile: "strict",
    auditSigningKey: AUDIT_KEY,
    traceJournalPath: tracePath,
    recordJournalPath: recordPath
  });
  await revived.bootHost();
  const recovered = revived.traceJournal.snapshot();
  must(
    JSON.stringify(recovered) === JSON.stringify(liveEntries),
    "recovered audit entries must equal the pre-shutdown snapshot"
  );
  const resumed = revived.currentRecordJournal();
  must(resumed && resumed.size() === recorded.length, "the record window must resume, not restart");
  console.log(`[recover] audit trail + record window recovered across the restart`);

  const chainAfterRestart = revived.verifyAuditChain();
  must(chainAfterRestart.consistent, "recovered chain must still verify");
  console.log(
    `[audit ] post-restart: entries=${chainAfterRestart.total} consistent=${chainAfterRestart.consistent}`
  );
  await revived.shutdownHost();

  /* ------------------------------- 6. compliance report + ED25519 signature */

  // buildComplianceReport lives in the console's lib (DOM-free); the kernel
  // surface here is the signed envelope: sign with the seed, verify with the
  // public key — a third party needs nothing else.
  const report = {
    meta: { product: "Orbit Runtime", version: "0.12.0", generatedAt: "2026-09-06T09:00:00.000Z" },
    governance: {
      tier: "Strict（合规）",
      profile: "strict",
      traceDurability: "required",
      auditSigning: "HMAC chain",
      maxIsolationLevel: "L1",
      schemaMode: "required"
    },
    audit: { entries: chain.total, signed: chain.signed, consistent: chain.consistent, status: "PASS" },
    determinism: { recorded: session.length, replayed: session.length, byteIdentical: true },
    summary: "审计链完整且已签名；录制窗口零漂移重放"
  };

  const signed = signComplianceReport(report, REPORT_SEED);
  const { publicKeyPem } = deriveReportKeyPair(REPORT_SEED);
  console.log(`[report] signature=${signed.sig.algorithm} fingerprint=${signed.sig.publicKeyFingerprint.slice(0, 16)}…`);

  const ok = verifyComplianceReport(signed, publicKeyPem);
  must(ok.ok, "the genuine signed report must verify");
  console.log(`[verify] third-party verification with the public key: ok=${ok.ok}`);

  // Tamper with the report body AFTER signing — verification must break.
  const tampered = {
    ...signed,
    audit: { ...signed.audit, entries: 999999 }
  };
  const broken = verifyComplianceReport(tampered, publicKeyPem);
  must(!broken.ok, "a tampered report body must fail verification");
  console.log(`[tamper] mutated report rejected: ${broken.reason}`);

  // A third party holding the WRONG public key cannot pass the check —
  // no seed, no host, no journal access changes that.
  const wrongKeyPem = deriveReportKeyPair(
    "ff".repeat(32).replace(/^ff/, "fe")
  ).publicKeyPem;
  const wrongKey = verifyComplianceReport(signed, wrongKeyPem);
  must(!wrongKey.ok, "the wrong public key must fail verification");
  console.log(`[offline] wrong public key rejected: ${wrongKey.reason}`);

  await fs.rm(dir, { recursive: true, force: true });
  console.log("\nOK — boot → record → audit → replay → restart → signed report, all gates passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
