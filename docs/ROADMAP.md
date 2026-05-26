# ROADMAP

> 渐进式、不一次性做完。每个阶段验证 ROI 后再投资源。

> ⚠️ **2026-05-15 同步**：V1 流程历经 spec→plan→build → context→plan→build→ship → 最终定型 **`plan → build` 双阶段**（V0.3.4）+ 「**chat 自由对话**」双模式。保活机制从 `wait_for_user` MCP + `keep_alive_a/b/c` 重构为 `shell + curl long-poll`（V0.3.5）。**V0.4 大动**：多角色 schema（`Task.role`、当前仅 fe、未来扩 be/data/mobile/qa、详见 `docs/MULTI-ROLE.md`）+ chat 自由化（删 `/start-chat` 路由、首条消息直接 inject prompt、表单全选填、详情页打开 ContextDocsPanel）+ 字段统一删 `feishuUrl` + 顶部品牌改「开发流水线」+ 大规模代码质量清扫。当前实际进度看 HANDOFF.md「V0.2 → V0.3.5 演进 + V0.4」段、Chat 架构看 DESIGN.md 第 16 节。

---

## 当前阶段（2026-05-15 同步）

| 阶段 | 状态 | 备注 |
|---|---|---|
| 基础设施（设置页 / shadcn / Tailwind 4 / SDK 验证） | ✅ 完成 | clean slate 重做 |
| 任务列表 + 详情 + 双模式 UI 路由 | ✅ 完成 | 主页卡片列表 / `tasks/[id]` 按 mode 分两套 UI |
| **Plan workflow（V0.5 起 = 3 phase chain、单 SDK Run）** | ✅ 完成 | `plan-runner.ts` + 3 个 phase prompt 模板（plan / build / review）、V0.5 起加 fork 模式（ack 时换新 agent） |
| **Chat 模式（wait_for_user MCP）** | ✅ 完成 | `chat-runner.ts` + `chat-mcp.ts` + `watch-chat` |
| **ContextDocsPanel（任务级上下文文档面板）** | ✅ V0.3 完成 | `context-docs-panel.tsx`（V0.3.4 起 plan 自己读、不用 phase 重划） |
| **ask_user 弹窗 modal**（一次打包 + ABCD）| ✅ V0.3.2 完成、V0.3.3 微调 | `ask-user-dialog.tsx`（Other 选中保留其它 option、textarea 移下方） |
| **任务级 MCP 黑名单**（每任务可关闭部分 MCP）| ✅ V0.3.3 完成 | `Task.disabledMcpServers` |
| **shell + curl long-poll 保活**（取代 keep_alive_a/b/c）| ✅ V0.3.5 完成 | 新增 `wait-ack/route.ts`、删 keep_alive 三件套 |
| **断线手动「继续监听」**（Agent.resume）| ✅ V0.3.5 完成 | 新增 `resume-waiting/route.ts` + UI 按钮 |
| **ask_user race fix（grace window）** | ✅ V0.3.5 完成 | `finalizeEntry` 60 秒延迟清 |
| **task-fs 原子写 + 任务级互斥锁** | ✅ V0.3.1 完成 | 修 readMeta race |
| **status=error 诊断增强**（dump CursorSdkError）| ✅ V0.3.2 完成 | `plan-runner.ts` catch dump |
| **多角色 schema（V0.4）** | ✅ V0.4 完成 | `Task.role` + `TASK_ROLE_LABEL` + `phase-1-plan.md` 注入 `{{role}}` + `new-task-dialog.tsx` 选择器、当前仅 fe |
| **chat 自由化（V0.4）** | ✅ V0.4 完成 | 删 `/start-chat` 路由（合并进 `/chat-reply`）、表单全选填、首条消息直接 inject `buildInitialPrompt` 第三参数、agent 第一次 turn 就回答、详情页打开 ContextDocsPanel |
| **字段统一（V0.4）** | ✅ V0.4 完成 | 删 `feishuUrl` 字段、plan/chat 都用 `feishuStoryUrl`；chat-runner 用共享 helper `renderContextDocsSection` inject contextDocs |
| **代码质量大清扫（V0.4）** | ✅ V0.4 完成 | 修 chat-runner 严重 prompt drift（keep_alive_a/b/c → shell long-poll）、删老 phase prompt 文件、修 SKILL.md / `ask_user` description 残留、顶部品牌改「开发流水线」 |
| Plan + Build 端到端跑通 | 🚧 待用户 demo | 用户最近已能跑通 plan、build phase 也能写 artifact、但 wait-ack 长连接 / 代理稳定性还是隐患 |
| 自动 retry on ConnectError | 🔲 不做 | 用户决定：靠手动「继续监听」、避免 agent 反复踩坑 |
| **review phase（V0.5 代码已落地）** | 🚧 待联测 | 4 类差异 + plan 校验前移 + 模型 / agent 自由切换、详见 HANDOFF V0.5 段 |
| **V0.5.1 prompt / UI 打磨**（联测中边走边修）| 🚧 持续打磨 | SDK 工具名修正 / revise 永远 ask_user / resume artifact 真实性 / artifact-writer skill / ack dialog 回归 / 任务级模型字段、详见 HANDOFF V0.5.1 段 |
| **V0.5.2「再聊聊」意图二分**（V0.5.1 §10 方向 A 简化版）| ✅ 完成 | 「补意见」→「再聊聊」、agent 在 ask_user 时让用户选「我想改 / 我想问 / 先答再决定」、A 改 artifact / B 仅答疑（严禁 edit）、协议层不动、详见 HANDOFF V0.5.2 段 |
| Cancel chat（保留任务、停 agent） | 🔲 未启动 | 当前只能"删任务" |
| 飞书 / swagger 自动拉 | 🔲 未启动 | V0.6 启动、用户已配飞书 MCP |
| cost / token dashboard | 🔲 未启动 | V0.7 启动 |

---

## V1 拍板（2026-05-08 → 2026-05-11 演化版）

### 流程：双模式

```
plan 模式（阶段化、HITL 在 phase 边界）：
  [raw_input] → plan → [前端 ack] → build → [前端 ack] → 完
                ✅                  🚧

chat 模式（单 SDK Run、HITL 走 wait_for_user 阻塞）：
  [raw_input] → 整段对话（agent 反复 wait_for_user、用户在 ChatView 输入触发 chat-reply）→ 用户停 / done
                ✅
```

老版本拍的「spec → plan → build」三步流程：spec 已砍（实测产出对开发参考价值低、反而拉长链路）。chat 模式是 2026-05-09 ~ 2026-05-11 新增的第二条路径、跟 plan 阶段化互补。

### 每步 7 维度缰绳（不变）
1. 输入产物（schema / 上游文件）
2. 工具白名单（哪些 MCP / SDK / 命令可用）
3. 输出产物（含 frontmatter 的 markdown）
4. HITL 闸门（plan 模式 = 前端 ack 按钮、chat 模式 = wait_for_user 阻塞）
5. 自验证（eslint / typecheck / prompt review）
6. 失败回滚（git reset / 上一步重跑）
7. 事件日志（events.jsonl 全量记录）

### B 端阶段二定位
不是「Figma + Token」、是「接口契约 + 数据模型」（权限矩阵 V1.x 待评估）。

### V1 必接 vs 选接 vs V2+
**plan phase（已落地）**：仓库只读 / 类型定义 read / write-disabled / plan.md frontmatter / Task List schema（必）；git log / blame、self-review（选）。
**build phase（待启动）**：Cursor SDK / git 每 task commit / file allowlist / eslint / typecheck / typecheck 失败重试上限（必）；prettier / Cursor rule / Skill（选）；hook / 浏览器截图 / token 上限（V2 补）。
**chat 模式**：用户配的 MCP servers + 内置 `feAiFlowChat` HTTP MCP（提供 wait_for_user）；任务级 MCP 白名单（`Task.enabledMcpServers`）；agent 自由调 SDK 内置工具。

### 预留扩展点（V2 不重构）
1. phase 可注册（`PhaseId` union type、加新 phase 时只扩这个 + 注册 runner）
2. 产物 frontmatter（V2 加字段不动表结构）
3. 「完成」= 最后一个 phase 被 ack、不写死 build 跑完
4. `TaskMode` 留扩展位（未来要加 review 模式之类的、直接扩 union）

详细工具清单看 `docs/DESIGN.md` 第 14 节、reliability 4 件事看第 13 节、与公司 5 阶段对齐看第 15 节、Chat 模式架构看第 16 节。

---

## 已完成里程碑（保留作演化记录）

### 2026-05-08 ~ 2026-05-09：基础设施 + Plan phase

- 设置页（4 张 Card、每张独立保存）
- 任务列表 + 详情页
- `data/tasks/<id>/` 三件套（meta.json / events.jsonl / *.md）
- Plan phase：`prompts/plan-phase.md` + `plan-runner.ts` 流式消费 SDKMessage、artifact 增量写

### 2026-05-09 ~ 2026-05-10：砍 spec phase

实测下来 spec 对开发参考价值有限、plan agent 自己进仓库 grep 一遍后产出的 Task List 已经够准。砍 spec、改 `PhaseId = "plan" | "build"`。

### 2026-05-09 ~ 2026-05-11：Chat 模式落地

- 新建 `TaskMode = "plan" | "chat"`、新建任务默认 chat
- 本地 HTTP MCP `feAiFlowChat`（chat-mcp.ts）+ `wait_for_user(task_id)` 阻塞工具
- `chat-runner.ts` publish-subscribe 模式、`runningChats / subscribers` 挂 globalThis
- `start-chat`（POST、fire-and-forget）+ `watch-chat`（GET、SSE 订阅）拆开、刷新页面不断 agent
  - ⚠️ V0.4 已删 `start-chat`、启动职责合并进 `/chat-reply`
- 50s keepalive + 反 anti-loop 双重压制（keepalive 文本变体化 + prompt 反反思指令）
  - ⚠️ V0.3.5 已删、改成 shell + curl long-poll
- `completed` 状态可"再聊一次"重启 agent（计费再算一次、UI 有提示）
  - V0.4 起：`completed` / `failed` 状态再发消息会自动重启 agent、不需要专门按钮
- 任务删除 cleanup 三步：cancelChat → cleanupChatTaskState → deleteTask

---

## V0.4 / W4：多角色 schema + chat 自由化 + 代码质量大清扫（已落地）

**目标**：让 fe-ai-flow 不只服务前端、能扩到后端 / 数仓 / 测试 / 移动端；把 chat 模式真的「自由化」（不强制填表 / 不强制点启动）；清扫前几版残留的 prompt drift 和死字段。

### 多角色 schema（详见 `docs/MULTI-ROLE.md`）

- `Task.role: TaskRole`（当前仅 `"fe"`、未来扩）+ `TASK_ROLE_LABEL` 中文映射、单一来源
- `task-fs.ts` 老数据兜底 `"fe"`、`plan-runner.ts` 把 `{{role}}` / `{{roleLabel}}` 注入 phase prompt
- `phase-1-plan.md` 强调「以 role 视角、只挑相关部分做、不收集其他角色实现细节」
- `new-task-dialog.tsx` 加角色选择器（当前单值、UI 保留以信号未来扩）

### chat 模式自由化（用户拍板 2026-05-15）

- 表单全选填：标题 / 仓库 / 飞书项目链接都可空、不填 `task-fs.createTask` 给默认值（占位标题 + `os.homedir()` 仓库）
- 删 `/start-chat` 路由：启动职责合并进 `/chat-reply`、用户在输入框发首条消息时后端自动 spawn agent
- 首条消息直接 inject prompt：`chat-runner.buildInitialPrompt(task, skills, firstMessage)` 第三参数、agent 第一次 turn 就回答（不绕 wait_for_user）
  - 走过的弯路：先做 `pendingFirstMessage` 队列让 agent 起手 wait_for_user 时消费、但 wait_for_user 进来会让 UI 输入框短暂可用、还会被 agent emit「正在调用 wait_for_user 等你」之类协议元叙述。直接塞 prompt 一步到位
- 详情页打开 ContextDocsPanel：chat 任务也能随时加 / 删上下文（之前 `!isChatMode` 守卫拿掉）
- chat 模式 inject contextDocs：`renderContextDocsSection` 从 `plan-runner.ts` 抽到 `src/lib/server/context-docs-prompt.ts`、plan / chat 共用

### 字段统一

- 删 `feishuUrl` 字段（之前 chat 模式表单用、根本没拼进 prompt、是个死字段）
- plan / chat 都用 `feishuStoryUrl`、`createTask` 不分 mode 都把它落「飞书 story」contextDoc

### 代码质量大清扫

- 修 `chat-runner.ts` 严重 prompt drift（buildInitialPrompt 还在教 keep_alive_a/b/c 轮转、chat 模式实际坏了）
- 删 `prompts/phase-{1-context,2-plan,3-build,4-ship}.md` 老文件（V0.3.4 起不再使用）
- 修 phase prompt / SKILL.md / chat-mcp ask_user description 里 `keep_alive` 残留
- 顶部品牌改「开发流水线」（产品形态命名、用户拍板顶部 UI 用这个；**README + DESIGN / HANDOFF / PRODUCT-COMPARISON 里「项目级 AI Harness 平台」表述照旧**——Harness 是项目灵魂、不能因顶栏简化就丢）
- `chat-mcp.ts` GLOBAL_KEY bump 到 `__feAiFlowChatStateV6__`（dev 热重载不混入旧 V5 状态）
- README.md 整篇重写到 V0.4、DESIGN.md 顶部 warning 改完整版本演进表、HANDOFF.md V0.4 段细化

### 未启动子项（V0.6+ 再说）

- 角色枚举扩展（be / data / mobile / qa）：等真有 1 个非 fe 用户来开新坑、不空设
- `prompts/roles/<role>.md` 片段化（当前角色提示直接写在 phase-1-plan.md「当前角色提示」段、扩展时再抽）

---

## V0.5 / W5：review phase + 多 phase 模型选择 + plan 校验前移（代码已落地、待联测）

**目标**：在 build 之后补一道 review phase、把编码完成到「真的可以交付」之间那段手工活吃掉。设计 + 实施详见 `docs/HANDOFF.md` V0.5 段（含完整 artifact 模板 + fork 流程实现细节）、本节只列里程碑。

**核心改动**：

- **Phase 拓扑**：`plan → build` → `plan → build → review`、review 完成 = `completed`
- **review phase 职责**：拿 `git diff` × `01-plan.md` × `02-build.md` × contextDocs 做结构化差值、产出 `artifacts/03-review.md`
- **4 类差异分流**：范围扩张 / 范围收缩 / 实现偏差 / 未完成、不同性质不同处理路径（详见 HANDOFF V0.5 段）
- **plan phase 校验前移**：plan agent 在 `01-plan.md` 里写「我的理解 vs 飞书原文」对照、避免 review 阶段才发现差异
- **agent 复用**：默认整条 workflow 同一个 agent（节省 500 次套餐配额）、用户在 ack 时可手动切「换新 agent」（reviewer ≠ author）
- **模型选择**：settings 默认模型 + 每 phase ack 时可切（切了不同模型 → 暗示起新 agent run、SDK 限制同 run 不能换模型）

**坚决不做**（V0.5 止损边界）：

- ❌ 自动 git push / 自动改飞书 story 状态（V0.3.3 砍 ship 的核心规避项、V0.5 不重新拾起）
- ❌ agent 自动循环修复差异（HITL 闸门优先）
- ❌ 默认强制起新 agent run（决定权给用户）
- ❌ review 之后再加 phase（V0.5 收敛到 review）

**已落地（2026-05-18）**：

- ✅ `prompts/phase-3-review.md` 写完（含 4 类差异分流 + 严格只输出文本约束）
- ✅ `prompts/phase-1-plan.md` 加「§1.1 我的理解 vs 飞书原文」校验前移段
- ✅ `plan-runner.ts` 加 fork 模式（`Agent.create` 新 agent、super-prompt 顶部 fork banner 提示从哪 phase 开始）
- ✅ `phase-ack` 路由支持 `forkAgent` / `nextModel` / `bootArgs`、fork 流程 `markPlanForFork → cancelPlan → waitForPlanToStop → markPhaseAcked → runPlanWorkflow(fork)`
- ✅ `src/components/tasks/approve-phase-dialog.tsx` 新增、含模型 selector + 「换新 agent」switch
- ✅ task-fs.ts / task-display.ts / types.ts 加 review phase 元数据

**待联测**：

- 跑 1-2 个真任务、走完 plan → build → review 三 phase（含 plan ack / build ack / review ack 三次 HITL）
- 测 fork：在 build ack 时切换模型 / 勾「换新 agent」、确认旧 agent 干净退出 + 新 agent 接管 review
- 调差异分类：跑出 03-review.md 后看 4 类差异的实际效果、按用户反馈调 prompt

---

## V0.5.1 / W5.1：联测中的 prompt / UI 打磨（2026-05-17 ~ 2026-05-18、持续）

**目标**：用户开始走真任务联测 V0.5、把发现的所有 prompt 边缘 case / UI 不顺 / SDK 工具名错配吃掉、不开新功能口子。详细修复清单 + 全 commit 列表见 `docs/HANDOFF.md` V0.5.1 段、本节只列重点。

**已落地**：

- ✅ **SDK 1.0.13 工具名全量修正**：`read_file` → `read`、`edit_file`/`write_file` → `edit`/`write`、`prompts/*` + `plan-runner.ts` + `chat-runner.ts` + `skills/*` + UI + docs 全清
- ✅ **revise feedback 永远先 ask_user 复述**：用户点「补意见」后 agent 不再闷头改、永远先调 `ask_user` 跟用户复述理解 + 改动计划（不再做 feedback 质量判断分支）
- ✅ **resume-waiting artifact 真实性检查**：`fs.stat` 读 artifact 大小、空 / 不存在 → `[RESUME_INCOMPLETE]`、有内容 → `[RESUME_WAITING]`、防 agent 撒谎说「已产出」
- ✅ **agent 中间 phase 提前退 run 修复**：prompt 加强约束 + 阶段转换 banner、ack approve 后必须进下一 phase
- ✅ **`artifact-writer` skill 渐进式披露**：prompt 不再反复教「`write` vs `edit`」、改成「写前先 read 这个 skill」、prompt 短了一大截、agent 第一次写之前自行查阅
- ✅ **ack UI 回到 dialog**（三次来回后用户拍板）：「通过 PHASE」按钮直接打开 `ApprovePhaseDialog`、内含模型 selector + fork toggle、行内布局撤回（先把所有逻辑走通、再回来优化交互）
- ✅ **任务级模型字段 `Task.model`**：新建任务表单加 selector、默认 `settings.defaultModel`、可为本任务挑别的、`prepareRunArgs` 优先 task.model 启动 agent
- ✅ **弹窗文案统一极简化**：所有 `DialogDescription` 解释性文案删掉、字段帮助文案缩到一句话、「跟 AI 再聊聊」按钮文案缩为「补意见」

**已落地（V0.5.2、2026-05-18 收尾）**：

- ✅ **「再聊聊」意图二分**：「补意见」按钮 → 「再聊聊」、agent 在 ask_user 复述时让用户选「我想改 / 我想问 / 先答再决定」、Path A 改 artifact、Path B 仅答疑（严禁 `edit`/`write`、只读 `read`/`grep`/`glob` OK）、Path C 先答再决定。**协议层不动**、复用 `[PHASE_ACK revise]` 通道、不新加 API。原 V0.5.1 §10 方向 A（新加「问 AI」按钮 + 新协议）的简化版、UI 改一个文案 + prompt 改 D-scheme 即可。详见 HANDOFF V0.5.2 段。

**待联测**：

- 🚧 **真任务联测**：跑 1-2 个真飞书 story、走完 plan → build → review 全链路、验证 V0.5 + V0.5.1 + V0.5.2 所有打磨
- 🚧 **「再聊聊」意图二分实测**：分别试「明确想改」/ 「明确想问」/ 「含混」三种输入、确认 agent 不偷偷动 artifact

---

## V0.5.3 ~ V0.5.11：持续打磨期（2026-05-18 ~ 25、已落地）

V0.5 大动后用户密集联测、超过一周小迭代、每一档都先落 HANDOFF.md「最近演进」段、再老的迁到 CHANGELOG.md。本节只列里程碑指引、细节请去 HANDOFF / CHANGELOG。

- ✅ **V0.5.3 ~ V0.5.4 图片附件**：revise / chat 支持贴图、`use-image-attach` hook 统一处理 paste / drop / file
- ✅ **V0.5.5 plan / build / review 骨架精简**：三 phase artifact frontmatter 全删、直接从 `# 方案：xxx` 起头
- ✅ **V0.5.6.x ask_user 无限 + 稍后再补充 + plan 模板大改 + prompt 加严**：见 CHANGELOG
- ✅ **V0.5.7 统一推进入口**：合并历史 N 个续接按钮为单一「推进」+ `AdvanceDialog` 三选一（resume / fork / restart）、resume 失败 NGHTTP2_ENHANCE_YOUR_CALM 自动降级 fork、删 `/resume-waiting` 路由
- ✅ **V0.5.7.1 ~ V0.5.7.6 fork reason + 修改记录 + 内部技术词禁项**：fork 走 fix mode、不 rewrite 已有产物、增量 edit、修改记录段约束
- ✅ **V0.5.7.7 `_shared.md` 抽出**：三 phase 通用 artifact 写法 + 跨 phase 规则抽到一份 md、改约束改一处即同步
- ✅ **V0.5.8 artifact 间引用走前端 tab**：`looksLikeArtifactRef` 识别裸文件名 → artifact-panel 渲染为可点 button、点击切 tab
- ✅ **V0.5.9 任务仓库多选 + 公共父目录 cwd**：`Task.repoPaths: string[]`、`getEffectiveCwd` 算公共父目录、多仓 git 命令必须 `cd <repo>` 再跑
- ✅ **V0.5.10 revise 交互二分类铁则 + Resizable 分栏**：feedback 按「问类 / 改类」铁则二分、AI 行为完全可预测；artifact / event-stream 双栏可拖动、持久化 `task.uiLayout`
- ✅ **V0.5.11 系统瘦身 + 提示词模板化 + 文档拆分**：plan-runner 1651 → 1432 行、抽 `prompts/_super.md` 模板（buildSuperPrompt 442 → 100 行）、event-stream 890 → 427 行（拆 utils.tsx + rows.tsx）、HANDOFF 2018 → 289 行（拆 CHANGELOG.md）、artifact-panel 删「渲染 / 原文」切换

**待联测**：

- 🚧 **fix mode 真任务测**：fork build + textarea 填 bug → AI 真的只 edit 不 rewrite
- 🚧 **V0.5.11 提示词模板化运行时验证**：跑一道真任务、看 `_super.md` 渲染输出与之前硬编码版的行为一致

---

## V0.5.12 / W5.12：artifact diff 视图 + review 闭环 + 全局清理（代码已落地、待联测 review 闭环）

V0.5.12 实际跑下来分了三轮迭代、详细内容看 `docs/HANDOFF.md` 三段、本节只列里程碑。

### 迭代一：artifact diff 视图（已落地）

**痛点**：每次「再聊聊」让 AI 改 md 后、用户不知道 AI 改了哪些地方、需要重读长 artifact。

**落地**：

- 后端 `phase-ack` revise 分支 → `snapshotArtifact` 复制旧版到 `data/tasks/<id>/artifacts/.revisions/<NN>-<phase>.<ISO>.md`、每 phase 上限 10 个 GC
- `Task.revisions[phaseId]` 加元数据数组、新增两条 API（`artifact-revisions` / `artifact-diff`）
- `ArtifactPanel` toolbar 加「正文 / Diff」切换 + Diff 模式 dropdown（对比上次 / 初版 / 任意快照）+ 「行内 / 并排」切换 + 未看 revision 红点指示器（first 版用过黄 banner、用户拍板「简单点」改成红点）
- `react-diff-viewer-continued` + `prismjs` markdown 语法高亮（用户「太代码风格」反馈后补的、走 `prismjs/themes/prism-tomorrow.css`）
- `next/dynamic` 懒加载、不切到 Diff 不拉、First Load JS 270KB 持平 V0.5.11

### 迭代二：review phase 闭环（已落地、待联测）

**痛点**：review phase 列「实现偏差 / 未完成 task」段建议「接受偏差并更新 plan」、但用户不知怎么落地——review 不能动 plan、build 已结束、「再聊聊」也不一定 trigger 改对 plan。流程**没闭环**。

**落地**：

- `prompts/phase-3-review.md` 重写 §7：review agent 写完初稿后必须调一次 ask_user 把所有偏差 / 未完成 task 一次性问完
- ask_user 答 b（接受偏差）→ agent edit `01-plan.md` 对应段落、用 `~~strikethrough~~` 划掉旧描述 + 加 review ack 补录标记
- ask_user 答 c（未完成 task 接受不做）→ agent edit `01-plan.md` §5 task 加注解
- 每条决策追加到 `03-review.md`「§ 用户决策」段
- 约束扩展：review phase **允许** edit `01-plan.md`（破例、只在 §7 ask_user 答完 b/c 后、不动 §5 task 拆分骨架）
- ⚠️ limitation：review edit 01-plan.md 时**不自动 snapshot 旧 plan**（snapshot 钩子只挂在用户 revise 路径上）、diff 视图看不到这次改动、V0.5.13 再补

### 迭代三：全局遗留清理（已落地、2026-05-26）

走过的弯路：一度在 ask_user 加 `recommended` 字段 + 弹窗「一键接受推荐」按钮、用户实测后拍板砍掉「HITL 是底线、AI 不预判倾向」、顺势扫整个项目执行「开发期不写向后兼容代码」原则、清掉一堆历史兼容：

- 删 V0/V1 老 artifact path 兜底（`<phase>.md` 在 task 根）、`phaseArtifactFilename` idx<0 改抛错
- 删 `sanitizeCurrentPhase`（V0 时代 `spec` phase 兜底）
- 删 `TaskMeta.repoPath` 单值字段 + hydrate `[repoPath]` 兼容
- 删 `start-workflow` mode 缺省 = restart 兼容、改成必传
- 删 `local-store` 老 schema 迁移（`migrateDefaultModel` / `migrateMcpJson`）、改成纯校验

**副作用**（用户拍板接受）：V0.5.9 之前的 task 打不开 / V0 spec task 崩 / 老 schema localStorage 需重配 settings / 外部脚本调 start-workflow 不带 mode 返 400（项目内 UI 无影响）。

**不做**（评估后 ROI 低、用户已拍）：

- ❌ 渲染 markdown + 段级高亮（手写段对齐算法易错、ROI 不高）
- ❌ 双视图 split-view（artifact-panel 本就不大、拆栏挤）
- ❌ SDK toolCall 事件流 diff 卡片（事件流已拥挤、bash sed 拿不到 diff 不可靠）
- ❌ ask_user 推荐机制（一度加过、用户拍板砍）

**实际成本**：~10h（含两次反复 + 一次 cleanup）、超原估 5-7h

**待联测**：迭代二的 review phase ask_user 闭环（迭代一 diff 视图用户已基本验证）

---

## V0.5.13 ~ V0.5.14 / W5.13-14：事件流 UX 优化（已落地、待联测）

V0.5.13 + V0.5.14 围绕「事件流体验」做了一连串小迭代、起点是用户在 V0.5.12 review 闭环联测时反馈「事件流密密麻麻」、终点是事件流性能 + 滚动彻底解决。细节看 `docs/HANDOFF.md`「最近演进」段。

- ✅ **V0.5.13 事件流密度优化**：`summarize` 改全文空白压缩 + 200 字截、`mergeAdjacentToolCall` 合并同 phase 连续 tool_call（折叠态 ×N 后缀 + 展开态每条带 `[tool name]` badge）、解决 review 阶段 agent 频繁 edit artifact 导致 tool_call 卡片刷屏
- ✅ **V0.5.13.2 4 dialog Cmd+Enter 默认快捷键**：revise / ask_user / new-task / advance 四个 dialog 的 Textarea 统一加 onKeyDown handler、Cmd/Ctrl+Enter 提交、单 Enter 换行、跟 chat 应用通用习惯（Slack/Cursor/ChatGPT）对齐
- ✅ **V0.5.13.4 事件流自动滚动 bug fix**：useEffect dep `renderEvents.length` → `task.events.length`（之前合并算法把多条合一条 / length 不变 / 贴底不触发滚动），后被 V0.5.14 Virtuoso 接管整段删除自然消失
- ✅ **V0.5.14 事件流虚拟滚动 + React.memo**：装 `react-virtuoso@4.18.7`、`<Virtuoso>` 替代原 `<div onScroll>` 手撸滚动、DOM 节点封顶 ~30 个、`followOutput={(atBottom)=>atBottom?"smooth":false}` 一行替代 25 行贴底跟随逻辑、`streamingText` 作为 `__streaming__` 虚拟末尾 item 参与虚拟化、`EventRow` / `AskUserRequestRow` / `StreamingAssistantRow` 全 React.memo、bundle +15KB（First Load 270 → 290 KB、可接受）

**待联测**：

- 🚧 跑一个事件多的真任务（几百条 events）、看滚动 / 切折叠 / 推 chunk 是否丝滑
- 🚧 贴底跟随是否正常（不在底部时不打扰、回到底部恢复跟随）
- 🚧 resizable 拖动是否影响 Virtuoso 虚拟化（理论上 ResizeObserver 自动适配、待用户实测）

---

## V0.5.X 历史里程碑细节

详见：

- `docs/HANDOFF.md`「最近演进」段（V0.5.13 + V0.5.14、滚动 2 个子版本）
- `docs/CHANGELOG.md`（V0.2 ~ V0.5.12、全部历史档案、时间倒序）

---

## V0.6 / W6：飞书 MCP 自动拉文档（未启动、V0.5 跑稳后再开）

**目标**：用户只输入 storyId、自动拉飞书需求 + swagger

**实现**：

- `src/lib/feishu.ts`：通过飞书 OpenAPI 拉 docx 内容
- `src/lib/swagger.ts`：通过 swagger URL 拉接口 schema
- 表单加"自动拉取"按钮、调这两个接口、把返回的内容自动填到需求 / swagger 字段

**预计**：1 天。

**前置依赖**：

- 用户在设置页加飞书 app_id / app_secret（也存 localStorage）
- swagger 集中地址（公司有统一 swagger gateway 吗？需确认）

---

## V0.7 / W7：Cost / Token Dashboard（未启动）

**目标**：知道每个任务花了多少 token / 多少钱

**实现**：

- `llm-log.jsonl` 已经记 token 数（如果 SDK 返回的话）
- 加一个 `/dashboard` 页面、汇总：
  - 今日总 token / 总 cost
  - 按任务 / 按 phase 分布
  - 平均 latency
- 数据源：扫描 `data/tasks/*/llm-log.jsonl`

**未来可选升级**：接 Langfuse 自托管 dashboard、白送一套观测能力。

**预计**：1 天。

---

## V0.3 候选区

### A. 任务级「上下文文档面板」 ✅ 已落地（V0.3）

详情页顶部加可折叠面板、用户随时增 / 删上下文文档（URL / path / 自由文本）、agent 后续 phase 都能用。

- **场景**：飞书 story 链接建任务后、产品 / 后端陆续补 PRD / 接口文档 / 评论、不该被「建任务时一次性填」绑死
- **设计要点**（避坑）：清单 inject + 按需拉取（不全量塞 super-prompt）、prompt 教 agent 发现冲突列「不确定项」
- **已附带做的**：Phase 1 角色变窄（只综合用户提供的上下文、不扫仓库）、Phase 2 接管仓库扫描、Phase 1/2 重叠消失
- **关联**：用户答完的 ask_user 答案会自动落到 contextDocs（title=`Q: 问题`）、后续 phase 复用

### B. Phase 3 ack 前「cursor-rule 沉淀」步骤

Phase 3 build 完成后、ack 前、agent 把本次改动中发现的「值得沉淀的仓库约定」整理成 `proposed-rules.md`、HITL 让用户选哪些写进仓库的 `.cursor/rules/`、下个 task 自动生效。

- **场景**：B 端仓库存在大量隐性约定（dialog 样式 / api 封装 / store 路径）、agent 每次重头摸索成本高、应该一次发现长期沉淀
- **为什么放 Phase 3 之后**：只有真改过代码才知道哪些约定是「真的重要」、凭空扫仓库提议出来的 rule 多半不接地气
- **harness 立场**：「把可重复的知识结构化沉淀」是 harness 的核心命题、这是正统路子

### C. Phase 边界重划（如果 A 不做）

不做 A 的话、备选路径：Phase 1 改成「只拉文档 + 与用户澄清需求」、Phase 2 接管「扫仓库 + 出方案」。如果做了 A、这条自然落地。

---

## V0.8+ / W8+：体验优化

- [ ] 任务搜索 + 标签（归档已落 ✅）
- [ ] cancel 中途打断（不删任务）——chat 模式当前只能"删任务"
- [ ] retry 单 phase（改 prompt 后重跑 plan、不重做整个链路）
- [ ] 比较同一 task 多次执行的 plan 差异
- [ ] 多语言 prompt 模板（B / C 端分开）
- [ ] 团队共享 prompt 库（git submodule？）
- [ ] chat prompt 外提 `prompts/chat-init.md`（待 chat 模式跑稳定 ≥2 周不踩坑）

---

## 不打算做（明确止损）

| 不做的事 | 为什么 |
|---|---|
| 真·multi-agent 协作（PM/Dev/QA 互相谈判式、如 BMAD） | Cognition 警告、共识盲点、debug 灾难。注：phase chain 里多 agent 节点是合法的、跟这条不冲突 |
| AI 自审 review bot（纯 LLM 看 LLM 写的代码判对错） | 共识盲点问题、性价比低。**注**：V0.5 review phase ≠ 这条——前者是「拿 git diff × plan artifact 做结构化差值」、用的是确定性产物、不是 LLM 判断对错、本质是 harness 增量、不冲突 |
| 跨 AI 厂商路由（LiteLLM） | 没必要、增加复杂度 |
| 自动跑测试用例 | 公司没单测 / e2e、强行做没意义 |
| 自动 merge MR | 责任归属问题、永远不该自动 |
| 接 IDE plugin | 命令行 + Web UI 已经够、IDE plugin 维护成本高 |

---

## 决策检查表（V 转 V 时）

每个 V 完成后、问自己 4 个问题、再决定下一步投不投：

1. 当前 V 在真实任务上的命中率 ≥ 70% 吗？（不够、回去调 prompt）
2. 用户实际使用频次足够吗？（一周用不到 3 次、说明价值不够）
3. 维护成本是否在增长？（prompt 越来越长、规则越来越多——警惕）
4. 用户主动要扩展吗？（用户不主动提、就是没痒处）

**任意一个 ❌ → 暂停、调研、不要硬推下一阶段**。
