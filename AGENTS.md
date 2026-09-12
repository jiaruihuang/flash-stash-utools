# 闪藏 (flash-stash) — 项目 Agent 指南

> 本文件遵循 [agents.md 开放标准](https://agents.md/)，供 **DSH**、**OpenCode** 及任何遵循该标准的编码 agent 在工作区根目录读取。
> 目标：让一个新会话（无对话上下文）也能正确、安全地接手本 uTools 插件开发。**任务开始前先读 @HANDOFF.md。**

## 一句话项目
uTools 插件「闪藏」：快速收藏文本 / Markdown / 图片，加标签与备注，全文搜索，一键复制。
- 技术栈：TypeScript + Vite；运行环境 **uTools 6.1.0 ≈ Electron 22 / Node 16**（preload.js 必须 CommonJS）。
- 交互基调：快、不反直觉——**Esc 永远只退出当前子页面/弹层，绝不误退插件、绝不误弹提示**（集中式 Escape 处理器栈，见 @src/escape.ts）。

## 必读引用（按需加载）
| 引用 | 内容 | 何时读 |
|---|---|---|
| @HANDOFF.md | **交接文档（权威）**：当前状态、Esc 规范表、架构、命令、坑、待办、决策记录 | 每个新会话、每项任务的第一件事 |
| @README.md | 用户视角用法说明 | 涉及用户文档/发布说明时 |
| @CHANGELOG.md | 版本历史（0.5.x） | 记录变更/发版时 |
| @UTools-插件开发要求速查.md | uTools 官方插件规范要点 | 涉及 uTools API/打包时 |
| @package.json / @plugin.json | 命令与版本（两处必须一致，plugin.json 权威） | 改版本前 |
| @src/escape.ts | 集中式 Escape 处理器栈（pushEsc / resetEsc / initGlobalEscape） | 改任何 Esc 行为时 |
| @src/views/save-view.ts | 收藏/编辑视图：未保存判定、离开去向（`SaveInit.from`） | 改保存/Esc/未保存提示时 |
| @src/views/main-view.ts | 主面板：搜索/筛选/卡片/标签管理/设置 | 改主界面时 |
| @src/db.ts / @src/search.ts / @src/render.ts | 数据层 / 搜索 / 渲染（lowlight 代码高亮、自研 table→GFM 规则） | 改数据或搜索逻辑时 |
| @src/editor.ts | Markdown 富文本编辑器（Tiptap 3 + StarterKit + CodeBlockLowlight + 回车语义 + 块级命令规整/代码块合并/列表逐行） | 改富文本编辑/工具栏/回车语义时 |
| @src/code-block-ui.ts | 代码块悬停「复制」浮层（编辑/预览通用） | 改代码块复制交互时 |
| @src/table-picker.ts | 表格行列矩阵选择器（8×8 浮层） | 改表格插入交互时 |
| @tests/ | store / search / markdown / editor / ui-smoke 测试（当前 98 例） | 任何代码改动后必跑 |

## 外部文件加载约定（OpenCode 规则）
- **CRITICAL**：遇到文件引用（如 `@HANDOFF.md`）时用 Read 工具**按需**加载（lazy loading）——不要一次性把所有引用读进上下文，只读当前任务需要的。
- 被加载的内容视为**强制指令**，覆盖默认偏好；引用可递归跟进。
- **@HANDOFF.md 是唯一例外：每个新会话都必须先读**（它是专为无上下文会话写的交接文档）。

## 开发命令
```bash
pnpm install --store-dir /home/huangjiarui/flash-stash/.pnpm-store   # node_modules 被重置时先跑
npm run typecheck   # tsc --noEmit
npm test            # 先构建再跑全部测试（当前 98 例）
npm run pack        # 构建 + 组装 release/flash-stash-<ver>/ + 参考 zip（校验版本一致）
npm run logo        # 重新生成 logo.png（从母版降采样）
```

## 关键陷阱（改代码前必看）
1. **Node 16（uTools 6.1.0）**：正则**禁用 lookbehind `(?<!…)`**（会崩）
2. **含正则的文件**：避免 shell heredoc / 模板字面量（`\\n` 转义会坏）；用 write 工具字符串数组或 Node 脚本写
3. **body { overflow: hidden }**：下拉/浮层一律 `position: fixed`（.tag-suggest 已是）
4. **Esc 必须走 @src/escape.ts 统一栈**，禁止散装 document keydown 监听（会与栈冲突或泄漏到其他视图）
5. **jsdom 测试**：弹窗/确认框挂在 document.body（不在 #app）；跨测试要 `closeAllLayers()` 清残留弹层；键盘断言用 `dispatchEvent(KeyboardEvent, { bubbles: true })`
6. **版本一致**：plugin.json 为权威版本源，package.json 必须同步（pack 会校验）
7. **交付**：改完跑 `npm test`（全绿）→ `npm run pack`；用户经 Windows uTools 开发者工具「接入开发」加载 `release/flash-stash-<ver>/plugin.json`
8. **富文本接线（0.5.0）**：富文本由 Tiptap 驱动，DOM 结构是 `.rich` 包裹层内 `.rich .ProseMirror`（contenteditable 子层）；编辑器实例经 `.rich` 上的 `_mdEditor` 接缝获取；编辑一律走 `editor.commands`/键盘事件，**禁止直接改 .rich 的 DOM**（ProseMirror 独立状态）；jsdom 测试需 rAF/getComputedStyle/Range 测量 API 兜底（测试文件已内置）

## 工作流约定
- 任务顺序：读 @HANDOFF.md（§5 接手顺序、§7 决策记录；§2 维护原则）→ 定位相关 src/views 与 tests → 改动 → `npm test` → `npm run pack` → **更新 @HANDOFF.md（只更新待办与接手须知，已完成项一律进 @CHANGELOG.md，见 HANDOFF §2 维护原则）**。
- 不要推翻 HANDOFF.md §7 的关键决策（除非用户明确要求）。
- 文档与注释保持中文；用户沟通语言为中文。

## 协作原则（用户明确要求，2026-09-11 起长期有效）
- **用户反馈表达的是「意图」，不是精确规格**：用户用日常语言描述现象、且自认"不专业"，实施时**不要逐字照搬**，要还原真实问题、按有经验的工程师视角给出更合理的方案；必要时**主动纠正其字面要求**，并在交付说明中讲清「为什么这样改、代价是什么」。
- **动手前先评估结构性代价**：一个看似小的改动可能破坏其它机制。典型教训（0.5.2）：用户说「切到源码时两行之间有空行」→ 字面照做把回车改成软换行（`<br>`），结果多行文本并成同一段落，块级格式（H1/列表/引用）只能作用于整段，问题更大；0.5.3 回到行业标准（回车=新段落、Shift+Enter=段内换行）并补「部分选中先切块」机制。
- **有争议时给选项而不是沉默照做**：若确实存在多种合理取舍且影响体验，先说明取舍再选一个（或问用户），不要默默实现字面要求。

## 各工具如何使用本文件
- **内容单点存放（勿复制）**：本文件是**唯一内容出处**。`CLAUDE.md`（Claude Code）与 `.agents/agent.md`（DSH）只是各自工具约定的**薄引用入口**，正文只写「先读本文件」——**禁止往它们里复制本文件的内容**；改引用表/命令/坑只改本文件。
- **OpenCode**：直接读取根目录 `AGENTS.md` 作为项目规则（优先级高于 `CLAUDE.md` 兜底），**无需额外目录或子代理文件**。
- **Claude Code**：@CLAUDE.md 是薄壳入口，指向本文件与 @HANDOFF.md。
- **DSH**：`.agents/agent.md` 是薄壳入口，指向本文件（唯一内容出处）；DSH 会话读入口后按引用表打开 @HANDOFF.md 等。