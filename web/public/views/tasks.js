/**
 * 任务中心 · 六态任务中心
 *
 * 任务是把"一次执行"变成"一份可追责记录"的载体：实例轮次、工作流编排、
 * RAG推演工作台三类动作都会落到这里，每类都带步骤明细与耗时。
 *
 * 一个刻意的克制：终止是**协作式**的。执行是单线程的，运行中的任务只在
 * 下一个 await 边界（步骤之间）才检查终止请求；因此点击"终止"后状态可能
 * 仍是 running 一段时间，界面如实显示"终止请求已记录"，而不是假装立即生效。
 */
import { api } from "../api.js";
import { el, esc, badge, fmtTime, fmtDate, toast, empty, drawer, confirmDialog, go } from "../app.js";
import { TASK_STATUS_IDS, taskStatusMeta, taskKindMeta } from "../lib.js";

export async function renderTasks(root) {
  const wrap = el("div", "");
  let disposed = false;
  let timer = null;

  /* ---- 过滤条 ---- */
  const card = el("div", "card");
  const statusF = el("select", "select");
  statusF.append(el("option", "", "全部状态"));
  for (const id of TASK_STATUS_IDS) {
    const o = el("option", "", esc(taskStatusMeta(id).label));
    o.value = id;
    statusF.append(o);
  }
  const kindF = el("select", "select");
  kindF.append(el("option", "", "全部类型"));
  for (const [k, meta] of Object.entries({ agent: "实例轮次", workflow: "工作流编排", rag: "RAG推演工作台" })) {
    const o = el("option", "", esc(meta));
    o.value = k;
    kindF.append(o);
  }
  const autoF = el("input");
  autoF.type = "checkbox";
  autoF.checked = true;
  const autoRow = el("label", "row");
  autoRow.append(autoF, el("span", "sub", "自动刷新（3s）"));

  const filter = el("div", "card-body grid cols-3");
  filter.append(
    field("状态", statusF),
    field("类型", kindF),
    el("div", "field", [el("label", "", "　"), autoRow])
  );
  card.append(el("div", "card-head", "<h3>任务流</h3><span class='sub' id='task-count'>—</span>"), filter);

  const tblWrap = el("div", "tbl-wrap");
  const tbl = el("table", "tbl");
  tbl.innerHTML = `<thead><tr><th>任务</th><th>类型</th><th>状态</th><th>创建</th><th class="num">耗时</th><th>操作</th></tr></thead>`;
  const tbody = el("tbody");
  tbl.append(tbody);
  tblWrap.append(tbl);
  card.append(tblWrap);
  wrap.append(card);
  root.append(wrap);

  async function load() {
    if (disposed) return;
    const params = {};
    if (statusF.value) params.status = statusF.value;
    if (kindF.value) params.kind = kindF.value;
    try {
      const list = await api.tasks(params);
      const countEl = card.querySelector("#task-count");
      if (countEl) countEl.textContent = `${list.length} 个任务`;
      if (list.length === 0) {
        tbody.replaceChildren();
        tblWrap.append(empty("没有匹配的任务", "⧉", "实例轮次、工作流编排与RAG推演工作台都会在这里留下记录。"));
        return;
      }
      tbody.replaceChildren(...list.map(rowOf));
    } catch (err) {
      tbody.replaceChildren();
      tblWrap.append(el("div", "alert err", `<span>⚠</span><span class="msg">${esc(err.message)}</span>`));
    }
  }

  function rowOf(t) {
    const meta = taskStatusMeta(t.status);
    const kind = taskKindMeta(t.kind);
    const tr = el("tr", "", `
      <td><b>${esc(t.title)}</b><div class="hint mono">${esc(t.id)}</div></td>
      <td>${esc(kind.icon)} ${esc(kind.label)}</td>
      <td>${badge(meta.label, meta.tone)}${t.abortRequested && !isDone(t.status) ? badge("终止中", "warn") : ""}</td>
      <td class="mono">${fmtDate(t.createdAt)} ${fmtTime(t.createdAt)}</td>
      <td class="num">${durationOf(t)}</td>
      <td></td>`);
    const ops = el("div", "row");
    const detail = el("button", "btn sm", "详情");
    detail.type = "button";
    detail.addEventListener("click", () => openDetail(t.id));
    ops.append(detail);
    if (!isDone(t.status)) {
      const abort = el("button", "btn sm danger", "终止");
      abort.type = "button";
      abort.addEventListener("click", () => abortTask(t, abort));
      ops.append(abort);
    }
    tr.lastElementChild.append(ops);
    return tr;
  }

  async function abortTask(t, btn) {
    const ok = await confirmDialog("终止任务", `确认终止 ${t.id}（${t.title}）？运行中的任务会在下一个步骤边界停止。`, "终止");
    if (!ok) return;
    btn.disabled = true;
    try {
      await api.abortTask(t.id);
      toast("终止请求已记录", "warn");
      await load();
    } catch (err) {
      toast(err.message, "err");
      btn.disabled = false;
    }
  }

  async function openDetail(id) {
    let task;
    try {
      task = await api.task(id);
    } catch (err) {
      toast(`加载失败：${err.message}`, "err");
      return;
    }
    const meta = taskStatusMeta(task.status);
    const body = el("div", "");

    const kv = el("dl", "kv");
    kv.append(
      dt("任务 ID", task.id),
      dt("类型", `${taskKindMeta(task.kind).icon} ${taskKindMeta(task.kind).label}`),
      dt("状态", `${meta.label}${task.abortRequested ? "（终止请求已记录）" : ""}`),
      dt("创建", `${fmtDate(task.createdAt)} ${fmtTime(task.createdAt)}`),
      dt("耗时", durationOf(task)),
      dt("元数据", JSON.stringify(task.meta ?? {}))
    );
    body.append(kv);

    if (task.steps?.length) {
      body.append(el("div", "mt16", `<div class="sub">执行步骤</div>`));
      const tl = el("div", "timeline mt8");
      for (const s of task.steps) {
        const tone = s.status === "done" ? "ok" : s.status === "failed" ? "err" : "violet";
        tl.append(el("div", `tl-item ${tone}`, `
          <div class="tl-head"><b>${esc(s.label)}</b><span class="t-time">${s.ms != null ? `${s.ms}ms` : ""}</span></div>
          <div class="tl-body">${esc(s.detail || "—")}</div>`));
      }
      body.append(tl);
    }

    if (task.error) {
      body.append(el("div", "mt16 alert err", `<span>✕</span><span class="msg">${esc(task.error)}</span>`));
    }
    if (task.result) {
      body.append(el("div", "mt16", [el("div", "sub", "结果"), el("pre", "codeblock mt8", esc(JSON.stringify(task.result, null, 2)))]));
    }

    const foot = el("div", "row");
    if (taskKindMeta(task.kind).route) {
      const jump = el("button", "btn sm", "前往来源页面");
      jump.type = "button";
      jump.addEventListener("click", () => { go(taskKindMeta(task.kind).route); });
      foot.append(jump);
    }

    drawer(`任务 · ${task.title}`, body, foot.children.length ? foot : null);
  }

  statusF.addEventListener("change", load);
  kindF.addEventListener("change", load);
  autoF.addEventListener("change", () => { if (autoF.checked) load(); });

  await load();
  timer = setInterval(() => { if (autoF.checked) load(); }, 3000);

  return {
    dispose() {
      disposed = true;
      clearInterval(timer);
    },
    refresh: () => renderTasks(root)
  };
}

function isDone(status) {
  return ["done", "failed", "aborted"].includes(status);
}

function durationOf(t) {
  if (!t.startedAt) return "—";
  const end = t.endedAt ?? Date.now();
  const ms = Math.max(0, end - t.startedAt);
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function dt(k, v) {
  const wrap = document.createDocumentFragment();
  const kk = el("dt", "", esc(k));
  const vv = el("dd", "", esc(String(v ?? "—")));
  wrap.append(kk, vv);
  return wrap;
}

function field(text, control) {
  const f = el("div", "field");
  f.style.marginBottom = "0";
  f.append(el("label", "", esc(text)));
  f.append(control);
  return f;
}
