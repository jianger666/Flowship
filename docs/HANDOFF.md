# ai-flow Handoff

> **权威源**：代码 + 本文件。其余 docs/*.md 为辅助、有冲突以代码 + 本文件为准。

## 项目定位（一句话）

站在 Cursor SDK 肩膀上的**项目级 AI Harness 平台 · 飞书 story → MR 自动化**。核心是 Harness（缰绳）：每个 action 边界用确定性工具（artifact 落盘 / 必备段 lint / review 只读指纹 / 基底 commit 校验 / MR 门禁 / HITL ack）压住 LLM 非确定性、保证产出可观测、可回退、可复用。

> 产品显示名 **Flowship**（v1.1.0 起、原「AI工作流」）；内部标识（appId / userData `fe-ai-flow` / artifactName / 仓库名）永远不改。

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

`Task.mode` 区分两种使用形态（V1.0 起入口分流：task 从飞书工作项详情页的启动表单进、「新建任务」dialog 已砍；chat 走侧栏 / 对话页「新建对话」零表单直建）：

| mode | 用途 | UI | runner | 必填字段 |
|---|---|---|---|---|
| `task` | 正经需求、走 action 容器 | 三栏 ResizablePanelGroup（左 timeline + 中 artifact + 右 event stream） | `task-runner.ts` + `_super.md`（只注入当前 action playbook） | title、repoPaths、feishuStoryUrl |
| `chat` | 跟 AI 临时聊（答疑 / 探索 / 思路碰撞、不走完整流程） | 单栏 `ChatView`（顶部 bar + event stream + 输入框） | `chat-runner.ts` + 极简 prompt（submit_work / ask_user 非阻塞、V0.11 会话模型） | 全选填、空 title 自动补「未命名对话 MM-DD HH:mm」 |

两套通路完全独立、不共享 runner / prompt / 推进 dialog / advance API。chat 模式 task 入 `/api/tasks/[id]/chat-reply`、task 模式 task 入 `/api/tasks/[id]/advance`（V0.13 起 approve 由推进时自动认可、`action-ack` 路由已退役、用户消息统一走 `[USER_MESSAGE]`）。`advance` route 防御性 reject `task.mode === "chat"` 的请求。

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
- `gitToken`：Personal Access Token（明文存服务端 `data/config.json`、跟 apiKey 同安全级别；V0.7.16 起配置已从 localStorage 迁走、`/api/settings` GET 默认脱敏返回）

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

### Skills loader

`src/lib/server/skills-loader.ts` 加载三源注入 prompt：平台自带 `<app>/skills/` + app 自管 `<dataRoot>/skills/` + 飞书 CLI `<dataRoot>/tools/skills/`。**不扫** `~/.cursor/skills/`（Cursor 全局只作能力页「从 Cursor 导入」源、拷成自管副本后才注入）。同名优先级：自管 > 平台 > 飞书 CLI。

---

## 最近演进（窗口式、保留 2 个子版本）

> 写入规则：新子版本完成后在本段顶部追加、超过 2 个时把最老的迁到 `docs/CHANGELOG.md`。

### 2026-07-13 晚 v1.1.8 发版：今日积压全量（下面三段 + 本段、v1.1.7 tag/draft 已删除作废）

- **GitLab 凭证运行时注入（野路子转正、用户拍板）**：settings 配了 gitToken 时、task + 绑仓 chat 的 prompt 注入「## GitLab 访问」段（host + `config.json` **gitToken 字段**位置 + 「只取该字段别 cat 全文件——里面还有其它密钥」+ 读随意写收敛 + 内置飞书 CLI 已登录勿预检）——AI 不再靠自己摸后门（线上实锤：同事的自定义 action 里 AI 先试 glab 失败、再自己发现 config.json 才跑通）；`action-ship.md`「拿不到 PAT 必然失败」旧措辞纠偏成「MR 创建必须走 submit_mr（落库审计）」。曾讨论过 `gitlab_api_get` 只读代理 + 红线的分级方案、用户拍板不做（本地单机、接受 token 进上下文）
- **插话答疑顺序硬化**（线上实锤：agent 先交卷后答疑、还把「这是纯疑问：我将…」当回复发出）：〈产出审阅中〉直令 + _super/[USER_MESSAGE] 段改写为「**先发答案、再 submit_work 重新交卷**、禁分类旁白」；本次立原则：**prompt 改动优先改写现有句子、不追加新段**（本批全部净增 ≤4 行）
- **creator 可移植原则**：action/skill creator 各加一句「凭证/系统工具细节不写进 skill（保通用）、运行时系统会注入」——skill 拿去 Cursor 等环境不废
- **蓝军全量终审**（v1.1.6..HEAD 8 commit）：无 P0；2 个 P1 已修（看板任务列表未加载时误进预览页——`!loaded` 回退信缓存映射；mac 更新暂存下载无并发互斥——single-flight stagingPromise）；P1-3/4（退出替换窗口强杀空窗、DELETE 挂死锁死列表项）+ 若干 P2 记账攒下版
- 工作项预览页描述区块整体移除（用户拍板）

### 2026-07-13 傍晚（已随 v1.1.8 发）：线上 bug 修一批 + mac 自更新延迟替换

- **postCheck 红条终于实装**（同事「自定义 action 不知道 AI 写没写产物」根因）：后置检查 fail 一直只落 `action.postCheck`、前端 0 处渲染（V0.6 设计的红条漏做）——artifact 面板正文/空态顶部 destructive 警示条（「后置检查未通过」+ details）+ action timeline 行警示标；顺带修 Windows 反斜杠路径漏检测（sdk-message-handler 匹配前归一 `\`→`/`、否则「在写 artifact」事件与 artifactUpdatedAt 刷新全漏）+ 过时 `skills/artifact-writer` 教旧 artifacts/ 路径纠偏
- **删任务后看板 404 修复**：看板 `handleOpen` 盲信缓存里的 `item.task` 硬跳已删任务——改成点击前用 `useTaskList()` 实时校验、删了就走 `/workitems/` 预览重新建（用户期望）；任务详情页 `!task` 从裸 `notFound()` 改 EmptyHint+「回工作台」；侧栏删除防重（deletingIds 锁 + 404 幂等成功不再 toast「任务不存在」+ `use-task-list` pendingDeletes 防 2s 轮询回魂 + 删当前任务先导航再等 DELETE）
- **表单**：任一仓填「已有工作分支」→ 强制原仓运行、worktree 勾选隐藏换一行说明（同事实测踩「已有分支+隔离」必撞 git 同分支双检出）；勾选文案改正向「使用 worktree 隔离运行」（用户拍板「原仓运行别人看不懂」）、设置页对应项同步
- **mac 自更新改延迟替换**（用户实测「稍后」态被硬闸拦、问能不能不用重启）：下载+验签后只暂存 `updates/staged-<v>.app`、**不碰 /Applications**——「立即更新」= 替换+重启；「稍后」= 老进程跑在没动过的老包上完全正常、before-quit 时替换（preventDefault 等替换完 exit）、启动早期兜底（有效暂存 → 替换+relaunch 无感知）；update-pending-restart 硬闸保留但正常流程不再触发；启动清扫扩展覆盖过期 staged
- test 包中途打过一轮给用户验收（只读仓 / 删除 404 / 表单批）
- ⏸ **讨论后搁置记账：GitLab 能力分级方案**（用户拍板「现在的好像也能用、先不改」）——背景：creator（action/skill）零提系统能力、AI 无「读 GitLab」正规通道、测试同事的 action 靠 AI 自己发现 config.json 明文 token 跑通（野路子、token/apiKey 会进事件流与上下文）。已讨论定型但未实施的方案：A. 两个 creator 加「系统能力速查」（含新原则：工具名不进 skill、只进运行时注入、保 skill 通用性）B. `gitlab_api_get` 通用只读代理 + `add_mr_comment`（读自由写收口、merge/删分支不开）C. 「禁读 config.json 取密钥」红线。将来要做直接按这个捡起来。

### 2026-07-13 午后（已随 v1.1.8 发）：仓库级「只读」取代测试角色机制

> ⚠️ v1.1.7 tag 被用户手动取消 CI（draft 未转正、对外不存在、latest 仍指 v1.1.6）；本段改动只在 main、等用户亲自验收后再定发版。同日立规：**发版只在用户主动喊「发版」时做、用户没验过的改动绝不发**（见 learned-conventions）。

- **背景（用户复盘）**：v1.1.6/1.1.7 的「测试角色（userRole=qa）」路线提示词越补越多（三变体 20 行 + 按角色的 ship/dev 闸）、维护成本高、开发者自己都记不住。拍板改成**仓库级只读**：语义跟着仓走、配一次永久生效、看得见不靠记忆。
- **实现**：settings.repos 每仓「只读」Switch（`RepoEntry.readonly`）→ 建任务快照 `task.readonlyRepoPaths`（同 nonGitRepoPaths 三写点模式）；只读仓**不进隔离 worktree**（原仓直接用、用户拍板「不写代码隔离没必要」）；门禁——全仓只读拒 build/ship/dev（`ALL_READONLY_REPOS_BLOCK_REASON` 单一文案源、服务端 + 弹窗灰卡共用）、`submit_mr` 对只读仓拒；prompt 只剩**一行**只读约定（不改内容/不建分支/不 commit push 提 MR、允许 pull + 切测试分支拉最新）、分支配置段只读仓行尾标 🔒；**后置确定性检测**（action-checks、所有 action 通用）：交卷后对只读仓查 `status --porcelain` 脏 + 本地领先 upstream 的 commit、被动过红条罗列（pull/切分支不误报）——「shell 硬拦」的替代（hooks 链路 v1.1.2 已拆、恢复成本高、记账观察）；任务头部只读仓挂 Lock icon
- **退役删除**：`buildQaRoleDirective` 三变体 + `{{qaRoleDirective}}` 占位 + 两 runner 注入接线 + action-gates/advance-dialog 的 qa 角色闸——角色（userRole）不再影响任何 prompt / 门禁

### 2026-07-13 v1.1.7（tag 已作废、CI 被取消、改动在 main）：测试角色专项审查修复 + 工作台手动建任务入口

- **测试角色约定专项审查**（用户点名「拉子代理一起 review 影响点」、逐 action 推演 + prompt 一致性 + 边界场景、报 3 P1）：① 守约定反而必红——review 只读指纹把 HEAD 编进 hash、QA detached 切基线必触发红条；② 非隔离任务切基线会动用户原仓 HEAD；③ ship/dev 准入不看角色、playbook（commit+push+提 MR）与 QA 红线硬对撞
- **修复**：唯一代码闸 = `checkActionPrerequisites` ship/dev 对 `userRole==="qa"` 直接拒（`QA_ROLE_BLOCK_SHIP_DEV_REASON` 单一文案源、服务端准入 + 推进弹窗灰卡共用；advanceTask 读 settings 传 ctx）；其余全 prompt 文案解——`buildQaRoleDirective` 加 `isolateWorktree` 参数：隔离 task 才教 detached 切基线（含 MR ref 姿势）、非隔离 task / chat 一律「不切分支、当前检出只读验证」；追加通用约束（review 期间不切 commit / 误推 build 只产验证报告 / learn 只写任务目录 / 本约定优先于 playbook）
- **工作台手动建任务**（用户：有些需求没排到甘特上、看板无入口）：看板头部「手动建任务」按钮 + 空态提示带链接 → 新页 `/workitems/new`（TaskLaunchForm 无预填复用）；表单飞书链接字段——有预填固定带入（看板进）、无预填露出可编辑输入（placeholder「粘贴飞书工作项链接」）、必填语义不变
- 顺带（v1.1.6 发出后的样式跟进）：推进卡两行方案回退单行 truncate + hover Tooltip 补全名（两行让 grid 行高不齐、用户拍板）；文字 13px→12px + padding 收窄、单行多容一两个字

### 2026-07-13 v1.1.6 发版：非 git 目录混合隔离 + 测试角色约定 + MCP 去自动导入（蓝军终审 1P0 拦下修完复审过）

- **非 git 目录不再拦推进（混合隔离）**：task 绑的 repoPath 没有 `.git` 时——git 仓照旧建 worktree、非 git 目录跳过隔离原地使用（脚本库无分支概念）。核心：`Task.nonGitRepoPaths` 快照（createTask / updateTaskFields / setTaskRepoPaths 三写点、undefined=全 git 老任务兜底、**不做运行时 existsSync**——防 .git 中途增删映射漂移）；`getTaskWorkRepoPaths` 逐仓映射；**`getTaskCwd` 只对 git worktree 聚合**（终审 P0：混着原路径算公共父会漂到 $HOME、agent cwd / IDE 打开路径 / 兄弟仓扫描全翻车——已修+单测锁死）；`formatRepoSectionForPrompt` 混合模板逐仓标注；client `getRepoWorkDirs` 非 git 用原路径；`planBranchesForBuild` 非 git 跳过 checkout hint
- **测试角色约定（纯 prompt、零服务端行为改动、用户拍板「简单点」）**：`settings.userRole === "qa"` 时 task（+绑仓 chat）注入 `buildQaRoleDirective`——不改仓库代码/不建分支/不 commit push MR（产物放任务目录或非 git 目录）、验证基线=各仓提测分支（detached 姿势切、显式豁免隔离段「禁止 checkout」）、给了 MR 链接用 `merge-requests/<iid>/head` 原生 ref 拉（不需要分支名/Token）、提测分支多需求集成只验当前需求范围；chat 变体不引用「仓库分支配置」段、纯非 git 任务只注入通用部分
- **MCP 去 Cursor 全局自动导入**：删 V0.13 `migrateCursorMcpOnce` 整套（新用户首次落盘 config.json 会静默快照 ~/.cursor/mcp.json、用户拍板不可接受）；「从 Cursor 导入」手动链路是唯一导入口；老用户早已迁移完成无影响
- **推进弹窗 action 卡长名两行**（v1.1.7 已回退成 Tooltip 方案、见上）
- 流程：4 个 grok 子代理并行实施 → 蓝军终审拦下 1 P0 + 1 P1 + 2 P2 → 修复子代理全修 → 蓝军复审通过；余 3 个文案级 P2 攒下版

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
| MCP server 本体（v0.9.8 瘦身：工具注册 + premature 兜底 + session transport；V0.11 起 wait 协议退役、submit_work / ask_user 非阻塞） | `src/lib/server/chat-mcp.ts` |
| pending 等待状态机 + 信号 API（v0.9.8 拆出：pendingMap / ToolReturn / submitXxx / notifier 注册表、routes 与 runner 都从这 import） | `src/lib/server/chat-pending.ts` |
| 推进 / 终结 路由（V0.13 起 action-ack 退役、approve 由推进时自动认可） | `src/app/api/tasks/[id]/{advance,finalize}/route.ts` |
| watch-task SSE 路由 | `src/app/api/tasks/[id]/watch-task/route.ts` |
| Action revisions / diff 路由 | `src/app/api/tasks/[id]/{action-revisions,action-diff}/route.ts` |
| ContextDocsPanel（任务级上下文） | `src/components/tasks/context-docs-panel.tsx` |
| ask_user 答题卡（V0.13 起内联进事件流、原弹窗退役） | `src/components/tasks/ask-user-inline.tsx` |
| 事件流主组件 + utils + rows | `src/components/tasks/event-stream{,/utils,/rows}.tsx` |
| Artifact 面板（V0.6 适配 ActionRecord） | `src/components/tasks/artifact-panel.tsx` |
| Artifact diff 组件 | `src/components/tasks/artifact-diff.tsx` |
| **Action timeline（V0.6 新）** | `src/components/tasks/action-timeline.tsx` |
| 推进 dialog（V0.6 重写、选 action；V0.9 内置+自定义混排；v0.9.12 隐藏项不出现、默认选可见第一位） | `src/components/tasks/advance-dialog.tsx` |
| **自定义 Action（V0.9、`custom` 类型 + 定义存储 + 管理页 + 客户端；v0.9.14 加 placeholder 字段 / skill 缺失兜底 / md 导入导出）** | `src/lib/server/custom-action-fs.ts` + `src/app/api/custom-actions/*`（含 import / export 子路由）+ `src/app/api/skills/route.ts` + `src/app/actions/page.tsx` + `src/components/custom-actions/custom-action-editor.tsx` + `src/lib/custom-action-client.ts` |
| **推进面板布局（V0.9、内置+自定义混排排序/显隐、framer-motion 拖拽配置）** | `src/lib/action-layout.ts` + `src/components/custom-actions/action-layout-config.tsx` + `FeAiFlowSettings.actionLayout` |
| 说话入口合一（V0.13、原「再聊聊」弹窗 + 「问一问」输入条二合一、revise-dialog 已删） | `src/components/tasks/task-talk-composer.tsx` |
| 任务启动表单（原 new-task-dialog 退役、V0.14+ 页面内表单形态） | `src/components/tasks/task-launch-form.tsx` |
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
