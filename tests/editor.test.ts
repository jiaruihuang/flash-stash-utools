// 编辑器命令级测试（0.5.0）：直接驱动 src/editor.ts 的 Tiptap 实例
// 覆盖：工具栏各命令（加粗/标题/列表/引用/代码块/行内码/链接/表格/撤销重做）、
//       Markdown↔HTML 往返（含表格 gfm 保留）、LegacyEnter 回车语义（代码块/引用退出）
import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", { pretendToBeVisual: true });
const { window } = dom;
(globalThis as never as Record<string, unknown>).window = window;
(globalThis as never as Record<string, unknown>).document = window.document;
(globalThis as never as Record<string, unknown>).requestAnimationFrame = window.requestAnimationFrame;
(globalThis as never as Record<string, unknown>).cancelAnimationFrame = window.cancelAnimationFrame;
(globalThis as never as Record<string, unknown>).getComputedStyle = window.getComputedStyle;
for (const g of ["HTMLElement", "HTMLDivElement", "Node", "Range", "Text", "Element", "KeyboardEvent",
  "Event", "DocumentFragment", "NodeList", "MutationObserver", "DOMParser", "XMLSerializer", "CSSStyleDeclaration"]) {
  try {
    Object.defineProperty(globalThis, g, { value: (window as never as Record<string, unknown>)[g], configurable: true });
  } catch { /* 忽略 */ }
}
const rp = window.Range.prototype as never as Record<string, unknown>;
if (typeof rp.getClientRects !== "function") rp.getClientRects = () => [];
if (typeof rp.getBoundingClientRect !== "function") {
  rp.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }) as DOMRect;
}

const { createMdEditor, prepareBlockSelection, toggleCodeBlockSmart, splitLinesForList } = await import("../src/editor.ts");
const { htmlToMarkdown, renderMarkdown } = await import("../src/render.ts");

interface Handle {
  el: HTMLElement;
  editor: any;
  lastHtml: string;
  destroy(): void;
  key(key: string, init?: { shiftKey?: boolean }): void;
}
function makeEditor(md: string): Handle {
  const el = document.createElement("div");
  document.body.append(el);
  const h: Handle = {
    el,
    editor: null as never,
    lastHtml: "",
    destroy: () => { h.editor?.destroy(); el.remove(); },
    key: (key: string, init: { shiftKey?: boolean } = {}) => {
      (el.querySelector(".ProseMirror") as HTMLElement)
        .dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true, ...init }));
    }
  };
  h.editor = createMdEditor(el, { md, onUpdate: (html: string) => { h.lastHtml = html; } });
  return h;
}

test("载入 Markdown 渲染为可编辑结构（标题/加粗/列表）", () => {
  const h = makeEditor("# 标题\n**加粗**内容\n\n- 条目一\n- 条目二");
  const html = h.editor.getHTML();
  assert.ok(html.includes("<h1>"), "标题应渲染为 h1");
  assert.ok(html.includes("<strong>"), "加粗应渲染为 strong");
  assert.ok(html.includes("<ul>") && html.includes("<li>"), "列表应渲染为 ul/li");
  h.destroy();
});

test("调色按钮：全选后 B/I/U/S 切换并撤销还原", () => {
  const h = makeEditor("段落文字");
  h.editor.chain().selectAll().toggleBold().run();
  assert.ok(h.editor.isActive("bold"), "应激活加粗");
  assert.ok(h.editor.getHTML().includes("<strong>段落文字</strong>"), "选区应被加粗包裹");
  h.editor.commands.undo();
  assert.ok(!h.editor.getHTML().includes("<strong>"), "undo 后应还原");
  h.destroy();
});

test("标题按钮：H2/H3 切换与还原", () => {
  const h = makeEditor("段落文字");
  h.editor.chain().focus().toggleHeading({ level: 2 }).run();
  assert.ok(h.editor.isActive("heading", { level: 2 }), "H2 应激活");
  assert.ok(h.editor.getHTML().includes("<h2>"), "应渲染为 h2");
  h.editor.chain().focus().toggleHeading({ level: 3 }).run();
  assert.ok(h.editor.getHTML().includes("<h3>"), "再点 H3 应变为 h3");
  h.destroy();
});

test("列表按钮：无序/有序列表切换", () => {
  const h = makeEditor("条目");
  h.editor.chain().focus().toggleBulletList().run();
  assert.ok(h.editor.isActive("bulletList"), "应激活无序列表");
  assert.ok(h.editor.getHTML().includes("<ul>"), "应渲染为 ul");
  h.editor.chain().focus().toggleBulletList().run();
  h.editor.chain().focus().toggleOrderedList().run();
  assert.ok(h.editor.isActive("orderedList"), "应激活有序列表");
  assert.ok(h.editor.getHTML().includes("<ol>"), "应渲染为 ol");
  h.destroy();
});

test("引用按钮：toggleBlockquote 包裹段落", () => {
  const h = makeEditor("引用内容");
  h.editor.chain().focus().toggleBlockquote().run();
  assert.ok(h.editor.isActive("blockquote"), "应激活引用");
  assert.ok(h.editor.getHTML().includes("<blockquote>"), "应渲染为 blockquote");
  h.editor.chain().focus().toggleBlockquote().run();
  assert.ok(!h.editor.isActive("blockquote"), "再点应取消引用");
  h.destroy();
});

test("代码块按钮：toggleCodeBlock 生成 pre，代码内容保留", () => {
  const h = makeEditor("段落文字");
  h.editor.chain().focus().toggleCodeBlock().run();
  assert.ok(h.editor.isActive("codeBlock"), "应激活代码块");
  assert.ok(h.el.querySelector("pre"), "应生成 pre");
  h.editor.commands.insertContent("const a = 1;");
  assert.ok(h.editor.getHTML().includes("const a = 1;"), "代码内容应写入");
  h.destroy();
});

test("行内码按钮：toggleCode 包裹选中文字", () => {
  const h = makeEditor("段落文字");
  h.editor.chain().selectAll().toggleCode().run();
  assert.ok(h.editor.isActive("code"), "应激活行内码");
  assert.ok(h.editor.getHTML().includes("<code>段落文字</code>"), "选中文字应包裹 code");
  h.destroy();
});

test("链接按钮：setLink 给选中文字加 href", () => {
  const h = makeEditor("跳转链接");
  h.editor.chain().selectAll().setLink({ href: "https://example.com" }).run();
  assert.ok(h.editor.isActive("link"), "应激活链接");
  // Tiptap 会给 a 附加 target/rel 属性，只断言 href 存在
  assert.ok(h.editor.getHTML().includes('href="https://example.com"'), "应生成带 href 的链接");
  h.destroy();
});

test("表格按钮：insertTable 生成表格，deleteTable 删除", () => {
  const h = makeEditor("表格内容");
  h.editor.chain().focus().insertTable({ rows: 2, cols: 2, withHeaderRow: true }).run();
  assert.ok(h.editor.isActive("table"), "应激活表格");
  assert.ok(h.el.querySelector("table"), "应生成 table");
  h.editor.chain().focus().deleteTable().run();
  assert.ok(!h.el.querySelector("table"), "应删除表格");
  h.destroy();
});

test("撤销/重做：undo 还原、redo 重做", () => {
  const h = makeEditor("段落文字");
  h.editor.chain().selectAll().toggleBold().run();
  const bolded = h.editor.getHTML();
  assert.ok(bolded.includes("<strong>"), "加粗成功");
  h.editor.commands.undo();
  assert.ok(!h.editor.getHTML().includes("<strong>"), "undo 应还原");
  h.editor.commands.redo();
  assert.ok(h.editor.getHTML().includes("<strong>"), "redo 应重做");
  h.destroy();
});

test("Markdown 往返：表格经 渲染→编辑→回写 仍为 GFM 表格", () => {
  const md = "| 名称 | 数量 |\n| --- | --- |\n| 苹果 | 3 |";
  const h = makeEditor(md);
  // Tiptap 会给 table 加 style 属性，断言以 `<table` 开头即可
  assert.ok(h.editor.getHTML().includes("<table"), "应渲染出表格");
  const back = htmlToMarkdown(h.editor.getHTML());
  assert.ok(back.includes("| 名称 | 数量 |"), "回写应保留 GFM 表格分隔线与表头");
  assert.ok(back.includes("| 苹果 | 3 |"), "回写应保留单元格内容");
  h.destroy();
});

test("表格行列增删：addRowAfter / addColumnAfter / deleteRow / deleteColumn", () => {
  const h = makeEditor("表格内容");
  h.editor.chain().focus().insertTable({ rows: 2, cols: 2, withHeaderRow: true }).run();
  const rows = () => h.el.querySelectorAll("table tr").length;
  const firstRowCells = () =>
    h.el.querySelectorAll("table tr:first-child th, table tr:first-child td").length;
  assert.equal(rows(), 2, "初始 2 行（表头+数据）");
  assert.equal(firstRowCells(), 2, "初始 2 列");
  h.editor.chain().focus().addRowAfter().run();
  assert.equal(rows(), 3, "加行后 3 行");
  h.editor.chain().focus().addColumnAfter().run();
  assert.equal(firstRowCells(), 3, "加列后 3 列");
  h.editor.chain().focus().deleteRow().run();
  assert.equal(rows(), 2, "删行后 2 行");
  h.editor.chain().focus().deleteColumn().run();
  assert.equal(firstRowCells(), 2, "删列后 2 列");
  h.destroy();
});

test("代码块语法高亮：js 围栏渲染出 hljs token", () => {
  const h = makeEditor("```js\nconst a = 1;\n```");
  const code = h.el.querySelector("pre code");
  assert.ok(code, "应有代码块");
  const hl = h.el.querySelector("pre code .hljs-keyword") ?? h.el.querySelector("pre .hljs-keyword");
  assert.ok(hl, "应渲染出关键字高亮 token");
  h.destroy();
});

test("预览渲染同样高亮：renderMarkdown 输出 hljs token，且不漏代码", () => {
  const html = renderMarkdown("```js\nconst a = 1;\n```");
  assert.ok(html.includes("hljs-keyword"), "预览 HTML 应含高亮 token");
  const text = html.replace(/<[^>]+>/g, "");
  assert.ok(text.includes("const a = 1;"), "代码内容不应丢失");
});

test("回车语义：代码块内回车换行、末行 ↓ 退出代码块（引擎标准行为，0.5.2）", () => {
  const h = makeEditor("```\nx\n```");
  const pre = h.el.querySelector("pre") as HTMLElement | null;
  assert.ok(pre, "应有代码块");
  h.editor.commands.focus("end");
  // 回车：代码块内换行，不再退出
  h.key("Enter");
  assert.ok(h.el.querySelector("pre") === pre, "回车后仍应留在代码块内");
  assert.ok(h.editor.isActive("codeBlock"), "回车不应退出代码块");
  assert.equal(pre!.textContent, "x\n", "回车应在代码块内插入换行");
  // ↓：末行退出代码块到新段落
  h.key("ArrowDown");
  assert.ok(!h.editor.isActive("codeBlock"), "末行 ↓ 应退出代码块");
  const next = pre!.nextElementSibling as HTMLElement | null;
  assert.ok(next && next.tagName === "P", "代码块后应出现普通段落");
  h.destroy();
});

test("回车语义：回车为新段落，Shift+Enter 为段内软换行（0.5.3 标准语义）", () => {
  const h = makeEditor("第一行");
  h.editor.commands.focus("end");
  h.key("Enter");
  h.editor.commands.insertContent("第二行");
  const html = h.editor.getHTML();
  assert.ok(html.includes("</p><p>"), "回车应新建段落（块级结构，H1/列表才能按行生效）");
  const md = htmlToMarkdown(html);
  assert.ok(md.includes("第一行") && md.includes("第二行"), "两行内容都应保留");
  // Shift+Enter：同一段落内的软换行
  const h2 = makeEditor("甲");
  h2.editor.commands.focus("end");
  h2.key("Enter", { shiftKey: true });
  h2.editor.commands.insertContent("乙");
  const html2 = h2.editor.getHTML();
  assert.ok(html2.includes("<br"), "Shift+Enter 应插入软换行");
  assert.ok(!html2.includes("</p><p>"), "Shift+Enter 不应新建段落");
  h.destroy();
  h2.destroy();
});

test("块级命令：部分选中只作用于选中文字（先切块，0.5.3）", () => {
  // 引用：只有选中的前半句进引用
  const a = makeEditor("这句话前半部分要引用后半部分不要");
  a.editor.chain().focus().setTextSelection({ from: 1, to: 6 }).run();
  prepareBlockSelection(a.editor);
  a.editor.chain().focus().toggleBlockquote().run();
  const qh = a.el.querySelector("blockquote")?.textContent ?? "";
  assert.ok(qh.includes("这句话前半"), "选中的文字应进引用");
  assert.ok(!qh.includes("后半部分"), "未选中的文字不应被引用");
  a.destroy();

  // 列表：只有选中的文字成为列表项
  const b = makeEditor("前面的文字要变成列表项后面的不动");
  b.editor.chain().focus().setTextSelection({ from: 1, to: 6 }).run();
  prepareBlockSelection(b.editor);
  b.editor.chain().focus().toggleBulletList().run();
  const li = b.el.querySelector("li")?.textContent ?? "";
  assert.ok(li.includes("前面的文字"), "选中文字应成为列表项");
  assert.ok(!li.includes("后面的不动"), "未选中文字不应进入列表项");
  b.destroy();

  // 标题：只有选中的文字成为标题
  const c = makeEditor("前半做标题后半保持正文");
  c.editor.chain().focus().setTextSelection({ from: 1, to: 5 }).run();
  prepareBlockSelection(c.editor);
  c.editor.chain().focus().toggleHeading({ level: 2 }).run();
  assert.equal(c.el.querySelector("h2")?.textContent, "前半做标", "只有选中文字应成为标题");
  assert.ok(c.el.querySelector("p")?.textContent?.includes("题后半保持正文"), "其余文字应保留为正文");
  c.destroy();
});

test("块级命令：光标所在行才受影响（多段文本按行格式化，0.5.3）", () => {
  const h = makeEditor("第一行\n\n第二行\n\n第三行");
  assert.equal(h.el.querySelectorAll("p").length, 3, "三行应是三个段落");
  // 光标落在第二段
  h.editor.chain().focus().setTextSelection(1 + 3 + 2 + 1).run();
  prepareBlockSelection(h.editor);
  h.editor.chain().focus().toggleHeading({ level: 1 }).run();
  assert.equal(h.el.querySelector("h1")?.textContent, "第二行", "只有光标所在行变 H1");
  assert.equal(h.el.querySelectorAll("p").length, 2, "其余两行仍是段落");
  h.destroy();
});

test("行内代码：光标在代码末尾继续输入不再继承代码样式（0.5.3）", () => {
  const h = makeEditor("前缀 `code`");
  const end = h.editor.state.doc.content.size - 1;
  h.editor.chain().focus().setTextSelection(end).insertContent("尾部").run();
  assert.ok(!h.editor.isActive("code"), "末尾输入不应仍在行内代码内");
  assert.ok(h.editor.getHTML().includes("<code>code</code>尾部"), "新输入应是普通文本");
  h.destroy();
});

test("代码语言角标：编辑区 pre 带 data-language（显式或自动识别，0.5.3）", () => {
  const explicit = makeEditor("```java\npublic class A {}\n```");
  assert.equal(explicit.el.querySelector("pre")?.getAttribute("data-language"), "java", "显式语言应写入角标");
  explicit.destroy();
  const auto = makeEditor("```\nconst a = 1;\n```");
  assert.ok((auto.el.querySelector("pre")?.getAttribute("data-language") ?? "").length > 0, "无语言围栏应显示自动识别结果");
  auto.destroy();
});

test("预览代码块同样带语言角标 data-language（0.5.3）", () => {
  const html = renderMarkdown("```python\nprint(1)\n```");
  assert.ok(html.includes('data-language="python"'), "预览 pre 应带显式语言角标");
  const auto = renderMarkdown("```\nconst a = 1;\n```");
  assert.ok(/data-language="[^"]+"/.test(auto), "预览也应带自动识别语言角标");
});

test("往返完整性：空表格 富文本→源码→富文本 不丢表格（0.5.2）", () => {
  const a = makeEditor("正文");
  a.editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
  const md = htmlToMarkdown(a.editor.getHTML());
  assert.ok(md.includes("| --- | --- | --- |"), "源码应是合法 GFM 表格（含表头分隔行）");
  for (const line of md.split("\n")) {
    if (line.trim() === "" || !line.includes("|")) continue;
    assert.equal((line.match(/\|/g) ?? []).length, 4, "表格每行都应是完整的 3 列（不被换行打断）");
  }
  const b = makeEditor(md);
  assert.ok(b.el.querySelector("table"), "回到富文本应仍有表格");
  assert.equal(b.el.querySelectorAll("table tr").length, 3, "行数应保持 3");
  a.destroy();
  b.destroy();
});

test("往返完整性：无语言代码块 富文本→源码→富文本 内容与换行不丢（0.5.2）", () => {
  const a = makeEditor("```\nline1\nline2\n```");
  const md = htmlToMarkdown(a.editor.getHTML());
  assert.ok(md.includes("line1\nline2"), "源码应保留多行代码内容");
  const b = makeEditor(md);
  assert.equal(b.el.querySelector("pre")?.textContent, "line1\nline2", "回到富文本内容与换行应保持");
  a.destroy();
  b.destroy();
});

test("未识别语言的代码块不丢内容（highlightAuto 空结果回退纯文本，0.5.2）", () => {
  const text = renderMarkdown("```\nhello world\n```").replace(/<[^>]+>/g, "");
  assert.ok(text.includes("hello world"), "识别不出语言时应原样保留纯文本");
});

test("代码语言属性：设置 language 后渲染出对应 class（0.5.2）", () => {
  const h = makeEditor("```\ncode\n```");
  h.editor.chain().focus().updateAttributes("codeBlock", { language: "java" }).run();
  assert.ok(h.editor.getHTML().includes("language-java"), "应带 language-java class");
  assert.ok(htmlToMarkdown(h.editor.getHTML()).includes("```java"), "源码围栏应带语言");
  h.destroy();
});

test("代码块命令：多段选区合并成一个代码块（0.5.4）", () => {
  const h = makeEditor("line1\n\nline2\n\nline3");
  h.editor.chain().focus().selectAll().run();
  toggleCodeBlockSmart(h.editor);
  assert.equal(h.el.querySelectorAll("pre").length, 1, "多段选区应只生成一个代码块");
  assert.equal(h.el.querySelector("pre")?.textContent, "line1\nline2\nline3", "三行内容应合并进同一代码块");
  const md = htmlToMarkdown(h.editor.getHTML());
  assert.equal(md, "```\nline1\nline2\nline3\n```", "源码应是一段围栏");
  h.destroy();
});

test("代码块命令：光标在单段内仍是常规切换（0.5.4）", () => {
  const h = makeEditor("单行文字");
  h.editor.chain().focus().setTextSelection(2).run();
  toggleCodeBlockSmart(h.editor);
  assert.equal(h.el.querySelectorAll("pre").length, 1, "应生成一个代码块");
  assert.equal(h.el.querySelector("pre")?.textContent, "单行文字", "内容应原样进入代码块");
  h.destroy();
});

test("表格在文末：文档末尾有真实段落，↓ 落到段落而非 gap cursor（0.5.4）", () => {
  const h = makeEditor("");
  h.editor.chain().focus().insertTable({ rows: 2, cols: 2, withHeaderRow: true }).run();
  const kinds: string[] = [];
  h.editor.state.doc.forEach((n: { type: { name: string } }) => kinds.push(n.type.name));
  assert.equal(kinds[kinds.length - 1], "paragraph", "表格结尾应自动补一个段落");
  const cells = h.el.querySelectorAll("table tr:last-child td");
  const pos = h.editor.view.posAtDOM(cells[cells.length - 1], 0);
  h.editor.chain().focus().setTextSelection(pos + 1).run();
  h.key("ArrowDown");
  assert.equal(h.editor.state.selection.constructor.name, "TextSelection", "↓ 后应是文字光标");
  assert.ok(!h.el.querySelector(".ProseMirror-gapcursor"), "不应出现 gap cursor（横线光标）");
  h.destroy();
});

test("列表命令：软换行的多行文字逐行成项（0.5.4）", () => {
  const h = makeEditor("甲\n乙\n丙"); // 单段落 + 软换行（粘贴多行文本的常见形态）
  assert.equal(h.el.querySelectorAll("p").length, 1, "三行同属一个段落");
  h.editor.chain().focus().selectAll().run();
  splitLinesForList(h.editor);
  h.editor.chain().focus().toggleBulletList().run();
  const items = [...h.el.querySelectorAll("li")].map((li) => li.textContent);
  assert.deepEqual(items, ["甲", "乙", "丙"], "每行应各成一个列表项");
  h.destroy();
});

test("快捷键语义：引用内空段回车退出引用（LegacyEnter）", () => {
  const h = makeEditor("> 引用内容");
  const quote = h.el.querySelector("blockquote");
  assert.ok(quote, "应有引用块");
  h.editor.commands.focus("end");
  // 第一次回车：引用内新建空段落
  h.key("Enter");
  assert.equal(quote!.querySelectorAll("p").length, 2, "回车后引用内应有两个段落");
  // 第二次回车：空段退出引用
  h.key("Enter");
  const next = quote!.nextElementSibling as HTMLElement | null;
  assert.ok(next && next.tagName === "P", "引用后应出现普通段落");
  assert.equal(quote!.querySelectorAll("p").length, 1, "退出后引用内空段应被清理");
  h.destroy();
});