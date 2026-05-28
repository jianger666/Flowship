# Action: test（V0.6.2 完整实现、V0.6.0 stub）

> 当前 V0.6.0 阶段 test action **未实现、UI 推进 dialog 灰掉**、runner 准入检查会拒绝。这份 prompt 是 V0.6.2 的设计参考、收到 `[NEXT_ACTION type=test]` 时你应该不会实际拿到（runner 已拦）。

---

> 以下是 V0.6.2 设计、当前 V0.6.0 不要按这套跑、收到 [NEXT_ACTION type=test] 时立刻 emit 一条 assistant_message：「test action 在 V0.6.2 上线、当前未实现」、然后 wait_for_user(task_id={{taskId}})（不带 action_id）等下一 action 指令。

## V0.6.2 设计草稿

test action 的目标：AI 手测——读飞书项目里的测试用例（用 `user-feishu-project-mcp.list_workitem_comments` 等 API 自己翻）、起服务 / 调 curl / 看页面表现、按 case 逐条判断 pass/fail/skip、写 test artifact。

### 准入条件（V0.6 门槛 1）

- 至少 1 个已通过的 build action（硬门槛）
- contextDocs 里有标记为「测试用例」的 doc（软门槛、没有时 warning「无测试用例、AI 自由探索」、但 V0.6.2 起 agent 默认自主翻飞书项目找）

### 执行步骤（草稿）

1. read 最新 build artifact
2. 用 `user-feishu-project-mcp.list_workitem_comments` + `get_workitem_brief` + 飞书项目子工作项 API 自己翻、按内容识别测试用例
3. 按 case 逐条手测：
   - case 描述「点 X 按钮、应该弹 Y」→ agent 调 `shell` curl / 调 puppeteer MCP 模拟、看返回 / DOM、判断 pass/fail
   - case 没法自动化（需要肉眼判断）→ 标 SKIP + 原因
4. 写 `actions/<n>-test.md`：case 列表 + pass/fail/skip 状态

### 后置检查（V0.6.2）

- pass 率 ≥ plan 里定的阈值（默认 100%、用户在 plan §4 关键技术决策里可改）
- skip 率 < 50%
- 不通过 → artifact 标 ❌ → 用户下一步推 build 修

### artifact 骨架（V0.6.2）

详见 V0.6-REFACTOR.md §5.5。

### 反例

- 编造 case 结果（必须配合 grep evidence、artifact 里有 shell 命令实际输出）
- 跳过太多 case（skip 率 > 50% → 后置检查标 ❌、提示用户「测试不充分」）
- 自动跑下一 action（绝对不、test approve 后等用户选下一 action）
