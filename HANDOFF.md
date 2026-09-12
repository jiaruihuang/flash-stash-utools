# 闪藏 (flash-stash) — 交接文档 / HANDOFF

> 用途：给下一个新会话（无此对话上下文的模型）快速接手本插件开发。
> 更新于：0.5.5（2026-09-11）。开发者环境为 Linux；用户测试环境为 Windows + uTools 6.1.0。

---

## 0. 一句话目标
**uTools 插件「闪藏」：快速收藏文本 / Markdown / 图片，加标签与备注，全文搜索，一键复制。**
设计基调：交互要快、不反直觉——尤其 **Esc 永远只退出当前子页面/弹层，绝不误退插件、绝不误弹提示**。

## 1. 当前状态
- 版本 **0.5.5**，**用户 Windows 实测通过**（0.5.0 换引擎 → 0.5.1~0.5.5 五轮实测修复，用户已确认原 P0 富文本编辑器体验问题解决）；发布物 `release/flash-stash-0.5.5/` + `flash-stash-0.5.5.zip`
- `npm test` 98/98 绿（含构建）
- **当前没有未完成待办**（见 §6）
- 各项功能与版本变更**详见 CHANGELOG.md**；本文只列待办（§6）与接手须知（§3~§5、§7）

## 2. 文档维护原则（必读）
- 本文档**只记录【待办/未完成】与【接手所需的环境·规范·决策】**；
- **已完成的功能 / 版本变更 / 实测结论一律不写进本文**，统一记录在 CHANGELOG.md 的版本条目里（原「已完成的功能」「版本历史速览」两节已按此原则移除）；
- 每次任务收尾：代码/产物变更照常进 CHANGELOG.md；本文只更新待办与接手须知，并在 §8/§9 同步（当前版本号、交付物位置）。

## 3. Escape 交互规范（0.4.8 定稿，0.4.9 增补来源区分，测试锁定）
| 场景 | 按 Esc |
|---|---|
| 标签建议列表弹出 | 关闭列表回输入框 |
| 弹窗（设置/标签管理/更多标签/确认框） | 关闭当前弹窗；再按 Esc 作用于下一层 |
| 标签管理·重命名输入中 | 只取消重命名，弹窗不动 |
| 保存视图·有未保存修改（内容/类型/标签/备注/标签框已输入文字任一改动） | 弹「未保存的修改」确认框；确认框内再按 Esc = 取消确认留在原地；连按/连点有防抖不会叠弹窗 |
| 保存视图·无修改（编辑，或主面板「＋新增」进入） | 回主面板 |
| 保存视图·无修改（uTools 指令：收藏文本/Markdown/图片/剪贴板 进入的新建） | 退出插件（与「取消」按钮一致） |
| 保存视图·已保存成功 | 直接离开（主面板来源→回主面板；uTools 来源→退出插件），绝不误弹 |
| 主面板·有搜索词 | 清空搜索词 |
| 主面板·无操作 | 退出插件（uTools 原行为） |

> 离开去向由 `SaveInit.from`（"main" / "utools"）决定，编辑模式恒为回主面板。
> 「取消」按钮与 Esc 走同一套 `tryLeave()` 判定（0.4.9 起「取消」有改动时同样弹确认）。
> 局限：uTools 侧主动收起插件（点外部/按全局热键触发 onPluginOut）无法拦截，未保存提示只覆盖插件内 Esc 与「取消」。

## 4. 架构与关键文件
```
plugin.json          # 权威版本源；5 个 feature（main / save.text / save.md / save.img / save.clipboard）
preload.js           # CommonJS + Node 16；暴露 window.flashStash（剪贴板/图片/文件 API）
index.html           # 壳；dist 由 Vite 构建，main 指向 dist/index.html
src/main.ts          # 入口：路由（onPluginEnter）→ showMain / showSave；initGlobalEscape()
src/escape.ts        # 【核心】集中式 Escape 处理器栈（pushEsc/resetEsc/initGlobalEscape）；新层打开时注册、关闭时注销，栈顶消费即 stopPropagation
src/ui.ts            # h() 轻量 DOM / toast / confirmDialog / openModal（后两者 Escape 走 escape.ts）
src/db.ts            # Store：封装 utools.db（收藏/标签/设置 CRUD，touchTag 更新 lastUsedAt）
src/types.ts         # Snippet / TagDoc / UxSettings / DbLike 接口
src/search.ts        # searchSnippets + filterSnippets（kind 精确 + tags 多选任一）
src/render.ts        # renderMarkdown（marked+DOMPurify+lowlight 代码高亮）/ htmlToMarkdown（turndown+gfm；自研 table 规则 + 空白短路规避）
src/editor.ts        # Markdown 富文本编辑器封装（0.5.0：Tiptap 3 + StarterKit + 表格 + CodeBlockLowlight + 回车语义扩展）
                     #   创建 createMdEditor(el,{md,onUpdate})；工具栏命令经 editor.chain() 执行
src/code-block-ui.ts # 代码块悬停「复制」浮层（容器委托；编辑/预览通用，支持随更新收起）
src/table-picker.ts  # 表格行列矩阵选择器（8×8，fixed 浮层）
src/markdown.ts      # detectKind：自动判定 Markdown（**已停止在 main 中调用**，仅单元测试保留）
src/utils.ts         # escapeHtml / highlightText / snippetExcerpt / formatTime
src/views/main-view.ts  # 主面板：搜索/筛选/卡片/复制/编辑/删除/标签管理弹窗/设置弹窗/更多标签多选
src/views/save-view.ts  # 收藏与编辑视图：编辑器三模式、标签输入+建议下拉、备注、保存、未保存判定与离开去向（SaveInit.from："utools"|"main"；tryLeave 统一 Esc/取消）
src/style.css        # 设计系统（注意 body{overflow:hidden}，下拉必须 position:fixed）
src/utools.d.ts      # utools API 类型声明（含 hideMainWindow(可选参数) 修正）
tests/               # store / search / markdown / ui-smoke（jsdom + 手写 utools mock，48 例）
                     # memory-db.ts 内存实现；ui-browser.test.ts 为 playwright 备用（未纳入 npm test）
scripts/pack.mjs     # 校验 plugin.json 资源与版本一致 → 组装 release/flash-stash-<版本>/ + 参考 zip
scripts/make-logo.py # 纯 Python（无 PIL）对母版降采样生成 logo.png（128x128）
scripts/logo-master-256.png # logo 256 母版，勿删
AGENTS.md            # Agent 指南（agents.md 开放标准）：OpenCode 直接读取 / DSH、Claude Code 经入口读取，**唯一内容出处**；含必读引用表、命令、坑、工作流
CLAUDE.md            # Claude Code 薄引用入口（只指回 AGENTS.md，不承载内容）
.agents/agent.md     # DSH 薄引用入口（只指回根 AGENTS.md，不承载内容）
```

## 5. 开发命令与环境（重要陷阱）
```bash
pnpm install --store-dir /home/huangjiarui/flash-stash/.pnpm-store   # 依赖装了 pnpm store（node_modules 可能被环境重置，先跑这个）
npm run typecheck   # tsc --noEmit
npm test            # 先构建再跑全部测试（48 例，jsdom 冒烟）
npm run pack        # 构建+组装 release 目录+zip（校验 plugin.json 与 package.json 版本一致）
npm run logo        # 重新生成 logo.png（从母版降采样）
```
### 必须牢记的坑
1. **uTools 6.1.0 ≈ Electron 22 / Node 16**：正则**禁用 lookbehind `(?<!…)`**（会崩）；preload.js 必须 CommonJS
2. **编写含正则的文件**：shell heredoc / 模板字面量会把转义弄坏（`\\n` 变成字面量）。可靠方式：`tools.write` 用字符串数组拼接，或 Node 脚本 `fs.writeFileSync`。改 markdown.ts 风格的正则时务必用测试验证
3. **body { overflow: hidden }** 会裁剪 `position:absolute` —— 下拉/浮层一律 `position:fixed`（.tag-suggest 已用 fixed + 动态上下翻转）
4. **Esc 必须经 src/escape.ts 统一处理**（capture 阶段 stopPropagation 拦 uTools 窗口级退出）；不要在局部再散装 document keydown 监听（会与栈冲突或泄漏到其他视图）
5. **jsdom 测试**：弹窗/确认框挂在 `document.body`（不在 #app）；跨测试要 `closeAllLayers()` 清残留弹层；键盘事件断言用 `dispatchEvent(KeyboardEvent)`（bubbles:true）
6. **版本一致**：plugin.json 为权威版本源，package.json 必须同步，pack 会校验
7. 用户侧加载：Windows uTools 开发者工具「接入开发」指向 `release/flash-stash-<ver>/plugin.json`；每次改动跑 `npm run pack` 交付（当前 0.5.5）
8. **jsdom 富文本测试（0.5.0）**：Tiptap/ProseMirror 需要 `requestAnimationFrame` / `getComputedStyle` / `Range.prototype.getClientRects` 等测量 API 兜底（ui-smoke 与 editor.test 均已内置 polyfill）；富文本结构为 `.rich` 包裹层 + `.rich .ProseMirror`（contenteditable 子层），不再是 `.rich` 本体；编辑器实例经 `.rich` 上的 `_mdEditor` 测试接缝获取，用例一律**命令/键盘级驱动（editor.commands / keydown 派发），禁止直接改 DOM**（ProseMirror 有独立状态，DOM 手术不同步）

## 6. 未完成 / 待办
- **当前没有未完成待办。** 原 P0「Markdown 富文本编辑器体验」（用户曾抱怨"整个编辑器都有问题"）已于 0.5.0~0.5.5 完成并由用户 Windows 实测确认关闭：换用 Tiptap 3 引擎 → 语法高亮/语言角标/复制按钮 → 回车与块级语义 → 表格与代码块往返 → 若干实测细节，全过程见 CHANGELOG
- **非待办的已知限制**（不要当 bug 反复修）：
  1. 富文本 ↔ 源码/预览 切换会重建编辑器，**撤销历史随之重置**（Markdown 源码是唯一数据源）；同一次富文本会话内撤销/重做正常
  2. uTools 侧主动收起插件（点外部/全局热键触发 onPluginOut）无法拦截，未保存提示只覆盖插件内 Esc 与「取消」

## 7. 关键决策记录（别推翻，除非用户明确要求）
1. **剪贴板保存一律「文本」**：不自动判 Markdown（误判太多，见 0.4.0~0.4.4 折腾史）；要 md 用「闪藏：收藏 Markdown」命令。detectKind 保留但 main.ts 不再调用
2. **成功提示默认 toast**（轻量气泡 + 1.4s 后退出），不打扰工作流
3. **Esc 语义**：见第 3 节表格——「退出当前子页面」优先，绝不误弹、绝不误退
4. **标签建议键盘导航不循环**（到顶/底即停，clamp 而非 wrap）
5. **离开保存视图的去向**：主面板「＋新增」进入（from:"main"）与编辑模式 → 回主面板；uTools 功能指令进入的新建（from:"utools"）→ 退出插件。成功保存后同理（0.4.9 定稿，勿再改回「新建一律退出插件」）
6. **未保存判定范围**：内容（含类型切换）/ 标签（含标签框已输入未回车的文字）/ 备注任一变化即判脏；只打开不改动不弹（基线在首次渲染后用与保存一致的规范化管线取值，见 0.4.8 CHANGELOG）
7. **成功浮层「继续收藏」用 cb.onNewAgain() 新开空收藏视图**，不要用 location.reload()（uTools webview reload 后 onPluginEnter 不再触发，会白屏）
8. **新会话接手顺序**：pnpm install → npm test（确认 68 绿）→ 读 src/escape.ts、src/editor.ts 与两个 view → 处理待办（当前无）→ npm run pack 交付
9. **Agent 文档体系（0.4.10 定稿）**：内容**单点存放**于根 `AGENTS.md`（agents.md 开放标准，含必读引用表）；`CLAUDE.md` 与 `.agents/agent.md`（DSH）只是各自工具约定的**薄引用入口**，正文只写「先读 AGENTS.md」，**禁止往薄壳里复制 AGENTS.md 的内容**。OpenCode 直接读根 AGENTS.md，无需额外目录/子代理文件。改引用表/命令/坑只改 AGENTS.md
10. **富文本编辑器引擎（0.5.0 定稿）**：基于 **Tiptap 3 + StarterKit**（+官方表格扩展），`src/editor.ts` 单一封装，工具栏命令化（`editor.chain()`），不再手写 execCommand / DOM 手术。保留三模式与 baseline 判脏管线；LegacyEnter 扩展延续「代码块空行回车退出 / 引用空段回车退出」手感；表格回写需剥离 `<colgroup>`（gfm 表格规则误判）
11. **0.5.1 交互决策**：代码块悬停复制用容器内委托浮层（`src/code-block-ui.ts`，不侵入 ProseMirror 内容 DOM）；语法高亮编辑区 CodeBlockLowlight（lowlight）、预览 marked 渲染器（共用同套 hljs 主题）；链接统一走「文字+网址」对话框；**全局 `<a>` 点击一律 `utools.shellOpenExternal` 外部打开（禁止 webview 内导航）**，改链接行为先看这里
12. **0.5.2 语义决策**：富文本**回车 = 软换行（`<br>`）**、**Shift+Enter = 新段落**（用户明确要求源码里不要平白出现空行）；列表内/引用内回车仍交还引擎；代码块退出用引擎标准方式（末行 ↓ / 三连回车），**不再用「空行回车退出」兜底**；表格转 Markdown 用自研 table 规则（`src/render.ts`），别再改回 gfm 自带表格规则（空白单元格会被 turndown 的 blankRule 打断）
13. **0.5.3 修正（覆盖第 12 条的回车部分）**：**回车 = 新段落、Shift+Enter = 段内软换行**（回到 Typora/Vditor/Milkdown 一致的行业标准）。0.5.2 的软换行虽让源码"好看"，却把多行并成同一段落，导致 H1/列表/引用等块级格式只能作用于整段（用户实测踩到）。配套机制：`prepareBlockSelection()`（`src/editor.ts`）在块级命令前**按选区边界切块**，让格式只作用于选中文字；行内代码 mark 用 `inclusive:false`（`InlineCode`），代码末尾继续输入不再继承样式 —— **改回车/块级行为前先读这条**
14. **协作原则（用户明确要求）**：用户反馈是「意图」不是精确规格——按专业工程师视角还原真实问题，必要时纠正字面要求并在交付说明里讲清理由与代价；详见 @AGENTS.md「协作原则」一节（长期有效）
15. **0.5.4 定稿（回车/块级行为的最终形态，别再改回去）**：
    - **回车 = 新段落、Shift+Enter = 段内软换行**（0.5.3 起回到行业标准）。多行=多块，H1/列表/引用才能按行生效；Markdown 段落本就以空行分隔，用户若不喜欢空行应改用 Shift+Enter
    - **代码块命令是智能合并**（`toggleCodeBlockSmart`）：选多块 → 合成一个代码块；单块内 → 常规切换
    - **列表命令先按行拆块**（`splitLinesForList`）：软换行的多行 → 每行一项
    - **TrailingNode 已启用**（`trailingNode: { node: "paragraph" }`）：文末非段落时补空段落，避免表格/代码块结尾处出现 gap cursor（横线光标）；`htmlToMarkdown` 会去掉文末空白，故不影响判脏与源码
    - **测试注意**：文末可能有 TrailingNode 补的空段落，定位光标别用 `focus("end")`，用「包含指定文字的文本块末尾」显式定位（见 tests 里的 `caretAtEndOfBlock`）

## 8. 版本与变更记录
全部版本历史与功能变更见 **CHANGELOG.md**（当前 0.5.5）。按 §2 维护原则，本文不再重复记录已完成内容。

## 9. 交付物位置
- 可交付目录：`release/flash-stash-0.5.5/`（plugin.json + preload.js + logo.png + dist/）
- 参考 zip：`flash-stash-0.5.5.zip`（外部 zip 不能直接装，仅传输用；正式安装走开发者工具打包 .upxs）
- 文档：README.md（用法）、CHANGELOG.md（历史）、发布文案.md（市场发布用的插件介绍 / 版本说明 / 发布前检查清单）、UTools-插件开发要求速查.md（官方规范要点）
- Agent 文档（不进 release 目录，仅仓库内供 agent 读取）：AGENTS.md（**唯一内容出处**）、CLAUDE.md（CLAUDE薄引用）、.agents/agent.md（DSH 薄引用）
