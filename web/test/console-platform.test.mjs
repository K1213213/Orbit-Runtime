import { test } from "node:test";
import assert from "node:assert/strict";

import {
  TASK_STATUS,
  TASK_STATUS_IDS,
  taskStatusMeta,
  TASK_KINDS,
  taskKindMeta,
  deriveBilling,
  deriveNotifications,
  trendOf,
  ROLE_MATRIX,
  can,
  ROLE_LABEL,
  CHANNEL_LABEL,
  channelLabel
} from "../public/lib.js";

/**
 * Platform-facing pure logic in lib.js: billing aggregation, notification
 * derivation, metric trends, task-status vocabulary and the role/permission
 * matrix. All DOM-free, all assertable in Node so the console and the bridge
 * share one source of truth.
 */

/* --------------------------- 任务状态词汇 ------------------------- */

test("taskStatusMeta: 已知状态返回中文标签与 tone", () => {
  assert.equal(taskStatusMeta("running").label, "执行中");
  assert.equal(taskStatusMeta("running").tone, "violet");
  assert.equal(taskStatusMeta("iterating").tone, "warn");
  assert.equal(TASK_STATUS_IDS.length, Object.keys(TASK_STATUS).length);
});

test("taskStatusMeta: 未知状态回退到中性", () => {
  const m = taskStatusMeta("nonexistent");
  assert.equal(m.label, "nonexistent");
  assert.equal(m.tone, "neutral");
});

test("taskKindMeta: 已知大类带路由，未知回退", () => {
  assert.equal(taskKindMeta("rag").route, "rag");
  assert.equal(taskKindMeta("workflow").label, "工作流编排");
  assert.equal(taskKindMeta("??").route, "tasks");
  assert.equal(Object.keys(TASK_KINDS).length, 3);
});

/* ----------------------------- 账单推导 --------------------------- */

test("deriveBilling: 空账本安全返回，余额低于阈值报警", () => {
  const b = deriveBilling([], { balance: 30 });
  assert.equal(b.total, 0);
  assert.equal(b.todaySpend, 0);
  assert.equal(b.lowBalance, true);
  assert.equal(b.trend.length, 7);
});

test("deriveBilling: 聚合总量、按盒子/任务排名、7 日趋势连续补零", () => {
  const ts = Date.now();
  const ledger = [
    { ts, task: "t1", box: "b1", channel: "c", units: 5, reason: "x" },
    { ts, task: "t1", box: "b2", channel: "c", units: 3, reason: "y" },
    { ts, task: "t2", box: "b1", units: 2, reason: "z" }
  ];
  const b = deriveBilling(ledger, { balance: 500, lowThreshold: 100 });
  assert.equal(b.total, 10);
  assert.equal(b.todaySpend, 10);
  assert.equal(b.yesterdaySpend, 0);
  assert.equal(b.delta, 10);
  assert.equal(b.deltaPct, null);
  assert.equal(b.lowBalance, false);
  assert.deepEqual(b.topBoxes[0], { id: "b1", units: 7 });
  assert.equal(b.topTasks[0].id, "t1");
  assert.equal(b.entries.length, 3);
  // 趋势连续 7 天，单位数之和为总量
  assert.equal(b.trend.reduce((a, d) => a + d.units, 0), 10);
});

/* ----------------------------- 通知推导 --------------------------- */

test("deriveNotifications: 时间降序、未读计数、已读集合生效", () => {
  const events = [
    { ts: 1, kind: "audit", level: "warn", title: "x", detail: "d", route: "audit" },
    { ts: 2, kind: "billing", level: "ok", title: "y" }
  ];
  const n = deriveNotifications(events, { readIds: ["nt-1-1"] });
  assert.equal(n.list.length, 2);
  assert.equal(n.list[0].title, "y"); // 最新在前
  assert.equal(n.list[0].id, "nt-2-0");
  assert.equal(n.unread, 1); // nt-1-1 已读
  assert.equal(n.list[1].read, true);
});

test("deriveNotifications: 缺省 level 为 ok，缺省 id 稳定可复现", () => {
  const n = deriveNotifications([{ ts: 100, title: "hello" }]);
  assert.equal(n.list[0].level, "ok");
  assert.equal(n.list[0].id, "nt-100-0");
  assert.equal(n.unread, 1);
});

/* --------------------------- 指标环比 ----------------------------- */

test("trendOf: 无历史返回 null 或纯增量；有历史返回方向与百分比", () => {
  assert.equal(trendOf(0, 0), null);
  assert.deepEqual(trendOf(5, 0), { dir: "up", delta: 5, pct: null });
  assert.deepEqual(trendOf(15, 10), { dir: "up", delta: 5, pct: 50 });
  assert.deepEqual(trendOf(5, 10), { dir: "down", delta: -5, pct: -50 });
});

/* ----------------------------- 权限矩阵 --------------------------- */

test("can: 角色-动作裁决唯一入口", () => {
  assert.equal(can("admin", "settings"), true);
  assert.equal(can("admin", "nope"), false);
  assert.equal(can("operator", "billing"), false);
  assert.equal(can("operator", "workflow"), true);
  assert.equal(can("viewer", "host"), false);
  assert.equal(can(undefined, "settings"), false);
});

test("ROLE_MATRIX / ROLE_LABEL: 三种角色齐全且中文标签正确", () => {
  assert.deepEqual(Object.keys(ROLE_MATRIX).sort(), ["admin", "operator", "viewer"]);
  assert.equal(ROLE_LABEL.admin, "管理员");
  assert.equal(ROLE_LABEL.operator, "操作员");
  assert.equal(ROLE_LABEL.viewer, "观察者");
});

/* --------------------------- 通道展示名 ------------------------- */

test("channelLabel: 已知通道返回中文名，未知通道原样回退", () => {
  assert.equal(channelLabel("llm-access"), "模型通道");
  assert.equal(channelLabel("mem-kv-store"), "记忆存储");
  assert.equal(channelLabel("pae-tool"), "外来工具");
  assert.equal(channelLabel("some-future-channel"), "some-future-channel");
  assert.equal(channelLabel(undefined), "—");
  assert.deepEqual(Object.keys(CHANNEL_LABEL).sort(), ["domain-tool", "file-system", "llm-access", "mem-kv-store", "pae-tool", "shell-exec"]);
});
