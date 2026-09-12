import type { DbLike, DbDoc, DbResult } from "../src/types.ts";

/** 模拟 utools.db 语义的内存实现（put 更新需带 _rev） */
export class MemoryDb implements DbLike {
  private docs = new Map<string, DbDoc>();

  put(doc: DbDoc): DbResult {
    if (!doc || typeof doc._id !== "string" || !doc._id) {
      return { error: true, message: "缺少 _id" };
    }
    const prev = this.docs.get(doc._id);
    if (prev && prev._rev && doc._rev !== prev._rev) {
      return { error: true, message: "文档已被修改，_rev 冲突" };
    }
    const rev = String((parseInt(String(prev?._rev ?? "0"), 10) || 0) + 1);
    this.docs.set(doc._id, { ...doc, _rev: rev });
    return { ok: true, id: doc._id, rev };
  }

  get(id: string): DbDoc | null {
    return this.docs.get(id) ?? null;
  }

  remove(doc: DbDoc): DbResult | null {
    if (!doc || !this.docs.has(doc._id)) return { error: true, message: "文档不存在" };
    this.docs.delete(doc._id);
    return { ok: true, id: doc._id };
  }

  allDocs(idStartsWith?: string): DbDoc[] {
    return [...this.docs.values()].filter((d) => !idStartsWith || d._id.startsWith(idStartsWith));
  }
}
