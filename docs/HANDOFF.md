# Flowship Handoff

> **权威源**：代码 + 本文件。其余 docs/*.md 为辅助、有冲突以代码 + 本文件为准。

## 项目定位（一句话）

站在 Cursor SDK 肩膀上的**项目级 AI Harness 平台 · 飞书 story → MR 自动化**。核心是 Harness（缰绳）：每个 action 边界用确定性工具（artifact 落盘 / 必备段 lint / review 只读指纹 / 基底 commit 校验 / MR 门禁 / HITL ack）压住 LLM 非确定性、保证产出可观测、可回退、可复用。

> 产品显示名与 GitHub 仓库名均为 **Flowship**（v1.1.0 起、原「AI工作流」；仓库于 2026-08-03 从 `fe-ai-flow` 改名）。发版链稳定内部标识（appId / userData `fe-ai-flow` / artifactName）永远不改。代码内标识已全面 Flowship 化（v1.1.x：包名 `flowship`、env `FLOWSHIP_*`、globalThis `__flowship*`、localStorage `flowship:*`）；MCP 保留名 `flowshipChat` / `custom-user-tools`（系统工具走 SDK customTools、防用户占用）；仍保留旧值的仅剩：持久化 marker（`<!--fe-ai-flow-rev-split-->`、`refs/ai-flow/checkpoints`）、退役迁移 key（`fe-ai-flow:settings`）。

## 给 AI 接力的最小上下文

按顺序读：

1. `.cursor/rules/project-context.mdc` —— 强制约束
2. `.cursor/rules/learned-conventions.mdc` —— 编码风格
3. 本文件「当前架构快照」段（V0.6 系列、稳定架构）+「最近演进」段
4. `prompts/_super.md` —— super-prompt 主模板（V0.6.27 起只注入当前 action playbook + action history）
5. `prompts/_shared.md` —— 跨 action 通用 artifact 写法 + 跨 action 规则
6. `prompts/action-plan.md` / `action-build.md` / `action-review.md` / `action-ship.md` / `action-dev.md` —— 各 action 的特有约束
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
- **action** = 单次动作（plan / build / review / ship / dev）、任意触发、不强制顺序

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
| `chat` | 跟 AI 临时聊（答疑 / 探索 / 思路碰撞、不走完整流程） | 单栏 `ChatView`（顶部 bar + event stream + 输入框） | `chat-runner.ts` + 极简 prompt（多轮 `agent.send`、V0.11 会话模型；不走 action 交卷） | 全选填、空 title 自动补「未命名对话 MM-DD HH:mm」 |

两套通路完全独立、不共享 runner / prompt / 推进 dialog / advance API。chat 模式 task 入 `/api/tasks/[id]/chat-reply`、task 模式 task 入 `/api/tasks/[id]/advance`（V0.13 起 approve 由推进时自动认可、`action-ack` 路由已退役、用户消息统一走 `[USER_MESSAGE]`）。`advance` route 防御性 reject `task.mode === "chat"` 的请求。

### 双状态：repoStatus + runStatus

V0.5 单 `status` 字段（draft / running / awaiting_user / completed / failed）拆成两个独立维度：

| 字段 | 含义 | 取值 |
|---|---|---|
| `repoStatus` | 任务对仓库的业务状态 | `developing` / `merged` / `abandoned` |
| `runStatus` | agent 运行时状态 | `idle` / `running` / `awaiting_user` / `error` |

UI 卡片 / 详情页头部分两个 badge 显示。

### V0.6.1 已实装 vs stub

仅 `task.mode === "task"` 走下表的 action 体系；`chat` 模式独立通路、不在此表。

| Action | 状态 | 准入条件 | 后置 deterministic check |
|---|---|---|---|
| plan | ✅ 已实装 | 永远可 | artifact 存在 + 内容长度 >= 100 + 必备段（需求理解 / Task 拆分、V0.6.27）|
| build | ✅ 已实装 | 永远可（V0.6.17 放开 plan 前置）| artifact 落盘 + 必备段（全量校验；「修改记录」铁段已删）+ 兄弟仓越权检测（V0.6.27）；跑项目命令的 CheckRun 已删（v0.9.13、见下）|
| review | ✅ 已实装 | 永远可（v0.8.23 去「先 build」流程前置）| 必备段（总评 / 需求对照 / bug 复审）+ 基底 commit 跟 HEAD 一致（V0.6.25 P1-2 修死代码正则）+ 工作区指纹未变（V0.6.27 只读硬校验）|
| ship | ✅ 已实装 | 能从仓库推得 GitLab Host + 已配 PAT（v0.8.23 去「先 build」、只留技术前置）| `task.mrs[]` 覆盖所有 repoPath（URL 非空） + 跳仓有原因 |
| dev（联调）| ✅ 已实装 v0.8.23 | 至少一仓配 dev 分支 | 直推无 MR 信任 artifact；提 PR 同 ship 门禁（URL 非空 + 冲突拦）|

无 stub——上表五种均已实装；另有 `custom`（用户自建定义、不在本表、advance API 校验定义存在性）。

### 大需求分批 build（V0.6.23 起、V0.6.24 打磨、可选）

plan 可把大需求在 §5 task 之上再分「批次」（`PlanBatch`、plan agent 调 MCP `set_plan_batches` 上报、落 `ActionRecord.planBatches`）。之后：

- **build 选批**：推进 build 时 advance-dialog 列批次让用户勾（**默认不勾任何批次**、必须显式选本次要做 / 返工的批次、`canSubmit` 拦空选；提供一键「全选」、已做的带角标）、`requestedBatchIds` 落到该 build action；runner `buildBatchDirective` 把「本次做哪批 + 测试策略 + 进度」拼进 `[NEXT_ACTION]` 的 `[BUILD_BATCHES]` 段；每批可「新启 Agent」换干净上下文（无 subagent 原语、用这个当等价物）
- **测试策略**：每批标 `TestStrategy`（tdd / after / none、自适应不强制、label「先写测试(TDD) / 实现后测试 / 免测」走 `TEST_STRATEGY_LABEL` 单一源）、build agent 按策略走（TDD 批用 `shell` 实跑仓库现有测试框架、先写测试看红 → 实现到绿；无测试设施则退化「正常实现 + artifact 写明该测什么」）
- **review 两层**：runner `buildReviewScopeDirective` 按派生进度注入 `[REVIEW_SCOPE]`——还有批没做 = 增量（聚焦新批 + 衔接）、全做完 = 集成（查批次间接口 / 数据流 / 重复实现 / 冲突）
- **进度纯派生**：`task-display.computeBatchProgress` / `deriveEffectiveBatches` 从 action 历史算「已做批 / 总批」、不存计数器（前后端共用单一源）；批次读取**不限 plan status**（批次是 agent 主动落库的有效数据、plan 重跑被标 error / 接续没重拆都能回退到拆好那版、避免分批失效）
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
- agent 跑完 action → 写完 artifact 后调 `submit_work(action_id)` **交卷**（非阻塞）→ 拿到 `[SUBMITTED]` 后说 1-3 句业务结论并结束 turn（固定横幅在 run 结束补发）→ runner **后台异步**跑后置检查（V0.8.18）、跑完把 action 标 `awaiting_ack`
- 用户操作以 send 送达：再聊聊 = `send([ACTION_ACK revise]+feedback)`、ask 答案优先走提问时挂上的 `/ask-wait` curl（同一轮 stdout），没挂上才 `send([ASK_USER_REPLY]…)`；**通过纯服务端落状态**（agent 不需要收信号）
- 终结 task → finalize 直接 cancel 活 run + 关会话（不再发 [TASK_DONE] 信号）

**字段热更（V0.6.6、仅续用路径需要）**：super prompt 只在会话启动时构造一次、续用推进时用户在详情页编辑的 `title/role/feishuStoryUrl` 会 stale。runner 在 `agentSessions` record 存启动快照（内存、不落盘）、续用推进时 diff 出变更、**有变才**拼一段 `[TASK_UPDATED]` 注入 `[NEXT_ACTION]` directive（注入后推进快照防重复告知）。

### 会话机制：agent 会话跨 run 存活（V0.11、替代 V0.3.5~V0.10 的 shell curl 长轮询）

```
Agent.create（每 action 默认新建 / 勾续用复用）
  → agent.send(prompt) → run 流式消费 → 交卷后自然结束 turn；提问则前台 curl 挂 `/ask-wait` 等答案（没挂上则结束 turn、答案改 send）
  → agent 实例保留在 agentSessions（不 close）
  → 用户下一步操作（推进续用 / 再聊聊 / chat 消息 / 未挂 wait 的 ask 答案）→ agent.send(新消息) → 新 run
  → stop / error / finalize / 换新 agent / 服务重启 → 会话关闭（下次 fresh agent + artifact/events 恢复上下文）
```

「run 自然 finished 但最后 action 还 running」时豁免两种正常情况（后置 check 在跑 = 刚交卷、pendingAsk 在等答案）、否则先 `agent.send` 追问补调 `submit_work`（最多 2 次）、仍不交则标 error。

### 推进 dialog（V0.6 重写）

用户从「推进」按钮打开 dialog、选下一个 action 类型 + 写指令：

- **action 类型卡片**：内置 + 自定义混排、顺序 / 显隐在 /actions 页配（隐藏的直接不出现）；不满足准入条件灰掉 + hover 提示
- **默认选中**：可见列表第一位（用户自己排的顺序、无业务假设——v0.9.12 删掉按 repoStatus / 最近 action 顺推的 `inferDefaultActionType`、工具通用化不再假设研发流程）；全部隐藏时空态引导去 /actions 页
- **placeholder 动态**：按 action 类型 + task 状态变（首次 plan vs 再次 plan；已有 ship/dev MR 时提示「已有 vN …继续推」；其余走各 action 固定文案）
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

门槛 2（action 后置 deterministic check、`action-checks.ts`）的检查范围**只到「agent 交付是否诚实」为止**：artifact 落盘 + 必备段 lint、review 只读指纹 / 基底 commit 验真、ship MR URL 覆盖所有仓、build 兄弟仓越权检测。

**不跑项目命令**（typecheck / lint / test）。V0.6.25~V0.6.26 曾建过一整套 CheckRun（per-repo 配命令 + 自动检测 + 污染检测 + ship gate override 留痕）、v0.9.13 整套删除、根因是语义错配：

- 全仓检查问的是「项目是不是绿的」、但存量项目基线本来就红（历史债）——agent 只改两个文件也永远红、红色失去信息量、还连带 ship 每次都要 override 填原因（用户实测「公司项目几乎全部不通过」）
- 方向通用化后（测试 / BI 等非研发用户、纯自定义 action）「研发流程假设」不再成立
- 代码质量校验由 build agent 自己做（`action-build.md` 让 agent 找仓库命令做**增量**校验、改哪查哪）+ review action 人审兜底

保留的基建：`runActionPostCheck` 后台异步框架（`runningChecks` 去重 + abort、防状态交错——check 同步 await 会把交卷工具阻塞到超 Cursor SDK ~60s 工具超时、线上踩过）、`computeWorktreeFingerprint` / `computeRepoStatusHash`（review 指纹 + 兄弟仓基线用、V0.11.2 起纯 Node execFile git 实现）。`GET /ship-precheck`（reviewMissing 提醒）已于 V0.11.7 随黄条整链删除。

### Shell 命令硬拦截（已退役）

V0.6.27 曾用 `beforeShellExecution` hook（`shell-guard.mjs` → `/api/hooks/shell-check` + `shell-guard-rules.ts`）硬拦高危 shell；**V0.11 随 hooks 整体退役**（改 `agent.send` 追问交卷后不再注入 hooks）。相关实现（`shell-guard-rules.ts` / `scripts/shell-guard.mjs` / `hooks/shell-check` / `stop-hook-inject.ts`）已删。现状：启动时 `cleanup-fe-hooks.ts` 清业务仓残留的 fe 注入 `hooks.json`；shell 禁令仍靠 `_shared.md` prompt 软约束。

### Git Branch 自动建（V0.6.1 多仓、V0.6.7 命名模板化）

build action 每次跑前、runner 拼 `GitBranchInfo[]`（每仓 1 条 branch）、prompt 头部追加**多仓 idempotent** checkout 引导。

**分支名按模板渲染**（V0.6.7、`src/lib/branch-template.ts`、内置兜底 `feature/{storyId}-{taskTitle}`、V0.12.x 删 username 字段——老配置迁移时把名字烘焙进模板）：

- 占位符：`{storyId}`（从 feishuStoryUrl 抠）/ `{taskTitle}` / `{date:FORMAT}`、每个值各自 branch-safe 化（含路径分隔 `/`、模板字面的 `/` 才是层级）；老任务快照里的 `{username}` 渲染为空段、由 `/` 清理兜住
- 模板层级：per-repo 覆盖 > 全局默认 > 内置默认；建 task 时由 client `resolveBranchTemplate` 算「有效模板」固化进 `task.repoBranchTemplates`、build 直接渲染——**不同仓可用不同模板**（如后端 `feature/{date:MM-dd}/{storyId}-{taskTitle}`）
- 开发侧已移除「已有工作分支」；`repoFeatureBranches` 仅测试任务用作「被测业务分支」（QA 填、可后补）

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
- **PAT 不暴露给 agent**：agent 通过平台工具 `submit_mr` 间接调、server 端凭 settings 闭包的 token 访问 GitLab；工具返结构化 JSON（`{ ok, mr_url, mr_iid, mr_version }`）
- **多仓 task 每仓 1 条 MR**：`Task.gitBranches[]` / `Task.mrs[]` / `ActionRecord.sideEffects.mrs[]` 都按 `repoPath` 区分；某仓 `git diff` 为空时 agent 跳过、在 artifact 写跳过原因
- **同分支累计 commit**：同 `(repoPath, 目标分支)` 多次提交不开新 MR、`version` 累加、保留 `createdAt` 首次值——`upsertMR(taskId, repoPath, { targetBranch, ... })`（v0.8.23 去重键加目标分支、同仓提测 MR→test 和联调 MR→dev 各记各的）
- **dev（联调）复用同一 GitLab 基建（v0.8.23）**：提 PR 模式跟 ship 共用 `submit_mr` + `MRRecord` + 冲突门禁、唯一区别 target = dev 分支；直推模式不提 MR（本地 merge dev 直推）。详见「最近演进」v0.8.23
- **飞书 @ 测试人员（A+C 策略）**：首次 ship 由 agent 调飞书 MCP `get_workitem_brief` 自动探测（A、role_members 的 `member.key` 就是 user_key）、探不到时 ask_user 让用户填用户名（C、`search_user_info` 转 user_key）、结果通过 `set_feishu_testers` MCP 工具持久化到 `task.feishuTesterUserKeys`、后续 ship 直接复用。id 体系 = 飞书项目 user_key（2026-06-12 起、lark_user_id 被官方 MCP 封死、详见 action-ship.md §4）

settings 相关字段：

- `gitToken`：Personal Access Token（明文存服务端 `data/config.json`、跟 apiKey 同安全级别；V0.7.16 起配置已从 localStorage 迁走、`/api/settings` GET 默认脱敏返回）；UI 在连接卡 GitLab 节（`git-card.tsx` 的 `GitLabSection`）
- Host：**不进 settings**——`resolveEffectiveGitHost(repoPaths)` 按任务仓库 origin remote 现推；多仓分属不同 GitLab 实例 fail-fast（「多仓属于不同 GitLab 实例、暂不支持」）

ship 准入 = 能推得 Host + 已配 `gitToken`（不再要求 build 已 approve；全仓只读另拦）。

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

### 发起人身份（设置页 userRole）

角色语义只剩设置页 `userRole`：注入 prompt「发起人」行（姓名 + 角色），作为 AI 工作视角/身份锚点。任务级 `Task.role` / 自适应枚举已退役——不再为单任务选角色。

### 多仓库 cwd 公共父目录（V0.5.9 沿用、V0.10 叠加 worktree 隔离）

`Task.repoPaths: string[]`、SDK Run `local.cwd = getTaskCwd(task)`（task-worktrees.ts）：

- **隔离 task（`isolateWorktree`、新建默认）** → cwd = `<数据目录>/worktrees/<taskId>/`下的 worktree（单仓 = worktree 自身、多仓 = taskId 目录做公共父）、并行任务互不干扰
- 非隔离（逃生口 / 老 task / chat）走 `getEffectiveCwd(repoPaths)` 旧逻辑：单仓 = 仓自身、多仓 = 公共父目录、0 仓 = home（纯探索 / 答疑场景）

### Resizable 分栏 + 修订视图（V0.5.10 分栏沿用、v1.1.9 修订模式替代 Diff tab）

任务详情页主区：左 `ArtifactPanel`（当前 selected action）+ 右 `EventStream`、可拖动、持久化在 `task.uiLayout.artifactPanelSize`。

ArtifactPanel 正文常显 + toolbar「修订」开关（原「正文 / Diff」tab 已退役）：开则内联 Track Changes 渲染（`md-revision.ts` + `artifact-revision-view.tsx`）；对比数据仍走 `fetchActionRevisions` / `fetchActionDiff` API；有未看 revision 时开关挂红点。

### Skills loader

`src/lib/server/skills-loader.ts` 加载三源注入 prompt：平台自带 `<app>/skills/` + app 自管 `<dataRoot>/skills/` + 飞书 CLI `<dataRoot>/tools/skills/`。**不扫** `~/.cursor/skills/`（Cursor 全局只作能力页「从 Cursor 导入」源、拷成自管副本后才注入）。同名优先级：自管 > 平台 > 飞书 CLI。

### 团队库（组共享库 + 知识库镜像、2026-07-22）

一个 GitLab 仓（内置地址 `frontend/infra/ai-flow-action-hub`、`<dataRoot>/team-library.json` 可覆盖）作为团队 skill / action 分发中心，对用户无感：启动自动 clone/pull 到 `<dataRoot>/team-library/repo`。

```
ai-flow-action-hub/
├─ skills/<角色分类>/<skill名>/SKILL.md [+ .flowship-action.json]  ← 组内沉淀（fe/be/qa/other/common）
└─ knowledge/   ← 公司知识库 wukong/wk-harness-platform 整库镜像（默认分支 release/1.0）
   ├─ knowledge-base/  工程知识档案
   ├─ scripts/         知识库维护脚本（kb_refresh.sh / pull_*_repos.sh）——不是门禁脚本
   └─ skills/{global,frontend,backend,client}/<工程>/<skill>/SKILL.md
      └─ global/wk-harness/scripts/  ← 七个 wk 门禁脚本（doc-quality-gate.py / wk-context-init.py /
         wk-delivery-sync.py 等），`wk-gate.wkScriptsDir()` 指向这里
```

- **模块**：`team-library.ts`（sync / 上传 / 镜像 / 安装卸载，git 网络操作走 inline credential helper + env 传 token——不进命令行/config/FETCH_HEAD；对外错误统一 `redactGitText` 脱敏；`withTeamLibraryLock` 全局仓锁互斥）+ `team-skill-states.ts`（安装态存储、零依赖小模块）
- **skills 第四源「team」**：loader 扫 clone 两目录注入；`knowledge/skills/**` 条目带 `kbRoot`（skill 内库相对路径的解析根）；同名优先级最低；`loadSkillsForTask(repoPaths)` 按任务仓 basename 强制注入命中的工程档案 skill（无视安装态）
- **市场模型**：team skill = 安装/卸载（`skill-states.json`、单一 owner = team-library 模块，settings.disabledSkills 只管自管源）；**首次默认**：`skills/` 共享（含派生 action）未装、按需安装；`knowledge/skills/` 团队规范默认开；增量新名一律未装；用户改过的永不被默认策略覆盖
- **共享 action 派生**：带 `.flowship-action.json` 的已安装 team skill 实时派生虚拟 CustomActionDef（id `team:<skill名>`、origin "team"），合成点在 custom-action-fs 读入口——安装/卸载一份状态、无第二份定义文件可撕裂；写入口对 `team:` id 防护（PATCH 拒绝、DELETE 转卸载）
- **上传**：勾自管 skill → 选角色分类（默认 userRole）→ commit+push main；被保护分支拒 → 自动推临时分支 + GitLab REST 开 MR（pendingReview + mrUrl、maintainer 审批）
- **知识库镜像**：`canMirror` 按 gitToken 对源仓的真实权限探测显隐；镜像 = 拉 `wukong/wk-harness-platform` → 拷进 `knowledge/` → push；同事无源仓权限也能用全套规范
  - **源分支**：`git ls-remote --symref` 探远端默认分支（当前 `release/1.0`，**不是 main**——main 是另一条受保护分支），探不到才回退 `knowledgeSourceBranch` 配置值
  - **排除**：`MIRROR_EXCLUDED_TOP_DIRS`（单一来源常量）= `codes/` + `harness-delivery-hub/`（交付平台服务端项目、1.2M/176 文件/0 个 skill，不是知识内容）
  - **整体替换**：`copyTree(clearDest:true)` 先删整棵 `knowledge/` 再重建，源仓删的文件不留幽灵
  - **`knowledge/` 豁免敏感扫描**：机器镜像不是用户手写内容，高熵规则对 py 标识符 / XML 属性值 / 文档示例 URL 满屏误报（实测 18 个变更文件 106 处、无一为真）会把镜像永久卡死；扫描只保留在真正的风险面「用户上传自管 skill → `skills/`」
- **开关**：仅「团队规范」保留总开关 `teamKnowledgeEnabled`（一键隔离 wk 套：skill 不注入 + 自动匹配停 + 推进面板隐藏相关 action）；共享无总开关；内置/飞书 CLI 无行开关（必备只读）
- **UI**：能力页 Skills 区双栏（左 5 项来源导航 + 右列表：chip 分类过滤 / 搜索跨源平铺 / 市场行「安装/已安装+卸载」/ 组头挂同步·镜像·上传）；组件在 `skills-panel/`

### 需求群协作（飞书需求群 ↔ 任务双向打通）

一个飞书群绑一个飞书项目工作项（meegle `group_type` bind），前后端测试各自的 Flowship 任务都往这个群里发 / 从这个群里收。**每人各配自己的飞书自建应用**——bot 事件只到属主本机、@ 谁的 bot 就路由到谁，天然没有广播认领问题。完整设计与实测数据（权限边界 / id 换算表 / 竞态语义全表 / 单测清单）在 `docs/feishu-group-collab.md`，改群相关代码前先读它。

| 链路 | 模块 | 干什么 |
|---|---|---|
| 分享（出）| `feishu-group.ts` + `POST /api/tasks/[id]/share-to-group` + MCP `share_to_group` | **发到需求群的唯一收口** `shareToRequirementGroup`：`format: "card"`（默认）幂等建群 + 发卡，`artifact` 再跟全文 md；`format: "post"` 发 IM markdown（可 `mentions` 真 @），不建卡片 |
| 成员注册表 | `feishu-group-registry.ts` | **建群是唯一能带人 / 带 bot 的时机**（事后拉人缺 scope）——按工作项角色成员邮箱反查，一次把人和他们各自的 bot 带齐 |
| 回流（入）| `feishu-bridge/group-route.ts` | 群消息 → 任务：三层 @ 过滤 → chat_id 反查本机任务 → 推进命令 / 答题 / 消息注入 |
| 出向 | `feishu-bridge/group-outbound.ts` | 全局 task 流 tap：ask 卡发群、回答回群（`post` markdown）、推进产物回群 |
| 提测 @ 测试 | `feishu-bridge/group-tester-notify.ts` + 工具 `notify_group_testers` | ship 写完飞书评论后由 agent 调；只认邮箱走提测通知卡（卡片 `<at email>` 真 @）；没群 / bot 不在群返回 skipped，不阻塞 |
| 自动播报 | `feishu-bridge/group-broadcast.ts` | app 内 action 跑完自动进群（`off` / `ship` / `all` 三档、当前固定 `off`、**绝不建群**）|
| 共享状态 | `feishu-bridge/group-shared.ts` | 回群登记表 + 产物卡防重 + 选择卡防重 + 群成员名清洗 |

四条硬口径（都是踩出来的、别回退）：

- **身份门控**：读 / 答疑对全群开放，**写路径只有任务所有者本人**能触发（推进 action、改产物重交卷、唤醒全权限 agent）。非属主的普通文本强制走受限旁路（见下节）；chat 型任务没有受限通道 → 非属主普通文本直接拒。
- **回群登记 token 化投递**：每条登记绑不可复用 token + 记死「在等哪一路 run」（`runTag`：属主主链 = null 单格、旁路 = 自己的 token 且多条并存），攒回答与 flush **只认 `origin === runTag` 的那一路**——属主 run 与多位同事的答疑 run 同时在飞也各回各的。
- **advance 登记只增不静默减**：摘掉它 = 群里永久收不到那轮产物（既没产物卡也没失败回执）。四条清理链（租约到期 / 属主单格覆盖 / 容量上限 / 失败回滚）对 advance 的口径统一成**一张表**，写在 `group-shared` 文件头与设计文档——⛔ 新增清理链先对表。推进的收口判据是 **action 落终态**、不是 turn 结束（`done` 在 agent 中途 `ask_user` 时就会发一帧、那会儿 artifact 还没写）。
- **依赖方向**：`feishu-group` 静态引 meegle-cli，**挂在 router / bootstrap / task-runner 图上的模块一律动态 `import()` 它**（否则一堆把 meegle-cli 整个 mock 掉的单测在 import 阶段就炸 missing export）。
- **ask 卡片终态只有一个收口点**：`feishu-bridge/ask-card-settle.settleAskCards(taskId, askId, …)`，按 card-map 的 ask 索引（`askTaskId + askId`）反查**所有**承载卡（p2p 流式卡 + 群答题卡）一起 patch。了结这组 ask 的每条链（app 答题 / 群里打字 / 群卡点按钮 / 用户跳过）各调一次；同步占坑保证只置一次。⛔ 别再在某个入口分支里单独写 patch——那正是「从别处答完群里卡片不置态」的老根因。

**群协作行为是固定策略、不是设置项**（2026-07-28 砍掉设置页三个开关、`settings.groupCollab` 字段一并删）：单一源 `bridge-config.GROUP_COLLAB_POLICY` = `askToGroup: false` / `advanceResultToGroup: true` / `autoBroadcast: "off"`，口径是**默认不主动吵群、但别人主动在群里发起的操作一定有回应**。三条链代码全保留、只是入参写死，以后要放开改这一个常量即可。

### 受限答疑旁路（非属主群消息、与 task 运行状态机完全解耦）

`src/lib/server/restricted-question.ts`。群里**非任务所有者**的一句话只配得到一个答案，它**不是这个 task 的一次 action run**——review 里连报的三条 P0 全长在「把它当成 run」这个耦合上（停止键在答疑期间冒出来、点下去把审阅中的 action 全标 cancelled；早退路径要回滚的东西补不完；prompt 里同时出现「禁止改」和「修改要求才动手改」）。契约：

| 不碰 | 为什么 |
|---|---|
| `task.runStatus` | 一个字节都不写。停止键只看它（`isStopButtonVisible` 单一源）——不写就不会冒出来，`stopTaskAgent` 那条核弹路径（running / `awaiting_ack` 的 action 一律 cancelled + 关属主会话）也波及不到审阅中的产物 |
| `runningTasks` | 不占位 = 不进 advance / send 互斥判定，也不会被 `cancelTaskRun` 顺手带走 |
| `agentSessions` | 独立实例、答完 close，与属主活会话**并存**——交卷后会话是刻意保留的，而那正是产物刚播报进群、同事最可能回话的窗口（老实现在这里静默让位 = 群里没回音 + App 侧假「运行中」）|
| action / artifact | 只靠 prompt 约束「只答疑、不改文件、不跑有副作用的命令」——**honor-system、不是硬拦**：工具全开（Cursor 标准工具 / pi 完整 coding 工具），代码里没有 `readOnly`、没有工具白名单。唯一硬隔离的是**身份**：不传 `callerToken`（拿不到属主的 flowship 工具）。⚠ 它能读属主 OS 用户能读的一切（`config.json` 里的 PAT / apiKey / 公司环境密码、`~/.ssh` 等），**只适合只有可信同事的内部群**（见本文「第三轮复审」一节） |

- **唯一收口 `settle(ok, errorText?)`**：幂等，任何出口（成功 / 失败 / 取消 / finally 兜底）都只经它发一次 `done`——群出向据此回群 + 摘登记，漏发一次那条登记就一直挂到租约到期。
- **prompt 走 `buildReadonlyUserMessage`**：⛔ 不得复用 `buildAgentMessage({kind:"user_message"})`（它会追加一段给属主写的行为尾巴「…修改要求才动手改…」，塞进只读 prompt 当场自相矛盾）；「# 边界（硬约束）」永远排在最后一段。
- **本 run 的每条 envelope 都带 `origin`**（= 本轮回群登记 token）：与属主 run 并行时不错投的唯一依据，⛔ 别在这条链上新增「不带 origin 的 publish」。
- 唯一登记是 task-stream 的轻量旁路表，只服务三件事：终态叫停（`cancelRestrictedQuestions`——它不在 `runningTasks` 里、`cancelTaskRun` 够不着）、**群入向**串行闸（同 worktree 并排起多个只读 agent 烧额度又抢 IO）、纯 UI 帧 `restricted_run`（详情页并进 `isRunning`，否则旁路跑的工具块会被判成「已中断」）。
- ⛔ 别把这张表接回 `runStatus` / 停止键 / **app 侧** advance 准入——那就是又耦合回去了。
- 属主自己的 `startOneShotQuestion` 是**另一条通道**（V0.13.x 起能直接改小改动、用户拍板「纯答疑限制太死」）。两条彻底分家，别再合并回一个入口。

### 并发所有权与消息投递协议（2026-07-19 收敛）

> 21 轮 adversarial review（外部 AI 深审 + 生产链反例）后收敛的并发模型。核心原则：**一个 owner、一套状态迁移、状态类别不共用空值/计数器**。动这些模块前先读本节；改并发/竞态 bug 优先收敛模型、不打局部补丁（learned-conventions 有对应条目）。

| 层 | 协议 | 位置 |
|---|---|---|
| **task 操作所有权** | 统一 `TaskOpHandle`（`claimTaskOp` / `snapshotTaskOp` / `releaseTaskOpIf` / `revokeTaskOps`、owner CAS 单一判定入口）；start / send / consume / failure / stop 由 coordinator 统一收尾、禁止调用链外围补写 | `task-stream.ts` + `task-runner.ts` + `stop-task.ts` |
| **消息受理 aggregate** | claim 返回唯一 handle、route 外层 finally 只认三出口（transfer 给 queue/runner、settle terminal、release+回滚 staged 附件）；phase = accepting → persisted →（**仅 runner 在 `agent.send` resolve 后**提交）handedOff \| 失败枚举族；terminal 与 recentSettled 同一 50 条有界淘汰、淘汰后同 id = 新受理 | `chat-queue.ts` + `chat-runner.ts` + `chat-reply/route.ts` |
| **wire schema** | phase / outcome 只定义一次、client 表驱动 exhaustive decoder、未知值 fail-closed 为 unknown（绝不默认 delivered）；fingerprint 单一契约（共享 FNV） | `message-op-schema.ts` + `chat-payload-fingerprint.ts` |
| **删除证据与可见性** | deletion journal 完整 runtime schema 校验、三态读（absent / present / unknown）；TaskVisibility = readable / deleted / unavailable——410 + `task_deleted` 只来自 committed 证据、unknown → 503（不 commit 删除）；删不存在任务幂等、不建 journal | `task-fs.ts` + 各 detail/list/watch route |
| **client 消息状态** | 三个正交轴：`persistence`（气泡是否落盘、UI 占位只看它）/ `terminalKnowledge`（none \| unknown、known 直接摘 pending）/ `networkUncertain`（HTTP 响应丢失、same-id retry 依据）；可交换格 join（permutation 测试锁死）；bootstrap snapshot 无因果版本**只能单调 join**、不得清本地不确定证据；ledger 单提交入口 `dispatchChatOp(taskId, action)`（请求发起时捕获不可变 operationTaskId）、挂 globalThis 跨 HMR、带旧 shape 迁移 | `chat-pending-reconcile.ts` + `chat-op-ledger.ts` + `chat-submit-controller.ts` |
| **watch SSE 重连** | `unavailableAttempts` 与 `transientFailures` 双计数（503 不吃普通网络错 6 次预算、持续有界重试）；首个合法 bootstrap 帧 established 即清 epoch、未 established 的 200 空流 EOF 记失败预算；已 hydrate watcher 的 404 = 物理删除完成 → deleted terminal（server 已把证据 unknown 独立编码为 503、此 404 无歧义） | `use-task-watch.ts` + `task-terminal.ts` + `task-store.ts: watchTaskStream` |
| **failpoint 测试法** | 关键 await 后注入 stop / resume / advance / I/O 错验固定不变量；测试必须走真实 route/reducer 生产链、不许「预摆好状态调 helper」自证 | `failpoints.ts` + `tests/ownership-*.test.ts` |

### SDK 本地存储与会话规模治理（checkpoints 加速 / GC / 回退开关）

> 动 `sdk-agent-store.ts` / `fast-checkpoint-store.ts` / `memory-run-events.ts` / `sdk-store-gc.ts` 前先读本节、`fast-checkpoint-store.ts` 头注释（含不变式清单）和 `memory-run-events.ts` 头注释（SDK 语义对照 + 回收不变式）。

| 项 | 现状 | 位置 |
|---|---|---|
| **落盘** | `<dataRoot>/sdk-agent-store/`：agents / runs / checkpoints 三份 ndjson（躲开 `~/.cursor` SQLite WAL）；**run_events 默认不落盘、走进程内存**（见下一行）。进程级句柄只经 `getSdkStoreHandle()`（globalThis 单例）；任何碰 checkpoints 的代码（含 GC）必须经它，不得绕过去直接读写 `checkpoints.ndjson` | `sdk-agent-store.ts` |
| **checkpoints 实现** | 默认 `FastCheckpoints`：启动流式扫描建「(agentId, blobId) → 行偏移」索引，读按偏移、写 = 追加一行 + fsync；agents / runs 仍是 SDK 自带（文件很小），run_events 换成内存实现，经公开 API `composeLocalAgentStore` 组合。文件格式与 SDK 逐字节兼容（不用迁移、双向可回退）。预热失败 / `compose` 抛错自动回退 SDK 自带实现（此时尚无写入，安全） | `fast-checkpoint-store.ts` |
| **run_events 内存化**（2026-10-10） | **SDK 的 run_events 是进程内「运行时 → `run.stream()` 消费端」的传输通道，不是可有可无的历史**：本地运行时每条流式消息都 `appendRunEvent`，消费端再 `listRunEvents({afterOffset})` 读回。SDK 的 JSONL 实现每次 append / list 都整文件读入 + 逐行 `JSON.parse`，append 还整文件重写（全局串行），代价 ∝ 文件大小——线上文件 18.5MB / 35,925 条时每条 ≈ 243ms、串行上限 ≈ 4 条/秒、主线程 85–110% CPU，吐字被钉在 ≈ 5 条/秒（模型早已生成完、字还在排队往外挤）。现在换成 `MemoryRunEvents`：O(1) append、O(k) list，语义与 SDK 逐项对齐（`seq` 从 1、`offset=String(seq)`、`afterOffset` 严格大于、`limit` 缺省 100、幂等键返回已有、`delete` 空 runIds = 全删），用 10 个随机种子对真实 SDK 实现做差分测试。回收：只回收「已被读走」的前缀、且该 run 闲置 5 分钟后（幽灵 run 6 小时后），绝不丢未读；没有定时器、没有 IO。Flowship 从不读历史 run 事件（三个入口 `chat-runner` / `task-runner` / `restricted-question` 都只 `for await run.stream()` + `run.wait()`；会话恢复靠自己的 `events.jsonl`），所以不落盘安全。**旧 `run_events.ndjson` 在新版首次打开 store 时被归档**（改名进 `.quarantine/run_events-<ts>.ndjson`、留 5 份，可逆；只在 `compose` 成功之后才动）。真实 SDK A/B 见「最近演进」。 | `memory-run-events.ts` + `sdk-store-quarantine.ts` + `sdk-agent-store.ts` |
| **回退开关**（重启生效） | 整个 store 回 SDK 自带：`FLOWSHIP_SDK_STORE=sdk`，或 store 目录下建空文件 `USE_SDK_STORE`。只让 run_events 回 SDK 落盘：`FLOWSHIP_SDK_RUN_EVENTS=file`，或建空文件 `USE_SDK_RUN_EVENTS`（环境变量显式 `memory` / `file` 压过标记文件）。⚠ 回到 file 会重新带回「每条事件整文件读写」的慢——归档进 `.quarantine/` 的旧文件不会自动搬回，需要时手动拷回 | `sdk-agent-store.ts` |
| **单写者（硬约束）** | 同一数据目录同一时刻只让一个 Flowship 进程写。实测（两进程同一瞬间各写 1 条记录）：≤ 约 500KiB 的记录不丢不坏；> 512KiB 的会交错损坏（Node 的 `appendFile` 对大数据拆成多次 `write`，别的进程的追加可能插进缝里）。2026-10 实测线上 store：14434 条记录，p99 162KiB，约 0.14%（20 条）超过 512KiB、最大约 720KiB——所以窗口理论上存在，但要两个进程在毫秒级同时写才会撞上；SDK 原实现同场景 100% 丢一条（整文件重写、后写覆盖），所以并不比原来差。两个进程「轮流用」（都开着、各带旧索引）完全安全（写前先追赶外部追加）。→ `pnpm dev:web` 与 FlowshipTest 共用测试数据目录可以接受，别让它们同时大量写 | `fast-checkpoint-store.ts` 头注释不变式 1 |
| **GC** | App 启动后首次加载任务列表时后台跑（`task-fs.ts` boot recovery 末尾 `maybeGcSdkStore()`）；checkpoints ≥ 50MB 才跑，孤儿宽限 10 分钟，只留最新 1 份 `.gc-backup-*`；活名单 = `tasks/*/meta.json` 的 `sessionAgentId`。跑之前对 `run_events.ndjson` **自愈**：SDK 读到非尾行坏记录会整体抛 Corrupt（GC 因此每轮跳过）→ 流式扫描、无坏记录零写入、坏记录原文进 `.quarantine/`（留 5 份）、rename 前比对 size / mtime / ino、绝不抛。默认（run_events 内存化）下旧文件已被归档、文件不存在 = `clean`，自愈只对回退到 file 的场景有意义；GC 里 `store.runEvents.delete` 走组合后的 store，内存实现同样生效。⚠ 早先注释「run_events 在本地模式下几乎不写」是错的——本地模式每条流式消息都写（那 18.5MB 就是证据），已更正 | `sdk-store-gc.ts` |
| **会话轮换** | 按 token 累计水位自动换会话**默认关闭**（曾让长对话 AI “失忆”）；`FLOWSHIP_TOKEN_WATERMARK=1` 才开。OOM 防线 = 85% 堆拒单门（`HeapPressureError`）+ 壳 `--max-old-space-size=4096` + GC | `session-rotate.ts` |
| **chat 回合结束后的重放（只观测、不处理）** | 「首条 `usage` 即落盘 + 其后同一条流里的 thinking / 回复当重放丢弃 + 3s 未收尾给静态提示」**已整套撤掉、也没有开关**（2026-10-12 按用户决定：丢弃规则不可审计，静默误杀比重复上屏更严重）；`usage` 现在只计数（`turnEndedCount` / `turnEndedAt`），异常收尾写 `turn-wrapup.jsonl` | `sdk-message-handler.ts: usage 分支` + `chat-runner.ts: noteTurnWrapUp` + `scripts/lib/perf-report.mjs` |
| **崩溃取证** | 壳给 server 注入 `--report-on-fatalerror --report-uncaught-exception --report-directory=<userData>/data/diagnostics/node-reports`，启动时只留最近 5 份。取值含空格（macOS 的「Application Support」）必须加引号，否则 Node 只取空格前那一截、报告写不出来（用 `quoteNodeOptionValue`） | `electron-app/main.js` + `electron-app/node-options.mjs` |
| **已删除** | worker 进程隔离子系统（曾为解 OOM；已被 GC 根治、从未真机验收、与单写者约束冲突）。需要恢复：`git checkout 3c04297 -- <paths>`，或见提交 `a7874c2` / `19a914f` | — |

### 观测体系与预热

| 层 | 现状 | 位置 |
|---|---|---|
| **服务端观测** | 结构化 jsonl 落 `<dataRoot>/logs/`：`run-perf.jsonl`（每个 run 收口一条：受理 / ttft / 首个工具 / 各阶段 / MCP 探活 / store 规模 / 事件循环 / `appNap` / **吐字节奏 `cadence`**〔相邻 text / thinking delta 到达间隔的 p50 / p95 / max / >100ms / >250ms 计数，记在 `onDelta` 热路径上、不分配对象、零日志；运行时是等事件落盘才发下一条，所以这个间隔就是用户看到的吐字间隔；p50 ≈ 30–50ms 且 >100ms 占比低 = 流畅，p50 ≥ 150ms = 被存储 / 事件循环钉住〕/ **`store.runEvents`·`evMB`·`evCount`·`evTrimmed`·`runsMB`**〔run_events 实现与体积、runs.ndjson 体积：后者同样被 SDK 每次读 run 状态整文件解析，涨到数 MB 就是下一个 O(文件大小) 瓶颈〕）、`warmup.jsonl`、`loop-lag.jsonl`（事件循环慢秒）、`ui-perf.jsonl`、**`turn-wrapup.jsonl`**〔回合收尾异常：turn-ended 之后 > 3s 才收尾 / 同一 run 里 turn-ended 出现 > 1 次才写，正常回合不写；用来确认「回复完又重复回复一遍」是否还在发生，观测量是 `turnEndedCount` / `settledAfterMs`；2026-10-12 起不再丢重放，新记录没有 `replayDropped`（v1.9.29 期间的老记录里有，`perf-report` 读到才印）〕；按大小轮转、不截断；单条超大降级只留标识 | `perf-journal.ts` + `run-perf-record.ts` + `run-prep-notes.ts` + `loop-lag.ts` |
| **前端观测** | 渲染进程采集长任务 / 慢交互 / 堆 / DOM → `/api/perf/ui` → `ui-perf-ingest.ts` 清洗入库；只留耗时与规模，不含消息正文与路径（有金丝雀测试） | `ui-perf-collector.ts` + `use-ui-perf-reporter.ts` + `src/app/api/perf/ui/route.ts` |
| **看数据** | `node scripts/perf-report.mjs [--since 7d] [--task t_xxx] [--json]`（默认读本机数据目录的 logs；「十、吐字节奏」一节按 run_events 实现 / 文件体积对照；「十一、回合收尾」列 `turn-wrapup.jsonl` 的异常收尾）。判读「回车 → 开口」要把 `preSend` / `acceptMs` / `ttftMs` 三段分开看，并按 `proc.eluAvg` 分组（主线程满载时 accept 会被排队拖长，别误判成 SDK 慢） | `scripts/perf-report.mjs` + `scripts/lib/perf-report.mjs` |
| **预热** | 窗口 / 输入框聚焦 →（前端 `warmup-scheduler` 去抖 + 节流）→ `POST /api/tasks/[id]/warmup` → 后台刷新 MCP 探活缓存（stale-while-revalidate）+ 预读 store 尾部 blob。只做幂等 / 只读 / 可丢弃的事；有 run 在跑则跳过；同 task 服务端 20s 节流、全局并发 ≤ 2。MCP OAuth 续期对同一 server single-flight | `use-task-warmup.ts` + `warmup-scheduler.ts` + `task-warmup.ts` + `mcp-probe.ts` + `mcp-oauth.ts` |
| **流式代码块** | 限频高亮：上游 highlight 缓存键含 `code.length`，流式每帧整块重分词（二次方）。限频窗口内用「上次高亮结果 + 新增无色文字」，窗口到期整块补色，文字永不回退；只在流式中用，静态渲染仍用上游插件 | `throttled-code-plugin.ts` + `streaming-code-highlighter.ts` + `markdown-text.tsx` |
| **实验开关（默认关）** | 防后台节流：`FLOWSHIP_PREVENT_APP_NAP=1`，或 userData 下建空文件 `PREVENT_APP_NAP`，重启生效；`run-perf.jsonl` 的 `appNap` 字段做 A/B | `electron-app/app-nap.mjs` |

---

## 最近演进（窗口式、保留 2 个子版本）

> 写入规则：新子版本完成后在本段顶部追加、超过 2 个时把最老的迁到 `docs/CHANGELOG.md`。

### 下一版（未发布）：回车后输入框立刻按运行态画 / 受理前点停止延后到提交落地 / 撤掉回合收尾「丢重放」/「记录 Bug」6 条一并修 / 事件流 v2 视觉重构 / 第三轮反馈（条间距 · 往回滚弹回底部 · 思考吐字匀速）

> 起因：用户发「再来一下」时输入框没有马上变成停止生成的样子、还是 loading。他的猜测——「是不是把之前的发送中去掉了、输入框状态本身没处理」——基本对：v1.9.29 把「发送中…」并入准备阶段时只改了气泡和列表末尾的进度行，输入框仍绑在 HTTP 请求上。（发送键转圈本来就在，不是被去掉的；变的是气泡改成了「AI 已在处理」，两处表达自相矛盾。）

- **窗口有多长**（`<dataRoot>/logs/chat-reply-timings.log`，该任务 10/10 以来的发送）：回车 → 服务端把消息交给 SDK 受理，热路径 0.9–2.7s（发送前快照 270–717ms + `agent.send` 受理 0.96–1.8s；那次「再来一下」共 1335ms），冷路径 4.6–6.7s（另有 `resume` 1.4–3.8s）。**`runStatus=running` 在 `agent.send` 受理之后才发布**（`chat-runner.ts: sendChatMessage`），所以这段窗口里 `isRunning` 恒为假：气泡已是正式消息、列表末尾是「准备环境…」，输入框却只剩一个转圈的发送键、没有停止键，想停也停不了。
- **修复**（三个纯函数在 `chat-pending-display.ts`，接线三处）：`shouldShowComposerRunning`（`isRunning || submitting`，有待答提问时照旧不画）→ `event-stream.tsx` 的 `composerRunning`；运行态里的「排队发送」键不再转圈（`conversation-composer.tsx`，左边已有转圈 + 停止键，否则回车后仍是一副 loading）；`decideChatStop` + `settleStopIntent` → `chat-view.tsx` 的 `handleStop` 和对外的 `handleUserReply`（提交本体改名 `submitUserReply`，外面包一层兑现停止意图）。
- **⚠ 为什么受理前点停止不能直接停（必读）**：服务端热路径（会话在内存）在「发送前快照」那 270–717ms 里**没有任何占位**（`rec.runActive` 要到 `sendChatMessage` 才置真）。此刻 stop 到达：`cancelChatRun` 对空闲会话走 `closeChatSession` 把会话关掉；随后 `sendChatMessage` 发现无会话返回 `no_session`，`chat-inject` 落到「起新会话」并**重新领一个 lease**（stop 的 `cancelChatStart` 早已过去）——用户点了停止，AI 却被重新拉起、消息被重放。冷路径（`claimRun` / `startToken`）和 `agent.send` 受理期间（共享取消闭包 `cancelledDuringSend`）都有兜底，**唯独这一段没有**。以前这个窗口里没有停止键、碰不到；提前亮出停止键就等于把它暴露给用户。**这条链是读代码推断的，没有实测复现**（每一环都读过：`cancelChatRun` / `sendChatMessage` / `chat-inject` 的 `no_session` 分支 / `tryReserveChatStart`）。
- **所以客户端绕开、服务端没修**：受理前点停止只登记意图（`stopAfterSubmitRef`）并让停止键转圈（`stopping`），提交落地（`handleUserReply` 里 `submitUserReply` 返回后）再按 `settleStopIntent` 兑现；没发出去（被拒 / 状态不明）或任务已删就只收掉「停止中」、不 stop。「受理前」的判据是 `submitTokenRef.current !== null && !runActiveRef.current`（读 ref，回调保持稳定；受理后 `runStatus` 立刻发布 running，`runActive` 随之为真，此后 stop 是确定的）。AI 在跑时的排队发送也是 `runActive` 已真 → 直接停。
- **代价**：受理前点停止有延迟（热路径 ≤ 2.7s、冷路径 ≤ 6.7s，期间停止键转圈），消息会被受理、AI 回合被立刻中断——等同于「发完马上点停止」。**若以后想让受理前的停止立即生效，必须先在服务端热路径补占位（或给 stop 一个 epoch：请求入口取、返回前对比、变了就 409），否则就是「停不住」。**
- **没动**：task 模式的「跟 AI 说」条（`task-talk-composer.tsx`）同构（`busy = submitting || isRunning`、`running={isRunning}`，提交中也只转圈、没有停止键），但受理链路与竞态都不同（task-runner），这次没碰。
- **验证**：纯函数 11 个用例（`chat-pending-display.test.ts`）+ 接线契约 16 个（`chat-composer-running-contract.test.ts`：输入框接线、`after_submit` 分支不得直接停、兑现只在 `handleUserReply` 一处、行内重试也走包装、切任务清意图）。**变异验证 32 个全部被抓**，抽查 6 个确认是因对应断言失败而红、不是文件崩了。`tsc` / `eslint` 全仓干净；干净串行全量 vitest 317 个文件 / 4093 个用例通过（3 跳过），测试期间改动指纹不变。⚠ **没做 UI 实机验收**（AGENTS.md 禁止未经用户要求用截图 / 自动化）：要看效果用 `pnpm dev:web`（8676）或打包。契约只能防「被删 / 被改回去」，证明不了渲染正确。
- **测试环境备注**：一次「tsc + eslint + 全量 vitest 同时跑」的运行里，`ownership-r34-cleanup-coord` 的 R33-2① 失败一次（`removeTaskWorktrees` 被调 2 次），同一份日志里混着两份汇总（开始时间差 12s、结束顺序对不上同一进程）——像是当时有两个 vitest 同时写它。**来源没查到，也没证实那次失败是并发造成的。**该用例与本次改动无依赖（它只导入 `@/lib/server/*` 与一个 route；`chat-pending-display.ts` 只被 UI 文件引用，`src/lib/server` 里没有任何 `@/components` 引用），单独重跑 5 次全过，之后干净串行全量全绿。遇到类似失败先单独重跑、并确认没有第二个 vitest 在跑。

#### 同版：撤掉回合收尾「丢重放」整套机制（2026-10-12，只留观测、不留开关）

> 起因：用户追问「回合一结束就落盘、其后同一条流里的思考和回复当重放丢掉——会不会误杀」。会（规则只有「首条 usage 之后」一条，挡不住合法的第二轮，被丢的文字又不落盘、事后无法核对）。他的决定：先把这块去掉、继续观察，确证了问题再说，理由是「误杀一次并重放 10 次更严重」。我先做成了「默认关闭的环境变量开关」（`FLOWSHIP_CHAT_REPLAY_GUARD`），他随即说「不需要那么多开关，我不会有把这个功能再打开的需求；观测日志留着就行」——于是开关和这套机制**一起整个删掉**（代码、UI、测试都不留），只保留观测。

- **删掉了什么**（相对 v1.9.29 的三件事 + 中间做过的开关，全删）：① 首条 `usage` 一到就落盘回复；② 其后同一条流里的 thinking / 回复当重放丢弃（`dropAfterTurnEnded`）；③ turn-ended 后 3s 仍未收尾的静态提示「回复已完成，正在保存会话…」整条链路（`chat-runner` 的 `publishTurnWrapUp` 定时器、`chat-turns.ts` 的 `TURN_WRAP_UP_STATUS` 与 `ActiveStatus.settled`、`chat-stream-display.ts` 的 `isTurnWrapUpInfo` / `hasActiveTurnWrapUp`、`event-stream-hidden.ts` 的 `turnWrapUp` 闸、`active-status-line.tsx` 的 `SettledStatusLine`）；④ 开关 `chat-replay-guard.ts` 与它的测试。现在 `usage` 分支只计数，`usage` 之后到达的 thinking / 回复 / 工具调用与平时完全一样地上屏、落盘（回到 v1.9.28 及之前的行为）。
- **保留了什么（观测）**：`AssistantBufferCtx.turnEndedCount / turnEndedAt`（处理器里只计数）；`turn-wrapup.jsonl`（`turn-ended` 之后 > 3s 才收尾，或同一 run 里 `turn-ended` 出现 > 1 次才写，字段 `taskId / agentId / settledAfterMs / turnEndedCount`；正常回合不写）；main.log 一行 `[chat-runner] task=… 回合结束后 …ms SDK 才收尾（turn-ended×N）`；`perf-report` 第十一节（读到 v1.9.29 期间留下的 `replayDropped` 历史记录时才印「已拦截的重放…（v1.9.29 期间的历史记录，该机制已撤掉）」，新记录里没有这个字段、不会印出与事实相反的「没有重复上屏」）。
- **⚠ 给后来人**：不要再往 `usage` 分支里加 flush / 丢弃，也不要在 turn-ended 之后立刻 `run.cancel()`（见下方「改动 3」里的探针结论：turn-ended 先于 checkpoint 持久化，立刻 cancel 会丢该回合上下文）。`tests/sdk-message-handler.test.ts` 的「usage（= turn-ended）只计数，其后的消息照常处理」钉住了这一点（改回去会红）。
- **为什么撤（证据，部分是间接的）**：（i）规则不可审计，是最根本的原因；（ii）多出来的回合很可能是 SDK 的连接重试而不是逐字重放——11 回合那次（任务 `t_…132tb1`，10/11 11:39）最后以 `SDK ERROR：Connection failed repeatedly` 收场（1 次 + 10 次重试，对得上 SDK 里 `transportCap: 10`）；新回合在上一条 `usage` 后 6–8s 才开始新的思考 / 回复 / 工具调用，步骤 id 逐轮增长；重试是重新生成，第二遍可能比第一遍更完整（10/8–10/10 扫出的 22 个历史重复对，3-gram Jaccard 中位数约 0.28，其中 6 对第二遍带有 ≥ 6 个第一遍没有的行内代码 token）。**这是推断，没有逐例证实**；（iii）实际丢过东西：`turn-wrapup.jsonl` 的 8 条记录里有 7 个 chat run 被丢过文字，合计约 4.2 万字正文（41,568）、5.9 万个 thinking 片段（59,495），**其中多少是真重复无从核对**。
- **这套保护从来没解决「卡住 + 烧 token」**：最长的一次（`t_1791767645407_q3fu3f`「Mac空间音频支持问题」）回答 09:17 落盘、09:33 才收尾（945s，turn-ended × 7），多出来的 6 个回合约 10.3 万输出 + 112.6 万输入 token（约 108 万是缓存读取）；重放里出现过 6 次工具调用（`sw_vers` / `system_profiler` / `defaults read`，全是只读）。**重放里的工具调用是否被真执行未证实**——若是，重放里的写操作就是真副作用，比重复文字更该盯。
- **用户可见的变化**：重复回复会回来（频率参考：v1.9.29 段的历史基线约 9% 含长回复的回合；按 chat run 计，被丢过文字的占 7/48≈15%〔自 10/10 12:29 包起〕～ 7/18≈39%〔自首条记录起〕）；卡在回合收尾时没有静态提示，回复要到下一个事件 / run 结束才落盘（v1.9.28 及之前的老行为：这期间关掉 app，这条回复可能没落盘）。
- **怎么观察**：`turn-wrapup.jsonl`（`turnEndedCount > 1` = SDK 在同一条流上又跑了一轮，`settledAfterMs` = 回合结束 → 收尾）、`perf-report` 第十一节、`events.jsonl`（重复回复重新出现，数法见 v1.9.29 段）、main.log 里的「回合结束后 …ms SDK 才收尾（turn-ended×N）」。
- **待确证（下一步该查什么）**：① 回合结束后为什么连接失败——SDK 内部失败不进 main.log；我们没设 `stallDetectorConfig`，其默认 30s 的停滞判定与观察到的 6–8s 重试间隔对不上，所以触发原因没证实，需要探针或 SDK 日志；② 重试回合里的工具调用是否真执行；③ 出现重试时 UI 看到的与 AI 记忆是否分叉；④ turn-ended 之后隔几秒（不是 1–2ms）再 cancel 是否仍丢该回合上下文——只测过 1–2ms。
- **没做**：没提交 / 没发版——**已发布的 v1.9.29 里这套保护是硬开着的（没有任何开关能关），新行为要等下一版才生效**。也没做「连接失败后别重放、直接报错」之类的替代方案：先观察，确证原因再说。
- **验证**：开关版本的测试（`chat-replay-guard.test.ts` 等）随开关一起删了，现在留下的是：`sdk-message-handler.test.ts`「usage（= turn-ended）只计数，其后的消息照常处理」（含 usage 分支不 flush、其后的助手文字 / 思考不丢）、`thinking-delta-publish.test.ts`（usage 之后又来的思考照常发帧）、`perf-report.test.ts`（第十一节读历史 `replayDropped` 记录时的措辞、新记录不印「已拦截…」）；`chat-turns` / `chat-stream-display` / `event-stream-hidden` 里关于「回合收尾静态提示」的用例随那条链路一起删。**变异验证 2 个，各被对应用例抓住**：① 在 `usage` 分支里加 `flush()`；② 在助手文字分支里 `turnEndedCount ≥ 1` 就丢弃。⚠ **踩坑**：第一次把「备份」和「改坏」放进同一批并行调用，备份抓到了已被改坏的文件、后面的「还原」把坏代码原样还了回去——只是靠还原前后比哈希才发现。之后一律严格串行：备份并记哈希 → 改坏（一次一处）→ `diff` + 跑测试 → `cp` 还原 → `shasum -c` 校验。⚠ 没做运行时验收：「撤掉后真的不丢」要跑一次 chat 并制造回合收尾重放才能看到，目前没有稳定复现手段。全量结果见本版末尾「汇总验证」。

#### 同版：「记录Bug待后续修复」聊天里的 6 条 Bug 一并修（2026-10-12）

> 来源：聊天「记录Bug待后续修复」（任务 `t_1791440195961_jlcu91`；那个聊天只做了调查和记录、没改代码）。用户在撤开关的同一条消息里说「里面有我之前记录的一些 bug，你可以一起修复了」。下面按处理顺序写；**每条都带「没做 / 没验证」，别当成全部闭环**。

- **#2 会话恢复丢 GitLab Token**（2026-10-08 事故：`submit_mr` 报「没拿到 Host / Token」，设置页的 Token 一直在）
  - 根因：`buildSessionBridges` 对 Token 取**会话期不可变快照**；`resumeTaskSession` 只认入参 `creds.gitToken`，而输入条发消息触发的「恢复会话」（`task-question-inject.ts: deliverTaskQuestion`）传的凭据只有 `{ apiKey, model }`。Token 没丢在设置里，丢在这条路径没传。会话空闲 12 分钟（`SESSION_IDLE_TTL_MS`）就回收，「恢复」是高频路径，不是只有更新后才会遇到。
  - 修法：兜底放在 `resumeTaskSession`——它是所有恢复入口（输入条 / 飞书属主消息 / 飞书答题 / 自动重连）的唯一汇合点：`resolveSessionGitToken(creds)`，入参有就用，否则 `readServerGitToken()` 从 `config.json` 里只取 `gitToken` 这一个值（读文件、但只返回这一个字段，不把整份配置带进会话；读不到 / 空白一律当没有）。`deliverTaskQuestion` 顺手补传；`buildSessionBridges` 把「没拿到 Host / Token」拆成两条（原来一句话混着说、用户以为是设置有问题）。
  - 注意：快照仍是会话期不可变——设置里改了 Token，要到会话重建 / 恢复才生效。
  - 验证：`tests/resume-session-git-token.test.ts` 15 个；变异 4 个全被抓（`resumeTaskSession` 改回只认入参 / `deliverTaskQuestion` 不传 / 报错拆分合回去 / 兜底函数无视入参）。**没做**：没有真跑「会话被回收 → 输入条发消息 → `submit_mr`」的端到端（要真 GitLab）。
- **#6 问答卡选项里的长串撑破按钮、事件流出现横向滚动条**
  - 根因（Bug 记录里那次调查用 headless Chrome 做过最小复现）：选项按钮是 flex、文字 `<span>` 是 flex 子项，默认 `min-width:auto`，一整串不可断的字段名 / 路径 / URL 把它撑得比按钮还宽，`wrap-break-word` 救不了。
  - 修法：`ask-user-inline.tsx` 选项文字加 `min-w-0`。**没有**给事件流容器加 `overflow-x-hidden`——那会把溢出的内容静默裁掉。
- **#1 推进弹窗批次卡片溢出**（「全选」和 #N 徽标被挤出弹窗）
  - 根因（**读代码推断，没复现**）：批次区三层 `grid` 只写了 `gap`、没写列模板，隐式列是 `auto`，被 nowrap 的长标题撑到比弹窗内容区还宽，`truncate` 永远截不到。
  - 修法（`advance-dialog.tsx`）：三层 `grid` 都补 `grid-cols-1`（= `minmax(0,1fr)`）；批次卡片（每一批的可点选项）加 `min-w-0`；说明行加 `max-w-full`（列方向 flex 在 `items-start` 下子项宽度是 fit-content，`min-w-0` 管不到横向）；标题加 `title` 悬停看全文。
  - 验证：`tests/layout-overflow-contract.test.ts` 4 个（#1 / #6 共用，**只断言关键 className 还在**——vitest 没有布局引擎，证明不了「真的不溢出」）；变异 3 个全被抓。⚠ **#1 / #6 的修法都没有界面级验证**（AGENTS.md 禁止未经用户要求用截图 / 自动化）：要看效果用 `pnpm dev:web` 打开推进弹窗 / 带长选项的问答卡。
- **#3 Sonnet 5.5「回答完不结束 / 重复回答 / 报错」**（只做了「看得懂 + 不自动重连 + 留下原因」，**没有消除重复本身**）
  - 机制（读 `@cursor/sdk` 1.0.37 源码确认）：SDK 内部有一层自动续接——连接异常时不报错，而是从最近的检查点重发（检查点之后的内容会重新生成，用户看到的就是又一遍回答）；连续 2 次续接「有流数据、却没产生检查点」就抛 `Agent turn stopped after repeated resume attempts made no progress`（SDK 日志原文 `Resume attempts are streaming but not producing checkpoints; stopping automatic resume`）。另一句 `Connection failed repeatedly` 是传输层连续失败后的放弃。**为什么会反复断线（服务端 / 网络 / 停滞检测）仍没证实。**
  - 做了（`sdk-error.ts`）：① `SDK_GIVE_UP_RULES` 两条规则 → 一句看得懂的话（只陈述报错本身的意思、不断言「为什么」），原始诊断照旧进 `meta.detail`（错误卡可展开）。② `isRetryableRunError` 对这两类**显式判否**（即使同时带网络类关键字也不自动重连——SDK 自己已经重试 / 续接了很多次，我们再来一轮多半只是再重放一遍、再烧一遍 token）。③ `buildRunNotFinishedError` 把 SDK 的 `result.error` 作 `cause`，`chat-runner` / `task-runner` 两处 throw 改用它，`main.log` 里不再只有被截断 1500 字的 dump。
  - **真正的杠杆没动**：`LocalAgentOptions.enableAgentRetries`（SDK 注释：「Enable transport and stall auto-retry for local agent runs. Defaults to true for headless embedders; set false to surface transport errors on the first failure」）。设成 false = 首次传输错误就直接报出来：不会有续接重放，但网络抖一下整轮就失败。这是产品取舍，没替用户决定；想试就试这个。
  - **刻意没做**：在界面上给重复回答加标记 / 自动取消重复——和刚撤掉的「丢重放」一样，没有证据证明哪一遍才是重复之前，不该替用户判断。
  - 验证：`tests/sdk-error.test.ts` 29 个（含规则表自检：文案里不得出现未证实的断言用词）；变异 4 个全被抓（去掉判否 / 去掉 `summarizeRunFailure` 的早退 / `chat-runner` 改回裸 `new Error` / 始终挂 `cause`）。**没做**：没复现过这两句报错、没跑过真实的 SDK 放弃场景。
- **#4 agent shell 继承正式数据目录 → 跑测试误动正式数据**（2026-10-09 事故）
  - 机制：Cursor provider 的 agent shell 由 SDK 自己 spawn、环境原样继承 server（SDK 1.0.37 没有给本地 agent 的 env 选项；只有 pi provider 的 shell 工具走了 `stripHostInjectedEnv`）。于是 agent 在仓库里跑 vitest 时带着 `FLOWSHIP_DATA_DIR=<正式数据目录>`；`task-fs` 在**模块加载时**钉死 `DATA_DIR`，任何没自己改 env 的测试一 import `task-fs`、调任一 API，就触发惰性的 boot-recovery——把正式数据里 running 的聊天标成「已中断」、清 worktree、杀预览进程、GC SDK store。
  - 修（两层，**修的是测试进程、不是 agent shell**）：① vitest `setupFiles: tests/setup/hermetic-env.ts`：每个测试文件 import 之前剔除宿主注入变量（`HOST_INJECTED_ENV_KEYS`）、把 `FLOWSHIP_DATA_DIR` 指到全新的临时目录；每个测试前 `assertEnvNotAppData`（指向桌面包数据目录就抛错）；`afterAll` 清理。② `task-fs.ts: ensureBootRecovery` 的运行时防线：`VITEST` 下数据目录若是桌面包 userData（`app-data-dir.ts: isAppUserDataPath`）就拒绝执行并打 warn。判定认「`<appData>` + `fe-ai-flow[-test]`」两段——只认后缀的话，仓库被克隆成名叫 `fe-ai-flow` 的目录时，缺省回落的 `cwd/data` 会被误当用户数据。
  - 复现与分层验证：同时去掉两层，在造出来的「正式数据目录」里复现了事故（running 的聊天变 `error`、追加 `[boot-recovery]` 事件）；只去掉第一层、保留第二层，聊天状态不变——第二层单独就能兜住。变异 6 个全被抓。附带：缺省回落的 `cwd/data` 同样被指到临时目录，测试不再往仓库的 `data/` 写。
  - **刻意没做**：不去清理 agent shell 的环境（SDK 没有入口；`AGENTS.md` 已更正——原来写的「shell 工具已统一清洗」只对 pi provider 成立，Cursor 会话里要自己 `env -u …`）；不做只在入口识别的恢复锁 / liveness 锁（改动面和误伤风险都比测试隔离大）。
  - 测试：`app-data-dir` 11；`hermetic-vitest-env` 12（含一条端到端：`spawnSync` 起一个嵌套的 vitest 子进程，带着假的「正式」环境去跑 `hermetic-probe`，再检查假的正式数据没被动过）；`hermetic-probe` 2（事故现场形状的探针，平时就是两条普通的隔离断言，别改名、那边按文件名拉它）；`boot-recovery-test-guard` 3。
- **#5 事件流长时间只显示「处理中…」，看不出在做什么**（Bug 记录里的 P0，纯前端；P1 / P2 没做）
  - 记录给的数据（213 个 chat、4.2 万条事件）：「工具全跑完 → 下一个事件」空窗 12,239 次、中位 7s、P90 25s、≥60s 263 次、最长 692s；≥20s 的「工具后 → 下一个工具」空窗里有 20% 的下一个工具是 `read`，不可能是参数生成慢——所以**文案只说「在分析上一个工具的结果」，不断言更细的阶段**（推理 / 排队 / SDK 重试从这里分不出来）。
  - 做了：① **去重复**：`shouldShowProcessingPlaceholder` 新增 `statusLineVisible`（chat、没隐藏输入区、有状态文案 = 输入框上方的状态行这一帧真的会画），工作过程组尾的「处理中…」让位；task 形态没有状态行，仍由组尾兜底。② **点名**：工具跑完等模型 →「正在分析 {上一个工具} 的结果」（工具名超 28 字截断）；有 `tool_call` 还没配上结果（并行工具）时说不清是哪个，退回「处理中…」、不乱点名。③ **计时**：`ActiveStatus.sinceTs`（工具执行中 / 子代理 / 工具跑完等模型三类）→ `ActiveStatusLine` 等够 3s 显示「· 12s」/「· 2m14s」并逐秒走字（`formatStatusElapsed` 在 `chat-turns.ts`，口径同工作过程组头）；等模型的起点是 `tool_result` 落盘时刻，不把工具自己的耗时算进空等。没有 `sinceTs` 的状态不起定时器。
  - 顺带改了一处内部判定：实时思考盖「空等」文案，以前按 label 文案集合（`IDLE_WAIT_LABELS`）判等；文案现在带工具名、不再是固定集合，改成显式的 `idle` 标记（工具在跑 / 子代理 / 压缩 / 已落盘的思考仍不会被盖）。
  - **与 Bug 记录不同的地方**：记录要求「正在启动…也带秒数」——**没加**。列表里的 `PendingRow` 已经在计「已等待 Ns」（v1.9.29），再加就是两个秒数并排；记录写的时候还是 v1.9.28 的 UI。另外状态行的「正在启动…」和列表里的「准备环境… / 等待模型响应…」本身也算一种重复，记录没点名、这次没动〔2026-10-12 后续已处理：状态行在列表尾确有进度行时让位，见下方「同版：事件流思考体验重构」〕。
  - **没做**：P1（消费 `thinking-delta` / `partial-tool-call` / `token-delta`、thinking 耗时写进事件）、P2（卡住 / 续接 / 压缩的诚实提示，依赖 #3 的检测）。「token 停涨超过 30s 提示无输出」这类说法没有 `token-delta` 数据支撑，没写进文案。
  - 验证（数字是当时的；之后随「事件流思考体验重构」有增补——`thinking-live` 现 45、`status-line-contract` 现 11）：纯函数在 `chat-turns.test.ts`（39 个）/ `thinking-live.test.ts`（27 个）；接线契约 `tests/status-line-contract.test.ts` 8 个（`statusLineVisible` 与渲染条件同口径并传给判定；走字定时器只在有 `sinceTs` 时起、换起点重启、卸载清理）。**变异 10 个全被抓**。⚠ **没做界面实测**：走字、3s 门槛、组尾让位的实际观感没看过；秒数 = 浏览器 `Date.now()` − 事件 ts（服务端时钟），桌面端同一台机器、无偏差。
- **旁注 `NODE_OPTIONS` 的 `--report-directory` 路径含空格被截断**：**v1.9.29 已修**（`electron-app/node-options.mjs: quoteNodeOptionValue`，见下方 v1.9.29 段「同批其他改动」），这次只复核：`tests/node-options-quote.test.ts` 14 个通过，并用真 Node 读回（带引号的含空格路径 → `process.report.directory` 是完整路径）。无改动。
- **汇总验证**：`tsc` 0 错误；`eslint` 在全部改动 / 新增的 TS 文件（37 个）上干净（`scripts/**` 在 eslint 配置里被忽略）；**干净串行全量 vitest：324 个文件通过（另 1 个跳过）/ 4166 个用例通过（3 跳过）**，运行期间改动文件的哈希不变。变异验证合计 29 个（撤丢重放 2 + #4 6 + #2 4 + #6/#1 3 + #3 4 + #5 10），全部被抓，每次还原后 `shasum -c` 核对。全部**未提交 / 未发版 / 未打包**。⚠ 以上全是单元 / 契约测试，**没有任何一条做过界面或端到端实测**。

#### 同版：事件流思考体验重构——吐字「机械」+ 上下重复（用户反馈，2026-10-12）

> 起因：用户说正文吐字已经丝滑、动画也好看，但**思考吐字很机械**；截图里同一段思考原文同时出现在两处——工作过程组里思考行的折叠摘要，和输入框上方状态行的「思考中 …」，问「上下都展示是不是有点重复」；并希望「把整个事件流的 UI 都重构下，让它更丝滑、更舒服」。上一轮在动手前被中断，这次从头做。

- **「机械」的根因**（读代码 + 模拟，不是猜）：思考一路上都没有平滑层。服务端每 250ms 一帧（首帧立即、合并不丢字，v1.9.29 的设计）；前端到一帧就整段替换文本；折叠摘要又取「最后一行的行尾 80 字」——每多一个字，整行向左滑一格，眼睛没法跟读。用模拟量化（250ms 一批、60fps 逐帧采样、变化量的变异系数 CV 越小越匀）：**旧做法最长停顿 283ms、93% 的帧没有任何变化、CV 3.84（一阵一阵）**。
- **「重复」的根因**：同一行最新原文被画在**三处**——思考行的折叠摘要、状态行的 `detail`、工作过程组被手动折叠时的组头。
- **平滑层**〔**2026-10-12 第二轮已重写成「按到达速率匀速放字」，现行算法与数据见下方「同版：用户第三轮反馈」③；下面是第一版（τ = 300ms 指数追赶）的原始记录，保留是为了说明当时为什么这么做、后来为什么不够**〕（`src/lib/smooth-reveal.ts` 纯函数 + `src/components/tasks/use-smooth-thinking.ts` hook）：jitter-buffer 式追赶——每帧 `pos += remaining × (1 − e^(−dt/τ))`，τ = 300ms（略大于 250ms 的帧间隔，让两批之间不见底），保底 15 字/秒，`dt` 钳到 100ms（切后台回来不一口气跳），位置用浮点、显示取 `floor`，代理对安全。**刻意不做「积压越大放得越快」**——试过，大块到达时会一口气喷出来、又回到机械。模拟（同上口径）：到达 160 字/秒 → 最长停顿 0ms / 空帧 0% / CV 0.31，代价是显示滞后到达约 31 字（≈ 0.2s）；80 字/秒 17ms / 1% / 0.38；40 字/秒 33ms / 31% / 0.68；20 字/秒 50ms / 65% / 1.37（该速率下每 50ms 才来一个字，已是理论极限）。**不碰** `useSmoothStreaming`（正文，用户说很丝滑；有契约测试钉住）。
- **累计坐标**（`thinking-live.ts: LiveThinking.total` / `liveThinkingOffset` / `stepLiveReveal` / `revealLiveThinking`）：`total` = 本段累计到达字数，`offset = total − text.length` = 被 `THINKING_TEXT_MAX`（2 万）截掉的头部。平滑位置用累计坐标，截断不会让进度错位；窗口起点超过位置（后台标签页 rAF 暂停、帧积压）时 `seek` 到窗口起点，不会显示成空白。
- **展示**：进行中的思考行**默认展开**，展开区是 `LiveThinkingTail`（`event-stream/live-thinking-tail.tsx`）——固定高度（`max-h-28` ≈ 5 行）的尾部窗口，内容贴底，**多出一行才平滑上滚、同一行内逐字追加不动**（`ResizeObserver` 盯内容高度，不用每帧写 `scrollTop`；偏好「减少动态效果」的用户一律瞬移）〔第二轮改成按光标位置连续平移（`translateY`），不再「多一行整行一跳」，见下方 ③〕，溢出时顶部渐隐、末尾脉冲光标。**不再有折叠摘要**。折叠状态是纯函数：`manualCollapsed ?? autoEventCollapsed(isLive, initialCollapsed)`（进行中 → 展开；否则取首次渲染时锁定的默认值），`toggleEventCollapsed` 切换；落盘后同一个 React 节点（id 相同）自动回到默认折叠（带一行摘要），用户手动点过的一律尊重。
- **去重复的原则**：同一信息只在一处说——状态行 = 瞬时全局状态（「思考中 · 12s」，计时走已有的 `sinceTs`，**不带原文**），工作过程组 = 内容（组头折叠时也不再摘原文）。状态行与列表尾的重复也一并处理：`ActiveStatus.yieldToTail`（仅「正在启动…」）+ `tailHasProgressRow`（列表尾确有 `__loading__` / `__boot_stage__` 进度行）→ 状态行让位；输入框上方预留 `h-7` 槽位（与 `ActiveStatusLine` 同高），状态行出现 / 消失不再把输入框顶得跳。
- **顺带修了一处老缺陷**：正文流式输出期间（`assistant_message` 还没落盘），状态行会说「正在启动…」或「思考中 · 最后一行」；现在 `streaming` 时说「正在回复…」（`deriveActiveStatus` 新增 `streaming` 选项）。
- **每帧开销（取舍，没实测）**：思考期间前端的 `setState` 从「≤ 4 次/s（跟着服务端帧）」变成「rAF 每帧最多一次，且只在显示字数变化时」（≤ 60 次/s）。`useSmoothThinking` 的 state 在 `ChatView` 里，所以思考期间 `ChatView` 每帧重渲染一次——**与正文打字机（`useSmoothStreaming`，同样在 `ChatView`、rAF 每帧）是同一条路径、同一量级**；设计上前面的行靠 memo 不重渲染，每帧只重算第三层（`attachLiveThinking`）。**没用 Profiler 实测过**。若以后觉得思考期间 `ChatView` 重渲染太重，下一步是把平滑 state 下沉到只订阅思考的子组件 / `useSyncExternalStore`，让 `ChatView` 不跟着每帧渲染。
- **刻意没做**：整体视觉（颜色 / 间距 / 圆角）没动——这次只动思考这一块的节奏、重复和跳动，没有做「整个事件流的视觉语言统一」（那需要先拍板方向；〔2026-10-12 后续：用户拍板「按最佳实践来、task 和 chat 一致」，已在下一小节「事件流 v2」做了〕）；状态行 / 标签的淡入淡出、高度动画（Virtuoso 要测量高度，动画会让它频繁重算）；服务端节流（`THINKING_DELTA_INTERVAL_MS` 250ms 降到 ~100ms 收益不大、改动面在服务端）。
- **验证**〔以下是第一版的数字；第二轮 `smooth-reveal` 已是 52 个用例、变异 38/38，见下方 ③ 与验证小结〕：8 个测试文件——`smooth-reveal` 31（算法）、`thinking-live` 45、`thinking-reveal-integration` 9（模拟时钟，含后台标签页积压、截断后位置不错位）、`thinking-smooth-ui-contract` 19、`chat-turns-live-thinking` 29（含折叠状态真值表与时间线）、`thinking-delta-wiring-contract` 28、`status-line-contract` 11、`chat-turns` 39。**变异验证 40 个：39 个被抓，1 个（`done: pos >= target`）是等价变异**——位置恒为有限值，改了行为不变，没有硬凑测试，只改正了注释里不准确的说法。**其中两个最初只被「对照测试」抓住**（去掉 seek、切片不带 offset），不是被正式断言抓住，已补强集成用例（偏移 > 总量 40%，且逐帧 `cum(f) === f.len`）。⚠ **踩坑**：第一轮 UI 变异脚本有 bug（zsh 不拆分未加引号的变量 → vitest 找不到文件，11 个都报「没被抓住」），修了脚本并加了「无效结果」检测后重跑才可信。`tsc` 0 错误；`eslint` 在全部改动 / 新增文件上干净；**全量 vitest 328 个文件 / 4258 个用例通过（3 跳过），0 失败**。
- **一次性冒烟（没留在仓库，项目约定不测 UI）**：① `react-dom/server` 服务端渲染真实 `EventRow`：进行中行 = 箭头已旋转（展开）+ 转圈标题 + **没有折叠摘要** + 尾部窗口 + 光标；落盘行 = 箭头未旋转 + 一行摘要 + 无展开内容。② 用项目真实 `globals.css` 经 `@tailwindcss/postcss` 编译：`LiveThinkingTail` 的 17 个类全部生成了 CSS（含 `[mask-image:…]` 任意值、`wrap-break-word`），本次改动新增行里 40 个疑似类名缺失 0 个（反向对照确认检查器分得出错类名）。这两项证明结构与样式能编译出来，**不证明视觉**。
- ⚠ **没做 UI 实机验收**（AGENTS.md 禁止未经用户要求用截图 / 自动化操作 App）：吐字的**手感**、贴底滚动、顶部渐隐、`h-7` 槽位的实际观感都没看过。用 `pnpm dev:web`（8676），发一条会长时间思考的消息看。
- **已知限制 / 给后来人**：① 进行中只显示尾部约 5 行，完整原文落盘后在思考行里看；② 落盘瞬间展开区立刻收起（设计如此；想「保持展开」只改 `autoEventCollapsed` 一处）；③ `SuspectStuckHint` 不把实时思考帧当作活动（5 分钟阈值），超长思考时可能误提示——**这次没碰**；④ 正文与思考现在是两套追赶算法（`useSmoothStreaming` / `smooth-reveal`），将来可统一，这次没动正文；⑤ `max-h-28` = 112px ≈ 5.7 行（`text-xs` + `leading-relaxed` 行高 19.5px），顶部那半行靠渐隐遮住——换字号 / 行高要一起看。
- **没做**：没提交 / 没发版 / 没打包。

#### 同版：事件流 v2——整个时间流的视觉 / 交互重构，task 与 chat 一致（用户拍板，2026-10-12）

> 起因：上一小节「刻意没做」留了一条——整体视觉（颜色 / 间距 / 圆角）没动，因为「整个事件流的视觉语言统一」得先拍板方向。用户随后拍板：「整个时间流重构，按你觉得的最佳实践来吧，包括交互和色系」+「task 和 chat 我觉得是可以一直保持一致的」，并明确允许「自己开个浏览器看 web、但不要开客户端」（覆盖了 AGENTS.md「不要主动开 / 查看 App」那条）。所以这次**先量化、再改**：隔离数据目录起一个 `next dev`（8676）、puppeteer 驱动系统 Chrome 读 computed style + 截图（工具和数据都在仓库外、用完已删），桌面客户端一次没开。

- **实测出来的问题**（不是观感）：① 过程层文字叠 alpha——旧「工作过程」行 `text-muted-foreground/70` 浅色只有 **3.28:1**（WCAG AA 要 4.5:1），`/60` 2.68、`/50` 2.21、`/80` 4.07；深色 `/70` 4.21、`/50` 2.71；② 用户气泡 `bg-muted/40` 对页面底只有 **1.03:1（浅）/ 1.08:1（深）**，全靠 1px 边框撑；③ AI 正文被 `@tailwindcss/typography` 默认 gray 色板染成蓝灰 `rgb(54,65,83)`，站内 `--foreground` 是 `rgb(21,23,27)`；④ sticky「本轮提问」条是 `bg-background/75 + backdrop-blur`，叠在正文第一行上、两行字糊在一起；⑤ 错误卡一律整卡粉红——历史错误和当前要处理的一样重，一屏全是红块；⑥ task(log) 的 AI 回复 / 用户消息是带边框 + 图标 + chevron 的整张卡，同一条消息在 chat 和 task 里长得完全两样；⑦ 同屏 3–4 处在动（组头 spinner、成员 spinner、状态行脉冲点 + shimmer），shimmer 的 keyframes 还是组件里内联 `<style>`、`prefers-reduced-motion` 管不到；⑧ hover 才显的时间戳 / 编辑删除键盘聚焦不到，原生 `title`、emoji ⚠️、`bg-blue-500` 硬编码各一处；⑨ `CollapseChevron` 在三个文件各一份、行按钮类名三份近似拷贝。
- **设计规则**（已写进 `.cursor/rules/ui-conventions.mdc` 文末「事件流 v2」，每条有契约测试拦）：文字层级不叠 alpha（更弱 = 11px 档 + 位置）；颜色只落在图标 / 点 / 细条上、全走语义 token；数据块用白卡 `bg-card border-border`、浮层必须实心；当前强、历史弱；动效同屏一处 + reduced-motion 全停；折叠控件 `aria-expanded`、hover 才显的东西同时挂 `focus-within`。
- **做了什么**：
  - 新 `event-stream/stream-style.tsx`（`CollapseChevron` / `PROCESS_ROW_BUTTON` / `PROCESS_BODY_RAIL`）：过程层所有折叠行共用，rows / tool-block / work-group 三处的重复拷贝删掉。
  - 过程层（`work-group` / `rows: ProcessEventRow` / `tool-block`）：文字一律 `text-muted-foreground`（浅 **6.48:1** / 深 7.48:1）；hover 走 `bg-accent`（旧 `bg-muted/40` 只有 1.03:1 的底色差，几乎看不出 hover 反馈）；数据块（命令 / 输出 / diff）白卡；组头 spinner 只在折叠时转（展开后成员自己在转）；警告标 = `TriangleAlert` + `Tooltip`；重连 / 压缩行翻篇后整行转中性灰，不再 warning 色叠 `opacity-60`。
  - 对话层：用户气泡 `bg-secondary` 无边框（对页面底 **1.12:1 浅 / 1.27:1 深**）；排队气泡用「空心虚线框」表达未落定，不再整个压 `opacity-70`，编辑 / 删除键盘可达、`Tooltip` 取代原生 `title`；`.prose` 的 `--tw-prose-*` 全部映射到 `--foreground / --muted-foreground / --border`（AI 正文 `rgb(54,65,83)` → `rgb(21,23,27)`；invert 变量指向同一组 token，`dark:prose-invert` 切换后不会被覆盖回 gray-300）。
  - 回合节奏：〔**数值已在第三轮反馈后调整、并抽成纯函数 `lib/event-stream-rhythm`，现行数值见下方「同版：用户第三轮反馈」①**；当时的值：对话之间 `pt-6`、紧跟对话的过程行 `pt-2`、连续过程行 `pt-0.5`；log 的对话 `pt-4`〕「AI 说了一句 + 它接着干的活」靠邻近性读成一组。sticky 条实心 + 完整边 + `shadow-sm` + 「本轮提问」标签；分隔胶囊去 alpha。
  - 错误卡 / 提问卡分级：错误卡「当轮」（没在跑 + 最近一条）整卡 destructive 描边 + 淡底 + 重试，历史只留左侧 3px destructive 线 + 白卡底；提问卡未答保留 brand 强视觉，已答 = 白卡 + success 左线（Q&A 块内陷一档），已失效 / 已跳过 = 白卡。
  - 动效：状态点静态 `bg-info`、整行只剩 label 的 shimmer（keyframes 迁进 `globals.css`、删掉内联 `<style>`）；`@media (prefers-reduced-motion: reduce)` 里 `.animate-pulse` / `.status-shimmer` 全停（shimmer 回纯色，否则停在渐变某一帧、左浅右深）；输入栏 / 等待行 / 启动阶段行的 spinner 统一 `text-info`（running = info）。
  - **task(log) 与 chat 一致**：AI 回复 / 用户消息两种对话类事件在 `EventRowImpl` 共用同一段渲染（`variant === "chat" || isAssistant || isUser`），log 只多一行元信息（action 归属标 + 时间；AI 回复那一行同时是折叠头）；流式行同款平铺。里程碑 ack / 答题回执 / 行动指引 notice 仍是卡（那是回执、不是对话）。task 的「跟 AI 说」条本来就是同一个 `ConversationComposer`。
- **⚠ 解除了一条旧约束、改写了一条旧规则**：`docs/CHAT-REDESIGN.md` 写着「task(log) 形态零改动」「不动 task 模式事件流」——按用户「task 和 chat 保持一致」解除，两处已划掉并注明。`ui-conventions.mdc` 字号阶梯一节原有一句「需要比 11 更弱用透明度（`text-muted-foreground/70`）」，与上面的实测相反，已改写废止。
- **改了两条老契约断言**（`tests/event-stream-message-ui-contract.test.ts`，意图保留、结构变了）：「三处消息块都用公共件」`<MessageActionBar` ≥3 → ≥2（并新增 `isAssistant && <MessageActionBar` 不得再出现）；「chat / log 共用同一份 assistantActions」`actions={assistantActions}` ≥2 → 恰好 1（并断言共用分支入口 `variant === "chat" || isAssistant || isUser`）。原因：log 的 AI 回复并入 chat 的共用分支后，原来两处 JSX 变成一处，覆盖的场景没少。
- **验证**：`tsc` 0 错误；`eslint` 在 10 个改动 / 新增文件上干净；**干净串行全量 vitest：328 个文件通过（另 1 个跳过）/ 4292 个用例通过（3 跳过），0 失败**（上一小节 4258 → +34，全是新契约）。新增 `tests/event-stream-v2-contract.test.ts` 34 个（共享样式单一来源 / 文字不叠 alpha 与无裸色号 / 动效与 reduced-motion / task·chat 对话外观统一 / 浮层实心 / 错误卡·提问卡分级 / 键盘读屏可达 / prose 取色）。**变异验证 6 个全被抓**（用户气泡改回 `bg-muted/40 + border` / diff 分隔符文字叠 alpha / reduced-motion 块去掉 `.animate-pulse` / 错误卡重试不再限定当轮 / sticky 条改回半透明 + 毛玻璃 / 去掉一个 `aria-expanded`），每个都只红对应那一条，还原后逐字节 `cmp` 一致。
- **浏览器里看过的**（web 版；隔离数据目录里的 3 个样本：当前 chat + 两个 task；浅 / 深色；1440 / 1100 / 820 / 640 宽）：chat 与 task 的整体观感、用户气泡、AI 回复、折叠 / 展开的工作过程与工具行、回执卡、当轮错误卡（历史错误卡在中途单独看过）、已答 / 已跳过的提问卡；所有视口无横向溢出。**交互**：hover 底色（computed 值 = `--accent`）、键盘 Tab 聚焦的焦点环（`:focus-visible` 为真）、Enter 展开、聚焦时时间戳显形（150ms 过渡后 opacity 1，焦点离开回 0）；`prefers-reduced-motion` 切换前后 `status-shimmer` / `animate-pulse` 的 `animation-name` 从有变 `none`。
- **没验证 / 没做**：⚠ ① 「运行中」的真实观感——没有跑 agent（没密钥、也不该烧 token），状态行 shimmer、组头 spinner、流式行的「AI 回复中…」小标、`BootStageRow` / `PendingRow` 的 info spinner 只有类型 + 契约保证；② 未答的 brand 提问卡和排队气泡——样本数据里没有，也没造；③ 性能没 profile（这次基本只动类名，新增的 JS 只有 `isCurrent` 一处判定，`canRetry` 原本就在扫）；④ 动画的**手感**（hover 过渡、chevron 旋转）静态截图看不出来，要自己 `pnpm dev:web`（8676）摸一下；⑤ 契约测试只能防「被改回去」，证明不了渲染正确。
- **顺带发现、当时没动**（①②③ 已在同日后续处理，见下一小节）：① `.prose-sm` 让 AI 正文实际是 **14px / 24px**，而 `ui-conventions.mdc` 写的对话正文是 `text-[15px] leading-7`（外层类名在 `.prose-sm` 里不生效）；`globals.css` 2026-07-20 的注释又把 0.875rem 当「聊天正文」，两处说法冲突——**要不要对齐到 15px 待拍板**（会影响整个正文密度）；② 640px 宽时输入框底部工具栏（模型名与右侧图标）会重叠——既有布局问题，不是这次引入的；③ `.prose` 变量映射是全局的，产物栏 / 文档面的正文颜色也随之统一到 `--foreground`（预期内的好处，但影响面比事件流大）；④ `ErrorCard` 故意没加 `role="alert"`：事件流是虚拟列表，卡片每次滚进视口都会重新挂载，live region 会反复播报；⑤ task / chat 输入栏的功能差异（排队、provider picker、停止键行为）没动（上一小节已记）。
- **没做**：没提交 / 没发版 / 没打包；v1.9.30 要不要发的问题仍待用户定。

#### 同版：事件流 v2 的三个遗留项——正文字号 / `.prose` 全局影响 / 窄屏重叠（用户授权「按最佳实践来、不用确认」，2026-10-12）

> 起因：上一小节「顺带发现、没动」留了三条要用户拍板的事；用户把本地包替换后回复「正文字号、全局影响、窄屏重叠…都按照你的最佳实践来就行，不用和我确认」。这次同样先量化再改：隔离数据目录起 `next dev`（8676）+ puppeteer-core 驱动系统 Chrome headless，只开 web、没开客户端；样本 = 当前 chat 的副本 + 一条我注入的「Markdown 元素全覆盖」回复（只写在 `/tmp`，用完已删）；浅 / 深色；窗口宽度 1440 → 375。

- **正文字号：落实 15px（不是改规则去迁就 bug）。**
  - 依据：15px 不是随手写的——2026-07-21 `adf94f3`（用户本人的提交）的说明就是「正文全宽平铺、字号 15px / leading-7」，07-28 又写进字号阶梯。两处都是明确的设计，漂移的是实现。
  - 根因：外层 wrapper 写了 `text-[15px] leading-7`，但 `.prose-sm` 在 prose 元素**自己**身上设了 `font-size:.875rem; line-height:1.714`，把外层盖掉——实测一直是 **14px / 24px**，三个月没人发现。
  - 做法：`MarkdownText` 新增 `size?: "default" | "reply"`（缺省不变）；`reply` 给 prose 元素加常量 `MARKDOWN_REPLY_TEXT`（`text-[15px] leading-7`）。AI 回复三处（chat 流式占位 / log 流式占位 / 定稿气泡）传 `size="reply"`，外层 wrapper 改引用同一常量；问答卡 / 群问答 / 工具产出不动。
  - **连带校准**（不校准会引入阶梯外字号）：行内 code 在 `.prose-sm` 里是 `.857em`，基准抬到 15px 后成 **12.86px**；路径 code `text-[0.85em]` 成 **12.75px**（规则明令禁止 12.8px）。reply 档下两者钉 `text-xs`（12px），default 档保持原样。
  - 实测（浅 / 深一致）：正文 / 列表 / 引用 / 链接 **15px / 28px**；行内 code 12px；路径 code 12px；标题 h2 24px / h3 20px（Streamdown 绝对字号，没变）；表格 th / td 14px（显式字号，没变）。一条含标题 / 表格 / 代码块的样例回复整体高度 **895px → 1003px（+12%，其中一部分来自下一条的代码块变大）**。
- **顺手揪出同根的第二个缺陷：代码块文字实际是 10.29px。** `.prose-sm` 对 `pre`、`code` 各乘一次 `.857em`，`code-block-body` 上写的 `font-size:.875rem`（2026-07-20「字号与聊天正文一致」的拍板）只管到容器，里面的文字是 14 → 12 → **10.29px**——违反「不许 10px」，也没兑现那次拍板。`globals.css` 里让 `pre / code` 显式 `font-size: inherit`，容器字号走 `--prose-code-size`（默认 `0.875rem`）；工具块产出（12px 档）设 `[--prose-code-size:0.75rem]`，不比周围正文还大。实测代码块文字 **10.29px → 14px / 21px**（对话与文件预览都是）；`--prose-code-size` 机制用「给容器加类」的方式量过 14px → 12px。
- **全局影响：量过、没发现要回退的。** `.prose` 的取色映射与代码块字号同时落到对话事件流 / 产物栏 / 本地文件预览 / 修订视图。在文件预览（真实 `docs/HANDOFF.md`：9 个表格、5 个代码块，浅 / 深色）里量：正文仍 14px / 24px、取色是站内中性灰 token（浅色 `--foreground` 一档，不再是蓝灰）、标题 / 表格 / 引用 / 代码块都正常。**发现但没动**：文档面表格里的短英文列（`mode` / `task` / `chat`）被 `overflow-wrap: anywhere` 挤成「mo / de」「tas / k」——那条规则是用户实测调优过的（`globals.css` 表格列宽一节，目的是不让中文备注列竖排），要改得让用户再看一眼。
- **窄屏重叠：根因是 `<button>` 的 shrink-to-fit，不是缺 `min-w-0`。** 量了窗口宽度 1440 → 375：修前 720 起模型按钮就顶穿左 slot，640 压住右侧附件图标 **60px**、560 压 **140px**、480 压 220px。逐层打印盒模型：`div.min-w-0.flex-1` 正确收缩到 71px、包它的 wrapper 也是 71px，**最里面的 `<button>` 却是 156px**——`<button>` 的 `width:auto` 按 shrink-to-fit 算、下限是内容 min-content（nowrap 的模型名即全宽），祖先再多层 `min-w-0` 都收不住，内部 `truncate` 永远不生效。`RichInput` 里 `*:min-w-0` 那条注释的本意就是这个，但它只管 slot 的直接子节点。
  - 修法：compact trigger 自己 `max-w-full`（上限 `max-w-48` 挪到 wrapper）；模型保底 `min-w-32`、提供方 96px 不让位（先试过让提供方先缩，结果 640 时提供方变成「C…」、没信息量，放弃）；`RichInput` footer 改 `flex-wrap`、左 slot `basis-58`（= 96 + 6 + 128 + 2 余量），放不下就把右侧附件 / 发送折到第二行靠右；没有 `leading` 时不渲染左 slot（空 slot 的 basis 也会触发折行）。任务说话条（`task-talk-composer`）的 leading 是同一套拷贝，同步改。
  - 实测（修后）：1440 ~ 700 单行、680 及以下折成两行，**全程两组按钮矩形交叠面积 = 0**；≥ 820 的数值与修前相同（提供方 96 / 模型 156），宽屏观感不变。折行阈值：footer 内容宽 < 362px（侧栏展开时约视口 < 700px）。
  - **没解决、也不在这条范围**：窗口 ≤ 520px 时侧栏固定 ~281px、主区只剩 ~240px 以下，整个应用已不可用，composer 比框宽属壳层问题；Electron 主窗口没设 `minWidth`（`electron-app/main.js`），要不要加是另一个决定。
- **验证**：`tsc` 0 错误；`eslint` 在改动的 10 个文件上 0 错误（2 个 `ui/` 文件被项目 ignore 规则跳过）；**全量 vitest 329 个文件通过（另 1 个跳过）/ 4309 个用例通过（3 跳过），0 失败**（上一小节 328 / 4292 → +1 文件 / +17 用例）。新增 `tests/markdown-reply-size-contract.test.ts` 10 个、`layout-overflow-contract.test.ts` 追加 #7 共 7 个；`event-stream-v2-contract.test.ts` 一条断言随常量化改写。**变异验证 3 个全被抓**（去掉 footer `flex-wrap` / 去掉定稿气泡 `size="reply"` / 把 `code` 的 `font-size: inherit` 改成 `1em`），每个只红对应那一条，还原后重跑全绿。
- **没验证 / 没做**：⚠ ① 运行态的流式占位（`StreamingAssistantRow`）——没跑 agent，只靠契约保证它与定稿同一档（两处 `size="reply"` + 外层同一常量）；② task 说话条（`task-talk-composer`）只做了源码同步 + 契约，没有单独在浏览器里看（需要 task 样本）；③ 问答卡 / 群问答面板 / 子代理工具块 / 产物栏 / 修订视图没逐个在浏览器里看——它们用默认档或 `variant="document"`，只受代码块那条 CSS 影响；④ 28px 行距的**手感**要自己 `pnpm dev:web`（8676）看；⑤ 契约测试只能防「被改回去」，证明不了渲染正确。
- **用户会看到的变化**：AI 正文 +1px、行距 24 → 28px（长回复整体约高 12%）；代码块文字 10.29 → 14px（明显变大）；窄窗口下输入框底栏折成两行而不是叠在一起。**回退**：正文——把 `rows.tsx` 三处 `size="reply"` 去掉即回 14px / 24px；代码块——删掉 `globals.css` 里 `pre / code { font-size: inherit }` 那条；窄屏——`RichInput` footer 去掉 `flex-wrap`（但会回到压叠）。
- **没做**：没提交 / 没发版 / 没打包；⚠ **用户刚替换进 `/Applications` 的本地包是这些改动之前构建的**，要看效果需要重新打包替换（约 5 分钟、会中断正在跑的任务）。

#### 同版：用户第三轮反馈——条间距「分辨力低」/ 往回滚弹回底部 / 思考吐字速度忽快忽慢（2026-10-12）

> 起因：用户把本地包替换后发来一张截图和三条反馈——① 右边时间流每条之间「看着都没间隔了」、分辨力太低；② 在底部往回滚的距离不多时，会自己弹回底部；③ 思考现在很丝滑，但速度时快时慢、「像开车加速又刹车又加速」，「如果是专门做的运动曲线就优化下，甚至可以不用要，或者有更优的方式」。同样**先量化、再改**：隔离数据目录起 `next dev`（8676，`FLOWSHIP_DATA_DIR` 指到 `/tmp` 里的样本副本）+ puppeteer-core 驱动系统 Chrome headless，只开 web、没开客户端；流式用页面里的 SSE 钩子灌 `assistant_delta` / `thinking_delta` 帧模拟；工具和数据都在仓库外、用完已删。

- **① 条间距**（`src/lib/event-stream-rhythm.ts`，新；`event-stream.tsx` 的 `itemContent` 改成调它）
  - 实测（task 样本、1440 宽、文字到文字的间距）：旧 说话 → 工作过程 **19px**、工作过程 → 下一条说话 **27px**，比值 **1.42**；「你的回答」卡 → 工作过程 26px。三个数几乎一样——整列等距，用户的观感是对的。
  - 做法：**拉大组间、收紧组内，而不是整体放大**。对话档 `pt-4`（task）/ `pt-6`（chat）→ 统一 **`pt-7`（28px）**；紧跟对话的过程行（工作过程组 / 工具块 / 工具动词组）`pt-2` → **`pt-1`（4px）**；紧跟对话的**卡片**（回执 / 错误 / 通知，自带边框）保持 `pt-2`——不能像过程行那样贴着上文；连续过程行 `pt-0.5`、首尾留白不变。**chat 与 task 同一套数值**（用户拍板一致；task 栏更窄，更要靠间距分组）。
  - 结果：组内 / 组间 task **15 / 39px（比值 2.60）**、chat 15 / 40px（2.67）；浅 / 深色、1440 / 820 宽都看过截图。
  - 为什么抽成纯函数（`rhythmTier` 判档、`rhythmPaddingTop` 映射）：节奏靠「档与档的相对关系」读出来，原来是 JSX 里两层三元，改着改着又等距了也没有任何东西拦。`tests/event-stream-rhythm.test.ts` 13 个，既钉数值、也钉关系（层级严格递减、组间 ≥ 组内 5 倍、组内 ≥ 4px、chat 与 task 除首条外一致）。
  - **刻意没改**：「你的回答」（`ask_user_reply`）不算对话档、按卡片处理——它紧跟在「已回答 N 个问题」卡后面，两张卡是一问一答、该贴近；算对话档会把它们拉开 28px。
  - 代价 / 回退：每个回合多占约 8–12px，长会话的滚动距离略增。回退 = 把 `rhythmPaddingTop` 里的数值改回去（task 对话 `pt-4` / chat `pt-6`，紧跟对话的过程行 `pt-2`），关系测试会拦「组间 < 组内 5 倍」，回退时要连测试一起改。
- **② 往回滚被拽回底部**（`src/lib/scroll-follow.ts` / `src/hooks/use-stream-follow.ts` / `event-stream.tsx`）
  - 复现（隔离环境；流式每 80ms 追加约 28px，滚轮上滚后观察 1.8s，每种输入 6 次；每次先确认「页面贴底 + 流式确实在长」才算有效）：旧实现滚轮上滚 15 / 30 / 100px 各 **2/6 弹回**，60px 和键盘 ↑ 为 0/6。
  - **根因不是一处，是五处互相独立的「拉回底部」机制叠在一起**——每修掉一处，下一处就接上来。每一处都在浏览器里抓到过证据（拦截 `scrollTo` / `scrollBy` / `scrollTop` 写入并按调用栈归属 + Virtuoso 的 `logLevel` 调试日志 + 读 `react-virtuoso@4.18.7` 的 `dist/index.mjs`）：
    1. **旧状态机**从浏览器平滑滚动动画的后续帧（距底 ≤ 48px）里「恢复跟随」——上滚被动画的尾巴判成了「又回到底部」。→ 状态机只认**用户意图**：上滚输入 → 停；恢复要同时满足「1s 内有往下翻的输入（滚轮 / 触摸 / ↓ PageDown End / 点滚动条）+ 这一帧确实朝底部走 + 距底 ≤ 48px」，程序化滚动再也恢复不了。
    2. **Virtuoso 自带「内容增高 / 视口变矮 → 滚到底」**，用它的 `atBottom` 当闸门；`atBottomThreshold` 给任何正数，用户上滚 ≤ 阈值仍算在带内。→ `atBottomThreshold = -∞`（`VIRTUOSO_NEVER_AT_BOTTOM`，永远不在底部）。副作用：「视口变矮」那条一起关了，由控制器的 `ResizeObserver` 补回。
    3. **Virtuoso「向上滚动补偿」**：上滚时上方项重新测量，它 `scrollBy(+增量)` 保持内容不跳，会吃掉小幅上滚（实测 +28 一次、净 −2px）。**没处理**——那是虚拟列表保持内容不跳的机制。
    4. **Virtuoso `scrollToIndex` 的重试链**（源码：每次滚完盯 150ms，期间列表变了就再滚一遍、再盯 150ms）：流式每 80ms 长一次，链永不结束，且**没有取消接口**——用户上滚后仍每 ~100ms 一次 +28px 把人拉回去。→ 日常贴底不再用 `scrollToIndex`：控制器直接写 `scrollTop`、每帧复查（连续 3 帧贴着才收工、最多 30 帧），离开底部立即取消。
    5. **函数形式的 `followOutput`** 才是链的起点：条数变化时 Virtuoso 自己 `scrollToIndex("LAST")`，**函数形式下跟不跟只看返回值、跟 `isAtBottom` 无关**——流式第一个 chunk 让条数 +1 就启动链。之前代码注释里「isAtBottom 恒假所以它不会触发」是**错的**（调试日志实证：`following output to {"totalCount":15}` → 反复 `retrying to scroll to`）。→ 不再传 `followOutput`；条数 / 总高变化后的贴底统一走控制器（跟随 effect + `totalListHeightChanged`）。
  - 结果：7 种输入 × 8 次 = **56 次有效试验 0 次弹回**（滚轮 15 / 30 / 60 / 100px、30px×3 连滚、↑×1、↑×5）；输入之后 Virtuoso 自己的程序化滚动从「每 ~100ms 一次」降到 0–1 次。跟随质量（每帧采样、取**绘制之后**的距底）：流式正文 / 思考 100% 的帧距底 ≤ 2px；异步增高 300px / 视口变矮 200px 各只有一帧偏差；上滚后用滚轮 / End / PageDown×4 / ↓×12 回到底部都能恢复跟随；载入定位到底、无残差。
  - **用户会感受到的行为变化**：① 任何可感知的上滚都立刻停止跟随，要回到「跟着最新」得自己往下滚到距底 ≤ 48px（或点「回到最新」/ Cmd+End）；② 程序化滚动（含内容收缩后浏览器夹住 `scrollTop`）不再自动恢复跟随；③ **拖滚动条到底仍不恢复**（拖动期间每帧按上滚意图算），要再滚一下；④ 选中拖拽、中键自动滚动到底也不恢复。
  - 回退：给 Virtuoso 加回 `followOutput` 与 `atBottomThreshold={120}`、控制器改回 `scrollToIndex`——等于把 bug 请回来；契约测试会拦（「不给 Virtuoso 传 followOutput」「底部带必须是负无穷」等）。
  - **没验证 / 已知限制**：机制 3（上滚补偿）没处理；初始定位链（`initialTopMostItemIndex`）和 3 个「跳到某项」（搜索命中 / 待答提问 / 回到本轮开头）仍走 `scrollToIndex`——一次性动作、没发现问题，但**没测到「初始定位链与流式增长重叠」那个窗口**（载入后 0.2 / 0.5 / 1 / 2s 上滚各 4 次 0 弹回，但这组里流式比 scroller 晚约 0.5–1s 才开始，前两档上滚发生在流式之前）；触摸和拖滚动条两条路径只有单元测试、没在真实设备上跑。
  - 踩坑：长时间跑 `next dev --turbo` 会触发「Server is approaching the used memory threshold, restarting...」自动重启，期间请求 `ERR_CONNECTION_REFUSED`（本轮一次批量因此中途失败、重跑）——是 dev 服务的内存策略，不是代码问题。
- **③ 思考吐字忽快忽慢**（`src/lib/smooth-reveal.ts` 重写；`src/lib/live-tail-scroll.ts` 新；`live-thinking-tail.tsx` / `use-smooth-thinking.ts` 接线）
  - 量化（模拟 250ms 一批、到达速率稳定 120 字/秒）：旧平滑层（τ = 300ms 指数追赶，`pos += 积压 × (1 − e^(−dt/τ))`）下**显示速度仍在起伏**——积压越多放得越快、批与批之间积压见底就慢下来，正是「加速 → 刹车 → 加速」；窗口上滚还是「多一行才整行跳一下」，82% 的时间静止。用户猜「如果是专门做的运动曲线就可以不要」——**确实是我做的追赶曲线造成的**。
  - 做法：没有简单去掉（去掉 = 回到 250ms 一批的整段替换，更机械），改成**按到达速率匀速放字**（jitter buffer 的做法）：用时间加权 EMA（τ = 3s）估到达速率 λ；显示速度 `v = λ + (积压 − 目标缓冲) / 1.8s`（缓冲偏低时修正力度 ×2），目标缓冲 = λ × 0.65s——速度只在 λ 附近微调、不再随每批到达起伏；积压 > 3 × max(目标, 20 字) 才追赶、到达停止 600ms 后排空；保底 10 字/秒（排空 60）；`dt` 钳 100ms；首批 / 突发（大块一次性到）不计入速率估计。窗口上滚改成按**光标位置连续平移**（`translateY`），不再整行一跳。
  - 数据（同口径、120 字/秒）：显示速度变异系数 **0.35 → 0.15**，p5..p95 **70..220 → 100..170 字/秒**；窗口滚动变异系数 **2.51 → 0.39**、静止时间占比 **82% → 2%**。
  - **代价（取舍）**：显示比到达滞后约 **0.65s**（旧约 0.29s）——匀速的前提是留缓冲。若觉得「慢半拍」，调小 `REVEAL_BUFFER_MS`（越小越紧跟、越容易重新出现起伏）。
  - 没做：正文打字机 `useSmoothStreaming` 没动（用户说它很丝滑）；两套算法仍分开。
- **验证**：`tsc` 0 错误；`eslint` 在 69 个改动 / 新增 TS 文件上 0 错误（反向对照确认它能报错）；**干净串行全量 vitest：338 个文件通过（另 1 个跳过）/ 4546 个用例通过（3 跳过），0 失败**（上一小节 329 / 4309 → +9 文件 / +237 用例），测试期间改动指纹不变。本轮新增 / 重写：`smooth-reveal` 52、`live-tail-scroll` 15、`thinking-reveal-integration` 9、`thinking-smooth-ui-contract` 23、`scroll-follow` 45、`stream-follow-controller` 50、`event-stream-scroll-contract` 21、`event-stream-rhythm` 13，`event-stream-v2-contract` 35（其中一条随节奏常量化改写）。**变异验证 96 个全部被抓**：思考 38（平滑层 23 + 窗口函数 7 + 组件 8）、滚动 39、节奏 19；滚动那批**第一轮有 3 个没被抓**（复查预算常量、跟随 effect 的依赖与闸门——控制器测试拿常量自己当期望，常量改了测试跟着改），补断言后全抓；每批跑完用 `shasum -c` 核对源码已还原。
- **浏览器里看过的 / 没验证**：web 版、隔离数据目录；浅 / 深色、1440 / 820 宽的 task 与 chat 条间距截图；上述所有回弹 / 跟随 / 载入采样。⚠ **没验证**：真实 Electron 窗口；真实模型的流（用的是 SSE 钩子灌的合成帧：正文每 80ms 约 28px、思考每 250ms 约 30 字）；真实触摸设备；窗口很窄（≤ 640）时的条间距；滚动 / 吐字的**手感**——数据说明「没弹回、速度更匀」，手感要自己 `pnpm dev:web`（8676）摸一下。
- **没做**：没提交 / 没发版 / 没打包；⚠ 用户已替换进 `/Applications` 的本地包**不含**本轮改动（也不含上一小节的 15px 正文 / 窄屏修复）——要看效果需要重新打包替换（约 5 分钟、会中断正在跑的任务）。

#### 同版：用户第四轮反馈——首轮思考很长，切窗口再切回来，思考又从第一个字开始吐（2026-10-13）

> 起因：用户一句话——「首轮思考很长的话，我切窗口再切回来，那个思考好像又是从第一个字开始吐」。同样**先复现、再改**：隔离数据目录起 `next dev`（8676）+ puppeteer-core 驱动系统 Chrome headless，只开 web、没开客户端；思考用页面里的 SSE 钩子按 400 字/秒灌 `thinking_delta`（250ms 一批、每批 100 字，语料每 ~10 字带一个「【nnnn】」序号，一眼能看出文本区是不是从头开始）。工具和数据都在仓库外、用完已删。

- **根因**：进行中的思考只存在于前端 `ChatView` 的**本地 state**；服务端的 `thinking_delta` 是**纯内存帧、从不回放**；`ChatView.onEvent` 对**任何**落盘事件都 `clearThinkingLive()`，连 bootstrap 重新回放的尾部历史也算。所以任何「重新订阅」都等于从零开始：文本区只剩订阅之后新到的字、从那里重新长，已累积的几千字和「思考中 · Ns」的计时起点全丢。三条触发路径（修复前，实测）：
  - **A. 切到别的对话再切回**（`ChatView` 卸载重挂）：切走前文本区 1772 字、头「【0000】思考」→ 切回后第一次可见 **36 字、头变成「思考内容第244」**，从那里重新长。这就是用户说的现象。
  - **C. SSE 断流自动重连**（页面没卸载；`maxDuration = 300` 到点 / 网络抖动 / 服务重启都会触发，hook 1s 后重连）：文本区先**消失**（len → −1），重连后 36 字、头「思考内容第169」重新长。
  - **B. 窗口 / 标签页在后台**（rAF 暂停、SSE 照常到）：文本没被重置，但回前台时 250ms 内 1786 → 3346 字，之后以 500–600 字/秒高速追赶约 5s——「没在看的时候长出来的字」被演了一遍。
- **做法**（协议加两处、都向后兼容：旧客户端忽略未知帧 / 字段，新客户端遇到旧服务端 = 旧行为）：
  1. **服务端记「已发出的」**（`sdk-message-handler.ts` 的 `ThinkingThrottle` 加 `sent` / `sentTotal` / `since`）：只在 `publishIfCurrent` 返回 true 后累积（还在节流窗口里排着的尾巴发出时才进，否则 bootstrap 之后那一帧会把它重复一遍）；`sent` 与前端同一个截尾口径（尾部 ≤ `THINKING_TEXT_MAX` = 20000、同一个 `appendThinkingText`），`sentTotal` 不截。`getLiveThinkingSnapshot(taskId)` 读时重估 lease，失主就清掉。
  2. **新帧 `thinking_snapshot`**（`watch-task` 路由）：每次（重）连接 bootstrap 末尾**无条件恰好一帧**（`queue_state`、`restricted_run` 之后、buffer 回放之前）——`live: null`（没在思考，前端据此清残留）或 `{ eventId, text, total, since }`。**订阅与读快照同步配对，中间不能有 `await`**：快照 = 订阅那一刻之前已发出的全部，之后的帧都进 buffer、在快照后面回放，不重不漏；隔了 `await` 就会既进快照又进 buffer、前端文本被重复一遍（有挂起 bootstrap 磁盘读取的 race 测试钉着）。这段思考的落盘事件已经在 tail 里 → 发 `live: null`（别复活幽灵「思考中」）。
  3. **`event` 帧加 `replay: true`**（只给 bootstrap 回放的 tail 事件，实时事件不带）：`task-store` 只认**严格布尔 true**，`onEvent(ev, meta?)` 仅回放时带第二个参数（实时事件仍是单参数，调用形状不变）；`chat-view` 对回放事件**不清**实时态——「重读一遍旧账」不等于「刚发生一个落盘事件 = 这段思考结束了」。思考是否真的结束，由紧随其后的快照对齐。
  4. **前端合并 / 不重演**（`lib/thinking-live.ts` 纯函数）：`applyThinkingSnapshot`——本地没有 / 是另一段 → 按快照重建（起点用服务端首帧时刻，计时不归零；`base` = 快照末尾，这些字直接显示、不再演）；同一段（同页重连）→ 本地不比服务端旧就原样返回（引用稳定、位置不回拨），否则换成更全的文本、**起点和 base 沿用本地**，断线期间缺的字作为积压追上去。`use-smooth-thinking`：新挂载 / 刚换段时初始位置取 `liveThinkingFloor`（窗口起点与 `base` 取大）而不是 0，所以重建后的**第一帧就是整段内容**；`visibilitychange` 回前台时 `skipLiveReveal` 直接跳到最新（只动位置、不碰速率估计）。
  5. **顺带修的既有 bug**：旁路答疑（`origin`）run 与属主主链共用按 `taskId` 的节流状态，但它自己的每条消息和收尾 `flushThinkingBuffer` 都会 `discardPendingThinkingDeltas`——主链思考进行中，旁路一说话 / 一收尾就把主链的节流状态（现在还有快照）清掉。两处 discard 加了 `!origin` 门。
- **结果**（同口径、浏览器里量；「对照」= 路由没快照可给，用来证明改善来自快照而不是实验设置）：

  | 场景 | 修复前 | 修复后 |
  |---|---|---|
  | A 切走再切回 | 切回后 36 字、头「思考内容第244」，从头长 | 切回后第一次可见 **3800 字（= 服务端已发出的全部）、头仍是「【0000】思考」**，之后 ≈ 到达速率继续长（每 250ms +80～100 字）；状态行「思考中 · 9s」→「12s」连续不归零 |
  | C 断流重连 | 文本区消失（−1）→ 36 字重新长 | 全程单调不回落（1768 → 1868 → 1948 → 2013 → 2055 → 2092 → 2184…）、头不变、无 −1；断线期间缺的约 500 字作为积压以 ≤ 520 字/秒追平（无爆发） |
  | B 后台再回前台 | 250ms 内 1786 → 3346，再以 500–600 字/秒追 5s | 隐藏期间冻结；回前台**一次**跳到最新（1782 → 3459），之后 230 → 400 字/秒爬升到到达速率，无高速追赶 |
  | 对照（无快照） | — | 切回后仍是 36 字、头「思考内容第244」（与修复前一致） |

  回到 A 到文本区出现之间约 0.75s 的空窗是**切换对话本身的加载**（重新拉任务 / 重挂 / 建连），不是思考专属。回前台后前 ~1s 吐字略慢于到达（230 → 400 字/秒），文本落后约 0.4s——跳过的那一大块不计入速率估计，估计值要重新收敛；之后与到达速率一致。
- **用户会看到的变化**：① 切回对话 / 断流重连后，思考文本区第一帧就是已有的全部内容、接着往下长，不再从头吐；② 「思考中 · Ns」计时连续；③ 重连时文本区不再消失；④ 回到前台直接显示最新、不再把后台长出来的字补演一遍；⑤ 切回对话仍要等对话本身的加载（约 0.75s），之后思考行一次性出现。
- **测试**（新增 4 个文件、69 个用例 + 更新 2 个契约文件）：`thinking-snapshot`（33，前端纯函数 + 重挂 / 重连 / 回前台模拟）、`thinking-live-snapshot`（16，服务端快照存储：只含已发出的 / 截尾 / 段结束 / 失主 / 旁路不碰主链）、`watch-task-thinking-snapshot`（9，**真实路由 + 真实 `handleSdkMessage`**：帧序、`replay`、failpoint 挂起 bootstrap 的不重不漏 race、落盘事件已在 tail、路由字节流喂给真实 `watchTaskStream` 的端到端回调序列）、`thinking-snapshot-dispatch`（11，客户端分发：无效帧一律丢弃、`replay` 只认严格 true）；`thinking-delta-wiring-contract` / `thinking-smooth-ui-contract` 更新并新增每一环的源码契约（node 环境跑不起 React，hook 与 `chat-view` 只能靠契约）。
- **验证**：`tsc` 0 错误；`eslint` 在 75 个改动 / 新增 TS 文件上 0 错误；**串行全量 vitest：342 个文件通过（另 1 个跳过）/ 4629 个用例通过（3 跳过），0 失败**（上一小节 338 / 4546 → +4 文件 / +83 用例），测试期间源码指纹不变，真实数据目录的 `node-reports` 数仍是 8（没被测试污染）。
- **变异验证 52 个全部被抓**（服务端 11 / 路由 7 / 客户端解析 8 / hook·`chat-view`·平滑 hook 11 / 纯函数 15）。其中前 41 个（不含 UI 层）用**只含行为测试、不含源码契约**的口径单独跑了一遍：第一轮 **S10（没发过任何一帧也返回快照）存活**——没有可达路径能让它暴露（首个 chunk 总是立即发）；补了一条「系统时间落在节流窗口内、首个 chunk 排着 → 快照为 null」后全抓。每批跑完核对源码已还原。
- **没验证 / 没做 / 已知限制**：⚠ ① **正文（`assistant_delta`）流式有同样的「重新订阅就丢」性质，这次没动**——切回后已流出的正文不会补、要等整条落盘；而且 bootstrap 回放的 `assistant_message` 事件会触发 `clearStreaming()`，同页重连时正在流的正文也会被清。用户这次没提、没扩大范围；要做的话是同一套做法（服务端快照 + `replay` 门）。② `since` 是**服务端时钟**（桌面版内置服务、同机，一致；跨机器访问且时钟有偏差时「思考中 · Ns」会偏）。③ 真实 Electron、真实模型的流没验证（用的是 SSE 钩子灌的合成帧）；窗口被系统遮挡时 Chromium 是否把 `visibilityState` 置为 hidden 取决于平台，只验证了「置 hidden → 回前台」这条链路。④ 手感要自己 `pnpm dev:web`（8676）摸一下。
- **回退**（各层独立）：删掉 `watch-task` 的 `thinking_snapshot` 帧发送 = 无快照、回到旧行为；`chat-view` 去掉 `if (!meta?.replay)` 条件 = 回放也清；`use-smooth-thinking` 删掉 visibility 监听 = 回前台重新补演。契约测试会拦这些回退，回退时要连测试一起改。
- **没做**：没提交 / 没发版 / 没打包；⚠ 用户已替换进 `/Applications` 的本地包**不含**这一轮（也不含上一轮）的改动——要看效果需要重新打包替换（约 5 分钟、会中断正在跑的任务）。

#### 同版：用户第五轮反馈——聊天太多，往回滚滚着滚着就滚不动了（2026-10-13）

> 起因：用户一句话加一张截图——「聊天太多的话，我往回滚，滚着滚着就滚不动了，看不了再之前的了」。截图里顶部是一个折叠的「工作过程 · 245 步 · 42m8s」，滚动条滑块缩在最顶端。同样**先复现、再改**：把这个对话的 `events.jsonl`（6247 条）复制进 `/tmp` 的隔离数据目录，起 `next dev`（8699）+ puppeteer-core 驱动系统 Chrome headless，脚本模拟滚轮一路上滚。工具和数据都在仓库外、用完已删。

- **根因**：分页按**原始事件条数**切（一页 300 条，`EARLIER_PAGE_SIZE`），渲染却按回合折叠。AI 连续调几百次工具、中间一句话没说，这几百条在 chat 里是**同一个**「工作过程」组（`buildWorkGroup` 的组 id = 首成员 id）。真实对话里最大的组有 **671 条**原始事件（250 次工具 + 171 段思考）。往上翻时某一页**整页都是这个组的成员**：prepend 之后它们全并进最顶上那一条，条目数不变，`firstItemIndex` 的递减量 = 条目数差 = 0，Virtuoso 里第一项的绝对序号不变。而 Virtuoso 的 `startReached` 内部是 `distinctUntilChanged(第一项序号)`——序号没变就**不再触发**。用户停在 `scrollTop = 0`，往上滚没有任何东西可滚，也没有任何东西再去拉下一页。服务端其实明确回了 `hasMore: true`。
- **核对**：截图里的 245 步 ≈ 日志第 1747–2139 条的 `tool_call + thinking`（246）——正好是「大组被第 14 页塞满、第 15 页没拉」的状态；截图里组下面那条「第一版剪好了」就是日志第 2140 条。
- **修复前实测**（同一份日志，滚轮上滚 −700px/次）：**翻了 14 页 / 4200 条后卡死**，`hasMore: true`、`scrollTop = 0`、顶部组 235 步（我这份拷贝比用户那份少几条）、之后 6 秒没有任何请求。截图与用户的几乎一样。
- **做法**：一次上拉保证二选一——**顶部多出至少一条可见条目，或历史读完**。`src/lib/earlier-events.ts` 的 `fetchEarlierBatch`：拉一页 → 按 id 去重 → 用调用方注入的 `countItems` 看条目数有没有变多 → 没变就接着往前拉（单批最多 8 页），**不把「空转」的一页提交出去**；单批到上限仍没进展、且还有更早的 → 返回 `progressed: false`，`loadEarlier` 先提交这一批（组的步数会涨）再接着拉。`countItems` 就是 `buildStreamItems`（与 `items` useMemo、`firstItemIndex` 差值**同一个函数**）。游标始终推到「这一页最早一条」，哪怕整页都是已知事件也不原地空转；服务端说还有、却给了空页 → 当作到头。
- **顺手堵的同症状漏洞**：请求失败后 Virtuoso 同样不会再触发 `startReached`（第一项序号没变），用户停在顶部没有任何办法重试。现在失败后顶部出现「加载更早失败，点击重试」（`earlierFailed` + Header 的 context），点击重新拉；开拉时清掉。
- **修复后实测**（同一份日志、同一个脚本）：从最新一路滚到对话最开头，**20 次请求 / 5947 条（= 6247 − 尾部 300）**，最后一页 `hasMore: false`，第一条 `user_reply` 渲染出来，没有任何一次卡住。失败重试：强制第一次「更早事件」请求返回 500 → 顶部出现重试入口、`scrollTop = 0`；点击后请求成功、`scrollTop` 0 → 2052（新内容进来、位置被补偿）、入口消失。
- **用户会看到的变化**：① 往回滚经过很长的「工作过程」时，顶部会多转一会儿「加载更早…」、组的步数往上涨，然后继续往上滚得动；② 请求失败时顶部有「点击重试」；③ 其余不变。
- **排查过、结论不是原因**：① `readEventsBefore` 的锚点——服务端合并相邻思考时保留**第一个碎片**的 id（`coalesceAdjacentThinking`），锚点一定在文件里；这个对话也没有相邻思考。② `hasMoreEarlier` 初值 / `pagedOnceRef`——卡死时 `hasMore` 一直是 true。③ 上一轮的跟随 / 贴底改动——只在 `scrollTop` 写入和 `followOutput` 上，与分页触发无关。
- **没处理的、顺带观察到的**：用户停在 `scrollTop = 0` 时，**普通一页** prepend 也会有一帧内容错位（用「每帧绘制之后」采样锚点位置：Virtuoso 补偿滚动位置晚一帧，那一帧 `scrollTop` 还是 0）。实测 4 个普通页边界里 3 个有（偏移 1568 / 3080 / 168px，另一个没有）。普通页走的提交路径与改动前一致，推断旧代码同样有，但**没有单独在旧代码上量过**（工作区改动太多没法回退）。这次没动它：不是用户这次提的问题，且要改得动 Virtuoso 的 prepend 补偿方式。大组那次提交里同样有一帧（最终代码实测偏 204px，在普通页的范围内；中间版本试过把没进展的页放大到 500 再攒着提交，那一帧偏到 2724px，所以改回每页 300）。
- **测试**（新增 2 个文件、20 个用例）：`tests/earlier-events.test.ts`（14 个行为测试，条目数用**真实**的隐藏闸 → 工具配对 → 工作过程分组来数，不自己模拟；含「整页在大组里」「从最新一路翻到最开头每一批都有进展」「游标推进」「空页」「取消」「失败」「拉的过程中本地追加了新事件」）、`tests/earlier-events-wiring-contract.test.ts`（6 个源码契约：走 `fetchEarlierBatch`、条目数走 `buildStreamItems`、没进展就循环、`firstItemIndex` 差值、取消、重试入口）。
- **验证**：`tsc` 0 错误；`eslint`（改动 / 新增的 4 个文件）0 错误；**全量 vitest：344 个文件通过（1 个跳过）/ 4649 个用例通过（3 个跳过），0 失败**（上一小节 342 / 4629 → +2 文件 / +20 用例）。⚠ 第一次全量跑有 `agent-readonly`、`sdk-agent-store-wiring` 两个文件失败（5 秒超时、后者是超时后的连带断言），当时我的 dev server 和无头 Chrome 同时在跑、抢 CPU；关掉后单跑这两个文件 44 个用例全过，空闲状态下全量重跑也全过。
- **变异验证 7 个全部被抓**：M1 拉完一页就收工（旧行为）/ M2 游标不推进 / M3 去掉空页保护 / M4 `progressed` 恒为 true / M5 组件里没进展不循环 / M6 去掉重试入口 / M7 条目数不走 `buildStreamItems`。每个跑完核对源码已还原。
- **没验证 / 没做 / 已知限制**：⚠ ① 只测了 web 版（headless Chrome），没测真实 Electron 窗口；滚轮上滚是脚本合成的，触摸板惯性滚动、拖滚动条没在真实设备上跑。② 失败重试用的是强制 500，没测真实断网。③ 极端情况（单个组几万条事件）理论上会连着拉很多页（每页服务端要从文件头扫到游标），没造这么大的数据测。④ 回到贴底 / 跟随最新那一套没动，没有重测。⑤ 手感要自己在 `pnpm dev:web`（8676）上摸一下。
- **回退**：`loadEarlier` 改回「以本地第一条为锚点单页请求」= 旧行为（卡死复现）；契约测试会拦，回退时要连测试一起改。

#### 同版：用户第六轮反馈——task 右栏「文字变大了、消息之间分不出来」（2026-10-13）

- **现象**：用户贴 task 页右栏截图：「事件流每条消息之间的间隔分割不是很明显了，文字感觉稍稍有些大，本身事件流也不宽」。
- **根因（两件事叠在一起，都是 2026-10-12 事件流 v2 带来的）**：① 昨天把 AI 正文真正落到 15px / 28px（此前实际一直是 14px / 24px），task 右栏只有 chat 宽列的一半多一点，每行字少、行高又大；② 行距变成 28px 后和组间留白 `pt-7`（28px）一样大——文字到文字的间距只有一个行距的 1.4 倍，平铺文字里读不出「这是新的一段话」（第三轮只拉大了留白、没解决这个比例问题）。
- **做法**：
  - **字号**：task(log) 的 AI 回复回到 **14px / 24px**（`MarkdownText size="default"` + wrapper 常量 `MARKDOWN_LOG_REPLY_TEXT = "text-sm leading-6"`，流式占位与定稿同档）；**chat 宽列保持 15px / 28px**。字号随容器宽度走，节奏 / 外观才要求两边一致。
  - **分隔**：AI 一段新话的开头在留白正中画一条两端渐隐的 1px 细线（`rhythmShowsGroupDivider` 纯函数 + `RHYTHM_GROUP_DIVIDER_TOP`）；用户气泡 / 提问卡 / 过程行不画，紧跟用户这一侧话的 AI 回复也不画（一问一答是同一组）。chat 与 task 同一套。**留白数值没动**（`pt-7` / `pt-1`），所以第三轮的比例测试仍成立。
- **改动文件**：`src/lib/event-stream-rhythm.ts`、`src/components/tasks/event-stream.tsx`（`rhythmFacts` 补两个事实 + 分隔线 DOM）、`src/components/tasks/event-stream/rows.tsx`、`src/components/markdown-text.tsx`；规则写进 `.cursor/rules/ui-conventions.mdc`（字号阶梯 + 回合节奏两处）；测试 `event-stream-rhythm` / `event-stream-v2-contract` / `markdown-reply-size-contract`。
- **没验证 / 要用户自己看**：⚠ 没在浏览器里量过——分隔线颜色（`border` token）在浅色下够不够显、14px 下观感，要 `pnpm dev:web`（8676）刷新看；chat 里的 AI→AI 之间新增了分隔线、字号没动，若 chat 也嫌大，把 `rows.tsx` 两处 `isLog ? … : …` 的 chat 一支也换成 default 即可。
- **回退**：字号——`rows.tsx` 里 log 的 `size="default"` / `MARKDOWN_LOG_REPLY_TEXT` 换回 `size="reply"` / `MARKDOWN_REPLY_TEXT`；分隔线——`event-stream.tsx` 里删掉 `showGroupDivider` 那段 DOM（`rhythmFacts` 的 `aiText` / `userSide` 可留）。

#### 同版：子代理能指定模型 / effort——自定义 provider（pi `task`）+ Cursor（新增 `subagent` 工具）两条路径都落地（用户提出，2026-10-13）

> 起因：用户问「自定义 provider 那边自己封装了子代理，SDK 能不能也用那一套？再把自封装的完善下，能传详细的模型和 effort」。背景：本会话里 Cursor 原生 `Task` 的 `model` 只允许 `inherit` / `composer-2.5-fast`，Cursor SDK 1.0.37 公开类型里也没有子代理模型选项（只有 `subagentInherit` 与 `tools` 里 `"task"` 的开关）。用户拍板：范围由我取舍（选「新增工具、与原生 task 共存」〔更新：后来用户改主意、原生 `task` 已关，见下面「Cursor 路径关掉 SDK 原生 `task`」一节〕）；子代理**只能选当前 provider 的模型**、缺省继承当前模型；**fast 不在代码里拦**，继续靠 `.cursor/rules/subagent-no-fast.mdc`〔2026-10-13 后续：用户要求删掉这条规则，文件已删，现在既不拦也无规则约束〕。

- **改之前的问题（读代码确认，没在旧代码上跑过）**：`pi-coding-tools.ts` 的 `task` 工具声明了 `model` / `subagentType`，`runSubagent` 却只用 `prompt`——子会话固定沿用父会话的模型和思考档；而 `TaskSubagentBlock` 的模型徽标读的就是模型传进来的 `args.model`，所以**显示的模型和实际跑的模型可以不一致**。另外：父会话被停后子会话不会停（`execute` 的 `signal` 没用）；子会话自己的模型请求失败（鉴权 / 模型名被端点拒 / 5xx）被吞成「(子任务无输出)」；参数错误当普通文本返回，界面显示「成功」。
- **做法**：
  - `src/lib/subagent-spec.ts`（新，纯逻辑，pi 与以后 Cursor 共用）：`parseSubagentRequest`、`resolveSubagentModel`、`catalogFromModelOptions`、`formatModelCatalog`。规则：`model` 缺省 / `inherit` / 与当前同 id → 沿用（连当前思考档一起沿用）；指定其它模型 → 必须在当前 provider 的目录里（精确 id → 忽略大小写 → 唯一 displayName），**换了模型就不把父档位硬套过去**；`effort` 显式给了 → 必须是目标模型支持的档，目标模型没有 effort 参数也报错；`model: "list"` 返回可选模型 + 各自 effort 档。**填错一律报错并列出可选项，不静默回退**。拿不到目录（端点没有 `/models` 等）→ 不校验 model id、effort 按通用档校验。`subagentType` 收成 `explore`（只读）/ `general`。
  - `src/lib/server/model-catalog.ts`（新）：把 `/api/models` 路由里的「拉清单 + 10 分钟缓存 + 超时」抽出来，路由与子代理共用一份（cache key 与改造前一致；路由的校验 / 状态码 / 错误格式不变）。
  - `custom-agent-backend.ts`：`runSubagent` → 导出的 `runPiSubagent`。沿用模型且没覆盖 effort 时复用父 runtime（不多一次构建、不为此访问 `/models`）；否则用 `buildRuntime({...父 input, model: 解析结果})` 重建。`explore` 只给 `read / grep / find / ls`。`signal` 取消 → `session.abort()`。子会话失败（`prompt()` 抛错或最后一条 assistant 是错误）→ 抛错带上原因（已有部分输出则一并带上）。effort 被 pi 丢掉（目录不认这档）→ 报错，不假装生效。`buildCustomTools` 改成接 `SubagentParent`（父 input + runtime + model + thinkingLevel）。
  - `pi-coding-tools.ts`：`task` 加 `effort` 参数、描述写清用法；参数错误 / 用法错误**抛错**（pi 标成工具错误），子会话运行失败加「子任务失败：」前缀。
  - 界面：`tool-display.ts` 的 `parseTaskToolArgs` 多解析 `effort`；`sdk-message-handler.ts` 把 `effort` 放进「短字段前置」（否则 prompt 一长就被截掉）；`TaskSubagentBlock` 在模型徽标后多一个 effort 徽标。
  - `prompts/_super.md`：`task` 一行写明新参数。
- **用户会看到的变化**：自定义 provider 会话里，模型可以让子代理用别的模型 / 别的思考档；填错会看到错误卡片与可选项而不是悄悄用错的；父会话停止后子代理也停；子代理自己失败时能看到原因。**Cursor 会话**：原生 `task` 原样保留；多了一个 `subagent` 工具（见下「Cursor 路径」），要指定模型 / effort 时模型用它。〔更新：原生 `task` 后来已在挂了 `subagent` 的会话里关掉，见下一节〕
- **pi 路径范围内没做**：① （Cursor 路径当时没做，后来补做了，见下）；② 子代理过程的实时输出（子会话事件不进父会话事件流，仍是跑完才有结果）；③ 并发上限（模型一口气派很多个子代理会同时起很多会话）。
- **Cursor 路径（同日补做）**：先前因 `cursor-delegate` 存的 key 已失效没跑成实验；后来用户在对话里给了一把临时 Cursor key 并授权自行实验（可用 composer2.5 / gemini3.8flash / sonnet5.5）。key **只通过环境变量传给实验进程**（经一个临时文件，用完已删），没打印、没写进仓库、没写进 `cursor-delegate` 凭证库，也没去找别的凭证。⚠ **这把 key 出现在了对话 / 终端历史里，建议用户去 Cursor 后台作废重发。**
  - **5 个实验结论（真实 `@cursor/sdk` 1.0.37，2026-10-13）**：① `local.customTools` 回调**同步阻塞 ≥330s 不超时**（「MCP 60s 硬超时」是 HTTP MCP 时代的结论，不适用于进程内 customTools）；② 在工具回调里再 `Agent.create` 起子 agent 可行（sonnet-5-5 + `reasoning_effort` 实测生效，子 agent 自报「Claude Sonnet 5.5」）；③ 同一轮并行的多个 customTool 调用**并发执行**；④ **customTool 回调拿不到 `AbortSignal`，父 `run.cancel()` 不会停子 agent**——必须自己联动；⑤ `AgentOptions.agents[].model` 本地运行时**被忽略**（仍是 composer-2.5-fast），所以走不了「改原生子代理配置」这条路。另：`SDKCustomToolResult` 支持 `{content:[{type:"text",text}], isError?}`；`ctx.sessionId` 是父 agentId；`tools` 白名单名字是 `shell/read/edit/grep/glob/ls/task/mcp…`。
  - **effort 参数名在 Cursor 模型里不统一**：`reasoning_effort`（sonnet-5-5、gemini-3.8-flash）/ `effort`（sonnet-5、gemini-3.7-flash、sonnet-4-6…）/ `thinking`（多为布尔开关，不当 effort 档）。`subagent-spec.ts: findEffortParam` 按优先级找；`context` 参数在 `withoutHiddenModelSelection` 里统一剥掉（与主会话同口径）。
  - **做法：新增 Cursor 专用 MCP 工具 `subagent`（server `custom-user-tools`），与原生 `task` 共存，原生 `task` 一点没动**。参数、描述、报错与 pi 的 `task` 共用同一份 spec（`subagent-spec.ts` 新增 `SUBAGENT_TOOL_DESCRIPTION` / `SUBAGENT_INPUT_JSON_SCHEMA` / `subagentNeedsCatalog`）。
    - `src/lib/server/cursor-subagent.ts`（新）：`createCursorSubagentLink(deps)`（依赖可注入，便于测）= 工具本身 + `attach(agent)` + `cancelAll()`。流程：parse → 只有指定了别的模型 / effort / `list` 才去拉目录（沿用模型就不为此访问 `/models`）→ 解析 → 起子 agent → `send` → 收文本 → `wait()`。取消 → 返回「子任务已取消」（不算错）；失败 → `子任务失败：…`（`isError`）；无输出 → `(子任务无输出)`；`finally` 一定 `child.close()`。`createCursorSubagentLinkForSession({apiKey, parentModel?, cwd?})` 是真实依赖：目录来自 `listModelOptions({kind:"cursor"})`（失败返回 null 并 `console.warn`，退化成不校验 id）；子 agent 与父同 apiKey / cwd、`settingSources: []`（不加载 `.cursor/`）、`explore` 只给 `read/grep/glob/ls` 白名单、`general` 用 `disallowedTools:["task"]`（防递归）；子 agent **不挂任何 customTools / mcpServers / agents**；创建 / 发送套 `withSdkDeadline`（180s / 120s，与父会话同口径，晚到的结果自动 close / cancel）。
    - **取消联动（实验④的补救）**：每个父 agent 实例一个 `link`：活着的子 run 集合 + **取消代数计数器**（工具回调开始时记下代数，每个 `await` 之后复查；`cancelAll()` 把代数 +1）。不用永久标志（同一个 agent 的下一轮还要能用），也不按 agentId 存（resume 出来的新实例 agentId 相同）。`attach(agent)` 返回 **Proxy** 而不是原地改：包住 `send`（返回 run 的 `cancel` 先取消子 run，再原样返回父的结果 / 异常）、`close`、`[Symbol.asyncDispose]`；`Reflect.get(target, prop, target)` + bind 到原对象（SDK 的 agent 是带 `#private` 的类实例）；冻结对象不代理。⚠ **教训：我第一版是原地替换 `run.cancel` / `agent.close`，结果 `chat-runner-reconnect-race` 等 4 个文件共 8 个用例失败**（它们断言原对象上的 spy 被调用，被我替换后变成「is not a spy」），改成 Proxy 后这 4 个文件不改一行就过了。
    - `agent-backend.ts`（`Agent` facade）：`attachFlowshipTools` 现在返回 `{input, subagent}`；**只有带 `callerToken` 的会话才挂 `subagent`**（`readOnly` / oneshot / 受限会话没有），`create` 与 `resume` 都 `subagent.attach(agent)`。`flowship-tools.ts: withFlowshipSdkCustomTools` 多一个 `extraTools` 参数（不覆盖已有 customTools）。
    - 界面：`cursor-subagent-display.ts`（新，纯函数）+ `sdk-message-handler.ts` 顶部一行：`subagent` 的 MCP 事件（名字是 `mcp`、`args:{providerIdentifier,toolName,args}`、结果是 `{content:[{text:{text}}],isError}`）被改写成 `task` 事件（平铺 args、纯文本结果、`isError` → status `error`），于是**现成的 `TaskSubagentBlock`（模型 / effort 徽标、状态）直接可用，前端没改**。其它 MCP 事件原样（同一引用）。
    - `prompts/_super.md`：写明 `subagent` 用法与「要指定 model / effort 就用它，原生 `task` 不能选模型」；`pi-coding-tools.ts` / `custom-agent-backend.ts` 改用共用的描述与 `subagentNeedsCatalog`。
  - **没做成「原生 task 被替换」**〔更新：后来做成了——挂了 `subagent` 的会话里原生 `task` 已关，见下一节〕：原生 `task` 与 `subagent` 并存，靠提示词引导模型选；`.cursor/rules/subagent-no-fast.mdc`（子代理不选 fast）继续只靠规则约束，代码里不拦（用户拍板）〔2026-10-13 后续：规则文件已按用户要求删除〕。
- **测试**（新增 2 个文件、33 个用例；改 2 个文件）：`tests/subagent-spec.test.ts`（23，纯逻辑）；`tests/subagent-pi-e2e.test.ts`（10，**真实 pi 父会话 → 真实 `task` 工具 → 真实子会话**，对端是本机假 OpenAI 兼容端点，只记录请求；用「请求里有没有 `task` 工具」区分父 / 子，因为沿用模型时两者 `model` 相同）：缺省沿用（`reasoning_effort` = 父档）/ 指定 model + effort（模型 id 与 `reasoning_effort` 真的到了端点）/ 换模型不带 effort（不是父档）/ 只改 effort / `explore` 只有 `find grep ls read`、`general` 有 `bash edit write read` 且没有 `task` 与 `submit_work` / 无效 model → 工具错误 + 可选项且**没有发出子会话请求** / effort 不支持（两种）/ `list` / 子会话模型被端点 400 拒 → 父会话看到原因 / 父会话取消 → 子会话对端点的连接被断开。`tests/tool-display.test.ts`、`tests/sdk-message-handler.test.ts` 补 `effort`（含「prompt 3000 字时 effort 不被截」）。
- **变异验证 8 个全部被抓**：M1 子会话忽略指定模型 / M2 去掉取消联动 / M3 吞掉子会话失败 / M4 `explore` 给全套工具 / M5 换模型时硬套父 params / M6 无效 model 静默回退 / M7 effort 校验放行任意值 / M8 `effort` 排在 prompt 后面（被截断）。每个跑完核对源码已还原。
- **验证**：`tsc` 0 错误；`eslint`（改动 / 新增文件）0 错误；**全量 vitest：346 个文件通过（1 个跳过）/ 4684 个用例通过（3 个跳过），0 失败**（上一小节 344 / 4649 → +2 文件 / +35 用例）。⚠ 第一次全量跑时 `tests/event-stream-v2-contract.test.ts` 失败——我给 effort 徽标写了 `text-subagent/80`，违反「事件流渲染层文字不叠 alpha」约定，已改成 `text-muted-foreground`。
- **没验证 / 已知限制**：⚠ ① 只对着**假端点**测过，没连真实自定义 provider（真实端点是否接受子会话用别的模型 / `reasoning_effort` 取决于端点）。② 没在浏览器里看 effort 徽标（只过了源码契约测试）。③ 没测模型实际会不会按新参数调用 `task`（提示词与工具描述只是写了，没跑真实模型）。④ 「Default（不覆盖）」在 pi 里并不是请求里不带 `reasoning_effort`，而是 pi 用它自己的默认档（假端点上看到的是 `high`）——这是已有行为，没动。⑤ 顺带观察：**没有任何子代理**的 pi 父会话被取消时，`PiRunAdapter.wait()` 也是 `error / "Request aborted"`；task-runner 是否靠自己的取消标记兜底没查，没动。
- **回退**：`runPiSubagent` 里换回「总用父 runtime」+ 去掉 `effort` 参数即旧行为；`model-catalog.ts` 可单独保留（路由行为不变）。
- **Cursor 路径的测试**（新增 4 个文件、76 个用例；改 2 个文件）：`tests/cursor-subagent.test.ts`（44：模型 / effort 解析、结果与失败路径、close 路径、取消联动含代数竞态、Proxy attach——带 `#private` 的类实例 / 冻结对象 / 不能被当 thenable / 原对象上的 spy 不被动过）、`cursor-subagent-display.test.ts`（12：事件改写）、`cursor-subagent-wiring.test.ts`（11：facade 只在有 `callerToken` 且非 `readOnly` 时挂 `subagent`、create 与 resume 都包、无 `callerToken` 返回原 agent）、`cursor-subagent-session.test.ts`（9：真实依赖工厂的创建选项——`general` / `explore`、藏起来的 `context` 参数被剥、目录拉取失败的退化、成功后 close、无父模型、send 120s / create 180s 的 deadline，用 fake timers）。`tests/sdk-message-handler.test.ts` 新增 `subagent → task` 改写 describe（running / 长 prompt / completed 外壳 / `isError` / 其它 MCP 不动）；`tests/subagent-spec.test.ts` 同步工具中性的报错文案。
- **真实 SDK 验证**（走生产代码路径：`Agent` facade → `subagent` customTool → 子 agent；用临时测试脚本跑完已删）：Sonnet 5.5 + `reasoning_effort: low` 的子 agent 自报「Claude Sonnet 5.5」；`list` / 无效模型 / 无效 effort 各返回带可选项的提示；`explore` 能读不能写、`general` 能写；**父 `run.cancel()` 约 46–58ms 内连子 agent 和它起的 shell 进程一起停掉**，取消后同一个 agent 的下一轮正常；resume 出来的 agent 同样联动；`agent.close()` 能停掉正在跑的子 agent（Proxy 版 5/5）。
- **变异验证**：`cursor-subagent` 主体 19 个变异全部被抓（M1–M20，含 Proxy 相关：`this` 没绑定 / `send` 返回的 run 没包 / `asyncDispose` 没联动 / 冻结对象被代理）；⚠ 其中 M15「resume 不挂联动」第一次**没被抓**，补了 resume 的 wiring 用例后红了。真实依赖工厂另做 6 个：子 agent 不去 `task`（可递归）/ 加载 `.cursor/` 设置 / send 无 deadline / create 无 deadline / `explore` 用黑名单替白名单 → 5 个被抓；「父模型 context 不剥」没被抓，**是等价变异**（`createChild` 创建时本来就再剥一次，提前剥只是冗余）。每个跑完核对源码已还原。
- **验证（最终）**：`tsc` 0 错误；`eslint`（所有改动 / 新增文件）0 错误 0 警告；**全量 vitest：353 个文件通过（1 个跳过）/ 4820 个用例通过（3 个跳过），0 失败**。⚠ 与上一节 346 / 4684 的差值不全是本次新增（工作区里还有其它未提交改动带来的测试）。中途有过一次 8 个用例失败（原地替换 `cancel` / `close` 的版本，见上），已改 Proxy 并全量重跑确认。
- **Cursor 路径没验证 / 已知限制**：⚠ ① **没在浏览器里看**：界面只验证到 handler 层（用真实形状的事件喂 `handleSdkMessage`），`TaskSubagentBlock` 在真实页面上的渲染没看。② **模型会不会真的优先选 `subagent` 而不是原生 `task`**——只靠提示词与工具描述引导，没批量跑真实模型统计；模型选了原生 `task` 就还是 composer 系。〔更新：这条风险已消除——原生 `task` 在挂了 `subagent` 的会话里已关，见下一节；但「关得是否真生效」没实测〕③ 子 agent 创建 / 发送挂死的 deadline 只用 fake timers 验证过，没造真实挂死。④ **没有并发上限**：模型一口气派很多个 `subagent` 会同时起很多子 agent（实验③证明并行可行，但没限流）。⑤ **子 agent 的过程不进父会话事件流**，用户只看到「子代理工作中」到最后的结果文本（与 pi 路径一致）。⑥ customTool 回调拿不到 `AbortSignal`，联动完全靠 Proxy 包 agent / run 的 `cancel` / `close`——SDK 以后改了 `send` / `cancel` 的形状可能失效，wiring 测试会拦住大部分。⑦ 目录来自 `listModelOptions({kind:"cursor"})`，拿不到时退化成不校验 model id（子 agent 创建时由 Cursor 端报错）。
- **回退**：去掉 `agent-backend.ts: attachFlowshipTools` 里 `subagent` 的创建与 `attach`（以及 `flowship-tools.ts` 的 `extraTools` 参数）即可让 Cursor 会话回到「只有原生 `task`」；`sdk-message-handler.ts` 顶部的 `toSubagentDisplayCall` 一行可一并去掉（不去也无害，没有 `subagent` 事件时它什么都不改）；`subagent-spec.ts` / `model-catalog.ts` 是 pi 与 Cursor 共用的，保留。回退时要连 `tests/cursor-subagent*.test.ts` 一起处理。
- **没提交、没打包**（按约定）。

#### 同版：Cursor 路径关掉 SDK 原生 `task`、`subagent` 加 `resume`、卡片徽标显示实际模型（用户拍板，2026-10-13）

> 起因：用户先看到子代理卡片上写着 `inherit`、原生 `task` 还留着，问「是不是把 SDK 原生方法禁用了好点」「我们自己封装的能不能把原生的功能封进去」，随后拍板「把 cursor sdk 的原生 subagents 去掉，然后把我们自己封装的再完善下」。**这一节推翻上一节「`subagent` 与原生 `task` 共存」的结论**（上一节的描述保留作历史，见各处〔更新〕标注）。同时按用户要求删掉了 `.cursor/rules/subagent-no-fast.mdc`（既不拦 fast、也没有规则约束）。

- **1. 关掉原生 `task`**：`agent-backend.ts: attachFlowshipTools` 在挂 `subagent` 的**同一处**把 `"task"` 加进 `disallowedTools`（`cursor-subagent.ts: withNativeTaskDisabled`：保留调用方已有项、去重、不改入参）。`Agent.create` 与 `Agent.resume` 都经过这里——SDK 的 `disallowedTools` **不持久化**，只在 create 传的话恢复出来的会话会重新长出原生 `task`。**只在挂了 `subagent` 时才关**：没有 `callerToken` 的 oneshot / 受限答疑、只读轮次没有 `subagent`，原生 `task` 原样（没有替代品就不能去掉）。依据：`AgentOptions.disallowedTools` 的类型文档写明 “Disallow "task" to prevent subagents entirely”，且 `"task"` 是合法 `ToolName`（未知名会抛 `ConfigurationError`，读 bundled 源码确认）。子 agent 自己原本就带 `disallowedTools:["task"]` 防递归，现在与父会话共用 `withNativeTaskDisabled`。
- **2. `subagent` 加 `resume`（只 Cursor；pi 的 `task` 明确不支持）**：
  - 入参 `resume: "<agentId>"`：成功结果末尾附 `[子代理 <id> · <实际模型 (思考档)>]` + 怎么 resume 的一句话（`formatSubagentTrailer`）；之后模型再调 `subagent` 传 `resume` + 新 `prompt` 就接着那个子代理（它记得之前的上下文，不用重讲背景）。**失败 / 取消的不登记、不给 id**（状态不确定，不鼓励接着做）。
  - **范围 = 本父会话派出的**：登记表 `globalThis.__flowshipSubagentResumables`（父 agentId → 子 agentId → `{ model, explore, busy }`）。**不做「任何 agentId 都能 resume」**——模型能传任意字符串，那样等于能把别的任务 / 别的会话的 agent 当子代理接上。父 agentId 取自 `attach(agent).agentId`，所以同一会话被恢复成新实例后能接着之前派的。进程内存：**应用重启后接不上**，报「找不到子代理」让模型另起；容量 64 个父会话 × 32 个子代理，LRU 淘汰；resume 过的刷新为最近使用。
  - **填错直接报错、不静默当成新任务**：id 不认识 / 不是本会话的、`model` / `effort` 与当初不同（`model: "inherit"` 等于没填，允许）、`subagentType` 与当初不一致、同一个子代理还在跑（同时只允许一个 run，占位是同步的、跑完 `finally` 释放）、环境没提供 `resumeChild`。`Agent.resume` 本身失败（会话记录被清了等）→ 忘掉这条登记 + 提示另起。
  - **resume 时选项必须原样再传一份**：`createChild` / `resumeChild` 共用 `childAgentOptions`（模型沿用登记的、`explore` 的 `tools` 白名单 / 其余的 `disallowedTools:["task"]` 都再传）。`tools` / `disallowedTools` 不持久化，resume 不传的话**只读（explore）子代理接回来就拿到写权限**。
  - pi 侧：`task` 的 schema 里没有 `resume`（共享的 `SUBAGENT_INPUT_JSON_SCHEMA` 一个字没动，Cursor 版另在它上面加了一项）；模型从 Cursor 习惯带来传了，`pi-coding-tools.ts` 抛 `SubagentUsageError`「不支持 resume」，不静默当新任务跑。
  - 能 resume 的前提（读代码得出、**未实测**）：父子 agent 共用进程级 SDK JSONL store（`withCursorJsonlStore`），GC（`planOrphans`）保留活跃 / 近期 agent，所以进程存活期内子 agent 的会话记录还在。
- **3. 卡片徽标显示实际生效的模型 / 思考档，不再只是 `inherit`**：`tool_call` 的 args **只在 `running` 时落盘一次**（completed 只写 `tool_result`），所以只能在写事件之前改。链路：facade `attach` 把父模型登记到返回给调用方的（包装后的）agent 上（新模块 `subagent-parent-model.ts`，globalThis 上的 WeakMap；**单拆一个无依赖模块**是因为 runner 的测试普遍 mock 掉 `agent-backend`，读方不能从那里取）→ `task-runner` / `chat-runner` 的流消费 ctx 带 `subagentParentModel` → `handleSdkMessage` 把它交给 `toSubagentDisplayCall(msg, { parentModel })`。规则：`model` 缺省 / inherit → 父模型 id；模型沿用且 `effort` 没填 → 父会话当前的思考档（`currentEffortValue`，开关 / default 不硬造档位）；显式写了的原样；**resume 调用不改写**（接着的是之前那个子代理，它当初用什么这里不知道）。只改展示副本，工具真实入参不动。**pi 路径没有这条**：pi 的 `task` 事件不经 `toSubagentDisplayCall`，徽标仍是模型传的原值。
- **4. 描述 / 提示词**：`CURSOR_SUBAGENT_DESCRIPTION` 不再写「与原生 task 的区别」（它已被关掉），改写并行与 resume 用法；`prompts/_super.md` 的工具表把 `task`（自研）/ `subagent`（Cursor）合并成「用会话里有的那个」，另起一条讲 `resume`（并写明 `task` 没有）。
- **明确没做**（用户确认不需要）：`run_in_background`（后台跑）〔更新：随后用户要「派了子代理后还能和主 AI 继续聊」，后台运行已做、仅 chat 会话，见下一节〕、`fork`、attachments、更多 `subagentType`；子 agent 的过程仍不进父会话事件流（与 pi 一致）。同一轮并行派多个本来就行（customTool 并发执行，上一节实验③）。
- **验证**：`tsc` 0 错误；`eslint`（所有改动 / 新增文件）0 错误 0 警告；**全量 vitest 410 个文件 / 5928 个用例通过（3 个跳过）**（与最初 365 / 4973 的差值不全是本次新增，工作区里还有别人的未提交改动与测试）。本次新增 / 改的测试：`cursor-subagent`（resume 全套：成功给 id、沿用模型 / explore、归属、并发 busy、失败不登记、取消、容量 LRU、`withNativeTaskDisabled`、尾注、父模型登记）、`cursor-subagent-wiring`（create / resume 都关 task、保留已有 disallowedTools、没挂 subagent 不动、父模型可查）、`cursor-subagent-session`（`Agent.resume` 的选项与 create 同口径、explore 仍只读、换过模型沿用、resume 抛错 / 挂死的处理）、`cursor-subagent-display`（徽标规则 9 条）、`subagent-spec`、`pi-coding-tools`（pi 拒绝 resume）、`sdk-message-handler`（徽标落盘）、新增 `subagent-parent-model`（模块 + 接线契约）。**变异验证 16 个全部被抓**（归属不校验 / 不置 busy / busy 不释放 / 失败也登记 / explore 不沿用 / resume 失败不忘 / 选项不共用 / 不关原生 task / 丢已有 disallowedTools / pi 不拒 / handler 不传父模型 / 徽标两条规则 / attach 不登记 / parentKey 不绑 id / 容量不淘汰），每个跑完核对源码已还原。
- **真实 SDK 实测（2026-10-14，用户授权使用设置里的 key；临时脚本跑完已删、SDK 存储走临时目录、没碰正式数据；父 / 子模型用 `composer-2.5`，徽标那条另用 Sonnet 5.5 + `reasoning_effort=low`）**：① **关原生 task 生效**：同一句「用 task 工具派子代理」，不关 → 调了原生 `task`（对照），`disallowedTools:["task"]` → 一次 `task` 调用都没有、模型回 `NO_TASK_TOOL`。② **resume 真能接上上下文**：走生产工厂 `createCursorSubagentLinkForSession`，先让子代理记住暗号、`resume` 后它答出了暗号；`explore` 子代理接回来仍写不了文件（文件确实没建出来）；另一个 link 拿同一个 id `resume` → 「找不到子代理」。③ **facade 全链路**：Agent facade 建的父会话里没有原生 `task` 调用、`subagent` 被调用、父模型已登记；第二轮让模型「接着问同一个子代理」，**模型自己传了正确的 `resume` id**（只靠描述 + 结果尾注引导，没给 id）。④ **徽标**：Sonnet 5.5 + `reasoning_effort=low` 的父会话里，模型传的是 `model:"inherit"`，卡片 args 变成 `claude-sonnet-5-5` / `effort:"low"`；结果尾注 `claude-sonnet-5-5 (reasoning_effort=low)`。**仍没做的**：没在浏览器里看卡片渲染；pi 路径徽标没改。另：既有行为（非本次引入、没改）——沿用父模型但**目录里查不到父模型条目**时，写 `effort` 会走通用参数 id `thinking`，可能与父的 `reasoning_effort` 并存（`resolveSubagentModel`）。
- **回退**：去掉 `attachFlowshipTools` 里 `disallowedTools: withNativeTaskDisabled(...)` 一行 → 原生 `task` 回来（与上一节的「共存」状态一致；此时 `CURSOR_SUBAGENT_DESCRIPTION` / `_super.md` 里「原生 task 已关」的话要改回去）。resume：删 `cursor-subagent.ts` 的登记表 / `resumeChild` / schema 的 `resume`，`subagent-spec.ts` 的 `resume` 字段与 pi 的拒绝可留（无害）。徽标：`sdk-message-handler.ts` 去掉 `toSubagentDisplayCall` 的第二个参数即可。
- **没提交、没打包**（按约定）。

#### 同版：队列「立即发送」改成 steer 进当前这一轮 + 子代理后台运行 + 编辑已发送消息改成「替换」（用户拍板，2026-10-14）

> 起因：用户问「主 AI 派了 3 个子代理在干活，我还能插话吗？Cursor IDE 可以」，又说「现在排队顶上去其实只是把之前的暂停了、重新发一遍；编辑消息也是重新发新的，我想像 Codex / Cursor IDE 那样自然一点」。根因有两层：① 主 AI 卡在 `subagent` 阻塞的工具回调里，**没有哪条消息能到它手上**；② 「立即发送」是 停止 → 关会话 → 重开 → 重发，会把正在跑的一轮（含子代理）整个打断。

- **B. 「立即发送」= steer（Codex / Cursor IDE 式插话）**：`chat-queue-send-now.ts` 入口 `deps.steer?.canSteer(taskId)` 命中就走 `steerQueuedMessage`——**不停止、不重开会话**，把话插进正在跑的这一轮，AI 在当前步骤（工具调用 / 一段输出）结束后读到并转向。
  - 依据（真 SDK 实测，`@cursor/sdk` 1.0.37）：`Run.steer(text)` 返回 `"complete_delivered" | "revert_to_followup"`；**它的 Promise 要等这一轮真正收下这条消息才 resolve（主 AI 卡在慢工具里就要等工具返回）**；对已结束的 run steer → `revert_to_followup`（不抛）；steer 之后上下文延续。
  - 所以 **HTTP 不能等 `run.steer`**：先落 `user_reply`（落之前先 `flushChatAssistantBuffer`，免得半截回复排到用户插话后面）→ fire-and-forget steer → 结果经队列状态给 `message_op` 推 handedOff / failed；**不占在途队列槽**（否则后面的消息被它挡住）；`getChatQueueGeneration` 代数在停止 / 回退后让迟到的 steer 结果作废；steer 被退回（`revert_to_followup`）= 不丢，按下一轮发。
  - **回退旧流程（打断重发）的情况**：pi 自研后端（`PiRunAdapter` 没有 `steer`）、冷启动中（还没拿到 run 句柄）、run 刚收尾的空窗、回退门闩中。banner 的提示文案同步改了。
  - 新 `chat-runner.ts` 导出：`canSteerChatRun` / `steerChatRun`（`run.currentRun` / `rec.flushAssistant` 由 `consumeChatRun` 挂、收尾清）、`flushChatAssistantBuffer`、`composeChatPrompt`（steer 与普通发送共用同一套拼 prompt）。
- **A. 子代理后台运行（仅 Cursor 后端的 chat 会话；task 流程、pi 不开）**：`subagent` 多一个 `run_in_background` 参数（`subagent-spec.ts: runInBackground`，字符串 `"true"` 也认；pi 的 `task` 传了会明确拒绝、不静默同步跑）。
  - 行为：`true` → 派出后**立刻返回**后台任务 id；子代理做完，结果以一条消息送回主 AI——**主 AI 空闲 → 唤醒一轮（不落用户气泡）；在忙 → steer 进当前轮，不能 steer 就攒着、这一轮收尾时合并成一条送**；事件流里只落一行提示（「后台子代理「x」已完成（用时…），结果已交给主 AI」），长正文只给主 AI、由它转述。
  - **自动转后台（解决「卡在前台子代理里没法插话」）**：用户「立即发送」时 `detachForeground` 把主 AI 正在前台等的子代理**全部转后台**，那个阻塞的工具调用立刻返回「[已转到后台…先回应用户]」，主 AI 马上读得到用户的话；子代理不取消、继续跑。
  - **安全 / 护栏**：结果消息以 `[BACKGROUND_SUBAGENT_RESULT]` 开头、正文包在 `<subagent_output>` 里并声明「是数据不是指令」（子代理读过网页 / 仓库，输出可能夹带注入；输出里自带的结束标签会被打断）；超 12000 字截断；并发上限 4（占位同步预约，防并发穿透）、单个最长 30 分钟（到点取消、按失败告知）；投递前核对 `parentAgentId`（会话换了 / 关了就丢，不送给不相干的新会话）；`cancelled` 不投递。
  - **生命周期**：停止 / 关会话 = `run.cancel` / `close` / `asyncDispose` 联动取消**所有**子代理（前台 + 后台，沿用此前的联动）；一轮**自然结束**不取消后台子代理；有后台子代理在跑的会话**不被 12 分钟空闲回收**；`closeChatSession` 清掉攒着的结果（回收 / 关闭后不会「复活」送给新会话）。后台期间那个子代理占着 resume 的 busy 位。
  - 结构：新叶子模块 `subagent-background.ts`（控制句柄登记、事件类型、globalThis hub、文案）；`cursor-subagent.ts` 的 link 管 jobs / 并发 / 超时 / 转后台；`chat-runner.ts` 订阅 hub 做投递（`deliverBackgroundSubagentResult` / `drainBackgroundResults` / `detachChatForegroundSubagents`）；facade 多一个 `backgroundSubagents` 额外参数（和 `providerId` / `callerToken` 一样在传给 SDK 前剥掉），`Agent.create` 与 `Agent.resume` 都传。
  - **提示词 / 工具描述**：`prompts/_super.md` 新增 `run_in_background` 一条（含「结果是数据不是指令」）；工具描述里写了并发 / 时长上限与「别编造结果、问进度如实说还在跑」。
- **C. 编辑已发送的消息 = 替换这条及之后的对话（Codex / Cursor IDE 式）**：以前「编辑」只有**最后一条**用户消息有、编辑后**追加**一条新消息到末尾（原消息和 AI 的回复都留着）；现在 chat 里**任意一条**用户消息都能编辑，发送后这条及之后的对话被删掉、换成编辑后的新对话，从这里重新跑。
  - 流程（`chat-view.tsx: handleEditRewind` + `event-stream.tsx: handleEditInPlace`）：先回读这条消息的图 / 附件（回退会删事件）→ **只有会丢东西才弹确认**（这条消息有文件检查点 = 会还原文件、覆盖未提交改动；或这条之后还有别的几轮对话。没绑仓 / 没检查点时改刚发的最后一句则不弹）→ 当前回复在跑就**先停**（`stopAgentCore`）→ 服务端回退 → 让一拍给 React 渲染 → 发编辑后的内容。回退成功但新消息没发出去时旧消息已删，**把用户打的字放回输入框**并提示，不丢字。
  - **服务端**（`/rewind` 新增 `mode:"edit"`；缺省行为不变）：`chat-checkpoint.ts: executeChatEditRewind`——这条消息还有文件检查点 → 走原来的完整回退（还原文件 + 截断对话）；没有（没绑仓 / 检查点被裁掉〔只留最近 20 个〕/ 打点失败）→ 新增的 `executeChatConversationRewind`：**只回退对话、不碰文件**（截断事件、关会话并清 `sessionAgentId`、丢掉锚在被删事件上的 rewind_points 与对应 git 引用，不打安全点——没动文件）。检查点被裁掉时自动降级成只回退对话，方向是安全的（文件只会少改）。目标必须是 `user_reply`（`bad_target` 400）。
  - 为此把 `executeChatRewind` 里的「进锁前检查」「锁内复查（+清排队）」「收尾（写回退标记 + 读最新 task、失败不报错）」抽成三个共用函数（`assertRewindPreflight` / `assertRewindIdleLocked` / `finishRewind`），**原函数行为不变**（原有 rewind 测试全绿）；新函数共用同一套门闩 / 复查 / 收尾，区别只在没有文件操作与回滚——截断之前没有任何改动（原子写、失败即原样），截断之后的记账全部前滚、绝不让已提交的回退报错。
  - 回退标记照常写进事件流（info 行「已回退到这条消息之前的对话（文件未改动）」，meta 带标记，客户端据此截断本地窗口，复用既有机制）。
  - 没接 `onEditRewind` 的 `EventStream`（task 模式等）仍是旧语义；「原样重发」「重新生成」不变（仍是追加、只给最后一条）；「回退到这里」按钮不变。
  - 新文件 `src/lib/edit-rewind.ts`（纯函数：`planEditRewind` / `editRewindConfirmCopy`）。
- **明确没做**：① 子代理的**单独取消按钮 / 状态条**（界面上只有那行信息；要取消只能整体「停止」，会停掉所有子代理）；② 后台结果不进「待办 / banner」；③ `fork`、attachments、更多 `subagentType`（仍不需要）；④ pi 后端的「立即发送」仍是旧的打断重发；⑤ 编辑消息**没有「只改对话、保留文件」的选项**（有检查点就一律还原文件，对齐 Cursor；要保留文件得先手动备份或不要编辑那条）；⑥ 编辑时附件 / 图片只在文本框里编辑文字，原附件原样带上（不能在编辑态增删）。
- **测试**（新增 4 个文件、改 4 个）：`tests/chat-steer.test.ts`（17，`steerChatRun` / `canSteerChatRun`：退回 followup、run 先结束的宽限、会话被替换、同步抛错…）、`tests/chat-queue-send-now.test.ts`（+12 steer 用例：顺序 flush→落盘→steer、不占槽、失败 / 退回 / 代数失效、回退旧流程的各情形）、`tests/cursor-subagent-background.test.ts`（27，link 层：立即返回、并发预约、超时、转后台、取消联动、resume busy）、`tests/subagent-background.test.ts`（11，文案 / 截断 / 标签打断 / hub / 句柄）、`tests/chat-background-subagents.test.ts`（15，**真实 chat-runner + 真实 link + 假 SDK**：schema 带参数（resume 与 create 两条路径）、插话→转后台→steer、空闲唤醒 / 忙时攒着 / steer 退回 / 失败回告、取消 / 换会话 / 关会话 / send 失败后不复活、回收放过后台会话）、`subagent-spec`（`run_in_background` 解析）、`pi-coding-tools`（pi 拒绝）；C：`tests/chat-edit-rewind.test.ts`（17，真实文件系统 + 真实 git：只回退对话不动文件 / 点与 git 引用的清理 / 门闩与各种 run_active / 前滚 / 有无检查点的分流）、`tests/edit-rewind.test.ts`（15，纯函数 + 源码接线契约）、`tests/rewind-route.test.ts`（8，含 `mode` 分发 / 未知 mode 400）。
- **变异验证**：B（steer）17 个全部被抓；A 31 个——**第一轮 4 个没被抓**（`cancelled` 也投递 / 关会话不清攒着的结果 / `Agent.create` 路径没开后台 / `putBack` 不看会话还在不在），逐个补用例后全部被抓；C 服务端 12 个、客户端 13 个——**服务端 2 个第一轮没被抓**（`hasCheckpoint` 不排除 `pre_rewind` 点：测试用的假 oid 被解析器当成非法丢掉了、用例其实没触发；被丢检查点的 git 引用不清），换成合法 oid / 加了 git 引用断言后被抓；客户端那 13 个靠源码契约，只能证明接线没被改掉、证明不了渲染对；每个跑完核对源码已还原。
- **真实 SDK 实测（用户授权用设置里的 key；临时测试文件跑完已删、数据走临时目录；模型 `composer-2.5`）**：① **后台派出**：主 AI 调 `subagent(run_in_background:true)` → 工具秒回「已在后台启动…」→ 主 AI 回「已派出」收尾 → 子代理 5 秒做完 → 事件流出现提示行 → **主 AI 被唤醒一轮、转述了结果**（「后台完成」）；全程没有额外用户气泡。② **插话转后台**：主 AI 前台派了个 `sleep 40` 的子代理，3 秒后「立即发送」「17+25 等于几」→ 响应 `steered:true`，事件顺序 `tool_call → user_reply → tool_result(已转到后台) → assistant「42」`，**从点发送到主 AI 答出 ≈3 秒**（没转后台的话要等 40 秒）；子代理继续跑完（46 秒）、结果随后送回、主 AI 转述。③ **编辑消息**（真 SDK + 真 `executeChatEditRewind`、没绑仓）：先后发「记住暗号 ALPHA」「再记住暗号 BETA」，把第 2 条编辑成「GAMMA」→ 事件里 BETA 没了、会话已关 → 新会话从截断后的历史开始 → 问「记得哪些暗号」答 **「ALPHA, GAMMA」**（BETA 不记得，说明被删的内容不会通过旧会话泄回来）。
- **验证**：`tsc` 0 错误；`eslint`（本节改动 / 新增文件）0 错误 0 警告；**全量 vitest 414 个文件 / 6016 个用例通过（3 个跳过）、0 失败**；加上 C 之后重跑：**416 个文件 / 6052 个用例通过（3 个跳过）、0 失败**，tsc / eslint 干净。
- **没验证**：⚠ ① 没在浏览器里看（队列 banner 文案、子代理卡片在「转后台」时的呈现）；② 只实测了 Cursor 路径的 composer-2.5，没测 Sonnet 等其它模型会不会正确使用 `run_in_background`（只靠工具描述 + 提示词引导）；③ 多个后台子代理同时收尾的合并投递只有单测（假 SDK）、没在真 SDK 上造；④ 应用重启后后台子代理随进程消失（和 resume 登记表一样是进程内存），主 AI 不会收到结果。
- **回退**：B：`chat-queue-send-now.ts` 去掉 `deps.steer` 分支（不传 `steer` 依赖即回到旧流程）；A：facade 不传 `backgroundSubagents`（`agent-backend.ts: attachFlowshipTools`）即让会话回到「只有前台子代理」，`chat-runner.ts` 的投递代码留着无害；回退时连 `tests/chat-steer.test.ts` / `chat-background-subagents.test.ts` / `cursor-subagent-background.test.ts` / `subagent-background.test.ts` 一起处理。
- **没提交、没打包**（按约定）。

#### 同版：全项目审查 → 逐项确诊 → 只修确诊的（用户要求，2026-10-13）

> 起因：用户让我审查整个项目找可优化点，随后要求「确诊过的话就全部都改」。做法：5 个只读探索子代理出清单 → **我逐条读代码核实**（子代理的"高"里有不少其实是文件头写明的设计取舍或已被兜住的误报）→ 只改确诊为真的、其余不动并写明原因。**没有提交 / 打包 / 动正式或测试 app**；没用浏览器看界面。

- **已修（6 项）**
  1. **`run.wait()` 无上限**（`task-runner.ts` / `chat-runner.ts`）：取消（用户停止 / 24h 硬超时 / 中途轮换）后若 SDK 的 `wait()` 永不返回，这一轮的收尾（解锁、状态落盘、释放会话槽）会一直卡住、任务假死「运行中」。新增 `src/lib/server/run-wait.ts: createCancelEscape`——在**每个** `run.cancel()` 处 `arm()`，取消后 30s（`CANCEL_WAIT_GRACE_MS`）`wait()` 还没回就当 `cancelled` 放行并 `console.warn`；正常结束 / 没取消时一点不影响（计时只在「已取消且正在等」时才走，`hardTimer` 改成覆盖到 `wait()` 结束才清）。
  2. **`ask-reply` / `advance` 热路径全量读事件 + 响应体带全量事件**：这两条路由每次 `getTask` 把整份 `events.jsonl` 解析进内存、响应又整份回给客户端。改为：入口用 `getTaskMeta`（不读事件）/ 尾部窗口（`ASK_DECISION_TAIL = 200`，窗口里找不到该 ask 才回退全量读，`hasAskRequestEvent` 新增在 `ask-pending.ts`）；响应用 `getTaskWithTailEvents(id, 300)`。客户端 `mergeTaskEvents` 本来只吸收比本地最后一条更新的事件、丢更旧的，所以不需要全量。`repo-files` / `preview` / `branches` 三个根本不用事件的路由 `getTask` → `getTaskMeta`。
  3. **`readEventsBefore`（往回翻历史）永远从文件头流式扫到锚点**：翻最近几页也要读几乎整个文件。改为**反向分块扫**（`scanLinesBackward`：按字节找 `\n` 再整行解码，不会被 64KB 块边界切断 UTF-8 多字节；跨块长行靠 carry 拼接）+ 连续翻页时下一页锚点的**行首偏移缓存**（`anchorOffsetCache`，256 条 LRU，键 `taskId+eventId`）直接 seek。缓存只是提示：用前必校验（前一字节是 `\n` 且那一行 parse 出来的 id 就是锚点），对不上就退回扫描，不会翻出错页。语义与旧实现逐条一致（返回原始行解析的事件、坏行 / 半行跳过、锚点不存在 → 空页）；前提是事件 id 文件内唯一（`appendEvent` 契约「一个 id 只落一条」；反向命中的是最后一次出现、旧实现是第一次，唯一时等价）。
  4. **产物面板把「拉取失败」显示成「没有产物」**（`artifact-panel.tsx`）：`fetchActionRevisions` 失败且退避重试耗尽后只 `console.warn`，落到 `!currentArtifact` 分支。现在最终失败落 `loadError`，空态分支显示「加载产物失败：… + 重试」（与同文件修订对比失败态同一套样式）；重试中保持 loading 不闪错误；已有旧正文时仍显示旧正文。
  5. **违反 UI 约定的小字号 / 文字透明度**：`group-qa-panel.tsx` 4 处 `text-[10px]`（约定「⛔ 不许再出现 10px」）→ `text-[11px]`，3 处文字 `/60` `/70` → 中性 `text-muted-foreground`；`task-list-item.tsx` 的阶段文字 `/70`、相对时间 `/50` 同改（装饰分隔点与行首图标按约定允许 alpha，没动）。
  6. **`.cursor/rules/project-context.mdc` 的陈旧行数**：HANDOFF「~300 行」（实际 ~800）、CHANGELOG「~2000 行」（实际数千）→ 改成「以 `wc -l` 为准、按需跳读」。
- **核实后没改（子代理报了、我读代码后判断不该改 / 不是问题）**
  - **重启后 chat 队列不对账**：队列纯内存是设计（只在 run 进行时存在，重启时 boot-recovery 已把该轮标 error 并提示重新发起）；客户端 `chat-pending-reconcile.ts:576-583` 已专门处理「服务端重启丢 ledger」——fail-closed 标「发送状态未知」、可同 id 重试，绝不误标已送达。
  - **后置检查环境异常报通过**（`action-checks.ts`）：文件头明写的「软兜底」设计（检查是提示不是闸门）；且 UI 只在 `passed===false` 时渲染红条、通过态本来就不显示任何绿条，所以「报通过」的实际效果是「不提示」。改三态要动类型 + 两处 UI，收益低。
  - **meegle / lark CLI 串行队列「排队不计超时」**：文件头写明是有意的（否则排在慢调用后面的无辜请求会被误杀；凭据文件并发 refresh 会撞毁 → 等效登出，凭据安全 > 速度）。队列槽永不 settle 只在子进程忽略 SIGTERM 时才会发生，没有实际证据。
  - **ask 待答时推进按钮被隐藏**：有意（注释写明会绕开答题打断会话语境），底部输入条已有「可先答上方提问」提示。**「合并后删除源分支」要二次确认**：它是 dialog 内显式开关、默认关，提交还要点「推进」，再加确认过度。**列表行不标 error 状态**：文件头写明是用户实测后要求的降噪（「有了那么多状态反而更杂乱」）。**`stickyReady`**：用户拍板的设计，飞书真掉登录靠看板降级态兜底。
  - **`mcp-oauth` 回调 `postMessage(…, "*")`**：载荷只有 `{type, ok}` 无敏感信息；回调 host（`localhost`）与用户访问 host（`127.0.0.1`）常不一致，硬改成 `window.location.origin` 可能让自动刷新静默失效，收益近零。**`git checkout b` 缺 `--`**：`git-branches.ts` 已在前面拒绝 `-` 开头的分支名（误报）。
  - **`cursor-feedback` 规则「过期」/ `learned-conventions` 与 AGENTS.md「矛盾」**：是用户为 IDE 里开发本仓库立的工作流规则，三处互相一致，`prompts/_super.md:35` 也声明不适用于 Flowship 自带 agent；与 AGENTS.md 没有实质冲突。
- **追加：全仓文字透明度一次清完（用户确认「都改了、有问题再说」，同日）**：20 个文件里的「文字 + `/40~/80`」全部改成不带 alpha 的 `text-muted-foreground` / `text-foreground` / `text-destructive` / `text-primary`——`task-list-item`、`artifact-panel`（文件名）、`branch-switcher`、`model-select`、`advance-dialog`（两个开关标签）、`app-sidebar`（分组标题 + 「显示更多」）、`company-env-card`、`preference-card`、`custom-provider-card`、`setup-checklist`（提示行）、`action-layout-config`、`action-timeline`（`#n` 序号 / `…` 省略块）、`workspace-actions`、`context-docs-panel`、`search-dialog`、`mcp-toggle-list` / `mcp-card`（禁用项名字，仍保留删除线）、`board-timeline`（周几）、`markdown-link`、`batch-plan-table`。**保留 alpha 的只有图标 / 装饰**（约定允许）：`Info` / `Chevron` / `Circle` / `Loader2` / `Plug` / `Sparkles` 图标、`·` 与面包屑 `/` 分隔符、拖拽把手、垃圾桶图标按钮。范围按约定点名的 `/40~/80`，`/85`、`/90`（`text-foreground/90`、`text-destructive/90`、`text-foreground/85`）对比度没问题、没动。**会看到的视觉变化**：这些次要文字整体从「更淡」变成「标准次要灰」，对比度从 2.2~3.3:1 提到 6.5:1；侧栏任务行（原 `text-foreground/75`）和分组标题（原 `/80`）略深，且因基色已等于 hover 色，去掉了冗余的 `hover:text-foreground`（hover 仍有底色反馈）。新增 `tests/ui-text-alpha-contract.test.ts`（2）全 src 守「文字不许 `/40~/80`」，放行按标签级白名单（图标 / 分隔符 / 把手 / 注释）、带自检用例；变异（把一处改回 `/70`）能抓到。⚠ **没在浏览器里看**，上面「视觉变化」是按 class 推断，不是实测。回退：`git diff` 看这 20 个文件里 `text-*` 的变化逐处还原，并删掉守卫测试。
- **没改、留给用户决定**：① 详情页分栏 `minSize="20%"` 在窄窗太小——改像素下限会和已持久化的分栏比例 / `react-resizable-panels` 约束求解相互作用，没法浏览器验证就不动；② ~~全仓文字叠 `/40~/80` 透明度~~——已在用户确认「都改了、有问题再说」后清掉，见下一条；③ 大重构类（`task-runner.ts` ~6200 行拆分、events 索引 / 归档、任务列表搜索索引、fsync 策略）、本地 API 无 token / 无 Origin 放行的 loopback 取舍、`restricted` 旁路、预览 `shell:true`、mac 签名——都是已知取舍或大改动，不在「确诊小修」范围。
- **测试**（新增 6 个文件、改 1 个）：`tests/run-wait.test.ts`（11）、`tests/ask-reply-tail-read.test.ts`（10）、`tests/meta-only-routes.test.ts`（6）、`tests/events-before-reverse.test.ts`（14：与全量读逐条差分——含多字节 / 超长行跨 64KB 块 / 空行 / 坏行 / CRLF / 末尾崩溃半行 × 多种锚点 × 多种 limit × 冷热缓存；连续翻页拼起来 = 全量历史；8MB 文件翻 20 页的读取字节远小于文件大小；缓存陈旧——重写 / 偏移后移 / 等长行删头部 / 截断 / 跨任务——都退回扫描且结果与全量读一致）、`tests/artifact-load-error-contract.test.ts`（5）、`tests/ui-min-font-size-contract.test.ts`（3，全 src 守「不许 ≤10px」）；改 `tests/ask-reply-skill-split.test.ts`（补 `getTaskMeta` / `getTaskWithTailEvents` mock）。
- **变异验证**：`run-wait` 的变异——W2 第一次**没被抓**（补了「`wait()` 之前 `arm()` 不起计时」断言后红）、W3/W4/W6 单独是等价变异（`Promise.race` 已订阅 real、`dispose` 双重保护），W4+W6 一起红；`ask-reply` 的变异——M4「唤醒路径响应全量读」第一次没被抓（只测了主路径），补了僵尸唤醒用例后红。`readEventsBefore` 12 个变异：**M1「缓存校验恒真」第一次存活**——原因是「前一字节是 `\n`」与「行 id 匹配」两道检查互相掩护（我的重写用例让偏移落在行中间，被第一道拦下），补了「等长行删头部、偏移仍是行首但已是别的事件」的用例后红；M8（去掉行首校验）/ M11（去掉越界判断）/ M12（缓存键不含任务）是**纵深防御的等价变异**（单独去掉任一道都由另一道兜底；M12 的跨任务串号由行 id 校验兜住）。产物面板契约 5 个变异全抓；字号守卫 1 个变异抓。每个变异跑完都核对源码已还原。
- **验证**：`tsc` 0 错误；`eslint`（本段改动 / 新增的全部文件）0 错误；**全量 vitest：362 个文件通过（1 个跳过）/ 4941 个用例通过（3 个跳过），0 失败**。⚠ ① 没在浏览器里看：`artifact-panel` 的失败态 / `group-qa-panel` / `task-list-item` 的字号颜色只验证到源码契约，没有真实页面渲染的验证；`advance` / `preview` / `branches` 路由的改动只有推理 + `tsc` + `meta-only-routes` 的 mock 测试，没起服务实际调用。② `readEventsBefore` 的 IO 量是用 `FileHandle.read` 字节数衡量的（页缓存命中时墙钟差距不会像字节数那么大）。③ `run-wait` 的 30s 兜底只用 fake timers 验证过，没造真实挂死的 SDK。
- **回退**：A 删 `run-wait.ts` 并把 `task-runner` / `chat-runner` 里 `cancelEscape.*` 换回直接 `await run.wait()`（`hardTimer` 的清理位置要还原到 `wait()` 之前）；B 把路由里的 `getTaskMeta` / `getTaskWithTailEvents` 换回 `getTask`；C 把 `readEventsBefore` 换回流式向前扫（旧实现在 git 历史里）；G 各自还原对应文件即可。

#### 同版：另一个 AI 对 `v1.9.29..main` 的验收 review → 逐项核实后处理（2026-10-13）

> 起因：上面那批提交 `c943f1b` 推上 `origin/main` 后，用户让另一个 AI 做了整体验收（10 个提交 / 172 个文件），再让我来修。做法同上：**每条先对着代码核实，再决定改不改**。**没提交 / 没打包 / 没动正式或测试 app。**

- **已修（2 项）**
  1. **pi 子代理取消竞态**（中等；`custom-agent-backend.ts` 的 `runPiSubagent`）：session 创建期间用户点了停止，旧代码走 `onAbort()` → `session.abort()`，但此刻 `prompt()` 还没开始，abort 是**空操作**，子代理照常把整轮跑完（Stop 像没按过）。改成直接 `throw new Error("子任务已取消")`、不往下走到 `prompt()`——这个 `if` 与 `prompt` 之间没有 `await`，窗口就此关死；`finally` 照常摘监听 + `dispose` 会话。新增 `tests/pi-subagent-abort.test.ts`（3：创建中途 abort → 抛错且 `prompt` 没被调、`dispose` 一次；进来前已 abort → 不创建会话；正常跑完仍返回结果）。**变异**：改回 `onAbort()` → 第一个用例红（`prompt` 被调了 1 次）。
  2. **`loadEarlier` 多一次重复请求**（低；`event-stream.tsx`）：多批循环里，`latestEventsRef.current` 平时只在渲染时更新，`onPrependEvents(fresh)` 之后下一批立刻开始、`fetchEarlierBatch` 开头同步读 `getCurrent()[0]` 拿到的还是 prepend 前的第一条，会把刚拉到的那页再请求一次（按 id 去重、游标也会越过，所以只是白多一次请求，不出错）。现在 `onPrependEvents(fresh)` 之后同步 `latestEventsRef.current = [...fresh, ...cur]`；下一次渲染会用真实的 `task.events` 覆盖它，不会有偏差。契约测试加 1 条（`tests/earlier-events-wiring-contract.test.ts`），变异（删掉这行）变红。⚠ 只有源码契约、没有真实组件的行为测试（node 环境跑不起 React，见 `vitest.config.ts`）。
- **核实后不成立（没改源码，补了防回归测试）**：**「artifact-panel 重试时没有加载态」**——代码里两条重试路径都有：产物重试 = `loadRetryKey++` → effect 里 `load()` 第一句就是 `setContentLoading(true)`，渲染分支 `contentLoading && !currentArtifact`（「加载产物…」）排在 `loadError` / 空态分支**之前**；修订对比重试 = `setDiffLoading(true)` + `setDiffError(null)`。评审说的「不重置 `contentLoading`」与现状不符。但原契约测试没钉住「加载分支排在错误分支前」，补了 2 条（`tests/artifact-load-error-contract.test.ts`，5 → 7）；变异 2 个（去掉 `setContentLoading(true)` / 去掉 `setDiffError(null)`）都变红。
- **没改（及原因）**
  - **启动清单没接进发版链 → 并行预读在正式包里不生效**（评审标「中等」）：**属实，但是有意的、也没有副作用**。`scripts/gen-boot-manifest.mjs` 文件头明写「先在 Windows 真机验证预读确有收益再接」；`windows-install-startup-rca-2026-10-12.md` 里 25.3s → 2.8s 的那组数据**不是受控对照**（装完 5 秒 vs 78 秒后启动，Defender 的后台扫描会拖慢前者），预读到底值多少还没定论。没有清单时壳只记一行 `[main] prefetch 跳过：没有可用的启动清单` 就返回，不报错、不拖启动。评审给的「要么接上、要么 whats-new 别宣传」——**后者已成立**：`whats-new.ts` 里唯一相关的一条（Windows 第一次打开不再弹「启动超时」）讲的是**首次启动超时放宽**，走 `pickBootTimeoutMs(firstBoot)`，与清单无关。不接的原因：清单**必须在目标平台（Windows 构建机）上产出**（它要拉起打好的 server 录文件路径），我在 Mac 上没法验证这条发版链，接错会直接影响发版。**接入前提**：先做一次受控 A/B（同一个包、装完立刻启动，一次 `FLOWSHIP_NO_PREFETCH=1`、一次不设，对比 `Ready in`），证明有收益再把 `gen-boot-manifest.mjs` 接进 Windows 构建步骤。
  - **安装器可能连弹两次空间不足对话框 / `.fsprobe` 会提前建出安装目录**：NSIS 在 Mac 上编译不了也跑不了，没法验证。双弹窗要靠 UAC 内部实例判断（`UAC_IsInnerInstance`），那个宏是否被 electron-builder 的模板包含取决于它的版本，写错会让 **Windows 打包直接编译失败**——代价远大于「提权重启时多弹一次、点一下」。`.fsprobe` 的探测发生在用户**已点「安装」之后**（`customPageAfterChangeDir`），装机本来就要建这个目录，影响只剩「装到一半取消会留下一个空目录」。都留到 Windows 真机验证时一起看。
  - **滚动跟随恢复条件偏严**（Space 键不算「往下翻」、拖滚动条到底超过 1 秒不恢复跟随）：评审自己归为「体验上的保守取舍」。放宽会增加「用户想停在中间却被拽回底部」的风险，而这正是 `scroll-follow` 一整套测试守的东西，没有实测反馈前不动。
  - **残留 ABORT 文案 / `apiKey: ""` 回落**：评审没给位置、自称「不影响行为」。`ABORT` 是 `installer.log` 的**行格式协议**（`installer.nsh` 写、`win-update-guard.mjs` 解析、测试用安装器源码模板对账），改措辞会让两边对不上；`apiKey ?? ""` 是 `apiKey` 可选字段在类型上的统一落点（十几处），没有行为问题。
- **已改（用户拍板「按你的来」）：`env-probe` 只在「首次启动 / 这次启动偏慢」时跑**。起因：`env-probe`（拉 `powershell.exe -Command` 取机型 / 杀软 / Defender / 盘介质）原先**每次 Windows 启动都跑一次**（`emitBootReport` 里只按 win32 门禁、亮窗后约 6s、最长 20s；只有「杀软清单」才是首次启动才跑，契约测试钉的也只是「只有 Windows」）。应用没签名，公司电脑的杀软 / EDR 可能对「未签名程序反复拉起 PowerShell」报警，而正常启动拿到这些数据也没用。现在：纯函数 `decideEnvProbe`（`env-probe.mjs`）按 `firstBoot`（按版本判定：全新安装 / 更新 / 重装）或「亮窗用时（boot 时间线 `reveal` 里程碑）> `SLOW_BOOT_PROBE_MS`（30s，与杀软清单的慢启动阈值同一个常量、同样严格大于）」决定；亮窗用时拿不到 / 脏值按「不慢」。Windows 上每次启动都留一行 `[boot] env 探测 trigger=first-boot|slow-boot` 或 `[boot] env 探测跳过（…）`，日志里分得清「没跑」和「没查到」。取舍：为什么用亮窗用时而不是 server 就绪耗时——用户感知的「慢」包含就绪后首页冷读的十几秒，亮窗用时是它的超集；代价是非首次、慢于 30s 的启动才有环境数据，要更灵敏就调低 `SLOW_BOOT_PROBE_MS`（**同时**影响杀软清单的触发）。没改：server 起不来 → 弹「启动超时」的路径本来就不出启动报告，所以那条路径上（含首次启动）仍然没有环境数据，要的话得另开一处调用。测试：`tests/env-probe.test.ts` 加 `decideEnvProbe` 5 条，`tests/boot-diag-wiring-contract.test.ts` 加 1 条接线（门禁参数 / 调用只挂在 `envProbe.run` 上 / 两种日志行）。回退：把 `if (envProbe.run) await logEnvProbe();` 改回无条件 `await logEnvProbe();` 并还原那条契约测试。
- **验证**：`tsc` 0 错误；`eslint`（本段改的 5 个文件）0 错误；**全量 vitest：365 个文件通过（1 个跳过）/ 4973 个用例通过（3 个跳过），0 失败**。⚠ 没在真机 / 浏览器验证：子代理取消只有 fake session 的单测，没造「创建中途点停止」的真实时序；`loadEarlier` 只有源码契约。
- **回退**：① 把 `if (signal?.aborted) throw …` 改回 `onAbort()` 并删 `pi-subagent-abort.test.ts`；② 删 `latestEventsRef.current = [...fresh, ...cur]` 一行和对应契约测试。
- **发版前提醒（评审提的，仍有效）**：`src/lib/whats-new.ts` 文案草稿要先给用户看、说行才能打 tag；这批改动大半是 Windows 安装 / 启动路径（NSIS、磁盘预检、更新守卫），单测覆盖不到真实安装器，**需要 Windows 真机各跑一遍：全新安装 / 覆盖安装 / 低磁盘空间**。
- **已发 v1.9.30（2026-10-13）**：用户确认文案与范围后发版。**只带 review 过的文件**；同一工作区里别人在做的「任务页代码改动预览」（`TaskChangesPanel` / `task-changes.ts` / `/api/tasks/[id]/changes` 等，未提交）**没带**。发版范围在干净 worktree 里复验：`tsc` 0、`eslint` 0、全量 vitest 365 个文件 / 4979 个用例通过。⚠ 发版时 `1.9.30-localtest.4` 的「旧卸载器 TEMP 同盘提速」（RCA §10.5）**仍是「待真机验证」**（用户知情后确认发）——发出后第一件事是在装在非 C 盘的 Windows 上覆盖装一次，看 `installer.log` 的 `tmpredirect result=applied` / `tmprestore dir=removed` / `uninstSec`。

#### v1.9.31：任务页「代码改动」预览（用户要求「看 AI 改了什么、不用开 IDE」，2026-10-13）

- **是什么**：task 模式页顶栏（`BatchProgress` 后面）多一个「改动 N +a −r」按钮，点开右侧非模态 Sheet：左边按仓分组的文件清单、右边选中文件的 diff（复用 `tool-block.tsx` 导出的 `InlineDiff`，新行号可点跳 IDE）。chat / 没启动（无 `workCwd`）/ 全是非 git·只读仓的任务不挂入口。
- **文件**：`src/lib/server/task-changes.ts`（git 读取层，纯函数解析 + `execFile`）、`src/app/api/tasks/[id]/changes/route.ts`（清单）、`.../changes/file/route.ts`（单文件 diff，按需拉）、`src/hooks/use-task-changes.ts`（拉取 + 运行中轮询）、`src/components/tasks/task-changes-panel.tsx`（UI）；类型在 `types.ts`「任务代码改动预览」段，拉取函数在 `task-store.ts`。
- **为什么直接问 git、不聚合事件流里的 edit diff**：同一文件改多次事件流只能叠加、看不到净改动；工具 diff 服务端截断过；shell 里 sed / mv / 脚本生成的改动、用户在 IDE 里的改动事件流根本没有。
- **基线 = HEAD 与「线上分支」的 merge-base**。线上分支依次取 `task.gitBranches[].baseBranch` → `task.repoBaseBranches[repoPath]`（设置页快照）→ `origin/HEAD`；远端引用（`origin/<name>`）优先、本地分支兜底；都没有降级成 HEAD（只看未提交，UI 标注）。**非隔离任务（直接在原仓里干活）走同一套**：每次实时读 HEAD、不存快照，所以中途切分支（分支切换器允许）自动跟着走；展示的是「当前分支的整体改动」，含任务开始前该分支已有的提交和未提交内容（UI 有说明）；当前就在线上分支本身时标 `onBaseBranch`（只剩未提交 / 未推送）。
- **约束（改它之前先看）**：全程只读——`GIT_OPTIONAL_LOCKS=0`（git diff 默认会机会性刷新 index、与 agent 的 git 操作抢 `index.lock`），不 `git add -N`、不碰 index，未跟踪文件的 diff 由我们自己合成（测试断言 index 文件字节不变）；`execFile` 不走 shell，路径一律在 `--` 之后并开 `--literal-pathspecs`；接口不接受前端传工作目录（从 task 权威数据算），`path` / `oldPath` 必须是仓内相对路径（`sanitizeRepoRelPath`），分支名走白名单（`-` 开头 / 含 `..` 的忽略）；未跟踪文件只有确实「未跟踪且未被 ignore」才读盘（读不到 `.env`），符号链接只展示链接目标、不跟随；单仓失败只让该仓带 `unavailable`，不影响其他仓。
- **上限**：清单最多 500 个文件（`filesTruncated`，totals 仍按全量）；未跟踪文件最多逐个数 200 个、单个 ≤1MB；单文件 diff 返回 ≤400KB（按行截断）、git 输出 >8MB 放弃（`tooLarge`）；未跟踪清单读失败 / 超限只标 `untrackedSkipped`。
- **刷新**：挂载 / run 状态变化 / 面板打开立刻拉；agent 运行中轮询（面板开着 4s、关着 10s，页面不可见跳过）；运行中选中文件的 diff 每次清单刷新都静默重拉（不信缓存）。**成本**：每次轮询每个仓约 10 个 git 子进程，本机（macOS）单仓实测 ~70ms；Windows + Defender 会更慢，嫌卡就调大 `use-task-changes.ts` 的 `POLL_CLOSED_MS`。
- **测试**：`tests/task-changes.integration.test.ts`（真 git：带空格路径的隔离 worktree + 非隔离原仓，覆盖已提交 / 暂存 / 未暂存 / 重命名 / 删除 / 二进制 / 未跟踪 / 被 ignore / 中文文件名 / 符号链接 / 路径逃逸 / pathspec 魔法 / 超限截断 / 中途切分支 / 游离 HEAD）。
- **验证**：`tsc` / `eslint` 0；全量 vitest 全绿；另用本仓库当「非隔离任务」实跑：基线认成 `origin/main`、清单与 `git status` 一致。⚠ **没在浏览器里看过界面**（顶栏按钮位置、面板布局、diff 渲染只读了代码）；Windows 上没跑过。
- **已知边界**：已归档 / 工作区被清理的任务按钮仍在、点开提示「工作区目录不存在」；非隔离任务若本地线上分支很旧（长期没 fetch），merge-base 会很早、清单会混进别人的提交（500 上限兜底、UI 说明了范围）；`git diff` 若遇用户配置的 `textconv` 过滤器会执行它（只关了 `--no-ext-diff`）。
- **回退**：删上面 5 个新文件 + `tests/task-changes.integration.test.ts`，还原 `page.tsx`（顶栏那 4 行）、`task-store.ts`、`types.ts`（对应段）、`tool-block.tsx`（`InlineDiff` 的 export 与两个 className 参数）。

#### 同版：全量代码审查两轮修复 + 安全加固 + 已知限制（2026-10-14，未提交）

> 起因：另一个 AI 做了全量代码审查（约 60 条，S01–S16），修完后又做了一轮复审（5 个 P1 / 36 个 P2 / 46 个 P3）。两轮的修复、以及用户说「不用我拍板、按你觉得最优的来」后落地的几项决策，都在这一节。**全部改动都在工作区、没提交**；其中混着别的任务的改动（事件流 v2 / `installer.nsh` 等），提交时要拆开（见文末）。

- **Harness 门禁**：review 只读检查对多仓任务逐仓比对、基底 commit 必须在 artifact 里声明（`action-checks.ts`，`extractDeclaredBaseCommits`）；不再因为 cwd 没有 `.git` / 没写基底 commit 就直接放行。
- **SQL 只读**：`src/lib/server/sql-readonly-guard.ts`（词法扫描器）与 `scripts/pg-exec.mjs` 里**内联的一份**必须同步（pg-exec 要单文件分发；两边共用测试里的「拒绝 / 放行」表）。`readonly` 实例另有库侧 `BEGIN READ ONLY` + 扩展协议兜底；显式 `readonly:false` 的实例走旁路 shell 时**只有静态门这一道**（带副作用的函数如 `pg_terminate_backend` / `setval` 不在拦截范围）。
- **凭据不外流**：`event-secret-redact.ts` 按精确值（≥8 位）脱敏 gitToken / apiKey / 公司环境密码，覆盖落盘（`serializeEventLineRedacted`）、实时增量（`task-stream.publish`）、思考快照、群回复缓存、飞书 outbound。
- **GitLab PAT 两道防线**（2026-10-14 新增）：
  - **只发往可信 host**：`trusted-git-host.ts`。首次「可信时机」（服务启动 / 保存设置 / 会话启动，都早于 agent 介入）把 host 固定到 `<dataRoot>/trusted-git-host.json`，之后所有带 PAT 的出站（`gitlab-client` 兜底、`submit_mr`、收件箱扫描、merge 路由、团队库 git 操作）在**发请求前**校验，host 不一致就拒发并写清楚怎么处理。可选 `config.json` 的 `gitHostAllowlist: string[]`（无 UI、手改，非空时独占）。固定文件损坏 = fail-closed、不会被「重新固定」覆盖。**换 GitLab 域名时要删这个文件或配白名单**（错误文案里有路径）。
  - **token 走环境变量**：`git-token-env.ts` 把 token 写进 server 的 `process.env.FLOWSHIP_GITLAB_TOKEN`（Cursor SDK 本地 shell 继承 server env；pi 的 `stripHostInjectedEnv` 不剔它；**pi 路径下的受限答疑旁路**经 `omitGitToken: true` 摘掉，**Cursor 路径摘不掉**——SDK 本地 agent 无 env 选项、整份继承 server env，也不能临时删 `process.env`，那是进程全局、会弄坏属主的并行会话）。「GitLab 访问」提示改成直接引用 `"$FLOWSHIP_GITLAB_TOKEN"`，agent **不再需要打开 `config.json`**。
- **团队库**：删除加 owner 校验（`authorizeSharedSkillDeletion`）；secret-scan 补 camelCase 键名与一行多键 JSON。
- **飞书**：私聊卡片答 ask 改原子摘取（`takePendingAskIf` / `restorePendingAskIf`）；`ask-settle-state.ts` 区分「占位」与「终态视图」，patch 失败按钮不复活；`share_to_group` 对没有已绑群的任务**不自动建群**，如实报 `no_group`；建群成功但落盘失败有补偿（错误带 chat_id、同任务重试复用）。详见 `docs/feishu-group-collab.md`。
- **运行时**：worktree 改名隔离失败且存在 `.git` 时**抛错、不 rm -rf**；`kill-orphans` 签名分支只杀祖先链含本 server pid（或 ppid==1）的 agent shell，无签名的 `ppid===1` 候选**必须 cwd 在 `<dataRoot>/worktrees` 下**才杀（用户原仓里自己起的 nohup / daemon 不再被误杀，代价是非隔离任务里无签名的孤儿不再被收）；worktree 目录「坏了」的判定改看文件系统结构证据（`inspectWorkDirGit`：`.git` 指针 / `HEAD` / `commondir` 缺失才隔离重建），git 临时失败 / 超时 / 权限问题只抛错不动目录；重连放弃的收尾只在仍 `running` 时写 error，一问一答启动失败补发 `done(ok=false)`；回退写 `meta.rewoundFromEventId` + `rewoundKeptCount` 标记，前端按它截断；SSE 休眠 / 重连走 `watch-reconnect.ts` 状态机。
- **文件预览**：docx / xlsx 的 HTML 过白名单净化（`preview-html-sanitize.ts`）；zip 炸弹 / 条目数 / 超时保护（`office-zip-guard.ts`）；「打开文件」走 `buildOpenPathPlan`（可执行文件 / 脚本 / UNC 路径拒绝或只定位）；**xlsx 升到 0.20.3**（SheetJS 官方 CDN tarball，lockfile 带 sha512；修了 CVE-2023-30533 原型污染，有会在 0.18.5 下变红的回归测试；CVE-2024-22363 ReDoS 没造出可靠 PoC、只靠版本）。
- **CSP（Report-Only，2026-10-14）**：`next.config.mjs` 的 `headers()` 下发 `Content-Security-Policy-Report-Only`，违规报到 `/api/csp-report`（`csp-report.ts`：限体积 / 限频 / 去重 / URL 去 query，只打一行 `[csp-report]` 日志）。**绝不要直接改成 enforcing**——`tests/csp-headers.test.ts` 会拦；路线：观察 2–3 个版本 → 先收紧 `worker-src` / `img-src blob:` / `font-src data:` → 再处理 `script-src 'unsafe-inline'`（nonce + strict-dynamic，价值最大、工作量最大）→ 最后换 header 名并先在测试包验收。
- **发版门禁（2026-10-14）**：新增 `.github/workflows/ci.yml`（typecheck + eslint + 全量 vitest，ubuntu），`release.yml` 的 `verify` job 复用它，**不过就不 build / 不建 draft / 不出包**；同一份也可 `workflow_dispatch` 手动触发、PR 触发。原 `sdk-gate.yml`（已删）只跑 SDK store 的一小撮对拍，全量 vitest 已覆盖。
- **Windows 自动更新验签（2026-10-14，R9-01）**：exe 与两枚 mac dmg 一起签进 `update-manifest.json`（`release.yml` finalize：恰好 2 dmg + 1 exe，`fe-ai-flow-*-win-*.exe` 不匹配 `.blockmap`）；壳在 `update-downloaded` 时验一次、`installWinUpdate` 里 `quitting` 之前再验一次（`verifyDownloadedUpdate` → 纯函数 `update-manifest-verify.mjs: verifyManifestEntry`），**fail-closed**：验不过删缓存、回 `available`、开发布页、不置 `quitting`。asset 名取 latest.yml 的 `files[].url` basename，不用本地缓存文件名。旧壳行为不变；新壳对没有 manifest / 没有 exe 条目的 release 一律降级手动下载。
- **外链白名单**：`main.js` 的 `will-navigate` 之前对非站内 URL 无条件 `openExternal`；现在过 `external-url.mjs`（`isSafeExternalUrl` 用 `new URL` 比协议；`isIdeDeepLink` 只放 `cursor://file/…` / `vscode://file/…`，拒绝 `..` / `//`(UNC) / userinfo / 端口），其余只 log 不打开。
- **提示词**：`prompts/_super.md` 里 `[USER_MESSAGE]` 改类的处理原本自相矛盾（一处说小改动可直接改、一处说必须先复述），现在统一为：**仅「明确的小改动」（写清改哪里 + 改成什么、单点或少数几处、不是暗示 / 模糊）可跳过复述，其余一律先 `ask_user` 复述**，判不准当「其余」。
- **输入法**：所有「Enter 提交」处统一走 `src/lib/ime.ts: isImeComposing`；`tests/ime-enter-contract.test.ts` 是 AST 契约（同一函数体内必须有守卫），`PENDING` 名单已清空（`rows.tsx` 的排队消息编辑框也补了，Escape 一并守住）。
- **其它**：设置页的删除加确认 / 保存失败重试 / 端口数字框（`int-field.ts`）/ API Key 缓存（`api-key-cache.ts`）；MR 收件箱「已忽略(N)」常驻恢复入口 + 撤销忽略立即生效；会话页 `picked` 随筛选修剪；工作项防重复只认飞书链接里的工作项 id，撞上已有任务时表单**默认收起、点「仍要新建」才展开**；`skills/skill-creator` 的数据目录写法修正。

**决策记录（没做什么、为什么）**
- **公司环境密码仍会进模型上下文（S07-03）**：是设计取舍——agent 要 ssh / curl 就得拿到密码，换成「wrapper 工具」要改所有用法且 agent 仍可 `env`；现状靠 ① 提示词禁止打印 ② 事件 / 实时流 / 飞书回流的精确值脱敏兜底。真要根治，得做成只在 server 侧发起连接的专用工具（PG 的 `pg-exec` 已是这个形态）。
- **R9-03（旧卸载器失败后的 NSIS 自愈整目录强删、`partial` 仍继续装）没动**：`packaging/installer.nsh` 是另一个任务在改，且只能在 Windows 真机验证。
- **P3 长尾（约 46 条）没重审**：复审报告只带出了 P1/P2，没有逐条保留 P3。

**第三轮复审（2026-10-14，未提交）——逐项核实后处理，核实不成立的不改代码**
- **N3-01（旁路能 `printenv` 出 PAT）核实成立**：pi 路径已修——`omitGitToken: true` 一路透传（`restricted-question` → `agent-backend` → `custom-agent-backend` → `pi-coding-tools`），bash 工具摘掉 `FLOWSHIP_GITLAB_TOKEN`；旁路里 `task` 派的 general 子代理用 pi 原生 bash、会继承整份 env，用 `buildGitTokenFreeBashTool` 覆盖。判据是**显式传参而不是「无 callerToken」**：属主自己的 `startOneShotQuestion` 也无 callerToken、但要带 token。**Cursor 路径摘不掉**（见上）。⚠ **失败即开**：以后新增的非属主驱动会话，忘了传 `omitGitToken: true` 默认就带 token。`event-secret-redact` 把「当前 env 里的值」也加进了脱敏集（它可能不等于 config 的 gitToken，会话启动时优先用入口带来的 token）。
- **重定向会把 PAT 带给别的 host（新发现，实测复现）**：undici 跨源重定向只剔 `Authorization` / `Cookie`，自定义头 `PRIVATE-TOKEN` 原样带过去；git 默认 `http.followRedirects=initial` 会跟随 302、而 inline credential helper 不看 host，**真 git 复现了 B 收到 `oauth2:<PAT>` 的 Basic 头**。fetch 侧统一走 `fetchWithGitToken`（`redirect:"error"`，抛 `GitHostRedirectError`），git 侧 `buildAuthedGitArgs` / 团队库的 git 操作加 `-c http.followRedirects=false`。**代价：项目改名 / 迁移后的 301 会失败**（错误里有提示，更新 remote URL 即可）。有静态护栏：凡以 `PRIVATE-TOKEN` 为请求头 key 的文件不许出现裸 `fetch(`。
- **N8-01（readOnly pg-exec 旁路命令头无约束）**：潜伏（`readOnly` 没有任何调用方传 true），但比报告更宽（`touch x … pg-exec.mjs --`、`env` / 变量前缀、`node ./evil.js` 都能过）。已加 `checkPgExecHead`：必须是 node + 仓内 `pg-exec.mjs` + 已知参数、不许 shell 展开，有真 shell 工具的测试。**以后重新接线只读旁路前先看这条。**
- **N1-01（zip 炸弹只信中央目录声明的大小）**：`assertSafeOfficeZipDeep`——对每个 deflate 条目用**异步** `zlib.inflateRaw` + `maxOutputLength` 真实解压校验（声明 1KB / 实际 1GB 的炸弹约 40ms 被掐断，不阻塞事件循环）；加密标志位**不跳过**（xlsx 看本地头、jszip 看中央目录，位置不同）；EOCD「本盘条目数 ≠ 总条目数」按损坏拒绝。CPU 代价：最多真实解压 100MB，解析器之后还会再解一遍。
- **N2-02（Windows 验签失败一律删缓存的 112MB 安装包）**：`update-manifest-verify.mjs` 新增 `UpdateVerifyMismatchError`（签名 / version / 条目缺失 / size / sha256，**确定不符**）与 `UpdateVerifyUnavailableError`（取不到清单 / 公钥读不了 / 本地读文件失败，**暂时性**）。`main.js` 只在确定不符时删包 + 开发布页；暂时性失败**仍拒绝安装（fail-closed）但保留缓存**、回 `available` 带错误，下次点徽标重新验。分流只看 `instanceof`、不匹配文案；未归类的错误按「不删」处理。payload 重建与生成脚本的一致性**核实不成立**（key 顺序 / 数字 / `res.json()` 都不改字节），只补了 18 条端到端测试。
- **N7（飞书）**：群 ask 卡「缺 askId」字面不成立（按钮 value 带、入口比对了），**真问题是竞态**——比对与摘除之间 `await loadBridgeBootContext()`，agent 在窗口里登记新提问、点旧卡会答到新提问上（实测答成 `Q1:…（ask-2）`）；已把 await 挪到比对之前。`ask-card-settle` 原来只认群卡的 `md_gask_hint`，私聊卡的提示行是 `md_ask_hint`——已按卡类型选 id（`ASK_HINT_ELEMENT_ID` 导出自 `card-stream.ts`）。
- **N8-03（secret-scan 嵌套 JSON 回归）**：核实成立（`matchAll` 不重叠，值分支把 `{` 连同内层 key 吞了，`{"a":{"b":{"password":"x"}}}` 全漏）；值部分补「紧跟 key 的 `{`」与「紧跟 `{`/`[` 的 `[`」两个只吃开括号的分支。1113 个文本文件对比修复前后扫描结果：只有 1 条差异、是消除了一条误报。
- **N9-02 / N9-01**：工作项预览页与收件箱「改 bug」入口读 `useTaskList().loaded`（纯函数 `decideWorkitemGate` / `resolveTaskLookup`，加载中显示骨架、不渲染表单，表单放出后不再收回）；MR 收件箱撤销忽略时若有刷新在跑，`force` 刷新登记一次尾随（`mr-inbox-state.ts` 的 `runCoalescedInboxRefresh`，多次合并、绝不并发）。
- **N10-03 / N10-02**：见上「运行时」一条。`preview-html-sanitize` 的「10 万标签 < 2s」改成 1 万 / 10 万两档耗时比（中位数、阈值 40，线性约 10×、二次约 100×），其余绝对耗时断言逐条看过、都是下界 / 定时器语义 / 余量 100× 以上，没动。
- **N4（后台子代理，别的任务的新功能里）**：N4-01 成立——`claimResumable` 在 `try` 外，resume 抛错（四条分支：id 找不到 / model·effort 被改 / subagentType 不一致 / 在忙）会泄漏后台名额，连续 4 次后再也派不了后台子代理；已挪进 `try`。N4-03 成立——12000 字截断把末尾带 resumable agentId 的 trailer 整段切掉、提示却说「可以 resume」；现在先拆 trailer、给提示和 trailer 预留预算，只截正文，总长严格 ≤ 12000，切点不落在代理对中间。`SUBAGENT_TRAILER_PREFIX` 两边共用，**改 trailer 格式要两处一起看**。
- **N5（chat steer / rewind，别的任务的新功能里）**：重复投递**不成立**；rewind 服务端原子性**不成立**（提交点是 tmp + rename，提交后只前滚，持门闩、队列非空 409）。成立并已修两处（`chat-runner.ts`）：① `flushChatQueue` 撞上 rewind 门闩直接 `return` → 队列悬空、已 202 的排队消息永远不发，现在门闩释放后补一次 drain（无会话时不补，队列归启动状态机）；② 流抛错进入自动重连的退避窗口内 `rec.currentRun` 仍指着死 run、`canSteerChatRun` 仍为真，「立即发送」会塞给死 run，现在 catch 开头清掉。
- **没改、需要你定语义的两条 N5 残留**：(1) **V4**：steer 在途时自动重连替换了实例，`steerChatRun` 里 `!stillCurrent` 一律判 `cancelled`、记 `failed(stopped)`、不重排——这是「至少一次」与「至多一次」的取舍，且现有测试把 `cancelled` 建模成「不 bump generation」；推荐修法：自动重连摘实例时 bump generation 或打标，让「重连替换」与「用户停止」可区分，前者排队重发；SDK 断线时 steer promise 实际怎么落定没验证。(2) **编辑历史消息 = 「回退」+「重发新内容」两次请求**：中间崩溃会丢这条编辑，只有发送失败时的输入框回填兜底；推荐把重发放进服务端同一事务（门闩内回退 + 入队）。另外 `executeChatEditRewind` 在门闩外 peek 分流存在低影响 TOCTOU，steer 的 persist 窗口内恰好 rewind 可能留幽灵气泡。

**第四轮复审（2026-10-14，未提交）——无 P1，P2 逐项核实后处理**
- **拍板（用户授权「按最优来」）**：① **Cursor 路径的 PAT 不采用 `disallowedTools` / `local.customTools` 换自带 shell**——换掉 shell 后 Cursor 的 `read` 仍能读 `config.json`，得到的不是真边界，而且替换内置 shell 会影响工具块展示、有回归风险；继续按「旁路只适合可信同事的内部群」处理，注释里写明了这个决定和理由。② **跨域重定向一律拒绝保留**（GitLab 项目改名 / 迁移后的旧路径、http→https 跳转会直接失败，错误里有提示）——安全上是对的，属于产品行为变化。③ **`kill-orphans` / worktree 收窄覆盖面保留**（宁可漏收不误杀）。④ N4-04：`.mdc` 的删除是用户要求的，上一轮已答复，无需动作。
- **M3-01 / M3-02（zip 守卫可绕过）核实成立，且两条都能用真实解析器对拍复现**：守卫只按 EOCD 声明的条目数迭代、不看中央目录是否读完；jszip 读到「连续的中央目录记录」为止（60KB 的 zip 里藏 60MB 的 `document.xml`，把 EOCD 条目数从 5 改成 3 即绕过）。xlsx 的 `parse_zip` 与 jszip 都从 `length-4` 向前找**最后一个** EOCD 签名（旧守卫从 `length-22` 找），jszip 在 EOCD 任一字段为占位值时读 zip64、xlsx 完全不读 zip64。收口原则是**「歧义 → 拒绝」，不在守卫里复刻各解析器的怪癖**：声明的 N 条必须正好读完中央目录（`pos === cdEnd`）且中央目录紧贴 EOCD；EOCD 搜索从 `length-4` 起；搜索窗口内只能有一个 EOCD 签名（⚠ **这一条已在第五轮 F2-02 去掉**：三个解析器都取最后一个签名，窗口内第二个签名没有安全意义，却会把内嵌 stored zip 的合法 docx 整份误杀；现行规则 = EOCD 取末尾向前的最后一个签名 + 本条其余各项，见 `office-zip-guard.ts` 的 EOCD 注释第 3 点）；comment 长度必须对齐文件末尾；EOCD 的 6 个 zip64 占位字段一律拒绝；本盘条目数必须等于总条目数。`tests/office-zip-guard-parser-parity.test.ts` 用真实 jszip / `XLSX.CFB.read` 对拍一张畸形样例表，断言「守卫拒绝 或 守卫看到的集合 === 解析器看到的集合」；单点变异（去掉任一规则）都有用例变红。~~⚠ 误报风险：「窗口内多个 EOCD 签名则拒绝」会误拒「docx 里内嵌 stored 的 zip 且恰好落在文件末尾约 64KB 内」~~——**该规则已移除（第五轮 F2-02），这条风险不再适用**；当时没用真实 Word 生成的这类 docx 验证过概率，规则去掉之后也就不需要验证了。
- **M2-01（嵌套 JSON 漏报）/ M2-10（`requirePassword: false` 误报）**：上一轮为让 `{"a":{"b":{"password":"x"}}}` 命中，值部分改成「只吃开括号」，导致外层敏感键的「敏感度」丢了，`{"password":{"value":"…"}}` / `secret→data` / `apiKey→key` / `token→value` 全漏；现在 `collectLinePairs` 用跨行延续的括号栈把父键敏感度**只传给紧邻的下一层**（数组对继承透明、孙子层不继承；引用型键 `secretRef`、元数据子键 `name`/`file`/`username` 不继承；继承来的值还要再像口令才报）。随机差分：约 2.7 万个随机嵌套 JSON、语义推导的期望答案，0 漏报 0 多报；对 1178 个仓库文本文件修前修后对比，非测试文件新增 0 条。`requirePassword: false` 的原因是布尔 / 数字豁免只给 token 类键名，新增 `isNonSecretLiteralValue`（去引号后**整体相等**才豁免，`false123` / `truePassw0rd` 仍报）。仍漏报：括号单独成行、YAML 缩进式嵌套、带空格的口令短语、单行紧凑数组首元素是占位符；仍误报：URL 查询串里的 `?requirePassword=false`。
- **脱敏编码变体（P3）**：所有凭据加 `encodeURIComponent` 变体，gitToken 另加 `base64("oauth2:"+PAT)` 与 `base64(PAT)`（`GIT_TRACE_CURL` / `curl -v` 会把 Basic 头打进输出）；变体随值集合缓存，4KB 无命中事件行检测约 10.5µs → 17.5µs。⚠ 仍不覆盖：分块 / URL-safe / 无填充 base64、hex、二次编码、非 `oauth2` 用户名的 Basic、把凭据拆开分段打印——脱敏是事后遮盖不是隔离。
- **pg-exec 命令头（N8-01 余项，仍潜伏）**：用真 bash + 只打印 argv 的 `node` 垫片 fuzz，对比「校验器看到的参数」与「bash 真正执行的参数」。补拒三类：**未加引号的特殊空白**（NBSP / U+2028 / U+3000 / BOM / `\v` `\f` / U+2000–U+200A：JS 的 `\s` 当空白、bash 不当，校验器以为 `--` 之后是整条只读 SQL，bash 实际拿到的是别的 argv）、**未加引号的 `#` 注释**（`--env #x -- 'SELECT 1'` 的 argv 只剩 `["--env"]`）、**未加引号的括号**；带引号的 `"Project (copy)"` 仍放行。修前 16000 条 fuzz 有 202 条偏差，修后 0。
- **可信 host 端口（P3）**：逐点核实，比较口径已是 `URL.host`（非默认端口保留）；只有 `getGitLabUploadIdentity` 的身份缓存 key 没带端口、没有测试变红，已补 `tests/team-library-identity-port.test.ts`。⚠ **未改（超出范围）**：`git-remote.ts` 的 `parseHostFromRemoteUrl` 丢端口——非默认 HTTPS 端口的 GitLab 在任务 / MR 链路上会被当成 443（验 443、发 443，**没有泄露**，但功能上走不通）。
- **M5（飞书提问卡结算）**：M5-01 成立——`card-stream.ts` 的 `askRendersOptionButtons`（单题才渲染按钮）现在是私聊构造器、群构造器、结算三处共用的唯一判据，结算只删 `askRenderedOptionElementIds` 推出的 id，多题卡删除集合为空；契约测试对真实构造器产物断言（私聊 / 群 × 单题 / 多题 / 无选项题 / 部分带选项），delete 排在 update 之后。M5-02 成立——`batch_update` 是 POST，响应丢了 lark-api 不重试，旧实现一次就弃、卡停在「等待回答」且按钮还能点；现在瞬时失败后台退避重试 2 秒、8 秒各一次（`update_element` 整元素覆盖幂等、`delete_elements` 排最后），业务拒绝不重试。M5-03 成立——取消 / 顶替 / 停止 / 会话失效 / 24 小时过期都经 `supersedePendingAsks` 写作废标记，`group-outbound` 的全局 tap 认出后调同一结算入口，文案区分「已失效 / 已过期 / 已跳过」；点旧卡只有事件流里真有 `ask_user_reply` 才说「已经有人回答了」。**未做**：进程重启后没人再碰的孤儿 ask 没有标记、卡仍挂着（点击时如实回「已失效」）；在点击路径上主动结算不安全（「已提交但事件未落盘」的在途答案也分类成 unknown，会把已答的卡盖成「已失效」），推荐方案是启动时扫描未了结的 `ask_user_request`，要动启动恢复流程。⚠ 飞书对 `batch_update` 是否原子、对重复 delete 是否报错**仍无证据**，顺序设计对两种语义都安全，需真机确认。
- **M3-03 / M3-04 / M3-05（更新验签的出路）**：M3-03 成立——清单 404 被归为「暂时无法校验」，用户永远看到「请检查网络后重试」、没有手动下载入口，与上面「降级手动下载」的描述相反。新增 `UpdateVerifyManifestMissingError`（`UpdateVerifyUnavailableError` 的子类，只关心「删不删缓存」的调用方天然落在保守分支）：HTTP 404 / 410 → 保留缓存、仍拒绝自动安装、弹「该版本暂不支持自动校验」**并打开发布页**；5xx / 403 / 429 / 超时 / 网络错误 / 正文不是 JSON 仍是「暂时无法校验」、不开发布页。M3-04 成立——mac 路径 `finally` 一定删 dmg，清单持续取不到时每 2 小时重下一次；现在 `macVerifyFailedVersion` 只在验签类失败（含 404）时登记，同版本不再自动重下，点徽标或重启应用才重试（dmg 本身下载失败不记，网络自愈保留）。（⚠ **第六轮订正**：这一段只对「确定不符 / 没带清单」两类成立。暂时性失败〔5xx / 限流 / 超时 / 网络 / 未归类〕**不**登记 `macVerifyFailedVersion`——它走第五轮 F1-01 的时间退避〔5 / 10 / 20 / 40 / 80 / 120 / 120… 分钟、内存里、重启清零〕，到点自动放行；退避只挡「非轮询触发的自动暂存」，2 小时轮询前 5 次失败时必然已过窗口、**不受退避影响**。完整口径见下方「第六轮」必修 5。）M3-05：electron-updater 6.8.9 源码确认缓存命中（`DownloadedUpdateHelper.validateDownloadedPath` → `AppUpdater.done`）会重发 `update-downloaded`，但同会话分支只比 `versionInfo` 与文件是否存在，latest.yml 一变就无视已有文件重下 112MB——所以**不依赖事件重发**：`rejectUnverifiedWinUpdate` 保留缓存时登记 `winRetainedInstaller`，点徽标走 `resumeRetainedWinInstaller` 直接对该文件重验（与 `update-downloaded` 共用 `verifyAndMarkWinReady`），文件不在 / 版本变了才回落 `downloadUpdate()`。⚠ 没有 manifest 的 release，Windows 用户点徽标后仍会先下 112MB 才发现 404（要省这一次需在下载前探测 manifest）；mac 自动路径遇到暂时性失败（断网）也会弹「未通过完整性校验」并开发布页，每版本一次——这是原有行为，没动。（⚠ **第六轮订正**：已改——mac 后台自动暂存遇到暂时性失败**不再弹框、不开发布页、不消耗「已提示」名额**，只确定不符 / 没带清单才弹且每版本一次；与 Windows 共用纯函数 `buildVerifyRejectionNotice`，见「第六轮」必修 5。）
- **M4-01（steer 在途遇到重连）**：按「至少一次」落地——重连摘实例前（退避期间用户没停才算）给实例打 `replacedByReconnect` 标记并唤醒在飞的 steer；`steerChatRun` 新增返回 `replaced`（用户停止仍返回 `cancelled`、不打标记）；`chat-queue-send-now.ts` 收到 `replaced` 调 `requeueAsFollowup(true)`（排队前插、`skipPersistEvent`、不再落 `user_reply`），一条消息最多重排一次。理由：静默丢用户消息比重复一条糟，重排的条目在排队条里可见、可自己删。没动 generation，既有的 `cancelled` 断言一条没改。⚠ 真实 SDK 断流时 `run.steer` 是拒绝还是挂起没验证（测试覆盖了 `hang` / `reject-on-close` / `reject-on-break` 三种形态）；error 收尾时在飞 steer 仍记 `failed(stopped)`，措辞不准确。（**第六轮订正**：这不只是措辞——error / restart 收尾时在飞的「立即发送」会被当成用户停止、消息永久丢掉；已按关闭原因分流修好，见下方「第六轮」必修 1。）
- **M4-02（非用户原因的会话关闭静默取消后台子代理 / 结果丢失）核实成立，比报告更严重**：`closeChatSession` 里 `agent.close()` 经 `wrapAgentWithCancelLink` 触发 `cancelAll`，所以自动重连摘实例 / error 收尾 / 懒重启 / 编辑回退都会取消在跑的后台子代理；`cancelled` 事件没有原因字段、`deliverBackgroundSubagentResult` 第一行直接丢弃、事件流不写任何 info。探针实测更糟的一条：子代理在重连退避窗口内**已完成**时，事件流写「结果已交给主 AI」，但新实例收到的 `send` 里没有结果（随 `closeChatSession` 清 `pendingBackgroundResults` 丢了），提示是假的；`drainBackgroundResults` 在 steer 返回 `replaced` 时也直接丢那一批。已按最小范围落地（P0 + P1，不做 P2）：重连摘实例时把已到达未送达的结果暂存进 `stashedBackgroundResults`（**按 agentId 绑定**，新实例 send 受理后由 `restoreStashedBackgroundResults` 先删后放回，不会送两次；agentId 对不上、重连放弃 / 被停止 / 回退 → `discardStashedBackgroundResults` 清掉并写「N 条后台子代理的结果未送达主 AI（原因）」）；`closeChatSession` 加可选 `reason`（缺省 `user` = 现行行为），非用户主动关闭且在跑的后台子代理数 > 0 时，在 `agent.close()` 之前同步读数、写「因X，取消了 N 个后台子代理」；到达提示改成只说「将转交」。**没改关闭顺序、没动 `cancelled` 不投递的既有设计与既有断言**。**未做（P2）**：把丢失的后台任务拼进下一条 prompt 让主 AI 知情——主 AI 目前仍不知道子代理被取消，只有用户看得见。⚠ 本条是在同一份简报被多个子代理并行执行的情况下落地的（见下方「并行会话撞车」），期间出现过两份断言文案互相冲突的测试，已收敛为 `tests/chat-background-reconnect-window.test.ts` + `tests/chat-background-result-settle.test.ts`；真实 SDK 断线时 steer / wait 是拒绝还是挂起仍没验证。
- **M6（worktree 判定的三个边缘）**：M6-01 成立——主仓暂时不可达（外接盘没挂载）时「指针指向的 gitdir 不存在」会被判 broken 并改名隔离，用户看到「改动消失」，报错还是误导性的「找不到线上分支」；现在主仓 `.git` stat 报非 ENOENT/ENOTDIR 的错 → `unknown`（抛错带「主仓暂时不可达（是否未挂载？）」），主仓 `.git` 不存在时再看任务自己的 `repoPath` 是否可达（可达说明重建能成功、仍判 broken；**把「隔离只发生在马上能重建的前提下」当不变量**，所以与「上级目录不存在就判 unknown」的字面方案有一处差异——字面执行会让 S03-01 / R2-01 的既有用例退化）。M6-02 成立——`HEAD` 为空 / 内容不是合法 ref（`ref: refs/…` 或 40/64 位十六进制）现在是正面损坏证据；M6-03 成立——`.git` 悬空软链沿链走到链尾、链尾所在目录可达才判 broken，多跳链也对。另补一处：旧式软链 HEAD（`core.preferSymlinkRefs=true`，真 git 实测 `pack-refs` / `gc` 后会悬空但 git 仍认）原来会被误判缺 HEAD，现在软链指向 `refs/…` 算合法。⚠ Windows 没验（软链用例跳过、盘符不存在 / UNC 的错误码只是推断）；「悬空软链指向挂载点根」纯文件系统判据区分不了，会判 broken；用户改过 `repoPath` 而旧指针指向另一块没挂载的盘时会隔离重建（改动在 `.orphaned-*`，日志有 warn、界面没提示）。
- **⚠ 并行会话撞车（本轮出现过）**：同一份任务简报被多个会话同时执行，多个写入者同时改 `chat-runner.ts` 等文件，出现过两套并行方案、断言文案互相冲突的测试。起手先 `git status` / 看 mtime，发现别的会话在写同一批文件就停手、不要再起第三个写入者。

**第五轮：自查（2026-10-15，未提交）——用户问「你看下你的代码有问题不」**
> 做法：前四轮有不少代码是多个子代理并行落地、主线没完整读过，所以这轮不再重复「核实别人的报告」，而是**真实执行**去找：① 拿 46 个真实 docx / xlsx 过 zip 守卫；② 拿 78 个真实 skill / 文档 / 脚本文件对比新旧 secret-scan；③ 5 个只读为主的复查子代理（chat-runner、更新验签与打包、PAT / 脱敏 / SQL 守卫、前端 hooks、扫描性能 / worktree / kill-orphans），有把握的缺陷先写红灯测试再修，没把握的只报告。

- **真实文件探针结果**：zip 守卫对 46 个真实 Office 文件放行 45 个，唯一被拒的是一份**本身已损坏**的 xlsx（`unzip -t` 报少 7 字节 / 本地头偏移错 / CRC 错，Python `zipfile` 读不出任何条目，SheetJS 自己也抛 `Unsupported ZIP Compression method`）——不是误拒、不是回归。上一轮写的「docx 内嵌 stored zip 落在文件末尾 64KB 内会误拒」这一条风险当时**没有用真实样本证伪也没有复现**；它依赖的「窗口内多个 EOCD 签名则拒绝」规则随后已在本轮统一修复（F2-02）里整条去掉，所以这条风险**已不适用**（先前写「保留」是在规则去掉之前，与后文冲突，已订正）。
- **secret-scan 真实文件对比**（旧 HEAD 版 vs 现在，78 个文件）：命中 489 → 271；少报的 232 条 `high-entropy` 全是误报（kebab 名如 `"id": "chat-history-recovery"`、`result = generate_design_system(...)` 之类代码标识符）；多报的 16 条里 15 条是 `credential-key`，主要是 `*_tokens = set(...)` / `maxTokens: 8_192` 这类 **LLM / NLP 代码里的 `tokens`**——其中 `8_192` / `128_000` 这种下划线分组数字已修（见下），`x_tokens = set(...)` 这类代码赋值**仍会报**（`splitKeyWords` 把复数 `tokens` 归成 `token` 是为了抓 `"tokens": [...]` 结构，二者取舍；扫描拦截可被「确认无敏感信息 / force」放行，是摩擦不是阻断）。
- **本轮修掉的真缺陷**（均有先红后绿的测试 + 回退自检，改坏实现对应测试必变红、还原后 md5 一致）：
  - `chat-runner.ts`（3 处，`tests/chat-background-audit.test.ts`）：① `drainBackgroundResults` 撞 rewind 门闩且会话空闲时直接 return，回退若被拒就没有任何 run 收尾会再调它 → 「已提示将转交」的结果永远不送，现在空闲时等门闩解除后补一次；② 同窗口的变种（门闩在唤醒前 `getTask` 的 await 里才占上、`sendChatMessage` 回 busy）；③ 空闲唤醒前 `getTask` 抛错，已出队的批次被外层 `console.warn` 吞掉、用户以为交给了主 AI，现在如实写「读取任务失败」。`cancelled` 的提示措辞改成「会话已被停止或关闭」（原来一律写「被停止」，error / 懒重启 / 回退关的会话用户并没有停）。
  - `update-manifest-verify.mjs`：拉 `update-manifest.json` 原来整个正文先读进内存再 `res.json()`，30 秒超时只限时长不限字节（实测 200MiB 清单被完整接收、进程涨 ~616MB）。现在上限 1MiB（先看 `content-length`、没声明 / 声明有假就流式累计并 `cancel()`），超限抛 `UpdateVerifyUnavailableError`（code `manifest-too-large`，不删缓存、不开发布页）。`tests/update-manifest-body-cap.test.ts`。
  - `event-secret-redact.ts`：密码含 `"` / `\` / 制表符 / 换行时，`cat company-env.json` 的输出是 **JSON 转义形态**，只按原值匹配会漏；事件行落盘前再 `JSON.stringify` 一次还有二次转义形态。现在转义一层 / 两层的形态也进脱敏集（只在含特殊字符时才多算，普通凭据集合不变）。`tests/event-secret-redact-json-escape.test.ts`。
  - `sql-readonly-guard.ts` + `scripts/pg-exec.mjs`（两份同步）：黑名单里裸词 `COMMENT` 会把合法的 `SELECT comment FROM t`（极常见的业务列名）判成写操作；`COMMENT` 语句文法只有 `COMMENT ON …`，改成 `COMMENT\s+ON`。（第六轮 H4-09 订正：不锚定的 `COMMENT\s+ON` 仍会把 `JOIN comment ON …` 的联接条件误拒——现在只认**语句开头**的 `COMMENT`。）
  - `use-settings.ts` + `save-retry.ts`：同一字段先存 V1、V1 的 PUT 还在路上又存 V2，V1 **晚失败**会排退避重试、约 2 秒后用 V1 把 V2 覆盖回磁盘（输入框里还是 V2）。现在 `cancel` 让该字段的「世代」+1，`saveWithRetry` 失败时发现世代变了就不提示、不重试；`update`（草稿被改）只 `dropPending`、不动世代（`repo-card` 先落盘安全版再 `update` 草稿，安全版失败仍要排重试）。`tests/save-retry.test.ts`。⚠ 旧的 `settings-safety-contract` 一条钉死源码形态的断言改成在新位置断言同样的行为，不是删除。
  - `team-library-secret-scan.ts`：**线性化** + 多条真漏报。大写缩写拆分 / 尾部序号 / 尾部括号 / `{{ }}` / 引号串的正则对长标识符是二次方（16 万字符键名 38 秒、`password: )))…x` 42 秒），单个超长 token ≥ 约 8MB 会 `RangeError` 让整个 publish 抛错；现在全部线性、引号串用展开式循环。漏报：`&` 连接的参数（`?a=1&password=xx`）、`rediss://` / `amqps://` / `sftp://` / `ssh://` / `mssql://` / `ldap://` 等连接串 scheme 改通配、`PGP PRIVATE KEY BLOCK` 等私钥块。误报：小写 kebab slug 不再当高熵。新旧扫描器 6 万个随机多行输入（不含 `&`）0 差异。`tests/team-library-secret-scan-{perf,forms}.test.ts`。本轮我另补：token 类键名的数字豁免认 `_` 分组（`maxTokens: 8_192`），`password: 1_234_567` 仍报。
  - `task-worktrees.ts`：git ≥ 2.48 `worktree.useRelativePaths` 写出的**相对 `gitdir:` 指针**，加上 workDir 路径里有软链时，旧代码 `path.resolve` 字面量折叠 `..`、git 却顺着软链走 → **健康的 worktree 被判 `broken` 后改名隔离重建、用户看到「改动全消失」**（真 git 复现）。现在 `resolveGitPointer` 按 `.git` 所在目录的 realpath 解析，realpath 取不到返回 `unknown`（不动目录）。`tests/task-worktrees-inspect-git.test.ts`（真 git，13 个 `it`；此前误写成「31 个场景」，数字对不上，以文件为准）。
  - `kill-orphans.ts`：① `lsof` 因候选里某个 pid 在 `ps` 与 `lsof` 之间退出而非零退出时，旧 `getCwds` 把 stdout 整个丢掉（实测 lsof 退出码 1 但其余 pid 的 cwd 照常打印）→ 一次竞态一个孤儿都不收，现在捡回 `err.stdout` 的完整行（没换行结尾的最后一段不采信，防半截路径恰好等于工作目录）；② lsof 永远报 realpath、调用方给字面量，经软链访问数据目录 / 大小写与磁盘不一致（macOS）时前缀永远对不上，保护整个失灵 → 同时保留字面量与 realpath；③ `isUnder` 用 `startsWith("..")`，`..cache` 这种普通子目录被当成「跑到外面」。`tests/kill-orphans-paths.test.ts`。真 ps / lsof / kill 端到端：worktree 根下的孤儿被杀、用户原仓里的存活。
  - `task-runner.ts`：启动 / 恢复时 `syncGitTokenEnv(await resolveSessionGitToken(...))` 会把「读盘失败」吞成 undefined 并 `delete process.env.FLOWSHIP_GITLAB_TOKEN`——这个变量是**进程级全局**，别的并行会话下一条命令就拿不到凭据（401；Windows 杀软扫描 `config.json` 时的 `EBUSY` 就能触发）。新增 `syncSessionGitTokenEnv`：入口带了就用，否则按 `readSettingsFile` 三态（missing → 清；**error → 不动 env**），与 chat-runner / instrumentation 的 `syncGitTokenEnvFromSettingsResult` 同口径；提 MR 的桥快照仍走 `resolveSessionGitToken`。`tests/session-git-token-env-sync.test.ts`；`session-git-trust` 里钉调用形状的一条断言随之更新。
  - `IntInput`（端口 / DB 序号）：`type="number"` 里敲了 `22e` 之类非法字符时浏览器 `.value` 是空串，和「清空」在文本层无法区分，失焦被当成留空 → **静默回填默认值并提交**（SSH 端口悄悄变回 22）。`parseIntField` 新增 `badInput` 标记（先于「留空」判断），组件失焦读 `validity.badInput` 传入。⚠ 只有纯函数测试 + 接线的源码断言，**没有在浏览器里看过**。
  - `use-api-key-info.ts`：换成没缓存的新 key 时上一把 key 的姓名 / 邮箱继续挂着（`api-key-card` 会渲染 `info`）→ 未命中缓存先 `setInfo(null)`；静默刷新时补 `setLoading(false)`（被中止的非静默请求不会自己复位）。只有源码断言。
  - `team-library.ts`：`runGit` 的「GitLab 把该地址重定向了」提示正则漏了 303（现 `30[12378]`），并补上最常见的真实原因——**共享库地址没带 `.git` 后缀**（GitLab 会把无后缀的 `info/refs` 302 到带后缀的地址，而带 PAT 的 git 操作开了 `http.followRedirects=false`）。**自定义团队库地址请写成 `….git` 结尾。**
  - `scripts/generate-update-keypair.mjs`：公钥文件已存在时**拒绝覆盖**（要换必须 `--force`）。这个脚本会不经确认覆盖已提交的 `electron-app/update-manifest-public-key.pem`——换掉公钥 = 已发布的所有客户端对不上新私钥签的 manifest、自更新全部验签失败。已在真实仓库里跑过确认被拒、公钥 md5 不变；`--force` 与「文件不存在」两条路径在临时目录里验过。
- **子代理报告了、我没改的（按价值排序，需要你定或超出范围）**：
  - `electron-builder.yml` 的 `nsis` 段注释写「差分更新已下线」，但全仓没有 `differentialPackage: false` 也没有 `disableDifferentialDownload`（`main.js` 里同样没有），**实际默认是开的**，注释与现状不符。产品决定（真关还是改注释）；该文件不在本次改动里。
  - `redactSecretsInPlace` 嵌套深度 > 64 失败即开（不再脱敏）；`gitHostAllowlist` 条目带尾部 `/` 会被静默丢弃、悄悄退回 TOFU（方向是安全的，但用户以为白名单生效了）；`gitlab-host.ts` 在仓库横跨多个 host（gitlab + github）时启动 / 保存阶段的固定被整体跳过；`task-prompts.ts` 对纯 github 任务也会提示「origin 不可信」（误报）；`git-remote.ts: parseHostFromRemoteUrl` 丢端口（已在第四轮记过）。
  - SQL 黑名单仍是黑名单：未覆盖 `REASSIGN OWNED` / `COMMIT|ROLLBACK PREPARED` / `PREPARE TRANSACTION` / `NOTIFY` / `LOAD` / `ANALYZE` / `CHECKPOINT` / `SECURITY LABEL` / `IMPORT FOREIGN SCHEMA`，且 `lock` / `call` / `cluster` / `refresh` 作列名会误拒。`readonly` 实例有库侧兜底、只读旁路目前没有调用方，所以不构成实际绕过；真要根治应改成「语句首词白名单（SELECT / WITH / EXPLAIN / SHOW / VALUES）」。
  - secret-scan 的设计盲区：裸 JWT、Basic auth 头、`AIza…`、命令行 `-p` / `--password`、YAML 缩进式嵌套、值在下一行、`.netrc` / `//…:_authToken=`、全角冒号与中文键名、括号深度 > 64 之后继承失效；普通 URL / 绝对路径值会被高熵规则报（`context-docs-handler/SKILL.md` 里的飞书链接仍被拦，Slack / 飞书 webhook 的检测目前依赖同一规则，推荐对 URL / 路径值按 `/` 切段逐段判熵）；同步扫描会占住事件循环（20MB 约 2.9 秒，`collectStagedTextFilesForScan` 没有文件大小上限）；单个字符串里 ≥ 约 4M 个转义序列仍会 `RangeError`（抛错 = 失败即拒绝，不是放行）。
  - 后台子代理残留：提示写盘 `await` 的窗口内会话被**重连替换**，结果会走「会话已关闭、未送达」（如实提示、不假装送达；窗口只有一次磁盘写入那么短）；`rec` 缺失时无提示；`discardStashedBackgroundResults` 无条件清（多条重连链交错时可能误清另一条）；重连链收尾 `getTask` 抛错时暂存会残留到下次覆盖；`detachForeground` 转后台绕过并发上限（设计取舍）。
  - 前端：`composer-editor.tsx` 的 Esc / 方向键、`rows.tsx:954` 用原生 `isComposing` 而非 `isImeComposing`（Electron Chromium 下可靠，仅风格不一致）；`use-settings` 的 `update` 现在会丢掉待办重试——失败后继续编辑同一字段又没失焦就离页时旧值不再补写（输入框里更新的文本本来也没落盘，`dirty` 守卫仍拦离页）；极窄窗口 B（V1 失败后 2 秒内改回旧值并失焦）仍可能发生，要彻底消除需调用方在去重跳过时显式 `cancel`；`company-env-card` 两处删除按钮只有 `aria-label` 没有 `Tooltip`（旧代码）。
  - 更新链：`installWinUpdate` 里一处版本标签竞态（低）、dmg 下载没有大小上限、本地 `.next` 里可能有旧的强制 CSP 产物。
- **⚠ 仍有并行写入者**：本轮收尾时发现另一个会话在改 `task-runner.ts` / `task-worktrees.ts` / `settings-fs.ts` / `use-settings.ts` / `repo-card.tsx` / `sidebar-groups.ts` / `worktree-deps.ts` 等（worktree 依赖预装、侧边栏分组、仓库命令一类的功能，与本任务无关）。**这些文件里混着两个任务的改动，提交时要拆开**；我只用精确替换改了自己的部分，并核对过自己的改动都还在。

**第五轮补：worktree 依赖预装复查（2026-10-15，未提交）——用户问「另一个 AI 好像也在改 worktree 这一块，再看看代码有问题不」**
> 读了另一个会话的 `worktree-deps.ts`（全文）和 `task-worktrees.ts` 里依赖预装段（`planDepClone` / `cloneDepDirsLocked` / `runDepSetupIfDue` / `buildDepPrepareHint`），以及它与孤儿扫描 / 存储页 / kill-orphans 的交汇。大体可信：路径越界（`..` / 绝对路径）有挡、setup 命令的 env 摘了宿主注入变量和 GitLab PAT、进程组整组杀、超时 / abort 有 `settled` 守卫、`.dep-clone-tmp` 崩溃残留会被开机孤儿扫描整个清掉、存储页过滤点开头的内部目录。只改了下面两处（先红后绿 + 回退自检，md5 还原核对过）：
- `task-worktrees.ts: readWorktreeGitDir`（定位 `flowship-dep-setup.json` 标记所在的 worktree 私有 gitdir）：对相对 `gitdir:` 指针仍用 `path.resolve(workDir, p)` 字面量折叠——和上面 `inspectWorkDirGit` 修掉的是**同一个 bug**。git ≥ 2.48 `worktree.useRelativePaths` + workDir 路径含软链时算出一个不存在的目录：标记读不到、写也写不进去（写入处 `.catch(() => {})` 吞了错）→「setup 命令最多试 2 次 / 成功过就不再跑」的去重整个失效，**每次启动 agent 都重跑一条最长 15 分钟的 install**，提示词也永远说「正在初始化」。现在改走 `resolveGitPointer`（realpath 取不到返回 null、不退回字面量）。`tests/task-worktrees-inspect-git.test.ts`（真 git，+5 条）。
- `settings-fs.ts: getRepoSetupCommand`：读盘只 `trim()`，没走 PUT 落盘时的 `sanitizeRepoShellCommand`。现实里唯一的落盘入口 `putSettingsFile` 已净化，所以只有**手改 `config.json`** 写进多行 / 超长值才会漏到 shell（多行的第二行是另一条完全不同的命令；超长截断同理）。现在读出来再过一遍，脏值整条丢弃、回退 agent 自装。`tests/settings-fs.test.ts`（+1 条）。
- **没改、记下的**：`parseMainGitDirFromPointer` 的两个调用方（`cleanupUnmappedWorktrees`、开机孤儿扫描）对相对指针仍是字面量，得到相对路径后 `runGit` 的 cwd 会按服务进程的工作目录解析。这两条路径都是「任务已删、先落 WIP 快照再清」的 best-effort：失败只会退化成 `fs.rm` + 主仓里留一条过期登记（下次同分支被占用时 `tryReleaseDeletedTaskOrphan` 会释放），不丢数据，仅 git ≥ 2.48 且手动开了 `useRelativePaths` 才触发；要改需把同步纯函数换成带 realpath 的异步版，且现有 Windows 路径用例要保持。
- `setupCommand` 是**服务端用 shell 直接执行**的字符串，来源只有设置页（同机用户本人）；它不来自仓库内容，所以仓库本身不能借它注入。`previewCommand` 同样是用户配置、且读取处刻意保持宽松（见 `repo-shell-command.ts` 注释），没动。

**第五轮 review 报告统一修复（2026-10-15，未提交）——用户说「里面还有其他 AI 干的活，你来统一修复吧」**
> 来源：另一个 AI 接手出的「第五轮 review 报告」（136 条：P1×3 / P2×40 / P3×93；覆盖 G1–G5 群协作 v2〔927c4a2..ef205e5〕与 F1–F6 第四轮后的改动；该 AI **没改仓库代码**）。报告 §8 的四个决定用户授权我自己定。做法：按文件域拆给 7 个写入子代理（A 协议 / 净化 / 收尾工具，B 群路由 / 队列，C composer / 群问答前端，D 守卫 / 扫描，E 更新验签，F chat-runner / ask 注入，G worktree 依赖），我做主线修复和最终读码；每项先写红灯（确认红在真缺陷上而不是缺导出）→ 最小修复 → 绿 → 回退自检（临时撤掉修复，测试必须变红，还原后 md5 一致）。过程中有**另一个会话同时在写同一批文件**（F5 / F6 被重复执行，一个子代理因此中止），所以建基线前等到全仓 ~100 秒内没有文件变动。
- **我自己改的 4 处**（均先红后绿 + 回退自检）：
  - **G3-01（P1）群问题排队的「done → 释放」窗口**：task-runner 先 publish `done`、之后才 `finalizeOpenToolCalls` + `runningTasks.delete`，done 触发的那次 `pumpGroupQuestionQueue` 可能看到 busy 而空转，队里的人要等下一条新消息才被叫醒。`group-outbound.ts` 在 done 后补兜底重试链（`GROUP_PUMP_RETRY_DELAYS_MS` = 300 / 1200 / 4000ms；每 task 一条链、队列非空才续、timer `unref`、`__resetGroupOutboundForTest` 会清）。`tests/group-outbound-pump-retry.test.ts`（6 条，假定时器 + 真实 `runningTasks` 占位）。
  - **F4-03 余项**：`chat-inject.ts` 的会话轮换取消改传 `{ reason: "restart" }`（原来无 reason，会被当成用户停止）。`tests/session-rotate-chat.test.ts`。
  - **`remapLayoutInSettings` 丢更新**：它读改写 `config.json` 但没走 `withSettingsWriteLock`，与并发的设置 PUT 会互相覆盖（自定义 action 改 id 时重映射 `actionLayout`）。现在整段进写链。`tests/custom-action-fs.test.ts`。
  - **`config.json.bak` 补进脱敏源 + 旁路读守卫**：F6 新增的 `.bak` 里是**上一版**的 apiKey / PAT——用户轮换掉旧 key 后它们仍躺在磁盘上，而脱敏只认 `config.json`、旁路守卫只精确拦 `config.json`。现在 `event-secret-redact.ts` 多一个 `configBackup` 缓存槽（缓存 key 升到 V4；同值先到先得、占位符以当前 config 为准），`isBypassBlockedReadPath` 在数据目录根拦 `config.json` / `.bak` / `.corrupt-<ts>`（后者是读到损坏 JSON 时留的原文备份，本来就漏）。`tests/event-secret-redact.test.ts`（+2）、`tests/readonly-bypass-guards.test.ts`（+1）。
- **子代理落地的修复（按组，细节看各自测试文件头注释）**：
  - **G1 / G2（协议、净化、收尾）**：`group-reply-protocol.ts`——`NO_REPLY` 认 markdown 强调与「哨兵 + 说明」、未闭合 `[[需属主确认：` 也落地、邮箱 `@` 判「后面像域名」、prompt 清单里的清洗名也能命中、at 标签碎片逐字 `<`→`＜`；多处正则线性化（5 万字符标点串 / 空白串原来要十几秒、同步卡死事件循环）。`inbound-card-sanitize.ts` 线性化。`finalize-open-tools.ts`（G2-02）。`tests/group-reply-protocol-{perf,at-variants,r5}*.test.ts`、`inbound-card-sanitize-perf-r5`、`finalize-open-tools`。
  - **G3 / G4（路由、队列、出向）**：`group-shared.ts` 队列状态挂 `globalThis`（Next 多 chunk 下模块变量不共享）、`GROUP_QUESTION_QUEUE_MAX_PER_SENDER` = 2、`admitGroupBypassRun`（10 分钟滑动窗限制非属主旁路 run，超限静默丢 + 每窗一条 info；⚠ **第五轮这一版的口径是「入口处受理就计」，第六轮已改为「真正起了 run 才计、另有每人 4 次子限额」**，见「第六轮」必修 3，别按这里的字面理解）；`group-route.ts` 的 `GROUP_BYPASS_RATE_LIMITED`、owner 忙时登记、回放修复；`task-talk-queue.ts` 入队时复查生命周期（`closing`）；`group-outbound.ts` 预过滤。`tests/group-{outbound-pump-prefilter,route-pump-replay,question-queue-globalthis,bypass-limit,route-owner-busy-registration}`、`task-talk-queue-{lifecycle-guard,session-guard}`、`talk-queue-clear-callsites`。
  - **前端**：`composer-history.ts` 的 `buildInputHistory` 跳过 `isHiddenFromEventStream`；`group-qa.ts` 轮次 key 改用 runTag；`talk-send-attempt.ts` + `task-talk-composer.tsx` 重试复用同一个 `clientItemId`。⚠ 没在浏览器里看过。
  - **F2 守卫 / 扫描**：`office-zip-guard.ts`（xlsx 校验本地头 method；去掉「第二个 EOCD」误拒规则）、`pi-coding-tools.ts`（`NODE_PRELOAD_FLAG_RE` / 内联 `--require` 识别）、`team-library-secret-scan.ts`（YAML 缩进继承、`?` 分段、内嵌 payload 下钻 ≤ 2 层）。
  - **F3 更新验签**：`update-manifest-verify.mjs` 的 `hasCompleteManifestShape`（形状不全 → `manifest-invalid`，归 Unavailable 不删缓存）；新增 `win-pending-verify.mjs`（`verifyWinPendingInstallerWith`）、`update-verify-retry.mjs`（退避 5 分钟翻倍、封顶 2 小时）；`main.js` 变薄、mailto 走 `isSafeMailtoUrl`。
  - **F4 chat-runner**：关闭原因标记（`pendingCloseReason` / `pendingCloseBackground`）、steer 总超时 30 分钟、`droppedTexts` 先脱敏再截断；`ask-inject.ts` / `card-action.ts`：F3-01（ask 已处理卡的 patch 判据改 `isAskCardPatched`）；F3-02 是另一回事——**会话已死时**群里答题 / 点群答题卡，要写 `supersedePendingAsks` 作废标记并把卡置「已失效」（`tests/ask-inject-dead-session-void.test.ts`；`isAskCardPatched` 不是 F3-02 的修法，上一版把两条并在一起写，已订正）。
  - **F5 worktree 依赖**：`worktree-deps.ts`（win32 `taskkill` + 宽限）、`task-worktrees.ts`（started 标记、`leftDeps` 重试、`git ls-tree` 判「是否被跟踪」）；`task-runner.ts` 预热传 `skipDepSetup: true`（预热不该跑一条 15 分钟的 install）。
  - **F6 设置写入**（另一个会话落的，我读过）：`validateSettingsPayload`（`{}` / `[]` / 不含任何已知键的对象拒写，避免整对象覆盖清空配置）、`putSettingsFile` 覆盖前备份 `.bak`（0600；备份失败只 warn 不挡保存；损坏 / 不可读时在备份**之前**返回 `unreadable`，不顶掉好备份）、`jsonParseReason` 只留出错位置（V8 的 message 会夹带出错处附近的原文，手改 `config.json` 漏引号最容易触发）。
  - **R3 / R4**：`group-answer-context.ts`（清洗发送人名、`isSelf` 判据收紧）；`task-question-inject.ts`（入队后复查 opGen / 生命周期、2 分钟 TTL 去重表返回 `{ ok, deduped: true }`）。
- **产品取舍（我定的，没有再问你）**：G1-05 真人提问人 + 需属主确认 → **双 @（提问人开头 + 属主确认行）**，认为两个人都该看到；G3-02 保守限流（队内每人 2 槽〔排队槽位〕/ 10 分钟内**起了 run 的**非属主旁路最多 12 次、每发送人最多 4 次〔第六轮订正：最初写成「被受理就计 12 条」，被忙线 / 队满拒收的消息也占名额〕）；G2-01 / F2-09（群里的人能影响 agent）和 F5-09（`setupCommand` 是配置级命令执行面）**只写文档、不加更多过滤**——这是产品边界，已写进 `feishu-group-collab.md`「诚实的局限」；G5-01 保持设计（停止任务只清 `app` 来源的队列，`group_owner` 回放不清）。
- **需要你确认**：① G1-05 的双 @ 你觉得吵不吵；② G5-01 停止语义——停止后群属主排队的回放还会不会发；③ F6-03：另一个会话在 PUT 时遇到 `unreadable` 只拒写，不会暂停设置页的自动保存重试链（只在读取阶段暂停），极端情况下会反复弹错误。
- **没修、记下的残余**：
  - 群协作：`cli_` 同名机器人冒充要 `restricted-question.ts` 把 bot app_id 带进来才能根治；roster 区昵称伪造需与 `promptNameOf` 同步演进；同一 `clientItemId` 的并发在途请求没做互斥；`deduped` 的 200 不带 `persistWarning`；~~`error` / `restart` 路径的 steer 仍记 `failed(stopped)`（要改成「重排队」文案得动 `chat-queue-send-now.ts`）~~——**这条诊断是错的，且问题已在第六轮修好**：不是文案，是「排队重发的判据」把系统自己的清队当成了用户停止，error / restart 下的消息会被永久丢弃；修法在判据（系统关闭标记 + 在飞 steer 登记），不是改文案，详见「第六轮」必修 1。
  - 更新链：~~`runUpdateCheck` 在 Unavailable 时仍弹窗 / 开发布页~~（第六轮已修：后台触发的暂时性失败不弹框，见必修 5）；退避不落盘；mac 没有清单阶段的进度。
  - 守卫 / 扫描：secret-scan 的 YAML 标量列表项、`password=?abc`、2 层以上内嵌、`file:` 预加载、`node -`、`--env-file`、`--run` 仍有盲区；F2-08 目前没有调用方传 `readOnly: true`（潜伏）。（⚠ **第七轮订正**：`file:` 预加载第六轮已处理，这里写的「仍有盲区」早已过期；`--env-file` / `--run=` 以及所有「带值的非预加载选项」第七轮 K4-01 已按 fail-closed 修好，见「第七轮」。）
  - worktree：Windows `taskkill` 路径**没在真机验过**；`exit 0` 之后孙进程仍占着管道的情形没覆盖；`parseMainGitDirFromPointer` 的相对指针（见上一节）。
  - 设置：F6-01 多标签页互相覆盖只做了评估，要做需要 revision / `If-Match` 设计，没做。
  - 测试质量：仍有若干「只 grep 源码字符串」的契约测试（防删防改，证明不了行为）；前端改动没有浏览器验证。
- **⚠ 提交前必须拆分**：工作区现在 **347 个改动 / 155 个未跟踪**，混着至少三个任务（本任务的审查修复、事件流 v2、worktree 依赖预装 / 侧边栏分组 / 仓库命令那一批），其中 `task-runner.ts` / `task-worktrees.ts` / `settings-fs.ts` / `use-settings.ts` / `repo-card.tsx` / `sidebar-groups.ts` / `worktree-deps.ts` 等是**两个任务写在同一个文件里**，要按 hunk 拆。拆分建议沿用上面「提交前建议拆开」那一条再加：⑥ worktree 依赖预装（另一任务）、⑦ 群协作 v2 的第五轮修复（本节）。（⚠ **第六轮订正：这条「按 hunk 拆」对未跟踪的新文件做不到**——`worktree-deps.ts` / `repo-shell-command.ts` 等是整文件新增、没有 hunk 可拆。可操作的做法见下方「第六轮」的提交建议：新文件连同依赖它们的修改放进**同一个功能提交**，只有「两个任务写在同一个已跟踪文件里」的才需要 `git add -p` 按 hunk 拆。）
- **验证**：`tsc --noEmit` 退出 0；`eslint .` 退出 0；全量 vitest（CI 口径：`PATH` 含 `/opt/homebrew/bin`、`CI=1`）**495 个文件通过 + 1 个跳过、8235 个用例通过 + 3 个跳过，退出 0**。⚠ 本机 `/usr/bin/git` 是 Xcode shim（退出 69），不带 `/opt/homebrew/bin` 跑真 git 的集成测试会整片红，不是代码问题。

**第六轮：对第五轮统一修复的复核修复（2026-10-15，未提交）——用户转来「第六轮 review 结果」**
> 来源：另一个 AI 对第五轮统一修复的复核报告（审查方**没有改仓库**；P2×5 + 若干 P3 + 文档订正；§「已拍板」的取舍已经定了，没有再问用户）。做法：5 个必修 P2 里 1、2 由我自己做（它们是同一块收尾时序，要读透），3、4、5、提示词、P3 三组交给写入子代理，我读码核对 + 补测试。每项先写红灯（红在真缺陷上、不是缺导出）→ 最小修复 → 绿 → 回退自检（撤掉修复必须变红，md5 还原核对）。报告 §五 的测试要求逐条照办：**竞态修复的测试一律走真实收尾路径**（不再只断言纯函数返回值——第五轮 F4-01「绿灯但没修好」就是这么来的）、性能测试用 n→2n 耗时比（`tests/helpers/scaling-ratio.ts`）、不新增 grep 源码的契约测试、能不真等的不真等。

**必修 1 · steer 重排：按关闭原因分流（F4-01 第五轮没修全）**
- **先验证了报告的「同一同步段」断言**：cancelled / error 两条收尾都是 `failQueuedItems`（清队、queue generation + 1）→ 同一同步段内 `closeChatSession`（打 replaced 标）。在飞的「立即发送」条目已从队里摘出、**刻意不占 in-flight 槽**，所以 error 收尾的清队看不到它；它之后拿到 `replaced` 回 `requeueAsFollowup`，看到 generation 变了——**把系统自己的清队当成了用户停止，记 `failed(stopped)`**。用「`steer` 与 `run.wait` 都永不返回」的假 agent 走真实 finalize 复现，修前 restart / error 两条真红。第五轮的 `chat-steer-nonuser-close` 只断言了 `steerChatRun` 的返回值，所以绿灯。
- **订正第五轮的诊断**：HANDOFF 当时写「要改成『重排队』文案得动 `chat-queue-send-now.ts`」——**不是文案**，是**判据**。
- **修法**（三处）：① `chat-queue.ts` 新增系统关闭标记 `markChatSystemClose(taskId, reason)`（`reconnect` / `error` / `restart`，记关闭那一刻的 generation）（⚠ **第八轮订正：这是第六轮的旧签名**——第七轮起是 `markChatSystemClose(taskId, preClearGeneration?)`，`reason` 已删；第八轮又给标记加了单调的 `seq`，见「第八轮」L5-01）；`closeChatSession` 对这三种原因打标。② `chat-queue-send-now.ts: requeueAsFollowup(replaced=true)` 以「标记里的 generation」为基线判断「用户有没有另外停过」——系统自己的清队不算，**之后**再有 generation 变化（用户停止 / 回退 / 删除任务）仍判 `stopped`。（⚠ **第七轮订正 K1-01，这个基线只挡住了「摘表之后」的用户介入**：标记取的是摘表时（系统自己清队之后）的值，用户停止的清队若发生在系统摘表**之前**，就被吸收进基线、消息被重排回来。现在标记同时记「系统清队前」与「摘表时」两个值，两个条件都满足才算用户没介入，见「第七轮」。标记也不再带 `reason` 字段——无人读取，已删。）③ error 不重排（和队列里其它消息同命运、避免对着坏会话再送一遍）：`steerChatRun` 包一层把在飞条目登记到 `RunningChatRecord.inflightSteers`（`try/finally` 注销），`failQueuedItemsCapturingTexts` 在 reason=`error` 时并入快照并经 `failQueuedItems({ extraItemIds })`（跳过已终态的）一起判 `failed(error)` + `queue_failed`，计入「本轮出错，N 条排队消息未送达」提示与 `meta.droppedTexts`（先脱敏再截断）。
- **关闭原因的最终终态**（⚠ **第八轮订正：原标题写「六种」，下表有 7 行**——7 行里 `error` 关闭拆成了「run 出错收尾」与「send 抛错」两种形态；另外下表描述的是**摘表之后**的行为，「`take` 之后、登记 `inflightSteers` 之前」那段空窗第七轮没覆盖，第八轮 L5-01 补上了，见「第八轮」）（`tests/chat-steer-requeue-by-reason.test.ts` 经真实 chat-runner + 真实 `chat-queue-send-now` 断言条目终态；`hang` 与 `reject-on-close` 两种 steer 形态都覆盖）：

  | 关闭原因 | 在飞 steer 的那条消息 |
  |---|---|
  | reconnect（自动重连摘实例） | 重排队首（至少送一次）——由既有 `chat-steer-reconnect-replaced.test.ts` 端到端覆盖（含真实 2 秒退避，见下「残余」） |
  | restart（取消收尾 `reason=restart`） | 重排队首 |
  | forceClear（懒重启强清，`forceClearChatRun`） | 重排队首 |
  | error（出错收尾：`finalize` 的 error 分支 / 收尾抛错兜底 / 重连放弃） | `failed(error)`、并入「N 条未送达」提示 |
  | error 关闭但**不是** run 出错收尾（`sendChatMessage` 里 `agent.send` 抛错走的 `reason: "error"` 关闭，第七轮 K1-02 订正） | **重排队首**（不是 `failed(error)`）：这条关闭不清队、也不并入 `inflightSteers`；理论上此刻没有活 run，只可能是上一轮刚结束、宽限内没落定的 steer |
  | 用户停止（`cancelChatRun` 不带 reason） | `failed(stopped)`，不重排 |
  | 回退（`closeChatSessionUnconditional`） | `failed(stopped)`，不重排 |
- 修前红 / 修后绿都核过（restart 与 error 两条在修前真红；forceClear、用户停止、回退三条本来就对，作回归守卫）；回退自检：撤掉修复后对应用例变红、还原后 md5 一致。⚠ **restart 重排的消息靠新会话的 run 收尾 flush 送出**（至少一次语义，不是即时送）；删除任务同样走 generation、没有单独用例。

**必修 2 · 后台子代理结果暂存：只有 reconnect 暂存**
- 第五轮之前，`drainBackgroundResults` 在 steer 回 `replaced` 时一律暂存，而暂存是**按 agentId 绑定**的：error / restart 摘掉会话后，同一持久化 agent 之后的**任何**一次自动重连都会把这批旧结果投进去——陈旧结果复活。
- 现在只有 `rec.replacedReason === "reconnect"` 才暂存；其余原因写一条「N 条后台子代理的结果未送达主 AI（原因）」info（原因取 `CHAT_CLOSE_REASON_LABEL`：对话出错收尾 / 会话重启…），不暂存。`closeChatSession` 把**首个**关闭原因记在 `rec.replacedReason`（先到先得）。暂存带 **10 分钟时效**（`STASHED_BACKGROUND_RESULTS_TTL_MS`，`unref` 的 timer，restore / discard / 重新暂存都会清它），到期写「未送达（暂存超时）」并清空。`tests/chat-background-result-close-reason.test.ts`（5 条：error / restart 各一条提示、陈旧结果不会被同 agentId 的后来重连投递、TTL 到期、discard 时 timer 被取消——用 `vi.getTimerCount()` 的差值，不依赖实现细节）。

**必修 3 · 群答疑旁路限流：改成「真正起了 run 才计」**（`group-shared.ts` / `group-route.ts`）
- 第五轮的 `admitGroupBypassRun` 在入口处「受理就计」，被忙线 / 队满拒收的消息也占名额，一个发送人能把整个任务的名额耗光。现在名额只在忙线 / 队满 / 槽位 / 启动凭据都通过、**紧接着起 run** 的那一刻扣；**总 12 次 / 10 分钟 + 每发送人 4 次**；同一 `message_id` 重投不重复计；排队回放在**真正起 run 时**计一次（入队时不计）；起 run 失败（注入抛错 / 非 200）`releaseGroupBypassRun` 退还。总限额与个人限额的 info 提示各自每窗最多一条、文案区分。
- **没有给 `expect_group_reply` 登记的回执做豁免**：核对了——关联回执 / pendingAsk 答案 / 属主 / chat 型本来就**不经过** `admitGroupBypassRun`（走 send 进活会话、不起旁路 run），所以限流打不到它们，也就不需要另加豁免。（⚠ **第七轮订正，这一条只对「有活会话」成立**：`group-route.ts` 里 `feedIntoSession = !!correlated && agentSessions.has(taskId)`，**没有活会话时关联回执走只读旁路起 run、要过 `admitGroupBypassRun`**，会计入个人限额——同一发送人 10 分钟内第 5 次回执被静默丢掉。第七轮 K2-01 已改成「命中登记的关联回执只计总限额、不计个人限额」，见「第七轮」。）`tests/group-bypass-admit-at-start.test.ts`、`tests/group-bypass-limit.test.ts`、`tests/feishu-group-inbound.test.ts`。⚠ 回放遇限流时静默丢弃该条（不卡后面别人的排队项），对提问人本人是静默的。口径写进 `docs/feishu-group-collab.md`。

**必修 4 · 设置写入兜底**（`settings-fs.ts`）
- **严格校验**：`validateSettingsPayload` 不再只看「含一个已知键」——PUT 是整对象覆盖，只带一部分键（`{ repos: [] }` / `{ apiKey: "" }`）同样会让 config 只剩一个键、API key / 偏好 / 仓库全丢，所以必须同时带 `apiKey`（字符串）、`defaultModel`（普通对象）、`repos`（数组），只认自有属性；文案只点名字段名、不回显值。
- **`config.json.bak.shrink`**：`.bak` 每次保存都滚，误清配置后再普通保存一次好备份就被顶掉；新增「收缩」判定——任一已知顶层键从非空变成缺失 / 空，就在滚 `.bak` 之前先把收缩前的完整配置原子写成 `.bak.shrink`（0600，**只被下一次收缩写覆盖**）。「非空」= 非空串 / 非空数组 / 有键的对象 / `true`（判定在掩码合并之后做，与最终落盘内容一一对应）。（⚠ **第七轮订正 P2-1**：「任一已知顶层键」+「`true` 算非空」过宽，关个开关就能把好备份顶掉；现在只看凭据与列表类键〔`apiKey` / `gitToken` / `repos` / `mcpServers` / `customProviders`，外加 `customProviders` 的 apiKey 与 `companyEnv` 子系统的嵌套清空〕，布尔开关 / 星标 / 禁用清单 / 分支模板一律不算，`true` 不再算非空。）
- **同族文件整族排除**：`CONFIG_FILE_FAMILY_RE` = `config.json` + `.bak` / `.bak.shrink` / `.corrupt-<ts>` + `.tmp.*`，旁路读守卫（`isBypassBlockedReadPath`，两侧都 resolve、修了尾部斜杠）与脱敏源（缓存 key 升到 V5）按整族处理（⚠ **第七轮订正，「整族」说过头了**：读守卫确实拦整族；**脱敏源只有 `config.json` / `.bak` / `.bak.shrink` 三个槽**，不含 `.corrupt-<ts>` 与 `.tmp.*`——前者是损坏原文的一次性备份、后者是写入中间态，没有固定内容可预取。为此第七轮在启动时清掉遗留的 `config.json*.tmp.*`，见「第七轮」K3-08）；诊断导出（只读固定的 `config.json`）和存储页（只枚举 `tasks/`、`worktrees/` 下的目录）**本来就不枚举数据目录**，`tests/settings-backup-exclusion.test.ts` 把「整族不会被带出 / 列出」钉成行为，日后谁加了「枚举数据目录」的功能会在这里红。
- 测试：`settings-put-route` / `settings-fs` / `settings-backup-exclusion` / `event-secret-redact` / `settings-unreadable-route` / `settings-safety-contract` / `readonly-bypass-guards`（+2）。

**必修 5 · mac 更新失败的处置与 Windows 对齐**（`update-manifest-verify.mjs` / `main.js` / `update-verify-retry.mjs`）
- 旧：mac `runUpdateCheck` 对**任何**暂存失败都弹「未通过完整性校验」+ 开发布页 + 用掉该版本唯一一次提示——一次 503 就误导用户。现在两个平台共用纯函数 `buildVerifyRejectionNotice(err, { trigger, alreadyPrompted })`，按**错误类型 × 触发方式**出处置：

  | 失败类型 | `trigger: "user"`（点徽标触发，Windows 全流程） | `trigger: "background"`（mac 的 2h 轮询 / 启动检查，没人在等） |
  |---|---|---|
  | 确定不符（签名 / 版本 / 条目 / size / sha256） | 弹框 + 开发布页（Windows 删缓存） | 弹框 + 开发布页 + 记「已提示」；**每版本一次** |
  | 没带清单（404 / 410） | 弹框 + 开发布页，缓存保留 | 同上 |
  | 暂时性（5xx / 限流 / 超时 / 网络 / 未归类） | 弹「暂时无法校验」（不开发布页） | **不弹框、不开发布页、不消耗「已提示」名额**，交给轮询自愈 |
- **退避的诚实说明**：暂时性失败的 5 / 10 / 20 / 40 / 80 / 120 / 120… 分钟退避（内存里，重启清零）**只挡「非轮询触发的自动暂存」**；2 小时轮询前 5 次失败时退避窗口都短于 2 小时、必然放行，连续失败 ≥ 6 次封顶后才可能偶尔被跳过一轮——所以**退避不会让轮询停下来**，用户端「不被打扰」靠的是上表的不弹框、不是退避（旧注释把两件事混在一起，已改）。`macVerifyFailedVersion` 只在真的弹了框（确定不符 / 没带清单）时登记（⚠ **第七轮订正，这句话不属实**：它在 `downloadAndStageMacUpdate` 的 `catch` 里对**任何触发方式、任何永久失败**一律登记，与弹没弹框无关——「谁登记」与「谁弹框」是两件事。真正的坑是设置页「检查更新」那条路 `.catch(() => {})` 把第一次确定不符整个吞了、之后后台轮询又因已登记而永不弹。第七轮 K3-05 让手动路径也走同一个处置函数 `handleMacStageFailure`，见「第七轮」。另外「未归类」不再是静默 + 无退避，见 P2-2）。`tests/update-verify-disposition.test.ts`、`update-manifest-failure-kinds`（③b / ③e 走 `main.js` 真实函数体）、`update-verify-retry`、`windows-auto-update-contract`。⚠ Windows / mac 真机都没跑过。

**提示词与协议（P3-A + 提示词）**
- **A0 提示词与代码口径对齐（以代码为准）**：代码在「正文已有经校验的真 @」时**不**自动 @ 提问人；提示词（`buildGroupReplyRules` 真人 / 机器人两版）原先写成「会自动 @」。现按代码改提示词，并明确「**不要手写 `<at>` 标签、直接写 `@名字`**」（手写标签 id 不可信、会被退化成纯文本）。不改代码的理由：自动 @ 的判据属于第五轮 R5 的安全修复，改成无条件补会改变群通知量。
- **H1-01 围栏判定线性化**：`unwrapCodeFence` 对「首行超长且没有闭合」的输入是二次方，现为线性。**H1-02**：属主确认标记容忍 `【…】`、全角空格 / 制表符 / 冒号变体；闭合符**只在同一段内找**（旧实现是「最后一个 `]]` 之前全部惰性匹配」，会把隔着空行的无关 `]]` 当闭合、吞掉中间正文）；未闭合 → 说明取到行尾；解析走线性的 `stripNeedsOwnerMarkers`。**H1-04**：哨兵词 `NO_REPLY` 先 NFKC 归一并去零宽再判；反引号 / 引号包住且**后面还有正文**的是在「解释哨兵词」，不当哨兵（旧实现整条被吞）。**H1-06**：入向卡片无配对 `▲` 的面板头只剥「面板头 + 缩进的面板体」，不再一路剥到文末（`▶ 🔧 修复登录 / ▶ 🔧 补充测试 / 请 review` 里的「请 review」不再被吞）。`group-contract.ts:59` 关于 NO_REPLY 的过期注释已更新。`tests/group-reply-protocol-r6.test.ts`、`inbound-card-sanitize-r6.test.ts`。
- **A5 `_shared.md` 与 `_super.md` 对「复述」的写法冲突**：统一成「仅明确的小改动可跳过复述，其余先 `ask_user` 复述」；`skills/artifact-writer/SKILL.md` 里同一处措辞也对齐。`tests/prompt-reprise-consistency.test.ts` 只钉「两处说法一致」、不钉具体措辞。

**守卫 / 扫描（P3-B）**
- **H4-01（潜伏）旁路只读 shell 把预加载选项的值当脚本**：`node -r ./pre.js ../outside/evil.js` 里 `./pre.js` 被当脚本过了钳制、真脚本成了「普通参数」没人看（真 node 实测两个都被执行）；`--require=<路径>` 整体被当 flag 跳过。现在预加载选项（`-r` / `--require` / `--import` / `--loader` / `--experimental-loader` / `--test-reporter`，含 `=` 形态与 `file:` URL、npm `--node-options` 里的）连同其值先单独取出、走路径钳制 / 凭据文件 / 发布脚本名检查，再在剩余参数里找真脚本。**H4-10**：`SCRIPT_INLINE_FLAG_RE` 原是 `^-[a-zA-Z]*[ecp]` 前缀匹配，把脚本自己的 `-verbose` / `-print` / `-quiet` 误当内联代码；改精确匹配。**H4-09**：`COMMENT` 关键字只在语句开头才算写（`JOIN comment ON …` 是联接条件、不再误拒；**订正第五轮写的 `COMMENT\s+ON`**——那个不锚定的写法仍会误拒联接）。`sql-readonly-guard.ts` 与 `scripts/pg-exec.mjs` 内联的一份保持同步。**H4-03**：secret-scan 的 YAML 缩进继承只对「语义上像凭据本体」的子键生效（`value` / `data` / `key` / `secret` / `token` / `password`…），`secrets:` 下 `backend: "aws-secrets-manager"` 这类配置性子键不再误报。⚠ 取舍：「名字 → 密文」型映射（`secrets:` 下 `smtp: <口令>`）的子键名不是凭据词，不再靠父键继承命中（有测试明写为已知残留）。
- 测试：`readonly-shell-preload-path`（85）、`readonly-shell-preload-inline`（93）、`team-library-secret-scan-inherit-keys`（59）、`sql-readonly-guard`、`pg-exec`。

**幂等（P3-C）**：H3-01 / H2-06 `task-question-inject.ts`——幂等表原先只在 200 **之后**登记（并发重发仍会双注入），且只比 id（同 id 不同正文也回 `deduped:true`、真新消息被吞）。现在入口**同步**登记「处理中」、表项带正文指纹；同 id 同正文并发只注入一次（后到者等第一次：成功 → deduped；失败 → 登记撤销、自己走一遍）；同 id 不同正文按新消息处理；各种失败路径一律撤销在途登记；僵死在途项可被接管、等待有上限（回 409、防双注入）；等待期间 stop 不会借重试把被取消的输入复活；deduped 的 200 回放首次的 `persistWarning`。全走真实注入链，时钟用 fake timers（不真等）。`tests/task-question-inject-inflight-dedupe.test.ts`（31）。

**其它收口**：`talk-send-attempt.ts` 头注释更新（与「重试复用同一 `clientItemId`」的现状一致）。

**本轮拍板的小项（没有再问用户）**
- 关联回执（`expect_group_reply`）**不加**限流豁免——它本来就不经过限流（见必修 3）。（⚠ 第七轮订正：只在有活会话时成立；没有活会话的回执会走旁路、计入个人限额，已改成只计总限额，见 K2-01。）
- 收缩判定里 **`true` 算「非空」**（报告原话如此）：副作用是布尔开关从开改关会被当成一次收缩、重写一次 `.bak.shrink`（内容是旧配置，无害，但会顶掉更早的那份）。记在残余里，没改。（⚠ **第七轮订正，「无害」是错的**：`.bak.shrink` 的价值就在「只被下一次真收缩覆盖」；默认开启的 `teamKnowledgeEnabled` / `isolateWorktreeDefault` / `feishuBridgeKeepAwake` 从开改关就能把「repos 误清之前」的好备份顶成「repos 已空」的状态——审查方实证。第七轮 P2-1 已把判定收窄到凭据与列表类键，见「第七轮」。）
- F4 的两处小措辞（`artifact-writer` 与 `talk-send-attempt` 注释）顺手对齐。

**本轮新增 / 订正后的残余（没修，需要知道）**
- **测试里仍有一处真实 2 秒退避**：`tests/chat-background-result-close-reason.test.ts` 的「陈旧结果不会被同 agentId 的后来重连投递」要走完整的自动重连链，而 `RECONNECT_BACKOFF_MS`（chat-runner 内常量、`sleepWithCancel` 用 1 秒分片 + `Date.now`）**不可注入**；`chat-steer-reconnect-replaced` 等既有重连用例同样是真退避。报告 §五 要求「避免真等」，这里没做到——要做需要给退避注入时钟（改生产代码），没做。
- **旁路只读 shell 的预加载盲区**：带值但**不是预加载**的 node 选项（如 `--conditions <x>` 一类的「选项 + 值」形态）仍会让「第一个非 flag 参数」判错脚本；`bash -eu script.sh` 这类合并短选项被整体拒绝（偏严）。当前没有调用方传 `readOnly: true`，仍然潜伏。（⚠ **第七轮订正，这里写的是「判错脚本」，实际方向是放行**，而且不只 node：`bash -o pipefail ../outside/ok.sh`、`node --conditions dev ../outside/evil.js`、`npm test --prefix ../outside`、`pnpm --dir=../outside run test` 全部 `ok:true`〔审查方实证〕；已在第七轮 K4-01 按 fail-closed 修好，覆盖 bash / sh / node / npm / pnpm。`bash -eu script.sh` 偏严的取舍不变。）
- **secret-scan**：本轮真实文件对比里又有两处命中需要人看（沿用「误报是摩擦不是阻断」的口径）。
- **「已送达」之后抛错的双注入**：`task-question-inject.ts` 里底层注入已成功、之后抛出的异常会撤销在途登记，重试会再注入一遍；僵死在途项的接管同理（至少一次）。
- **更新**：mac 的 UI 不展示 `updateState.error`（只有 Windows 的徽标带）；`macSelfUpdate`（用户点徽标那条路）对失败仍是通用弹框、没走三类处置；mac 未归类的错误后台静默（只进日志和 `state.error`）。（⚠ **第七轮已修，除 UI 不展示 `state.error` 外这条已过期**：`macSelfUpdate` 的验签类失败现在按 `buildVerifyRejectionNotice(err, { trigger: "user" })` 取标题 / 正文 / 是否开页（K3-04）；未归类错误现在进退避、连续 3 次提示一次（P2-2）。见「第七轮」。）
- **协议**：`` `NO_REPLY`（说明） `` 仍按「哨兵 + 说明」静默（有意保留，测试钉着）；`▶ 🔧 …` 形态的普通要点行仍会被当面板头剥掉（但不再连累后面的正文）；回放被限流丢弃时对提问人静默、只有属主事件流一条 info。
- **报告 §四「其余 P3」（审查方没复核，供排优先级，本轮均未处理）**：队列 H2-02…05 / H2-08…11（其中 H2-02：任务 / 动作帧每次都「取出、完整读任务、放回」，撤回可能在这个窗口丢失）；前端 H3-02 / H3-04 / H3-05 / H3-06；更新 H5-03…09；steer H6-03…11；worktree 依赖 H7-01…10（H7-01 缺 `exit` 兜底，已在第五轮承认）；设置 H8-03…12（**H8-11 指出「`putSettingsFile` 是唯一落盘入口」的说法不成立**，且有死导出 `writeSettingsFileAtomic`，别再引用那句话）；协议 H1-07…12。
- **第五轮「残余清单」漏列、现补上**（均来自第五轮 review 的子代理报告、没修；一句话说明）：
  - G5（task 消息排队）：**G5-04** archive 对 chat / 非 worktree 任务早返回、没走到清队；**G5-05** `isBusy409` 靠中文错误文案子串判忙，新抽的 lifecycle 阻塞文案不含这些子串、会被当「非忙」丢弃；**G5-08** `putBackToHead` 可在清队之后复活条目；**G5-09** GET / DELETE `talk-queue` 用 `getTask` 全量 hydrate events，应改 `getTaskMeta`。
  - G3（群路由 / 队列）：**G3-07** 入队前有 `await`、可能错过「刚好空闲」的唤醒（G3-01 的兜底重试链把窗口压到约 5.5 秒内，不是靠「run 释放」事件）；**G3-09** 属主豁免只判 `rawBusy === GROUP_TASK_RUNNING`，主链与旁路同时在飞时属主消息仍被豁免进队、回放可能与旁路并行（文档写的「旁路在飞仍拒收」只对没有主链在跑的情形成立，已在 `feishu-group-collab.md` 注明）；**G3-10** 撤回 / 清空 / 终结对排队提问人没有交代，`unshiftGroupQuestionQueue` 可能复活已清空的队；**G3-11** 属主排队消息回放时没有群回流（结果只在 app 里）、带图 base64 进 talk 队列不受「带图不排」约束。
  - G2（答疑旁路）：**G2-05** 旁路拉上下文的 lark-cli 调用落单不取消、无 in-flight 共享，会挤占全进程单飞队列。
  - G4（前端群问答）：**G4-03** `TalkQueueBanner` 卸载重挂就重新自动弹开；**G4-04** 撤回忽略结果、失败 / 删不到时没有反馈；**G4-05** 逐字段校验没覆盖群来源会渲染的字段、也没有上限；**G4-07** 隐藏之后 `restricted_run` 并进 `isRunning` 成了副作用，卡住提示仍把被藏事件当活跃信号；**G4-08** 新增 UI 违反 `ui-conventions.mdc` 的几条；**G4-09** 同一 runTag 多条汇总时 `key` / DOM id 重复；**G4-10** 卡片 `memo` 被 `events` 击穿、「点开才算」的注释不准；**G4-11** 「待你决定」红点没有「已处理」出口、两处各算一遍。（G4-06 已在第五轮修掉。）
- **订正清单**（上面各处已就地改，这里汇总方便核对）：F4-01 的诊断（「得动 `chat-queue-send-now.ts`」→ 是判据）；限流描述（「被受理就计 12 条」→「起了 run 才计、每人 4、总 12」）；`inspect-git` 测试「31 个场景」→ 13 个 `it`；**F3-02** 的描述（此前被并进 `isAskCardPatched` 一条里——F3-02 是「会话已死时的 ask 注入 / 点卡补写作废标记并置卡」，`isAskCardPatched` 是 F3-01）；**G1-06**（`▶` 面板头无 `▲` 时一路剥到文末——第五轮只让「形态对」的才算面板头，本轮 H1-06 再把「面板体」限定为缩进行）；round-4 M3-01 的「窗口内多个 EOCD 签名则拒绝 / 误报风险」与 round-5 去掉该规则的矛盾（以后者为准）；round-4 M3-04 的 mac「不再自动重下」与 round-5 F1-01 的「暂时性失败按时间退避」的矛盾（只对确定不符 / 没带清单成立）；「提交前必须拆分」。另外 `docs/feishu-group-collab.md` 的限流口径、回复协议第 1 / 3 / 4 条、入向面板剥离、「诚实的局限」和单测清单已同步。
- **提交建议（订正第五轮那条做不到的）**：工作区几百个改动没提交（风险高）。**未跟踪的新文件没有 hunk 可拆**——`worktree-deps.ts` / `repo-shell-command.ts` / `sql-readonly-guard.ts` 之类，要连同依赖它们的修改**放进同一个功能提交**。建议按「功能」分 5–6 个提交：① 本任务的审查修复与安全加固（含 `ci.yml` / `release.yml` / 脱敏 / 守卫 / 更新验签）；② 群协作 v2 的修复（`feishu-bridge/*` + 提示词 + 对应测试）；③ chat 收尾 / steer / 后台子代理（`chat-runner.ts` / `chat-queue*.ts` + 测试）；④ 事件流 v2（`ui-conventions.mdc` / `markdown-text.tsx` / `event-stream*`）；⑤ worktree 依赖预装 / 侧边栏分组 / 仓库命令（另一任务）；⑥ 删除项（`.cursor/rules/subagent-no-fast.mdc`、`sdk-gate.yml`）。**只有「两个任务写在同一个已跟踪文件里」的（`task-runner.ts` / `task-worktrees.ts` / `settings-fs.ts` / `use-settings.ts` / `repo-card.tsx` / `sidebar-groups.ts` 等）才需要 `git add -p` 按 hunk 拆。** `installer.nsh` 属另一任务，单独提交。
- **建议的下一步**：审查方提的窄范围复核——只看 5 个 P2 涉及的位置（`chat-queue-send-now.ts` 与 `chat-runner.ts` 的收尾顺序、`drainBackgroundResults`、`admitGroupBypassRun` 的起 run 点、`putSettingsFile` 的收缩备份、`runUpdateCheck` 的失败分流）和对应的收尾顺序测试，不需要再全量通审。
- **验证**：`tsc --noEmit` 退出 0；`eslint .` 退出 0；全量 vitest（CI 口径：`PATH` 含 `/opt/homebrew/bin`、`CI=1`）**506 个文件通过 + 1 个跳过、8693 个用例通过 + 3 个跳过，退出 0**（第五轮收尾是 495 / 8235，本轮净增 11 个文件 / 458 个用例，大头是子代理补的协议 / 守卫 / 限流测试）。跑之前确认全仓没有别的写入者。⚠ 前端改动与 Windows / mac 更新链仍没有真机 / 浏览器验证。

**第七轮：对第六轮修复的复核修复（2026-10-15，未提交）——用户转来「第七轮 review 结果」**
> 来源：另一个 AI 对第六轮修复的复核报告（审查方**没有改仓库**，没有新的 P0 / P1；P2×2 + P3 若干 + 文档订正；各条「已拍板」已经定了，没有再问用户，不同意的要带理由和最小反例回报）。做法：P2-1 / P2-2 与四组 P3（设置 / 更新、群限流 / 幂等、只读守卫、协议 / 面板 / 扫描）交给写入子代理，K1（chat 收尾 / steer）我自己做，最后我读码核对 + 补测试 + 订正文档。每项先写红灯（红在真缺陷上）→ 最小修复 → 绿 → 回退自检（撤掉修复必须变红、md5 还原核对）。所有写入者都限定「只改自己那一块」，跑之前确认全仓没有别的写入者。

**P2-1 · 收缩备份只看「凭据与列表类」键**（`settings-fs.ts`）
- 审查方实证：把默认开启的 `teamKnowledgeEnabled` 从 `true` 改成 `false` 也算收缩，`.bak.shrink` 被改写成 repos 已空的状态，误清 repos / apiKey 之后留下的好备份就没了。
- 现在 `SHRINK_WATCHED_KEYS` 只含 `apiKey` / `gitToken` / `repos` / `mcpServers` / `customProviders`；所有布尔开关、`starredModels`、`disabledSkills` / `disabledRules` / `disabledMcpServers`、`branchTemplate`、`defaultModel`、`userRole` 一律不算，`true` 不再是「非空」（只认非空串 / 非空数组 / 有自有键的对象）。**嵌套清空专项**：`customProviders` 里某条的 `apiKey` 被清空或整条被删（按 `id` 对齐；本来就没有 key 的本地端点不算）；`companyEnv` 的任一子系统（`servers` / `pg` / …，取自 `emptyCompanyEnv()` 的键，新增子系统自动纳入）从「有用户填的内容」变成没有。
- **与「已拍板」的差异（有理由）**：审查方只点了 `servers` / `pg` 两个内层。实现按**全部子系统**判，并给「空白行」豁免——设置页点「添加」会立即把默认行（只带 `env` / `port` / `db` / `readonly` / `namespaces`）落盘，添加再删掉不该算收缩，否则这一来一回就把好备份顶掉（与 `company-env-card` 的 `isBlankRow` 同口径）。`customProviders` 整条被删（其它条还在，顶层数组仍非空）也算。
- 验收按报告：`tests/settings-fs.test.ts` 里把「`true→false` 是收缩」改成「不是收缩」；补与审查方序列等价的用例（完整配置 → `repos: []` → 只关一个开关 → `.bak.shrink` 仍含旧 repos 与 apiKey）。

**P2-2 · mac 未归类错误：退避 + 连续 3 次提示一次**（`main.js` / `update-verify-retry.mjs`）
- 旧：`downloadAndStageMacUpdate` 的 `catch` 只对「永久」「Unavailable」两类登记，dmg 502 / 不完整 / `hdiutil attach` 失败 / `ditto` 失败（磁盘满）/「dmg 里没找到 .app」既不退避也不弹框，每次轮询和每次设置页「检查更新」都完整走一遍「清单 → 下载 100MB+ → 失败 → 删除」。
- 现在 `catch` 里 `else` 分支对**一切非永久失败**都 `nextVerifyRetry`（`failures` 同时就是「连续失败次数」）；后台触发、同一版本连续失败 ≥ 3 次（`REPEATED_FAILURE_PROMPT_AFTER`）→ 弹**一次**「自动更新多次失败」说明框（不开发布页，提示点徽标重试或手动下载）。成功暂存清掉计数与标记。
- **与「已拍板」的差异（有反例）**：报告写「用一次 `wasPrompted` 名额」。`wasPrompted` 是每版本一次的**持久**名额，确定不符 / 没带清单的安全告警也用它（`alreadyPrompted` 为真时后台全部静默）。反例：同一版本先 3 次暂时性失败（名额被「多次失败」框占用）、第 4 次真出现「确定不符」→ 因名额已用而静默，**完整性告警丢失**。所以「多次失败」框用独立的进程内标记 `repeatedFailurePromptedVersion` 去重，不碰 `wasPrompted`。代价：重启后同一版本再连续失败 3 次会再提示一次（可接受）。
- ⚠ **需要你知道、没修**：退避**挡不住 2 小时轮询**。退避窗口 5 / 10 / 20 / 40 / 80 分钟都短于 2 小时，前 5 次失败时轮询必然放行、会照样重下一次 dmg；只有封顶（120 分钟）之后才可能隔一轮跳过。报告写的验收（「连续两次 `runUpdateCheck`，第二次被退避跳过」）只对**非轮询触发**（设置页「检查更新」）成立，已按此写进测试。要真正让轮询对「未归类错误」收手，得把退避上限拉到大于 2 小时或让轮询也计失败，这是产品取舍，没动。（⚠ **第八轮订正：这两个杠杆都不对**——上限只在第 6 次失败之后才生效，`failures` 本来就不分触发方式地在累计，轮询对它们没有反应是因为退避分支**只读 `notBefore`、不读 `failures`**。真正缺的是「按 `failures` 设闸」，第八轮 L2-01 已补：同一版本「会白下 dmg 的失败」累计 3 次后，后台轮询不再自动暂存〔⚠ 第九轮复核订正：是「累计」不是严格「连续」，见「第八轮」L2-01〕，见「第八轮」。）

**P3 · 设置 / 更新（K3）**
- **K3-02**：嵌套层面的清空并入 P2-1 的专项检测。**K3-04**：`macSelfUpdate`（点徽标）对验签类失败改用 `buildVerifyRejectionNotice(err, { trigger: "user" })` 取标题 / 正文 / 是否开发布页，其余保持通用弹框。**K3-05**：设置页「检查更新」那条路的 `.catch(() => {})` 会吞掉第一次确定不符，之后后台轮询又因已登记永不弹——现在手动路径也走同一个处置函数 `handleMacStageFailure(err, version, trigger)`（`trigger: "user"` 三类都弹框、不看 / 不消耗 `wasPrompted`）。「谁登记、谁弹框」是两件事，已写进注释；此前 HANDOFF 的「只在真的弹了框时登记」不属实（见上方就地订正）。**K3-06**：清单级 Mismatch（签名 / 版本 / 条目缺失）发生在下载**之前**，弹框却说「已清除下载的文件」——`buildVerifyRejectionNotice` 新增 `fileState: "cleared" | "kept" | "none"`，正文按真实情况措辞（只影响 `body`，不影响任何标志位）。⚠ Windows 路径：`rejectUnverifiedWinUpdate` 在**删除之前**不知道 rm 会不会成功，所以先按处置结果取标志位、删完再用真实 `fileState` 取一次正文——「如实说清除了没有」比「事先写好」优先，已在代码注释里写明。**K3-11**：「待安装文件与已验签文件不一致」从暂时性归为确定不符（文案原来说「不代表安装包有问题」，自相矛盾）。
- **K3-07**：`isBypassBlockedReadPath(path, platform)` 在 darwin / win32 两侧做 casefold（linux 保持大小写敏感），对**已存在**的路径再补 dev + ino 比对（stat 失败安静回退到词法判断、绝不抛）。残余：Windows 8.3 短名 / 尾部点 / `::$DATA` 没实测；`.corrupt-<ts>` / `.tmp.*` 的硬链接不在 inode 比对范围；`config.json` 保存是 rename 覆盖、inode 每次都变，保存之前造的硬链接认不出。`tests/readonly-blocked-path-casefold.test.ts`（18）。
- **K3-08**：订正「整族」措辞（见上方就地订正）；`hardenConfigFilePerms`（启动时）顺手 `cleanupStaleSettingsTmpFiles`，清掉遗留的 `config.json*.tmp.*`（只认 `config.json` / `.bak` / `.bak.shrink` 三种目标）。**K3-09**：`settings-unreadable.ts` 的恢复指引补一句 `.bak.shrink`。**K3-10**：`putSettings` 以前丢掉状态码，400 也重试 3 次、toast 却说「将自动重试」不真——`local-store.ts` 新增 `saveSettingsDetailed`（带状态码），`save-retry.ts` 对 4xx 不排重试（`onRejected` 回调），`use-settings.ts` 对应改。

**P3 · 群限流 / 幂等（K2）**（`group-shared.ts` / `group-route.ts` / `task-talk-queue.ts` / `task-question-inject.ts` / 新 `task-inject-shared.ts`）
- **K2-01**：命中登记的关联回执（`expect_group_reply`）**只计总限额、不计个人限额**（`admitGroupBypassRun` 的 `correlatedReceipt`；它的 stamp 也不进个人计数，不会挤占该人后续普通提问的额度）；`feishu-group-inbound.test.ts` 里被改成 4 轮的「连发」用例恢复成 6 轮。
- **K2-02**：排队回放被限流丢弃时，对**真人**提问人补一句群内提示（每窗每人一条，`claimGroupBypassDropHint`；机器人保持静默，先判 `groupReplyMention` 再认领名额，免得机器人白占；不回显原文）。
- **K2-03**：新增 `TASK_INJECT_BUSY_CODE = "task_busy"`（响应体 `{ error, code }`），`isBusy409` 认**结构化标记**、不再靠中文文案子串；只给会自己恢复的忙类 409 打（agent 还在跑 / 同一条消息上一次还在处理中），停止 / 删除 / 终结中 / 状态已变 / 队列已满不打。同时顺手解掉 G5-05。（⚠ **第八轮订正，「解掉」说过头**：`task-talk-queue.ts` 的文案兜底 `msg.includes("正在跑")` 仍保留（兼容未带标记的旧响应），且「正在停止」这类同样会自行恢复的 409 当时没打标，回放时被当非忙丢弃——第八轮 L3-02 已给停止中补标记并让回放对它分流，见「第八轮」；文案兜底保留。）
- **K2-04 / K2-05**：排队路径的去重由「只按 id」改为「**id + 正文指纹**」（`fingerprintTaskQuestionBody`，sha256，只存哈希不存原文，三处共用：空闲直送的在途 / 已送达两张表、排队去重、直送后摘队）；直送成功后 `removeTalkQueueItemsByDedupe` 顺手摘掉队列里同一条（delivered 表只留 2 分钟、短于队列等待，否则 TTL 后的重放会二次注入）。**与「已拍板」的差异（有反例）**：报告写「摘掉同 id 的排队项」，实现按 id **且**指纹都一致才摘——同 id 不同正文是另一条真消息，只按 id 摘会把它吞掉（与 K2-04 同一个理由）。
- **K2-06 / K2-07 / K2-10**：几处注释订正（忙线判定与 admit 之间有 `await loadBootContext()`，只保证「`admit` 返回到注入调用之间无 await」；僵死接管只发生在清扫那一刻；`talk-send-attempt.ts` 头注释不再说「服务端只按 id 去重」）。**K2-08**：个人限额的 info 节流改按发送人分桶。**K2-09**：发送人 key 退到展示名时加 `name:` 前缀（稳定 ID 永远是 `ou_` / `cli_` 之类的服务端串、不会撞）；空 `messageId` 直接放行、不计数、不记 stamp（生产上到不了，是防御）。
- 测试：`group-bypass-r7`（22）、`task-talk-queue-r7`（12），并改了 `task-talk-queue` / `group-bypass-limit` / `group-bypass-admit-at-start` / `feishu-group-inbound`。

**P3 · 只读守卫（K4-01 / K4-10 / K3-07）**（`pi-coding-tools.ts`，**潜伏**：当前没有调用方传 `readOnly: true`，**接线之前必须保持这套 fail-closed**）
- **K4-01**：带值但不是预加载的选项会让真脚本逃过全部检查，方向是放行——`bash -o pipefail ../outside/ok.sh`、`node --conditions dev ../outside/evil.js`、`node --env-file .env ../outside/evil.js`、`npm test --prefix ../outside`、`pnpm --dir=../outside run test` 全部 `ok:true`。改成 fail-closed：`pickScriptOperand` 在「前导选项带值」时一律拒——bash / sh（`-o` / `+o` / 含 `o` 的合并簇 / `-O` / `--rcfile` / `--init-file`）、npm / pnpm（`--prefix` / `--dir` / `-C` / `--workspace` / `-w` / `--userconfig`，空格与 `=` 两种形态）、node（白名单布尔旗标之外的 `--xxx` 必须是 `=值` 形态）；脚本必须是「只带白名单旗标之后」的第一个操作数。
- **与「已拍板」的差异（有反例，真 bash 5 / npm 10 / pnpm 10 / node 22 在临时目录实测）**：更严，补了同类写法——`npm --loglevel test run deploy` / `pnpm --reporter test run deploy`（`test` 被当成动词，真正跑的是 `deploy`，发版脚本名检查被绕开）→ 给 npm / pnpm 做了**动词前选项白名单**；`npm --prefi=<dir>`（npm 的 nopt 接受唯一前缀缩写，字面名黑名单拦不住；pnpm 不缩写）→ 加缩写处理；`node --run=deploy`（等号形态也能跑 package.json 里的脚本、绕开发版脚本名检查）→ 一并拒。选项后面紧跟仓内合法脚本**也拒**（校验层不认识这个选项，就无从确认哪个操作数是脚本）。`tests/readonly-shell-value-options.test.ts`（208）。
- **K4-10**：预加载与脚本的相对路径按 `cwd` 判而不是 `workCwd`、纯词法、符号链接指向仓外会放行——只会偏严、没找到放行方向的绕过，仅补注释，记入残余。（⚠ **第九轮复核订正 N9-01：「只会偏严」只对 `cwd` 与 `workCwd` 的差异那一点成立，对符号链接不成立**——软链恰恰是放行方向，而且不只脚本 / 预加载，以软链做路径前缀的 `cat` / `node` / `bash` 操作数同样 `ok:true`。接线前要对所有路径操作数做 realpath 再钳，见「第九轮」。）另订正 `readonly-shell-preload-inline` / `readonly-shell-inline-family` 里的旧名 `SCRIPT_INLINE_FLAG_RE`（现为函数 `isInlineCodeFlag`）与「至多 2 个字母」（代码是 ≤3）、`pi-coding-tools.ts` 里暗示 bash 不拒 `-e` 的注释（实际拒，偏严）。

**P3 · 协议 / 面板 / 扫描（K4-02…07、K4-11）**（`group-reply-protocol.ts` / `group-contract.ts` / `inbound-card-sanitize.ts`）
- **K4-02**：整行被一对反引号 / 引号包住的 `` `NO_REPLY：对方只是确认` ``（行首包裹符与行尾配对）按「哨兵 + 说明」静默；`` `NO_REPLY`：说明 `` 这种仍是「在解释哨兵词」、照发（写进残余）。**K4-03**：`noteOnly` 要求「首个括号配对之后恰好到行尾」——`` `NO_REPLY`（先说明）接口是 /a/b（见文档） `` 不再被整条静默、真正的回复不再被吞。**K4-04**：属主确认标记的判定在 **NFKC + 去 Cf** 的折叠文本上做、剪切在原文上做（`foldWithMap` 位置映射），全角 `［［…］］`、括号后夹零宽字符都认，发群的永远是原文。**K4-05**：说明按括号配平（`看 a[0]]]` → 说明 `看 a[0]`、不残留孤立 `]`）；围栏 / 行内代码里的标记当示例不触发（不留空围栏）；说明里含空行时满足「行尾闭合 + 近 + 配平 + 无别的起头」才算闭合。**K4-07**：面板体缩进只认 ASCII 空格和 tab、**排除 `\u3000`**（全角缩进的段落不再被当面板体剥成空）；`inbound-card-sanitize-r6` 里钉着「吞正文」的那条改成「已知缺陷·现状如此、不是规格」。⚠ **报告里「`▶ 🔧 修复登录` 下缩进的 `- 改了 a.ts` 子项被剥」没有修**：面板体的定义就是「紧跟面板头的缩进行」，这类普通要点的子项在形态上与真面板体无从区分，已在 `inbound-card-sanitize-r7` 里明写为已知局限（记入残余）。**K4-06**：`team-library-secret-scan-inherit-keys` 的注释改成真实阈值（`secrets:\n  smtp: <16 位口令>` 这类 16 位口令无命中，高熵规则要求 ≥20 字符）并记入残余。**K4-11**：删除 `GROUP_NEEDS_OWNER_RE`（生产没有调用方、还留着二次型陷阱）。
- 测试：`group-reply-protocol-r7`（145）、`inbound-card-sanitize-r7`（8），调整了 r6 / 原测试里钉住旧行为的几条。

**K1 · chat 收尾 / steer / 后台结果（我自己做）**
- **K1-01（真缺陷，已修）**：`markChatSystemClose` 只记「摘表时」的 generation，用户停止的清队若先于系统摘表，就被吸收进基线、已撤销的消息被重排回来。修法：标记同时记**系统清队前**（`preClearGeneration`）与**摘表时**（`generation`）两个值；`closeChatSession` 新增 `queueGenerationBeforeClear` 选项，cancelled 收尾 / error 收尾 / `finalizeChatRunSafely` 兜底三处在**清队前、同一同步段内**读 generation 并带进来（forceClear / 重连没有自己的清队，省略 = 当前值）；`requeueAsFollowup` 只有「清队前 == steer 开始时（`genAtStart`）**且**当前 == 摘表时」才算用户没介入，否则记 `failed(stopped)`；更早一次关闭留下的陈旧标记（清队前的值小于 `genAtStart`）忽略、退回 `genAtStart` 基线（⚠ **第八轮订正：这条「陈旧标记守卫」在真实路径上走不到**——`replaced` 必然伴随同一同步段里写下的新标记——所以别把它读成「防住了真实场景」；第八轮已把它换成按标记 `seq` 判「这次 steer 开始之后有没有发生系统关闭」，守卫本身删了）。用显式传参、不用「待清」全局标志（后者要靠微任务过期，容易误吸收别的关闭）。`tests/chat-steer-requeue-by-reason.test.ts` 新增 3 组 6 条：用户停止的清队先到 + forceClear 后到（红→绿，`hang` / `reject-on-close` 两形态）、用户的清队落在 restart 取消信号之后、取消收尾自己清队之前（走真实 cancelled 收尾，红→绿）、系统先摘会话 + 用户清队紧随其后（回归守卫，原本就对）。⚠ 可达性审查方也没核实（取决于「停止之后 `stopping` 闸门是否挡住系统强清」），按「宁可多挡一个误重排」处理。（**第八轮核实：可达，但很窄**——`chat-inject.ts` 懒重启流程是 `cancelChatRun(restart)` 等 5 秒、超时再 `forceClearChatRun`，用户在这 5 秒内点停止而旧 run 没退出，强清就发生在用户清队之后；真实「停止」走 `stop-task.ts` 的 `cancelChatRun()`，会把 `pendingCloseReason` 清成 `undefined`，取消收尾不打标。）
- **K1-02**：`sendChatMessage` 里 `agent.send` 抛错走的 `reason: "error"` 关闭**不是** run 出错收尾——不清队、不并入 `inflightSteers`；在飞 steer（理论上只可能是上一轮刚结束、宽限内没落定的）会被唤醒为 `replaced`、**重排队首**，不是 `failed(error)`。已订正代码注释与上面第六轮的终态表。
- **K1-04**：删 `ChatSystemCloseMark.reason`（无人读取，连带删了 `ChatSystemCloseReason` 类型）。**K1-05**：新增 `discardStashedBackgroundResultsForDeletedTask`，`DELETE /api/tasks/[id]` 在清队之后静默清掉重连窗口里暂存的后台结果（含 10 分钟时效计时器；不写「未送达」——任务没了、没人看事件流，往已删目录写事件还可能把目录又建出来）。**K1-06**：结果批 steer 超过 30 分钟总期限时，`steerChatRun` 新增 `onTimeout` 回调（给了就表示调用方自己负责说明、本函数不再写面向用户插话的「一条插话…」）；`drainBackgroundResults` 单独写「N 条后台子代理的结果未送达主 AI（等了 30 分钟仍没被这一轮收下；会话还在，若 AI 稍后仍读到会照常使用）」，不再套「会话已被停止或关闭」。**K1-07**：订正 `drainBackgroundResults` 里 `cancelled` 分支的过期注释（出错 / 懒重启 / 重连摘实例是 `replaced`，不会走到那里）。
- 报告 §五 缺的用例：restart / forceClear 重排后「真的被送出」（新会话 resume + 首条跑完后收尾 flush，断言新会话 `send` 第 2 次调用就是 steer 原文、台账 `delivered`、气泡只有 steer 路径落的那一条）、**多条在飞 steer**（error 收尾并入两条、各记 `failed(error)`、提示里算 2 条）、K1-06 的措辞（fake timers）、K1-05 的计时器（`vi.getTimerCount()` 差值）。

**测试质量（报告 §五）**：补了 K1-01 的顺序用例、restart 重排送出、多条在飞 steer；K2-02（回放被限流丢弃的反馈）与 delivered 过期后的队列重放由 `group-bypass-r7` / `task-talk-queue-r7` 覆盖。**已处理**：`update-manifest-failure-kinds` 里对整份 `main.js` 的 `not.toMatch`（报告指出与「不新增 grep 契约」有出入、注释里提到那两个名字会误红）已撤掉，「未归类错误也登记退避」改由 ③e 的 P2-2 用例走真实函数体守；`settings-safety-contract` 的 grep 断言补了注释，明写「源码形态契约、不是行为证明」。**没动**：`scaling-ratio` 阈值 3 的 CI 抖动余量（要改得连 helper 一起评估）、`settings-backup-exclusion`（特征化测试，回退任何修复都不红，本来如此）、`settings-safety-contract` 里那条 grep 断言本身——记入残余。

**本轮订正清单**（上面各处已就地改，这里汇总方便核对）：① `macVerifyFailedVersion`「只在真的弹了框时登记」不属实；② 「带值非预加载选项」写成「判错脚本」实际是放行、且不止 node；③ 「`file:` 预加载仍有盲区」已过期；④ 「关联回执不经过限流」只在有活会话时成立；⑤ 「整族」脱敏说过头（三个槽）；⑥ 「`true` 算非空、无害」不对（会顶掉好备份）；⑦ 第六轮 K1 的基线只挡「摘表之后」的用户介入；⑧ `sendChatMessage` send 抛错的 error 关闭不是 `failed(error)`；⑨ 「mac 未归类错误后台静默」→ 现在退避 + 连续 3 次提示一次（但仍挡不住 2 小时轮询，见 P2-2）。`docs/feishu-group-collab.md` 的限流口径、关联回执、去重 / 忙判定、回复协议第 1 / 3 条、面板缩进、`GROUP_NEEDS_OWNER_RE`、残余清单与单测清单已同步。**`prompts/_shared.md` 里两处与 R6 决议无关的改动**（「`ask_user` 留痕唯一例外」、§8 review 补录规则）：来源是哪一轮、谁改的我也没核实——没有动，也没有回退，提交前请确认是不是你要的。（第八轮核实了一部分，见「第八轮」末尾：这两处与 `_super.md` / `action-build.md` / `action-review.md` 的改动互相一致、不是我们任何一轮改的，**是否保留仍需你拍板**。）

**本轮新增 / 订正后的残余（没修，需要知道）**
- **mac 2 小时轮询会对「未归类错误」继续重下 dmg**（见 P2-2）：退避只挡非轮询触发的自动暂存。
- **旁路只读 shell（潜伏）**：K4-10（预加载 / 脚本的相对路径按 `cwd` 判、纯词法、符号链接指向仓外会放行——**偏严不偏松只对 `cwd` / `workCwd` 的差异成立，软链是放行方向**，第九轮 N9-01 订正）；Windows 8.3 短名 / `::$DATA` 没实测；`bash -eu script.sh` 仍整体拒（偏严）。
- **协议 / 面板**：`` `NO_REPLY`：说明 `` 仍视为「在解释哨兵词」、照发；说明里含空行时，若空行之后一段话恰好在近处以 `]]` 结尾，会被当成说明的延续；`▶ 🔧 修复登录` 之类带图标的要点行下缩进的子项（`  - 改了 a.ts`）仍会被当面板体剥掉（形态上无从区分，不是全角缩进那种可修的误判）。
- **secret-scan**：`secrets:` 下「名字 → 16 位口令」的映射仍无命中（高熵规则要求 ≥20 字符）。
- **settings**：收缩检测的盲区仍是「条目还在、只清了其中一个字段」（`.bak` 能兜一次，`.bak.shrink` 只留给整块没了）；`companyEnv` 的空白行豁免依赖与设置页 `isBlankRow` 同口径（改一处要改另一处）。
- **K1**：K1-01 的可达性未核实（见上）；restart / forceClear 重排的消息靠新会话 run 收尾 flush 送出（至少一次、可能与旧会话已读到的重复）。
- **测试**：同第六轮——`chat-background-result-close-reason` 与 `chat-steer-reconnect-replaced` 仍有真实 2 秒退避；`scaling-ratio` 阈值余量；上述几处 grep 型 / 特征化断言。
- **报告 §四之外、前几轮已列的残余清单**（H2-02…05 / H2-08…11、H3-02…06、H5-03…09、H6-03…11、H7-01…10、H8-03…12、H1-07…12 及 G5-04 / 08 / 09、G3-07 / 09 / 10 / 11、G2-05、G4-03…11）本轮均未处理；其中 **G5-05（`isBusy409` 靠文案子串）已被 K2-03 顺手解掉**。
- **验证**（第七轮收尾，2026-10-15）：`tsc --noEmit -p .` 0 错、`eslint .` 0 告警、全量 `CI=1 vitest run`
  **514 个文件通过 + 1 跳过 / 9271 条通过 + 3 跳过**（第六轮收尾基线 506 + 1 / 8693 + 3；净增 8 个文件、578 条）。
  只在本机跑了一遍，没有 Windows / 真机验证（Windows 更新链路、mac 真签名 dmg 的退避行为都只有契约测试）。

**提交建议与下一步**：工作区现在 **374 个改动**（198 已跟踪修改 + 176 未跟踪），仍没提交，风险在累积。按功能分 5–6 个检查点：① 本任务的审查修复与安全加固（`ci.yml` / `release.yml` / 脱敏 / 守卫 / 设置 / 更新验签与 `update-*.mjs`）；② 群协作 v2（`feishu-bridge/*` + `task-talk-queue` / `task-question-inject` / `task-inject-shared` + 提示词 + 对应测试）；③ chat 收尾 / steer / 后台子代理（`chat-runner.ts` / `chat-queue*.ts` / `tasks/[id]/route.ts` 的暂存清理 + 测试）；④ 事件流 v2；⑤ worktree 依赖预装 / 侧边栏分组 / 仓库命令（另一任务）；⑥ 删除项（`.cursor/rules/subagent-no-fast.mdc`、`sdk-gate.yml`）；`installer.nsh` 单独。**未跟踪的新文件没有 hunk 可拆**，要连同依赖它们的修改放进同一个功能提交，只有「两个任务写在同一个已跟踪文件里」的才需要 `git add -p`。审查方建议下一步：只做一次定点复查——看 P2-1 / P2-2、K4-01、K2-08 / 09、K4-02…04 这几处修复，以及 K1-01 的顺序用例。

**第八轮：对第七轮修复的复核修复（2026-10-16，未提交）——用户转来「第八轮 review 结果」**
> 来源：另一个 AI 对第七轮修复的复核报告（审查方**没有改仓库**，**没有新的 P0 / P1**；唯一还开着的 P2 是 L2-01，其余是 P3 与文档订正）。做法：L2-01 与更新链 P3、设置、群限流、只读守卫、协议 / 面板 / 扫描各交给一个写入子代理，chat（L5）我自己做；最后我读码核对、补测试、订正文档。每项先写红灯 → 最小修复 → 绿 → 回退自检（撤掉修复必须变红，md5 备份还原核对）。⚠ **本轮有一次「重复派发」**：同一批文件被两个子代理同时改过，各自都把对方的改动当基线、没有覆盖；最终状态由全量 tsc / eslint / vitest 兜底，没发现遗留的回退。另外收尾时发现 `/tmp` 里有两个守卫子代理遗留的**孤儿 vitest worker**（父进程已没了、各占 90% CPU 跑了 20 多分钟，cwd 是它的沙箱 `/tmp/r8-l4-sbx`）——是沙箱里「改成恰好相等才取行尾」的实验卡住的，不是仓库代码；已杀掉，仓库的对应测试全绿。

**L2-01（唯一的 P2）· mac 2 小时轮询对「未归类错误」每轮整包重下 dmg：按 `failures` 设闸**（`update-verify-retry.mjs` / `main.js`）
- 根因订正：退避分支**只读 `notBefore`、不读 `failures`**；第七轮 HANDOFF 写的「拉高退避上限 / 让轮询也计失败」两个杠杆都不对（见上方 P2-2 的就地订正）。
- 修法：同一版本「会白下 dmg 的失败」**累计** `STAGE_GIVE_UP_AFTER`（= `REPEATED_FAILURE_PROMPT_AFTER` = 3）次后（⚠ **第九轮复核订正：本块原先写成「连续 3 次」，不准确**——成功暂存 / 换版本才清零，期间的 503 等清单阶段失败既不累计也不重置，所以「2 次未归类 + 5 个 503 + 1 次未归类」就会触发；`tests/update-verify-retry.test.ts` 已钉这条序列），`main.js` 登记进程内的 `macStageGiveUpVersion`；**后台轮询遇到它就跳过自动暂存，只记一行日志**。纯函数在 `update-verify-retry.mjs`：`isCostlyStageFailure` / `nextCostlyFailureRecord` / `shouldGiveUpAutoStage`。解除：换版本、成功暂存、重启。**用户手动检查与点徽标不看这个闸**，照常发起；成功则解除，失败则计数继续涨、闸保持登记（不会借一次手动尝试多放后台 3 次）。闸本身不弹框——用户想重试就点徽标（「多次失败」提示框的文案说的正是这个）。
- **与「已拍板」的差异（有理由）**：① 报告写「只统计非验签、非 Unavailable 的失败」。实现多算了一类——`Unavailable` 里的 **`local-io`**（dmg 已经下完、之后读盘 / 算哈希才失败，`verifyDownloadedUpdate` 在下载**之后**调用），它花掉了一次整包下载，不计入就会漏掉「磁盘出问题 → 每轮重下」。其余 Unavailable（5xx / 限流 / 超时 / 网络 / 清单结构非法 / 公钥）发生在下载 dmg 之前、只花几百字节，仍**既不计数也不清零**（穿插在中间不影响「连续」），否则 3 次 503 就会停掉轮询、废掉 F1-01 的网络恢复自愈。② 报告写「用户手动检查 / 点徽标**发起一次尝试**就解除」；实现是「**成功才解除**，失败不解除」。反例：dmg 本身有问题（502 / 不完整）时用户连点两次「检查更新」，若发起即解除，闸每次都被重置、后台轮询又白放行 3 轮。③ 计数口径**不分触发方式**（后台 / 设置页 / 点徽标的失败都计），与 `failures` 一致，所以「闸触发」与「多次失败提示框触发」不一定是同一次失败（提示框只在后台触发时弹、数的是含 Unavailable 的 `failures`）。
- ⚠ **闸是进程内的，重启清零**：重启后同一版本的坏 dmg 会再放行 3 轮才登记。是否要落盘是产品取舍（需要你定，见文末），没做。

**L2-02…06 · 更新链 P3**
- **L2-02**：手动检查 / 点徽标遇到**非验签类**错误（`ditto ENOSPC` 之类）时，不再套「暂时无法校验更新包 / 这不代表安装包有问题」的验签文案——`buildGenericUpdateFailureNotice` 与 `macSelfUpdate` 的通用分支、`handleMacStageFailure` 共用。**L2-03**：`dialoguedStageErrors`（`WeakSet<Error>`）+ `claimStageErrorDialog`：后台 handler 与用户 handler 处理的是**同一个错误对象**时只弹一次、只开一次发布页（轮询暂存在途时用户点「检查更新」不再双弹）。**L2-04**：「前 5 次必然放行」说过头，注释与文档改成真实条件（失败发生在触发后 `delta`，要满足 `delta > 2h − 退避` 才放行；5 次失败、最后一次发生在 45 分钟时，120 分钟时仍被挡）。**L2-05**：K3-11（待安装文件与已验签文件不一致）在 Windows 上现在**删除并开发布页**，而 `resumeRetainedWinInstaller` 里同一个条件只是静默回落——两处口径不同，只补注释说明；库内部的 `helper.file` 与事件 `downloadedFile` 能否不同**没核实**。**L2-06**：`rejectUnverifiedWinUpdate` 弹框前先 `fs.stat`，文件被杀软删了就不再写「已保留」。
- 测试：`update-manifest-failure-kinds`（218，`sliceMainFn` 加了「模块级 `let` 声明必须存在于 `main.js`」的守卫——删掉 `let repeatedFailurePromptedVersion` 之前测试仍绿、生产会抛 `ReferenceError`）、`update-verify-retry`（61）、`update-verify-disposition`（28）、`update-manifest-win-pending`（93）。⚠ 与前几轮一样，Windows / mac 真机都没跑过。

**L1 · 设置**（`settings-fs.ts` / `company-env.ts` / `company-env-card.tsx` / `save-retry.ts`）
- **L1-02**：清理遗留 tmp 只删严格形态 `STALE_SETTINGS_TMP_FILE_RE = /^config\.json(?:\.bak(?:\.shrink)?)?\.tmp\.\d+\.[a-z0-9]+$/`；读拦截仍用宽口径（用户手工的 `config.json.tmp.my-copy` 不再被误删）。**L1-01**：`saveWithRetry` 的 4xx 里 `RETRYABLE_4XX = {408, 425, 429}` 照常重试，其余 4xx 仍是「被拒、不重试」。**L1-03**：判收缩前对**上一份** `companyEnv` 也过 `normalizeCompanyEnv`（旧单对象格式清空不再漏报）。**L1-04 / L1-05**：`company-env.ts` 导出 `isBlankCompanyEnvRow`，服务端与设置卡共用一份判据（豁免字段 env / port / db / readonly / namespaces）；补了真实默认行（`env: "test"`）的用例；`use-settings.ts` 用 `saveSettingsDetailed` 与 `onRejected` 的接线补了一条**源码形态契约**（诚实标注：它只防「被换回去」，不证明行为）。**L1-06**：「第二次合法收缩会顶掉第一次的好备份」写进注释与残余，不改代码（按拍板）。**L1-07 / L1-09**：注释订正（`.bak.shrink` 并非「只在本文件内读写」——`event-secret-redact.ts` 读、`pi-coding-tools.ts` 做 `stat`；`company-env.json.tmp.*` 里同样是明文口令，`settings-tmp-cleanup.test.ts` 特意钉成保留，原因写清）。
- 测试：`save-retry-r8`（3）、`settings-shrink-r8`、`save-retry.test.ts` 的 AST 契约、`settings-fs.test.ts` 等。

**L3 · 群限流 / 幂等 / `task_busy`**（`group-shared.ts` / `group-route.ts` / `task-talk-queue.ts` / `task-question-inject.ts` / `task-inject-shared.ts`）
- **L3-05（推翻我第七轮的拍板）**：空 `messageId` **不再放行**——用合成 id（`anon:<自增>`）照常计数、照常受限额约束，退还靠不上就保守不退。第七轮写「生产上到不了、是防御」没错，但它是限流器 fail-open，将来换入口就是后门。**L3-04**：`groupBypassSenderKey` 在 id 与名字都没有时返回 `anon:`（此前拼出 `name:undefined`）；`enqueueGroupQuestion` 的槽位 key 与限流 key 统一用它（此前是裸 `openId || name`）；回放被限流丢弃的提示改为「**先 peek 有没有名额 → 发送 → 发送成功才认领**」（此前先认领、发送失败名额已耗）；pump 一轮最多**逐条**发 3 条提示，其余合并成一句、同一个人同一批只提示一次（此前最多 10 条串行 `await`，会阻塞入向）。**L3-02**：`stopping`（stop 收尾窗口，会自己恢复）的 409 也带 `task_busy`，并附 `phase: "stopping"`；回放的 `classifyReplayConflict`：busy → 放回队首，**stopping → 来源是 app 的丢弃并写一条 info、来源是群的放回**，其余 → 丢弃 + info；文案兜底 `msg.includes("正在跑")` 保留。**L3-01 / L3-03 / L3-06**：关联回执只受总限额约束——**不改**（登记一问一答、消费即焚，同人期间的消息因忙线入队、回放时按普通消息计个人额度），写进文档；`queueable` 的注释订正（无活会话的回执会入队，回放时登记若已被焚，数据头与 `correlatedAnswer` 标记随之丢失）。
- 测试：`group-bypass-r8`（34）、`group-bypass-r7`（22）、`task-talk-queue-r8`（17）、`task-talk-queue-r7`（15，另加 `setInterval` 一并 fake——报告指出它只 fake 了 `setTimeout` / `clearTimeout` / `Date`，高负载下可能误报）。

**L4-01 · 只读 shell 守卫：未加引号字符白名单**（`pi-coding-tools.ts`，**仍然潜伏**：全仓没有调用方传 `readOnly: true`）
- 报告实证：花括号 / `~` / 通配符展开会让校验看到的字面 argv 与 bash 真实展开后的 argv 不同（`node {-p,1}`、`cat {..,x}/config.json`、`ls {~,x}/.ssh`、`cat *.json` 全部 `ok:true`），而且 2000 个 `{x}` 会让 `expandBraces` 抛栈溢出而不是拒绝。连续三轮每轮一类新绕过，**问题在设计：黑名单加词法判断**。
- 修法：① 未加引号 token 的字符由黑名单改成**白名单** `[A-Za-z0-9_@%+=:,./-]`，其余（含 `{ } ~ * ? [ ] ! $ ` 等）一律拒；② node / npm / pnpm 的 `=` 形态选项走白名单（未知 `--x=y` 拒、pnpm 拒 `--config.*`）；③ `wc` / `grep` / `head` / `tail` / `cat` / `ls` 只放行布尔旗标白名单，路径值选项（`--files0-from` / `-f` / `--file` / `--exclude-from`）直接拒；④ 发版脚本名识别 `isDeployLikeName`（分隔符加 `:` `/`，加驼峰边界：`deploy:prod` / `release/patch` / `deployProd`）；⑤ `git branch` 只放行列表形态（`checkGitBranchArgs`），git 的前导选项走 `GIT_LEADING_BOOL_FLAGS` 白名单；⑥ **`expandBraces` 整个删了**（有了字符白名单就不需要）。
- **预言机 fuzz 的真实范围**：`readonly-shell-bash-oracle-r8` 用真 bash 的 `printf '%s\0'` 对比「校验器接受的 token 列表」与「bash 实际 argv」。⚠ **只在 bash 3.2.57（macOS `/bin/bash`）上跑过**，Linux 的 bash 5 与 Windows Git Bash 没跑；它是**采样、不是证明**。实际使用的 shell：macOS / Linux 是 `/bin/bash -c` → PATH 里的 bash → `sh -c`；Windows 是 Git Bash → PATH 里的 `bash.exe`。
- **按报告第 7 条**：如果这段守卫在下一次提交之后仍没人接线，**直接删掉**，别让它带着「fail-closed」的名头留在仓库里（需要你定，见文末）。`pi-coding-tools.ts` 里「echo 不走这里」的注释不对（echo 与 ls / pwd / wc 一样走路径钳制），已订正。
- 测试：`readonly-shell-whitelist-r8`（271，表驱动）、`readonly-shell-bash-oracle-r8`（真 bash 预言机）、`readonly-shell-git-global-opts-r8`（33 + 1，真 git 2.42 对照）、`readonly-shell-value-options` **重写为 126 条**（原 208 条；报告指出 A3 组是 2×8×7 的笛卡尔积、独立分支约 15 个，条数虚高——A3 现在是 38 行，原先 120 行，每个独立分支仍各有一行，`--config.*` 整类拒的分支在 `readonly-shell-whitelist-r8` 的 B 组）。

**L4-05…10 · 回复协议 / 面板 / 扫描**（`group-reply-protocol.ts` / `inbound-card-sanitize.ts` / `team-library-secret-scan.ts` 注释）
- **L4-05**：**未闭合围栏不算代码区间**（`closedFenceLineSpans`，起行之后找不到止行就不当围栏）——此前 `好的\n```bash\nnpm test\n[[需属主确认：要不要上线]]` 里真标记被当示例、属主没被 @，与 `findCodeRanges` 自己写的「宁可把示例当标记触发」相反；`group-reply-protocol-r7` 里把它钉成规格的那条翻过来了。**L4-06**：`dropsSentinelLine` 跳过**闭合**围栏内的行（`格式如下：\n```\nNO_REPLY\n```` 不再留下空围栏）；⚠ 未闭合围栏里单独一行的 `NO_REPLY` 仍会被删（不算围栏，所以不受保护），**并会留下一行孤立的 ` ``` `**（第九轮复核实测）。**L4-08**：标题形态的面板头（`▶ 🔧 修复登录`）也套「`▲` 之前出现别的头就不配对」，`r6:72` 钉着的「请 review 被吞」改成保留。**L4-07**：只订正注释与补边界用例——高熵规则的真实条件是「某个 `:` / `=` 之后（容忍空白与一个引号）**连续 ≥20 个 `[A-Za-z0-9+/=_.~-]`**」，20 位命中、19 位不命中；含 `!` 的 23 位口令前 20 位若有 `!` 就不命中，写进残余。
- **L4-10**（与「已拍板」的关系）：报告写「回退取第一个 `]]`，不取最后一个」。报告的复现（`[[需属主确认：用 [ 表示]] 后面还有一句话 [[链接]]`）已修好——说明 = `用 [ 表示`，后半句和 `[[链接]]` 留在正文。但**没有完全照字面改成「永远取第一个」**：保留了「行尾 `]]` 能让说明配平才取行尾」这一档，否则第七轮 K4-05 钉着的 `数组 a[b[0]] 怎么取]]`（说明里本来就有 `]]`）会被截断。代价（`用 [ 表示]] 然后 x]]` 这类「左括号数 ≤ 右括号数」就被当成凑平）见残余；沙箱实测「改成恰好相等才取行尾」可以把它分出去，但会让 `看 a[0]] 的值]]` 这种多一个 `]` 的写法改取第一个闭合符，本轮没采用，留给你取舍。
- `foldWithMap`：补了位置映射的种子 fuzz（`group-reply-protocol-fold-fuzz-r8`：折叠不变量、「全角化 / 插零宽变形后的标记，解析结果与 ASCII 写法一致」的元测试、`closedFenceLineSpans` 与朴素二次型预言对拍，并带「池子没写错」的自检防 fuzz 空转）；`unwrapCodeFence` 与旧正则的对拍沿用原有测试。
- 测试：`group-reply-protocol-r8`（70）、`group-reply-protocol-fold-fuzz-r8`（8）、`inbound-card-sanitize-r8`（16）、r6 / r7 相应更新、`team-library-secret-scan-inherit-keys`（67）。

**L5 · chat steer / 暂存（我自己做）**
- **L5-01（真缺陷，已修）· `take` 到登记 `inflightSteers` 之间有空窗**：「立即发送」的消息被摘出队列后，要经 `await flushAssistant` 与 `await persistReply`（含检查点落盘）才进入 `steerChatRun` 并登记；这段时间它**既不在队里、也不在 in-flight 槽、也不在 `inflightSteers`**。空窗内发生系统关闭：error / restart 收尾（清队）→ 记成 `failed(stopped)`、不进「N 条未送达」提示；forceClear / 重连摘表（不清队）→ 记成 `failed(no_session)`、不重排——都与第六轮终态表不一致。
  - **修法**：① `registerInflightSteer(taskId, item)`（`chat-runner.ts` 导出）在 `take` 之后**立刻**登记，`steerChatRun` 用 `preRegistered` 不重复登记、不删调用方登记的条目；`steerQueuedMessage` 用 `try / finally` 注销；`failQueuedItems({ extraItemIds })` 对已终态的条目跳过。② **没有用报告说的「标记加 `at` 时间戳」，改成单调的 `seq`**：`ChatSystemCloseMark` 新增 `seq`（每个任务一个只增不减的计数器，`markChatSystemClose` 写入），`requeueAsFollowup` 取 `closeSeqAtStart`，**`mark.seq > closeSeqAtStart` 就是「这次 steer 开始之后发生过系统关闭」**——重排（除非用户另外清过：`preClearGeneration === genAtStart && 当前 === mark.generation`），且此时跳过 `no_session` 分支。理由与反例：时间戳依赖 `Date.now()`，同一毫秒内的 `take` 与关闭、以及时钟回拨会判错边界（`>=` 会把「take 之前一毫秒发生的关闭」也算进来）；`seq` 与时钟无关，同时**顺手取代了没人走得到的「陈旧标记守卫」**（见上方 K1-01 的订正）。
  - 与第六 / 七轮终态表的对应：reconnect / restart / forceClear → 重排队首；error（run 出错收尾）→ `failed(error)` 并入「N 条未送达」；用户停止 / 回退 → `failed(stopped)`；**空窗内发生的也是同样的结果**。
  - 测试 `tests/chat-steer-window-r8.test.ts`（10）：空窗内 forceClear / restart / error（合并进提示）/ error + 落盘失败 / 用户停止 / 用户先清再 forceClear / 无关闭的正常路径 / 已送达后再 error / `persistReply` 抛错，另有 L5-03 的 EIO 兜底。**回退自检（诚实说明，md5 备份还原核对过）**：M1 换回旧判据（只对 `replaced` 看标记、`no_session` 条件照旧）、M2 不提前登记、M4 兜底站点不传清队前 generation、M5 `persist_failed` 不看终态、M3b `persistReply` 抛错时不注销——各自变红；**唯独 M3「撤掉 `finally` 里的注销」不会让任何用例变红**：`failQueuedItems` 对终态条目本就跳过，残留的登记项无害，注销只是卫生（残条随会话记录一起丢弃）。所以「已送达后再 error」那条是**回归守卫、不证明注销**，测试名与注释已改成这么写。
- **L5-02**：暂存的 10 分钟 TTL（`STASHED_BACKGROUND_RESULTS_TTL_MS`）短于重连链最坏时长——5 次尝试，退避合计 59 秒，每次 `Agent.resume` 最长 180 秒（`SDK_CREATE_RESUME_TIMEOUT_MS`）、`send` 最长 120 秒，5 次 resume 都挂到超时时整条链约 16 分钟；TTL 先到会写「暂存超时」，之后重连成功反而找不到暂存。（⚠ 报告写的「最坏约 11 分钟以上」低估了：resume 的上限是 180 秒不是 120 秒。）**修法**：`armStashExpiry` / `renewStashExpiry`，`tryChatAutoReconnect` 每次尝试起手（退避睡眠之前）续一次期。测试 `tests/chat-reconnect-stash-renew-r8.test.ts`：假 SDK 让每次重连的 `Agent.resume` 都永远挂起、走真 `withSdkDeadline` 的 180 秒超时，fake timers（含 `Date`）分小步推进、每步让出真实时间——越过「首次暂存起算的 10 分钟」后暂存仍在、没有「暂存超时」，链放弃时才清并写「未送达」。**回退自检**：撤掉 `renewStashExpiry(task.id)`，该用例红在「暂存已不存在」。
- **L5-03**：补了 `finalizeChatRunSafely` 兜底站点的序列用例（取消收尾写状态抛 EIO → 进入兜底 → 期望那条 steer 被重排、队列里 1 条、无终态），在 `chat-steer-window-r8` 里。**L5-04**：error 收尾 `await` 期间用户点停止，那条 steer 仍记 `failed(error)` 并出现在提示里——消息本来就没送达，只是**归因不准**；按拍板记入残余、没改。

**测试质量项（报告 §六）**：守卫补了花括号 / 通配 / `:` 命名 / `=` 形态 / 路径值选项 / `git branch` 写形态的表驱动；`readonly-shell-value-options` 去掉笛卡尔积虚高；`foldWithMap` 补种子 fuzz；`sliceMainFn` 的 `let` 声明守卫；`task-talk-queue-r7` 的 `setInterval` fake；`scaling-ratio` 阈值 3 的余量**没动**（HANDOFF 已承认，高负载 30–126 时仍可能抖）；`chat-background-result-close-reason` 仍有一例真实 2 秒退避（等待上限 12 秒，慢机器只会假绿不会假红）。报告说他「没有亲自跑回退实验」——本轮 L5 与更新 / 设置 / 守卫的子代理都做了，L5 的结果见上。

**本轮订正清单**（上面各处已就地改，这里汇总方便核对）：① `markChatSystemClose(taskId, reason)` 是旧签名；② 「六种关闭原因」下面有 7 行；③ K1-01 的「陈旧标记忽略」走不到、不是「防住了真实场景」（且已删）；④ P2-2 的「两个杠杆」不对、真正缺的是按 `failures` 设闸；⑤ K2-03 的「顺手解掉 G5-05」说过头；⑥ 「`bash -eu script.sh` 偏严」不变；⑦ 在 L4-01 修完之前不要写「整体 fail-closed」——**现在可以写了，但仅限「字符白名单 + 预言机采样」的范围**，且仍潜伏；⑧ `settings-fs.ts` 的「只在本文件内读写」、`event-secret-redact.ts` 里「已知键由非空变空」已过期、`inbound-card-sanitize.ts` 头注释与 `r6:72` 的矛盾——均已改注释；⑨ 第六轮必修 5 的退避说明、第七轮 P2-2 的「⚠ 需要你知道」——以本轮 L2-01 为准。`docs/feishu-group-collab.md` 的限流 / 空 `messageId` / `task_busy` / 回放提示 / 单测清单已同步。

**需要你拍板的（其余我都定了）**
1. **`prompts/_shared.md`、`prompts/_super.md`、`prompts/action-build.md`、`prompts/action-review.md` 的改动是否保留**。我这轮追了来源：四个文件的改动**互相一致**（「`ask_user` 对改类需求先复述」「review 补录用 `action-review.md` §6 的 blockquote 格式」），但**不是我们任何一轮改的**，也不是第六轮提示词对齐（A5）的内容——来源仍不明（可能是别的会话 / 你自己改的）。我没有动、没有回退。提交之前请确认是不是你要的；不是的话需要连同 `skills/artifact-writer/SKILL.md` 里的措辞一起回退。
2. **L2-01 的闸要不要落盘**：现在是进程内、重启清零；落盘能让坏 dmg 在重启后也不再每次放行 3 轮，代价是要处理「发布修好了但本机还记着」（至少要随版本号失效）。
3. **L4-10 的取舍**：照字面「永远取第一个 `]]`」（会截断 `数组 a[b[0]] 怎么取]]` 这类说明里本来就有 `]]` 的写法），还是现在的「配平才取行尾」，还是「恰好相等才取行尾」（沙箱实测可行，代价是多一个 `]` 的写法改取第一个闭合符）。
4. **只读 shell 守卫**：如果这次提交之后仍没人接线，按报告第 7 条直接删掉。

**本轮新增 / 订正后的残余（没修，需要知道）**
- **L2-01 的闸是进程内的**（重启清零）；Windows 没有对应的闸（Windows 全流程是用户触发、不存在轮询自动暂存）。
- **L5-04**：error 收尾期间用户点停止的那条 steer 归因记成 `failed(error)`（消息本来就没送达，只是归因不准）；steer 重排 / 暂存相关的 `stop-task.ts` 里 `["app"]` 与 `STOP_CLEARED_SOURCES` 是**两处手工镜像**，改一处要改另一处。
- **`chat-view.tsx:622` 与 L1-01 同款**：对任意 4xx 一律当「被业务拒绝」处理，没把 408 / 425 / 429 排除（本轮只改了 `save-retry.ts`）。目前本地服务只会返回 400 / 403 / 500，所以是潜伏的。
- **群限流**：关联回执只受总限额约束（L3-01，已写进文档）；pump 的限流提示最多逐条 3 条（其余合并）但仍是串行 `await`；回放被限流丢弃时对机器人提问人静默。
- **协议 / 面板 / 扫描**：「```\nNO_REPLY」未闭合围栏里的哨兵行仍会被删；`▶ 🔧 修复登录` 之类带图标要点行下 ASCII 缩进的子项仍被当面板体剥掉（K4-07，形态上无从区分，已知局限）；L4-10 的取舍（见上）；secret-scan 高熵规则对含 `!` 等字符集之外符号的口令、以及 `secrets:` 下 19 位及以下的口令无命中。
- **只读 shell 守卫**：仍潜伏；预言机只在 bash 3.2.57 上采样；Windows 8.3 短名 / `::$DATA` 没实测；`bash -eu script.sh` 仍整体拒（偏严）。
- **测试**：`scaling-ratio` 阈值余量（高负载仍可能抖）；`chat-steer-window-r8` 里有两条是回归守卫、不单独证明「注销」；`update-manifest-failure-kinds` 的 `sliceMainFn` 仍是源码切片、手抄了模块级 `let`（现在有守卫防漏，但不是真 import）。
- **报告「我没读到 / 没核实」那一节所列的**（`chat-runner.ts` 约 3000 行没人通读、Windows 与 mac 真机更新链、dmg 的实际大小、`helper.file` 与 `downloadedFile` 是否可能不同、真实飞书卡片的缩进字符是否会用 NBSP）本轮同样没核实。
- 前几轮已列、本轮未动的清单（H2-02…05 / H2-08…11、H3-02…06、H5-03…09、H6-03…11、H7-01…10、H8-03…12、H1-07…12 及 G5-04 / 08 / 09、G3-07 / 09 / 10 / 11、G2-05、G4-03…11）不变。

**验证**（第八轮收尾，2026-10-16）：`tsc --noEmit -p .` 0 错、`eslint .` 0 告警、全量 `CI=1 vitest run` **526 个文件通过 + 1 跳过 / 9828 条通过 + 5 跳过，退出 0**（第七轮收尾 514 + 1 / 9271 + 3；净增 12 个文件、557 条）。跳过数 3 → 5：新增的两个是「本机没有 git / bash 时才跑」的占位用例（`readonly-shell-git-global-opts-r8` 与 `readonly-shell-bash-oracle-r8` 里各一个 `describe.skipIf(HAVE_…)`），本机有 git 与 bash，所以它们被跳过——不是被禁用的测试。只在本机（macOS）跑了一遍，没有 Windows / 真机验证。

**提交建议（第八轮后）**：工作区现在 **386 个改动（198 已跟踪修改 + 188 未跟踪）**，连续四轮没提交，风险还在累积——报告建议修完后「立刻」按下面 5–6 个检查点分批提交、不要再往里堆（我没提交，等你确认；提交前先看上面第 1 条）。分法沿用第七轮那一条，**只在「两个任务写在同一个已跟踪文件里」时才需要 `git add -p`**。**报告建议的定点复查范围**：只看 L2-01、L4-01（含 bash 预言机 fuzz）、L1-02、L3-05、L5-01、L4-05 这 6 项，不再开全量子代理。

**第九轮：对第八轮修复的定点复查（2026-10-16，未提交）——用户转来「第九轮复核（转发版）」**
> 来源：另一个 AI 只对第八轮的 6 项（L2-01、L4-01、L1-02、L3-05、L5-01、L4-05）做的定点复查（审查方**没有改仓库**，复核后工作区仍是 386 个改动、HEAD `ef205e5`）。**结论：6 项全部收口，没有新的 P0 / P1 / P2，可以停止复核、开始提交。** 新发现 3 条 P3，全落在没人调用的只读守卫上，外加两处文档措辞。审查方复现了第八轮的数字（`tsc` 0、`eslint` 0、526 + 1 / 9828 + 5）；单独跑了 bash 预言机 fuzz：候选 783、被接受 300、与真 bash（3.2.57）不一致 0。

**本轮做了什么（都很小，只动注释 / 文档 / 一条测试，没动行为）**
- **订正 L2-01 的「连续 3 次」**：代码是**同版本累计 3 次、成功暂存 / 换版本才清零**，期间的 503 既不累计也不重置——审查方实测「2 次未归类 + 5 个 503 + 1 次未归类」就会触发，「连续」不准确。已改 `main.js` 与 `update-verify-retry.mjs` 的注释、日志文案（「自动暂存累计失败 N 次」）和本文件第八轮块；`tests/update-verify-retry.test.ts` 新增这条序列的用例（并带对照：只有 2 次未归类、后面全是 503 → 不触发）。
- **订正 K4-10 的「偏严不偏松」（N9-01）**：只对 `cwd` / `workCwd` 的差异那一点成立；**符号链接是放行方向**，而且不只脚本 / 预加载，以软链做路径前缀的 `cat` / `node` / `bash` 操作数同样 `ok:true`。已改第七轮 K4-10 与残余里的措辞，并在 `pi-coding-tools.ts` 的 K4-10 注释里写了「接线前必做清单」。
- **未闭合围栏里的 `NO_REPLY`**：补一句「会留下一行孤立的 ` ``` `」（L4-06 残余，审查方实测）。

**对审查方三个新发现的处理**（全部潜伏、没人调用 `readOnly: true`，按报告「接线时再做」）
- **N9-01**：路径钳制纯词法，仓内指向仓外的软链放行。**接线前**对所有路径操作数做 realpath 再钳（会引入同步 IO 与 TOCTOU，所以现在不做）。
- **N9-02**：`git show --textconv` / `git diff --ext-diff` 会调 git 配置里的外部程序；只读模式下 agent 改不了 git 配置，当前无法利用。**接线时**把这两个选项加进 git 拒绝名单。
- **N9-03**：未加引号的非 ASCII 被字符白名单拒。**报错文案本来就带提示**（「含这类字符的字面量（通配、花括号、~、中文路径等）请用单引号整体包住」，审查方只看了前半截没确认），无需再改。
- 三条都写进了 `pi-coding-tools.ts` 的「接线前必做清单」注释。

**审查方对上一轮四个「需要你拍板」的回答，我全部采纳**（你之前说过按最优的来、不用再问；其中第 1 条涉及提示词，**你不想要的话随时说，我来回退**）
1. **prompts 四个文件保留、不回退**（改动互相自洽，`tests/prompt-reprise-consistency.test.ts` 钉着同一套措辞）。**提交时单独成一个 commit**（信息写明「复述分流 + review 补录格式」），同一个 commit 带上 `skills/artifact-writer/SKILL.md` 与那个测试；这些提示词对所有 task 的 agent 行为都生效，单独提交方便以后单独回退。⚠ `prompts/_super.md` 里还有 `task` / `subagent` 的 `resume`、`run_in_background` 文档改动，那部分归到「chat 后台子代理」那个 checkpoint——**这个文件是两个主题混在一起的，需要 `git add -p` 按 hunk 拆**。
2. **L2-01 的闸不落盘**：重启本身就是一次显式重试，重启后最多再白下 3 次，落盘只会多一份要维护的状态。
3. **L4-10 保持现状**（「配平才取行尾」）；审查方 8 个输入实测：`用 [ 表示]] 后面还有一句话 [[链接]]` → 说明 `用 [ 表示`；`数组 a[b[0]] 怎么取` 完整；`看 a[0]]]` → `看 a[0]`；`先看 a[0] ]] 再说]]` 取第一个闭合符、`再说]]` 留在正文。
4. **只读守卫：提交后仍没人接线就删，并加期限**——原定**下一个发版 tag 前**如果还没有调用方，整段删，同时删 8 个 r8 守卫测试文件与预言机 fuzz，不留半截；要接线就先做上面 N9-01 / N9-02 再接。
   **v1.9.32 发版时仍无调用方，期限顺延一版（2026-10-16，我提的建议「这版先带着」、用户回「发版吧」未提异议）：改为 v1.9.33 tag 前**。理由：整段约 1500 行在 `pi-coding-tools.ts`、外加十来个测试文件，删除要动一个在用的文件，需要多一轮完整门禁，不适合夹在发版里做；它是死代码、不影响运行。**只顺延这一次**——v1.9.33 之前仍无调用方就必须删，不要再顺延。

**没按审查方建议做的一条：`chat-view.tsx:622` 不改成复用 `isClientRejection`**
- 审查方确认了该处与 L1-01 同款的「任意 4xx 一律当业务拒绝」是潜伏的（`src/app/api` 里没有任何路由返回 408 / 425 / 429），建议「顺手改成复用 `isClientRejection`」。
- **不改的理由（语义不等价）**：`save-retry` 里 408 / 425 / 429 排除出「被拒」是为了**自动重发同一份整对象覆盖**（幂等、重发无害）。chat 这里的非业务分支是 `kind: "network"` → ledger 记「状态未知」→ 提示「发送状态未知、正在确认…」，**等 SSE 来确认**。对 429 / 425 这种服务端**明确没受理**的响应，没有 `message_op` 事件可对账（`chat-pending-reconcile` 对「本地 uncertain」是 fail-closed、不会自己翻成失败），气泡会一直停在「状态未知」，直到用户重发（会复用同一个 `clientItemId`、不会双送）；而 `biz` 分支是立刻 `dropPending` + 「回复失败」toast，草稿保留、用户可直接重发——对「明确没受理」的响应后者更准。`isClientRejection` 也不是导出的。等将来真有路由返回这三个码，再按「是否受理」设计 chat 侧的分流。残余已记。

**提交**：审查方建议「不要再开新一轮复核，先提交」，按本文件的 5–6 个检查点分批、prompts 那批单独成 commit，**每个 commit 前后都跑 `tsc` / `eslint` / 全量 vitest**；提交完后审查方最多再做一次只看 N9-01…03 订正的小复查。⚠ **我没有提交**——「不要 `git commit` / `push`」是你之前定的规矩，等你明确说「提交」我再动，并会在提交前给出每个检查点的文件清单（含需要 `git add -p` 的混合文件：`prompts/_super.md`、`task-runner.ts` / `task-worktrees.ts` / `settings-fs.ts` / `use-settings.ts` / `repo-card.tsx` / `sidebar-groups.ts` 等）。

**验证**（第九轮收尾，2026-10-16）：`tsc --noEmit -p .` 0 错、`eslint .` 0 告警、全量 `CI=1 vitest run` **526 个文件通过 + 1 跳过 / 9829 条通过 + 5 跳过，退出 0**（第八轮收尾 9828 + 5，多的 1 条是 L2-01 的「累计」序列用例）。本轮只改了注释、日志文案、文档与一条测试用例，没动行为。⚠ **全量跑了三遍，前两遍各有一条不同的用例红、第三遍全绿**：① `ownership-r34-cleanup-coord` 的「R33-2① waiting 期第二次 finalize」（`removeTaskWorktrees` 被调 2 次，真实 git 仓 + 200ms 的 join 超时）；② `group-reply-protocol-r7` 的「说明里一长串 `]`」线性度（耗时比 3.16，阈值 3）。两条单跑各 5 次 / 3 次全过；跑的时候机器负载 17–38（用户的 Flowship / WindowServer 等在占 CPU）。①②都是**时序 / 耗时比敏感**的用例，本轮没碰它们的代码，归入既有残余里的「`scaling-ratio` 阈值余量（高负载仍可能抖）」——但 ① 是第一次在这份记录里出现，值得后续留意（它依赖真实 git 初始化的耗时，不只是耗时比）。

**第十轮：对第九轮订正的定点复查（2026-10-16，未提交）——用户转来「第十轮复核（转发版）」**
> 来源：另一个 AI 对第九轮订正的复查（审查方**没有改仓库**）。**结论：通过，没有新的 P0 / P1 / P2，可以提交。** 审查方复现了数字（`tsc` 0、`eslint` 0、526 + 1 / 9829 + 5，改动数 386、HEAD 仍是 `ef205e5`），把第九轮那份 136 行的探针脚本原样重跑、输出与第九轮逐行一致（行为没变），`node --check electron-app/main.js` 通过；**撤回了自己上一轮的 N9-03**（报错文案本来就带「中文路径请用单引号」）与「`chat-view.tsx:622` 改成复用 `isClientRejection`」的建议（接受我们的理由：对 429 这类明确没受理的响应走「状态未知」没有事件可对账）。另指出我在第九轮报告里记的**两条测试抖动**都是测试本身不稳、不是产品缺陷，**建议修、不挡提交**——本轮就是把它们修了（只改测试 / 测试 helper，不改产品行为）。

**抖动 ②（耗时比）· `tests/helpers/scaling-ratio.ts` 的 `doublingRatio` 改成「多轮、取最小比值」**
- 判断：被测函数是线性的（审查方同口径 n=4000 连测 12 次倍增比：2.34 / 2.04 / 2.05 / 1.87 / 2.26 / 2.29 / **4.83** / 2.62 / 2.10 / 2.49 / 2.61 / 2.22，11 次在 1.9–2.6、1 次离群），抖动来自统计方式太紧：原先是「小规模取最小、大规模取最小」两个**独立**的最小值，遇到持续一小段的负载抖动时大规模那一侧整个窗口都被拉高，线性实现也能量出 3.16。这个比值在负载约 12 时就有约 1/12 的概率冒过阈值 3，同一批还有一二十个同类用例，全量跑遇到一次红灯很正常。
- 修法：`doublingRatio` 每一轮**重新 make、重新测小 / 大两个规模**，轮与轮之间互相独立；某一轮比值 ≤ `threshold`（默认 `LINEAR_RATIO_MAX` = 3）就**提前停**（线性实现通常第一轮就停）；跑满 `DOUBLING_ROUNDS`（= 3）轮仍都高于阈值才返回最小的那个。**真二次型每一轮都接近 4，取最小仍 > 3、照样红**；线性实现被噪声拉高一次，下一轮就回到 ≈ 2。代价：只有红灯路径才会跑满 3 轮（二次型一轮本来就慢），绿灯不受影响。
- 新测试 `tests/scaling-ratio-helper.test.ts`（6）：真线性 → 绿；**真二次型 → 仍然红**（这个改动唯一的风险：不能把二次型放过去）；第一轮被抖动拉高（在 `make` 里按调用次序造出确定的抖动、不靠真实负载碰运气）第二轮恢复 → 绿且确实重测了；`rounds: 1`（修前的单轮行为）在同样的抖动下是红的（证明上一条测的是多轮、不是碰巧）；`threshold` 可调且提前停。**回退自检（md5 还原核对）**：M1 只测 1 轮 → 红；M2 取最大不取最小 → 红；M3 不提前停 → 红；M4 把比值压成 2（放过二次型）→ 红（②与对照两条）。⚠ 全量里 5 个用到它的测试文件（`group-reply-protocol-r6/r7/r8`、`inbound-card-sanitize-r6/r8`）都没改调用点，它们的断言还是 `ratio < LINEAR_RATIO_MAX`。

**抖动 ①（竞态）· `ownership-r34-cleanup-coord` 的「R33-2①」**
- 审查方的推断（**读源码、没能复现**）：第二次 `finalizeTask` 走到 `acquireTerminalCleanup`（加入在飞 cleanup）之前要先过好几个异步步骤（等任务停止 / 写 meta / 停预览，都是文件 IO），而测试在同步断言完 phase 之后**立刻 `hang.release()`**；高负载下第一次 cleanup 的真实 git 删除与 release 可能在它到达之前就全部做完，第二次就找不到在飞的 cleanup、自己再起一次删除，计数变 2。这对产品**无害**（第一次 cleanup 完成之后才到的第二次 `finalize` 本来就该自己再跑一次幂等清理）。
- **本轮把这个推断复现了**：临时在 `task-runner.ts` 的 `acquireTerminalCleanup` 之前加 600ms 延迟（模拟高负载），**旧测试红在「expected `removeTaskWorktrees` to be called 1 times, but got 2 times」——与第九轮全量里那次失败的输出一模一样**；同一变异下新测试绿；撤掉变异（md5 还原核对）后两者都绿。
- 修法（只改测试）：放行（`hang.release()`）之前先等到 `finalizeTask` 在 join 分支打的那行日志（「已有 terminal cleanup 在飞、join 不重入 remove task=…」）出现，用 `vi.spyOn(console, "log")` 穿透监听（不吞日志）、手写轮询（8 秒上限），再断言 phase 仍是 waiting、`removeTaskWorktrees` 仍 0 次，最后才放行——这样断言对应的是「join 了」这件事、不再依赖时序。**该用例仍有牙**：临时让 join 分支重入 `removeTaskWorktrees` → 新测试红（「expected … +0 times, but got 1」），还原后绿。
- **审查方没逐个看的「其余几个 R33-2 用例」我看了**：② 同样只靠 `sleep(200)` 断言「还没 settle」，在高负载下可能只是第二次 finalize 还没走到 acquire、并没有 join 上，用例就不再证明它名字里说的事（不会红，但会假绿）——同样补了「先等 join 日志」；③ 没有第二次 finalize，④⑤ 是 reopen / DELETE 与 cleanup 的互斥，不涉及 join 计数，没改。单跑 5 次全过。

**验证**（第十轮收尾，2026-10-16）：`tsc --noEmit -p .` 0 错、`eslint .` 0 告警、全量 `CI=1 vitest run` **527 个文件通过 + 1 跳过 / 9835 条通过 + 5 跳过，退出 0**（第九轮收尾 526 + 1 / 9829 + 5；净增 1 个文件、6 条，全是 `scaling-ratio-helper`）。这次全量一遍就绿；跑的时候机器负载仍高（>10），可见两处修复至少没有让它更糟，但**我没在高负载下重复整套来证明「不再抖」**——只证明了：① 耗时比这一类对「一次抖动」免疫（有确定性用例）、真二次型仍红；② R33-2① 的竞态能被确定性复现、新测试在复现条件下绿。只改了测试与测试 helper，没动任何产品代码（`task-runner.ts` 的变异实验都用 md5 还原核对过）。

**提交**：审查方也说「可以提交了」，并建议：每个 commit 前后各跑 `tsc` / `eslint` / 全量 vitest；按本文件 5–6 个检查点分批；prompts 那批单独成 commit；**这两处测试稳定性修复单独做一个只改测试的 commit、放在最后**。⚠ **我核对了跟踪状态，这条建议只对一半成立**：`tests/ownership-r34-cleanup-coord.test.ts` 是已跟踪文件、只有这一处改动，可以单独放最后；但 `tests/helpers/scaling-ratio.ts` 与 `tests/scaling-ratio-helper.test.ts` 是**未跟踪的新文件**，而用到它们的 `group-reply-protocol-r6 / r7 / r8`、`inbound-card-sanitize-r6 / r8` 也都是未跟踪新文件——helper 若放到比这些测试更晚的 commit，前面的 commit 里这些测试会因为 import 不到 helper 而红、整串 commit 就没法二分。所以 helper 与它的自测要**跟着「群协作 v2 / 回复协议」那个检查点一起提交**（本轮的多轮取最小比值改动已经在文件里、不需要再拆）。⚠ 我仍没提交，等你明确说「提交」。审查方可以在提交完后再扫一眼「拆分是否漏文件 / 混入不该进的改动」。

**已知限制 / 没验证（接手前先看）**
- ⚠ **受限答疑旁路 = 属主的完整 shell**（N3-01 的本质）：Cursor 路径下 `printenv` 仍能拿到 PAT；两条路径下都能读 `config.json`（PAT / apiKey / 公司环境密码）和 `~/.ssh`。事件流 / 回群有精确值脱敏兜底，但那是事后遮盖、不是隔离。**建议只在全是可信同事的内部群里开**；要真隔离只有「旁路在无凭据的受限 OS 用户 / 容器里跑」或「工具白名单 + 只读」两条路，前者改动大、后者是上一轮用户明确不要的方向（已放开成 honor-system）。此外继承自用户启动环境的 `*_TOKEN` / `*_API_KEY` / `AWS_*` 不在脱敏范围（按变量名猜既漏又误伤）；`custom-provider.ts` 的 `x-api-key` 与 `mcp-probe.ts` 的 initialize POST（用户 mcp.json 的自定义头）出站没设 `redirect:"error"`；pi 的 `task` 子代理原生 bash 不剔除宿主注入变量。
- ⚠ **Windows 真机一次都没跑过**：更新验签（点徽标 → 下载 → 验签 → ready → 安装；确定不符 → 弹框 + 删缓存 + 开发布页；暂时性失败（断网 / hosts 屏蔽 github）→ 弹「暂时无法校验」、缓存 exe 保留、恢复网络后再点徽标应复用缓存重新验签并正常安装；清单 404 → 弹「该版本暂不支持自动校验」+ 开发布页、缓存保留、不自动安装；篡改缓存 exe 一个字节应走删包分支；mac 在清单持续取不到〔暂时性：5xx / 断网〕时观察 2 小时轮询会继续重试（前 5 次失败时退避窗口都短于 2 小时、必然放行；连续失败 ≥ 6 次封顶后才可能偶尔被跳过一轮）、且全程不弹框；清单 404 / 没带 manifest 时观察同一进程内不再自动重下、只弹一次）、`downloadedUpdateHelper.file` 是 electron-updater 的 protected 内部属性（只用来交叉校验，取不到就跳过）、latest.yml 里 `files[].url` 的真实形态是读源码推断的、NSIS 自愈、`buildOpenPathPlan` 在 Windows 的行为、PowerShell 下的 `$env:FLOWSHIP_GITLAB_TOKEN`。
- ⚠ **没有浏览器验证**：CSP 的实际上报量与端点能否收到（若浏览器发的是 `Origin: null` 会被 middleware 403、上报静默丢失）；Chromium 内置 PDF 查看器会不会触发 `object-src` 违规；R6 的 hook 接线只有函数级测试、没有挂到真实组件上的集成测试。
- ⚠ **token 环境变量继承是按 AGENTS.md 的描述推断的**：没有实测 Cursor SDK 在 `create` 时是否快照 env（所以在 `create` / `resume` 之前、保存设置、服务启动三处都同步）；`process.env` 是进程级的，MCP stdio / lark-cli / meegle 等子进程可能继承到。env 方案做到的是「token 值不进命令文本、不用打开 config.json」，**不是**「agent 拿不到 token」——agent 拿到后自己 curl 到哪，只有服务端发起的请求受 host 绑定约束。
- ⚠ **TOFU 的前提**：首次固定之前 origin 已被篡改，固定的就是攻击者的 host，所以固定点尽量前移（服务启动 / 保存设置）；能直接写数据目录的 agent 不在防护内（它本来就能读 config.json）。团队库默认 host 写死为 `gitlab.wukongedu.net`，PAT 与固定值不一致的用户现在会被拒（启动 sync 会 warn）——这是预期的行为变化。
- ⚠ **CI 门禁没在 GitHub 上跑过**：本机与「无全局 git 配置」的模拟环境都全绿，但没有 Linux 实跑。**打下一个 tag 之前先手动触发一次 `ci` workflow**（Actions → ci → Run workflow），红了先修再打 tag，别让第一次实跑发生在发版时。
- ⚠ **xlsx 走 CDN tarball**：CI / 发版的 `pnpm install` 要访问 `cdn.sheetjs.com`（完整性由 lockfile sha512 保证，内容不会被悄悄换，风险只在可用性 / 可复现性——建议镜像到内部 registry 或 `vendor/`）；pnpm 虚拟 store 目录名变长（约 56 字符），**下次打包留意 `assemble-electron-server` 和 Windows 260 字符路径**；CI 的 `--config.node-linker=hoisted` 安装没实跑。
- `buildOpenPathPlan`：macOS 上没有扩展名的可执行文件识别不出来；返回的 `notice` 前端暂无展示位置。
- `main.js` 里 `will-prevent-unload`（S13-03，`quitting` 时放行页面的 beforeunload）超出审查原范围，需要真机确认「重启更新 / Cmd+Q」不再被设置页草稿拦住。
- `isSafeExternalUrl` 放行带 userinfo 的 http(s)（如 `http://127.0.0.1:8876@evil/`）：只交给系统浏览器、不在应用窗口加载，保持了原语义；要拒绝就在该函数加一行 `u.username || u.password` 判断。

**提交前建议拆开**（⚠ 第六轮订正：字面「按文件拆」对未跟踪新文件不可行，按下方「第六轮」的提交建议执行）：① 本节的审查修复（含 `ci.yml` / `release.yml`）；② 事件流 v2（`ui-conventions.mdc` / `markdown-text.tsx` / `event-stream*.tsx` / `event-stream-rhythm.ts` 及三个测试）；③ `installer.nsh`（另一任务）；④ `.cursor/rules/subagent-no-fast.mdc` 的删除；⑤ `sdk-gate.yml` 的删除（已在 `ci.yml` 头部注释里记原因）。

- **回退**：每项都是独立模块 + 独立测试，按上面「文件」整体撤即可。Windows 验签可退回旧行为：删 `main.js` 里 `rejectUnverifiedWinUpdate` 调用（`update-downloaded` 与 `installWinUpdate` 各一处）并还原 `release.yml` finalize 里的 exe 下载，契约测试会拦、要连测试一起改；CI 门禁可去掉 `release.yml` 的 `verify` job 和 `build-release` 的 `needs: verify`。

### v1.9.29（2026-10-10）吐字不流畅的根因：run_events 内存化 / 吐字节奏观测

> 起因：用户升级到 v1.9.28 后反馈「吐字还是不太流畅」。排查结论：**不是前端渲染，是 SDK 的 run_events 落盘实现把流式消息钉死在个位数条/秒**。同类症状第二次出现（上一次是 checkpoints，见 v1.9.28）——SDK 的 JSONL store 每个子 store 都是「整文件读 + 整文件重写」，凡是在流式热路径上的都会随文件变大线性变慢。

- **根因**：SDK 1.0.37 本地运行时把每条流式消息 `await eventStore.appendRunEvent(...)`（`run_stream_event`），`run.stream()` 再从同一个 store `listRunEvents({afterOffset})` 读回——run_events 是**进程内「运行时 → 消费端」的传输通道**，不是历史记录。线上文件 18.54MB / 35,925 条（9 个 run、全是 `run_stream_event`、p50 507B），SDK 实现每条 append ≈ 243ms（真实 SDK + 克隆件基准，100% CPU，事件循环延迟 p99 187ms）、串行上限 ≈ 4 条/秒；线上 `next-server` 主线程 85–110%，`run-perf.jsonl` 的 `eluAvg` 从文件还小时的 0.09–0.25 涨到 0.85–0.89。文字被钉在 ≈ 5 条/秒，**模型早已生成完、字还在排队往外挤**；这个文件还在涨（实测一个长 run 的 35 分钟里涨了约 4.5MB），越用越慢。
- **真实 SDK A/B**（同提示词 / 同模型 `reasoning_effort=low` / 同机器、同一份 18.5MB 现网快照，先后各跑一次）：总耗时 110.5s → 19.0s（5.8×）；吐字 4.8 → 29.8 条/秒（6.2×，SDK 原生节奏约 30 条/秒）；相邻间隔 p50 / p95 197 / 261ms → 33 / 47ms，>100ms 的占比 99.8% → 1.3%；主线程 CPU 102% → 2%（113s → 0.39s）；事件循环利用率 0.88 → 0.04，延迟 p99 / max 145 / 2100ms → 7 / 88ms；`send` 受理 6.5s → 34ms。另外 `onDelta`（运行时侧）与 `run.stream()`（消费侧）的间隔逐分位一致——运行时是等落盘后才发下一条，所以 tracker 里的 `onDelta` 就是可靠的吐字节奏观测点。
- **修复**：`composeLocalAgentStore` 只换 `runEvents` 这一个槽，`MemoryRunEvents`（详见架构快照）；旧文件在 `compose` 成功后归档进 `.quarantine/`（可逆、留 5 份）；GC 与测试随之适配。回退：`FLOWSHIP_SDK_RUN_EVENTS=file` 或 `USE_SDK_RUN_EVENTS`。**更正了两条早先的错误结论**：`sdk-agent-store.ts` 头注释「其余三份小文件仍用 SDK 自带实现」、`sdk-store-gc.ts` 注释「run_events 在本地模式下几乎不写（实测一整天没增长过）」——后者当时只是文件还小、没看出增长。
- **观测（吐字再慢能直接看到）**：`run-perf.jsonl` 新增 `cadence`（text / thinking 间隔的 `n / p50 / p95 / max / over100 / over250`）与 `store.runEvents / evMB / evCount / evTrimmed / runsMB`；`perf-report` 新增「十、吐字节奏」（按 run_events 实现、按 file 体积分桶对照，并列出整轮被钉住的 run 数）与 `runsMB` 等体积行。判读见 `stream-cadence.ts` 头注释。
- **排查过、结论不是原因**：① 前端侧栏 2 秒轮询——无头 Chrome 连隔离实例（克隆 273 个任务）实测，轮询开 vs 关主线程只多约 1%（Script 0.1% → 0.7%，每次约 12ms），30 秒内 0 个长任务、仅 1 帧 33ms；`TaskListProvider` 的 `value` 是内联新对象、每次轮询 `setTasks(新数组)`，所有 `useTaskList()` 消费者都会跟着重渲染，是可以顺手清的小毛病但不是吐字的病根。② SSE 路由已带 `no-cache, no-transform` + `X-Accel-Buffering: no`，不会被压缩缓冲成块。③ `GET /api/tasks`（2 秒轮询、273 个任务逐个读 meta、约 351KB / 120–140ms）约占 6% 单核，次要。④ `runs.ndjson`（现网 195KB / 58 条）每次 `runs.get` 约 1.2ms、按每秒 30 次消费者唤醒约 3.7% 单核，现在不是瓶颈，但它同样整文件解析、会随保留的 run 数线性变慢——已进观测（`store.runsMB`），涨到数 MB 前要处理（GC 裁终态 run，或同样组合一个内存 `runs`）。⑤ Cursor CLI 对照做不了（账号额度报错 `ActionRequiredError`，未动计费设置），用 SDK 直连探针（同后端 / 同 key / 同流）代替。
- **留意**：`reasoning_effort=max` 时思考原本不在界面实时展示（约 10 条/秒的思考 chunk 后才出正文）。**〔原结论「这是静默期不是卡顿」已过期：一段思考可达 65s，用户体感就是卡死；2026-10-10 起思考在流程里是一行实时更新的步骤，见下方「同版补充二」〕** 客户端帧间隔仍没有遥测（`ui-perf-collector` 只有长任务 / 慢交互 / 堆 / DOM），要做可挂在 `src/components/tasks/use-smooth-streaming.ts` 现成的 rAF 循环（`smoothTick`）上。另：`smoothTick` 每帧至少推 2 个字（`step = max(2, ceil(remaining × 0.12))`），对「慢滴流」输入（上游每 ~200ms 才来 ~6 个字，即这次的病态节奏）会表现成「冒几个字、停一下」的一抖一抖；上游恢复到 30 条/秒后这不是问题，若换包后仍有抖感，下一个候选是把追赶速度改成按近期到达速率自适应（带约 150–250ms 缓冲的匀速放字），而不是再动服务端。 〔2026-10-12：这个思路已先用在**思考**上——`src/lib/smooth-reveal.ts`（按 τ = 300ms 指数追赶 + 保底速率，不是匀速）；正文的 `smoothTick` 没动（用户说正文已经丝滑）。若以后要动正文，可直接复用那个纯函数，见「同版：事件流思考体验重构」。〕
- **同批其他改动**：`openSdkStore` 的 `compose` 抛错时回退 SDK 自带实现（防 SDK 升级后接口行为变化）；崩溃取证的 `--report-directory` 含空格时加引号（此前在 macOS 的「Application Support」下被截成不存在的目录，取证报告一直没写出来）；`sdk-store-gc-store-path` 测试超时 30→60s。

#### 同版补充：回车 → AI 开口的等待 / 回合收尾重复回复 / 「发送中」并入准备阶段

> 起因：用户反馈 ① 回车到 AI 开口要等很久 ② 简单问题也要很久 ③ SDK 回车后总有一个「发送中」④ 回复完对话迟迟不结束、之后又把同一段回复吐了第二遍。先量后改：下面的数字来自 `run-perf.jsonl`（28 条 run / 3 天、两个版本混合）+ SDK 直连探针（同后端 / 同 key / 隔离 store）。**样本小，是方向性证据，不是统计结论。**

- **用户感知的等待 = `prep.preSend` + `acceptMs` + `ttftMs`**，三段互相独立（`acceptMs` 不含 `preSend`）。**⚠ 这是服务端口径、对长思考会严重低估**：`ttftMs` 量的是「首个 delta」，`reasoning_effort=max` 时首个 delta 是思考、UI 当时一个字都看不见，用户看得见的口径要等首个可见内容（首条落盘的 thinking 事件或回复文字）。实测同一条 run：服务端口径 6s、用户看到 70s——见下方「同版补充二」。
- **旧版慢的主因是主线程被占满，不是 SDK 固有开销**：按 `proc.eluAvg` 分组，≥ 0.5 的 8 条（10/10 08:59–12:21，即 run_events 内存化之前）`acceptMs` p50 4.2s（热 3.6 / create 4.2–7.6 / resume 5.8–7.9s）；< 0.5 的 17 条热路径 p50 50ms、create 1.8s、resume 2.0s。12:29 包之后 `eluAvg` 0.07–0.15。⚠ 昨晚（v1.9.27）另有 4 条慢 accept（resume 8.0 / 7.7 / 4.6s、热 2.2s）当时 `eluAvg` 并不高；该版本的 run_events 还是 SDK 的 JSONL 整文件实现，**推测同源，但那个版本的记录没有 `store.evMB`，无法核对**。
- **剩下的大头在模型侧，而且是配置**：有 `modelParams` 记录的 27 条**全是 `reasoning_effort=max`**，首个 delta 全是 `thinking-delta`；热路径 ttft 3.4–5.4s、冷路径 7.8–8.2s（探针 `low` 热路径 1.2–2.8s，`max` 约 +3s）；累计思考时长占总耗时的中位约 47%（16–83%）。**降默认 effort 是最大的可控杠杆，但会改变回答质量，留给用户决定，没改。**
- **冷路径（重启后 / 回收后首发）构成**：`resumeChatSession` 1.4–2.6s（读设置 → MCP 解析 + 探活 → `Agent.resume`；**`Agent.resume` 的 `mcpServers` 入参取自探活结果，所以探活与 resume 不能简单并行**，探活缓存全未命中时多 ~0.9s）+ `checkpoint#send` 0.2–0.5s + 新实例首个 send 的 ttft 比热实例多 1.5–2s（受理之后 SDK 还要再新建 4 次 TLS + 2 次 `exchange_user_api_key`，每次 TLS ~650ms；探针里 `Agent.resume` 期间也新建 5 次 TLS）。
- **否掉的三个假设**：① 「12 分钟空闲回收是冷路径主因」——28 条里只有 2 条是 > 30 分钟回收后的 resume，其余冷发送的 idle 都是「未知」（本进程内没有该会话的上一个 run，uptime 均 < 1.3 小时，即重启后首发）；延长 TTL 对这批数据几乎没用，且 12 分钟是为 OOM 收紧的（`CHAT_IDLE_TTL_MS` 注释），没动。② 「热会话空闲后连接失效」——探针同实例空闲 90s 后 accept 仍 ~60ms。③ 「预热 resume / 会话保热」——违反预热契约（`task-warmup.ts`「绝不 resume」），新实例首个 send 的额外开销预热不掉，收益上限只有冷路径的 1.4–2.3s，不做。
- **改动 1 · 冷路径快照与 resume 并行**（`chat-inject.ts` / `chat-checkpoint.ts`）：发送前快照只看 `task.repoPaths`、与会话无关，原先排在 resume 之后串行。现在 resume 分支里同时起 `earlyCapture`，`unchanged` 分支在 `agent.send` 之前 await 它（不变式不变：快照先于 send）。它**永不 reject**（失败降级为不带 checkpointed，与 `captureChatCheckpoint`「失败不挡发消息」的约定一致）；resume 失败 / 让位 / 走别的分支时白打一次（只读 git，无副作用）。`prep` 里 `checkpoint#early` = 快照真实耗时，`checkpoint#send` 变成「等待残余」，并行后会明显变小——**和历史数据对比时注意口径**。同时 `captureChatCheckpoint` 的多仓由串行 `for await` 改 `Promise.all`（每仓独立临时 index、互不干扰；汇总仍按入参顺序，`repoPaths[0]` 是 cwd、顺序有语义）。热路径没有可并行的对象，不变。
- **改动 2 · 「发送中…」并入准备阶段**（`chat-pending-display.ts` + `rows.tsx` + `event-stream.tsx` + `chat-view.tsx`）：回车后、user_reply 落盘前（inflight）直接显示成正式气泡，「在等什么」交给列表末尾的 `PendingRow`（3 秒内「准备环境…」，之后「等待模型响应…」）；冷路径 server 另推真实阶段「正在恢复对话…」→「正在发送…」（`boot-progress.ts`，热路径一条都不推，别让它一闪而过）；提交那一刻 run 正在跑的（queued）显示「排队中…」；`uncertain`（网络不确定）与 task 模式的 `pendingTalkRows` 仍是老的「发送中…」虚线气泡。⚠ **没做 UI 实机验收**（AGENTS.md 禁止未经用户要求用截图 / 自动化）。
- **改动 3 · 回合收尾 / 重复回复**（**⚠ 2026-10-12 起其中「丢重放 / 回合一结束即落盘 / 3s 静态提示」已整套撤掉**，见上方「下一版」里的「撤掉回合收尾『丢重放』整套机制」；下面描述的是 v1.9.29 发布时的行为，仅作历史与机制依据）：机制（读 SDK 源码 + 探针）——`usage` 消息每回合只发一次 = 回合已结束，但 `FINISHED` 要等 checkpoint 持久化之后才发；SDK 的 StallDetector 判流停滞时会取消当次 attempt、从 checkpoint resume 重放，于是同一段回复又被吐一遍。现在：chat 在第一个 turn-ended 就 flush 并落盘回复，之后到达的 thinking / assistant 当作重放丢弃（`dropAfterTurnEnded`；task 模式「交卷后续跑」语义不动；`tool_call` 只计数不丢）；turn-ended 后 3s 仍未收尾，输入框上方显示静态的「回复已完成，正在保存会话…」（`TURN_WRAP_UP_STATUS`，不转圈）；异常收尾写 `turn-wrapup.jsonl` + `perf-report` 第十一节。**⚠ 不要在 turn-ended 之后立刻 `run.cancel()` 想「抢时间」**：探针里 turn-ended 后 1–2ms 就 cancel，3/3 次追问都答「没看到你让我记住的暗号」（同实例与 resume 后均丢）——turn-ended 先于 checkpoint 持久化，立刻 cancel 会丢该回合的上下文。
- **重复回复的触发条件没有证实**：已确认的是机制，不是「为什么会判停滞」。「主线程满载 → socket 数据迟迟不被处理 → 被误判」是个有机制依据的假说，12:29 包之后 `eluAvg` 降到 0.1、至今 0 复发与之不矛盾，但样本太小、证据力很弱（见下一条）；`turn-wrapup.jsonl` 会积累真实数据，用 `perf-report` 第十一节看。
- **怎么从历史聊天里数「重复回复」（判别规则 + 基线）**：同一回合（两条 `user_reply` 之间）出现两条长回复（≥ 150 字），且二者之间没有任何 `tool_call` / `tool_result`——正常的多步回复两段文字之间会夹着工具调用。**第二遍是模型重新生成的、措辞不同**（已知案例两遍的 3-gram Jaccard 仅 0.19），按文本相等去重会全部漏掉（我第一版检测器就是这么漏掉已知案例的）。用这个规则扫近 4 天有改动的 28 个任务：10/8 有 8 个回合、10/9 有 5 个、10/10 12:29 之前有 1 个（已知案例，两遍相隔 158s），合计 14 / 152 个含长回复的回合（约 9%）；个别回合连续重放 3–4 遍。12:29 包之后 15 个回合里只有 6 个含长回复、0 命中——**按 9% 的基础率，这个样本里本来就有一半以上概率 0 命中，不能据此说「已解决」**，至少要再攒 ~30 个含长回复的回合。注意：v1.9.29 那版曾把 turn-ended 之后的重放丢弃（**2026-10-12 起整套撤掉，重放重新照常落进 `events.jsonl`，判据回到上面「扫两条长回复」的规则**）；v1.9.29 发布后的那段时期 `events.jsonl` 里不会出现第二遍，只能看 `turn-wrapup.jsonl` 的 `replayDropped`。
- **踩过的坑**：`event-stream-scroll-contract` 钉死 `activeStatus` 那个 `useMemo` 的源码里不能出现 `task.events`（shell 直播时 `liveToolOutputs` 每个 delta 一个新引用、每秒几十次重算）——凡是要扫 `task.events` 的判定都得抽成独立 memo 再把结果传进去，注释里也不能写这个词（当时的 wrap-up 判定就是这么抽出去的；该提示已于 2026-10-12 撤掉，这条约束仍然成立）。
- **评估过、没做**：① 全局 undici dispatcher 调大 `keepAliveTimeout`（默认 4s 空闲就关连接；冷路径合计约 9 次新建 TLS、部分并行，能复用可省约 1.5–2.6s）——要新增 `undici` 依赖、在 Electron 打包环境实测与内置版本兼容、有死连接风险。② 快照提速：`read-tree HEAD` 后的临时 index 没有 stat 缓存，`add -A` 要把所有 tracked 文件重新 hash（热路径 ~0.4s 的主要来源）；改用真实 index 作起点会改变「被 `git add -f` 的 ignored 文件」是否进快照的语义。③ MCP 探活缓存全未命中时多 ~0.9s：可查缓存 TTL / stale 保留策略。

#### 同版补充二：思考是工作过程流程里的一步（用户反馈「回车后几乎 70s 才有响应」→「思考不能展示成流程的吗」→「就是现在已有的思考的展示一直就行」）

> ⚠ **2026-10-12 更新（未发布）**：下面关于**展示层**的描述已被上方「同版：事件流思考体验重构」取代——进行中的思考行现在**默认展开**为固定高度的尾部窗口、**不再有「折叠摘要取最新一行」**；输入框上方状态行**不再带思考原文**（只说「思考中 · 12s」）；`LiveThinking` 多了累计字数 `total`，文本经平滑层逐字放出。服务端链路（`thinking_delta` 帧 / 节流 / 预定落盘 id）、`attachLiveThinking` 的三种落点与合并规则、兼容性、已知限制 ①③ **没有变**。下面各条已就地改正。

> 起因：用户截图（用户气泡下面一行「等待模型响应… 已等待 62s」）加一句「那段话几乎是 70s 后才开始有响应」。他说的「响应」包括思考。**上一轮我把这个等待归因于 SDK 受理慢 / 会话体积，对这一条是错的**——当时只看了服务端口径的指标，没拿 `events.jsonl` 里用户看得见的时间点对账。**展示方式被用户纠偏了两次**：第一版把思考做成等待行里的一行小字 → 追问「思考不能展示成流程的吗」；第二版做了单独的、默认展开的滚动步骤组件（`LiveThinkingStepRow`，带「已思考 Ns」）→ 再说「就是现在已有的思考的展示一直就行」：不要另做一套，**已有的那个思考行从开始想到想完就是同一行**。现版就是这个——进行中的思考 = 一条合成的 `thinking` 事件，由已有的 `ProcessEventRow` 渲染；前两版的专用组件 / 壳字段 / 等待行里的思考分支整套回退（有契约测试防它们回来）。

- **实测时间线**（任务 `t_1791609385026_jl3011`，`reasoning_effort=max`；`events.jsonl` 与 `run-perf.jsonl` 同一条 run 对账）：15:46:41.856 `user_reply` → 受理 `acceptMs` 753ms（整个 send 1322ms）→ 第 6s 收到首个 thinking delta（`firstDeltaMs` 5995、`ttftMs` 5242，服务端口径「一切正常」）→ **一整段 65s 的思考**（`thinkingSegments=1`、`thinkingMs` 65370、`cadence.thinking.n` = 1111 条 token 级 chunk）→ 15:47:52.486 第一条 `thinking` 事件才落盘（距回车 70.6s）→ 用户这才第一次看到东西。
- **根因**：`sdk-message-handler` 把 thinking chunk 攒在 `thinkingBuffer`，**整段思考结束才落一条 `thinking` 事件**（tool_call / 回复文字 / usage / run 结束触发）；前端又没有「实时思考」通道（只有 `assistant_delta`）——`PendingRow` 在 `isRunning && 最后一条是用户消息` 时一直写「等待模型响应… 已等待 Ns」，`deriveActiveStatus` 也只有扫到**已落盘**的 thinking 事件才说「思考中」。结果：**服务端第 6s 就开口了，用户第 70s 才看到**。每一段长思考都这样，不只回车后的第一段（同一任务另有 29 段 / 353s 的回合，以及 425 段 / 2753s 的任务）。
- **修复**：新增纯内存 SSE 帧 `thinking_delta`（与 `assistant_delta` 对称、**不落盘**），帧里带 **`eventId` = 这段思考落盘后那条 `thinking` 事件的 id**；前端把帧累积成本段原文，合成一条 `thinking` 事件并入流尾工作过程组，由已有的思考行渲染。
  - **服务端节流**（`sdk-message-handler.ts: enqueueThinkingDelta`）：leading + trailing——一段思考的**首个 chunk 立刻发**（痛点就是「开始响应」看不见），之后每 250ms 最多一帧、带这期间攒下的全部增量（不丢字）；段结束（任何非 thinking 消息 / `flushThinkingBuffer` / run 结束）**丢掉没发的尾巴**——紧跟着落盘的 thinking 事件带完整文本，补发只会制造晚于落盘事件到达的幽灵「思考中」。只对 owner 主线路（无 `origin`）、非 `askSeen`、非 turn-ended 之后的重放、lease 仍有效时发。
  - **服务端预定落盘 id**：本段第一个非空 chunk 时 `assistantCtx.thinkingEventId ??= newEventId()`，之后每帧带同一个；`flushThinkingBuffer` 落盘时复用——`task-fs.ts: appendEvent` 新增可选 `id`（缺省 / 空串回退现生成；先拆出 `id` 再 spread，显式 `undefined` 不会覆盖生成值；键顺序 `id, ts, …` 不变，`events.jsonl` 行格式不变）。**id 放在每路 run 自己的 `AssistantBufferCtx`、不放按 taskId 共享的节流表**：旁路答疑（`origin`）的 flush 也走 `flushThinkingBuffer`，放共享表会被旁路偷走、同一个 id 落成两条事件。id 与 `thinkingBuffer` 一起取走并清零，且在 `!text` 早退和 lease 检查之前——空段 / 失主不会把 id 漏给下一段。没发过帧的（旁路 / 已提问消音）没有预定 id，由 `appendEvent` 现生成，与原行为一致。run 被新一轮接管、旧 run 的节流状态残留时，新 run 的首个 chunk 会命中它——`st.eventId` 随入队更新，帧带的是新 run 自己的 id（有行为用例）。
  - **前端数据**（`src/lib/thinking-live.ts` / `chat-view.tsx`）：`LiveThinking = { id, text, since, total? }`（`total` = 本段累计到达字数，见下方「同版：事件流思考体验重构」）；`pushThinkingDelta(text, id)`：同 id 累积、id 变了（新一段）重新开始，`since`（收到首帧的时刻）同一段内不变、作为合成事件的 `ts`。`text` 是本段累积原文（上限 2 万字、保留尾部；实测 65s 的思考约 7.8K 字）。收到 `assistant_delta` / 落盘的 `event` / `done` / 切任务 / 停止 / 删除任务都清掉；`onEvent` 里**先清实时态、再追加落盘事件**（同一个同步回调，React 18 自动批处理）→ 合成行直接换成同 id 的落盘行，没有空档。
  - **进流程**（`chat-turns.ts: attachLiveThinking`，事件流**第三层**——本来就随 chunk 变、不拖着分组管线重算）：合成事件 `{ id: live.id, ts: live.since, kind: "thinking", text, meta: { live: true } }`，三种落点，都与「落盘后 `buildStreamItems` 会产出的结果」同构（组 id / 成员 id / 步数一致，有测试拿真实 `groupChatRenderItems` + `coalesceAdjacentThinking` 对照）：① 流尾是组、末成员不是思考 → 追加为新成员（`stepCount + 1`）；② 末成员已是思考（无 `actionId`，与 `coalesceAdjacentThinking` 的合并规则一致）→ 并进去（文本拼接、沿用它的 id / ts / meta，步数不变），落盘时不会「两行变一行」；③ 流尾不是组（回车后第一段 / AI 插话之后又开始想）→ 新建只含这一步的组，**组 id = 思考 id**（落盘后 `buildWorkGroup` 的组 id = 首成员 id）。尾组里已有同 id 成员（落盘事件先于清实时态到达的兜底）→ 原样返回、不叠第二份。`hasRunning: true`（组头转圈、自动展开、「处理中…」占位让位）。只有流尾一项变，前面的项 / 成员引用不变（memo 的行不被击穿），不改入参。
  - **展示**（`event-stream/rows.tsx: ProcessEventRow` + `event-stream/live-thinking-tail.tsx`）：**仍是已有的思考行**——折叠箭头 + 脑图标 +「思考」。与落盘后的行**只有三处差异，全靠 `meta.live` 区分**：① 标签后多一个转圈（`Loader2`）；② **默认展开**，展开区是 `LiveThinkingTail`（固定高度 ≈ 5 行的尾部窗口、贴底上滚〔第二轮起是连续平移、不再整行一跳〕、溢出时顶部渐隐、末尾脉冲光标），**没有折叠摘要**（2026-10-12 之前是「默认折叠 + 摘要取最新一行」，吐字时整行向左滑，已撤）；③ 不显示耗时（耗时落盘后才有；并入相邻思考时带着上一段的 `durationMs`，必须屏蔽）。落盘后是同一个 React 节点（id 相同）：自动回到默认折叠（带一行摘要）；用户手动点过的一律保留（`manualCollapsed ?? autoEventCollapsed(isLive, initialCollapsed)`）。进行中不展示全文，完整原文落盘后在思考行里看。
  - **其它位置**：输入框上方的活动状态行说「思考中 · 12s」（计时走 `sinceTs`，**不带原文**；只覆盖「正在启动… / 处理中… / 正在回复…」这类空等标签，工具 / 压缩等具体状态不被盖；用户滚离流尾时它仍可见）；流程里已有「正在思考」就不再叠底部的「等待模型响应…」/ 冷路径启动阶段行（`items` 在 boot 与 loading 两个分支之前返回）；工作过程组被手动折叠时组头**不再摘录思考原文**（本来就有转圈）。
  - **帧率与开销**：服务端 ≤ 4 帧/s → 前端到达侧 ≤ 约 4 次 `setState` / s〔渲染侧见「同版：事件流思考体验重构」：2026-10-12 起多了 rAF 平滑层，每帧最多一次〕（对比 assistant 打字机 70ms 一档）；每帧只重算第三层（浅拷贝 + 换尾组外壳与尾成员），不重跑分组管线；思考行每帧更新一个文本节点（≤ 2 万字）。
- **兼容**：落盘的 `thinking` 事件 / `events.jsonl` 语义不变（事件 id 现在可由服务端预定，行格式不变）。飞书 `outbound.ts` / `group-outbound.ts` 对未知 kind 直接 return（已逐个核对订阅者，目前只有 watch-task 路由 + 这两个）；旧前端连新服务端：未知帧被忽略；新前端连旧服务端：缺 `eventId` 的帧当无效帧丢弃（没有 id 就对不上落盘行）——两种都只是没有实时的思考行，不影响其它。
- **验证**（10-10 当时的数字；现状见上方「同版：事件流思考体验重构」）：7 个测试文件共 102 个用例——`thinking-live`（纯函数 + `deriveActiveStatus`）26、`thinking-delta-publish`（服务端节流 + eventId 预定 / 复用 / 清零 / 旁路 / 消音 / 失主 / run 交接，假定时器）22、`thinking-delta-wiring-contract`（链路每一环的源码契约）26、`thinking-delta-stream-integration`（走**真实** `publish` / `subscribeTaskStream`）1、`thinking-delta-dispatch`（客户端 SSE 分发，缺 id 的帧丢弃）3、`append-event-preset-id`（真实 `appendEvent`、临时数据目录）5、`chat-turns-live-thinking`（合成事件并入流程，以真实 `groupChatRenderItems` / `coalesceAdjacentThinking` 产出作对照）19。集成用例按实测复现：1111 条 chunk / 65.5s → **263 帧（4.02 帧/s）、首帧 t=0、相邻帧间隔恒为 250ms**，全部实时帧先于落盘的 thinking 事件、落盘仍是整段一条且文本完整，**所有帧的 `eventId` 相同且等于落盘事件的 id**，段结束时确有未发的尾巴被丢（用例里有场景自检，防止场景退化到没覆盖这条分支）。全量 vitest 316 个文件 / 4066 个用例通过，`tsc` / `eslint` 干净。**变异验证 67 个**（服务端 id 预定 / 复用 / 清零 / 旁路 / 消音 / 节流状态、`appendEvent` 预设 id 与键顺序、链路各环、`attachLiveThinking` 各分支、组件接线、`chat-view` 各清理点）最终全部被抓，**其中 5 个最初存活、逐个补强**：节流状态不随新一段更新 `eventId`（补「run 交接」行为用例）；`isLiveThinkingMeta` 放宽成 truthy（补「只认布尔 true」）；切任务不清实时态（契约原来只查依赖数组、没查 effect 体里真调用——A 任务思考时切到正在跑的 B，B 的流尾会挂着 A 的思考）；`isThinkingLive` 写死 false（契约只钉了使用处、没钉定义）；折叠组头文案模板（契约只钉了函数调用、没钉「思考中 · 最近一行」）。另外 `actionId` 合并条件原来**没有任何测试**，补了与真实 `coalesceAdjacentThinking` 同构的用例。契约测试只能防「被删 / 被改」、证明不了渲染正确。⚠ **没做 UI 实机验收**（AGENTS.md 禁止未经用户要求用截图 / 自动化操作 App）：用 `pnpm dev:web`（8676）或换包后肉眼看。
- **已知限制**：① 页面刷新 / SSE 重连后，进行中的那一行里只有重连之后收到的内容；落盘后完整原文在 thinking 行里。② 进行中只保留最近 2 万字（`THINKING_TEXT_MAX`，超出从头部截断；平滑层用累计坐标，截断不影响放字进度），界面上也只显示尾部约 5 行。③ 只对 owner 主线路——子 agent / 旁路答疑的思考不进流程（它们本来也不进主事件流）。④ 进行中的行高度固定（尾部窗口），不再随文本增长；列表高度只在换新一段 / 落盘时变。⑤ 进行中默认展开、落盘后同一节点自动收起（设计如此；想「保持展开」只改 `autoEventCollapsed` 一处）。
- **没动**：思考本身的 65s（`reasoning_effort=max`，用户此前明确不动）。这次只让「在思考」可见、不让它变短；降默认 effort 仍是最大的可控杠杆，留给用户决定。冷路径首发那 8.6–17.6s 里是否另有未识别的成因，仍没证实。

### v1.9.28（2026-10-09）提速 / SDK store 加速 / GC 自愈 / 删除 worker

> 1.9.8 – 1.9.27 没在本文件记账（中途改用 `src/lib/whats-new.ts` + git log 记录）：用户可感知的变化看 whats-new，细节看 `git log v1.9.7..v1.9.27`。本版落地的几块已刷新进上面「当前架构快照」的两节（SDK 本地存储与会话规模治理 / 观测体系与预热）。

- **checkpoints 换 FastCheckpoints**：SDK 自带 store 每次读写都整文件读入 + 逐行 JSON.parse、写则整文件重写、全局串行。换成带偏移索引的实现后，本聊天 `sendChatMessage` 慢阶段 54–90s → 6–8s，store 放大 5 倍仍约 8s。只换 checkpoints 这一层，文件格式与 SDK 逐字节兼容，回退开关见架构快照。
- **预热 + 探活 stale-while-revalidate**：窗口 / 输入框聚焦时后台刷新 MCP 探活缓存、预读会话存储（main.log 实测 1543 次探活里约 70% 整表 miss）。预热让并发续期更常见，所以 `mcp-oauth` 对同一 server 的 token 续期做 single-flight（refresh-token 轮换的服务端上，并发 refresh 会 invalid_grant、严重时覆盖新 token，用户得重新授权）。
- **流式代码块限频高亮**：上游 highlight 缓存键含 `code.length`，流式每帧整块重分词（二次方，代码密集的回复里占主线程约 40%）；限频后文字逐帧增长、窗口到期补色。
- **⚠ 行为变更（不是 bug 修复）：按 token 累计水位自动换会话默认关闭**。长对话不再被换成新会话（AI 不再“失忆”）；回滚 `FLOWSHIP_TOKEN_WATERMARK=1` + 重启。85% 堆拒单门、壳 `--max-old-space-size=4096`、GC 不变。
- **GC 自愈**：SDK 读 ndjson 遇到非尾行坏记录会整体抛 Corrupt，GC 因此每轮“本轮跳过”；现在 GC 前对 `run_events.ndjson` 流式预检并自愈（坏记录原文进 `.quarantine/`）。线上实测 checkpoints 354→244MB，活会话 0 丢失。
- **观测体系**：run-perf / warmup / loop-lag / ui-perf 四类 jsonl + `scripts/perf-report.mjs`；App Nap 防后台节流是实验开关（默认关）。
- **`@cursor/sdk` 1.0.31 → 1.0.37**（三个平台包同步）。`assemble-server` 补上本机 isolated(pnpm) 布局下的平台包顶层链接，CI 的 hoisted 布局不受影响。
- **删除 worker 子系统**（31 文件 / -4285 行）：OOM 已被 GC 根治（2026-09-04 起零 OOM）、从未真机验收、与 FastCheckpoints 单写者约束冲突。恢复：`git checkout 3c04297 -- <paths>`，或见提交 `a7874c2` / `19a914f`。

## 关键文件索引

| 内容 | 位置 |
|---|---|
| **V0.6 重构设计文档（已 archived、V0.6.0 落地完成）** | `docs/V0.6-REFACTOR.md` |
| **V0.6 统一 runner（task 容器 + action history、v0.9.7 起只留编排：advance / restart / ack / finalize / internalStartAgent）** | `src/lib/server/task-runner.ts` |
| **流事件底座（v0.9.7 拆出：TaskStreamEvent 协议 + publish/subscribe + writeEventAndPublish + runningTasks 等 globalThis 状态）** | `src/lib/server/task-stream.ts` |
| **Prompt 拼装（v0.9.7 拆出：buildSuperPrompt + NEXT_ACTION/RESTART directive + 字段热更 diff、纯函数）** | `src/lib/server/task-prompts.ts` |
| **Action 门禁（v0.9.7 拆出：checkActionPrerequisites + build 分支规划、纯函数；ship 预检 reviewMissing 已于 V0.11.7 删）** | `src/lib/server/action-gates.ts` |
| **SDK 消息翻译器（v0.9.7 拆出：handleSdkMessage + AssistantBufferCtx）** | `src/lib/server/sdk-message-handler.ts` |
| **run 失败的文案归一 + 自动重连判定（`summarizeRunFailure` / `isRetryableRunError`；SDK 自己「放弃」类终态报错的规则表 `SDK_GIVE_UP_RULES`：命中给友好文案、绝不自动重连；`buildRunNotFinishedError` 把 SDK 终态错误作 `cause` 带进 main.log）** | `src/lib/server/sdk-error.ts` + `tests/sdk-error.test.ts` |
| **V0.6 action 后置 deterministic check（v0.9.13 起只查交付诚实性：artifact 必备段 / review 指纹 computeWorktreeFingerprint / MR 验真、不跑项目命令）** | `src/lib/server/action-checks.ts` |
| **协议信号单一常量源（V0.6.27、信号 ↔ prompt 一致性由测试守护）** | `src/lib/protocol-signals.ts` + `tests/protocol-signals.test.ts` |
| **shell / stop hook 清理（V0.11 起 hooks 退役、残留 hooks.json 启动时清掉）** | `src/lib/server/cleanup-fe-hooks.ts` |
| **submit_mr 范围校验（V0.6.27 从 task-runner 拆出、防 agent 越权提 MR）** | `src/lib/server/submit-mr-guard.ts` |
| **vitest 测试（V0.6.27、安全关键纯函数 + prompt 一致性；2026-10-12 起每个测试文件 import 前先隔离环境——剔除宿主注入变量、`FLOWSHIP_DATA_DIR` 指向临时目录，防测试误动正式数据）** | `vitest.config.ts`（`setupFiles`）+ `tests/setup/hermetic-env.ts` + `tests/helpers/hermetic-env.ts` + `src/lib/server/app-data-dir.ts`（识别桌面包数据目录）+ `tests/*.test.ts` |
| **V0.6 task schema + 文件系统（v0.9.9 拆三层：CRUD/patch 在 task-fs、路径/schema/锁/事件 IO/hydrate 在 task-fs-core、附件/artifact/revisions 在 task-artifacts）** | `src/lib/types.ts` + `src/lib/server/{task-fs,task-fs-core,task-artifacts}.ts` |
| **批次推导 + 展示（V0.6.23 起、computeBatchProgress 前后端共用 / 进度 chip / 批次表 / 选批 / 测试策略 label）** | `src/lib/task-display.ts` + `src/lib/types.ts: PlanBatch / TestStrategy / TEST_STRATEGY_LABEL` + `src/components/tasks/{batch-progress,batch-plan-table}.tsx` + `advance-dialog.tsx` 选批 |
| **GitLab REST client（V0.6.1 新、V0.6.8 加 closeOpenMR 关被取代的旧 MR）** | `src/lib/server/gitlab-client.ts` |
| **agent 孤儿子进程清理（V0.6.8、停 task / finally 调）** | `src/lib/server/kill-orphans.ts` |
| **任务 worktree 隔离（V0.10：ensure/remove/孤儿扫描/getTaskCwd/路径归一）** | `src/lib/server/task-worktrees.ts` + `tests/task-worktrees{,.integration}.test.ts` |
| **团队库（2026-07-22：组共享库 clone/sync/上传/镜像/市场安装卸载 + 安装态存储 + 派生共享 action + 双栏 UI）** | `src/lib/server/{team-library,team-skill-states}.ts` + `src/app/api/team-library/**` + `src/components/settings/skills-panel/*` + `src/components/custom-actions/install-team-actions.tsx` + `src/hooks/use-team-library.ts` + `tests/{team-library,skills-loader-team}.test.ts` |
| **团队 wk 流程门禁（2026-07-28：三个挂钩点强制调官方脚本 + 五档降级 + 输出转人话；脚本目录 = 镜像里 `knowledge/skills/global/wk-harness/scripts/`）** | `src/lib/server/wk-gate.ts` + `src/lib/{wk-command,wk-gate-output}.ts` + `src/lib/server/action-checks.ts: checkWkStageGate` + `tests/{wk-gate,wk-gate-output,wk-command,wk-post-stage-hook}.test.ts` |
| **wk 本机配置 `~/.wk/config.yaml`（键级合并、与不用 Flowship 的同事共用同一份）+ 交付中心探测** | `src/lib/{wk-config,wk-hub}.ts` + `src/lib/server/{wk-config,wk-hub-probe}.ts` + `src/app/api/system/wk-config/{route,probe/route}.ts` + `src/components/settings/wk-harness-card.tsx` + `src/hooks/use-wk-config.ts` + `tests/{wk-config,wk-hub-probe}.test.ts` |
| **REQ-ID（手填 > 链接派生 > 兜底；`reqIdPatchValue` 是新建表单与编辑弹窗共用的提交判定）** | `src/lib/req-id.ts` + `src/components/tasks/{task-launch-form,edit-task-dialog}.tsx` + `tests/{req-id,req-id-form-contract}.test.ts` |
| **需求群协作（2026-07-27：建群 / 分享 / 群消息回流 / 群内推进 / 自动播报 / 成员自动注册表；2026-09-02 提测群 @ 测试）** | `src/lib/server/{feishu-group,feishu-group-registry}.ts` + `src/lib/server/feishu-bridge/group-{route,outbound,broadcast,tester-notify,shared,ask-card,advance-card}.ts` + `src/app/api/tasks/[id]/share-to-group/route.ts` + `src/lib/share-to-group.ts` + `src/hooks/use-share-to-group.tsx` + `src/components/tasks/{share-to-group-dialog,bot-add-guide-dialog}.tsx` + `docs/feishu-group-collab.md` |
| **受限答疑旁路（非属主群消息、与 task 运行状态机解耦；只读 prompt + 唯一 settle + 事件带 origin）** | `src/lib/server/restricted-question.ts` + `task-stream.ts` 的旁路表 / `restricted_run` 帧 + `tests/{restricted-group-question,restricted-run-signal,task-question-inject-restrict}.test.ts` |
| **task 模式消息注入链（question 路由抽出的薄壳、群 / p2p / UI 三处复用；非属主传 `restrictToQuestion`）** | `src/lib/server/task-question-inject.ts` |
| **server 复算「当前可推进 action 清单」（与推进弹窗同一套过滤 / 分组序，群内推进选择卡与模糊匹配的数据源）** | `src/lib/server/advance-options.ts` + `tests/advance-options.test.ts` |
| **富输入三层（2026-07-27：内核 / 会话壳 / 状态层，chat 输入岛 + 事件流输入条 + 推进弹窗 + 答题卡四处共用）** | `src/components/{rich-input,conversation-composer}.tsx` + `src/hooks/use-rich-input.ts` + `src/lib/{rich-input-payload,composer-history}.ts` |
| **公司环境配置 company-env（设置页表单 + 导入导出 + `Agent.create` 前原子写 `<dataRoot>/company-env.json` 0600 给 skill 脚本读、密码不进 prompt）** | `FeAiFlowSettings.companyEnv` + `src/lib/company-env.ts`（归一 + `buildCompanyEnvBrief` 能力声明）+ `src/lib/server/company-env-fs.ts`（`writeCompanyEnvFile` / `syncCompanyEnvFileFromSettings`）+ `src/components/settings/company-env-card.tsx` |
| **run 收尾闭合未配对 tool_call（只扫事件流尾窗、避免翻出远古孤儿「已中断」）** | `src/lib/server/finalize-open-tools.ts` + `tests/finalize-open-tools.test.ts` |
| **选区浮动按钮公共件（产物「分享到群」与事件流「引用」共用定位 / 样式 / 防选区塌陷）** | `src/components/ui/selection-float.tsx` |
| **读 Cursor 全局配置 mcp/rules（V0.6.2 新）** | `src/lib/server/cursor-config.ts` |
| **Cursor MCP 只读 API + hook（V0.6.2 新）** | `src/app/api/cursor-mcp/route.ts` + `src/hooks/use-cursor-mcp.ts` |
| **MCP OAuth（V0.6.4 新、走 OAuth 的远程 MCP 授权 + 注入）** | `src/lib/server/mcp-oauth.ts` + `src/app/api/mcp-oauth/{start,callback,status,revoke}` + `src/hooks/use-mcp-oauth.ts` |
| **设置页编辑即保存（V0.6.5、6 张卡片去 SaveButton）** | `src/hooks/use-settings.ts: saveFieldValue`（唯一落盘入口）+ `src/app/settings/page.tsx` + `src/components/settings/*-card.tsx` |
| **「常用 MCP」全局开关（V0.6.5、设置页配 + 建 task 取快照）** | `FeAiFlowSettings.disabledMcpServers` + `src/components/settings/mcp-card.tsx` |
| **super-prompt 主模板（V0.6.27 起只注入当前 action playbook）** | `prompts/_super.md` |
| **跨 action 共享规范** | `prompts/_shared.md` |
| **plan / build / review / ship / dev action prompt** | `prompts/action-{plan,build,review,ship,dev}.md` |
| Electron 桌面端发版链（V0.7.0 薄壳 + 打包 + 自更新；v0.7.15 起唯一发版链、server 布局组包走公共函数 assemble-server） | `electron-app/main.js` + `electron-builder.yml` + `scripts/assemble-electron-server.mjs` + `scripts/lib/assemble-server.mjs` + `src/lib/server/data-root.ts` |
| **light/dark 三态主题 + 自定义同色一体标题栏（v0.7.23、next-themes 三态跟随系统 + 壳 hiddenInset/titleBarOverlay 顶栏；色板/prism/滚动条全主题变量化）** | `src/components/app-header.tsx` + `src/components/theme-toggle.tsx` + `src/app/globals.css` + `electron-app/{main.js,preload.cjs}` |
| **chat 模式独立 runner（V0.6.0.1 新、v0.7.23 进入即占位注册修「停止后还回复」冷启动竞态）** | `src/lib/server/chat-runner.ts` |
| **SDK 本地 agent store（躲开 `~/.cursor` SQLite WAL；checkpoints 用 FastCheckpoints；run_events 默认内存实现；GC 含 run_events 自愈）** | `src/lib/server/{sdk-agent-store,fast-checkpoint-store,memory-run-events,sdk-store-quarantine,sdk-store-gc}.ts` + `src/lib/server/agent-backend.ts` + `tests/{fast-checkpoint-*,memory-run-events,sdk-agent-store*,sdk-store-*}.test.ts` |
| **chat 模式 UI（V0.6.0.1 新）** | `src/components/tasks/chat-view.tsx` |
| **chat 模式 API** | `src/app/api/tasks/[id]/chat-reply/route.ts` |
| **系统工具（交卷 / 提问 / 提 MR 等）** | Cursor：`flowship-tools.ts` → SDK `local.customTools`（`agent-backend.ts` 按 `callerToken` 挂上）；pi：同文件桥成 customTools | `src/lib/server/flowship-tools.ts` |
| pending 等待状态机 + 信号 API（v0.9.8 拆出：pendingMap / ToolReturn / submitXxx / notifier 注册表、routes 与 runner 都从这 import） | `src/lib/server/chat-pending.ts` |
| 推进 / 终结 路由（V0.13 起 action-ack 退役、approve 由推进时自动认可） | `src/app/api/tasks/[id]/{advance,finalize}/route.ts` |
| watch-task SSE 路由 | `src/app/api/tasks/[id]/watch-task/route.ts` |
| Action revisions / diff 路由 | `src/app/api/tasks/[id]/{action-revisions,action-diff}/route.ts` |
| ContextDocsPanel（任务级上下文） | `src/components/tasks/context-docs-panel.tsx` |
| ask_user 答题卡（V0.13 起内联进事件流、原弹窗退役） | `src/components/tasks/ask-user-inline.tsx` |
| 事件流主组件 + utils + rows | `src/components/tasks/event-stream{,/utils,/rows}.tsx` |
| **事件流 v2：过程层 / 对话层共用的样式单一来源（折叠箭头 / 行按钮 / 引导线）+ 错误卡·提问卡「当前强历史弱」+ 状态行 shimmer + prose 取色走语义 token** | `src/components/tasks/event-stream/{stream-style,rows,tool-block,work-group,error-card,active-status-line}.tsx` + `src/app/globals.css`（`.prose` token 映射 / `status-shimmer` / reduced-motion 块）+ `tests/event-stream-v2-contract.test.ts` + `.cursor/rules/ui-conventions.mdc` 文末「事件流 v2」 |
| **事件流「跟随最新 / 往回滚不被拽回」（用户意图状态机〔只认用户输入、程序化滚动不恢复〕+ 控制器自己写 `scrollTop` 贴底并逐帧复查 + 不给 Virtuoso 传 `followOutput`、`atBottomThreshold=-∞`、总高变化走 `totalListHeightChanged`；视口变矮由 `ResizeObserver` 接手）** | `src/lib/scroll-follow.ts` + `src/hooks/use-stream-follow.ts` + `src/components/tasks/event-stream.tsx`（`attachScrollerRef` / `onTotalHeightChanged` / 跟随 effect）+ `tests/{scroll-follow,stream-follow-controller,event-stream-scroll-contract}.test.ts` |
| **事件流回合节奏（条间距五档：首条 / 对话 / 紧跟对话的过程行 / 紧跟对话的卡片 / 连续过程行；chat 与 task 同一套）** | `src/lib/event-stream-rhythm.ts` + `src/components/tasks/event-stream.tsx`（`rhythmFacts` / `itemContent`）+ `tests/event-stream-rhythm.test.ts` + `tests/event-stream-v2-contract.test.ts` |
| **事件流上拉加载更早（一次上拉必须「顶部多出至少一条可见条目、或历史读完」——否则一整页并进最顶上的工作过程组、`firstItemIndex` 不变、`startReached` 不再触发 = 往回滚滚不动；失败后顶部手动重试）** | `src/lib/earlier-events.ts: fetchEarlierBatch` + `src/components/tasks/event-stream.tsx`（`loadEarlier` / `EarlierLoadingHeader` / `buildStreamItems`）+ `src/lib/task-store.ts: fetchEarlierEvents` + `src/app/api/tasks/[id]/events/route.ts` + `tests/{earlier-events,earlier-events-wiring-contract}.test.ts` |
| **子代理 `task` 的模型 / effort（pi 路径；缺省沿用当前模型，指定则在当前 provider 目录内解析、填错报错并列出可选项、不静默回退；`explore` 只读、取消联动、子会话失败不吞）** | `src/lib/subagent-spec.ts` + `src/lib/server/model-catalog.ts`（`/api/models` 共用）+ `src/lib/server/custom-agent-backend.ts: runPiSubagent` + `src/lib/server/pi-coding-tools.ts: taskTool` + `tests/{subagent-spec,subagent-pi-e2e}.test.ts` |
| **子代理 `subagent`（Cursor 路径；挂了它就关掉 SDK 原生 `task`；MCP 工具 server `custom-user-tools`；缺省沿用当前模型、可指定模型 / effort、可 `resume` 接着之前的子代理；父 run 取消 / `agent.close()` 联动停子 agent；界面事件改写成 `task` 复用 `TaskSubagentBlock`、徽标显示实际生效的模型）** | `src/lib/server/cursor-subagent.ts`（`createCursorSubagentLink` / `createCursorSubagentLinkForSession` / `withNativeTaskDisabled` / resume 登记表）+ `src/lib/server/subagent-parent-model.ts`（父模型登记，给徽标用）+ `src/lib/cursor-subagent-display.ts` + `src/lib/server/agent-backend.ts: attachFlowshipTools`（只在有 `callerToken` 时挂）+ `src/lib/server/flowship-tools.ts: extraTools` + `src/lib/server/sdk-message-handler.ts: toSubagentDisplayCall` + 共用 `src/lib/subagent-spec.ts` + `tests/cursor-subagent{,-display,-wiring,-session}.test.ts` |
| **取消后 `run.wait()` 逃生口（取消 30s 仍不返回就放行收尾；每个 `run.cancel()` 处 arm）** | `src/lib/server/run-wait.ts: createCancelEscape` + `src/lib/server/{task-runner,chat-runner}.ts`（`cancelEscape`）+ `tests/run-wait.test.ts` |
| **往回翻历史的反向读（`readEventsBefore`：反向分块扫 + 行首偏移缓存〔用前必校验〕）/ 热路径只读 meta 与尾部窗口** | `src/lib/server/task-fs-core.ts: readEventsBefore / scanLinesBackward / anchorOffsetCache` + `src/lib/ask-pending.ts: hasAskRequestEvent` + `src/app/api/tasks/[id]/{ask-reply,advance}/route.ts` + `tests/{events-before-reverse,events-tail-io,ask-reply-tail-read,meta-only-routes}.test.ts` |
| 事件流不渲染闸（muted / 跳过过期 / ask-wait curl / 回合内工具 error / chat boot） | `src/lib/event-stream-hidden.ts` |
| **chat「回车 → AI 开口」的等待体验（启动阶段推送 / inflight·queued·uncertain 占位气泡语义 / 冷路径快照并行 / 思考作为流程里的一步〔`thinking_delta` 帧带预定的落盘 id：服务端节流 + 前端累积原文、合成一条 `thinking` 事件并入流尾工作过程组、由已有的思考行渲染〕/ 进行中思考的逐字放出〔`smooth-reveal` 平滑层 + `LiveThinkingTail` 尾部窗口 + 状态行去重〕）** | `src/lib/server/boot-progress.ts` + `src/lib/{chat-pending-display,chat-stream-display,thinking-live}.ts` + `src/lib/chat-turns.ts: deriveActiveStatus / attachLiveThinking` + `src/lib/server/sdk-message-handler.ts: enqueueThinkingDelta / thinkingEventId` + `src/lib/server/task-fs.ts: appendEvent`（可选 `id`）+ `src/lib/server/task-stream.ts`（`thinking_delta` 帧，带 `eventId`）+ `src/app/api/tasks/[id]/watch-task/route.ts` + `src/lib/task-store.ts` + `src/hooks/use-task-watch.ts` + `src/components/tasks/event-stream/{rows,active-status-line,work-group,live-thinking-tail}.tsx` + `src/components/tasks/use-smooth-thinking.ts` + `src/lib/smooth-reveal.ts` + `src/lib/server/{chat-inject,chat-checkpoint}.ts` + `tests/{boot-progress,chat-inject-boot-progress,chat-pending-display,chat-stream-display,thinking-live,thinking-delta-publish,thinking-delta-wiring-contract,thinking-delta-stream-integration,thinking-delta-dispatch,append-event-preset-id,chat-turns-live-thinking,smooth-reveal,thinking-reveal-integration,thinking-smooth-ui-contract,status-line-contract}.test.ts` |
| Artifact 面板（V0.6 适配 ActionRecord） | `src/components/tasks/artifact-panel.tsx` |
| Artifact 修订模式（词级 diff + 内联渲染） | `src/lib/md-revision.ts` + `src/components/tasks/artifact-revision-view.tsx` |
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
| 设置页发起人角色（userRole 身份注入） | `src/lib/types.ts: UserRole / USER_ROLE_LABEL` + `meegle-cli.ts: resolveUserIdentityForPrompt` |
| 多仓 cwd / repoPaths 工具 | `src/lib/path-utils.ts: getEffectiveCwd / formatRepoSectionForPrompt` |
| Artifact ref / 文件路径渲染（V0.6.0.1 加 `actions/` 前缀支持） | `src/lib/path-utils.ts: looksLikeArtifactRef / looksLikePath / buildCursorLink` |
| 设置：代码跳转 IDE + 默认分支命名模板（已并入 preference-card） | `src/components/settings/preference-card.tsx` |
| 设置：仓库列表 + per-repo 分支 + 模板覆盖（V0.6.7）；分支字段 v0.9.11 起 Combobox 下拉（候选自动拉、非 git 禁用） | `src/components/settings/repo-card.tsx` |
| **仓库分支候选（v0.9.11、本地 + 远端合并去重、设置页 / 任务 dialog 分支下拉数据源）** | `src/lib/server/git-branches.ts: listRepoBranches` + `src/app/api/repo-branches/route.ts` + `src/hooks/use-repo-branches.ts` |
| 通用可搜索单选下拉（v0.9.11 抽、支持自由输入 + 清空、首用于分支字段） | `src/components/ui/combobox.tsx` |
| 设置：交互偏好卡（提交快捷键 + v0.9.11「推进时默认续用当前 Agent」） | `src/components/settings/preference-card.tsx` + `FeAiFlowSettings.reuseAgentDefault` |
| 设置：GitLab PAT（Host 从仓库 origin 推导；V0.6.1 新增） | `src/components/settings/git-card.tsx` |
| **feature 分支命名模板引擎（V0.6.7、client+server 共用）** | `src/lib/branch-template.ts` |
| 提供方+模型组合选择（下拉里点星钉常用，每提供方 2 个） | `src/components/ui/{provider-model-picker,model-select,picker}.tsx` + `src/lib/starred-models.ts` |
| **观测体系（服务端 jsonl + 前端上报 + 报告 CLI）** | `src/lib/server/{perf-journal,run-perf-record,stream-cadence,run-prep-notes,loop-lag,ui-perf-ingest}.ts` + `src/lib/ui-perf-collector.ts` + `src/hooks/use-ui-perf-reporter.ts` + `src/app/api/perf/ui/route.ts` + `scripts/perf-report.mjs` + `scripts/lib/perf-report.mjs` |
| **任务预热（MCP 探活 SWR + store 预读）** | `src/lib/server/{task-warmup,mcp-probe,mcp-oauth}.ts` + `src/lib/warmup-scheduler.ts` + `src/hooks/use-task-warmup.ts` + `src/app/api/tasks/[id]/warmup/route.ts` |
| **流式代码块限频高亮** | `src/lib/{throttled-code-plugin,streaming-code-highlighter}.ts` + `src/components/markdown-text.tsx` |
| **Electron 壳小模块（纯函数、单测直接 import）：防后台节流开关 / NODE_OPTIONS 取值引用** | `electron-app/{app-nap,node-options}.mjs` + `tests/{app-nap-switch,node-options-quote}.test.ts` |

## 设计变动流程

权威源 = 代码 + 本文件。设计层面变动：

1. **当前架构变动**（如 action 模型改、保活机制改、新增大组件）→ 改代码 + 同步更新本文件「当前架构快照」段
2. **小步迭代**（同主题连续 .1 / .2 / .3 微调）→ 改代码 + 写到本文件「最近演进」段顶部
3. **再老一轮时**（「最近演进」积压超过 2 个子版本）→ 把最老那段迁到 `docs/CHANGELOG.md` 顶部

⛔ 不要散落到其它 md 写一份新的演进段。
