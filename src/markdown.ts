/** Markdown 特征检测（纯函数，可在 Node 16+ 测试） */

const HEADING = /(?:^|\n)\s{0,3}#{1,6}\s/m;
const LIST = /(?:^|\n)\s{0,3}(?:[-*+]\s|\d+[.)]\s)/m;
const QUOTE = /(?:^|\n)\s{0,3}>\s/m;
const FENCE = /(?:^|\n)\s{0,3}(```|~~~)/m;
const HR = /(?:^|\n)\s{0,3}(?:---|\*\*\*|___)\s*$/m;

function clean(text: string): string {
  return (text ?? "")
    .replace(/[\u200B\u200C\u200D\uFEFF]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function looksLikeMarkdown(text: string): boolean {
  const t = clean(text);
  if (!t) return false;
  return (
    HEADING.test(t) ||
    LIST.test(t) ||
    QUOTE.test(t) ||
    FENCE.test(t) ||
    HR.test(t)
  );
}

export function detectKind(text: string): "text" | "markdown" {
  return looksLikeMarkdown(text) ? "markdown" : "text";
}
