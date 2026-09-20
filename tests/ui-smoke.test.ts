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
let notifyCalls = 0;
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
  showNotification: () => { notifyCalls++; },
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
  const tagInput = app().querySelector(".tag-input") as HTMLInputElement;
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
  const tagInput = app().querySelector(".tag-input") as HTMLInputElement;
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
  const chips = [...app().querySelectorAll(".tag-field-box .chip-item")];
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
  const tagInput = app().querySelector(".tag-input") as HTMLInputElement;
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
  const tagInput = app().querySelector(".tag-input") as HTMLInputElement;
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
  const tagInput = app().querySelector(".tag-input") as HTMLInputElement;
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
  const tagInput = app().querySelector(".tag-input") as HTMLInputElement;
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
  const tagInput = app().querySelector(".tag-input") as HTMLInputElement;
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

// ---------- 0.5.6：系统消息提示开关 / 拼音匹配 / 预览编辑 ----------
/** 设置 setting/ux 文档（保留 _rev） */
function putUx(partial: Record<string, unknown>): void {
  const prev = db.get("setting/ux") as { _rev?: string } | null;
  db.put({
    _id: "setting/ux", type: "setting",
    successStyle: "toast", successDelayMs: 1200, closeOnCopy: false,
    systemNotify: true, pinyinSearch: true,
    ...(prev?._rev ? { _rev: prev._rev } : {}),
    ...partial
  } as never);
}

test("0.5.6：设置弹窗可开关 Windows 系统消息提示与拼音搜索并持久化", async () => {
  closeAllLayers();
  enter({ code: "flashstash.main", type: "text", payload: "" });
  await wait();
  click([...app().querySelectorAll(".mv-head-actions .btn")].find((b) => b.textContent?.includes("设置"))!);
  await wait();
  const checks = [...document.querySelectorAll(".overlay .modal .setting-check")] as HTMLInputElement[];
  assert.equal(checks.length, 4, "设置弹窗应有四个开关（复制关闭 / 系统提示 / 拼音搜索 / 按日期分组）");
  // 默认值：系统提示开、拼音搜索开
  assert.equal(checks[1].checked, true, "Windows 系统消息提示默认开启");
  assert.equal(checks[2].checked, true, "拼音搜索默认开启");
  // 关掉两个新开关并保存
  click(checks[1]);
  click(checks[2]);
  click([...document.querySelectorAll(".overlay .modal .btn")].find((b) => b.textContent?.trim() === "保存")!);
  await wait();
  const saved = db.get("setting/ux") as unknown as { systemNotify?: boolean; pinyinSearch?: boolean } | null;
  assert.equal(saved?.systemNotify, false, "系统消息提示开关应持久化");
  assert.equal(saved?.pinyinSearch, false, "拼音搜索开关应持久化");
  // 恢复默认应把两个开关复位
  click([...app().querySelectorAll(".mv-head-actions .btn")].find((b) => b.textContent?.includes("设置"))!);
  await wait();
  click([...document.querySelectorAll(".overlay .modal .btn")].find((b) => b.textContent?.includes("恢复默认"))!);
  await wait();
  const reset = db.get("setting/ux") as unknown as { systemNotify?: boolean; pinyinSearch?: boolean } | null;
  assert.equal(reset?.systemNotify, true, "恢复默认应开启系统消息提示");
  assert.equal(reset?.pinyinSearch, true, "恢复默认应开启拼音搜索");
});

test("0.5.6：关闭系统消息提示后保存不再弹系统通知", async () => {
  closeAllLayers();
  notifyCalls = 0;
  putUx({ successStyle: "overlay", successDelayMs: 1200, systemNotify: false, pinyinSearch: true });
  enter({ code: "flashstash.save.text", type: "over", payload: "关闭通知测试" });
  await wait();
  click(app().querySelector(".sv .btn.primary"));
  await wait(80);
  assert.ok(app().querySelector(".succ"), "关闭系统提示不影响插件内成功浮层");
  assert.equal(notifyCalls, 0, "关闭后保存不应调用 showNotification");
  // 开启时恢复系统通知
  putUx({ successStyle: "overlay", successDelayMs: 1200, systemNotify: true, pinyinSearch: true });
  enter({ code: "flashstash.save.text", type: "over", payload: "开启通知测试" });
  await wait();
  click(app().querySelector(".sv .btn.primary"));
  await wait(80);
  assert.equal(notifyCalls, 1, "开启后保存应调用一次 showNotification");
});

test("0.5.6：标签建议支持拼音匹配（输入 qd 搜出「前端」）", async () => {
  closeAllLayers();
  const now = Date.now();
  if (!db.allDocs("tag/").some((d) => (d as { name?: string }).name === "前端")) {
    db.put({ _id: "tag/qd-1", type: "tag", name: "前端", createdAt: now, updatedAt: now } as never);
  }
  enter({ code: "flashstash.save.text", type: "over", payload: "拼音建议测试" });
  await wait();
  const tagInput = app().querySelector(".tag-input") as HTMLInputElement;
  tagInput.value = "qd";
  tagInput.dispatchEvent(new window.InputEvent("input", { bubbles: true }));
  await wait();
  const suggest = app().querySelector(".tag-suggest") as HTMLElement;
  assert.equal(suggest.style.display, "block", "拼音输入应弹出建议列表");
  const opts = [...suggest.querySelectorAll(".opt")];
  assert.ok(opts.length >= 1, "应有拼音匹配的标签");
  assert.ok(opts.some((o) => o.textContent?.includes("前端")), "输入 qd 应搜出标签「前端」");
  // 首字母全拼都支持：qianduan
  tagInput.value = "qianduan";
  tagInput.dispatchEvent(new window.InputEvent("input", { bubbles: true }));
  await wait();
  const opts2 = [...suggest.querySelectorAll(".opt")];
  assert.ok(opts2.some((o) => o.textContent?.includes("前端")), "输入全拼 qianduan 也应搜出「前端」");
});

test("0.5.6：标签管理查询支持拼音匹配", async () => {
  closeAllLayers();
  enter({ code: "flashstash.main", type: "text", payload: "" });
  await wait();
  click([...app().querySelectorAll(".mv-head-actions .btn")].find((b) => b.textContent?.includes("标签管理"))!);
  await wait();
  const modal = document.querySelector(".overlay .modal");
  assert.ok(modal, "应打开标签管理弹窗");
  const inputs = modal!.querySelectorAll("input.input");
  assert.ok(inputs.length >= 2, "应有新建与搜索两个输入框");
  const search = inputs[1] as HTMLInputElement;
  search.value = "qd";
  search.dispatchEvent(new window.InputEvent("input", { bubbles: true }));
  await wait();
  const rows = modal!.querySelectorAll(".tag-manage-row");
  assert.ok(rows.length >= 1, "拼音过滤后应仍有匹配标签");
  assert.ok([...rows].some((r) => (r.textContent ?? "").includes("前端")), "输入 qd 应保留标签「前端」");
  // 不匹配拼音的标签应被过滤
  assert.equal([...rows].some((r) => (r.textContent ?? "").includes("资料")), false, "与 qd 无关的标签应被过滤");
});

test("0.5.6：主面板搜索支持拼音（默认开启）且可在设置中关闭", async () => {
  closeAllLayers();
  const now = Date.now();
  db.put({ _id: "snippet/py-1", type: "snippet", kind: "text", content: "前端收藏拼音测试", note: "拼音搜索专用", tags: ["前端"], createdAt: now, updatedAt: now } as never);
  enter({ code: "flashstash.main", type: "text", payload: "" });
  await wait();
  const search = app().querySelector("input.mv-search") as HTMLInputElement;
  search.value = "qd";
  search.dispatchEvent(new window.InputEvent("input", { bubbles: true }));
  await wait();
  let cards = [...app().querySelectorAll(".card")];
  assert.ok(cards.some((c) => c.textContent?.includes("前端收藏拼音测试")), "默认开启拼音：输入 qd 应搜到该收藏");
  // 关闭拼音搜索后同一查询不再命中中文
  putUx({ successStyle: "toast", successDelayMs: 1200, closeOnCopy: false, systemNotify: true, pinyinSearch: false });
  search.value = "qd";
  search.dispatchEvent(new window.InputEvent("input", { bubbles: true }));
  await wait();
  cards = [...app().querySelectorAll(".card")];
  assert.equal(cards.some((c) => c.textContent?.includes("前端收藏拼音测试")), false, "关闭拼音后输入 qd 不应再搜到");
  // 恢复默认（再次开启）
  putUx({ successStyle: "toast", successDelayMs: 1200, closeOnCopy: false, systemNotify: true, pinyinSearch: true });
});

test("0.5.6：预览弹窗提供「编辑」按钮，可一键进入编辑状态", async () => {
  closeAllLayers();
  const now = Date.now();
  db.put({ _id: "snippet/py-edit", type: "snippet", kind: "markdown", content: "# 预览编辑标题\n编辑内容正文", note: "预览编辑备注", tags: ["前端"], createdAt: now, updatedAt: now } as never);
  enter({ code: "flashstash.main", type: "text", payload: "" });
  await wait();
  const card = [...app().querySelectorAll(".card")].find((c) => c.textContent?.includes("预览编辑标题"));
  assert.ok(card, "应找到目标卡片");
  click([...card!.querySelectorAll(".mini-btn")].find((b) => b.textContent?.trim() === "预览")!);
  await wait();
  const modal = document.querySelector(".overlay .modal");
  assert.ok(modal, "应打开预览弹窗");
  const editBtn = [...modal!.querySelectorAll(".btn")].find((b) => (b.textContent ?? "").trim() === "编辑");
  assert.ok(editBtn, "预览弹窗应有「编辑」按钮");
  click(editBtn!);
  await wait();
  assert.ok(document.querySelector(".overlay") === null, "点击编辑后预览弹窗应关闭");
  assert.ok(app().querySelector(".sv-title")?.textContent?.includes("编辑收藏"), "应进入编辑视图");
  const rich = app().querySelector(".rich");
  assert.ok(rich, "Markdown 编辑应显示富文本区");
  assert.ok((rich!.textContent ?? "").includes("预览编辑标题"), "编辑区应载入原内容");
});
// ---------- 0.6.0：批量删除 / 排序 / 剪贴板按文本收藏 / 标签建议键盘选择 ----------

/** 取当前列表里卡片的标题序（用卡片摘要文字首行近似） */
function cardOrder(): string[] {
  return [...app().querySelectorAll(".mv-list .card")].map((c) => c.textContent ?? "");
}

/** 清掉测试写进 db 的指定收藏，避免污染后续用例的计数断言 */
function dropSnippets(ids: string[]): void {
  for (const id of ids) {
    const d = db.get(id);
    if (d) db.remove(d as never);
  }
}

test("0.6.0：批量模式可多选卡片并一次性删除（含全选 / 退出批量）", async () => {
  closeAllLayers();
  const now = Date.now();
  const ids = ["snippet/bulk-a", "snippet/bulk-b", "snippet/bulk-c"];
  ids.forEach((id, i) => {
    db.put({ _id: id, type: "snippet", kind: "text", content: "批量删除样本" + i, note: "", tags: [], createdAt: now + i, updatedAt: now + i } as never);
  });
  enter({ code: "flashstash.main", type: "text", payload: "" });
  await wait();
  const batchBtn = [...app().querySelectorAll(".mv-head-actions .btn")].find((b) => b.textContent?.includes("批量"));
  assert.ok(batchBtn, "头部应有「批量」按钮");
  click(batchBtn!);
  await wait();
  assert.ok(app().querySelector(".mv-list.batch"), "进入批量模式后列表应带 batch 类（复选框可见）");
  assert.equal(app().querySelectorAll(".mv-list .card-check input").length, app().querySelectorAll(".mv-list .card").length, "每张卡片都应有复选框");

  // 勾选两张（点复选框）
  const boxes = [...app().querySelectorAll(".mv-list .card-check input")] as HTMLInputElement[];
  const targetIdx = cardOrder().findIndex((t) => t.includes("批量删除样本0"));
  click(boxes[targetIdx]);
  await wait();
  assert.ok(app().querySelector(".batchbar")?.textContent?.includes("已选 1 条"), "批量条应显示已选数量");

  // 全选当前结果
  click([...app().querySelectorAll(".batchbar .mini-btn")].find((b) => b.textContent?.includes("全选"))!);
  await wait();
  const allCount = app().querySelectorAll(".mv-list .card").length;
  assert.ok(app().querySelector(".batchbar")?.textContent?.includes(`已选 ${allCount} 条`), "全选后应选中全部当前结果");

  // 只保留三张样本：先点「反选」再勾选三张样本
  click([...app().querySelectorAll(".batchbar .mini-btn")].find((b) => b.textContent?.includes("反选"))!);
  await wait();
  const order = cardOrder();
  const boxes2 = [...app().querySelectorAll(".mv-list .card-check input")] as HTMLInputElement[];
  for (const id of ids) {
    const label = "批量删除样本" + ids.indexOf(id);
    const i = order.findIndex((t) => t.includes(label));
    assert.ok(i >= 0, "应能找到样本卡片 " + label);
    if (!boxes2[i].checked) click(boxes2[i]);
    await wait();
  }
  assert.ok(app().querySelector(".batchbar")?.textContent?.includes("已选 3 条"), "应选中三条样本");

  // 删除所选 → 确认
  click([...app().querySelectorAll(".batchbar .mini-btn")].find((b) => b.textContent?.includes("删除所选"))!);
  await wait();
  const overlay = document.querySelector(".overlay");
  assert.ok(overlay && (overlay.textContent ?? "").includes("批量删除"), "应弹批量删除确认框");
  assert.ok((overlay!.textContent ?? "").includes("3 条"), "确认框应写明删除条数");
  click([...overlay!.querySelectorAll(".btn")].find((b) => (b.textContent ?? "").includes("删除"))!);
  await wait(60);
  for (const id of ids) assert.equal(db.get(id), null, "样本收藏应已被删除");
  assert.equal(app().querySelectorAll(".mv-list .card").length, allCount - 3, "列表应少三条");
  assert.ok((app().querySelector(".batchbar")?.textContent ?? "").includes("已选 0 条"), "删除后选择应被清空");
  assert.equal(app().querySelector(".mv-list .batch-picked"), null, "不应残留选中态卡片");

  // 退出批量模式后点卡片恢复为复制
  click([...app().querySelectorAll(".mv-head-actions .btn")].find((b) => b.textContent?.includes("批量"))!);
  await wait();
  assert.equal(app().querySelector(".mv-list.batch"), null, "再次点击应退出批量模式");
  const before = copied.length;
  const firstCard = app().querySelector(".mv-list .card") as HTMLElement | null;
  if (firstCard) {
    click(firstCard);
    await wait();
    assert.equal(copied.length, before + 1, "非批量模式下点卡片应照旧复制");
  }
});

test("0.6.0：批量模式下点卡片是勾选而非复制，Esc 先退出批量模式", async () => {
  closeAllLayers();
  const now = Date.now();
  db.put({ _id: "snippet/bulk-esc", type: "snippet", kind: "text", content: "批量ESC样本", note: "", tags: [], createdAt: now, updatedAt: now } as never);
  enter({ code: "flashstash.main", type: "text", payload: "" });
  await wait();
  click([...app().querySelectorAll(".mv-head-actions .btn")].find((b) => b.textContent?.includes("批量"))!);
  await wait();
  const before = copied.length;
  const card = [...app().querySelectorAll(".mv-list .card")].find((c) => c.textContent?.includes("批量ESC样本")) as HTMLElement;
  click(card);
  await wait();
  assert.equal(copied.length, before, "批量模式下点卡片不应复制");
  assert.equal(card.classList.contains("batch-picked"), true, "批量模式下点卡片应勾选");
  outPluginCalled = false;
  esc();
  await wait();
  assert.equal(app().querySelector(".mv-list.batch"), null, "Esc 应先退出批量模式");
  assert.equal(outPluginCalled, false, "退出批量模式不应退出插件");
  dropSnippets(["snippet/bulk-esc"]);
});

test("0.6.0：排序可按创建时间/使用次数/标题切换，且选定后被记住（重进主面板仍生效）", async () => {
  closeAllLayers();
  putUx({ sortMode: "updated", sortDir: "desc", sortGroup: "none" });
  const base = Date.now() - 86400000;
  // 三条样本：创建时间与使用次数刻意错开
  db.put({ _id: "snippet/ord-1", type: "snippet", kind: "text", content: "排序样本 甲", note: "", tags: [], createdAt: base + 1000, updatedAt: base + 3000, useCount: 1, lastUsedAt: base + 4000 } as never);
  db.put({ _id: "snippet/ord-2", type: "snippet", kind: "text", content: "排序样本 乙", note: "", tags: [], createdAt: base + 2000, updatedAt: base + 2000, useCount: 9, lastUsedAt: base + 5000 } as never);
  db.put({ _id: "snippet/ord-3", type: "snippet", kind: "text", content: "排序样本 丙", note: "", tags: [], createdAt: base + 3000, updatedAt: base + 1000, useCount: 0 } as never);
  enter({ code: "flashstash.main", type: "text", payload: "" });
  await wait();
  const sel = app().querySelector(".sort-select") as HTMLSelectElement;
  assert.ok(sel, "主面板应有排序下拉");
  assert.ok([...sel.options].some((o) => o.textContent === "使用次数"), "排序下拉应包含「使用次数」");
  assert.ok([...sel.options].some((o) => o.textContent === "创建时间"), "排序下拉应包含「创建时间」");
  assert.ok([...sel.options].some((o) => o.textContent === "最近使用"), "排序下拉应包含「最近使用」");

  const samples = () => cardOrder().filter((t) => t.includes("排序样本"));
  // 创建时间升序：甲(1000) → 乙(2000) → 丙(3000)
  sel.value = "created";
  sel.dispatchEvent(new window.Event("change", { bubbles: true }));
  await wait();
  click(app().querySelector(".sort-dir-btn")!); // 默认 desc → 切成 asc
  await wait();
  assert.ok(samples()[0].includes("甲") && samples()[2].includes("丙"), "创建时间升序应 甲→乙→丙，实际：" + samples().map((t) => t.slice(0, 20)).join(" | "));

  // 使用次数降序：乙(9) → 甲(1)，丙无使用记录排最后
  sel.value = "hits";
  sel.dispatchEvent(new window.Event("change", { bubbles: true }));
  await wait();
  assert.ok(samples()[0].includes("乙"), "使用次数降序应把次数最多的排最前");
  assert.ok(samples()[2].includes("丙"), "从未使用的应排最后");

  // 排序偏好落库
  const savedSort = db.get("setting/ux") as unknown as { sortMode?: string; sortDir?: string } | null;
  assert.equal(savedSort?.sortMode, "hits", "排序方式应持久化");
  assert.equal(savedSort?.sortDir, "desc", "排序方向应持久化");

  // 重进主面板：仍按最后设定（使用次数降序）
  enter({ code: "flashstash.main", type: "text", payload: "" });
  await wait();
  const sel2 = app().querySelector(".sort-select") as HTMLSelectElement;
  assert.equal(sel2.value, "hits", "重新打开主面板应沿用最后选定的排序方式");
  assert.ok(samples()[0].includes("乙"), "重新打开后仍应按使用次数降序");
  // 清场：恢复默认排序并移除样本
  click([...app().querySelectorAll(".sort-dir-btn")].find((b) => b.textContent?.includes("重置排序"))!);
  await wait();
  dropSnippets(["snippet/ord-1", "snippet/ord-2", "snippet/ord-3"]);
  putUx({ sortMode: "smart", sortDir: "desc", sortGroup: "none" });
});

test("0.6.0：搜索结果同样受排序控制（检索出的数据也按所选顺序）", async () => {
  closeAllLayers();
  const base = Date.now() - 3600000;
  db.put({ _id: "snippet/sort-q1", type: "snippet", kind: "text", content: "检索排序样本 甲", note: "", tags: [], createdAt: base + 1000, updatedAt: base + 2000, useCount: 5 } as never);
  db.put({ _id: "snippet/sort-q2", type: "snippet", kind: "text", content: "检索排序样本 乙", note: "", tags: [], createdAt: base + 2000, updatedAt: base + 1000, useCount: 7 } as never);
  enter({ code: "flashstash.main", type: "text", payload: "" });
  await wait();
  const search = app().querySelector("input.mv-search") as HTMLInputElement;
  search.value = "检索排序样本";
  search.dispatchEvent(new window.InputEvent("input", { bubbles: true }));
  await wait();
  const sel = app().querySelector(".sort-select") as HTMLSelectElement;
  sel.value = "hits";
  sel.dispatchEvent(new window.Event("change", { bubbles: true }));
  await wait();
  const got = cardOrder().filter((t) => t.includes("检索排序样本"));
  assert.equal(got.length, 2, "应检索出两条");
  assert.ok(got[0].includes("乙"), "搜索命中后也应按使用次数排序（乙 7 次在前）");
  search.value = "";
  search.dispatchEvent(new window.InputEvent("input", { bubbles: true }));
  await wait();
  click([...app().querySelectorAll(".sort-dir-btn")].find((b) => b.textContent?.includes("重置排序"))!);
  await wait();
  dropSnippets(["snippet/sort-q1", "snippet/sort-q2"]);
  putUx({ sortMode: "smart", sortDir: "desc", sortGroup: "none" });
});

test("0.6.0：复制取用会累计使用次数与最近使用时间（供排序使用）", async () => {
  closeAllLayers();
  const now = Date.now();
  db.put({ _id: "snippet/use-1", type: "snippet", kind: "text", content: "取用计数样本", note: "", tags: [], createdAt: now, updatedAt: now } as never);
  enter({ code: "flashstash.main", type: "text", payload: "" });
  await wait();
  const card = [...app().querySelectorAll(".mv-list .card")].find((c) => c.textContent?.includes("取用计数样本")) as HTMLElement;
  assert.ok(card, "应找到样本卡片");
  click(card);
  await wait(30);
  click(card);
  await wait(30);
  const doc = db.get("snippet/use-1") as unknown as { useCount?: number; lastUsedAt?: number } | null;
  assert.equal(doc?.useCount, 2, "复制两次应累计 useCount=2");
  assert.ok((doc?.lastUsedAt ?? 0) > 0, "应记录最近使用时间");
  dropSnippets(["snippet/use-1"]);
});

test("0.6.0：剪贴板内容按「文本」收藏并明确提示（不会被 Markdown 绑架），可一键切 Markdown", async () => {
  closeAllLayers();
  clipboardText = "SELECT id, name FROM users WHERE age > 18;";
  enter({ code: "flashstash.save.clipboard", type: "text", payload: "" });
  await wait();
  const activeKind = app().querySelector(".kind-tab.active")?.textContent?.trim();
  assert.equal(activeKind, "文本", "剪贴板内容应默认按文本收藏");
  const sub = app().querySelector(".sv-sub")?.textContent ?? "";
  assert.ok(sub.includes("文本"), "副标题应明确告知当前按「文本」收藏：" + sub);
  assert.ok(sub.includes("Markdown"), "副标题应提示可切换为 Markdown");
  assert.ok(sub.includes("不做 Markdown 解析") || sub.includes("原样"), "应说明文本是原样保存");
  // 切到 Markdown 后提示同步更新
  click(app().querySelectorAll(".kind-tab")[1]);
  await wait();
  const sub2 = app().querySelector(".sv-sub")?.textContent ?? "";
  assert.ok(sub2.includes("Markdown"), "切换后提示应更新为 Markdown：" + sub2);
  // 切回文本保存：内容原样落库（不解析）
  click(app().querySelectorAll(".kind-tab")[0]);
  await wait();
  click(app().querySelector(".sv .btn.primary"));
  await wait(80);
  const snips = db.allDocs("snippet/") as unknown as Array<{ content: string; kind: string }>;
  const sql = snips.find((s) => s.content.includes("SELECT id, name"));
  assert.ok(sql, "应写入剪贴板内容");
  assert.equal(sql?.kind, "text", "应保存为 text 类型");
  assert.equal(sql?.content, "SELECT id, name FROM users WHERE age > 18;", "内容原样保存");
});

test("0.6.0：uTools 对象型 payload（{text}）也能正确带入内容，不再「内容为空」", async () => {
  closeAllLayers();
  enter({ code: "flashstash.save.text", type: "over", payload: { text: "对象载荷内容" } });
  await wait();
  const ta = app().querySelector("textarea.ta") as HTMLTextAreaElement;
  assert.ok(ta, "应进入文本收藏视图");
  assert.equal(ta.value, "对象载荷内容", "对象型 payload 的 text 字段应被带入");
});

test("0.6.0：标签建议全量列表直接键盘选择即生效（修复：首次全量筛选时选择无效）", async () => {
  closeAllLayers();
  const now = Date.now();
  db.put({ _id: "tag/kb-full-1", type: "tag", name: "键盘标签甲", createdAt: now, updatedAt: now } as never);
  db.put({ _id: "tag/kb-full-2", type: "tag", name: "键盘标签乙", createdAt: now, updatedAt: now } as never);
  enter({ code: "flashstash.save.text", type: "over", payload: "全量列表键盘选择" });
  await wait();
  const tagInput = app().querySelector(".tag-input") as HTMLInputElement;
  const suggest = app().querySelector(".tag-suggest") as HTMLElement;
  // 空白回车展开全量列表（不做任何筛选）
  tagInput.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await wait();
  assert.equal(suggest.style.display, "block", "空白回车应展开全部标签");
  const total = suggest.querySelectorAll(".opt").length;
  assert.ok(total >= 2, "全量列表应包含多个标签，实际 " + total);
  // 直接 ↓ 选中第一项 + 回车
  tagInput.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  await wait();
  const first = suggest.querySelectorAll(".opt")[0].textContent ?? "";
  tagInput.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await wait();
  const chips = [...app().querySelectorAll(".tag-field-box .chip-item")].map((c) => c.querySelector(".chip-text")?.textContent ?? "");
  assert.ok(chips.some((c) => c.includes(first)), `全量列表下键盘选择应添加「${first}」，实际：` + chips.join(","));
  assert.equal(tagInput.value, "", "选择后输入框应清空");
});

test("0.6.0：先筛后选——回车新建筛选词本身，按 ↓ 后回车才选中候选项", async () => {
  closeAllLayers();
  const now = Date.now();
  // 唯一前缀，保证候选只来自本用例
  const uniq = "筛选专用标签" + Math.floor(Math.random() * 1e6);
  db.put({ _id: "tag/kb-x1", type: "tag", name: uniq, createdAt: now, updatedAt: now } as never);
  enter({ code: "flashstash.save.text", type: "over", payload: "先筛后选" });
  await wait();
  const tagInput = app().querySelector(".tag-input") as HTMLInputElement;
  const suggest = app().querySelector(".tag-suggest") as HTMLElement;
  const filterWord = uniq.slice(0, 6);
  tagInput.value = filterWord;
  tagInput.dispatchEvent(new window.InputEvent("input", { bubbles: true }));
  await wait();
  const opts = [...suggest.querySelectorAll(".opt")].map((o) => o.textContent ?? "");
  assert.ok(opts.length === 1 && opts[0].includes(filterWord), "筛选后候选应唯一，实际：" + opts.join(","));

  // ① 直接回车 = 新建“筛选词”本身（0.6.0 定稿语义：直接回车永远是“我要这个”）
  tagInput.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await wait();
  let chips = [...app().querySelectorAll(".tag-field-box .chip-item")].map((c) => c.querySelector(".chip-text")?.textContent ?? "");
  assert.deepEqual(chips, [filterWord], "直接回车应新建筛选词本身，实际：" + chips.join(","));

  // ② 重新输入筛选词，按 ↓ 高亮后再回车 = 选中已有候选
  tagInput.value = filterWord;
  tagInput.dispatchEvent(new window.InputEvent("input", { bubbles: true }));
  await wait();
  tagInput.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  await wait();
  const highlighted = suggest.querySelector(".opt.active")?.textContent ?? "";
  assert.ok(highlighted.includes(uniq), "↓ 的高亮项应是被筛出的那条，实际高亮：" + highlighted);
  tagInput.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await wait();
  chips = [...app().querySelectorAll(".tag-field-box .chip-item")].map((c) => c.querySelector(".chip-text")?.textContent ?? "");
  assert.ok(chips.includes(uniq), "↓ 后回车应选中已有标签，实际：" + chips.join(","));

  const d = db.get("tag/kb-x1");
  if (d) db.remove(d as never);
});

test("0.6.0：标签建议列表紧跟标签字段（不再向上展开后与输入框拉开大间隔）", async () => {
  closeAllLayers();
  enter({ code: "flashstash.save.text", type: "over", payload: "建议列表定位" });
  await wait();
  const tagInput = app().querySelector(".tag-input") as HTMLInputElement;
  const suggest = app().querySelector(".tag-suggest") as HTMLElement;
  tagInput.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await wait();
  assert.equal(suggest.style.display, "block", "应展开建议列表");
  // 定位以「标签字段」为准：列表 top 等于字段下沿（向下）或上沿（向上），不会飘到很远
  const field = app().querySelector(".tag-field-box") as HTMLElement;
  const fieldRect = field.getBoundingClientRect();
  const top = parseFloat(suggest.style.top);
  const up = suggest.classList.contains("drop-up");
  assert.ok(Math.abs(top - (up ? fieldRect.top : fieldRect.bottom)) < 8,
    `建议列表应贴住标签字段（top=${top}, 字段=${fieldRect.top}~${fieldRect.bottom}, up=${up}）`);
  assert.ok(suggest.style.left !== "" && suggest.style.width !== "", "应显式设定左右与宽度以对齐输入区");
  // 上下方向由 class 精确控制，CSS 里 .drop-up 才做 translateY(-100%)
  assert.ok(getComputedStyle(suggest).position === "absolute" || suggest.className.includes("tag-suggest"),
    "建议列表应是相对字段定位的内联浮层");
});

test("0.6.0：输入标签名回车是【新建标签】，不会被下拉候选项抢走（回归）", async () => {
  closeAllLayers();
  const now = Date.now();
  const uniq = "新建回归" + Math.floor(Math.random() * 1e6);
  db.put({ _id: "tag/new-a", type: "tag", name: uniq + "乙", createdAt: now, updatedAt: now } as never);
  enter({ code: "flashstash.save.text", type: "over", payload: "新建标签回归" });
  await wait();
  const tagInput = app().querySelector(".tag-input") as HTMLInputElement;
  const suggest = app().querySelector(".tag-suggest") as HTMLElement;
  tagInput.value = uniq;
  tagInput.dispatchEvent(new window.InputEvent("input", { bubbles: true }));
  await wait();
  assert.ok([...suggest.querySelectorAll(".opt")].some((o) => (o.textContent ?? "").includes(uniq + "乙")),
    "下拉应出现被命中的候选（复现前提）");
  // 直接回车（没按过 ↓）：应新建 uniq 本身，而不是选中 uniq乙
  tagInput.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await wait();
  const chips = [...app().querySelectorAll(".tag-field-box .chip-item")].map((c) => c.querySelector(".chip-text")?.textContent ?? "");
  assert.deepEqual(chips, [uniq], `回车应新建「${uniq}」本身，实际：` + chips.join(","));
  const d = db.get("tag/new-a");
  if (d) db.remove(d as never);
});

test("0.6.0：按 ↓ 高亮后回车选中候选项，且 ↓ 逐项推进", async () => {
  closeAllLayers();
  const now = Date.now();
  const uniq = "选中回归" + Math.floor(Math.random() * 1e6);
  db.put({ _id: "tag/pick-a", type: "tag", name: uniq + "甲", createdAt: now, updatedAt: now } as never);
  db.put({ _id: "tag/pick-b", type: "tag", name: uniq + "乙", createdAt: now, updatedAt: now } as never);
  enter({ code: "flashstash.save.text", type: "over", payload: "选中回归" });
  await wait();
  const tagInput = app().querySelector(".tag-input") as HTMLInputElement;
  const suggest = app().querySelector(".tag-suggest") as HTMLElement;
  tagInput.value = uniq;
  tagInput.dispatchEvent(new window.InputEvent("input", { bubbles: true }));
  await wait();
  tagInput.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  await wait();
  const first = suggest.querySelector(".opt.active")?.textContent ?? "";
  assert.ok(first.includes(uniq), "↓ 应高亮第 1 项，实际：" + first);
  tagInput.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await wait();
  const chips = [...app().querySelectorAll(".tag-field-box .chip-item")].map((c) => c.querySelector(".chip-text")?.textContent ?? "");
  assert.deepEqual(chips, [first], "回车应选中所高亮的候选项，实际：" + chips.join(","));

  // 重新输入（上一步已把“甲”加进 chips，候选只剩“乙”）：↓↓ 应停在唯一一项
  tagInput.value = uniq;
  tagInput.dispatchEvent(new window.InputEvent("input", { bubbles: true }));
  await wait();
  const remain = [...suggest.querySelectorAll(".opt")].map((o) => o.textContent ?? "");
  assert.deepEqual(remain, [uniq + "乙"], "已选中的标签不应再出现在候选里，实际：" + remain.join(","));
  tagInput.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  await wait();
  const h1 = suggest.querySelector(".opt.active")?.textContent ?? "";
  tagInput.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  await wait();
  const h2 = suggest.querySelector(".opt.active")?.textContent ?? "";
  assert.equal(h1, uniq + "乙", "↓ 应高亮唯一候选");
  assert.equal(h2, uniq + "乙", "只有一项时 ↓ 应停在原地（clamp，不循环）");
  for (const id of ["tag/pick-a", "tag/pick-b"]) {
    const d = db.get(id);
    if (d) db.remove(d as never);
  }
});

test("0.6.0：改动筛选词后高亮复位，↓ 从第 1 项重新开始（回归）", async () => {
  closeAllLayers();
  const now = Date.now();
  const uniq = "复位回归" + Math.floor(Math.random() * 1e6);
  ["甲", "乙", "丙"].forEach((suf, i) => {
    db.put({ _id: "tag/rst-" + i, type: "tag", name: uniq + suf, createdAt: now, updatedAt: now } as never);
  });
  enter({ code: "flashstash.save.text", type: "over", payload: "高亮复位" });
  await wait();
  const tagInput = app().querySelector(".tag-input") as HTMLInputElement;
  const suggest = app().querySelector(".tag-suggest") as HTMLElement;
  tagInput.value = uniq;
  tagInput.dispatchEvent(new window.InputEvent("input", { bubbles: true }));
  await wait();
  tagInput.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  await wait();
  tagInput.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  await wait();
  assert.equal(suggest.querySelectorAll(".opt.active").length, 1, "应有且仅有一个高亮项");
  // 删掉末尾一个字符：列表刷新 → 高亮必须清零
  tagInput.value = uniq.slice(0, -1);
  tagInput.dispatchEvent(new window.InputEvent("input", { bubbles: true }));
  await wait();
  assert.equal(suggest.querySelectorAll(".opt.active").length, 0, "筛选词变化后高亮应复位（不残留旧位置）");
  tagInput.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  await wait();
  const active = suggest.querySelector(".opt.active");
  assert.ok(active && active === suggest.querySelectorAll(".opt")[0], "改动筛选词后 ↓ 应从第 1 项重新开始");
  for (let i = 0; i < 3; i++) {
    const d = db.get("tag/rst-" + i);
    if (d) db.remove(d as never);
  }
});

test("0.6.0：标签建议列表高度给足（不再被硬性 200px 卡住）", async () => {
  closeAllLayers();
  enter({ code: "flashstash.save.text", type: "over", payload: "列表高度" });
  await wait();
  const tagInput = app().querySelector(".tag-input") as HTMLInputElement;
  const suggest = app().querySelector(".tag-suggest") as HTMLElement;
  tagInput.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await wait();
  assert.equal(suggest.style.display, "block", "应展开建议列表");
  const mh = parseInt(suggest.style.maxHeight, 10);
  assert.ok(mh >= 120, `列表最大高度应给足（实际 ${mh}px，旧版上限 200px 且常被压到更小）`);
});

test("0.6.0：多行纯文本（SQL）两个入口都按 text 收藏且内容完整保留", async () => {
  closeAllLayers();
  // 用 none 风格保存，避免成功浮层盖住视图影响后续断言
  putUx({ successStyle: "none", successDelayMs: 1200 });
  // 用唯一标记，避免命中其它用例写入的同名片段
  const mark = "-- 多行SQL回归" + Math.floor(Math.random() * 1e6);
  const sql = [mark, "SELECT id, name", "FROM users", "WHERE age > 18;", "-- 结束"].join("\r\n");
  clipboardText = sql;
  enter({ code: "flashstash.save.clipboard", type: "text", payload: "" });
  await wait();
  assert.equal(app().querySelector(".kind-tab.active")?.textContent?.trim(), "文本", "剪贴板多行内容应默认文本");
  const ta = app().querySelector("textarea.ta") as HTMLTextAreaElement;
  assert.ok(ta.value.includes("SELECT id, name"), "应带入完整内容");
  assert.ok(ta.value.split("\n").length >= 5, "多行内容应完整保留（不被截断）");
  click(app().querySelector(".sv .btn.primary"));
  await wait(80);
  let snips = db.allDocs("snippet/") as unknown as Array<{ content: string; kind: string }>;
  const saved = snips.find((x) => x.content.includes(mark));
  assert.ok(saved, "应写入收藏");
  assert.equal(saved?.kind, "text", "多行 SQL 应保存为 text 类型");
  assert.ok(saved?.content.includes("-- 结束"), "内容应原样保留到结尾");
  assert.equal(saved?.content.split("\n").length, 5, "五行内容应完整保留");
  // 多行 payload 走「收藏文本」入口
  enter({ code: "flashstash.save.text", type: "over", payload: sql });
  await wait();
  assert.equal(app().querySelector(".kind-tab.active")?.textContent?.trim(), "文本", "多行 payload 也应默认文本");
  click(app().querySelector(".sv .btn.primary"));
  await wait(80);
  snips = db.allDocs("snippet/") as unknown as Array<{ content: string; kind: string }>;
  assert.equal(snips.filter((x) => x.kind === "text" && x.content.includes(mark)).length, 2,
    "两个入口都应写入 text 收藏");
  const again = snips.find((x) => x.content.includes(mark) && x.content.includes("-- 结束"));
  assert.ok(again, "payload 入口也应在文本模式下原样保留多行内容");
  clipboardText = null;
});

// ---------- 0.6.3：token field 标签交互（添加顺序 / 两段式退格删除 / 落库拼音排序） ----------
/** 打开保存视图并加入若干标签，返回操作句柄 */
async function tagInputHarness(payload: string, tags: string[]) {
  enter({ code: "flashstash.save.text", type: "over", payload });
  await wait();
  const tagInput = app().querySelector(".tag-input") as HTMLInputElement;
  /** 已选标签：按 DOM 顺序（= 添加顺序）读取名字，待删的加 [待删] 后缀 */
  const chips = () => [...app().querySelectorAll(".tag-field-box .chip-item")]
    .map((c) => (c.querySelector(".chip-text")?.textContent ?? "") + (c.classList.contains("pending-del") ? "[待删]" : ""));
  for (const t of tags) {
    tagInput.value = t;
    tagInput.dispatchEvent(new window.InputEvent("input", { bubbles: true }));
    await wait();
    tagInput.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await wait();
  }
  const bs = async () => {
    tagInput.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Backspace", bubbles: true }));
    await wait(10);
  };
  const type = async (v: string) => {
    tagInput.value = v;
    tagInput.dispatchEvent(new window.InputEvent("input", { bubbles: true }));
    await wait(10);
  };
  return { tagInput, chips, bs, type };
}

test("0.6.3：标签按【添加顺序】显示（不再按拼音重排）", async () => {
  closeAllLayers();
  // 刻意让"添加顺序"与"拼音顺序"不同：前端(f) / 工作(g) / 测试(c)
  const H = await tagInputHarness("标签顺序", ["前端", "工作", "测试"]);
  assert.deepEqual(H.chips(), ["前端", "工作", "测试"], "应按添加先后原样显示，而不是拼音序（测试/工作/前端）");
  // 再补一个，应追加在末尾
  await H.type("备注项");
  H.tagInput.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await wait();
  assert.deepEqual(H.chips(), ["前端", "工作", "测试", "备注项"], "新标签应追加到末尾");
});

test("0.6.3：token field 中退格删的是【视觉上最后一个】标签（两段式，先标红再删）", async () => {
  closeAllLayers();
  const H = await tagInputHarness("退格删除", ["前端", "工作", "测试"]);
  // 第一次退格：只标记最后一个（测试），不删除
  await H.bs();
  assert.deepEqual(H.chips(), ["前端", "工作", "测试[待删]"], "第一次退格应标记视觉上最后一个标签");
  // 第二次退格：真正删除
  await H.bs();
  assert.deepEqual(H.chips(), ["前端", "工作"], "再按一次才删除该标签");
  // 再删一个，确认总是删最后一个
  await H.bs();
  await H.bs();
  assert.deepEqual(H.chips(), ["前端"], "删除对象始终是视觉上最后一个（与显示顺序一致）");
});

test("0.6.3：长按退格不会成串清空已选标签", async () => {
  closeAllLayers();
  const H = await tagInputHarness("退格长按", ["标签甲", "标签乙", "标签丙"]);
  await H.bs();
  assert.equal(H.chips().filter((c) => c.includes("[待删]")).length, 1, "应只有一个待删标记");
  await H.bs();
  assert.equal(H.chips().length, 2, "只应删掉一个");
  await H.bs();
  assert.equal(H.chips().length, 2, "第三次退格只标记，不删除");
  assert.equal(H.chips().filter((c) => c.includes("[待删]")).length, 1, "仍只有一个待删标记");
});

test("0.6.3：输入框有内容时退格只删文字，不动已选标签", async () => {
  closeAllLayers();
  const H = await tagInputHarness("退格删字", ["标签甲"]);
  await H.type("xyz");
  await H.bs();
  assert.deepEqual(H.chips(), ["标签甲"], "输入框有内容时退格不应影响标签");
});

test("0.6.3：待删标记在继续输入后自动取消", async () => {
  closeAllLayers();
  const H = await tagInputHarness("退格取消", ["标签甲"]);
  await H.bs();
  assert.deepEqual(H.chips(), ["标签甲[待删]"], "退格后应出现待删标记");
  await H.type("n");
  assert.deepEqual(H.chips(), ["标签甲"], "继续输入应取消待删标记，且标签保留");
});

test("0.6.3：保存时标签按拼音排序落库（编辑时按存储顺序显示、不再重排）", async () => {
  closeAllLayers();
  putUx({ successStyle: "none", successDelayMs: 1200 });
  const mark = "排序落库" + Math.floor(Math.random() * 1e6);
  // 按"前端 / 工作 / 测试"添加，拼音序应为"测试 / 前端 / 工作"
  enter({ code: "flashstash.save.text", type: "over", payload: mark });
  await wait();
  const tagInput = app().querySelector(".tag-input") as HTMLInputElement;
  for (const t of ["前端", "工作", "测试"]) {
    tagInput.value = t;
    tagInput.dispatchEvent(new window.InputEvent("input", { bubbles: true }));
    await wait();
    tagInput.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await wait();
  }
  // 界面上仍是添加顺序
  assert.deepEqual(
    [...app().querySelectorAll(".tag-field-box .chip-item")].map((c) => c.querySelector(".chip-text")?.textContent),
    ["前端", "工作", "测试"],
    "编辑界面应保持添加顺序"
  );
  click(app().querySelector(".sv .btn.primary"));
  await wait(80);
  const snips = db.allDocs("snippet/") as unknown as Array<{ _id: string; content: string; tags: string[] }>;
  const saved = snips.find((x) => x.content === mark);
  assert.ok(saved, "应写入收藏");
  const sorted = [...saved!.tags].sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
  assert.deepEqual(saved!.tags, sorted, "落库的标签应按拼音排序：" + saved!.tags.join(","));

  // 打开编辑：按存储顺序显示（即拼音序），不再重排成别的顺序
  enter({ code: "flashstash.main", type: "text", payload: "" });
  await wait();
  const card = [...app().querySelectorAll(".card")].find((c) => (c.textContent ?? "").includes(mark));
  assert.ok(card, "应找到刚保存的收藏");
  click([...card!.querySelectorAll(".mini-btn")].find((b) => (b.textContent ?? "").trim() === "编辑")!);
  await wait();
  assert.deepEqual(
    [...app().querySelectorAll(".tag-field-box .chip-item")].map((c) => c.querySelector(".chip-text")?.textContent),
    saved!.tags,
    "编辑时应按存储顺序显示"
  );
  const d = db.get(saved!._id);
  if (d) db.remove(d as never);
});

// ---------- 0.6.4：删标签收起候选列表 / 下拉滚动跟随高亮 ----------
test("0.6.4：删标签（退格两段式 / 点 ×）时候选列表收起——此时不会选标签", async () => {
  closeAllLayers();
  const H = await tagInputHarness("删除收起列表", ["标签甲", "标签乙"]);
  const suggest = app().querySelector(".tag-suggest") as HTMLElement;
  // 展开候选列表（空白回车）
  H.tagInput.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await wait();
  assert.equal(suggest.style.display, "block", "空白回车应展开候选列表");
  // 第一次退格（标记待删）→ 列表应收起
  await H.bs();
  assert.equal(suggest.style.display, "none", "标记待删除时应收起候选列表");
  assert.equal(H.chips().some((c) => c.includes("待删")), true, "仍应出现待删标记");
  // 再展开 → 第二次退格（真删）→ 列表仍收起
  H.tagInput.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await wait();
  assert.equal(suggest.style.display, "block", "应能再次展开");
  await H.bs();
  assert.equal(suggest.style.display, "none", "确认删除时也应收起候选列表");
  assert.deepEqual(H.chips(), ["标签甲"], "应删掉一个标签");
  // 点 × 删除同样不应弹出列表
  const x = app().querySelector(".tag-field-box .chip-item .x") as HTMLElement;
  click(x);
  await wait();
  assert.equal(suggest.style.display, "none", "点 × 删除时不应弹出候选列表");
});

test("0.6.4：占位提示包含 Esc 收起候选的说明", async () => {
  closeAllLayers();
  enter({ code: "flashstash.save.text", type: "over", payload: "占位提示" });
  await wait();
  const tagInput = app().querySelector(".tag-input") as HTMLInputElement;
  const ph = tagInput.placeholder;
  assert.ok(ph.includes("回车"), "占位应说明回车添加：" + ph);
  assert.ok(ph.includes("Esc"), "占位应提示 Esc 可收起候选：" + ph);
  assert.ok(ph.includes("收起"), "占位应说明 Esc 的作用是收起：" + ph);
});

test("0.6.5：键盘上下移动时下拉按整行滚动，高亮项始终完整可见（回归：不再跳到上一条的下一条）", async () => {
  closeAllLayers();
  const now = Date.now();
  const ROW = 32, BORDER = 2;
  for (let i = 0; i < 40; i++) {
    db.put({ _id: "tag/scroll-" + i, type: "tag", name: "滚动项" + String(i).padStart(2, "0"), createdAt: now, updatedAt: now } as never);
  }
  /**
   * jsdom 没有真实布局，这里补一套**贴近真实盒模型**的量法：
   * - 行高 32px
   * - clientHeight = maxHeight - border（border-box），且不超过内容总高
   * 用来验证滚动算法本身（此前用 scrollIntoView 时 jsdom 下压根没执行，是假绿灯）。
   */
  const proto = window.HTMLElement.prototype as never as Record<string, unknown>;
  const saved = ["offsetTop", "offsetHeight", "clientHeight"].map(
    (k) => [k, Object.getOwnPropertyDescriptor(proto, k)] as const
  );
  Object.defineProperty(proto, "offsetTop", {
    configurable: true,
    get(this: HTMLElement) {
      const sibs = [...(this.parentElement?.children ?? [])];
      const i = sibs.indexOf(this);
      return i < 0 ? 0 : i * ROW;
    }
  });
  Object.defineProperty(proto, "offsetHeight", { configurable: true, get() { return ROW; } });
  Object.defineProperty(proto, "clientHeight", {
    configurable: true,
    get(this: HTMLElement) {
      if (!this.classList?.contains("tag-suggest")) return 0;
      const mh = parseFloat(this.style.maxHeight) || 0;
      const content = (this.children?.length ?? 0) * ROW;
      return Math.max(0, Math.min(content, mh - BORDER));
    }
  });
  try {
    enter({ code: "flashstash.save.text", type: "over", payload: "滚动跟随" });
    await wait();
    const tagInput = app().querySelector(".tag-input") as HTMLInputElement;
    const suggest = app().querySelector(".tag-suggest") as HTMLElement;
    tagInput.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await wait();
    assert.ok(suggest.querySelectorAll(".opt").length >= 20, "候选应足够多以产生滚动");

    /**
     * 关键回归点（0.6.5 的真正根因）：
     * 列表可视高度必须是**整行数**。此前 max-height 被夹到 320px，border-box 扣掉 2px 边框后
     * clientHeight=318px（9.94 行）→ 滚到第 10 项时 scrollTop 变成 2/34/66…（非行高整数倍），
     * 顶部永远被切掉 2px；表现就是"移到可视范围最后一条再往下，像跳回了上一条的下一条"。
     * 这里同时锁住：整行高度 + scrollTop 整行对齐。
     */
    const rows = suggest.clientHeight / ROW;
    assert.ok(Number.isInteger(rows) && rows >= 3,
      `列表可视高度应是整行数（clientHeight=${suggest.clientHeight}px / 行高 ${ROW}px = ${rows} 行）；maxHeight=${suggest.style.maxHeight}`);
    assert.equal(suggest.clientHeight % ROW, 0, "clientHeight 必须是行高的整数倍，否则会出现半行、滚动不对齐");

    const idxOf = () => [...suggest.querySelectorAll(".opt")].indexOf(suggest.querySelector(".opt.active") as Element);
    const visible = () => {
      const i = idxOf();
      const top = suggest.scrollTop;
      return i * ROW >= top && i * ROW + ROW <= top + suggest.clientHeight;
    };

    // ↓ 到底：高亮必须始终**完整可见**，且 scrollTop 必须是行高的整数倍（整行对齐）
    let sawScroll = false;
    for (let i = 0; i < 34; i++) {
      tagInput.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
      await wait(4);
      assert.ok(visible(), `第 ${i + 1} 次 ↓ 后高亮项应完整可见（idx=${idxOf()}, scrollTop=${suggest.scrollTop}, 可视高=${suggest.clientHeight}）`);
      assert.equal(suggest.scrollTop % ROW, 0, `scrollTop 应整行对齐（实际 ${suggest.scrollTop}，行高 ${ROW}）`);
      if (suggest.scrollTop > 0) sawScroll = true;
    }
    assert.ok(sawScroll, "高亮越过可视区后 scrollTop 必须跟随滚动");
    // 按下 N 次 ↓ 后应停在已到达的位置（不循环、clamp 到底）
    const allOpts = suggest.querySelectorAll(".opt").length;
    assert.ok(idxOf() > 20, "应已滚过可视区、停在靠后的位置，实际 idx=" + idxOf());

    // ↑ 回顶：仍然完整可见，且 scrollTop 归零
    for (let i = 0; i < allOpts; i++) {
      tagInput.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
      await wait(4);
      assert.ok(visible(), `第 ${i + 1} 次 ↑ 后高亮项应完整可见（idx=${idxOf()}, scrollTop=${suggest.scrollTop}）`);
    }
    assert.equal(idxOf(), 0, "应回到第 1 项");
    assert.equal(suggest.scrollTop, 0, "回到顶部时 scrollTop 应归零");
  } finally {
    for (const [k, d] of saved) {
      if (d) Object.defineProperty(proto, k, d); else delete proto[k];
    }
    dropSnippets(Array.from({ length: 40 }, (_, i) => "tag/scroll-" + i));
  }
});

/**
 * 0.6.8 回归（此现象第 5 次才找到真因，0.6.4~0.6.7 连续四次都没修对）：
 * 「走到可视区最后一条再按 ↓，不跟随、跳回顶端、丢高亮」。
 *
 * 真因（事件层，第一次暴露）：
 *   document 上的 capture scroll 监听（repositionSuggest，0.6.0 为“列表贴字段”而设）
 *   连**下拉自身的 scroll 事件**也一并捕获 → 调 `showSuggest()` → `rebuildSuggestOpts()`
 *   整表重建 + `suggestActive=-1` + `scrollTop` 钳回 0，正是“回顶/丢高亮”。
 *   scroll 事件由浏览器在滚动后**异步派发**，目标是 suggestEl 本身；
 *   重建出的选项是全新节点，指针下方的新节点会再触发 mouseenter（此时 kbdNav 已被
 *   重建复位）→ 与“鼠标有点关系”。
 *
 * ⚠️ jsdom 里 `scrollTop` 赋值**不会**派发 scroll 事件——这是前四次测试假绿灯的共同原因。
 *    本用例在每次可能产生滚动的 ↓ 之后**显式派发** `Event("scroll")`（目标 = suggestEl，
 *    capture 监听在捕获阶段照样触发），像真实浏览器一样走这条路径。
 */
test("0.6.8：下拉自身的 scroll 事件不得触发候选列表重建（回归：回顶 / 丢高亮）", async () => {
  closeAllLayers();
  const now = Date.now();
  const ROW = 32;
  for (let i = 0; i < 40; i++) {
    db.put({ _id: "tag/scrollrb-" + i, type: "tag", name: "滚复现项" + String(i).padStart(2, "0"), createdAt: now, updatedAt: now } as never);
  }
  const proto = window.HTMLElement.prototype as never as Record<string, unknown>;
  const saved = ["offsetTop", "offsetHeight", "clientHeight"].map(
    (k) => [k, Object.getOwnPropertyDescriptor(proto, k)] as const
  );
  Object.defineProperty(proto, "offsetTop", {
    configurable: true,
    get(this: HTMLElement) {
      const sibs = [...(this.parentElement?.children ?? [])];
      const i = sibs.indexOf(this);
      return i < 0 ? 0 : i * ROW;
    }
  });
  Object.defineProperty(proto, "offsetHeight", { configurable: true, get() { return ROW; } });
  Object.defineProperty(proto, "clientHeight", {
    configurable: true,
    get(this: HTMLElement) {
      if (!this.classList?.contains("tag-suggest")) return 0;
      const mh = parseFloat(this.style.maxHeight) || 0;
      return Math.max(0, Math.min((this.children?.length ?? 0) * ROW, mh - 2));
    }
  });
  try {
    enter({ code: "flashstash.save.text", type: "over", payload: "自身滚动重建" });
    await wait();
    const tagInput = app().querySelector(".tag-input") as HTMLInputElement;
    const suggest = app().querySelector(".tag-suggest") as HTMLElement;
    tagInput.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await wait();
    const opts = () => [...suggest.querySelectorAll(".opt")] as HTMLElement[];
    const idxOf = () => opts().findIndex((o) => o.classList.contains("active"));
    assert.ok(opts().length >= 30, "候选应足够多以触发滚动：n=" + opts().length);

    let sawScroll = false;
    // 高亮从 -1 出发：按 n 次走到第 n-1 项（与真实用户连续按 ↓ 同量级）
    for (let i = 0; i < suggest.querySelectorAll(".opt").length; i++) {
      tagInput.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
      // 真实浏览器在 scrollTop 变化后异步派发 scroll（目标 = 下拉自身，capture 监听可捕获）
      suggest.dispatchEvent(new window.Event("scroll"));
      await wait(4);
      assert.equal(idxOf(), i,
        `第 ${i + 1} 次 ↓ 后高亮必须正好在第 ${i} 项（实际 ${idxOf()}，scrollTop=${suggest.scrollTop}）`);
      if (suggest.scrollTop > 0) sawScroll = true;
    }
    assert.ok(sawScroll, "越过可视区后必须发生滚动（否则本用例是空转的）");
    assert.equal(idxOf(), suggest.querySelectorAll(".opt").length - 1, "↓ 到底应停在最后一项（clamp）");
  } finally {
    for (const [k, d] of saved) {
      if (d) Object.defineProperty(proto, k, d); else delete proto[k];
    }
    dropSnippets(Array.from({ length: 40 }, (_, i) => "tag/scrollrb-" + i));
  }
});

/**
 * 0.6.6 回归 A（用户实测的真根因）：
 * 「高亮 → 按下 → 没有高亮 → 按下 → 跳过没高亮的那条，直接到下一条」。
 *
 * 真因：列表滚动时**新的一行会滑到静止的鼠标指针下面**，浏览器对该行触发 mouseenter，
 * 而旧实现的 onmouseenter 无条件接管高亮，把键盘刚选中的 `.active` 抹掉。
 *
 * 本用例显式模拟这个"被动 mouseenter"，它必须被忽略；
 * 同时验证**用户真的移动鼠标**时仍能正常接管（否则就把鼠标选择彻底弄坏了）。
 */test("0.6.7：慢速按键下伪 mouseenter 仍不得冲掉键盘高亮（回归：失高亮 / 滚动条回顶）", async () => {
  closeAllLayers();
  const now = Date.now();
  const ROW = 32;
  for (let i = 0; i < 30; i++) {
    db.put({ _id: "tag:mouse-" + i, type: "tag", name: "鼠标项" + String(i).padStart(2, "0"), createdAt: now, updatedAt: now } as never);
  }
  const proto = window.HTMLElement.prototype as never as Record<string, unknown>;
  const saved = ["offsetTop", "offsetHeight", "clientHeight"].map(
    (k) => [k, Object.getOwnPropertyDescriptor(proto, k)] as const
  );
  Object.defineProperty(proto, "offsetTop", {
    configurable: true,
    get(this: HTMLElement) {
      const sibs = [...(this.parentElement?.children ?? [])];
      const i = sibs.indexOf(this);
      return i < 0 ? 0 : i * ROW;
    }
  });
  Object.defineProperty(proto, "offsetHeight", { configurable: true, get() { return ROW; } });
  Object.defineProperty(proto, "clientHeight", {
    configurable: true,
    get(this: HTMLElement) {
      if (!this.classList?.contains("tag-suggest")) return 0;
      const mh = parseFloat(this.style.maxHeight) || 0;
      return Math.max(0, Math.min((this.children?.length ?? 0) * ROW, mh - 2));
    }
  });
  try {
    enter({ code: "flashstash.save.text", type: "over", payload: "鼠标干扰" });
    await wait();
    const tagInput = app().querySelector(".tag-input") as HTMLInputElement;
    const suggest = app().querySelector(".tag-suggest") as HTMLElement;
    tagInput.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await wait();
    const opts = () => [...suggest.querySelectorAll(".opt")] as HTMLElement[];
    const idxOf = () => opts().findIndex((o) => o.classList.contains("active"));
    let sawScroll = false;
    let lastScroll = 0;
    assert.ok(opts().length >= 10, "候选应足够多");

    /**
     * 0.6.7 关键：按键间隔必须**大于**旧的 500ms「免疫时间窗」。
     * 旧实现用计时器做保护，用户按键稍慢（思考、找键位）保护就过期、现象复发——
     * 这正是用户反馈"和我鼠标有点关系"的原因。
     * 这里刻意用 560ms 的慢速按键，旧实现必然失败；新的粘性 `kbdNav` 模式与时间无关，必然通过。
     */
    for (let i = 0; i < 12; i++) {
      tagInput.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
      await wait(560);
      const cur = idxOf();
      assert.equal(cur, i, `第 ${i + 1} 次 ↓ 后高亮应正好在第 ${i} 项（实际 ${cur}）`);
      // 模拟被动 mouseenter：指针停在列表里，滚上来的行触发 mouseenter
      const underCursor = opts()[Math.min(i + 1, opts().length - 1)];
      underCursor.dispatchEvent(new window.MouseEvent("mouseenter", { bubbles: false }));
      await wait(2);
      assert.equal(idxOf(), cur, "滚动引发的伪 mouseenter 不得改变键盘高亮（否则就会出现「没有高亮」）");
      /**
       * 用户实测的连续症状：一旦高亮被鼠标改到靠前的项，下一次 ↓ 会让
       * `itemTop < scrollTop` 成立 → 滚动条"回到最上面"、第一条露出来但无高亮。
       * 这里顺带锁住：持续按 ↓ 的过程中滚动条只能单调前进，绝不回退。
       */
      const st = suggest.scrollTop;
      if (sawScroll) {
        assert.ok(st >= lastScroll,
          `持续按 ↓ 时滚动条不应回退（上次 ${lastScroll} → 本次 ${st}）`);
      }
      if (st > 0) sawScroll = true;
      lastScroll = st;
    }
    assert.ok(sawScroll, "按 ↓ 越过可视区后滚动条必须跟随移动（否则本用例是空转的）");

    // 但用户**真的移动鼠标**时必须能接管：mousemove 退出键盘导航模式
    const target = opts()[2];
    target.dispatchEvent(new window.MouseEvent("mousemove", { bubbles: true }));
    target.dispatchEvent(new window.MouseEvent("mouseenter", { bubbles: false }));
    await wait(2);
    assert.equal(idxOf(), 2, "用户真实移动鼠标后，鼠标应能接管高亮");
  } finally {
    for (const [k, d] of saved) {
      if (d) Object.defineProperty(proto, k, d); else delete proto[k];
    }
    dropSnippets(Array.from({ length: 30 }, (_, i) => "tag:mouse-" + i));
  }
});

/**
 * 0.6.6 回归 B：`max-height` 必须是**真实行高**的整数倍。
 *
 * 旧实现把行高写死 32，而 CSS 里 `.opt` 的高度是由
 * `font-size(12.5px) × line-height + padding(7px×2)` 自然撑开的（实际约 27~29px），
 * 于是 `maxRows * 32 + 2` 并不是真实行高的整数倍 → 列表上下永远被切掉一部分，
 * 正是用户说的"遮蔽一半记录"。0.6.5 的用例因为**自己注入了 32**，完全测不到这一点。
 *
 * 这里刻意注入一个"非 32"的真实行高（模拟 CSS 自然撑开的结果），
 * 要求 clientHeight 仍是该行高的整数倍。
 */
test("0.6.6：下拉高度按【实测行高】对齐整行，不再因写死 32 而切掉半行", async () => {
  closeAllLayers();
  const now = Date.now();
  const REAL_ROW = 29; // 12.5px * 1.2 + 14 ≈ 29px：CSS 自然撑开的真实高度
  for (let i = 0; i < 30; i++) {
    db.put({ _id: "tag:rowh-" + i, type: "tag", name: "行高项" + String(i).padStart(2, "0"), createdAt: now, updatedAt: now } as never);
  }
  const proto = window.HTMLElement.prototype as never as Record<string, unknown>;
  const saved = ["offsetTop", "offsetHeight", "clientHeight"].map(
    (k) => [k, Object.getOwnPropertyDescriptor(proto, k)] as const
  );
  Object.defineProperty(proto, "offsetTop", {
    configurable: true,
    get(this: HTMLElement) {
      const sibs = [...(this.parentElement?.children ?? [])];
      const i = sibs.indexOf(this);
      return i < 0 ? 0 : i * REAL_ROW;
    }
  });
  Object.defineProperty(proto, "offsetHeight", { configurable: true, get() { return REAL_ROW; } });
  Object.defineProperty(proto, "clientHeight", {
    configurable: true,
    get(this: HTMLElement) {
      if (!this.classList?.contains("tag-suggest")) return 0;
      const mh = parseFloat(this.style.maxHeight) || 0;
      return Math.max(0, Math.min((this.children?.length ?? 0) * REAL_ROW, mh - 2));
    }
  });
  try {
    enter({ code: "flashstash.save.text", type: "over", payload: "行高对齐" });
    await wait();
    const tagInput = app().querySelector(".tag-input") as HTMLInputElement;
    const suggest = app().querySelector(".tag-suggest") as HTMLElement;
    tagInput.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await wait();
    const ch = suggest.clientHeight;
    assert.ok(ch > 0, "列表应已展开（clientHeight>0）");
    assert.equal(ch % REAL_ROW, 0,
      `可视高度必须是真实行高 ${REAL_ROW}px 的整数倍，否则会切掉半行（实际 ${ch}px，maxHeight=${suggest.style.maxHeight}）`);
  } finally {
    for (const [k, d] of saved) {
      if (d) Object.defineProperty(proto, k, d); else delete proto[k];
    }
    dropSnippets(Array.from({ length: 30 }, (_, i) => "tag:rowh-" + i));
  }
});

/** 0.6.6 回归 C：候选选项不得抢走输入框焦点（否则 blur 会收起列表、键盘失效）。 */
test("0.6.6：候选选项不可聚焦，点击/导航不会让标签输入框失去焦点", async () => {
  closeAllLayers();
  const H = await tagInputHarness("焦点保持", ["占位标签"]);
  const suggest = app().querySelector(".tag-suggest") as HTMLElement;
  H.tagInput.focus();
  H.tagInput.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await wait();
  const opt = suggest.querySelector(".opt") as HTMLElement;
  assert.ok(opt, "应有候选项");
  /**
   * 断言"点选项后焦点仍在输入框"，而不是只断言属性存在——
   * 属性只是手段，用户真正感受到的是"焦点还在不在"。
   * 若选项可被聚焦，浏览器会把焦点移过去，输入框的 blur 处理器随即收起列表。
   */
  assert.equal(opt.getAttribute("tabindex"), "-1", "候选项应设 tabindex=-1，避免被浏览器聚焦");
  opt.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  await wait(10);
  assert.equal(document.activeElement, H.tagInput,
    "选中候选项后焦点必须仍在标签输入框（否则后续键盘操作会失效）");
});

