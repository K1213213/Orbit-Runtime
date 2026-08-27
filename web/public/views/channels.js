/**
 * 模型通道视图：真实模型（DeepSeek）接入 + 通道状态管理。
 */
import { api } from "../api.js";
import { el, esc, badge, toast, empty, loading } from "../app.js";

function input(type, value = "", ph = "") {
  const i = document.createElement("input");
  i.type = type;
  i.value = value;
  i.placeholder = ph;
  return i;
}

export async function renderChannels(root) {
  const wrap = el("div", "");
  wrap.append(loading());

  let channels = [];
  try {
    channels = await api.channels();
  } catch (err) {
    wrap.innerHTML = "";
    wrap.append(el("div", "card", `<div class="card-body">加载失败：${esc(err.message)}</div>`));
    root.append(wrap);
    return;
  }
  wrap.innerHTML = "";

  const llm = channels.find((c) => c.kind === "llm-access");

  /* ---- DeepSeek 接入卡片 ---- */
  const dsCard = el("div", "card");
  const dsHead = el("div", "card-head", "<h3>接入真实模型 · DeepSeek</h3><span class='sub'>OpenAI 兼容 · 零额外依赖 · 支持确定性重放</span>");
  const dsBody = el("div", "card-body");

  if (llm && llm.type === "deepseek") {
    dsBody.append(
      el("div", "ok-banner", `已接入 ${esc(llm.label)} — 沙箱对话将调用真实模型（密钥仅存于运行时内存）`),
      el("div", "btn-row", btn("移除 DeepSeek，恢复 Mock", "danger", async () => {
        try {
          await api.removeDeepSeek();
          toast("已恢复 Mock LLM 通道");
          renderChannels(root);
        } catch (err) {
          toast(err.message, "danger");
        }
      }))
    );
  } else {
    const keyF = input("password", "", "sk-…（仅保存在内存，不落盘）");
    const modelF = input("text", "deepseek-chat", "模型：deepseek-chat / deepseek-reasoner");
    const tempF = input("number", "1.0", "temperature（可选）");
    tempF.style.width = "120px";

    const form = el("form", "field-grid");
    form.append(
      el("label", "field", `<span>API Key</span>`),
      keyF,
      el("label", "field", `<span>模型</span>`),
      modelF,
      el("label", "field", `<span>Temperature</span>`),
      tempF
    );
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const key = keyF.value.trim();
      if (!key) {
        toast("请填写 API Key", "danger");
        return;
      }
      try {
        await api.registerDeepSeek(key, modelF.value.trim() || "deepseek-chat", Number(tempF.value) || undefined);
        toast("DeepSeek 通道已接入");
        renderChannels(root);
      } catch (err) {
        toast(err.message, "danger");
      }
    });

    dsBody.append(
      el("p", "sub", "注册后沙箱对话（boxes 页）将走真实 DeepSeek 模型；回放实验室（replay 页）仍可零 API 调用精确重放。"),
      form,
      el("div", "btn-row", btn("接入 DeepSeek", "primary", null, form))
    );
  }
  dsCard.append(dsHead, dsBody);
  wrap.append(dsCard);

  /* ---- 通道状态列表 ---- */
  const listCard = el("div", "card");
  const listHead = el("div", "card-head", "<h3>通道状态</h3><span class='sub'>插件通道优先于内置通道</span>");
  const listBody = el("div", "card-body");
  channels.forEach((c) => {
    const tone = c.type === "builtin" ? "neutral" : c.type === "deepseek" ? "accent" : "warn";
    const row = el("div", "chan-row",
      `<span class="mono">${esc(c.kind)}</span>` +
      badge(c.type === "builtin" ? "内置" : c.type === "deepseek" ? "DeepSeek" : "插件覆盖", tone) +
      `<span class="sub">${esc(c.label)}</span>`
    );
    if (c.kind === "llm-access" && c.type === "builtin") {
      row.append(btn("用 Echo 插件覆盖", "ghost", async () => {
        try {
          await api.registerPluginChannel("llm-access");
          toast("Echo 插件已覆盖 LLM 通道");
          renderChannels(root);
        } catch (err) {
          toast(err.message, "danger");
        }
      }));
    }
    listBody.append(row);
  });
  if (channels.length === 0) listBody.append(empty("暂无通道"));
  listCard.append(listHead, listBody);
  wrap.append(listCard);

  root.append(wrap);
}

function btn(label, tone, onClick, form) {
  const b = document.createElement("button");
  b.type = form ? "submit" : "button";
  b.className = `btn ${tone}`;
  b.textContent = label;
  if (onClick) b.addEventListener("click", onClick);
  return b;
}
