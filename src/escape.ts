// 集中式 Escape 处理：LIFO 处理器栈，最上层（最近注册的“层”）优先响应
// 每个层（弹窗 / 确认框 / 标签建议 / 视图）在打开时注册自己的处理器，
// 关闭时注销。Escape 按下时由栈顶处理器决定是否消费：
//   return true  → 已消费：stopPropagation，uTools 不会退出插件
//   return false → 未消费：事件继续传播，uTools 正常退出

type EscHandler = () => boolean;

const stack: EscHandler[] = [];

/** 注册一个 Escape 处理器，返回注销函数（幂等） */
export function pushEsc(h: EscHandler): () => void {
  stack.push(h);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    const i = stack.indexOf(h);
    if (i >= 0) stack.splice(i, 1);
  };
}

/** 视图整体切换时清空全部处理器（showMain / showSave 进入新视图前调用） */
export function resetEsc(): void {
  stack.length = 0;
}

/** main.ts 初始化时调用一次：全局唯一的 Escape 拦截点（capture 阶段，先于 uTools 窗口级退出） */
export function initGlobalEscape(): void {
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (stack.length > 0 && stack[stack.length - 1]()) {
      // 已消费：阻止冒泡到 uTools（uTools 监听 window 层的 Escape）
      e.stopPropagation();
    }
  }, true);
}
