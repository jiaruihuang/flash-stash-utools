import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/db.ts";
import { MemoryDb } from "./memory-db.ts";

function setup() {
  return new Store(new MemoryDb());
}

test("创建/读取/更新/删除收藏", () => {
  const s = setup();
  const doc = s.createSnippet({ kind: "text", content: "hello 世界", note: "备注", tags: ["a", "b"] });
  assert.ok(doc._id.startsWith("snippet/"));
  assert.equal(doc._rev, "1");

  const got = s.getSnippet(doc._id)!;
  assert.equal(got.content, "hello 世界");
  assert.deepEqual(got.tags, ["a", "b"]);

  doc.content = "更新后的内容";
  s.updateSnippet(doc);
  assert.equal(s.getSnippet(doc._id)!.content, "更新后的内容");
  assert.equal(s.getSnippet(doc._id)!._rev, "2");

  assert.equal(s.listSnippets().length, 1);
  assert.ok(s.removeSnippet(doc));
  assert.equal(s.listSnippets().length, 0);
});

test("标签去重与空值过滤", () => {
  const s = setup();
  s.createSnippet({ kind: "text", content: "x", note: "", tags: ["", "  ", "唯一", "唯一", "标签"] });
  const got = s.listSnippets()[0];
  assert.deepEqual(got.tags, ["唯一", "标签"]);
});

test("标签的创建/重名/重命名（联动收藏）/删除（联动收藏）", () => {
  const s = setup();
  const t1 = s.createTag("工作");
  assert.ok(!("error" in t1));
  const dup = s.createTag("工作");
  assert.ok("error" in dup && dup.error === "标签已存在");

  const snip = s.createSnippet({ kind: "text", content: "c", note: "", tags: ["工作"] });
  const t2 = s.findTagByName("工作")!;
  const rr = s.renameTag(t2, "重要");
  assert.equal(rr.ok, true);
  assert.deepEqual(s.getSnippet(snip._id)!.tags, ["重要"]);

  const tn = s.findTagByName("重要")!;
  assert.ok(s.removeTag(tn));
  assert.deepEqual(s.getSnippet(snip._id)!.tags, []);
  assert.equal(s.listTags().length, 0);
});

test("tagUsage 统计", () => {
  const s = setup();
  s.createTag("x");
  s.createSnippet({ kind: "text", content: "1", note: "", tags: ["x"] });
  s.createSnippet({ kind: "text", content: "2", note: "", tags: ["x", "y"] });
  assert.equal(s.tagUsage("x"), 2);
  assert.equal(s.tagUsage("y"), 1);
  assert.equal(s.tagUsage("不存在"), 0);
});