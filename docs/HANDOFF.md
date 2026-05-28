# fe-ai-flow Handoff

> **权威源**：代码 + 本文件。其余 docs/*.md 为辅助、有冲突以代码 + 本文件为准。

## 项目定位（一句话）

站在 Cursor SDK 肩膀上的**项目级 AI Harness 平台 · 飞书 story → MR 自动化**。核心是 Harness（缰绳）：每个 action 边界用确定性工具（typecheck / lint / git diff hash / HITL ack）压住 LLM 非确定性、保证产出可观测、可回退、可复用。

## 给 AI 接力的最小上下文

按顺序读：

1. `.cursor/rules/project-context.mdc` —— 强制约束
2. `.cursor/rules/learned-conventions.mdc` —— 编码风格
3. 本文件「当前架构快照」段（V0.6 系列、稳定架构）+「最近演进」段
4. `prompts/_super.md` —— super-prompt 主模板（V0.6 改造、注入 7 种 action prompt + action history）
5. `prompts/_shared.md` —— 跨 action 通用 artifact 写法 + 跨 action 规则
6. `prompts/action-plan.md` / `action-build.md` / `action-review.md` —— V0.6.0 已实装 action 的特有约束（ship/test/learn 是 stub、待 V0.6.1+）
7. `src/lib/server/task-runner.ts` —— V0.6 统一 runner（V0.5 plan-runner + chat-runner 合一）
8. `src/lib/types.ts` —— V0.6 schema（Task / ActionRecord / RepoStatus / RunStatus 等）
9. `docs/CHANGELOG.md` —— 历史演进档案（V0.2 ~ V0.5.16-design）、想看某条早期变更细节再翻

## 代码层面要点

### 强制

- 思考和回复永远用中文
- 每次对话操作前唤起 `cursor-feedback` MCP、timeout 600 秒
- 代码改完跑 `pnpm typecheck` + `pnpm lint`（用户对低级错误零容忍）
- 开发期不要写向后兼容代码

### 编码约定（详见 `.cursor/rules/learned-conventions.mdc`）

- UI 组件统一用 shadcn/ui、不要手写原生 element
- 函数声明统一用箭头函数（除了第三方 / Next.js default export）
- 注释中文、解释"为什么"而不是"做什么"
- 每个 useState / useRef / useMemo 跟一行短注释

---

## 当前架构快照（V0.6 系列、稳定）

> 本段只描述「现在的代码是这样组织的」、不带版本号迭代细节。版本演进史看 `docs/CHANGELOG.md`。

### Task 容器 + Action 历史模型

V0.5 phase chain（`plan → build → review`、固定顺序）已废弃、改为 **task 容器 + action 历史**：

- **task** = 单个需求生命周期容器、多 MR / 多次推进、终态 `merged` / `abandoned`
- **action** = 单次动作（plan / build / review / ship / test / learn）、任意触发、不强制顺序

```
新建 task → 推进 plan (#1) → ack → 推进 build (#2) → ack → 推进 review (#3) → ack
        → 推进 build (#4) 修 bug → ack → 推进 review (#5) → ack → ... → 终结 merged
```

每条 action 落一个 artifact：`data/tasks/<id>/actions/<n>-<type>.md`、N 单调递增不复用、按时间正序。

### 两套 task mode：task / chat

`Task.mode` 区分两种使用形态、入口都是首页「新建任务」dialog 顶部 tab：

| mode | 用途 | UI | runner | 必填字段 |
|---|---|---|---|---|
| `task` | 正经需求、走 action 容器 | 三栏 ResizablePanelGroup（左 timeline + 中 artifact + 右 event stream） | `task-runner.ts` + `_super.md` 注入 7 action prompt | title、repoPaths、feishuStoryUrl |
| `chat` | 跟 AI 临时聊（答疑 / 探索 / 思路碰撞、不走完整流程） | 单栏 `ChatView`（顶部 bar + event stream + 输入框） | `chat-runner.ts` + 极简 prompt（只装 wait_for_user + shell long-poll） | 全选填、空 title 自动补「未命名对话 MM-DD HH:mm」 |

两套通路完全独立、不共享 runner / prompt / 推进 dialog / advance API。chat 模式 task 入 `/api/tasks/[id]/chat-reply`、task 模式 task 入 `/api/tasks/[id]/advance` + `/action-ack`。`advance` route 防御性 reject `task.mode === "chat"` 的请求。

### 双状态：repoStatus + runStatus

V0.5 单 `status` 字段（draft / running / awaiting_user / completed / failed）拆成两个独立维度：

| 字段 | 含义 | 取值 |
|---|---|---|
| `repoStatus` | 任务对仓库的业务状态 | `developing` / `awaiting_test` / `has_bug` / `merged` / `abandoned` |
| `runStatus` | agent 运行时状态 | `idle` / `running` / `awaiting_user` / `error` |

UI 卡片 / 详情页头部分两个 badge 显示。

### V0.6.0.1 已实装 vs stub

仅 `task.mode === "task"` 走下表的 action 体系；`chat` 模式独立通路、不在此表。

| Action | 状态 | 准入条件 | 后置 deterministic check |
|---|---|---|---|
| plan | ✅ 已实装 | 永远可 | artifact 存在 + 内容长度 >= 100 |
| build | ✅ 已实装 | 至少 1 个 plan completed | `pnpm typecheck` + `pnpm lint` + git status 有改动 |
| review | ✅ 已实装 | 至少 1 个 build completed | 4 类差异段非空 + git hash 一致 |
| ship | 🚧 V0.6.1 | 至少 1 个 build | （未实现） |
| test | 🚧 V0.6.2 | 至少 1 个 build | （未实现） |
| learn | 🚧 V0.6.3 | `repoStatus = merged` + 整 task 只跑一次 | （未实现） |

stub action 的 prompt 文件存在（V0.6.1+ 设计草稿）、UI 推进 dialog 灰掉、runner 准入拒绝。

### 单 SDK Run 永生

整 task 跑在**同一个 SDK Run** 里、不一个 action 一个 Run：

- 用户每次「推进」action → runner 写 `[NEXT_ACTION ...]` 给 agent
- agent 跑完 action → 调 `wait_for_user(action_id)` → runner 把 action 标 `awaiting_ack` + 跑后置检查
- 用户 ack → wait-ack 写 `[ACTION_ACK approve|revise]` → agent 接着调 `wait_for_user(待命态)` 等下一指令
- 终结 task → finalize 路由写 `[TASK_DONE]` / `[TASK_ABANDONED]` → agent 自然退出 Run

agent 永远不会主动 emit assistant_message + exit Run、只通过 wait_for_user 把控制权交回用户。

### 保活机制：shell + curl long-poll（V0.3.5 沿用）

```
agent 调 wait_for_user / ask_user
  → MCP 工具立即返回 shell 引导文本
  → agent 用 SDK shell 工具调 curl -sN <base>/api/tasks/:id/wait-ack?token=…
  → 长 HTTP 连接挂住、服务端每 60 秒 write 一行 [KEEPALIVE ts=...]
  → 用户 ack/reply / next_action / terminate → 服务端 resolve promise → 写一行结果 → 关流
  → curl exit → agent stdout 拿到结果推进
```

**不**走 MCP 60s timer + 轮转——会踩 Cursor backend anti-loop。

### 推进 dialog（V0.6 重写）

用户从「推进」按钮打开 dialog、选下一个 action 类型 + 写指令：

- **action 类型卡片**：4 个实装 + 3 个 stub、不满足准入条件灰掉 + hover 提示
- **推荐项**：按 `inferRecommended(task)` 推断（无 action → plan / 最近 plan completed → build / has_bug → build / merged → chat）
- **placeholder 动态**：按 action 类型 + task 状态变（has_bug + build → 「修哪个 bug」/ 首次 plan vs 再次 plan 不同）
- **forceNewAgent**（高级）：默认 false、勾上时 cancel 旧 Run + 起新 Agent（耗 +1 send 配额）

### Ack：approve / revise（V0.6 简化）

V0.5 「通过 PHASE 高级配置 dialog」（切模型 / 换 agent）拆掉、ack 路径简化：

- **通过**：顶部「通过」按钮 → submitActionAck("approve") → 同 agent 接着等下一指令
- **再聊聊（revise）**：「再聊聊」按钮 → ReviseDialog 写 feedback + 可选附图 → submitActionAck("revise", feedback, images) → 同 agent 改 artifact

切模型 / 换 agent 现在统一在「推进」dialog 的高级选项里、ack 路径不再支持。

### 6 个 Harness 门槛（V0.6 核心）

V0.5 phase 顺序拆掉后、用 6 个显性门槛补回保证：

| 门槛 | 实现 | 位置 |
|---|---|---|
| 1. action 前置准入 | runner `checkActionPrerequisites` + UI dialog 灰掉 | `task-runner.ts` + `advance-dialog.tsx` |
| 2. action 后置 deterministic check | runner 切 awaiting_ack 前跑、写 `action.postCheck` | `action-checks.ts` |
| 3. 推荐 default | UI 按 task 状态推断 | `advance-dialog.tsx: inferRecommended` |
| 4. action 级 anti-patterns prompt | 每个 `prompts/action-<type>.md` 头部红线段 | `prompts/action-*.md` |
| 5. cross-action 一致性自检 | V0.6.4+ 再做 | - |
| 6. placeholder 动态 | UI 按 action + task 状态变 | `advance-dialog.tsx: buildPlaceholder` |

### Git Branch 自动建（V0.6 新）

build action 第一次跑前、runner 拼 `GitBranchInfo` 落库、prompt 头部追加 branch checkout 引导：

```
feature/<settings.username>/<飞书 story id>-<task.title 转换后>
```

agent 用 SDK shell 跑 `git checkout -b ...`、checkout 成功后再做 build 实施。base branch 取自 `settings.repos[i].mainBranch`（不填走 agent 探测 `origin/HEAD` fallback）。

没填 username / feishuStoryUrl 时不建 branch、走 fallback。

### 文件系统改造

```
data/tasks/<id>/
  meta.json          # V0.6 schema：actions[] / mrs[] / repoStatus / runStatus / mode
  events.jsonl       # 同 V0.5
  actions/           # V0.6 改：artifacts/ → actions/
    1-plan.md
    2-build.md
    3-review.md
    .revisions/      # 用户 revise 前的 snapshot、按 actionId 分子目录
      <actionId>/<ISO>.md
```

chat 模式 task 只用 `meta.json` + `events.jsonl`、不写 `actions/`（没有 artifact 概念）。

V0.6 不写 V0.5 → V0.6 migration 脚本、`listTasks` / `getTask` 用 `isValidMetaShape(raw)` 校验 schema、不匹配的 meta.json 直接 skip（开发期数据清空、本机 `rm -rf data/tasks/*` 即可）。

### 多角色 schema（V0.4 沿用）

`Task.role: TaskRole`（当前仅 `"fe"`、未来扩 `be / data / mobile / qa`）、`TASK_ROLE_LABEL` 中文映射、prompt 顶部「当前角色：xxx」提示。

### 多仓库 cwd 公共父目录（V0.5.9 沿用）

`Task.repoPaths: string[]`、SDK Run `local.cwd = getEffectiveCwd(repoPaths)`：

- 单仓 → cwd = 仓自身
- 多仓 → cwd = 公共父目录、AI 视角下挂 N 个 git 子仓、路径首段是仓名
- 0 仓 → cwd = home（纯探索 / 答疑场景）

### Resizable 分栏 + Diff 视图（V0.5.10 + V0.5.12 沿用）

任务详情页主区：左 `ArtifactPanel`（当前 selected action）+ 右 `EventStream`、可拖动、持久化在 `task.uiLayout.artifactPanelSize`。

ArtifactPanel toolbar 加「正文 / Diff」切换、`fetchActionRevisions` / `fetchActionDiff` API（V0.5.12 接口同款、key 改 actionId）、有未看 revision 时 Diff 按钮挂红点。

### Skills loader（V0.5 沿用、V0.6 不动）

`src/lib/server/skills-loader.ts` 加载 `<repoPath>/.cursor/skills-*/*.md` + `~/.cursor/skills-*/*.md`、注入到 super-prompt。

---

## 最近演进（窗口式、保留 2 个子版本）

> 写入规则：新子版本完成后在本段顶部追加、超过 2 个时把最老的迁到 `docs/CHANGELOG.md`。

### V0.6.0.1：自由对话模式剥离 + 后置检查体验整改 + 推进时换模型（2026-05-27 / 2026-05-28）

**整体**：用户实测 V0.6.0 发现十个体验断点、本子版本修：(1) action=chat 跟 task 容器混用导致 agent 行为漂（用户问「你好啊」、agent 当成 plan 流程闷头思考调工具）、(2) action 完成后事件流把 deterministic 后置检查的 details 一坨贴出来（用户原话「这更像是调试内容」）、(3) plan 后置检查 V0.5.6.5 黑名单 grep 把「示例 / 或」等业务高频词误报、用户拍板「方案太粗暴、不是有效约束、直接删」、(4) 中途加过 ActionTimeline 失败 chip 的 retry 快捷入口、实测语义混乱（点旧 error chip 反而打断当前 running、起一个全新 action）、用户拍板砍掉、(5) 强制起新 agent 时没法临时换模型、只能去 settings 改全局、本版加 ModelPicker、(6) 多次推 plan / build 后时间线所有 chip 同等显著、看不出哪个是「当前生效版本」、stale 版本视觉降权、(7) review 发现偏差后 edit plan 的 strikethrough 留痕方案 prompt 高摩擦（5 子点 + 位置铁则、agent 经常踩坑）、简化为「原描述不动 + 章节末尾追加 blockquote」唯一姿势、(8) advance dialog 卡片上的「推荐」微标签语义草率（has_bug→build / plan→build 这种「流程顺推」也叫推荐显得 AI 在 narrate）、删微标签 + 删「error→同 type」那条 retry 残留 + 函数重命名为 `inferDefaultActionType`、保留默认选中作为「减少首次点击」的 UX 工具、(9) review artifact 里写「`actions/5-plan.md` §1」点击被当业务仓库路径跳 Cursor、报「找不到文件」、修 `looksLikeArtifactRef` 让它能识别 `actions/N-type.md` 这种带前缀的形式、命中后走 task 内 tab 跳转、(10) review 表格备注「同上：244-248」省略文件名导致整列点不开、`_shared.md §3` prompt 加严禁用「同上 / ↑ / ditto」类简写、表格 row 同一文件多个引用强制合并到一行用顿号分隔。`pnpm typecheck` ✓ / `pnpm lint` ✓。

#### chat 从 action 体系剥离 → 独立 mode

V0.6.0 把 V0.5 的 chat-runner 砍了、chat 吸收为 `action=chat`、用户反馈「自由聊全是问题」（agent 不回 / 走任务式公文体 / 暴露协议细节）。本版本 revert 这个决定、回到 V0.5 心智、但用 V0.6 schema 字段：

- `Task.kind` → `Task.mode`（`"task" | "chat"`、入口在新建任务 dialog 顶部 tab）
- `ActionType` 删 `"chat"`、改回 6 种：`plan / build / review / ship / test / learn`
- 新增 `src/lib/server/chat-runner.ts`：独立 runner、独立极简 prompt（只装 `wait_for_user` + shell long-poll 引导、没有 [NEXT_ACTION] / [ACTION_ACK] / [TASK_DONE] 概念）、agent 启动后第一句直接回应用户、然后 `wait_for_user` 等下一条
- 新增 `src/components/tasks/chat-view.tsx`：单栏 UI（顶部 bar + event stream + 输入框）、内部自己订阅 `useTaskWatch`、task page 按 `task.mode === "chat"` 分支渲染
- 新增 `/api/tasks/[id]/chat-reply`：处理用户消息、`runStatus === awaiting_user` 时 `submitUserMessage` 续接、idle / error / completed 时 `runChatSession` 重启 Run、收到消息立刻写 `user_reply` 事件（避免「我的你好啊没在聊天上」的体验问题）
- 新建任务 dialog：顶部 ChoiceButton tab 切换 task / chat、chat 模式 title / repoPaths / feishuStoryUrl 全选填、空 title 自动补「未命名对话 MM-DD HH:mm」
- 删 `prompts/action-chat.md`、`_super.md` 移除 chat action 段 / 例外规则 / placeholder
- 首页删「快速聊」按钮、统一从「新建任务」入

agent 永远不在 chat 模式 prompt 里看到 [NEXT_ACTION] / [ACTION_ACK] 这些概念、自然不会公文体；`ask_user` 在 chat-runner prompt 显式禁用、agent 想确认就直接 `assistant_message` 问。

#### action 失败后 retry 入口：加过、用户实测后砍掉

V0.6.0.1 中段试过给 `ActionTimeline` 的失败 chip 挂 🔄 retry 按钮、点了打开 advance-dialog、预填 actionType + `forceNewAgent=true`。意图是让 agent 从「Run 挂了 / 错误状态」状态更顺地恢复。

用户实测后反馈语义混乱：

- ActionRecord 是不可变历史、`appendAction` 永远追加新 `n`、不会改老条目
- 所以点旧 `error` chip retry、实际效果 = 「打断当前正在跑的 action」+「起一个新 action（n+1）」、跟用户直觉「修复那条历史」差太远
- task.runStatus = error 时、顶部「推进」按钮本身就是亮的、用户走标准推进 + 勾「强制起新 agent」开关即可恢复、retry chip 是冗余入口
- 多条 error chip 都长得能点、用户在「当前还在跑」时手抖点旧 chip 会把跑得好好的 agent 撞死

最终砍掉：

- `ActionTimeline` 去掉 retry icon + `onRetryAction` prop
- `page.tsx` 去掉 `advancePrefill` state + retry 触发回调
- `AdvanceDialog` 去掉 `initialActionType` / `retryHint` props + 顶部红条提示
- 「强制起新 agent」开关在 advance-dialog 保留、这才是真正从错误恢复的官方路径

教训：**UI 上额外的「快捷入口」不一定省事**——如果背后语义跟入口看起来要做的事不一致、用户会被绕进去。retry icon 看着像「修复这条」、实际是「再起一条」、两层语义冲突、宁可砍。

#### 强制起新 agent 时支持换模型 + 抽 ModelPicker 共享组件

V0.6.0 推进只能用 `task.model` / `settings.defaultModel`、想给某个 task 在不同阶段配不同模型（plan 用 opus 想得清、build 切 sonnet 省 token）只能去 settings 改全局再回来、麻烦且会影响别的 task。

本子版本末段在 `AdvanceDialog` 顶部「强制起新 agent」开关下面加了一段 `ModelPicker`：

- 开关 off：保持原行为、续接 Run、走 `task.model`
- 开关 on：露出 ModelPicker、默认值 = `settings.defaultModel`、用户可以临时换 base + 调 `thinking` / `effort` 等 params
- 提交时把 selection 透传给 `handleAdvance`、`/api/tasks/[id]/advance` body 的 `model` 字段用这个、不改 `task.model`（一次性、不污染 task 级 / 设置页全局）
- 续接 Run 时 SDK 不支持中途换模型、所以 dialog 里这段在 off 时直接隐藏、避免误以为「不开关也能改」

配套抽出 `src/components/ui/model-picker.tsx` 作为 base + parameters 双层 select 的纯 UI（不带 Card / SaveButton 包裹）、`settings/model-card.tsx` 和 `advance-dialog.tsx` 都 wrap 一层用、保证设置页和推进 dialog 行为一致——切 base 自动填默认 params、`thinking` 这种 false/true 参数显示成「关 / 开」等。符合编码约定「典型 UI 组件即使当前只有 1 个 caller 也应该抽到 `src/components/ui/`」、虽然 new-task-dialog 目前只用了 base id 没用 params、本次没急着改它、未来若想让新建任务也调 params、直接换 ModelPicker 即可。

#### 后置检查 details 不再 publish 到事件流

V0.5 / V0.6.0 在 action 切 `awaiting_ack` 时、把 `runActionCheck` 的 `details` 整段拼成一条 `info` / `error` 事件写进事件流。这套对开发期调试有用、但用户视角下：

- plan 这种「策略层」检查容易误报、用户看到一坨「artifact 出现 2 处不确定字眼」会困惑
- 真出问题（typecheck 红、lint 红）的细节也不应该塞在事件流里、agent 自己在下次 revise 时会读 `action.postCheck` 字段去修

本子版本改为：

- `task-runner.ts` 不再把 `postCheck.details` 拼进事件 text、只写一句简版「Action 产出完成、等待用户 ack（artifact=...）」
- `kind` 永远 `info`（不因 postCheck 失败标 `error`、避免红色卡片）
- `action.postCheck` 字段照样落到 `meta.json`（数据完整、想 debug 直接看文件、或后续 UI 加「调试信息」折叠面板）
- console.log 加上 `details` 截断 200 字符的输出、本地开发能从 server log 看到

#### plan 黑名单 grep 彻底删（2026-05-28）

V0.5.6.5 加过一组 13 字眼黑名单（或 / 约 / 大约 / 大概 / 可能 / 应该是 / 待定 / TBD / 暂定 / 节选 / 示例 / 部分 / 后续补全）、artifact substring 命中即 ❌、配套 `_super.md` 强制自检让 agent 自己 grep 一遍。**意图**：防 agent 写 plan 时用含糊词糊弄、build 阶段按模糊 plan 写代码会飘。**问题**：substring 不看语境、对「示例」（表格列名）、「或」（业务规则明确 or）等高频业务词误伤率高、V0.6.0.1 实测 2 条命中全是误报。**用户拍板**「方案太干脆简单了、不是个有效的方案、直接删掉、后面再考虑长远的」。

本子版本删 4 处：

- `src/lib/server/action-checks.ts`：删 `PLAN_BLACKLIST_TOKENS` 常量 + `checkPlan` 第 2 步黑名单 grep 逻辑、plan postCheck 退化为「artifact 文件存在 + 内容长度 >= 100」最低门槛
- `prompts/action-plan.md`：「后置检查」段 1. 黑名单 grep 那条删、「⛔ 严禁带不确定表述写 artifact」段的「黑名单字眼」子条删（语义引导整段保留——「不确定 → ask_user 拍板」「节选 / 示例类偷懒」反例都还在）
- `prompts/_super.md`：「写完 artifact 强制自检」段从 4 步缩成 3 步（黑名单 grep 那步删、保留业务名词全称扫 / ack 留痕位置 / 路径完整性）
- `src/lib/types.ts`：`ActionRecord.postCheck` 注释 plan 行改成「artifact 文件存在 + 内容长度 >= 100」

后续替代方案（**未做、留给将来**）：语义层质量靠 ⛔ artifact 段硬约束 + 用户人眼把关 + revise 兜底。如果以后还想做 deterministic、考虑「语义 diff（plan 跟 contextDocs 信息差）」「agent 自检 ask-LLM」等更靠谱方向、别再凑字符串。

#### `actions/N-type.md` 路径识别 hot-fix（review artifact 引用别的 action）

用户实测发现 review artifact 里写 `actions/5-plan.md §1` / `actions/5-plan.md §2.2` 这种 plan 位置引用、点击后跳 Cursor IDE 报「找不到文件」。

根因：`src/lib/path-utils.ts:looksLikeArtifactRef` 的 regex 是 `^(\d+)-([a-z]+)\.md$`、只能识别**不带任何前缀**的 `5-plan.md`。review agent 按 prompt 强约束写「actions/N-type.md」相对路径形式（_super.md「Artifact 文件路径」段、所有 artifact 互引都这么写）、不命中 `looksLikeArtifactRef`、退化到 `looksLikePath` 命中（含 `/`、最后一段 `plan.md` 有扩展名）、被当业务仓库路径走 `cursor://file/<repoPath>/actions/5-plan.md`、Cursor 找不到自然报错。

修：regex 改成 `^(?:actions\/)?(\d+)-([a-z]+)\.md$`、加可选 `actions/` 前缀；长度上限同步从 50 提到 60（多 8 个字符的前缀）。命中后渲染 / 跳转链路不变（蓝色按钮 → onArtifactRefClick → 切到目标 action panel）。

**仅识别 `actions/N-type.md` 这种相对前缀**——`data/tasks/xxx/actions/5-plan.md` 这种 fs 绝对路径不命中、保留走 `looksLikePath` + cursor:// 跳转兜底（不知道是不是 agent 写错路径、不该 task 内跳）。

#### prompt 加严：表格里不准用「同上 / ditto / ↑」类简写

紧挨上面 hot-fix——review artifact「plan 拍板口径复核」表格 row 1 写了完整 `tch-service-center/src/views/.../DetailDrawer.vue:93-95`、row 2-N 全写「同上：90」「同上：244-248」省略文件名。表格列空间有限、agent 偷懒挤一行、但用户拿这些 path 是要点击跳转的——「同上」不是 inline code、前端的 `looksLikePath` 自然识别不出来、整列全失效。

`prompts/_shared.md §3` 加严：

- **规则段加第 6 条**：明确「严禁同上 / 同前 / ↑ / 上同 / ditto 类省略词」、给出 fallback（同一文件多个引用合并成一行用顿号分隔多个 `path:line`）
- **反例段加一条 V0.6.0.1 实测的真实截图原文**：`review 表格备注：「同上：90」/「同上：244-248」/「↑ 同前」 ← V0.6.0.1 实测、表格 row 用「同上」指代上一行的文件名、用户没法点击跳转`
- 原反例里 `← 同上` 这种 inline 标注同步改成「← 没目录前缀」、避免「反例里也写同上」的歧义

reviewer agent 跑 V0.6.0.1 之后的下一份 review 时观察是否还会偷懒——如果继续踩、再考虑 review prompt 单独加显式说明。

#### 删 advance dialog「推荐」微标签 + 清掉 retry 在推断逻辑里的残留

V0.6.0 advance dialog 卡片右上角挂了一个「推荐」微标签（`type === recommended && !reason && <span>推荐</span>`）、底层逻辑 `inferRecommended(task)`：

- repoStatus = has_bug → build
- repoStatus = merged → plan（V0.6.3 起改 learn）
- 无 action → plan
- 最近 completed action：plan → build / build → review / review → plan
- **last action 是 error → 同 type**（V0.6.0.1 中段加的 retry 兜底）

用户实测后嫌「推荐」二字过重——「这个推荐逻辑太草率了太简单了、没什么意义」。逻辑本身其实是「业务状态映射 + 流程顺推」、谈不上智能：

- has_bug → build 是「业务状态决定」、不是推荐
- plan → build 是「下一步常识」、不是推荐
- 标了「推荐」反而暗示「我跟你说要走这个」、自抬身价、误导用户「这条路有什么特别理由」

V0.6.0.1 末段拍板：

- **删 UI 微标签**：`<span>推荐</span>` 整段渲染逻辑去掉、卡片右上角空着
- **删 last error → 同 type 那条**：跟「砍 retry 入口」的精神冲突（错误后不该让 dialog 默认走「再来一次」、用户应该手动决策要不要换 type）、删掉之后 error 状态默认仍走流程顺推
- **重命名 `inferRecommended` → `inferDefaultActionType`**：消除「推荐」二字的语义、明确这是「dialog 打开时默认选哪个 chip」、纯 UX 工具
- **保留默认选中本身**：dialog 打开时仍有一个 chip 是 selected、按上面 5 条逻辑算、用户每次省一次点击；这跟「推荐」不是一回事、是「初始焦点」

`new-task-dialog.tsx` 顶部注释里「任务（推荐）」也顺手清成「任务」、跟「不站队」语义一致。`action-timeline.tsx` 注释里提到「智能推荐」也改成「按 task 状态选默认 chip」。

涉及文件：`src/components/tasks/advance-dialog.tsx`（删 UI span + 改函数名 + 改 useState 变量名 + 改注释 + useEffect 依赖跟着改）、`src/components/tasks/new-task-dialog.tsx`（注释字面）、`src/components/tasks/action-timeline.tsx`（注释字面）。

#### review 改 latest plan 留痕策略简化（strikethrough → 末尾 blockquote）

V0.5.12 起 review action 走 §6 ask_user 闭环时、用户答 b（接受偏差并更新 plan）→ review agent 用 `edit` 改最新 plan artifact、`prompts/action-review.md` §6.2 b 写了 5 个子点 + blockquote 位置铁则：

- 段落 / 单层 list item 改 → `~~strikethrough~~ 新描述（review ack 补录、原计划 X）`
- 表格 cell 改 → 直接改新值 + 表末加 blockquote
- 嵌套 list item 改 → 上层字符串用 strikethrough、子 list 整体变更用 blockquote
- 反例若干 + blockquote 位置铁则（不能插表格行间 / list 项间 / 要留空行）

实测踩坑率高：

- agent 把 strikethrough 塞表格 cell 里破坏列对齐 + markdown 不渲染
- blockquote 插表格行之间、表格断成两段
- 嵌套 list 改时上下层位置拿不准、prompt 5 个子点反而越看越乱

V0.6.0.1 用户拍板「我们走敏捷开发、后面发现问题再说」+ 视觉焦点心智（latest plan = 用户在关注的、review 改它合理）下、prompt 简化为**统一一种姿势**：

- **原描述绝对不动**（保持 stale 之前那一刻的字面原文不变）
- 在**被改章节末尾**追加 ⚠️ blockquote、格式固定 2 行：

  ```
  > ⚠️ review #N 补录：原「<原描述 ≤ 25 字>」、build 跳 plan 上、改为「<新描述 ≤ 25 字>」。
  >    原因：<build agent 原因 / N/A>。详见 actions/N-review.md §用户决策 → 偏差 X。
  ```

- 位置铁则简化为 3 条：紧贴下一级标题前、留一空行；绝不插表格行间 / list 项间 / 被改字段那一行后面；多条按时序往末尾叠加、不合并

骨架「§ 用户决策」段例子同步重写、**强制要求贴「改前 / 改后片段」**（包含被改章节原文 25 字摘录 + 完整 blockquote 原文）、用户在 review artifact 一个文件能看清楚 plan 改了什么、不用切 tab 对照 plan diff。

未做（敏捷迭代留观察）：

- 同一 latest plan 被 review 修订 N 次的阈值提醒
- ArtifactPanel 加「快看 latest plan」按钮（ArtifactPanel 已支持选 chip 切 artifact、加专用按钮过度设计）
- `_shared.md §8`「review 例外可 edit plan」那条保留不动、与 Z' 思路一致

#### Action timeline stale 视觉降权

V0.6.0 时间线上所有 action chip 同等显著、只有 `currentActionId` 加一圈 ring。多次推进同 type（plan #1 → plan #3 / build #2 → build #4）后、用户看不出哪个 chip 是「当前生效版本」、哪些是「已被新版本取代的历史快照」、artifact 切回历史版本只能凭 n 大小硬记。

`src/components/tasks/action-timeline.tsx` 加 `computeLatestByType` helper、按「同 type n 最大的算 latest、其他都 stale」算 isStale：

- **stale chip**：`opacity-50 + text-muted-foreground`、状态点本身也淡化（不再用 `bg-emerald-500` 这种饱和色撞眼）
- **latest chip**：正常颜色、有 `currentActionId` 加 ring 高亮
- **hover title**：stale chip 后缀「（已被 #N type 取代）」、用户能确认是被哪个新版本顶掉
- **可点性不变**：stale chip 仍可点选中、ArtifactPanel 切到历史版本读 artifact 不受影响

跟 status 解耦——error / cancelled chip 在 stale 时同样淡化、不再用 status 跟 stale 双重打架。视觉表达原则：「opacity 表达时间维度（旧版本被取代）、status 点颜色表达本次执行结果」。

注意没引入「latest 但 status === error」的特殊外圈、跟原有视觉一致：状态点的红色已经能把 error 顶到顶层注意力、不需要再叠 ring。

**hot-fix（V0.6.0.1 末段、用户反馈 ring 视觉读不出意图）**：`isCurrent && !isSelected` 那圈 ring 用户 hover 完才反应过来是「当前 action」、看着像 hover 残留态。chip 的 title 由「单一信息」改成「多状态拼装」、把 isCurrent / isStale 各自的语义都拼进圆括号——例如「#8 复核 · 等用户确认（当前 action、点可跳回、已被 #9 取代）」——hover 一眼看清楚多个修饰来源、不用猜。

#### 不做的事

- chat 模式 task 不写 `actions/` 目录（没有 artifact 概念）
- chat 模式 task 不能走「推进」dialog、`advance` route 防御性 reject `task.mode === "chat"`
- 不写 V0.6.0 → V0.6.0.1 migration（开发期 / 本机清 `data/tasks/*` 即可）

### V0.6.0：核心重构（2026-05-27）

**整体**：按 `docs/V0.6-REFACTOR.md` 落地核心模型重构。从 phase chain 切到 task 容器 + action 历史、动了 30+ 文件、删 4 个旧路由 + 4 个旧组件、新增 ActionTimeline 等组件。V0.5 兼容代码 / 数据彻底删（不写 migration、开发期清空 data/tasks/*）。`pnpm typecheck` ✓ / `pnpm lint` ✓。

#### Day 1：Schema + Runner 骨架

- `src/lib/types.ts` 大改：ActionType / ActionStatus / RepoStatus / RunStatus / ActionRecord / MRRecord / GitBranchInfo 加入；V0.5 LegacyPhaseId / LegacyTaskData / task.legacy 等类型彻底删
- `src/lib/server/task-fs.ts` 大改：appendAction / patchAction / setTaskRepoStatus / setTaskRunStatus / snapshotActionArtifact 等 V0.6 API；isValidMetaShape 取代 isLegacyMeta（不匹配的 meta.json 直接 skip、不再 hydrate 老 task）
- `src/lib/server/task-runner.ts` 新增：整合 plan-runner + chat-runner、统一 advanceTask / acknowledgeAction / finalizeTask
- `src/lib/server/chat-mcp.ts` 大改：phase_* → action_*、submitNextAction / submitTaskTerminate 新增

#### Day 2：Prompt 重组

- `prompts/_super.md` 大改：一次性注入 7 种 action prompt + action history + first NEXT_ACTION 指令
- `prompts/_shared.md` 中改：phase → action 字眼、跨 action 一致性约束
- `phase-1-plan.md` → `action-plan.md`、`phase-2-build.md` → `action-build.md`、`phase-3-review.md` → `action-review.md`、骨架沿用 V0.5.15 改完版本、加准入 / 后置 / anti-patterns 段
- `action-ship.md` / `action-test.md` / `action-learn.md` / `action-chat.md` 新建（前 3 个是 V0.6.1+ 设计草稿、stub）

#### Day 3：UI 改造

- 删 `chat-view.tsx` / `phase-progress.tsx` / `approve-phase-dialog.tsx`（V0.6 不需要）
- 删旧路由：`start-workflow` / `phase-ack` / `chat-reply` / `watch-chat` / `artifact-revisions` / `artifact-diff`
- 新增路由：`advance` / `action-ack` / `finalize` / `watch-task` / `action-revisions` / `action-diff`
- `task-card.tsx` 重写：双状态 badge + 最近 action 简略
- `new-task-dialog.tsx` 重写：删 mode、全字段选填
- `advance-dialog.tsx` 重写：选 action 类型 + 用户指令 + forceNewAgent
- `action-timeline.tsx` 新增：横向 chip + 状态点
- `artifact-panel.tsx` 重写：接收 ActionRecord + 异步加载 content
- `task page` 重写：删 chat-view 分支、单一布局
- V0.5 兼容代码彻底删（LegacyTaskView 没保留、hydrateTaskLegacy 删、各路由 task.legacy 守卫删）
- `revise-dialog.tsx` 适配：phaseLabel → actionLabel
- `event-stream` 系列适配：phase → actionId
- `settings/repo-card.tsx` 加 `mainBranch` 字段输入
- `settings/user-profile-card.tsx` 新增：`username` 字段

#### Day 4：6 个 Harness 门槛 P0+P1

- `src/lib/server/action-checks.ts` 新增：plan 黑名单 grep / build typecheck+lint+git status / review 4 类段 + hash 一致（plan 黑名单 V0.6.0.1 已删、详见上方）
- `task-runner.ts` 在切 awaiting_ack 前调 `runActionCheck`、写 `action.postCheck`
- `advance-dialog.tsx` 加 `inferDisabledReason` + `inferRecommended` + `buildPlaceholder`、推荐 / 灰掉 / 动态 placeholder 三件套

#### 关键设计决策（不要回头）

1. phase 顺序拆掉、action 任意触发
2. 单 task 多 MR、`Task.mrs` 列表追踪（V0.6.1 ship 上线时填）
3. chat 吸收为 `action=chat`、删 chat-runner
4. 单 SDK Run 永生（同 V0.5）
5. V0.6.0 实装 plan/build/review/chat、ship/test/learn 是 V0.6.1+ stub
6. 老 V0.5 task 只读、不写 migration

#### 没做的事

- ship / test / learn action 实际跑通（V0.6.1+ 分版本上）
- 门槛 5 cross-action 一致性自检（V0.6.4+）
- MR 状态 polling（V0.6.4+）
- learn 自动 cleanup（V0.6.4+）

---

## 关键文件索引

| 内容 | 位置 |
|---|---|
| **V0.6 重构设计文档（已 archived、V0.6.0 落地完成）** | `docs/V0.6-REFACTOR.md` |
| **V0.6 统一 runner（task 容器 + action history）** | `src/lib/server/task-runner.ts` |
| **V0.6 action 后置 deterministic check** | `src/lib/server/action-checks.ts` |
| **V0.6 task schema + 文件系统** | `src/lib/types.ts` + `src/lib/server/task-fs.ts` |
| **super-prompt 主模板（V0.6 改造、注入 7 action）** | `prompts/_super.md` |
| **跨 action 共享规范** | `prompts/_shared.md` |
| **plan / build / review action prompt** | `prompts/action-{plan,build,review}.md` |
| **ship / test / learn stub（V0.6.1+ 设计草稿）** | `prompts/action-{ship,test,learn}.md` |
| **chat 模式独立 runner（V0.6.0.1 新）** | `src/lib/server/chat-runner.ts` |
| **chat 模式 UI（V0.6.0.1 新）** | `src/components/tasks/chat-view.tsx` |
| **chat 模式 API** | `src/app/api/tasks/[id]/chat-reply/route.ts` |
| `wait_for_user` / `ask_user` 实现 + pendingMap | `src/lib/server/chat-mcp.ts` |
| wait-ack 长连接路由（保活核心） | `src/app/api/tasks/[id]/wait-ack/route.ts` |
| 推进 / ack / 终结 路由 | `src/app/api/tasks/[id]/{advance,action-ack,finalize}/route.ts` |
| watch-task SSE 路由 | `src/app/api/tasks/[id]/watch-task/route.ts` |
| Action revisions / diff 路由 | `src/app/api/tasks/[id]/{action-revisions,action-diff}/route.ts` |
| ContextDocsPanel（任务级上下文） | `src/components/tasks/context-docs-panel.tsx` |
| ask_user 弹窗（V0.3.2 沿用） | `src/components/tasks/ask-user-dialog.tsx` |
| 事件流主组件 + utils + rows | `src/components/tasks/event-stream{,/utils,/rows}.tsx` |
| Artifact 面板（V0.6 适配 ActionRecord） | `src/components/tasks/artifact-panel.tsx` |
| Artifact diff 组件 | `src/components/tasks/artifact-diff.tsx` |
| **Action timeline（V0.6 新）** | `src/components/tasks/action-timeline.tsx` |
| 推进 dialog（V0.6 重写、选 action） | `src/components/tasks/advance-dialog.tsx` |
| 再聊聊 dialog（V0.6 适配 actionLabel） | `src/components/tasks/revise-dialog.tsx` |
| 新建任务 dialog（V0.6.0.1 重新加 mode tab） | `src/components/tasks/new-task-dialog.tsx` |
| 任务卡片（V0.6 双状态） | `src/components/tasks/task-card.tsx` |
| 任务详情页（V0.6 重写） | `src/app/tasks/[id]/page.tsx` |
| 任务角色 schema + 展示文案 | `src/lib/types.ts: TaskRole / TASK_ROLE_LABEL` |
| 多仓 cwd / repoPaths 工具 | `src/lib/path-utils.ts: getEffectiveCwd / formatRepoSectionForPrompt` |
| Artifact ref / 文件路径渲染（V0.6.0.1 加 `actions/` 前缀支持） | `src/lib/path-utils.ts: looksLikeArtifactRef / looksLikePath / buildCursorLink` |
| 设置：username + mainBranch（V0.6 新增） | `src/components/settings/user-profile-card.tsx` + `repo-card.tsx` |
| 模型选择器共享组件（V0.6.0.1 抽出、settings + advance dialog 共用） | `src/components/ui/model-picker.tsx` |
| Skills loader | `src/lib/server/skills-loader.ts` |

## 设计变动流程

权威源 = 代码 + 本文件。设计层面变动：

1. **当前架构变动**（如 action 模型改、保活机制改、新增大组件）→ 改代码 + 同步更新本文件「当前架构快照」段
2. **小步迭代**（同主题连续 .1 / .2 / .3 微调）→ 改代码 + 写到本文件「最近演进」段顶部
3. **再老一轮时**（「最近演进」积压超过 2 个子版本）→ 把最老那段迁到 `docs/CHANGELOG.md` 顶部

⛔ 不要散落到其它 md 写一份新的演进段。
