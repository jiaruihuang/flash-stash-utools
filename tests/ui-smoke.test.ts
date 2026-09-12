// UI 冒烟测试：加载真实构建产物（dist），在 jsdom + utools mock 环境跑通主要流程
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { MemoryDb } from "./memory-db.ts";

const distDir = path.resolve(process.cwd(), "dist", "assets");
const indexHtml = readFileSync(path.resolve(process.cwd(), "dist", "index.html"), "utf8");
const jsFile = indexHtml.match(/assets\/(index-[^"]+\.js)/)?.[1];
assert.ok(jsFile, "dist 中未找到 JS 产物");

const db = new MemoryDb();
const copied: string[] = [];
const openedUrls: string[] = [];
let enterCb: ((a: { code: string; type: string; payload: unknown }) => void) | null = null;
let clipboardText: string | null = null;
let outPluginCalled = false;
let hideMainWindowCalled = false;

const dom = new JSDOM('<!DOCTYPE html><html><body><div id="app"></div></body></html>', {
  pretendToBeVisual: true,
  url: "http://localhost/"
});
const { window } = dom;
(globalThis as never as Record<string, unknown>).window = window;
(globalThis as never as Record<string, unknown>).document = window.document;
(globalThis as never as Record<string, unknown>).HTMLElement = window.HTMLElement;
(globalThis as never as Record<string, unknown>).Node = window.Node;
try {
  Object.defineProperty(globalThis, "navigator", { value: window.navigator, configurable: true });
} catch { /* 忽略 */ }
try {
  Object.defineProperty(globalThis, "location", { value: window.location, configurable: true });
} catch { /* 忽略 */ }
try {
  Object.defineProperty(globalThis, "getSelection", { value: window.getSelection.bind(window), configurable: true });
} catch { /* 忽略 */ }
const browserGlobals = [
  "MutationObserver", "DOMParser", "XMLSerializer", "Range", "Text", "Comment",
  "DocumentFragment", "Event", "KeyboardEvent", "MouseEvent", "CustomEvent", "InputEvent",
  "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLImageElement", "Element",
  "CSSStyleDeclaration", "Image", "Blob", "File", "Node", "window", "document", "NodeList",
  "NamedNodeMap", "URL", "URLSearchParams", "localStorage", "sessionStorage", "StaticRange",
  "requestAnimationFrame", "cancelAnimationFrame", "getComputedStyle"
];
for (const g of browserGlobals) {
  try {
    Object.defineProperty(globalThis, g, { value: (window as never as Record<string, unknown>)[g], configurable: true });
  } catch { /* 忽略 */ }
}

(window as never as Record<string, unknown>).flashStash = {
  getDataDir: () => "/tmp/flash-stash",
  saveImageFile: () => ({ ok: true, path: "/tmp/flash-stash/img.png" }),
  readImageAsDataUrl: () => ({ ok: true, dataUrl: "data:image/png;base64,AAAA" }),
  deleteFile: () => true,
  copyImageByPath: () => ({ ok: true }),
  copyText: (t: string) => { copied.push(t); return { ok: true }; },
  readClipboard: () => ({ text: clipboardText, imageDataUrl: null })
};
(window as never as Record<string, unknown>).utools = {
  db,
  onPluginEnter: (cb: (a: { code: string; type: string; payload: unknown }) => void) => { enterCb = cb; },
  onPluginOut: () => {},
  onThemeChange: () => {},
  isDarkColors: () => false,
  copyText: (t: string) => { copied.push(t); return true; },
  copyImage: () => true,
  getPath: () => "/tmp",
  setExpendHeight: () => true,
  setSubInput: () => true,
  removeSubInput: () => {},
  hideMainWindow: () => { hideMainWindowCalled = true; },
  outPlugin: () => { outPluginCalled = true; },
  showNotification: () => {},
  shellOpenExternal: (url: string) => { openedUrls.push(url); },
  redirectHotKeySetting: () => {}
};

// 模拟 uTools 窗口层：未被插件消费（stopPropagation）的 Escape 会退出插件
window.addEventListener("keydown", (e: KeyboardEvent) => {
  if (e.key === "Escape") outPluginCalled = true;
});

// ProseMirror/Tiptap 在 jsdom 下需要的测量 API 兜底（测试不关心真实布局，给空/零值即可）
const rangeProto = window.Range.prototype as never as Record<string, unknown>;
if (typeof rangeProto.getClientRects !== "function") rangeProto.getClientRects = () => [];
if (typeof rangeProto.getBoundingClientRect !== "function") {
  rangeProto.getBoundingClientRect = () => ({
    x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0
  }) as DOMRect;
}

function enter(action: { code: string; type: string; payload: unknown }): void {
  assert.ok(enterCb, "onPluginEnter 未注册");
  enterCb(action);
}
const app = () => window.document.getElementById("app")!;
const wait = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const click = (el: Element | null) => { assert.ok(el, "目标元素不存在"); (el as HTMLElement).click(); };
/** 取 Tiptap 编辑器实例（保存视图挂在 .rich 上的测试接缝） */
const mdEditorOf = (rich: Element): any =>
  (rich as any)._mdEditor;
/**
 * 把光标放到「包含指定文字的第一个文本块」末尾。
 * 注意：文末有 TrailingNode 补的空段落（表格/代码块/引用结尾时），
 * 所以不能用 focus("end") 来定位到某个块内部。
 */
function caretAtEndOfBlock(editor: any, text: string): number {
  let pos = 1;
  editor.state.doc.descendants((node: any, p: number) => {
    if (node.isTextblock && node.textContent.includes(text)) pos = p + 1 + node.content.size;
    return true;
  });
  editor.commands.setTextSelection(pos);
  return pos;
}
/** 在富文本编辑区上派发键盘事件 */
const keyOn = (rich: Element, key: string, init: { shiftKey?: boolean } = {}) => {
  (rich.querySelector(".ProseMirror") as HTMLElement)
    .dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true, ...init }));
};

before(async () => {
  await import(pathToFileURL(path.resolve(distDir, jsFile)).href);
});

test("收藏文本流程：进入保存视图 → 填写标签备注 → 保存 → 写入 db + 成功浮层", async () => {
  db.put({ _id: "setting/ux", type: "setting", successStyle: "overlay", successDelayMs: 1200 } as never);
  enter({ code: "flashstash.save.text", type: "over", payload: "hello 闪藏测试" });
  await wait();
  assert.ok(text(app(), ".sv-title").includes("收藏到闪藏"), "应进入收藏视图");
  const ta = app().querySelector("textarea.ta") as HTMLTextAreaElement | null;
  assert.ok(ta, "应有文本输入框");
  assert.equal(ta!.value, "hello 闪藏测试", "文本框应预填内容");

  // 加标签与备注
  const tagInput = app().querySelector(".tag-input-wrap input") as HTMLInputElement;
  tagInput.value = "测试";
  tagInput.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  const note = app().querySelectorAll("textarea.input")[0] as HTMLTextAreaElement;
  note.value = "这是备注";
  click(app().querySelector(".sv .btn.primary"));

  await wait(80);
  const snips = db.allDocs("snippet/") as unknown as Array<{ content: string; note: string; tags: string[]; kind: string }>;
  assert.equal(snips.length, 1, "应写入 1 条收藏");
  assert.equal(snips[0].content, "hello 闪藏测试");
  assert.equal(snips[0].note, "这是备注");
  assert.deepEqual(snips[0].tags, ["测试"]);
  assert.equal(snips[0].kind, "text");
  assert.ok(app().querySelector(".succ"), "应显示成功浮层");
});

test("剪贴板收藏：默认文本类型（不自动判定 Markdown）", async () => {
  clipboardText = "# 剪贴板标题\n- 条目A\n- 条目B";
  enter({ code: "flashstash.save.clipboard", type: "text", payload: "" });
  await wait();
  const kindTab = app().querySelector(".kind-tab.active");
  assert.ok(kindTab && kindTab.textContent?.includes("文本"), "剪贴板内容默认保存为文本类型");
});

test("类型切换保留编辑内容：文本 → Markdown", async () => {
  enter({ code: "flashstash.save.text", type: "over", payload: "原始内容" });
  await wait();
  const ta = app().querySelector("textarea.ta") as HTMLTextAreaElement;
  ta.value = "我在文本模式改的内容";
  ta.dispatchEvent(new window.InputEvent("input", { bubbles: true }));
  // 切到 Markdown
  const tabs = app().querySelectorAll(".kind-tab");
  click(tabs[1]);
  await wait();
  // 保存
  click(app().querySelector(".sv .btn.primary"));
  await wait(80);
  const snips = db.allDocs("snippet/") as unknown as Array<{ content: string; kind: string }>;
  const last = snips[snips.length - 1];
  assert.equal(last.content, "我在文本模式改的内容", "切换到 Markdown 后保存应保留文本模式的编辑");
  assert.equal(last.kind, "markdown");
});

test("Markdown 编辑器：富文本/源码/预览三种模式可切换", async () => {
  enter({ code: "flashstash.save.md", type: "over", payload: "# 标题\n**加粗** 内容" });
  await wait();
  const rich = app().querySelector(".rich") as HTMLElement | null;
  assert.ok(rich, "应有富文本编辑区");
  assert.equal(rich!.querySelector(".ProseMirror")?.getAttribute("contenteditable"), "true", "富文本区应可编辑");
  assert.ok(rich!.querySelector("h1"), "标题应渲染为 h1");
  const tabs = [...app().querySelectorAll(".editor-tab")].map((t) => t.textContent?.trim());
  assert.deepEqual(tabs, ["富文本", "源码", "预览"]);

  click(app().querySelectorAll(".editor-tab")[1]); // 源码
  await wait();
  const ta = app().querySelector("textarea.ta") as HTMLTextAreaElement;
  assert.ok(ta && ta.value.includes("# 标题"), "源码模式应显示 Markdown 源码");

  click(app().querySelectorAll(".editor-tab")[2]); // 预览
  await wait();
  assert.ok(app().querySelector(".preview"), "应有预览区");

  // 保存为 markdown
  click(app().querySelector(".sv .btn.primary"));
  await wait(80);
  const snips = db.allDocs("snippet/") as unknown as Array<{ content: string; kind: string }>;
  const mdSnip = snips.find((s) => s.content.includes("# 标题"));
  assert.ok(mdSnip && mdSnip.kind === "markdown", "应保存 markdown 收藏");
});

test("主面板：列表展示、搜索过滤、点击复制", async () => {
  enter({ code: "flashstash.main", type: "text", payload: "" });
  await wait();
  assert.ok(app().querySelector(".mv-title"), "应进入主面板");
  const cards = app().querySelectorAll(".card");
  assert.equal(cards.length, db.allDocs("snippet/").length, "卡片数量应与收藏一致");

  // 找到包含 闪藏测试 的卡片并点击 → 触发复制
  const target = [...cards].find((c) => c.textContent?.includes("闪藏测试"));
  assert.ok(target, "应能找到目标卡片");
  (target as HTMLElement).click();
  assert.ok(copied.length > 0 && copied.includes("hello 闪藏测试"), "点击卡片应复制内容");
});

test("搜索逻辑与界面联动（通过标签筛选 chip）", async () => {
  enter({ code: "flashstash.main", type: "text", payload: "" });
  await wait();
  const chips = [...app().querySelectorAll(".mv-filters .chip")];
  const tagChip = chips.find((c) => c.textContent?.includes("测试"));
  assert.ok(tagChip, "标签筛选 chip 应存在");
  click(tagChip);
  await wait();
  const cards = app().querySelectorAll(".card");
  for (const c of cards) {
    assert.ok(c.textContent?.includes("测试"), "筛选后卡片都应带该标签");
  }
});

test("富文本：代码块按钮无选区时插入真正 pre 块（修订2）", async () => {
  enter({ code: "flashstash.save.md", type: "over", payload: "段落文字" });
  await wait();
  const rich = app().querySelector(".rich") as HTMLElement | null;
  assert.ok(rich, "应有富文本编辑区");
  const p = rich!.querySelector("p");
  assert.ok(p, "应有段落");
  const btn = [...app().querySelectorAll(".tb-btn")].find((b) => b.textContent?.includes("⧉"));
  assert.ok(btn, "应有代码块按钮");
  click(btn!);
  await wait();
  const pre = rich!.querySelector("pre");
  assert.ok(pre, "无选区插入应生成真正 <pre> 代码块");
  // 通过命令在代码块内输入代码（保持编辑器状态一致）
  const editor = mdEditorOf(rich!);
  editor.commands.insertContent("const a = 1;");
  await wait();
  click(app().querySelectorAll(".editor-tab")[1]); // 源码
  await wait();
  const ta = app().querySelector("textarea.ta") as HTMLTextAreaElement;
  assert.ok(ta.value.includes("```"), "源码模式应包含代码围栏");
  assert.ok(ta.value.includes("const a = 1;"), "源码应包含代码内容");
});

test("富文本：引用内空行回车退出引用（修订2）", async () => {
  enter({ code: "flashstash.save.md", type: "over", payload: "> 引用内容" });
  await wait();
  const rich = app().querySelector(".rich") as HTMLElement;
  assert.ok(rich, "应有富文本编辑区");
  const quote = rich.querySelector("blockquote");
  assert.ok(quote, "应有引用块");
  // 光标移到引用文本末尾（显式定位，避免落到文末补的空段落）
  caretAtEndOfBlock(mdEditorOf(rich), "引用内容");
  await wait();
  // 第一次回车：引用内新建空段落（引擎默认拆分块）
  keyOn(rich, "Enter");
  await wait();
  assert.equal(quote!.querySelectorAll("p").length, 2, "回车后引用内应有两个段落");
  // 第二次回车：空段回车退出引用（LegacyEnter 兜底）
  keyOn(rich, "Enter");
  await wait();
  const next = quote!.nextElementSibling as HTMLElement | null;
  assert.ok(next && next.tagName === "P", "引用后应出现普通段落");
});

test("0.5.2：代码块内回车换行、末行 ↓ 退出代码块（引擎标准行为）", async () => {
  enter({ code: "flashstash.save.md", type: "over", payload: "```\ncode line\n```" });
  await wait();
  const rich = app().querySelector(".rich") as HTMLElement;
  assert.ok(rich, "应有富文本编辑区");
  const pre = rich.querySelector("pre") as HTMLElement | null;
  assert.ok(pre && pre.querySelector("code"), "应有代码块");
  // 光标移到代码块末尾（显式定位，避免落到文末补的空段落）
  caretAtEndOfBlock(mdEditorOf(rich), "code line");
  await wait();
  // 回车：代码块内换行（不再用「空行回车退出」的老兜底）
  keyOn(rich, "Enter");
  await wait();
  assert.ok(rich.querySelector("pre") === pre, "回车应留在代码块内");
  // ↓：末行退出代码块
  keyOn(rich, "ArrowDown");
  await wait();
  const next = pre!.nextElementSibling as HTMLElement | null;
  assert.ok(next && next.tagName === "P", "末行 ↓ 应退出代码块到新段落");
});

test("标签建议列表：键盘 ↑/↓ 选择 + 回车添加（修订3A）", async () => {
  const now = Date.now();
  db.put({ _id: "tag/key-1", type: "tag", name: "参考", createdAt: now, updatedAt: now } as never);
  db.put({ _id: "tag/key-2", type: "tag", name: "资料", createdAt: now, updatedAt: now } as never);
  enter({ code: "flashstash.save.text", type: "over", payload: "键盘标签选择测试" });
  await wait();
  const tagInput = app().querySelector(".tag-input-wrap input") as HTMLInputElement;
  assert.ok(tagInput, "应有标签输入框");
  tagInput.value = "参";
  tagInput.dispatchEvent(new window.InputEvent("input", { bubbles: true }));
  await wait();
  const suggest = app().querySelector(".tag-suggest") as HTMLElement;
  assert.equal(suggest.style.display, "block", "建议列表应显示");
  const opts = [...suggest.querySelectorAll(".opt")];
  assert.ok(opts.length >= 1 && opts[0].textContent?.includes("参考"), "应展示匹配的已存在标签");
  tagInput.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  tagInput.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await wait();
  const chips = [...app().querySelectorAll(".chips .chip-item")];
  assert.ok(chips.some((c) => c.textContent?.includes("参考")), "应通过键盘选择了建议标签");
  assert.equal(suggest.style.display, "none", "添加后建议应关闭");
});

test("主面板：键盘 ↑/↓ 选择 + 回车复制（修订3B）", async () => {
  enter({ code: "flashstash.main", type: "text", payload: "" });
  await wait();
  const search = app().querySelector("input.mv-search") as HTMLInputElement;
  assert.ok(search, "应显示插件内搜索输入框");
  const before = copied.length;
  search.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await wait();
  assert.equal(copied.length, before + 1, "回车应复制当前高亮卡片");
  search.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  search.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await wait();
  assert.equal(copied.length, before + 2, "↓ 后回车应复制下一条");
  assert.notEqual(copied[before], copied[before + 1], "两次复制的应是不同卡片");
});

test("保存成功默认直接退出：不显示浮层，调用 outPlugin + hideMainWindow（问题11）", async () => {
  const prevUx = db.get("setting/ux") as { _rev?: string } | null;
  db.put({ _id: "setting/ux", type: "setting", successStyle: "none", successDelayMs: 1200, ...(prevUx?._rev ? { _rev: prevUx._rev } : {}) } as never);
  outPluginCalled = false;
  hideMainWindowCalled = false;
  enter({ code: "flashstash.save.text", type: "over", payload: "快速保存测试" });
  await wait();
  click(app().querySelector(".sv .btn.primary"));
  await wait(80);
  const snips = db.allDocs("snippet/") as unknown as Array<{ content: string }>;
  assert.ok(snips.some((s) => s.content === "快速保存测试"), "应写入收藏");
  assert.equal(app().querySelector(".succ"), null, "不应显示成功浮层");
  assert.equal(outPluginCalled, true, "应调用 outPlugin 退出插件");
  assert.equal(hideMainWindowCalled, true, "应调用 hideMainWindow 恢复之前窗口");
});

test("标签输入：空白回车展示全部已存在标签（问题3）", async () => {
  enter({ code: "flashstash.save.text", type: "over", payload: "空白回车测试" });
  await wait();
  const tagInput = app().querySelector(".tag-input-wrap input") as HTMLInputElement;
  const allTagCount = db.allDocs("tag/").length;
  assert.ok(allTagCount >= 2, "应已有预置标签");
  tagInput.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await wait();
  const suggest = app().querySelector(".tag-suggest") as HTMLElement;
  assert.equal(suggest.style.display, "block", "空白回车应展示建议列表");
  assert.equal(suggest.querySelectorAll(".opt").length, allTagCount, "应展示全部已存在标签");
});

test("主面板：进入时搜索框为空，不预填 uTools 带入的词（问题1）", async () => {
  enter({ code: "flashstash.main", type: "text", payload: "闪藏" });
  await wait();
  const search = app().querySelector("input.mv-search") as HTMLInputElement;
  assert.ok(search, "应显示搜索输入框");
  assert.equal(search.value, "", "进入时应默认空搜索、显示全部收藏");
});

test("主面板：标签多时折叠进「更多标签」多选面板（问题9）", async () => {
  const now = Date.now();
  for (let i = 0; i < 8; i++) {
    db.put({ _id: "tag/many-" + i, type: "tag", name: "批量标签" + i, createdAt: now, updatedAt: now } as never);
  }
  enter({ code: "flashstash.main", type: "text", payload: "" });
  await wait();
  const more = [...app().querySelectorAll(".mv-filters .chip")].find((c) => c.textContent?.includes("更多标签"));
  assert.ok(more, "标签多时应出现「更多标签」按钮");
  click(more);
  await wait();
  const modalChips = document.querySelectorAll(".overlay .modal .chip");
  assert.ok(modalChips.length >= 8, "面板应列出全部标签");
  click(modalChips[0]);
  await wait();
  click(document.querySelectorAll(".overlay .modal .chip")[1]);
  await wait();
  const ok = [...document.querySelectorAll(".overlay .btn")].find((b) => b.textContent?.includes("确定"));
  assert.ok(ok, "应有确定按钮");
  click(ok);
  await wait();
  const actives = app().querySelectorAll(".mv-filters .chip.active");
  assert.ok(actives.length >= 1, "应用筛选后筛选条应有选中标签");
});

test("标签管理：搜索过滤标签（问题8）", async () => {
  enter({ code: "flashstash.main", type: "text", payload: "" });
  await wait();
  const btn = [...app().querySelectorAll(".mv-head-actions .btn")].find((b) => b.textContent?.includes("标签管理"));
  assert.ok(btn, "应有标签管理按钮");
  click(btn);
  await wait();
  const modal = document.querySelector(".overlay .modal");
  assert.ok(modal, "应打开标签管理弹窗");
  const inp = modal?.querySelector("input.input") as HTMLInputElement;
  assert.ok(inp, "应有搜索输入框");
  const rowsAll = modal?.querySelectorAll(".tag-manage-row").length ?? 0;
  assert.ok(rowsAll >= 2, "初始应展示标签列表");
  inp.value = "资料";
  inp.dispatchEvent(new window.InputEvent("input", { bubbles: true }));
  await wait();
  const rows = modal?.querySelectorAll(".tag-manage-row") ?? [];
  assert.ok(rows.length >= 1 && rows.length <= rowsAll, "过滤后行数应在合理范围");
  assert.ok([...rows].some((r) => (r.textContent ?? "").includes("资料")), "应保留匹配标签");
});


// ---------- 修订4：统一 Escape（退出当前子页面，绝不误弹“未保存”） ----------
const esc = () => window.document.body.dispatchEvent(
  new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })
);
// 每个测试开始前清理上一个测试遗留的弹层（弹窗挂在 body、succ 挂在 #app）
const closeAllLayers = () => {
  window.document.querySelectorAll(".overlay").forEach((el) => el.remove());
  app().querySelectorAll(".succ").forEach((el) => el.remove());
};

test("修订4：标签建议列表打开时 Esc 关闭列表，不离开保存视图、不退出插件", async () => {
  closeAllLayers();
  outPluginCalled = false;
  enter({ code: "flashstash.save.text", type: "over", payload: "esc 建议列表测试" });
  await wait();
  const tagInput = app().querySelector(".tag-input-wrap input") as HTMLInputElement;
  tagInput.focus();
  tagInput.dispatchEvent(new window.InputEvent("input", { bubbles: true }));
  await wait();
  const suggest = app().querySelector(".tag-suggest") as HTMLElement;
  assert.equal(suggest.style.display, "block", "建议列表应显示");
  esc();
  await wait();
  assert.equal(suggest.style.display, "none", "Esc 应关闭建议列表");
  assert.ok(app().querySelector(".sv"), "应留在保存视图");
  assert.equal(outPluginCalled, false, "不应退出插件");
});

test("修订4：保存视图无修改 Esc 直接退出，不弹未保存提示", async () => {
  closeAllLayers();
  outPluginCalled = false;
  enter({ code: "flashstash.save.text", type: "over", payload: "无修改退出测试" });
  await wait();
  esc();
  await wait();
  assert.equal(app().querySelector(".overlay"), null, "无修改不应弹未保存提示");
  assert.equal(outPluginCalled, true, "新建流程无修改 Esc 应退出插件");
});

test("修订4：编辑 Markdown 无修改 Esc 直接回主面板，不弹未保存提示", async () => {
  closeAllLayers();
  db.put({ _id: "snippet/esc-md", type: "snippet", kind: "markdown", content: "# 无修改标题\n正文内容", note: "", tags: [], createdAt: Date.now(), updatedAt: Date.now() } as never);
  outPluginCalled = false;
  enter({ code: "flashstash.main", type: "text", payload: "" });
  await wait();
  const card = [...app().querySelectorAll(".card")].find((c) => c.textContent?.includes("无修改标题"));
  assert.ok(card, "应找到 markdown 卡片");
  const editBtn = [...card!.querySelectorAll(".mini-btn")].find((b) => b.textContent?.trim() === "编辑");
  click(editBtn ?? null);
  await wait();
  assert.ok(app().querySelector(".rich"), "应进入编辑视图");
  esc();
  await wait();
  assert.equal(app().querySelector(".overlay"), null, "无修改不应弹未保存提示");
  assert.ok(app().querySelector(".mv-title"), "应回到主面板");
  assert.equal(outPluginCalled, false, "编辑流程无修改 Esc 不应退出插件");
});

test("修订4：编辑修改后 Esc 弹未保存确认；再 Esc 取消确认留在视图；确认后回主面板", async () => {
  closeAllLayers();
  outPluginCalled = false;
  enter({ code: "flashstash.main", type: "text", payload: "" });
  await wait();
  const card = [...app().querySelectorAll(".card")].find((c) => c.textContent?.includes("无修改标题"));
  const editBtn = [...card!.querySelectorAll(".mini-btn")].find((b) => b.textContent?.trim() === "编辑");
  click(editBtn ?? null);
  await wait();
  const rich = app().querySelector(".rich") as HTMLElement;
  // 通过命令追加内容（保持 ProseMirror 状态一致，触发 onUpdate 判脏）
  const editor = mdEditorOf(rich);
  editor.commands.insertContentAt(editor.state.doc.content.size, " 追加内容");
  await wait();
  // 第一次 Esc：弹未保存确认（确认框挂在 body）
  esc();
  await wait();
  const overlay = window.document.querySelector(".overlay");
  assert.ok(overlay, "修改后 Esc 应弹未保存确认");
  assert.ok(overlay?.textContent?.includes("未保存"), "确认框应含未保存文案");
  assert.equal(outPluginCalled, false, "弹确认时不应退出插件");
  // 第二次 Esc：取消确认，留在保存视图
  esc();
  await wait();
  assert.equal(window.document.querySelector(".overlay"), null, "Esc 应关闭确认框");
  assert.ok(app().querySelector(".sv"), "应留在保存视图");
  // 第三次 Esc：再弹确认，点“离开”回主面板
  esc();
  await wait();
  const leaveBtn = [...window.document.querySelectorAll(".overlay .btn")].find((b) => b.textContent?.includes("离开"));
  assert.ok(leaveBtn, "应有离开按钮");
  click(leaveBtn ?? null);
  await wait();
  assert.ok(app().querySelector(".mv-title"), "确认离开后应回主面板");
});

test("修订4：主面板 Esc 清空搜索词；再 Esc 退出插件，全程不弹未保存提示", async () => {
  closeAllLayers();
  outPluginCalled = false;
  enter({ code: "flashstash.main", type: "text", payload: "" });
  await wait();
  const search = app().querySelector("input.mv-search") as HTMLInputElement;
  search.value = "标题";
  search.dispatchEvent(new window.InputEvent("input", { bubbles: true }));
  await wait();
  assert.ok(app().querySelectorAll(".card").length > 0, "搜索应有结果");
  esc();
  await wait();
  assert.equal(search.value, "", "Esc 应清空搜索词");
  assert.equal(app().querySelector(".overlay"), null, "主面板 Esc 不应弹未保存提示");
  assert.equal(outPluginCalled, false, "清空搜索词时不应退出插件");
  // 再按一次 Esc：无搜索词 → 退出插件
  esc();
  await wait();
  assert.equal(app().querySelector(".overlay"), null, "退出前不应弹未保存提示");
  assert.equal(outPluginCalled, true, "无搜索词 Esc 应退出插件");
});

test("修订4：弹窗 Esc 关闭弹窗，不退出插件", async () => {
  closeAllLayers();
  outPluginCalled = false;
  enter({ code: "flashstash.main", type: "text", payload: "" });
  await wait();
  const settingsBtn = [...app().querySelectorAll(".mv-head-actions .btn")].find((b) => b.textContent?.includes("设置"));
  click(settingsBtn ?? null);
  await wait();
  assert.ok(document.querySelector(".overlay"), "应打开设置弹窗");
  esc();
  await wait();
  assert.equal(document.querySelector(".overlay"), null, "Esc 应关闭弹窗");
  assert.ok(app().querySelector(".mv-title"), "应留在主面板");
  assert.equal(outPluginCalled, false, "弹窗关闭不应退出插件");
});

test("修订4：标签管理重命名输入中 Esc 只取消重命名，弹窗保持打开", async () => {
  closeAllLayers();
  outPluginCalled = false;
  enter({ code: "flashstash.main", type: "text", payload: "" });
  await wait();
  const mgrBtn = [...app().querySelectorAll(".mv-head-actions .btn")].find((b) => b.textContent?.includes("标签管理"));
  click(mgrBtn ?? null);
  await wait();
  const row = document.querySelectorAll(".tag-manage-row")[0];
  assert.ok(row, "应有标签行");
  const renameBtn = [...row!.querySelectorAll(".mini-btn")].find((b) => b.textContent?.trim() === "重命名");
  click(renameBtn ?? null);
  await wait();
  assert.ok(row!.querySelector("input.input"), "应有重命名输入框");
  esc();
  await wait();
  assert.ok(document.querySelector(".overlay"), "Esc 取消重命名后弹窗应保持打开");
  assert.ok(document.querySelectorAll(".tag-manage-row").length > 0, "行应恢复为展示状态");
  // 再 Esc 关闭弹窗
  esc();
  await wait();
  assert.equal(document.querySelector(".overlay"), null, "再按 Esc 应关闭弹窗");
});

test("修订4：编辑保存后 Esc 不弹未保存提示（旧泄漏监听器回归）", async () => {
  closeAllLayers();
  const prevUx = db.get("setting/ux") as { _rev?: string } | null;
  db.put({ _id: "setting/ux", type: "setting", successStyle: "toast", successDelayMs: 1200, ...(prevUx?._rev ? { _rev: prevUx._rev } : {}) } as never);
  outPluginCalled = false;
  enter({ code: "flashstash.main", type: "text", payload: "" });
  await wait();
  const card = [...app().querySelectorAll(".card")].find((c) => c.textContent?.includes("无修改标题"));
  const editBtn = [...card!.querySelectorAll(".mini-btn")].find((b) => b.textContent?.trim() === "编辑");
  click(editBtn ?? null);
  await wait();
  const rich = app().querySelector(".rich") as HTMLElement;
  const lastP = rich.querySelector("p:last-child") as HTMLElement | null;
  if (lastP) lastP.append(document.createTextNode(" 保存后内容"));
  else rich.prepend(document.createTextNode("保存后内容"));
  rich.dispatchEvent(new window.InputEvent("input", { bubbles: true }));
  await wait();
  click(app().querySelector(".sv .btn.primary")); // toast 风格：保存后停留片刻
  await wait(50);
  assert.ok(app().querySelector(".sv"), "toast 提示期间应仍在保存视图");
  esc();
  await wait();
  assert.equal(app().querySelector(".overlay"), null, "保存后 Esc 不应弹未保存提示");
  assert.ok(app().querySelector(".mv-title"), "保存后 Esc 应回到主面板");
  assert.equal(outPluginCalled, false, "编辑保存后 Esc 不应退出插件");
  // 回主面板后再按 Esc：直接退出，绝不弹“未保存”（回归：旧监听器泄漏）
  esc();
  await wait();
  assert.equal(app().querySelector(".overlay"), null, "主面板 Esc 不应弹未保存提示");
  assert.ok(app().querySelector(".mv-title"), "主面板仍正常显示");
  assert.equal(outPluginCalled, true, "主面板无操作 Esc 应退出插件");
});

// ---------- 0.4.9：未保存提示规则（从记录入口区分离开去向） ----------
test("0.4.9：主面板＋新增 无修改 Esc 回主面板，不弹提示、不退出插件（问题5）", async () => {
  closeAllLayers();
  outPluginCalled = false;
  enter({ code: "flashstash.main", type: "text", payload: "" });
  await wait();
  const addBtn = [...app().querySelectorAll(".mv-head-actions .btn")].find((b) => b.textContent?.includes("新增"));
  assert.ok(addBtn, "应有新增按钮");
  click(addBtn!);
  await wait();
  assert.ok(app().querySelector(".sv-title"), "应进入收藏视图");
  esc();
  await wait();
  assert.equal(window.document.querySelector(".overlay"), null, "空新增退出不应弹未保存提示");
  assert.ok(app().querySelector(".mv-title"), "应回到主面板，而不是退出插件");
  assert.equal(outPluginCalled, false, "主面板＋新增 Esc 不应退出插件");
});

test("0.4.9：主面板＋新增 空内容，取消按钮直接回主面板不提示", async () => {
  closeAllLayers();
  outPluginCalled = false;
  enter({ code: "flashstash.main", type: "text", payload: "" });
  await wait();
  const addBtn = [...app().querySelectorAll(".mv-head-actions .btn")].find((b) => b.textContent?.includes("新增"));
  click(addBtn!);
  await wait();
  const cancelBtn = [...app().querySelectorAll(".sv-foot .btn")].find((b) => b.textContent?.trim() === "取消");
  click(cancelBtn!);
  await wait();
  assert.equal(window.document.querySelector(".overlay"), null, "空新增取消不应弹未保存提示");
  assert.ok(app().querySelector(".mv-title"), "取消应回主面板");
  assert.equal(outPluginCalled, false, "不应退出插件");
});

test("0.4.9：主面板＋新增 修改后 Esc 弹未保存确认；二次 Esc 取消留在视图；确认离开回主面板", async () => {
  closeAllLayers();
  outPluginCalled = false;
  enter({ code: "flashstash.main", type: "text", payload: "" });
  await wait();
  const addBtn = [...app().querySelectorAll(".mv-head-actions .btn")].find((b) => b.textContent?.includes("新增"));
  click(addBtn!);
  await wait();
  const ta = app().querySelector("textarea.ta") as HTMLTextAreaElement;
  ta.value = "我从主面板新增的内容";
  ta.dispatchEvent(new window.InputEvent("input", { bubbles: true }));
  esc();
  await wait();
  const overlay = window.document.querySelector(".overlay");
  assert.ok(overlay && (overlay.textContent ?? "").includes("未保存"), "修改后 Esc 应弹未保存确认");
  assert.ok(app().querySelector(".sv"), "确认期间应留在保存视图");
  assert.equal(outPluginCalled, false, "弹确认时不应退出插件");
  // 二次 Esc：取消确认，留在视图
  esc();
  await wait();
  assert.equal(window.document.querySelector(".overlay"), null, "Esc 应关闭确认框");
  assert.ok(app().querySelector(".sv"), "应留在保存视图");
  // 再 Esc → 弹确认 → 放弃离开 → 回主面板
  esc();
  await wait();
  const leaveBtn = [...window.document.querySelectorAll(".overlay .btn")].find((b) => b.textContent?.includes("放弃离开"));
  assert.ok(leaveBtn, "应有放弃离开按钮");
  click(leaveBtn!);
  await wait();
  assert.ok(app().querySelector(".mv-title"), "确认离开后应回主面板");
  assert.equal(outPluginCalled, false, "回主面板不应退出插件");
});

test("0.4.9：主面板＋新增 修改后点「取消」也弹未保存确认（关闭与 Esc 一致）", async () => {
  closeAllLayers();
  outPluginCalled = false;
  enter({ code: "flashstash.main", type: "text", payload: "" });
  await wait();
  const addBtn = [...app().querySelectorAll(".mv-head-actions .btn")].find((b) => b.textContent?.includes("新增"));
  click(addBtn!);
  await wait();
  const note = app().querySelectorAll("textarea.input")[0] as HTMLTextAreaElement;
  note.value = "未保存的备注";
  note.dispatchEvent(new window.InputEvent("input", { bubbles: true }));
  const cancelBtn = [...app().querySelectorAll(".sv-foot .btn")].find((b) => b.textContent?.trim() === "取消");
  click(cancelBtn!);
  await wait();
  const overlay = window.document.querySelector(".overlay");
  assert.ok(overlay, "修改后点取消应弹未保存确认");
  // 点确认框的「取消」留在视图
  const stayBtn = [...overlay!.querySelectorAll(".btn")].find((b) => b.textContent?.trim() === "取消");
  click(stayBtn!);
  await wait();
  assert.equal(window.document.querySelector(".overlay"), null, "确认框应关闭");
  assert.ok(app().querySelector(".sv"), "应留在保存视图");
  // 再次取消并确认离开 → 回主面板
  click(cancelBtn!);
  await wait();
  const leaveBtn = [...window.document.querySelectorAll(".overlay .btn")].find((b) => b.textContent?.includes("放弃离开"));
  assert.ok(leaveBtn, "应有放弃离开按钮");
  click(leaveBtn!);
  await wait();
  assert.ok(app().querySelector(".mv-title"), "应回到主面板");
  assert.equal(outPluginCalled, false, "不应退出插件");
});

test("0.4.9：uTools 指令进入新建 无修改点取消直接退出插件，不弹提示", async () => {
  closeAllLayers();
  outPluginCalled = false;
  enter({ code: "flashstash.save.text", type: "over", payload: "utools 取消退出测试" });
  await wait();
  const cancelBtn = [...app().querySelectorAll(".sv-foot .btn")].find((b) => b.textContent?.trim() === "取消");
  click(cancelBtn!);
  await wait();
  assert.equal(window.document.querySelector(".overlay"), null, "无修改不应弹未保存提示");
  assert.equal(outPluginCalled, true, "uTools 指令进入的无修改取消应退出插件");
});

test("0.4.9：uTools 指令进入新建 备注修改后 Esc 弹确认，确认后退出插件", async () => {
  closeAllLayers();
  outPluginCalled = false;
  enter({ code: "flashstash.save.text", type: "over", payload: "utools 修改退出测试" });
  await wait();
  const note = app().querySelectorAll("textarea.input")[0] as HTMLTextAreaElement;
  note.value = "我改过备注";
  note.dispatchEvent(new window.InputEvent("input", { bubbles: true }));
  assert.equal(outPluginCalled, false, "修改前不应退出");
  esc();
  await wait();
  const overlay = window.document.querySelector(".overlay");
  assert.ok(overlay, "修改后 Esc 应弹未保存确认");
  const leaveBtn = [...overlay!.querySelectorAll(".btn")].find((b) => b.textContent?.includes("放弃离开"));
  click(leaveBtn!);
  await wait();
  assert.equal(window.document.querySelector(".overlay"), null, "确认后应关闭弹窗");
  assert.equal(outPluginCalled, true, "uTools 进入的未保存离开应退出插件");
});

test("0.4.9：保存视图 标签框已输入未回车，Esc 也视为未保存修改", async () => {
  closeAllLayers();
  outPluginCalled = false;
  enter({ code: "flashstash.save.text", type: "over", payload: "标签未提交退出测试" });
  await wait();
  const tagInput = app().querySelector(".tag-input-wrap input") as HTMLInputElement;
  tagInput.value = "临时标签";
  tagInput.dispatchEvent(new window.InputEvent("input", { bubbles: true }));
  await wait();
  esc();
  await wait();
  assert.ok(window.document.querySelector(".overlay"), "标签框有未提交文字应弹未保存确认");
  // 二次 Esc 关闭确认框留在视图
  esc();
  await wait();
  assert.equal(window.document.querySelector(".overlay"), null, "二次 Esc 应关闭确认框");
  assert.ok(app().querySelector(".sv"), "应留在保存视图");
  assert.equal(outPluginCalled, false, "不应退出插件");
});

test("0.4.9：主面板＋新增 保存成功后回主面板（不退出插件）", async () => {
  closeAllLayers();
  const prevUx = db.get("setting/ux") as { _rev?: string } | null;
  db.put({ _id: "setting/ux", type: "setting", successStyle: "none", successDelayMs: 1200, ...(prevUx?._rev ? { _rev: prevUx._rev } : {}) } as never);
  outPluginCalled = false;
  enter({ code: "flashstash.main", type: "text", payload: "" });
  await wait();
  const addBtn = [...app().querySelectorAll(".mv-head-actions .btn")].find((b) => b.textContent?.includes("新增"));
  click(addBtn!);
  await wait();
  const ta = app().querySelector("textarea.ta") as HTMLTextAreaElement;
  ta.value = "主面板新增保存";
  ta.dispatchEvent(new window.InputEvent("input", { bubbles: true }));
  click(app().querySelector(".sv .btn.primary"));
  await wait(80);
  const snips = db.allDocs("snippet/") as unknown as Array<{ content: string }>;
  assert.ok(snips.some((s) => s.content === "主面板新增保存"), "应写入收藏");
  assert.ok(app().querySelector(".mv-title"), "保存后应回主面板");
  assert.equal(app().querySelector(".overlay"), null, "不应弹未保存提示");
  assert.equal(outPluginCalled, false, "主面板新增保存不应退出插件");
  assert.ok(app().querySelectorAll(".card").length > 0, "主面板应展示收藏列表");
});

test("0.4.9：成功浮层「继续收藏」新开收藏视图（不白屏、不退出插件）", async () => {
  closeAllLayers();
  const prevUx = db.get("setting/ux") as { _rev?: string } | null;
  db.put({ _id: "setting/ux", type: "setting", successStyle: "overlay", successDelayMs: 3000, ...(prevUx?._rev ? { _rev: prevUx._rev } : {}) } as never);
  outPluginCalled = false;
  enter({ code: "flashstash.save.text", type: "over", payload: "继续收藏测试" });
  await wait();
  click(app().querySelector(".sv .btn.primary"));
  await wait(80);
  assert.ok(app().querySelector(".succ"), "应显示成功浮层");
  const contBtn = [...app().querySelectorAll(".succ-btns .btn")].find((b) => b.textContent?.includes("继续收藏"));
  assert.ok(contBtn, "应有继续收藏按钮");
  click(contBtn!);
  await wait();
  assert.ok(app().querySelector(".sv-title"), "应进入新的收藏视图");
  const ta = app().querySelector("textarea.ta") as HTMLTextAreaElement;
  assert.ok(ta, "应有内容输入框");
  assert.equal(ta.value, "", "新视图应为空内容");
  assert.equal(outPluginCalled, false, "继续收藏不应退出插件");
});

test("0.4.10：toast 保存后提前离开，迟到的退出定时器不得重绘/劫持后续视图", async () => {
  closeAllLayers();
  const prevUx = db.get("setting/ux") as { _rev?: string } | null;
  db.put({ _id: "setting/ux", type: "setting", successStyle: "toast", successDelayMs: 1200, ...(prevUx?._rev ? { _rev: prevUx._rev } : {}) } as never);
  outPluginCalled = false;
  enter({ code: "flashstash.main", type: "text", payload: "" });
  await wait();
  const card = [...app().querySelectorAll(".card")].find((c) => c.textContent?.includes("无修改标题"));
  assert.ok(card, "应找到可编辑的 markdown 卡片");
  const editBtn = [...card!.querySelectorAll(".mini-btn")].find((b) => b.textContent?.trim() === "编辑");
  click(editBtn!);
  await wait();
  // toast 风格保存：1400ms 后有一个 finishAndExit 定时器
  click(app().querySelector(".sv .btn.primary"));
  await wait(50);
  // 立刻 Esc 提前离开（saved=true，不弹确认）
  esc();
  await wait();
  assert.ok(app().querySelector(".mv-title"), "应回到主面板");
  // 马上再开一个新增视图
  const addBtn = [...app().querySelectorAll(".mv-head-actions .btn")].find((b) => b.textContent?.includes("新增"));
  click(addBtn!);
  await wait();
  assert.ok(app().querySelector("textarea.ta"), "应在新增视图");
  // 等过原 toast 定时器的 1400ms：迟到的 finishAndExit 必须已被取消，不得把视图重绘回主面板
  await wait(1500);
  assert.ok(app().querySelector("textarea.ta"), "迟到的退出定时器不得劫持新增视图");
  assert.equal(app().querySelector(".mv-title"), null, "不应被重绘为主面板");
  assert.equal(outPluginCalled, false, "不应退出插件");
});

test("0.4.11：标签建议列表被 Esc 关闭后，单击/双击输入框能重新弹出（问题1）", async () => {
  closeAllLayers();
  outPluginCalled = false;
  const now = Date.now();
  db.put({ _id: "tag/click-reopen", type: "tag", name: "点击重开", createdAt: now, updatedAt: now } as never);
  enter({ code: "flashstash.save.text", type: "over", payload: "标签点击重开测试" });
  await wait();
  const tagInput = app().querySelector(".tag-input-wrap input") as HTMLInputElement;
  const suggest = app().querySelector(".tag-suggest") as HTMLElement;
  tagInput.focus();
  tagInput.dispatchEvent(new window.InputEvent("input", { bubbles: true }));
  await wait();
  assert.equal(suggest.style.display, "block", "输入后建议列表应弹出");
  esc();
  await wait();
  assert.equal(suggest.style.display, "none", "Esc 应关闭建议列表");
  assert.equal(window.document.activeElement, tagInput, "Esc 关闭列表后焦点应仍在标签输入框");
  // 单击：列表应重新弹出
  tagInput.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await wait();
  assert.equal(suggest.style.display, "block", "Esc 收起后单击输入框应重新弹出建议列表");
  assert.ok(suggest.querySelectorAll(".opt").length >= 1, "列表应包含候选标签");
  esc();
  await wait();
  assert.equal(suggest.style.display, "none");
  // 双击同样有效
  tagInput.dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true }));
  await wait();
  assert.equal(suggest.style.display, "block", "Esc 收起后双击输入框也应弹出建议列表");
  esc();
  await wait();
  assert.equal(suggest.style.display, "none");
  esc();
  await wait();
  assert.equal(outPluginCalled, true, "列表已关闭后再按 Esc 应正常离开保存视图（uTools 来源退出插件）");
});

test("0.4.11：失焦后延迟收起未到就被点回，列表不被迟到的回调收掉（问题1 竞态）", async () => {
  closeAllLayers();
  enter({ code: "flashstash.save.text", type: "over", payload: "失焦竞态测试" });
  await wait();
  const tagInput = app().querySelector(".tag-input-wrap input") as HTMLInputElement;
  const suggest = app().querySelector(".tag-suggest") as HTMLElement;
  tagInput.focus();
  tagInput.dispatchEvent(new window.InputEvent("input", { bubbles: true }));
  await wait();
  assert.equal(suggest.style.display, "block", "建议列表应弹出");
  // 失焦（调度 150ms 后收起）→ 立即点回输入框 → 列表重新弹出
  tagInput.blur();
  tagInput.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await wait();
  assert.equal(suggest.style.display, "block", "失焦后立即点回应重新弹出列表");
  await wait(200); // 越过原 150ms 收起定时器
  assert.equal(suggest.style.display, "block", "迟到的失焦收起回调不得把重新弹出的列表收掉");
  esc();
  await wait();
});

test("0.4.11：主面板卡片「预览」打开预览弹窗，展示完整内容且不复制（问题2）", async () => {
  closeAllLayers();
  outPluginCalled = false;
  const long = "# 预览标题\n" + "这是一段比较长的正文内容，".repeat(12) + "\n\n- 条目一\n- 条目二";
  db.put({ _id: "snippet/pv-1", type: "snippet", kind: "markdown", content: long, note: "预览备注", tags: ["预览标签"], createdAt: Date.now(), updatedAt: Date.now() } as never);
  db.put({ _id: "snippet/pv-img", type: "snippet", kind: "image", content: "", note: "图片备注", tags: [], imagePath: "/tmp/logo.png", imageExt: "png", createdAt: Date.now(), updatedAt: Date.now() } as never);
  enter({ code: "flashstash.main", type: "text", payload: "" });
  await wait();
  const card = [...app().querySelectorAll(".card")].find((c) => c.textContent?.includes("预览标题"));
  assert.ok(card, "应找到目标卡片");
  const pvBtn = [...card!.querySelectorAll(".mini-btn")].find((b) => b.textContent?.trim() === "预览");
  assert.ok(pvBtn, "卡片应有「预览」按钮");
  const before = copied.length;
  click(pvBtn!);
  await wait();
  assert.equal(copied.length, before, "点预览不应触发复制");
  const modal = document.querySelector(".overlay .modal");
  assert.ok(modal, "应打开预览弹窗");
  const pv = modal!.querySelector(".preview");
  assert.ok(pv, "Markdown 预览应渲染为 HTML");
  assert.ok((pv!.textContent ?? "").includes("条目一"), "应展示完整正文章节");
  assert.ok((pv!.textContent ?? "").replace(/\s+/g, " ").length > 90, "应展示完整内容（超过卡片摘要 90 字）");
  assert.ok((modal!.textContent ?? "").includes("预览备注"), "应显示备注");
  assert.ok((modal!.textContent ?? "").includes("预览标签"), "应显示标签");
  const copyBtn = [...modal!.querySelectorAll(".btn")].find((b) => (b.textContent ?? "").includes("复制"));
  click(copyBtn!);
  assert.ok(copied.includes(long), "弹窗内「复制内容」应复制完整内容");
  // 图片卡片预览
  const imgCard = [...app().querySelectorAll(".card")].find((c) => c.textContent?.includes("图片备注"));
  const imgPvBtn = [...imgCard!.querySelectorAll(".mini-btn")].find((b) => b.textContent?.trim() === "预览");
  click(imgPvBtn!);
  await wait();
  const imgModal = document.querySelectorAll(".overlay .modal");
  assert.ok(imgModal.length >= 1, "图片预览应打开弹窗");
  const lastModal = imgModal[imgModal.length - 1];
  assert.ok(lastModal.querySelector(".pv-img img"), "图片预览应展示大图");
  // Esc 关闭全部预览弹窗，不退出插件
  esc();
  await wait();
  esc();
  await wait();
  assert.equal(document.querySelector(".overlay"), null, "Esc 应关闭预览弹窗");
  assert.equal(outPluginCalled, false, "关闭预览不应退出插件");
});

test("0.4.12：设置弹窗可开关「复制后立即关闭窗口」并持久化", async () => {
  closeAllLayers();
  const prevUx = db.get("setting/ux") as { _rev?: string } | null;
  db.put({ _id: "setting/ux", type: "setting", successStyle: "toast", successDelayMs: 1200, closeOnCopy: false, ...(prevUx?._rev ? { _rev: prevUx._rev } : {}) } as never);
  enter({ code: "flashstash.main", type: "text", payload: "" });
  await wait();
  const settingsBtn = [...app().querySelectorAll(".mv-head-actions .btn")].find((b) => b.textContent?.includes("设置"));
  click(settingsBtn!);
  await wait();
  const box = document.querySelector(".overlay .modal .setting-check") as HTMLInputElement;
  assert.ok(box, "设置弹窗应有复制关闭开关");
  click(box);
  const saveBtn = [...document.querySelectorAll(".overlay .modal .btn")].find((b) => b.textContent?.trim() === "保存");
  click(saveBtn!);
  await wait();
  const saved = db.get("setting/ux") as unknown as { closeOnCopy?: boolean } | null;
  assert.equal(saved?.closeOnCopy, true, "勾选后保存应持久化 closeOnCopy=true");
  // 再开设置确认恢复默认会重置该开关
  click([...app().querySelectorAll(".mv-head-actions .btn")].find((b) => b.textContent?.includes("设置"))!);
  await wait();
  const resetBtn = [...document.querySelectorAll(".overlay .modal .btn")].find((b) => b.textContent?.includes("恢复默认"));
  click(resetBtn!);
  await wait();
  assert.equal((db.get("setting/ux") as unknown as { closeOnCopy?: boolean } | null)?.closeOnCopy, false, "恢复默认应关闭该开关");
});

test("0.4.12：复制后立即关闭窗口开启时，主面板复制即刻退出 uTools、无 toast", async () => {
  closeAllLayers();
  const prevUx = db.get("setting/ux") as { _rev?: string } | null;
  db.put({ _id: "setting/ux", type: "setting", successStyle: "toast", successDelayMs: 1200, closeOnCopy: true, ...(prevUx?._rev ? { _rev: prevUx._rev } : {}) } as never);
  outPluginCalled = false;
  hideMainWindowCalled = false;
  enter({ code: "flashstash.main", type: "text", payload: "" });
  await wait();
  const card = [...app().querySelectorAll(".card")].find((c) => c.textContent?.includes("闪藏测试"));
  assert.ok(card, "应找到目标卡片");
  const toastCountBefore = document.querySelectorAll(".toast").length;
  click(card!);
  await wait();
  assert.ok(copied.includes("hello 闪藏测试"), "复制应生效");
  assert.equal(outPluginCalled, true, "复制后应立即退出插件");
  assert.equal(hideMainWindowCalled, true, "复制后应恢复之前窗口");
  assert.equal(document.querySelectorAll(".toast").length, toastCountBefore, "开启后不应再弹复制 toast");
});

test("0.4.12：复制后立即关闭窗口关闭时，复制保持现状（仅 toast，不退出）", async () => {
  closeAllLayers();
  const prevUx = db.get("setting/ux") as { _rev?: string } | null;
  db.put({ _id: "setting/ux", type: "setting", successStyle: "toast", successDelayMs: 1200, closeOnCopy: false, ...(prevUx?._rev ? { _rev: prevUx._rev } : {}) } as never);
  outPluginCalled = false;
  hideMainWindowCalled = false;
  enter({ code: "flashstash.main", type: "text", payload: "" });
  await wait();
  const card = [...app().querySelectorAll(".card")].find((c) => c.textContent?.includes("闪藏测试"));
  assert.ok(card, "应找到目标卡片");
  const toastCountBefore = document.querySelectorAll(".toast").length;
  click(card!);
  await wait();
  assert.ok(copied.includes("hello 闪藏测试"), "复制应生效");
  assert.equal(outPluginCalled, false, "关闭开关时复制不应退出插件");
  assert.equal(hideMainWindowCalled, false, "关闭开关时不应隐藏窗口");
  assert.ok(document.querySelectorAll(".toast").length > toastCountBefore, "应保持复制 toast 提示");
});

test("0.4.12：预览弹窗内「复制内容」在开启开关时同样即刻退出", async () => {
  closeAllLayers();
  const prevUx = db.get("setting/ux") as { _rev?: string } | null;
  db.put({ _id: "setting/ux", type: "setting", successStyle: "toast", successDelayMs: 1200, closeOnCopy: true, ...(prevUx?._rev ? { _rev: prevUx._rev } : {}) } as never);
  outPluginCalled = false;
  enter({ code: "flashstash.main", type: "text", payload: "" });
  await wait();
  const card = [...app().querySelectorAll(".card")].find((c) => c.textContent?.includes("闪藏测试"));
  const pvBtn = [...card!.querySelectorAll(".mini-btn")].find((b) => b.textContent?.trim() === "预览");
  click(pvBtn!);
  await wait();
  const copyBtn = [...document.querySelectorAll(".overlay .modal .btn")].find((b) => (b.textContent ?? "").includes("复制"));
  click(copyBtn!);
  await wait();
  assert.ok(copied.includes("hello 闪藏测试"), "预览内复制应生效");
  assert.equal(outPluginCalled, true, "预览内复制后也应立即退出插件");
});

test("0.5.1：链接按钮打开「文字+网址」对话框，无选区插入命名链接", async () => {
  closeAllLayers();
  enter({ code: "flashstash.save.md", type: "over", payload: "正文" });
  await wait();
  const linkBtn = [...app().querySelectorAll(".tb-btn")].find((b) => b.textContent?.includes("🔗"));
  assert.ok(linkBtn, "应有链接按钮");
  click(linkBtn!);
  await wait();
  const modal = document.querySelector(".overlay .modal");
  assert.ok(modal, "应打开插入链接弹窗");
  const inputs = modal!.querySelectorAll("input.input");
  assert.equal(inputs.length, 2, "应有文字与网址两个输入框");
  (inputs[0] as HTMLInputElement).value = "闪藏官网";
  (inputs[1] as HTMLInputElement).value = "https://www.u-tools.cn/plugins";
  const okBtn = [...modal!.querySelectorAll(".btn")].find((b) => b.textContent?.trim() === "确定");
  assert.ok(okBtn, "应有确定按钮");
  click(okBtn!);
  await wait();
  const editor = mdEditorOf(app().querySelector(".rich") as HTMLElement);
  const html = editor.getHTML();
  assert.ok(html.includes('href="https://www.u-tools.cn/plugins"'), "应插入带网址的链接");
  assert.ok(html.includes("闪藏官网"), "应插入命名链接文字");
  assert.equal(document.querySelector(".overlay"), null, "确定后弹窗应关闭");
});

test("0.5.1：预览弹窗内点击链接走系统浏览器，不跳出空白页", async () => {
  closeAllLayers();
  openedUrls.length = 0;
  outPluginCalled = false;
  db.put({ _id: "snippet/link-2", type: "snippet", kind: "markdown", content: "[链接文案](https://www.u-tools.cn/plugins)", note: "", tags: [], createdAt: Date.now(), updatedAt: Date.now() } as never);
  enter({ code: "flashstash.main", type: "text", payload: "" });
  await wait();
  const card = [...app().querySelectorAll(".card")].find((c) => c.textContent?.includes("链接文案"));
  assert.ok(card, "应找到带链接的卡片");
  const pvBtn = [...card!.querySelectorAll(".mini-btn")].find((b) => b.textContent?.trim() === "预览");
  click(pvBtn!);
  await wait();
  const a = document.querySelector(".overlay .modal a") as HTMLAnchorElement | null;
  assert.ok(a, "预览弹窗应渲染出链接");
  click(a!);
  await wait();
  assert.deepEqual(openedUrls, ["https://www.u-tools.cn/plugins"], "点击链接应调用 shellOpenExternal");
  assert.equal(outPluginCalled, false, "不应退出插件");
});

test("0.5.1：编辑区代码块悬停出现复制按钮，点击复制代码", async () => {
  closeAllLayers();
  enter({ code: "flashstash.save.md", type: "over", payload: "```js\nconst a = 1;\n```" });
  await wait();
  const rich = app().querySelector(".rich") as HTMLElement;
  const pre = rich.querySelector("pre");
  assert.ok(pre, "应有代码块");
  const layer = rich.querySelector(".code-copy-layer") as HTMLElement;
  assert.ok(layer, "应挂载复制浮层");
  assert.equal(layer.style.display, "none", "未悬停时隐藏");
  const code = pre!.querySelector("code");
  code!.dispatchEvent(new window.MouseEvent("mouseover", { bubbles: true }));
  await wait();
  assert.equal(layer.style.display, "block", "悬停代码块应显示复制按钮");
  const before = copied.length;
  click(layer);
  await wait();
  assert.ok(copied.slice(before).some((t) => t.includes("const a = 1;")), "点击复制应复制代码内容");
});

test("0.5.2：代码语言选择器可切换语言（不在代码块内时禁用）", async () => {
  closeAllLayers();
  enter({ code: "flashstash.save.md", type: "over", payload: "正文" });
  await wait();
  const sel = app().querySelector(".tb-select") as HTMLSelectElement | null;
  assert.ok(sel, "工具栏应有语言选择器");
  assert.equal(sel!.disabled, true, "光标不在代码块内时应禁用");
  assert.ok([...sel!.options].some((o) => o.value === "java"), "应包含 java 等常见语言");
  const rich = app().querySelector(".rich") as HTMLElement;
  const editor = mdEditorOf(rich);
  editor.chain().focus().toggleCodeBlock().run();
  await wait();
  assert.equal(sel!.disabled, false, "进入代码块后应可用");
  sel!.value = "java";
  sel!.dispatchEvent(new window.Event("change", { bubbles: true }));
  await wait();
  assert.ok(editor.getHTML().includes("language-java"), "应写入所选代码语言");
});

test("0.5.2：表格按钮弹出矩阵选择器，拖选 3×4 插入", async () => {
  closeAllLayers();
  enter({ code: "flashstash.save.md", type: "over", payload: "正文" });
  await wait();
  const tableBtn = [...app().querySelectorAll(".tb-btn")].find((b) => b.textContent?.includes("⊞"));
  assert.ok(tableBtn, "应有表格按钮");
  click(tableBtn!);
  await wait();
  const panel = document.body.querySelector(".tp-panel");
  assert.ok(panel, "应弹出矩阵选择器");
  const cells = panel!.querySelectorAll(".tp-cell");
  assert.equal(cells.length, 64, "应为 8×8 矩阵");
  const target = cells[2 * 8 + 3] as HTMLElement; // 第 3 行第 4 列
  target.dispatchEvent(new window.MouseEvent("mouseenter"));
  await wait();
  assert.ok((panel!.querySelector(".tp-label")?.textContent ?? "").includes("3 × 4"), "标签应显示 3 × 4");
  click(target);
  await wait();
  assert.equal(document.body.querySelector(".tp-panel"), null, "选择后弹层应关闭");
  const rich = app().querySelector(".rich") as HTMLElement;
  assert.ok(rich.querySelector("table"), "应插入表格");
  assert.equal(rich.querySelectorAll("table tr").length, 3, "应为 3 行");
  assert.equal(rich.querySelectorAll("table tr:first-child > th, table tr:first-child > td").length, 4, "应为 4 列");
});

test("0.5.2：删除代码块后悬停复制按钮立即消失", async () => {
  closeAllLayers();
  enter({ code: "flashstash.save.md", type: "over", payload: "```js\nconst a = 1;\n```" });
  await wait();
  const rich = app().querySelector(".rich") as HTMLElement;
  const layer = rich.querySelector(".code-copy-layer") as HTMLElement;
  const code = rich.querySelector("pre code") as HTMLElement;
  code.dispatchEvent(new window.MouseEvent("mouseover", { bubbles: true }));
  await wait();
  assert.equal(layer.style.display, "block", "悬停应显示复制按钮");
  mdEditorOf(rich).chain().focus().selectAll().deleteSelection().run();
  await wait();
  assert.equal(rich.querySelector("pre"), null, "代码块应已删除");
  assert.equal(layer.style.display, "none", "删除后复制按钮应立即消失");
});

test("0.5.3：回车=新段落（源码以空行分隔），Shift+Enter=段内软换行（源码相邻行）", async () => {
  closeAllLayers();
  enter({ code: "flashstash.save.md", type: "over", payload: "第一行" });
  await wait();
  const rich = app().querySelector(".rich") as HTMLElement;
  mdEditorOf(rich).commands.focus("end");
  await wait();
  keyOn(rich, "Enter");
  mdEditorOf(rich).commands.insertContent("第二行");
  await wait();
  click(app().querySelectorAll(".editor-tab")[1]); // 源码
  await wait();
  const ta = app().querySelector("textarea.ta") as HTMLTextAreaElement;
  assert.ok(ta.value.includes("第一行") && ta.value.includes("第二行"), "源码应含两段内容");
  assert.ok(/\n[ \t]*\n/.test(ta.value), "回车产生的是段落：Markdown 里以空行分隔（块级格式才能按行生效）");

  // Shift+Enter：段内换行 → 源码里是相邻两行
  enter({ code: "flashstash.save.md", type: "over", payload: "甲" });
  await wait();
  const rich2 = app().querySelector(".rich") as HTMLElement;
  mdEditorOf(rich2).commands.focus("end");
  await wait();
  keyOn(rich2, "Enter", { shiftKey: true });
  mdEditorOf(rich2).commands.insertContent("乙");
  await wait();
  click(app().querySelectorAll(".editor-tab")[1]);
  await wait();
  const ta2 = app().querySelector("textarea.ta") as HTMLTextAreaElement;
  assert.ok(!/\n[ \t]*\n/.test(ta2.value.trim()), "Shift+Enter 换行时源码里不应有空行");
});

test("0.5.3：部分选中点「引用」只引用选中文字，不扩到整段", async () => {
  closeAllLayers();
  enter({ code: "flashstash.save.md", type: "over", payload: "这句话前半部分要引用后半部分不要" });
  await wait();
  const rich = app().querySelector(".rich") as HTMLElement;
  const editor = mdEditorOf(rich);
  editor.chain().focus().setTextSelection({ from: 1, to: 6 }).run();
  await wait();
  const quoteBtn = [...app().querySelectorAll(".tb-btn")].find((b) => b.textContent?.includes("❝"));
  assert.ok(quoteBtn, "应有引用按钮");
  click(quoteBtn!);
  await wait();
  const quoted = rich.querySelector("blockquote")?.textContent ?? "";
  assert.ok(quoted.includes("这句话前半"), "选中的文字应进引用");
  assert.ok(!quoted.includes("后半部分"), "未选中的文字不应被引用");
  const outside = [...rich.querySelectorAll("p")]
    .filter((p) => !p.closest("blockquote"))
    .map((p) => p.textContent ?? "");
  assert.ok(outside.some((t) => t.includes("部分要引用")), "剩余文字应保留为普通段落");
});

test("0.5.3：光标在某一行点 H1 只影响该行", async () => {
  closeAllLayers();
  enter({ code: "flashstash.save.md", type: "over", payload: "第一行\n\n第二行\n\n第三行" });
  await wait();
  const rich = app().querySelector(".rich") as HTMLElement;
  assert.equal(rich.querySelectorAll("p").length, 3, "三行应是三个段落");
  mdEditorOf(rich).chain().focus().setTextSelection(1 + 3 + 2 + 1).run();
  await wait();
  const h1Btn = [...app().querySelectorAll(".tb-btn")].find((b) => b.textContent?.trim() === "H1");
  click(h1Btn!);
  await wait();
  assert.equal(rich.querySelector("h1")?.textContent, "第二行", "只有光标所在行变 H1");
  assert.equal(rich.querySelectorAll("p").length, 2, "其余两行仍是段落");
});

test("0.5.3：代码块语言角标在编辑区与预览区都显示", async () => {
  closeAllLayers();
  enter({ code: "flashstash.save.md", type: "over", payload: "```java\npublic class A {}\n```" });
  await wait();
  const rich = app().querySelector(".rich") as HTMLElement;
  assert.equal(rich.querySelector("pre")?.getAttribute("data-language"), "java", "编辑区应显示语言角标");
  click(app().querySelectorAll(".editor-tab")[2]); // 预览
  await wait();
  const preview = app().querySelector(".preview") as HTMLElement;
  assert.equal(preview.querySelector("pre")?.getAttribute("data-language"), "java", "预览区应显示语言角标");
});

test("0.5.4：选中多行点「代码块」只生成一个代码块（不再一段一个）", async () => {
  closeAllLayers();
  enter({ code: "flashstash.save.md", type: "over", payload: "line1\n\nline2\n\nline3" });
  await wait();
  const rich = app().querySelector(".rich") as HTMLElement;
  assert.equal(rich.querySelectorAll("p").length, 3, "三行应是三个段落");
  mdEditorOf(rich).chain().focus().selectAll().run();
  await wait();
  const codeBtn = [...app().querySelectorAll(".tb-btn")].find((b) => b.textContent?.includes("⧉"));
  assert.ok(codeBtn, "应有代码块按钮");
  click(codeBtn!);
  await wait();
  assert.equal(rich.querySelectorAll("pre").length, 1, "应只生成一个代码块");
  assert.equal(rich.querySelector("pre")?.textContent, "line1\nline2\nline3", "三行应合并进同一代码块");
  click(app().querySelectorAll(".editor-tab")[1]); // 源码
  await wait();
  const ta = app().querySelector("textarea.ta") as HTMLTextAreaElement;
  assert.equal((ta.value.match(/```/g) ?? []).length, 2, "源码应只有一对围栏");
});

test("0.5.4：以代码块结尾的收藏，编辑时打开不判脏（TrailingNode 补的空段不算修改）", async () => {
  closeAllLayers();
  db.put({
    _id: "snippet/trail-1", type: "snippet", kind: "markdown",
    content: "```js\nconst a = 1;\n```", note: "", tags: [],
    createdAt: Date.now(), updatedAt: Date.now()
  } as never);
  enter({ code: "flashstash.main", type: "text", payload: "" });
  await wait();
  const card = [...app().querySelectorAll(".card")].find((c) => c.textContent?.includes("const a = 1;"));
  assert.ok(card, "应找到代码块收藏");
  const editBtn = [...card!.querySelectorAll(".mini-btn")].find((b) => b.textContent?.trim() === "编辑");
  click(editBtn!);
  await wait();
  // 触发一次事务，让 TrailingNode 补出文末空段落
  mdEditorOf(app().querySelector(".rich") as HTMLElement).commands.focus();
  await wait();
  esc();
  await wait();
  assert.equal(document.querySelector(".overlay"), null, "不应因文末空段落误弹未保存提示");
  assert.ok(app().querySelector(".mv-title"), "应直接回主面板");
});

test("0.5.5：鼠标从代码块移到「复制」按钮时按钮不消失（可点中）", async () => {
  closeAllLayers();
  enter({ code: "flashstash.save.md", type: "over", payload: "```js\nconst a = 1;\n```" });
  await wait();
  const rich = app().querySelector(".rich") as HTMLElement;
  const layer = rich.querySelector(".code-copy-layer") as HTMLElement;
  const code = rich.querySelector("pre code") as HTMLElement;
  // 悬停代码块 → 按钮出现
  code.dispatchEvent(new window.MouseEvent("mouseover", { bubbles: true }));
  await wait();
  assert.equal(layer.style.display, "block", "悬停代码块应显示复制按钮");
  // 指针移向按钮：代码块收到 mouseout，但 relatedTarget 是按钮 → 不能收起
  code.dispatchEvent(new window.MouseEvent("mouseout", { bubbles: true, relatedTarget: layer }));
  await wait(50);
  assert.equal(layer.style.display, "block", "指针移到按钮上时按钮不应消失");
  assert.equal(rich.querySelector(".code-copy-layer"), layer, "按钮实例应保持存在");
  // 点击能真正复制
  const before = copied.length;
  click(layer);
  await wait();
  assert.ok(copied.slice(before).some((t) => t.includes("const a = 1;")), "点击按钮应复制代码");
  // 指针移出到无关区域 → 延时后收起
  code.dispatchEvent(new window.MouseEvent("mouseover", { bubbles: true }));
  await wait(20);
  code.dispatchEvent(new window.MouseEvent("mouseout", { bubbles: true, relatedTarget: window.document.body }));
  await wait(260);
  assert.equal(layer.style.display, "none", "指针离开后应延时收起");
});

function text(root: Element, sel: string): string {
  return root.querySelector(sel)?.textContent?.trim() ?? "";
}