# uTools 插件开发要求速查（基于官方文档 u.tools/docs/developer）

> 来源：官方开发者文档（VitePress 站点，2025 抓取）。
> 权威入口：https://u.tools/docs/developer/basic/getting-started.html（welcome 页会自动跳转到这里）

## 一、环境要求（开工前准备）
- **uTools 本体**：https://u.tools 下载
- **uTools 开发者工具**：官网下载（新建/调试/打包/发布全靠它）
- 代码编辑器：推荐 VSCode 或 WebStorm
- 技术栈要求：熟悉 JavaScript；熟悉 HTML/CSS；了解 Node.js；进阶可上 Vue / React / Svelte + Vite

## 二、插件本质
- uTools 插件 = **Node.js 本地原生能力 + Web 前端网页**（本地软件能做的，理论上都能做）
- 界面用 HTML/CSS/JS 绘制；本地能力（文件、网络、系统）通过 preload 的 Node.js API 获得

## 三、最小目录结构
\`\`\`
/{plugin}
|-- plugin.json   # 必填，入口配置
|-- preload.js    # 可选，预加载脚本（Node.js 能力）
|-- index.html    # main 指向的界面
|-- index.js
|-- index.css
|-- logo.png      # 必填
\`\`\`

## 四、plugin.json 核心要求
必填字段（缺一不可）：
- **main**：string，相对 plugin.json 的路径，且必须是 .html
- **logo**：string，相对路径的 Logo 文件
- **features**：Array，最少 1 个功能
  - 每个 feature 必须有 **code**（唯一编码）和 **cmds**（指令列表，最少 1 条）

可选字段：
- **preload**：.js 预加载脚本路径
- **pluginSetting**：single（默认 true，单例）、height（默认 544，可被 utools.setExpendHeight 改）
- feature 可选：explain（功能描述）、icon（png/jpg/svg）、mainPush（向搜索框推送内容）、mainHide（触发指令不弹主搜索框，用于直接执行类功能）
- **tools**（新特性）：把插件能力暴露给 AI Agent（OpenClaw / Claude Code 等），需配合代码里 utools.registerTool 注册；键名必须小写 snake_case；必须有 description + inputSchema（JSON Schema，不能为 null）

### 指令 cmds 的五种类型
1. **功能指令**：纯字符串，如 "你好"
   - 要求：简短、明确、唯一；禁止无意义/重复/模糊名称；中文自动支持拼音和首字母搜索
2. **regex**：正则匹配文本，字段 type/label/match（注意正斜杠 "\\" 要写成 "\\\\"；"任意匹配"正则如 /.*/ 会被忽略）/minLength/maxLength
3. **over**：匹配任意文本，字段 type/label/exclude/minLength/maxLength（默认最多 10000）
4. **img**：匹配图像，type/label
5. **files**：匹配文件(夹)，type/label/fileType（file|directory）/extensions（扩展名列表）或 match（文件名正则，二选一）/minLength/maxLength
6. **window**：匹配当前活动系统窗口，type/label/match.app（数组，必填）/match.title（正则）/match.class（Windows 专有）

## 五、preload 规范（审核重点）
- preload 与 plugin.json 同目录或其子目录，必须可随插件一起打包
- 遵循 **CommonJS**（require），Node.js **16.x**
- 运行在独立预加载环境，可调用 Node.js 原生模块 + Electron 渲染进程 API（如 clipboard、nativeImage）
- **禁止打包/压缩/混淆**：代码必须每行清晰可读，源码提交
- 引入第三方模块：
  - 方式一 npm：preload.js 同级目录放独立 package.json（"type": "commonjs"），npm install 后保留 node_modules 一并提交
  - 方式二 源码：直接放源码目录 require 引入，同样不允许压缩混淆
- 前端通过 window 自定义属性访问 preload 暴露的能力，如 window.customApis.readFile(...)

## 六、开发调试
- 用「uTools 开发者工具」→ 新建项目（填应用名/描述/运行平台/开发者名称；名字避免特殊符号和 emoji）→ 新建 React+Vite / Vue+Vite 工程或手动建 → 选择工程下的 plugin.json → 点「接入开发」→ 点「打开」预览
- 调试：插件内 Ctrl+Shift+I（或右上角 Logo → 开发者工具）打开 DevTools
- 每次进入加载最新代码：应用开发界面 → 设置 → 开启「退出到后台立即结束运行」
- 热更新：plugin.json 加 development.main 指向本地 dev server URL：
  \`\`\`json
  { "development": { "main": "http://127.0.0.1:5173/index.html" } }
  \`\`\`
  Vite 直接用默认 HMR（npm run dev 后端口 5173）；Webpack 需装 webpack-dev-server 并在入口加 module.hot.accept()
  ⚠️ preload.js 变更无法热更新，只能重启（配合上面的立即结束运行）

## 七、打包与发布
- **离线安装包 UPXS**：开发者工具 → 打包 → 填版本号（遵循 semver 部分规范；注意打包版本号和发布版本号互不关联）→ 选保存路径。无需审核，但安装时 uTools 会弹安全提示；仅建议内部分享/测试，不建议当正式发布渠道
- **发布到应用市场**：开发者工具 → 发布 → 确认版本号和文件夹 → 填版本说明、插件介绍、插件截图 → 提交审核
- 发布前准备：发布插件信息、版本信息、截图；检查 preload.js 与 plugin.json 是否符合规范；提供用户手册（降低使用门槛，减少功能定位歧义）
- 审核结果在「发布历史」标签查看；审核通过后进入市场
- 第三方依赖注意：前端依赖装根目录正常编译输出到 dist；**Node.js 依赖放 preload.js 同级**，不要编译，保持目录结构不变、源码清晰
- 打包时只打包编译产物（dist 目录），**切勿把整个项目根目录打包**

## 八、实用 API 入口（官方 utools-api 文档）
- 交互事件 / 数据存储(db) / 系统相关 / window / copy / input / user / payment / screen / simulate / ubrowser / ffmpeg / sharp / tools / ai
- 对应文档目录都在 https://u.tools/docs/developer/

## 九、本地参考文件
本仓库 utools-docs-reference/ 下有本次抓取的官方页面原文（.md.txt）：
- basic_getting-started / first-plugin / debug-plugin / offline-plugin / publish-plugin
- information_plugin-json（含完整 cmds 与 tools 示例）/ information_preload / information_file-structure
