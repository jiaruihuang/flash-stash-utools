# 闪藏 (flash-stash) — 交接文档 / HANDOFF

> 用途：给下一个新会话（无此对话上下文的模型）快速接手本插件开发。
> 本文件承载**本项目实例的全部情报**：背景、进展、架构、核心要素、项目硬规则、陷阱档案目录、跨模块决策。
> 通用契约与知识地图骨架在 `AGENTS.md`；方法论在 `@WORKMETHOD.md`（两者为可复制到其他项目的模板核心）。
> 待办 `@docs/TODO.md`；更新日志 `@docs/CHANGELOG.md`（热）/ `@docs/CHANGELOG-DETAIL.md`（冷）。
> 更新于：0.6.8（2026-09-20，当日完成文档体系四层化改造并把 AGENTS/WORKMETHOD 抽为通用模板）。开发者环境为 Linux；用户测试环境为 Windows + uTools 6.1.0。

## 0. 项目背景与核心要素
**uTools 插件「闪藏」**：快速收藏文本 / Markdown / 图片，加标签与备注，全文搜索，一键复制。
- 技术栈：TypeScript + Vite；运行环境 **uTools 6.1.0 ≈ Electron 22 / Node 16**。
- **交互基调（不可违背）**：快、不反直觉——Esc 语义细则见 traps/esc-views.md §1。
- 用户是最终验收者：用户在 Windows + uTools 真机实测通过，才算交付。

## 1. 项目硬规则（编码领域；做事方法论纪律见 @WORKMETHOD.md §二/§三）
1. **Esc 走 `@src/escape.ts` 统一栈**，禁止散装 keydown —— traps/esc-views.md
2. **Node 16 约束**：正则禁用 lookbehind；`preload.js` 必须 CommonJS —— traps/env.md §1
3. **浮层定位**：顶层 fixed / 内联 absolute 挂定位上下文 —— traps/env.md §3
4. **富文本禁止 DOM 手术**，一律 `editor.commands` / 键盘驱动（测试同）—— traps/editor.md §3
5. **版本唯一权威源是 plugin.json**，package.json 必须同步（pack 校验中止）—— traps/env.md §4
6. **验证门禁**：`npm test` 全绿 → `npm run pack` → 用户真机验证；不许跳过或带失败用例交付
7. **测试纪律**：写或改任何测试前必读 **traps/testing.md**（双向验证 / 条件同量级 / 假绿灯五形态）
8. **版本提交**：每次任务收尾完成文档维护后，**立即 `git commit` 并推送 origin**——代码增量与文档体系变化**分开提交**；不允许积累多个版本不提交（0.5.5~0.6.8 曾全局未提交，教训）

## 2. 当前状态
- 版本 **0.6.8**；`npm test` 133/133 绿（含构建）；发布物 `release/flash-stash-0.6.8/` + `flash-stash-0.6.8.zip`。
- **当前没有未完成待办**（见 docs/TODO.md）。
- 0.6.8 交付：下拉键盘滚动最终收敛（capture scroll 误重建 → 忽略自滚）——五层真因与排查全史见 traps/tag-suggest.md §6 与 docs/CHANGELOG-DETAIL.md 0.6.8。
- 各版本功能变更**详见 docs/CHANGELOG.md**（按主题归集）；逐版明细见 docs/CHANGELOG-DETAIL.md。

## 3. 开工顺序
pnpm install（依赖可能被环境重置，见 traps/env.md §7）→ `npm test`（确认全绿）→ 读本次任务涉及模块的 traps 档案 → 看 docs/TODO.md → 改码 → 测试 → pack → 更新文档 → 用户真机验证。
命令清单见 `docs/traps/env.md` §7（含 pnpm store 路径、playwright 安装）。**用例数只写在本文件**：当前 **133**。

## 4. 架构与关键文件
```
plugin.json          # 权威版本源；5 个 feature（main / save.text / save.md / save.img / save.clipboard）
preload.js           # CommonJS + Node 16；暴露 window.flashStash（剪贴板/图片/文件 API）
index.html           # 壳；dist 由 Vite 构建，main 指向 dist/index.html
src/main.ts          # 入口：路由（onPluginEnter）→ showMain / showSave；initGlobalEscape()
src/escape.ts        # 集中式 Escape 处理器栈（pushEsc/resetEsc/initGlobalEscape）——traps/esc-views.md
src/ui.ts            # h() 轻量 DOM / toast / confirmDialog / openModal（Escape 走 escape.ts）
src/db.ts            # Store：封装 utools.db（收藏/标签/设置 CRUD，touchTag 更新 lastUsedAt）
src/types.ts         # Snippet / TagDoc / UxSettings / DbLike 接口
src/search.ts        # searchSnippets + filterSnippets（kind 精确 + tags 多选任一；拼音见 traps/main-panel.md §6）
src/render.ts        # renderMarkdown（marked+DOMPurify+lowlight）/ htmlToMarkdown（turndown+gfm；自研 table 规则）——traps/editor.md
src/editor.ts        # Markdown 富文本编辑器封装（Tiptap 3）——traps/editor.md
src/code-block-ui.ts # 代码块悬停「复制」浮层（容器委托）
src/table-picker.ts  # 表格行列矩阵选择器（8×8，fixed 浮层）
src/markdown.ts      # detectKind（已停止调用，仅测试保留）——traps/main-panel.md §4
src/utils.ts         # escapeHtml / highlightText / snippetExcerpt / formatTime
src/sort.ts          # 排序/分组纯函数（sortSnippets / groupSnippets / SORT_OPTIONS）——traps/main-panel.md §1
src/item-view.ts     # KIND_ICON / KIND_LABEL / thumbnailEl
src/pinyin.ts        # 拼音匹配值缓存索引 + matchPinyin / matchTextOrPinyin——traps/main-panel.md §6
src/views/main-view.ts  # 主面板：搜索/筛选/排序条/卡片/批量/标签管理/设置/预览——traps/main-panel.md
src/views/save-view.ts  # 收藏与编辑视图：三模式、标签区、备注、判脏与离开去向——traps/esc-views.md + tag-suggest.md
src/style.css        # 设计系统（body{overflow:hidden}；浮层定位见 traps/env.md §3）
src/utools.d.ts      # utools API 类型声明（含 hideMainWindow 可选参数修正）
tests/               # store / search / markdown / editor / ui-smoke / ui-browser——纪律见 traps/testing.md
memory-db.ts (tests) # 内存实现；ui-browser.test.ts 为 playwright 真实浏览器用例
scripts/pack.mjs     # 校验 plugin.json 资源与版本一致 → 组装 release/flash-stash-<版本>/ + 参考 zip
scripts/make-logo.py # 纯 Python（无 PIL）降采样生成 logo.png；scripts/logo-master-256.png 母版勿删
```

## 5. 陷阱档案目录（本文件是"情报入口"）
| 档案 | 何时读 |
|---|---|
| `docs/traps/tag-suggest.md` | 改标签区 token field / 建议下拉 / 键盘导航 / 删标签（含下拉五层真因全史） |
| `docs/traps/editor.md` | 改 Tiptap 编辑器 / 回车语义 / 代码块 / 表格 / 链接 / 渲染 |
| `docs/traps/esc-views.md` | 改 Esc 行为 / 保存视图判脏 / 离开去向 / 弹窗（含 Esc 语义表） |
| `docs/traps/main-panel.md` | 改主面板搜索 / 排序 / 批量 / 卡片 / 拼音 / 数据层 |
| `docs/traps/testing.md` | 写或改任何测试（假绿灯五形态 / 双向验证） |
| `docs/traps/env.md` | 运行时版本 / 正则 / 浮层定位 / 构建 / 用户侧加载（含命令清单） |

方法论与维护节奏：`WORKMETHOD.md`；通用分工表（骨架）：`AGENTS.md` §3。

## 6. 跨模块产品决策（各决策的完整依据在指到的档案，勿推翻，除非用户明确要求）
1. **剪贴板保存一律「文本」**，不自动判 Markdown；保存视图明示当前标记、可切换——traps/main-panel.md §4
2. **成功提示默认 toast**（轻量气泡，不打扰工作流）——traps/main-panel.md §5
3. **标签建议键盘导航不循环**（clamp 到顶/底停）——traps/tag-suggest.md
4. **拼音匹配方案**（pinyin-pro 值缓存、纯 ASCII 才走拼音分支、超集补充匹配）——traps/main-panel.md §6
5. **Agent 文档体系**：AGENTS+WORKMETHOD 已抽为**通用模板核心**（零项目内容，可直接复制到其他项目），本项目实例 = HANDOFF(全部情报+项目硬规则) + docs/{TODO,traps,CHANGELOG*}；分工表骨架在 AGENTS §3。**下次体系维护触发于 0.7.3**（WORKMETHOD §四.5）

## 7. 交付物位置
- 可交付目录：`release/flash-stash-0.6.8/`（plugin.json + preload.js + logo.png + dist/）
- 参考 zip：`flash-stash-0.6.8.zip`（外部 zip 不能直接装，仅传输用；正式安装走开发者工具打包 .upxs）
- 文档：README.md（用法）、docs/CHANGELOG.md（归集日志）、docs/CHANGELOG-DETAIL.md（明细归档）、UTools-插件开发要求速查.md（uTools 官方规范要点，涉及 uTools API/打包/plugin.json 时读）
- Agent 文档（不进 release 目录）：AGENTS.md、WORKMETHOD.md（通用模板核心）、HANDOFF.md（本文）、docs/{TODO,traps,CHANGELOG*}、CLAUDE.md、.agents/agent.md
