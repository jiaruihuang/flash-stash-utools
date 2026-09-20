# 陷阱档案：测试纪律（假绿灯与双向验证）

> 来源：本项目 0.6.4~0.6.8 假绿灯教训、WORKMETHOD.md §三 验证纪律（项目硬规则索引：HANDOFF §1 第 7 条）、jsdom 相关须知。写或改任何测试前必读。
> 本文是 WORKMETHOD.md「三、验证纪律」四条硬要求（双向验证 / 同量级 / 注入与断言独立 / 路径覆盖）在**软件测试领域**的具体化与本项目实例。

## 1. 「真锁住」要求（硬性）
- 新增/修改的回归测试**必须验证过它能捕获该 bug**：临时还原成错误实现 → 用例应失败；恢复 → 通过。
- **"通过了"不等于"锁住了"**——测试与实现若共享同一个错误假设（如都写死同一个常量），会给出假绿灯。

## 2. 假绿灯五种形态（本项目全部真实发生过，累计五次）
1. **路径从未执行**（0.6.4）：滚动用例对**新旧实现都通过**；且 jsdom 里 `scrollIntoView` 是 `undefined`、旧代码用 `?.` 调用 → **测试中从未真正执行过**。
2. **共享错误常量**（0.6.5）：行高用例**自己注入了 `offsetHeight = 32`**，在"真实行高不是 32"上完全测不到——**测试与实现共享了同一个错误常量**。
3. **测试比 bug 跑得快**（0.6.6）：用例用 **4ms 间隔按键**，**永远测不到 500ms 时间窗过期**。
4. **事件路径不驱动 = 路径不存在**（0.6.7）：jsdom 不派发 scroll 事件，真正的「scroll → showSuggest → 重建」路径在四轮测试里从未执行过。
5. （综合）以上形态叠加，导致同一个问题连续四版假绿灯（详见 CHANGELOG-DETAIL 0.6.4~0.6.8）。

## 3. 时序与常量必须与"用户真实操作"同量级（硬性）
- 正面范例：0.6.7 用例注入**真实行高 29px** + **560ms 慢速按键**（大于旧的 500ms 窗口），并双向验证。
- jsdom 滚动用例必须**显式 `el.dispatchEvent(new Event("scroll"))`** 模拟真实浏览器（`scrollTop` 赋值不派发 scroll 事件）。

## 4. jsdom 环境注意
- 弹窗/确认框挂在 `document.body`（不在 #app）；跨测试要 `closeAllLayers()` 清残留弹层。
- 键盘事件断言用 `dispatchEvent(KeyboardEvent)`（`bubbles:true`）。
- 富文本测试见 traps/editor.md §4（polyfill 与接缝）。
- 现用例数只维护在 HANDOFF.md（勿写进 AGENTS/本文，会过期）。

## 5. 浏览器层测试
- jsdom 测不到的事件路径（真实滚动/布局），用 `npm run test:browser`（playwright，浏览器已在 `.pw-browsers/`）锁。
- 既有 3 个历史遗留浏览器用例当前失败属历史遗留，与功能无关，勿当回归修。

## 6. 测试文件索引
- `tests/`：store / search / markdown / editor / ui-smoke（jsdom + 手写 utools mock）
- `tests/memory-db.ts`：内存实现；`tests/ui-browser.test.ts` 为 playwright 备用（0.6.8 起纳入关键路径回归）
