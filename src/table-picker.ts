// 表格行列矩阵选择器（0.5.2）：悬停/点击矩阵格选择行列数后插入表格
import { h } from "./ui.ts";
import { pushEsc } from "./escape.ts";

const MAX_ROWS = 8;
const MAX_COLS = 8;

export function openTablePicker(anchor: HTMLElement, onPick: (rows: number, cols: number) => void): void {
  let hoverR = 1;
  let hoverC = 1;

  const label = h("div", { class: "tp-label", text: "1 × 1" });
  const grid = h("div", { class: "tp-grid" });
  const cells: HTMLElement[][] = [];
  for (let r = 0; r < MAX_ROWS; r++) {
    for (let c = 0; c < MAX_COLS; c++) {
      const cell = h("div", { class: "tp-cell" });
      cell.addEventListener("mouseenter", () => { hoverR = r + 1; hoverC = c + 1; paint(); });
      cell.addEventListener("click", () => { cleanup(); onPick(hoverR, hoverC); });
      if (!cells[r]) cells[r] = [];
      cells[r][c] = cell;
      grid.append(cell);
    }
  }
  function paint(): void {
    label.textContent = hoverR + " × " + hoverC;
    for (let r = 0; r < MAX_ROWS; r++) {
      for (let c = 0; c < MAX_COLS; c++) {
        cells[r][c].classList.toggle("on", r < hoverR && c < hoverC);
      }
    }
  }
  paint();

  const panel = h("div", { class: "tp-panel" }, label, grid,
    h("div", { class: "tp-hint", text: "点击确定行列（含表头行）" }));
  // body 是 overflow:hidden，浮层统一用 fixed 定位
  panel.style.position = "fixed";
  panel.style.visibility = "hidden";
  document.body.append(panel);

  const arect = anchor.getBoundingClientRect();
  const prect = panel.getBoundingClientRect();
  const vw = window.innerWidth || document.documentElement.clientWidth;
  const vh = window.innerHeight || document.documentElement.clientHeight;
  const left = Math.max(8, Math.min(arect.left, vw - prect.width - 8));
  const below = arect.bottom + 6;
  const top = below + prect.height > vh - 8 ? Math.max(8, arect.top - prect.height - 6) : below;
  panel.style.left = left + "px";
  panel.style.top = top + "px";
  panel.style.visibility = "visible";

  const off = pushEsc(() => { cleanup(); return true; });
  const onDown = (e: MouseEvent): void => {
    const t = e.target as Node | null;
    if (t && (panel.contains(t) || anchor.contains(t))) return;
    cleanup();
  };
  // 延后注册，避免触发本次点击立刻关闭
  const timer = setTimeout(() => document.addEventListener("mousedown", onDown), 0);

  let closed = false;
  function cleanup(): void {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    off();
    document.removeEventListener("mousedown", onDown);
    panel.remove();
  }
}
