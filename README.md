# fe-ai-flow

**项目级 AI Harness 平台 · 飞书 story → MR 自动化**——站在 Cursor SDK 肩膀上、把「读飞书 / 拉接口文档 / 摸代码 / 写技术方案 / 写代码 / 跑校验 / 提 MR」这 80% 的手工活自动化、用户只在每个 action 边界 ack 一次。

**核心是 Harness（缰绳）**：每个 action 边界都用确定性工具（typecheck / lint / git diff hash / MCP / HITL ack）加固质量、压住 LLM 的非确定性、保证产出可观测、可回退、可复用。UI 上的「任务看板 + action 时间线」是产品形态、底下是「AI 写代码 + harness 保质量」这套工程哲学。

---

## 核心模型：task 容器 + action 历史

V0.6 起从「phase chain（`plan → build → review` 固定顺序）」重构为 **task 容器 + action 历史**：

- **task** = 单个需求的生命周期容器、可多次推进 / 多个 MR、双状态（`repoStatus` 业务状态 + `runStatus` 运行时状态）、终态 `merged` / `abandoned`
- **action** = 单次动作（`plan` / `build` / `review` / `ship` / `test` / `learn`）、任意触发、**不强制顺序**——小改 / 修 bug 可跳过 plan 直接 build

```
新建 task → plan (#1) → ack → build (#2) → ack → review (#3) → ack
        → build (#4) 修 bug → ack → ship (#5) 提 MR → ack → ... → merged
```

每条 action 落一个 artifact：`data/tasks/<id>/actions/<n>-<type>.md`、N 单调递增不复用、按时间正序。

### 6 种 action

| action | 干什么 | 准入条件 | 后置确定性检查 |
|---|---|---|---|
| `plan` ✅ | 拉 story / 关联文档 + 扫仓库 + 出技术方案 + 拆 task | 永远可 | artifact 存在 + 长度 |
| `build` ✅ | 真改代码 + 跑 typecheck/lint；有 plan 按工单走、无 plan 按指令改 | 永远可（plan 可选） | 无（靠 review 兜底） |
| `review` ✅ | git diff × plan × 飞书需求做结构化差值 + fresh peer bug 复审 | 至少 1 个 build | 必备段非空 + git hash 一致 |
| `ship` ✅ | server-side GitLab REST 提 MR（多仓）+ 飞书 @ 测试人员 | 至少 1 个 build + 配 GitLab Host/PAT | MR 覆盖所有仓 + 跳仓有原因 |
| `test` 🚧 | 飞书验收用例 + 运行时验证（蓝图见 ROADMAP） | 至少 1 个 build | 待实现 |
| `learn` 🚧 | merged 后沉淀经验注入 AGENTS.md | `merged` + 整 task 一次 | 待实现 |

---

## 两套 mode：task / chat

新建任务 dialog 顶部 tab 二选一、两套通路完全独立（不共享 runner / prompt / 推进入口）：

| mode | 用途 | UI | 必填 |
|---|---|---|---|
| **task** | 正经需求、走 action 容器 | 三栏（左 action 时间线 + 中 artifact 预览 + 右事件流） | 标题、仓库（多仓）、飞书 story URL；**强制配齐飞书 MCP + 飞书项目 MCP** |
| **chat** | 跟 AI 临时聊（答疑 / 探索 / 思路碰撞、不走完整流程） | 单栏对话（顶部 bar + 事件流 + 输入框、随时可「停止」） | 全选填、空标题自动补「未命名对话 MM-DD HH:mm」 |

> 飞书两个 MCP 是「需求 → MR」全流程命脉（plan 拉 story / build 摸需求 / ship @ 测试人员全靠它）、**task 模式按 url 域名强校验**（`mcp.feishu.cn` + `project.feishu.cn`、不认 key 名）、漏配不让建。chat 模式不依赖、放行。

---

## 关键属性

- **单 SDK Run 永生**：整 task 跑在一个 SDK Run、不一个 action 一个 Run、计费一次。action 间用 `wait_for_user` MCP 阻塞等用户 ack；终结 task 才退出 Run（实测比每 action 起新 Run 省大量扣费）
- **HITL 是底线**：每个 action 边界都要用户 ack（**通过** / **再聊聊**）、不会偷偷往下走
- **双状态**：`repoStatus`（developing / awaiting_test / has_bug / merged / abandoned）+ `runStatus`（idle / running / awaiting_user / error）分两个 badge 显示
- **6 个 Harness 门槛**：action 前置准入 / 后置确定性检查 / 默认值推断 / anti-patterns prompt / cross-action 一致性自检（V0.6.4+）/ placeholder 动态
- **「再聊聊」（revise）**：对 artifact 有意见 / 疑问 → agent 先复述意图再决定（想改就改 artifact、想问就只答疑、严禁偷偷动 artifact）
- **新启 Agent（forceNewAgent）**：推进 dialog 高级选项、默认 false；勾上 cancel 旧 Run + 起新 Agent（换模型 / reviewer ≠ author 场景、耗 +1 send 配额）
- **shell + curl long-poll 保活**：agent 拿到 `wait_for_user` 返回的 shell 引导后调 `shell` 工具 curl 跟服务端长连接、根治旧版 anti-loop
- **Git 分支自动建（多仓 + 模板化）**：build 前 runner 按模板（默认 `feature/{username}/{storyId}-{taskTitle}`、可 per-repo 覆盖）拼分支名、prompt 注入 idempotent checkout 引导；填了「已有工作分支」则复用
- **决定链落 md**：review 提的 bug、用户裁决（改 / 不改 / 延后）写进 review artifact、后续 build 不重复问（换 agent 也读得到）

---

## 快速开始

```bash
pnpm install
pnpm dev
```

打开 http://localhost:8876、按以下顺序操作：

1. **设置页 `/settings`**：
   - **API Key**：粘贴 Cursor API Key（[这里办一个](https://cursor.com/dashboard/integrations)、`crsr_` 开头）
   - **默认模型**：从 SDK 拉的可用模型列表选 + SDK 参数（thinking / context / effort 等）
   - **仓库**：点「选择文件夹」弹原生 dialog 选目录、可多仓
   - **MCP servers**：**只读展示** `~/.cursor/mcp.json`（跟 Cursor 共用配置、fe 不自己维护）、可按任务关掉某些 MCP（黑名单）、失败的可点开看报错日志
2. **主页 `/`**：任务卡片看板、点「新建任务」开始；选 mode（task / chat）
3. **task 详情页**：左 action 时间线 + 中 artifact 预览 + 右事件流；顶部「再聊聊 / 通过」按钮；「推进」按钮开 dialog 选下一个 action + 写指令（可勾「新启 Agent」/ 切模型）
4. **chat 详情页**：底部输入框发消息自动启 agent；running 时可「停止」
5. 不想要的任务可手动归档 / 删除；终态 7 天没动自动归档

---

## 项目结构

```
fe-ai-flow/
├── src/
│   ├── app/
│   │   ├── page.tsx                         # 主页：任务卡片看板（task / chat 共用）
│   │   ├── settings/page.tsx                # 设置：API key / 默认模型 / 仓库 / MCP（只读 Cursor 全局）
│   │   ├── tasks/[id]/page.tsx              # 任务详情、按 task.mode 渲染（task 三栏 / chat 单栏）
│   │   └── api/
│   │       ├── tasks/route.ts               # GET 列表 / POST 新建
│   │       ├── tasks/[id]/advance/          # POST：task 模式推进下一个 action
│   │       ├── tasks/[id]/action-ack/       # POST：action ack（approve / revise）
│   │       ├── tasks/[id]/chat-reply/       # POST：chat 用户回复（兼自动启 agent）
│   │       ├── tasks/[id]/wait-ack/         # GET：shell long-poll 长连接、保活核心
│   │       ├── tasks/[id]/stop/             # POST：停止当前 Run（task / chat 通用）
│   │       └── cursor-mcp/                  # GET：原样读 ~/.cursor/mcp.json + health 探测
│   ├── components/
│   │   ├── ui/                              # shadcn/ui base-nova + LoadingState / EmptyHint / ChoiceButton / MultiSelect
│   │   ├── settings/                        # 设置 Card（含 mcp-card 只读展示 + 健康探测）
│   │   └── tasks/                           # 任务卡片 / 新建对话框 / 事件流 / artifact 面板 / action 时间线 / chat 视图 / 推进 dialog / 再聊聊 dialog
│   ├── hooks/                               # use-dialog / use-settings / use-task-watch（SSE）/ use-mcp-health / use-image-attach
│   └── lib/
│       ├── types.ts                         # V0.6 schema（Task / ActionRecord / RepoStatus / RunStatus / TaskRole）
│       ├── task-store.ts                    # 客户端 fetch + 错误归一（handleJson）
│       ├── task-display.ts                  # 展示常量单一来源（STATUS_LABEL / formatRelative 等）
│       ├── run-args.ts                      # 客户端 SDK run 参数准备（prepareRunArgs）
│       ├── branch-template.ts               # 分支名模板渲染
│       └── server/
│           ├── task-runner.ts               # V0.6 统一 runner（task 模式、单 SDK Run + action 推进）
│           ├── chat-runner.ts               # chat 模式 agent 生命周期
│           ├── chat-mcp.ts                  # 本地 HTTP MCP（wait_for_user / ask_user）
│           ├── action-checks.ts             # action 后置确定性检查
│           ├── gitlab-client.ts             # ship：server-side GitLab REST
│           ├── cursor-config.ts             # 读 ~/.cursor 全局 MCP / rules 注入
│           └── task-fs.ts                   # data/tasks/ 持久化（meta + events + actions/）
├── prompts/
│   ├── _super.md                           # super-prompt 主模板（注入 7 种 action prompt + action history）
│   ├── _shared.md                          # 跨 action 通用 artifact 写法 + 规则
│   └── action-{plan,build,review,ship,test,learn}.md   # 各 action 特有约束（test/learn 是 V0.6.2+ 草稿）
├── skills/                                  # 平台自带 skills（agent 按需 read）
│   └── {artifact-writer,chat-attachments,chat-history-recovery,context-docs-handler}/SKILL.md
├── data/                                    # 任务持久化（git ignore）
│   └── tasks/<taskId>/
│       ├── meta.json                        # 元信息（mode / role / model / repoStatus / runStatus / actions[] / ...）
│       ├── events.jsonl                     # 事件流（追加写、原子写防 race）
│       ├── actions/<n>-<type>.md            # 每条 action 的 artifact
│       └── uploads/                         # chat 上传的图片附件
└── docs/
    ├── HANDOFF.md                           # 接力第一文件（项目定位 + 当前架构快照 + 最近演进）
    ├── CHANGELOG.md                         # 历史演进档案（时间倒序）
    ├── ROADMAP.md                           # 路线图 + 质量保证蓝图
    ├── MULTI-ROLE.md                        # 多角色机制 + 扩 role checklist
    ├── PRODUCT-COMPARISON.md                # 跟 Cursor IDE / Claude Code / 四大质量库横向对比
    ├── DESIGN.md                            # V0.2~V0.5 设计权衡（已 archived）
    └── V0.6-REFACTOR.md                     # V0.6 重构设计意图（已 archived）
```

---

## 配置

| 类型 | 位置 | 说明 |
|---|---|---|
| Cursor API Key | localStorage | 不上传服务器、每用户自配 |
| 默认模型 + 参数 | localStorage | `ModelSelection`、跟 SDK schema 一致 |
| 仓库列表 | localStorage | 走 `/api/fs/*` + `FsPickerDialog` 选目录、可多仓 |
| MCP servers | `~/.cursor/mcp.json` | **跟 Cursor 共用、fe 只读不写**；runtime 自动追加内置 `feAiFlowChat`（提供 `wait_for_user` / `ask_user`） |
| 任务级 MCP 黑名单 | `data/tasks/<id>/meta.json` | 默认全开、按任务关掉某些 MCP |
| Prompt 模板 | `prompts/action-*.md` + `_super.md` / `_shared.md` | 用户可直接改、`fs.readFile` 不缓存、保存后下次跑就生效 |
| 任务数据 | `data/tasks/<id>/` | meta.json + events.jsonl + actions/ 目录 |

### 飞书 MCP（task 模式命脉、强校验）

task 模式按 url 域名强校验这两个、漏配不让建：

- `mcp.feishu.cn`：拉飞书 wiki / docx 关联 PRD（story 通常只指向 wiki、详细需求正文在 wiki 里）
- `project.feishu.cn`：拉 story 详情 / 工作项字段 / 关联文档

---

## 设计哲学

- **HITL 是底线**——所有真生产产品都没敢全自动、action 边界强制人 ack
- **单 SDK Run 跑完全程**——整 task 共享上下文、计费一次；ack 时可手动起新 Agent（reviewer ≠ author 这种场景）
- **所有 LLM 调用打日志 + 产物落盘**——可观测、可回退、`data/tasks/` 全部可 diff
- **能用确定性工具兜的、就不让 LLM 自己判断**——eslint / typecheck / git hash / JSON Schema 优先（客观可证伪 predicate、不走字符串黑名单）
- **不是 multi-agent**——单 agent 跑全程（不是 Cognition 反对的「角色协作」、是 Anthropic 推荐的 prompt chaining）；单 task 多 action 链合法
- **角色驱动而非端驱动**——`task.role` 字段、同一 story 多端建多 task、agent 按角色挑相关部分（详见 `docs/MULTI-ROLE.md`）
- **跟 Cursor 共用配置**——MCP / rules / skills 统一消费 Cursor 全局（`~/.cursor/`）+ 项目（repo `.cursor/`）、fe 只读不写

---

## 下一步

- 优先：跑通真飞书 story → plan → build → review → ship 全流程端到端 demo
- `test` action：运行时验证（飞书验收用例 + 浏览器 QA、蓝图 + 待拍板矛盾见 `docs/ROADMAP.md`）
- `learn` action：merged 后沉淀经验注入 AGENTS.md
- 扩 `task.role` 枚举到后端 / 数仓 / 测试（详见 `docs/MULTI-ROLE.md` checklist）
- cross-action 一致性自检（门槛 5）/ token-cost dashboard

详见 [docs/ROADMAP.md](./docs/ROADMAP.md) + [docs/HANDOFF.md](./docs/HANDOFF.md)（接力第一文件、必读）。
