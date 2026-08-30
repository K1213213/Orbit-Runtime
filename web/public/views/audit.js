/**
 * 事件溯源 · 平台审计流
 *
 * 两个层次刻意放在同一页，因为它们回答的是不同问题：
 *
 *   · 平台审计（/api/audit）—— 谁在什么时候对什么做了什么，用于追责与导出；
 *   · 内核追踪（/api/trace）—— 内核实际执行了哪些动作，用于复现与对账。
 *
 * 审计导出走服务端（/api/audit/export）而不是前端拼字符串：导出动作本身
 * 也会落一条审计事件，"谁导出了什么"因此同样可追溯。
 */
import { api } from "../api.js";
import { el, esc, badge, fmtTime, fmtDate, toast, empty, go } from "../app.js";

const LEVEL_TONE = { ok: "ok", warn: "warn", err: "err" };

export async function renderAudit(root) {
  const wrap = el("div", "");

  /* ---- 过滤器 ---- */
  const filterCard = el("div", "card");
  const filterBody = el("div", "card-body");
  const filter = el("div", "grid cols-4");

  const actorF = el("input", "input");
  actorF.placeholder = "全部操作者";
  const actionF = el("select", "select");
  for (const a of ["", "host.boot", "host.shutdown", "plugin.register", "box.spawn", "template.save",
    "template.rollback", "workflow.run", "kb.upload", "rag.run", "pae.register", "billing.low",
    "auth.login", "auth.password", "task.failed", "task.aborted"]) {
    actionF.append(el("option", "", a === "" ? "全部动作" : esc(a)));
  }
  const levelF = el("select", "select");
  for (const [v, t] of [["", "全部级别"], ["ok", "正常"], ["warn", "告警"], ["err", "异常"]]) {
    const o = el("option", "", esc(t));
    o.value = v;
    levelF.append(o);
  }

  const autoRow = el("label", "row");
  const autoF = el("input");
  autoF.type = "checkbox";
  autoF.checked = true;
  autoRow.append(autoF, el("span", "sub", "自动刷新（5s）"));

  filter.append(
    field("操作者", actorF),
    field("动作", actionF),
    field("级别", levelF),
    el("div", "field", [el("label", "", "　"), autoRow])
  );

  const actions = el("div", "row mt8");
  const exportMd = el("button", "btn sm", "导出 Markdown");
  const exportJson = el("button", "btn sm", "导出 JSON");
  const exportPdf = el("button", "btn sm", "导出 PDF");
  exportMd.type = exportJson.type = exportPdf.type = "button";
  exportMd.addEventListener("click", () => exportAs("md"));
  exportJson.addEventListener("click", () => exportAs("json"));
  exportPdf.addEventListener("click", () => exportAs("pdf"));
  actions.append(exportMd, exportJson, exportPdf, el("span", "hint grow", "导出由服务端生成，导出动作本身也会记入审计流"));

  filterBody.append(filter, actions);
  filterCard.append(el("div", "card-head", "<h3>平台审计流</h3><span class='sub' id='audit-count'>—</span>"), filterBody);

  const tblWrap = el("div", "tbl-wrap");
  const tbl = el("table", "tbl");
  tbl.innerHTML = `<thead><tr><th>时间</th><th>操作者</th><th>动作</th><th>对象</th><th>级别</th><th>详情</th></tr></thead>`;
  const tbody = el("tbody");
  tbl.append(tbody);
  tblWrap.append(tbl);
  filterCard.append(tblWrap);

  /* ---- 内核追踪日志 ---- */
  const traceCard = el("div", "card mt16");
  const traceBody = el("div", "card-body");
  traceCard.append(el("div", "card-head", `
    <h3>内核追踪日志</h3><span class="sub" id="trace-count">—</span>
    <div class="head-actions"><button class="btn sm" id="goto-replay">去回放台对账 →</button></div>`), traceBody);

  wrap.append(filterCard, traceCard);
  root.append(wrap);

  let timer = null;
  let disposed = false;

  async function load() {
    if (disposed) return;
    const params = { limit: 200 };
    if (actorF.value.trim()) params.actor = actorF.value.trim();
    if (actionF.value) params.action = actionF.value;
    if (levelF.value) params.level = levelF.value;
    try {
      const events = await api.audit(params);
      const countEl = filterCard.querySelector("#audit-count");
      if (countEl) countEl.textContent = `${events.length} 条 · 追加式只读，最多保留 1000 条`;
      if (events.length === 0) {
        tbody.replaceChildren();
        tblWrap.append(empty("没有匹配的审计事件", "≡"));
        return;
      }
      tbody.replaceChildren(...events.map(rowOf));
    } catch (err) {
      tbody.replaceChildren();
      traceBody.append(el("div", "alert err", `<span>⚠</span><span class="msg">${esc(err.message)}</span>`));
    }
  }

  async function loadTrace() {
    if (disposed) return;
    try {
      const entries = await api.trace({ limit: 12 });
      const countEl = traceCard.querySelector("#trace-count");
      if (countEl) countEl.textContent = `最近 ${entries.length} 条 · 内核 journal 只读追加`;
      if (entries.length === 0) {
        traceBody.replaceChildren(empty("暂无内核追踪事件，去实例页跑一轮", "≡"));
        return;
      }
      const list = el("div", "mini-trace");
      for (const e of entries) {
        const cls = e.entryClass ?? "OTHER";
        const who = e.pluginUnitId ?? e.agentBoxId ?? "host";
        const payload = JSON.stringify(e.factPayload ?? {});
        const row = el("div", "t-entry", `
          <span class="t-time mono">${fmtTime(e.occurredAt)}</span>
          <span class="t-class ec-${esc(cls)}">${esc(cls)}</span>
          <span class="t-payload mono"><b>${esc(who)}</b> ${esc(payload.slice(0, 120))}${payload.length > 120 ? "…" : ""}</span>`);
        row.title = `${e.entryUid}\ntrace: ${e.traceMarkId}\n${payload}`;
        list.append(row);
      }
      traceBody.replaceChildren(list);
    } catch { /* 追踪日志加载失败不打断审计视图 */ }
  }

  function rowOf(e) {
    const tr = el("tr", "", `
      <td class="mono">${fmtDate(e.ts)} ${fmtTime(e.ts)}</td>
      <td>${esc(e.actor)}</td>
      <td class="mono">${esc(e.action)}</td>
      <td class="mono">${esc(e.target || "—")}</td>
      <td>${badge(levelLabel(e.level), LEVEL_TONE[e.level] ?? "neutral")}</td>
      <td class="t-payload">${esc(e.detail || "—")}</td>`);
    if (e.route) {
      tr.style.cursor = "pointer";
      tr.title = `点击前往 ${e.route}`;
      tr.addEventListener("click", () => go(e.route));
    }
    return tr;
  }

  async function exportAs(format) {
    try {
      const res = await api.auditExport(format, {
        actor: actorF.value.trim() || undefined,
        action: actionF.value || undefined,
        level: levelF.value || undefined
      });
      const blob = new Blob([res.content], { type: res.mime });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = res.filename;
      a.click();
      URL.revokeObjectURL(a.href);
      toast(`已导出 ${res.filename}`, "ok");
      load();
    } catch (err) {
      toast(`导出失败：${err.message}`, "err");
    }
  }

  actorF.addEventListener("input", debounce(load, 300));
  actionF.addEventListener("change", load);
  levelF.addEventListener("change", load);
  traceCard.querySelector("#goto-replay").addEventListener("click", () => go("replay"));

  await load();
  await loadTrace();
  timer = setInterval(() => {
    if (autoF.checked) { load(); loadTrace(); }
  }, 5000);

  return {
    dispose() {
      disposed = true;
      clearInterval(timer);
    },
    refresh: () => renderAudit(root)
  };
}

function levelLabel(level) {
  return { ok: "正常", warn: "告警", err: "异常" }[level] ?? level;
}

function field(text, control) {
  const f = el("div", "field");
  f.style.marginBottom = "0";
  f.append(el("label", "", esc(text)));
  f.append(control);
  return f;
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}
