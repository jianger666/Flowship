# fe-ai-flow Handoff

> 本项目的**完整设计文档**已经移到飞书、以飞书为唯一权威源、本文件不再维护正文。
>
> 任何架构 / 路线图 / 设计原则的讨论、都先看飞书文档：
>
> **[fe-ai-flow 设计（V0.2 草稿）](https://wukongedu.feishu.cn/docx/Ue7Td9mOWoU57cxVctfcLA68nic)**

---

## 给 AI 接力的最小上下文

如果你是接力的 AI、在动手改代码 / 加功能之前**先读上面飞书文档**、它包含：

- 项目定位（站在 Cursor 肩膀上的企业 / 项目级 AI Harness 平台）
- 主场景预演（飞书 story 链接 → PR 的完整 workflow）
- 4 张架构图（用户工作流 / 架构全貌 / phase 状态机 / 飞书链接处理时序）
- 跟 Cursor / Claude Code 的层级关系
- 团队 12 步 Harness 方法论及 fe-ai-flow phase 对应
- 现有代码怎么处理（保留 70% / 重构 20% / 砍掉 10%）
- V0.2 路线图（P0 / P1 / P2 / P3）
- 关键设计原则

## 代码层面要点（不在飞书文档里）

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

- **删 ship phase**（提 PR + 同步飞书 story 状态、效果不稳、改用户手提）
- **任务级 MCP 黑名单** `Task.disabledMcpServers`：UI 给每个任务一个开关、settings 加新 MCP 自动对所有任务生效、用户能按任务关掉某些 MCP（黑名单语义而不是白名单）
- **Settings 优化**：模型列表按钮不需要 API key 验证、MCP servers JSON 加 prismjs 高亮
- **AskUserDialog**：「Other」选中时同时显示其它 option（不是切换式）、textarea 移到下方、有底部间距
- **「补意见再跑」按钮**：文案改成更准确的「跟 AI 再聊聊」、对应 dialog 也调整、去掉过度繁琐提示

#### V0.3.4（2026-05-13 ~ 2026-05-14）：context 合进 plan

- **删 context phase、把上下文收集合进 plan phase**：`PhaseId = "plan" | "build"`、phase 序列 = `[plan, build]`
- 合并理由（用户实操后拍板）：分离 context / plan 价值未兑现、用户审 context 时的判断点跟审 plan 时重合、反而多审 1 次、多 ack 1 次、agent 也多写 1 份 artifact。合并后 plan 一气呵成：读上下文 → 扫仓库 → 出方案、用户只审 1 次。
- prompt 同步重写、把原 phase-1-context 内容并入 phase-2-plan
- artifact 结构变成 `artifacts/01-plan.md` + `artifacts/02-build.md`（原 `01-context.md` 概念删除）

#### V0.4（2026-05-15）：多角色 schema + 通用化

**核心动机**：飞书 story 是「跨角色共享」的——同一条 story 通常涉及前端 / 后端 / 数仓 / 测试 / 移动端、每个研发只关心其中一部分。之前 prompt / UI 把「前端」写死、扩到其他角色得到处改 prompt。

**改造**：

- **`Task.role: TaskRole`**：`types.ts` 加新枚举（当前仅 `"fe"`、未来扩 `be / data / mobile / qa`）+ `TASK_ROLE_LABEL` 中文映射、UI / prompt 统一来源
- **`task-fs.ts`**：`createTask` 默认 `role: "fe"`、`hydrateTask` 老数据兜底 `"fe"`、向后兼容老 task
- **`plan-runner.ts`**：`loadPhasePrompt` 把 `{{role}}` + `{{roleLabel}}` 注入 phase prompt、super-prompt 顶部多加一行「当前角色：xxx」提示
- **`phase-1-plan.md`**：明确「以 `{{roleLabel}}` 视角、为本地仓库出方案」、「只挑跟你这个角色相关的部分做」、列出当前角色 fe 的细化提示
- **`new-task-dialog.tsx`**：新建任务多一个「角色 \*」选择器（当前只有「前端」一项、保留 UI 以信号未来扩展）
- **顶部导航 / metadata**：去掉「前端需求自动化流水线」字眼、改成「项目级 AI Harness · 飞书 story → PR」
- **路线图**：详见 `docs/MULTI-ROLE.md`（含扩 role 的 checklist）

**代码质量大清扫（V0.4 同步做）**：

- 修 `chat-runner.ts` `buildInitialPrompt`：原本还在教 agent 走 `keep_alive_a/b/c`、chat 模式严重 prompt drift；重写跟 plan-runner 同款 V0.3.5 shell + curl long-poll
- 删 `prompts/phase-1-context.md` / `phase-2-plan.md` / `phase-3-build.md` / `phase-4-ship.md` 老文件（V0.3.4 起不再使用）
- 修 `phase-1-plan.md` / `phase-2-build.md` 内残留的 `keep_alive_a/b/c` 协议描述
- 修 `chat-mcp.ts` `ask_user` 工具 description：返回值从 `[USER_AWAITING]` 改为正确的 `[SHELL_WAIT_GUIDE]` + shell long-poll
- 修 `skills/context-docs-handler/SKILL.md`：4 phase 描述改 2 phase、`01-context.md` 改 `01-plan.md`
- `README.md` 整篇重写到 V0.4
- `DESIGN.md` 顶部 warning 改成完整版本演进表

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

### 关键文件速查（V0.3.5 更新）

| 想找 | 看这里 |
|---|---|
| Plan workflow 整体逻辑 + super-prompt | `src/lib/server/plan-runner.ts` |
| Chat workflow 整体逻辑 | `src/lib/server/chat-runner.ts` |
| `wait_for_user` / `ask_user` 实现 + pendingMap + grace race fix | `src/lib/server/chat-mcp.ts` |
| **wait-ack 长连接路由（V0.3.5 新加、保活核心）** | `src/app/api/tasks/[id]/wait-ack/route.ts` |
| **resume-waiting 路由（手动重连、Agent.resume）** | `src/app/api/tasks/[id]/resume-waiting/route.ts` |
| Phase 状态机怎么 patch / 任务级互斥锁 / 原子写 / `lastAgentId` | `src/lib/server/task-fs.ts:withTaskLock` + `patchPhase` + `markPhaseAcked` + `setTaskLastAgentId` |
| ContextDocsPanel | `src/components/tasks/context-docs-panel.tsx` |
| ask_user 弹窗（V0.3.2 modal 形态、V0.3.3 微调）| `src/components/tasks/ask-user-dialog.tsx` |
| 事件流（含 ask_user 历史回放）| `src/components/tasks/event-stream.tsx` |
| Plan 模式 UI（含「重启 workflow」/「继续监听」按钮）| `src/app/tasks/[id]/page.tsx` |
| 启动 / phase ack / ask reply / mcp 黑名单 API | `src/app/api/tasks/[id]/start-workflow/route.ts` + `phase-ack/route.ts` + `ask-reply/route.ts` + `route.ts`（PATCH） |
| Plan / build phase prompt（V0.3.4 合并版） | `prompts/phase-1-plan.md` + `prompts/phase-2-build.md` |
| 任务角色 schema + 展示文案（V0.4） | `src/lib/types.ts: TaskRole / TASK_ROLE_LABEL` + `docs/MULTI-ROLE.md` |
| Skills loader | `src/lib/server/skills-loader.ts` |

### 飞书文档同步

如果飞书文档有更新、应当：
1. 在本仓库改架构 / 加功能时、读最新飞书文档
2. 不要把飞书文档内容复制粘贴到 docs/ 下任何 md 文件（**单一权威源**）
3. 设计层面变动 → 先在飞书文档讨论 + 修改、再落代码
