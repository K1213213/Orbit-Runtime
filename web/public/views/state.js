/**
 * 全局状态页：404 / 403 / 通用空与异常态。
 * 纯展示，无业务依赖；被 app.js 的路由兜底与权限拦截直接调用。
 */
import { el, esc, go } from "../app.js";

const PALETTES = {
  404: { code: "404", title: "页面不存在", tone: "warn",
    desc: "你访问的地址不在控制台内，可能已被移动或从未存在。" },
  403: { code: "403", title: "无访问权限", tone: "err",
    desc: "当前账号角色无权查看此页面。如需访问，请联系管理员调整权限策略。" },
  offline: { code: "离线", title: "服务未连接", tone: "warn",
    desc: "无法连接桥接服务，请确认服务已启动后刷新页面。" },
  error: { code: "!", title: "发生异常", tone: "err",
    desc: "视图在渲染过程中抛出异常，详情见浏览器控制台。" }
};

export function renderStatePage(root, kind = "404", hint = "") {
  const p = PALETTES[kind] ?? PALETTES["404"];
  const wrap = el("div", "state-page");
  const card = el("div", "state-card");
  card.append(
    el("div", `sp-code ${p.tone}`, esc(p.code)),
    el("div", "sp-title", esc(p.title)),
    el("div", "sp-desc", esc(p.desc)),
    hint ? el("div", "sp-hint mono", esc(hint)) : el("div", ""),
    (() => {
      const btn = el("button", "btn primary", "返回数据总览");
      btn.type = "button";
      btn.addEventListener("click", () => go("overview"));
      return btn;
    })()
  );
  wrap.append(card);
  root.append(wrap);
  return { dispose() {} };
}
