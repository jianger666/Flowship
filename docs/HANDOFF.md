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

### 应用外壳 + 侧栏任务导航（V0.8）

全局 UI 外壳 `AppShell`（`src/components/app-shell.tsx`）：顶栏（`app-header.tsx`）+ 常驻左侧栏（`app-sidebar.tsx`）+ 主内容区三段。

- **侧栏即导航**：任务列表在侧栏（不在首页）、点侧栏项即切任务（`router.push`、URL 仍 `/tasks/[id]`）；侧栏可展开 / 收起（`w-64` ↔ `w-0` push 主区、收起后复杂详情页全宽不被遮挡）、开合态 localStorage 记忆 + `⌘/Ctrl+B` 切换（焦点在输入框时让行）；展开 / 收起 toggle 常驻顶栏红绿灯右侧（位置固定不随开合跳）。
- **侧栏列表**：置顶组（pin）+ 活跃（updatedAt 倒序）+「更早」折叠（archived）；顶部「新建任务」+ 类型筛选（图标下拉选 全部 / 任务 / 对话、非全部时列表顶显示类型标题）；任务行 = 类型图标（对话气泡 / 任务清单）+ 标题（hover `Tooltip` 补全）+ hover 置顶 / 删除、当前项高亮；**状态不用色点**（开发中是常态、满屏点是噪声、`getTaskStatusDot` 已删）。
- **共享列表 store**：侧栏 + 各页面共享 `useTaskList`（`src/hooks/use-task-list.tsx`）一份 `TaskSummary[]`、新建 / 删除乐观更新 + mount / window focus 刷新。挂在 `providers.tsx`。
- **首页 `/` = 轻量欢迎页**：新建入口 + 最近任务快捷跳转、不再堆列表。
- **归档无手动入口**：终态任务由后端 7 天 auto-archive、侧栏收进「更早」折叠分组（`TaskCard` 组件 + 首页「已归档」视图已删）。
- **高度 / 滚动模型**：body `h-screen overflow-hidden`、滚动交给主区（`overflow-y-auto`）；详情页 `h-full` 内部分栏滚、首页 / 设置在主区滚；顶栏分隔线由主区 scrollTop 驱动（`AppShell` 算后传 `app-header`）。

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

### v0.8.0：侧栏任务导航（列表搬进常驻侧栏、多任务秒切）（2026-06-15）

痛点：首页是任务大列表、切任务必须「详情 → 返回 `/` → 进另一个」、多任务并行来回切累。改成 ChatGPT / Cursor 式常驻左侧栏：点侧栏即切任务、可展开 / 收起（收起宽度归零、复杂详情页不被遮挡）。用 `ui-ux-pro-max` + `frontend-design` skill 辅助（落实当前项高亮 / 键盘可达 / push 不遮挡 / 视觉克制）。

- **应用外壳 `AppShell`（新 `app-shell.tsx`）**：包「顶栏 + 侧栏 + 主区」、持侧栏开合态（localStorage `fe-ai-flow:sidebar-open` 记忆）+ `⌘/Ctrl+B` 切换（焦点在输入框时让行）+ 路由切换主区归顶。`layout.tsx` 用它取代旧「header + main」、body `h-screen overflow-hidden`（整体不滚、滚动交给主区）。
- **侧栏 `AppSidebar`（新 `app-sidebar.tsx`）**：顶部「新建任务」实色按钮 + 类型筛选（`ListFilter` 图标点开 Popover 选「全部 / 任务 / 对话」、localStorage 记忆）；列表分「置顶（pin）/ 活跃（updatedAt 倒序）/ 更早（archived 折叠、默认收起）」；行尾 hover「置顶 / 删除」（删除二次确认 + 乐观移除 + 删当前任务回首页）。`open ? w-64 : w-0` 过渡 push 主区。
- **共享列表 `useTaskList`（新 `use-task-list.tsx`）**：侧栏 + 各页面共享 `TaskSummary[]`、`refresh`（mount + window focus）/ `upsertTask`（新建即时插入 / 状态同步、Task 自动收窄 Summary 剔除 events）/ `removeTask`（乐观）。挂 `providers.tsx`。
- **任务行 `TaskListItem`（新）**：侧栏 / 欢迎页共用、一行 = 行首**类型图标**（对话 = 气泡 `MessageCircle` / 任务 = 清单 `ListTodo`、所有行左缘对齐）+ 标题 truncate（hover `Tooltip` 补全长标题）+ 行尾 hover 操作（置顶 `Pin` / 删除）、当前任务高亮（左 primary 竖条 + 底色）。**状态不再用色点表达**（2026-06-15 用户反馈：开发中是常态、满屏色点是噪声、且 shell 保活超时几乎每个任务最终落 error 标红误导）——`getTaskStatusDot` / `TaskStatusDot` 已删。
- **置顶 pinned（全栈）**：`Task.pinned`（types + `task-fs` schema/hydrate + PATCH `/api/tasks/[id]` + `setTaskPinned` client），侧栏置顶组排最前。
- **类型筛选**：侧栏顶部 `ListFilter` 图标点开 `Popover` 下拉选「全部 / 任务 / 对话」（状态 localStorage 记忆、非「全部」时图标高亮 + 列表顶部显示当前类型标题 +「清除筛选」），避免用户以为任务丢了。
- **新增 `Tooltip` 组件**（`ui/tooltip.tsx`、base-ui、长标题 hover 补全）。
- **首页 `/` → 欢迎页**：删大列表（在侧栏）、改 hero（一句定位 + 新建 CTA + 继续最近、logo 柔和光晕 `/8`）+ 最近任务入口。
- **去手动归档**：首页「已归档」视图 + `TaskCard` 整个组件删、归档退化为侧栏「更早」折叠（沿用后端 7 天 auto-archive、不再让用户手动操心）。
- **顶栏 / 详情页适配**：侧栏展开 / 收起 toggle 常驻**顶栏红绿灯右侧**（`app-header.tsx`、位置固定不随开合跳）+ scrolled 改外壳传入；详情页 task + chat 两模式去 `h-[calc(100vh-3.5rem)]` 改 `h-full`、去冗余「返回」按钮（侧栏常驻 + logo 已能回首页、对标 ChatGPT/Cursor）；`LoadingState` block 同步去 calc。
- 验证：typecheck + lint 全绿 + 3 步打包（`BUILD_STANDALONE=1 pnpm build` → `assemble-electron-server.mjs` → `electron:dist:test`）+ test 包（8776）端到端验证。

### v0.7.23：light/dark 主题 + 自定义同色标题栏 + 包瘦身 + chat 运行态重构（2026-06-15）

本轮一次会话堆了 7 块改动（均已 test 实例验证、未单独 tag）：① **Electron 包瘦身（~600M 起步）**：`next.config.ts` `outputFileTracingExcludes` 显式剔除 file-tracing 误拖进 standalone 的死重（`sharp`/`@img` libvips、`typescript` devDep、`caniuse-lite` 构建期专用、合计 ~26M、grep 实证运行时零 require）+ `electron-builder.yml` `electronLanguages` 只留中英 locale（Chromium 默认塞 ~220 国 ~47M、本应用 UI 全自绘中文、只 Chromium 原生右键菜单用 locale；不影响 icudtl.dat）。② **light/dark 三态主题（一步到位、默认跟随系统、codex 灰调）**：`providers.tsx` next-themes 从 `forcedTheme=dark` 改 `defaultTheme=system + enableSystem`；`globals.css` 补 light 色板（codex 风浅灰底 oklch(0.967) + 白卡浮起、全局极微冷调 hue264 避免死灰）+ dark 提亮柔化（纯黑 0.145→0.17、card 拉层次、border 10%→12%）+ prism token / 滚动条色全主题变量化（light 压暗保白底可读）；新增 `theme-toggle.tsx`（顶栏三态 popover：浅色 / 深色 / 跟随系统）；`artifact-diff.tsx` diff viewer 跟 `resolvedTheme`（删 dark-only prism-tomorrow.css）；`mcp-oauth/callback` 结果页 + `main.js` 加载页/窗口底色都跟 `nativeTheme` 系统深浅、消除浅色系统启动闪黑。③ **自定义同色标题栏（Cursor 式一体顶栏、mac+win）**：新增 `app-header.tsx` 替换 `layout.tsx` 旧 header——品牌（logo+「AI工作流」）居中、整条 `-webkit-app-region:drag` 可拖窗 + 交互元素 no-drag、滚动 >0 才浮现 border-b；`main.js` mac `titleBarStyle=hiddenInset` + `trafficLightPosition` 对齐 h-14、win `hidden` + `titleBarOverlay`（height 56、运行时主题切换走 IPC `set-titlebar-overlay` 同步控制按钮条底色/图标色）；`preload.cjs` 暴露 `window.__shell`（platform + setTitleBarOverlay）。④ **app icon 圆角平台分治**：win 用预圆角透明角 squircle `packaging/icon-win.png`（`electron-builder.yml` `win.icon`、任务栏显圆角）、mac 继续满幅方块 `packaging/icon.png`（Tahoe 自己加圆角且不垫白底、共用透明角图会被 Tahoe 垫成白底方块、踩过）；header `public/logo.png` 用透明角 squircle、`<img>` 不再叠 ring/CSS 圆角。⑤ **prompt 修订：先回复再 wait_for_user（线上 money看板 翻车驱动）**：composer-2.5 干完工具/部署直接挂等、正文全空（用户连追 4 次才吐链接）——`chat-mcp.ts` `CHAT_REPLY_REMINDER` 重排成两步且**正文在前**（① 先把结果/链接/结论写进正文 ② 再 wait_for_user）、`wait-protocol-prompt.ts` `chatShellWaitGuideBody` 自检改「正文是否已发出、只调工具≠回答=用户看到空白」；顺手精简该文件冗余（删「收尾语也照样等」整段、step5 去括号、消歧义交叉引用）。⑥ **chat 运行态指示器重构（ui-pro-max、零布局抖动）**：`chat-view.tsx` 删顶栏「AI 正在回 + 停止」簇、`statusHint` 瘦身 error-only；`event-stream.tsx` 运行态收进输入框操作行（loading 转圈 + 红方块停止键替代发送键、点即停）、删输入框下方那条会顶高布局的「agent 正在思考」状态行（content-jumping severity high）、模型选择器与输入加 pt-1.5 间距。⑦ **修 chat「停止后 AI 还回复」冷启动竞态**：`runChatSession` 旧版到 `agent.send` 之后才把 run 注册进 `runningChats`、而 `cancelChatRun` 靠 `runningChats.get` 命中——`Agent.create` / `send` / MCP 健康探测的数秒冷启动窗口里点停止会扑空（连 cancelled 标志都来不及设）、run 照常启动复述 + 回复（用户线上实测、事件流「用户停止了对话」落在「Chat 任务启动」之前为证）；改为**进入即占位注册**（cancel 置 cancelled + 有 run 时真 `run.cancel`、agentId 先空 send 出来回填）、`try/finally` 扩到覆盖全程保证占位 record 必清理（不泄漏 `has=true` 卡死后续启动）、MCP 探测 / create / send 三个 await 后各加 cancelled 检查点提前收尾（idle + done、不重复落停止事件）。附带清理网页版残留（`use-mcp-oauth` 删浏览器预开窗分支、`native-picker`/`update-badge`/`repo-card` 去 web 版兜底注释）+ `learned-conventions` test 实例/包默认不关不删（2026-06-15 用户修订、覆盖旧「测完删包 / 立即关 test」）。

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
| **light/dark 三态主题 + 自定义同色一体标题栏（v0.7.23、next-themes 三态跟随系统 + 壳 hiddenInset/titleBarOverlay 顶栏；色板/prism/滚动条全主题变量化）** | `src/components/app-header.tsx` + `src/components/theme-toggle.tsx` + `src/app/globals.css` + `electron-app/{main.js,preload.cjs}` |
| **test stub（设计草稿）** | `prompts/action-test.md` |
| **chat 模式独立 runner（V0.6.0.1 新、v0.7.23 进入即占位注册修「停止后还回复」冷启动竞态）** | `src/lib/server/chat-runner.ts` |
| **chat 模式 UI（V0.6.0.1 新）** | `src/components/tasks/chat-view.tsx` |
| **chat 模式 API** | `src/app/api/tasks/[id]/chat-reply/route.ts` |
| **等待协议 prompt 单一源（v0.7.21、chat+task 共用「写完→wait_for_user→shell curl 挂等」机制纪律 + 三认知陷阱；v0.7.23 强化「先回复正文再 wait」）** | `src/lib/server/wait-protocol-prompt.ts` |
| `wait_for_user` / `ask_user` 实现 + pendingMap（v0.7.23 `CHAT_REPLY_REMINDER` 重排两步正文在前） | `src/lib/server/chat-mcp.ts` |
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
| 新建任务 dialog（V0.6.0.1 重新加 mode tab、V0.8 加 `trigger` prop 供侧栏自定义触发） | `src/components/tasks/new-task-dialog.tsx` |
| 编辑任务 dialog + 字段热更（V0.6.6、详情页改软配置字段、reused agent diff 注入 `[TASK_UPDATED]`） | `src/components/tasks/edit-task-dialog.tsx` + `task-fs.ts: updateTaskFields` + `task-runner.ts: buildTaskUpdateHint` |
| **应用外壳 + 侧栏任务导航（V0.8、常驻侧栏切任务 / 展开收起 ⌘B / 共享列表 store / 欢迎页 / 任务行状态点）** | `src/components/app-shell.tsx` + `src/components/app-sidebar.tsx` + `src/hooks/use-task-list.tsx` + `src/components/tasks/task-list-item.tsx` + `src/app/page.tsx` |
| 任务详情页（V0.6 重写、V0.8 去返回按钮 + h-full 适配外壳） | `src/app/tasks/[id]/page.tsx` |
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
