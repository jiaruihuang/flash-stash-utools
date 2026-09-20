// 收藏条目的展示取值（0.6.0 从 main-view 抽出，供主面板与后续视图复用）
import type { Snippet } from "./types.ts";

export const KIND_ICON: Record<Snippet["kind"], string> = { text: "文", markdown: "M↓", image: "图" };
export const KIND_LABEL: Record<Snippet["kind"], string> = { text: "文本", markdown: "Markdown", image: "图片" };

/** 图片条目的小缩略图（读不到时留空容器，不抛错） */
export function thumbnailEl(s: Snippet): HTMLElement {
  const thumb = document.createElement("div");
  thumb.className = "card-thumb";
  try {
    if (s.imagePath && window.flashStash) {
      const r = window.flashStash.readImageAsDataUrl(s.imagePath);
      if (r && r.ok && r.dataUrl) {
        const img = document.createElement("img");
        img.src = r.dataUrl;
        img.alt = "收藏图片";
        thumb.append(img);
      }
    }
  } catch { /* 忽略 */ }
  return thumb;
}
