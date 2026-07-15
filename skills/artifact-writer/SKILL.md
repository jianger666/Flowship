---
name: artifact-writer
description: >-
  当你需要写或修改 ai-flow action artifact 文件（actions/<n>-<type>.md）、
  不确定该用什么 SDK 工具、参数怎么传、路径写哪、如何跟 submit_work 衔接、
  或之前写失败过想看排查清单时——请 `read` 本 skill。任何「写 artifact」场景必读一次。
---

# ai-flow Artifact 写入协议

## 一句话核心

**写 / 创建 artifact 文件永远用 SDK 内置 `write` 工具、永远不要用 `edit` / `write_file` / `create_file`。**

`edit` 工具签名是 `{ path, oldText, newText }`、要求文件已存在、能找到 oldText。新建 artifact 时文件不存在、`edit` 一定失败、SDK 拒掉调用、模型 retry 还用 edit、几轮后整个 run status=error → workflow failed。这是实测踩过 N 次的 anti-pattern。

## 工具映射表

| 你想做的事 | 用哪个工具 | args 形状 |
|---|---|---|
| **创建新的 artifact 初稿** | `write` | `{ path: <绝对路径>, fileText: <完整 markdown> }` |
| 修订已存在 artifact（用户 revise 后的小改）| `edit` | `{ path: <绝对路径>, oldText: <原段>, newText: <改后段> }` |
| 整文件覆盖已存在 artifact | `write` | `{ path: <绝对路径>, fileText: <完整新 markdown> }` |
| 删 artifact（不应该发生）| `delete` | `{ path }` |

**记忆口诀**：「**初稿 write、改段落 edit、整体覆盖也 write**」。拿不准就用 write、永远是对的。

## 路径必须绝对（当前体系：`actions/<n>-<type>.md`）

artifact 相对任务目录的路径是 `actions/<n>-<type>.md`（**无前导 0**、`n` 从 1 起）：

- 相对路径例：`actions/1-plan.md`、`actions/2-build.md`、`actions/5-custom.md`
- 绝对路径 = `<数据目录>/tasks/<taskId>/actions/<n>-<type>.md`
  - 也就是 super-prompt 顶部「Artifact 文件路径」段给的 `{{actionArtifactsDir}}/<n>-<type>.md`
  - 例：`…/tasks/<task_id>/actions/1-plan.md`

注意：

- **artifact 不在 agent cwd 下**——agent cwd 是用户业务仓库、artifact 在平台数据目录的 `tasks/<taskId>/actions/` 下、两者不在同一棵目录树
- **必须用绝对路径**——相对路径会写到 agent cwd 下、artifact 永远找不到、UI 也加载不出
- 路径直接抄 super-prompt 里的「Artifact 文件路径」/ `[NEXT_ACTION]` 头里的 `artifact_path`、不要自己拼、**不要用旧的 `artifacts/01-plan.md` 那种前导 0 / phase 目录**
- `submit_work` 的 `artifact_path` 传相对路径（如 `actions/3-build.md`）、跟 write 用的绝对路径对应同一文件

## 写 artifact 的标准动作（按顺序）

每个 action 完成时按这 3 步走、不要省也不要乱序：

### 1. write artifact

```
tool_use: write
args: {
  path: "<数据目录>/tasks/<task_id>/actions/<n>-<type>.md",
  fileText: "<完整 markdown 内容、从 # 标题开始>"
}
```

`fileText` 是**完整文件内容**、不是补丁、不是「在末尾追加 X」。从一级标题开始、按该 action prompt 模板的章节顺序写完。

### 2. emit 一条简短 assistant_message

格式：「**已写入 actions/<n>-<type>.md、请审阅**」（一句话、不要总结全文）。也可按 super-prompt：先给用户 1-3 句简短结论。

**禁说**的话：
- 把整份 artifact 内容粘回 assistant_message（用户已经能在左侧看到、不要重复）
- 把 SDK 协议名（`submit_work` / `ask_user` 等）告诉用户

### 3. 立刻调 submit_work 交卷

```
tool_use: submit_work
args: {
  task_id: <顶部告诉过你的 task_id>,
  action_id: <本 action 的 id>,
  artifact_path: "actions/<n>-<type>.md"
}
```

交卷后**正常结束本轮回复**——不要再调已退役的 `wait_for_user` / curl 长轮询。用户的下一步（推进 / 再聊聊 / 回答提问）会作为新消息续同一会话。

## 收到用户 revise（改类反馈）时的写法

用户改类反馈走 ask_user 复述确认（主 prompt 里详述）。**确认理解后**改 artifact 时：

- **改局部段落** → 用 `edit` 工具 `{ path, oldText, newText }`、不是 `write` 整文件覆盖（保留 git diff 干净）
- **结构性大改** → 用 `write` 整文件覆盖（一次写完）

判断标准：影响超过 3 段就走 write 整覆盖；3 段以内就 edit 局部。改完再调一次 `submit_work`（同 action_id、同 artifact_path）重新交卷。

## 排错清单（写失败时按这个序走）

### 错误：`File does not exist` / `oldText not found`

**原因**：你用了 `edit` 工具创建新 artifact。`edit` 只能改已存在的文件。

**修法**：改用 `write` 工具、参数从 `{ path, oldText, newText }` 换成 `{ path, fileText }`、`fileText` 是完整文件内容。

### 错误：`Permission denied` / `EACCES`

**原因**：路径不在 sandbox 允许范围。

**修法**：检查路径是不是 super-prompt 里给的 artifact 绝对路径、不要自己拼。如果路径正确但还是 denied、把错误内容写进下一次 `assistant_message` 让用户看到（这是平台 bug、不是你的锅）。

### 错误：`path must be absolute`

**原因**：你用了相对路径（如 `./actions/1-plan.md` 或 `data/tasks/.../1-plan.md`）。

**修法**：从 super-prompt 顶部「Artifact 文件路径」段**整段抄**绝对路径过来、不要自己改前缀。

### 错误：写完了 UI 看不到 artifact

**原因**：路径写错地方了（写到 agent cwd 下、或仍用旧的 `artifacts/0X-….md`）。

**修法**：

1. 在 agent cwd 下 `read` 你刚才写的路径、确认文件是不是被写到了 cwd 而不是绝对路径指定的位置
2. 如果文件在 cwd 下、`delete` 掉、用绝对路径重新 `write` 到 `…/tasks/<taskId>/actions/<n>-<type>.md`
3. 用绝对路径 `read` 一次目标文件、确认内容到位、再调 submit_work

## 各 action 的 artifact 命名

- **plan** → `actions/<n>-plan.md`（章节按 `prompts/action-plan.md`）
- **build** → `actions/<n>-build.md`（除了写 artifact、还要 edit 业务代码）
- **review** → `actions/<n>-review.md`（**只读业务代码、不改**）
- **ship / custom / …** → `actions/<n>-<type>.md`（按对应 action prompt）

同一 task 内 `n` 单调递增、不按 type 分编号、不补前导 0。模板看对应 action prompt（super-prompt 里嵌入过）。

## 跟 build action 改业务代码的区别

build action 同时干两件事：

1. **改业务代码**：用 `edit` 改已存在的 .ts/.tsx/.vue 文件（业务代码本就存在）、新建文件用 `write`
2. **写 `actions/<n>-build.md` artifact**：用 `write`（artifact 是新建的）

不要混了——业务代码大部分用 `edit`、artifact 永远用 `write`。

## 跟 review action 的区别

review action **禁止改业务代码**、只读 git diff + 上游 artifact、写 `actions/<n>-review.md`。所以 review 里你只会用一次 `write`（写本 action artifact）、不会有 `edit` 业务代码这个动作。
