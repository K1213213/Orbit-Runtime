/**
 * 插件注册视图：pact 表单 + 注册清单 + 通道覆盖演示。
 */
import { api } from "../api.js";
import { el, esc, badge, toast, empty } from "../app.js";

const ALL_CAPS = [
  { key: "channel:read", label: "channel:read · 读通道" },
  { key: "channel:write", label: "channel:write · 写通道" }
];

const ALL_CHANNELS = [
  { key: "llm-access", label: "llm-access" },
  { key: "mem-kv-store", label: "mem-kv-store" }
];

export async function renderMarket(root) {
  const wrap = el("div", "");

  /* ---- 注册表单 ---- */
  const form = el("form", "card");
  const head = el("div", "card-head", "<h3>注册插件 · Plugin Pact</h3><span class='sub'>字段 / 版本 / 能力三重校验</span>");
  const body = el("div", "card-body");

  const idF = input("text", "plugin.weather", "如 plugin.weather");
  const nameF = input("text", "Weather Lookup Plugin", "显示名称");
  const edF = input("text", "1.2.0");
  const minEdF = input("text", "1.0.0");

  const capsWrap = el("div");
  ALL_CAPS.forEach((c) => {
    const row = el("label", "row", `<input type="checkbox" value="${c.key}" checked /> ${c.label}`);
    capsWrap.append(row);
  });

  const depsWrap = el("div");
  ALL_CHANNELS.forEach((c) => {
    const row = el("label", "row", `<input type="checkbox" value="${c.key}" /> ${c.label}`);
    depsWrap.append(row);
  });

  body.append(
    field("插件 ID *", idF),
    field("显示名称 *", nameF),
    el("div", "grid cols-2", [field("版本 edition *", edF), field("要求主机最低版本 *", minEdF)]),
    el("div", "", [label("声明能力 allowCapabilities *"), capsWrap]),
    el("div", "mt8", [
      label("通道依赖 declareChannelDeps"),
      depsWrap,
      el("div", "hint", "若勾选依赖但未勾选对应能力，pact 校验会拒绝注册（能力闭包检查）。")
    ]),
    el("div", "mt16 row", [
      submitBtn("注册插件", async () => {
        const pact = {
          id: idF.value.trim(),
          displayName: nameF.value.trim(),
          edition: edF.value.trim(),
          requireHostMinEdition: minEdF.value.trim(),
          allowCapabilities: [...capsWrap.querySelectorAll("input:checked")].map((i) => i.value),
          declareChannelDeps: [...depsWrap.querySelectorAll("input:checked")].map((i) => i.value)
        };
        try {
          const list = await api.registerPlugin(pact);
          toast(`插件 ${pact.id} 已通过 pact 校验并注册`, "ok");
          refreshTable(list);
        } catch (err) {
          toast(`注册被拒绝：${err.message}`, "err");
          showPactError(err.message);
        }
      }),
      resetBtn("重置插件区", async () => {
        try {
          await api.resetPlugins();
          toast("插件区已重置（依赖图已重建）", "ok");
          refreshTable(await api.plugins());
        } catch (err) {
          toast(`重置失败：${err.message}`, "err");
        }
      })
    ])
  );

  form.append(head, body);

  /* ---- 插件清单 ---- */
  const tableCard = el("div", "card mt16");
  tableCard.append(el("div", "card-head", "<h3>注册清单</h3><span class='sub' id='plugin-count'>—</span>"));

  let tblBody;
  async function refreshTable(list) {
    const countEl = tableCard.querySelector("#plugin-count");
    countEl.textContent = `${list.length} 个插件 · 每个插件有独立熔断器与故障日志`;
    if (list.length === 0) {
      tblBody.replaceChildren(empty("尚未注册插件，用左侧表单注册一个试试", "◱"));
      return;
    }
    const rows = list.map((p) => `
      <tr>
        <td class="mono">${esc(p.id)}</td>
        <td>${esc(p.displayName)}</td>
        <td class="mono">${esc(p.edition)} → ${esc(p.requireHostMinEdition)}</td>
        <td>${(p.allowCapabilities ?? []).map((c) => badge(c, c.includes("write") ? "violet" : "ok")).join(" ") || badge("—", "neutral")}</td>
        <td>${(p.declareChannelDeps ?? []).map((d) => badge(d, "gold")).join(" ") || badge("—", "neutral")}</td>
      </tr>`);
    tblBody.innerHTML = rows;
  }

  tblBody = el("tbody");
  const tblWrap = el("div", "tbl-wrap");
  const tableEl = el("table", "tbl", `<thead><tr><th>插件 ID</th><th>名称</th><th>版本（插件 → 主机要求）</th><th>能力</th><th>通道依赖</th></tr></thead>`);
  tableEl.append(tblBody);
  tblWrap.append(tableEl);
  tableCard.append(tblWrap);

  /* ---- 插件通道覆盖演示 ---- */
  const chCard = el("div", "card mt16");
  chCard.append(el("div", "card-head", "<h3>插件通道覆盖 · Plugin-first</h3><span class='sub'>插件提供的通道优先于内置通道</span>"));
  const chBody = el("div", "card-body");
  let chList = [];
  let chTbl;

  async function refreshChannels() {
    chList = await api.channels();
    chTbl.innerHTML = chList.map((c) => `
      <tr>
        <td class="mono">${esc(c.kind)}</td>
        <td>${badge(c.type === "builtin" ? "builtin" : "plugin · echo-plugin", c.type === "builtin" ? "neutral" : "violet")}</td>
        <td class="mono">${c.cost.costPerCall} / ${c.cost.latencyMs}ms / ${c.cost.quality}</td>
        <td>${c.type === "plugin"
          ? `<button class="btn sm danger" data-unplug="${esc(c.kind)}">移除覆盖</button>`
          : `<button class="btn sm" data-plug="${esc(c.kind)}">用 echo 插件覆盖</button>`}</td>
      </tr>`).join("");
    chBody.querySelectorAll("[data-plug]").forEach((b) =>
      b.addEventListener("click", async () => {
        try {
          await api.registerPluginChannel(b.dataset.plug);
          toast(`通道 ${b.dataset.plug} 已被 echo 插件覆盖（plugin-first）`, "ok");
          await refreshChannels();
        } catch (err) { toast(err.message, "err"); }
      }));
    chBody.querySelectorAll("[data-unplug]").forEach((b) =>
      b.addEventListener("click", async () => {
        try {
          await api.removePluginChannel(b.dataset.unplug);
          toast(`已移除插件覆盖，回退内置通道`, "ok");
          await refreshChannels();
        } catch (err) { toast(err.message, "err"); }
      }));
  }

  chTbl = el("tbody");
  const chWrap = el("div", "tbl-wrap");
  const chTable = el("table", "tbl", `<thead><tr><th>通道</th><th>提供方</th><th>成本 / 延迟 / 质量</th><th>操作</th></tr></thead>`);
  chTable.append(chTbl);
  chWrap.append(chTable);
  chBody.append(chWrap);
  chBody.append(el("p", "hint", "覆盖后，沙箱对话中的 LLM 调用将由 echo 插件通道响应（延迟降为 1/4），展示通道级插件优先。"));
  chCard.append(chBody);

  /* ---- pact 错误提示 ---- */
  const errBox = el("div", "alert err", "<span>✕</span><span class='msg' id='pact-err'></span>");
  errBox.style.display = "none";
  wrap.append(form, errBox, tableCard, chCard);

  function showPactError(msg) {
    errBox.querySelector("#pact-err").textContent = `Pact 校验拒绝：${msg}`;
    errBox.style.display = "flex";
    setTimeout(() => { errBox.style.display = "none"; }, 6000);
  }

  try {
    await refreshTable(await api.plugins());
    await refreshChannels();
  } catch (err) {
    wrap.append(el("div", "alert err", `<span>⚠</span><span class="msg">${esc(err.message)}</span>`));
  }

  root.append(wrap);
  return { dispose() {}, refresh: () => renderMarket(root) };
}

/* ---- 表单小部件 ---- */
function label(text) {
  return el("label", "", `<span style="font-size:12px;color:var(--text-2);font-weight:550">${esc(text)}</span>`);
}

function input(type, value, placeholder) {
  const i = el("input", "input");
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

function submitBtn(text, fn) {
  const b = el("button", "btn primary", text);
  b.type = "button";
  b.addEventListener("click", fn);
  return b;
}

function resetBtn(text, fn) {
  const b = el("button", "btn", text);
  b.type = "button";
  b.addEventListener("click", fn);
  return b;
}
