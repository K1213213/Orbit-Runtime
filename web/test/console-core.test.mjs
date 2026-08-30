import { test } from "node:test";
import assert from "node:assert/strict";

import {
  NAV_GROUPS,
  NAV_ITEMS,
  NAV_PATHS,
  deriveSystemHealth,
  fuzzyScore,
  missingRenderers,
  navItemOf,
  parseArgv,
  searchCommands,
  suggestNextSteps
} from "../public/lib.js";

/**
 * Console core — the DOM-free half of the console shell.
 *
 * Information architecture, command-palette ranking, health derivation and
 * next-step suggestions all live in `lib.js` precisely so they can be asserted
 * here, in Node, without a browser. Anything that decides *what the user sees
 * next* is a decision worth testing.
 */

const ALL_PATHS = [
  "overview",
  "boxes",
  "tasks",
  "workflow",
  "knowledge",
  "rag",
  "templates",
  "plugins",
  "channels",
  "pae",
  "trace",
  "billing",
  "routing",
  "replay",
  "graph",
  "settings",
  "profile"
];

function makeState(overrides = {}) {
  return {
    running: true,
    channels: [{ kind: "llm-access", type: "builtin", cost: {} }],
    plugins: [{ id: "p1" }],
    sandboxes: [{ id: "b1" }],
    traceCount: 12,
    trace: [],
    runCounter: 3,
    pae: { enabled: true, adapters: 1, tools: 2, configHash: "abc" },
    ...overrides
  };
}

/* ------------------------------------------------------------------ */
/* Information architecture                                            */
/* ------------------------------------------------------------------ */

test("nav: every view is reachable and grouped exactly once", () => {
  assert.deepEqual([...NAV_PATHS].sort(), [...ALL_PATHS].sort(), "no view is missing from the nav");
  assert.equal(new Set(NAV_PATHS).size, NAV_PATHS.length, "no duplicate routes");

  for (const g of NAV_GROUPS) {
    assert.ok(g.id && g.label && g.desc, "a group carries its intent");
    assert.ok(g.items.length > 0, `group ${g.id} is not empty`);
    for (const item of g.items) {
      assert.ok(item.path && item.title && item.icon, `${item.path} is fully described`);
      assert.ok(item.keywords && item.keywords.length > 0, `${item.path} is searchable`);
    }
  }
});

test("nav: lookup resolves a path to its group", () => {
  assert.equal(navItemOf("replay").group, "governance");
  assert.equal(navItemOf("pae").group, "artifacts");
  assert.equal(navItemOf("boxes").group, "runtime");
  assert.equal(navItemOf("nope"), null);
});

test("nav: a declared route with no renderer is detected, not silently unreachable", () => {
  assert.deepEqual(missingRenderers(NAV_PATHS, ALL_PATHS), [], "declared and implemented agree");
  assert.deepEqual(
    missingRenderers(NAV_PATHS, ALL_PATHS.filter((p) => p !== "channels")),
    ["channels"],
    "the historical channels incident would now fail here"
  );
});

/* ------------------------------------------------------------------ */
/* Command palette ranking                                             */
/* ------------------------------------------------------------------ */

test("fuzzy: an empty query matches everything at a neutral score", () => {
  assert.equal(fuzzyScore("", "anything"), 0);
  assert.equal(fuzzyScore("   ", "anything"), 0);
});

test("fuzzy: a substring hit outranks a scattered subsequence", () => {
  const tight = fuzzyScore("路由", "成本路由");
  const loose = fuzzyScore("路由", "路-由 分散命中");
  assert.ok(tight > loose, "an unbroken run ranks higher than a scattered one");
  assert.ok(fuzzyScore("over", "overview") > fuzzyScore("over", "o-v-e-r"));
});

test("fuzzy: a prefix hit outranks the same match later in the string", () => {
  assert.ok(fuzzyScore("over", "overview console") > fuzzyScore("over", "the overview page"));
});

test("fuzzy: matching is case-insensitive", () => {
  assert.equal(fuzzyScore("MCP", "mcp"), fuzzyScore("mcp", "MCP"));
  assert.ok(fuzzyScore("MCP", "MCP 适配") > 0);
});

test("fuzzy: a query with no matching characters does not match", () => {
  assert.equal(fuzzyScore("zzz", "overview"), -1);
  assert.equal(fuzzyScore("abc", ""), -1);
});

test("palette: results are ranked and every candidate stays searchable by keyword", () => {
  const items = NAV_ITEMS.map((i) => ({
    id: i.path,
    title: i.title,
    group: i.groupLabel,
    keywords: i.keywords
  }));

  const byChinese = searchCommands("回放", items);
  assert.equal(byChinese[0].id, "replay");

  const byEnglish = searchCommands("replay", items);
  assert.equal(byEnglish[0].id, "replay");

  const byKeyword = searchCommands("mcp", items);
  assert.equal(byKeyword[0].id, "pae", "reachable through a synonym the title never mentions");

  const byPinyinless = searchCommands("成本", items);
  assert.equal(byPinyinless[0].id, "routing");
});

test("palette: an empty query preserves declaration order", () => {
  const items = NAV_ITEMS.map((i) => ({ id: i.path, title: i.title, keywords: i.keywords }));
  assert.deepEqual(searchCommands("", items).map((i) => i.id), NAV_PATHS);
});

test("palette: unmatched candidates are dropped entirely", () => {
  const items = [
    { id: "a", title: "回放台", keywords: "" },
    { id: "b", title: "总览", keywords: "" }
  ];
  assert.deepEqual(searchCommands("回放", items).map((i) => i.id), ["a"]);
  assert.deepEqual(searchCommands("qqq", items), []);
});

/* ------------------------------------------------------------------ */
/* Command-line argument parsing (MCP server args)                     */
/* ------------------------------------------------------------------ */

test("argv: blank input yields no arguments", () => {
  assert.deepEqual(parseArgv(""), []);
  assert.deepEqual(parseArgv("   "), []);
  assert.deepEqual(parseArgv(null), []);
});

test("argv: whitespace separates arguments", () => {
  assert.deepEqual(parseArgv("-y @modelcontextprotocol/server-x"), [
    "-y",
    "@modelcontextprotocol/server-x"
  ]);
  assert.deepEqual(parseArgv("a  b\tc"), ["a", "b", "c"]);
});

test("argv: quoted segments keep their spaces together", () => {
  assert.deepEqual(parseArgv('--dir "C:/Program Files/data" --ro'), [
    "--dir",
    "C:/Program Files/data",
    "--ro"
  ]);
  assert.deepEqual(parseArgv("echo 'hello world'"), ["echo", "hello world"]);
});

test("argv: a missing closing quote does not loop forever", () => {
  assert.deepEqual(parseArgv('a "unterminated'), ["a", "unterminated"]);
});

/* ------------------------------------------------------------------ */
/* Health derivation                                                   */
/* ------------------------------------------------------------------ */

test("health: a fully exercised host reports no issues", () => {
  const h = deriveSystemHealth(makeState());
  assert.equal(h.level, "ok");
  assert.equal(h.healthy, true);
  assert.deepEqual(h.issues, []);
});

test("health: a stopped host is an error before anything else", () => {
  const h = deriveSystemHealth(makeState({ running: false }));
  assert.equal(h.level, "err");
  assert.equal(h.issues[0].id, "host-down");
  assert.equal(h.healthy, false);
});

test("health: a running host with no channels cannot do anything", () => {
  const h = deriveSystemHealth(makeState({ channels: [] }));
  assert.equal(h.level, "err");
  assert.ok(h.issues.some((i) => i.id === "no-channel"));
});

test("health: missing plugins and adapters are warnings, not errors", () => {
  const h = deriveSystemHealth(
    makeState({ plugins: [], pae: { enabled: false, adapters: 0, tools: 0, configHash: null } })
  );
  assert.equal(h.level, "warn", "the host still works, so this must not read as broken");
  assert.ok(h.issues.some((i) => i.id === "no-plugin"));
  assert.ok(h.issues.some((i) => i.id === "no-adapter"));
});

test("health: every issue carries actionable text", () => {
  const h = deriveSystemHealth(makeState({ running: false }));
  for (const issue of h.issues) {
    assert.ok(issue.text && issue.text.length > 0, "an issue says what is wrong");
    assert.ok(issue.detail && issue.detail.length > 0, "and what to do about it");
  }
});

/* ------------------------------------------------------------------ */
/* Next-step suggestions                                               */
/* ------------------------------------------------------------------ */

test("next steps: a stopped host gets exactly one instruction — start it", () => {
  const steps = suggestNextSteps(makeState({ running: false }));
  assert.equal(steps.length, 1);
  assert.equal(steps[0].id, "boot");
  assert.equal(steps[0].primary, true);
});

test("next steps: the first suggestion is always actionable and routed", () => {
  const steps = suggestNextSteps(
    makeState({ sandboxes: [], plugins: [], traceCount: 0, pae: { enabled: false } })
  );
  assert.ok(steps.length > 0);
  for (const s of steps) {
    assert.ok(ALL_PATHS.includes(s.route), `${s.id} points at a real view`);
    assert.ok(s.title && s.desc, `${s.id} explains itself`);
  }
  assert.equal(steps[0].primary, true, "the top suggestion is the one to take");
});

test("next steps: an unexercised host is told to create a sandbox before inspecting graphs", () => {
  const steps = suggestNextSteps(makeState({ sandboxes: [], traceCount: 0 }));
  assert.equal(steps[0].id, "create-box");
  assert.ok(steps.every((s) => s.id !== "replay"), "no trace means replay would be empty");
});

test("next steps: once there is a trace, replay is offered", () => {
  const steps = suggestNextSteps(makeState({ traceCount: 5 }));
  assert.ok(steps.some((s) => s.id === "replay"));
});

test("next steps: the list is bounded so it never becomes a wall of advice", () => {
  const steps = suggestNextSteps(makeState({ sandboxes: [], plugins: [], traceCount: 9 }), 2);
  assert.ok(steps.length <= 2);
});
