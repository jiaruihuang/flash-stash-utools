# ✦ 闪藏 flash-stash · uTools 插件

> 瞬间收纳 · 随取随用 —— 快速收藏文本、图片与 Markdown 片段，标签化管理，全文搜索，一键复制。

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE) · 更新日志见 [CHANGELOG.md](CHANGELOG.md)

---

## 简介

「闪藏」是一款 [uTools](https://www.u-tools.cn/) 插件，用于**快速收藏、管理、复用知识片段**：

- 在任意应用中选中文字、图片或 Markdown 片段，呼出 uTools 一键收藏；
- 为每条收藏打标签、加备注，之后随时全文搜索、点击即复制回剪贴板；
- 收藏前可编辑，Markdown 片段支持所见即所得的富文本编辑。

## 功能特性

- **一键收藏**：选中文字 / 图片呼出 uTools 即可收藏；也支持一键保存剪贴板内容
- **收藏前可编辑**：文本可修改；Markdown 片段支持**富文本编辑**（加粗 / 斜体 / 下划线 / 删除线、H1–H3、有序·无序列表、引用、代码块、行内代码、链接、**表格（矩阵拖选行列 + 增删行列）**、撤销 / 重做），另有**源码**与**实时预览**两种模式；回车 = 新段落，Shift+Enter = 段内软换行
- **代码块体验**：编辑与预览均带**语法高亮**与**语言角标**，支持工具栏指定语言（未指定时自动识别），悬停右上角**一键复制**
- **标签与备注**：每条收藏可打多个标签（标签可新建 / 重命名 / 删除并自动联动收藏），可加备注
- **全文搜索**：搜索内容、标题、备注与标签；多关键词空格分隔（AND 语义），标签命中权重最高
- **一键复制**：点击结果卡片即复制——文本复制纯文本，Markdown 复制源码，图片复制原图
- **预览**：悬停卡片可预览完整内容（Markdown 渲染为富文本、图片显示大图），弹窗内可直接复制
- **键盘操作**：主面板内置搜索框，↑/↓ 选择、回车复制、Esc 清空；标签建议列表同样支持
- **设置项**：收藏成功提示三种风格（轻量气泡 / 完整浮层 / 不提示）；「复制后立即关闭窗口」开关
- **类型筛选**：全部 / 文本 / Markdown / 图片，支持按标签多选筛选（任一命中）
- **深浅色自适应**：跟随 uTools 主题

## 安装

> ⚠️ **uTools 6+ 注意**：官方离线安装包 `.upxs` 是加密容器，**普通 zip 无法直接安装**
> （会提示「插件应用无法安装 / prefix value error」）。请走以下官方流程：

### 方式一：开发模式（推荐体验，支持热更新）

1. 安装最新版 [uTools](https://www.u-tools.cn/download/) 与「**uTools 开发者工具**」（插件市场内搜索安装）
2. 打开 uTools 开发者工具 → 选择工程 → 选中本目录的 `plugin.json` → 「接入开发」→ 打开

### 方式二：打包离线包（分发 / 正式安装）

1. 用「uTools 开发者工具」的「打包」功能生成官方 `.upxs`（`npm run pack` 仅产出 `release/` 目录与参考 zip，**不能直接安装**）
2. 拿到 `.upxs` 后：长按右键呼出超级面板选择「安装插件应用」，或复制文件粘贴到 uTools 搜索框安装

## 使用

| 触发指令 | 说明 |
| --- | --- |
| `闪藏` / `flash-stash` | 打开主面板（搜索、浏览、标签管理） |
| 选中文字 → `闪藏：收藏文本` | 收藏单行文本 |
| 选中多行 / Markdown → `闪藏：收藏 Markdown` | 收藏 Markdown 片段 |
| 选中图片 → `闪藏：收藏图片` | 收藏图片 |
| `闪藏：保存剪贴板` | 收藏剪贴板中的文本或图片 |

💡 建议在 uTools 快捷键设置中为「闪藏：保存剪贴板」绑定一个全局快捷键，随取随存。

## 从源码构建

**环境要求**：Node.js ^20.19.0 或 >= 22.12.0（Vite 8 要求）、包管理器 npm / pnpm。

```bash
npm install        # 安装依赖（本项目用 pnpm 管理时：pnpm install）
npm run dev        # 启动 Vite 开发服务器（热更新，端口 5173）
npm run typecheck  # TypeScript 类型检查
npm test           # 构建 + 运行全部测试（单测 + jsdom UI 冒烟测试）
npm run pack       # 构建 + 组装 release/ 插件目录与参考 zip（校验版本一致）
```

可选：`npm run test:browser` 运行真实 Chromium 无头浏览器测试（需先安装
`pnpm exec playwright install chromium`）。

**版本约定**：`plugin.json` 的 `version` 是唯一权威版本源，`package.json` 必须同步
（`npm run pack` 会校验，不一致直接报错）。

## 项目结构

```
flash-stash/
├── plugin.json      # uTools 插件配置（入口 / 触发指令）
├── preload.js       # Node.js 能力层（剪贴板 / 图片持久化，CommonJS 明文）
├── logo.png         # 插件 Logo
├── index.html       # Vite 入口
├── src/             # 源码（入口 / 数据层 / 搜索 / 渲染 / 编辑器 / 视图）
├── tests/           # 单元测试 + UI 冒烟测试（jsdom + utools mock）
├── scripts/         # make-logo.py（Logo 生成）、pack.mjs（打包）
├── dist/            # 构建产物（仅本地，不入库）
└── release/         # 打包产物（仅本地，不入库）
```

## 技术栈

- **前端**：TypeScript + Vite，零 UI 框架；Markdown 富文本由 **Tiptap 3 / ProseMirror** 驱动
- **渲染**：marked（Markdown → HTML）、DOMPurify（安全净化）、lowlight / highlight.js（代码高亮）、Turndown + GFM（富文本 → Markdown）
- **存储**：uTools 内置数据库 `utools.db`（可云同步）；图片存于本地 `userData/flash-stash/images/`

## 常见问题

**数据存在哪里？**
收藏的文本 / Markdown / 标签 / 备注存于 uTools 内置数据库（开启云同步可多设备同步）；
图片文件存于 `userData/flash-stash/images/`。

**为什么 preload.js 不压缩？**
uTools 规范要求 preload 源码明文可读（安全审核），本插件保持 CommonJS 明文。

**双击卡片复制的是什么？**
文本复制纯文本；Markdown 复制源码（可粘贴进 Markdown 编辑器）；图片复制原图。
只想先看看内容？悬停卡片点「预览」，弹窗里再决定是否复制。

## License

[MIT](LICENSE) © 2026 doubleXiao