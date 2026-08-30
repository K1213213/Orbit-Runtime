import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * View reference gate — every identifier a view CALLS must be defined in the
 * same module or imported.
 *
 * The console views are plain ES modules with zero bundler: a view that calls
 * a helper it neither defines nor imports dies at runtime with
 * `ReferenceError: X is not defined` (the settings-page `field` crash was
 * exactly this class). This gate scans every `web/public/views/*.js` and fails
 * if any called identifier is not locally defined, not imported, and not a
 * known browser/JS global.
 *
 * Like `missingRenderers` and `css-coverage`, the gate exists because the
 * failure mode is silent until a user navigates to the broken view.
 */

const VIEWS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "views");

/** JS keywords that are call-shaped but not identifiers. */
const KEYWORDS = new Set(
  "break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof new null return static super switch this throw true try typeof var void while with yield async await of get set let".split(" ")
);

/**
 * Browser / platform globals the views may call. Anything else must be defined
 * in-file or imported — that is the entire point of the gate.
 */
const GLOBALS = new Set(
  [
    // timer
    "setTimeout", "clearTimeout", "setInterval", "clearInterval", "setImmediate", "clearImmediate", "requestAnimationFrame", "cancelAnimationFrame",
    // structures / coercion
    "Array", "Object", "String", "Number", "Boolean", "Date", "Map", "Set", "WeakMap", "WeakSet", "Promise", "Symbol", "BigInt", "Math", "JSON", "RegExp", "Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError", "URIError", "parseInt", "parseFloat", "isNaN", "isFinite", "encodeURI", "encodeURIComponent", "decodeURI", "decodeURIComponent", "structuredClone",
    // browser APIs
    "fetch", "URL", "URLSearchParams", "Blob", "File", "FileReader", "FormData", "AbortController", "AbortSignal", "TextDecoder", "TextEncoder", "atob", "btoa", "crypto", "localStorage", "sessionStorage", "navigator", "location", "history", "window", "document", "console", "performance", "customElements", "requestIdleCallback", "cancelIdleCallback", "queueMicrotask",
    // typed arrays
    "Uint8Array", "Uint16Array", "Uint32Array", "Int8Array", "Int16Array", "Int32Array", "Float32Array", "Float64Array", "ArrayBuffer", "DataView"
  ].sort()
);

/**
 * Names that look like calls but are never JS: CSS functions inside template
 * attribute values (`rgba(...)`, `url(...)`) and regex character-class
 * internals (`BT` in /BT(...)ET/g, `nrtbf` in [nrtbf()\\]). Allowed only
 * because the gate already verified they never occur as standalone calls in
 * executable positions elsewhere.
 */
const NON_JS_CALLS = new Set(["rgba", "url", "BT", "nrtbf"]);

/** Strip comments, string literals and non-interpolated template text. */
function stripNoise(src) {
  let code = src;
  code = code.replace(/\/\/[^\n]*/g, "");
  code = code.replace(/\/\*[\s\S]*?\*\//g, "");
  code = code.replace(/(['"])(?:(?!\1)[^\\]|\\.)*\1/g, "");
  // Backtick templates: keep only ${...} interpolations (real code), drop the rest.
  code = code.replace(/`(?:\\.|[^`\\]|\$\{[^}]*\})*`/g, (m) => {
    const segs = [...m.matchAll(/\$\{([^}]*)\}/g)].map((x) => x[1]);
    return segs.join("\n");
  });
  return code;
}

/** Identifiers this file defines (function/class/const/let/var/imports/params). */
function collectDefined(src) {
  const defined = new Set();
  for (const m of src.matchAll(/(?:function|class)\s+([A-Za-z_$][\w$]*)/g)) defined.add(m[1]);
  for (const m of src.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g)) defined.add(m[1]);
  // named import { a, b as c } and default import d from
  for (const m of src.matchAll(/import\s*\{([^}]+)\}\s*from/g)) {
    for (const n of m[1].split(",")) {
      const name = n.trim().split(/\s+as\s+/)[0].trim();
      if (name) defined.add(name);
    }
  }
  for (const m of src.matchAll(/import\s+([A-Za-z_$][\w$]*)\s*[,{]/g)) defined.add(m[1]);
  // object-method shorthand `name(...) { ... }` is a definition
  for (const m of src.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/g)) defined.add(m[1]);
  // function / arrow parameters, including destructured `{ a, b }` / `[a]`
  for (const m of src.matchAll(/function\s+\w+\s*\(([^)]*)\)/g)) addParams(defined, m[1]);
  for (const m of src.matchAll(/(?:async\s*)?\(([^)]*)\)\s*=>/g)) addParams(defined, m[1]);
  for (const m of src.matchAll(/(?:async\s*)?([A-Za-z_$][\w$]*)\s*=>/g)) defined.add(m[1]);
  return defined;
}

function addParams(defined, paramList) {
  // The capture can include a leading '(' when a call wraps the arrow
  // (e.g. `new Promise((resolve, reject) =>`), so strip it before splitting.
  const cleaned = paramList.replace(/^\(/, "").trim();
  for (const raw of cleaned.split(",")) {
    const p = raw.trim();
    if (!p) continue;
    if (p.startsWith("{")) {
      for (const inner of p.replace(/^\{/, "").replace(/\}$/, "").split(",")) {
        const name = inner.trim().split(":")[1] ?? inner.trim();
        const plain = name.split("=")[0].trim();
        if (/^[A-Za-z_$][\w$]*$/.test(plain)) defined.add(plain);
      }
      continue;
    }
    const plain = p.replace(/^\.\.\./, "").split("=")[0].trim();
    if (/^[A-Za-z_$][\w$]*$/.test(plain)) defined.add(plain);
  }
}

test("view refs: every called identifier is defined, imported or a global", () => {
  const files = readdirSync(VIEWS_DIR).filter((f) => f.endsWith(".js"));
  assert.ok(files.length >= 10, `expected view modules, found ${files.length}`);
  const problems = [];
  for (const file of files) {
    const src = readFileSync(join(VIEWS_DIR, file), "utf8");
    const code = stripNoise(src);
    const defined = collectDefined(src);
    const calls = new Set();
    for (const m of code.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
      const name = m[1];
      if (KEYWORDS.has(name)) continue;
      if (NON_JS_CALLS.has(name)) continue;
      // method-shorthand definition `name(...) {` is not a call
      if (/^\s*\([^)]*\)\s*\{/.test(code.slice(m.index + m[0].length - 1))) continue;
      // only flag names that occur as `name(` in the ORIGINAL source — the
      // stripper can concatenate HTML attribute text into fake identifiers.
      if (!src.includes(`${name}(`)) continue;
      if (!defined.has(name) && !GLOBALS.has(name)) calls.add(name);
    }
    if (calls.size > 0) {
      problems.push(`${file}: undefined call(s): ${[...calls].sort().join(", ")}`);
    }
  }
  assert.deepEqual(problems, [], "every called identifier must be defined or imported");
});

test("badge() 字符串不得直接 append（会按文本渲染露出 <span> 原文，须用 badgeEl）", () => {
  const files = readdirSync(VIEWS_DIR).filter((f) => f.endsWith(".js"));
  const problems = [];
  for (const file of files) {
    const src = readFileSync(join(VIEWS_DIR, file), "utf8");
    // append( 之后直接出现 badge( 且中间没有 el( 包裹（el 的 innerHTML 场景合法）
    for (const m of src.matchAll(/\.append\(\s*((?!el\()[^)]*?)badge\(/g)) {
      problems.push(`${file}: append(${m[1].trim().slice(0, 40)}badge(…) — 字符串被当文本渲染，改用 badgeEl()`);
    }
  }
  assert.deepEqual(problems, [], "badge 字符串直接 append 会把标签原文显示出来");
});
