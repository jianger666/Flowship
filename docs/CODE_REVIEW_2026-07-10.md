# fe-ai-flow 全仓代码审查报告

审查日期：2026-07-10  
审查分支：`main`  
审查基线：`4cd8a4e fix: 甘特窄条文字仍溢出——主条残留 overflow:visible 覆盖了 overflow-hidden、状态 label 并入名字统一省略`  
审查方式：静态代码审查 + 本地构建/测试/类型/依赖审计；未修改业务代码。

## 1. 结论摘要

当前代码的功能组织、任务文件隔离、Git 参数化执行、Markdown 渲染安全性和部分工作树集成测试做得较扎实；现有 `typecheck`、项目内置 `lint`、151 个测试和生产构建均能通过。

但当前版本不建议直接扩大分发或在不受信网络中运行，主要原因是：

- 2 个 P0（阻断级）：源码运行默认对局域网暴露无鉴权 API，可形成密钥泄漏和远程命令执行；mac 自动更新在没有签名/哈希校验的情况下替换自身。
- 4 个 P1（高）：worktree 清理存在数据丢失路径；OAuth 凭证文件名碰撞可把 token 发给错误服务器；飞书 CLI/Skills 安装链缺少完整性校验；生产依赖存在 13 个 high 等级公告。
- 6 个 P2（中）：自适应角色无法编辑、设置持久化可能静默失败/乱序覆盖、仓库配置 dirty 判断漏字段、预览进程存在并发/误杀风险、Windows 路径被拒、完整 lint/关键链路测试存在盲区。
- 1 个 P3（低）：README/HANDOFF 多处描述已与 V0.13/V0.14 实现不一致，其中包括密钥存储位置等安全相关说明。

问题统计：P0 × 2、P1 × 4、P2 × 6、P3 × 1，共 13 项。

建议修复顺序：`CR-01 → CR-02 → CR-03/04/05/06 → CR-07~12 → CR-13`。

## 2. 审查范围与验证结果

覆盖范围：

- Next.js App Router 页面、全部 API Route
- task/chat runner、MCP、OAuth、GitLab、worktree、artifact/事件持久化
- Electron 主进程、preload、自更新与打包链
- 飞书 CLI/Skills 下载与执行链
- 客户端状态、设置存取、SSE、主要任务 UI
- package/lockfile、ESLint/TypeScript/Vitest/构建配置、核心文档

执行结果：

| 校验 | 结果 | 备注 |
|---|---:|---|
| `pnpm typecheck` | 通过 | 无 TypeScript 错误 |
| `pnpm test` | 通过 | 13 个测试文件、151 个用例 |
| `pnpm lint` | 通过 | 但使用已废弃的 `next lint`，且没有覆盖完整仓库，见 CR-12 |
| `pnpm build` | 通过 | 34 个页面/路由生成成功；构建期出现 Node SQLite experimental warning |
| `pnpm exec eslint .` | 失败 | 2 errors + 1 warning，见 CR-12 |
| Electron/脚本 `node --check` | 通过 | `main.js`、`preload.cjs`、关键 `.mjs` 语法正常 |
| `pnpm audit --prod` | 失败 | 45 项：13 high、26 moderate、6 low，见 CR-06 |

限制：没有使用真实 Cursor API Key、GitLab PAT、飞书账号跑完整 E2E；没有实际打包并安装 Electron 产物；因此外部服务协议兼容性、安装器行为和真实自动更新只能基于代码链路审查。

## 3. 详细问题

### CR-01 [P0] 源码运行默认监听所有网卡，无鉴权 API 可泄漏密钥并执行任意命令

位置：

- `package.json:11-16`
- `scripts/dev-open.mjs:21-31`
- `src/app/api/settings/route.ts:27-31`
- `src/app/api/tasks/route.ts:61-101`
- `src/app/api/preview/route.ts:27-68`
- `src/lib/server/preview-manager.ts:166-176`

证据：

1. `dev`、`serve`、`start:prod` 和 `dev-open.mjs` 都只传端口，没有传 hostname。
2. 本仓本地 CLI `next dev --help` / `next start --help` 显示默认 hostname 为 `0.0.0.0`。
3. `/api/settings` 原样返回 `config.json`，其中包含 Cursor API Key、GitLab Token 和 MCP 配置。
4. `/api/preview` 接收客户端传来的 `command`，最终以 `spawn(command, { shell: true })` 执行。
5. API 没有身份认证、会话 token、Origin/Host 校验或 CSRF 防护。

可达攻击链（不要求预先存在任务）：

1. 攻击者从同一局域网请求 `POST /api/tasks`，创建 `mode=chat`、`repoPaths=["/tmp"]` 的任务。
2. 从响应取得 task id。
3. 请求 `POST /api/preview`，传该 task id、`repoPath=/tmp` 和任意 shell 命令。
4. 命令以运行 ai-flow 的本机用户权限执行。

同一攻击者也可以直接 `GET /api/settings` 读取完整密钥。Electron 打包态显式设置了 `HOSTNAME=127.0.0.1`，但 README 首选的源码运行路径仍受影响；只绑定 loopback 也不能替代 API 鉴权/Origin 防护。

影响：局域网远程代码执行、Cursor/GitLab/MCP 凭证泄漏、任意任务/文件/分支操作。

修复建议：

1. 所有源码启动命令强制 `-H 127.0.0.1`，`dev-open.mjs` 同样显式传 hostname。
2. Electron/dev 启动时生成高熵进程级 bearer token，所有 `/api/**`（OAuth callback 例外）校验；renderer 请求统一注入。
3. 校验 `Host`/`Origin`，拒绝非本应用 origin；所有变更接口做 CSRF 防护并限制 JSON content type。
4. `/api/preview` 不再接受任意命令；服务端按 `task.repoPaths` 从权威 settings 查 `previewCommand`。
5. `/api/settings` 默认返回脱敏结构；敏感值读取/更新走专门接口，避免“一次 GET 全量导出”。
6. 增加安全回归测试：非 loopback 连接失败、无 token 401、跨 origin 403、客户端伪造 preview command 无效。

验收标准：从局域网另一台机器无法连接；loopback 无认证无法读/写 API；不存在“创建 chat task → preview shell”的无认证 RCE 链。

### CR-02 [P0] mac 自动更新不校验发布者或内容真实性，却直接替换应用并刻意绕过 Gatekeeper

位置：

- `electron-app/main.js:492-500`
- `electron-app/main.js:568-671`
- `electron-builder.yml` 的 `mac.identity: null`

证据：

- mac 产物明确不签名。
- 更新器从固定 GitHub Release URL 下载 DMG，只校验 HTTP 状态和 `Content-Length`。
- 未校验 SHA-256、签名、Team ID、bundle id、代码签名或签名 manifest。
- 下载后挂载 DMG，寻找第一个 `.app`，用 `ditto` 替换当前应用。
- 注释明确依赖“fetch 下载不带 quarantine”来规避 Gatekeeper 检查。

`Content-Length` 只能发现传输截断，不能证明文件来自可信发布者。GitHub 账号、仓库写权限、CI token、Release asset 或下载链任一被攻破，都可向所有 mac 用户投递任意代码。

影响：供应链远程代码执行；更新机制会把攻击持久化为正式应用版本。

修复建议：

1. 首选 Apple Developer ID 签名 + notarization，并使用能验证代码签名的标准更新方案。
2. 若短期无法签名，至少发布独立签名 manifest：内置离线公钥，manifest 包含版本、asset 名、长度、SHA-256，使用 Ed25519 签名；客户端先验签再验哈希。
3. 挂载后用 `codesign --verify --deep --strict`，并检查 bundle id/Team ID（有签名后）。
4. 不以绕过 quarantine 作为安全设计；验签失败必须保留旧应用、清理下载并明确报错。
5. CI 增加产物摘要和签名发布，私钥不与 GitHub Release 写 token 共用信任域。

验收标准：篡改 DMG 任意一个字节、替换 Release asset、放入错误 bundle id 的 `.app` 都必须被拒绝，旧应用不移动。

### CR-03 [P1] worktree 清理在 `git status` 失败时按“干净”处理，可删除未提交改动

位置：

- `src/lib/server/task-worktrees.ts:426-475`
- `src/lib/server/task-worktrees.ts:493-533`
- `src/lib/server/task-worktrees.ts:557-599`

证据：`snapshotDirtyWorktree()` 在 `git status --porcelain` 执行失败时直接返回 `"clean"`：

```ts
if (!status.ok || status.stdout.length === 0) return "clean";
```

随后 `removeTaskWorktrees()` 会执行 `git worktree remove --force`；若原仓路径也失效，则回退 `fs.rm(workDir, { recursive: true, force: true })`。

触发场景：原仓库被移动/删除、`.git` 指针损坏、git 不在 PATH、权限/文件系统暂时异常。此时 worktree 里可能仍有用户/agent 未提交文件，但状态查询失败被误判成干净并递归删除。

影响：不可恢复的数据丢失。当前测试覆盖“正常脏工作区自动 WIP commit”和“merge 冲突不删”，但没有覆盖 `git status` 自身失败。

修复建议：

- `status.ok === false` 必须返回 `"failed"`，清理流程 fail-closed。
- 删除前再次验证 worktree、分支和快照 commit；快照后确认 `git status --porcelain` 为空。
- 原仓不可用时不要删，或先把工作目录打包/复制到 recovery 目录并通知用户。
- 为“原仓重命名/删除”“git 不可执行”“`.git` 指针损坏”增加集成测试。

验收标准：任何无法证明工作区干净或已可靠快照的情况都不得删除目录。

### CR-04 [P1] OAuth 凭证文件名清洗不是一一映射，名称碰撞会把 token 注入错误 MCP 服务器

位置：

- `src/lib/server/mcp-oauth.ts:76-108`
- `src/lib/server/mcp-oauth.ts:438-497`

证据：凭证文件名通过以下方式生成：

```ts
serverName.replace(/[^a-zA-Z0-9_.-]/g, "_")
```

例如 `foo/bar` 与 `foo?bar` 都映射为 `foo_bar.json`。`readRecord()` 不校验记录内的 `serverName`/`serverUrl` 是否与调用参数一致；`getValidAccessToken()` 读到新鲜 token 后直接返回；`enrichMcpServersWithOAuth()` 会把它作为 Bearer token 发到当前配置项的 URL。

影响：两个碰撞名称会互相覆盖 OAuth 状态；更严重时，受信 MCP 的 bearer token 会被发送给另一个（可由攻击者控制的）MCP URL。

修复建议：

- 文件名使用 `sha256(serverName)` 或可逆且无碰撞的 base64url 编码。
- 读取后强校验 `rec.serverName === serverName`，并校验规范化后的 `rec.serverUrl === serverUrl`；不一致立即拒绝并要求重新授权。
- 为旧文件做一次安全迁移，碰撞时不自动猜测归属。
- 增加碰撞名称、URL 改绑、旧记录迁移测试。

验收标准：任意两个不同 serverName 不共用记录；修改同名 server 的 URL 后旧 token 不能被发送到新 URL。

### CR-05 [P1] 飞书 CLI 和 Agent Skills 下载执行链缺少完整性校验与版本固定

位置：

- `src/lib/server/feishu-cli.ts:61-111`
- `src/lib/server/feishu-cli.ts:127-201`
- `src/lib/server/feishu-cli.ts:204-240`

证据：

- `lark-cli` 从 GitHub 或 npmmirror 下载二进制 archive，未校验 checksum/signature。
- `meegle` 从 npmjs 或 npmmirror 下载 tgz，只读取 latest 版本号，没有使用 npm metadata 的 `dist.integrity`/`shasum`。
- 下载内容解包后直接复制为可执行文件并加入进程 PATH，agent 后续会执行。
- Agent Skills 从两个 GitHub 仓库的可变 `main` 分支下载并直接进入 skills loader；没有 commit/tag 固定、签名或内容审核。
- 临时文件名部分可预测，未使用 `fs.mkdtemp`/排他创建，存在本地 symlink/race 风险。

影响：镜像、registry、仓库、账号或传输链被攻破时可执行任意二进制；可变 Skills 还可形成持久 prompt/shell 供应链注入。

修复建议：

1. npm 包读取并验证 `dist.integrity`；GitHub 资产使用发布方 checksum/signature，并固定版本。
2. 镜像只能作为字节源，必须通过同一个受信摘要验真；不能“镜像成功即信任”。
3. Skills 固定到 tag/commit，记录来源 commit；更新前展示 diff 或要求显式确认。
4. 使用 `fs.mkdtemp` 创建私有临时目录，文件用排他模式创建；安装采用 staging + 原子替换。
5. 安装后验证版本和预期文件类型；失败不覆盖已安装版本。

### CR-06 [P1] 生产依赖审计发现 13 个 high，且存在可移除/错放的直接依赖

位置：`package.json:24-49`、`pnpm-lock.yaml`

`pnpm audit --prod` 结果：

- 总计 45：13 high、26 moderate、6 low。
- 当前安装 `next@15.5.15`，审计要求至少升级到 `15.5.18` 才覆盖当前列出的高危修复。
- `@connectrpc/connect-node@1.7.0 → undici@5.29.0` 带入多个 high；全仓搜索没有发现业务代码引用 `@connectrpc/connect-node`。
- `@modelcontextprotocol/sdk@1.29.0` 当前解析到有公告的 `fast-uri@3.1.0`、`hono@4.12.15`。
- `shadcn@4.6.0` 是脚手架 CLI，但被放在 production dependencies；全仓没有运行时 import，它把大量 CLI/MCP/构建依赖计入生产图。
- `gray-matter → js-yaml@3.14.2`、`react-diff-viewer-continued → js-yaml@4.1.1` 有 DoS 公告。

部分公告对应本项目未使用的框架功能，实际可利用性需要逐项确认，但直接 Next.js 漏洞、对外暴露的本地 HTTP 服务和 MCP 路径不应整体忽略。

修复建议：

- 更新 lockfile，至少将 Next 升到已修复版本；同步 `eslint-config-next`。
- 删除未使用的 `@connectrpc/connect-node`；把 `shadcn` 移到 devDependencies。
- 升级 MCP SDK/相关传递依赖，必要时使用经过兼容测试的 `pnpm.overrides`。
- 处理两个 `js-yaml` 路径，或替换维护停滞的上层包。
- CI 增加 `pnpm audit --prod --audit-level high`，允许带书面理由的精确 advisory 豁免，禁止整类忽略。

### CR-07 [P2] “自适应”角色任务无法保存任何编辑

位置：

- `src/components/tasks/edit-task-dialog.tsx:60,158-173`
- `src/app/api/tasks/[id]/route.ts:153-190`
- `src/lib/types.ts:757-765`

前端角色选项包含 `adaptive`，且保存请求总会携带 `role`。后端 PATCH 校验却只接受 `fe`/`be`：

```ts
if ("role" in body && body.role !== "fe" && body.role !== "be")
```

因此 adaptive 任务即使只改标题或飞书链接，也会因为随请求发送的角色而返回 400。

修复建议：角色枚举校验集中成共享 type guard/schema（包含 `adaptive`），不要在多个 route 手写白名单。增加“创建 adaptive → 编辑标题/角色/仓库 → 保存成功”的 route 测试。

### CR-08 [P2] 设置文件写入是 fire-and-forget，错误被当成功，且并发整对象 PUT 可能乱序覆盖

位置：

- `src/lib/local-store.ts:198-225`
- `src/lib/local-store.ts:258-278`
- `src/app/api/settings/route.ts:49-75`
- `src/hooks/use-settings.ts:201-219`

证据：

- `putSettings()` 不检查 `res.ok`，500 响应会被解析后静默返回。
- `saveSettings()` 立即返回 localStorage 是否写成功，服务端 `config.json` 写入异步执行；UI 会把字段标记成已保存。
- 下次启动只要 `config.json` 存在就以它为权威，因此服务端写失败时，本轮看似成功的修改会在重启后丢失。
- 每次保存发送整份 settings，没有客户端串行队列、revision 或服务端 mutex。两个快速保存请求可能后发先完成，旧整对象覆盖新整对象。

修复建议：

- 保存 API 改为 await 并检查 HTTP 状态；只有权威文件写成功后才更新 saved state/提示成功。
- 优先改成字段级 PATCH，或增加单调 revision/ETag + compare-and-swap。
- 客户端按顺序串行写入并合并 pending changes；服务端为 settings 写加单例 mutex。
- 文件权限显式限制为当前用户，密钥不再长期双写 localStorage。
- 测试 500、磁盘只读、两个请求人为延迟乱序、进程重启后的最终值。

### CR-09 [P2] 仓库设置 dirty 判断只比较 name/path，遗漏五个真实配置字段

位置：

- `src/hooks/use-settings.ts:91-98`
- `src/lib/types.ts:14-40`
- `src/components/settings/repo-card.tsx:104-125,226-247`

`RepoConfig` 还包含 `onlineBranch`、`testBranch`、`devBranch`、`branchTemplate`、`previewCommand`，但 `isFieldEqual("repos")` 只比较 `path` 和 `name`。

结果：用户编辑分支模板或预览命令时，`hasUnsaved` 仍可能为 false；窗口关闭/异常导航若未触发 blur，不会得到未保存提示。现有 `beforeunload` 也不能覆盖所有 Next.js SPA 导航。

修复建议：完整比较 RepoConfig 所有持久字段（或稳定序列化）；为应用内路由增加 dirty 拦截；测试每个字段单独修改时 dirty=true、保存后=false。

### CR-10 [P2] 预览进程的 start/stop 未串行化，pidfile 也未验证进程归属

位置：`src/lib/server/preview-manager.ts:46-104,130-225`

问题一：两个并发 `startPreview()` 都可能先完成 `stopPreview()/killStalePreview()`，随后各自 spawn。后写入的 slot/PID 覆盖先写入者，先启动的进程变成无法通过 UI 停止的孤儿进程。“全局唯一预览位”在并发下不成立。`stop` 与正在 await 的 `start` 也有同类竞态。

问题二：pidfile 只保存 `{ pid, at }`。应用重启后直接向该 PID/进程组发信号，没有核验命令、启动时间或 owner；PID 被系统复用时可能终止无关进程。

修复建议：

- 对 start/stop 使用全局串行 mutex/operation generation；旧 generation 完成时不得发布 slot。
- pidfile 保存随机 ownership token、预期 executable/command、进程 start time；杀前核验。
- 进程退出回调只在 `ref.current === slot` 时清 pidfile，避免旧进程退出清掉新进程 pidfile。
- 增加并发双 start、start+stop、旧进程迟到 exit、PID 不匹配测试。

### CR-11 [P2] Windows 绝对仓库路径被 `/api/repo-branches` 拒绝，手填入口也只接受 POSIX 路径

位置：

- `src/app/api/repo-branches/route.ts:19-27`
- `src/components/settings/repo-card.tsx:76-92`

服务端使用 `path.startsWith("/")` 判断绝对路径，因此 `C:\work\repo`、`D:/repo` 和 UNC 路径都会 400。设置页手填校验也要求以 `/` 开头。

影响：Windows 原生 picker 虽能填入路径，但分支候选请求失败，线上/测试/dev 分支 Combobox 可能持续不可用；手填兜底也不可用。项目其他路径工具已显式支持 Windows，这里形成局部回归。

修复建议：服务端使用 Node `path.isAbsolute()`（并覆盖 win32/UNC 语义）；客户端使用共享跨平台绝对路径判断。增加盘符反斜杠、盘符正斜杠、UNC、POSIX 测试。

### CR-12 [P2] `pnpm lint` 给出“全绿”假象，Electron/API/关键 runner 缺少自动化保护

位置：

- `package.json:16`
- `eslint.config.mjs`
- `tests/`

证据：

- `pnpm lint` 运行已废弃的 `next lint`，输出 clean。
- `pnpm exec eslint .` 实际返回 2 errors + 1 warning：`electron-app/preload.cjs` 的 CJS require 规则、生成的 `next-env.d.ts` triple-slash、`postcss.config.mjs` 默认导出 warning。
- 当前 151 个测试主要覆盖纯函数、worktree 和 action fingerprint；没有直接覆盖 `task-runner.ts`、`chat-runner.ts`、`chat-mcp.ts`、OAuth、settings route、preview manager、Electron updater、绝大多数 API route。
- Electron 主进程约 929 行 JavaScript，不在 TypeScript 类型检查内；脚本目录被 ESLint 整体忽略。

这不是说现有测试无价值，而是“通过现有校验”不足以证明最危险的状态机和系统边界可靠。本次发现的 CR-01/02/04/07/08/10 都没有现成测试能拦截回归。

修复建议：

- 改成 ESLint CLI，明确 include/ignore；生成文件忽略，preload CJS 做定点规则 override，而不是靠 Next 默认扫描范围。
- Electron 主进程逐步迁到 TypeScript，或至少加 `// @ts-check` + JS config。
- 优先为 CR-01~11 增加 route/integration 测试，再追求覆盖率数字。
- CI 固定运行 `typecheck + eslint + test + build + audit`，任何一项失败阻断合并。

### CR-13 [P3] README/HANDOFF 与当前实现明显漂移，包含错误的安全与架构说明

位置示例：

- `README.md:88-95,110-116,160-189`
- `docs/HANDOFF.md:83,252,529,541-543`

不一致示例：

- README 称 API Key/仓库/模型只在 localStorage、“不上传服务器”；实际已迁移到服务端 `data/config.json`，且 `/api/settings` 返回完整对象。
- README 称 MCP 只读 `~/.cursor/mcp.json`；V0.13 已改为 app 自管配置并支持导入。
- 文档仍列已删除的 `/action-ack` route、`revise-dialog`、`new-task-dialog`、test action 等。
- “单 SDK Run 跑全程”与当前“每 action 默认新 agent/跨 run session”描述混杂。

影响：新维护者和 AI 会按错误安全模型/旧文件路径改代码，增加回归概率；密钥位置描述错误会直接影响威胁建模。

修复建议：把 README 收敛为当前用户使用说明；HANDOFF 顶部生成“当前版本事实表”，已退役内容移入 changelog；在 CI 加文档链接/文件存在性检查。完成 CR-01/02 后同步更新安全说明。

## 4. 做得较好的部分

- Task id 和上传文件名有白名单校验，主要任务目录路径穿越防护清晰。
- Git/IDE/CLI 多数调用使用 `execFile` + 参数数组，没有把分支名直接拼 shell；preview 的 `shell:true` 是明确设计点，也因此必须受 CR-01 的强边界保护。
- `meta.json` 使用 tmp + rename 原子写，task read-modify-write 有 per-task mutex；对 Next dev 多 chunk 的 globalThis 状态问题有现实经验。
- worktree 已覆盖正常创建、幂等、WIP 自动快照、分支被占用和 merge 冲突保留等真实 Git 集成测试。
- Markdown 不启用 raw HTML，链接组件只放行 http/https，降低 AI 输出造成 renderer XSS/危险协议打开的风险。
- runner 对并发 advance、后台 check ownership、旧 ask 作废、SSE bootstrap race 等复杂状态已有专门保护和较充分注释。
- Electron 打包态显式绑定 `127.0.0.1`，默认 context isolation/node integration 也未被放宽。

## 5. 建议实施批次

### 批次 A：立即止血（发布前）

1. CR-01：loopback + API auth/origin + preview 服务端取命令。
2. CR-02：暂停不验签的 mac 自更新；在可信更新链完成前退回手动下载并明确校验方式。
3. CR-03：worktree status 失败 fail-closed。
4. CR-04：OAuth 记录无碰撞命名 + serverName/serverUrl 双校验。

### 批次 B：供应链与依赖

1. CR-05：CLI/skills 摘要、版本固定、私有临时目录。
2. CR-06：Next/MCP/传递依赖更新；删除 connect-node、移动 shadcn。
3. 把 audit/lint/build 纳入 CI 阻断。

### 批次 C：功能与可靠性

1. CR-07：adaptive PATCH。
2. CR-08/09：设置持久化协议、revision/队列、完整 dirty。
3. CR-10：preview operation mutex + PID ownership。
4. CR-11：Windows 路径统一。

### 批次 D：守护与文档

1. 为上述问题逐项加回归测试。
2. Electron 主进程纳入类型/静态检查。
3. CR-13：重写当前 README/HANDOFF 事实层。

## 6. 交给修复 AI 的约束

- 不要用“这是本地应用”关闭 CR-01：源码模式当前真实监听 `0.0.0.0`，而且 API 具备密钥读取和 shell 能力。
- 不要只给 mac DMG 加 SHA-256 文本文件：摘要本身必须由内置公钥验证，否则攻击者可同时替换 DMG 和摘要。
- 不要在 CR-03 中继续 fail-open；清理逻辑必须以“无法证明安全就保留”为原则。
- OAuth 迁移不能通过“替换非法字符”换另一种清洗规则，必须使用无碰撞 key 并校验记录身份。
- 设置修复不能只补 `res.ok`；还要处理整对象 PUT 的并发顺序问题。
- 每个修复至少增加一个能在旧实现上失败、修复后通过的回归测试。

