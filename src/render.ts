import { marked } from "marked";
import DOMPurify from "dompurify";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import { createLowlight, common } from "lowlight";
import { escapeHtml } from "./utils.ts";

marked.setOptions({ gfm: true, breaks: true });

// 语法高亮（0.5.1）：编辑器内由 CodeBlockLowlight（lowlight）装饰渲染；
// 渲染/预览走这里，两侧共用同一套 hljs 主题色
export const lowlight = createLowlight(common);

/** lowlight 返回的 hast 树节点（仅用我们关心的字段） */
interface HastNode {
  type: string;
  value?: string;
  tagName?: string;
  properties?: { className?: string[] };
  children?: HastNode[];
}
function hastHtml(node: HastNode): string {
  if (node.type === "text") return node.value ?? "";
  const inner = (node.children ?? []).map(hastHtml).join("");
  // 根节点（type: "root"）没有标签名：只输出子内容，否则会产出 <undefined> 包裹层，
  // 被 DOMPurify 剥掉后连内容一起丢（0.5.1 实测「代码内容消失」的根因）
  if (node.type === "root" || !node.tagName) return inner;
  const cls = (node.properties?.className ?? []).join(" ");
  const attrs = cls ? ` class="${cls}"` : "";
  return `<${node.tagName}${attrs}>${inner}</${node.tagName}>`;
}

/**
 * 代码高亮：有语言按语言高亮（别名可解析），否则自动识别。
 * 注意：lowlight 未识别出语言时会返回**空树**（如纯文本 "line1\nline2"），
 * 此时必须回退为转义纯文本，否则代码内容会被整段抹掉（0.5.1 实测 bug）。
 */
function highlightCode(code: string, lang: string | null): string {
  try {
    let tree: HastNode | null = null;
    if (lang) {
      try { tree = lowlight.highlight(lang, code) as unknown as HastNode; } catch { tree = null; }
    }
    if (!tree) {
      try { tree = lowlight.highlightAuto(code) as unknown as HastNode; } catch { tree = null; }
    }
    const html = tree ? hastHtml(tree) : "";
    return html || escapeHtml(code);
  } catch {
    return escapeHtml(code);
  }
}

/** 可选代码语言列表（供语言选择器使用） */
export function codeLanguages(): string[] {
  return lowlight.listLanguages().slice().sort();
}

marked.use({
  renderer: {
    code({ text, lang }: { text: string; lang?: string }): string {
      const l = (lang || "").trim() || null;
      const cls = l ? `language-${l}` : "";
      return `<pre data-language="${escapeHtml(l ?? detectedLanguage(text))}"><code class="hljs ${cls}">${highlightCode(text, l)}</code></pre>`;
    }
  }
});

/** 自动识别的语言名（供语言角标显示；识别不出则空串） */
export function detectedLanguage(code: string): string {
  try {
    const tree = lowlight.highlightAuto(code) as unknown as { data?: { language?: string } };
    return tree?.data?.language ?? "";
  } catch {
    return "";
  }
}

const td = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
  emDelimiter: "*",
  strongDelimiter: "**"
});
/** 零宽空格：用于绕开 turndown 的空白节点短路（U+200B 不属于 ECMAScript 空白，trim 不会移除） */
const BLANK_GUARD = "\u200b";
// gfm 规则：删除线 / 任务列表等（表格由下面的 fsTable 规则接管，更可控）
td.use(gfm);
/**
 * 自研表格 → GFM 规则（0.5.2）：
 * gfm 自带的表格规则在「单元格内是块级 <p>」时会带出换行、空白单元格还会被 turndown
 * 的 blankRule 短路成 "\n\n"，导致 Markdown 表格结构被打断、往返后表格丢失。
 * 这里直接遍历 rows/cells，逐格递归转换 + 空白归一 + 转义 `|`，输出稳定的单行单元格。
 */
td.addRule("fsTable", {
  filter: (node: HTMLElement) => node.nodeName === "TABLE",
  replacement: (_content: string, node: HTMLElement) => {
    const table = node as HTMLTableElement;
    const rows = Array.from(table.rows ?? []);
    if (rows.length === 0) return "";
    const cellMd = (cell: HTMLTableCellElement): string =>
      td.turndown(cell.innerHTML || "")
        .replace(/\s*\n+\s*/g, " ")
        .trim()
        .replace(/\|/g, "\\|");
    const cols = rows[0].cells.length;
    const lines = rows.map((tr) => "| " + Array.from(tr.cells).map(cellMd).join(" | ") + " |");
    // Markdown 表格必须有表头分隔行；原表没有表头行时也补一行，保证往返不丢结构
    if (cols > 0) lines.splice(1, 0, "| " + Array.from({ length: cols }, () => "---").join(" | ") + " |");
    return "\n\n" + lines.join("\n") + "\n\n";
  }
});

/** Markdown → 安全 HTML（预览用） */
export function renderMarkdown(md: string): string {
  const html = marked.parse(md || "") as string;
  return DOMPurify.sanitize(html);
}

/** 富文本 HTML → Markdown 源码（富文本编辑保存时用） */
export function htmlToMarkdown(html: string): string {
  // turndown 对「空白节点」会在规则匹配前短路（blankRule），**全空表格**会被整表丢弃；
  // 先在 table 标签后插入零宽空格占位（U+200B 不参与 trim），转换完再清掉
  const guarded = (html || "").replace(/<table([^>]*)>/gi, "<table$1>" + BLANK_GUARD);
  // 末尾空段落（TrailingNode 补的占位段落）会留下尾部空行，这里去掉
  return td.turndown(guarded).split(BLANK_GUARD).join("").replace(/\s+$/, "");
}
