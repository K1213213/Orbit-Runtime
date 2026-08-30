/**
 * CSS 覆盖门禁
 *
 * 背景：826c150 整体重构 styles.css 时，早期波次视图（pae/channels/graph/
 * replay/routing）引用的选择器未随之迁移，导致多页无样式；同时 .shell 的
 * display:grid 覆盖了 UA 的 [hidden]，登录页注册字段泄漏到登录态。
 *
 * 本测试固化两条门禁：
 *   1. 视图 el() 调用与 class= 模板里引用的类名，必须在 styles.css 有定义
 *      （动态模板表达式类名会因含 ${ 等字符被过滤器排除，属预期豁免）；
 *   2. [hidden] 与 .hidden 必须带 !important —— author 的 display 规则
 *      （.shell/.field 等）会压过 UA 样式表，隐藏语义必须显式收回。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, "..");
const css = readFileSync(join(webRoot, "public", "styles.css"), "utf8");

const definedClasses = new Set();
for (const m of css.matchAll(/\.([a-zA-Z][a-zA-Z0-9_-]+)/g)) definedClasses.add(m[1]);

test("[hidden] 规则带 !important（防止 .shell/.field 的 display 覆盖隐藏语义）", () => {
  assert.ok(/\[hidden\]\s*\{\s*display:\s*none\s*!important/.test(css), "styles.css 缺少 [hidden]{display:none!important}");
  assert.ok(/\.hidden\s*\{\s*display:\s*none\s*!important/.test(css), "styles.css 缺少 .hidden{display:none!important}");
});

test("视图引用的类名在 styles.css 均有定义（声明了就必须渲染得出来）", () => {
  const views = readdirSync(join(webRoot, "public", "views")).filter((f) => f.endsWith(".js"));
  assert.ok(views.length >= 15, `视图数量异常：${views.length}`);
  const missing = {};
  for (const f of views) {
    const js = readFileSync(join(webRoot, "public", "views", f), "utf8");
    const used = new Set();
    for (const m of js.matchAll(/el\([^,]{1,60},\s*["']([^"']+)["']/g))
      for (const c of m[1].split(/ +/)) if (c) used.add(c);
    for (const m of js.matchAll(/class=["']([^"']*)/g)) {
      if (m[1].includes("$") || m[1].includes("{")) continue; // 动态模板类名，豁免
      for (const c of m[1].split(/ +/)) if (c) used.add(c);
    }
    const miss = [...used].filter((c) => /^[a-z][a-zA-Z0-9_-]*$/.test(c) && !definedClasses.has(c));
    if (miss.length) missing[f] = miss.sort();
  }
  assert.deepEqual(missing, {}, "以下视图类名在 styles.css 中缺失（样式断层会导致页面裸奔）");
});

test("旧词表兼容令牌已就位（早期视图的 inline var(--coupler) 等不再落空）", () => {
  for (const token of ["--coupler", "--text-2", "--plasma", "--neuron", "--accent", "--purple"]) {
    assert.ok(css.includes(token + ":"), `兼容令牌 ${token} 未定义`);
  }
});
