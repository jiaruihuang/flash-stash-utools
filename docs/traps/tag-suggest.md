# 陷阱档案：标签区（token field）与建议下拉

> 来源：本项目标签区/下拉须知全史（原 HANDOFF 条目于 2026-09-20 体系改造迁入）；决策记录见文末。改 `src/views/save-view.ts` 标签区、`src/pinyin.ts` 标签建议前**必读**。
> 写法约定：现象 / 真因 / 禁令三段式（见 WORKMETHOD.md §四.3）。

## 1. DOM 结构（0.6.3 定稿）
- **结构**：`.tag-field`(position:relative，建议列表定位上下文) > `.tag-field-box`(带边框、flex-wrap)
  > `.chip-item`×N + `input.tag-input`（**输入框必须是 box 的最后一个子元素**，token 用 `prepend` 插到它前面）。
  ⚠️ 曾经漏掉把 tagInput append 进 tagBox，导致 `.tag-input` 查不到、整片用例失败。

## 2. 显示顺序与判脏
- **显示顺序 = 添加顺序**（`renderChips` 直接遍历 `Set`，**不排序**）；退格删除取 `[...tagSet][size-1]`，与显示顺序一致。**不要再给显示加 sort**，否则"删的"和"看到的"又会错位。
- **落库才排序**：`tagsForSave()` 按拼音排（跨收藏统一）；**编辑时按存储顺序显示**（`tagSet` 由 `snippet.tags` 初始化）。
- **判脏**用 `tagSignature()`（排序后快照），顺序变化不算修改。

## 3. 退格两段式删除（0.6.2，别再改回去）
**现象**：用户实测长按退格会把已选标签成串清空，属误操作。
**真因**：一次性删除对长按 `e.repeat` 连发无防护。
**禁令**：退格必须是「两段式」——输入框为空时第一次只置 `pendingRemoval`（红色高亮、不删除），松手再按一次才真删；`e.repeat` 连发只标记不确认（`backspaceLatch`）。不要改回"一次退格删一个标签"。
相关：`renderChips()` 负责渲染 `.chip-item.pending-del` 样式。

## 4. 回车语义（0.6.1 定稿，别再改回去）
**唯一判据是「有没有高亮项」**（= 用户按过 ↑/↓）：
- 有高亮 → 选中该项；
- 无高亮 → **按输入内容新建标签**。

**禁令**：不要写成"有候选就选候选"——那会让用户无法新增标签（0.6.0 的回归，用户实测反馈"增加不了"）。
相关：筛选词一变，`suggestActive` 必须复位（input 处理器中的 `lastQuery` 判断），否则 ↓ 会从上一批候选的旧下标继续走。

## 5. 滚动跟随（0.6.4）
**禁令**：滚动高亮用 `scrollActiveIntoView()` 自己算，**禁止改回 `scrollIntoView`**——后者会滚动所有可滚动祖先（把整个视图顶动、下拉自己不动），且向上展开时列表是 `transform` 视觉上移的，浏览器按布局盒判断可见性会判错。（排查全史见 CHANGELOG-DETAIL 0.6.4）

## 6. 下拉键盘导航：五层真因与禁令（0.6.4~0.6.7 连续四次没修对，0.6.8 才收敛）

**现象**（用户原话）：按 ↓ 走到可视区最后一条再按一次 → **失高亮**、不跟随；再按一次 → 滚动条**回到最上面**、第一条露出来但仍无高亮；再按一次才高亮第一条；"和我鼠标有点关系""当到达视野最后一条再按键盘下时不会跟随向下，而且是跳回到了顶端大概的位置"。

**真因（累计五层；0.6.8 才发现最后一层——它正是此前四次的共同盲区）**：

① **（0.6.8 核心修复）`document` 上的 capture scroll 监听连「下拉自身的 scroll」也捕获并整表重建**：
   0.6.0 为"列表贴字段"注册了 `document.addEventListener("scroll", repositionSuggest, true)`；
   scroll 事件虽不冒泡，但**捕获阶段仍从 document 走向目标**。键盘导航走到底时
   `scrollActiveIntoView()` 改 `suggestEl.scrollTop` → 浏览器**异步派发** scroll（目标 = 下拉自己）
   → `repositionSuggest → showSuggest() → rebuildSuggestOpts()`：候选整表重建、
   `suggestActive=-1`、`setKbdNav(false)`，新内容把 `scrollTop` 钳回 0
   → 名副其实的"跳回顶端 + 丢高亮"。且重建出的选项是**全新节点**，
   指针下方的新节点会再触发 `mouseenter`（此时 kbdNav 已被重建复位 → 守卫失效），
   这就是 0.6.7 修了 kbdNav 仍残留"和我鼠标有点关系"的原因（已在真实 Chromium
   中完整复现该事件序列并逐方验证）。
   ⚠️ **jsdom 里 `scrollTop` 赋值不派发 scroll 事件**——该事件路径在 0.6.4~0.6.7
   四轮测试中从未执行过（假绿灯）；**jsdom 滚动用例必须显式
   `suggest.dispatchEvent(new Event("scroll"))` 模拟真实浏览器**。

② 此前四轮已修的三层（结论仍有效）：
   • `mouseenter` 抢走键盘高亮：列表滚动时新行滑到静止指针下触发 mouseenter，
     无条件接管 → 抹掉 `.active`（0.6.7 用粘性 `kbdNav` 模式压制）；
   • 计时器挡 mouseenter 会过期：**必须模式化，不能时间窗**（0.6.6 废除计时器）；
   • 行高写死 32 / maxHeight 非整行 / 导航不重套几何 → 半行遮蔽、提前停住（0.6.5；CSS 见 .opt 注释）。

ℹ️ **"滚动条回顶"在①视角下也不是独立 bug**：是监听重建把 scrollTop 钳回 0 的连锁反应。

**禁令**（每条都有血泪史，不要"优化"回去）：
- **capture 级全局监听必须识别事件来源**：`repositionSuggest` 必须忽略
  `e.target === suggestEl`（它自滚不改变与 `.tag-field` 的相对位置）。
  **不要"顺手"删掉这个判断**，也不要让任何会 `rebuildSuggestOpts()` 的函数
  出现在重定位路径上——重建即清高亮、清 kbdNav、回 scrollTop 顶。
- **jsdom 滚动相关回归用例必须显式派发 scroll 事件**（目标 = suggestEl），
  否则用例空转（假绿灯第 4 次）。真实浏览器层用 `npm run test:browser`
  （playwright，浏览器已在 .pw-browsers/）锁。
- **键盘导航是模式，不是时间窗**。守卫必须是 `if (kbdNav) return;`，
  **绝不要改回 `Date.now() - lastNavKeyAt < N` 这类计时判据**——它会过期，现象随按键快慢复发。
- **只有真实 `mousemove` 才可退出键盘模式**（`mousemove` 不会被"滚动被动进入"触发）。
  **不要把退出判据改成 `mouseenter`**，否则被动进入会误退出、鼠标又能抢走高亮。
- **`kbd-nav` 类只是表现，守卫是布尔量**：`kbdNav` 与类名是同一状态的两处表示，
  必须走唯一入口 `setKbdNav(on)`，**禁止任何地方直接 `classList.add/remove("kbd-nav")`**。
  （历史坑：只加类没置位 → hover 被压制但高亮仍被抢，极难查。）
- 行高**必须实测**（`measureRowH()`），**绝不可**在算 `maxHeight` 时写死 32；
  CSS 侧 `.opt` 固定 `height:32px / line-height:18px`，**改这里必须同步验证**。
- `maxHeight` 必须是「整行数 × **实测行高** + 2px 边框」，**绝不要再夹固定 320**；
  滚动用 `scrollActiveIntoView()`，**禁止改回 `scrollIntoView`**。
- 导航时重算几何要用 `placeSuggest()`（只定位/定高），**不要**用 `showSuggest()`
  ——后者会 `rebuildSuggestOpts()` 把高亮重置掉。

- 本模块五次假绿灯实录（路径未执行 / 共享错误常量 / 测试比 bug 快 / 事件路径未驱动等）
  与"真实行高 29px + 560ms 慢速按键 + 双向验证"的修正全文见 **traps/testing.md**；
  版本级排查史见 CHANGELOG-DETAIL 0.6.4~0.6.8。

📌 **通用教训：测试的时序/常量必须与"用户真实操作"同量级**；**事件路径必须显式驱动**，
否则测试只会验证实现自己的假设。

## 7. 删标签必须收起下拉
**禁令**：删标签（退格两段式 / 点 ×）必须 `hideSuggest()`——删标签场景不会同时选标签，列表留着会挡住红色提示。
点 × 会让输入框先失焦再聚焦，须用 `suppressBlur` 抑制随之而来的自动弹出。

## 8. 建议下拉：弹层定位（0.4.2~0.4.6 → 0.6.0 定稿）
浮层定位通用规则见 traps/env.md §浮层定位。本模块特例：
- 历史演进：早期用 fixed + 上下翻转，在"上方更宽裕"时会把列表甩到输入框上方老远、中间留大段空白（用户实测反馈），0.6.0 起改为**相对定位上下文内联展开**（`.tag-field` 内 absolute，紧贴上下沿，滚动/缩放跟随）。

## 相关决策（本项目定稿，改前勿推翻）
- **标签建议键盘导航不循环**（到顶/底即停，clamp 而非 wrap）。
- **状态机**：`suggestOpts`（候选）+ `suggestActive`（高亮）+ `kbdNav`（键盘态）三者独立。
  ⚠️ ↑/↓/回车**不能**落到末尾的 `showSuggest()`（会重置高亮）；回车以「有没有高亮项」为准，
  不要退回"只看 kbdNav"的写法——那是「全量列表键盘选标签没效果」的成因（详见 CHANGELOG-DETAIL 0.6.0）。
- **拼音选标签**（0.5.6）：`matchTextOrPinyin`（`src/pinyin.ts`），输入 `qd`/`qianduan` 搜「前端」。
