import { test } from "node:test";
import assert from "node:assert/strict";

import {
  NAV_GROUPS,
  NAV_ITEMS,
  NAV_PATHS,
  buildTimeline,
  buildComplianceReport,
  callFacts,
  countInterventions,
  deriveSystemHealth,
  flaggedSteps,
  fuzzyScore,
  missingRenderers,
  navItemOf,
  parseArgv,
  searchCommands,
  suggestNextSteps,
  summarizeValue
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
  assert.equal(navItemOf("replay").group, "developer");
  assert.equal(navItemOf("pae").group, "developer");
  assert.equal(navItemOf("boxes").group, "primary");
  assert.equal(navItemOf("trace").group, "proof");
  assert.equal(navItemOf("settings").group, "system");
  assert.equal(navItemOf("nope"), null);
});

test("nav: progressive disclosure — mechanism pages live in the collapsed developer group", () => {
  const dev = NAV_GROUPS.find((g) => g.id === "developer");
  assert.ok(dev, "developer group exists");
  assert.equal(dev.collapsed, true, "developer control plane is collapsed by default");
  const devPaths = dev.items.map((i) => i.path).sort();
  assert.deepEqual(
    devPaths,
    ["billing", "channels", "graph", "knowledge", "pae", "plugins", "rag", "replay", "routing", "templates", "workflow"].sort(),
    "the 11 mechanism pages are grouped under developer"
  );
  // The always-visible groups are the product-facing surface.
  const visible = NAV_GROUPS.filter((g) => !g.collapsed).flatMap((g) => g.items.map((i) => i.path));
  assert.deepEqual(visible.sort(), ["boxes", "overview", "profile", "settings", "tasks", "trace"].sort());
  for (const g of NAV_GROUPS) {
    if (!g.collapsed) continue;
    for (const i of g.items) assert.ok(i.path !== "trace" && i.path !== "overview", "core product pages stay visible");
  }
});

test("nav: product-facing naming (business language, not kernel jargon)", () => {
  assert.equal(navItemOf("overview").title, "工作台");
  assert.equal(navItemOf("trace").title, "审计与合规");
  assert.equal(navItemOf("graph").title, "故障隔离图");
  assert.equal(navItemOf("replay").title, "重放调试台");
  assert.equal(navItemOf("billing").title, "用量账单");
  assert.equal(navItemOf("routing").title, "路由与预算");
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

/* ---------------------------------------------------------------- W32 重放时间线 */

test("timeline: empty window builds an empty timeline", () => {
  assert.deepEqual(buildTimeline([]), []);
  assert.deepEqual(buildTimeline(undefined), []);
});

test("timeline: callFacts extracts channel, func, digest, output and route", () => {
  const facts = callFacts({
    channelKind: "mem-kv-store",
    funcName: "readEntry",
    inputDigest: "d9f2ab7c",
    outputSnapshot: { value: "hi" },
    durationMs: 3,
    decision: { route: "native" }
  });
  assert.equal(facts.channel, "mem-kv-store");
  assert.equal(facts.func, "readEntry");
  assert.equal(facts.inputDigest, "d9f2ab7c".slice(0, 10));
  assert.match(facts.output, /"value":"hi"/);
  assert.equal(facts.ms, 3);
  assert.ok(facts.facts.some((f) => f.key === "route" && f.label === "原生"));
});

test("timeline: governance interventions surface as facts", () => {
  const facts = callFacts({
    channelKind: "llm-access",
    funcName: "chat",
    outputSnapshot: "x".repeat(300),
    durationMs: 10,
    decision: {
      route: "pae",
      tripAllowed: false,
      pactPass: true,
      budget: { allow: false, strategy: "shrink" },
      compression: { level: "normal", applied: true, bytesSaved: 12 }
    }
  });
  const keys = facts.facts.map((f) => f.key);
  assert.ok(keys.includes("tripped"), "trip rejection is flagged");
  assert.ok(keys.includes("budget"), "budget shrink is flagged");
  assert.ok(keys.includes("compressed"), "compression is flagged");
  assert.ok(keys.includes("route") && facts.facts.find((f) => f.key === "route").label === "PAE");
});

test("timeline: flaggedSteps filters out the routine route-only steps", () => {
  const timeline = buildTimeline([
    { channelKind: "mem-kv-store", funcName: "a", outputSnapshot: 1, durationMs: 1, decision: { route: "native" } },
    { channelKind: "llm-access", funcName: "b", outputSnapshot: 2, durationMs: 2, decision: { route: "pae", rateLimited: true } },
    { channelKind: "mem-kv-store", funcName: "c", outputSnapshot: 3, durationMs: 3, decision: { route: "native" } }
  ]);
  assert.equal(timeline.length, 3);
  const flagged = flaggedSteps(timeline);
  assert.equal(flagged.length, 1);
  assert.equal(flagged[0].index, 1);
  assert.equal(flagged[0].func, "b");
});

test("timeline: summarizeValue truncates long strings and JSON", () => {
  assert.equal(summarizeValue("ab".repeat(200)).endsWith("…"), true);
  assert.equal(summarizeValue({ big: "x".repeat(500) }).endsWith("…"), true);
  assert.equal(summarizeValue(42), "42");
  assert.equal(summarizeValue(null), "null");
  assert.equal(summarizeValue("short"), "short");
});

test("timeline: buildTimeline indexes steps by call order", () => {
  const t = buildTimeline([
    { channelKind: "a", funcName: "f1", outputSnapshot: null, durationMs: 1, decision: {} },
    { channelKind: "b", funcName: "f2", outputSnapshot: null, durationMs: 2, decision: {} }
  ]);
  assert.deepEqual(t.map((s) => s.index), [0, 1]);
});

/* ---------------------------------------------------------------- W33 合规报告 */

const GOV = {
  name: "strict", compression: "aggressive",
  limiter: { maxCallsPerWindow: 60, windowSizeCalls: 60 },
  trip: { failureThreshold: 3, cooldownMs: 5000 },
  paeAdmission: [], traceDurability: "required",
  maxIsolationLevel: "L1", schemaMode: "required"
};

test("compliance: a signed consistent chain reports PASS", () => {
  const r = buildComplianceReport({
    version: "0.10.0", generatedAt: "2026-09-02T00:00:00.000Z",
    profile: GOV,
    audit: { total: 5, signed: true, consistent: true },
    window: { total: 3, steps: [] }
  });
  assert.equal(r.audit.status, "PASS");
  assert.equal(r.governance.tier, "Strict（合规）");
  assert.equal(r.governance.maxIsolationLevel, "L1");
  assert.equal(r.governance.schemaMode, "required");
  assert.equal(r.determinism.calls, 3);
  assert.match(r.summary, /可向第三方出示/);
});

test("compliance: unsigned or broken chains report UNSIGNED / FAIL", () => {
  const base = { version: "0.10.0", generatedAt: "x", profile: GOV, window: { total: 0, steps: [] } };
  const unsigned = buildComplianceReport({ ...base, audit: { total: 5, signed: false, consistent: false } });
  assert.equal(unsigned.audit.status, "UNSIGNED");
  const broken = buildComplianceReport({
    ...base,
    audit: { total: 5, signed: true, consistent: false, brokenAt: 2, brokenReason: "tampered" }
  });
  assert.equal(broken.audit.status, "FAIL");
  assert.equal(broken.audit.text.includes("#2"), true);
  const empty = buildComplianceReport({ ...base, audit: { total: 0, signed: false, consistent: false } });
  assert.equal(empty.audit.status, "EMPTY");
});

test("compliance: interventions are counted from timeline steps", () => {
  const steps = buildTimeline([
    { channelKind: "llm-access", funcName: "a", outputSnapshot: 1, durationMs: 1,
      decision: { route: "pae", rateLimited: true } },
    { channelKind: "llm-access", funcName: "b", outputSnapshot: 2, durationMs: 2,
      decision: { route: "pae", budget: { allow: false, strategy: "shrink" } } },
    { channelKind: "llm-access", funcName: "c", outputSnapshot: 3, durationMs: 3,
      decision: { route: "pae", rateLimited: true, compression: { level: "normal", applied: true, bytesSaved: 5 } } },
    { channelKind: "mem-kv-store", funcName: "d", outputSnapshot: 4, durationMs: 4, decision: { route: "native" } }
  ]);
  const r = buildComplianceReport({
    version: "1", generatedAt: "x", profile: GOV,
    audit: { total: 1, signed: true, consistent: true },
    window: { total: steps.length, steps }
  });
  assert.equal(r.interventions["限流"], 2);
  assert.equal(r.interventions["预算收缩"], 1);
  assert.equal(r.interventions["压缩"], 1);
  assert.ok(!r.interventions["路由"], "pure routing is not an intervention");
  assert.equal(r.determinism.flagged, 4);
});

test("compliance: countInterventions skips empty windows", () => {
  assert.deepEqual(countInterventions([]), {});
  assert.deepEqual(countInterventions(undefined), {});
});
