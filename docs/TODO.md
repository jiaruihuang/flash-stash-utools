# TODO — 待办（做完即删）

> 规则（见 WORKMETHOD.md §四.4）：
> 1. **完成一项立刻删除该条**，不保留"已完成"记录——完成的内容进 `docs/CHANGELOG.md`；
> 2. 删除前若该条结论有长期价值（陷阱/决策/须知），先迁移到 `docs/traps/` 对应档案或 `docs/CHANGELOG-DETAIL.md`；
> 3. 优先级：P0 > P1 > P2。新待办加进来时写清一句话背景与验收标准。

## 当前待办

- **P2（后话）把 AGENTS + WORKMETHOD 的方法沉淀收敛为可复用的 Skill/模板包**：目标是在新项目上能"读取项目 → 初始化生成该项目实例（HANDOFF/docs/）"。本项目的四层机制就是试点；验收标准：脱离本项目上下文，仅凭模板即可初始化一个新项目并让新会话顺利接手。

## 已知限制（不要当 bug 反复修，仅供查阅；完整列表见 docs/traps/ 各档案「已知限制」节）

- 富文本 ↔ 源码/预览 切换会重建编辑器，撤销历史随之重置（traps/editor.md §9）
- uTools 侧主动收起插件（onPluginOut）无法拦截，未保存提示只覆盖插件内 Esc 与「取消」（traps/esc-views.md §6）
- 拼音命中的中文不标黄属预期（traps/main-panel.md §6）
- 既有 3 个 playwright 冒烟用例失败属历史遗留，勿当回归修（traps/testing.md §5）
