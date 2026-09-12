import { test } from "node:test";
import assert from "node:assert/strict";
import { detectKind, looksLikeMarkdown } from "../src/markdown.ts";

test("纯文本不判为 Markdown", () => {
  assert.equal(detectKind("今天天气不错"), "text");
  assert.equal(detectKind("这是一行普通文字，包含逗号，和句号。"), "text");
  assert.equal(detectKind("12345"), "text");
});

test("多行纯段落不再默认判为 Markdown（修订1）", () => {
  assert.equal(detectKind("多行\n内容"), "text");
  assert.equal(detectKind("这是第一行普通文字\n这是第二行普通文字\n第三行"), "text");
  assert.equal(looksLikeMarkdown("普通的\n段落\n文字"), false);
});

test("普通文本中的横线/特殊符号不误判为 Markdown", () => {
  // 中间出现的 --- 不是分隔线
  assert.equal(detectKind("苹果---橙子"), "text");
  assert.equal(detectKind("a *** b"), "text");
  assert.equal(detectKind("路径：C:\\Users\\"), "text");
  assert.equal(detectKind("价格：100-200 元"), "text");
  // 独立一行的 --- 才是分隔线
  assert.equal(detectKind("上文\n---\n下文"), "markdown");
  assert.equal(detectKind("\n---\n"), "markdown");
});

test("标题/列表/引用/代码块/粗体/链接判为 Markdown", () => {
  assert.equal(detectKind("# 一级标题"), "markdown");
  assert.equal(detectKind("- 列表项"), "markdown");
  assert.equal(detectKind("1. 有序列表"), "markdown");
  assert.equal(detectKind("> 引用内容"), "markdown");
  assert.equal(detectKind("```js\nconst a = 1;\n```"), "markdown");
  assert.equal(detectKind("这是**加粗**文字"), "text");
  assert.equal(detectKind("访问[官网](https://u.tools)"), "text");
  // 多行且带 Markdown 特征 → 仍判 markdown
  assert.equal(detectKind("第一段\n> 引用行"), "markdown");
  assert.equal(detectKind("普通行\n```\ncode\n```"), "markdown");
});

test("部分 Markdown 特征不误报", () => {
  // 数字与."1. 2. 3." 列表格式判定
  assert.equal(looksLikeMarkdown("1. 项目说明"), true);
  // 普通数字后跟点的写法（版本号）
  assert.equal(looksLikeMarkdown("版本 1.0.2 发布说明"), false);
});
