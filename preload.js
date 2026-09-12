// ============================================================
// 闪藏 flash-stash · preload 预加载脚本
// 遵循 uTools preload 规范：CommonJS / Node.js 16 / 不可压缩混淆
// 提供：图片文件持久化、剪贴板读取、复制能力
// ============================================================
const fs = require("fs");
const path = require("path");
const os = require("os");

let DATA_DIR = null;
let IMG_DIR = null;

function getDataDir() {
  if (DATA_DIR) return DATA_DIR;
  let base = null;
  try {
    if (typeof utools !== "undefined" && utools.getPath) {
      base = utools.getPath("userData") || utools.getPath("appData");
    }
  } catch (e) {
    /* 忽略，走兜底路径 */
  }
  if (!base) base = path.join(os.homedir(), ".uTools");
  DATA_DIR = path.join(base, "flash-stash");
  IMG_DIR = path.join(DATA_DIR, "images");
  try {
    fs.mkdirSync(IMG_DIR, { recursive: true });
  } catch (e) {
    /* 忽略 */
  }
  return DATA_DIR;
}

const EXT_MAP = {
  jpg: "jpg",
  jpeg: "jpg",
  png: "png",
  gif: "gif",
  webp: "webp",
  bmp: "bmp"
};

function normalizeExt(ext) {
  const e = String(ext || "").toLowerCase().replace(/^\./, "");
  return EXT_MAP[e] || "png";
}

/**
 * 保存图片文件
 * @param {Buffer|string} input  Buffer | base64 dataURL | 源文件路径
 * @param {string} [ext] 扩展名（当 input 为 Buffer 时使用）
 */
function saveImageFile(input, ext) {
  try {
    getDataDir();
    const id = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
    if (Buffer.isBuffer(input)) {
      const filePath = path.join(IMG_DIR, id + "." + normalizeExt(ext));
      fs.writeFileSync(filePath, input);
      return { ok: true, path: filePath };
    }
    if (typeof input === "string") {
      if (input.startsWith("data:")) {
        const m = input.match(/^data:image\/([\w+.]+);base64,(.+)$/);
        if (!m) return { ok: false, error: "不支持的图片数据格式" };
        const buf = Buffer.from(m[2], "base64");
        const filePath = path.join(IMG_DIR, id + "." + normalizeExt(m[1]));
        fs.writeFileSync(filePath, buf);
        return { ok: true, path: filePath };
      }
      if (fs.existsSync(input)) {
        const srcExt = path.extname(input).toLowerCase().replace(/^\./, "");
        const filePath = path.join(IMG_DIR, id + "." + normalizeExt(srcExt));
        fs.copyFileSync(input, filePath);
        return { ok: true, path: filePath };
      }
      return { ok: false, error: "源图片不存在" };
    }
    return { ok: false, error: "无法识别的图片输入" };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

function readImageAsDataUrl(filePath) {
  try {
    const buf = fs.readFileSync(filePath);
    const ext = path.extname(filePath).replace(/^\./, "").toLowerCase();
    const mime = {
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      gif: "image/gif",
      webp: "image/webp",
      bmp: "image/bmp"
    }[ext] || "image/png";
    return { ok: true, dataUrl: "data:" + mime + ";base64," + buf.toString("base64") };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

function deleteFile(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
    return true;
  } catch (e) {
    return false;
  }
}

function copyImageByPath(filePath) {
  try {
    return { ok: !!utools.copyImage(filePath) };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

function copyText(text) {
  try {
    return { ok: !!utools.copyText(String(text)) };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/** 读取剪贴板：文本 + 图片（PNG dataURL） */
function readClipboard() {
  const { clipboard, nativeImage } = require("electron");
  let text = null;
  let imageDataUrl = null;
  try {
    text = clipboard.readText() || null;
  } catch (e) {
    /* 忽略 */
  }
  try {
    const img = clipboard.readImage();
    if (!img.isEmpty()) {
      const buf = img.toPNG();
      imageDataUrl = "data:image/png;base64," + buf.toString("base64");
    }
  } catch (e) {
    /* 忽略 */
  }
  return { text, imageDataUrl };
}

window.flashStash = {
  getDataDir,
  saveImageFile,
  readImageAsDataUrl,
  deleteFile,
  copyImageByPath,
  copyText,
  readClipboard
};
