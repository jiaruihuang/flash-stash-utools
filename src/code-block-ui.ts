// 代码块悬停「复制」浮层（0.5.1）：编辑区 .rich 与预览区 .preview/.pv 通用
// 用容器内委托监听，浮层按钮叠加在 pre 右上角；不侵入 ProseMirror 内容 DOM。
import { h, toast } from "./ui.ts";

export interface CodeCopyLayer {
  /** 无条件隐藏浮层 */
  hide(): void;
  /** 若当前悬停的代码块已被删除/移出，隐藏浮层（可随编辑器更新频繁调用） */
  refresh(): void;
}

export function attachCodeCopyLayer(container: HTMLElement): CodeCopyLayer {
  if (container.querySelector(".code-copy-layer")) {
    return { hide: () => { /* 已挂载 */ }, refresh: () => { /* 已挂载 */ } };
  }
  const layer = h("button", {
    class: "code-copy-layer",
    text: "复制",
    title: "复制代码",
    type: "button"
  }) as HTMLButtonElement;
  layer.style.display = "none";
  container.append(layer);

  let currentPre: HTMLElement | null = null;
  let hideTimer: ReturnType<typeof setTimeout> | null = null;

  function doCopy(pre: HTMLElement): void {
    const text = pre.querySelector("code")?.textContent ?? "";
    if (!text) return;
    const r = window.flashStash?.copyText?.(text);
    if (r && r.ok) toast("代码已复制");
    else if (r) toast(r.error ?? "复制失败", "err");
    else {
      void navigator.clipboard?.writeText(text).then(
        () => toast("代码已复制"),
        () => toast("复制失败", "err")
      );
    }
  }

  layer.addEventListener("click", () => {
    if (currentPre) doCopy(currentPre);
  });

  const cancelHide = (): void => {
    if (hideTimer !== null) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
  };
  const hide = (): void => {
    cancelHide();
    layer.style.display = "none";
    currentPre = null;
  };
  /**
   * 延迟收起（鼠标桥）：浮层是代码块的兄弟节点，指针从代码块移到按钮上时会先触发
   * 代码块的 mouseout——若立刻收起，按钮会在指针到达前消失（用户反馈"点不中、有点飘"）。
   * 因此这里留一小段缓冲，指针落到按钮上或回到代码块都会取消收起。
   */
  const scheduleHide = (): void => {
    cancelHide();
    hideTimer = setTimeout(() => { hideTimer = null; hide(); }, 160);
  };
  const isInsideHover = (node: Node | null): boolean =>
    !!node && (node === layer || layer.contains(node) || !!currentPre?.contains(node));

  container.addEventListener("mouseover", (e) => {
    const pre = (e.target as HTMLElement)?.closest?.("pre") as HTMLElement | null;
    if (!pre) return;
    cancelHide();
    currentPre = pre;
    const crect = container.getBoundingClientRect();
    const prect = pre.getBoundingClientRect();
    // 浮层钉在 pre 右上角（按钮宽约 52px，留 6px 边距）
    layer.style.left = Math.max(0, prect.right - crect.left - 58) + "px";
    layer.style.top = Math.max(0, prect.top - crect.top + 6) + "px";
    layer.style.display = "block";
  });
  container.addEventListener("mouseout", (e) => {
    if (!currentPre) return;
    const to = (e as MouseEvent).relatedTarget as Node | null;
    if (isInsideHover(to)) cancelHide();
    else scheduleHide();
  });
  // 指针停在按钮上时绝不收起
  layer.addEventListener("mouseenter", cancelHide);
  layer.addEventListener("mouseleave", () => { scheduleHide(); });
  container.addEventListener("mouseleave", scheduleHide);
  // 滚动时位置会失效：立即收起
  container.addEventListener("scroll", hide, true);

  return {
    hide,
    // 代码块被删除/替换后 pre 会脱离文档，靠这个在编辑器每次更新时及时收起浮层
    refresh: () => {
      if (currentPre && !container.contains(currentPre)) hide();
    }
  };
}