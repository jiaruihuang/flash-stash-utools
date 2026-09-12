import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/db.ts";
import { MemoryDb } from "./memory-db.ts";
import { searchSnippets, filterSnippets } from "../src/search.ts";

function make() {
  const s = new Store(new MemoryDb());
  s.createSnippet({ kind: "text", content: "vue3 响应式原理 详解", note: "学习笔记", tags: ["前端"] });
  s.createSnippet({ kind: "markdown", content: "# 周报\n- 完成闪藏插件", note: "周一", tags: ["工作"] });
  s.createSnippet({ kind: "text", content: "s3 上传脚本", note: "部署用", tags: ["运维"] });
  return s;
}

test("按内容 / 备注 / 标签 / 标题搜索", () => {
  const s = make();
  const all = s.listSnippets();
  const tags = s.listTags();

  assert.equal(searchSnippets(all, tags, "响应式").length, 1);
  assert.equal(searchSnippets(all, tags, "学习笔记").length, 1);
  assert.equal(searchSnippets(all, tags, "前端").length, 1);
  assert.equal(searchSnippets(all, tags, "周报").length, 1);
});

test("多关键词 AND 语义", () => {
  const s = make();
  const all = s.listSnippets();
  const tags = s.listTags();
  const hits = searchSnippets(all, tags, "闪藏 周报");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].snippet.content.includes("周报"), true);
  assert.equal(searchSnippets(all, tags, "闪藏 s3").length, 0);
});

test("标签匹配权重高于内容匹配", () => {
  const s = make();
  s.createSnippet({ kind: "text", content: "前端 这个关键词在正文里", note: "", tags: [] });
  const all = s.listSnippets();
  const tags = s.listTags();
  const hits = searchSnippets(all, tags, "前端");
  // 标签精确命中 6 分 > 内容命中 1 分
  assert.equal(hits[0].snippet.tags.includes("前端"), true);
  assert.ok(hits[0].matchedOn.includes("tag"));
});

test("过滤：类型与标签", () => {
  const s = make();
  const all = s.listSnippets();
  const tags = s.listTags();
  const hits = searchSnippets(all, tags, "");
  assert.equal(filterSnippets(hits, { kind: "markdown" }).length, 1);
  assert.equal(filterSnippets(hits, { tags: ["运维"] }).length, 1);
  assert.equal(filterSnippets(hits, { tags: ["不存在"] }).length, 0);
  // 多选标签：任一命中（OR 语义）
  assert.equal(filterSnippets(hits, { tags: ["前端", "运维"] }).length, 2);
  assert.equal(filterSnippets(hits, { tags: ["前端", "不存在"] }).length, 1);
});

test("设置读写：默认轻量提示，可切换", () => {
  const s = new Store(new MemoryDb());
  const d = s.getUxSettings();
  assert.equal(d.successStyle, "toast", "默认为轻量提示");
  assert.ok(d.successDelayMs > 0);
  assert.equal(d.closeOnCopy, false, "默认关闭「复制后立即关闭窗口」");
  s.saveUxSettings({ successStyle: "overlay", successDelayMs: 3000, closeOnCopy: true });
  const u = s.getUxSettings();
  assert.equal(u.successStyle, "overlay");
  assert.equal(u.successDelayMs, 3000);
  assert.equal(u.closeOnCopy, true, "开关应持久化");
});
