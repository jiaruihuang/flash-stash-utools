// 可选：真实无头浏览器（Chromium）冒烟测试
// 需要先执行：pnpm exec playwright install chromium（下载浏览器后运行）
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { chromium, type Browser, type Page } from "playwright";

const require = createRequire(import.meta.url);
// vite 8 起 package.json exports 不再暴露 ./bin/vite.js，从包根路径手工拼（原 require.resolve 已失效）
const VITE_BIN = require.resolve("vite/package.json").replace(/package\.json$/, "bin/vite.js");
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
test("真实浏览器 0.6.8：键盘 ↓ 越过可视区时列表不得被自身 scroll 事件重建（回归：回顶/丢高亮）", async () => {
  assert.ok(page);
  // 造 40 个标签（真实浏览器中滚动 = 真实异步 scroll 事件，无需任何注入）
  await page.evaluate(() => {
    const now = Date.now();
    for (let i = 0; i < 40; i++) {
      window.utools.db.put({ _id: "tag/scrollb-" + i, type: "tag", name: "滚测项" + String(i).padStart(2, "0"), createdAt: now, updatedAt: now });
    }
  });
  await enter("flashstash.save.text", "over", "真实滚动回归");
  await wait();
  const input = page.locator(".tag-input");
  await input.click();
  await wait(120);
  await input.press("Enter"); // 展开全量列表
  await wait(150);

  const read = () => page.evaluate(() => {
    const s = document.querySelector(".tag-suggest") as HTMLElement;
    const opts = [...s.querySelectorAll(".opt")] as HTMLElement[];
    const rowH = opts.length > 1 ? opts[1].offsetTop - opts[0].offsetTop : 32;
    return {
      scrollTop: s.scrollTop,
      active: opts.findIndex((o) => o.classList.contains("active")),
      rowH,
      clientH: s.clientHeight,
      n: opts.length
    };
  });

  const first = await read();
  assert.ok(first.n >= 30, "候选应足够多以触发滚动：n=" + first.n);
  const visibleRows = Math.floor(first.clientH / first.rowH);
  let sawScroll = false;

  // ↓ 一路打到最后一条（可量化：40 项、可视 ~10 行，必然触发滚动）。
  // 注意：高亮从 -1 出发，第 1 次 ↓ = 第 0 项，故需按 n 次。
  for (let i = 0; i < first.n; i++) {
    await input.press("ArrowDown");
    await wait(60); // scroll 事件在浏览器里异步派发，必须留事件循环的余量
    const st = await read();
    assert.ok(st.active >= 0,
      `第 ${i + 1} 次 ↓ 后不得丢失高亮（active=${st.active}, scrollTop=${st.scrollTop}）`);
    assert.equal(st.active, i,
      `第 ${i + 1} 次 ↓ 后高亮必须连续推进（实际 active=${st.active}，scrollTop=${st.scrollTop}）`);
    assert.ok(st.scrollTop <= st.active * st.rowH,
      `高亮不能滚出可视区顶端（active=${st.active}, scrollTop=${st.scrollTop}）`);
    assert.ok(st.active * st.rowH + st.rowH <= Math.ceil(st.scrollTop + (visibleRows + 1) * st.rowH),
      `高亮必须紧随滚动可视区（active=${st.active}, scrollTop=${st.scrollTop}）`);
    if (st.scrollTop > 0) sawScroll = true;
  }
  const last = await read();
  assert.equal(last.active, last.n - 1, "↓ 到底应停在第 40 项（clamp，不循环）");
  assert.ok(sawScroll, "按 ↓ 越过可视区后列表必须滚动跟随（否则本用例空转）");

  // ↑ 一路回顶：途中高亮也不得丢失/被重建
  for (let i = last.n - 2; i >= 0; i--) {
    await input.press("ArrowUp");
    await wait(60);
    const st = await read();
    assert.equal(st.active, i, `← ${last.n - 1 - i} 次 ↑ 后高亮应为第 ${i} 项（实际 ${st.active}）`);
  }
  const top = await read();
  assert.equal(top.scrollTop, 0, "回到顶部时 scrollTop 应归零");
});
