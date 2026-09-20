// 拼音匹配工具（基于 pinyin-pro）：
// 为中文文本建立「全拼（无声调） + 首字母」双索引，查询串（纯 ASCII）命中任一索引即视为拼音匹配。
// 用于：标签建议 / 标签管理查询 / 收藏记录搜索（0.5.6 新增）。
// 全部逻辑与正则均避免 lookbehind（Node 16 兼容）。
import { pinyin } from "pinyin-pro";

export interface PinyinIndex {
  /** 全拼（无空格、无声调、ü→v），如 “前端框架” → "qianduankuangjia" */
  full: string;
  /** 首字母（非中文片段保留原字符），如 “前端框架” → "qdkj" */
  initials: string;
}

/** 值缓存：文本内容作 key（字符串按值比较），避免同一文本反复转拼音 */
const cache = new Map<string, PinyinIndex>();
const CACHE_LIMIT = 400;
/** 超过该长度的文本不缓存（如大段正文），每次现算，防止长期占用内存 */
const NO_CACHE_LEN = 2000;

function build(text: string): PinyinIndex {
  const pieces = pinyin(text, { toneType: "none", v: true, type: "array" });
  let full = "";
  let initials = "";
  for (const piece of pieces) {
    if (!piece) continue;
    if (/\s/.test(piece)) continue; // 跳过空白片段（pinyin-pro 会把空格/换行原样作为片段）
    full += piece;
    initials += piece[0];
  }
  return { full, initials };
}

/** 文本的拼音索引；不含中文时返回 null（纯 ASCII 文本无需拼音索引，避免无谓缓存） */
export function pinyinIndexOf(text: string): PinyinIndex | null {
  const t = String(text ?? "");
  if (!/[\u4e00-\u9fff]/.test(t)) return null;
  if (t.length > NO_CACHE_LEN) return build(t);
  let idx = cache.get(t);
  if (idx) return idx;
  idx = build(t);
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(t, idx);
  return idx;
}

/** 查询串是否为纯 ASCII（可当作拼音查询处理） */
export function isPinyinQuery(q: string): boolean {
  return /^[a-z0-9]+$/.test(String(q ?? ""));
}

/** 拼音匹配：文本的拼音索引（全拼或首字母）包含查询串；非拼音查询一律 false */
export function matchPinyin(text: string, query: string): boolean {
  const q = String(query ?? "").toLowerCase();
  if (!q || !isPinyinQuery(q)) return false;
  const idx = pinyinIndexOf(text);
  if (!idx) return false;
  return idx.full.includes(q) || idx.initials.includes(q);
}

/** 复合匹配：常规子串命中，或拼音匹配命中（标签建议 / 标签管理查询共用） */
export function matchTextOrPinyin(text: string, queryRaw: string): boolean {
  const t = String(text ?? "");
  const q = String(queryRaw ?? "").toLowerCase();
  if (!q) return true; // 空查询不过滤
  if (t.toLowerCase().includes(q)) return true;
  return matchPinyin(t, q);
}