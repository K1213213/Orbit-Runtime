/**
 * 追踪日志视图：全链路事件流、按 trace / 沙箱过滤、自动刷新、导出。
 */
import { api } from "../api.js";
import { el, esc, fmtTime, fmtDate, toast, empty, loading } from "../app.js";

const CLASS_TONES = {
  AGENT_SINGLE_CYCLE_EXEC: "accent",
  AGENT_CYCLE_LIMIT_HIT: "warn",
  PLUGIN_UNIT_EXCEPTION: "err",
  CHANNEL_CALL: "violet",
  BUDGET: "purple"
};

export async function renderTrace(root) {
  const wrap = el("div", "");

  const card = el("div", "card");
  const filter = el("div", "filter-bar");
  const boxF = el("input");
  boxF.type = "text";
  boxF.placeholder = "按 agentBoxId 过滤…";
  const classF = el("select");
  ["", "AGENT_SINGLE_CYCLE_EXEC", "AGENT_CYCLE_LIMIT_HIT", "PLUGIN_UNIT_EXCEPTION"].forEach((c) => {
    const o = el("option");
    o.value = c;
    o.textContent = c === "" ? "全部事件类型" : c;
    classF.append(o);
  });
  const autoF = el("input");
  autoF.type = "checkbox";
  autoF.checked = true;
  const autoRow = el("label", "check-row");
  autoRow.append(autoF, el("span", "", "自动刷新（3s）"));
  const exportBtn = el("button", "btn sm", "导出 JSON");

  filter.append(
    fieldWrap("沙箱过滤", boxF),
    fieldWrap("事件类型", classF),
    autoRow,
    fieldWrap("", exportBtn)
  );

  const countBar = el("div", "", `<div class="hint" style="padding:8px 18px" id="trace-count">—</div>`);
  const list = el("div", "trace-list");

  card.append(filter, countBar, list);
  wrap.append(card);
  root.append(wrap);

  let timer = null;
  let disposed = false;

  async function load() {
    if (disposed) return;
    const params = {};
    if (boxF.value.trim()) params.box = boxF.value.trim();
    if (classF.value) params.class = classF.value;
    try {
      let entries = await api.trace({ limit: 400 });
      if (classF.value) entries = entries.filter((e) => e.entryClass === classF.value);
      const countEl = card.querySelector("#trace-count");
      if (countEl) countEl.textContent = `共 ${entries.length} 条事件 · 日志为追加式只读，任何执行都会被记录`;
      if (entries.length === 0) {
        list.replaceChildren(empty("暂无匹配的追踪事件", "≡"));
        return;
      }
      list.replaceChildren(...entries.map(renderEntry));
    } catch (err) {
      list.replaceChildren(empty(`加载失败：${err.message}`, "✕"));
    }
  }

  function renderEntry(e) {
    const cls = e.entryClass || "OTHER";
    const who = e.pluginUnitId ?? e.agentBoxId ?? "host";
    const payload = JSON.stringify(e.factPayload ?? {}, null, 0);
    const row = el("div", "t-entry");
    row.innerHTML = `
      <span class="t-time">${fmtDate(e.occurredAt)} ${fmtTime(e.occurredAt)}</span>
      <span class="t-class ec-${cls}">${esc(cls)}</span>
      <span class="t-payload"><b>${esc(who)}</b> · <span class="muted">${esc(payload.slice(0, 140))}${payload.length > 140 ? "…" : ""}</span></span>`;
    row.title = `${e.entryUid}\ntrace: ${e.traceMarkId}\n${payload}`;
    return row;
  }

  exportBtn.addEventListener("click", async () => {
    try {
      const entries = await api.trace({ limit: 2000 });
      const blob = new Blob([JSON.stringify(entries, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `orbit-trace-${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      toast(`已导出 ${entries.length} 条追踪事件`, "ok");
    } catch (err) {
      toast(`导出失败：${err.message}`, "err");
    }
  });

  const reload = () => {
    if (autoF.checked) load();
  };
  boxF.addEventListener("input", debounce(load, 300));
  classF.addEventListener("change", load);
  autoF.addEventListener("change", () => {
    if (autoF.checked) load();
  });

  await load();
  timer = setInterval(reload, 3000);

  return {
    dispose() {
      disposed = true;
      clearInterval(timer);
    },
    refresh: () => renderTrace(root)
  };
}

function label(text) {
  return el("label", "", text);
}

function fieldWrap(text, control) {
  const f = el("div", "field");
  if (text) f.append(label(text));
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
