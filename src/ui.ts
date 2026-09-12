// 轻量 DOM 工具与通用组件
import { escapeHtml } from "./utils.ts";
import { pushEsc } from "./escape.ts";

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, unknown> = {},
  ...children: Array<Node | string | number | null | undefined>
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null) continue;
    if (k === "class") node.className = String(v);
    else if (k === "dataset") Object.assign(node.dataset, v as Record<string, string>);
    else if (k === "style" && typeof v === "object") Object.assign(node.style, v as Partial<CSSStyleDeclaration>);
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (k === "html" && typeof v === "string") node.innerHTML = v;
    else if (k === "text") node.textContent = String(v);
    else if ((k === "value" || k === "checked") && k in node) (node as any)[k] = v;
    else node.setAttribute(k, String(v));
  }
  for (const c of children) {
    if (c == null) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

export function toast(message: string, type: "ok" | "err" = "ok", duration = 1600): void {
  let wrap = document.querySelector(".toast-wrap") as HTMLElement | null;
  if (!wrap) { wrap = h("div", { class: "toast-wrap" }); document.body.append(wrap); }
  const t = h("div", { class: "toast " + type, text: message });
  wrap.append(t);
  setTimeout(() => { t.style.opacity = "0"; t.style.transition = "opacity .3s ease"; setTimeout(() => t.remove(), 320); }, duration);
}

/** Escape 取消确认弹窗 */
export function confirmDialog(title: string, message: string, okText = "删除"): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = h("div", { class: "overlay" });
    let off: () => void = () => {};
    const cleanup = () => { overlay.remove(); off(); };
    off = pushEsc(() => { cleanup(); resolve(false); return true; });
    const modal = h("div", { class: "modal", style: { width: "360px" } },
      h("div", { class: "modal-head" }, h("div", { class: "modal-title", text: title })),
      h("div", { class: "modal-body" }, h("div", { text: message, style: { fontSize: "13px", color: "var(--text-2)", lineHeight: "1.7" } })),
      h("div", { class: "modal-foot" },
        h("button", { class: "btn", text: "取消", onclick: () => { cleanup(); resolve(false); } }),
        h("button", { class: "btn danger", text: okText, onclick: () => { cleanup(); resolve(true); } })
      )
    );
    overlay.append(modal);
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) { cleanup(); resolve(false); } });
    document.body.append(overlay);
  });
}

/** 模态框（返回关闭函数）; Escape 关闭弹窗 */
export function openModal(title: string, body: Node, opts: { width?: string } = {}): () => void {
  const overlay = h("div", { class: "overlay" });
  let off: () => void = () => {};
  let close: () => void = () => {};
  close = () => { overlay.remove(); off(); };
  off = pushEsc(() => { close(); return true; });
  const modal = h("div", { class: "modal" },
    h("div", { class: "modal-head" },
      h("div", { class: "modal-title", text: title }),
      h("button", { class: "btn ghost", html: "✕", onclick: close })
    ),
    h("div", { class: "modal-body" }, body)
  );
  if (opts.width) modal.style.width = opts.width;
  overlay.append(modal);
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
  document.body.append(overlay);
  return close;
}

export function escapeAttrs(s: string): string {
  return escapeHtml(s).replace(/'/g, "&#39;");
}
