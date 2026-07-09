# ai-flow Handoff

> **权威源**：代码 + 本文件。其余 docs/*.md 为辅助、有冲突以代码 + 本文件为准。

## 项目定位（一句话）

站在 Cursor SDK 肩膀上的**项目级 AI Harness 平台 · 飞书 story → MR 自动化**。核心是 Harness（缰绳）：每个 action 边界用确定性工具（artifact 落盘 / 必备段 lint / review 只读指纹 / 基底 commit 校验 / MR 门禁 / HITL ack）压住 LLM 非确定性、保证产出可观测、可回退、可复用。

## 给 AI 接力的最小上下文

按顺序读：

1. `.cursor/rules/project-context.mdc` —— 强制约束
2. `.cursor/rules/learned-conventions.mdc` —— 编码风格
3. 本文件「当前架构快照」段（V0.6 系列、稳定架构）+「最近演进」段
4. `prompts/_super.md` —— super-prompt 主模板（V0.6.27 起只注入当前 action playbook + action history）
5. `prompts/_shared.md` —— 跨 action 通用 artifact 写法 + 跨 action 规则
6. `prompts/action-plan.md` / `action-build.md` / `action-review.md` / `action-ship.md` / `action-learn.md` / `action-dev.md` —— 各 action 的特有约束
7. `src/lib/server/task-runner.ts` —— V0.6 统一 runner（v0.9.7 拆出 task-stream / task-prompts / action-gates / sdk-message-handler 四模块、runner 只留编排）
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
- **action** = 单次动作（plan / build / review / ship / dev 联调 / learn）、任意触发、不强制顺序

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
| build | ✅ 已实装 | 永远可（V0.6.17 放开 plan 前置）| artifact 落盘 + 必备段（全量校验 / 修改记录）+ 兄弟仓越权检测（V0.6.27）；跑项目命令的 CheckRun 已删（v0.9.13、见下）|
| review | ✅ 已实装 | 永远可（v0.8.23 去「先 build」流程前置）| 必备段（总评 / 需求对照 / bug 复审）+ 基底 commit 跟 HEAD 一致（V0.6.25 P1-2 修死代码正则）+ 工作区指纹未变（V0.6.27 只读硬校验）|
| ship | ✅ 已实装 | settings 配 GitLab Host + PAT（v0.8.23 去「先 build」、只留技术前置）| `task.mrs[]` 覆盖所有 repoPath（URL 非空） + 跳仓有原因 |
| dev（联调）| ✅ 已实装 v0.8.23 | 至少一仓配 dev 分支 | 直推无 MR 信任 artifact；提 PR 同 ship 门禁（URL 非空 + 冲突拦）|
| learn | ✅ 已实装 | 永远可（v0.8.23 去「先有 completed action」）| 必备段 + checkLearn 证据验真 |

stub action 的 prompt 文件存在（V0.6.2+ 设计草稿）、UI 推进 dialog 灰掉、runner 准入拒绝。

### 大需求分批 build（V0.6.23 起、V0.6.24 打磨、可选）

plan 可把大需求在 §5 task 之上再分「批次」（`PlanBatch`、plan agent 调 MCP `set_plan_batches` 上报、落 `ActionRecord.planBatches`）。之后：

- **build 选批**：推进 build 时 advance-dialog 列批次让用户勾（**默认不勾任何批次**、必须显式选本次要做 / 返工的批次、`canSubmit` 拦空选；提供一键「全选」、已做的带角标）、`requestedBatchIds` 落到该 build action；runner `buildBatchDirective` 把「本次做哪批 + 测试策略 + 进度」拼进 `[NEXT_ACTION]` 的 `[BUILD_BATCHES]` 段；每批可「新启 Agent」换干净上下文（无 subagent 原语、用这个当等价物）
- **测试策略**：每批标 `TestStrategy`（tdd / after / none、自适应不强制、label「先写测试(TDD) / 实现后测试 / 免测」走 `TEST_STRATEGY_LABEL` 单一源）、build agent 按策略走（TDD 批用 `shell` 实跑仓库现有测试框架、先写测试看红 → 实现到绿；无测试设施则退化「正常实现 + artifact 写明该测什么」）
- **review 两层**：runner `buildReviewScopeDirective` 按派生进度注入 `[REVIEW_SCOPE]`——还有批没做 = 增量（聚焦新批 + 衔接）、全做完 = 集成（查批次间接口 / 数据流 / 重复实现 / 冲突）
- **进度纯派生**：`task-display.computeBatchProgress` 从 action 历史算「已做批 / 总批」、不存计数器（前后端共用单一源）；`getLatestPlanBatches` 倒序取「最新一个有批次的 plan」**不限 status**（批次是 agent 主动落库的有效数据、plan 重跑被标 error / 接续没重拆都能回退到拆好那版、避免分批失效）
- **多轮 build artifact 只写增量（V0.6.26）**：新 build action 不能复制上一轮完整实现文档；本轮改了代码就写本轮变更，本轮评估后不改则写「本轮无代码改动」+「有效实现来源：沿用 build #N（`actions/N-build.md`）」。review / ship 看到无代码 build 必须沿该来源递归追溯到真正改代码的 build，避免用户界面被旧 md 刷屏、也避免后续 action 丢上下文。
- **展示（V0.6.24 chip 化）**：详情页头部「上下文文档 / MCP」chip 行里加 `BatchProgress` chip（`batch-progress.tsx`）——拆了批次=实色「批次进度 N/M」、点开 Dialog 看进度条 + 每批详情；没拆=灰色「未分批」chip 占位；plan 产物（`artifact-panel.tsx`）无批次时顶部「未分批」提示条（防 AI 漏调 set_plan_batches 用户不知情）、有批次时底部 `BatchPlanTable` 渲染批次表（从 planBatches、不解析 markdown）
- 小需求 plan 不分批（不调 set_plan_batches）→ build 退化单次做全部、老流程不变

### Agent 生命周期：每 action 默认新 agent（V0.6.27 反转）

V0.6.26 以前默认「单 SDK Run 跑全 task、forceNewAgent 是例外」、V0.6.27 反转为「**每 action 默认起新 agent**、续用是例外」：

- 理由：context 膨胀是跑偏的物理根源（lost in the middle）、artifact 本来就是 action 间唯一合法通信媒介、新 agent 冷启动所需上下文全量可重建（review fresh peer 自 V0.6.9 验证可行且效果更好）
- 生效逻辑（`advanceTask`）：`effectiveForceNewAgent = !reuseAgent || ACTION_FRESH_AGENT_DEFAULT[type]`——UI「续用当前 Agent」开关是例外逃生口（省 send 配额 / 需要连续上下文时手动勾）、review 勾了也强起新（换人复审铁律）
- 连带：super prompt 只注入**当前 action** 的 playbook（不再全量 6 种、体积 -60%+）；续用路径收到 `[NEXT_ACTION]` 时、server 在载荷里附带新 action 的完整 playbook（`buildNextActionDirective(actionPlaybook)`）

**会话内协议（V0.11 起「create + 多轮 send」、run 自然结束）**：

- 用户每次「推进」action → 默认起新 agent + super prompt 冷启动；勾续用 → 对存活会话 `agent.send([NEXT_ACTION ...])` 接力
- agent 跑完 action → 调 `wait_for_user(action_id)` **交卷**（非阻塞、返回「结束回复」）→ agent 正常结束 turn、run finished；runner **后台异步**跑后置检查（V0.8.18）、跑完把 action 标 `awaiting_ack`
- 用户操作以 send 送达：再聊聊 = `send([ACTION_ACK revise]+feedback)`、ask 答案 = `send([ASK_USER_REPLY]…)`；**通过纯服务端落状态**（agent 不需要收信号）
- 终结 task → finalize 直接 cancel 活 run + 关会话（不再发 [TASK_DONE] 信号）

**字段热更（V0.6.6、仅续用路径需要）**：super prompt 只在会话启动时构造一次、续用推进时用户在详情页编辑的 `title/role/feishuStoryUrl` 会 stale。runner 在 `agentSessions` record 存启动快照（内存、不落盘）、续用推进时 diff 出变更、**有变才**拼一段 `[TASK_UPDATED]` 注入 `[NEXT_ACTION]` directive（注入后推进快照防重复告知）。

### 会话机制：agent 会话跨 run 存活（V0.11、替代 V0.3.5~V0.10 的 shell curl 长轮询）

```
Agent.create（每 action 默认新建 / 勾续用复用）
  → agent.send(prompt) → run 流式消费 → agent 交卷 / 提问后自然结束 turn → run finished
  → agent 实例保留在 agentSessions（不 close）
  → 用户下一步操作（推进续用 / 再聊聊 / ask 答案 / chat 消息）→ agent.send(新消息) → 新 run
  → stop / error / finalize / 换新 agent / 服务重启 → 会话关闭（下次 fresh agent + artifact/events 恢复上下文）
```

「run 自然 finished 但最后 action 还 running」时豁免两种正常情况（后置 check 在跑 = 刚交卷、pendingAsk 在等答案）、否则判「没交卷就跑了」标 error（stop-hook 同口径先行拦截）。

### 推进 dialog（V0.6 重写）

用户从「推进」按钮打开 dialog、选下一个 action 类型 + 写指令：

- **action 类型卡片**：内置 + 自定义混排、顺序 / 显隐在 /actions 页配（隐藏的直接不出现）；不满足准入条件灰掉 + hover 提示
- **默认选中**：可见列表第一位（用户自己排的顺序、无业务假设——v0.9.12 删掉按 repoStatus / 最近 action 顺推的 `inferDefaultActionType`、工具通用化不再假设研发流程）；全部隐藏时空态引导去 /actions 页
- **placeholder 动态**：按 action 类型 + task 状态变（has_bug + build → 「修哪个 bug」/ 首次 plan vs 再次 plan 不同）
- **reuseAgent**（V0.6.27 语义反转）：默认不勾 = 起新 agent（可顺带临时换模型）、勾上 = 续用当前 agent（省 send 配额、review 勾了也强起新）

### Ack：再聊聊 + 推进隐式认可（v0.8.23 去掉「通过」按钮）

ack 路径简化到只剩「再聊聊」、approve 收进「推进」：

- **通过 = 推进**（v0.8.23）：删掉独立「通过」按钮——推进时若当前 action 还 `awaiting_ack`、`advanceTask` 先隐式认可它（续接走 `acknowledgeAction(approve)`、force-new/无活 agent 走 `patchAction(completed)` + 审计事件、认可后重读 task），少一次点击；HITL 不变（推进仍是人主动触发）。`canAdvance` 不再被 `!canAck` 卡；配 `setTaskAwaitingIfIdle`（锁内 compare-set）防 force-new 秒推 race。
- **再聊聊（revise）**：「再聊聊」按钮 → ReviseDialog 写 feedback + 可选附图 → submitActionAck("revise", feedback, images) → 同 agent 改 artifact

切模型 / 换 agent 统一在「推进」dialog 的高级选项里。

### 6 个 Harness 门槛（V0.6 核心）

V0.5 phase 顺序拆掉后、用 6 个显性门槛补回保证：

| 门槛 | 实现 | 位置 |
|---|---|---|
| 1. action 前置准入 | runner `checkActionPrerequisites` + UI dialog 灰掉 | `task-runner.ts` + `advance-dialog.tsx` |
| 2. action 后置 deterministic check | runner 切 awaiting_ack 前跑、写 `action.postCheck` | `action-checks.ts` |
| 3. 默认 default | 可见列表第一位（v0.9.12 删按 task 状态推断、通用化） | `advance-dialog.tsx` open-effect |
| 4. action 级 anti-patterns prompt | 每个 `prompts/action-<type>.md` 头部红线段 | `prompts/action-*.md` |
| 5. cross-action 一致性自检 | V0.6.4+ 再做 | - |
| 6. placeholder 动态 | UI 按 action + task 状态变 | `advance-dialog.tsx: buildPlaceholder` |

### 后置 check 的边界：只查交付诚实性、不跑项目命令（v0.9.13 拍板）

门槛 2（action 后置 deterministic check、`action-checks.ts`）的检查范围**只到「agent 交付是否诚实」为止**：artifact 落盘 + 必备段 lint、review 只读指纹 / 基底 commit 验真、ship MR URL 覆盖所有仓、learn 证据路径验真、build 兄弟仓越权检测。

**不跑项目命令**（typecheck / lint / test）。V0.6.25~V0.6.26 曾建过一整套 CheckRun（per-repo 配命令 + 自动检测 + 污染检测 + ship gate override 留痕）、v0.9.13 整套删除、根因是语义错配：

- 全仓检查问的是「项目是不是绿的」、但存量项目基线本来就红（历史债）——agent 只改两个文件也永远红、红色失去信息量、还连带 ship 每次都要 override 填原因（用户实测「公司项目几乎全部不通过」）
- 方向通用化后（测试 / BI 等非研发用户、纯自定义 action）「研发流程假设」不再成立
- 代码质量校验由 build agent 自己做（`action-build.md` 让 agent 找仓库命令做**增量**校验、改哪查哪）+ review action 人审兜底

保留的基建：`runActionPostCheck` 后台异步框架（`runningChecks` 去重 + abort、防状态交错——check 同步 await 会把 wait_for_user 阻塞到超 Cursor SDK ~60s 工具超时、线上踩过）、`computeWorktreeFingerprint` / `computeRepoStatusHash`（review 指纹 + 兄弟仓基线用、V0.11.2 起纯 Node execFile git 实现）。`GET /ship-precheck`（reviewMissing 提醒）已于 V0.11.7 随黄条整链删除。

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
- **保守黑名单 + fail-open**：只拦 prompt 已明令禁止且误伤面可控的；脚本 / 网络任何异常都放行（误杀比放过代价大）
- hooks.json 注入扩展为 stop + beforeShellExecution 两条（`stop-hook-inject.ts`、旧版 fe 生成的 hooks.json 自动升级补缺、用户自己的 hooks.json 不动）

### Git Branch 自动建（V0.6.1 多仓、V0.6.7 命名模板化）

build action 每次跑前、runner 拼 `GitBranchInfo[]`（每仓 1 条 branch）、prompt 头部追加**多仓 idempotent** checkout 引导。

**分支名按模板渲染**（V0.6.7、`src/lib/branch-template.ts`、内置兜底 `feature/{storyId}-{taskTitle}`、V0.12.x 删 username 字段——老配置迁移时把名字烘焙进模板）：

- 占位符：`{storyId}`（从 feishuStoryUrl 抠）/ `{taskTitle}` / `{date:FORMAT}`、每个值各自 branch-safe 化（含路径分隔 `/`、模板字面的 `/` 才是层级）；老任务快照里的 `{username}` 渲染为空段、由 `/` 清理兜住
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

没填 feishuStoryUrl / 没绑仓时不建 branch、走 fallback。

### Ship action + GitLab REST 集成（V0.6.1）

ship 实现要点：

- **server-side GitLab REST API**：`src/lib/server/gitlab-client.ts` 直接 fetch `/api/v4/projects/:id/merge_requests`、走 PAT (`PRIVATE-TOKEN` header)；**不**依赖 glab CLI / 外部 MCP server
- **提测目标分支 per-repo（V0.6.7）**：MR target = 该仓的测试分支（`task.repoTestBranches[repoPath]`、建 task 时从设置页快照）、没配回退 `test`；agent 从 super prompt「仓库分支配置」段读、不探 `origin/HEAD`（那是默认主分支、跟提测工作流不符）
- **PAT 不暴露给 agent**：agent 通过 MCP 工具 `submit_mr` 间接调、server 端凭 settings 闭包的 token 访问 GitLab；MCP 工具返结构化 JSON（`{ ok, mr_url, mr_iid, mr_version }`）
- **多仓 task 每仓 1 条 MR**：`Task.gitBranches[]` / `Task.mrs[]` / `ActionRecord.sideEffects.mrs[]` 都按 `repoPath` 区分；某仓 `git diff` 为空时 agent 跳过、在 artifact 写跳过原因
- **同分支累计 commit**：同 `(repoPath, 目标分支)` 多次提交不开新 MR、`version` 累加、保留 `createdAt` 首次值——`upsertMR(taskId, repoPath, { targetBranch, ... })`（v0.8.23 去重键加目标分支、同仓提测 MR→test 和联调 MR→dev 各记各的）
- **dev（联调）复用同一 GitLab 基建（v0.8.23）**：提 PR 模式跟 ship 共用 `submit_mr` + `MRRecord` + 冲突门禁、唯一区别 target = dev 分支；直推模式不提 MR（本地 merge dev 直推）。详见「最近演进」v0.8.23
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

### 多仓库 cwd 公共父目录（V0.5.9 沿用、V0.10 叠加 worktree 隔离）

`Task.repoPaths: string[]`、SDK Run `local.cwd = getTaskCwd(task)`（task-worktrees.ts）：

- **隔离 task（`isolateWorktree`、新建默认）** → cwd = `<数据目录>/worktrees/<taskId>/`下的 worktree（单仓 = worktree 自身、多仓 = taskId 目录做公共父）、并行任务互不干扰
- 非隔离（逃生口 / 老 task / chat）走 `getEffectiveCwd(repoPaths)` 旧逻辑：单仓 = 仓自身、多仓 = 公共父目录、0 仓 = home（纯探索 / 答疑场景）

### Resizable 分栏 + Diff 视图（V0.5.10 + V0.5.12 沿用）

任务详情页主区：左 `ArtifactPanel`（当前 selected action）+ 右 `EventStream`、可拖动、持久化在 `task.uiLayout.artifactPanelSize`。

ArtifactPanel toolbar 加「正文 / Diff」切换、`fetchActionRevisions` / `fetchActionDiff` API（V0.5.12 接口同款、key 改 actionId）、有未看 revision 时 Diff 按钮挂红点。

### Skills loader（V0.5 沿用、V0.6 不动）

`src/lib/server/skills-loader.ts` 加载 `<repoPath>/.cursor/skills-*/*.md` + `~/.cursor/skills-*/*.md`、注入到 super-prompt。

---

## 最近演进（窗口式、保留 2 个子版本）

> 写入规则：新子版本完成后在本段顶部追加、超过 2 个时把最老的迁到 `docs/CHANGELOG.md`。

### V0.13-P0（未发版、攒着）：MCP 独立化（2026-07-09、用户拍板「先解耦、为接 Codex / Claude Code 等多 backend 留口子」）

- **运行时只读 fe 自管配置**（config.json → settings.mcpServers）、不再 live 合并 `~/.cursor/mcp.json`——在 Cursor 改配置不再影响本 app；`readMergedMcpServers` → `readEffectiveMcpServers`（自管 + 剔 RESERVED 名）、resolveTaskMcpServers / health / oauth 四处消费方统一切换
- **老用户无感迁移**（`migrateCursorMcpOnce`、单飞 + 幂等）：调用点 = /api/settings **GET**（client 首拉配置前必过、cache 一定含快照 → 整对象 PUT 不盖丢）+ **PUT**（localStorage 过渡期老用户 config.json 首次落盘后补迁、响应返最终盘上 settings、client putSettings 回填 mcpServers 进 cache）+ readEffectiveMcpServers（boot 直接 resume agent 路径）。config.json 已存在 → Cursor 快照合入自管（自管同名优先、原子写）+ 落标记；不存在 → 什么都不做不落标记（等首次 PUT 出生后再迁）。标记 `data/.mcp-cursor-migrated` 防重、失败清单飞下次重试。审计（grok subagent 蓝军）揪出的 2 个 P0（迁移 vs 整对象 PUT 竞态、localStorage-only 老用户被误判新装）均按此修复
- **设置页 MCP 卡重做**（`mcp-card.tsx` 条目化）：每 server 一行（类型摘要 + 编辑 / 删除）、新增 / 编辑 dialog（名称 + 单 server JSON）、「从 Cursor 导入」dialog 勾选挑 server（已存在标「导入将覆盖」）、高级折叠保留整体 JSON 编辑；OAuth / 常用开关 / 健康探测数据源全切自管
- `/api/cursor-mcp` 语义改：`servers` = 有效集（自管）、`cursor` 仅供导入 dialog；`settingSources:["project"]` / 全局 rules 注入**本期不动**（prompt 上下文体系、接第二 backend 时再抽统一层）
- **V0.13-P1 Skill 独立化 + MCP 卡整合**（同日追加、用户拍板）：
  - app 自管 skills 目录 `<dataRoot>/skills/<name>/SKILL.md`（`app-skills.ts`）、loadSkills 纳入扫描（优先级：平台内置 > 自管 > Cursor 全局 > 飞书 CLI）
  - 设置页新增 Skills 卡（`skills-card.tsx`）：列全部来源（带标签）、自管可新增 / 编辑 / 删除（编辑 SKILL.md、CodeEditor 加 markdown 高亮）、「从 Cursor 导入」勾选 dialog（**整目录拷贝**、含脚本附属文件）；API：GET/POST/DELETE `/api/skills` + `/api/skills/content` + `/api/skills/import`
  - MCP 卡「常用 MCP」独立区块砍掉（用户：太长）——常用开关 + 健康徽标 + OAuth 授权全并进条目行内、`HealthBadge` 从 mcp-toggle-list export 复用
- **飞书工具去 MCP 强绑定 + CLI 内置进安装包**（同日、用户拍板）：
  - prompt 中性化：action-plan / build / ship + context-docs-handler skill 里点名 `feishu-mcp` / `feishu-project-mcp` 的地方全改「有 MCP 用 MCP、没有用内置 lark-cli / meegle CLI（用法见注入的官方 skills）」
  - 建任务校验降级：原「缺飞书 MCP 不让建」→ 按能力域（飞书文档 ↔ lark-cli、飞书项目 ↔ meegle）判定「MCP 或 CLI 任一就绪即过」、都缺才 amber 提示且**不阻断**（跳设置页飞书卡）
  - CLI 内置（+~14MB、用户拍板）：CI 打包前 `scripts/fetch-feishu-cli.mjs --platform <target>` 预取平台二进制 + 官方 skills 到 `dist/feishu-tools`、afterPack 拷进 `resources/feishu-tools`、boot 时 `seedFeishuToolsFromResources`（壳传 `FE_AI_FLOW_RESOURCES_DIR`）缺才拷进 data/tools/——开箱即用、在线「更新」仍走增量下载、种子不覆盖用户更新过的新版本
  - 飞书 CLI 安装器增量化（同日修 bug）：已装且版本一致跳过、按钮「缺任一叫安装、都在叫更新」
- **Skills 列表按来源分组折叠**（用户拍板「几十上百个太长」）：自管组常驻展开、内置 / Cursor 全局 / 飞书 CLI 各一折叠组（标题带数量、默认收起）
- **ask_user 弹窗 → 事件流内联答题卡**（同日、用户拍板「弹窗挡整屏不合理」）：模态 AskUserDialog 删除（旧 wait_for_user 阻塞协议遗产）、答题逻辑整体搬进 `ask-user-inline.tsx`（AskUserInlineCard）；event-stream 分流：`findPendingAskEvent` 命中的 ask 行渲染内联卡（选项 / 自定义 / 每题贴图 / 稍后再补充 / 快捷键全保留）、已答 / 作废走 AskUserRequestRow 回放；失效态（runStatus=error）内联警示不再需要 dismiss；chat-view 的兜底弹窗一并删（EventStream 内已覆盖）。对齐 Cursor / Claude Code 的内联提问形态、答题时能看事件流上下文

### V0.12.2（已发版）：删 settings.username + 默认模板留空（2026-07-09、用户点名「缩写没意义、可以写死在模板里」）

- **结论**：username 唯一消费方是分支模板 `{username}` 占位符（不进 prompt / MR / git 身份）、单机 app 写死在模板等价——字段删除
- **无感迁移**（normalizeSettings、幂等）：老配置有 username 时把全局 + 各仓模板里的 `{username}` 一次性替换成真实名字（没显式配过模板的老用户按旧默认烘焙成 `feature/<名字>/{storyId}-{taskTitle}`）、老用户分支名零变化；migration 后字段不再落盘
- **默认模板留空**：设置页模板输入框默认空（placeholder 提示）、运行时留空回退内置兜底 `feature/{storyId}-{taskTitle}`（DEFAULT_BRANCH_TEMPLATE 改值）；渲染引擎保留 `{username}` token 兼容老任务快照（渲染为空段、`/` 清理兜住）
- 链路清理：ensureTaskWorktrees / planWorktreeBranchInfos / planBranchesForBuild 去 username 参数、advance / question route 及 client 透传全删、设置页「用户名/缩写」输入框删

### V0.11.11（未发版、攒着）：worktree 全流程审计 + 7 项修复（2026-07-09、用户点名「好好检查 worktree」、4 审计 + 3 修复 subagent 并行）

- **审计结论**：主链路扎实（幂等 / 路径归一 / 指纹 key / 孤儿 live 集合 / 跨实例 dataRoot 隔离 / chat 旁路都验过没问题）；证伪了一个 subagent 误报（「跨实例 worktree 注册名必撞」——真 git 实验：git 会自动给重名注册加后缀 crm-web/crm-web1、不存在该问题）
- **修复 7 项**：
  1. ensure 复用热路径校验当前分支——被手动 checkout 切走 / detached HEAD 自动切回、切不回抛清晰错（原「build 自检兜底」实际不存在、静默错分支干活）
  2. WIP 快照改三态（clean/snapshotted/failed）：merge/rebase 冲突中（porcelain 未合并码）直接 failed 且**跳过删除**（原来快照失败仍 --force 删、未提交改动被销毁）；`RemoveWorktreesResult.skippedRepos` + finalize 事件⚠️提示；孤儿清理同口径整目录保留
  3. 分支占用报错识别新版 git 文案 `already used by worktree`（2.4x+ 改了措辞、原正则只认 already checked out、中文提示不出——昨天线上实测）+ 提示补「检查另一实例（正式/test）是否占用」
  4. finalizeTask 补 `waitForTaskToStop`（对齐 DELETE、防 agent 边写边删）
  5. deleteTask / finalizeTask 清 worktree 前停本任务预览（防 dev server 悬空占端口）
  6. `ensureWorkspaceReady`：internalStartAgent / resumeTaskSession / startOneShotQuestion 入口幂等 ensure（reopen 后问一问 / 手删 worktree 后 resume 不再指向不存在目录）
  7. ArtifactPanel baseDir 回退链补 `task.workCwd`（隔离任务老 action 缺 cwd 快照时、链接不再拼到原仓）；ActionRecord.cwd 注释同步
- 集成测试 +2（分支切走自动纠正 / merge 冲突态删除跳过）、全量 150 绿

### V0.11.10（未发版、攒着）：IDE 探测扩到 10 个 + 设置页只列已装（2026-07-09、用户点名）

- `JumpIde` 扩：VS Code 系（Cursor / VS Code / **Windsurf / Trae**）+ JetBrains 全家（IDEA / WebStorm / **PyCharm / GoLand / PhpStorm / Android Studio**、Android Studio win 装 `Program Files\Android` 下 exe=studio64 单独配）；探测改 `IDE_SPECS` 配置表驱动（ide-tools.ts）、加新 IDE = 加一行配置；候选清单单一来源 `JUMP_IDES`（types.ts）、组件 / route / normalize 全引它
- 设置页下拉**只列本机探测到的**（用户拍板「没有的就不展示」；当前已选的即使没探到也列、防下拉找不到当前值）、「（未检测到）」后缀已删

### V0.12 P0（进行中）：内置飞书官方 CLI（2026-07-08 晚、用户拍板「内置两套 CLI、不强迫用户配 MCP、尽可能都接进来」）

- **两个官方 CLI**：lark-cli（larksuite/cli、飞书开放平台 200+ 命令 + 26 官方 Agent Skills）+ meegle（larksuite/meegle-cli、飞书项目 16 域 50+ 命令）、都 MIT
- **分发（不进安装包、运行时一键装到 `<dataRoot>/tools/`）**：lark-cli 走 GitHub Releases 平台二进制（China fallback npmmirror `/-/binary/` 镜像、URL 规则照官方 install.js）；meegle npm 包自带全平台 Go 二进制、解 tgz 抽当前平台的；官方 skills 从两仓库 main tarball 的 `skills/` 抽（失败不阻断）
- **agent 接入**：`injectFeishuCliPath` 把 tools/bin 注 process.env.PATH（instrumentation 启动 + 装完即时）、SDK agent 子进程继承直呼；skills-loader 增扫 tools/skills（优先级最低）
- **登录**：CLI 自带 OAuth（自动开浏览器）——lark-cli 无配置走 `config init --new`（官方引导建应用）、有配置 `auth login --recommend`；meegle 先 `config set host`（默认 project.feishu.cn）再 `auth login`。spawn 托管 + 抓输出授权 URL 给 UI 兜底
- **UI**：设置页「飞书集成」卡片（安装/更新 + 每工具登录按钮 + 版本/账号状态、流程中 2s 轮询）
- **后续（明天）**：P1 新建任务「从飞书需求选」+ 首页我的需求面板；P2 状态反向同步；飞书项目 MCP 链退役（用户拍板不留兼容）

### V0.11.9（未发版、攒着）：说话入口合一 + 重启概念退役（2026-07-08、用户拍板「有些设计是之前冗余的」）

- **「重启当前阶段」按钮/弹窗/route 删除、能力并入输入条「唤醒模式」**（用户拍板「输入条覆盖重启、别多一条 action 链」）：会话接不回 + 当前 action 停在半路（error/cancelled/僵死 running）时、输入条消息触发 `resumeCurrentActionWithMessage`——起新 agent **原地续同一个 action**（`[RESUME_ACTION]` 指令 = 旧 restart 骨架 + 用户消息当最新指示、不再 ask「按原计划继续吗」；pendingQuestions 断点续传保留）。模型沿用 action.agentModel（唤醒不悄悄换模型）
- Cmd/Ctrl+J 快捷键改为聚焦底部输入条（原开再聊聊弹窗）
- **唤醒模式周边收口**（用户点名全面检查）：ask 弹窗失效态 / 停止确认 / 「没交卷」error 三处引导文案改成「底部输入条说句话即可唤醒」；question 路由的 pendingAsk 拦截对「action 已停在半路」豁免（stale 弹窗没人接、不该把用户堵在弹窗上——唤醒后断点续传会重新问到）
- **E 批小清理**：repoStatus 死枚举 awaiting_test / has_bug 删除（全仓从未写入过）；V0.11.6 后冗余的 watchEpoch 重连兜底清掉（只留 reopen 终态重订阅）；wait-protocol-prompt.ts 改名 turn-discipline.ts
- **交卷工具改名 `wait_for_user` → `submit_work`**（用户拍板）：prompts / 工具注册 / src 文案全量改；**旧名保留一版 alias**（同 handler、升级前启动的会话 in-context 还教旧名、断代会交不了卷、下版本删）；sdk-message-handler 的交卷特判两个名字都认
- **事件流滚不到底修复**：EventStream 根节点是 `h-full`、底部加输入条后总高超 100%——外层包 `min-h-0 flex-1` 容器给它确定高度
- **问一问 run 全出口保护（第二轮全面检查扫出的隐患）**：consumeSessionRun 加 `questionRun` 标——纯答疑 run 被停 / 失败时**绝不动 action**（原 cancel 分支会 finalizeStaleActions 把 awaiting_ack 审阅位打成 cancelled、error 分支同理打成 error——答疑期间点停止 / 网络抖动就会误伤任务本体）、不关会话、runStatus 按当前 action 状态归位（restoreRunStatusAfterQuestion、含 error 位）
- **待讨论候选（用户拍板「记下后面翻出来」）**：chat / task 双 runner 合一（最大代码冗余、双份逻辑漂移是 bug 温床）
- **说话入口合一（TaskTalkComposer）**：原「再聊聊」弹窗（+Cmd/Ctrl+J）与「问一问」输入条 90% 重复、二合一成事件流底部常驻输入条——**系统按状态自动懂语境**：当前产出等审阅 → 按 revise 送（agent 二分类：问就答、改就改完重新交卷）；其他时刻 → [USER_QUESTION] 纯提问；显式选模型 → 一次性答疑 agent。支持贴图（粘贴 / 附图）。revise-dialog.tsx 删除
- **prompt 措辞修正**（用户实测 agent 旁白「等你点通过」误导）：_super / action-* 全部清掉「用户点通过」概念、改「认可 = 直接推进（无通过按钮）、旁白禁说点通过」

### V0.11.9（未发版、攒着）：任务内「问一问」+ 设置页整理（2026-07-08、用户大方向讨论第一批）

- **任务内「问一问」**（用户痛点：想就任务问点问题、以前必须推进 action 再嘱咐「只回答别改代码」）：
  - 任务页事件流底部轻量输入条（`task-question-composer.tsx`、单行 textarea、agent 跑动中禁用、终态隐藏）
  - `POST /api/tasks/[id]/question` → `deliverTaskQuestion` → send `[USER_QUESTION]` 给存活会话（约束内联：只答不动手、不调动作工具、答完自然结束；_super.md 同步教、protocol-signals 加常量 + 一致性测试）
  - 不新建 action、不动任务进度：回答期间 runStatus=running、答完 consumeSessionRun 按最后 action 状态归位（awaiting_ack → awaiting_user、completed → idle——后者是本次补的 tail 分支、也顺手修了「等审阅期间任何 send 后 runStatus 卡 running」的隐患）
  - 拒绝口径：agent 在跑 / ask 弹窗未答 / 无会话且 resume 不了（409 提示推进或重启阶段）
- **问一问兜底：一次性答疑 agent**（用户拍板「接不回来另起一个没问题」）：会话接不回时 `startOneShotQuestion` 起轻量 Q&A agent——带任务事件日志 / artifact 目录路径、只读答疑铁律、**不注册会话不落锚点**（防被「续用推进」误当正式会话）、答完 close、runStatus 答完兜回提问前状态。语义澄清（用户问「这算重启吗」）：不算——重启当前阶段 = 换 agent 重做产出、问一问 = 只聊不动产出、两者并存
- **诊断包一键导出**（用户点名「让同事找日志太麻烦」）：设置页顶部「导出诊断包」→ `POST /api/system/diagnostics-export` → 单个 txt 落 ~/Downloads（版本 / IDE 探测含 exec 路径 / **脱敏**配置概要 / main.log 尾部 300KB）、toast 路径 + 自动复制。`server/diagnostics.ts`
- **IDE 打开「没反应」诊断增强**（同事 Windows 复现待定位）：探测结果落日志（每次探测打 exec 路径）+ spawn 静默失败探测（1.5s 内 error / 非零码退出 → 报错 toast、不再假成功）
- **设置页整理**（sub-agent 执行、已逐 diff 审过）：删安全警示式啰嗦文案、`?focus=<卡片>` 锚点定位 + 2s 高亮、「去设置页」提示改可点快捷跳转（toast action / 空态内联链接、`settings-link.tsx` 统一拼 URL）
- **GitLab host 可不填**（sub-agent 执行）：`resolveEffectiveGitHost` settings 显式值 > 仓库 origin remote 推导（`git-remote.ts` 纯函数 + `GET /api/repo-remote-meta`）；设置页「从仓库检测」按钮、advance-dialog ship 准入同口径
- **MCP 自管 + Cursor 导入**（sub-agent 执行；V0.13 起运行时不再合并 Cursor、见 V0.13-P0 段）：`settings.mcpServers`（config.json）可视化增删 + 「从 Cursor 导入」、aiFlowChat 保留名不可占用、task/chat/OAuth/健康探测全部读自管有效集

### V0.11.8：IDE 跳转去协议依赖 + 自动探测（2026-07-08、同事 Windows 实测「idea:// 打不开」）

- **根因**：`idea://` 协议只有 JetBrains Toolbox 会注册——直接装 IDEA 的 Windows 机器点跳转弹「找不到应用」（两位同事实测）
- **方案（本地 app 不需要经过浏览器协议）**：
  - `src/lib/server/ide-tools.ts`：探测本机装了哪些 IDE（常规安装位 + JetBrains Toolbox 目录 + PATH、60s 缓存）+ `openInIde` 后端直接 spawn 可执行文件（带 `--line`；Toolbox .cmd 脚本经 cmd /c；mac 用 `open -na`）
  - 跳转双通道（`JUMP_IDE_USES_PROTOCOL`）：cursor / vscode 协议注册可靠、仍走 deep link；JetBrains 系（idea / webstorm）走 `POST /api/system/open-in-ide` 后端拉起、协议没注册也能开
  - 渲染统一走 `getIdeAnchorProps`（`src/lib/ide-open.ts`）：协议工具返 href、后端工具返 onClick——artifact 路径链接 / 事件流附件 / 工作区「在 IDE 打开」五处收口
  - `JumpIde` 扩成 cursor / vscode / idea / webstorm；设置页下拉按 `GET /api/system/ide-tools` 探测结果动态列、未装的置灰「（未检测到）」、不再写死两个
- 同批攒着的：黄点收窄 + approve 归 idle、常用模型快捷位、提测黄条删除（见下）

### V0.11.8（未发版、攒着）：黄点收窄 + approve 归 idle（2026-07-08、用户点名「黄点什么时候消失」）

- **背景**：V0.11 后 awaiting_user 成了常态静息位（chat 每轮说完 / task 交卷等 ack / approve 后都停在这）——侧栏琥珀脉冲点按旧条件（runStatus=awaiting_user 就亮）几乎满屏常亮、失去注意力信号价值
- **改法**：
  - server：approve 后 runStatus 归 idle（action 已 completed、无 ask、没有任何「在等你」的东西；原来永远停在 awaiting_user、顶部「等待回复」badge 也误导）
  - 侧栏琥珀点只在「需要你行动」时亮（task 模式限定）：lastAction awaiting_ack（等你审阅）或 running + awaiting_user（ask 弹窗等答案）；chat 静息不亮

### V0.11.8（未发版、攒着）：常用模型快捷位——按使用次数自动排（2026-07-08、用户点名「切模型太麻烦」）

- **交互**：模型选择器（ModelSelect `quickPicks` 开关）上方常驻 2 个 chip = 使用次数 top2 的「模型 + 参数组合」（Fable High 和 Fable Low 算两个条目）、点一下连参数一步选中、不用开下拉搜。用户拍板「自动记录选择次数做排序」、零配置无需手动星标
- **计数**：`settings.modelUsage`（config.json、上限 20 条防膨胀、淘汰次数最少）+ `recordModelUsage`/`getTopUsedModels`（local-store）。只在**真实使用**时 +1：推进起新 agent / 重启阶段 / 新建任务 / chat 换模型；在下拉里点着玩不计
- **生效面**：推进弹窗 / 重启阶段弹窗 / 新建任务弹窗（full 变体）；chat 底部 compact 选择器不加 chip（空间紧）但换模型计数照记

### V0.11.7：修「秒答 ask 弹窗撞在飞 run」——第一次提交报「没有活跃会话」、重试才过（2026-07-08、用户线上实测）

- **现象**：agent 调 ask_user 后弹窗立即弹给用户、但本回合 run 还要再跑几秒才 finished（收尾旁白 + stop-check 往返）——用户手快秒答、`sendToTaskSession` 撞上 `runningTasks.has` 直接拒 → 409「没有可续接的 agent 会话」、几秒后重试就成功（线上日志实锤：ask 14:16:41 → 首答 14:16:52.420 被拒 → run 14:16:52.9 才排空 → 重试 14:16:59 成功）
- **修复**：`sendToTaskSession` 入口不再见 run 就拒、改 `waitForRunToDrain`（300ms 轮询等排空、90s 上限兜底）——协议间隙由 server 消化、不再把用户答案弹回去。推进 / 再聊聊路径本来就在 run 结束后才可操作、等待为 no-op 零影响
- **顺带删「build 后没 review」黄条整链**（用户拍板「文案去掉」）：判定只认 status=completed、刚交卷 awaiting_ack 的 review 也被误报「没复核」（实测 review #20 刚跑完没 ack、提测弹窗仍黄条）——`GET /ship-precheck` route / `getShipPrecheck` / `ShipPrecheck` 类型 / dialog 黄条全删

### V0.11.6：修 V0.11 回归「done 即断流」——ask 弹窗答完永远卡「提交中」（2026-07-08、用户线上实测踩到）

- **现象**：task 模式 ask 弹窗答完后按钮永远「提交中…」、弹窗关不掉（by design 不可 dismiss）、页面再也不更新；后端其实全链路正常（答案已送达、agent 已继续跑完交卷）
- **根因（V0.11 语义冲突）**：watch-task SSE 沿用旧「publish done → 关流」+ 客户端 hook「收到 done → 不再重连（靠 reconnectKey）」。旧模型 run=整个 action、done 很少见；V0.11 起 run=一个回合、**agent 每说完一轮都 publish done** → 页面在任意回合后断流、后续 `agent.send` 起的新 run 事件全收不到。advance / restart / chat 自动启动路径恰好有 `watchEpoch++` 兜底才没暴露、ask-reply / revise 等路径没有 → 弹窗卡死（Electron 还禁了 cmd+R、用户没有自救手段）
- **修复（回合结束 ≠ 订阅结束）**：
  - 服务端 watch-task：done 帧照发、**只有 task 业务终态（merged/abandoned）才关流**、其余保持挂着跨 run 存活
  - 客户端 use-task-watch：只有「终态 done」才停止订阅、回合级 done 不停、被动断流照常退避重连
  - reopen（终态恢复）补 `watchEpoch++`（终态时订阅已按终态停、恢复后强制重订阅）；chat-view / page 的旧 epoch 兜底保留不动
- 顺带：上下文文档弹窗支持点条目看详情（全文 / URL 打开+复制 / 图片大图、返回键回列表）——用户点名「加了就没法看详情」

### V0.11.5：揪出安装包隐性膨胀根因——CI npm install 重装全依赖（2026-07-08）

- **异常信号**：V0.11.4 压缩优化后线上包 192/189.5MB、远超本地实测 118/112MB → 挂载线上 dmg 对账：**app-server 532MB**（本地组包只有 79MB）
- **根因（自 v0.7.6 起每一版都中招）**：CI「修平台依赖」步在 dist/app-server 里跑 `npm install @cursor/sdk-<platform>`——standalone 的 package.json 是全项目的、npm 装单包时顺手把「缺失」的全部 dependencies 重装成**完整包**（full next 152M + @next/swc 平台二进制 124M + lucide-react 36M + typescript 23M…）、~450MB 死重进包。用户「Windows 装得特别久」主根因就是解包落盘 ~770MB
- **修复**：`npm install` → `npm pack` + tar 解到 `node_modules/@cursor/<平台包>`、零依赖解析只落平台包本体；实加载验真步保留
- 效果：解包 771MB → ~310MB、安装包 190+ → ~110-120MB（真·减半、叠加 V0.11.4 压缩优化）

### V0.11.4：安装包减半（2026-07-08、用户点名「包太大、装太久」）

- **win exe 213.6MB → 实测 112MB（-48%）**：`compression: maximum`（electron-builder.yml 全局）。回收 v0.8.10「7z 降到 level 3 提安装速度」特例——release 体积历史证明那次前后都 213MB、没变小也没装快（LZMA 解压速度和压缩级别基本无关、安装慢卡在落盘 300MB + Defender 扫描）
- **mac dmg 215MB → 实测 118MB（-45%）**：格式 ULFO（LZFSE）→ UDBZ（bzip2）。实测挂载 25s + 全量拷出 12s、安装/自更新多花半分钟换下载少 ~100MB。⚠️ ULMO（LZMA）实测更小（97MB）但 electron-builder 26.15.2 schema 只认 UDBZ/UDCO/UDRO/UDRW/UDZO/ULFO、CI 直接拒（踩过、v0.11.4 首次打包双平台全挂重打 tag）
- assemble 布局顺带删 sourcemap（*.map、生产死重）
- 代价：CI 打包每平台 +3-5min；天花板说明：压缩后 ~100MB 基本到底（Electron/Chromium 底座占大头、再小要换底座、不动）

### V0.11.3：依赖目录克隆多语言泛化（2026-07-08、用户点名「通用项目、别只考虑前端」）

- worktree 依赖秒级克隆从写死 `node_modules` 泛化为**安全克隆白名单**（`CLONABLE_DEP_DIRS`）：`node_modules`（JS）/ `vendor`（PHP composer / Ruby bundler / Go vendor 模式）/ `Pods`（iOS）——都是可重定位目录、探测到就克
- **明确排除 `.venv`/`venv`**（Python 虚拟环境 shebang/activate 写死绝对路径、克隆过去是坏的、比不克更坑）——Python 走 agent 自建；Java/Go/.NET 依赖存全局缓存、天然不需要克隆
- `EnsureWorktreesResult.clonedNodeModulesRepos` → `clonedDeps: { repoPath, dirs }[]`、事件流 / prompt 仓库段措辞同步改「依赖目录」；集成测试补 vendor 正例 + `.venv` 反例
- 不加设置项（白名单够用、疼了再开 per-repo 配置）

### V0.11.2：Windows / macOS 兼容性全面扫描修复（2026-07-08、用户点名全查）

- **P1 工作区指纹 / status hash 在 Windows 静默失效**：原实现 `spawn("sh", ["-c", 多行 POSIX 脚本])`——Windows 没有 `sh`、`2>/dev/null` 也非 cmd 语法 → fingerprint 恒 null、review 只读硬校验 / build 兄弟仓越权检测形同虚设。重写成纯 Node 逐条 `execFile git`（唯一要喂 stdin 的 `hash-object --stdin-paths` 单独 spawn）、平台无关；顺带删掉 `buildCheckEnv`（PATH 用 `:` 拼 + 读 `HOME`、Windows 分隔符是 `;`、会把 PATH 首项写坏）——现在只跑 git、不需要自拼 PATH。新增 `tests/action-checks.integration.test.ts`（真 git 仓锁指纹语义 5 条）
- **P2 kill-orphans 在 Windows 白跑报错**：依赖 `ps` + `lsof`、win32 入口直接跳过（孤儿树杀由壳退出时 taskkill /T 兜底、不值得接 wmic/CIM）
- **P2 预览 dev server 在 Windows 弹控制台黑框**：`detached: true` 在 win 会给子进程开独立控制台——改 win 不 detach + `windowsHide`（树杀本就走 `taskkill /T`、不依赖进程组）；其它 git spawn 也补了 `windowsHide` 防闪框
- 确认无问题的面：task-worktrees（gitdir 正反斜杠都认）、path-utils（盘符/反斜杠归一化齐全）、hooks 脚本（纯 Node + win 分支）、Electron 壳（netstat/taskkill 分支齐全）、node_modules 克隆（darwin 门控、其它平台回退 agent 自装）
- typecheck / lint 全绿、vitest 148 全绿

### V0.11：wait 协议退役——回归「create + 多轮 send」正常流程（2026-07-07 用户拍板、当日实装）

- **动机**：Cursor 已去掉按次计费、「单 Run 永生 + wait_for_user 挂 shell curl 长轮询省 send」的历史前提消失；worktree 隔离（V0.10）后现场永久保留、Run 随时可断可续；且长挂 curl 是全系统最脆的机制（升级假卡死 / 僵尸 zsh / premature wait / 失效 ask 弹窗死循环等事故大户）。用户原话「首次是 create、后面就都是 send、改回正常流程」。
- **新模型**：
  - **agent 会话跨 run 存活**：`agentSessions`（task-stream globalThis）持有 Agent 实例；`runningTasks` 只表示「有 run 在跑」。run 自然结束不 close agent、下一次用户操作 `agent.send()` 续上（SDK 官方多轮语义）；stop / error / finalize / 换模型才关会话。app 重启丢会话 → 沿用旧 fresh-agent + events.jsonl 恢复路径。
  - **wait_for_user 改「交卷」语义（非阻塞）**：完成 action 调它（带 action_id）→ 后台跑 check + 切 awaiting_ack（同今天）→ 返回「交卷成功、立即结束本轮回复」→ run 自然 finished = 正常（旧模型里是 error）。不带 action_id 的「待命态」概念删除。
  - **ask_user 改「弹窗 + 结束回复」**：注册 pendingAsk（askId/token 校验保留）→ UI 弹窗 → 返回「结束本轮回复」；用户答案经 `agent.send([ASK_USER_REPLY]…)` 送达新 run。
  - **用户操作 → send**：推进（续用会话）= send [NEXT_ACTION…]；再聊聊 = send [ACTION_ACK revise]+feedback；ask 答案 = send [ASK_USER_REPLY]；chat 每条消息 = send。通过（approve）纯服务端落状态、不再需要通知 agent。终态（merged/abandoned）不再发 [TASK_DONE]、直接 cancel 活 run + 关会话。
  - **chat 模式回归普通对话**：agent 无需任何 wait 工具、说完自然结束 turn；run 结束 → runStatus=awaiting_user 等下一条消息。premature-wait 兜底 / 概括 message / recency 提醒全部删除。
  - **stop-hook 语义保留但收窄**：只拦「当前 action 还在 running（没交卷）且无 pendingAsk」的提前退出；交卷后 / ask 后 / chat 模式放行。
- **删除面**：wait-ack 长轮询 route、pendingMap/token/grace/keepalive 状态机（chat-pending 1049→370 行、pendingAsks 轻量表保留）、premature-chat-wait 模块 + 测试、SHELL_WAIT_GUIDE/KEEPALIVE/STALE/INVALID_TOKEN/TASK_DONE 信号、prompts 里全部 curl 协议段（_super.md 重写、action-*.md 交卷语义）。
- **实装要点**：`agentSessions`（task-stream V4）+ `consumeSessionRun`（首 run / send 共用消费管道）+ `sendToTaskSession`；chat 侧 `RunningChatRecord` 变会话记录（agent + runActive）+ `sendChatMessage` + `consumeChatRun`；「run 自然 finished 且 lastAction 还 running」时豁免两种正常情况（后置 check 在跑 = 刚交卷、pendingAsk 在等答案）才判「没交卷就跑了」；stop-hook 同口径豁免。approve 纯服务端落状态。协议信号瘦身到 3 个（ACTION_ACK_REVISE / USER_REPLY / NEXT_ACTION 前缀 + 附件段头）、一致性测试改守「旧协议字样不得残留」。
- **V0.11.1 会话持久化 + 空闲回收（同日、用户拍板 abc 全做）**：
  - **Agent.resume 跨重启续会话**：`Task.sessionAgentId` 落盘（create/resume 时写、停止/终结/报错/换新 agent 清、空闲回收保留）；task 侧 `resumeTaskSession`（重建 mergedMcp + `registerSessionBridges` 重注册 handler/notifier——从 internalStartAgent 抽出的共用工厂）、chat 侧 `resumeChatSession` + `registerChatNotifier`。ack / ask-reply 路由随 client `bootArgs`（apiKey/model/gitHost/gitToken、task-store 内部自动附）拿恢复凭据；advance 续用 / chat-reply 天然有。服务重启后「再聊聊 / 答弹窗 / 续用推进 / chat 消息」全部无缝接回原会话
  - **⚠️ resume 两个必传（实测踩过、AgentNotFoundError / ConfigurationError）**：① `local.cwd` 必须和 create 时一致（本地 agent 按 cwd 定位持久化存储）；② `model` 必须显式传（恢复的 agent 不保留 model、send 会炸）——task 侧优先用最近 action 的 agentModel、chat 侧用 bootArgs.model。已用「记暗号 → 重启 app → 问暗号」实测全链路：resume 成功（autoStarted=false）+ 上下文保留
  - **会话空闲回收**：task / chat 各一个 sweeper（10min 扫、闲置 2h close、keepPersisted——下次操作 resume 接回、体感无差）、降常驻 agent 子进程数
  - **boot recovery 不再误伤**：只有 `running`（run 真在跑时进程死了）才标 error；`awaiting_user` 是新模型正常静息态、保留原状（resume 可续）
  - **preview Windows 杀进程树**：`kill(-pid)` 负号语义 win 不支持、改 `taskkill /T /F`
  - 顺手清了旧协议死代码 / 误导注释（route-helpers KEEPALIVE 常量、readRecentEvents、十余处注释、README 关键属性段）
- typecheck / lint / vitest 143 全绿；chat 多轮 send 续接实测通过、task 模式冒烟因 TCC 权限（锁屏 + 重签名）只验到 agent 启动 + 工具调用正常、见 learned-conventions 新增踩坑条目。

### V0.10.1：自更新「稍后重启」防挂死闸 + updates/ 启动清扫（2026-07-07、线上事故沉淀）

- **事故**：正式 app（v0.9.10 进程）7-6 早自更新到 v0.9.14 后用户点「稍后」没重启——mac 自更新是**原地替换 /Applications 里的 .app**、老进程继续跑在被替换的 bundle 上、此后 SDK 沙箱 zsh state-dump helper 因 bundle 失配**永久挂死**（跟 learned-conventions 里「test 包重打不退老实例」同机制）：每起一个 agent run、第一批 shell 调用就永远不返回、任务假死「运行中」（next-server 下挂一排僵尸 `dump_zsh_state`）。7-7 早用户跑「上线审查」action 连卡两次、排查确诊。
- **修复（marker 硬闸）**：壳 `macSelfUpdate` 替换成功后写 `<data>/update-pending-restart.json`（含新版本号）、壳下次启动删；server 在**所有起新 agent run 的入口**查 marker、存在直接拒绝并提示重启——`advanceTaskInner` / `restartCurrentActionInner` 开头 throw（API 400 透传 toast）、chat-reply 懒重启分支（拦在杀健康旧 Run 之前）+ 终态自动启动分支返 409。已在跑的 run（更新前起的、仍健康）不受影响。新模块 `src/lib/server/update-pending.ts` + `tests/update-pending.test.ts`。
- **顺带**：壳启动 `cleanupUpdateLeftovers`——清 updates/ 残留（`old-*.app` 暂存旧包 / `mnt-*` 挂载点先 detach 再删 / 残留 dmg；替换现场 rm 偶发失败早前被静默吞、实测积了 4 份 200MB+ 旧包）、并删待重启 marker；替换现场 rm 失败改记日志不再静默。
- typecheck / lint / vitest 155 全绿（改动含 electron-app/main.js、`node --check` 过）。

---

## 关键文件索引

| 内容 | 位置 |
|---|---|
| **V0.6 重构设计文档（已 archived、V0.6.0 落地完成）** | `docs/V0.6-REFACTOR.md` |
| **V0.6 统一 runner（task 容器 + action history、v0.9.7 起只留编排：advance / restart / ack / finalize / internalStartAgent）** | `src/lib/server/task-runner.ts` |
| **流事件底座（v0.9.7 拆出：TaskStreamEvent 协议 + publish/subscribe + writeEventAndPublish + runningTasks 等 globalThis 状态）** | `src/lib/server/task-stream.ts` |
| **Prompt 拼装（v0.9.7 拆出：buildSuperPrompt + NEXT_ACTION/RESTART directive + 字段热更 diff、纯函数）** | `src/lib/server/task-prompts.ts` |
| **Action 门禁（v0.9.7 拆出：checkActionPrerequisites + ship 预检 reviewMissing + build 分支规划、纯函数）** | `src/lib/server/action-gates.ts` |
| **SDK 消息翻译器（v0.9.7 拆出：handleSdkMessage + AssistantBufferCtx）** | `src/lib/server/sdk-message-handler.ts` |
| **V0.6 action 后置 deterministic check（v0.9.13 起只查交付诚实性：artifact 必备段 / review 指纹 computeWorktreeFingerprint / MR 验真、不跑项目命令）** | `src/lib/server/action-checks.ts` |
| **协议信号单一常量源（V0.6.27、信号 ↔ prompt 一致性由测试守护）** | `src/lib/protocol-signals.ts` + `tests/protocol-signals.test.ts` |
| **shell 命令硬拦截（V0.6.27、beforeShellExecution hook 策略引擎）** | `src/lib/server/shell-guard-rules.ts` + `scripts/shell-guard.mjs` + `src/app/api/hooks/shell-check/route.ts` |
| **submit_mr 范围校验（V0.6.27 从 task-runner 拆出、防 agent 越权提 MR）** | `src/lib/server/submit-mr-guard.ts` |
| **vitest 测试（V0.6.27、安全关键纯函数 + prompt 一致性）** | `vitest.config.ts` + `tests/*.test.ts` |
| **V0.6 task schema + 文件系统（v0.9.9 拆三层：CRUD/patch 在 task-fs、路径/schema/锁/事件 IO/hydrate 在 task-fs-core、附件/artifact/revisions 在 task-artifacts）** | `src/lib/types.ts` + `src/lib/server/{task-fs,task-fs-core,task-artifacts}.ts` |
| **批次推导 + 展示（V0.6.23 起、computeBatchProgress 前后端共用 / 进度 chip / 批次表 / 选批 / 测试策略 label）** | `src/lib/task-display.ts` + `src/lib/types.ts: PlanBatch / TestStrategy / TEST_STRATEGY_LABEL` + `src/components/tasks/{batch-progress,batch-plan-table}.tsx` + `advance-dialog.tsx` 选批 |
| **GitLab REST client（V0.6.1 新、V0.6.8 加 closeOpenMR 关被取代的旧 MR）** | `src/lib/server/gitlab-client.ts` |
| **agent 孤儿子进程清理（V0.6.8、停 task / finally 调）** | `src/lib/server/kill-orphans.ts` |
| **任务 worktree 隔离（V0.10：ensure/remove/孤儿扫描/getTaskCwd/路径归一）** | `src/lib/server/task-worktrees.ts` + `tests/task-worktrees{,.integration}.test.ts` |
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
| **chat 模式独立 runner（V0.6.0.1 新、v0.7.23 进入即占位注册修「停止后还回复」冷启动竞态）** | `src/lib/server/chat-runner.ts` |
| **chat 模式 UI（V0.6.0.1 新）** | `src/components/tasks/chat-view.tsx` |
| **chat 模式 API** | `src/app/api/tasks/[id]/chat-reply/route.ts` |
| **等待协议 prompt 单一源（v0.7.21、chat+task 共用「写完→wait_for_user→shell curl 挂等」机制纪律 + 三认知陷阱；v0.7.23 强化「先回复正文再 wait」）** | `src/lib/server/wait-protocol-prompt.ts` |
| MCP server 本体（v0.9.8 瘦身：五工具注册 + shell 等待引导 + premature wait 兜底 + session transport） | `src/lib/server/chat-mcp.ts` |
| pending 等待状态机 + 信号 API（v0.9.8 拆出：pendingMap / ToolReturn / submitXxx / notifier 注册表、routes 与 runner 都从这 import） | `src/lib/server/chat-pending.ts` |
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
| 推进 dialog（V0.6 重写、选 action；V0.9 内置+自定义混排；v0.9.12 隐藏项不出现、默认选可见第一位） | `src/components/tasks/advance-dialog.tsx` |
| **自定义 Action（V0.9、`custom` 类型 + 定义存储 + 管理页 + 客户端；v0.9.14 加 placeholder 字段 / skill 缺失兜底 / md 导入导出）** | `src/lib/server/custom-action-fs.ts` + `src/app/api/custom-actions/*`（含 import / export 子路由）+ `src/app/api/skills/route.ts` + `src/app/actions/page.tsx` + `src/components/custom-actions/custom-action-editor.tsx` + `src/lib/custom-action-client.ts` |
| **推进面板布局（V0.9、内置+自定义混排排序/显隐、framer-motion 拖拽配置）** | `src/lib/action-layout.ts` + `src/components/custom-actions/action-layout-config.tsx` + `FeAiFlowSettings.actionLayout` |
| 再聊聊 dialog（V0.6 适配 actionLabel） | `src/components/tasks/revise-dialog.tsx` |
| 新建任务 dialog（V0.6.0.1 重新加 mode tab、V0.8 加 `trigger` prop 供侧栏自定义触发） | `src/components/tasks/new-task-dialog.tsx` |
| 编辑任务 dialog + 字段热更（V0.6.6、详情页改软配置字段、reused agent diff 注入 `[TASK_UPDATED]`） | `src/components/tasks/edit-task-dialog.tsx` + `task-fs.ts: updateTaskFields` + `task-prompts.ts: buildTaskUpdateHint` |
| **应用外壳 + 侧栏任务导航（V0.8、常驻侧栏切任务 / 展开收起 ⌘B / 共享列表 store / 欢迎页 / 任务行类型图标 + pin 置顶 + 类型筛选）** | `src/components/app-shell.tsx` + `src/components/app-sidebar.tsx` + `src/hooks/use-task-list.tsx` + `src/components/tasks/task-list-item.tsx` + `src/components/ui/tooltip.tsx` + `src/app/page.tsx` |
| **任务注意力系统通知（v0.9.5、awaiting 转变沿 → 后台系统通知点击跳任务；v0.9.10 用户拍板去掉 Dock 角标——常驻不消被当噪声、作用不大）** | `src/components/task-attention-watcher.tsx` + `src/lib/shell-notify.ts` + `electron-app/{main.js,preload.cjs}` 的 `task-notify` IPC |
| 任务详情页（V0.6 重写、V0.8 去返回按钮 + h-full 适配外壳） | `src/app/tasks/[id]/page.tsx` |
| 任务角色 schema + 展示文案 | `src/lib/types.ts: TaskRole / TASK_ROLE_LABEL` |
| 多仓 cwd / repoPaths 工具 | `src/lib/path-utils.ts: getEffectiveCwd / formatRepoSectionForPrompt` |
| Artifact ref / 文件路径渲染（V0.6.0.1 加 `actions/` 前缀支持） | `src/lib/path-utils.ts: looksLikeArtifactRef / looksLikePath / buildCursorLink` |
| 设置：代码跳转 IDE + 默认分支命名模板（V0.12.x 删 username 字段） | `src/components/settings/user-profile-card.tsx` |
| 设置：仓库列表 + per-repo 分支 + 模板覆盖（V0.6.7）；分支字段 v0.9.11 起 Combobox 下拉（候选自动拉、非 git 禁用） | `src/components/settings/repo-card.tsx` |
| **仓库分支候选（v0.9.11、本地 + 远端合并去重、设置页 / 任务 dialog 分支下拉数据源）** | `src/lib/server/git-branches.ts: listRepoBranches` + `src/app/api/repo-branches/route.ts` + `src/hooks/use-repo-branches.ts` |
| 通用可搜索单选下拉（v0.9.11 抽、支持自由输入 + 清空、首用于分支字段） | `src/components/ui/combobox.tsx` |
| 设置：交互偏好卡（提交快捷键 + v0.9.11「推进时默认续用当前 Agent」） | `src/components/settings/preference-card.tsx` + `FeAiFlowSettings.reuseAgentDefault` |
| 设置：GitLab Host + PAT（V0.6.1 新增） | `src/components/settings/git-card.tsx` |
| **feature 分支命名模板引擎（V0.6.7、client+server 共用）** | `src/lib/branch-template.ts` |
| 模型选择器统一组件（可搜索 popover + chips 参数、全站 5 处共用） | `src/components/ui/model-select.tsx` |
| Skills loader | `src/lib/server/skills-loader.ts` |

## 设计变动流程

权威源 = 代码 + 本文件。设计层面变动：

1. **当前架构变动**（如 action 模型改、保活机制改、新增大组件）→ 改代码 + 同步更新本文件「当前架构快照」段
2. **小步迭代**（同主题连续 .1 / .2 / .3 微调）→ 改代码 + 写到本文件「最近演进」段顶部
3. **再老一轮时**（「最近演进」积压超过 2 个子版本）→ 把最老那段迁到 `docs/CHANGELOG.md` 顶部

⛔ 不要散落到其它 md 写一份新的演进段。
