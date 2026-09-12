import type { Snippet } from "./types.ts";
import { snippetTitle } from "./utils.ts";

export interface SearchHit {
  snippet: Snippet;
  score: number;
  matchedOn: Array<"content" | "note" | "title" | "tag">;
}

const TOKEN_SPLIT = /[\s,，。;；:：、|]+/;

/**
 * 全文搜索：内容 / 备注 / 标题 / 标签。
 * 多词查询（空格分隔）要求每个词都至少命中一个字段（AND 语义）。
 * 权重：标签 > 备注 > 标题 > 内容。
 */
export function searchSnippets(
  snippets: Snippet[],
  tags: Array<{ _id: string; name: string }>,
  queryRaw: string
): SearchHit[] {
  const q = (queryRaw ?? "").trim();
  if (!q) {
    return snippets.map((s) => ({ snippet: s, score: 0, matchedOn: [] }));
  }
  const tokens = q.toLowerCase().split(TOKEN_SPLIT).filter(Boolean);
  const effective = tokens.length > 0 ? tokens : [q.toLowerCase()];
  const tagNameById = new Map(tags.map((t) => [t._id, t.name]));
  const results: SearchHit[] = [];

  for (const s of snippets) {
    const content = (s.content ?? "").toLowerCase();
    const note = (s.note ?? "").toLowerCase();
    const title = snippetTitle(s).toLowerCase();
    const tagNames = (s.tags ?? [])
      .map((t) => tagNameById.get(t) ?? t)
      .join(" ")
      .toLowerCase();

    let matchedAll = true;
    const matchedOn = new Set<"content" | "note" | "title" | "tag">();
    let score = 0;
    for (const tok of effective) {
      let hitHere = false;
      if (content.includes(tok)) {
        score += 1;
        hitHere = true;
        matchedOn.add("content");
      }
      if (note.includes(tok)) {
        score += 4;
        hitHere = true;
        matchedOn.add("note");
      }
      if (title.includes(tok)) {
        score += 2;
        hitHere = true;
        matchedOn.add("title");
      }
      if (tagNames.includes(tok)) {
        score += 6;
        hitHere = true;
        matchedOn.add("tag");
      }
      for (const t of s.tags ?? []) {
        const tn = (tagNameById.get(t) ?? t).toLowerCase();
        if (tn.includes(tok)) {
          score += 5;
          hitHere = true;
          matchedOn.add("tag");
        }
      }
      if (!hitHere) {
        matchedAll = false;
        break;
      }
    }
    if (matchedAll) {
      results.push({ snippet: s, score: Math.round(score), matchedOn: [...matchedOn] });
    }
  }

  results.sort((a, b) => b.score - a.score || b.snippet.updatedAt - a.snippet.updatedAt);
  return results;
}

/** 过滤：类型 / 标签（tags 数组为任一命中，即 OR 语义） */
export function filterSnippets(
  hits: SearchHit[],
  opts: { kind?: Snippet["kind"] | ""; tags?: string[] }
): SearchHit[] {
  return hits.filter((h) => {
    const s = h.snippet;
    if (opts.kind && s.kind !== opts.kind) return false;
    if (opts.tags && opts.tags.length > 0) {
      const has = opts.tags.some((t) => (s.tags ?? []).includes(t));
      if (!has) return false;
    }
    return true;
  });
}
