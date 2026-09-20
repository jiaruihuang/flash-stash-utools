# 陷阱档案：主面板与数据层

> 来源：本项目主面板/数据层定稿须知与决策（原 HANDOFF 条目于 2026-09-20 体系改造迁入）。改 `src/views/main-view.ts`、`src/db.ts`、`src/search.ts`、`src/sort.ts` 前必读。

## 1. 检索管线与排序（0.6.0）
- `renderList()` 里顺序为「检索(searchSnippets) → 筛选(filterSnippets) → 排序(sortSnippets)」，所以检索出的结果同样受排序控制。
- 排序偏好存 `setting/ux` 的 `sortMode/sortDir/sortGroup`，读时一律经 `src/sort.ts` 的 `normalizeSort*` 兜底（老库缺字段 → 更新时间 ↓、不分组）。
- 排序键（`src/sort.ts`）：smart(搜索相关度) / updated / created / recent(最近使用) / hits(使用次数) / title / kind。
- 排序是展示层能力、选定即持久化；日期分组可选。

## 2. `useCount` / `lastUsedAt` 由复制驱动
- `doCopy()` 成功才 `store.touchSnippet()`；
- 为避免复制后卡片在脚下重排，**记账后不立即重绘**，下次刷新自然生效（**不要自作主张加 renderList**）。

## 3. 批量模式（0.6.0）
- `.mv-list.batch` 控制复选框显隐；点卡片在批量模式下是勾选而非复制；**Esc 先退批量**。
- 批量删除确认框写明条数，图片一并清理本地文件。

## 4. 剪贴板保存一律「文本」（0.4.4 定稿，别推翻）
- 不自动判 Markdown——误判太多（0.4.0~0.4.4 折腾史）；要 md 用「闪藏：收藏 Markdown」命令。
- `detectKind`（`src/markdown.ts`）保留但 `main.ts` 不再调用（仅单元测试保留）。
- **0.6.0 强化**：保存视图**明确告知当前按哪种标记收藏**并提示可切换（`SaveInit.source`），把选择权交给用户——用户复制 SQL 后想收藏 text 却只看到 Markdown 选项的问题由此闭环。
- **0.6.1 禁令**：`plugin.json` 的「闪藏：收藏文本」**绝不能加 `exclude: "/\\n/"`**——uTools 的 `exclude` 是「从任意文本中排除」，一旦含换行该指令会被**直接隐藏**（用户复制多行 SQL 时菜单里只剩「收藏 Markdown」，正是用户反复反馈"只给 Markdown 选项"的根因）。两个 `over` 指令必须都可见，由用户在菜单里选。

## 5. 成功提示默认 toast（0.3.0 定稿）
- 轻量气泡 + 1.4s 后退出，不打扰工作流；设置里可选完整浮层/不提示。

## 6. 拼音匹配（0.5.6 定稿）
- 基于 pinyin-pro，`src/pinyin.ts` 统一封装——按文本内容做**值缓存**（上限 400 条、>2000 字不缓存现算）建立「全拼 + 首字母」双索引（ü→v、多音字按词组取音）。
- **查询串为纯 ASCII（`/^[a-z0-9]+$/`）才走拼音分支**，其余保持常规子串语义，多词 AND 与权重不变。
- 命中是**超集补充匹配**（常规子串优先），视觉高亮只高亮字面命中片段（拼音命中的中文不标黄，**属预期**，不要当 bug 修）。
- 三处共用：搜索（`searchSnippets` 第三参 `{pinyin}`，设置默认开）、标签建议（`matchTextOrPinyin`）、标签管理（同）。
- 若用户反馈"拼音搜不到/太飘"，先看 `src/pinyin.ts` 的缓存与 `search.ts` 的 `fieldHit`。

## 7. 已知限制（不要当 bug 反复修）
- 「类型」排序（文本→Markdown→图片）与「标题」排序都属并列较多的兜底排序，主键相同时统一以更新时间倒序收尾。
- uTools 带词进入自动预填搜索（0.3.0）。

## 8. 数据层结构速记
- `src/db.ts`：Store 封装 utools.db（收藏/标签/设置 CRUD，touchTag 更新 lastUsedAt）。
- `src/types.ts`：Snippet / TagDoc / UxSettings / DbLike 接口。
- `src/item-view.ts`：KIND_ICON / KIND_LABEL / thumbnailEl。
