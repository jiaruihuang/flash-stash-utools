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
  assert.equal(d.systemNotify, true, "默认开启 Windows 系统消息提示");
  assert.equal(d.pinyinSearch, true, "默认开启拼音搜索");
  s.saveUxSettings({ successStyle: "overlay", successDelayMs: 3000, closeOnCopy: true, systemNotify: false, pinyinSearch: false, sortMode: "updated", sortDir: "desc", sortGroup: "none" });
  const u = s.getUxSettings();
  assert.equal(u.successStyle, "overlay");
  assert.equal(u.successDelayMs, 3000);
  assert.equal(u.closeOnCopy, true, "开关应持久化");
  assert.equal(u.systemNotify, false, "系统消息提示开关应持久化");
  assert.equal(u.pinyinSearch, false, "拼音搜索开关应持久化");
});

test("拼音搜索：全拼与首字母匹配，可开关（0.5.6）", () => {
  const s = new Store(new MemoryDb());
  s.createSnippet({ kind: "text", content: "vue3 响应式原理", note: "学习笔记", tags: ["前端"] });
  s.createSnippet({ kind: "text", content: "周报模板", note: "", tags: ["工作"] });
  const all = s.listSnippets();
  const tags = s.listTags();

  // 全拼：qianduan → 标签「前端」（混合大小写也支持）
  const byFull = searchSnippets(all, tags, "qianDuan", { pinyin: true });
  assert.ok(byFull.length >= 1 && byFull.some((h) => h.snippet.tags.includes("前端")), "全拼应命中中文标签");
  assert.ok(byFull.some((h) => h.matchedOn.includes("tag")), "拼音命中标签应记录 matchedOn=tag");

  // 首字母：qd → 前端
  const byInitial = searchSnippets(all, tags, "qd", { pinyin: true });
  assert.ok(byInitial.some((h) => h.snippet.tags.includes("前端")), "首字母应命中中文标签");

  // 内容里的中文也支持：xiangyingshi → 响应式
  const byContent = searchSnippets(all, tags, "xiangyingshi", { pinyin: true });
  assert.ok(byContent.some((h) => h.snippet.content.includes("响应式")), "内容拼音应命中");

  // 关闭拼音匹配后，纯字母查询不再命中中文
  assert.equal(searchSnippets(all, tags, "qd", { pinyin: false }).length, 0, "关闭拼音后字母查询不应命中中文");

  // 默认（不传 opts）拼音开启
  assert.ok(
    searchSnippets(all, tags, "gongzuo").some((h) => h.snippet.tags.includes("工作")),
    "默认应开启拼音匹配"
  );

  // 混合内容 "s3 上传脚本" 的拼音可被 "shangchuan" 命中
  s.createSnippet({ kind: "text", content: "s3 上传脚本", note: "部署用", tags: ["运维"] });
  const all2 = s.listSnippets();
  assert.ok(
    searchSnippets(all2, tags, "shangchuan", { pinyin: true }).some((h) => h.snippet.content.includes("上传脚本")),
    "混合文本（ASCII+中文）全拼应命中"
  );
});
