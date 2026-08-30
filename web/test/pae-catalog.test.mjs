/**
 * PAE 目录与纯函数单测（无 DOM、无内核，直接在 Node 运行）。
 * 覆盖：文本转义、徽章渲染、保真度排序、模板完整性、describePaeTool 的
 * 覆盖与「诚实降级门禁」。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  esc,
  badge,
  FIDELITY_RANK,
  PAE_TEMPLATES,
  PAE_TEMPLATE_IDS,
  describePaeTool
} from "../public/lib.js";

test("esc 转义 HTML 特殊字符", () => {
  assert.equal(esc('<b>"x" & \'y\'</b>'), "&lt;b&gt;&quot;x&quot; &amp; 'y'&lt;/b&gt;");
  assert.equal(esc(null), "");
  assert.equal(esc(42), "42");
});

test("badge 渲染带 tone 的徽章", () => {
  assert.equal(badge("ok", "ok"), '<span class="badge ok">ok</span>');
  assert.equal(badge("x"), '<span class="badge neutral">x</span>');
});

test("FIDELITY_RANK 排序 full > reduced > lossy", () => {
  assert.ok(FIDELITY_RANK.full > FIDELITY_RANK.reduced);
  assert.ok(FIDELITY_RANK.reduced > FIDELITY_RANK.lossy);
});

test("PAE_TEMPLATES 每个模板字段完整且保真度合法", () => {
  const fid = ["full", "reduced", "lossy"];
  const det = ["deterministic", "stochastic", "io-bound"];
  for (const id of PAE_TEMPLATE_IDS) {
    const t = PAE_TEMPLATES[id];
    assert.ok(t.label && t.description, `模板 ${id} 缺 label/description`);
    assert.ok(fid.includes(t.fidelity), `模板 ${id} 保真度非法: ${t.fidelity}`);
    assert.ok(det.includes(t.determinism), `模板 ${id} 确定性非法: ${t.determinism}`);
    assert.ok(t.capability === "channel:read" || t.capability === "channel:write", `模板 ${id} 能力非法`);
  }
});

test("describePaeTool 默认 full 不携带 fidelityNote", () => {
  const d = describePaeTool("echo", "myEcho");
  assert.equal(d.name, "myEcho");
  assert.equal(d.fidelity, "full");
  assert.equal(d.fidelityNote, undefined);
  assert.equal(d.capability, "channel:read");
  assert.equal(d.determinism, "deterministic");
});

test("describePaeTool 覆盖 capability / determinism 生效", () => {
  const d = describePaeTool("echo", "w", { capability: "channel:write", determinism: "io-bound" });
  assert.equal(d.capability, "channel:write");
  assert.equal(d.determinism, "io-bound");
});

test("describePaeTool 诚实门禁：降级必须带 fidelityNote", () => {
  assert.throws(
    () => describePaeTool("echo", "bad", { fidelity: "reduced" }),
    /fidelityNote/
  );
  // 带上 note 则通过
  const d = describePaeTool("echo", "ok", { fidelity: "reduced", fidelityNote: "仅回显首行" });
  assert.equal(d.fidelity, "reduced");
  assert.equal(d.fidelityNote, "仅回显首行");
});

test("describePaeTool 未知模板抛错", () => {
  assert.throws(() => describePaeTool("nope", "x"), /unknown pae template/);
});
