// 可选：真实无头浏览器（Chromium）冒烟测试
// 需要先执行：pnpm exec playwright install chromium（下载浏览器后运行）
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { chromium, type Browser, type Page } from "playwright";

const require = createRequire(import.meta.url);
const VITE_BIN = require.resolve("vite/bin/vite.js");
const PORT = 4173;
const BASE = "http://127.0.0.1:" + PORT;

let server: ReturnType<typeof spawn> | null = null;
let browser: Browser | null = null;
let page: Page | null = null;

const mockSrc = [
  "(function () {",
  '  var dbDocs = new Map();',
  '  var db = {',
  '    put: function (doc) {',
  '      var prev = dbDocs.get(doc._id);',
  '      if (prev && prev._rev && doc._rev !== prev._rev) return { error: true, message: "rev conflict" };',
  '      var rev = String((parseInt(String(prev ? prev._rev : "0"), 10) || 0) + 1);',
  '      dbDocs.set(doc._id, Object.assign({}, doc, { _rev: rev }));',
  '      return { ok: true, id: doc._id, rev: rev };',
  '    },',
  '    get: function (id) { return dbDocs.get(id) || null; },',
  '    remove: function (doc) { return dbDocs.delete(doc._id) ? { ok: true, id: doc._id } : { error: true }; },',
  '    allDocs: function (prefix) {',
  '      var out = [];',
  '      dbDocs.forEach(function (d) { if (!prefix || d._id.indexOf(prefix) === 0) out.push(d); });',
  '      return out;',
  '    }',
  '  };',
  '  var events = { subInput: [], heights: [], notifications: [], outCount: 0 };',
  '  window.__mockEvents = events;',
  '  window.flashStash = {',
  '    getDataDir: function () { return "/tmp/flash-stash"; },',
  '    saveImageFile: function () { return { ok: true, path: "/tmp/flash-stash/img.png" }; },',
  '    readImageAsDataUrl: function () { return { ok: true, dataUrl: "data:image/png;base64,iVBORw0KGgo=" }; },',
  '    deleteFile: function () { return true; },',
  '    copyImageByPath: function () { return { ok: true }; },',
  '    copyText: function (t) { events.notifications.push("copied:" + t); return { ok: true }; },',
  '    readClipboard: function () { return { text: "剪贴板内容", imageDataUrl: null }; }',
  '  };',
  '  window.utools = {',
  '    db: db,',
  '    onPluginEnter: function (cb) { window.__enter = cb; },',
  '    onPluginOut: function () {},',
  '    onThemeChange: function () {},',
  '    isDarkColors: function () { return false; },',
  '    copyText: function () { return true; },',
  '    copyImage: function () { return true; },',
  '    getPath: function () { return "/tmp/utools"; },',
  '    setExpendHeight: function (h) { events.heights.push(h); return true; },',
  '    setSubInput: function (cb, ph) { events.subInput.push(ph); window.__subInput = cb; return true; },',
  '    removeSubInput: function () {},',
  '    hideMainWindow: function () {},',
  '    outPlugin: function () { events.outCount += 1; },',
  '    showNotification: function (t) { events.notifications.push(t); },',
  '    redirectHotKeySetting: function () {},',
  '    getUser: function () { return null; }',
  '  };',
  '})();'
].join("\n");

async function enter(code: string, type: string, payload: string): Promise<void> {
  await page!.evaluate(
    ([c, t, p]) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__enter?.({ code: c, type: t, payload: p });
    },
    [code, type, payload]
  );
}

async function waitForServer(ms = 15000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < ms) {
    try {
      const res = await fetch(BASE + "/index.html");
      if (res.ok) return;
    } catch {
      /* 未就绪 */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("vite preview 未就绪");
}

before(async () => {
  server = spawn(process.execPath, [VITE_BIN, "preview", "--port", String(PORT)], {
    cwd: process.cwd(),
    stdio: "ignore"
  });
  await waitForServer();
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 760, height: 640 } });
  await page.addInitScript({ content: mockSrc });
  await page.goto(BASE + "/index.html");
});

after(async () => {
  if (page) await page.close().catch(() => undefined);
  if (browser) await browser.close().catch(() => undefined);
  if (server) server.kill();
});

const wait = (ms = 120) => new Promise((r) => setTimeout(r, ms));

test("真实浏览器：主面板渲染 + 空状态", async () => {
  assert.ok(page);
  await enter("flashstash.main", "text", "");
  await wait();
  assert.equal(await page.textContent(".mv-title"), "闪藏");
  assert.ok(await page.$(".empty"), "空状态应显示");
});

test("真实浏览器：收藏文本 → 保存 → 主面板出现卡片 → 点击复制", async () => {
  assert.ok(page);
  await enter("flashstash.save.text", "over", "浏览器测试内容 42");
  await wait();
  assert.equal(await page.locator("textarea.ta").count(), 1, "应有文本输入框");
  await page.locator(".tag-input-wrap input").fill("浏览器");
  await page.locator(".tag-input-wrap input").press("Enter");
  await page.locator("textarea.input").fill("浏览器备注");
  await page.screenshot({ path: "artifacts/save-view-text.png" });
  await page.click(".sv .btn.primary");
  await wait(250);
  const events = await page.evaluate(() => (window as any).__mockEvents as { notifications: string[] });
  assert.ok(events.notifications.some((n) => n.includes("闪藏")), "应有成功通知");

  await enter("flashstash.main", "text", "");
  await wait();
  await page.screenshot({ path: "artifacts/main-view.png" });
  const cards = page.locator(".card");
  assert.ok((await cards.count()) >= 1, "主面板应有卡片");
  const cardText = await cards.first().textContent();
  assert.ok(cardText?.includes("浏览器测试内容 42"), "卡片应显示收藏内容");
  await cards.first().click();
  await wait(150);
  const events2 = await page.evaluate(
    () => (window as any).__mockEvents as { notifications: string[]; subInput: string[] }
  );
  assert.ok(events2.notifications.some((n) => n.startsWith("copied:")), "点击卡片应触发复制");
  assert.ok(events2.subInput.length >= 1, "主面板应启用子输入框");
});

test("真实浏览器：Markdown 富文本编辑渲染", async () => {
  assert.ok(page);
await enter("flashstash.save.md", "over", "# 标题\n\n- 列表一\n- 列表二");
  await wait();
  assert.equal(await page.locator(".rich[contenteditable]").count(), 1, "应有富文本编辑区");
  const html = await page.locator(".rich").first().innerHTML();
  assert.ok(html.includes("<h1"), "应渲染出 h1 标题");
  await page.screenshot({ path: "artifacts/save-view-markdown.png" });
  await page.click(".editor-tab:has-text('预览')");
  await wait(150);
  assert.ok(await page.$(".preview h1"), "预览区应有标题");
});