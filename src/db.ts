import type { DbLike, DbDoc, Snippet, TagDoc, SnippetKind, UxSettings } from "./types.ts";
import { uid } from "./utils.ts";

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
      closeOnCopy: (doc as { closeOnCopy?: boolean } | null)?.closeOnCopy === true
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
      updatedAt: Date.now()
    } as DbDoc & UxSettings;
    this.db.put(doc);
  }
}
