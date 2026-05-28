# Action: ship（V0.6.1 完整实现、V0.6.0 stub）

> 当前 V0.6.0 阶段 ship action **未实现、UI 推进 dialog 灰掉**、runner 准入检查会拒绝。这份 prompt 是 V0.6.1 的设计参考、收到 `[NEXT_ACTION type=ship]` 时你应该不会实际拿到（runner 已拦）。

---

> 以下是 V0.6.1 设计、当前 V0.6.0 不要按这套跑、收到 [NEXT_ACTION type=ship] 时立刻 emit 一条 assistant_message：「ship action 在 V0.6.1 上线、当前未实现」、然后 wait_for_user(task_id={{taskId}})（不带 action_id）等下一 action 指令。

## V0.6.1 设计草稿

ship action 的目标：把最新 build artifact 的改动提成 MR（GitLab `glab mr create`）+ 飞书工作项评论回写 + 写 ship artifact 记录 commit hash / MR URL / 飞书回写状态。

### 准入条件（V0.6 门槛 1、硬门槛）

- 至少 1 个已通过的 build action
- `git status` 当前分支有改动 / 至少有 1 个未推送 commit
- `task.gitBranch.checkedOut = true`（build 第一次跑前已 checkout 分支）

### 执行步骤（草稿）

1. read 最新 build artifact + 最新 review artifact（如有）
2. 生成 commit message（基于最新 build artifact 的「Task 完成情况」段、按 conventional commit）
3. 生成 MR title + body（基于飞书 story + 最新 build + 最新 review）
4. ask_user 让用户最终确认 commit msg / MR title / MR body（一次性问完）
5. 调 `shell` 跑：
   - `git add` / `git commit`
   - `git push -u origin <branch>`
   - `glab mr create --title ... --description ... --target-branch <主分支名（agent 自探）> --source-branch <branch>`
6. 拿到 MR URL 后、调 `user-feishu-project-mcp.add_comment` 把 URL 评论回飞书项目工作项
7. 写 `actions/<n>-ship.md`：commit hash / MR URL / branch / 飞书回写状态
8. wait_for_user(task_id, action_id, artifact_path)

### 后置检查（V0.6.1）

- `git push` exit 0
- `glab mr create` exit 0、拿到的 URL 非空
- 飞书评论调用 exit 0（失败也不阻塞 ship、artifact 标 ❌、用户后续补）

### 同 task 多次 ship

V0.6 拍板：**同 branch、累计 commit**——修 MR review 反馈直接接着 push、不重开 MR。第 N 次 ship 时 runner 检测到 task 已有 MR、跳过 `glab mr create`、只做 commit + push。

### artifact 骨架（V0.6.1）

详见 V0.6-REFACTOR.md §5.4。

### 反例

- 强推到 main（硬门槛禁）
- commit message 跟 build artifact 不一致
- 不更新 `Task.mrs` 列表（runner 侧必须写入）
- 自动跑下一 action（绝对不、ship approve 后等用户选下一 action）
