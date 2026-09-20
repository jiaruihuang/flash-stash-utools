import type { DbLike, DbDoc, Snippet, TagDoc, SnippetKind, UxSettings } from "./types.ts";
import { uid } from "./utils.ts";
import { normalizeSortKey, normalizeSortDir, normalizeGroup } from "./sort.ts";

export function normalizeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tags ?? []) {
    const n = String(t).trim();
    if (n && !seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  }
  return out;
}

export class Store {
  private db: DbLike;

  constructor(db: DbLike) {
    this.db = db;
  }

  /** ---------- 收藏 ---------- */

  listSnippets(): Snippet[] {
    const docs = this.db.allDocs("snippet/") as unknown as Snippet[];
    return (docs ?? [])
      .filter((d) => d && d.type === "snippet")
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  getSnippet(id: string): Snippet | null {
    const d = this.db.get(id) as unknown as Snippet | null;
    if (!d || d.type !== "snippet") return null;
    return d;
  }

  createSnippet(input: {
    kind: SnippetKind;
    content: string;
    note: string;
    tags: string[];
    imagePath?: string;
    imageExt?: string;
  }): Snippet {
    const now = Date.now();
    const doc: Snippet = {
      _id: uid("snippet"),
      type: "snippet",
      kind: input.kind,
      content: input.content ?? "",
      note: input.note ?? "",
      tags: normalizeTags(input.tags),
      imagePath: input.imagePath,
      imageExt: input.imageExt,
      createdAt: now,
      updatedAt: now
    };
    this.commit(doc);
    return doc;
  }

  updateSnippet(doc: Snippet): Snippet | null {
    if (!doc || !doc._id) return null;
    doc.updatedAt = Date.now();
    this.commit(doc);
    return doc;
  }

  removeSnippet(doc: Snippet): boolean {
    if (!doc || !doc._id) return false;
    const res = this.db.remove(doc);
    return !!(res && res.ok);
  }

  /**
   * 批量删除收藏（0.6.0）：由调用方统一确认一次，这里只负责逐条落库。
   * 返回实际删除成功的条数（部分失败不影响其余条目）。
   */
  removeSnippets(docs: Snippet[]): number {
    let n = 0;
    for (const d of docs ?? []) {
      if (d && this.removeSnippet(d)) n++;
    }
    return n;
  }

  /**
   * 复制一条收藏（0.6.0）：生成独立副本（新 _id、创建/无取用记录），
   * 图片条目复用同一图片文件（只读展示，不复制文件本身）。
   */
  copySnippet(s: Snippet): Snippet | null {
    if (!s || !s._id) return null;
    return this.createSnippet({
      kind: s.kind,
      content: s.content ?? "",
      note: s.note ?? "",
      tags: (s.tags ?? []).slice(),
      imagePath: s.imagePath,
      imageExt: s.imageExt
    });
  }

  /** 记录一次「取用」（复制到剪贴板）：使用次数 +1、最近使用时间刷新 */
  touchSnippet(s: Snippet): void {
    if (!s || !s._id) return;
    const now = Date.now();
    const doc = this.getSnippet(s._id) ?? s;
    doc.useCount = (typeof doc.useCount === "number" ? doc.useCount : 0) + 1;
    doc.lastUsedAt = now;
    this.db.put(doc);
    // 同步调用方持有的对象，避免列表里显示的还是旧值
    s.useCount = doc.useCount;
    s.lastUsedAt = now;
  }

  private commit(doc: Snippet | TagDoc): void {
    const res = this.db.put(doc);
    if (res && res.ok && res.rev) doc._rev = res.rev;
  }

  /** ---------- 标签 ---------- */

  listTags(): TagDoc[] {
    const docs = this.db.allDocs("tag/") as unknown as TagDoc[];
    return (docs ?? [])
      .filter((d) => d && d.type === "tag")
      .sort((a, b) => (b.lastUsedAt || 0) - (a.lastUsedAt || 0) || a.name.localeCompare(b.name, "zh-Hans-CN"));
  }

  /** 标记标签最近使用时间（复制/编辑时调用） */
  touchTag(name: string): void {
    const tag = this.findTagByName(name);
    if (!tag) return;
    tag.lastUsedAt = Date.now();
    tag.updatedAt = Date.now();
    this.commit(tag);
  }

  /** 批量删除标签（不逐个 confirm，由调用方统一确认） */
  removeTags(tags: TagDoc[]): number {
    let count = 0;
    for (const t of tags) { if (this.removeTag(t)) count++; }
    return count;
  }

  findTagByName(name: string): TagDoc | null {
    const n = String(name ?? "").trim();
    if (!n) return null;
    return this.listTags().find((t) => t.name === n) ?? null;
  }

  createTag(name: string): TagDoc | { error: string } {
    const n = String(name ?? "").trim();
    if (!n) return { error: "标签名不能为空" };
    const exist = this.findTagByName(n);
    if (exist) return { error: "标签已存在" };
    const now = Date.now();
    const doc: TagDoc = {
      _id: uid("tag"),
      type: "tag",
      name: n,
      lastUsedAt: 0,
      createdAt: now,
      updatedAt: now
    };
    this.commit(doc);
    return doc;
  }

  renameTag(tag: TagDoc, newName: string): { ok: boolean; error?: string } {
    const n = String(newName ?? "").trim();
    if (!n) return { ok: false, error: "标签名不能为空" };
    if (n === tag.name) return { ok: true };
    const exist = this.findTagByName(n);
    if (exist && exist._id !== tag._id) return { ok: false, error: "标签已存在" };
    const old = tag.name;
    tag.name = n;
    tag.updatedAt = Date.now();
    const res = this.db.put(tag);
    if (!(res && res.ok)) return { ok: false, error: res?.message || "保存失败" };
    if (res.rev) tag._rev = res.rev;
    // 同步更新所有引用该标签的收藏
    for (const s of this.listSnippets()) {
      if (s.tags.includes(old)) {
        s.tags = s.tags.map((t) => (t === old ? n : t));
        this.db.put(s);
      }
    }
    return { ok: true };
  }

  removeTag(tag: TagDoc): boolean {
    if (!tag || !tag._id) return false;
    const res = this.db.remove(tag);
    if (!(res && res.ok)) return false;
    // 从所有收藏中移除该标签
    for (const s of this.listSnippets()) {
      if (s.tags.includes(tag.name)) {
        s.tags = s.tags.filter((t) => t !== tag.name);
        this.db.put(s);
      }
    }
    return true;
  }

  tagUsage(name: string): number {
    return this.listSnippets().filter((s) => s.tags.includes(name)).length;
  }

  /** ---------- 设置 ---------- */

  getUxSettings(): UxSettings {
    const doc = this.db.get("setting/ux") as unknown as UxSettings | null;
    return {
      successStyle: (doc as { successStyle?: string } | null)?.successStyle === "overlay"
        ? "overlay"
        : (doc as { successStyle?: string } | null)?.successStyle === "none"
          ? "none"
          : "toast",
      successDelayMs: (doc as { successDelayMs?: number } | null)?.successDelayMs ?? 1200,
      closeOnCopy: (doc as { closeOnCopy?: boolean } | null)?.closeOnCopy === true,
      systemNotify: (doc as { systemNotify?: boolean } | null)?.systemNotify !== false,
      pinyinSearch: (doc as { pinyinSearch?: boolean } | null)?.pinyinSearch !== false,
      sortMode: normalizeSortKey((doc as { sortMode?: unknown } | null)?.sortMode),
      sortDir: normalizeSortDir((doc as { sortDir?: unknown } | null)?.sortDir),
      sortGroup: normalizeGroup((doc as { sortGroup?: unknown } | null)?.sortGroup)
    };
  }

  saveUxSettings(s: UxSettings): void {
    const exist = this.db.get("setting/ux");
    const doc = {
      _id: "setting/ux",
      type: "setting",
      ...(exist && exist._rev ? { _rev: exist._rev } : {}),
      successStyle: s.successStyle ?? "toast",
      successDelayMs: s.successDelayMs > 0 ? s.successDelayMs : 1200,
      closeOnCopy: s.closeOnCopy === true,
      systemNotify: s.systemNotify !== false,
      pinyinSearch: s.pinyinSearch !== false,
      sortMode: normalizeSortKey(s.sortMode),
      sortDir: normalizeSortDir(s.sortDir),
      sortGroup: normalizeGroup(s.sortGroup),
      updatedAt: Date.now()
    } as DbDoc & UxSettings;
    this.db.put(doc);
  }

  /**
   * 只更新排序偏好（0.6.0）：改排序是高频轻量操作，读改写整份设置，
   * 避免调用方漏传其它字段而把它们重置。
   */
  saveSortPrefs(p: { sortMode?: UxSettings["sortMode"]; sortDir?: UxSettings["sortDir"]; sortGroup?: UxSettings["sortGroup"] }): UxSettings {
    const cur = this.getUxSettings();
    const next: UxSettings = {
      ...cur,
      sortMode: p.sortMode ?? cur.sortMode,
      sortDir: p.sortDir ?? cur.sortDir,
      sortGroup: p.sortGroup ?? cur.sortGroup
    };
    this.saveUxSettings(next);
    return next;
  }
}
