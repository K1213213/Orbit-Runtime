/**
 * build-site.mjs — docsite generator (W34).
 *
 * Reads docs/*.md + README.md + docs/blog/*.md, renders each through the
 * zero-dependency renderer, wraps them in a shared Bio-Lineage themed layout,
 * and writes static HTML to site/. Pure tooling — nothing here ships in the
 * npm package or runs in the kernel.
 */
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { join, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { renderMarkdown, escapeHtml } from "./render-md.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SITE = join(ROOT, "site");

const THEME_CSS = `
:root {
  --bg: #0b1017; --surface: #121a26; --surface-2: #0f1620; --ink: #dfe7ef; --muted: #8fa0b3;
  --gene: #3cf2a8; --plasma: #39e6ff; --neural: #b78bff; --adapter: #ff9d4d; --scarlet: #ff5c7a;
  --line: #223048; --accent: #39e6ff;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink);
  font: 15px/1.7 "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
.layout { display: flex; min-height: 100vh; }
nav { width: 232px; flex: none; background: var(--surface-2); border-right: 1px solid var(--line);
  padding: 22px 14px; position: sticky; top: 0; height: 100vh; overflow: auto; }
nav .brand { font-weight: 700; font-size: 15px; letter-spacing: 0.02em; margin-bottom: 2px; }
nav .brand span { color: var(--gene); }
nav .ver { color: var(--muted); font-size: 11px; margin-bottom: 14px; }
nav a { display: block; color: var(--ink); text-decoration: none; padding: 5px 9px; border-radius: 7px;
  font-size: 13px; }
nav a:hover, nav a.on { background: var(--surface); color: var(--gene); }
nav .grp { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em;
  margin: 12px 8px 4px; }
main { flex: 1; min-width: 0; padding: 34px 44px 80px; max-width: 980px; }
h1 { font-size: 26px; border-bottom: 1px solid var(--line); padding-bottom: 10px; }
h2 { font-size: 20px; margin-top: 34px; color: var(--plasma); }
h3 { font-size: 16px; margin-top: 26px; color: var(--neural); }
h4 { font-size: 14px; }
a { color: var(--accent); }
code { background: var(--surface); border: 1px solid var(--line); border-radius: 4px; padding: 1px 5px;
  font: 12px/1.5 "Cascadia Code", Consolas, monospace; }
pre { background: var(--surface-2); border: 1px solid var(--line); border-radius: 8px; padding: 12px 14px;
  overflow: auto; }
pre code { background: none; border: none; padding: 0; }
blockquote { margin: 10px 0; padding: 2px 14px; border-left: 3px solid var(--gene); background: rgba(60,242,168,.06);
  border-radius: 0 6px 6px 0; color: var(--muted); }
table { border-collapse: collapse; width: 100%; margin: 12px 0; font-size: 13px; }
th, td { border: 1px solid var(--line); padding: 6px 10px; text-align: left; }
th { background: var(--surface); }
tr:nth-child(even) td { background: rgba(18,26,38,.5); }
.tbl-wrap { overflow-x: auto; }
hr { border: none; border-top: 1px solid var(--line); margin: 22px 0; }
strong { color: #fff; }
ul, ol { padding-left: 22px; }
.hero { padding: 26px 0 6px; }
.hero h1 { border: none; font-size: 34px; }
.hero .tag { color: var(--gene); font-weight: 700; letter-spacing: 0.06em; font-size: 13px; }
.badges { margin: 12px 0; }
.badges span { display: inline-block; border: 1px solid var(--line); border-radius: 999px; padding: 2px 12px;
  font-size: 12px; margin-right: 6px; color: var(--muted); }
`;

function layout(title, bodyHtml, navHtml) {
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · Orbit Agent Runtime</title>
<style>${THEME_CSS}</style></head>
<body><div class="layout">${navHtml}<main><article>${bodyHtml}</article></main></div></body></html>`;
}

function navHtml(pages, active) {
  const groups = [
    ["产品", ["index", "guide"]],
    ["架构", ["VISION", "architecture", "UPGRADE_PLAN"]],
    ["路线", ["PRODUCT_PLAN", "DEV_PLAN", "CHANGELOG"]],
    ["博客", ["blog/why-agent-bugs-unreproducible"]]
  ];
  const seen = new Set();
  let out = `<nav><div class="brand">Orbit <span>Runtime</span></div><div class="ver">v0.10.0 · Apache-2.0</div>`;
  for (const [grp, ids] of groups) {
    out += `<div class="grp">${grp}</div>`;
    for (const id of ids) {
      const p = pages.find((x) => x.id === id);
      if (!p) continue;
      seen.add(id);
      out += `<a class="${id === active ? "on" : ""}" href="${p.href}">${escapeHtml(p.label)}</a>`;
    }
  }
  out += `</nav>`;
  return out;
}

async function main() {
  const version = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8")).version;
  const docs = [
    { id: "index", file: "README.md", label: "产品首页" },
    { id: "guide", file: "docs/guide.md", label: "开发者指南" },
    { id: "VISION", file: "docs/VISION.md", label: "架构宪章" },
    { id: "architecture", file: "docs/architecture.md", label: "内核设计" },
    { id: "UPGRADE_PLAN", file: "docs/UPGRADE_PLAN.md", label: "升级方案" },
    { id: "PRODUCT_PLAN", file: "docs/PRODUCT_PLAN.md", label: "产品计划" },
    { id: "DEV_PLAN", file: "docs/DEV_PLAN.md", label: "开发计划" },
    { id: "CHANGELOG", file: "CHANGELOG.md", label: "变更日志" },
    { id: "blog/why-agent-bugs-unreproducible", file: "docs/blog/why-agent-bugs-unreproducible.md", label: "博客 · Agent bug 为何不可复现" }
  ];
  const pages = [];
  for (const d of docs) {
    const raw = await readFile(join(ROOT, d.file), "utf8");
    const body = renderMarkdown(raw);
    pages.push({ id: d.id, href: `${d.id === "index" ? "index.html" : d.id + ".html"}`, label: d.label, body, file: d.file });
  }
  const nav = navHtml(pages, "");
  for (const p of pages) {
    const active = p.id;
    const full = layout(p.label, p.body, navHtml(pages, active));
    const outPath = join(SITE, p.id === "index" ? "index.html" : p.id + ".html");
    await mkdir(join(SITE, p.id.includes("/") ? p.id.split("/")[0] : "."), { recursive: true });
    await writeFile(outPath, full, "utf8");
  }
  console.log(`docsite: ${pages.length} pages rendered (${version}) -> ${SITE}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
