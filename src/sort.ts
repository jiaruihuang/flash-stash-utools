// 收藏列表排序（0.6.0）
//
// 设计要点：
// - 排序是**展示层**能力，不改变检索语义：检索/筛选先得出命中集合（SearchHit，带相关度分），
//   本模块只决定这些命中「以什么顺序」呈现。
// - `SearchHit` 的结构与 `sortHits` 的入参保持**结构兼容**（只要有 snippet 字段即可），
//   便于纯数据层（Store/Search）直接复用。
// - 排序一律返回**新数组**，不改动入参，避免调用方持有的列表被就地打乱。
import type { Snippet } from "./types.ts";

export type SortKey = "recent" | "updated" | "created" | "hits" | "title" | "kind";
export type SortDir = "asc" | "desc";
export type SortMode = "smart" | SortKey;
export type GroupMode = "none" | "day";

export interface SortOptions {
  key: SortMode;
  dir: SortDir;
  /** 是否按天分组显示（组内仍按所选顺序） */
  group?: GroupMode;
  /** 搜索相关度（key="smart" 且有关键词时参与排序；缺省按 0 处理） */
  score?: (s: Snippet) => number;
  /** 标题取值（缺省用内置截断规则；主面板传 snippetTitle 与之保持一致） */
  title?: (s: Snippet) => string;
}

export interface SortOption {
  key: SortKey;
  label: string;
  /** 默认方向（点「排序」下拉重置时使用） */
  dir: SortDir;
  desc: string;
}

/** 可选项（顺序即下拉里的展示顺序） */
export const SORT_OPTIONS: SortOption[] = [
  { key: "updated", label: "更新时间", dir: "desc", desc: "按最近修改/保存时间" },
  { key: "created", label: "创建时间", dir: "desc", desc: "按首次收藏时间" },
  { key: "recent", label: "最近使用", dir: "desc", desc: "按最近一次复制取用时间" },
  { key: "hits", label: "使用次数", dir: "desc", desc: "按复制取用次数" },
  { key: "title", label: "标题", dir: "asc", desc: "按标题拼音/笔画（中文顺序）" },
  { key: "kind", label: "类型", dir: "asc", desc: "按文本 / Markdown / 图片归组" }
];

export const GROUP_OPTIONS: Array<{ key: GroupMode; label: string; desc: string }> = [
  { key: "none", label: "不分组", desc: "平铺展示全部结果" },
  { key: "day", label: "按日期分组", desc: "按「今天 / 昨天 / 更早」分段，组内保持所选顺序" }
];

const SORT_KEYS: SortKey[] = SORT_OPTIONS.map((o) => o.key);

/** 把任意输入规范成合法排序键（"smart" = 搜索时按相关度） */
export function normalizeSortKey(v: unknown): SortMode {
  if (v === "smart") return "smart";
  return SORT_KEYS.includes(v as SortKey) ? (v as SortKey) : "updated";
}

export function normalizeSortDir(v: unknown): SortDir {
  return v === "asc" ? "asc" : "desc";
}

export function normalizeGroup(v: unknown): GroupMode {
  return v === "day" ? "day" : "none";
}

/** 下拉展示文案：`排序：更新时间 ↓` */
export function sortLabel(key: SortMode, dir: SortDir): string {
  const arrow = dir === "asc" ? "↑" : "↓";
  if (key === "smart") return "排序：相关度 " + arrow;
  const opt = SORT_OPTIONS.find((o) => o.key === key);
  return "排序：" + (opt?.label ?? "更新时间") + " " + arrow;
}

export function sortOptionLabel(key: SortKey): string {
  const opt = SORT_OPTIONS.find((o) => o.key === key);
  return opt ? opt.label : key;
}

/** 有效排序键：smart 在有搜索词时按相关度，否则回落到更新时间 */
export type EffectiveKey = SortKey | "smart";

export function effectiveKey(o: SortOptions, hasQuery: boolean): EffectiveKey {
  if (o.key === "smart") return hasQuery ? "smart" : "updated";
  return o.key;
}

function useCount(s: Snippet): number {
  return typeof s.useCount === "number" && s.useCount > 0 ? s.useCount : 0;
}

function lastUsed(s: Snippet): number {
  return typeof s.lastUsedAt === "number" && s.lastUsedAt > 0 ? s.lastUsedAt : 0;
}

const KIND_ORDER: Record<Snippet["kind"], number> = { text: 0, markdown: 1, image: 2 };

/**
 * 对（已检索/筛选过的）集合排序。
 * - 主键相同时一律以「更新时间倒序」兜底，保证列表稳定、不会因并列而乱跳。
 * - 返回新数组。
 */
export function sortSnippets<T extends { snippet: Snippet }>(hits: T[], o: SortOptions, hasQuery = false): T[] {
  const key = effectiveKey(o, hasQuery);
  const dir = o.dir;
  const title = o.title ?? ((s: Snippet) => defaultTitle(s));
  const score = o.score ?? (() => 0);
  const sign = dir === "asc" ? 1 : -1;
  const out = hits.slice();
  out.sort((x, y) => {
    const a = x.snippet;
    const b = y.snippet;
    let primary = 0;
    switch (key) {
      case "smart":
        primary = score(a) - score(b);
        break;
      case "created":
        primary = a.createdAt - b.createdAt;
        break;
      case "recent":
        primary = lastUsed(a) - lastUsed(b);
        break;
      case "hits":
        primary = useCount(a) - useCount(b);
        break;
      case "title":
        primary = title(a).localeCompare(title(b), "zh-Hans-CN");
        break;
      case "kind": {
        const ka = KIND_ORDER[a.kind] ?? 9;
        const kb = KIND_ORDER[b.kind] ?? 9;
        primary = ka - kb;
        break;
      }
      case "updated":
      default:
        primary = a.updatedAt - b.updatedAt;
        break;
    }
    if (primary !== 0) return primary * sign;
    return b.updatedAt - a.updatedAt || String(a._id).localeCompare(String(b._id));
  });
  return out;
}

function defaultTitle(s: Snippet): string {
  if (s.kind === "image") return s.note || "图片";
  const t = (s.content ?? "").trim();
  const line = t ? t.split(/\r?\n/, 1)[0].trim() : "";
  return line || s.note || "无标题";
}

/** 分组标签：今天 / 昨天 / 本周 / 更早（按给定时间戳与当前时刻比较） */
export function dayGroupLabel(ts: number, now = Date.now()): string {
  const d = new Date(ts);
  const n = new Date(now);
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (sameDay(d, n)) return "今天";
  if (sameDay(d, new Date(now - 86400000))) return "昨天";
  if (now - ts < 7 * 86400000) return "本周";
  const pad = (v: number) => String(v).padStart(2, "0");
  if (d.getFullYear() === n.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 分组锚点：智能/创建/最近使用按各自语义取时间，其余按更新时间 */
function groupAnchor(s: Snippet, key: EffectiveKey): number {
  if (key === "created") return s.createdAt || s.updatedAt;
  if (key === "recent") return lastUsed(s) || s.updatedAt;
  return s.updatedAt;
}

/**
 * 按组分段：返回 [{label, items}]，输入需已排序。
 * 组顺序沿用输入顺序（例如时间倒序时天然是 今天→昨天→…）。
 */
export function groupSnippets<T extends { snippet: Snippet }>(
  hits: T[],
  o: SortOptions,
  hasQuery = false,
  now = Date.now()
): Array<{ label: string; items: T[] }> {
  const key = effectiveKey(o, hasQuery);
  const groups: Array<{ label: string; items: T[] }> = [];
  for (const h of hits) {
    const label = dayGroupLabel(groupAnchor(h.snippet, key), now);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(h);
    else groups.push({ label, items: [h] });
  }
  return groups;
}
