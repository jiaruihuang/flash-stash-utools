export function uid(prefix: string): string {
  return `${prefix}/${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function firstLine(text: string): string {
  const t = (text ?? "").trim();
  if (!t) return "";
  const line = t.split(/\r?\n/, 1)[0].trim();
  return line.length > 60 ? line.slice(0, 60) + "…" : line;
}

export function snippetTitle(s: { kind: string; content: string; note: string }): string {
  if (s.kind === "image") return s.note || "图片";
  const t = firstLine(s.content);
  return t || s.note || "无标题";
}

/** 收藏内容摘要（展示用） */
export function snippetExcerpt(s: { kind: string; content: string; note: string; imagePath?: string }): string {
  if (s.kind === "image") return s.note || "（图片）";
  const t = (s.content ?? "").trim().replace(/\r?\n/g, " ");
  if (t.length <= 90) return t;
  return t.slice(0, 90) + "…";
}

export function formatTime(ts: number): string {
  const d = new Date(ts);
  const nowD = new Date();
  const diff = nowD.getTime() - ts;
  const min = Math.floor(diff / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const pad = (n: number) => String(n).padStart(2, "0");
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (sameDay(d, nowD)) {
    const h = Math.floor(min / 60);
    if (h < 24) return `${h} 小时前`;
    return hm;
  }
  const yesterday = new Date(nowD.getTime() - 86400000);
  if (sameDay(d, yesterday)) return `昨天 ${hm}`;
  if (d.getFullYear() === nowD.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 将文本中命中查询的部分用 <mark> 高亮（返回已转义的 HTML） */
export function highlightText(text: string, query: string): string {
  const q = (query ?? "").trim();
  if (!q || !text) return escapeHtml(text ?? "");
  const lower = text;
  const ql = q.toLowerCase();
  const out: string[] = [];
  let i = 0;
  const push = (chunk: string, mark: boolean) => {
    if (!chunk) return;
    out.push(mark ? `<mark>${escapeHtml(chunk)}</mark>` : escapeHtml(chunk));
  };
  const sz = ql.length;
  while (i < lower.length) {
    const idx = lower.toLowerCase().indexOf(ql, i);
    if (idx === -1) {
      push(lower.slice(i), false);
      break;
    }
    push(lower.slice(i, idx), false);
    push(lower.slice(idx, idx + sz), true);
    i = idx + sz;
  }
  return out.join("");
}
