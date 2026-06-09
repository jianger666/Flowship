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
6. `prompts/action-plan.md` / `action-build.md` / `action-review.md` / `action-ship.md` —— V0.6.1 已实装 action 的特有约束（test/learn 是 stub、待 V0.6.2+）
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

### V0.6.1 已实装 vs stub

仅 `task.mode === "task"` 走下表的 action 体系；`chat` 模式独立通路、不在此表。

| Action | 状态 | 准入条件 | 后置 deterministic check |
|---|---|---|---|
| plan | ✅ 已实装 | 永远可 | artifact 存在 + 内容长度 >= 100 |
| build | ✅ 已实装 | 永远可（V0.6.17 放开 plan 前置）| 无（V0.6.3 撤 build 后置检查、靠 review 兜底）|
| review | ✅ 已实装 | 至少 1 个 build completed | 4 类差异段非空 + git hash 一致 |
| ship | ✅ 已实装 | 至少 1 个 build + settings 配 GitLab Host + PAT | `task.mrs[]` 覆盖所有 repoPath（URL 非空） + 跳仓有原因 |
| test | 🚧 V0.6.2 | 至少 1 个 build | （未实现） |
| learn | 🚧 V0.6.3 | `repoStatus = merged` + 整 task 只跑一次 | （未实现） |

stub action 的 prompt 文件存在（V0.6.2+ 设计草稿）、UI 推进 dialog 灰掉、runner 准入拒绝。

### 大需求分批 build（V0.6.23 起、V0.6.24 打磨、可选）

plan 可把大需求在 §5 task 之上再分「批次」（`PlanBatch`、plan agent 调 MCP `set_plan_batches` 上报、落 `ActionRecord.planBatches`）。之后：

- **build 选批**：推进 build 时 advance-dialog 列批次让用户勾（**默认只勾「下一个未完成批次」**remaining[0] + 一键「全选」、已做的带角标）、`requestedBatchIds` 落到该 build action；runner `buildBatchDirective` 把「本次做哪批 + 测试策略 + 进度」拼进 `[NEXT_ACTION]` 的 `[BUILD_BATCHES]` 段；每批可「新启 Agent」换干净上下文（无 subagent 原语、用这个当等价物）
- **测试策略**：每批标 `TestStrategy`（tdd / after / none、自适应不强制、label「先写测试(TDD) / 实现后测试 / 免测」走 `TEST_STRATEGY_LABEL` 单一源）、build agent 按策略走（TDD 批用 `shell` 实跑仓库现有测试框架、先写测试看红 → 实现到绿；无测试设施则退化「正常实现 + artifact 写明该测什么」）
- **review 两层**：runner `buildReviewScopeDirective` 按派生进度注入 `[REVIEW_SCOPE]`——还有批没做 = 增量（聚焦新批 + 衔接）、全做完 = 集成（查批次间接口 / 数据流 / 重复实现 / 冲突）
- **进度纯派生**：`task-display.computeBatchProgress` 从 action 历史算「已做批 / 总批」、不存计数器（前后端共用单一源）；`getLatestPlanBatches` 倒序取「最新一个有批次的 plan」**不限 status**（批次是 agent 主动落库的有效数据、plan 重跑被标 error / 接续没重拆都能回退到拆好那版、避免分批失效）
- **展示（V0.6.24 chip 化）**：详情页头部「上下文文档 / MCP」chip 行里加 `BatchProgress` chip（`batch-progress.tsx`）——拆了批次=实色「批次进度 N/M」、点开 Dialog 看进度条 + 每批详情；没拆=灰色「未分批」chip 占位；plan 产物（`artifact-panel.tsx`）无批次时顶部「未分批」提示条（防 AI 漏调 set_plan_batches 用户不知情）、有批次时底部 `BatchPlanTable` 渲染批次表（从 planBatches、不解析 markdown）
- 小需求 plan 不分批（不调 set_plan_batches）→ build 退化单次做全部、老流程不变

### 单 SDK Run 永生

整 task 跑在**同一个 SDK Run** 里、不一个 action 一个 Run：

- 用户每次「推进」action → runner 写 `[NEXT_ACTION ...]` 给 agent
- agent 跑完 action → 调 `wait_for_user(action_id)` → runner 把 action 标 `awaiting_ack` + 跑后置检查
- 用户 ack → wait-ack 写 `[ACTION_ACK approve|revise]` → agent 接着调 `wait_for_user(待命态)` 等下一指令
- 终结 task → finalize 路由写 `[TASK_DONE]` / `[TASK_ABANDONED]` → agent 自然退出 Run

**字段热更（V0.6.6）**：super prompt 只在 Run 启动时构造一次、reused agent 推进时用户在详情页编辑的 `title/role/feishuStoryUrl` 会 stale。runner 在 `runningTasks` record 存 agent 启动快照（内存、不落盘）、reused 推进时 diff 出变更、**有变才**拼一段 `[TASK_UPDATED]` 注入 `[NEXT_ACTION]` directive（注入后推进快照防重复告知）。`model` 是 Run 启动时绑定改不了、`repoFeatureBranches` build 前本就读盘、二者都不走此机制。

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
| 3. 默认 default | UI 按 task 状态推断 | `advance-dialog.tsx: inferDefaultActionType` |
| 4. action 级 anti-patterns prompt | 每个 `prompts/action-<type>.md` 头部红线段 | `prompts/action-*.md` |
| 5. cross-action 一致性自检 | V0.6.4+ 再做 | - |
| 6. placeholder 动态 | UI 按 action + task 状态变 | `advance-dialog.tsx: buildPlaceholder` |

### Git Branch 自动建（V0.6.1 多仓、V0.6.7 命名模板化）

build action 每次跑前、runner 拼 `GitBranchInfo[]`（每仓 1 条 branch）、prompt 头部追加**多仓 idempotent** checkout 引导。

**分支名按模板渲染**（V0.6.7、`src/lib/branch-template.ts`、内置默认 `feature/{username}/{storyId}-{taskTitle}`）：

- 占位符：`{username}` / `{storyId}`（从 feishuStoryUrl 抠）/ `{taskTitle}` / `{date:FORMAT}`、每个值各自 branch-safe 化（含路径分隔 `/`、模板字面的 `/` 才是层级）
- 模板层级：per-repo 覆盖 > 全局默认 > 内置默认；建 task 时由 client `resolveBranchTemplate` 算「有效模板」固化进 `task.repoBranchTemplates`、build 直接渲染——**不同仓可用不同模板**（如后端 `feature/{date:MM-dd}/{storyId}-{taskTitle}`）
- 用户在新建 / 编辑 dialog 给某仓填了「已有工作分支」(`repoFeatureBranches`) → 用它当 name（build 复用、不另建）

agent 用 SDK shell 对每个仓跑一段 idempotent 命令（base 分支：配了线上分支用配的、没配则自探 master/main/develop）：

```bash
BASE=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@')
if git show-ref --verify --quiet refs/heads/<branch>; then
  git checkout <branch>
else
  git fetch origin "$BASE" && git checkout -b <branch> "origin/$BASE"
fi
```

每次 build 都重新 inject 这段 hint、不再维护 `checkedOut` 状态。多仓各仓 branch name 取决于模板（同模板=同名、不同模板=各异）。

没填 feishuStoryUrl / 没绑仓时不建 branch、走 fallback（V0.6.7 起 username 不再硬性必需、后端模板可能不含 `{username}`）。

### Ship action + GitLab REST 集成（V0.6.1）

ship 实现要点：

- **server-side GitLab REST API**：`src/lib/server/gitlab-client.ts` 直接 fetch `/api/v4/projects/:id/merge_requests`、走 PAT (`PRIVATE-TOKEN` header)；**不**依赖 glab CLI / 外部 MCP server
- **提测目标分支 per-repo（V0.6.7）**：MR target = 该仓的测试分支（`task.repoTestBranches[repoPath]`、建 task 时从设置页快照）、没配回退 `test`；agent 从 super prompt「仓库分支配置」段读、不探 `origin/HEAD`（那是默认主分支、跟提测工作流不符）
- **PAT 不暴露给 agent**：agent 通过 MCP 工具 `submit_mr` 间接调、server 端凭 settings 闭包的 token 访问 GitLab；MCP 工具返结构化 JSON（`{ ok, mr_url, mr_iid, mr_version }`）
- **多仓 task 每仓 1 条 MR**：`Task.gitBranches[]` / `Task.mrs[]` / `ActionRecord.sideEffects.mrs[]` 都按 `repoPath` 区分；某仓 `git diff` 为空时 agent 跳过、在 artifact 写跳过原因
- **同分支累计 commit**：同 `repoPath` 多次 ship 不开新 MR、`task.mrs[repoPath]` 的 `version` 累加、保留 `createdAt` 首次值——`upsertMR(taskId, repoPath, ...)`
- **飞书 @ 测试人员（A+C 策略）**：首次 ship 由 agent 调飞书 MCP `list_workitem_role_config` + `search_user_info` 自动探测（A）、探不到时 ask_user 让用户填用户名（C）、结果通过 `set_feishu_testers` MCP 工具持久化到 `task.feishuTesterUserIds`、后续 ship 直接复用

settings 新加 2 个全局字段：

- `gitHost`：自建 GitLab host（如 `gitlab.wukongedu.net`、不带协议）
- `gitToken`：Personal Access Token（明文 localStorage、跟 apiKey 同安全级别）

UI 在 `src/components/settings/git-card.tsx` 卡片配置。ship 准入 = build 已 approve + gitHost + gitToken 三者俱全。

### 文件系统改造

```
data/tasks/<id>/
  meta.json          # V0.6 schema：actions[] / mrs[] / repoStatus / runStatus / mode
  events.jsonl       # 同 V0.5
  actions/           # V0.6 改：artifacts/ → actions/
    1-plan.md
    2-build.md
    3-review.md
    4-ship.md        # V0.6.1：ship action artifact（含 §3 多仓 push + MR 详情表）
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

### V0.6.24：分批 build 打磨——批次显示 bug 修复 + 进度条 chip 化 + 文案（2026-06-09）

V0.6.23 批次功能上线后的真机打磨（用户拿大需求边跑边修）：

- **批次不显示 bug（RCA 锁定）**：`getLatestPlanBatches` 原要求 plan `completed` 才认其批次。但 plan 重跑场景——act_1 拆了批次却因 serve 重启被标 `error`、act_2 接续 `completed` 却没重调 `set_plan_batches`——两个都被跳过、批次读不到（advance-dialog 选批没选项）。**读取侧**去掉 `completed` 限制（planBatches 是 agent 主动落库的有效数据、run 中断不影响）；**写入侧** `action-plan.md` 加 ⚠️「重跑 / 接续 plan 必须重调 set_plan_batches」（批次绑当前 action、不从上一版继承、系统兜底回退但别依赖）。
- **进度条 chip 化（UI）**：原 timeline 下常驻进度条用户嫌占高度 + 挡。改成详情页头部「上下文文档 / MCP」chip 行里的 chip + 点开 Dialog（对齐那两个的 chip+dialog 模式）——拆了批次=实色「批次进度 N/M」、没拆=灰色「未分批」chip 占位（点开也有引导）。`batch-progress.tsx` 重写。
- **选批默认值 + 全选**：advance-dialog 默认勾从「全部未完成」改「只勾下一个未完成」（remaining[0]、用户拍板）+ 加「全选 / 全不选」按钮。
- **A' plan 无批次提示条**：plan 产物顶部、该 plan 无 planBatches 时显示「本方案未分批 · 大需求可再聊聊让 AI 拆批次」（`artifact-panel.tsx`）——给「AI 漏调 set_plan_batches」一个可见信号 + 兜底入口。
- **测试策略文案**：`after`「事后测」（用户反馈费解）→「实现后测试」、`tdd`「TDD(先写测试)」→「先写测试(TDD)」对仗；全局 5 处统一 + `batch-plan-table.tsx` 脚注改走 `TEST_STRATEGY_LABEL` 单一源（修之前硬编码漂移）。
- **加固决策**：讨论过给 build 加「测试必须真跑且绿才算完成」硬 gate、结论**暂不加**（前端多 after/none 会误伤 / 跨框架检测复杂 / 跟 review 重叠 / 符合分阶段验证 ROI）——靠 prompt 引导 + review 把关。
- `pnpm typecheck` ✓ / `pnpm lint` ✓。

### V0.6.23：大需求「批次 + 分批 build」（已实装、2026-06-08）

**动机**：一个大飞书需求、`plan + 单次 build` 跑完不保险——上下文越跑越长、agent 改着改着就乱了、质量滑。

**对齐四大库调研**（详见本轮对话 + `docs/PRODUCT-COMPARISON.md`）：
- **Superpowers / GSD = 真分批 + 多 Agent**：每批换 fresh subagent + 每批自动复查（防上下文污染）。Superpowers 还强制 TDD + 两阶段 review；GSD 波次 gate + 目标倒推 verify。
- **Spec Kit / OpenSpec = 单 Agent 顺序跑清单**：靠「实现前把 plan/spec 拆够细 + 人审到位」保证质量、不靠多 Agent。
- **我们的位置**：无 subagent 原语（`@cursor/sdk` 不支持）、用 **「新启 Agent」**（`forceNewAgent`、换全新上下文 + 读前序 artifact）当等价物。**清单结构化我们已做了一大半**（plan §5 task 已带 精确文件路径 + 依赖 + 验收点 + 关键参考、约等于 Spec Kit）。

**方案**：全程**一个 task**（不拆多任务、满足用户硬要求）、plan 多产出「批次」层、build 可选「全做 / 挑批」、每批可新启 Agent、review 两层。

**数据模型**（`types.ts`、最小化、**进度纯推导不存计数器**）：
- `TestStrategy = "tdd" | "after" | "none"`——自适应 TDD：逻辑批 TDD / UI 批实现后测试 / 纯样式免测（**不强制**、对齐 Spec Kit「TDD 可选」、契合我们前端为主的现实）
- `PlanBatch { id; title; testStrategy; taskRefs: string[] }`——批次 = 可独立交付功能块、下挂 plan §5 的 task
- `ActionRecord.planBatches?: PlanBatch[]`——plan action 落；plan agent 写完 artifact 调 **MCP `set_plan_batches`** 上报（跟 `submit_mr` / `set_feishu_testers` 同套路、**不靠解析 markdown**）
- `ActionRecord.requestedBatchIds?: string[]`——推进 build 时**用户在 dialog 勾的批次、后端 advance 时直接存**（不靠 agent 上报、省掉第 2 个 MCP 工具）
- **进度 = 派生**：已做批 = ∪(completed build 的 `requestedBatchIds`)、总批 = 最新 plan 的 `planBatches`——不存「已完成 N 批」、避免漂移

**四块改动**：
1. **plan**（`action-plan.md`）：§5 task 拆分上加一层「批次」分组、每批标 `testStrategy` + 一句话目标 + independent test；写完调 `set_plan_batches` 上报
2. **build**（`action-build.md`）：开头从 `[NEXT_ACTION]` 指令读「本次做哪批」（用户 dialog 选的）；只做选中批次的 task；**TDD 批先写测试看失败再实现**；build artifact 记「本次完成批次 X」（给人看）
3. **review**（`action-review.md`）：两层——**增量**（只审本批 build 的 diff）/ **集成**（所有 planBatches 都 built 后、审批次间是否打架、借 GSD「目标倒推」）；判用哪层 = 看 `requestedBatchIds` 并集是否已覆盖全部 `planBatches`
4. **UI**（`advance-dialog.tsx` + `batch-progress.tsx`）：推进 build 时若最新 plan 有 `planBatches`、用 ChoiceButton 卡片列批次让用户勾（**默认勾未完成批次**、已做的带角标）+ 显示「X/Y 批」进度；详情页 timeline 下常驻 `BatchProgress` 进度条（M/N + 每批 chip、纯派生、没批次不渲染）

**关键决策**：批次结构走 MCP 上报（不解析 markdown）· 进度纯派生不存状态 · TDD 自适应不强制 · 批次不是独立 task（全程一个 task）· review 增量 / 集成由后端派生进度注入 `[REVIEW_SCOPE]`（agent 不自己猜）。

**数据流闭环**（实装）：plan agent 调 MCP `set_plan_batches`（chat-mcp 第 5 工具）→ runner `taskActionHandler` patchAction 落 `planBatches`；build 推进时 advance-dialog 勾批 → `/advance` 透传 `requestedBatchIds` → 落 build action → runner `buildBatchDirective` 拼 `[BUILD_BATCHES]`；review 推进时 `buildReviewScopeDirective` 注入 `[REVIEW_SCOPE]`；进度全程走 `task-display.computeBatchProgress` 派生（前后端共用）。

`pnpm typecheck` ✓ / `pnpm lint` ✓（0 warning）。⚠️ 真机大需求实测待用户验。

---

## 关键文件索引

| 内容 | 位置 |
|---|---|
| **V0.6 重构设计文档（已 archived、V0.6.0 落地完成）** | `docs/V0.6-REFACTOR.md` |
| **V0.6 统一 runner（task 容器 + action history）** | `src/lib/server/task-runner.ts` |
| **V0.6 action 后置 deterministic check** | `src/lib/server/action-checks.ts` |
| **V0.6 task schema + 文件系统** | `src/lib/types.ts` + `src/lib/server/task-fs.ts` |
| **批次推导 + 展示（V0.6.23 起、computeBatchProgress 前后端共用 / 进度 chip / 批次表 / 选批 / 测试策略 label）** | `src/lib/task-display.ts` + `src/lib/types.ts: PlanBatch / TestStrategy / TEST_STRATEGY_LABEL` + `src/components/tasks/{batch-progress,batch-plan-table}.tsx` + `advance-dialog.tsx` 选批 |
| **GitLab REST client（V0.6.1 新、V0.6.8 加 closeOpenMR 关被取代的旧 MR）** | `src/lib/server/gitlab-client.ts` |
| **agent 孤儿子进程清理（V0.6.8、停 task / finally 调）** | `src/lib/server/kill-orphans.ts` |
| **读 Cursor 全局配置 mcp/rules（V0.6.2 新）** | `src/lib/server/cursor-config.ts` |
| **Cursor MCP 只读 API + hook（V0.6.2 新）** | `src/app/api/cursor-mcp/route.ts` + `src/hooks/use-cursor-mcp.ts` |
| **MCP OAuth（V0.6.4 新、走 OAuth 的远程 MCP 授权 + 注入）** | `src/lib/server/mcp-oauth.ts` + `src/app/api/mcp-oauth/{start,callback,status,revoke}` + `src/hooks/use-mcp-oauth.ts` |
| **设置页编辑即保存（V0.6.5、6 张卡片去 SaveButton）** | `src/hooks/use-settings.ts: saveFieldValue`（唯一落盘入口）+ `src/app/settings/page.tsx` + `src/components/settings/*-card.tsx` |
| **「常用 MCP」全局开关（V0.6.5、设置页配 + 建 task 取快照）** | `FeAiFlowSettings.disabledMcpServers` + `src/components/settings/mcp-card.tsx` |
| **super-prompt 主模板（V0.6 改造、注入 7 action）** | `prompts/_super.md` |
| **跨 action 共享规范** | `prompts/_shared.md` |
| **plan / build / review / ship action prompt** | `prompts/action-{plan,build,review,ship}.md` |
| **test / learn stub（V0.6.2+ 设计草稿）** | `prompts/action-{test,learn}.md` |
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
| 编辑任务 dialog + 字段热更（V0.6.6、详情页改软配置字段、reused agent diff 注入 `[TASK_UPDATED]`） | `src/components/tasks/edit-task-dialog.tsx` + `task-fs.ts: updateTaskFields` + `task-runner.ts: buildTaskUpdateHint` |
| 任务卡片（V0.6 双状态） | `src/components/tasks/task-card.tsx` |
| 任务详情页（V0.6 重写） | `src/app/tasks/[id]/page.tsx` |
| 任务角色 schema + 展示文案 | `src/lib/types.ts: TaskRole / TASK_ROLE_LABEL` |
| 多仓 cwd / repoPaths 工具 | `src/lib/path-utils.ts: getEffectiveCwd / formatRepoSectionForPrompt` |
| Artifact ref / 文件路径渲染（V0.6.0.1 加 `actions/` 前缀支持） | `src/lib/path-utils.ts: looksLikeArtifactRef / looksLikePath / buildCursorLink` |
| 设置：username + 默认分支命名模板（V0.6.7 加模板） | `src/components/settings/user-profile-card.tsx` |
| 设置：仓库列表 + per-repo 线上/测试/dev 分支 + 模板覆盖（V0.6.7） | `src/components/settings/repo-card.tsx` |
| 设置：GitLab Host + PAT（V0.6.1 新增） | `src/components/settings/git-card.tsx` |
| **feature 分支命名模板引擎（V0.6.7、client+server 共用）** | `src/lib/branch-template.ts` |
| 模型选择器共享组件（V0.6.0.1 抽出、settings + advance dialog 共用） | `src/components/ui/model-picker.tsx` |
| Skills loader | `src/lib/server/skills-loader.ts` |

## 设计变动流程

权威源 = 代码 + 本文件。设计层面变动：

1. **当前架构变动**（如 action 模型改、保活机制改、新增大组件）→ 改代码 + 同步更新本文件「当前架构快照」段
2. **小步迭代**（同主题连续 .1 / .2 / .3 微调）→ 改代码 + 写到本文件「最近演进」段顶部
3. **再老一轮时**（「最近演进」积压超过 2 个子版本）→ 把最老那段迁到 `docs/CHANGELOG.md` 顶部

⛔ 不要散落到其它 md 写一份新的演进段。
