# fe-ai-flow Handoff

> **权威源**：代码 + 本文件。其余 docs/*.md 为辅助、有冲突以代码 + 本文件为准。

## 项目定位（一句话）

站在 Cursor SDK 肩膀上的**项目级 AI Harness 平台 · 飞书 story → MR 自动化**。核心是 Harness（缰绳）：每个 action 边界用确定性工具（typecheck / lint / git diff hash / HITL ack）压住 LLM 非确定性、保证产出可观测、可回退、可复用。

## 给 AI 接力的最小上下文

按顺序读：

1. `.cursor/rules/project-context.mdc` —— 强制约束
2. `.cursor/rules/learned-conventions.mdc` —— 编码风格
3. 本文件「当前架构快照」段（V0.6 系列、稳定架构）+「最近演进」段
4. `prompts/_super.md` —— super-prompt 主模板（V0.6 改造、注入 7 种 action prompt + action history）
5. `prompts/_shared.md` —— 跨 action 通用 artifact 写法 + 跨 action 规则
6. `prompts/action-plan.md` / `action-build.md` / `action-review.md` / `action-ship.md` —— V0.6.1 已实装 action 的特有约束（test/learn 是 stub、待 V0.6.2+）
7. `src/lib/server/task-runner.ts` —— V0.6 统一 runner（V0.5 plan-runner + chat-runner 合一）
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

### Task 容器 + Action 历史模型

V0.5 phase chain（`plan → build → review`、固定顺序）已废弃、改为 **task 容器 + action 历史**：

- **task** = 单个需求生命周期容器、多 MR / 多次推进、终态 `merged` / `abandoned`
- **action** = 单次动作（plan / build / review / ship / test / learn）、任意触发、不强制顺序

```
新建 task → 推进 plan (#1) → ack → 推进 build (#2) → ack → 推进 review (#3) → ack
        → 推进 build (#4) 修 bug → ack → 推进 review (#5) → ack → ... → 终结 merged
```

每条 action 落一个 artifact：`data/tasks/<id>/actions/<n>-<type>.md`、N 单调递增不复用、按时间正序。

### 两套 task mode：task / chat

`Task.mode` 区分两种使用形态、入口都是首页「新建任务」dialog 顶部 tab：

| mode | 用途 | UI | runner | 必填字段 |
|---|---|---|---|---|
| `task` | 正经需求、走 action 容器 | 三栏 ResizablePanelGroup（左 timeline + 中 artifact + 右 event stream） | `task-runner.ts` + `_super.md` 注入 7 action prompt | title、repoPaths、feishuStoryUrl |
| `chat` | 跟 AI 临时聊（答疑 / 探索 / 思路碰撞、不走完整流程） | 单栏 `ChatView`（顶部 bar + event stream + 输入框） | `chat-runner.ts` + 极简 prompt（只装 wait_for_user + shell long-poll） | 全选填、空 title 自动补「未命名对话 MM-DD HH:mm」 |

两套通路完全独立、不共享 runner / prompt / 推进 dialog / advance API。chat 模式 task 入 `/api/tasks/[id]/chat-reply`、task 模式 task 入 `/api/tasks/[id]/advance` + `/action-ack`。`advance` route 防御性 reject `task.mode === "chat"` 的请求。

### 双状态：repoStatus + runStatus

V0.5 单 `status` 字段（draft / running / awaiting_user / completed / failed）拆成两个独立维度：

| 字段 | 含义 | 取值 |
|---|---|---|
| `repoStatus` | 任务对仓库的业务状态 | `developing` / `awaiting_test` / `has_bug` / `merged` / `abandoned` |
| `runStatus` | agent 运行时状态 | `idle` / `running` / `awaiting_user` / `error` |

UI 卡片 / 详情页头部分两个 badge 显示。

### V0.6.1 已实装 vs stub

仅 `task.mode === "task"` 走下表的 action 体系；`chat` 模式独立通路、不在此表。

| Action | 状态 | 准入条件 | 后置 deterministic check |
|---|---|---|---|
| plan | ✅ 已实装 | 永远可 | artifact 存在 + 内容长度 >= 100 |
| build | ✅ 已实装 | 至少 1 个 plan completed | `pnpm typecheck` + `pnpm lint` + git status 有改动 |
| review | ✅ 已实装 | 至少 1 个 build completed | 4 类差异段非空 + git hash 一致 |
| ship | ✅ 已实装 | 至少 1 个 build + settings 配 GitLab Host + PAT | `task.mrs[]` 覆盖所有 repoPath（URL 非空） + 跳仓有原因 |
| test | 🚧 V0.6.2 | 至少 1 个 build | （未实现） |
| learn | 🚧 V0.6.3 | `repoStatus = merged` + 整 task 只跑一次 | （未实现） |

stub action 的 prompt 文件存在（V0.6.2+ 设计草稿）、UI 推进 dialog 灰掉、runner 准入拒绝。

### 单 SDK Run 永生

整 task 跑在**同一个 SDK Run** 里、不一个 action 一个 Run：

- 用户每次「推进」action → runner 写 `[NEXT_ACTION ...]` 给 agent
- agent 跑完 action → 调 `wait_for_user(action_id)` → runner 把 action 标 `awaiting_ack` + 跑后置检查
- 用户 ack → wait-ack 写 `[ACTION_ACK approve|revise]` → agent 接着调 `wait_for_user(待命态)` 等下一指令
- 终结 task → finalize 路由写 `[TASK_DONE]` / `[TASK_ABANDONED]` → agent 自然退出 Run

agent 永远不会主动 emit assistant_message + exit Run、只通过 wait_for_user 把控制权交回用户。

### 保活机制：shell + curl long-poll（V0.3.5 沿用）

```
agent 调 wait_for_user / ask_user
  → MCP 工具立即返回 shell 引导文本
  → agent 用 SDK shell 工具调 curl -sN <base>/api/tasks/:id/wait-ack?token=…
  → 长 HTTP 连接挂住、服务端每 60 秒 write 一行 [KEEPALIVE ts=...]
  → 用户 ack/reply / next_action / terminate → 服务端 resolve promise → 写一行结果 → 关流
  → curl exit → agent stdout 拿到结果推进
```

**不**走 MCP 60s timer + 轮转——会踩 Cursor backend anti-loop。

### 推进 dialog（V0.6 重写）

用户从「推进」按钮打开 dialog、选下一个 action 类型 + 写指令：

- **action 类型卡片**：4 个实装 + 3 个 stub、不满足准入条件灰掉 + hover 提示
- **推荐项**：按 `inferRecommended(task)` 推断（无 action → plan / 最近 plan completed → build / has_bug → build / merged → chat）
- **placeholder 动态**：按 action 类型 + task 状态变（has_bug + build → 「修哪个 bug」/ 首次 plan vs 再次 plan 不同）
- **forceNewAgent**（高级）：默认 false、勾上时 cancel 旧 Run + 起新 Agent（耗 +1 send 配额）

### Ack：approve / revise（V0.6 简化）

V0.5 「通过 PHASE 高级配置 dialog」（切模型 / 换 agent）拆掉、ack 路径简化：

- **通过**：顶部「通过」按钮 → submitActionAck("approve") → 同 agent 接着等下一指令
- **再聊聊（revise）**：「再聊聊」按钮 → ReviseDialog 写 feedback + 可选附图 → submitActionAck("revise", feedback, images) → 同 agent 改 artifact

切模型 / 换 agent 现在统一在「推进」dialog 的高级选项里、ack 路径不再支持。

### 6 个 Harness 门槛（V0.6 核心）

V0.5 phase 顺序拆掉后、用 6 个显性门槛补回保证：

| 门槛 | 实现 | 位置 |
|---|---|---|
| 1. action 前置准入 | runner `checkActionPrerequisites` + UI dialog 灰掉 | `task-runner.ts` + `advance-dialog.tsx` |
| 2. action 后置 deterministic check | runner 切 awaiting_ack 前跑、写 `action.postCheck` | `action-checks.ts` |
| 3. 默认 default | UI 按 task 状态推断 | `advance-dialog.tsx: inferDefaultActionType` |
| 4. action 级 anti-patterns prompt | 每个 `prompts/action-<type>.md` 头部红线段 | `prompts/action-*.md` |
| 5. cross-action 一致性自检 | V0.6.4+ 再做 | - |
| 6. placeholder 动态 | UI 按 action + task 状态变 | `advance-dialog.tsx: buildPlaceholder` |

### Git Branch 自动建（V0.6.1 重构、多仓适配）

build action 每次跑前、runner 拼 `GitBranchInfo[]`（每仓 1 条同名 branch）、prompt 头部追加**多仓 idempotent** checkout 引导：

```
feature/<settings.username>/<飞书 story id>-<task.title 转换后>
```

agent 用 SDK shell 对每个仓跑一段 idempotent 命令：

```bash
BASE=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@')
if git show-ref --verify --quiet refs/heads/<branch>; then
  git checkout <branch>
else
  git fetch origin "$BASE" && git checkout -b <branch> "origin/$BASE"
fi
```

每次 build 都重新 inject 这段 hint、不再维护 `checkedOut` 状态。多仓 task 各仓 base 分支自探（不同仓可能 master / main / develop）、共用同一 branch name。

没填 username / feishuStoryUrl 时不建 branch、走 fallback。

### Ship action + GitLab REST 集成（V0.6.1）

ship 实现要点：

- **server-side GitLab REST API**：`src/lib/server/gitlab-client.ts` 直接 fetch `/api/v4/projects/:id/merge_requests`、走 PAT (`PRIVATE-TOKEN` header)；**不**依赖 glab CLI / 外部 MCP server
- **PAT 不暴露给 agent**：agent 通过 MCP 工具 `submit_mr` 间接调、server 端凭 settings 闭包的 token 访问 GitLab；MCP 工具返结构化 JSON（`{ ok, mr_url, mr_iid, mr_version }`）
- **多仓 task 每仓 1 条 MR**：`Task.gitBranches[]` / `Task.mrs[]` / `ActionRecord.sideEffects.mrs[]` 都按 `repoPath` 区分；某仓 `git diff` 为空时 agent 跳过、在 artifact 写跳过原因
- **同分支累计 commit**：同 `repoPath` 多次 ship 不开新 MR、`task.mrs[repoPath]` 的 `version` 累加、保留 `createdAt` 首次值——`upsertMR(taskId, repoPath, ...)`
- **飞书 @ 测试人员（A+C 策略）**：首次 ship 由 agent 调飞书 MCP `list_workitem_role_config` + `search_user_info` 自动探测（A）、探不到时 ask_user 让用户填用户名（C）、结果通过 `set_feishu_testers` MCP 工具持久化到 `task.feishuTesterUserIds`、后续 ship 直接复用

settings 新加 2 个全局字段：

- `gitHost`：自建 GitLab host（如 `gitlab.wukongedu.net`、不带协议）
- `gitToken`：Personal Access Token（明文 localStorage、跟 apiKey 同安全级别）

UI 在 `src/components/settings/git-card.tsx` 卡片配置。ship 准入 = build 已 approve + gitHost + gitToken 三者俱全。

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

### 多角色 schema（V0.4 沿用）

`Task.role: TaskRole`（当前仅 `"fe"`、未来扩 `be / data / mobile / qa`）、`TASK_ROLE_LABEL` 中文映射、prompt 顶部「当前角色：xxx」提示。

### 多仓库 cwd 公共父目录（V0.5.9 沿用）

`Task.repoPaths: string[]`、SDK Run `local.cwd = getEffectiveCwd(repoPaths)`：

- 单仓 → cwd = 仓自身
- 多仓 → cwd = 公共父目录、AI 视角下挂 N 个 git 子仓、路径首段是仓名
- 0 仓 → cwd = home（纯探索 / 答疑场景）

### Resizable 分栏 + Diff 视图（V0.5.10 + V0.5.12 沿用）

任务详情页主区：左 `ArtifactPanel`（当前 selected action）+ 右 `EventStream`、可拖动、持久化在 `task.uiLayout.artifactPanelSize`。

ArtifactPanel toolbar 加「正文 / Diff」切换、`fetchActionRevisions` / `fetchActionDiff` API（V0.5.12 接口同款、key 改 actionId）、有未看 revision 时 Diff 按钮挂红点。

### Skills loader（V0.5 沿用、V0.6 不动）

`src/lib/server/skills-loader.ts` 加载 `<repoPath>/.cursor/skills-*/*.md` + `~/.cursor/skills-*/*.md`、注入到 super-prompt。

---

## 最近演进（窗口式、保留 2 个子版本）

> 写入规则：新子版本完成后在本段顶部追加、超过 2 个时把最老的迁到 `docs/CHANGELOG.md`。

### V0.6.5：设置页编辑即保存 + 「常用 MCP」开关（建任务取快照）（2026-06-02）

**需求**：设置页给每个 MCP 加「常用」开关、建任务时取这份快照作默认黑名单——常用的默认带、不常用的默认关、建 task 弹窗里仍可临时增减。

**数据**：`FeAiFlowSettings.disabledMcpServers`（全局默认黑名单、跟 task 级 `task.disabledMcpServers` 同形）。`local-store` 的 `DEFAULT_SETTINGS` 补空数组、`getSettings` 读时兜 `Array.isArray`。`use-settings` 的 `isFieldEqual` 给它单独走「排序后逐项比」（数组无序）、`dirty` 纳入。

**建任务取快照**：`new-task-dialog` open 时 `setDisabledMcp(settings.disabledMcpServers ?? [])` 作默认。因为 settings 在 localStorage、server 读不到 → 必须建 task 时由 client 固化进 `task.disabledMcpServers`。

**改即存 → 全设置页（用户拍板「所有保存按钮都去掉、编辑即保存」）**：业界共识（macOS 系统设置 / VS Code / Notion 都改即存）。`use-settings` 加 `saveFieldValue(key, value)` 作**唯一落盘入口**、删 `saveField`：base 取 `getSettings()` 读「落盘最新」（**连续存不同字段不互相覆盖**）、state 只更新该字段（**不冲掉其它正在输入未 blur 的草稿**）、不弹 success toast（仅失败弹）。控件分两类落盘时机——**选择 / 开关 / 增删等离散操作**：`onChange` 直接 `saveFieldValue`；**文本框**（apiKey / username / gitHost / gitToken / repo 名 + 线上分支）：`onChange` 只改草稿（`update`）、`onBlur` 才落盘（避免每敲一字符就写 + 存进半成品）。6 张卡片全去 `SaveButton`、`save-button.tsx` 删。`dirty` / `hasUnsaved` / beforeunload 保留作「文本框输入中途未 blur 就关页」的兜底提醒。

`pnpm typecheck` ✓ / `pnpm lint` ✓。

**另（hot-fix：修同事试用反馈的两个 UI bug、2026-06-02）**：

1. **Select 受控/非受控切换 console 警告**（`A component is changing the uncontrolled value state of Select to be controlled`）——Base UI Select 以「`value` 是否 `undefined`」判定受控/非受控、`value={x || undefined}` 在初次渲染（空 → undefined、非受控）与有值后（string、受控）之间切换触发警告。修：空值统一传 `null`（Base UI 类型 `value?: Value | null | undefined` 明确支持 null 作受控空值、trigger 照常显示 placeholder）。扫全项目 5 个 `<Select>`、改其中 4 处（`model-picker` base + param select / `artifact-panel` diff 版本选择器 / `new-task-dialog` 换模型）；`new-task-dialog` 的 role select 因 `useState<TaskRole>("fe")` 恒有值、本就受控、不动。
2. **推进弹窗「打开后选中跳一下」**——`advance-dialog` 把「表单初始化」和「按需拉模型列表」塞进同一 `useEffect` 且依赖 `availableModels.length`、模型列表异步加载完成（length 0 → N）触发 effect 重跑、把用户已改的 action 选中打回默认（实测：选「提测」跳回「方案」）。修：拆成两个 effect——表单初始化只依赖 `[open, defaultActionType]`、拉模型单独一个 effect（只 fetch、不碰任何表单 state、即便重跑也无副作用）。

### V0.6.4：MCP OAuth（fe 自己跑标准 OAuth、让走 OAuth 的远程 MCP 在 fe 可用）（2026-06-01）

**背景**：飞书项目 MCP（`project.feishu.cn/mcp_server/v1`）走标准 OAuth——Cursor 里点浏览器授权、token 存 Cursor 内部、连接时注入。但 fe 读 `~/.cursor/mcp.json` 只拿到裸 url（OAuth token 不写文件）、SDK 起的 agent 是 headless 弹不了浏览器 → 连 server 直接 401、用不了。

**实锤**（curl 探测飞书项目）：教科书级 OAuth 2.1——401 带标准 `WWW-Authenticate`、Protected Resource Metadata（RFC 9728）+ Authorization Server Metadata（RFC 8414）齐全、DCR 动态注册（**接受 localhost 回调**）、PKCE S256、refresh_token。

**方案**：fe 自己跑标准 OAuth flow（复用 `@modelcontextprotocol/sdk` 自带 OAuth client：`auth()` 一站式做发现 / DCR / PKCE / 换 token / refresh）、token 落服务端文件、起 agent 前注入 `mcpServers[name].headers.Authorization`。一次授权、refresh_token 长期自动续——跟 Cursor 体验一致。**通用**：任何标准 OAuth 2.1 的 MCP 都能用、不止飞书项目。

**落地**：
- `src/lib/server/mcp-oauth.ts`：`FileOAuthClientProvider`（OAuthClientProvider 实现、状态全部落 `data/mcp-oauth/<server>.json`、靠 serverName 跨请求串）+ `startMcpOAuth` / `completeMcpOAuth`（CSRF state 校验）/ `enrichMcpServersWithOAuth`（注入、access 过期先 refresh、提前 60s 续）/ status / revoke。认证方式取舍：飞书 auth metadata 没声明 `token_endpoint_auth_methods_supported`、SDK 在 client 有 secret（DCR 颁发）时默认 `client_secret_basic`、实测 OK
- 4 个 API：`/api/mcp-oauth/{start,callback,status,revoke}`。callback 返回结果 HTML（成功自动关窗 + postMessage 通知 opener 刷新）
- 注入点：`chat-runner` / `task-runner` 的 `filterDisabledMcp` 外包一层 `enrichMcpServersWithOAuth`
- UI：`mcp-card` 加 OAuth 授权区（http/sse 类且没手配 Authorization header 的 server 显示「授权 / 已授权 / 重新授权 / 撤销」）+ `use-mcp-oauth` hook（点击同步开窗规避弹窗拦截、focus/postMessage 刷新状态）+ `task-store` 3 个 helper
- 端口：回调 `http://localhost:8876/api/mcp-oauth/callback`（dev/prod 都 8876、可 env `FE_AI_FLOW_BASE_URL` 覆盖、必须跟 DCR 注册一致）
- **实测**：发起链路（读配置→发现→DCR→PKCE→生成授权 URL）curl 验证通过（返回合法 authorizationUrl、client_id / S256 / redirect_uri / state / resource 全对）；换 token + 注入连通待用户飞书授权后验

`pnpm typecheck` ✓ / `pnpm lint` ✓。

**另（工程：依赖安装跨平台兜底、2026-06-02）**：`@cursor/sdk` 间接依赖 `sqlite3`、`install` 走 `prebuild-install` 默认拉 GitHub releases——国内 / Windows + 新 Node 常踩坑（下载超时 → 退回 node-gyp 源码编译 → 要装 VS C++ 工具链）。三处协同、新人 `pnpm install` 开箱即用：① `package.json` `overrides` 锁 `sqlite3@^6.0.1`（5.x 无 Node24 prebuild）+ `pnpm.onlyBuiltDependencies` 放行 build 脚本（pnpm10 默认拦截）+ `packageManager` 锁 pnpm 版本；② `.npmrc` `sqlite3_binary_host_mirror=…npmmirror…/sqlite3` 把预编译包指向淘宝（win/mac/linux 全平台 napi 包齐、免本机编译）。**坑**：prebuild-install 7.x 按 **package name** 读 env（`sqlite3_binary_host_mirror`）、不是老 node-pre-gyp 的 `node_sqlite3_` 前缀（网上教程多数过时）。实测 pnpm lifecycle 透传该 .npmrc key、URL 精准命中淘宝、win napi-v6 包完整可下（含 `build/Release/node_sqlite3.node`）。

**另（hot-fix：探测式判断哪些 MCP 真要 OAuth、2026-06-02）**：V0.6.4 初版用静态启发式判 OAuth 候选（凡有 `url` 且没手配 `Authorization` header 一律算「要授权」）、把 `figma-desktop`（本地 http）、`feishu-mcp`（url 自带 token）误判成要授权。改后端**探测**：`mcp-oauth.ts` 加 `evaluateMcpOAuthStatuses`——对每个**远程**（排除 localhost/127.0.0.1 本地地址 + 已手配 Authorization 的）server 发 MCP `initialize`、**只有真返 401（OAuth challenge）才算 `needsOAuth`**；探测非 401（公开 MCP / token 在 url）一律不进授权区。`McpOAuthStatus` 加 `needsOAuth`、`mcp-card` 去掉前端静态 `oauthCandidates`、直接用后端 `statuses`、`status` API 改调 `evaluateMcpOAuthStatuses`。

---

## 关键文件索引

| 内容 | 位置 |
|---|---|
| **V0.6 重构设计文档（已 archived、V0.6.0 落地完成）** | `docs/V0.6-REFACTOR.md` |
| **V0.6 统一 runner（task 容器 + action history）** | `src/lib/server/task-runner.ts` |
| **V0.6 action 后置 deterministic check** | `src/lib/server/action-checks.ts` |
| **V0.6 task schema + 文件系统** | `src/lib/types.ts` + `src/lib/server/task-fs.ts` |
| **GitLab REST client（V0.6.1 新）** | `src/lib/server/gitlab-client.ts` |
| **读 Cursor 全局配置 mcp/rules（V0.6.2 新）** | `src/lib/server/cursor-config.ts` |
| **Cursor MCP 只读 API + hook（V0.6.2 新）** | `src/app/api/cursor-mcp/route.ts` + `src/hooks/use-cursor-mcp.ts` |
| **MCP OAuth（V0.6.4 新、走 OAuth 的远程 MCP 授权 + 注入）** | `src/lib/server/mcp-oauth.ts` + `src/app/api/mcp-oauth/{start,callback,status,revoke}` + `src/hooks/use-mcp-oauth.ts` |
| **设置页编辑即保存（V0.6.5、6 张卡片去 SaveButton）** | `src/hooks/use-settings.ts: saveFieldValue`（唯一落盘入口）+ `src/app/settings/page.tsx` + `src/components/settings/*-card.tsx` |
| **「常用 MCP」全局开关（V0.6.5、设置页配 + 建 task 取快照）** | `FeAiFlowSettings.disabledMcpServers` + `src/components/settings/mcp-card.tsx` |
| **super-prompt 主模板（V0.6 改造、注入 7 action）** | `prompts/_super.md` |
| **跨 action 共享规范** | `prompts/_shared.md` |
| **plan / build / review / ship action prompt** | `prompts/action-{plan,build,review,ship}.md` |
| **test / learn stub（V0.6.2+ 设计草稿）** | `prompts/action-{test,learn}.md` |
| **chat 模式独立 runner（V0.6.0.1 新）** | `src/lib/server/chat-runner.ts` |
| **chat 模式 UI（V0.6.0.1 新）** | `src/components/tasks/chat-view.tsx` |
| **chat 模式 API** | `src/app/api/tasks/[id]/chat-reply/route.ts` |
| `wait_for_user` / `ask_user` 实现 + pendingMap | `src/lib/server/chat-mcp.ts` |
| wait-ack 长连接路由（保活核心） | `src/app/api/tasks/[id]/wait-ack/route.ts` |
| 推进 / ack / 终结 路由 | `src/app/api/tasks/[id]/{advance,action-ack,finalize}/route.ts` |
| watch-task SSE 路由 | `src/app/api/tasks/[id]/watch-task/route.ts` |
| Action revisions / diff 路由 | `src/app/api/tasks/[id]/{action-revisions,action-diff}/route.ts` |
| ContextDocsPanel（任务级上下文） | `src/components/tasks/context-docs-panel.tsx` |
| ask_user 弹窗（V0.3.2 沿用） | `src/components/tasks/ask-user-dialog.tsx` |
| 事件流主组件 + utils + rows | `src/components/tasks/event-stream{,/utils,/rows}.tsx` |
| Artifact 面板（V0.6 适配 ActionRecord） | `src/components/tasks/artifact-panel.tsx` |
| Artifact diff 组件 | `src/components/tasks/artifact-diff.tsx` |
| **Action timeline（V0.6 新）** | `src/components/tasks/action-timeline.tsx` |
| 推进 dialog（V0.6 重写、选 action） | `src/components/tasks/advance-dialog.tsx` |
| 再聊聊 dialog（V0.6 适配 actionLabel） | `src/components/tasks/revise-dialog.tsx` |
| 新建任务 dialog（V0.6.0.1 重新加 mode tab） | `src/components/tasks/new-task-dialog.tsx` |
| 任务卡片（V0.6 双状态） | `src/components/tasks/task-card.tsx` |
| 任务详情页（V0.6 重写） | `src/app/tasks/[id]/page.tsx` |
| 任务角色 schema + 展示文案 | `src/lib/types.ts: TaskRole / TASK_ROLE_LABEL` |
| 多仓 cwd / repoPaths 工具 | `src/lib/path-utils.ts: getEffectiveCwd / formatRepoSectionForPrompt` |
| Artifact ref / 文件路径渲染（V0.6.0.1 加 `actions/` 前缀支持） | `src/lib/path-utils.ts: looksLikeArtifactRef / looksLikePath / buildCursorLink` |
| 设置：username（V0.6 新增） | `src/components/settings/user-profile-card.tsx` |
| 设置：GitLab Host + PAT（V0.6.1 新增） | `src/components/settings/git-card.tsx` |
| 模型选择器共享组件（V0.6.0.1 抽出、settings + advance dialog 共用） | `src/components/ui/model-picker.tsx` |
| Skills loader | `src/lib/server/skills-loader.ts` |

## 设计变动流程

权威源 = 代码 + 本文件。设计层面变动：

1. **当前架构变动**（如 action 模型改、保活机制改、新增大组件）→ 改代码 + 同步更新本文件「当前架构快照」段
2. **小步迭代**（同主题连续 .1 / .2 / .3 微调）→ 改代码 + 写到本文件「最近演进」段顶部
3. **再老一轮时**（「最近演进」积压超过 2 个子版本）→ 把最老那段迁到 `docs/CHANGELOG.md` 顶部

⛔ 不要散落到其它 md 写一份新的演进段。
