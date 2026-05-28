# Action: learn（V0.6.3 完整实现、V0.6.0 stub）

> 当前 V0.6.0 阶段 learn action **未实现、UI 推进 dialog 灰掉**、runner 准入检查会拒绝。这份 prompt 是 V0.6.3 的设计参考、收到 `[NEXT_ACTION type=learn]` 时你应该不会实际拿到（runner 已拦）。

---

> 以下是 V0.6.3 设计、当前 V0.6.0 不要按这套跑、收到 [NEXT_ACTION type=learn] 时立刻 emit 一条 assistant_message：「learn action 在 V0.6.3 上线、当前未实现」、然后 wait_for_user(task_id={{taskId}})（不带 action_id）等下一 action 指令。

## V0.6.3 设计草稿

learn action 的目标：task merged 后、扫整段 action history、反思哪些约定值得跨任务沉淀、写一份 propose 列表给用户审 → HITL 落到 AGENTS.md / .cursor/rules / prompts/_super.md。

### 准入条件（V0.6 门槛 1、硬门槛）

- `repoStatus = "merged"`（用户已标 task 合入 main）
- 整个 task 里**只能跑一次**（runner 检查 action history、有 learn 则拒绝）

### 执行步骤（草稿）

1. read 全部 action history（plan / build / review / ship / test artifact）
2. read 当前的 `<repoPath>/AGENTS.md` + `<repoPath>/.cursor/rules/*.mdc`（避免重复）
3. 反思：哪些约定值得跨任务沉淀？
4. 写 `actions/<n>-learn.md`：propose 列表、每条带 trigger / rule / rationale / evidence / 落点建议
5. wait_for_user(task_id, action_id, artifact_path)

### 后置检查（V0.6.3）

- propose 段不能全是「本次无」（防搪塞、强制让 agent 写至少 1 条；或者明确写「本次无、理由：...」）
- evidence 必须指向某个 action 的 artifact 真实路径（防编造）

### HITL 落库（V0.6.3 第一版）

- 用户在 learn 的 ack dialog 里看 propose 列表、勾选哪些进库、选落点
- approve 时 fe-ai-flow 自动写到目标文件（append、不去重、第一版简单）
- 落点 3 选 1：
  - `<repoPath>/AGENTS.md`（2026 emerging 跨工具标准、Cursor / Claude Code / Windsurf 都识别）
  - `<repoPath>/.cursor/rules/<topic>.mdc`（Cursor 单工具）
  - `prompts/_super.md`（fe-ai-flow harness 自我增强）

### artifact 骨架（V0.6.3）

详见 V0.6-REFACTOR.md §5.6。

### 反例

- propose 跟 `<repoPath>/AGENTS.md` 已有内容重复
- propose 没 evidence（凭印象、编造）
- propose 是临时 workaround（不该沉淀）
- 自动结束 Run（错、learn approve 后才结束 Run、且需要服务端写 [TASK_DONE]）
