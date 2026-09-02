/**
 * render-md.test.mjs — docsite renderer (W34).
 * The renderer is a zero-dependency Markdown subset; these cases pin the
 * constructs the project's own docs rely on.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { escapeHtml, renderInline, renderMarkdown } from "./render-md.mjs";

test("renderer: escapes raw HTML in text", () => {
  assert.equal(escapeHtml("<script>alert(1)</script>"), "&lt;script&gt;alert(1)&lt;/script&gt;");
  assert.equal(renderInline("a < b & c"), "a &lt; b &amp; c");
});

test("renderer: inline bold, code and links", () => {
  const html = renderInline("**bold** and `code` and [label](https://x.dev)");
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /<a href="https:\/\/x.dev">label<\/a>/);
});

test("renderer: ATX headings with anchors", () => {
  const html = renderMarkdown("# Title One\n\n## 二 节\n");
  assert.match(html, /<h1 id="title-one">Title One<\/h1>/);
  assert.match(html, /<h2 id="二-节">二 节<\/h2>/);
});

test("renderer: fenced code blocks keep content and escape markup", () => {
  const md = "```ts\nconst x: number = 1 < 2;\n```";
  const html = renderMarkdown(md);
  assert.match(html, /<pre><code class="lang-ts">/);
  assert.ok(html.includes("const x: number = 1 &lt; 2;"));
});

test("renderer: pipe tables become html tables", () => {
  const md = "| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n";
  const html = renderMarkdown(md);
  assert.match(html, /<table>/);
  assert.match(html, /<th>a<\/th>/);
  assert.equal((html.match(/<tr>/g) ?? []).length, 3, "header row + two body rows");
});

test("renderer: blockquotes, hr and lists", () => {
  const md = "> quote line\n\n---\n\n- one\n- two\n\n1. first\n2. second\n";
  const html = renderMarkdown(md);
  assert.match(html, /<blockquote>quote line<\/blockquote>/);
  assert.match(html, /<hr>/);
  assert.match(html, /<ul>\s*<li>one<\/li>\s*<li>two<\/li>\s*<\/ul>/);
  assert.match(html, /<ol>\s*<li>first<\/li>\s*<li>second<\/li>\s*<\/ol>/);
});

test("renderer: paragraphs join continuation lines", () => {
  const html = renderMarkdown("line one\nline two\n");
  assert.match(html, /<p>line one line two<\/p>/);
});

test("renderer: renders the real architecture doc without raw markdown leaking", async () => {
  const { readFile } = await import("node:fs/promises");
  const raw = await readFile(new URL("../docs/architecture.md", import.meta.url), "utf8");
  const html = renderMarkdown(raw);
  assert.match(html, /<h1/);
  assert.ok(!html.includes("```"), "fenced code fully consumed");
  assert.ok(!html.includes("\n## "), "headings not left raw");
  assert.ok(html.includes("<table>"), "tables rendered");
});
