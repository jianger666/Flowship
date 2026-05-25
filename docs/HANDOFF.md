# fe-ai-flow Handoff

> **权威源**：代码 + 本文件。其余 docs/*.md 为辅助、有冲突以代码 + 本文件为准。
>
> （历史：曾经以飞书 V0.2 草稿为权威、已废弃。）

## 项目定位（一句话）

站在 Cursor SDK 肩膀上的**项目级 AI Harness 平台 · 飞书 story → PR 自动化**。核心是 Harness（缰绳）：每个 phase 边界用确定性工具（typecheck / lint / hooks / Skills / MCP / HITL ack）压住 LLM 非确定性、保证产出可观测、可回退、可复用。

## 给 AI 接力的最小上下文

接力的 AI 进来后按顺序读：

1. `.cursor/rules/project-context.mdc` —— 强制约束
2. `.cursor/rules/learned-conventions.mdc` —— 编码风格
3. 本文件的「当前架构快照」段（V0.5 系列、稳定架构）+「最近演进」段（V0.5.10 + V0.5.11、最近两轮迭代）
4. `prompts/_super.md` —— **super-prompt 主模板**（V0.5.11 抽出、占位符注入式、改模板优先在这里改、不再回 .ts 改硬编码）
5. `prompts/_shared.md` —— **三 phase 通用 artifact 写法 + 跨 phase 规则**（V0.5.7.7 抽出、改 phase prompt 前必读、避免漏改一处导致跨 phase 不一致）
6. `prompts/phase-1-plan.md` / `prompts/phase-2-build.md` / `prompts/phase-3-review.md` —— phase 特有约束
7. `src/lib/server/plan-runner.ts` 的 `buildSuperPrompt()` —— 看 super-prompt 怎么拼装（V0.5.11 后 ~100 行、纯变量注入）
8. `docs/DESIGN.md` 顶部 warning + 第 16 节（chat 架构、注意节首 V0.3.5 + V0.4 警告）
9. `docs/ROADMAP.md` 当前阶段表
10. `docs/MULTI-ROLE.md`（V0.4 多角色机制）
11. `docs/CHANGELOG.md` —— 历史演进档案（V0.2 ~ V0.5.9）、想看某条早期变更细节再翻、平时不用看
12. `src/lib/server/chat-mcp.ts` 顶部注释（保活机制核心）
13. `src/lib/server/chat-runner.ts` 顶部注释 + `buildInitialPrompt`

## 代码层面要点

### 强制

- 思考和回复永远用中文
- 每次对话操作前唤起 `cursor-feedback` MCP、timeout 600 秒
- 代码改完跑 `pnpm typecheck`（用户对低级错误零容忍）
- 开发期不要写向后兼容代码

### 编码约定（详见 `.cursor/rules/learned-conventions.mdc`）

- UI 组件统一用 shadcn/ui、不要手写原生 element
- 函数声明统一用箭头函数（除了第三方 / Next.js default export）
- 注释中文、解释"为什么"而不是"做什么"
- 每个 useState / useRef / useMemo 跟一行短注释

---

## 当前架构快照（V0.5 系列、稳定）

> 本段只描述「现在的代码是这样组织的」、不带版本号迭代细节。版本演进史看 `docs/CHANGELOG.md`。

### Phase 模型：plan → build → review

```
新建 task → plan（出方案 01-plan.md）→ build（写代码 + 02-build.md）→ review（diff 对照 + 03-review.md）→ completed
```

- 三个 phase 都在**同一个 SDK Run**里跑、phase 间用 `wait_for_user` 阻塞等用户 ack（节省 Cursor 计费——Run 收费、不是请求收费）
- PR 提交 + 飞书状态回写**手动由用户做**（review artifact 里给 commit msg / PR body 草稿、用户复制走）
- ⛔ 不做「agent 发现差异自己改、再 review 一轮」自动循环（HITL 闸门优先、避免 token 爆炸）

### HITL 闸门

每个 phase 结束 = `awaiting_ack` 状态、用户必须 ack 才能进下一 phase：

- **通过 PHASE**：打开 `ApprovePhaseDialog`、可选「换新 agent」+「切下一 phase 模型」
- **再聊聊（revise）**：打开 `ReviseDialog`、用户输入 feedback、走「问类 / 改类」二分类（见下）
- **deferred**：ask_user 弹窗有「稍后再补充」按钮、给用户跳过本轮 ask_user 的口子

### Revise 二分类铁则（V0.5.10 拍板）

用户写 feedback 后、AI 行为**完全可预测**：

```
- 问类（纯疑问句、不含改动暗示）
  字面含「为什么 / 怎么 / 是不是 / 能否 / 吗 / 呢 / ?」等疑问标记 + 不含改动暗示
  → 直接 emit assistant_message 答疑、不弹窗、不动 artifact

- 改类（其他所有 feedback、含模糊 / 兜底）
  → 先弹 ask_user 复述意图（固定模板「我打算 X、对吗?」、只有「✅ 同意」一个选项）
  → 用户 ✅ → 用 edit 改 artifact、按 _shared §5 留修改记录
  → 用户走「自定义回答」重说 → 当新一轮 revise feedback、重新走分类
```

判定护栏：判不准就当改类、走弹窗——错弹窗成本 1 click + 重说一句、错答疑成本「用户得再点再聊聊 + 重写指令」。

### 保活机制：shell + curl long-poll（V0.3.5）

```
agent 调 wait_for_user / ask_user
  → MCP 工具立即返回 shell 引导文本
  → agent 用 SDK shell 工具调 curl -sN <base>/api/tasks/:id/wait-ack?token=…
  → 长 HTTP 连接挂住、服务端每 60 秒 write 一行 [KEEPALIVE ts=...]
  → 用户 ack/reply → 服务端 resolve promise → 写一行结果 → 关流 → curl exit → agent stdout 拿到结果推进
```

**不**走 MCP 60s timer + 轮转——会踩 Cursor backend anti-loop。实证 shell 工具能撑 30 分钟+ 不挂。

### 推进入口三模式（V0.5.7）

task 跑到 failed / awaiting_user / completed 状态后、用户点「推进」、`AdvanceDialog` 三选一：

| mode | 后端动作 | 适用场景 | 成本 |
|---|---|---|---|
| `resume` | `Agent.resume(lastAgentId)` + send 续接 | wait-ack 断、agent 在 backend 仍活着 | +1 send 配额 |
| `fork` | `Agent.create` 新 agent + fork banner、从指定 phase 起跑、上游 artifact 复用 | 原 agent 已死 / 切模型 / 局部 fix | +1 send 配额 |
| `restart` | `Agent.create` 从 plan 完全重跑、覆盖现有 artifact | 改 prompt 大改动后想看纯净重跑 | +1 send 配额 |

**resume 自动降级 fork**：plan-runner catch 块检测 `NGHTTP2_ENHANCE_YOUR_CALM` / `Stream closed`、自动降级 fork（fromPhase = 当前 phase）、用户视角一次推进就能续走。

fork 时 textarea 填 reason（「这次主要想修什么」）、AI 拿到后会先 read 当前 phase artifact 判 fix mode、不 rewrite 已有产物、增量 edit。

### 多角色 schema（V0.4）

`Task.role: TaskRole`（当前仅 `"fe"`、未来扩 `be / data / mobile / qa`）、`TASK_ROLE_LABEL` 中文映射、prompt 顶部「当前角色：xxx」提示让 agent 只挑跟自己 role 相关的部分做。

### 多仓库 cwd 公共父目录（V0.5.9）

`Task.repoPaths: string[]`、SDK Run `local.cwd = getEffectiveCwd(repoPaths)`：

- 单仓 → cwd = 仓自身
- 多仓 → cwd = 公共父目录、AI 视角下挂 N 个 git 子仓、路径首段是仓名
- artifact / prompt 里的所有路径都以 `effective cwd` 为基准
- 多仓 git 命令必须 `cd <repo>` 再跑（super-prompt 已 inject 说明）

### Artifact 间引用走前端 tab 切换（V0.5.8）

`looksLikeArtifactRef(s)` 识别 `0N-<phase>.md` 形式的纯文件名引用（裸名、不含 `/`）、artifact-panel 渲染时把它变成可点 button、点击切到对应 phase 的 tab。

prompt 写「详见 `01-plan.md` §4」无需写完整路径、AI 心智负担不变、用户体验流畅。

### Super-prompt 模板化（V0.5.11）

super-prompt 主模板 = `prompts/_super.md`（17 个占位符）、`buildSuperPrompt()` 只负责变量注入：

```
buildSuperPrompt
  ├─ loadSuperPromptTemplate()    读 _super.md
  ├─ loadSharedPrompt(task)       读 _shared.md（跨 phase 共享规范）
  ├─ loadPhasePrompt × N          每个 phase 自己的 prompt md
  ├─ buildForkBanner()            fork 模式才有内容、否则空字符串
  └─ renderSuperPromptTemplate()  一次性 replace、空字符串保留字面（区别于 fillTemplate）
```

改 prompt 文案优先动 .md 文件、不用回 .ts 改硬编码。`renderSuperPromptTemplate` 跟 `fillTemplate` 区别：前者只把 `undefined`/`null` 替换成 `（未提供）`、后者把空字符串也替换。

### 共享 prompt `_shared.md`（V0.5.7.7）

三 phase 通用约束（artifact 写入工具 / frontmatter 禁项 / path 完整路径写法 / 内部技术词禁项 / fix mode 修改记录 / 中文表述 / 数字命名自检）抽到一份 md、`buildSuperPrompt()` 拼到「各 phase 详细 prompt」段之前。

改约束改一处即同步、不会漏改 3 个 phase 文件其中一个。

### Resizable 分栏（V0.5.10）

任务详情页 artifact / event-stream 双栏可拖动：

- 默认 70 / 30、minSize 20% / maxSize 80%
- 持久化在 `task.uiLayout.artifactPanelSize`（不写事件 / 不动 updatedAt）
- `react-resizable-panels@4.11.1`、4.x API（注意跟 shadcn 文档基于 2.x 不一样、详见 CHANGELOG V0.5.10 hot-fix）

### Ask_user 协议（V0.3.2 modal + V0.5.6 无次数上限）

- ask_user 弹窗 modal、不在事件流里 inline、避免被 keep_alive 信息淹没
- options 自动加 A/B/C/D 字母前缀、一次性提交所有答案、不可 dismiss
- **整个 phase 内无次数上限**、AI 按内容判断要不要继续问（不预设次数）
- **「稍后再补充」按钮**给用户退出循环的口子、答完点了 → `[ASK_USER_REPLY deferred]` 头、agent 把未答 Q 列进 artifact §6 + 按 default 推进

---

## 最近演进（窗口式、保留 2 个子版本）

> 写入规则：新子版本完成后在本段顶部追加、超过 2 个时把最老的迁到 `docs/CHANGELOG.md`。

### V0.5.11：系统瘦身 + 提示词重构 + 文档拆分（2026-05-23）

**背景**：用户拍板「整理 + 瘦身系统」三件事：①清死代码 ②重构 plan-runner 提示词拼接的三目运算地狱 ③扫不合理可优化的代码。

**Tier 1：死代码清理（5 处）**

- 删 `prompts/test-checklist-v0.3.5.md`（自标记 V0.3.6 该删、孤儿文件）
- 删 `src/app/api/tasks/[id]/run-plan/` / `start-chat/` / `rerun-phase/` 三个空路由目录（V0.2/V0.4 已迁走、目录留壳）
- 修 `plan-runner.ts` L847 死三目 `nextPhase ? "running" : "running"` → `"running"`

**Tier 2：plan-runner 提示词模板化**

- 新建 `prompts/_super.md`（~340 行、super-prompt 全模板化）
- `plan-runner.ts`：1651 → 1432 行（-219、-13%）
- `buildSuperPrompt()`：~443 → ~100 行（仅变量拼装）
- 抽 `buildForkBanner()` helper、`renderSuperPromptTemplate()`（空字符串保留字面、区别于 `fillTemplate`）
- 收益：以后改 prompt 文案改 `_super.md` 一处、不用碰 .ts

**Tier 3：event-stream.tsx 模块拆分**

- 原 890 行单文件 → 主文件 427 + `event-stream/utils.tsx` 188 + `event-stream/rows.tsx` 343
- utils：EVENT_LABEL / renderEventIcon / formatTs / mergeAdjacentThinking / summarize / meta 解析等纯函数
- rows：MarkdownText / StreamingAssistantRow / EventRow / AskUserRequestRow

**Tier 3 评估后不拆**（ROI 低）：

- `task-fs.ts`（1067 行）：结构已按功能段清晰分块、拆开需要 export 内部 helper 污染 public API
- `chat-mcp.ts`（1160 行）：核心是 stateful module（pendingMap / sessionTransports / awaitingNotifier 全 module-level）、拆需要把 state 提到 store class、改动面大风险高

**文档瘦身**：

- HANDOFF.md：2018 → ~300 行、拆出「当前架构快照」+「最近演进」窗口
- 新建 `docs/CHANGELOG.md`：1954 行、V0.2 ~ V0.5.9 全部演进档案、时间倒序（新在上）
- 写入规则化：新子版本先写 HANDOFF「最近演进」、再老一轮时迁到 CHANGELOG.md 顶部

**验证**：`pnpm typecheck` ✓ / `pnpm lint` ✓ / `pnpm build` ✓（21 routes 全编译成功、10/10 static pages）

### V0.5.10：revise 交互二分类铁则 + Resizable 分栏（2026-05-23）

**背景**（用户原话）：「再聊聊的结果不可控、有时候 AI 是弹窗过来问问题、有时候是在事件流回答我、有时候甚至都不回答我就直接开始改 md」

V0.5.5 起 prompt 里写「A 明确改 / B 明确问 / C 含混 / D 带图」4 分类、实操中标准模糊、AI 判得飘忽。

**V0.5.10 设计**（用户拍板「二分类铁则、用户能预测 AI 行为」）：

```
按 feedback 是否纯疑问句、铁则 2 分类：

- 问类（纯疑问句、不含改动暗示）
  字面含「为什么 / 怎么 / 是不是 / 能否 / 吗 / 呢 / ?」等疑问标记
  且 不含 改动暗示（无「改 / 删 / 加 / 调整 / 不对 / 怪怪的 / 再补 / 详细点 / 优化」等动词或暗示）
  → 直接 emit assistant_message 答疑、不弹窗、不动 artifact

- 改类（其他所有 feedback、含模糊 / 兜底）
  含明确改动指令 / 含改动暗示 / 模糊看不懂
  → 先弹 ask_user 复述意图（固定模板「我打算 X、对吗?」、二选一 ✅/❌）
    用户 ✅ → 用 edit 改 artifact、按 _shared §5 留修改记录
    用户 ❌ 重说 → 当新一轮 revise feedback、重新走分类
    用户 deferred → 跳过本轮（不重问）
```

**Resizable 分栏布局**：

- 任务详情页主区 artifact / event-stream 双栏可拖动
- 默认 70 / 30、minSize 20% / maxSize 80%、持久化在 `task.uiLayout.artifactPanelSize`
- 装 `react-resizable-panels@4.11.1`（注意 4.x API 跟 shadcn 文档基于 2.x 已不同、`Group/Panel/Separator` 替代旧 `PanelGroup/Panel/PanelResizeHandle`、`defaultSize` 数字默认是 `px` 不是 `%`、必须传字符串 `"70%"`）

**UX 精简**：

- 「再聊聊」placeholder 缩到一行
- revise 复述 ask_user options 简化为只有「✅ 同意」一项（重说走 AskUserDialog 自带「自定义回答」textarea）
- AskUserDialog「以上都不是 / 自定义回答…」→「自定义回答」
- 加严 ask_user prompt 约束、禁止塞「不对 / 不同意 / 重新说 / ❌」否定 options

⚠️ **验证 prompt 必须新起 task**：super-prompt 在 `Agent.create()` 时一次性灌进、`Agent.resume` 不重发。改 prompt 后想验证、必须新建 task 从头跑、旧 task 拿不到新 prompt。

---

## 关键文件索引

| 内容 | 位置 |
|---|---|
| Plan workflow 整体逻辑 + super-prompt（V0.5.11 重构后） | `src/lib/server/plan-runner.ts` |
| **super-prompt 主模板（V0.5.11 抽出、占位符注入）** | `prompts/_super.md` |
| **跨 phase 共享规范（V0.5.7.7 抽出）** | `prompts/_shared.md` |
| Chat workflow 整体逻辑 + V0.4 firstMessage 注入 | `src/lib/server/chat-runner.ts` |
| contextDocs prompt 渲染 helper（V0.4 抽出、plan/chat 共用） | `src/lib/server/context-docs-prompt.ts` |
| `wait_for_user` / `ask_user` 实现 + pendingMap + grace race fix | `src/lib/server/chat-mcp.ts` |
| wait-ack 长连接路由（V0.3.5、保活核心） | `src/app/api/tasks/[id]/wait-ack/route.ts` |
| 统一推进入口（V0.5.7、resume / fork / restart 三模式） | `src/app/api/tasks/[id]/start-workflow/route.ts` |
| chat-reply 路由（V0.4 合并启动职责） | `src/app/api/tasks/[id]/chat-reply/route.ts` |
| Phase 状态机 patch / 任务级互斥锁 / 原子写 / `lastAgentId` | `src/lib/server/task-fs.ts` |
| ContextDocsPanel（chat / plan 都用） | `src/components/tasks/context-docs-panel.tsx` |
| ask_user 弹窗（V0.3.2 modal、V0.5.6 加 deferred） | `src/components/tasks/ask-user-dialog.tsx` |
| **事件流主组件（V0.5.11 拆分后）** | `src/components/tasks/event-stream.tsx` |
| **事件流工具函数（V0.5.11 拆出）** | `src/components/tasks/event-stream/utils.tsx` |
| **事件流行组件（V0.5.11 拆出）** | `src/components/tasks/event-stream/rows.tsx` |
| Chat 视图（V0.4 自由化、无启动按钮） | `src/components/tasks/chat-view.tsx` |
| Plan 模式 UI（V0.5.7「推进」按钮 + V0.5.10 Resizable 分栏） | `src/app/tasks/[id]/page.tsx` |
| 推进 dialog（V0.5.7、resume / fork / restart 三选一） | `src/components/tasks/advance-dialog.tsx` |
| 启动 / phase ack / ask reply / mcp 黑名单 API | `src/app/api/tasks/[id]/start-workflow/route.ts` + `phase-ack/route.ts` + `ask-reply/route.ts` + `route.ts`（PATCH） |
| Plan / build / review phase prompt | `prompts/phase-1-plan.md` + `prompts/phase-2-build.md` + `prompts/phase-3-review.md` |
| Phase ack 高级选项 Dialog（V0.5、切模型 + fork agent） | `src/components/tasks/approve-phase-dialog.tsx` |
| 任务角色 schema + 展示文案（V0.4） | `src/lib/types.ts: TaskRole / TASK_ROLE_LABEL` + `docs/MULTI-ROLE.md` |
| 多仓 cwd / repoPaths 工具（V0.5.9） | `src/lib/path-utils.ts: getCommonParentDir / getEffectiveCwd / formatRepoSectionForPrompt` |
| Resizable 分栏 shadcn-style stub（V0.5.10） | `src/components/ui/resizable.tsx` |
| Skills loader | `src/lib/server/skills-loader.ts` |

## 设计变动流程

权威源 = 代码 + 本文件。设计层面变动：

1. **当前架构变动**（如 phase 模型改、保活机制改、新增大组件）→ 改代码 + 同步更新本文件「当前架构快照」段
2. **小步迭代**（同主题连续 .1 / .2 / .3 微调）→ 改代码 + 写到本文件「最近演进」段顶部
3. **再老一轮时**（「最近演进」积压超过 2 个子版本）→ 把最老那段迁到 `docs/CHANGELOG.md` 顶部

⛔ 不要散落到其它 md 写一份新的演进段。
