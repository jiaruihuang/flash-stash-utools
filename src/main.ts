import "./style.css";
import { Store } from "./db.ts";
// detectKind removed: clipboard saves default to "text" to avoid false positives
import { renderMain } from "./views/main-view.ts";
import { renderSave } from "./views/save-view.ts";
import type { SaveInit } from "./views/save-view.ts";
import { toast } from "./ui.ts";
import { initGlobalEscape, resetEsc } from "./escape.ts";

const app = document.getElementById("app")!;

function applyTheme(): void {
  try {
    const dark = window.utools?.isDarkColors?.();
    if (typeof dark === "boolean") {
      document.documentElement.dataset.theme = dark ? "dark" : "light";
    } else {
      delete document.documentElement.dataset.theme;
    }
  } catch {
    delete document.documentElement.dataset.theme;
  }
}

const store = window.utools?.db ? new Store(window.utools.db) : null;

/**
 * 取进入插件时带过来的文本（0.6.0）。
 * uTools 的 `payload` 随场景不同可能是字符串、`{ text }`（带 type 的对象），
 * 也可能是数组（多文件/多段）；此前只认字符串，遇到对象 payload 会「内容为空」，
 * 这里统一兜底，避免用户看到「内容不能为空」却不知所措。
 */
function extractText(payload: unknown): string {
  if (typeof payload === "string") return payload;
  if (Array.isArray(payload)) return payload.map((x) => extractText(x)).filter(Boolean).join("\n");
  if (payload && typeof payload === "object") {
    const o = payload as Record<string, unknown>;
    for (const k of ["text", "content", "value", "payload", "data"]) {
      if (typeof o[k] === "string") return o[k] as string;
    }
    try { return JSON.stringify(payload); } catch { return ""; }
  }
  return "";
}

if (!store) {
  app.innerHTML =
    '<div style="padding:48px;text-align:center;color:var(--text-2);line-height:2">闪藏需要在 uTools 环境中运行' +
    '<br><span style="font-size:12px;color:var(--text-3)">请通过 uTools 搜索「闪藏」进入</span></div>';
} else {
  const st: Store = store;
  applyTheme();
  try {
    window.utools?.onThemeChange?.(applyTheme);
  } catch { /* 忽略 */ }

  function closeWindow(): void {
    try {
      window.utools?.outPlugin?.();
    } catch { /* 忽略 */ }
  }

  function showMain(): void {
    try { window.utools?.removeSubInput?.(); } catch { /* 忽略 */ }
    try { window.utools?.setExpendHeight?.(560); } catch { /* 忽略 */ }
    resetEsc();
    app.replaceChildren();
    renderMain(app, st, {
      onEdit: (s) =>
        showSave({
          mode: "edit",
          kind: s.kind,
          content: s.content,
          snippet: s
        }),
      onAdd: () => showSave({ mode: "create", kind: "text", content: "", from: "main", source: "text" })
    });
  }

  function showSave(init: SaveInit): void {
    try { window.utools?.removeSubInput?.(); } catch { /* 忽略 */ }
    try { window.utools?.setExpendHeight?.(620); } catch { /* 忽略 */ }
    resetEsc();
    app.replaceChildren();
    renderSave(app, st, init, {
      onOpenMain: showMain,
      onNewAgain: () => showSave({ mode: "create", kind: "text", content: "", from: init.from, source: "text" })
    });
  }

  window.utools?.onPluginEnter?.(({ code, payload }) => {
    const p = extractText(payload);
    switch (code) {
      case "flashstash.main":
        showMain();
        return;
      case "flashstash.save.text":
        showSave({ mode: "create", kind: "text", content: p, from: "utools", source: "text" });
        return;
      case "flashstash.save.md":
        showSave({ mode: "create", kind: "markdown", content: p, from: "utools", source: "markdown" });
        return;
      case "flashstash.save.img":
        showSave({ mode: "create", kind: "image", content: "", imageSource: p, from: "utools", source: "image" });
        return;
      case "flashstash.save.clipboard": {
        const sel = window.flashStash?.readClipboard?.();
        if (sel?.imageDataUrl) {
          showSave({ mode: "create", kind: "image", content: "", imageSource: sel.imageDataUrl, from: "utools", source: "image" });
        } else if (sel?.text) {
          // 剪贴板保存默认 text，不自动判 markdown（见 docs/traps/main-panel.md §4）；
          // 0.6.0 起保存视图会明确提示「正在按文本收藏」，用户想按 Markdown 收藏可一键切换类型
          showSave({ mode: "create", kind: "text", content: sel.text, from: "utools", source: "text" });
        } else {
          toast("剪贴板中没有可保存的内容", "err");
          closeWindow();
        }
        return;
      }
      default:
        showMain();
    }
  });

  // 全局 Escape：由集中式处理器栈统一调度（弹窗/确认框/标签建议/视图各自注册）
  initGlobalEscape();

  // 全局链接拦截（0.5.1）：富文本/预览/弹窗里的 <a> 一律交给系统浏览器打开，
  // 避免 uTools webview 内直接导航导致插件跳成空白页
  document.addEventListener("click", (e) => {
    const a = (e.target as HTMLElement | null)?.closest?.("a") as HTMLAnchorElement | null;
    if (!a || !a.href) return;
    e.preventDefault();
    e.stopPropagation();
    try { window.utools?.shellOpenExternal?.(a.href); } catch { /* 忽略 */ }
  });

  window.utools?.onPluginOut?.(() => {
    try { window.utools?.removeSubInput?.(); } catch { /* 忽略 */ }
  });
}