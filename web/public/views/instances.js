/**
 * 智能体实例（Agent 沙箱）
 *
 * 沙箱是内核的执行单元：每轮 runSingleCycle 都带独立 trace ID、受循环预算
 * 约束、并经网关调用通道。视图要如实呈现三件事：
 *
 *   1. 预算消耗（cycleNow / maxCycleRun）—— 预算耗尽即拒绝执行，不是警告；
 *   2. 每次运行都是一个"任务" —— 桥接在内核调用前后记账并写审计；
 *   3. 释放沙箱后图节点仍在（内核暂不支持动态移除）—— 诚实标注，不假装消失。
 *
 * 聊天面板用右侧抽屉承载，卡片网格只做状态矩阵——一屏能看多少个实例，
 * 比单个实例能聊多少轮更重要。
 */
import { api } from "../api.js";
import { el, esc, badgeEl, toast, empty, drawer, confirmDialog } from "../app.js";

export async function renderInstances(root) {
  const wrap = el("div", "");

  let templates = [];
  try {
    templates = await api.templates();
  } catch { /* 模板不可用时退化为手填，不阻断主流程 */ }

  /* ---- 创建表单 ---- */
  const form = el("form", "card");
  form.append(el("div", "card-head", "<h3>生成智能体实例</h3><span class='sub'>循环预算防死循环 · 每轮独立 trace ID · 通道化模型调用</span>"));

  const tplSel = el("select", "select");
  tplSel.append(el("option", "", "自定义（手填参数）"));
  for (const t of templates) tplSel.append(el("option", "", esc(t.name)));

  const idF = input("text", "box.agent-1", "如 box.agent-1");
  const aliasF = input("text", "assistant-1", "如 assistant-1");
  const maxF = input("number", 3);
  const budgetF = input("number", 1);
  const instructF = el("textarea", "input");
  instructF.value = "You are a demo assistant.";

  tplSel.addEventListener("change", () => {
    const tpl = templates.find((t) => t.name === tplSel.value);
    if (!tpl || !tpl.snapshot) return;
    instructF.value = tpl.snapshot.baseInstruct;
    maxF.value = String(tpl.snapshot.maxCycleRun);
    budgetF.value = tpl.snapshot.budgetPerCycle ?? "";
  });

  const body = el("div", "card-body");
  body.append(
    el("div", "grid cols-2", [
      field("智能体模板（预填参数）", tplSel),
      el("div", "grid cols-2", [field("实例 ID *（agentBoxId）", idF), field("别名（boxAlias）", aliasF)])
    ]),
    el("div", "grid cols-2", [
      field("循环预算（maxCycleRun）", maxF),
      field("每轮成本预算（budgetPerCycle，可选）", budgetF)
    ]),
    field("基础指令（baseInstruct）", instructF),
    el("div", "row", [(() => {
      const b = el("button", "btn primary", "生成实例");
      b.type = "button";
      b.addEventListener("click", () => spawn());
      return b;
    })()])
  );
  form.append(body);

  /* ---- 实例池 ---- */
  const listCard = el("div", "card mt16");
  const countSub = el("span", "sub", "—");
  listCard.append((() => {
    const h = el("div", "card-head");
    h.append(el("h3", "", "实例池"));
    h.append(countSub);
    const acts = el("div", "head-actions");
    const refreshBtn = el("button", "btn sm", "↻ 刷新");
    refreshBtn.type = "button";
    refreshBtn.addEventListener("click", () => load());
    acts.append(refreshBtn);
    h.append(acts);
    return h;
  })());
  const listBody = el("div", "card-body");
  listCard.append(listBody);

  wrap.append(form, listCard);
  root.append(wrap);

  async function spawn() {
    const config = {
      agentBoxId: idF.value.trim(),
      boxAlias: aliasF.value.trim(),
      maxCycleRun: Number(maxF.value || 3),
      baseInstruct: instructF.value.trim() || "You are a demo assistant.",
      channelDeps: ["llm-access"],
      budgetPerCycle: budgetF.value === "" ? undefined : Number(budgetF.value)
    };
    if (!config.agentBoxId || !config.boxAlias) {
      toast("实例 ID 与别名为必填", "err");
      return;
    }
    try {
      await api.spawnBox(config);
      toast(`实例 ${config.agentBoxId} 已生成`, "ok");
      await load();
    } catch (err) {
      toast(`生成失败：${err.message}`, "err");
    }
  }

  async function load() {
    let boxes = [];
    try {
      boxes = await api.boxes();
    } catch (err) {
      listBody.replaceChildren(el("div", "alert err", `<span>⚠</span><span class="msg">${esc(err.message)}</span>`));
      return;
    }
    countSub.textContent = `${boxes.length} 个实例`;
    if (boxes.length === 0) {
      listBody.replaceChildren(empty("暂无实例，先用上方表单生成一枚实例", "▣", "实例是执行单元：每一轮推理都受循环预算约束并落入追踪日志。"));
      return;
    }
    const grid = el("div", "instance-grid");
    for (const box of boxes) grid.append(buildBoxCard(box, load));
    listBody.replaceChildren(grid);
  }

  await load();

  return { dispose() {}, refresh: () => renderInstances(root) };
}

/* ------------------------------------------------------------------ */

function buildBoxCard(box, reload) {
  const card = el("div", "instance-card");
  const spent = box.cycleNow >= box.maxCycleRun;
  const pct = Math.min(100, Math.round((box.cycleNow / Math.max(1, box.maxCycleRun)) * 100));

  const head = el("div", "ix-head");
  head.append(el("div", "avatar", esc(String(box.boxAlias ?? box.agentBoxId).slice(0, 1).toUpperCase())));
  const meta = el("div", "grow");
  meta.append(el("b", "", esc(box.boxAlias || box.agentBoxId)));
  meta.append(el("span", "sub mono", esc(box.agentBoxId)));
  head.append(meta);
  head.append(spent ? badgeEl("预算耗尽", "warn") : badgeEl(`${box.cycleNow}/${box.maxCycleRun} 轮`, "ok"));
  card.append(head);

  const rows = el("div", "ix-rows");
  rows.append(row("基础指令", box.baseInstruct || "—"));
  rows.append(row("循环预算", `${box.maxCycleRun} 轮`));
  card.append(rows);

  const bar = el("div", `progress mt8${spent ? " warn" : ""}`);
  const fill = el("i");
  fill.style.width = `${pct}%`;
  bar.append(fill);
  card.append(bar);

  const actions = el("div", "ix-actions");
  const detailBtn = el("button", "btn sm", "详情");
  const chatBtn = el("button", "btn sm primary", "推演一轮");
  const resetBtn = el("button", "btn sm", "重置轮次");
  const delBtn = el("button", "btn sm danger", "释放");
  detailBtn.type = chatBtn.type = resetBtn.type = delBtn.type = "button";
  detailBtn.addEventListener("click", () => openDetail(box, reload));
  chatBtn.addEventListener("click", () => openChat(box, reload));
  resetBtn.addEventListener("click", async () => {
    try {
      await api.resetBox(box.agentBoxId);
      toast(`实例 ${box.agentBoxId} 轮次已重置`, "ok");
      reload();
    } catch (err) { toast(err.message, "err"); }
  });
  delBtn.addEventListener("click", async () => {
    const ok = await confirmDialog("释放实例", `确认释放 ${box.agentBoxId}？影响域图节点将保留至主机重启（内核暂不支持动态移除）。`, "释放");
    if (!ok) return;
    try {
      await api.removeBox(box.agentBoxId);
      toast(`实例 ${box.agentBoxId} 已释放`, "ok");
      reload();
    } catch (err) { toast(err.message, "err"); }
  });
  actions.append(detailBtn, chatBtn, resetBtn, delBtn);
  card.append(actions);

  return card;
}

function openDetail(box, reload) {
  const spent = box.cycleNow >= box.maxCycleRun;
  const remaining = Math.max(0, box.maxCycleRun - box.cycleNow);
  const pct = Math.min(100, Math.round((box.cycleNow / Math.max(1, box.maxCycleRun)) * 100));

  const body = el("div", "");
  /* 字段表 */
  const kv = el("div", "kv");
  const add = (k, v) => kv.append(el("dt", "", esc(k)), el("dd", "", esc(String(v))));
  add("实例 ID", box.agentBoxId);
  add("别名", box.boxAlias || "—");
  add("循环预算", `${box.maxCycleRun} 轮`);
  add("已用轮次", `${box.cycleNow} 轮`);
  add("剩余预算", `${remaining} 轮`);
  add("预算状态", spent ? "已耗尽（需重置）" : "正常");
  add("通道依赖", "llm-access");
  body.append(kv);

  /* 基础指令（完整） */
  body.append(el("div", "sub mt16", "基础指令"));
  body.append(el("pre", "code-block", esc(box.baseInstruct || "—")));

  /* 进度 */
  body.append(el("div", "sub mt16", `预算消耗 ${pct}%`));
  const bar = el("div", `progress${spent ? " warn" : ""}`);
  const fill = el("i");
  fill.style.width = `${pct}%`;
  bar.append(fill);
  body.append(bar);

  /* 快捷操作 */
  const acts = el("div", "row mt16");
  const chat = el("button", "btn primary sm", "推演一轮");
  chat.type = "button";
  chat.addEventListener("click", () => openChat(box, reload));
  const reset = el("button", "btn sm", "重置轮次");
  reset.type = "button";
  reset.addEventListener("click", async () => {
    try { await api.resetBox(box.agentBoxId); toast("轮次已重置", "ok"); reload(); }
    catch (e) { toast(e.message, "err"); }
  });
  acts.append(chat, reset);
  body.append(acts);

  drawer(`实例详情 · ${box.boxAlias || box.agentBoxId}`, body);
}

function openChat(box, reload) {
  const log = el("div", "timeline");
  const inputBox = el("input", "input");
  inputBox.type = "text";
  inputBox.placeholder = `给 ${box.boxAlias || box.agentBoxId} 发消息…`;
  const sendBtn = el("button", "btn primary", "执行");

  const foot = el("div", "row");
  const taskHint = el("span", "hint grow", spentHint(box));
  foot.append(inputBox, sendBtn);

  const d = drawer(`推演 · ${box.boxAlias || box.agentBoxId}`, el("div", "", [log, el("div", "mt16", [foot, taskHint])]));
  inputBox.focus();
  inputBox.addEventListener("keydown", (e) => { if (e.key === "Enter") run(); });
  sendBtn.addEventListener("click", () => run());

  async function run() {
    const text = inputBox.value.trim();
    if (!text) return;
    inputBox.value = "";
    log.append(entry("violet", "输入", text));
    sendBtn.disabled = true;
    sendBtn.textContent = "执行中…";
    try {
      const r = await api.runBox(box.agentBoxId, text);
      log.append(entry("ok", `第 ${r.cycleNow}/${r.maxCycle} 轮`, String(r.output)));
      taskHint.textContent = `任务 ${r.taskId} · ${r.taskStatus}`;
      box.cycleNow = r.cycleNow;
      toast(`第 ${r.cycleNow}/${r.maxCycle} 轮完成`, "ok", 1500);
    } catch (err) {
      log.append(entry("err", "执行失败", err.message));
      toast(err.message, "err", 4000);
    } finally {
      sendBtn.disabled = false;
      sendBtn.textContent = "执行";
      reload();
    }
  }
}

function spentHint(box) {
  return box.cycleNow >= box.maxCycleRun
    ? "循环预算已耗尽：需重置轮次才能继续推演。"
    : `剩余 ${box.maxCycleRun - box.cycleNow} 轮预算 · 每轮经网关调用并计入Token账单。`;
}

function entry(tone, title, text) {
  return el("div", `tl-item ${tone}`, `
    <div class="tl-head"><b>${esc(title)}</b></div>
    <div class="tl-body">${esc(text)}</div>`);
}

function row(k, v) {
  return el("div", "spread", `<span>${esc(k)}</span><span>${esc(String(v))}</span>`);
}

function field(text, control) {
  const f = el("div", "field");
  f.style.marginBottom = "0";
  f.append(el("label", "", esc(text)));
  f.append(control);
  return f;
}

function input(type, value, ph) {
  const i = el("input", "input");
  i.type = type;
  i.value = value ?? "";
  if (ph) i.placeholder = ph;
  return i;
}
