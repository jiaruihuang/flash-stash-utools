// ============================================================
// 闪藏 打包脚本 v2
// 重要说明：uTools 6+ 的离线安装包（.upxs）内部是加密容器（非 zip），
// 只能由官方「uTools 开发者工具」的「打包」功能生成。
// 本脚本负责：
//   1. 校验 plugin.json 与资源完整性
//   2. 产出可交付的插件目录 release/flash-stash-<版本>/
//      （包含 plugin.json、preload.js、logo.png、dist/，供「接入开发」或开发者工具打包）
//   3. 同时产出参考 zip（flash-stash-<版本>.zip，方便传输；不能直接安装）
// ============================================================
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync, statSync, mkdirSync, rmSync, cpSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const errors = [];
function fail(msg) {
  errors.push(msg);
  console.error("✗ " + msg);
}

// ---------- 1. 校验 plugin.json ----------
const pluginPath = path.join(root, "plugin.json");
if (!existsSync(pluginPath)) fail("缺少 plugin.json");
const plugin = JSON.parse(readFileSync(pluginPath, "utf8"));

for (const field of ["pluginName", "main", "logo", "features"]) {
  if (!plugin[field]) fail("plugin.json 缺少必填字段：" + field);
}
if (plugin.features.length < 1) fail("features 至少需要一个功能");
for (const f of plugin.features) {
  if (!f.code) fail("feature 缺少 code（explain: " + (f?.explain ?? "") + "）");
  if (!f.cmds || f.cmds.length < 1) fail("feature " + f.code + " 缺少 cmds");
}
if (typeof plugin.main !== "string" || !plugin.main.endsWith(".html")) fail("main 必须指向 .html 文件");

function checkRel(p) {
  if (!existsSync(path.join(root, p))) fail("资源不存在：" + p);
}
checkRel(plugin.logo);
checkRel(plugin.main);
if (plugin.preload) checkRel(plugin.preload);
if (!existsSync(path.join(root, "dist", "index.html"))) {
  fail("dist/index.html 不存在，请先执行 npm run build");
}

// ---------- 版本一致性校验（plugin.json 为唯一权威源） ----------
const pkgPath = path.join(root, "package.json");
if (existsSync(pkgPath)) {
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  if (pkg.version !== plugin.version) {
    fail("版本不一致：plugin.json = " + plugin.version + "，package.json = " + pkg.version + "。请先同步两处版本（唯一权威源为 plugin.json）。");
  }
}

if (errors.length > 0) {
  console.error("\n打包中止：存在 " + errors.length + " 个问题");
  process.exit(1);
}

// ---------- 2. 组装 release 目录 ----------
const version = plugin.version || "0.0.1";
const dirName = "flash-stash-" + version;
const releaseDir = path.join(root, "release", dirName);
rmSync(releaseDir, { recursive: true, force: true });
mkdirSync(releaseDir, { recursive: true });

const copyPlan = [
  ["plugin.json", "plugin.json"],
  ["preload.js", "preload.js"],
  [plugin.logo, plugin.logo],
  ["dist", "dist"]
];
for (const [src, dst] of copyPlan) {
  const s = path.join(root, src);
  const d = path.join(releaseDir, dst);
  if (statSync(s).isDirectory()) cpSync(s, d, { recursive: true });
  else cpSync(s, d);
}
console.log("✔ 插件目录已生成：release/" + dirName + "/");
console.log("   （包含 plugin.json / preload.js / logo.png / dist/）");

// ---------- 3. 参考 zip ----------
const outPath = path.join(root, "flash-stash-" + version + ".zip");
const pyCode = [
  "import zipfile, os, sys",
  "src = sys.argv[1]",
  "out = sys.argv[2]",
  "with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:",
  "    for base, dirs, files in os.walk(src):",
  "        for f in files:",
  "            full = os.path.join(base, f)",
  "            rel = os.path.relpath(full, src)",
  "            z.write(full, rel)",
  "print('ZIP:', out, os.path.getsize(out), 'bytes')",
].join("\n");
const py = spawnSync("python3", ["-c", pyCode, releaseDir, outPath], { encoding: "utf-8" });
if (py.status !== 0) {
  console.error(py.stderr || "python3 zipfile 执行失败");
  process.exit(1);
}
console.log(py.stdout.trim());

// ---------- 4. 清理旧版本发布物（只保留当前版本：release/ 下旧目录 + 根目录旧 zip） ----------
try {
  const releaseRoot = path.join(root, "release");
  if (existsSync(releaseRoot)) {
    for (const entry of readdirSync(releaseRoot)) {
      const full = path.join(releaseRoot, entry);
      const isOldDir = entry.startsWith("flash-stash-") && entry !== dirName && statSync(full).isDirectory();
      if (isOldDir) {
        rmSync(full, { recursive: true, force: true });
        console.log("🗑 已删除旧发布目录：release/" + entry + "/");
      }
    }
  }
  for (const entry of readdirSync(root)) {
    const full = path.join(root, entry);
    const isOldZip = /^flash-stash-\d+\.\d+\.\d+\.zip$/.test(entry)
      && entry !== "flash-stash-" + version + ".zip"
      && statSync(full).isFile();
    if (isOldZip) {
      rmSync(full, { force: true });
      console.log("🗑 已删除旧 zip：" + entry);
    }
  }
} catch (e) {
  console.error("⚠ 清理旧发布物失败（不影响本次打包）：" + (e?.message ?? e));
}

console.log("");
console.log("⚠️ 重要：uTools 6+ 的离线安装包（.upxs）为加密容器，外部 zip 无法安装。");
console.log("   请按以下官方流程使用插件：");
console.log("   1) 将 uTools 升级到最新版（https://www.u-tools.cn/download/）");
console.log("   2) 在 uTools 插件市场安装「uTools 开发者工具」");
console.log("   3) 用开发者工具「接入开发」加载 release/" + dirName + "/plugin.json 直接运行");
console.log("   4) 要打包离线 .upxs，用开发者工具的「打包」功能（由官方工具生成加密安装包）");
