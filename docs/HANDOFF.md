# fe-ai-flow Handoff

> **权威源**：代码 + 本文件。其余 docs/*.md 为辅助、有冲突以代码 + 本文件为准。
>
> （历史：曾经以飞书 V0.2 草稿为权威、已废弃。）

## 项目定位（一句话）

站在 Cursor SDK 肩膀上的**项目级 AI Harness 平台 · 飞书 story → PR 自动化**。核心是 Harness（缰绳）：每个 phase 边界用确定性工具（typecheck / lint / hooks / Skills / MCP / HITL ack）压住 LLM 非确定性、保证产出可观测、可回退、可复用。

## 给 AI 接力的最小上下文

接力的 AI 进来后顺序读：

1. `.cursor/rules/project-context.mdc` —— 强制约束
2. `.cursor/rules/learned-conventions.mdc` —— 编码风格
3. 本文件 V0.4 段（最新架构）
4. `docs/DESIGN.md` 顶部 warning + 第 16 节（chat 架构、注意节首 V0.3.5 + V0.4 警告）
5. `docs/ROADMAP.md` 当前阶段表
6. `docs/MULTI-ROLE.md`（V0.4 多角色机制）
7. `src/lib/server/chat-mcp.ts` 顶部注释（保活机制核心）
8. `src/lib/server/chat-runner.ts` 顶部注释 + `buildInitialPrompt`

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

### V0.2 → V0.3.5 演进（2026-05-11 ~ 2026-05-15）

#### V0.2（2026-05-11）：4 phase workflow 落地

- **plan 模式 = 4 phase workflow**：context → plan → build → ship、一次 SDK Run 跑完全程
- **`wait_for_user` V2 语义**：支持 chat + workflow 两种模式、workflow 模式带 phase / artifact 参数
- **artifact 路径升级**：`artifacts/<NN>-<phase>.md`、`task-fs` 双读兼容 V0.1
- **新建任务默认 plan + 飞书 story 链接必填**
- **4 个 phase prompt 模板**：`prompts/phase-1-context.md` / `phase-2-plan.md` / `phase-3-build.md` / `phase-4-ship.md`
- **任务详情页 plan 视角**：phase 进度条 + artifact 预览 + 事件流 + 顶部「通过 / 补意见再跑」

#### V0.3（2026-05-11 ~ 2026-05-12）：上下文面板 + ask_user

- **ContextDocsPanel（任务级上下文文档面板）**：详情页可折叠面板、用户随时增删 URL / path / 自由文本、agent 各 phase 都能用
- **Phase 1/2 角色重划**：Phase 1 只综合用户提供的上下文（不扫仓库）、Phase 2 接管仓库扫描、消除两 phase 重叠
- **ask_user MCP 工具（V0.3 inline 形态）**：phase 内细粒度问答、答案自动落到 `contextDocs`（title=`Q: 问题`）后续 phase 复用

#### V0.3.1（2026-05-12）：抗 anti-loop / 文件并发

- **`keep_alive_a/b/c` 三端点轮转**：[USER_AWAITING] 文案伪装成「服务端事件查询接口」、配合 `next` 字段轮转、降低 anti-loop 触发
- **`task-fs` 原子写 + 任务级互斥锁**：彻底解决 `readMeta` 的 `SyntaxError: Unexpected end of JSON input`（race during `appendEvent`）
- **race 条件修复**：phase ack 后旧 keep_alive 调用回 `[STALE]` 而不是 `[CANCELLED]`、避免 agent 误退 run

#### V0.3.2（2026-05-12 ~ 2026-05-13）：协议硬约束 + ask_user 弹窗化

- **`wait_for_user` 重发拦截**：服务端检测到同一 task 已有 pending 还重发 `wait_for_user` → 返 `[PROTOCOL_VIOLATION]` 携带活跃 token、强制 agent 走 `keep_alive_a(token=...)` 续接、不顶替原 entry
- **prompt 反「批量预言 / 自救式重发」**：明确禁止「I will perform N additional tool calls」「Attempt calling wait_for_user again to consolidate state」「已暂停轮询、重新发起 wait_for_user」三类 thinking / message
- **ask_user 改造为弹窗 modal**（用户拍板）：
  - 入参 `question` → `questions[]`、一个 phase 内**只调 1 次 ask_user**、把所有不确定项打包问完
  - UI 用 modal dialog（`ask-user-dialog.tsx`）、不在事件流里 inline、避免被 keep_alive 信息淹没
  - options 自动加 **A/B/C/D 字母前缀**（对标 Cursor `askFollowUpQuestion`）
  - 一次性提交所有答案、不可 dismiss（必须答完）、答案批量 addContextDoc
  - 返回 `[ASK_USER_REPLY]` 头 + `Q1/A1 Q2/A2 ...` 拼接 markdown 给 agent
- **`status=error` 诊断增强**：catch 里 dump `CursorSdkError` 的 `code` / `status` / `requestId` / `endpoint` / `cause` 字段、能拿 requestId 去 Cursor 后台查

#### V0.3.3（2026-05-13）：砍 ship phase + 周边 UX

- **删 ship phase**（提 PR + 同步飞书 story 状态）
  - **砍掉理由 = 注意力管理、不是技术决策**：用户拍板「一个 phase 一个 phase 做扎实、先不让后面的 phase 影响当前焦点」。当时 plan / build 本身的产出还在打磨、ship 自动化（git push / 飞书 MCP）一旦掺进来、踩坑面会同时变大、调试链路变长。先收敛到 `plan → build`、把这两 phase 跑稳之后再考虑后续 phase。
  - ⚠️ **不要再写"砍 ship 因为效果不稳"**——这是早期 commit message 里的错误表述、已统一更正
  - V0.5 起会重新引入"build 之后的 phase"、但形态变了（review、不是 ship）、见下方 V0.5 设计段
- **任务级 MCP 黑名单** `Task.disabledMcpServers`：UI 给每个任务一个开关、settings 加新 MCP 自动对所有任务生效、用户能按任务关掉某些 MCP（黑名单语义而不是白名单）
- **Settings 优化**：模型列表按钮不需要 API key 验证、MCP servers JSON 加 prismjs 高亮
- **AskUserDialog**：「Other」选中时同时显示其它 option（不是切换式）、textarea 移到下方、有底部间距
- **「补意见再跑」按钮**：文案改成更准确的「跟 AI 再聊聊」、对应 dialog 也调整、去掉过度繁琐提示

#### V0.3.4（2026-05-13 ~ 2026-05-14）：context 合进 plan

- **删 context phase、把上下文收集合进 plan phase**：`PhaseId = "plan" | "build"`、phase 序列 = `[plan, build]`
- 合并理由（用户实操后拍板）：分离 context / plan 价值未兑现、用户审 context 时的判断点跟审 plan 时重合、反而多审 1 次、多 ack 1 次、agent 也多写 1 份 artifact。合并后 plan 一气呵成：读上下文 → 扫仓库 → 出方案、用户只审 1 次。
- prompt 同步重写、把原 phase-1-context 内容并入 phase-2-plan
- artifact 结构变成 `artifacts/01-plan.md` + `artifacts/02-build.md`（原 `01-context.md` 概念删除）

#### V0.4（2026-05-15）：多角色 schema + 通用化 + chat 自由化

##### 4.1 多角色 schema

**核心动机**：飞书 story 是「跨角色共享」的——同一条 story 通常涉及前端 / 后端 / 数仓 / 测试 / 移动端、每个研发只关心其中一部分。之前 prompt / UI 把「前端」写死、扩到其他角色得到处改 prompt。

**改造**：

- **`Task.role: TaskRole`**：`types.ts` 加新枚举（当前仅 `"fe"`、未来扩 `be / data / mobile / qa`）+ `TASK_ROLE_LABEL` 中文映射、UI / prompt 统一来源
- **`task-fs.ts`**：`createTask` 默认 `role: "fe"`、`hydrateTask` 老数据兜底 `"fe"`、向后兼容老 task
- **`plan-runner.ts`**：`loadPhasePrompt` 把 `{{role}}` + `{{roleLabel}}` 注入 phase prompt、super-prompt 顶部多加一行「当前角色：xxx」提示
- **`phase-1-plan.md`**：明确「以 `{{roleLabel}}` 视角、为本地仓库出方案」、「只挑跟你这个角色相关的部分做」、列出当前角色 fe 的细化提示
- **`new-task-dialog.tsx`**：新建任务多一个「角色 \*」选择器（当前只有「前端」一项、保留 UI 以信号未来扩展）
- **路线图**：详见 `docs/MULTI-ROLE.md`（含扩 role 的 checklist）

##### 4.2 chat 自由化（用户拍板 2026-05-15）

**核心动机**：之前 chat 模式表单要求填标题 / 仓库 / 首条消息、还要点「启动 Chat」按钮才能进对话——「自由对话」却被表单卡得不自由。

**改造**：

- **表单全选填**：`new-task-dialog.tsx` chat 模式下标题 / 仓库 / 飞书链接 / 描述全可空、不填 `task-fs.createTask` 给默认值（标题占位「未命名对话 MM-DD HH:mm」、仓库默认 `os.homedir()`）
- **删 `/start-chat` 路由**：启动职责合并进 `/chat-reply`、用户在 UI 输入框发首条消息时后端自动 spawn agent
- **首条消息直接 inject prompt**：`chat-runner.buildInitialPrompt(task, skills, firstMessage?)` 加 firstMessage 参数、`runChatSession` 透传、agent 第一次 turn 就回答用户首条、答完才调 `wait_for_user` 进等待
  - 走过的弯路：先做了 `pendingFirstMessage` 队列（agent 起手 wait_for_user → 后端 race 消费）、但 wait_for_user 进来会让 task.status 短暂切 awaiting_user、UI 输入框闪可用、agent 还偏好 emit「正在调用 wait_for_user 等你」之类协议元叙述。直接塞 prompt 一步到位、彻底绕过 race
- **chat 模式也 inject contextDocs**：`buildInitialPrompt` 调 `renderContextDocsSection`、跟 plan 一致。`renderContextDocsSection` / `renderContextDocBody` / `TEXT_INLINE_INJECT_MAX` 从 `plan-runner.ts` 抽到 `src/lib/server/context-docs-prompt.ts`、plan / chat 共用
- **chat 模式详情页打开 ContextDocsPanel**：原本 `!isChatMode && <ContextDocsPanel>` 守卫拿掉、chat 任务也能随时加 / 删上下文

##### 4.3 字段统一：删 feishuUrl

**核心动机**：之前 plan 模式建任务用 `feishuStoryUrl` 字段、chat 模式用 `feishuUrl` 字段、`task-fs.createTask` 又只把 `feishuStoryUrl` 落 contextDocs——chat 模式用户填的「飞书需求文档链接」**两层都没拼进 agent prompt**、agent 看不到。

**改造**：

- 彻底删 `feishuUrl` 字段（`Task` / `NewTaskInput` / `TaskMeta` / API route / plan-runner 模板变量全砍）
- chat 模式表单 label 改「飞书项目链接（选填）」、复用 `feishuStoryUrl` 字段
- `createTask` 不分 mode、`feishuStoryUrl` 有就落「飞书 story」contextDoc

##### 4.4 代码质量大清扫（V0.4 同步做）

- 修 `chat-runner.ts` `buildInitialPrompt`：原本还在教 agent 走 `keep_alive_a/b/c`、chat 模式严重 prompt drift；重写跟 plan-runner 同款 V0.3.5 shell + curl long-poll
- 删 `prompts/phase-1-context.md` / `phase-2-plan.md` / `phase-3-build.md` / `phase-4-ship.md` 老文件（V0.3.4 起不再使用）
- 修 `phase-1-plan.md` / `phase-2-build.md` 内残留的 `keep_alive_a/b/c` 协议描述
- 修 `chat-mcp.ts` `ask_user` 工具 description：返回值从 `[USER_AWAITING]` 改为正确的 `[SHELL_WAIT_GUIDE]` + shell long-poll
- 修 `skills/context-docs-handler/SKILL.md`：4 phase 描述改 2 phase、`01-context.md` 改 `01-plan.md`
- 顶部导航 / metadata 改成「开发流水线」（之前几版叫过「前端需求自动化流水线」「项目级 AI Harness 平台」、用户拍板顶部 UI 用这个最简）
  - ⚠️ **「项目级 AI Harness 平台」仍是项目灵魂**：README.md 开头 / docs 文档都保留这个表述、不要因为顶栏简化就把灵魂去掉。Harness（缰绳）= 用确定性工具压 LLM 非确定性、是这个项目区别于「再造一个 Cursor」的核心命题
- `README.md` 整篇重写到 V0.4
- `DESIGN.md` 顶部 warning 改成完整版本演进表
- `chat-mcp.ts` GLOBAL_KEY bump 到 `__feAiFlowChatStateV6__`（dev 热重载不混入旧 V5 状态）

#### V0.3.5（2026-05-14 ~ 2026-05-15）：保活机制大重构 + race fix

**核心动机**：旧的 `keep_alive_a/b/c` MCP 轮转 + 50s timer 5-6 分钟必踩 anti-loop / SDK 内部超时、用户实测 12 / 15 分钟内必挂。深挖发现：

1. **MCP 工具调用有 60s 硬超时**（SDK 限制、跟模型无关）
2. **shell 工具没硬超时**（实测 `sleep 300` 能跑完、不踩 anti-loop）
3. **模型 bias**：`composer-2` 等模型 5 分钟没看到 stdout 新行就主动 summarize 退出

**新方案：shell + curl long-poll 取代 MCP 轮转**

- `wait_for_user` / `ask_user` MCP 工具**立即返回 shell 引导文本**（不阻塞、不 50s timer）、教 agent 调 `shell` 工具 `curl -sN '<base>/api/tasks/:id/wait-ack?token=…'`
- 新增路由 **`/api/tasks/[id]/wait-ack`**：长 HTTP 连接、`subscribeWaitAck` 拿 pendingMap 里的 promise、服务端 chunked write 每 60 秒一次 keepalive `[KEEPALIVE ts=...]`（普通文本行、防被 SDK shell-output-delta 过滤）、用户 ack 时 resolve promise → 写一行结果 + 关流 → curl exit → agent stdout 拿到结果推进
- **删 `keep_alive_a/b/c` 三件套** + 删 `wait_for_user` 重发拦截 / `[PROTOCOL_VIOLATION]` / 抗 anti-loop prompt 大段
- **prompt 加「钢铁纪律」段**：明确禁 agent 在 shell long-poll 期间 `read` 自己的 terminal 文件 / self-summarize / 提前退出
- wait-ack 路由配置：`runtime = "nodejs"` + `dynamic = "force-dynamic"` + `maxDuration = 3600`（撑 1 小时）
- **手动重连不自动 retry**：`Task.lastAgentId` 持久化（`task-fs.ts: setTaskLastAgentId`）+ 新路由 `/api/tasks/[id]/resume-waiting`：用户连接断了 UI 显示「继续监听」按钮、点了走 `Agent.resume(lastAgentId) + send("[RESUME]…")`、不自动重试（用户决定：避免 agent 反复踩坑、且老套餐 resume 也要 +1 send 配额）

**SDK 升级**：`@cursor/sdk` 1.0.10 → 1.0.13（怀疑修了 transport 重连、实际证明根因是网络、但保留）

**ask_user race fix（2026-05-15）**：

- 原版 `finalizeEntry` 立刻清 `tokenToTask` / `pendingMap`、触发严重 race：
  - agent 调 ask_user → 工具立即返回 SHELL_WAIT_GUIDE、agent 这边还要几秒才发起 shell + curl
  - 用户在 UI 早已看到弹窗、提交答案瞬间 → finalizeEntry 立刻清
  - 几秒后 agent 的 curl 才到 wait-ack 路由 → token 已不在表 → 返回 `[INVALID_TOKEN]` → agent 退 run
- **修复**：`finalizeEntry` resolve promise 后保留 60 秒 grace、晚到的 curl 还能 subscribe 到已 resolved 的 promise 立刻拿结果。`registerPendingEntry` 顶替时立即清旧 entry、不等 grace。新增 `forceCleanupEntry` 工具函数。
- 关键文件：`src/lib/server/chat-mcp.ts` 269-388 行（`GRACE_CLEANUP_MS` / `forceCleanupEntry` / `finalizeEntry` / `registerPendingEntry` / `subscribeWaitAck`）

#### 已知坑（V0.3.5 仍未解决）

- **代理偶发 ECONNRESET**：日志大量出现 `ConnectError: api2.cursor.sh ... Client network socket disconnected before secure TLS connection was established`、用户走科学上网工具 fake-ip 模式（`api2.cursor.sh → 198.18.0.x`）、节点偶发抽风、SDK 当 run error。**代码层无解、用户得换稳定代理节点 / 换协议**
- **dev mode hot reload 杀任务**：`pnpm start` 实际跑 `next dev`（看 `scripts/dev-open.mjs`、不是 prod）、改任何 watch 范围内的源文件就重启 server、跑中的任务被 `boot recovery` 标 failed。建议长任务用 `pnpm build && pnpm start:prod`
- **断线后只能手动「继续监听」**：不自动 retry 是用户决定（计费 + agent 反复踩坑 trade-off）

#### 待验证（用户要测）

- **端到端 demo 验证**：真飞书 story → 走完 plan + build 还没完整跑通一遍
- **V0.3.5 race fix 真实生效**：制造「用户答 ask_user 比 agent 调 curl 快」的极端场景、看 dev terminal 有没有 `[chat-mcp] subscribeWaitAck: ... entry 已 resolved（grace window）` 日志（race 命中 grace 拿到结果）
- **wait-ack 长连接稳定性**：故意不 ack、看能不能撑 5 / 10 / 15 / 30 分钟（无 ConnectError 干扰前提下）

#### 待打磨（未启动）

- **失败恢复**：现在只能「重启 workflow 从头」或「继续监听」、未来要支持「从某个 phase 续跑」（artifact 已落盘可复用）
- **自定义 workflow**：V0.2 写死 `feishu-story-impl`、未来支持多 workflow 注册
- **cost / token dashboard**

---

### V0.5：review phase + 多 phase 模型选择 + plan 校验前移

> **状态：代码已落地（2026-05-18）、V0.5.1 持续打磨中**（详见下面 V0.5.1 段）。用户拍板「先按 A 来进行、写完三 phase 一起测」、本段记录设计 + 落地结果。

#### 动机

V0.3.3 砍掉 ship phase 是注意力管理决策（先把 plan / build 做扎实、不让后面的 phase 影响）、不是「ship 这个方向不对」。现在 plan + build 走得相对稳了、是时候补"编码完成之后"那一段——但形态从 ship（自动 PR / 飞书同步）转向 **review**（拿确定性产物做差值对照）、因为：

1. **ship 的"动作部分"风险高**：git push / 改飞书 story 状态都是不可逆动作、LLM 选错工具就麻烦
2. **ship 的"信息部分"价值高**：commit msg / PR body / 飞书评论草稿用户每次都要写、自动化 ROI 直接
3. **review 是真正的 harness 增量**：拿 `git diff`（确定性产物）跟 `01-plan.md`（确定性约束）做结构化差值、给用户喂 review 弹药、不让 LLM "判断对错"（避开 Cognition 警告的 AI 自审共识盲点）

#### Phase 拓扑变化

```
当前（V0.4）：plan → build
V0.5 起：     plan → build → review
```

review 完成后任务 = `completed`。PR 提交 + 飞书状态回写 **仍然**由用户手动（不重新自动化）、但 review artifact 里会带 commit msg / PR body / 飞书评论草稿、用户复制走。

#### review phase 设计要点

| 维度 | 设计 |
|---|---|
| **输入** | `01-plan.md` + `02-build.md` + `git diff`（本次 build 实际改动） + contextDocs（飞书需求 + 用户补充文档） + 仓库现状 |
| **产出** | `artifacts/03-review.md` |
| **artifact 结构** | 顶部「整体一致性」总评 + 4 类差异表 + 跟飞书需求对照 + 交付信息（commit msg / PR body / 飞书评论草稿） |
| **HITL** | 用户「整体通过」一次性 ack、或对单项 revise（agent 按指示动 build 或 plan） |
| **差异由谁改** | **按差异类型分流**（详见下表）、不做 agent 自动循环修复 |

**4 类差异分流**（用户拍板「先做出来看效果」、表格仅作设计预案、artifact 模板会给最终形态）：

| 差异类型 | 默认建议 | 谁拍板 |
|---|---|---|
| 范围扩张（plan 没列、实际改了） | 更新 plan task 加上、agent 解释为什么必要 | 用户 ack（默认通过） |
| 范围收缩（plan 列了、实际没改） | 从 plan 删 / 加「已无必要」注解 | 用户 ack |
| 实现偏差（plan 描述跟实际改法不一致） | 🚨 标红、必看 | 用户必选：a) 改回 plan b) 接受偏差 + 更新 plan 描述 |
| 未完成（plan task N 没做） | 列原因 | 用户必选：a) 现在补 b) 建 follow-up task c) 接受 |

**坚决不做** "agent 发现差异自己修、再 review 一轮" 这种自动循环（会死循环 / 烧 token、HITL 闸门被绕过）。

#### plan phase 增强：校验前移（防御性、不开新坑）

review phase 兜底的逻辑可能让 plan / 飞书文档的差异留到 review 才发现、循环回 plan 浪费 1 次 ack。所以 V0.5 同步增强 plan：

- plan agent 生成 `01-plan.md` 时、如果发现自己对飞书 story / contextDocs 的理解跟原文有差异（hallucinate / 偏离 / 信息缺失）、必须在 artifact 里写**「我的理解 vs 飞书原文」对照段**
- 用户审 plan 时直接看到差异、当场修正、不留到 review 阶段
- 实现：改 `prompts/phase-1-plan.md`、加一段「自我校验」步骤 + artifact section 模板

#### agent 复用策略（用户拍板：决定权给用户）

```
默认（V0.5 起）：plan → build → review 全程同一 agent（同一 SDK Run、+0 send 配额、上下文连续）
可选：用户在 phase ack 时手动切「换新 agent」、+1 send 配额、reviewer ≠ author
```

**为什么默认同一个 agent**（不是默认强制起新的）：用户老套餐是 500 次请求计费、不是 token 计费、小需求起新 agent 浪费配额。决定权给用户、复杂 / 重要任务用户自己点「换新 agent」。UI 上 phase ack 弹窗加 toggle、默认关闭、关闭时灰色提示「→ 起新 run、+1 send 配额、reviewer ≠ author、更接近真人 code review」。

#### 模型选择策略（用户提议、值得做）

```
settings.defaultModel = 默认模型（所有 phase / 新建任务的初始选中值）
+ 每个 phase ack 时可切模型（默认值 = settings.defaultModel）
+ 切了不同模型 → UI 暗示「下一 phase 必须起新 agent run」（SDK 限制：同一 run 内不能换模型）
```

实现要点：
- settings 加 / 复用 `defaultModel` 字段（已有）
- 新建任务表单、phase ack 弹窗都加 model selector、初始值 = `defaultModel`
- 切了不同模型 → 自动勾上「换新 agent」toggle、不让用户手动两步操作

#### artifact 模板：03-review.md

放在本文档下方「附录 A: 03-review.md artifact 模板示例」段、供 prompt 设计时直接抄。

#### 不做（V0.5 明确止损）

- ❌ 自动 git push / 自动调飞书 MCP 改 story 状态（V0.3.3 砍 ship 的核心规避项、V0.5 不重新拾起）
- ❌ agent 自动循环修复差异（HITL 闸门优先）
- ❌ 默认强制起新 agent run（用户拍板：决定权给用户、500 次套餐计费现实）
- ❌ 给 review 强制配「专用模型」（用户拍板：默认就是 settings 默认模型、不过度设计）
- ❌ review 之后再加 phase（V0.5 收敛到 review、不一次开多个口子）

#### 实施 checklist（2026-05-18 完成、待联测）

| 步骤 | 文件 | 完成状态 |
|---|---|---|
| 1. 加 PhaseId | `src/lib/types.ts` | ✅ `PhaseId = "plan" \| "build" \| "review"` + `WORKFLOWS.feishu-story-impl.phases` 加 review |
| 2. 写 review prompt | `prompts/phase-3-review.md` | ✅ 拿 git diff + plan + build artifact 做差值对照、按 4 类差异分流、产出 commit msg / PR body / 飞书评论草稿、严格只输出文本不动文件 |
| 3. plan 校验前移 | `prompts/phase-1-plan.md` | ✅ 加「§1.1 我的理解 vs 飞书原文（自我校验、V0.5 校验前移）」对照段、硬约束不可省 |
| 4. plan-runner 支持 review | `src/lib/server/plan-runner.ts` | ✅ `PHASE_PROMPT_FILE` 加 review、`planArtifactPath` 模板变量（给 review 读 01-plan.md）、`task-fs.ts` PHASE_ORDER 加 review |
| 5. phase ack 高级选项 UI | `src/components/tasks/approve-phase-dialog.tsx`（V0.5 新增） | ✅ 主按钮「通过」旁齿轮图标打开 dialog、含模型 selector + 「换新 agent」switch、模型切了自动勾上 fork 且不可关 |
| 6. plan-runner 支持 fork 模式 | `src/lib/server/plan-runner.ts` | ✅ `runPlanWorkflow` 加 `fork?: { fromPhase, reason }`、`buildSuperPrompt` 顶部加 fork banner、`markPlanForFork` + `waitForPlanToStop` helper |
| 7. phase-ack 路由支持 fork | `src/app/api/tasks/[id]/phase-ack/route.ts` | ✅ 接收 `forkAgent / nextModel / bootArgs`、fork 路径走 `markPlanForFork → cancelPlan → waitForPlanToStop → markPhaseAcked → runPlanWorkflow(fork=...)` |
| 8. phase 进度条 / 任务列表展示 review | `src/components/tasks/phase-progress.tsx` + `task-card.tsx` + `task-display.ts` | ✅ PHASE_LABEL 加「复核交付」、PHASE_LABEL_EN 加「Review」、动态 phaseOrder 自动渲染 |

#### 关键实现细节（给后续 AI 用）

**fork 流程**：

```text
用户在 phase ack 弹窗勾「换新 agent」/ 切模型 → 前端调 submitPhaseAck(approve, ..., { forkAgent, nextModel, bootArgs })
  → phase-ack route：
    1. markPlanForFork(taskId)  // 让旧 run 收尾时跳过 done 帧、保留 SSE 连接给新 agent
    2. cancelPlan(taskId)       // cancelPending + run.cancel() 让旧 agent 拿到 [CANCELLED] 退出
    3. waitForPlanToStop(taskId, 10000)  // 轮询等 runningPlans delete、防止新 run 被幂等保护拦截
    4. markPhaseAcked(taskId, ackPhase)  // patch 数据库：ackPhase=ack、currentPhase=nextPhase
    5. runPlanWorkflow({ task, model: nextModel, fork: { fromPhase: nextPhase } })
       → Agent.create 新 agent（不是 resume）
       → super-prompt 顶部加 fork banner、列已完成 phase 的 artifact 路径、提示「直接从 fromPhase 开始」
```

**为什么 fork 时不发 done 给 SSE**：watchChatStream 客户端拿到 done 后会停止订阅、UI 看不到新 agent 的事件。`forkPendingTasks` Set 让 cancelled 分支识别「这是 fork、保留 SSE」。新 agent 启动时新 publishChatStreamEvent 接着推、客户端无感切换。

**plan 校验前移的硬约束**：plan agent 必须写「§1.1 我的理解 vs 飞书原文」段、即使没差异也要写「✅ 所有关键点跟 contextDocs 原文一致」。这是为了把跟飞书的差异前置暴露在 plan ack、不留到 review 阶段才发现循环回 plan。

**review phase 唯一允许的写入**：`{{artifactPath}}`（即 `03-review.md`）。任何其它文件都是只读。这是给 review agent 的硬约束、违反 = 本 phase 直接 revise。所以 review **不调动作类 MCP**（不提 PR / 不改飞书状态）、只输出 commit msg / PR body / 飞书评论草稿 / 自测 checklist 文本、让用户复制走。

#### 附录 A：03-review.md artifact 模板示例

````markdown
---
phase: review
status: awaiting_ack
upstream: 01-plan.md, 02-build.md
downstream: (final)
task_id: t_xxx
generated_at: 2026-05-18T10:00:00+08:00
---

# Review · 任务名称

## 一、整体一致性总评

- **plan 实施完整度**：5/7 task 完成（71%）
- **代码改动跟 plan 范围匹配度**：高 / 中 / 低（附理由）
- **跟飞书 story 原始需求一致性**：高 / 中 / 低（附理由）
- **建议结论**：✅ 可交付 / ⚠️ 有偏差需用户决策 / ❌ 实施严重偏离 plan

## 二、差异分类对照

### 2.1 范围扩张（plan 没列、实际改了）

| 文件 | 改动概要 | 为什么必要 | 建议 |
|---|---|---|---|
| `src/lib/foo.ts` | 新增 utility 函数 | task 3 用到、plan 漏列 | 加入 plan task 3 |

### 2.2 范围收缩（plan 列了、实际没改）

| plan task | 原计划 | 实际状况 | 建议 |
|---|---|---|---|
| task 5 | 改 BarComponent.tsx | 实际已是目标形态、无需改 | 从 plan 删 |

### 2.3 🚨 实现偏差（plan 描述跟实际改法不一致、用户必看）

> 这里每条用户必须选一个处理路径、否则 review 不能 ack。

#### 偏差 1：task 2 的状态管理

- **plan 描述**：用 `useState` 维护表单 state
- **实际改法**：改用 `useReducer`
- **原因**：字段联动复杂、useState 写出来要 5 个 setter 互相调
- **用户选择**：
  - a) 改回 useState（agent 会按 plan 改代码）
  - b) 接受偏差、更新 plan 描述

### 2.4 未完成（plan task N 没做）

| plan task | 原计划 | 为什么没做 | 建议 |
|---|---|---|---|
| task 7 | 加单测 | 时间不足 / 仓库无单测惯例 | a) 现在补 b) follow-up task c) 接受 |

## 三、跟飞书需求对照

| 飞书需求项 | 本次是否覆盖 | 实施位置 | 备注 |
|---|---|---|---|
| 用户列表批量导出 | ✅ | `src/pages/users/list.tsx:42-86` | |
| 导出权限校验 | ❌ | (未实施) | plan 漏列、需要补 |

## 四、交付信息（用户复制走）

### 4.1 Commit message 草稿

```
feat(users): 加用户列表批量导出

- 新增 ExportButton 组件、调 /api/users/export
- ...
```

### 4.2 PR title + body 草稿

**标题**：`feat(users): 用户列表批量导出 [STORY-12345]`

**正文**：（agent 按团队 PR template 填）

### 4.3 飞书评论草稿（给 PM / 测试看）

> 用户列表批量导出已完成、已开 PR #xxx。改动范围：xxx。需要测试关注：xxx。

### 4.4 自测 checklist

- [ ] 启动 dev server、访问 /users/list
- [ ] 点「批量导出」按钮、确认弹窗 → 确认下载文件
- [ ] xxx
````

> ⚠️ 这是设计稿、prompt 拿这个当 schema、不要原样让 agent 复制。实际产出 agent 会按真实改动填、4 类差异里有 0 项时整段省略。

---

### V0.5.1：联测中的 prompt / UI 打磨（2026-05-17 ~ 2026-05-18、持续）

> 用户开始走真任务联测、发现一堆 prompt 边缘 case、UI 交互不顺、SDK 工具名错配。本段记录所有 V0.5.1 的修复与决策、给后续 AI 接力用。

#### 1. SDK 1.0.13 工具名修正（影响所有 prompt + skill）

SDK 1.0.13 工具名是 **`read` / `edit` / `write` / `delete` / `shell` / `grep` / `glob` / `task`**——**不是** `read_file` / `edit_file` / `write_file`。早期 prompt 里大量带 `_file` 后缀的写法导致 agent 调失败 / SDK 拒掉、看起来像 agent 在 hallucinate 工具名、实际是我们 prompt 教错了。

- 全量修：`prompts/phase-1-plan.md` / `prompts/phase-2-build.md` / `prompts/phase-3-review.md` / `src/lib/server/plan-runner.ts` / `src/lib/server/chat-runner.ts` / `skills/*/SKILL.md` / UI 文案 / 代码注释 / `docs/DESIGN.md` 全清
- 关键 commit：`b85cfe5`（prompts 主修）+ `fd2ff12`（代码注释 / UI / docs 清扫）

#### 2. revise feedback 不闷头改、永远先 ask_user 复述（D 方案最终态）

**坑**：用户点「补意见」（旧文案「跟 AI 再聊聊」）只随便打了 `111` 或一句模糊话、agent 直接修改 artifact。
**根因**：旧 prompt 教 agent「拿到 `[PHASE_ACK revise] + feedback` 就改 artifact」、agent 不验证理解就动手、用户根本来不及确认。

**最终方案（用户拍板：不分支、永远弹）**：

- 拿到 `[PHASE_ACK revise] + feedback` 后、**无论 feedback 多清晰、永远先调一次 `ask_user`** 跟用户复述自己的理解 + 改动计划。问题文案动态生成（feedback 清晰 vs 模糊 vs 极短分三档文案）
- 这次 `ask_user` 调用 **不计入「写 artifact 初稿阶段最多 1 次 ask_user」限额**（这俩限制此前打架、agent 优先后者直接动 artifact、所以必须分开计）
- agent 在 `tool_call` 触发的 `assistant_message` 里**严禁泄露协议名**（`[PHASE_ACK revise]` / 「反馈过短」/ 「无具体改进意图」这类公文措辞）、必须自然口吻直接跟用户对话

走过的弯路（按时间顺序）：
- `45d9030`：先做 4 步条件 D 方案（feedback 清晰 → 直接改 / 模糊 → ask_user）→ 用户立刻反馈「我打 `111` 也照样改、不要让 agent 判断质量」
- `b281bb3`：修「ask_user 限额冲突」+「协议泄露」两个坑、但还是有条件分支
- `8a5298e`：彻底拆掉分支、改成「永远先弹」最终态

#### 3. resume-waiting 别撒谎说「artifact 已产出」

**坑**：用户 SSE 断线 → 点「继续监听」、agent resume 后说「方案已完成」、但 `artifacts/01-plan.md` 根本没写完（断线时 agent 还在调 `ask_user`）。
**修复**：`src/app/api/tasks/[id]/resume-waiting/route.ts` 用 `fs.stat` 真实读 artifact 文件大小、空 / 不存在 → 拼 `[RESUME_INCOMPLETE]` 给 agent（明示「artifact 没写完、接着写、写完再 wait_for_user」）；有内容 → 拼 `[RESUME_WAITING]`（提示 artifact 已就绪、继续等用户 ack）。
关键 commit：`a37614c`。

#### 4. agent 中间 phase 提前退 run

**坑**：plan ack approve 后、agent 不进 build、直接 emit「workflow 已完成」退 run。
**修复**：`buildSuperPrompt` 加多段强约束 + 阶段转换 banner、`PHASE_ACK approve` 拿到后必须 emit「进入 X phase」+ 调 phase tool、严禁 summarize 收尾。
关键 commit：`002fae2`。

#### 5. artifact-writer skill（渐进式披露、不再靠 prompt 反复教）

**坑**：plan / build / review 三个 prompt 都得反复教 agent「写 artifact 用 `write` 工具、不要 `edit`」、prompt 越来越长、agent 还是踩坑。
**用户拍板**：用 Skills（Anthropic Agent Skills 标准）做渐进式披露——prompt 里只写一句「写 artifact 前先 `read` `artifact-writer` skill」、agent 第一次写之前自己读 skill 看完整规则。

- 新增：`skills/artifact-writer/SKILL.md`（含工具映射 / 路径规则 / 标准动作 / revise 写法 / 排错 / 跨 phase 复用 6 段）
- `plan-runner.ts` super-prompt + 三个 phase prompt 都简化成「按 `artifact-writer` skill 教的方式」一句话引用
- 关键 commit：`12b9496`

**后续观察**：用 `composer-2 fast` 跑测时偶尔仍用 `edit` 创建新 artifact、起初以为 SDK 会拒、加了「edit + 文件不存在」warning。但实测 **SDK 1.0.13 的 `edit` 工具能创建不存在的文件**、warning 是误报、已删（commit `9df5a9f`）。**当前结论：`write` 是推荐、`edit` 也能用、不再硬拦**。

#### 6. UI 演进：ack 区交互来回三次、最终回到 dialog

ack 区怎么暴露「下一 phase 选模型」「换新 agent」、user-DX 反复磨：

| 版本 | 形态 | 用户反馈 |
|---|---|---|
| V0.5（初版） | 「通过」主按钮 + 齿轮图标打开高级选项 dialog | 「太不显眼了、只有个 icon」 |
| `eecbc18` | 行内化：「下一 phase 模型」selector + 「换 agent」按钮 + 「补意见」+ 「通过」并列、按钮顺序「通过」最后 | 「不太规范、按钮高度对不齐」 |
| `ed23ea1` | 两行布局：上行 muted「下一 phase（X）: [model] [fork]」、下行「[补意见] [通过]」、语义分组 | 「按钮在当前 phase、模型针对下一 phase、很别扭」 |
| `4a7a102`（**最终**） | 回到 dialog：「通过 PHASE」按钮直接打开 `ApprovePhaseDialog`、内含模型 selector + fork toggle、文案标题「通过 X → Y」 | 用户拍板：「先把所有逻辑走通、再回来优化交互」 |

`ApprovePhaseDialog` 同步简化：删了 `DialogDescription` / 警告条 / `ApprovePhaseDialogTrigger`、标题加箭头明示「current → next phase」。

#### 7. 任务级模型字段（`Task.model`、新建任务表单加 selector）

**坑**：ack 回到 dialog 后、plan 阶段（第一个 phase）启动前没有 ack 入口、就没法挑模型——只能用 settings 默认。
**修复**：新建任务表单加「模型」字段、默认值 = `settings.defaultModel`、用户可为本任务单独挑别的。

- `src/lib/types.ts`：`Task` / `NewTaskInput` 加 `model?: ModelSelection`
- `src/lib/server/task-fs.ts`：`TaskMeta` 持久化 `model`、`hydrateTask` 读出来、`createTask` 写进 meta.json
- `src/lib/run-args.ts`：`prepareRunArgs` 优先 `task.model`、空时回退 `settings.defaultModel`（老任务无该字段时自动兜底）
- `src/components/tasks/new-task-dialog.tsx`：加 model selector、列表懒加载（已拉过不重复拉、避免每次开弹窗 toast 噪音）、切到非默认模型时下方 amber 提示
- 关键 commit：`43d3e76`

**模型选择全链路**：
```
新建任务表单（默认 settings.defaultModel、可改）
  → task.model 持久化
  → prepareRunArgs 优先取 task.model 启动 plan/build/review agent
  → 每次 phase ack 时 ApprovePhaseDialog 可再切（切了不同 model 自动隐含 fork）
```

#### 8. 弹窗文案统一极简化

用户拍板「所有弹窗的解释性文案去掉、极简就行」：
- `task-mcp-panel.tsx` `DialogDescription`：从「改完下次启动 workflow / chat 时生效…」缩到「选本任务启用哪些 MCP」
- `context-docs-panel.tsx` `DialogDescription` + 字段帮助文案：从「agent 在 phase 启动时会看到清单、按需拉取（URL → 飞书 / fetch；路径 → SDK `read` 工具）」缩到「agent 启动时会看到清单、按需读取」
- 「跟 AI 再聊聊」按钮文案缩为「补意见」（commit `dfab2b2`）

关键 commit：`8759836`（弹窗）+ `dfab2b2`（按钮）。

#### 9. V0.5.1 commit 全景

按时间倒序（看 `git log` 也行）：

```
43d3e76 feat(new-task): 新建任务表单加模型选择
4a7a102 revert(ui): ack 回到 dialog 弹窗（用户拍板：先走通再优化）
9df5a9f fix(observability): 删 edit+不存在文件的 warning 误报
ed23ea1 feat(ui): ack 区分两行布局
0325021 chore(ui): 换 agent toggle 改用 Button + secondary 状态
eecbc18 feat(ui): phase ack 行内化、模型 selector 外置
12b9496 feat(skill): 加 artifact-writer skill、用渐进式披露替代 prompt 反复教
3f0a9f1 fix(prompts+observability): edit 写新 artifact 第三轮压制
8759836 chore(ui): 弹窗解释性文案统一精简
dfab2b2 chore(ui): 「跟 AI 再聊聊」按钮文案缩短为「补意见」
8a5298e fix(prompts): revise feedback 永远弹 ask_user、不再分支判断
b281bb3 fix(prompts): revise 复述确认两处坑：限额冲突 + 协议泄露
45d9030 fix(prompts): revise feedback 闷头改修复（D 方案：先复述 + ask_user 确认）
a37614c fix(resume): 检查 artifact 实际存在性
002fae2 fix(prompts): 防止 agent 在中间 phase approve 后退 run
fd2ff12 chore: 跟随工具名修正、清理代码注释 / UI 文案 / DESIGN.md
b85cfe5 fix(prompts): SDK 1.0.13 工具名修正 edit_file → write / read_file → read
```

#### 10. V0.5.2 文案 + 意图二分（2026-05-18 收尾、答疑入口最终方案）

**演进**：V0.5.1 §10 原本提议方向 A（新加「问 AI」按钮 + 新协议）、但用户最后拍板了**更简单的方向**——直接把「补意见」按钮**改名「再聊聊」**、不加新协议、**让 agent 在 ask_user 复述时自己判断「用户是想改还是想问」**。

**最终交互**：

```
用户点「再聊聊」→ 输入想说的话（想改 / 想问 / 含混都行）
  → 服务端发 [PHASE_ACK revise] + feedback（协议名沿用、不新增）
  → agent 永远先调 ask_user 复述意图、option 给「我想改 / 我想问 / 先答疑再决定 / 我重新说」
  → 用户在弹窗里选 → agent 走 Path A（改）/ B（只答疑）/ C（先答再决定）
    - Path A: edit artifact → 再 wait_for_user
    - Path B: emit assistant_message 答疑、不动 artifact → 再 wait_for_user
    - Path C: 先 B 答疑、再 ask_user 问「还需要改吗」、按答案走 A 或 B
```

**为什么最终选这个而不是 V0.5.1 §10 的方向 A**：
- 用户视角：少一个按钮、文案更友好（「再聊聊」比「问 AI / 补意见」二选一更直白）
- 实施视角：不新加协议、复用 `[PHASE_ACK revise]` 通道、UI 只改一个文案、prompt 改 D-scheme 即可、工作量从 1.5h 降到 0.5h
- 风险：agent 自己判断意图、可能误判（用户说「这块怎么改」可能是问也可能是要求改）→ 用 ask_user 显式让用户拍板这一步、把判断权重新还给用户

**改动文件**：
- `src/app/tasks/[id]/page.tsx`：按钮文案「补意见」→「再聊聊」、Dialog title「对 X 补意见」→「跟 AI 再聊聊 · X」、Textarea placeholder 改成「想改的地方、有疑问、想问问 AI——都行」、button title 同步
- `src/lib/server/plan-runner.ts`：D-scheme §3 改成「Path A/B/C 三分」、步骤 3 拆 3a（改）+ 3b（仅答疑、严禁 `edit`/`write`、用 `read`/`grep`/`glob` 只读查询 OK）、ask_user options 模板改成「我想改 / 我想问 / 先答再决定 / 我重新说」、绝对禁止段加「走 Path B 答疑时偷偷动 artifact」
- `src/lib/server/chat-mcp.ts` / `src/lib/task-store.ts` / `src/app/api/tasks/[id]/phase-ack/route.ts`：文案 / 注释同步「补意见」→「再聊聊」、说明意图二分
- `src/components/tasks/event-stream.tsx`：注释里的「补意见」改「再聊聊」

**协议层不动**：
- `[PHASE_ACK revise]` 协议名保留（不叫 `[USER_QUESTION]`）、避免老 events.jsonl 兼容问题
- 服务端 phase-ack route 接的还是 `action: "revise" | "approve"`、不变
- agent 自由决定要不要动 artifact、不需要服务端区分

**接力 AI 注意**：
- 走 Path B 时 agent **不能调 `edit` / `write` / `delete`**——这是 prompt 里的绝对禁止、违反 = 用户会发现「我只问了一句、artifact 怎么被偷偷改了」
- `read` / `grep` / `glob` 只读查询 OK、答疑时可能需要查代码或 artifact
- 这次 ask_user 调用**不计入「写 artifact 初稿阶段最多 1 次 ask_user」限额**

#### 11. V0.5.2 之后的待办（接力 AI 该接的）

**真任务联测**（用户多次提到、还没完整跑通一遍）：
- 跑 1-2 个真飞书 story、走完 plan → build → review 三 phase
- 测 fork：build ack 时切模型、确认旧 agent 干净退出、新 agent 接管 review
- 测 03-review.md 4 类差异分流的实际效果、按反馈调 review prompt
- 测新建任务模型字段：选非默认模型 → 跑 plan → 看 SDK Run 用的是不是该模型
- **测「再聊聊」意图二分**（V0.5.2 新加）：分别试三种输入
  - 「字段 X 改只读」（明确想改）→ 看 ask_user 弹的是不是「我想改：…」、选「我想改」后是不是真改了 artifact
  - 「为什么这块用 useReducer？」（明确想问）→ 看 ask_user 弹的是不是「想问还是想改」、选「我想问」后是不是只回了答案、artifact 没动
  - 「111」（含混）→ 看 ask_user 是不是给了「我想改 / 我想问 / 重新说」三选项、是不是没瞎改 artifact

**已知 / 容忍的小坑**：

- `composer-2 fast` 偶尔用 `edit` 创建新 artifact（不是 hard fail、SDK 能处理、warning 已删）
- dev hot reload 杀任务（已知、改 watch 范围内文件就触发、长任务建议 `pnpm build && pnpm start:prod`）
- 代理偶发 ECONNRESET（已知、走科学上网 fake-ip 模式节点抽风、靠手动「继续监听」恢复）

---

|---|---|
| Plan workflow 整体逻辑 + super-prompt | `src/lib/server/plan-runner.ts` |
| Chat workflow 整体逻辑 + V0.4 firstMessage 注入 | `src/lib/server/chat-runner.ts` |
| **contextDocs prompt 渲染 helper（V0.4 抽出、plan/chat 共用）** | `src/lib/server/context-docs-prompt.ts` |
| `wait_for_user` / `ask_user` 实现 + pendingMap + grace race fix | `src/lib/server/chat-mcp.ts` |
| **wait-ack 长连接路由（V0.3.5 新加、保活核心）** | `src/app/api/tasks/[id]/wait-ack/route.ts` |
| **resume-waiting 路由（手动重连、Agent.resume）** | `src/app/api/tasks/[id]/resume-waiting/route.ts` |
| **chat-reply 路由（V0.4 合并启动职责）** | `src/app/api/tasks/[id]/chat-reply/route.ts` |
| Phase 状态机怎么 patch / 任务级互斥锁 / 原子写 / `lastAgentId` | `src/lib/server/task-fs.ts:withTaskLock` + `patchPhase` + `markPhaseAcked` + `setTaskLastAgentId` |
| ContextDocsPanel（chat / plan 都用） | `src/components/tasks/context-docs-panel.tsx` |
| ask_user 弹窗（V0.3.2 modal 形态、V0.3.3 微调）| `src/components/tasks/ask-user-dialog.tsx` |
| 事件流（含 ask_user 历史回放）| `src/components/tasks/event-stream.tsx` |
| Chat 视图（V0.4 自由化、无启动按钮） | `src/components/tasks/chat-view.tsx` |
| Plan 模式 UI（含「重启 workflow」/「继续监听」按钮）| `src/app/tasks/[id]/page.tsx` |
| 启动 / phase ack / ask reply / mcp 黑名单 API | `src/app/api/tasks/[id]/start-workflow/route.ts` + `phase-ack/route.ts` + `ask-reply/route.ts` + `route.ts`（PATCH） |
| Plan / build / **review** phase prompt | `prompts/phase-1-plan.md` + `prompts/phase-2-build.md` + `prompts/phase-3-review.md`（V0.5 新增） |
| **phase ack 高级选项 Dialog（V0.5、切模型 + fork agent）** | `src/components/tasks/approve-phase-dialog.tsx` |
| 任务角色 schema + 展示文案（V0.4） | `src/lib/types.ts: TaskRole / TASK_ROLE_LABEL` + `docs/MULTI-ROLE.md` |
| Skills loader | `src/lib/server/skills-loader.ts` |

### 设计变动流程

权威源 = 代码 + 本文件。设计层面变动直接落代码 + 同步更新本文件 V0.x 演进段、不要散落到其它 md 写一份新的。
