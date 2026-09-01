/**
 * W30 — audit hash chain (anti-tamper audit trail) end to end.
 *
 * The chain turns the append-only audit file into a tamper-evident one: any
 * edit to any entry breaks the chain AT that entry and everything after.
 * Without a signing key the journal records no chain fields at all — the
 * pre-W30 behaviour, byte for byte (backward-compat rule).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  OrbitRuntimeHost,
  TraceJournal,
  PersistedTraceJournal,
  ChannelKind,
  verifyAuditChain,
  chainFieldsOf,
  firstChainHash,
  auditChainHash,
  chainTailOf,
  AUDIT_GENESIS_HASH
} from "../src/index";

const KEY = "test-audit-key-0001";

function entry(overrides: Partial<Parameters<typeof chainFieldsOf>[2]> = {}): Parameters<typeof chainFieldsOf>[2] {
  return {
    entryUid: "uid-1",
    entryClass: "TEST",
    occurredAt: 1,
    traceMarkId: "t-1",
    factPayload: { k: "v" },
    ...overrides
  };
}

/* ---------------------------------------------------------- pure functions */

test("audit chain: a well-formed chain verifies as consistent and signed", () => {
  const e1 = entry({ entryUid: "a", occurredAt: 1 });
  const e2 = entry({ entryUid: "b", occurredAt: 2, factPayload: { n: 2 } });
  const a1 = chainFieldsOf(KEY, firstChainHash(KEY), e1);
  e1.prevHash = a1.prevHash;
  e1.chainHash = a1.chainHash;
  const a2 = chainFieldsOf(KEY, e1.chainHash!, e2);
  e2.prevHash = a2.prevHash;
  e2.chainHash = a2.chainHash;

  const report = verifyAuditChain([e1, e2], KEY);
  assert.equal(report.consistent, true);
  assert.equal(report.signed, true);
  assert.equal(report.total, 2);
  assert.notEqual(e1.chainHash, e2.chainHash);
  assert.equal(e2.prevHash, e1.chainHash, "the chain links consecutively");
});

test("audit chain: tampering with entry content is located at that index", () => {
  const e1 = entry({ entryUid: "a" });
  const e2 = entry({ entryUid: "b" });
  const e3 = entry({ entryUid: "c" });
  let prev = firstChainHash(KEY);
  for (const e of [e1, e2, e3]) {
    const f = chainFieldsOf(KEY, prev, e);
    e.prevHash = f.prevHash;
    e.chainHash = f.chainHash;
    prev = f.chainHash;
  }
  // Tamper with the middle entry's payload.
  e2.factPayload = { k: "EVIL" };
  const report = verifyAuditChain([e1, e2, e3], KEY);
  assert.equal(report.consistent, false);
  assert.equal(report.brokenAt, 1, "the tampered entry itself is the break point");
  assert.match(report.brokenReason ?? "", /chainHash/);
});

test("audit chain: deleting an interior entry breaks the link after it", () => {
  const e1 = entry({ entryUid: "a" });
  const e2 = entry({ entryUid: "b" });
  const e3 = entry({ entryUid: "c" });
  let prev = firstChainHash(KEY);
  for (const e of [e1, e2, e3]) {
    const f = chainFieldsOf(KEY, prev, e);
    e.prevHash = f.prevHash;
    e.chainHash = f.chainHash;
    prev = f.chainHash;
  }
  const report = verifyAuditChain([e1, e3], KEY);
  assert.equal(report.consistent, false);
  assert.equal(report.brokenAt, 1, "the survivor's prevHash no longer matches e1's chainHash");
});

test("audit chain: wrong key fails verification (the signature half)", () => {
  const e = entry({ entryUid: "a" });
  const f = chainFieldsOf(KEY, firstChainHash(KEY), e);
  e.prevHash = f.prevHash;
  e.chainHash = f.chainHash;
  const report = verifyAuditChain([e], "wrong-key");
  assert.equal(report.consistent, false);
  assert.match(report.brokenReason ?? "", /prevHash/);
});

test("audit chain: unsigned journals are vacuously consistent, not signed", () => {
  assert.equal(verifyAuditChain([], KEY).signed, false);
  const bare = entry();
  assert.equal(verifyAuditChain([bare], KEY).signed, false);
  assert.equal(verifyAuditChain([bare], KEY).consistent, true);
});

test("audit chain: a mixed chain (some entries unsigned) is a fault", () => {
  const e1 = entry({ entryUid: "a" });
  const e2 = entry({ entryUid: "b" }); // no chain fields
  const f = chainFieldsOf(KEY, firstChainHash(KEY), e1);
  e1.prevHash = f.prevHash;
  e1.chainHash = f.chainHash;
  const report = verifyAuditChain([e1, e2], KEY);
  assert.equal(report.consistent, false);
  assert.equal(report.brokenAt, 1);
  assert.match(report.brokenReason ?? "", /unsigned/);
});

test("audit chain: hash is deterministic and chain-order dependent", () => {
  const e = entry();
  const f1 = chainFieldsOf(KEY, firstChainHash(KEY), e);
  const f2 = chainFieldsOf(KEY, firstChainHash(KEY), e);
  assert.equal(f1.chainHash, f2.chainHash, "same key + entry + predecessor -> same hash");
  const f3 = chainFieldsOf(KEY, "other-prev", e);
  assert.notEqual(f1.chainHash, f3.chainHash, "a different predecessor changes the hash");
  assert.equal(chainTailOf([]), null);
  assert.equal(chainTailOf([{ ...e, chainHash: "tail" }]), "tail");
});

/* -------------------------------------------------------------- journal level */

test("audit chain: a keyed journal chains every append and rebuilds the tail on restore", () => {
  const j = new TraceJournal(KEY);
  const a = j.append({ entryClass: "A", traceMarkId: "t", factPayload: {} });
  const b = j.append({ entryClass: "B", traceMarkId: "t", factPayload: {} });
  assert.ok(a.chainHash && a.prevHash);
  assert.equal(b.prevHash, a.chainHash, "second entry links from the first");
  assert.equal(verifyAuditChain(j.snapshot(), KEY).consistent, true);

  // Restore (as recovery does) and append: the chain continues, not restarts.
  const j2 = new TraceJournal(KEY);
  j2.restoreSnapshot(j.snapshot());
  const c = j2.append({ entryClass: "C", traceMarkId: "t", factPayload: {} });
  assert.equal(c.prevHash, b.chainHash, "post-restore append links from the restored tail");
  assert.equal(verifyAuditChain(j2.snapshot(), KEY).consistent, true);
});

test("audit chain: an unsigned journal records no chain fields (pre-W30 byte-for-byte)", () => {
  const j = new TraceJournal();
  const e = j.append({ entryClass: "A", traceMarkId: "t", factPayload: {} });
  assert.ok(!("chainHash" in e) && !("prevHash" in e));
});

/* ------------------------------------------------------------------ host level */

test("audit chain: a keyed host appends chained audit entries and verifies clean", async () => {
  const host = new OrbitRuntimeHost({ auditSigningKey: KEY });
  await host.bootHost();
  // Host normal paths append audit entries through the journal; drive a few
  // directly to exercise the same append -> chain pipeline the host uses.
  host.traceJournal.append({ entryClass: "AUDIT", traceMarkId: "t-audit", factPayload: { action: "a" } });
  host.traceJournal.append({ entryClass: "AUDIT", traceMarkId: "t-audit", factPayload: { action: "b" } });
  const report = host.verifyAuditChain();
  assert.equal(report.consistent, true);
  assert.equal(report.signed, true);
  assert.ok(report.total >= 2);
  await host.shutdownHost();
});

test("audit chain: host without a key verifies as unsigned", async () => {
  const host = new OrbitRuntimeHost();
  await host.bootHost();
  const report = host.verifyAuditChain();
  assert.equal(report.consistent, true);
  assert.equal(report.signed, false);
  await host.shutdownHost();
});

test("audit chain: injecting a tampered entry is detected by host verification", async () => {
  const host = new OrbitRuntimeHost({ auditSigningKey: KEY });
  await host.bootHost();
  host.registerPlugin({
    id: "audit.tamper",
    displayName: "Audit",
    edition: "1.0.0",
    requireHostMinEdition: "1.0.0",
    allowCapabilities: ["channel:read"]
  });
  host.traceJournal.append({ entryClass: "AUDIT", traceMarkId: "t-tamper", factPayload: { action: "original" } });
  // Simulate a disk-level edit: restore a snapshot with a doctored entry.
  const tampered = host.traceJournal.entries();
  tampered[0].factPayload = { evil: true };
  host.traceJournal.restoreSnapshot(tampered);
  const report = host.verifyAuditChain();
  assert.equal(report.consistent, false);
  assert.equal(report.brokenAt, 0);
  await host.shutdownHost();
});

test("audit chain: strict tier requires the signing key", () => {
  assert.throws(
    () =>
      new OrbitRuntimeHost({
        governanceProfile: "strict",
        traceJournalPath: "./dist-test-audit-strict.wal"
      }),
    /requires auditSigningKey/
  );
});

test("audit chain: strict tier refuses to boot on a broken chain", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-audit-strict-"));
  const tracePath = path.join(root, "trace.wal.jsonl");

  // Run 1: write a signed, durable audit trail (at least one entry).
  const good = new OrbitRuntimeHost({ auditSigningKey: KEY, traceJournalPath: tracePath });
  await good.bootHost();
  good.traceJournal.append({ entryClass: "AUDIT", traceMarkId: "t-seed", factPayload: { action: "seed" } });
  await good.shutdownHost();

  // Tamper the WAL directly (the threat model: an editor with file access).
  const text = await fs.readFile(tracePath, "utf8");
  const lines = text.trim().split("\n");
  assert.ok(lines.length >= 1);
  const doctored = lines.map((line, i) => {
    if (i === 0) {
      const obj = JSON.parse(line);
      obj.factPayload = { evil: true };
      return JSON.stringify(obj);
    }
    return line;
  });
  await fs.writeFile(tracePath, doctored.join("\n"), "utf8");

  // Run 2: strict must refuse to boot on the broken chain.
  await assert.rejects(
    (async () => {
      const bad = new OrbitRuntimeHost({
        governanceProfile: "strict",
        auditSigningKey: KEY,
        traceJournalPath: tracePath
      });
      await bad.bootHost();
    })(),
    /audit chain broken/
  );
  await fs.rm(root, { recursive: true, force: true });
});

test("audit chain: signed chain survives persistence + recovery + append (cross-process)", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-audit-persist-"));
  const tracePath = path.join(root, "trace.wal.jsonl");

  // "Process 1": signed durable audit trail, one entry, clean shutdown.
  const p1 = new OrbitRuntimeHost({ auditSigningKey: KEY, traceJournalPath: tracePath });
  await p1.bootHost();
  p1.traceJournal.append({ entryClass: "AUDIT", traceMarkId: "t-p1", factPayload: { action: "seed" } });
  await p1.shutdownHost();

  // "Process 2": recover, append one more, verify the whole chain.
  const p2 = new OrbitRuntimeHost({ auditSigningKey: KEY, traceJournalPath: tracePath });
  await p2.bootHost();
  p2.registerPlugin({
    id: "audit.persist",
    displayName: "Audit",
    edition: "1.0.0",
    requireHostMinEdition: "1.0.0",
    allowCapabilities: ["channel:read"]
  });
  const ctx = { traceMarkId: "t-persist", maxWaitMs: 5000, pluginUnitId: "audit.persist" };
  await p2.capabilityInvoke({
    kind: ChannelKind.MEM_KV_STORE,
    pluginId: "audit.persist",
    funcName: "readEntry",
    args: ["k"],
    mode: "record",
    ctx
  });
  const report = p2.verifyAuditChain();
  assert.equal(report.consistent, true, "recovered + appended chain still verifies");
  assert.equal(report.signed, true);
  await p2.shutdownHost();
  await fs.rm(root, { recursive: true, force: true });
});
