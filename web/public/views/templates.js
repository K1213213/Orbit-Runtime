/**
 * 智能体模板 · 版本化人设快照
 *
 * 模板是"可复用的人设配置"：基础指令、循环预算、回放模式与通道依赖。
 * 关键约束是**版本链只追加**：回滚不是改写历史，而是把旧快照复制成一个
 * 新版本并记下 rollbackOf——否则"当前是第几版"就会变成一个谎言。
 */
import { api } from "../api.js";
import { el, esc, badge, badgeEl, toast, empty, drawer, modal, confirmDialog, fmtDate } from "../app.js";
import { channelLabel } from "../lib.js";

const REPLAY_TONE = { live: "ok", record: "warn", replay: "violet" };
const REPLAY_LABEL = { live: "实时", record: "录制", replay: "回放" };

export async function renderTemplates(root) {
  const wrap = el("div", "");
  const grid = el("div", "tpl-grid");

  const headCard = el("div", "card");
  const headBody = el("div", "card-body");
  const createBtn = el("button", "btn primary sm", "＋ 新建模板");
  createBtn.type = "button";
  createBtn.addEventListener("click", () => openEditor(null));
  headBody.append(el("div", "row", [
    createBtn,
    el("span", "hint grow", "模板被实例与工作流引用；保存即产生新版本，历史版本可回滚")
  ]));
  headCard.append(el("div", "card-head", "<h3>智能体模板</h3><span class='sub' id='tpl-count'>—</span>"), headBody);

  wrap.append(headCard, el("div", "section-gap"), grid);
  root.append(wrap);

  async function load() {
    let list = [];
    try {
      list = await api.templates();
    } catch (err) {
      grid.replaceChildren(el("div", "alert err", `<span>⚠</span><span class="msg">${esc(err.message)}</span>`));
      return;
    }
    headCard.querySelector("#tpl-count").textContent = `${list.length} 个模板`;
    if (list.length === 0) {
      grid.replaceChildren(empty("还没有模板，新建一个作为实例的初始配置", "◱"));
      return;
    }
    grid.replaceChildren(...list.map(cardOf));
  }

  function cardOf(t) {
    const snap = t.snapshot ?? {};
    const card = el("div", "tpl-card");
    card.title = t.id; // 原始 id 只进悬浮提示，卡片正面不裸露内部标识

    const head = el("div", "tx-head");
    head.append(el("div", "avatar", esc(String(t.name ?? "?").slice(0, 1))));
    const meta = el("div", "grow");
    meta.append(el("b", "", esc(t.name)));
    meta.append(el("div", "hint", `v${esc(t.currentVersion)} · 更新于 ${esc(fmtDate(t.updatedAt))}`));
    head.append(meta, badgeEl(REPLAY_LABEL[snap.replayMode] ?? snap.replayMode ?? "—", REPLAY_TONE[snap.replayMode] ?? "neutral"));
    card.append(head);

    card.append(el("div", "tx-desc mt8", esc(t.desc || "（无描述）")));

    const tags = el("div", "tx-tags mt8");
    for (const dep of snap.channelDeps ?? []) tags.append(badgeEl(channelLabel(dep), "violet"));
    tags.append(badgeEl(`循环上限 ${snap.maxCycleRun ?? "—"} 轮`, "neutral"));
    if (snap.budgetPerCycle !== undefined && snap.budgetPerCycle !== null) {
      tags.append(badgeEl(`每轮预算 ${snap.budgetPerCycle}`, "gold"));
    }
    card.append(tags);

    const foot = el("div", "tx-foot mt8");
    const edit = el("button", "btn sm", "存为新版本");
    const vers = el("button", "btn sm", `历史（${t.versionCount}）`);
    const copy = el("button", "btn sm", "复制");
    const del = el("button", "btn sm danger", "删除");
    edit.type = vers.type = copy.type = del.type = "button";
    edit.addEventListener("click", () => openEditor(t));
    vers.addEventListener("click", () => openVersions(t));
    copy.addEventListener("click", () => copyTemplate(t));
    del.addEventListener("click", async () => {
      const ok = await confirmDialog("删除模板", `确认删除「${t.name}」？全部版本一并移除。`, "删除");
      if (!ok) return;
      try {
        await api.removeTemplate(t.id);
        toast("模板已删除", "ok");
        await load();
      } catch (err) { toast(err.message, "err"); }
    });
    foot.append(edit, vers, copy, del);
    card.append(foot);
    return card;
  }

  function copyTemplate(tpl) {
    openEditor({
      id: undefined,
      name: `${tpl.name} 副本`,
      desc: tpl.desc,
      snapshot: tpl.snapshot
    });
  }

  function openEditor(tpl) {
    const snap = tpl?.snapshot ?? {};
    const nameF = el("input", "input");
    nameF.value = tpl?.name ?? "";
    nameF.placeholder = "如：知客 · 通用问答";
    const descF = el("input", "input");
    descF.value = tpl?.desc ?? "";
    const instructF = el("textarea", "input");
    instructF.value = snap.baseInstruct ?? "You are a demo assistant.";
    const maxF = el("input", "input");
    maxF.type = "number";
    maxF.value = String(snap.maxCycleRun ?? 5);
    const budgetF = el("input", "input");
    budgetF.type = "number";
    budgetF.value = snap.budgetPerCycle === undefined || snap.budgetPerCycle === null ? "" : String(snap.budgetPerCycle);
    const modeF = el("select", "select");
    for (const m of ["live", "record", "replay"]) {
      const o = el("option", "", esc(REPLAY_LABEL[m]));
      o.value = m;
      modeF.append(o);
    }
    modeF.value = snap.replayMode ?? "live";
    const depsF = el("input", "input");
    depsF.value = (snap.channelDeps ?? ["llm-access"]).join(", ");
    const noteF = el("input", "input");
    noteF.placeholder = "本次保存的说明（写进版本记录）";

    const body = el("div", "", [
      el("div", "grid cols-2", [field("名称 *", nameF), field("描述", descF)]),
      field("基础指令 baseInstruct", instructF),
      el("div", "grid cols-3", [field("循环预算 maxCycleRun", maxF), field("每轮成本预算（可空）", budgetF), field("回放模式", modeF)]),
      field("通道依赖（逗号分隔）", depsF),
      field("版本说明", noteF)
    ]);

    const m = modal(tpl ? `存为新版本 · ${tpl.name}` : "新建模板", body, el("div", "row"));
    const cancel = el("button", "btn", "取消");
    const ok = el("button", "btn primary", tpl ? "保存新版本" : "创建");
    cancel.type = ok.type = "button";
    cancel.addEventListener("click", () => m.close());
    ok.addEventListener("click", async () => {
      const name = nameF.value.trim();
      if (!name) { toast("名称为必填", "err"); return; }
      ok.disabled = true;
      try {
        await api.saveTemplate({
          id: tpl?.id,
          name,
          desc: descF.value.trim(),
          note: noteF.value.trim(),
          baseInstruct: instructF.value,
          maxCycleRun: Number(maxF.value || 5),
          budgetPerCycle: budgetF.value === "" ? null : Number(budgetF.value),
          replayMode: modeF.value,
          channelDeps: depsF.value.split(",").map((s) => s.trim()).filter(Boolean)
        });
        toast(tpl ? "已保存为新版本" : "模板已创建", "ok");
        m.close();
        await load();
      } catch (err) {
        toast(err.message, "err");
        ok.disabled = false;
      }
    });
    m.foot.append(cancel, ok);
  }

  async function openVersions(tpl) {
    let versions = [];
    try {
      versions = await api.templateVersions(tpl.id);
    } catch (err) {
      toast(err.message, "err");
      return;
    }
    const list = el("div", "ver-list");
    for (const v of [...versions].reverse()) {
      const item = el("div", `ver-item${v.isCurrent ? " current" : ""}`, `
        <span class="ver-no">v${esc(v.version)}</span>
        <span class="ver-meta">${esc(v.note || "—")} · ${esc(fmtDate(v.createdAt))}${
          v.rollbackOf ? ` · 回滚自 v${esc(v.rollbackOf)}` : ""}</span>`);
      if (!v.isCurrent) {
        const rb = el("button", "btn sm", "回滚到此版");
        rb.type = "button";
        rb.addEventListener("click", async () => {
          try {
            await api.rollbackTemplate(tpl.id, v.version);
            toast(`已回滚至 v${v.version}（作为新版本追加）`, "ok");
            await load();
          } catch (err) { toast(err.message, "err"); }
        });
        item.append(rb);
      } else {
        item.append(badgeEl("当前", "ok"));
      }
      if (v.version > 1) {
        const cmp = el("button", "btn sm", "对比上一版");
        cmp.type = "button";
        cmp.addEventListener("click", () => openCompare(tpl.name, v, versions));
        item.append(cmp);
      }
      list.append(item);
    }
    drawer(`版本历史 · ${tpl.name}`, list);
  }

  function openCompare(name, cur, all) {
    const prev = all.find((x) => x.version === cur.version - 1);
    if (!prev) { toast("没有更早的版本可对比", "err"); return; }
    const fields = [
      { key: "baseInstruct", label: "基础指令", type: "text" },
      { key: "maxCycleRun", label: "循环预算", type: "num" },
      { key: "budgetPerCycle", label: "每轮预算", type: "num" },
      { key: "replayMode", label: "回放模式", type: "text" },
      { key: "channelDeps", label: "通道依赖", type: "list" }
    ];
    const body = el("div", "");
    body.append(el("div", "sub", `v${prev.version} → v${cur.version} · 逐字段差异`));
    const tbl = el("table", "tbl compare-tbl");
    tbl.innerHTML = `<thead><tr><th>字段</th><th>上一版</th><th>本版</th><th>变化</th></tr></thead>`;
    const tbody = el("tbody");
    for (const f of fields) {
      const a = prev.snapshot?.[f.key];
      const b = cur.snapshot?.[f.key];
      let changed = false;
      let aStr = "", bStr = "";
      if (f.type === "list") {
        aStr = (a ?? []).join(", "); bStr = (b ?? []).join(", ");
        changed = aStr !== bStr;
      } else {
        aStr = String(a ?? "—"); bStr = String(b ?? "—");
        changed = aStr !== bStr;
      }
      const tr = el("tr", changed ? "changed" : "", `
        <td>${esc(f.label)}</td>
        <td class="mono">${esc(aStr)}</td>
        <td class="mono">${esc(bStr)}</td>
        <td>${changed ? badge("有变更", "warn") : badge("未变", "neutral")}</td>`);
      tbody.append(tr);
    }
    tbl.append(tbody);
    body.append(tbl);
    drawer(`版本对比 · ${name}`, body);
  }

  await load();
  return { dispose() {}, refresh: () => renderTemplates(root) };
}

function field(text, control) {
  const f = el("div", "field");
  f.append(el("label", "", esc(text)));
  f.append(control);
  return f;
}
