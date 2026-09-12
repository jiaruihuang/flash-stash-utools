// Markdown 富文本编辑器封装（0.5.0 起由 Tiptap 3 + StarterKit 驱动）
// 替代原先 contenteditable + document.execCommand 手写实现：
// 列表续编、粘贴清洗、IME、表格、代码块等由 ProseMirror 引擎原生解决。
import { Editor, Extension } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import { Code } from "@tiptap/extension-code";
import { Table } from "@tiptap/extension-table";
import { TableRow } from "@tiptap/extension-table-row";
import { TableCell } from "@tiptap/extension-table-cell";
import { TableHeader } from "@tiptap/extension-table-header";
import { TextSelection } from "@tiptap/pm/state";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { renderMarkdown, lowlight, detectedLanguage } from "./render.ts";

/** 行内代码：inclusive:false —— 光标停在代码末尾时继续输入不再继承 code 样式（0.5.3） */
const InlineCode = Code.extend({ inclusive: false });

/**
 * 代码块语言角标（0.5.3）：给每个 <pre> 挂 data-language（显式语言优先，否则用自动识别结果），
 * 由 CSS 用 ::before 渲染成右上角语言标签；不写入文档内容，纯装饰。
 */
const langDetectCache = new Map<string, string>();
function detectLanguage(text: string): string {
  const hit = langDetectCache.get(text);
  if (hit !== undefined) return hit;
  const lang = detectedLanguage(text);
  if (langDetectCache.size > 300) langDetectCache.clear();
  langDetectCache.set(text, lang);
  return lang;
}

const CodeLangBadge = Extension.create({
  name: "codeLangBadge",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("codeLangBadge"),
        props: {
          decorations(state) {
            const decos: Decoration[] = [];
            state.doc.descendants((node, pos) => {
              if (node.type.name !== "codeBlock") return true;
              const explicit = (node.attrs.language as string | null) || "";
              const label = explicit || detectLanguage(node.textContent);
              decos.push(Decoration.node(pos, pos + node.nodeSize, { "data-language": label }));
              return true;
            });
            return DecorationSet.create(state.doc, decos);
          }
        }
      })
    ];
  }
});

export interface MdEditorOptions {
  /** 初始 Markdown 源码（首次渲染时经 renderMarkdown 转 HTML 载入） */
  md: string;
  /** 内容变化回调（传当前 HTML，便于调用方走 htmlToMarkdown 同步/判脏） */
  onUpdate: (html: string) => void;
}

/**
 * 回车语义（0.5.3 定稿，回到行业标准）：
 * - 回车 = 新段落（块级结构，H1/列表/引用等块级格式才能按行生效）
 * - Shift+Enter = 段内软换行（同一段落里的 <br>，源码里是相邻两行）
 * - 代码块：交还引擎（行内换行、末行 ↓ 退出、三连回车退出）
 * - 引用内空段落：回车退出引用
 */
const LegacyEnter = Extension.create({
  name: "legacyEnter",

  addKeyboardShortcuts() {
    return {
      Enter: ({ editor }) => {
        const sel = editor.state.selection;
        if (!sel.empty) return false; // 有选区时走默认（拆块）
        const $from = sel.$from;

        // ① 代码块：交给引擎（含 ↓ 退出 / 三连回车退出）
        if (editor.isActive("codeBlock")) return false;

        // ② 引用：光标在引用内的空段落回车 → 删除该空段，在引用后新建段落并移入光标
        if ($from.parent.type.name === "paragraph" && $from.parent.content.size === 0) {
          for (let d = $from.depth; d > 0; d--) {
            if ($from.node(d).type.name === "blockquote") {
              const paraStart = $from.before($from.depth);
              const paraEnd = $from.after($from.depth);
              const quoteEnd = $from.after(d);
              const p = editor.state.schema.nodes.paragraph.create();
              const tr = editor.state.tr;
              tr.delete(paraStart, paraEnd);
              tr.insert(quoteEnd - (paraEnd - paraStart), p);
              const cursor = tr.mapping.map(quoteEnd - (paraEnd - paraStart) + 1);
              tr.setSelection(TextSelection.near(tr.doc.resolve(cursor)));
              tr.scrollIntoView();
              editor.view.dispatch(tr);
              return true;
            }
          }
        }
        // ③ 其余情况（段落/标题/列表）交还引擎：回车即新段落 / 列表续编
        return false;
      }
    };
  }
});

/**
 * 块级命令前的选区规整（0.5.3）：
 * 用户只选中段落中的一部分文字时，先按选区边界把段落切开，
 * 这样 H1/列表/引用等**只作用于选中的那段文字**，而不是整段。光标（无选区）时不动。
 */
export function prepareBlockSelection(editor: Editor): void {
  const { state } = editor;
  const { selection } = state;
  if (selection.empty) return; // 光标（无选区）：作用于当前块，无需切块
  const { from, to } = selection;
  const doc = state.doc;
  const $from = doc.resolve(from);
  const $to = doc.resolve(to);
  const startPartial = $from.parent.isTextblock && $from.parentOffset > 0;
  const endPartial = $to.parent.isTextblock && $to.parentOffset < $to.parent.content.size;
  if (!startPartial && !endPartial) return; // 选区已对齐块边界，无需处理

  const tr = state.tr;
  // 先切终点（位置在起点之后，切完不影响起点）
  if (endPartial) tr.split(to);
  if (startPartial) tr.split(from);
  // 切块后显式重设选区：起点向后偏（进入新块）、终点向前偏（留在原块末尾），
  // 否则映射会把终点推到下一块开头，导致整段仍被格式化
  tr.setSelection(TextSelection.create(tr.doc, tr.mapping.map(from, 1), tr.mapping.map(to, -1)));
  editor.view.dispatch(tr);
}

/**
 * 「代码块」按钮的智能命令（0.5.4）：
 * - 选区跨多个块（多行/多段/列表等）：把选中的内容**合并成一个**代码块（而不是每段一个）
 * - 选区在单个块内：先按选区边界切块，再常规 toggleCodeBlock（只包住选中文字）
 */
export function toggleCodeBlockSmart(editor: Editor): void {
  const { state } = editor;
  const { selection } = state;
  const $from = selection.$from;
  const $to = selection.$to;
  const fromTop = $from.before(1);
  const toTop = $to.after(1);

  if (!selection.empty && fromTop !== toTop) {
    const text = state.doc.textBetween(fromTop, toTop, "\n", "\n");
    const codeBlock = state.schema.nodes.codeBlock.create(null, text ? state.schema.text(text) : null);
    const tr = state.tr.replaceWith(fromTop, toTop, codeBlock);
    editor.view.dispatch(tr);
    const caret = Math.min(fromTop + 1, editor.state.doc.content.size);
    editor.commands.setTextSelection(caret);
    return;
  }
  if (!selection.empty) prepareBlockSelection(editor);
  editor.chain().focus().toggleCodeBlock().run();
}

/**
 * 列表命令前的行拆分（0.5.4）：
 * 粘贴/软换行来的多行文字是**同一个段落里的多个 <br>**，直接套列表会变成"一个列表项里塞多行"。
 * 这里先按硬换行把段落拆成多个块，再让列表命令逐行成项；光标在列表内或没有硬换行时不做处理。
 */
export function splitLinesForList(editor: Editor): void {
  const { state } = editor;
  if (editor.isActive("listItem") || editor.isActive("table")) return; // 列表内续编 / 表格内不拆
  const $from = state.selection.$from;
  const $to = state.selection.$to;
  const start = $from.before(1);
  const end = $to.after(1);
  const positions: number[] = [];
  state.doc.nodesBetween(start, end, (node, pos) => {
    if (node.type.name === "hardBreak") positions.push(pos);
    return true;
  });
  if (positions.length === 0) return;
  const tr = state.tr;
  for (let i = positions.length - 1; i >= 0; i--) {
    const pos = positions[i];
    // 从后往前：先在硬换行之后切块（换行留在前一块末尾），再删掉这个换行，
    // 这样每个块就是干净的一行（不留 <br> 尾巴）
    tr.split(pos + 1);
    tr.delete(pos, pos + 1);
  }
  const newStart = tr.mapping.map(start, 1);
  const newEnd = tr.mapping.map(end, -1);
  const from2 = newStart + 1;
  const to2 = Math.max(from2, newEnd - 1);
  tr.setSelection(TextSelection.create(tr.doc, from2, to2));
  editor.view.dispatch(tr);
}

/** 创建 Markdown 富文本编辑器（挂到 el 上），返回 Tiptap Editor 实例 */export function createMdEditor(el: HTMLElement, opts: MdEditorOptions): Editor {
  return new Editor({
    element: el,
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        link: { openOnClick: false, autolink: true, defaultProtocol: "https" },
        // TrailingNode：仅当文末不是段落时（如以表格/代码块结尾）自动补一个空段落，
        // 让 ↓ 能落到真实光标位置，而不是 ProseMirror 的 gap cursor「横线光标」
        trailingNode: { node: "paragraph" },
        // 代码块改用 CodeBlockLowlight（语法高亮 + 未知语言自动识别）
        codeBlock: false,
        // 行内代码改用 InlineCode（inclusive:false，代码末尾继续输入不继承样式）
        code: false
      }),
      CodeBlockLowlight.configure({
        lowlight,
        defaultLanguage: null,
        // 引擎标准退出方式：末行按 ↓ 或三连回车退出代码块
        exitOnArrowDown: true,
        exitOnTripleEnter: true
      }),
      InlineCode,
      CodeLangBadge,
      Table.configure({ resizable: false }),
      TableRow,
      TableCell,
      TableHeader,
      LegacyEnter
    ],
    content: renderMarkdown(opts.md),
    editorProps: {
      attributes: {
        spellcheck: "false",
        "data-placeholder": "在这里编写 Markdown 内容…"
      }
    },
    onUpdate: ({ editor }) => opts.onUpdate(editor.getHTML())
  });
}