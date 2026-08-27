/**
 * 沙箱对话视图：创建 Agent 沙箱、执行推理轮次、观察循环预算与输出。
 */
import { api } from "../api.js";
import { el, esc, badge, toast, empty, loading } from "../app.js";

export async function renderBoxes(root) {
  const wrap = el("div", "");

  /* ---- 创建沙箱 ---- */
  const form = el("form", "card");
  form.append(el("div", "card-head", "<h3>创建 Agent 沙箱</h3><span class='sub'>循环预算防死循环 · 每轮独立 trace ID · 通道化模型调用</span>"));

  const idF = input("text", "box.agent-1", "如 box.agent-1");
  const aliasF = input("text", "assistant-1", "如 assistant-1");
  const maxF = input("number", 3);
  const budgetF = input("number", 1);
  const instructF = el("textarea");
  instructF.value = "You are a demo assistant.";

  const body = el("div", "card-body");
  body.append(
    el("div", "form-row", [
      field("沙箱 ID *（agentBoxId）", idF),
      field("别名（boxAlias）", aliasF)
    ]),
    el("div", "form-row", [
      field("循环预算（maxCycleRun）", maxF),
      field("每轮成本预算（budgetPerCycle，可选）", budgetF)
    ]),
    field("基础指令（baseInstruct）", instructF),
    el("div", "mt12", [
      (() => {
        const b = el("button", "btn primary", "创建沙箱");
        b.type = "button";
        b.addEventListener("click", async () => {
          const config = {
            agentBoxId: idF.value.trim(),
            boxAlias: aliasF.value.trim(),
            maxCycleRun: Number(maxF.value || 3),
            baseInstruct: instructF.value.trim() || "You are a demo assistant.",
            channelDeps: ["llm-access"],
            budgetPerCycle: budgetF.value === "" ? undefined : Number(budgetF.value)
          };
          try {
            await api.spawnBox(config);
            toast(`沙箱 ${config.agentBoxId} 已创建`, "ok");
            await refresh();
          } catch (err) {
            toast(`创建失败：${err.message}`, "err");
          }
        });
        return b;
      })()
    ])
  );
  form.append(body);

  /* ---- 沙箱列表 ---- */
  const listCard = el("div", "card mt16");
  listCard.append(el("div", "card-head", "<h3>沙箱池</h3><span class='sub' id='box-count'>—</span>"));
  const listBody = el("div", "box-list");
  listCard.append(el("div", "card-body", [listBody]));

  async function refresh() {
    const boxes = await api.boxes();
    listCard.querySelector("#box-count").textContent = `${boxes.length} 个沙箱`;
    if (boxes.length === 0) {
      listBody.replaceChildren(empty("暂无沙箱，先创建一个开始对话", "▣"));
      return;
    }
    listBody.replaceChildren(...boxes.map((box) => buildBoxCard(box, refresh)));
  }

  root.append(form, listCard);
  try {
    await refresh();
  } catch (err) {
    root.append(el("div", "alert err", `<span>⚠</span><span class="msg">${esc(err.message)}</span>`));
  }

  return { dispose() {}, refresh: () => renderBoxes(root) };
}

/* ------------------------------------------------------------------ */

function buildBoxCard(box, refreshAll) {
  const card = el("div", "box-card");
  const pct = Math.min(100, Math.round((box.cycleNow / box.maxCycleRun) * 100));
  const spent = box.cycleNow >= box.maxCycleRun;

  const head = el("div", "box-head");
  head.innerHTML = `
    <div>
      <span class="t">${esc(box.agentBoxId)}</span>
      <span class="alias">${esc(box.boxAlias)}</span>
      ${spent ? badge("预算耗尽", "warn") : badge(`${box.cycleNow}/${box.maxCycleRun} 轮`, "accent")}
    </div>
    <div class="row">
      <button class="btn sm" data-reset>重置轮次</button>
      <button class="btn sm danger" data-remove>释放</button>
    </div>`;

  const body = el("div", "box-body");
  body.innerHTML = `
    <div class="row">
      <span class="muted" style="font-size:12px">${esc(box.baseInstruct || "—")}</span>
    </div>
    <div class="cycle-bar"><i style="width:${pct}%"></i></div>
    <div class="hint">循环预算 ${box.maxCycleRun} · 已用 ${box.cycleNow}</div>`;

  const chat = el("div", "chat");
  body.append(chat);

  const runBar = el("div", "run-bar");
  const inputBox = el("input");
  inputBox.type = "text";
  inputBox.placeholder = `给 ${box.boxAlias} 发消息…`;
  inputBox.addEventListener("keydown", (e) => { if (e.key === "Enter") run(); });
  const runBtn = el("button", "btn primary", "运行一轮");
  runBar.append(inputBox, runBtn);

  async function run() {
    const text = inputBox.value.trim();
    if (!text) return;
    inputBox.value = "";
    chat.append(msg("user", text));
    runBtn.disabled = true;
    runBtn.textContent = "执行中…";
    try {
      const r = await api.runBox(box.agentBoxId, text);
      chat.append(msg("agent", r.output));
      box.cycleNow = r.cycleNow;
      toast(`第 ${r.cycleNow}/${r.maxCycle} 轮完成`, "ok", 1500);
    } catch (err) {
      chat.append(msg("sys", `✕ ${err.message}（该事件已写入追踪日志）`));
      toast(err.message, "err", 4000);
    } finally {
      runBtn.disabled = false;
      runBtn.textContent = "运行一轮";
      refreshAll();
    }
  }

  runBtn.addEventListener("click", run);

  head.querySelector("[data-reset]").addEventListener("click", async () => {
    try {
      await api.resetBox(box.agentBoxId);
      toast(`沙箱 ${box.agentBoxId} 轮次已重置`, "ok");
      refreshAll();
    } catch (err) { toast(err.message, "err"); }
  });

  head.querySelector("[data-remove]").addEventListener("click", async () => {
    if (!confirm(`确认释放沙箱 ${box.agentBoxId}？\n（依赖图节点将保留至主机重启，内核暂不支持动态移除）`)) return;
    try {
      await api.removeBox(box.agentBoxId);
      toast(`沙箱 ${box.agentBoxId} 已释放`, "ok");
      refreshAll();
    } catch (err) { toast(err.message, "err"); }
  });

  card.append(head, body);
  return card;
}

function msg(who, text) {
  return el("div", `msg ${who}`, `<div class="who">${who === "user" ? "你" : who === "agent" ? "agent" : "系统"}</div>${esc(text)}`);
}

/* ---- 小部件 ---- */
function label(text) {
  return el("label", "", `<span style="font-size:12px;color:var(--text-2);font-weight:550">${esc(text)}</span>`);
}
function input(type, value, placeholder) {
  const i = el("input");
  i.type = type;
  i.value = value;
  if (placeholder) i.placeholder = placeholder;
  return i;
}
function field(text, control) {
  const f = el("div", "field");
  f.append(label(text), control);
  return f;
}
