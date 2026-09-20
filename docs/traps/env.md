# 陷阱档案：环境与运行时

> 来源：本项目环境与构建陷阱（原 HANDOFF 条目于 2026-09-20 体系改造迁入）。涉及运行时版本、构建、打包、用户侧加载前必读。

## 1. uTools 6.1.0 ≈ Electron 22 / Node 16
- **现象**：用到 lookbehind `(?<!…)` 的正则会让插件直接崩（不是报错，是白屏/无响应）。
- **真因**：Node 16 的 V8 不支持该语法。
- **禁令**：禁用 lookbehind；`preload.js` 必须 CommonJS（写 ESM `import` 会加载失败）。
- 替代写法：用捕获组 + 手工偏移，或改写为不含 lookbehind 的等价正则。

## 2. 编写含正则/反斜杠的文件
- **现象**：用 shell heredoc 或模板字面量写含 `\n` 的代码，落盘后转义被吃掉，正则语义悄悄变了（不报错，行为错）。
- **真因**：多层转义（shell → 模板 → 字符串）叠加。
- **禁令**：不要用 heredoc 写含反斜杠的源码；用 write 工具的字符串数组拼接，或 Node 脚本 `fs.writeFileSync`。改 `render.ts` / `markdown.ts` 风格的正则后**必须跑测试验证**。

## 3. 浮层定位（`body { overflow: hidden }`）
- **现象**：用 `position:absolute` 的浮层被裁剪看不见。
- **真因**：根容器 `overflow:hidden` 会裁剪 absolute 子元素。
- **规则**：顶层浮层（弹窗/确认框）用 `position:fixed`；**子级内联浮层**（如 `.tag-suggest`）用 `position:absolute`，但**必须挂在自己的定位上下文元素内**，偏移量只能按该元素的 rect 计算。
- ⚠️ 用错元素就会整体偏移（0.6.3 曾踩：误用别的祖先的 rect）。

## 4. 版本一致
- `plugin.json` 为**权威版本源**，`package.json` 必须同步，`npm run pack` 会校验并**中止**（不是警告）。

## 5. 用户侧加载
- Windows uTools 开发者工具「接入开发」指向 `release/flash-stash-<ver>/plugin.json`。
- ⚠️ **改了 `plugin.json` 必须让用户重新「接入开发」**，否则指令/菜单不会更新（0.6.1 就遇到过：指令级修复必须重载才生效）。

## 6. 开发者/用户环境差异
- 开发者环境为 Linux；用户测试环境为 Windows + uTools 6.1.0。**用户在真机实测通过，才算交付。**

## 7. 命令清单
```bash
pnpm install --store-dir /home/huangjiarui/flash-stash/.pnpm-store   # 依赖装了 pnpm store（node_modules 可能被环境重置，先跑这个）
npm run typecheck   # tsc --noEmit
npm test            # 先构建再跑全部测试（例数见 HANDOFF.md，jsdom 冒烟；不含浏览器用例）
npm run pack        # 构建+组装 release 目录+zip（校验 plugin.json 与 package.json 版本一致）
npm run logo        # 重新生成 logo.png（从母版降采样）
npm run dev         # 仅本地 vite 预览（不注入 uTools boot，不能当插件跑）
npm run test:browser  # 可选真实浏览器用例（需 PLAYWRIGHT_BROWSERS_PATH=$PWD/.pw-browsers，见 traps/testing.md §5）
```
- 可选浏览器安装：`PLAYWRIGHT_BROWSERS_PATH=$PWD/.pw-browsers PLAYWRIGHT_DOWNLOAD_HOST=https://registry.npmmirror.com/-/binary/playwright npx playwright install chromium`
- 交付节奏：改完 `npm test` 全绿 → `npm run pack` → 用户真机验证。
