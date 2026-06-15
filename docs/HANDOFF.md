# ai-flow Handoff

> **权威源**：代码 + 本文件。其余 docs/*.md 为辅助、有冲突以代码 + 本文件为准。

## 项目定位（一句话）

站在 Cursor SDK 肩膀上的**项目级 AI Harness 平台 · 飞书 story → MR 自动化**。核心是 Harness（缰绳）：每个 action 边界用确定性工具（per-repo CheckRun typecheck/lint/test + 工作区污染检测 / 基底 commit 校验 / HITL ack）压住 LLM 非确定性、保证产出可观测、可回退、可复用。

## 给 AI 接力的最小上下文

按顺序读：

1. `.cursor/rules/project-context.mdc` —— 强制约束
2. `.cursor/rules/learned-conventions.mdc` —— 编码风格
3. 本文件「当前架构快照」段（V0.6 系列、稳定架构）+「最近演进」段
4. `prompts/_super.md` —— super-prompt 主模板（V0.6.27 起只注入当前 action playbook + action history）
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

### 交付形态：Electron 桌面 app 唯一（2026-06-12 用户拍板）

后续**不用考虑网页版、绿色版**——新功能按桌面端设计（原生 picker / 壳 IPC / 自更新随便用）、不为浏览器做适配；绿色 zip 包 + launcher + CI 绿色包 job 已彻底清理（v0.7.15）、唯一发版链 = Electron 安装包。

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
| `task` | 正经需求、走 action 容器 | 三栏 ResizablePanelGroup（左 timeline + 中 artifact + 右 event stream） | `task-runner.ts` + `_super.md`（只注入当前 action playbook） | title、repoPaths、feishuStoryUrl |
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
| plan | ✅ 已实装 | 永远可 | artifact 存在 + 内容长度 >= 100 + 必备段（需求理解 / Task 拆分、V0.6.27）|
| build | ✅ 已实装 | 永远可（V0.6.17 放开 plan 前置）| V0.6.25 CheckRun：per-repo 跑用户配的 checkCommands（typecheck/lint/test）+ 工作区污染检测 + 兄弟仓越权检测（V0.6.27）、详见下「Build 后置 CheckRun」段 |
| review | ✅ 已实装 | 至少 1 个 build completed | 必备段（总评 / 需求对照 / bug 复审）+ 基底 commit 跟 HEAD 一致（V0.6.25 P1-2 修死代码正则）+ 工作区指纹未变（V0.6.27 只读硬校验）|
| ship | ✅ 已实装 | 至少 1 个 build + settings 配 GitLab Host + PAT | `task.mrs[]` 覆盖所有 repoPath（URL 非空） + 跳仓有原因 |
| test | 🚧 V0.6.2 | 至少 1 个 build | （未实现） |
| learn | 🚧 V0.6.3 | `repoStatus = merged` + 整 task 只跑一次 | （未实现） |

stub action 的 prompt 文件存在（V0.6.2+ 设计草稿）、UI 推进 dialog 灰掉、runner 准入拒绝。

### 大需求分批 build（V0.6.23 起、V0.6.24 打磨、可选）

plan 可把大需求在 §5 task 之上再分「批次」（`PlanBatch`、plan agent 调 MCP `set_plan_batches` 上报、落 `ActionRecord.planBatches`）。之后：

- **build 选批**：推进 build 时 advance-dialog 列批次让用户勾（**默认不勾任何批次**、必须显式选本次要做 / 返工的批次、`canSubmit` 拦空选；提供一键「全选」、已做的带角标）、`requestedBatchIds` 落到该 build action；runner `buildBatchDirective` 把「本次做哪批 + 测试策略 + 进度」拼进 `[NEXT_ACTION]` 的 `[BUILD_BATCHES]` 段；每批可「新启 Agent」换干净上下文（无 subagent 原语、用这个当等价物）
- **测试策略**：每批标 `TestStrategy`（tdd / after / none、自适应不强制、label「先写测试(TDD) / 实现后测试 / 免测」走 `TEST_STRATEGY_LABEL` 单一源）、build agent 按策略走（TDD 批用 `shell` 实跑仓库现有测试框架、先写测试看红 → 实现到绿；无测试设施则退化「正常实现 + artifact 写明该测什么」）
- **review 两层**：runner `buildReviewScopeDirective` 按派生进度注入 `[REVIEW_SCOPE]`——还有批没做 = 增量（聚焦新批 + 衔接）、全做完 = 集成（查批次间接口 / 数据流 / 重复实现 / 冲突）
- **进度纯派生**：`task-display.computeBatchProgress` 从 action 历史算「已做批 / 总批」、不存计数器（前后端共用单一源）；`getLatestPlanBatches` 倒序取「最新一个有批次的 plan」**不限 status**（批次是 agent 主动落库的有效数据、plan 重跑被标 error / 接续没重拆都能回退到拆好那版、避免分批失效）
- **多轮 build artifact 只写增量（V0.6.26）**：新 build action 不能复制上一轮完整实现文档；本轮改了代码就写本轮变更，本轮评估后不改则写「本轮无代码改动」+「有效实现来源：沿用 build #N（`actions/N-build.md`）」。review / ship / test 看到无代码 build 必须沿该来源递归追溯到真正改代码的 build，避免用户界面被旧 md 刷屏、也避免后续 action 丢上下文。
- **展示（V0.6.24 chip 化）**：详情页头部「上下文文档 / MCP」chip 行里加 `BatchProgress` chip（`batch-progress.tsx`）——拆了批次=实色「批次进度 N/M」、点开 Dialog 看进度条 + 每批详情；没拆=灰色「未分批」chip 占位；plan 产物（`artifact-panel.tsx`）无批次时顶部「未分批」提示条（防 AI 漏调 set_plan_batches 用户不知情）、有批次时底部 `BatchPlanTable` 渲染批次表（从 planBatches、不解析 markdown）
- 小需求 plan 不分批（不调 set_plan_batches）→ build 退化单次做全部、老流程不变

### Agent 生命周期：每 action 默认新 agent（V0.6.27 反转）

V0.6.26 以前默认「单 SDK Run 跑全 task、forceNewAgent 是例外」、V0.6.27 反转为「**每 action 默认起新 agent**、续用是例外」：

- 理由：context 膨胀是跑偏的物理根源（lost in the middle）、artifact 本来就是 action 间唯一合法通信媒介、新 agent 冷启动所需上下文全量可重建（review fresh peer 自 V0.6.9 验证可行且效果更好）
- 生效逻辑（`advanceTask`）：`effectiveForceNewAgent = !reuseAgent || ACTION_FRESH_AGENT_DEFAULT[type]`——UI「续用当前 Agent」开关是例外逃生口（省 send 配额 / 需要连续上下文时手动勾）、review 勾了也强起新（换人复审铁律）
- 连带：super prompt 只注入**当前 action** 的 playbook（不再全量 6 种、体积 -60%+）；续用路径收到 `[NEXT_ACTION]` 时、server 在载荷里附带新 action 的完整 playbook（`buildNextActionDirective(actionPlaybook)`）

**单 Run 内协议不变**（agent 视角无感知、它不知道自己会跑几个 action）：

- 用户每次「推进」action → 默认起新 agent + super prompt 冷启动；勾续用 → runner 写 `[NEXT_ACTION ...]` 接力
- agent 跑完 action → 调 `wait_for_user(action_id)` → runner 把 action 标 `awaiting_ack` + 跑后置检查
- 用户 ack → wait-ack 写 `[ACTION_ACK approve|revise]` → agent 接着调 `wait_for_user(待命态)` 等下一指令
- 终结 task → finalize 路由写 `[TASK_DONE]` / `[TASK_ABANDONED]` → agent 自然退出 Run；agent 不在 wait 挂起时 finalize 直接 `cancelTaskRun` 硬停（V0.6.27 B3）

**字段热更（V0.6.6、仅续用路径需要）**：super prompt 只在 Run 启动时构造一次、reused agent 推进时用户在详情页编辑的 `title/role/feishuStoryUrl` 会 stale。runner 在 `runningTasks` record 存 agent 启动快照（内存、不落盘）、reused 推进时 diff 出变更、**有变才**拼一段 `[TASK_UPDATED]` 注入 `[NEXT_ACTION]` directive（注入后推进快照防重复告知）。`model` 是 Run 启动时绑定改不了、`repoFeatureBranches` build 前本就读盘、二者都不走此机制。

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
- **reuseAgent**（V0.6.27 语义反转）：默认不勾 = 起新 agent（可顺带临时换模型）、勾上 = 续用当前 agent（省 send 配额、review 勾了也强起新）

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

### Build 后置 CheckRun（V0.6.25、门槛 2 的 build 实现）

V0.6.3 撤掉 build 写死的 `pnpm typecheck/lint`（多技术栈误报）后 build 一直没后置 check、靠 review 兜底。V0.6.25 用「用户 per-repo 配命令」补回：

- **配置 + 快照链（V0.6.26 自动检测为主、手动 override）**：建 task 时 per-repo 走 `manual override > auto detect`——设置页 repo-card 手配了 `checkCommands`（`RepoCheckCommands` 编辑器）就用手配、没配则 `detectRepoCheckCommands`（`repo-check-detect.ts`）按 repo 文件结构自动识别（Node `<pm> run lint`+`typecheck`/`tsc`、Maven `mvn -DskipTests compile`、Gradle `<wrapper> compileTestJava`）→ 快照进 `Task.repoCheckCommands`（key=repoPath；server 读不到 localStorage、必须快照）。`CheckCommand { name; cmd; kind; required; timeoutMs?; source? }`、`source` ∈ manual/auto（审计 + 未来 UI 徽章、不影响执行）、`kind` ∈ typecheck/lint/unit-test/build/custom（仅给默认超时 + UI 分组、不影响执行）。手动 + 自动两条来源统一过 `task-fs.sanitizeCheckCommands`：归一非法 kind 防 `setTimeout(0)` 秒杀、硬上限每仓≤10 条 / name≤80 / cmd≤2000 / timeoutMs clamp[5s,30min]。
- **产品语义三态（V0.6.26）**：设置页该仓检查命令**留空 = 自动检测**、**手动配置非空 = 覆盖自动检测**、**UI 暂不支持「禁用自动检测」**（清空 ≠ 禁用、等于回到自动检测——createTask 层 `repoCheckCommands[repo]=[]` 内部能表「禁用」、但 new-task-dialog / route 都 `length>0` 过滤、空数组到不了 server、第一版有意不暴露）。required 分级：Node lint/typecheck + Maven compile = `required=true`（挡 ship）、Gradle compileTestJava = `required=false`（Android/Kotlin 不通用、不自动挡 ship、用户可手动覆盖）。
- **触发**：build agent 调 `wait_for_user(build_action_id)` → 现成 `awaitingNotifier` 跑 `runActionCheck` → `case "build"` 走 `checkBuild`（`action-checks.ts`）。**复用现有钩子、不新增 action 步骤**。check 跑期间 build 停在 running、跑完才 awaiting_ack（配了 test 的仓用户要等）。
- **执行**（`checkBuild` → `runRepoChecks` → `runCheckShell`）：遍历 `task.repoPaths`、按 `repoCheckCommands[repo]` 串行跑——`sh -c`（支持 `&&` / `cd` / 管道）· `detached` + 进程组 kill（超时连子进程一起杀防孤儿）· PATH 继承 runner + 补常见 bin · **每条命令跑前后比 `git status --porcelain --untracked-files=no`**、tracked 变了 = `mutatedWorktree`（命令偷改源码、如 `--fix`）判 failed。build 改动停在工作区（未 commit）、check 校验的正是这批改动。
- **结果落盘**：完整输出落 `actions/.checks/<actionId>/<slug>.log`（`.checks` 隐藏目录不混进 artifact 列表、slug=`<idx>-<repo 末段>` 防多仓同名覆盖；单命令 output 累积 >512KB 截断打 `[output truncated]` 防内存爆）；摘要 `CheckRunSummary`（per-repo per-command status + logTail + **每仓 worktreeFingerprint**）落 `ActionRecord.checkRun`；`postCheck = { passed, details }` 复用红绿条。
- **聚合**（V0.6.25 review 加固）：repo 级——required 命令挂 **或任一命令 mutated（污染工作区、无视 required）** → failed；没配命令的仓按是否被本次 build 改过分 `not_configured`（dirty、改了没检查）/ `skipped`（clean、没碰）。run 级——任一 repo failed → failed；**任一** repo not_configured → not_configured（不让「一个仓过」掩盖「另一个仓改了没检查」）；否则 passed（含 skipped 仓）。
- **ship gate + 工作区指纹 + override**（V0.6.25 review 加固）：`checkShipCheckGate`（async）读最新 completed build 的 `checkRun.status`、**并重算各仓工作区指纹跟 check 时记录的比对**——非 passed 或指纹变了（check 后又改工作区）都拦、要求 `CheckOverride`（per-ship、只绑 `buildActionId` + `checkRunId`、重 build 自动失效、reason 必填进事件流 + 审计；工作区内容有效性只信 server 重算的 fingerprint、不信 client 字段）。指纹 = `sha256(headCommit + git diff HEAD + untracked 文件逐个 hash-object)`（覆盖 tracked 改 / staged / 删 / 新增 untracked / untracked 内容变；当前 tracked diff 输入给 20MB cap，极端超大 diff 后续可改逐文件 hash）。**`GET /api/tasks/[id]/ship-precheck`** 复用同一 gate 把结论给 advance-dialog 展示 override 区（client 算不了 git 指纹、不自己猜）、**但 `/advance` ship 分支仍重算 gate**（防 precheck → submit 间又改工作区、precheck 仅 UI 不授权）。
- **展示**：build 产物面板（`artifact-panel.tsx`）正文上方挂 `CheckRunSummaryCard`（per-repo not_configured「改了没配」/ skipped「没改跳过」分开提示）；ship 推进 dialog（`advance-dialog.tsx`）打开时拉 `/ship-precheck`、按 server 结论弹 override 区（勾「仍继续提测」+ 填原因）。
- **暂不做**：artifact graph / LLM analyze gate / 自动 lens / 自动跑重型 test / task 级永久忽略 check。

### Shell 命令硬拦截（V0.6.27、beforeShellExecution hook）

`_shared.md`「shell 安全」段的禁令从 prompt 软约束升级为确定性拦截：

```
agent 要跑 shell 命令
  → Cursor 触发 beforeShellExecution hook（业务仓 .cursor/hooks.json、起 agent 时注入）
  → scripts/shell-guard.mjs 把 {agent_id, command} POST 到 /api/hooks/shell-check
  → server 用 findTaskIdByAgentId 认出是不是 fe 的 agent（不是 → 放行、不干扰用户自己的 Cursor）
  → evaluateShellCommand（shell-guard-rules.ts 黑名单）判定 → allow / deny
  → deny 时 agent 收到 agent_message 解释 + task 事件流记 error 事件（可观测）
```

- 规则单一源 `src/lib/server/shell-guard-rules.ts`（纯函数、有单测）：`--fix`/`--write`、force push（豁免 `__conflict`）、`reset --hard`、`rebase`、`clean -f`、dev server、`--watch`/`tail -f`、全局安装
- **保守黑名单 + fail-open**：只拦 prompt 已明令禁止且误伤面可控的；脚本 / 网络任何异常都放行（误杀比放过代价大、放过还有 CheckRun mutatedWorktree 兜底）
- hooks.json 注入扩展为 stop + beforeShellExecution 两条（`stop-hook-inject.ts`、旧版 fe 生成的 hooks.json 自动升级补缺、用户自己的 hooks.json 不动）

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
- **飞书 @ 测试人员（A+C 策略）**：首次 ship 由 agent 调飞书 MCP `get_workitem_brief` 自动探测（A、role_members 的 `member.key` 就是 user_key）、探不到时 ask_user 让用户填用户名（C、`search_user_info` 转 user_key）、结果通过 `set_feishu_testers` MCP 工具持久化到 `task.feishuTesterUserKeys`、后续 ship 直接复用。id 体系 = 飞书项目 user_key（2026-06-12 起、lark_user_id 被官方 MCP 封死、详见 action-ship.md §4）

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

### V0.7.0：Electron 桌面端——双击图标即用、win 自动更新（2026-06-11）

背景：绿色 zip 的「bat→vbs→隐藏 powershell→node」四级启动链静默、易被企业 EDR 拦、挂了零反馈（同事实测「双击闪一下啥都没发生」）。用户拍板换 Electron：同事双击图标 → 独立窗口 → 关窗服务跟着退 → win 自动更新、接受体积代价（约 260MB vs 绿色包 170MB）。

- **改名 ai-flow（去 fe、不再局限前端）+ 等待协议 prompt 单一源 + Windows 可选装路径 + 禁整页刷新（v0.7.21）**：① **全局 `fe-ai-flow` → `ai-flow`**（用户拍板「已不局限于 fe」）：agent 上下文（prompts / skills / `.cursor/rules`）+ 项目名 + docs + MCP id（`feAiFlowChat` → `aiFlowChat`、`chat-mcp` 定义 + chat-runner / task-runner / `_super.md` 引用全链一致）全去 fe；**雷区一律不动**（改了裂 app / 丢数据 / 断自更新）——userData 目录（`fe-ai-flow` / `fe-ai-flow-test`）、appId（`com.jianger.fe-ai-flow`）、GitHub repo（`jianger666/fe-ai-flow`）、artifactName（`fe-ai-flow-${version}` exe/dmg）、env（`FE_AI_FLOW_*`）、globalThis key（`__feAiFlow*__`）、localStorage key（`fe-ai-flow:*`）。② **等待协议 prompt 收口单一源**（新建 `src/lib/server/wait-protocol-prompt.ts`、chat + task 四处引用同一份、删三处漂移）：抽共用「写完 → wait_for_user → shell curl 挂等」的纯机制纪律 + 三认知陷阱（turn 矛盾 / 回复完≠收尾、所谓「结束」其实是「断开」/ anti-loop 误报）；chat 侧补「每轮 `[USER_REPLY]` 尾部拼一句 wait 提醒」（recency 注入、抗长上下文把协议冲淡导致漏调）+「工具跑完 ≠ 回答、结果 / 链接 / 结论必须写进回复正文」、`wait-ack` maxDuration 提到 24h。③ **Windows nsis 可选安装路径**：`electron-builder.yml` `oneClick:false` + `allowToChangeInstallationDirectory`、首次手装走向导能选目录（自更新仍静默、per-user 不强制 UAC）。④ **禁整页刷新快捷键**：`main.js` `before-input-event` 拦 `cmd/ctrl+R` / `cmd+shift+R` 强刷 / `F5`（dev+prod 都禁）——桌面 app 不该暴露浏览器整页刷新、误触丢输入草稿 / UI 临时态（持久化态走 server + SSE replay 不受影响）；只拦这几个键、不碰 cmd+C/V/A / cmd+W / cmd+Q / devtools。⑤ **mac/win 自更新故意不统一（已评估、别复用重构）**：共享层已抽好（弹窗去重 `wasPrompted`/`markPrompted`、页面「新版本」标识 `notifyPageUpdateReady`、对话框 `promptUpdateOnce` 文案参数化、入口分流 `installUpdateNow`、版本比较 `isNewer`——改一处两端生效）；真正分两套的只有「下载+安装」核心（win `electron-updater` 一把梭 ≈18 行 / mac 无证书跑不了 Squirrel.Mac、自实现 `fetch dmg + hdiutil + ditto` ≈97 行）——底层是两个不兼容方案、连「查更新」都难统一（win 是查+下载一体的事件回调），强行抽接口反增耦合。**下个 AI 别再尝试复用重构自更新。**
- **chat 漏调实测复发 → prompt「第一铁律」加固 + anti-loop 软提示定调（v0.7.20）**：用户挂超长连接实测（main.log task vn2ckn）出两个结论。① **anti-loop = 软提示、非硬强制**（闭环 v0.7.19 ③ 待验证）：第 1 轮 long-poll 挂 67 分钟（10:28→11:35）curl 不断、run 不退——Cursor「flagged as looping / 处于循环状态」是能无视的软提示、不逼退出、KEEPALIVE 策略不用动。② **wait_for_user 漏调真实存在、概率性、纯 prompt 没根治**（修正 v0.7.17~18「漏调已修」的乐观结论）：12:07:52 用户回「好的」→ 12:07:57 SDK FINISHED、中间 0 次 wait_for_user（和最初 acmri2 同款）；对比 fxjb3s 的「好的」「ok」没漏 = 同输入不同结果、composer 软约束 hold 不住、**收尾语境（好的 / 谢谢 / 收到 / 没事了 / ok）最易触发误判「对话结束」而省 wait**。**用户否决「服务端 resume 兜底」**（原话「我就是不想冷启动、不多启动才搞这套 shell long-poll」——resume 起新 run 正撞「单 run 省计费」硬约束）、定调走 **prompt 加固**：`chat-runner.ts buildInitialPrompt` 改 2 处（精简后单一源、避免冗余）——① 总纲把原『循环往复直到用户主动结束』（给 agent『可自判结束』的错误锚点）换成『无限循环、永不自行结束』+ 新增「🚨 第一铁律：你没有结束对话的权力」整段讲透 turn 机制（emit 后不接 tool call → turn 结束 → Run 永久死 → 冷启动；唯一结束信号 [CANCELLED]；收尾语「好的 / 谢谢 / 收到 / ok」是普通消息、回完照样 wait）；② USER_REPLY 分支补一句指针「收尾语也不例外、见开头第一铁律」。（初版在关键规则 1 / 标准动作也各加过同款警告、后精简掉重复、只留总纲单一源 + USER_REPLY 指针）⚠️ 仍是软约束、composer 可能偶发不听、但决策路径上的错误锚点已清。③ 附带：几个 task long-poll 中途 SDK ERROR（fxjb3s 9.5min / mygeom 24min、message 空）但 vn2ckn 挂 67min 没事 = 非「挂久必挂」、根因待查（疑 test/正式 race 或 SDK 偶发、非 anti-loop）、和漏调两回事。
- **wait_for_user 引导焊死「移后台≠exit」+ 纯 shell 化讨论定调保留 MCP（v0.7.19）**：① 接 v0.7.18——`buildShellWaitGuidance`（chat+task 共享）原「curl 意外 exit 再跑一次兜底」拆成两条死边界：「被 shell **自动**转后台」≠「curl exit」（转后台后 curl 还活着、KEEPALIVE/终态行继续推、**绝不重发**继续等）、只有「真 exit」（shell 明确给 exit code 非 0 且 stdout 一行没有）才重发一次兜底——防 agent 把「被自动转后台」误判成「连接断了」狂发第 2 条 curl。② **纯 shell 化讨论 = 维持 mcp+shell 两段式**（用户问「能否去掉 wait_for_user 的 MCP 跳、直接一条 shell」）：技术可行（wait-ack route 就地建 entry、pendingMap 本就按 taskId 存、token 只是冗余二次校验）但 ROI 不划算——ask_user 必须留 MCP（问题清单结构化 payload、纯 GET curl 传不了）、wait_for_user 自己 chat（无 action_id、URL 固定）能纯 shell 但 task（带 action_id/artifact_path）要手拼 query 易错、还会让 chat/task 裂成两套等待机制违背单一源；省的只是「每轮一次工具调用」不修任何 bug（漏调 v0.7.18 已修）。③ ⚠️ **待验证认知：long-poll 等待期 KEEPALIVE 滚动仍触发 Cursor anti-loop**——用户实测 chat 等待时 composer 收到 Cursor 内置「flagged as looping / 处于循环状态」提示（grep 本仓无此串 = Cursor IDE 层真实提示、非 agent 幻觉）。route.ts 注释当年只记张力一半（**静默**几分钟→agent summarize 退出 bias、所以才改 KEEPALIVE 可见行）、现补另一半（**每 60s 同样的 [KEEPALIVE]**→「循环」bias）；两难 = 静默判卡住 / 滚动判循环。这次 agent 扛住没退（钢铁纪律 hold 住）。**实测闭环见 v0.7.20 ①：长连接挂 67 分钟 curl 不断、run 不退 = 该提示是软提示（能无视）、非硬强制、KEEPALIVE 策略不用动。**
- **test 包补 SDK 平台包 + wait_for_user 禁后台→简化单条 curl + 端口文案（v0.7.17~18）**：① **本地 `electron:dist:test` 缺 SDK 平台包 → 对话全挂**：`@cursor/sdk-<platform>`（含 native `cursorsandbox` + `rg` 二进制）运行时动态拼名加载、Next standalone nft 追不到、CI 靠 `npm install` 补、但本地 test 打包没这步 → SDK 连 API key exchange 端点 `fetch failed` → agent run error（**修正 v0.7.6 那条「本地组包缺平台包但有降级、一直能跑」的认知盲区**——降级只在「整包缺失」时走、test standalone 是「能 require 到 @cursor/sdk 主包、但缺平台子包」、SDK 内部直接 fetch failed 吞不掉、必挂）。修：`scripts/lib/assemble-server.mjs` 加 `addSdkPlatformPackage`、检测到本地 pnpm 符号链接拓扑（`.pnpm` 存在）时把当前平台 SDK 包从根 `.pnpm` 拷进 server 布局 + 建 symlink、CI hoisted 布局自动跳过、不影响发版链。② **wait_for_user 后台 bug**：composer-2.5 把保活 long-poll curl **放后台跑**（实测截图原话「Shell 在后台运行」）→ shell 秒返回不阻塞 turn → SDK run 提前 FINISHED → 每条消息重启新 run（违背「单 run 保活省计费」、对话「自己结束」要重发）；引导文本 / chat prompt 反复强调「前台」却**没一条显式禁后台**——`buildShellWaitGuidance`（chat+task 共享单一源）+ chat-runner `buildInitialPrompt` 三处加「必须前台、禁 `&`/nohup/disown/is_background」禁令。⚠️ 纯 prompt 软约束、composer 仍可能偶发不听、不行再上服务端兜底（检测「调了 wait_for_user 却 run 提前 FINISHED + entry 未 resolve」的误退信号自动续接 / 改文案）。**v0.7.18 用户拍板走简化路线（不上服务端兜底）**：旧引导给的是 `while + curl --max-time 1800 + tee + grep` 的「无限重连」命令（V0.6.21 防连接断的过度设计）、但「循环命令」本身就在诱导 agent 放后台 / 自己重连——用户原话「我让它 shell 一直保持就是不想 resume 冷启动、你反而要用禁令防它」。砍掉 while/max-time/tee/grep/mktemp/set+e、引导改**单条 `curl -sN`**：本地回环长连不会断、靠服务端 60s KEEPALIVE 维持（防 SDK shell idle-timeout 杀连接）、用户 ack 时 resolve 写终态行 + 关流、curl 自然 exit。命令越简单 agent 越难带偏（删 `terminalSignalGrepPattern`、`TERMINAL_SIGNAL_TOKENS` 留作协议清单 + 一致性测试；chat-mcp / chat-runner / wait-ack 三处实现注释同步去掉 while/max-time 旧描述）。**实测又修正一个认知**：单条 curl 跑起来后、**Cursor SDK shell 工具会因「命令长时间不返回」自动把它转后台**（超时机制、非 agent 主动——events.jsonl 实证 shell args 无 is_background 但 composer thinking「发现被后台启动了」）——所以 v0.7.17「禁后台」的因果其实错了（不是 composer 主动放后台导致 run 退、是 SDK 自动转后台 + composer 被「禁后台」禁令带得误以为违规、纠结/重调/退出）。prompt 再改：明确区分「agent **主动**加 `&`/nohup/is_background = 禁」vs「SDK **自动**转后台 = 正常、别慌别重调别退出、继续等后台 shell 推来的 KEEPALIVE/终态行」、chat（chat-mcp + chat-runner）+ task（_super.md 3 处旧 while 描述）全覆盖。实测 task acmri2：单条 curl + 被自动转后台、但 run 没退、连接稳挂、用户回复后 agent 正常接上（main.log 无 FINISHED/abort = 之前「对话自己结束」的病已好）。③ Electron 端口冲突 dialog 文案硬编码「8876」改 `${PORT}`（test 模式显示 8776、底层检测 / 清理逻辑本就用对了 PORT、纯文案误导）。⚠️ **同机两个 SDK app 实例（test 8776 + 正式 8876）并发跑 run 会 race**（[官方已知 bug](https://forum.cursor.com/t/concurrent-headless-cursor-agent-invocations-fail-without-delay/142677)：cursor-agent 多进程 session 初始化 / 文件锁冲突、一个正常一个秒 ERROR 无 message）——同进程内多 agent 不受影响、跨进程才撞；铁律 test 验证期间别和正式同开、验完即关（已入 learned-conventions）
- **配置 localStorage → config.json 无感迁移（v0.7.16、用户拍板「不能影响已有用户、要无感」）**：桌面端配置原存浏览器 localStorage（Chromium leveldb）、硬伤多——按 origin 含端口隔离（换端口 / 同步 test 读不到旧配置）、不透明 leveldb、Electron 主进程读不到。改存 `data/config.json`（新 `/api/settings`：GET 读 / PUT 原子写 tmp+rename、跟 `FE_AI_FLOW_DATA_DIR`、主进程可读、备份 / 同步 test 直接拷文件）。**无感迁移**（老用户零操作零丢失）：`local-store.ts` 内存缓存 cache（模块加载即用 localStorage 兜底、启动无空窗、`getSettings()` 同步签名不变、9 处调用方零改）+ `initSettings()`（启动 await 一次：文件在→用文件权威 / 文件不在→把旧 localStorage 配置写进文件完成迁移；`initPromise` 单飞、并发共享 + 失败清空可重试、防 SPA 不刷页永久卡 localStorage）+ `saveSettings` 双写（文件权威 + 过渡期 localStorage 回滚保险）；`providers.tsx` + `use-settings.ts` 启动 `await initSettings` 再读。⏰ **15 天清理任务**：`REMOVE_LOCALSTORAGE_AFTER = "2026-06-28"`、过期后 dev 控制台红字提醒——确认同事都升过本过渡版后做「清理版」：删掉 localStorage 读 / 写 / 迁移、saveSettings 改纯文件、只留 config.json + 缓存（**后续 AI 接力时若已过此日、请提醒用户做清理版**）。⚠️ apiKey / gitToken 仍明文存 config.json（同旧 localStorage 安全级别）、后续可上 Electron safeStorage 加密
- **飞书 @ 测试人员切 user_key 体系（v0.7.14、官方 MCP 服务端变更逼迁）**：06-09 还能用的 lark_user_id mention 06-12 起被官方 MCP `add_comment` 拒（`bytedance.bits.collect_public:userKey cross tenant`、对照实验确诊服务端改按 user_key 校验）——`feishuTesterUserIds` 改名 `feishuTesterUserKeys` 存 user_key、`set_feishu_testers` 入参 `user_ids → user_keys`、action-ship.md §2 探测省掉 search_user_info 转换步（role_members 的 member.key 直接用）、§4 mention/notify 全换 user_key。⚠️ **官方通知链路同时坏了**（user_key 评论能发、@ 蓝色渲染、但不推飞书通知；AT_USER_BLOCK / blockType:user / 纯文本 + notify 全组合实测不推、UI 手动 @ 正常——评论 mention 数据模型已迁 blockId 引用、MCP 拼不出）：§4 已标注「通知可能未送达」、artifact 提示用户必要时 IM 手动知会、等官方修复
- **壳原生 picker + 钥匙串静默 + dialog 防误关（v0.7.14 同批、test 实例 CDP 验证过）**：① 桌面端文件 / 目录选择改走 Electron IPC（`electron-app/preload.cjs` 暴露 `window.__nativePicker` → 主进程 `dialog.showOpenDialog`、秒弹 + 自动聚焦）、`native-picker.ts` 优先壳通道、HTTP + osascript 链路留作浏览器 dev 兜底（用户拍板大方针「全部用原生」、已入 ui-conventions）；② `use-mock-keychain` 开关绕开 mac 钥匙串——ad-hoc 签名每版 cdhash 变、Safe Storage 钥匙串条目对新版失效、同事每装新版必弹「想要使用钥匙串中的机密信息」（本机工具、数据本就明文落盘、磁盘加密无意义）；③ 带草稿表单的 dialog（new-task / advance、revise 原有）加 `disablePointerDismissal`——用户实测关「目标仓库」下拉点空白把整个弹窗带没、草稿全丢
- **代码跳转双 IDE + 多仓路径兜底 + picker 反馈（v0.7.14 同批）**：① `buildCursorLink` 改名 `buildIdeLink` 支持 `idea://open?file=...&line=...` 协议、设置页「个人信息」卡加「代码跳转 IDE」选项（Cursor / IDEA、`settings.jumpIde`、展示组件用轻 hook `useJumpIde` 读）；② 多仓 task 的 artifact 路径**首段不是仓短名 = agent 漏写仓名前缀**（实测 36-ship 写 `apps/...` 点击弹「路径不存在」）——`hasValidRepoPrefix` 校验不过的降级纯文本不给假链接（page 传 `repoShortNames` 给 ArtifactPanel）、`_shared.md` §3 同步补多仓反例正例；③ composer 附文件 / 附目录按钮 picking 时转 spinner（mac osascript 冷启动 ~1s、用户反馈「点了没反应」）；④ 顺手修「学员交接2.1」meta.json 尾部多 8 个 `}` 的损坏（写入事故、boot recovery 每次启动刷错）
- **产品显示名「AI工作流」（v0.7.2 用户拍板）**：`productName` + 页面 title + header + 用户可见提示语全改；**内部标识一律不动**——localStorage key（`fe-ai-flow:settings`、改了用户配置全丢）、MCP client name、appId（`com.jianger.fe-ai-flow`、改了 win 升级裂成两个 app）、release 产物文件名（artifactName 写死 ascii、latest.yml 下载链路稳）；壳里 `app.setPath("userData", appData/fe-ai-flow)` 钉死数据目录、显示名以后随便改数据不漂移
- **壳落盘日志（v0.7.2）**：打包后没终端、`main.js` 全部 console 输出 + server stdout/stderr + 生命周期事件（启动 / server spawn / 退出 / 端口清理）双写 `userData/logs/main.log`——同事那边「双击没反应」之类问题直接要日志文件、不再盲猜
- **win 更新交互升级（v0.7.3 用户拍板）**：弃 `checkForUpdatesAndNotify` 的英文系统通知 → 下载完弹原生中文对话框「立即重启更新 / 稍后」（同版本只弹一次、`userData/update-prompted.json` 记账）；点稍后或下次进来 → 页面 header 亮「新版本 vX」标识（壳 `executeJavaScript` 注入 `window.__appUpdateVersion` + 事件、`did-finish-load` 重注入防刷新丢）、点标识 confirm 后页面导航 `app-update://install` 伪协议、壳 `will-navigate` 拦截 `quitAndInstall`；浏览器 / mac 环境壳不注入、badge 恒不显示。注意 **v0.7.2 → v0.7.3 这次升级走的还是老体验**（弹窗逻辑在新壳里、装上 v0.7.3 后下次升级才见到）
- **MCP OAuth 改走系统浏览器（v0.7.4 用户拍板）**：桌面端不再开应用内子窗——`use-mcp-oauth.ts` 用 UA 判 Electron、跳过 about:blank 预开窗（预开保手势是浏览器才需要的）、直接 `window.open(authUrl)` 被壳 deny + `shell.openExternal` 转系统浏览器；postMessage 回传链路在该场景天然断、授权完切回应用窗口靠已有的 focus 刷新兜住；壳 `setWindowOpenHandler` 删 about:blank allow 分支、浏览器路径行为不变
- **mac Dock 不再多绿色 exec 图标（v0.7.5）**：主二进制 as node 跑 server 会被 LaunchServices 标成 Foreground app（lsappinfo 实锤 next-server 上 Dock、显示通用 exec 图标）——改用 bundle 内 `AI工作流 Helper.app`（LSUIElement=1、永不上 Dock）跑 server、VS Code extension host 同款方案；helper 路径用 `app.getName()` 拼、改显示名不裂；hooks 孙进程链不受影响（server 的 execPath 变 Helper、同样 as node）。⚠️ 用户本机日常跑着这个 app 当生产用——**别在本地 open 打包 app / 占 8876 验证**（学到 learned-conventions）
- **四连修（v0.7.13、用户一次反馈五条）**：① 裸链接尾部 `_` 被 GFM autolink 当标点剥掉、点开 404——新增 `src/lib/remark-keep-trailing-underscore.ts` remark 插件（只缝「裸链接」、显式 `[x](url)` 不动）+ 4 条回归测试、两处 ReactMarkdown 挂上；② 全局滚动条 dark 化（globals.css：thin + 半透明拇指、webkit + Firefox 双写）；③ 模型列表到处拉、每次 5-15s——双层缓存：客户端 localStorage SWR（TTL 24h、命中秒出 + 后台静默刷新、`use-models.ts`）+ server 内存 TTL 10 分钟（`/api/models` 按 apiKey）；④ 文件 / 目录选择全换系统原生 picker——新 `/api/fs/pick-native`（mac osascript 多选 / win powershell：文件多选、目录单选 / linux 501）+ 客户端 `src/lib/native-picker.ts`、repo-card 选仓库 + composer 附文件 / 附目录（拆两个按钮、原生没有混合模式）全接入；**自绘 FsPickerDialog + /api/fs/{list,home,pick-folder} 全删**；⑤ wait_for_user 用户问「能否简化成一条长链接」——现状 while+curl 重连机制效果上就是单长连接、MCP 工具直接阻塞会撞 idle 5 分钟被砍的老坑（V0.3.5 立机制的原因）、维持现状
- **mac 应用内自更新（v0.7.12、免证书）**：用户实测痛点「每版更新都要去 系统设置→隐私与安全性 放行 + 输密码」——根因：浏览器下载带 quarantine 标记 + ad-hoc 签名每版 cdhash 都变、Gatekeeper 把每个新版当全新可疑 app。解法：壳自己 fetch dmg（**壳进程落盘的文件没有 quarantine、Gatekeeper 不评估**、实测 xattr 只有 com.apple.provenance）→ hdiutil attach → 旧 app rename 暂存（同卷原子）→ ditto 新 app 就位（保留签名 / xattr、失败回滚）→ 弹「立即重启」relaunch；下载进度走 Dock 图标 setProgressBar；非常规安装位（/Volumes/ 里直接跑）或任一步失败降级开下载页。win electron-updater 链路不变。彻底零确认 + 首次安装也免弹窗仍需 Apple 开发者证书（99 美元/年）、用户暂不买
- **chat 模式对话 UI 重做（v0.7.11、参照 Cursor agent window、用户点名）**：EventStream / EventRow / StreamingAssistantRow 加 `variant="log" | "chat"`——chat 形态：窄列居中（max-w-3xl）、AI 回复无容器平铺 prose、用户消息浅色圆角块（附件随块内）、thinking / tool_call / info 压成单行细条目（小图标 + 摘要、hover 显时间、点击展开、连续过程行紧凑堆叠）、composer 重做成圆角输入岛（Textarea 去边框嵌入、focus-within 岛框反馈、左下模型选择、右下 icon 附件钮 + ArrowUp 圆角发送钮）、顶栏轻量化（状态文案仅异常 / 发送中出现、awaiting badge 不再常驻）；task 模式 log 形态零变化（默认 variant）；headless Chrome 截图自查过整体形态
- **本地 test 实例机制（v0.7.9 用户拍板「可以本地测、但隔离」）**：`pnpm electron:dist:test` 打「AI工作流test」包；壳按**可执行文件名**含 test（或 env `FE_AI_FLOW_TEST=1`）探测 → 端口 8776 / userData `fe-ai-flow-test` / 跳过 updater、单实例锁按 userData 天然独立——agent 本地验证不再碰用户正式实例（8876 + fe-ai-flow）。踩坑沉淀：`-c.productName` 不改 asar 内 package.json、`app.getName()` 探测不可靠；mac Helper 路径不能 getName() 拼、改扫 `Frameworks/* Helper.app`；spawn 加 `error` 事件监听（ENOENT 此前静默挂死 pid=undefined）
- **导航 / 链接规范化 + 版本号显示（v0.7.8、全站 UX review）**：① 设置页「返回」从写死 `href="/"` 改 `router.back()`（无历史兜底首页）——用户实测「任务详情→设置→回不去」；② chat 模式顶部条补「返回」按钮（跟 task 模式同款、此前只能点 logo）；③ 壳 `setWindowOpenHandler` **零白名单**——站内 URL 开 Electron 子窗的 allow 分支删掉（AI 给的 `127.0.0.1:8876/...` 绝对链接点击「应用内闪一下」、用户实测差评）、所有 window.open 一律系统浏览器；④ 壳注入 `window.__appVersion`、设置页标题旁显示版本号（用户「不确定装的是不是最新版」）；⑤ task-card 标题真 Link 化（键盘 tab 可达）；⑥ 新规则文件 `.cursor/rules/ui-conventions.mdc`（导航 / 链接 / 反馈 / 设计 skill 用法四节）+ 引入 `frontend-design`（Anthropic 官方）和 `ui-ux-pro-max` 两个设计 skill 进 `.cursor/skills/`
- **mac 更新提醒 + markdown 链接统一新窗口（v0.7.7）**：① mac 壳启动时请求 GitHub `releases/latest` 拿 302 location 抠版本号（不走 API 不吃 rate limit）、比 `app.getVersion()` 新则弹「打开下载页 / 稍后」+ 复用 badge 链路（注入 `__appUpdateMode: install|download`、UpdateBadge 按 mode 切 confirm 文案、`app-update://install` 壳侧分流 win quitAndInstall / mac openExternal 下载页）；② AI 回复 / artifact 里 markdown 原生链接此前是裸 `<a>` 同 frame 导航、桌面端点相对路径链接整窗跳 404（用户实测「点了没反应」）——新增 `src/components/markdown-link.tsx` 统一渲染：http(s) → target=_blank（浏览器新 tab / Electron 转系统浏览器）、相对路径 / 其它协议（AI 幻觉链接）→ 等宽纯文本不可点；事件流 MarkdownText + artifact-panel 两处 ReactMarkdown 接入；cursor:// 跳转（artifact code 组件 / 事件流附件）与 MR 外链行为不变
- **安装包平台依赖修正（v0.7.6）**：win 同事「获取模型列表」报 `Unexpected token '<'`（前端拿到 HTML 500 页）、排查实锤两个 ubuntu 组包带来的平台 bug：① `sqlite3` 的 `.node` 是 linux ELF、win/mac 上 require 直接 `ERR_DLOPEN_FAILED`（mac 同源布局 sqlite3 整包缺失反而没事——`MODULE_NOT_FOUND` 走 SDK 降级、「存在但错架构」吞不掉）；② SDK 平台工具包 `@cursor/sdk-<platform>`（ripgrep + 沙箱 helper）运行时动态拼名加载、nft 追不到、全平台缺失——修法：electron win/mac job 解 tar 后在**目标平台 runner** 上 `npm install --no-save` 补对应平台的 sqlite3 + SDK 平台包、再 `node -e "require('sqlite3')"` 实加载验真防带病发版。⚠️ 欠账：绿色包 win zip（ubuntu 组）同样带 linux sqlite3、待跨平台拉 prebuilt 修；本地 dev 组包（isolated trace）sqlite3 / 平台包整包缺失但有降级、一直能跑、不动

- **server 数据目录可注入**：新增 `src/lib/server/data-root.ts`（`FE_AI_FLOW_DATA_DIR` env 优先、回落 `process.cwd()/data`）、task-fs / mcp-oauth / uploads route 三处硬编码全部改走它——Electron 下 data 落系统 userData、dev / 绿色包行为不变
- **Electron 壳 `electron/main.js`**（纯 JS、不过 tsc）：单实例锁；`spawn(process.execPath, [server.js])` + env 三件套（`ELECTRON_RUN_AS_NODE=1` 让 execPath 表现为 node 且被 hooks 孙进程继承 / `PORT=8876` + `HOSTNAME=127.0.0.1` / `FE_AI_FLOW_DATA_DIR=userData/data`）；起 server 前探 8876 端口、被占（旧绿色包还在跑）弹 dialog 确认后杀占用进程；轮询就绪后开 1280x800 窗口（记忆上次尺寸）；关窗杀 server 子进程；win `autoUpdater.checkForUpdatesAndNotify()`（mac 未签名跳过）
- **electron-builder**：壳进 asar、组好的 server 布局（standalone + prompts/skills/scripts、**删 data/ 防隐私泄漏**）走 `extraResources` 进 `resources/app-server/` 不进 asar；**不再打便携 node**（Electron 自带运行时）；win `nsis`（oneClick、装用户目录免管理员）+ mac `dmg`（arm64）；`publish: github` 自动产 `latest.yml` 喂 electron-updater；图标 `packaging/icon.png`（buildResources 指 packaging、builder 自动转 ico/icns）
- ⚠️ **electron-app 依赖必须用 pnpm 装**：electron-builder 按根 lockfile 判定 pm=pnpm、npm 装的 node_modules 收集不到、会 fallback 把主项目 production 全家桶打进 asar（实测 271M → 修后 2M）
- **CI**（v0.7.15 起绿色 zip job 已删、唯一发版链 = electron）：electron win/mac 矩阵 job **复用 ubuntu job build 的 standalone**（tar artifact 传递——纯 JS 跨平台、且 win runner 上 next build 撞 `EPERM scandir "Application Data"` junction 必须绕开）；组 server 布局逻辑从 `package-release.mjs` 抽公共函数 `scripts/lib/assemble-server.mjs` 复用；v0.7.0 tag CI win 失败、v0.7.1 修复重发
- 已知风险（用户已确认）：未签名 exe 首次装 SmartScreen 要点「仍要运行」；mac 无公证 autoUpdate 不可用；桌面端 localStorage 独立于浏览器、设置要重配；旧 data 迁移 = 手动拷 `data/` 到 userData（mac `~/Library/Application Support/fe-ai-flow/` / win `%APPDATA%\fe-ai-flow\`）

### V0.6.34：win launcher 一键自动更新——有新版自动停旧进程（2026-06-11）

背景：原 launcher 流程「端口在跑 → 直开浏览器退出」、更新永远轮不到——同事得先去任务管理器杀 node.exe 才能吃到新版、对非前端复杂度太高。

- **`packaging/launch.ps1` 流程重排**：先查 GitHub latest（fail-open）→ 端口在跑且**无新版** = 直开浏览器（日常零感知）；在跑且**有新版** = `Stop-ServerOnPort`（`Get-NetTCPConnection -LocalPort` 拿 PID + `Stop-Process`、老系统 fallback netstat 解析；只杀监听本端口的进程、不误伤其它 node）→ 等端口释放 → 走原更新 + 重启
- 同事体验：发新版后**只需再双击一次桌面图标**、停进程 / 更新 / 重启全自动
- ⚠️ 鸡生蛋：这个新 launcher 本身要随包分发——**同事吃 v0.6.34 这一次仍需手动停一次服务（或重启电脑后点图标）**、从下一版起才是真·一键
- 取舍：点图标时 agent 正在跑任务会被中断——主动行为、可接受；mac launcher 未同步改（主要用户是自己、需要时再说）

---

## 关键文件索引

| 内容 | 位置 |
|---|---|
| **V0.6 重构设计文档（已 archived、V0.6.0 落地完成）** | `docs/V0.6-REFACTOR.md` |
| **V0.6 统一 runner（task 容器 + action history）** | `src/lib/server/task-runner.ts` |
| **V0.6 action 后置 deterministic check（含 V0.6.25 build CheckRun：checkBuild / runCheckShell / 工作区污染 + V0.6.25.1 指纹检测 / computeWorktreeFingerprint）** | `src/lib/server/action-checks.ts` |
| **CheckRun 检查命令自动检测（V0.6.26、建 task 没手配则按 repo 文件结构识别 Node/Maven/Gradle；manual override > auto detect）** | `src/lib/server/repo-check-detect.ts` + `task-fs.sanitizeCheckCommands` |
| **协议信号单一常量源（V0.6.27、信号 ↔ prompt 一致性由测试守护）** | `src/lib/protocol-signals.ts` + `tests/protocol-signals.test.ts` |
| **shell 命令硬拦截（V0.6.27、beforeShellExecution hook 策略引擎）** | `src/lib/server/shell-guard-rules.ts` + `scripts/shell-guard.mjs` + `src/app/api/hooks/shell-check/route.ts` |
| **submit_mr 范围校验（V0.6.27 从 task-runner 拆出、防 agent 越权提 MR）** | `src/lib/server/submit-mr-guard.ts` |
| **vitest 测试（V0.6.27、安全关键纯函数 + prompt 一致性）** | `vitest.config.ts` + `tests/*.test.ts` |
| **Build CheckRun 结果展示卡（V0.6.25、每仓 / 每命令红绿 + 失败日志末尾 + 完整日志路径）** | `src/components/tasks/check-run-summary.tsx` |
| **ship 前置预检 API（V0.6.25.1、复用 checkShipCheckGate 给 advance-dialog 拿 gate 结论展示 override 区）** | `src/app/api/tasks/[id]/ship-precheck/route.ts` + `getShipPrecheck`（task-runner）|
| **V0.6 task schema + 文件系统** | `src/lib/types.ts` + `src/lib/server/task-fs.ts` |
| **批次推导 + 展示（V0.6.23 起、computeBatchProgress 前后端共用 / 进度 chip / 批次表 / 选批 / 测试策略 label）** | `src/lib/task-display.ts` + `src/lib/types.ts: PlanBatch / TestStrategy / TEST_STRATEGY_LABEL` + `src/components/tasks/{batch-progress,batch-plan-table}.tsx` + `advance-dialog.tsx` 选批 |
| **GitLab REST client（V0.6.1 新、V0.6.8 加 closeOpenMR 关被取代的旧 MR）** | `src/lib/server/gitlab-client.ts` |
| **agent 孤儿子进程清理（V0.6.8、停 task / finally 调）** | `src/lib/server/kill-orphans.ts` |
| **读 Cursor 全局配置 mcp/rules（V0.6.2 新）** | `src/lib/server/cursor-config.ts` |
| **Cursor MCP 只读 API + hook（V0.6.2 新）** | `src/app/api/cursor-mcp/route.ts` + `src/hooks/use-cursor-mcp.ts` |
| **MCP OAuth（V0.6.4 新、走 OAuth 的远程 MCP 授权 + 注入）** | `src/lib/server/mcp-oauth.ts` + `src/app/api/mcp-oauth/{start,callback,status,revoke}` + `src/hooks/use-mcp-oauth.ts` |
| **设置页编辑即保存（V0.6.5、6 张卡片去 SaveButton）** | `src/hooks/use-settings.ts: saveFieldValue`（唯一落盘入口）+ `src/app/settings/page.tsx` + `src/components/settings/*-card.tsx` |
| **「常用 MCP」全局开关（V0.6.5、设置页配 + 建 task 取快照）** | `FeAiFlowSettings.disabledMcpServers` + `src/components/settings/mcp-card.tsx` |
| **super-prompt 主模板（V0.6.27 起只注入当前 action playbook）** | `prompts/_super.md` |
| **跨 action 共享规范** | `prompts/_shared.md` |
| **plan / build / review / ship / learn action prompt** | `prompts/action-{plan,build,review,ship,learn}.md` |
| **learn 知识沉淀（V0.6.29、三层架构 + 防臃肿 4 闸 + checkLearn 证据验真）** | `prompts/action-learn.md` + `action-checks.ts: checkLearn` |
| **Electron 桌面端发版链（V0.7.0 薄壳 + 打包 + 自更新；v0.7.15 起唯一发版链、server 布局组包走公共函数 assemble-server）** | `electron-app/main.js` + `electron-builder.yml` + `scripts/assemble-electron-server.mjs` + `scripts/lib/assemble-server.mjs` + `src/lib/server/data-root.ts` |
| **test stub（设计草稿）** | `prompts/action-test.md` |
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
| 设置：仓库列表 + per-repo 分支 + 模板覆盖（V0.6.7）+ 检查命令（V0.6.25 CheckRun checkCommands 编辑器） | `src/components/settings/repo-card.tsx` + `repo-check-commands.tsx` |
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
