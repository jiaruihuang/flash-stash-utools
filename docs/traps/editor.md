# 陷阱档案：Markdown 编辑器（Tiptap 3）

> 来源：本项目编辑器相关决策定稿（原 HANDOFF 条目于 2026-09-20 体系改造迁入）。改 `src/editor.ts`、`src/render.ts`、`src/table-picker.ts`、`src/code-block-ui.ts` 前必读。

## 1. 引擎（0.5.0 定稿）
基于 **Tiptap 3 + StarterKit**（+官方表格扩展 + CodeBlockLowlight），`src/editor.ts` 单一封装，工具栏命令化（`editor.chain()`）。**不再手写 execCommand / DOM 手术**。

## 2. 回车语义（0.5.2 错 → 0.5.3 修正 → 0.5.4 定稿，别再改回去）
**决策演进**：
- 0.5.2 曾按用户字面要求把回车改成**软换行 `<br>`**（用户说"源码里不要平白出现空行"）；
- 结果多行文本并成同一段落，块级格式（H1/列表/引用）只能作用于整段，问题更大（0.5.3 用户实测踩到）；
- 0.5.3 起回到行业标准。

**定稿（0.5.4）**：
- **回车 = 新段落、Shift+Enter = 段内软换行**（Typora/Vditor/Milkdown 一致）。多行=多块，H1/列表/引用才能按行生效；Markdown 段落本就以空行分隔，用户若不喜欢空行应改用 Shift+Enter。
- **代码块命令是智能合并**（`toggleCodeBlockSmart`）：选多块 → 合成一个代码块；单块内 → 常规切换。
- **列表命令先按行拆块**（`splitLinesForList`）：软换行的多行 → 每行一项。
- **TrailingNode 已启用**（`trailingNode: { node: "paragraph" }`）：文末非段落时补空段落，避免表格/代码块结尾处出现 gap cursor（横线光标）；`htmlToMarkdown` 会去掉文末空白，故不影响判脏与源码。
- LegacyEnter 扩展延续「代码块空行回车退出 / 引用空段回车退出」手感；代码块标准退出方式：末行 ↓ / 三连回车。
- 配套机制：`prepareBlockSelection()`（`src/editor.ts`）在块级命令前**按选区边界切块**，让格式只作用于选中文字；行内代码 mark 用 `inclusive:false`（`InlineCode`），代码末尾继续输入不再继承样式。

## 3. ProseMirror 禁 DOM 手术（硬性）
**真因**：`.rich` 内由 ProseMirror 独立维护状态，直接改 DOM 会与编辑器状态不同步。
**禁令**：编辑一律走 `editor.commands` / 键盘事件，**禁止直接改 `.rich` 的 DOM**；测试用例也必须命令级驱动（见 traps/testing.md）。

## 4. 测试接缝（jsdom）
- 富文本结构为 `.rich` 包裹层 + `.rich .ProseMirror`（contenteditable 子层），不再是 `.rich` 本体。
- 编辑器实例经 `.rich` 上的 `_mdEditor` 测试接缝获取。
- Tiptap/ProseMirror 需要 `requestAnimationFrame` / `getComputedStyle` / `Range.prototype.getClientRects` 等测量 API 兜底（ui-smoke 与 editor.test 均已内置 polyfill）。
- **定位光标别用 `focus("end")`**——文末可能有 TrailingNode 补的空段落；用「包含指定文字的文本块末尾」显式定位（见 tests 里的 `caretAtEndOfBlock`）。

## 5. 代码块体系（0.5.0~0.5.5）
- 语法高亮（hljs）+ 语言角标（自动识别）、语言选择器写入围栏、选多行合并为一个代码块、末行 ↓ 退出。
- 悬停「复制」浮层：容器内委托（`src/code-block-ui.ts`），**不侵入 ProseMirror 内容 DOM**（0.5.1 决策），支持随更新收起。
- 表格回写需**剥离 `<colgroup>`**（gfm 表格规则误判）。

## 6. 表格体系（0.5.1 / 0.5.2）
- 行列增删、**8×8 矩阵选择器**（`src/table-picker.ts`，fixed 浮层）。
- 富文本↔源码往返用**自研 table 规则**（`src/render.ts`），**别再改回 gfm 自带表格规则**——空白单元格会被 turndown 的 blankRule 打断。

## 7. 链接（0.5.1）
- 链接统一走「文字+网址」对话框；**全局 `<a>` 点击一律 `utools.shellOpenExternal` 外部打开（禁止 webview 内导航）**，改链接行为先看这条。

## 8. 渲染层（`src/render.ts`）
- `renderMarkdown`：marked + DOMPurify + lowlight 代码高亮；编辑区与预览共用同套 hljs 主题。
- `htmlToMarkdown`：turndown + gfm；自研 table 规则 + 空白短路规避。

## 9. 已知限制（不要当 bug 反复修）
- 富文本 ↔ 源码/预览 切换会重建编辑器，**撤销历史随之重置**（Markdown 源码是唯一数据源）；同一次富文本会话内撤销/重做正常。
