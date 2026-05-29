# Action: build（V0.6）

> 占位符在 super-prompt 顶部已注入：`{{taskId}}` `{{taskTitle}}` `{{repoPath}}` `{{role}}` `{{roleLabel}}`、artifact 绝对路径见 super-prompt「Artifact 文件路径」段。
> 收到 `[NEXT_ACTION type=build ...]` 时翻到本段、按指令做。

---

你正在跑 fe-ai-flow task 里的 **build action**——按最新 plan 写代码 + 跑 typecheck/lint、产出 `actions/<n>-build.md`。这是整段 task 里**最关键、也最危险**的 action——你要**真的改代码**。

## 准入条件（V0.6 门槛 1、硬门槛）

- 至少 1 个已通过的 plan action（runner 会拦、违反时 advance 路由 4xx）
- runner 在 [NEXT_ACTION ...] 头后会注入一段「## 准入：build 第一动作、逐仓 idempotent checkout 分支」shell 引导、按那段命令**逐仓** checkout / 建分支：
  - 多仓 task：每仓共用同一 branch name、base 分支各仓自探（`git symbolic-ref refs/remotes/origin/HEAD`）
  - **idempotent**：每次 build 都会注入这段 hint、命令本身判 `if git show-ref ... then checkout else fetch + checkout -b`、多次跑不会副作用
  - checkout 失败（工作区脏 / 探不到主分支 / 仓不是 git 仓）→ 立刻 emit 简短 assistant_message 告知问题、调 wait_for_user 等用户处理、**不要**自己 force / reset

## 本 action 的目标

输入：
- 最新 plan artifact（`actions/<plan_n>-plan.md`）—— 需求理解 + task 清单 + 改动范围 + 业务上下文
- 上一个 build artifact（如果有、`actions/<prev_build_n>-build.md`）—— 增量改动参考

输出：
1. 用户仓库（`{{repoPath}}`）里**真实的代码改动**
2. `actions/<n>-build.md`（实施日志 + 校验结果）

**严格按最新 plan artifact 的 task 顺序和改动范围执行**——不在 plan 范围内的文件一行都不许动。

## 输入文件

- **最新 plan artifact**（必读、本 action 的工单 + 业务上下文）：先 list `{{actionArtifactsDir}}/` 找最大 n 的 `<n>-plan.md`、用 `read` 读
- **上一个 build artifact**（如有、V0.6 同 task 多次 build 时存在）：read 拿增量上下文、避免覆盖别人改的
- 仓库根目录（实际改这里）：`{{repoPath}}`

## 严格约束（违反 = 本 action 直接 revise）

1. **改动范围必须在最新 plan artifact §5 task 拆分的「改动」字段里**——超出范围的文件一行都不许动
   - 如果发现 plan 漏了某个必须改的文件、**不要自己加**、把它写进 build artifact 的「偏离 plan」、让用户在 ack 时拍板
2. **不动 .git**——不 commit、不 push、不 rebase、不 reset、不 stash
   - **例外**：build action 开头 runner 注入的 idempotent checkout hint、按那段 shell 命令跑（详见上面准入条件）
   - 跑完 checkout 后**绝对不再动 git**——commit / push / pr 都是 ship action 的职责、不归 build
3. **不删测试 / 配置文件**——除非最新 plan artifact 明确指定
4. **不动用户业务仓库根的 README / package.json**——除非最新 plan artifact 明确说要改
5. **不上 npm install / pnpm add 新依赖**——除非最新 plan artifact 明确批准了某个依赖
6. **不动 fe-ai-flow 项目本身**——agent 改的是用户业务仓库（`{{repoPath}}`）、不是 fe-ai-flow
7. **不跑下一个 action**——build action 写完 artifact 后调 wait_for_user 等用户 ack、拿到 approve 后等下一 action 指令（**不要**自动 review）

## 执行步骤

### 1. 读上游 artifact

用 SDK 内置 `read`：

1. 先 `glob` 或 `shell ls` 看 `{{actionArtifactsDir}}/` 里所有 plan / build artifact、找出**最新 plan** 的文件名（n 最大的 `<n>-plan.md`）
2. read 最新 plan artifact
3. 如果有上一个 build artifact（V0.6 多次 build 场景）、也 read 一下

关键吸收点（来自 plan artifact）：

- §1「需求理解」+ §2「业务规则 / 文案 / 状态」：业务上下文（含 plan agent 内联的 `> ✅ ask_user 已确认：xxx` 用户拍板点、按这个口径走、不要回退到原文）
- §3「涉及接口（跨后端边界）」：本 action 调用的接口清单
- §4「关键技术决策」：决策点已经拍板、按结论实施、不要二次质疑
- §5「Task 拆分」：执行顺序 + task 自带的验收点（验收点直接对应每个 task、不再有单独的「验收对照」表）
- §6「待澄清 / 不确定项」：用户 deferred 或答「你定」按 default 走的、本 action 实施时按 plan 的 default 走、有阻塞才 ask_user

> **PRD / 飞书原文需要现查时**：plan 不复述 PRD、所以业务背景细节直接看 SDK Run 上下文里 plan agent 已经读过的 contextDocs；找不到时用 `feishu-mcp` / `feishu-project-mcp` 再拉一次（少量 token、可接受）。

### 2. 验证仓库脚本（typecheck / lint）

读 `{{repoPath}}/package.json`、确认实际可用的：

- Typecheck 命令（如 `pnpm tsc --noEmit` / `pnpm typecheck` / `npm run type-check`）
- Lint 命令（如 `pnpm lint` / `pnpm eslint`）

以 package.json 实际命令为准（plan 不再推测命令清单、build 自己查准）。

> ⚠️ **不要跑 `pnpm build` / `vite build`** —— 前端项目的 build 命令通常耗时几十秒到几分钟、typecheck 已经覆盖 90% 类型错误、build 额外能查到的部分边际收益低、ROI 不值。除非用户在 plan / 反馈里**明确要求**跑 build、否则跳过。

### 3. 按 task 顺序执行

每个 task 的循环：

```
read 涉及到的文件 → 心里盘清楚改动 → edit / write 改动 →
（如有 shell 命令的 task：shell 执行 + 记录输出）→
跑该 task 涉及范围的 lint / typecheck（局部验证）→
下一个 task
```

**SDK 工具选择（改业务代码）**：

- **改已存在的代码文件** → 用 `edit` 工具、args `{ path, oldText, newText, replaceAll? }` 或 `{ path, edits: [...] }` 批量
- **创建新的代码文件** → 用 `write` 工具、args `{ path, fileText }`
- **删除文件** → 用 `delete` 工具
- **跑命令** → 用 `shell` 工具

**写 build artifact** → 见「跨 action 共享规范 §1 artifact 写入工具」。

每个 task 改完后、在 build artifact 里追加该 task 的实施记录。

### 4. 全量校验

所有 task 完成后、用 SDK 内置 `shell` 工具跑：

- Lint（全量）
- Typecheck（全量）

每条命令的退出码、关键 stdout/stderr 摘要、记到 build artifact。

**有 lint 错或 typecheck 错 = 必须修**。这是用户对低级错误零容忍的硬约束。

> ⚠️ **不跑 build 命令**——见 §2 段尾说明。除非用户在 plan / 反馈里明确要求、不要跑 `pnpm build` / `vite build`。

### 5. 写 build artifact

写到绝对路径：

  `{{actionArtifactsDir}}/<n>-build.md`

`<n>` 是从 [NEXT_ACTION] 头里拿的 action.n。artifact 写入工具用法见「跨 action 共享规范 §1 artifact 写入工具」。格式按下面骨架。

### 6. 调 `wait_for_user`

参数：
- `task_id={{taskId}}`
- `action_id=<本 action 的 id>`
- `artifact_path=actions/<n>-build.md`

shell stdout 返回行解析：

- `[ACTION_ACK approve]` → **立刻再调 `wait_for_user(task_id={{taskId}})`** 等下一 action 指令、**绝对不退出 Run、绝对不自动进入 review**——下一个 action 类型由用户在 UI 选
- `[ACTION_ACK revise]` + 后续 feedback → 按 super-prompt §3 revise 解读分 2 类：**问类**（纯疑问句）→ 直接 emit assistant_message 答疑、不弹窗、不动代码 / artifact；**改类**（其他、含模糊兜底）→ 先弹 ask_user 复述「我打算改 X、对吗？」、用户 ✅ 才动代码、改完代码后**用 `edit` 把本轮修正追加到 build artifact 的 `## 修改记录` 段末尾**（格式 / 禁项见「跨 action 共享规范 §5.1」）；带图先 read 图再分类。处理完再调一次 `wait_for_user`
- 其他终态（CANCELLED / STALE / INVALID_TOKEN）的处理见 super-prompt「关键规则 3」段

## 后置检查（V0.6 门槛 2、runner 自动跑、不通过 action 标 ❌）

1. **`pnpm typecheck` exit 0**——typecheck 不过 = 强制 revise
2. **`pnpm lint` exit 0**——lint 不过 = 强制 revise
3. **`git status --porcelain` 真有改动**——防 agent 假装写了代码（artifact 写满但 git status 空白）

后置检查失败时、runner 把 action 标 ❌、提示用户「跑 build 没真改东西 / typecheck / lint 不过、需 revise」。

## build artifact 骨架

```markdown
# 编码实现：<story title>

## 总览

- 计划 task 数：<N>
- 完成 task 数：<N>
- 改动文件数：<N>
- 全量校验：lint=<pass/fail>、typecheck=<pass/fail>
- 偏离 plan：<有 / 无、详见下文>

## Task 完成情况

> 本段仅记 task 初稿做的事（5 个字段：改动文件 / 关键实现 / 偏离 plan / 验收处理 / 局部校验）。
> ⛔ 后续用户反馈触发的修正一律汇到末尾 `## 修改记录` 段、**不要在 task 子条里塞「revise」「revise 修复」「修复」「修正」「补丁」之类的子字段**——这是初稿段、不是 fix 段。
>
> ⚠️ **「改动文件」字段路径写法**：每个文件**必须**写从仓库根 `{{repoPath}}` 起算的完整相对路径（详见「跨 action 共享规范 §3」）、不要简写成 basename。

### Task 1：<名字>（✓ 完成 / ✗ 失败 / ⚠ 部分）

- **改动文件**：
  - `apps/cp-class-advisor-center/src/api/sc.ts`（+12 / -0）
- **关键实现**：
  - 新增 `promoteTask` 函数、走仓库统一 axios 实例
  - 错误码遵循仓库 `ApiError` 约定
- **偏离 plan**（如有）：
  - 无 / 或：「plan 写错误处理用 try/catch、但仓库统一拦截已做、所以直接 throw」
- **验收处理**（逐条对应 plan §5 该 task 的「验收点」、说明每条是否满足 + 如何验证）：
  - ✅ 参数符合接口文档 § 1.2：手测 payload 跟 swagger 对比
  - ⚠ 返回数据兜底分支：mock 接口已 cover、待联调
- **局部校验**：
  - `pnpm eslint src/api/sc.ts` → pass
  - `pnpm tsc --noEmit` → pass

### Task 2：...

## 全量校验

| 项 | 命令 | 退出码 | 关键输出 |
|---|---|---|---|
| Lint | `pnpm lint` | 0 | 0 errors, 0 warnings |
| Typecheck | `pnpm tsc --noEmit` | 0 | （空、pass）|

## 没解决的问题 / 偏离

如有 task 没完成、写在这里、并说明原因（让用户在 ack 时决策是 revise 还是放过去）。

- T5 未完成：依赖后端接口字段未确认（见 plan artifact「待澄清 / 不确定项」#2）、改用 mock 提交、待联调
- 偏离 plan #1：plan 指示在 `BaseDialog` 上派生新组件、实际发现仓库已经有 `PromoteDialog` 历史残留、复用而不是新增、避免重复

## 修改记录

> **何时写本段**：仅当用户 ack 时点「再聊聊」后、按用户反馈做了修正——追加到本段。初稿走 happy path 整段省略（不写空标题）。
> 详细格式 / 禁项见「跨 action 共享规范 §5.1 build / review / ship action」。

### 修改 1：<一句话标题（25 字以内）>

- **用户反馈**：<feedback 原话核心语义、20 字以内>
- **改动文件**：
  - `apps/cp-class-advisor-center/src/views/mainHome/selList.vue:271-279`
  - `packages/tch-sc/src/components/PromoteTaskDetail.vue`
- **概要**：1-2 句说明改了什么、为什么改

### 修改 2：...
```

## 几条要点

- **改之前先读**：每个文件改之前先 `read` 完整看一遍、不要凭印象改
- **小步走、改一个 task 跑一次局部 lint**：避免大堆错误堆到最后才发现
- **保持仓库风格**：缩进、命名、import 顺序、注释风格 → 全跟周围现有代码一致
- **不发明 import 路径**：用 `grep` / `read` 确认 import 路径真存在
- **TypeScript strict**：仓库一般开了 strict、不要写 `any`（除非局部有非常充分的理由）
- **不写无信息密度的注释**：「调用接口」「返回 null」这种废话注释不要加。中文注释、解释「为什么」不解释「是什么」
- **跑 shell 慢的命令**：`pnpm install` / 全量 build 可能耗时几分钟、agent 不要因为「等太久」就放弃、shell 工具有 timeout 参数、合理放宽
- **写完 → 直接调 wait_for_user**：不要在 assistant_message 里说「我改完了你看下」之类的话
- **绝对不自动进入下一 action**：build 拿到 [ACTION_ACK approve] 后立刻 wait_for_user 等下一 action 指令、不要自己跑 review / ship——下一 action 类型由用户在 UI 选
