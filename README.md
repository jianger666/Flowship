# Flowship

**AI 需求交付平台 · 飞书 story → MR 自动化。**

把「读飞书需求 / 拉关联文档 / 摸代码 / 写技术方案 / 写代码 / 跑校验 / 提 MR / @ 测试」这 80% 的手工活交给 AI，你只在每个关键节点确认一次。名字里的 flow 是需求流转、ship 是交付上线。

- **AI 干活、人把关**：AI 每完成一步（方案 / 代码 / 审查 / 提测）都停下来等你「通过」或「再聊聊」，不会偷偷往下走
- **质量有缰绳**：每一步都有确定性校验兜底（typecheck / lint / git 指纹 / MR 门禁），产出全部落盘、可回看可回退
- **并行不互踩**：每个任务在独立的 git 工作区（worktree）里干活，多任务同时推进、也不占用你自己的工作目录

---

## 安装

从 [Releases](https://github.com/jianger666/fe-ai-flow/releases/latest) 下载对应平台的安装包：

| 平台 | 包 | 安装 |
|---|---|---|
| Windows | `fe-ai-flow-<版本>-win-x64.exe` | 双击安装（装到用户目录、免管理员） |
| mac（M 芯片） | `fe-ai-flow-<版本>-mac-arm64.dmg` | 拖进「应用程序」、**首次右键 →「打开」** 过 Gatekeeper |

装完即用（自带运行时、不需要 node / git 环境）；之后有新版应用内提示、一键自更新，任务数据保留。

## 快速上手

首次打开是一张**就绪清单**，配齐三件事才进看板：

1. **Cursor API Key**：粘贴你的 Key（[这里办一个](https://cursor.com/dashboard/integrations)、`crsr_` 开头）
2. **飞书工具**：一键安装内置的 `lark-cli`（飞书）+ `meegle-cli`（飞书项目），浏览器授权登录即可——不需要自己配任何 MCP
3. **仓库**：选择本地仓库目录（可多仓）；GitLab 地址从仓库 origin 自动推导、只需填一个 PAT

然后按日常节奏用：

- **工作台（首页）**：你的飞书工作项看板，从工作项**一键创建任务**
- **任务详情页**：左边是步骤时间线、中间是产出预览（方案 / 审查报告等）、右边是 AI 干活的实时过程；顶部「通过 / 再聊聊」确认，「推进」选择下一步（写方案 / 写代码 / 审查 / 提测……可切模型、常用模型有快捷位）
- **对话（顶栏胶囊切换）**：不走流程、跟 AI 随便聊；输入 `/` 唤起 skill 菜单，消息可编辑重发
- **能力页**：Action / Skill / MCP 集中管理——skill 可以让 AI 帮你建，MCP 可从 Cursor 一键导入
- **设置页**：连接（API Key / GitLab / 飞书）、偏好（IDE 跳转 / 分支模板 / 快捷键 / 默认模型）、仓库、存储清理

## AI 能替你做的事（action）

一个需求 = 一个任务；任务里每次推进是一个 action，顺序不强制——小改动可以跳过方案直接写代码：

| action | 干什么 |
|---|---|
| `plan` | 拉 story + 关联 PRD、扫仓库、出技术方案、拆工单 |
| `build` | 真改代码 + 跑 typecheck / lint；有方案按工单走、没方案按你的指令改 |
| `review` | 用干净视角把 diff 对着方案和需求复审、结构化报 bug |
| `ship` | 提 MR（多仓）+ 飞书 @ 测试人员 |
| `learn` | 把这单踩过的坑沉淀回业务仓（rules / skills / 名词表） |
| `test` | 验收用例 + 运行时验证（建设中） |

每一步的产出都是一份 markdown 落在本地，换模型、换会话都不丢上下文。

## 配置与数据

所有数据都在**本机**、不出网（服务只监听 127.0.0.1）：

| 内容 | 位置 |
|---|---|
| API Key / GitLab PAT / 模型偏好 / 仓库列表 / MCP | `data/config.json`（桌面端在应用数据目录） |
| 任务数据（事件流 / 产出 / 附件） | `data/tasks/<id>/` |
| Prompt 模板 | `prompts/`（可直接改、保存后下次运行生效） |
| Skill | 应用内置 + 自建（能力页管理、可从 Cursor 导入） |

存储占用可在设置页「存储」查看并清理。

---

## 开发者

```bash
pnpm install
pnpm dev    # http://localhost:8876
```

- 代码改完跑 `pnpm typecheck` + `pnpm lint`
- 发版：`git tag v1.x.y && git push origin v1.x.y`，CI 自动打 win / mac 安装包传 Release
- 本地验证打包：`BUILD_STANDALONE=1 pnpm build` → `node scripts/assemble-electron-server.mjs` → `pnpm electron:dist:test`（产出 FlowshipTest、独立端口 8776 + 独立数据目录）

架构与设计细节看 [docs/HANDOFF.md](./docs/HANDOFF.md)（接力第一文件），历史演进看 [docs/CHANGELOG.md](./docs/CHANGELOG.md)。
