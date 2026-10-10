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
| action / artifact | 只读 prompt 硬拦：只答疑、禁止新建 / 修改 / 删除文件、禁止有副作用的命令 |

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
| **崩溃取证** | 壳给 server 注入 `--report-on-fatalerror --report-uncaught-exception --report-directory=<userData>/data/diagnostics/node-reports`，启动时只留最近 5 份。取值含空格（macOS 的「Application Support」）必须加引号，否则 Node 只取空格前那一截、报告写不出来（用 `quoteNodeOptionValue`） | `electron-app/main.js` + `electron-app/node-options.mjs` |
| **已删除** | worker 进程隔离子系统（曾为解 OOM；已被 GC 根治、从未真机验收、与单写者约束冲突）。需要恢复：`git checkout 3c04297 -- <paths>`，或见提交 `a7874c2` / `19a914f` | — |

### 观测体系与预热

| 层 | 现状 | 位置 |
|---|---|---|
| **服务端观测** | 结构化 jsonl 落 `<dataRoot>/logs/`：`run-perf.jsonl`（每个 run 收口一条：受理 / ttft / 首个工具 / 各阶段 / MCP 探活 / store 规模 / 事件循环 / `appNap` / **吐字节奏 `cadence`**〔相邻 text / thinking delta 到达间隔的 p50 / p95 / max / >100ms / >250ms 计数，记在 `onDelta` 热路径上、不分配对象、零日志；运行时是等事件落盘才发下一条，所以这个间隔就是用户看到的吐字间隔；p50 ≈ 30–50ms 且 >100ms 占比低 = 流畅，p50 ≥ 150ms = 被存储 / 事件循环钉住〕/ **`store.runEvents`·`evMB`·`evCount`·`evTrimmed`·`runsMB`**〔run_events 实现与体积、runs.ndjson 体积：后者同样被 SDK 每次读 run 状态整文件解析，涨到数 MB 就是下一个 O(文件大小) 瓶颈〕）、`warmup.jsonl`、`loop-lag.jsonl`（事件循环慢秒）、`ui-perf.jsonl`、**`turn-wrapup.jsonl`**〔回合收尾异常：turn-ended 之后 > 3s 才收尾 / 同一 run 里 turn-ended 出现 > 1 次 / 被丢弃的重放文本 > 0 才写，正常回合不写；用来确认「回复完又重复回复一遍」是否还在发生〕；按大小轮转、不截断；单条超大降级只留标识 | `perf-journal.ts` + `run-perf-record.ts` + `run-prep-notes.ts` + `loop-lag.ts` |
| **前端观测** | 渲染进程采集长任务 / 慢交互 / 堆 / DOM → `/api/perf/ui` → `ui-perf-ingest.ts` 清洗入库；只留耗时与规模，不含消息正文与路径（有金丝雀测试） | `ui-perf-collector.ts` + `use-ui-perf-reporter.ts` + `src/app/api/perf/ui/route.ts` |
| **看数据** | `node scripts/perf-report.mjs [--since 7d] [--task t_xxx] [--json]`（默认读本机数据目录的 logs；「十、吐字节奏」一节按 run_events 实现 / 文件体积对照；「十一、回合收尾」列 `turn-wrapup.jsonl` 的异常收尾）。判读「回车 → 开口」要把 `preSend` / `acceptMs` / `ttftMs` 三段分开看，并按 `proc.eluAvg` 分组（主线程满载时 accept 会被排队拖长，别误判成 SDK 慢） | `scripts/perf-report.mjs` + `scripts/lib/perf-report.mjs` |
| **预热** | 窗口 / 输入框聚焦 →（前端 `warmup-scheduler` 去抖 + 节流）→ `POST /api/tasks/[id]/warmup` → 后台刷新 MCP 探活缓存（stale-while-revalidate）+ 预读 store 尾部 blob。只做幂等 / 只读 / 可丢弃的事；有 run 在跑则跳过；同 task 服务端 20s 节流、全局并发 ≤ 2。MCP OAuth 续期对同一 server single-flight | `use-task-warmup.ts` + `warmup-scheduler.ts` + `task-warmup.ts` + `mcp-probe.ts` + `mcp-oauth.ts` |
| **流式代码块** | 限频高亮：上游 highlight 缓存键含 `code.length`，流式每帧整块重分词（二次方）。限频窗口内用「上次高亮结果 + 新增无色文字」，窗口到期整块补色，文字永不回退；只在流式中用，静态渲染仍用上游插件 | `throttled-code-plugin.ts` + `streaming-code-highlighter.ts` + `markdown-text.tsx` |
| **实验开关（默认关）** | 防后台节流：`FLOWSHIP_PREVENT_APP_NAP=1`，或 userData 下建空文件 `PREVENT_APP_NAP`，重启生效；`run-perf.jsonl` 的 `appNap` 字段做 A/B | `electron-app/app-nap.mjs` |

---

## 最近演进（窗口式、保留 2 个子版本）

> 写入规则：新子版本完成后在本段顶部追加、超过 2 个时把最老的迁到 `docs/CHANGELOG.md`。

### v1.9.29（2026-10-10）吐字不流畅的根因：run_events 内存化 / 吐字节奏观测

> 起因：用户升级到 v1.9.28 后反馈「吐字还是不太流畅」。排查结论：**不是前端渲染，是 SDK 的 run_events 落盘实现把流式消息钉死在个位数条/秒**。同类症状第二次出现（上一次是 checkpoints，见 v1.9.28）——SDK 的 JSONL store 每个子 store 都是「整文件读 + 整文件重写」，凡是在流式热路径上的都会随文件变大线性变慢。

- **根因**：SDK 1.0.37 本地运行时把每条流式消息 `await eventStore.appendRunEvent(...)`（`run_stream_event`），`run.stream()` 再从同一个 store `listRunEvents({afterOffset})` 读回——run_events 是**进程内「运行时 → 消费端」的传输通道**，不是历史记录。线上文件 18.54MB / 35,925 条（9 个 run、全是 `run_stream_event`、p50 507B），SDK 实现每条 append ≈ 243ms（真实 SDK + 克隆件基准，100% CPU，事件循环延迟 p99 187ms）、串行上限 ≈ 4 条/秒；线上 `next-server` 主线程 85–110%，`run-perf.jsonl` 的 `eluAvg` 从文件还小时的 0.09–0.25 涨到 0.85–0.89。文字被钉在 ≈ 5 条/秒，**模型早已生成完、字还在排队往外挤**；这个文件还在涨（实测一个长 run 的 35 分钟里涨了约 4.5MB），越用越慢。
- **真实 SDK A/B**（同提示词 / 同模型 `reasoning_effort=low` / 同机器、同一份 18.5MB 现网快照，先后各跑一次）：总耗时 110.5s → 19.0s（5.8×）；吐字 4.8 → 29.8 条/秒（6.2×，SDK 原生节奏约 30 条/秒）；相邻间隔 p50 / p95 197 / 261ms → 33 / 47ms，>100ms 的占比 99.8% → 1.3%；主线程 CPU 102% → 2%（113s → 0.39s）；事件循环利用率 0.88 → 0.04，延迟 p99 / max 145 / 2100ms → 7 / 88ms；`send` 受理 6.5s → 34ms。另外 `onDelta`（运行时侧）与 `run.stream()`（消费侧）的间隔逐分位一致——运行时是等落盘后才发下一条，所以 tracker 里的 `onDelta` 就是可靠的吐字节奏观测点。
- **修复**：`composeLocalAgentStore` 只换 `runEvents` 这一个槽，`MemoryRunEvents`（详见架构快照）；旧文件在 `compose` 成功后归档进 `.quarantine/`（可逆、留 5 份）；GC 与测试随之适配。回退：`FLOWSHIP_SDK_RUN_EVENTS=file` 或 `USE_SDK_RUN_EVENTS`。**更正了两条早先的错误结论**：`sdk-agent-store.ts` 头注释「其余三份小文件仍用 SDK 自带实现」、`sdk-store-gc.ts` 注释「run_events 在本地模式下几乎不写（实测一整天没增长过）」——后者当时只是文件还小、没看出增长。
- **观测（吐字再慢能直接看到）**：`run-perf.jsonl` 新增 `cadence`（text / thinking 间隔的 `n / p50 / p95 / max / over100 / over250`）与 `store.runEvents / evMB / evCount / evTrimmed / runsMB`；`perf-report` 新增「十、吐字节奏」（按 run_events 实现、按 file 体积分桶对照，并列出整轮被钉住的 run 数）与 `runsMB` 等体积行。判读见 `stream-cadence.ts` 头注释。
- **排查过、结论不是原因**：① 前端侧栏 2 秒轮询——无头 Chrome 连隔离实例（克隆 273 个任务）实测，轮询开 vs 关主线程只多约 1%（Script 0.1% → 0.7%，每次约 12ms），30 秒内 0 个长任务、仅 1 帧 33ms；`TaskListProvider` 的 `value` 是内联新对象、每次轮询 `setTasks(新数组)`，所有 `useTaskList()` 消费者都会跟着重渲染，是可以顺手清的小毛病但不是吐字的病根。② SSE 路由已带 `no-cache, no-transform` + `X-Accel-Buffering: no`，不会被压缩缓冲成块。③ `GET /api/tasks`（2 秒轮询、273 个任务逐个读 meta、约 351KB / 120–140ms）约占 6% 单核，次要。④ `runs.ndjson`（现网 195KB / 58 条）每次 `runs.get` 约 1.2ms、按每秒 30 次消费者唤醒约 3.7% 单核，现在不是瓶颈，但它同样整文件解析、会随保留的 run 数线性变慢——已进观测（`store.runsMB`），涨到数 MB 前要处理（GC 裁终态 run，或同样组合一个内存 `runs`）。⑤ Cursor CLI 对照做不了（账号额度报错 `ActionRequiredError`，未动计费设置），用 SDK 直连探针（同后端 / 同 key / 同流）代替。
- **留意**：`reasoning_effort=max` 时思考原本不在界面实时展示（约 10 条/秒的思考 chunk 后才出正文）。**〔原结论「这是静默期不是卡顿」已过期：一段思考可达 65s，用户体感就是卡死；2026-10-10 起思考在流程里是一行实时更新的步骤，见下方「同版补充二」〕** 客户端帧间隔仍没有遥测（`ui-perf-collector` 只有长任务 / 慢交互 / 堆 / DOM），要做可挂在 `src/components/tasks/use-smooth-streaming.ts` 现成的 rAF 循环（`smoothTick`）上。另：`smoothTick` 每帧至少推 2 个字（`step = max(2, ceil(remaining × 0.12))`），对「慢滴流」输入（上游每 ~200ms 才来 ~6 个字，即这次的病态节奏）会表现成「冒几个字、停一下」的一抖一抖；上游恢复到 30 条/秒后这不是问题，若换包后仍有抖感，下一个候选是把追赶速度改成按近期到达速率自适应（带约 150–250ms 缓冲的匀速放字），而不是再动服务端。
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
- **改动 3 · 回合收尾 / 重复回复**：机制（读 SDK 源码 + 探针）——`usage` 消息每回合只发一次 = 回合已结束，但 `FINISHED` 要等 checkpoint 持久化之后才发；SDK 的 StallDetector 判流停滞时会取消当次 attempt、从 checkpoint resume 重放，于是同一段回复又被吐一遍。现在：chat 在第一个 turn-ended 就 flush 并落盘回复，之后到达的 thinking / assistant 当作重放丢弃（`dropAfterTurnEnded`；task 模式「交卷后续跑」语义不动；`tool_call` 只计数不丢）；turn-ended 后 3s 仍未收尾，输入框上方显示静态的「回复已完成，正在保存会话…」（`TURN_WRAP_UP_STATUS`，不转圈）；异常收尾写 `turn-wrapup.jsonl` + `perf-report` 第十一节。**⚠ 不要在 turn-ended 之后立刻 `run.cancel()` 想「抢时间」**：探针里 turn-ended 后 1–2ms 就 cancel，3/3 次追问都答「没看到你让我记住的暗号」（同实例与 resume 后均丢）——turn-ended 先于 checkpoint 持久化，立刻 cancel 会丢该回合的上下文。
- **重复回复的触发条件没有证实**：已确认的是机制，不是「为什么会判停滞」。「主线程满载 → socket 数据迟迟不被处理 → 被误判」是个有机制依据的假说，12:29 包之后 `eluAvg` 降到 0.1、至今 0 复发与之不矛盾，但样本太小、证据力很弱（见下一条）；`turn-wrapup.jsonl` 会积累真实数据，用 `perf-report` 第十一节看。
- **怎么从历史聊天里数「重复回复」（判别规则 + 基线）**：同一回合（两条 `user_reply` 之间）出现两条长回复（≥ 150 字），且二者之间没有任何 `tool_call` / `tool_result`——正常的多步回复两段文字之间会夹着工具调用。**第二遍是模型重新生成的、措辞不同**（已知案例两遍的 3-gram Jaccard 仅 0.19），按文本相等去重会全部漏掉（我第一版检测器就是这么漏掉已知案例的）。用这个规则扫近 4 天有改动的 28 个任务：10/8 有 8 个回合、10/9 有 5 个、10/10 12:29 之前有 1 个（已知案例，两遍相隔 158s），合计 14 / 152 个含长回复的回合（约 9%）；个别回合连续重放 3–4 遍。12:29 包之后 15 个回合里只有 6 个含长回复、0 命中——**按 9% 的基础率，这个样本里本来就有一半以上概率 0 命中，不能据此说「已解决」**，至少要再攒 ~30 个含长回复的回合。注意：新包把 turn-ended 之后的重放丢弃了，`events.jsonl` 里不会再出现第二遍，之后的判据要看 `turn-wrapup.jsonl` 的 `replayDropped`。
- **踩过的坑**：`event-stream-scroll-contract` 钉死 `activeStatus` 那个 `useMemo` 的源码里不能出现 `task.events`（shell 直播时 `liveToolOutputs` 每个 delta 一个新引用、每秒几十次重算）——wrap-up 判定要抽成独立 memo（`turnWrapUp`）再把布尔传进去，注释里也不能写这个词。
- **评估过、没做**：① 全局 undici dispatcher 调大 `keepAliveTimeout`（默认 4s 空闲就关连接；冷路径合计约 9 次新建 TLS、部分并行，能复用可省约 1.5–2.6s）——要新增 `undici` 依赖、在 Electron 打包环境实测与内置版本兼容、有死连接风险。② 快照提速：`read-tree HEAD` 后的临时 index 没有 stat 缓存，`add -A` 要把所有 tracked 文件重新 hash（热路径 ~0.4s 的主要来源）；改用真实 index 作起点会改变「被 `git add -f` 的 ignored 文件」是否进快照的语义。③ MCP 探活缓存全未命中时多 ~0.9s：可查缓存 TTL / stale 保留策略。

#### 同版补充二：思考是工作过程流程里的一步（用户反馈「回车后几乎 70s 才有响应」→「思考不能展示成流程的吗」→「就是现在已有的思考的展示一直就行」）

> 起因：用户截图（用户气泡下面一行「等待模型响应… 已等待 62s」）加一句「那段话几乎是 70s 后才开始有响应」。他说的「响应」包括思考。**上一轮我把这个等待归因于 SDK 受理慢 / 会话体积，对这一条是错的**——当时只看了服务端口径的指标，没拿 `events.jsonl` 里用户看得见的时间点对账。**展示方式被用户纠偏了两次**：第一版把思考做成等待行里的一行小字 → 追问「思考不能展示成流程的吗」；第二版做了单独的、默认展开的滚动步骤组件（`LiveThinkingStepRow`，带「已思考 Ns」）→ 再说「就是现在已有的思考的展示一直就行」：不要另做一套，**已有的那个思考行从开始想到想完就是同一行**。现版就是这个——进行中的思考 = 一条合成的 `thinking` 事件，由已有的 `ProcessEventRow` 渲染；前两版的专用组件 / 壳字段 / 等待行里的思考分支整套回退（有契约测试防它们回来）。

- **实测时间线**（任务 `t_1791609385026_jl3011`，`reasoning_effort=max`；`events.jsonl` 与 `run-perf.jsonl` 同一条 run 对账）：15:46:41.856 `user_reply` → 受理 `acceptMs` 753ms（整个 send 1322ms）→ 第 6s 收到首个 thinking delta（`firstDeltaMs` 5995、`ttftMs` 5242，服务端口径「一切正常」）→ **一整段 65s 的思考**（`thinkingSegments=1`、`thinkingMs` 65370、`cadence.thinking.n` = 1111 条 token 级 chunk）→ 15:47:52.486 第一条 `thinking` 事件才落盘（距回车 70.6s）→ 用户这才第一次看到东西。
- **根因**：`sdk-message-handler` 把 thinking chunk 攒在 `thinkingBuffer`，**整段思考结束才落一条 `thinking` 事件**（tool_call / 回复文字 / usage / run 结束触发）；前端又没有「实时思考」通道（只有 `assistant_delta`）——`PendingRow` 在 `isRunning && 最后一条是用户消息` 时一直写「等待模型响应… 已等待 Ns」，`deriveActiveStatus` 也只有扫到**已落盘**的 thinking 事件才说「思考中」。结果：**服务端第 6s 就开口了，用户第 70s 才看到**。每一段长思考都这样，不只回车后的第一段（同一任务另有 29 段 / 353s 的回合，以及 425 段 / 2753s 的任务）。
- **修复**：新增纯内存 SSE 帧 `thinking_delta`（与 `assistant_delta` 对称、**不落盘**），帧里带 **`eventId` = 这段思考落盘后那条 `thinking` 事件的 id**；前端把帧累积成本段原文，合成一条 `thinking` 事件并入流尾工作过程组，由已有的思考行渲染。
  - **服务端节流**（`sdk-message-handler.ts: enqueueThinkingDelta`）：leading + trailing——一段思考的**首个 chunk 立刻发**（痛点就是「开始响应」看不见），之后每 250ms 最多一帧、带这期间攒下的全部增量（不丢字）；段结束（任何非 thinking 消息 / `flushThinkingBuffer` / run 结束）**丢掉没发的尾巴**——紧跟着落盘的 thinking 事件带完整文本，补发只会制造晚于落盘事件到达的幽灵「思考中」。只对 owner 主线路（无 `origin`）、非 `askSeen`、非 turn-ended 之后的重放、lease 仍有效时发。
  - **服务端预定落盘 id**：本段第一个非空 chunk 时 `assistantCtx.thinkingEventId ??= newEventId()`，之后每帧带同一个；`flushThinkingBuffer` 落盘时复用——`task-fs.ts: appendEvent` 新增可选 `id`（缺省 / 空串回退现生成；先拆出 `id` 再 spread，显式 `undefined` 不会覆盖生成值；键顺序 `id, ts, …` 不变，`events.jsonl` 行格式不变）。**id 放在每路 run 自己的 `AssistantBufferCtx`、不放按 taskId 共享的节流表**：旁路答疑（`origin`）的 flush 也走 `flushThinkingBuffer`，放共享表会被旁路偷走、同一个 id 落成两条事件。id 与 `thinkingBuffer` 一起取走并清零，且在 `!text` 早退和 lease 检查之前——空段 / 失主不会把 id 漏给下一段。没发过帧的（旁路 / 已提问消音）没有预定 id，由 `appendEvent` 现生成，与原行为一致。run 被新一轮接管、旧 run 的节流状态残留时，新 run 的首个 chunk 会命中它——`st.eventId` 随入队更新，帧带的是新 run 自己的 id（有行为用例）。
  - **前端数据**（`src/lib/thinking-live.ts` / `chat-view.tsx`）：`LiveThinking = { id, text, since }`；`pushThinkingDelta(text, id)`：同 id 累积、id 变了（新一段）重新开始，`since`（收到首帧的时刻）同一段内不变、作为合成事件的 `ts`。`text` 是本段累积原文（上限 2 万字、保留尾部；实测 65s 的思考约 7.8K 字）。「最近一行」由原文派生（`thinkingTextToLine`）：最后一个非空行 ≤80 字，超长取**行尾**（前缀 `…`；取行首的话长段落会像卡住不动），代理对安全。收到 `assistant_delta` / 落盘的 `event` / `done` / 切任务 / 停止 / 删除任务都清掉；`onEvent` 里**先清实时态、再追加落盘事件**（同一个同步回调，React 18 自动批处理）→ 合成行直接换成同 id 的落盘行，没有空档。
  - **进流程**（`chat-turns.ts: attachLiveThinking`，事件流**第三层**——本来就随 chunk 变、不拖着分组管线重算）：合成事件 `{ id: live.id, ts: live.since, kind: "thinking", text, meta: { live: true[, liveTruncated: true] } }`，三种落点，都与「落盘后 `buildStreamItems` 会产出的结果」同构（组 id / 成员 id / 步数一致，有测试拿真实 `groupChatRenderItems` + `coalesceAdjacentThinking` 对照）：① 流尾是组、末成员不是思考 → 追加为新成员（`stepCount + 1`）；② 末成员已是思考（无 `actionId`，与 `coalesceAdjacentThinking` 的合并规则一致）→ 并进去（文本拼接、沿用它的 id / ts / meta，步数不变），落盘时不会「两行变一行」；③ 流尾不是组（回车后第一段 / AI 插话之后又开始想）→ 新建只含这一步的组，**组 id = 思考 id**（落盘后 `buildWorkGroup` 的组 id = 首成员 id）。尾组里已有同 id 成员（落盘事件先于清实时态到达的兜底）→ 原样返回、不叠第二份。`hasRunning: true`（组头转圈、自动展开、「处理中…」占位让位）。只有流尾一项变，前面的项 / 成员引用不变（memo 的行不被击穿），不改入参。
  - **展示**（`event-stream/rows.tsx: ProcessEventRow`）：**就是已有的思考行**——折叠箭头 + 脑图标 +「思考」+ 折叠摘要，**默认折叠**（`thinking` 不在 `DEFAULT_EXPANDED_KINDS` 里），点开是斜体全文且随帧更新；落盘后是同一个 React 节点（id 相同），用户点开着读的内容不会被收起。与落盘后的行**只有三处差异，全靠 `meta.live` 区分**：① 标签后多一个转圈（`Loader2`）；② 折叠摘要取**最新一行**（`thinkingTextToLine`）——已有的摘要取前 200 字，一段长思考整段期间会纹丝不动、看着像卡死；③ 不显示耗时（耗时落盘后才有；并入相邻思考时带着上一段的 `durationMs`，必须屏蔽）。另：进行中文本触顶 2 万字时展开区顶部有提示。
  - **其它位置**：输入框上方的活动状态行说「思考中」+ 最近一行（只覆盖「正在启动… / 处理中… / 正在回复…」这类空等标签，工具 / 压缩 / 回合收尾等具体状态不被盖；用户滚离流尾时它仍可见）；流程里已有「正在思考」就不再叠底部的「等待模型响应…」/ 冷路径启动阶段行（`items` 在 boot 与 loading 两个分支之前返回）；工作过程组被手动折叠时组头也说「思考中 · 最近一行」。
  - **帧率与开销**：服务端 ≤ 4 帧/s → 前端 ≤ 约 4 次 `setState` / s（对比 assistant 打字机 70ms 一档）；每帧只重算第三层（浅拷贝 + 换尾组外壳与尾成员），不重跑分组管线；思考行每帧更新一个文本节点（≤ 2 万字）。
- **兼容**：落盘的 `thinking` 事件 / `events.jsonl` 语义不变（事件 id 现在可由服务端预定，行格式不变）。飞书 `outbound.ts` / `group-outbound.ts` 对未知 kind 直接 return（已逐个核对订阅者，目前只有 watch-task 路由 + 这两个）；旧前端连新服务端：未知帧被忽略；新前端连旧服务端：缺 `eventId` 的帧当无效帧丢弃（没有 id 就对不上落盘行）——两种都只是没有实时的思考行，不影响其它。
- **验证**：7 个测试文件共 102 个用例——`thinking-live`（纯函数 + `deriveActiveStatus`）26、`thinking-delta-publish`（服务端节流 + eventId 预定 / 复用 / 清零 / 旁路 / 消音 / 失主 / run 交接，假定时器）22、`thinking-delta-wiring-contract`（链路每一环的源码契约）26、`thinking-delta-stream-integration`（走**真实** `publish` / `subscribeTaskStream`）1、`thinking-delta-dispatch`（客户端 SSE 分发，缺 id 的帧丢弃）3、`append-event-preset-id`（真实 `appendEvent`、临时数据目录）5、`chat-turns-live-thinking`（合成事件并入流程，以真实 `groupChatRenderItems` / `coalesceAdjacentThinking` 产出作对照）19。集成用例按实测复现：1111 条 chunk / 65.5s → **263 帧（4.02 帧/s）、首帧 t=0、相邻帧间隔恒为 250ms**，全部实时帧先于落盘的 thinking 事件、落盘仍是整段一条且文本完整，**所有帧的 `eventId` 相同且等于落盘事件的 id**，段结束时确有未发的尾巴被丢（用例里有场景自检，防止场景退化到没覆盖这条分支）。全量 vitest 316 个文件 / 4066 个用例通过，`tsc` / `eslint` 干净。**变异验证 67 个**（服务端 id 预定 / 复用 / 清零 / 旁路 / 消音 / 节流状态、`appendEvent` 预设 id 与键顺序、链路各环、`attachLiveThinking` 各分支、组件接线、`chat-view` 各清理点）最终全部被抓，**其中 5 个最初存活、逐个补强**：节流状态不随新一段更新 `eventId`（补「run 交接」行为用例）；`isLiveThinkingMeta` 放宽成 truthy（补「只认布尔 true」）；切任务不清实时态（契约原来只查依赖数组、没查 effect 体里真调用——A 任务思考时切到正在跑的 B，B 的流尾会挂着 A 的思考）；`isThinkingLive` 写死 false（契约只钉了使用处、没钉定义）；折叠组头文案模板（契约只钉了函数调用、没钉「思考中 · 最近一行」）。另外 `actionId` 合并条件原来**没有任何测试**，补了与真实 `coalesceAdjacentThinking` 同构的用例。契约测试只能防「被删 / 被改」、证明不了渲染正确。⚠ **没做 UI 实机验收**（AGENTS.md 禁止未经用户要求用截图 / 自动化操作 App）：用 `pnpm dev:web`（8676）或换包后肉眼看。
- **已知限制**：① 页面刷新 / SSE 重连后，进行中的那一行里只有重连之后收到的内容；落盘后完整原文在 thinking 行里。② 展开区只保留最近 2 万字（超出时顶部有提示）。③ 只对 owner 主线路——子 agent / 旁路答疑的思考不进流程（它们本来也不进主事件流）。④ 点开着读时，进行中的行高度随文本增长（每 ≤250ms 一帧），列表只在用户正跟随底部时才跟着走。⑤ 进行中默认折叠（与落盘后的思考行一致）；若想进行中默认展开，会和落盘后收起不一致，是另一个决定。
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
| **V0.6 action 后置 deterministic check（v0.9.13 起只查交付诚实性：artifact 必备段 / review 指纹 computeWorktreeFingerprint / MR 验真、不跑项目命令）** | `src/lib/server/action-checks.ts` |
| **协议信号单一常量源（V0.6.27、信号 ↔ prompt 一致性由测试守护）** | `src/lib/protocol-signals.ts` + `tests/protocol-signals.test.ts` |
| **shell / stop hook 清理（V0.11 起 hooks 退役、残留 hooks.json 启动时清掉）** | `src/lib/server/cleanup-fe-hooks.ts` |
| **submit_mr 范围校验（V0.6.27 从 task-runner 拆出、防 agent 越权提 MR）** | `src/lib/server/submit-mr-guard.ts` |
| **vitest 测试（V0.6.27、安全关键纯函数 + prompt 一致性）** | `vitest.config.ts` + `tests/*.test.ts` |
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
| 事件流不渲染闸（muted / 跳过过期 / ask-wait curl / 回合内工具 error / chat boot / 回合收尾提示） | `src/lib/event-stream-hidden.ts` |
| **chat「回车 → AI 开口」的等待体验（启动阶段推送 / inflight·queued·uncertain 占位气泡语义 / 回合收尾静态提示 / 冷路径快照并行 / 思考作为流程里的一步〔`thinking_delta` 帧带预定的落盘 id：服务端节流 + 前端累积原文、合成一条 `thinking` 事件并入流尾工作过程组、由已有的思考行渲染〕）** | `src/lib/server/boot-progress.ts` + `src/lib/{chat-pending-display,chat-stream-display,thinking-live}.ts` + `src/lib/chat-turns.ts: TURN_WRAP_UP_STATUS / deriveActiveStatus / attachLiveThinking` + `src/lib/server/sdk-message-handler.ts: enqueueThinkingDelta / thinkingEventId` + `src/lib/server/task-fs.ts: appendEvent`（可选 `id`）+ `src/lib/server/task-stream.ts`（`thinking_delta` 帧，带 `eventId`）+ `src/app/api/tasks/[id]/watch-task/route.ts` + `src/lib/task-store.ts` + `src/hooks/use-task-watch.ts` + `src/components/tasks/event-stream/{rows,active-status-line,work-group}.tsx` + `src/lib/server/{chat-inject,chat-checkpoint}.ts` + `tests/{boot-progress,chat-inject-boot-progress,chat-pending-display,chat-stream-display,thinking-live,thinking-delta-publish,thinking-delta-wiring-contract,thinking-delta-stream-integration,thinking-delta-dispatch,append-event-preset-id,chat-turns-live-thinking}.test.ts` |
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
