# fe-ai-flow

**项目级 AI Harness 平台 · 飞书 story → PR 自动化**——站在 Cursor SDK 肩膀上、把「读飞书 / 拉接口文档 / 摸代码 / 写技术方案 / 写代码 / 跑校验」这 80% 的手工活自动化、用户只在每个 phase 边界 ack 一次。

**核心是 Harness（缰绳）**：每个 phase 边界都用确定性工具（typecheck / lint / hooks / Skills / MCP / HITL ack）加固质量、用 12 步 harness 方法论压住 LLM 的非确定性、保证产出可观测、可回退、可复用。UI 上的「开发流水线」是产品形态、底下是「AI 写代码 + harness 保质量」这套工程哲学。

**V0.5 / V0.5.1 当前能力**：

- **plan 模式（推荐）**：粘飞书 story 链接 + 选角色（当前仅前端、未来扩后端 / 数仓 / 测试…）+ 选模型（默认 = 设置页默认模型）→ `plan → build → review` 3 phase workflow 自动跑、每个 phase 边界你 ack 才推进、ack 时可切模型 / 换新 agent
- **chat 模式（V0.4 起自由化）**：表单全选填、进任务后底部输入框直接发消息自动启 agent；长会话、一次 SDK Run 跑到底、agent 用 `wait_for_user` MCP 反复阻塞等用户下一句、维持单次扣费

**主流程**：

```
[飞书 story URL + 仓库 + 角色 + 模型]
       ▼
  ┌─────────────────┐
  │ Phase 1: plan   │ 拉 story / 关联文档 + 扫仓库 + 出技术方案 + 拆 task + 校验前移段
  └─────────────────┘ → artifacts/01-plan.md（决策表 + 改动范围 + Task 拆分 + 我的理解 vs 飞书原文）
       ▼ 用户 ack（可切模型 / 换新 agent）
  ┌─────────────────┐
  │ Phase 2: build  │ 按 task 顺序真改代码 + 跑 lint/typecheck/build
  └─────────────────┘ → artifacts/02-build.md（实施日志 + 校验结果）
       ▼ 用户 ack（可切模型 / 换新 agent）
  ┌─────────────────┐
  │ Phase 3: review │ git diff × 01-plan.md × 02-build.md × 飞书原文做结构化差值、产出交付信息
  └─────────────────┘ → artifacts/03-review.md（4 类差异 + commit msg / PR body / 飞书评论草稿）
       ▼ 用户 ack
  [completed]（PR 提交 + 飞书状态回写仍由用户手动复制 review artifact 走、V0.3.3 砍了 ship phase）
```

详细架构 / 决策见 [docs/HANDOFF.md](./docs/HANDOFF.md)（V0.5 / V0.5.1 段最新）+ [docs/DESIGN.md](./docs/DESIGN.md) + [docs/MULTI-ROLE.md](./docs/MULTI-ROLE.md)（V0.4 多角色路线图）。

---

## 关键属性

- **一次 SDK Run 跑完全程**：3 phase 默认共享一个 agent / 一个 SDK Run、计费一次（用户在 ack 时可手动 fork 起新 agent、+1 send 配额）
- **HITL 是底线**：每个 phase 边界都要用户 ack、不会偷偷往下走
- **「再聊聊」意图二分**（V0.5.2、想改 / 想问都走这里）：用户点「再聊聊」→ agent **永远先弹 `ask_user`** 让你选「我想改 / 我想问 / 先答再决定」→ 想改就改 artifact、想问就只答疑（**严禁偷偷动 artifact**）、含混就再问一轮
- **per-phase 模型选择 + agent fork（V0.5）**：新建任务表单挑模型、每 phase ack 时还能再切；切了模型 → 自动隐含起新 agent run（SDK 限制：同 run 不能换模型）
- **artifact-writer skill 渐进式披露（V0.5.1）**：写 artifact 用 `write` / 修 artifact 用 `edit`、规则集中放在 `skills/artifact-writer/SKILL.md`、agent 自己 read 查阅、prompt 不再反复教
- **shell + curl long-poll 保活（V0.3.5）**：agent 拿到 wait_for_user 返回的 shell 引导后调 `shell` 工具 curl 跟服务端长连接、根治旧版 5-6 分钟必踩 anti-loop 的问题
- **断线手动续接**：长连接断了、UI 显示「继续监听」按钮、用户决定何时花 1 次 send 配额重连（`Agent.resume`）；resume 时 `fs.stat` 真实检查 artifact、防 agent 撒谎说「已产出」
- **失败可恢复**：artifact 保留、点「重启 workflow」可从头跑（agent 会看到已有 artifact、大概率跳过已 ack 的 phase）

---

## 快速开始

```bash
pnpm install
pnpm dev
```

打开 http://localhost:8876、按以下顺序操作：

1. **设置页 `/settings`**：四张 Card（每张独立保存）
   - **API Key**：粘贴 Cursor API Key（[这里办一个](https://cursor.com/dashboard/integrations)、`crsr_` 开头）
   - **默认模型**：从 SDK 拉的可用模型列表选 + SDK 参数（thinking / context / effort 等）
   - **仓库**：点「选择文件夹」弹原生 dialog 选目录、自动填仓库名
   - **MCP servers**：JSON 编辑器、自由配（建议至少配 `feishu-project-mcp` + `feishu-mcp`、plan 模式拉 story / wiki 要用）
2. **主页 `/`**：任务卡片看板、点「新建任务」开始
3. 新建任务时选 **mode**：
   - **plan**（默认、推荐）：粘飞书 story + 选角色 + 选仓库 + 选模型（默认 = 设置页默认模型）、自动跑 `plan → build → review`
   - **chat**（V0.4 起全选填）：可只输入飞书项目链接 / 仓库 / 标题、不绑仓库默认 `~`、进任务后底部输入框发首条消息自动启 agent；`completed` / `failed` 状态再发消息自动重启新一段 SDK Run
4. plan 任务详情页：左侧 artifact 预览（按 phase 切换）、右侧事件流、顶部「再聊聊 / 通过 PHASE」按钮；点「再聊聊」弹 dialog 输入意见 / 疑问（agent 会先复述意图、想改就改、想问就只答）；点「通过 PHASE」弹 dialog、可挑下一 phase 用的模型 / 勾「换新 agent」
5. 不想要的任务可手动归档 / 删除；completed/failed 7 天没动会自动归档

---

## 项目结构（V0.5.1）

```
fe-ai-flow/
├── src/
│   ├── app/
│   │   ├── layout.tsx                       # 强制 dark + Providers + Toaster + 顶部导航
│   │   ├── page.tsx                         # 主页：任务卡片看板（plan / chat 共用）
│   │   ├── globals.css                      # Tailwind 4 + shadcn oklch 变量
│   │   ├── settings/page.tsx                # 4 张 Card：API key / 默认模型 / 仓库 / MCP servers
│   │   ├── tasks/[id]/page.tsx              # 任务详情、按 task.mode 渲染（plan workflow / chat 整页）
│   │   └── api/
│   │       ├── models/route.ts              # POST：代理 Cursor.models.list
│   │       ├── fs/*                          # GET：列目录 / 拿用户 home（FsPickerDialog 用）
│   │       ├── tasks/route.ts               # GET 列表 / POST 新建（mode + workflowId + role + feishuStoryUrl）
│   │       ├── tasks/[id]/route.ts          # GET / PATCH / DELETE
│   │       ├── tasks/[id]/events/           # GET：events SSE 增量
│   │       ├── tasks/[id]/start-workflow/   # POST：spawn plan workflow agent
│   │       ├── tasks/[id]/watch-chat/       # GET：SSE 订阅（chat / plan 共用、replay + 增量）
│   │       ├── tasks/[id]/chat-reply/       # POST：chat 用户回复（V0.4 起兼具自动启 agent 职责）
│   │       ├── tasks/[id]/phase-ack/        # POST：plan 用户 phase ack（approve / revise）
│   │       ├── tasks/[id]/ask-reply/        # POST：ask_user 弹窗答复
│   │       ├── tasks/[id]/wait-ack/         # GET：V0.3.5 shell long-poll 长连接、保活核心
│   │       ├── tasks/[id]/resume-waiting/   # POST：手动「继续监听」走 Agent.resume
│   │       ├── tasks/[id]/context-docs/     # POST / DELETE：任务上下文文档面板
│   │       └── mcp/chat-tool/route.ts       # 本地 HTTP MCP server、暴露 wait_for_user / ask_user
│   ├── components/
│   │   ├── providers.tsx                    # next-themes 强制 dark + DialogProvider
│   │   ├── ui/                              # shadcn/ui base-nova 组件 + LoadingState / EmptyHint / ChoiceButton
│   │   ├── settings/                        # 4 张设置 Card
│   │   └── tasks/                           # 任务卡片 / 新建对话框 / 事件流 / artifact 面板 / phase 进度 / chat 视图 / ask_user 弹窗 / context-docs 面板 / approve-phase-dialog（V0.5：phase ack 高级选项、含模型 / fork toggle）
│   ├── hooks/
│   │   ├── use-dialog.tsx                   # 全局 confirm / prompt（取代 window.alert 等）
│   │   ├── use-settings.ts                  # localStorage 设置读写
│   │   └── use-task-watch.ts                # SSE 订阅 hook（plan / chat 共用）
│   └── lib/
│       ├── types.ts                         # Task / TaskMode / TaskRole / PhaseId / WorkflowId / WORKFLOWS 注册表（V0.5：PhaseId 加 review、V0.5.1：Task 加 model 字段）
│       ├── local-store.ts                   # localStorage 读写 + 默认值（DEFAULT_SETTINGS / DEFAULT_MCP_JSON 单一来源）
│       ├── task-store.ts                    # 客户端：fetchTasks / createTask / startWorkflow / submitPhaseAck / submitAskReply / watchChatStream
│       ├── task-display.ts                  # 任务展示常量（PHASE_LABEL / STATUS_LABEL / STATUS_VARIANT / formatRelative）单一来源
│       ├── run-args.ts                      # 客户端启动 SDK run 参数准备（V0.5.1：优先 task.model、回退 settings.defaultModel）
│       └── server/
│           ├── task-fs.ts                   # 服务端：data/tasks/ 持久化（meta.json + events.jsonl + artifacts/、含原子写 + 任务级互斥锁 + V0.5.1 持久化 task.model）
│           ├── plan-runner.ts               # plan workflow runner：单 SDK Run 跑 3 phase + super-prompt 注入 task.role + V0.5 fork 模式
│           ├── chat-runner.ts               # chat 模式 agent 生命周期 + V0.4 firstMessage 注入 + publish/subscribe（plan 共用）
│           ├── chat-mcp.ts                  # 本地 HTTP MCP（wait_for_user / ask_user、V0.3.5 race fix + grace 60s）
│           ├── context-docs-prompt.ts      # contextDocs prompt 渲染 helper（V0.4 抽出、plan / chat 共用）
│           └── skills-loader.ts             # 自定义 SKILL.md 加载器
├── prompts/
│   ├── phase-1-plan.md                      # Phase 1 prompt 模板（V0.3.4 起：context + plan 合并、V0.5 加「我的理解 vs 飞书原文」校验前移段）
│   ├── phase-2-build.md                     # Phase 2 prompt 模板（编码实现 + 校验）
│   └── phase-3-review.md                    # Phase 3 prompt 模板（V0.5 新增：git diff 结构化差值 + 4 类差异 + 交付信息）
├── skills/                                  # fe-ai-flow 自带 skills（agent 按需 read、Anthropic Agent Skills 标准）
│   ├── artifact-writer/SKILL.md             # V0.5.1：写 artifact 渐进式披露（write vs edit / 路径规则 / 排错）
│   ├── chat-attachments/SKILL.md
│   ├── chat-history-recovery/SKILL.md
│   └── context-docs-handler/SKILL.md
├── data/                                    # 任务持久化（git ignore）
│   └── tasks/<taskId>/
│       ├── meta.json                        # 任务元信息（mode / workflowId / role / model / phases 状态 / lastAgentId / ...）
│       ├── events.jsonl                     # 事件流（追加写、原子写防 race）
│       ├── artifacts/                       # phase artifact
│       │   ├── 01-plan.md
│       │   ├── 02-build.md
│       │   └── 03-review.md                 # V0.5 新增
│       └── uploads/                         # chat 用户上传的图片附件
└── docs/
    ├── HANDOFF.md                           # 给新对话 AI 的 onboarding 文档（必读）
    ├── DESIGN.md                            # 关键设计决策
    ├── ROADMAP.md                           # 路线图 + 已完成里程碑
    ├── MULTI-ROLE.md                        # V0.4 多角色机制 + 扩 enum checklist
    └── PRODUCT-COMPARISON.md                # 跟 Cursor IDE / Claude Code 横向对比
```

---

## 配置

| 类型 | 位置 | 说明 |
|---|---|---|
| Cursor API Key | localStorage | 不上传服务器、每用户自配 |
| 默认模型 + 参数 | localStorage | `ModelSelection`（id + 参数数组）、跟 SDK schema 一致 |
| 仓库列表 | localStorage | 默认空、走 `/api/fs/*` + `FsPickerDialog` 选目录 |
| MCP servers | localStorage | JSON 编辑器、自由配；runtime 自动追加内置 `feAiFlowChat`（提供 `wait_for_user` / `ask_user` 工具） |
| 任务级 MCP 黑名单 | `data/tasks/<id>/meta.json` | 默认全开、按任务关掉某些 MCP（不需要 figma-mcp 的任务可关） |
| Prompt 模板 | `prompts/phase-*.md` | 3 个 phase 各一份（plan / build / review）、用户可直接改、`fs.readFile` 不缓存、保存后下次跑就生效 |
| 任务数据 | `data/tasks/<id>/` | meta.json + events.jsonl + artifacts/ 目录 |

### MCP 推荐配置（plan 模式效果取决于此）

```json
{
  "mcpServers": {
    "feishu-project-mcp": { "command": "...", "args": ["..."] },
    "feishu-mcp": { "command": "...", "args": ["..."] }
  }
}
```

- `feishu-project-mcp`：plan phase 拉 story 详情 / 工作项字段 / 关联文档
- `feishu-mcp`：拉飞书 wiki / docx 关联 PRD（story 通常只指向 wiki、详细需求正文在 wiki 里）

没配也能跑、agent 会自己降级（如让用户手工补充上下文）。

---

## 设计哲学

参见 [docs/DESIGN.md](./docs/DESIGN.md)：

- **HITL 是底线**——所有真生产产品都没敢全自动、phase 边界强制人 ack
- **一次 SDK Run 跑完全程**——3 phase 默认共享上下文、计费一次（实测比每 phase 起新 Run 省 ~75% 扣费）；ack 时可手动 fork 起新 agent（reviewer ≠ author 这种场景）
- **所有 LLM 调用打日志 + 产物落盘**——可观测、可回退、`data/tasks/` 全部可 diff
- **能用确定性工具兜的、就不让 LLM 自己判断**——eslint / typecheck / JSON Schema 优先
- **不是 multi-agent**——单 agent 跑全程（不是 Cognition 反对的「角色协作」、是 Anthropic 推荐的 prompt chaining）
- **shell + curl 取代 MCP 轮转保活**——V0.3.5 实测根治 anti-loop（详见 `docs/HANDOFF.md` V0.3.5 段）
- **角色驱动而非端驱动**——V0.4 引入 `task.role` 字段、同一 story 多端建多 task、agent 按角色挑相关部分（详见 `docs/MULTI-ROLE.md`）

---

## 下一步

- 优先：跑通真飞书 story → plan → build → review 全流程的端到端 demo（V0.5 / V0.5.1 / V0.5.2 联测）
- 待启动：扩 `task.role` 枚举到后端 / 数仓 / 测试（详见 `docs/MULTI-ROLE.md` checklist）
- 待启动：phase 内部部分失败恢复（从某个 phase 续跑、不要从头）
- 待启动：用户自定义 workflow（V0.2 写死 `feishu-story-impl`、未来支持多 workflow 注册）
- 待启动：token / cost dashboard

详见 [docs/ROADMAP.md](./docs/ROADMAP.md)。
