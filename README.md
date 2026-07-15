# Flowship

**AI 需求交付平台 · 飞书 story → MR。**

站在 Cursor SDK 上的项目级 Harness：把读需求、摸代码、出方案、改代码、复核、提测这 80% 手工活交给 AI，你在关键节点推进或纠正。名字里的 flow 是需求流转、ship 是交付。

## 核心能力

- **Task 容器 + Action 历史**：一个需求 = 一个任务；任务里每次推进是一次 action（`plan` / `build` / `review` / `ship` / `dev`，另可自定义），顺序不强制——小改动可以跳过方案直接写代码。产出落盘为 markdown，可回看。
- **人在环（HITL）**：AI 交卷后停下等你；「推进」即认可当前步并开下一步，「再聊聊」可改 artifact。不会自动串跑全流程。
- **Worktree 隔离**：默认每个任务独立 git 工作区，多任务并行、不占用你日常工作目录。
- **飞书看板 / 工作项**：首页是飞书排期看板；从工作项一键建任务，拉 story 与关联文档。
- **对话模式**：侧栏可新建自由对话（不走 action 链），输入 `/` 唤起 skill。

后置检查只验**交付诚实性**（artifact 必备段、review 只读指纹、MR 验真等），不替你跑项目 typecheck / lint。代码质量由 build agent 按仓库命令做增量校验，再靠 review 与人工兜底。

## 安装

从 [Releases](https://github.com/jianger666/fe-ai-flow/releases/latest) 下载对应平台安装包：

| 平台 | 包 | 安装 |
|---|---|---|
| Windows | `fe-ai-flow-*-win-x64.exe` | 双击安装（用户目录、免管理员） |
| mac（Apple Silicon） | `fe-ai-flow-*-mac-arm64.dmg` | 拖进「应用程序」；首次右键 →「打开」过 Gatekeeper |
| mac（Intel） | `fe-ai-flow-*-mac-x64.dmg` | 同上 |

**环境要求（桌面安装包）**

- 自带 Node 运行时（Electron），**不必**本机再装 Node
- **需要系统已安装 Git**（PATH 可用）——建分支、worktree、提 MR 都依赖本机 git
- 之后有新版会应用内提示、可一键自更新；任务数据保留在本机应用数据目录

## 首次配置

打开后若未配齐，首页会显示就绪清单（五项都完成后自动变成飞书排期看板）：

1. **Cursor API Key** — AI 跑任务的凭据（[申请](https://cursor.com/dashboard/integrations)，`crsr_` 开头）
2. **飞书工具** — 安装并登录内置 `lark-cli` + `meegle-cli`（设置页一键，无需自配 MCP）
3. **GitLab Token** — 提 MR 用的 PAT
4. **代码仓库** — 至少添加一个本地仓库目录
5. **我的角色** — 设置页「我的角色」，告诉 AI 你的工作视角 / 身份（注入发起人信息；**不是**任务级角色）

配好后按日常节奏用：侧栏切任务 / 对话；任务详情里推进选 action、看产出与事件流；能力页管理 Action / Skill / MCP；设置页管连接、偏好、仓库与存储。

## AI 能替你做的事（action）

| action | 干什么 |
|---|---|
| `plan` | 拉 story + 关联文档、扫仓库、出技术方案、拆工单（大需求可分批） |
| `build` | 在 worktree 里改代码；有方案按工单 / 批次走 |
| `review` | 干净视角对照方案与需求复审、结构化报 bug |
| `ship` | 推改动、提 MR（多仓）到测试分支，并可飞书 @ 测试 |
| `dev` | 联调：合入 / 直推或提 PR 到开发分支 |
| 自定义 | 在能力页把 skill 挂成自定义 action，按你的流程扩展 |

## 数据与网络边界

- **本地持久化**：配置、任务事件流、artifact、附件都在本机（桌面端在应用数据目录）；服务只监听 loopback（`127.0.0.1`）
- **会出网的部分**（按你配置）：Cursor 模型 API（用户输入与仓库上下文会发给模型）、飞书 / 飞书项目（Meegle）、GitLab（MR / 仓库操作）、GitHub（检查应用更新）
- Prompt 模板在 `prompts/`，可改；Skill 可在能力页自建或从 Cursor 导入

存储占用可在设置页「存储」查看并清理。

## 本地开发

需要本机 **Node（pnpm）+ Git**：

```bash
pnpm install
pnpm dev          # http://127.0.0.1:8876
pnpm typecheck
pnpm lint
pnpm test
```

本地打 test 包验证（独立端口 8776 + 独立数据目录）：

```bash
BUILD_STANDALONE=1 pnpm build
node scripts/assemble-electron-server.mjs
pnpm electron:dist:test
```

发版：打 tag 推到 GitHub，CI 打 win / mac 安装包到 Release。

架构与设计细节见 [docs/HANDOFF.md](./docs/HANDOFF.md)；历史演进见 [docs/CHANGELOG.md](./docs/CHANGELOG.md)。
