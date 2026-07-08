# ai-flow CHANGELOG

本文件记录 ai-flow 所有 V0.x 版本的演进细节、按时间倒序（最新在最上面）。

## 这文件为什么存在

`docs/HANDOFF.md` 主要负责「最小接力上下文 + 当前架构快照 + 最近 1-2 个子版本」、不再吞下所有历史。每次新做完一个子版本后、改动细节追加到本文件顶部；超过 2 个子版本后由 HANDOFF.md「最近演进」段迁移过来。

## 写入规则

1. 新子版本完成后、**先在 HANDOFF.md「最近演进」段写一遍**（用户接力直接看 HANDOFF）
2. 等下一个 / 下下个子版本完成时、把 HANDOFF.md 里**最老的那段**迁移到本文件顶部（保持 HANDOFF.md「最近演进」始终只留 2 个子版本）
3. 本文件**只追加、不修改既有内容**——历史是事实、不要改写
4. 本文件内子版本顺序：**时间倒序**（新在上）；同子版本内部正序（小步迭代有逻辑链、不反过来）

---

### V0.10：任务 worktree 隔离（2026-07-06 实装）

- **动机**：agent 直接在用户配置的仓库目录里干活（`local.cwd = getEffectiveCwd(repoPaths)`）——同仓两个 task 并行必互踩（checkout 互切、A 的现场被 B 掀掉）、agent 和用户本人抢同一工作区、review 指纹易被无关改动误触。这是单机并行使用的物理天花板。
- **核心模块 `src/lib/server/task-worktrees.ts`**：每 (task × 仓) 一个 `git worktree`（同一仓库数据库长出多个独立工作目录、历史/分支引用共享、HEAD/index/工作文件独立、git 原生保证同分支不能双检出）：
  - 路径 `<数据目录>/worktrees/<taskId>/<仓名>`（仓名重名加 `-2` 后缀、`getUniqueRepoDirNames` in path-utils 前后端共用）——多仓 task 的 cwd = `worktrees/<taskId>/` 公共父目录、单仓 = worktree 自身、`getTaskCwd(task)` 统一封装（非隔离 task 原样走 `getEffectiveCwd`）
  - **`ensureTaskWorktrees`（幂等）**：advance / restart 时 runner 在起 agent 前调——分支名复用 branch-template 引擎渲染（storyId 抠取抽成 `extractFeishuStoryId` 进 branch-template.ts、action-gates 同源复用）、`fetch origin <base>` best-effort（离线回退本地 base）、分支已存在则直接挂载 / 不存在 `worktree add -b`、已有 worktree 直接复用；同 task 后续 action 零成本复用
  - **建分支从 prompt 软约束升级为 harness 保证**：隔离 task 不再注 build checkout hint、`action-build.md` 准入条件按「隔离 / 原仓直跑」两模式分写；prompt 仓库段（`renderRepoSection`）对隔离 task 说明「分支已检出、别自己 checkout、缺依赖自己装」
  - **路径归一**：agent 报的是 worktree 路径、后端记录/校验要原仓路径——`resolveOriginalRepoPath` 在 submit_mr 入口归一、review 指纹 / 起点基线 / 孤儿收割走 `getTaskWorkRepoPaths(task)`
  - **清理**：task 终结（merged/abandoned）/ 删除时 `worktree remove --force` + `prune`（**任务分支保留**、reopen 可重建续推）；boot recovery 扫 `worktrees/` 下不属于存活 task 的孤儿目录清掉
  - **删前 WIP 快照保底**（全项目 bug 扫描修的 P0）：build 铁律不 commit → 未 ship 的产物只以未提交改动活在 worktree 里、`--force` 删除会连带销毁。`snapshotDirtyWorktree`：删前 `status --porcelain` 查脏、脏则 `add -A` + `commit --no-verify`（带兜底身份、绕业务仓 hooks）落 WIP 快照到任务分支——「分支保留 = 产物保留」才真成立、reopen 重建检出即无缝续推。finalize / deleteTask / boot 孤儿清理三条路径都走
  - stop-hook 的 `addGitExclude` 学会解析 worktree 的 `.git` 指针文件、exclude 写到主仓公共 git dir（解析统一走 `parseMainGitDirFromPointer`——git 在 Windows 也写正斜杠、不能用 path.sep 匹配）
  - 仓短名去重改探重循环（`getUniqueRepoDirNames`）：旧「第 N 次出现拼 -N」会跟真实目录名 `web-2` 撞车、两仓静默映射同一 worktree
- **顺手修「删任务要删两遍」老 bug**（用户实测反馈）：DELETE route 的 cancel 只是发信号、run 的 finally 迟到写 events.jsonl 会跟递归删除撞车（目录删一半 + ENOTEMPTY → 首删报错、任务内容被清空、二删才成）——route 删前 `waitForTaskToStop` + `waitForChatToStop` 等 run 真退、`deleteTask` 的 `fs.rm` 加 `maxRetries: 5` 双保险
- **三个拍板设计点**（2026-07-06 用户确认）：
  1. node_modules（untracked、不跟过来）：第一版不自动装、prompt 告知 agent 缺依赖自己 install；疼了再上 per-repo 初始化命令
  2. `.env*` 本地配置：创建时从原仓根目录拷（仅根层 `.env*` 文件、白名单 per-repo 可配留到有需求再做）
  3. 任务分支恰好被用户本人 IDE 检出：`worktree add` 失败、报错透传 UI（提示在主仓切走）、不默默降级
- **逃生口**（用户拍板「留个逃生口」）：新建任务弹窗 MCP 块下加勾选「直接在原仓库运行」、默认不勾（即默认隔离）——适合「让 agent 接着我手头现场继续干」；chat 模式恒不隔离。`Task.isolateWorktree`（新建 task 默认 true、老 task undefined 走旧路径、不写 migration）
- **V0.10.1 配套体验（同日追加、用户实测 worktree 后的三个痛点）**：
  - **node_modules 秒级克隆**（`cloneNodeModules`）：建 worktree 时原仓有 node_modules 就 APFS copy-on-write 克隆（mac `cp -Rc`、clonefile）——不走网络、秒级、磁盘块共享、postinstall 产物原样带过来（实测痛点：umi 大包重装久 + 新环境 postinstall 偶发失败导致 build 校验被 skip）。独立副本互不污染、失败静默回退 agent 自装、非 mac 跳过
  - **`Task.workCwd` 计算字段**（hydrate 时 `getTaskCwd` 算、不落盘）：client 拿 agent 实际工作目录（dataRoot 只有 server 知道）
  - **任务页工作区快捷操作条**（`workspace-actions.tsx`、路径行下方）：「在 IDE 打开」（cursor:// deep link 直开 worktree）＋「复制路径」＋「预览」
  - **单预览位**（`preview-manager.ts` + `/api/preview` + 设置页 per-repo「预览启动命令」）：全局最多一个 dev server、点任务「预览」自动停旧起新（对齐单分支心智、端口不撞）。进程组隔离（detached + kill(-pid)）、pidfile 兜底（app 重启杀残留、boot recovery 调 `killStalePreview`）、日志环形缓冲 + URL 探测（探到 localhost 地址 UI 出「打开」）。app 不理解命令语义、只执行配置
- **测试**：`tests/task-worktrees.test.ts`（纯函数、含短名撞车 / gitdir 指针解析）+ `tests/task-worktrees.integration.test.ts`（真临时 git 仓跑 ensure/remove 全流程：建/幂等/同分支冲突报错/脏工作区 WIP 快照/清理留分支/reopen 重建续接快照内容/node_modules 克隆）。typecheck / lint / vitest 160 全绿。
- ~~后续期次 ①「在 IDE 打开 worktree」按钮 ② 单预览位~~——**已在 V0.10.1 当日做完**（见上）。剩余方向：③ 飞书收件箱一期（app 内列「指派给我的 story」+ 一键建 task）→ 二期（后台轮询自动建 task + 自动跑 plan、停在 awaiting_ack 等人审）——二期自动并发建 task 恰好依赖 worktree 隔离、顺序正确

### v0.9.14：自定义 action 增强——编辑器补全 + skill 缺失兜底 + 导入导出（2026-07-03、通用化讨论落地第一批）

- **背景**：通用化方向下自定义 action 可能是非研发用户（测试 / BI）的全部工作流。走查出三块短板：编辑器可发现性差（模板变量没提示、freshAgent 有字段没 UI）、引用的 skill 别人机器没有时 agent 拿悬空引用瞎找、团队没有轻量共享路径。同轮讨论还拍板了「建任务仓库改可选、飞书 story 保留必填」——**动面大、留到下一轮单做**。
- **编辑器小改**（`custom-action-editor.tsx`）：
  - 模板变量 chips 加过又删（用户实测「不知道是干嘛的、没太大用处」）——任务标题 / 仓库路径 / artifact 目录这些上下文 super prompt 本来就有独立段落传给 agent、playbook 不需要点位引用；运行时 `{{var}}` 替换链路保留（跟内置 prompt 同一条 fillTemplate）、手写仍生效、只是不宣传
  - `freshAgent` 补开关「每次推进都用新 Agent」（字段 / API / 运行链早就支持、一直没 UI 改不了）
  - 新字段 `CustomActionDef.placeholder`（推进输入框提示、轻量参数化——告诉使用者该填什么）：fs 层 parse/serialize + POST/PATCH 入参 + advance-dialog `buildPlaceholder` custom 分支读定义、缺省回通用文案
- **skill 缺失兜底**（导入别人的定义 / 换机器场景）：
  - **agent 侧静默过滤**：`skills-loader` 新增 `listAvailableSkillNames(repoPaths)`（平台 + 全局 ∪ 各绑定仓 `.cursor/skills/`、repo 层算进来防误杀）、`loadCustomActionPlaybook` 渲染点名段前按集合过滤——缺的名字不进 prompt、agent 无感零幻觉
  - **用户侧显式提示**：/actions 页自定义行显示 skill chips（缺失的灰显划线 + tooltip「本机未找到、推进时自动跳过」）；编辑器 MultiSelect 把「已勾但本机没有」合成灰项显示（不合进 options 这些勾选会隐身）
  - 定义文件不动（换机器 / 同事装了 skill 引用又活）——机器看不见缺的、人看得见缺的、文件不动
- **导入 / 导出**（团队点对点共享、比 repo `.cursor/actions/` 层更轻、先做这个）：
  - 定义本来就是单个 md 文件（frontmatter + playbook）、天然交换格式——飞书传文件即可共享
  - **都以文件夹为单位**（用户拍板「批量就用文件夹的形式」）——导出：只有 /actions 页顶部一个入口（不做行内单个导出、同轮拍板）、先弹勾选（`export-actions-dialog.tsx`、默认全选 / 全选 checkbox 带 indeterminate、用户反馈「一键全部太糙」当轮改）、确认后原生目录 picker、每个写 `<label>.md`（重名自动 -2 后缀不覆盖）；导入：顶部「导入」、原生 picker 选文件夹、server 扫目录第一层 md 逐个解析（借 `parseDef` 清洗、不递归）、**id 一律重新生成**防撞、单文件失败不影响其余（toast 汇总）；顺带补了 `ui/checkbox.tsx` 基础组件（base-nova、项目此前没有）
  - 新路由 `POST /api/custom-actions/import`（body paths、1MB/文件上限）+ `POST /api/custom-actions/export`（body ids + dir）、绝对路径校验、信任模型同 `/api/repo-branches`（本地单用户桌面 app）
- typecheck / lint / vitest 133 全绿。repo 层 action（`.cursor/actions/` 跟仓走）暂缓、看导入导出的实际使用效果再定。

### v0.9.13：删「跑项目命令」的确定性检查（2026-07-03、用户拍板「lint / typecheck 这类删掉」）

- **背景**：用户实测「公司项目几乎全部不通过」——CheckRun 对全仓跑 typecheck / lint、存量项目基线本来就红（历史债）、agent 只改两个文件也永远红、红色失去信息量、ship 还每次都要 override 填原因。加上工具通用化方向（非研发用户）、「研发流程假设」不再成立。拍板范围 = 档 A：**删所有「跑项目命令」的检查、保留「agent 交付诚实性」检查**（artifact 落盘 / 必备段 / review 只读指纹 / MR URL 验真等全保留）。
- **删除面（types → server → API → UI 全链）**：
  - types：`CheckCommand` / `CheckCommandKind` / `CheckCommandResult` / `CheckRepoResult` / `CheckRunSummary` / `CheckOverride` / `Task.repoCheckCommands` / `RepoConfig.checkCommands` / `CustomActionDef.checkCommands` / `ActionRecord.checkRun` / `ActionRecord.checkOverride` 全删；`ShipPrecheck` 瘦身成 `{ reviewMissing }`。
  - server：`repo-check-detect.ts` 整文件删（自动检测）；`action-checks.ts` 删 `runRepoChecks` / 污染检测 / `--fix` 预判、`checkBuild` 只留 artifact 必备段 + 兄弟仓越权、`checkCustom` 只留 artifact 非空；`action-gates.ts` 删 `checkShipCheckGate`（ship override 门禁）；`task-fs.sanitizeCheckCommands` / createTask 检测链 / `addRepoCheckCommands` patch 链删；`task-fs-core` 删 `getCheckLogPaths` + meta 字段。
  - API：advance 路由删 `checkOverride` 入参、tasks 路由删 `repoCheckCommands` / `addRepoCheckCommands`、custom-actions 路由删 `checkCommands`、ship-precheck 只返 `reviewMissing`。
  - UI：`check-run-summary.tsx` / `repo-check-commands.tsx` 两组件删；repo-card 检查命令编辑区删、advance-dialog ship override 区删（reviewMissing 黄条保留）、custom-action-editor 校验命令字段删、task-display 删 `CHECK_STATUS_LABEL/VARIANT`。
- **保留**：`runActionPostCheck` 后台异步框架（runningChecks 去重 + abort、checkReview 多仓 git 指纹仍可能上秒）、`runCheckShell` / `computeWorktreeFingerprint` / `computeRepoStatusHash`（review 指纹 + 兄弟仓基线的底座）。老 task 数据里的 `checkRun` 字段读时被 schema 忽略、不写 migration。
- 质量兜底改由 build agent 自查（action-build.md「验证仓库脚本」段让 agent 增量校验、未动）+ review 人审。测试删 `sanitize-check-commands.test.ts` / `repo-check-detect.test.ts`（142 → 133 条全绿）。

### v0.9.12：推进弹窗通用化——删「更多」折叠区 + 删默认 action 推断（2026-07-03、用户拍板「工具往通用走」）

- **背景**：用户在 /actions 页关掉某 action 后、推进弹窗里它收进「更多」且（默认选中项恰好被隐藏时）自动展开——「我关了它、它反而默认展开」反直觉。讨论后用户给出更深的方向：工具要往通用走、不能假设用户是前端研发（测试 / BI 用户可能把内置 action 全关、纯用自定义）、连「按仓库状态推断默认选中哪个 action」的逻辑也不该要。
- **「更多」折叠区删**：`arrangeByLayout` 从返回 `{visible, folded}` 改为直接返回过滤后的可见数组；隐藏语义彻底化——/actions 页关掉的 action 在推进弹窗**直接不出现**、重新启用回 /actions 页开开关（行尾标签「收进『更多』」→「已隐藏」）。
- **默认 action 推断删**：`inferDefaultActionType`（repoStatus 映射 + plan→build→review→ship 顺推）整套删了。默认选中 = **混排可见列表第一位**（用户自己拖的顺序、无业务假设；第一位是自定义 action 也能选中——open-effect 经 `customActionsRef` 读缓存、首次打开列表未拉到时只在内置里选、拉完不追改防跳变）。
- **全部隐藏的空态**：`actionType` 放宽为 `ActionType | null`（null = 无选中、canSubmit 拦）、chips 区显示 EmptyHint 引导去 /actions 页开启或新建。

### v0.9.11：续用 Agent 默认值可配 + 仓库分支字段 Combobox 化（2026-07-03）

- **「续用当前 Agent」默认值可配**：设置页原「提交快捷键」卡扩成**「交互偏好」卡**（`preference-card.tsx`、shortcut-card 删）、加开关「推进时默认续用当前 Agent」（`FeAiFlowSettings.reuseAgentDefault`、默认 false = 保持每 action 新 agent）。advance-dialog 打开时从 settings 读初始勾选、dialog 内仍可临时切；review 强起新 agent 的 server 铁律不受影响。
- **仓库分支字段 → git 分支下拉 + 搜索**：设置页仓库卡的线上 / 测试 / dev 分支、新建 / 编辑任务 dialog 的「已有工作分支」、全部从手填 Input 换成新抽的 `Combobox`（`ui/combobox.tsx`、可搜索 + 可清空 + 列表缺分支时手填兜底「使用 "xxx"」项）。
  - server：`git-branches.ts` 加 `listRepoBranches(dir)`——`for-each-ref refs/heads refs/remotes` 一条命令混列本地 + 远端（去 remote 前缀 / 滤 origin/HEAD / 去重、按最近提交倒序）、不主动 fetch；新只读路由 `GET /api/repo-branches?path=`（设置页配仓时 task 还不存在、按前端传路径查、仅 400 拦非绝对路径）。
  - client：`useRepoBranches(paths)` 批量 hook（行都是 map 渲染的、顶层调一次行内查）——`undefined`=拉取中（先禁用）、`isRepo:false`=非 git（保持禁用、placeholder 提示「非 git 仓库」）、git 仓自动放开。
  - repo-card 分支三字段由「草稿 + blur 落盘」改为选中即落盘（离散选择）；分支模板覆盖字段不是分支名、保持 Input。

### v0.9.10：去掉 Dock 角标（2026-07-02、用户实测反馈）

- **动机**：v0.9.5 加的 Dock 角标 = 「等待回复任务数」、用户实测两点不满：① 点开任务看了、角标还常驻不消（等待语义 ≠ 用户期望的未读语义）；② 「只看 icon 上的角标作用也不大」——进 app 后还是不知道哪个任务在等。讨论过「未读语义 + 顶栏 chip」方案、用户拍板**直接去掉角标**、注意力提醒收敛到系统通知（点击跳任务、这个保留）+ 侧栏琥珀脉冲点。
- 删干净三层：`task-attention-watcher.tsx` 的 setAttentionBadge 调用、`shell-notify.ts` 的 setBadge 封装、`preload.cjs` + `main.js` 的 `set-attention-badge` IPC。

### v0.9.9：task-fs.ts 拆出 core + artifacts（2026-07-02、代码健康度重构第三轮）

- **动机**：`task-fs.ts` ~1850 行（重构后仓库第一大文件）、「路径/schema/锁/事件 IO 底座」「artifact/附件读写」「boot recovery + CRUD + meta patch API」三个切面糊在一起。ROADMAP 代码健康度项收尾。
- **原则同前两轮：纯搬家零逻辑变更**（归一化 diff 核验：仅 `taskDir` 一处换行格式差异、零逻辑差异）。拆完 task-fs 1181 行、task-fs-core 462 行、task-artifacts 302 行。
- **`task-fs-core.ts`（新、底座层）**：数据目录路径常量 + `newTaskId`/`newActionId` 等 id 生成 + 路径 helper（events.jsonl / actions/ / artifact / check log）、`TaskMetaV06` 类型 + zod schema + `readMetaV06`/`writeMeta` 原子读写、`withTaskLock` per-task mutex（globalThis、拆文件不拆状态）、事件流 IO（`readEvents`/`readRecentEvents`/`appendEventLine`）、`hydrateTask`/`hydrateTaskSummary`。**只依赖 types / data-root、不回 import task-fs / task-artifacts**。
- **`task-artifacts.ts`（新、artifact/附件层）**：`saveImageAttachments`（uploads/）、`readCurrentActionArtifact`、revisions 快照（`snapshotActionArtifact`/`listActionRevisions`/`readActionRevisionContent`）、划除挪移（`setActionArtifactExcluded`、`.excluded/` 物理挪移）。只依赖 core。
- **`task-fs.ts`（瘦身后）**：boot recovery + 公开 CRUD（list / get / create / delete）+ `sanitizeCheckCommands` + `appendEvent`（节流）+ 上下文文档 + 各类 meta patch API（setTaskXxx / appendAction / patchAction / upsertMR 等）。
- **引用方改指向、无 re-export barrel**：路径 helper / `readRecentEvents` 用方（action-checks / chat-mcp / chat-runner / task-prompts）改 `task-fs-core`；`saveImageAttachments` / revisions / 划除用方（action-ack / ask-reply / chat-reply / advance / context-docs / action-diff / action-exclude / action-revisions 路由、route-helpers、task-runner 的 snapshot）改 `task-artifacts`；CRUD / patch API 仍从 `task-fs`。
- 验证：typecheck + lint 全绿、vitest 142 全过；完整三步打 test 包、boot 200、任务列表 / 任务详情（core hydrate 链路）+ action-revisions（artifacts 层）冒烟正常。
- 代码健康度三轮重构（task-runner → chat-mcp → task-fs）至此收尾、仓库不再有 >1700 行的 server 文件。

### v0.9.8：chat-mcp.ts 拆出 chat-pending（2026-07-02、代码健康度重构第二轮）

- **动机**：`chat-mcp.ts` ~1970 行（仓库第二大文件）、「pending 等待状态机 + 信号 API」和「MCP server 工具注册 + transport」两个切面糊在一起；routes（wait-ack / ask-reply / chat-reply / action-ack 等）本只依赖前者、却都 import 整个 MCP server 模块。
- **原则同 v0.9.7：纯搬家零逻辑变更**（归一化 diff 核验：除 import 重排外零差异）。拆完 chat-mcp 949 行、chat-pending 1049 行。
- **`chat-pending.ts`（新）**：pending 等待状态机 + 信号 API——`ToolReturn`/`PendingEntry`/`AwaitingSignal`/`ChatTaskAction` 协议类型、globalThis 全局状态（`GLOBAL_KEY` V12 不变、**拆文件不拆状态**）、`registerPendingEntry`/`subscribeWaitAck`/`finalizeEntry`（grace 60s）、`formatToolReturnAsText`、notifier / taskActionHandler 注册表、`submitUserMessage`/`submitAskReply`/`submitActionAck`/`submitNextAction`/`submitTaskTerminate`/`cancelPending`/`cleanupChatTaskState` 等信号 API。**只依赖 types / protocol-signals / wait-protocol-prompt、不回 import chat-mcp / task-runner**。
- **`chat-mcp.ts`（瘦身后）**：MCP server 本体——`buildMcpServer`（五工具注册：wait_for_user / ask_user / submit_mr / set_feishu_testers / set_plan_batches）、`buildShellWaitGuidance`、premature chat wait 兜底检测（跟 wait_for_user handler 强耦合、留这边）、session transport + `handleChatMcpRequest`、`getChatMcpUrl`。
- **引用方改指向**：task-runner / chat-runner / submit-mr-guard / wait-ack / ask-reply / chat-reply / action-ack / stop / tasks[id] 路由的等待状态相关 import 全改 `chat-pending`；`getChatMcpUrl`（chat-runner / task-runner）和 `handleChatMcpRequest`（chat-tool 路由）仍从 `chat-mcp`。无 re-export barrel。
- 验证：typecheck + lint 全绿、vitest 142 全过；完整三步打 test 包、boot 200、MCP initialize + tools/list 五工具齐、wait_for_user 注册 pending → wait-ack 长连接认 token + KEEPALIVE 正常。
- `task-fs.ts`（1851 行）留下一轮。

### v0.9.7：task-runner.ts 拆分四模块（2026-07-02、代码健康度重构第一轮）

- **动机**：`task-runner.ts` 长到 ~2950 行（仓库第一大文件）、prompt 拼装 / 门禁判定 / 流事件底座 / SDK 消息翻译 / 编排全糊在一起、改任何一块都要在 3000 行里找。ROADMAP 代码健康度项。
- **原则：纯搬家零逻辑变更**——按切面把代码原样搬到新模块、只动 import/export、不改任何行为（归一化 diff 核验过：除 log 前缀 `[task-runner]`→`[task-stream]` 外零逻辑差异）。拆完 task-runner 1650 行、只留「编排」。
- **四个新模块（依赖方向单向、无环、都不回 import task-runner）**：
  - `task-stream.ts`（~190 行）：流事件协议类型（`TaskStreamEvent`）+ publish/subscribe + `writeEventAndPublish` + 进程全局状态（`runningTasks`/`subscribers`/`forkPendingTasks`/`runningChecks` 挂 globalThis）+ `truncate`/`stringifyMeta` 小工具 + `waitForTaskToStop`/`forceClearStaleRunnerState`。chat-runner / 各路由的 `publishTaskStreamEvent`/`subscribeTaskStream` 改从这里 import。
  - `task-prompts.ts`（~620 行、纯函数）：模板渲染（fillTemplate / loadActionPrompt）+ `buildSuperPrompt` + `[NEXT_ACTION]` directive 全家（batch / reviewScope / replan / dev）+ `buildRestartActionInstruction` + 任务字段热更快照 diff（`TaskFieldsSnapshot`/`buildTaskUpdateHint`）。
  - `action-gates.ts`（~400 行、纯函数）：`checkActionPrerequisites`（准入门槛 1）+ `checkShipCheckGate`/`getShipPrecheck`（ship CheckRun 门禁）+ `planBranchesForBuild`（build 分支规划 + idempotent checkout hint）。ship-precheck 路由改从这里 import。
  - `sdk-message-handler.ts`（~200 行）：`handleSdkMessage`（SDKMessage → 事件流翻译、artifact 写入检测 / wait_for_user 特判）+ `AssistantBufferCtx`。
- **保守决策**：`internalStartAgent`（含 submit_mr handler / awaitingNotifier / run 消息循环闭包）耦合太深**不拆**、留在 runner；`chat-mcp.ts` / `task-fs.ts` 留后续轮次。task-runner 保留全部对外 API（advance / restart / ack / finalize / reopen / cancel / abortRunningCheck / findTaskIdByAgentId / supersedePendingAsks）、routes 只有 stream / gates 相关 import 改了指向、无 re-export barrel。
- 验证：typecheck + lint 全绿、vitest 142 全过；完整三步打 test 包（grep 核验新代码标记在包内）、boot 200、ship-precheck（走 action-gates）+ watch-task SSE（走 task-stream）冒烟正常。

### v0.9.6：旧 ask 弹窗误杀任务修复 + win 标题栏色差（2026-07-02、同事实测反馈三连）

- **旧提问弹窗复活 → 误杀任务（图 1 报障根因链）**：agent 先后发两组 ask（重问 / 断线重挂）时 pendingMap 单例被新 ask 顶掉、但旧 ask 事件没标作废 → 前端「倒序找第一条未了结」把答完新弹窗后的旧弹窗复活 → 用户答旧弹窗、token 已死 → ask-reply 僵尸判定把 `runStatus=running`（AI 明明在跑）也当僵尸、写「Agent 已断开」+ 任务标 error + 发 done 关流。修三层：
  - **根因**（`task-runner` awaitingNotifier）：写新 `ask_user_request` 前先 `supersedePendingAsks(taskId, "被新提问顶替")`——旧弹窗自动关、不再出现两个弹窗。
  - **前端防御**（`ask-pending.findPendingAskEvent`）：改「只看最新一条 ask」——最新已了结直接 null、旧的未了结 ask 永不复活（pending 单例、旧 token 必死；顺带救活存量脏数据任务）。补回归单测。
  - **服务端兜底**（ask-reply 路由）：僵尸判定收窄——`hasPending(task) || runStatus==="running"`（被顶替 / AI 在跑）→ 只补 `supersededAskId` 作废标记 + 409 温和提示、**不标 error 不关流**；真僵尸（`awaiting_user` 且全无 pending）维持原 410 + error。判定前重读 task 防 retry sleep 期间状态漂移。
- **重启按钮报「请用再聊聊」（图 2、是图 1 的下游）**：误杀关流后页面停在旧快照（action=running + runStatus=error）→ 重启按钮误亮、点时服务端 action 实际已 awaiting_ack → 被闸拒。修根因后主链路消失；另加自愈——重启失败 catch 里 `refresh()` 重拉任务对齐真实状态。
- **win 右上角窗口控制按钮底色不一致**：写死 hex 跟主题真实背景对不上——深色 `--background` = oklch(0.17 0.005 264) 精确换算 `#0e0f12`、代码写的 `#17181c` 偏亮一截。修 `main.js`（HEADER_BG_* + LOADING_BG_* 一并对齐）+ `app-header.tsx`（TITLEBAR_OVERLAY_COLOR）为精确换算值（深 `#0e0f12` / 浅 `#f3f4f5`）、注释钉住「改主题色两处要一起换算」。
- 事件流 ask 卡片失效文案「这组提问已失效（断线重启）」→「这组提问已失效」（作废原因已多于断线重启一种、具体原因看相邻 info 事件）。
- 验证：typecheck + lint 全绿、vitest 142 全过（含新回归用例）；test 包实测——伪造「两组未了结 ask + running」现场答旧弹窗 → 409「这组提问已失效、AI 已继续工作」+ runStatus 保持 running + 补作废标记；真僵尸场景 → 410 + error（行为不变）。

### v0.9.5：任务注意力系统通知 + Dock 角标（2026-07-02）

- **痛点**：agent 停在「等你回复」（action 跑完等 ack / ask_user 提问 / chat 回复完）时只有侧栏琥珀脉冲点、app 不在前台完全看不见——任务一跑几分钟到几十分钟、用户切去干别的、回来才发现 AI 早就停那等了。
- **壳侧**（`electron-app/main.js` + `preload.cjs`）：新增两条 IPC——`task-notify`（Electron `Notification`、点通知聚焦窗口 + `webContents.send("task-notify-click", taskId)` 回传）+ `set-attention-badge`（`app.setBadgeCount`、mac Dock 数字角标 / win 任务栏退化小圆点）；win 补 `app.setAppUserModelId`（跟 electron-builder appId 一致、否则 win 通知不归属本 app）。preload 暴露 `window.__notify = { send, setBadge, onNotifyClick }`。
- **页面侧**：`src/lib/shell-notify.ts`（封装、非桌面端静默降级、不像 picker 那样 toast——通知是被动增强）+ `src/components/task-attention-watcher.tsx`（挂 `providers.tsx` 的 TaskListProvider 内）。盯 `useTaskList` 列表（有任务跑时本就 2s 条件轮询、零新增请求）：**转变沿检测**——某任务 runStatus 从非 awaiting 转入 `awaiting_user` 才通知、mount 首轮只建基线不补发（陈旧噪声）；**前台抑制**——`document.hasFocus()` 时不发系统通知（用户正看着、侧栏琥珀点已够）；**error 不通知**（同侧栏决策：long-poll 超时几乎必 error、通知反而噪声）。角标 = awaiting_user 任务数、每次列表刷新同步、0 清空。通知正文按形态给一句话（chat「AI 已回复」/ awaiting_ack「『出方案』已完成、等你确认」/ 兜底「AI 在等你回复」）；点通知 → 壳聚焦窗口 → watcher `router.push(/tasks/<id>)` 跳详情页。
- 验证：typecheck + lint + vitest 141 全过；test 包实测——模拟 running→awaiting_user 转变系统横幅弹出、AXPress 点横幅 app 聚焦并跳到对应任务详情页、Dock 角标 1→2→清零（`lsappinfo` StatusLabel 核验）。mac 首次通知会弹系统权限横幅、用户允许一次即可。

### v0.9.0：自定义 Action + 推进面板布局可配置（2026-06-26）

- **自定义 Action（新 action 类型 `custom`）**：把 skill / playbook / 后置 check 串联封装成一个 action、在任务「推进」里像内置一样选（**不单独给 action 配 MCP——用 task 现有的、避免与 task 级 MCP 冲突**、用户拍板）。定义存 `dataRoot()/custom-actions/<id>.md`（gray-matter frontmatter 存 label/summary/skills/checkCommands/freshAgent + 正文 playbook）；`ActionType` 加 `"custom"`、`ActionRecord.customActionId/customLabel` 链定义；运行时 `task-runner` `loadActionPrompt` 走自定义 playbook、freshAgent / label 取 customDef、`checkActionPrerequisites` + `action-checks` 加 custom 分支（artifact 存在 + 跑用户配的 checkCommands）。管理页 `/actions`（列表 + `CustomActionEditor`、复用 `MultiSelect` 选 skill + `RepoCheckCommands` 配 check）；`_super.md` 的 `[NEXT_ACTION]` 协议头放行 `custom`。**关键修复**：`task-fs` 的 `ActionRecordLooseSchema` 必须放行 `"custom"`（`z.enum([...ACTION_TYPES, "custom"])`）——否则推过 custom 的 task `meta.json` 校验不过、`getTask` 返 null → 整个 task 读不了（404）、是首发数据损坏 bug。
- **推进面板布局可配置**：内置 + 自定义 action 在「推进」弹窗的顺序 + 显隐个人级可配、落 `settings.actionLayout`（config.json、`{order, hidden}`）。`/actions` 页加「推进面板布局」区——**拖拽排序（`framer-motion` Reorder、只手柄发起拖、松手才落盘防狂写）** + 开关控显隐、内置 / 自定义**混排**（自定义带扳手 `Wrench` 角标区分）。推进弹窗按偏好排（`arrangeByLayout`）、隐藏的收进「更多」可展开、默认选中项被隐藏时自动展开。排序纯函数 `src/lib/action-layout.ts`（`BUILTIN_ADVANCE_ACTIONS` / `sortByOrder` / `arrangeByLayout` / `isBuiltinAdvanceAction`）配置页 + 弹窗单一源。
- **（v0.9.1）win/mac 自动更新 UX 对齐**：win 之前 `electron-updater` `autoDownload=true`（检查到就后台偷偷下、下载完才点亮右上角「新版本」标识）、mac 是「检查到立即点亮、点按钮才下载」——两端不一致、且「发现新版本」toast 都说「随时点右上角新版本」但 win 当时标识根本没亮（用户反馈）。改：win 也 `autoDownload=false`（新 `ensureWinAutoUpdater` 懒加载单例统一管 `autoDownload` + `download-progress` 任务栏进度条 + `update-downloaded` 弹「立即重启」+ `error`、只注册一次防监听器泄漏），`runUpdateCheck` / `manualCheckForUpdate` 两端逻辑对齐（只查「有没有新版」不下载、查到立即 `notifyPageUpdateReady` 点亮标识 + 弹一次框、区别仅查版本号方式 win=`checkForUpdates` / mac=`fetchLatestVersion`），`installUpdateNow` win 分支点按钮才 `downloadUpdate`。`update-badge.tsx` 去掉 `__appUpdateMode` 分支、win/mac 共用「下载并安装更新、完成后会提示重启、数据不丢」一套文案。
- **（v0.9.2）受控放开 custom action 建线上 MR**：自定义 action 需把 feature 提到该仓 base（线上/基线）分支、但 `submit-mr-guard` 原两道闸挡死（只认 ship/dev type + target 一律禁 master）。改「受控放开」：闸 2 放行 `type==="custom"`、闸 3 对 custom 把 target 校验成该仓 `repoBaseBranches[repoPath]`（**仅放行这一个值、非任意分支**）；其余越权防线全不动（仓范围 / project 对真实 remote / source 必须 feature；ship/dev 校验完全不变、仍禁提 master）。`task-runner` handler 加 `isCustomSubmit`——custom 提 MR 跟 dev 一样 source(feature) 绝不删、失败事件「提测失败」泛化「提 MR 失败」。`chat-mcp` submit_mr describe 补 custom。冲突复用 ship `__conflict` 智能解（ask_user 选 AI 解 / 自己解、基于 base 另建分支 merge、feature 不动）。**逻辑全按 `action.type==="custom"` 判、对所有自定义 action 一视同仁、零具体 action 特判**。typecheck/lint/vitest 139 全过。
- **（v0.9.3）措辞统一「线上分支」+ 自定义 action 编辑入口可发现性**：① 把「base（线上/基线）分支」措辞在 `submit-mr-guard` 报错 + `chat-mcp` submit_mr describe 全统一成「线上分支」（跟设置页 `onlineBranch` + super prompt `renderRepoBranchSection` 一致、用户/agent 看报错不再被「base」绕、纯文案 0 逻辑改动）。② `/actions` 页合并成「Action 管理」单列表（去掉原上方独立的自定义 action 卡片列表）——内置 + 自定义混排在原「推进面板布局」那一个列表里统一管：拖拽排序 + 显隐开关不变、自定义行额外加编辑 / 删除按钮（内置不可改不可删、`ActionLayoutConfig` 新增 `onEdit/onDelete` props）。一个地方管完顺序 / 显隐 / 增删改。typecheck/lint/vitest 139 全过。
- **（v0.9.4）custom action 的 MR target 完全放开（任意分支）**：v0.9.2「受控放开」只给 custom 开了「该仓线上分支」一个口、写死 `target===repoBaseBranches[repoPath]`——但 custom 是用户自定义的、写死一个分支限制了灵活性（想做个提到 test 的 custom action 直接被拦、用户反馈「没必要拦、不然以后没法做针对 test 的自定义 action」）。改：`submit-mr-guard` 闸 3 对 `type==="custom"` **整段跳过 target 校验**（ship/dev 仍写死目标分支、原语义完全不变、仍禁提 master）、闸 4 退化兜底的「source≠目标」从 `expectedTarget` 改用 `a.targetBranch`（expectedTarget 收进 if 块、对所有类型都直接拿上报 target 判）。**越权安全不降级**——仓范围（闸1）/ source 必须 feature（闸4）/ project 对真实 remote（闸5）三道全留着；target 提到的是「本仓内」分支（test / 线上 / dev / release 都行）、同 project 内不构成越权。custom 不再依赖 `repoBaseBranches`（没配也能提）。配套 `chat-mcp` submit_mr describe + `task-runner` 注释改成「custom 提哪个分支由该 action 的 playbook 决定」。typecheck/lint/vitest 141 全过（custom 用例从「只放线上、否则拒」改成「任意分支放行」+ 补仓范围约束）。
- 验证：typecheck + lint 全绿、vitest 141 全过；打 test 包核验自定义 action 推进 + 拖拽 / 混排 UI 进包。

### v0.8.23：联调（dev）action + 分支配置同步 + 去「通过」按钮隐式认可 + task 做完给结论（2026-06-25）

- **联调（dev）action 落地**（新 action 类型、把改动送 dev 分支触发联调流水线）：advance-dialog 选两种推送方式、`buildDevDirective` 把 `[DEV_PUSH_MODE]` 钉进 `[NEXT_ACTION]` 载荷——① **直推**：本地基于 `origin/<dev>` `checkout -B` 重置本地 dev、`merge --no-ff` 把 feature 合进来、`push origin dev:dev`（feature 全程不动、绝不 force）；② **提 PR**：push feature + 复用 ship 的 `submit_mr`（唯一区别 `target_branch` = dev 分支）。冲突处理两模式共用（直推在本地 dev 就地解 / 提 PR 走 `<feature>__conflict` 一次性分支、同 ship §3.6）。准入 = 至少一仓配 dev 分支（技术必需、没配不知推哪）；`checkDev` 直推无 MR 信任 artifact、提 PR 复用 ship 门禁（URL 非空 + 冲突拦）。**联调源分支绝不删**（`isDevSubmit ? false`、合入后还要继续开发/提测）。配套 `prompts/action-dev.md` + `chat-mcp` submit_mr describe 泛化 ship/dev。
- **MR 数据模型扩展 targetBranch**（同仓提测 MR→test 和联调 MR→dev 并存）：`MRRecord.targetBranch` + `ActionRecord.sideEffects.mrs[].targetBranch`、`upsertMR` 去重键从 `repoPath` 改 `(repoPath, targetBranch)`——各自累计 version、各自关旧 MR、互不覆盖；老记录缺字段 → `mrTargetBranchOf` 兜底该仓测试分支、跟新提测 MR 正确合并不撞联调。`mrTargetBranchOf` / `mrKindOf`（判提测/联调）下沉 `task-display.ts` 前后端单一源；详情页 MR 链接标「提测/联调 → 目标分支」badge。
- **分支配置同步（A 方案、治「设置页改了老 task 用不上」）**：建 task 时 base/test/dev 分支从设置页快照固化、后改不影响老 task。改：推进时 client（`page.tsx handleAdvance`）带本 task 各仓设置页最新 base/test/dev 分支 → `advance/route` sanitize 透传 → `advanceTask` 起 agent 注入前调 `refreshRepoBranches`（task-fs、upsert：只覆盖「绑了的仓 + 传来非空」、没传/空保留、防误清）刷 task 快照（放在准入 + appendAction + renderRepoBranchSection 之前、否则用旧快照）。advance-dialog 联调 chip 准入读设置页**实时** dev 分支（`liveDevBranches`、dialog 打开瞬间读、同 gitConfig 套路）不被旧快照挡。**limitation**：reuseAgent 续接时 super prompt「仓库分支配置」段仍是起 agent 时旧值（一次性注入）——但 server `submit-mr-guard` 用 task 最新值兜底校验、推不错分支；联调默认起新 agent、极边缘。
- **去掉「通过」按钮 + 推进隐式认可**（HITL 不变、少一次点击）：详情页删「通过」按钮、只留「再聊聊」；`advanceTask` 推进时若当前 action 还 `awaiting_ack` 先隐式认可（续接走 `acknowledgeAction(approve)`、force-new/无活 agent 走 `patchAction(completed)` + 写审计事件、认可后重读 task 供准入），放在准入前；`canAdvance` 去掉 `!canAck` 限制、`inferDefaultActionType` 把 `awaiting_ack` 也算「这步做完」（build 刚完点推进默认顺推 review）。配 `setTaskAwaitingIfIdle`（task-fs、锁内 compare-set）防 force-new 秒推 race 把 running 覆盖回 awaiting_user（僵尸组合、推进按钮误亮）。
- **task 做完给 1-3 句结论（结论方案 A）**：`_super.md` + `action-build/plan/dev.md` 把「写完 artifact 沉默调 wait_for_user」改成「写完 artifact 先流式输出 1-3 句简短结论（改了什么 / 结果 / 有无遗留）→ 紧跟 wait_for_user」。精准区分三场景：写完 artifact 收尾**给**结论 / 拿 `[ACTION_ACK approve]` 后等下一 action **不** narrate / 调 ask_user 前**不**前置消息。复用 chat 已验证的 text-delta 流式管道、零渲染改动。
- **去 review/ship/learn 流程前置、留技术前置**：`checkActionPrerequisites` + `inferDisabledReason` 删「review/ship 必须先 build」「learn 必须先有 completed action」——可直接 review 现状找 bug / 没改动直接 ship（agent 自报工作区干净）/ 空 task learn 自说明；保留 ship gitHost+token、dev 至少一仓配 dev 分支（技术必需、非流程）。
- **push 同名分支修复（--no-track）**：build checkout feature 改 `git checkout -b <feature> --no-track "origin/$BASE"`——堵 git `autoSetupMerge=true` 默认把 feature 的 upstream 设成 `origin/<线上>`、导致后续裸 `git push` 误推线上分支（后端同事踩过、其线上分支名跟前端不同）；同名 upstream 由 ship 首次 `git push -u origin <feature>` 自然建立、build 不主动 unset（不打扰用户手动设的同名 upstream）。
- **restart ask_user 给「上次进展」背景**：阶段重启时 ask_user question 不写死固定句、要 agent 基于事件日志 + artifact + 工作区半成品先 1-2 句说清「上次断到哪、在做啥」再接确认问句（重启间隔久 / 换人接手常忘进度）。
- **（v0.8.24）推进 dialog action 顺序**：联调（dev）chip 排到提测（ship）前——工作流先联调推 develop、再提测推测试分支。
- 验证：typecheck + lint 全绿、vitest 135 全过（submit-mr-guard 加 dev 用例）；打 test 包核验联调 UI + 分支同步透传进包。

### v0.8.22：自由对话回归 text-delta 流式（M/C' 范式）+ 后置 check 跳过 --fix/--write 类命令（2026-06-24）

- **自由对话回归流式（M/C' 范式、替代 V0.8.21 的 message 范式）**：原 message 范式把整篇回复正文塞进 `wait_for_user` 的 `message` 参数让 composer「先产出再挂等」（治提前挂等）、但工具参数**不流式**、用户要等一次性 flush 才看到全部。调研实证 SDK 不发 partial-tool-call（5 轮探针、`message` 无法增量流式）。改回：**正文直接走 text-delta 通道输出**（天然逐字流式、`case "assistant"` 实时展示）、`wait_for_user.message` 改填**一句话概括**（给历史 / 标题、不展示给用户）、纯做「逼 composer 先产出正文再挂等」的钩子。premature 兜底相应改为：message 非空（声明已回复）→ 清计数放行；message 空 → 读 events 判（仅「用户在等 + 本轮没 stream 出正文」才拦）。删 `chat_message` 派发整套（`AwaitingSignal` 类型 / `safeNotifyChatMessage` / handler 调用 / chat-runner 展示分支 / task-runner 防御）。**task 模式零影响**：新逻辑全包在 `chatModeTasks.has(task_id) && !action_id` 内、task 永不在 `chatModeTasks`（仅 chat-runner `markTaskAsChat` 写入）；改的 4 个 prompt 片段（`chatWaitProtocolSection` / `chatShellWaitGuideBody` / `replyThenWaitReminder` / `firstTurnReplyThenWaitReminder`）全 chat 专用、task 用的 `waitDisciplineSection` 没动；`wait_for_user` describe 里 task 的硬性规则段一字未改。
- **后置 check 跳过会改写工作区的命令（--fix/--write 类）**：lint 脚本带 `--fix`（`ng lint --fix=true` / `eslint --fix` / `prettier --write`）当 check 跑有两坑（线上 cp-admin 踩过）：① 偷改源码污染工作区、被 `mutatedWorktree` 事后判 failed（误红）；② 用户本地开着 dev server（`ng serve` / `vite` watch）时、lint --fix 跑的几十秒里连环改文件 → dev 连环热重载、终端「一直重启」。新增 `isMutatingScript`（`repo-check-detect.ts`、识别 --fix/--write/--apply、negative-lookahead 排除 --fix-dry-run）+ `willCommandMutateWorktree`（`action-checks.ts`、解析 `<pm> run <script>` 的 package.json script 体、识破藏在 script 内的 fix flag）。检测层（过滤新建 task auto-detect）+ 执行层（拦存量 task 已固化命令）双重拦截、跳过记 `skipped` + 原因、不计入 failed（聚合用 `executed` 排除 skipped、全跳过退回 dirty 判定记 not_configured）。UI（`check-run-summary.tsx`）配了命令但全跳过显示「会改写源码、已跳过」。
- 验证：typecheck + lint 全绿；打包 test 探针实测 ✅ composer 完整正文走 text-delta（1102 chunk）、概括进 message；用户简单跑过。

### v0.8.21：兼容 stdio 命令方式配置的飞书 MCP——新建任务校验不再只认 url（2026-06-24）

- **问题**：同事用 `npx @lark-project/mcp --domain https://project.feishu.cn` 这种 stdio 命令方式配飞书项目 MCP（无 `url` 字段、域名在 args、token 在 env）、task 新建弹窗旧校验只看 `"url" in cfg` → 误判飞书 MCP 未配置、创建按钮一直置灰。
- **改法**（`new-task-dialog.tsx`）：飞书 MCP 校验从「只扫 url 字段」改为新增 `collectMcpHaystack`——把单个 server 配置里 `url + command + args + env 值`全拼成一段、按域名（`mcp.feishu.cn` / `project.feishu.cn`）substring 匹配。两种配法都兼容：① url 远程型（域名在 url）；② stdio 命令型（域名藏 command/args/env）。按域名认、不认 key 名。

### v0.8.20：chat 体验三处打磨——工作目录 Open Recent picker + 对话重命名 + 模型 1M 去「按量计费」（2026-06-23）

- **工作目录选择器（chat footer）改 Open Recent 模式**：原来点开下拉只有一个「选择文件夹」按钮、等于空壳多一步（用户实测嫌赘）。抄 codex / Cursor Agents / VS Code 共识：点开 = 顶部当前完整路径（不截断）+「最近」用过的目录一键切换 +「浏览…」选新目录 +「改用主目录」重置。最近目录走 `src/lib/recent-workdirs.ts`（localStorage MRU、去重 + 上限 5、纯本地便利、不进 config.json）。
- **chat 对话重命名**：chat 模式去掉新建弹窗后没了改名入口、在 `chat-view.tsx` 顶部标题旁加 ghost 铅笔按钮、走 `useDialog().prompt` → 复用 `updateTaskFields(id, { title })` 落盘。
- **模型选 1M 去掉「（MAX、按量计费）」后缀**（`model-select.tsx`）：用户实测是没用的废话、删 `renderParamValue` 里 context=1m 的特判（顺手清掉不再用的 `p` 参数 + 2 个调用处）。
- 验证：typecheck + lint 全绿；test 包重打 + 核验（chunk hash 变、MRU key +「浏览…」在新包里）。

### v0.8.19：auto-detect 跳过 watch 模式脚本、从源头防 typecheck 当 check 卡死（2026-06-22）

- **背景（接 v0.8.18 同一次排查）**：v0.8.18 根因之一是 cp-haomao 的 `"tsc": "node_modules/typescript/bin/tsc -w"`（watch 模式）被自动检测当 typecheck check 拉进来——watch 永不退出、必撞满 120s timeout（meta.json 实证三次 build 全 timed_out ~120s）。v0.8.18 治了「check 卡死 wait_for_user」的架构层；本版从源头治「别把 watch 脚本当 check」。
- **改法（不动正常脚本既有行为、只在脚本是 watch 时走兜底）**：`repo-check-detect.ts` 新增 `isWatchScript`（识别独立 `-w`/`--watch` token、词边界、不误伤 `--ext .tsx`/`--noEmit`）。① 选中的 typecheck 脚本是 watch → 不用脚本、兜底跑一次性 `npx tsc --noEmit` 且 `required:false`（我们替换猜的命令、降级只展示不挡 ship、沿用本模块「宁可少挡不误挡」哲学）；② lint 脚本是 watch → 直接跳过。**正常（非 watch）脚本逐字不变**。
- **影响面（零碰线上已有）**：auto-detect 唯一调用点是 `task-fs.createTask`、**只在建 task 时跑、只影响新建 task**、对线上已有 task 零影响（快照不动）；已踩坑的老 task 需在设置页手动覆盖该仓 typecheck 为 `tsc --noEmit` 或重建。
- 验证：typecheck + lint 全绿、vitest **132 全过**（新增 `tests/repo-check-detect.test.ts`：isWatchScript 正反用例 + cp-haomao 真实案例）。

### v0.8.18：build 后置 CheckRun 改后台异步、修 wait_for_user 被 check 阻塞超时（2026-06-22）

- **问题（线上 task t_…vcft9c 实测）**：agent 调用顺序错乱——「先报完成又继续思考做事」、甚至「不调 wait_for_user」。事件流见 wait_for_user 反复超时、agent 瞎编不存在的 `/wait` 端点 + read events 自救、「Action 产出完成」事件重复刷且跨 action 边界冒出（act_4 的 check 在 act_5 运行期间才落、状态交错）。
- **根因**：build 的后置 CheckRun（用户配的 lint/typecheck、可达 120s）以前在 `awaitingNotifier` 里被 `wait_for_user` MCP 工具**同步 await**（工具 handler → safeNotifyAwaiting → notifier → runActionCheck）。于是 agent 调 wait_for_user 后工具阻塞到 check 跑完才返回、超过 Cursor SDK ~60s 工具超时 → agent 收到「wait_for_user 失败」乱来。对照组 `ask_user` 不跑 check、秒回成功 → agent 误以为只有 ask_user 能用。
- **修法（治本）**：① 后置 check 改**后台异步**（`runActionPostCheck`、task-runner）——notifier 立即返回、agent 的 wait_for_user 秒回引导、第一时间挂 curl long-poll 等 ack；check 在后台跑、跑完再落 postCheck/checkRun + 切 awaiting_ack + 发「产出完成」事件。② `AbortSignal` 贯穿 `runActionCheck → checkBuild → runRepoChecks → runCheckShell`、停止 / 推进 / 重启 / 删除时 `abortRunningCheck` 杀掉 lint/typecheck 子进程树（不让它空跑几分钟）。③ 去重 + 防交错：一个 task 同时只一个在跑的 check（`runningChecks` map）、新一轮 wait 顶替旧的用最新代码重跑；check 落状态前两道校验「仍是当前 check（未被 abort/顶替）+ action 仍 running」、否则丢弃结果不写状态不发事件（根治「旧 action 的 check 在新 action 期间冒『产出完成』」）。
- 遗留（未动）：「不 ack 直接推进新 action」时旧 action 停在 running 僵尸态——原本就在、不影响新 action、待后续评估是否在推进时标 cancelled。
- 验证：typecheck + lint 全绿、vitest 130 全过。

### v0.8.17：修断线重启「多弹窗并发 + 死循环」+ ask 断点续传（2026-06-22）

- **问题（用户实测）**：agent 正 `ask_user` 提问时网络断开、用户点「重启当前阶段」→ 仨弹窗并发横跳关不完：上一轮提问窗 + restart_intent「按原计划继续」窗 + 「Agent 已断开」失效窗；用户答旧问题必 410（旧 agent 没了）→ runStatus 打回 error → 失效窗复活 → 死循环。
- **根因**：重启 / 推进 / 停止时旧 agent 被 cancel、但它发起的那条未答 ask **没被作废**——token 永久失效却仍 pending。前端 `AskUserDialog` 只看「`ask_user_request` 有没有配对 `ask_user_reply`」决定弹不弹 → 这条孤儿 ask 反复复活、答了 410 标 error 死循环。
- **修法（治本、力出一孔）**：① 新增 `supersedePendingAsks`（task-runner）——任何让旧 agent 终止的路径都作废未答 ask（补 `info` 事件标 `meta.supersededAskId`、**不**伪造 reply、**不**走 deferred 这种「用户主动放弃」语义、断网是被动打断）；② `restartCurrentAction` 把作废拿回的「你没答完的那组问题」交给新 agent **断点续传原样重问**（断在干活才走 restart_intent 确认方向）；③ `advanceTask`（推进）/ `stop`（停止）同类孤儿 ask 一并清（换 action / 主动停语义、只清不续传）；④ 判定逻辑下沉 `lib/ask-pending.ts` 单一源（`isAskReplied / isAskSuperseded / isAskSettled / findPendingAskEvent`、原散在前端 pendingEvent + rows + 后端 3 处）；⑤ 事件流失效 ask 显示中性「这组提问已失效（断线重启）」、不再假装「正在等你答」。
- 验证：typecheck + lint 全绿、vitest **130 全过**（新增 `tests/ask-pending.test.ts` 18 条、含断线重启「旧作废 + 新已答 → 不复活」核心回归）。

### v0.8.12：append 已分批的 task 强制出新批次（2026-06-18）

- **问题（实测线上 task t_…is2xsd #15 踩到）**：已分批（b1/b2、2/2 完成）的 task 追加需求时、plan agent 在 artifact 自判「补充小、不分批」没调 `set_plan_batches`（符合旧 §5.3「小可跳过」）→ 追加的 Task 8-10 不进任何批次 → 主页批次进度仍显示 2/2（看着像全完成）、追加需求游离、用户无法按批推进。根因：§5.3「小需求可不分批」对首次 plan 合理、但对「已分批 task 的 append」造成不一致。
- **两层硬约束（治本、保证生效）**：① `prompts/action-plan.md` §5.3 / [REPLAN_MODE append] 段加硬约束「**已分过批次的 task、append 追加需求一律调 `set_plan_batches` 出 ≥1 新批次、不适用『小可跳过』**」、引导 agent 从 NEXT_ACTION 里的「本 task 已拆 N 批」字样判断；② `task-runner.ts` `buildPlanReplanDirective` 加 `task` 参数、注入 NEXT_ACTION 时按 `computeBatchProgress(task).total > 0`（已分批）→ 注入「⚠️ 本 task 已拆 N 批、追加需求必须出 ≥1 新批次」**动态硬指令**（带真实批次数、不给 agent「因小跳过」口子）；没分批历史的 append 维持原弹性按规模自判。`replanDirective` 由 advanceTask / restart 两处算好（都拿得到 task）、透传 `buildNextActionDirective` + `internalStartAgent`、覆盖续接 / 降级 / 新 Run / 重启**全部启动路径**。
- **附带（修中文换行）**：① task 详情页标题行 `h1` + 容器加 `min-w-0`、修长标题把状态 badge 挤换行；② 批次表（`batch-plan-table`）状态列「待实现」被挤成「待实 / 现」——根因 shadcn `TableCell`(td) 默认无 `whitespace-nowrap`（只 `TableHead`(th) 有）、给状态 / 测试策略两窄列 td 补 nowrap + 图标 `shrink-0` + 状态列 `w-20`→`w-24`（v0.8.13 补）。
- 暂缓：系统侧「隐式批次派生」兜底（agent 真违抗时自动把漏报范围归批）评估后暂不做——A 已治本、等观察到 A 不生效再补这层防御性冗余。
- 验证：typecheck + lint 全绿。

### v0.8.11：action timeline 重做 + 修 CI sqlite3 死依赖打包失败（2026-06-18）

- **修 CI 打包失败（v0.8.7~v0.8.10 连挂 4 版的根因）**：`release.yml` electron job 的「修平台依赖」步还 hardcode 探测 + 装 + 验证 `sqlite3`，但 sqlite3 早已是死依赖（源码 0 引用、`pnpm-lock.yaml` 仅剩 overrides 声明、零实际包条目、standalone 产物根本不含它、test 包一直能正常 boot 证明运行时不需要）。standalone 里没有 sqlite3 → `node -p require('./node_modules/sqlite3/package.json')` 第一行直接炸 → win/mac 两个打包 job 全挂、release 卡在 draft。修：① step 8 删 sqlite3 三处（版本探测 / npm install / require 验证）、只留 `@cursor/sdk-<platform>` 平台包处理；② `package.json` 删 `overrides` + `pnpm.overrides` + `onlyBuiltDependencies` 里的 sqlite3；③ `pnpm install` 同步 lockfile（CI `--frozen-lockfile` 要求一致、本地已校验通过）。v0.8.6 之前 standalone 还含 sqlite3（那时有间接依赖引它）所以成功、v0.8.7 起依赖链断了但 CI / package.json 没同步清。
- **action timeline 重做（UX）**：原一排灰字 chip 太素 + 点击抖动。改：① 去类型图标 / 连接段（之前加过、太宽 + 把整行撑到换行临界、点击时右侧文件名变宽触发换行抖动）；② **timeline 独占整行拿满宽度**、文件名从右侧同行挪到**下方单独一行 + 固定行高占位**（根治「文件名挤压 timeline 宽度 → 换行重排 → 抖动」、加载中文件名暂空也不塌行）；③ 选中态 = **靛蓝描边 + 靛蓝字、无填充底 / 无背景色**（ring 是 box-shadow 不占盒模型、不加 border / 不改 padding / 不改字重 ⇒ 选中前后几何零变化、点击不闪不抖）；④ 去掉 workbench header 右侧 action 单步状态指示（运行中 / 失败…用户拍板：历史态意义不大、还抢视线 + 变宽加剧抖动）；⑤ 切换 task 默认选中**最后一个（最近）action**（直接看最新产物、不再跟 `currentActionId`）。涉及 `action-timeline.tsx` / `action-workbench-header.tsx` / `tasks/[id]/page.tsx`。
- 验证：typecheck + lint 全绿、lockfile `--frozen-lockfile` 通过、3 步打包 + test（8776）boot；产物确认无 sqlite3。

### v0.8.10：API Key 进页面自动验证 + 展示账号信息（2026-06-18）

- **进设置页自动验证**：以前 providers 已有 app 级模型预热、但设置页是另一个 `useModels` 实例不读缓存 → 用户进来要手动点「验证」才出模型。改成：配置加载完、有 apiKey 就自动拉一次（模型 + 账号信息、走 SWR 缓存秒出、`didInitValidate` ref 保证只跑一次）；apiKey 改完失焦（`onCommit`）也自动重验。
- **展示账号信息**：新增 `/api/me`（`Cursor.me`、同 `/api/models` 的 10min 内存缓存 + 超时兜底）+ `src/hooks/use-api-key-info.ts`（SWR：localStorage 先返 + 后台刷）；`ApiKeyCard` 在密钥下方显示「姓名 · 邮箱 / 密钥『name』· 创建于 YYYY-MM-DD」（团队 / service key 无邮箱时退回只显示有的字段）。`src/lib/types.ts` 加 `ApiKeyInfo`。
- **删过时文案**：设置页顶「编辑即保存、所有数据仅存浏览器 localStorage、不上传服务器」整句删——桌面端唯一交付、文案误导。
- 验证：typecheck + lint 全绿、3 步打包 + test（8776）boot；产物旧文案 0 命中、`/api/me` route 已进包、`/settings` 200、`/api/me` 空 body 返 400「缺少 apiKey」（路由挂载正常）。

---

### v0.8.9：桌面端「检查更新」按钮（2026-06-18）

- **手动检查更新**：壳本就有自动自更新（启动 + 每 2h 轮询 GitHub releases/latest、发现新版亮右上角「新版本」标识 + 弹一次原生框、mac 壳内下载替换 / win 重启即装），但「没更新就静默」、用户没法主动确认自己是不是最新。补一个按需通道：
  - `electron-app/main.js`：IPC `check-for-update` → `manualCheckForUpdate()`，按需查一次、返回 `{ status: "latest"|"available"|"error", current, latest? }`（mac 查 GitHub latest tag 比对 / win 走 `electron-updater.checkForUpdates`、复用现有 `fetchLatestVersion` / `isNewer` / `notifyPageUpdateReady`）；发现新版同样 set `updateReadyVersion` + 点亮右上角标识、接既有自更新流程。win 下 lazy init `winAutoUpdater`（test / 非打包早退场景兜底、轻监听不重复注册）。
  - `electron-app/preload.cjs`：暴露 `window.__appUpdater.check()`。
  - `src/components/settings/check-update-button.tsx`：设置页版本号旁「检查更新」按钮（仅桌面壳显示、disabled+spinner 防双击）——已最新 → toast「已是最新版本 vX」、发现新版 → toast「发现新版本 vX、点右上角更新」+ 标识亮起、失败 → toast.error。
- 验证：typecheck + lint 全绿、3 步打包 + test（8776）boot；asar 含新 IPC/preload 字符串、设置页文案进 chunk、`/settings` 200；用户在 test 实例点按钮端到端验通（test 版恒低于线上 → 走 available 分支、标识亮起）。

---

### v0.8.8：图片统一组件 + 站内预览 + 提交快捷键全站统一（2026-06-18）

- **图片统一组件 + 站内 lightbox（`src/components/ui/image-preview.tsx`）**：全站「用户内容图」收敛到 `ImageThumb`（缩略图）+ `MarkdownImage`（markdown 内嵌图）、`ImagePreviewProvider` / `useImagePreview` 提供全局 lightbox（挂 `providers.tsx`）。点击站内看大图（点背景 / Esc / X 关、多图 ←→ + 键盘 + N/total 计数、锁 body 滚动、**不跳出 app**）。替换 7+ 处：事件流已发送图（rows chat+log、**去掉 `target=_blank` 跳系统浏览器**）、5 处输入预览（event-stream 岛内 + 独立 / advance / revise / ask-user / context-docs、保留移除 X）、context-docs image doc 行内小图；两个 ReactMarkdown 实例（MarkdownText + artifact-panel）都配 `img: MarkdownImage`、markdown 内嵌图也可预览。痛点根源：原生 img 不能预览 + 新 tab 在 Electron 壳跳出 app 体验差。
- **提交快捷键全站统一**：`ask_user` 弹窗从写死 Cmd+Enter 改成跟设置页偏好走（`useSubmitShortcut` + `shouldSubmitOnKeyDown`）——mod-enter 任意焦点提交 / enter 只在 textarea 内提交（guard `tagName`、避免焦点在选项按钮上裸 Enter 误提交整表）；`shouldSubmitOnKeyDown` 入参放宽 `HTMLTextAreaElement` → `HTMLElement`（能绑 textarea 也能绑 DialogContent 容器）。单行 `prompt` 框保持 Enter 提交（无换行歧义、不套设置）。
- 规则沉淀：`learned-conventions`（图片走 ImageThumb / MarkdownImage、新 ReactMarkdown 必配 img）+ `ui-conventions`（提交快捷键走 useSubmitShortcut、不写死）。
- 验证：typecheck + lint 全绿、3 步打包 + test（8776）boot + 组件进包核验。

---

### v0.8.7：模型选择器全站统一 + 重启选模型 + 追加方案批次总览 + SDK 1.0.19 补 connect-node（2026-06-18）

- **模型选择器统一成 `ModelSelect`（`src/components/ui/model-select.tsx`）**：全站 5 处（设置页 / 新建任务 / 推进 dialog / 重启 dialog / chat footer）收敛到一个组件、删旧 `model-picker.tsx`。一个「trigger + 可搜索 popover + chips 参数」一体：① 顶部搜索框按 displayName/id 实时过滤（几十个模型不再纯下拉翻）；② **popover 内零嵌套弹层**（模型列表是普通 button、params 用 ChoiceButton chips 原地切）——根治旧版「Popover 套 Select / Select 套 Select」导致的「选完点空白要点两次才关」。
- **重启当前阶段加选模型（`RestartDialog`）**：原纯文字 confirm 升级成带 ModelSelect 的 dialog、默认回填该 action 的 `agentModel`（不改沿用、想换更强 / 更省的模型接手就改）。后端 `buildRestartActionInstruction` 加「你可能是被换上来的新模型、先读全上下文」+ 有序步骤 + **读完上下文动手前先 `ask_user` 确认方向**（一个「按原计划继续」选项 + allow_text 自定义）；`restartCurrentActionInner` 改用 `input.model`（前端默认填 agentModel、从源头堵「断线重启掉回默认模型」）、每次回写 agentModel 保证「卡片显示 = 实跑模型」。
- **追加方案「批次总览」（artifact-panel + batch-plan-table）**：补充需求重跑 plan 后、artifact 批次表从「单 action delta（只 b3）」改用全量 `deriveEffectiveBatches(task)`（b1/b2/b3）、跟选批界面 / 进度条同源——加状态列（已实现 / 待实现）+ 进度 badge（X/Y）+ 来源 #N + 「本次新增」标记；追加 / 重建 plan 顶部加「前序方案」跳转入口。设计原则：**数据保持增量、视图做聚合**（不改 agent 行为、不把主方案正文重抄进新 md、避免漂移）。
- **SDK 升 1.0.19 + 补 `@connectrpc/connect-node`**：SDK 1.0.19 运行时 import connect-node（Node transport）却漏在自己 package.json 声明依赖 → pnpm 没装、standalone nft 追不到、打包缺包、chat agent 启动即 `Cannot find package '@connectrpc/connect-node'`。项目侧显式 `pnpm add @connectrpc/connect-node@1.7.0`（对齐现有 connect 版本）补上、nft 自动进包、无需改 assemble 脚本。
- **删除对话不再弹 toast**：`app-sidebar` 删除任务成功的 `toast.success` 去掉（失败仍提示）。
- 验证：typecheck + lint 全绿、3 步打包 + test（8776）端到端（含运行时 `import @cursor/sdk` 验 connect-node 解析通）。

---

### v0.8.3：ask_user 逐题贴图 + chat 流式自动滑底 + announce-then-wait 防漏 + ask-reply race 加固（2026-06-16）

- **ask_user 弹窗逐题贴图（仅自定义回答能带图、用户拍板）**：每道题抽 `AskQuestionItem` 子组件、各 call 一次 `useImageAttach`（hook 不能在 `questions.map` 里循环调、故按子组件拆）、各绑各的图。附图按钮 / 缩略图 / 粘贴 / 拖拽整体收进「自定义回答」区——选固定选项（A/B/C）就隐藏且上报空图（图 state 不清、再切回自定义会重现、不丢用户已贴的图）。后端 `ask-reply/route.ts` 收 `imagesByQuestion`、按 questionId 白名单过滤（防客户端塞无关 key）、单题 ≤6 / 合计 ≤12、**先校验后落盘**（确认 agent 还在等才写、避免僵尸态留孤儿文件）、`buildReplyText` 每题 A 行下内联「本题附图：<basename>」做归属、`meta.images` 扁平给前端 `extractUserReplyImages` 渲缩略图、`allAbsPaths` 透传 agent（文末 `[ATTACHED_IMAGES]`）。图-only（只贴图不填字）也算已答。
- **chat 流式回复自动滑底（修）**：根因——react-virtuoso `followOutput` 只在 data **条数**变化触发、流式是往同一个 `__streaming__` 虚拟 item 追加 text、条数不变（始终 merged.length+1）→ 增长期间不滚。修：`atBottomRef`（Virtuoso `atBottomStateChange` 维护「用户是否贴底」）+ `useEffect([streamingText, items.length])` 贴底时 `scrollToIndex(last, align:"end", behavior:"auto")` + `atBottomThreshold={120}`（默认仅 4px、太敏感、单 chunk 增高就被判离底自废）。EventStream 是 chat / task 共用组件、两边都受益。
- **chat「宣告计划当正文」announce-then-wait 防漏（7 处文案、task 协议 + 硬闸逻辑不动）**：composer-2.5 实测把「我先写一篇 X、写完后再等」这种**计划宣告**当成回答、文章一字没写就直接挂等。把「预告」从「只举查询型（正在检索 / 让我看看）」**泛化**成「任何只宣告要做、不含成品的话都是预告」；交付用「**本轮成品 / 可用分段**」措辞（不逼一条写完整任务、不压制合理分多轮）。同步 7 处（含离每轮最近的 `CHAT_REPLY_REMINDER`、wait_for_user 工具 description、硬闸拒绝文案）。经 reviewAI 多轮确认范围限 chat。
- **chat 纯宣告硬闸（announce-then-wait 第二刀、reviewAI 拍板极窄启发式）**：上一刀（7 处文案）实测对 composer-2.5 仍漏——它「知道规则却执行时跳步」、发一句「我先写…进入等待你的下一条」当正文就直接 curl 挂等、命中硬闸「有正文就放行」分支没拦住（原判定只看「有没有正文」、不看是「宣告」还是「成品」）。纯 prompt 兜不住执行层、在 `premature-chat-wait.ts` 加 `isPureAnnouncement` 窄判定（两档：**强信号**=短正文含内部等待机制词「进入等待 / 挂等 / wait_for_user / 监听你下一」、**不收裸 curl** 防误伤「curl 调接口示例」类技术问答；**组合信号**=短正文同时命中「将来式计划 + 交付动词 + 延后/未完成语义」三件套缺一不算、区分「我先给你结论：可以」（已交付不拦）vs「我先写…写完后再发」（未交付拦））。判定拆 `lastSubstantiveAnswerIdx`：纯宣告不刷新「有效回答」位置、防「答→查→只发个宣告」绕过「答后又查没回报」。误拦靠既有 `CAP=2` 兜底。chat 起手顶部加一句 blockquote 铁律（计划 / 预告 / 等待说明都不是交付物）、waitDiscipline 核心段不动。+10 回归单测。经 reviewAI 两轮 review（揪出裸 curl 误拦 + 纯宣告刷新位置 2 个 P1、已修）终审通过。
- **ask-reply 后端 race 加固（2 个 P1、reviewAI 提）**：① **重排**「先 `submitAskReply` 成功、再写 ask_user_reply 事件 + publish + 切 running」——旧版先写事件再 submit、submit 失败（pending 被顶替 / keepalive 切换）时用户已看到「已答」但 agent 没收到（假已答）；② pending 校验**从 task 级升到 token 级**：`submitAskReply` 加 `expectedToken`、新增 `hasPendingToken(taskId, token)`、route 从 ask_user_request 事件 `meta.token` 取——防旧弹窗答案串进被 force-new-agent / 顶替换掉的新 pending。
- 验证：typecheck + lint 全绿、vitest 118 全过、3 步打包 + test（8776）端到端验证。

---

### v0.8.2：侧栏任务状态 + wait_for_user 误拦修复 + 长连接友好文案 + 重启模型保持（2026-06-16）

- **侧栏任务运行态指示**：任务列表显示 running 转圈 / awaiting_user 脉冲点（`task-list-item.tsx`）+ 条件轮询实时更新（`use-task-list.tsx`、切到 B 也能看到 A 的状态）。
- **wait_for_user 误拦两层修复**：chat-runner 认 MCP wrapper 包的 wait_for_user（从 `msg.args` 提 innerToolName、mirror task-runner）、`premature-chat-wait.ts` 结构化识别握手工具（不再靠展示文本子串、wait-ack 用 `curl` + `/api/tasks/` + `/wait-ack` 三条件）+ 全量读事件（limit=0 防长首轮 fail-open）+ 22 单测。
- **长连接断开友好文案**：长连接被断（status=error / expired 无诊断）→ 事件流换「长连接已断开」友好提示、有诊断的错照旧展详情、dump 仍进 console（`sdk-error.ts` `summarizeRunFailure` + 13 单测）。
- **boot-recovery 文案通用化**：task / chat 共用「重新发起即可恢复」（不再提「推进」、自由模式不合理）。
- **prompt 全局规则 front-load**：`_super.md` 把注入的用户全局规则段前移、提升权重（修「task 模式回英文」、语言无关、不写死永远中文）。
- **重启 action 用实跑模型**：`restartCurrentActionInner` 用 `action.agentModel`（不再掉回创建默认 composer）+ 老数据回填 agentModel（effectiveStartTask/Action 一致返回）；`advance-dialog` 默认沿用本 task 最近 action 实跑模型（settings fallback 移回 open-effect 当次读、不 stale）。

---

### v0.8.1：自更新防残缺包 + 发版改 draft 流程（修 v0.8.0 自更新事故）（2026-06-15）

v0.8.0 发版当场踩了自更新事故：旧 `release.yml` 先建 **published** 占位 release → 用户 app 在 dmg/yml 还没传完时就 `fetchLatestVersion` 查到新版 → mac 自更新下到残缺 dmg（只 1.78MB）→ `ditto` 拷残缺文件报 `Unknown error 1000`、且残缺 dmg 被 `hdiutil attach` 挂成坏卷没卸干净 → Finder 扫描坏卷 I/O 卡死。并发 publish 还撞出 **0 字节 `latest.yml`**（win electron-updater 全靠它、win 同事自更新挂）。

- **mac 自更新加 dmg 完整性校验（`main.js` `macSelfUpdate`）**：下载后比对 `content-length`、`got !== total` 直接 throw——在 `hdiutil attach` / `rename appPath` **之前**拦掉、残缺包根本不碰 app（旧逻辑下完直接 ditto、拷到一半才炸、那时旧 app 已被挪走）。
- **发版改 draft 流程（`release.yml`）**：① build-release 占位建 **draft**（electron-builder `getOrCreateRelease` 优先复用匹配 tag 的 draft、源码 `if(release.draft) return release`）② matrix `max-parallel: 1` 串行打包（防并发 overwrite asset 撞出 0KB yml）③ 新增 **finalize job**（win/mac 全传完才把 draft→published）。draft 期间 `/releases/latest` 不指向它、自更新查不到 → 杜绝「asset 没传完就被下到残缺」；任一平台挂就留 draft、不对外发半成品。
- 功能同 v0.8.0（侧栏导航）、纯发版链路 + 自更新加固的 hot-fix。

### v0.8.0：侧栏任务导航（列表搬进常驻侧栏、多任务秒切）（2026-06-15）

痛点：首页是任务大列表、切任务必须「详情 → 返回 `/` → 进另一个」、多任务并行来回切累。改成 ChatGPT / Cursor 式常驻左侧栏：点侧栏即切任务、可展开 / 收起（收起宽度归零、复杂详情页不被遮挡）。用 `ui-ux-pro-max` + `frontend-design` skill 辅助（落实当前项高亮 / 键盘可达 / push 不遮挡 / 视觉克制）。

- **应用外壳 `AppShell`（新 `app-shell.tsx`）**：包「顶栏 + 侧栏 + 主区」、持侧栏开合态（localStorage `fe-ai-flow:sidebar-open` 记忆）+ `⌘/Ctrl+B` 切换（焦点在输入框时让行）+ 路由切换主区归顶。`layout.tsx` 用它取代旧「header + main」、body `h-screen overflow-hidden`（整体不滚、滚动交给主区）。
- **侧栏 `AppSidebar`（新 `app-sidebar.tsx`）**：顶部「新建任务」实色按钮 + 类型筛选（`ListFilter` 图标点开 Popover 选「全部 / 任务 / 对话」、localStorage 记忆）；列表分「置顶（pin）/ 活跃（updatedAt 倒序）/ 更早（archived 折叠、默认收起）」；行尾 hover「置顶 / 删除」（删除二次确认 + 乐观移除 + 删当前任务回首页）。`open ? w-64 : w-0` 过渡 push 主区。
- **共享列表 `useTaskList`（新 `use-task-list.tsx`）**：侧栏 + 各页面共享 `TaskSummary[]`、`refresh`（mount + window focus）/ `upsertTask`（新建即时插入 / 状态同步、Task 自动收窄 Summary 剔除 events）/ `removeTask`（乐观）。挂 `providers.tsx`。
- **任务行 `TaskListItem`（新）**：侧栏 / 欢迎页共用、一行 = 行首**类型图标**（对话 = 气泡 `MessageCircle` / 任务 = 清单 `ListTodo`、所有行左缘对齐）+ 标题 truncate（hover `Tooltip` 补全长标题）+ 行尾 hover 操作（置顶 `Pin` / 删除）、当前任务高亮（左 primary 竖条 + 底色）。**状态不再用色点表达**（2026-06-15 用户反馈：开发中是常态、满屏色点是噪声、且 shell 保活超时几乎每个任务最终落 error 标红误导）——`getTaskStatusDot` / `TaskStatusDot` 已删。
- **置顶 pinned（全栈）**：`Task.pinned`（types + `task-fs` schema/hydrate + PATCH `/api/tasks/[id]` + `setTaskPinned` client），侧栏置顶组排最前。
- **类型筛选**：侧栏顶部 `ListFilter` 图标点开 `Popover` 下拉选「全部 / 任务 / 对话」（状态 localStorage 记忆、非「全部」时图标高亮 + 列表顶部显示当前类型标题 +「清除筛选」），避免用户以为任务丢了。
- **新增 `Tooltip` 组件**（`ui/tooltip.tsx`、base-ui、长标题 hover 补全）。
- **首页 `/` → 欢迎页**：删大列表（在侧栏）、改 hero（一句定位 + 新建 CTA + 继续最近、logo 柔和光晕 `/8`）+ 最近任务入口。
- **去手动归档**：首页「已归档」视图 + `TaskCard` 整个组件删、归档退化为侧栏「更早」折叠（沿用后端 7 天 auto-archive、不再让用户手动操心）。
- **顶栏 / 详情页适配**：侧栏展开 / 收起 toggle 常驻**顶栏红绿灯右侧**（`app-header.tsx`、位置固定不随开合跳）+ scrolled 改外壳传入；详情页 task + chat 两模式去 `h-[calc(100vh-3.5rem)]` 改 `h-full`、去冗余「返回」按钮（侧栏常驻 + logo 已能回首页、对标 ChatGPT/Cursor）；`LoadingState` block 同步去 calc。
- 验证：typecheck + lint 全绿 + 3 步打包（`BUILD_STANDALONE=1 pnpm build` → `assemble-electron-server.mjs` → `electron:dist:test`）+ test 包（8776）端到端验证。

### v0.7.23：light/dark 主题 + 自定义同色标题栏 + 包瘦身 + chat 运行态重构（2026-06-15）

本轮一次会话堆了 7 块改动（均已 test 实例验证、未单独 tag）：① **Electron 包瘦身（~600M 起步）**：`next.config.ts` `outputFileTracingExcludes` 显式剔除 file-tracing 误拖进 standalone 的死重（`sharp`/`@img` libvips、`typescript` devDep、`caniuse-lite` 构建期专用、合计 ~26M、grep 实证运行时零 require）+ `electron-builder.yml` `electronLanguages` 只留中英 locale（Chromium 默认塞 ~220 国 ~47M、本应用 UI 全自绘中文、只 Chromium 原生右键菜单用 locale；不影响 icudtl.dat）。② **light/dark 三态主题（一步到位、默认跟随系统、codex 灰调）**：`providers.tsx` next-themes 从 `forcedTheme=dark` 改 `defaultTheme=system + enableSystem`；`globals.css` 补 light 色板（codex 风浅灰底 oklch(0.967) + 白卡浮起、全局极微冷调 hue264 避免死灰）+ dark 提亮柔化（纯黑 0.145→0.17、card 拉层次、border 10%→12%）+ prism token / 滚动条色全主题变量化（light 压暗保白底可读）；新增 `theme-toggle.tsx`（顶栏三态 popover：浅色 / 深色 / 跟随系统）；`artifact-diff.tsx` diff viewer 跟 `resolvedTheme`（删 dark-only prism-tomorrow.css）；`mcp-oauth/callback` 结果页 + `main.js` 加载页/窗口底色都跟 `nativeTheme` 系统深浅、消除浅色系统启动闪黑。③ **自定义同色标题栏（Cursor 式一体顶栏、mac+win）**：新增 `app-header.tsx` 替换 `layout.tsx` 旧 header——品牌（logo+「AI工作流」）居中、整条 `-webkit-app-region:drag` 可拖窗 + 交互元素 no-drag、滚动 >0 才浮现 border-b；`main.js` mac `titleBarStyle=hiddenInset` + `trafficLightPosition` 对齐 h-14、win `hidden` + `titleBarOverlay`（height 56、运行时主题切换走 IPC `set-titlebar-overlay` 同步控制按钮条底色/图标色）；`preload.cjs` 暴露 `window.__shell`（platform + setTitleBarOverlay）。④ **app icon 圆角平台分治**：win 用预圆角透明角 squircle `packaging/icon-win.png`（`electron-builder.yml` `win.icon`、任务栏显圆角）、mac 继续满幅方块 `packaging/icon.png`（Tahoe 自己加圆角且不垫白底、共用透明角图会被 Tahoe 垫成白底方块、踩过）；header `public/logo.png` 用透明角 squircle、`<img>` 不再叠 ring/CSS 圆角。⑤ **prompt 修订：先回复再 wait_for_user（线上 money看板 翻车驱动）**：composer-2.5 干完工具/部署直接挂等、正文全空（用户连追 4 次才吐链接）——`chat-mcp.ts` `CHAT_REPLY_REMINDER` 重排成两步且**正文在前**（① 先把结果/链接/结论写进正文 ② 再 wait_for_user）、`wait-protocol-prompt.ts` `chatShellWaitGuideBody` 自检改「正文是否已发出、只调工具≠回答=用户看到空白」；顺手精简该文件冗余（删「收尾语也照样等」整段、step5 去括号、消歧义交叉引用）。⑥ **chat 运行态指示器重构（ui-pro-max、零布局抖动）**：`chat-view.tsx` 删顶栏「AI 正在回 + 停止」簇、`statusHint` 瘦身 error-only；`event-stream.tsx` 运行态收进输入框操作行（loading 转圈 + 红方块停止键替代发送键、点即停）、删输入框下方那条会顶高布局的「agent 正在思考」状态行（content-jumping severity high）、模型选择器与输入加 pt-1.5 间距。⑦ **修 chat「停止后 AI 还回复」冷启动竞态**：`runChatSession` 旧版到 `agent.send` 之后才把 run 注册进 `runningChats`、而 `cancelChatRun` 靠 `runningChats.get` 命中——`Agent.create` / `send` / MCP 健康探测的数秒冷启动窗口里点停止会扑空（连 cancelled 标志都来不及设）、run 照常启动复述 + 回复（用户线上实测、事件流「用户停止了对话」落在「Chat 任务启动」之前为证）；改为**进入即占位注册**（cancel 置 cancelled + 有 run 时真 `run.cancel`、agentId 先空 send 出来回填）、`try/finally` 扩到覆盖全程保证占位 record 必清理（不泄漏 `has=true` 卡死后续启动）、MCP 探测 / create / send 三个 await 后各加 cancelled 检查点提前收尾（idle + done、不重复落停止事件）。附带清理网页版残留（`use-mcp-oauth` 删浏览器预开窗分支、`native-picker`/`update-badge`/`repo-card` 去 web 版兜底注释）+ `learned-conventions` test 实例/包默认不关不删（2026-06-15 用户修订、覆盖旧「测完删包 / 立即关 test」）。

### v0.7.22：自更新加 2h 定时轮询（2026-06-15）

`main.js` 自更新原本只在 app 启动时查一次（`whenReady` → `setupAutoUpdate` 一次性）——同事习惯长期开着不关 app 就一直收不到新版提醒。本版加定时轮询：抽 `runUpdateCheck()`（启动 + `setInterval` 每 2h 各跑一次）、win 的 `update-downloaded` / `error` 事件监听器挪进 `setupAutoUpdate` **只注册一次**（`winAutoUpdater` 模块级单例、轮询只调 `checkForUpdates()`、防重复注册 = 监听器泄漏 + 多次弹窗）、mac 轮询走 `fetchLatestVersion()` 比对版本号。**去重靠既有 `promptUpdateOnce` 的 `wasPrompted`**（同版本只弹一次原生弹窗、跨重启持久化）——轮询查到同版本只刷新页面右上角「新版本」标识、不重复骚扰；app 退出进程自然清 interval。纯 main.js 自更新段改动、不碰其他。

### V0.7.0：Electron 桌面端——双击图标即用、win 自动更新（2026-06-11）

背景：绿色 zip 的「bat→vbs→隐藏 powershell→node」四级启动链静默、易被企业 EDR 拦、挂了零反馈（同事实测「双击闪一下啥都没发生」）。用户拍板换 Electron：同事双击图标 → 独立窗口 → 关窗服务跟着退 → win 自动更新、接受体积代价（约 260MB vs 绿色包 170MB）。

- **改名 ai-flow + 等待协议单一源 + Win 装路径可选 + 禁整页刷新（v0.7.21、2026-06-15）**：① **全局 `fe-ai-flow` → `ai-flow`**（用户拍板「已不局限于 fe」）：agent 上下文（prompts / skills / `.cursor/rules`）+ 项目名 + docs + MCP id（`feAiFlowChat` → `aiFlowChat`、`chat-mcp` 定义 + chat-runner / task-runner / `_super.md` 引用全链一致）全去 fe；**雷区一律不动**（改了裂 app / 丢数据 / 断自更新）——userData 目录（`fe-ai-flow` / `fe-ai-flow-test`）、appId（`com.jianger.fe-ai-flow`）、GitHub repo（`jianger666/fe-ai-flow`）、artifactName（`fe-ai-flow-${version}` exe/dmg）、env（`FE_AI_FLOW_*`）、globalThis key（`__feAiFlow*__`）、localStorage key（`fe-ai-flow:*`）。② **等待协议 prompt 收口单一源**（新建 `src/lib/server/wait-protocol-prompt.ts`、chat + task 四处引用同一份、删三处漂移）：抽共用「写完 → wait_for_user → shell curl 挂等」的纯机制纪律 + 三认知陷阱（turn 矛盾 / 回复完≠收尾、所谓「结束」其实是「断开」/ anti-loop 误报）；chat 侧补「每轮 `[USER_REPLY]` 尾部拼一句 wait 提醒」（recency 注入、抗长上下文把协议冲淡导致漏调）+「工具跑完 ≠ 回答、结果 / 链接 / 结论必须写进回复正文」、`wait-ack` maxDuration 提到 24h。③ **Windows nsis 可选安装路径**：`electron-builder.yml` `oneClick:false` + `allowToChangeInstallationDirectory`、首次手装走向导能选目录（自更新仍静默、per-user 不强制 UAC）。④ **禁整页刷新快捷键**：`main.js` `before-input-event` 拦 `cmd/ctrl+R` / `cmd+shift+R` 强刷 / `F5`（dev+prod 都禁）——桌面 app 不该暴露浏览器整页刷新、误触丢输入草稿 / UI 临时态（持久化态走 server + SSE replay 不受影响）；只拦这几个键、不碰 cmd+C/V/A / cmd+W / cmd+Q / devtools。⑤ **mac/win 自更新故意不统一（已评估、别复用重构）**：共享层已抽好（弹窗去重 `wasPrompted`/`markPrompted`、页面「新版本」标识 `notifyPageUpdateReady`、对话框 `promptUpdateOnce` 文案参数化、入口分流 `installUpdateNow`、版本比较 `isNewer`——改一处两端生效）；真正分两套的只有「下载+安装」核心（win `electron-updater` 一把梭 ≈18 行 / mac 无证书跑不了 Squirrel.Mac、自实现 `fetch dmg + hdiutil + ditto` ≈97 行）——底层是两个不兼容方案、连「查更新」都难统一（win 是查+下载一体的事件回调），强行抽接口反增耦合。**下个 AI 别再尝试复用重构自更新。**
- **chat 漏调 prompt 第一铁律加固 + anti-loop 软提示定调（v0.7.20）**：用户挂超长连接实测（main.log task vn2ckn）出两个结论。① **anti-loop = 软提示、非硬强制**（闭环 v0.7.19 ③ 待验证）：第 1 轮 long-poll 挂 67 分钟（10:28→11:35）curl 不断、run 不退——Cursor「flagged as looping / 处于循环状态」是能无视的软提示、不逼退出、KEEPALIVE 策略不用动。② **wait_for_user 漏调真实存在、概率性、纯 prompt 没根治**（修正 v0.7.17~18「漏调已修」的乐观结论）：12:07:52 用户回「好的」→ 12:07:57 SDK FINISHED、中间 0 次 wait_for_user（和最初 acmri2 同款）；对比 fxjb3s 的「好的」「ok」没漏 = 同输入不同结果、composer 软约束 hold 不住、**收尾语境（好的 / 谢谢 / 收到 / 没事了 / ok）最易触发误判「对话结束」而省 wait**。**用户否决「服务端 resume 兜底」**（原话「我就是不想冷启动、不多启动才搞这套 shell long-poll」——resume 起新 run 正撞「单 run 省计费」硬约束）、定调走 **prompt 加固**：`chat-runner.ts buildInitialPrompt` 改 2 处（精简后单一源、避免冗余）——① 总纲把原『循环往复直到用户主动结束』（给 agent『可自判结束』的错误锚点）换成『无限循环、永不自行结束』+ 新增「🚨 第一铁律：你没有结束对话的权力」整段讲透 turn 机制（emit 后不接 tool call → turn 结束 → Run 永久死 → 冷启动；唯一结束信号 [CANCELLED]；收尾语「好的 / 谢谢 / 收到 / ok」是普通消息、回完照样 wait）；② USER_REPLY 分支补一句指针「收尾语也不例外、见开头第一铁律」。（初版在关键规则 1 / 标准动作也各加过同款警告、后精简掉重复、只留总纲单一源 + USER_REPLY 指针）⚠️ 仍是软约束、composer 可能偶发不听、但决策路径上的错误锚点已清。③ 附带：几个 task long-poll 中途 SDK ERROR（fxjb3s 9.5min / mygeom 24min、message 空）但 vn2ckn 挂 67min 没事 = 非「挂久必挂」、根因待查（疑 test/正式 race 或 SDK 偶发、非 anti-loop）、和漏调两回事。
- **wait_for_user 引导焊死「移后台≠exit」+ 纯 shell 化讨论定调保留 MCP（v0.7.19）**：① 接 v0.7.18——`buildShellWaitGuidance`（chat+task 共享）原「curl 意外 exit 再跑一次兜底」拆成两条死边界：「被 shell **自动**转后台」≠「curl exit」（转后台后 curl 还活着、KEEPALIVE/终态行继续推、**绝不重发**继续等）、只有「真 exit」（shell 明确给 exit code 非 0 且 stdout 一行没有）才重发一次兜底——防 agent 把「被自动转后台」误判成「连接断了」狂发第 2 条 curl。② **纯 shell 化讨论 = 维持 mcp+shell 两段式**（用户问「能否去掉 wait_for_user 的 MCP 跳、直接一条 shell」）：技术可行（wait-ack route 就地建 entry、pendingMap 本就按 taskId 存、token 只是冗余二次校验）但 ROI 不划算——ask_user 必须留 MCP（问题清单结构化 payload、纯 GET curl 传不了）、wait_for_user 自己 chat（无 action_id、URL 固定）能纯 shell 但 task（带 action_id/artifact_path）要手拼 query 易错、还会让 chat/task 裂成两套等待机制违背单一源；省的只是「每轮一次工具调用」不修任何 bug（漏调 v0.7.18 已修）。③ ⚠️ **待验证认知：long-poll 等待期 KEEPALIVE 滚动仍触发 Cursor anti-loop**——用户实测 chat 等待时 composer 收到 Cursor 内置「flagged as looping / 处于循环状态」提示（grep 本仓无此串 = Cursor IDE 层真实提示、非 agent 幻觉）。route.ts 注释当年只记张力一半（**静默**几分钟→agent summarize 退出 bias、所以才改 KEEPALIVE 可见行）、现补另一半（**每 60s 同样的 [KEEPALIVE]**→「循环」bias）；两难 = 静默判卡住 / 滚动判循环。这次 agent 扛住没退（钢铁纪律 hold 住）。**实测闭环见 v0.7.20 ①：长连接挂 67 分钟 curl 不断、run 不退 = 该提示是软提示（能无视）、非硬强制、KEEPALIVE 策略不用动。**
- **test 包补 SDK 平台包 + wait_for_user 禁后台→简化单条 curl + 端口文案（v0.7.17~18）**：① **本地 `electron:dist:test` 缺 SDK 平台包 → 对话全挂**：`@cursor/sdk-<platform>`（含 native `cursorsandbox` + `rg` 二进制）运行时动态拼名加载、Next standalone nft 追不到、CI 靠 `npm install` 补、但本地 test 打包没这步 → SDK 连 API key exchange 端点 `fetch failed` → agent run error（**修正 v0.7.6 那条「本地组包缺平台包但有降级、一直能跑」的认知盲区**——降级只在「整包缺失」时走、test standalone 是「能 require 到 @cursor/sdk 主包、但缺平台子包」、SDK 内部直接 fetch failed 吞不掉、必挂）。修：`scripts/lib/assemble-server.mjs` 加 `addSdkPlatformPackage`、检测到本地 pnpm 符号链接拓扑（`.pnpm` 存在）时把当前平台 SDK 包从根 `.pnpm` 拷进 server 布局 + 建 symlink、CI hoisted 布局自动跳过、不影响发版链。② **wait_for_user 后台 bug**：composer-2.5 把保活 long-poll curl **放后台跑**（实测截图原话「Shell 在后台运行」）→ shell 秒返回不阻塞 turn → SDK run 提前 FINISHED → 每条消息重启新 run（违背「单 run 保活省计费」、对话「自己结束」要重发）；引导文本 / chat prompt 反复强调「前台」却**没一条显式禁后台**——`buildShellWaitGuidance`（chat+task 共享单一源）+ chat-runner `buildInitialPrompt` 三处加「必须前台、禁 `&`/nohup/disown/is_background」禁令。⚠️ 纯 prompt 软约束、composer 仍可能偶发不听、不行再上服务端兜底（检测「调了 wait_for_user 却 run 提前 FINISHED + entry 未 resolve」的误退信号自动续接 / 改文案）。**v0.7.18 用户拍板走简化路线（不上服务端兜底）**：旧引导给的是 `while + curl --max-time 1800 + tee + grep` 的「无限重连」命令（V0.6.21 防连接断的过度设计）、但「循环命令」本身就在诱导 agent 放后台 / 自己重连——用户原话「我让它 shell 一直保持就是不想 resume 冷启动、你反而要用禁令防它」。砍掉 while/max-time/tee/grep/mktemp/set+e、引导改**单条 `curl -sN`**：本地回环长连不会断、靠服务端 60s KEEPALIVE 维持（防 SDK shell idle-timeout 杀连接）、用户 ack 时 resolve 写终态行 + 关流、curl 自然 exit。命令越简单 agent 越难带偏（删 `terminalSignalGrepPattern`、`TERMINAL_SIGNAL_TOKENS` 留作协议清单 + 一致性测试；chat-mcp / chat-runner / wait-ack 三处实现注释同步去掉 while/max-time 旧描述）。**实测又修正一个认知**：单条 curl 跑起来后、**Cursor SDK shell 工具会因「命令长时间不返回」自动把它转后台**（超时机制、非 agent 主动——events.jsonl 实证 shell args 无 is_background 但 composer thinking「发现被后台启动了」）——所以 v0.7.17「禁后台」的因果其实错了（不是 composer 主动放后台导致 run 退、是 SDK 自动转后台 + composer 被「禁后台」禁令带得误以为违规、纠结/重调/退出）。prompt 再改：明确区分「agent **主动**加 `&`/nohup/is_background = 禁」vs「SDK **自动**转后台 = 正常、别慌别重调别退出、继续等后台 shell 推来的 KEEPALIVE/终态行」、chat（chat-mcp + chat-runner）+ task（_super.md 3 处旧 while 描述）全覆盖。实测 task acmri2：单条 curl + 被自动转后台、但 run 没退、连接稳挂、用户回复后 agent 正常接上（main.log 无 FINISHED/abort = 之前「对话自己结束」的病已好）。③ Electron 端口冲突 dialog 文案硬编码「8876」改 `${PORT}`（test 模式显示 8776、底层检测 / 清理逻辑本就用对了 PORT、纯文案误导）。⚠️ **同机两个 SDK app 实例（test 8776 + 正式 8876）并发跑 run 会 race**（[官方已知 bug](https://forum.cursor.com/t/concurrent-headless-cursor-agent-invocations-fail-without-delay/142677)：cursor-agent 多进程 session 初始化 / 文件锁冲突、一个正常一个秒 ERROR 无 message）——同进程内多 agent 不受影响、跨进程才撞；铁律 test 验证期间别和正式同开、验完即关（已入 learned-conventions）
- **配置 localStorage → config.json 无感迁移（v0.7.16、用户拍板「不能影响已有用户、要无感」）**：桌面端配置原存浏览器 localStorage（Chromium leveldb）、硬伤多——按 origin 含端口隔离（换端口 / 同步 test 读不到旧配置）、不透明 leveldb、Electron 主进程读不到。改存 `data/config.json`（新 `/api/settings`：GET 读 / PUT 原子写 tmp+rename、跟 `FE_AI_FLOW_DATA_DIR`、主进程可读、备份 / 同步 test 直接拷文件）。**无感迁移**（老用户零操作零丢失）：`local-store.ts` 内存缓存 cache（模块加载即用 localStorage 兜底、启动无空窗、`getSettings()` 同步签名不变、9 处调用方零改）+ `initSettings()`（启动 await 一次：文件在→用文件权威 / 文件不在→把旧 localStorage 配置写进文件完成迁移；`initPromise` 单飞、并发共享 + 失败清空可重试、防 SPA 不刷页永久卡 localStorage）+ `saveSettings` 双写（文件权威 + 过渡期 localStorage 回滚保险）；`providers.tsx` + `use-settings.ts` 启动 `await initSettings` 再读。⏰ **15 天清理任务**：`REMOVE_LOCALSTORAGE_AFTER = "2026-06-28"`、过期后 dev 控制台红字提醒——确认同事都升过本过渡版后做「清理版」：删掉 localStorage 读 / 写 / 迁移、saveSettings 改纯文件、只留 config.json + 缓存（**后续 AI 接力时若已过此日、请提醒用户做清理版**）。⚠️ apiKey / gitToken 仍明文存 config.json（同旧 localStorage 安全级别）、后续可上 Electron safeStorage 加密
- **飞书 @ 测试人员切 user_key 体系（v0.7.14、官方 MCP 服务端变更逼迁）**：06-09 还能用的 lark_user_id mention 06-12 起被官方 MCP `add_comment` 拒（`bytedance.bits.collect_public:userKey cross tenant`、对照实验确诊服务端改按 user_key 校验）——`feishuTesterUserIds` 改名 `feishuTesterUserKeys` 存 user_key、`set_feishu_testers` 入参 `user_ids → user_keys`、action-ship.md §2 探测省掉 search_user_info 转换步（role_members 的 member.key 直接用）、§4 mention/notify 全换 user_key。⚠️ **官方通知链路同时坏了**（user_key 评论能发、@ 蓝色渲染、但不推飞书通知；AT_USER_BLOCK / blockType:user / 纯文本 + notify 全组合实测不推、UI 手动 @ 正常——评论 mention 数据模型已迁 blockId 引用、MCP 拼不出）：§4 已标注「通知可能未送达」、artifact 提示用户必要时 IM 手动知会、等官方修复
- **壳原生 picker + 钥匙串静默 + dialog 防误关（v0.7.14 同批、test 实例 CDP 验证过）**：① 桌面端文件 / 目录选择改走 Electron IPC（`electron-app/preload.cjs` 暴露 `window.__nativePicker` → 主进程 `dialog.showOpenDialog`、秒弹 + 自动聚焦）、`native-picker.ts` 优先壳通道、HTTP + osascript 链路留作浏览器 dev 兜底（用户拍板大方针「全部用原生」、已入 ui-conventions）；② `use-mock-keychain` 开关绕开 mac 钥匙串——ad-hoc 签名每版 cdhash 变、Safe Storage 钥匙串条目对新版失效、同事每装新版必弹「想要使用钥匙串中的机密信息」（本机工具、数据本就明文落盘、磁盘加密无意义）；③ 带草稿表单的 dialog（new-task / advance、revise 原有）加 `disablePointerDismissal`——用户实测关「目标仓库」下拉点空白把整个弹窗带没、草稿全丢
- **代码跳转双 IDE + 多仓路径兜底 + picker 反馈（v0.7.14 同批）**：① `buildCursorLink` 改名 `buildIdeLink` 支持 `idea://open?file=...&line=...` 协议、设置页「个人信息」卡加「代码跳转 IDE」选项（Cursor / IDEA、`settings.jumpIde`、展示组件用轻 hook `useJumpIde` 读）；② 多仓 task 的 artifact 路径**首段不是仓短名 = agent 漏写仓名前缀**（实测 36-ship 写 `apps/...` 点击弹「路径不存在」）——`hasValidRepoPrefix` 校验不过的降级纯文本不给假链接（page 传 `repoShortNames` 给 ArtifactPanel）、`_shared.md` §3 同步补多仓反例正例；③ composer 附文件 / 附目录按钮 picking 时转 spinner（mac osascript 冷启动 ~1s、用户反馈「点了没反应」）；④ 顺手修「学员交接2.1」meta.json 尾部多 8 个 `}` 的损坏（写入事故、boot recovery 每次启动刷错）
- **产品显示名「AI工作流」（v0.7.2 用户拍板）**：`productName` + 页面 title + header + 用户可见提示语全改；**内部标识一律不动**——localStorage key（`fe-ai-flow:settings`、改了用户配置全丢）、MCP client name、appId（`com.jianger.fe-ai-flow`、改了 win 升级裂成两个 app）、release 产物文件名（artifactName 写死 ascii、latest.yml 下载链路稳）；壳里 `app.setPath("userData", appData/fe-ai-flow)` 钉死数据目录、显示名以后随便改数据不漂移
- **壳落盘日志（v0.7.2）**：打包后没终端、`main.js` 全部 console 输出 + server stdout/stderr + 生命周期事件（启动 / server spawn / 退出 / 端口清理）双写 `userData/logs/main.log`——同事那边「双击没反应」之类问题直接要日志文件、不再盲猜
- **win 更新交互升级（v0.7.3 用户拍板）**：弃 `checkForUpdatesAndNotify` 的英文系统通知 → 下载完弹原生中文对话框「立即重启更新 / 稍后」（同版本只弹一次、`userData/update-prompted.json` 记账）；点稍后或下次进来 → 页面 header 亮「新版本 vX」标识（壳 `executeJavaScript` 注入 `window.__appUpdateVersion` + 事件、`did-finish-load` 重注入防刷新丢）、点标识 confirm 后页面导航 `app-update://install` 伪协议、壳 `will-navigate` 拦截 `quitAndInstall`；浏览器 / mac 环境壳不注入、badge 恒不显示。注意 **v0.7.2 → v0.7.3 这次升级走的还是老体验**（弹窗逻辑在新壳里、装上 v0.7.3 后下次升级才见到）
- **MCP OAuth 改走系统浏览器（v0.7.4 用户拍板）**：桌面端不再开应用内子窗——`use-mcp-oauth.ts` 用 UA 判 Electron、跳过 about:blank 预开窗（预开保手势是浏览器才需要的）、直接 `window.open(authUrl)` 被壳 deny + `shell.openExternal` 转系统浏览器；postMessage 回传链路在该场景天然断、授权完切回应用窗口靠已有的 focus 刷新兜住；壳 `setWindowOpenHandler` 删 about:blank allow 分支、浏览器路径行为不变
- **mac Dock 不再多绿色 exec 图标（v0.7.5）**：主二进制 as node 跑 server 会被 LaunchServices 标成 Foreground app（lsappinfo 实锤 next-server 上 Dock、显示通用 exec 图标）——改用 bundle 内 `AI工作流 Helper.app`（LSUIElement=1、永不上 Dock）跑 server、VS Code extension host 同款方案；helper 路径用 `app.getName()` 拼、改显示名不裂；hooks 孙进程链不受影响（server 的 execPath 变 Helper、同样 as node）。⚠️ 用户本机日常跑着这个 app 当生产用——**别在本地 open 打包 app / 占 8876 验证**（学到 learned-conventions）
- **四连修（v0.7.13、用户一次反馈五条）**：① 裸链接尾部 `_` 被 GFM autolink 当标点剥掉、点开 404——新增 `src/lib/remark-keep-trailing-underscore.ts` remark 插件（只缝「裸链接」、显式 `[x](url)` 不动）+ 4 条回归测试、两处 ReactMarkdown 挂上；② 全局滚动条 dark 化（globals.css：thin + 半透明拇指、webkit + Firefox 双写）；③ 模型列表到处拉、每次 5-15s——双层缓存：客户端 localStorage SWR（TTL 24h、命中秒出 + 后台静默刷新、`use-models.ts`）+ server 内存 TTL 10 分钟（`/api/models` 按 apiKey）；④ 文件 / 目录选择全换系统原生 picker——新 `/api/fs/pick-native`（mac osascript 多选 / win powershell：文件多选、目录单选 / linux 501）+ 客户端 `src/lib/native-picker.ts`、repo-card 选仓库 + composer 附文件 / 附目录（拆两个按钮、原生没有混合模式）全接入；**自绘 FsPickerDialog + /api/fs/{list,home,pick-folder} 全删**；⑤ wait_for_user 用户问「能否简化成一条长链接」——现状 while+curl 重连机制效果上就是单长连接、MCP 工具直接阻塞会撞 idle 5 分钟被砍的老坑（V0.3.5 立机制的原因）、维持现状
- **mac 应用内自更新（v0.7.12、免证书）**：用户实测痛点「每版更新都要去 系统设置→隐私与安全性 放行 + 输密码」——根因：浏览器下载带 quarantine 标记 + ad-hoc 签名每版 cdhash 都变、Gatekeeper 把每个新版当全新可疑 app。解法：壳自己 fetch dmg（**壳进程落盘的文件没有 quarantine、Gatekeeper 不评估**、实测 xattr 只有 com.apple.provenance）→ hdiutil attach → 旧 app rename 暂存（同卷原子）→ ditto 新 app 就位（保留签名 / xattr、失败回滚）→ 弹「立即重启」relaunch；下载进度走 Dock 图标 setProgressBar；非常规安装位（/Volumes/ 里直接跑）或任一步失败降级开下载页。win electron-updater 链路不变。彻底零确认 + 首次安装也免弹窗仍需 Apple 开发者证书（99 美元/年）、用户暂不买
- **chat 模式对话 UI 重做（v0.7.11、参照 Cursor agent window、用户点名）**：EventStream / EventRow / StreamingAssistantRow 加 `variant="log" | "chat"`——chat 形态：窄列居中（max-w-3xl）、AI 回复无容器平铺 prose、用户消息浅色圆角块（附件随块内）、thinking / tool_call / info 压成单行细条目（小图标 + 摘要、hover 显时间、点击展开、连续过程行紧凑堆叠）、composer 重做成圆角输入岛（Textarea 去边框嵌入、focus-within 岛框反馈、左下模型选择、右下 icon 附件钮 + ArrowUp 圆角发送钮）、顶栏轻量化（状态文案仅异常 / 发送中出现、awaiting badge 不再常驻）；task 模式 log 形态零变化（默认 variant）；headless Chrome 截图自查过整体形态
- **本地 test 实例机制（v0.7.9 用户拍板「可以本地测、但隔离」）**：`pnpm electron:dist:test` 打「AI工作流test」包；壳按**可执行文件名**含 test（或 env `FE_AI_FLOW_TEST=1`）探测 → 端口 8776 / userData `fe-ai-flow-test` / 跳过 updater、单实例锁按 userData 天然独立——agent 本地验证不再碰用户正式实例（8876 + fe-ai-flow）。踩坑沉淀：`-c.productName` 不改 asar 内 package.json、`app.getName()` 探测不可靠；mac Helper 路径不能 getName() 拼、改扫 `Frameworks/* Helper.app`；spawn 加 `error` 事件监听（ENOENT 此前静默挂死 pid=undefined）
- **导航 / 链接规范化 + 版本号显示（v0.7.8、全站 UX review）**：① 设置页「返回」从写死 `href="/"` 改 `router.back()`（无历史兜底首页）——用户实测「任务详情→设置→回不去」；② chat 模式顶部条补「返回」按钮（跟 task 模式同款、此前只能点 logo）；③ 壳 `setWindowOpenHandler` **零白名单**——站内 URL 开 Electron 子窗的 allow 分支删掉（AI 给的 `127.0.0.1:8876/...` 绝对链接点击「应用内闪一下」、用户实测差评）、所有 window.open 一律系统浏览器；④ 壳注入 `window.__appVersion`、设置页标题旁显示版本号（用户「不确定装的是不是最新版」）；⑤ task-card 标题真 Link 化（键盘 tab 可达）；⑥ 新规则文件 `.cursor/rules/ui-conventions.mdc`（导航 / 链接 / 反馈 / 设计 skill 用法四节）+ 引入 `frontend-design`（Anthropic 官方）和 `ui-ux-pro-max` 两个设计 skill 进 `.cursor/skills/`
- **mac 更新提醒 + markdown 链接统一新窗口（v0.7.7）**：① mac 壳启动时请求 GitHub `releases/latest` 拿 302 location 抠版本号（不走 API 不吃 rate limit）、比 `app.getVersion()` 新则弹「打开下载页 / 稍后」+ 复用 badge 链路（注入 `__appUpdateMode: install|download`、UpdateBadge 按 mode 切 confirm 文案、`app-update://install` 壳侧分流 win quitAndInstall / mac openExternal 下载页）；② AI 回复 / artifact 里 markdown 原生链接此前是裸 `<a>` 同 frame 导航、桌面端点相对路径链接整窗跳 404（用户实测「点了没反应」）——新增 `src/components/markdown-link.tsx` 统一渲染：http(s) → target=_blank（浏览器新 tab / Electron 转系统浏览器）、相对路径 / 其它协议（AI 幻觉链接）→ 等宽纯文本不可点；事件流 MarkdownText + artifact-panel 两处 ReactMarkdown 接入；cursor:// 跳转（artifact code 组件 / 事件流附件）与 MR 外链行为不变
- **安装包平台依赖修正（v0.7.6）**：win 同事「获取模型列表」报 `Unexpected token '<'`（前端拿到 HTML 500 页）、排查实锤两个 ubuntu 组包带来的平台 bug：① `sqlite3` 的 `.node` 是 linux ELF、win/mac 上 require 直接 `ERR_DLOPEN_FAILED`（mac 同源布局 sqlite3 整包缺失反而没事——`MODULE_NOT_FOUND` 走 SDK 降级、「存在但错架构」吞不掉）；② SDK 平台工具包 `@cursor/sdk-<platform>`（ripgrep + 沙箱 helper）运行时动态拼名加载、nft 追不到、全平台缺失——修法：electron win/mac job 解 tar 后在**目标平台 runner** 上 `npm install --no-save` 补对应平台的 sqlite3 + SDK 平台包、再 `node -e "require('sqlite3')"` 实加载验真防带病发版。⚠️ 欠账：绿色包 win zip（ubuntu 组）同样带 linux sqlite3、待跨平台拉 prebuilt 修；本地 dev 组包（isolated trace）sqlite3 / 平台包整包缺失但有降级、一直能跑、不动

- **server 数据目录可注入**：新增 `src/lib/server/data-root.ts`（`FE_AI_FLOW_DATA_DIR` env 优先、回落 `process.cwd()/data`）、task-fs / mcp-oauth / uploads route 三处硬编码全部改走它——Electron 下 data 落系统 userData、dev / 绿色包行为不变
- **Electron 壳 `electron/main.js`**（纯 JS、不过 tsc）：单实例锁；`spawn(process.execPath, [server.js])` + env 三件套（`ELECTRON_RUN_AS_NODE=1` 让 execPath 表现为 node 且被 hooks 孙进程继承 / `PORT=8876` + `HOSTNAME=127.0.0.1` / `FE_AI_FLOW_DATA_DIR=userData/data`）；起 server 前探 8876 端口、被占（旧绿色包还在跑）弹 dialog 确认后杀占用进程；轮询就绪后开 1280x800 窗口（记忆上次尺寸）；关窗杀 server 子进程；win `autoUpdater.checkForUpdatesAndNotify()`（mac 未签名跳过）
- **electron-builder**：壳进 asar、组好的 server 布局（standalone + prompts/skills/scripts、**删 data/ 防隐私泄漏**）走 `extraResources` 进 `resources/app-server/` 不进 asar；**不再打便携 node**（Electron 自带运行时）；win `nsis`（oneClick、装用户目录免管理员）+ mac `dmg`（arm64）；`publish: github` 自动产 `latest.yml` 喂 electron-updater；图标 `packaging/icon.png`（buildResources 指 packaging、builder 自动转 ico/icns）
- ⚠️ **electron-app 依赖必须用 pnpm 装**：electron-builder 按根 lockfile 判定 pm=pnpm、npm 装的 node_modules 收集不到、会 fallback 把主项目 production 全家桶打进 asar（实测 271M → 修后 2M）
- **CI**（v0.7.15 起绿色 zip job 已删、唯一发版链 = electron）：electron win/mac 矩阵 job **复用 ubuntu job build 的 standalone**（tar artifact 传递——纯 JS 跨平台、且 win runner 上 next build 撞 `EPERM scandir "Application Data"` junction 必须绕开）；组 server 布局逻辑从 `package-release.mjs` 抽公共函数 `scripts/lib/assemble-server.mjs` 复用；v0.7.0 tag CI win 失败、v0.7.1 修复重发
- 已知风险（用户已确认）：未签名 exe 首次装 SmartScreen 要点「仍要运行」；mac 无公证 autoUpdate 不可用；桌面端 localStorage 独立于浏览器、设置要重配；旧 data 迁移 = 手动拷 `data/` 到 userData（mac `~/Library/Application Support/fe-ai-flow/` / win `%APPDATA%\fe-ai-flow\`）

### V0.6.34：win launcher 一键自动更新——有新版自动停旧进程（2026-06-11）

背景：原 launcher 流程「端口在跑 → 直开浏览器退出」、更新永远轮不到——同事得先去任务管理器杀 node.exe 才能吃到新版、对非前端复杂度太高。

- **`packaging/launch.ps1` 流程重排**：先查 GitHub latest（fail-open）→ 端口在跑且**无新版** = 直开浏览器（日常零感知）；在跑且**有新版** = `Stop-ServerOnPort`（`Get-NetTCPConnection -LocalPort` 拿 PID + `Stop-Process`、老系统 fallback netstat 解析；只杀监听本端口的进程、不误伤其它 node）→ 等端口释放 → 走原更新 + 重启
- 同事体验：发新版后**只需再双击一次桌面图标**、停进程 / 更新 / 重启全自动
- ⚠️ 鸡生蛋：这个新 launcher 本身要随包分发——**同事吃 v0.6.34 这一次仍需手动停一次服务（或重启电脑后点图标）**、从下一版起才是真·一键
- 取舍：点图标时 agent 正在跑任务会被中断——主动行为、可接受；mac launcher 未同步改（主要用户是自己、需要时再说）

### V0.6.33：「再聊聊」改非模态停靠弹窗（2026-06-11）

背景：Windows 同事反馈——plan tab 点「再聊聊」、模态弹窗遮罩把方案文档整个挡住、写 revise 反馈时没法对照文档「摸瞎写」。所有 action 的再聊聊共用同一个 `revise-dialog.tsx`、一处改全生效。

- **`ui/dialog.tsx` 新增 `DialogDockedContent`**：非模态「角落停靠」变体——无 Backdrop 遮罩、固定视口右下角（`w-[min(28rem,100vw-2rem)]` + max-h 内部滚动）、典型 UI 组件下沉 ui/ 单一来源
- **`revise-dialog.tsx`**：Root 加 `modal={false}`（不锁滚动 / 不拦点击 / 不 focus trap——弹窗开着可滚动、选中左侧 artifact 文本）+ `disablePointerDismissal`（点外部不关、草稿不丢；Esc / X / 取消仍可关）、Content 换 `DialogDockedContent`
- ⚠️ base-ui 1.4.1 的 prop 名是 `disablePointerDismissal`、不是新文档里的 `dismissible`（typecheck 踩过）
- 输入框 / 贴图 / Cmd+Enter / memo 防抖那套全不动；AskUserDialog（AI 选择题）保持模态不动——选项在弹窗内自洽、不需要对照文档
- **.1 补丁（用户实测指出）**：非模态后弹窗开着「通过」等按钮仍可点、ack 走掉后弹窗悬空指向已结束的 action——task page 把 canAck 提为 useMemo + effect「canAck 一丢自动收弹窗」、任何路径（通过 / 停止 / agent 推进 / 重启）都兜住

### V0.6.32：path-utils Windows 路径适配（2026-06-11）

背景：Windows 同事（V0.6.30 绿色包用户）反馈 artifact 里的文件路径不可点击跳转。根因：agent 在 Windows 业务仓写的路径是 `D:\IdeaProjects\...\Api.java` 盘符 + 反斜杠形态、`src/lib/path-utils.ts` 整套只认 `/`。

- **`looksLikePath` / `buildCursorLink` / `pathBasename`**：计算前把 `\` 归一化成 `/`；盘符绝对路径（`D:\` / `D:/` 起手）视作绝对路径不拼 baseDir；cursor 链接拼成 `cursor://file/D:/...`（同 VS Code `vscode://file/c:/...` 约定、**盘符段 `:` 不 encode**、encode 了 Cursor 不认）
- **`getCommonParentDir` / `getEffectiveCwd` / `getRepoShortNames`**：同样归一化、Windows 多仓（`D:\IdeaProjects\` 下三仓）能算出 `D:/IdeaProjects` 公共父目录（原来算出空串、SDK run cwd 直接坏）；跨盘符返 `""` 走 fallback；裸盘符公共段补 `/`（`D:` 是盘相对语义）
- 输出统一正斜杠：Node spawn cwd / Cursor 协议在 Windows 都接受 `/`、下游字符串比对单一化
- 单测 +9（盘符链接 / 带行号 / 反斜杠相对路径拼 baseDir / basename / Windows 多仓 cwd）、全量 64 测试过

### V0.6.31：revise 跳处理自动纠正 + mac 绿色包（2026-06-10）

**A. 「未处理 revise」服务端自动纠正（用户实测踩坑、harness 硬化）**：

- 实测事故：用户对 review #23 点「再聊聊」问了个问题、agent 收到 [ACTION_ACK revise] 后**什么都不干**（没答疑没弹窗）、直接重调 wait_for_user 且不带 action_id → 服务端入待命态、pendingAck 被清、UI 只剩「推进」、用户没法再对该 action 说话。prompt 协议写了「处理完带同一 action_id 重新等」、但纯软约束、模型这次没遵守
- 修法（chat-mcp、GLOBAL_KEY bump V10）：`unansweredRevises` Map（taskId → {actionId, artifactPath}）——revise ack 时置位；agent 重调 wait_for_user **不带 action_id 且标记在** → 服务端**强制按原 action 注册 ack 态**（UI 的 通过/再聊聊 不丢、用户可继续追问）+ 引导文本头部加「🚨 协议违规已被纠正」段责令先补处理（问类 emit 答疑 / 改类弹窗）再跑 shell
- 标记清除：带 action_id 重新等（正轨闭环）/ approve / 用户推进新 action（submitNextAction）/ cancelPending（取消、重启 action）。内存态、服务重启丢——重启本来就断 run、合理取舍
- 配套 prompt 收紧：_super.md / action-{plan,build,review}.md 的「处理完再调一次 wait_for_user」补「**必须带同一 action_id**、不带 = 服务端判协议违规自动纠正」
- 状态一致性由服务端兑付：agent 听不听劝只影响答复质量、UI 不再被带坏

**B. mac 绿色包（darwin-arm64 / darwin-x64）**：

- `package-release.mjs` 加平台位置参数、CI 一次出 3 包；darwin 便携 node 从官方 tar.gz 只抽 `bin/node`、zip `-y` 保留可执行权限
- `packaging/launch-mac.command`：双击即跑、逻辑同 win 版（已跑直开 / releases 自动更新 rsync 覆盖留 data / nohup 起 server / 等端口开浏览器 / 桌面软链快捷方式）；启动时 `xattr -rd com.apple.quarantine` 自解包内 node 的 Gatekeeper 标记、**首次需右键 →「打开」过门**（README 已写）；更新下载按 `uname -m` 选对应架构 asset
- mac 实机验证：解 zip → launcher 语法 ✓ → 便携 node 起 standalone server（首页 / API 200）✓

### V0.6.30：Windows 绿色包发版链——零 node 环境同事解压即用（2026-06-10）

背景：后端同事机器没 node / pnpm、源码跑门槛太高。方案 = 绿色 zip（standalone + 便携 node + 静默 launcher）+ GitHub Release 自动发版自动更新。用户拍板不做 Docker（本地优先架构：agent 改本地仓 / cursor:// 跳本地 IDE / hooks 注绝对路径、容器全断）。

- **standalone 构建**：next.config 按 `BUILD_STANDALONE=1` 开 `output: "standalone"`（日常 dev / `pnpm serve` 的 next start 不受影响、env 隔离）；`outputFileTracingRoot` 固定项目根——home 下有杂散 lockfile 时 Next 把 workspace root 推断到 `~`、standalone 产物嵌套整段 `Documents/my/...` 路径（实测踩到）
- **组包脚本 `scripts/package-release.mjs`**：standalone 平铺为包根（server.js 启动自带 `process.chdir(__dirname)`、prompts / scripts / data 等 `process.cwd()` 路径全命中）+ 显式拷 prompts / skills / hook 脚本 + 便携 node（latest v22.x、只抽 node.exe 一个文件）+ launcher + VERSION。**隐私剔除**：file tracing 会把本机 `data/`（任务数据 + mcp-oauth 凭证）拖进 standalone、组包无条件删
- **launcher（`packaging/`）**：`start.bat` → `launch.vbs`（wscript 零闪窗）→ `launch.ps1` 四步：已跑则直开浏览器；启动前查 GitHub releases/latest、有新版下载 robocopy 覆盖（`data/` `logs/` 排除保留、网络失败 fail-open 不挡启动）；起包内 node 跑 server（隐藏窗、日志落 `logs/`）；等端口 → 开浏览器 + 首次自动建桌面快捷方式。⚠️ ps1 / vbs / bat 故意纯 ASCII 注释——Windows PowerShell 5.1 对无 BOM UTF-8 中文会乱码、可能破坏解析
- **hook 注入 node 改 `process.execPath`**（stop-hook-inject）：绿色包机器 PATH 可能没 node、裸 `node` 命令两道闸必挂；execPath 正好指向包内便携 node.exe、源码跑 = 系统 node、行为不变
- **CI 发版 `.github/workflows/release.yml`**：push `v*` tag → build + 组包 + 传 GitHub Release（仓库 public、匿名可下）。发版 = 打 tag 一步、同事侧 launcher 下次启动自动更新

验证：mac 本地 standalone 组包后实际起包（首页 / API / 静态资源 200、data/ 运行时自建）✓；typecheck / lint / 55 测试 ✓。⚠️ Windows 实机（bat / vbs / ps1 / 快捷方式 / 自动更新）待同事验。

### V0.6.29：learn action 实装——三层知识架构 + 防臃肿铁律（2026-06-10）

learn 从 V0.6.0 stub 转正、用户拍板设计（对标 Spec Kit constitution / OpenSpec living docs / superpowers skills 理念）：

**三层知识架构（learn agent = 知识路由器 + 园丁）**：

| 层 | 载体 | 加载方式 |
|---|---|---|
| L1 约定 / 习惯（短判断式） | 业务仓 `.cursor/rules/<主题>.mdc` | 通用 `alwaysApply`、专题 `globs` 定向（碰到匹配文件才注入） |
| L2 过程知识（step-by-step 手册） | 业务仓 `.cursor/skills/<name>/SKILL.md` | 按需唤起、复利最高 |
| L3 业务域知识（名词表 / 模块地图） | `business-glossary.mdc` | 常驻、条目极简 |

第 4 类 harness 建议（ai-flow prompt 缺陷）**只 propose 不落地**（agent 自改自己 prompt 有自污染风险）。

**核心机制**：
- **证据驱动**：挖全部 artifact + 事件日志的四类高价值信号（用户 revise 原话 / ask_user 拍板 / review bug + 用户裁决 / check 失败）——凭印象编造被后置检查 fail
- **两段式 HITL**：propose 表 → ask_user 逐条筛（落地 / 否决、复用 review §6 模式、零新 UI）→ 批准的才写知识载体 → wait_for_user
- **防臃肿铁律（用户拍板的一等约束）**：4 道准入闸（跨任务复用 / 证据强度 / 代码自明 / 预算 ≤7 条）+ 园丁义务（写前 read 目标文件、重复 merge 不新增、过时条目出修订、文件超 150 行提拆分）+ 0 条是合格结果
- **写入边界**：只许 `.cursor/rules/**` / `.cursor/skills/**` / `AGENTS.md`、不碰业务代码、不碰 .git（改动停工作区、用户顺手带进下次提交）

**准入放宽**（对老草稿）：merged-only + 一次性 → 「≥1 个 completed action 即可、可多次跑」（沉淀点在 review 阶段就暴露、第二轮先读上一轮不重复提炼）；merged 后推进 dialog 默认选 learn。

**改动面**：`action-learn.md` 全量重写；task-runner 准入解禁（`AVAILABLE_ACTIONS` + learn 前置条件）+ `loadActionPrompt` 补 `{{eventsLogPath}}` 供值（占位符对账测试当场抓到漏供）；`checkLearn` 后置检查（必备段 + 证据路径逐条验真 + 落地记录闭环）；advance-dialog 解禁 learn。⚠️ 真机跑一轮 learn 待用户验。

**同日实测追加（用户连续反馈）**：
- **ask_user 弹窗问题 markdown 渲染**：`MarkdownText` 从 event-stream/rows export、ask-user-dialog 问题文本从裸 `<p>` 换 markdown（原来 `` `code` `` / 列表全是字面量）
- **MCP 开关弹回 bug**：mcp-toggle-list 自管模式 PATCH 成功后丢弃返回 task、干等 SSE——而改黑名单只写 meta 不产生事件、SSE 永不推、开关「闪一下弹回」。修法对齐 ContextDocsPanel：PATCH 返回 task 经 `onUpdated → onTaskUpdate → setTask` 回传
- **learn 卡片副标题残留**：advance-dialog 副标题原是嵌套三元、fallthrough 把「沉淀」也显示成「提 MR 到 test」——抽 `ACTION_SUBTITLE` 常量表；顺带清掉 chat-mcp / page / finalize route 里「V0.6.3 起 / V0.6.0 不实现」的过期 learn 文案
- **批次选择加「自由改动」选项卡**（用户提议的形态）：批次列表末尾加显式选项卡「自由改动（不绑定批次）」、跟批次勾选互斥——三态全显式：选批（按批做计进度）/ 自由改动（`buildBatchDirective` 注入「不绑定批次」指令：范围以指令为准、不顺手开做未完成批次、不计批次进度）/ 都没选（拦提交、语义不明）。老语义「空=全做」废弃、想全做点「全选」
- **增量 build artifact 布局**：本轮动过的 task 置顶详写、沿用项收拢成段尾「### 沿用 / 未触及」一行清单（原来按 plan 顺序穿插、增量被夹在沿用中间）；沿用引用写行内代码 `` `build #18` ``、`looksLikeArtifactRef` 扩展识别 `<type> #<n>` 形态 → 点击跳转对应 action
- **hook 脚本 .sh → Node .mjs**（同事 Windows 实测踩坑）：hooks.json command 指 .sh 时 Windows 没 shebang 机制、按文件关联把脚本「打开」到 IDE（每次 hook 触发弹一次）、且两道闸（stop 交卷 / shell-guard）在 Windows 从未生效。改写 `stop-hook.mjs` / `shell-guard.mjs`（node 内置 fetch、去 bash/curl 依赖）、注入 command 改 `node "<绝对路径>"`；`upgradeFeHooksJson` 改「全量重写」——fe 自建的 hooks.json 跟期望（buildHooksJson 单一源）不一致直接覆盖、老 .sh 形式拉代码重跑任务即自动迁移；.sh 删除不留兼容

typecheck ✓ / lint ✓ / 55 测试 ✓。

### V0.6.28：cursor 链接多段行号宽容解析 + task 中途追加仓库（2026-06-10）

**A. cursor:// 链接多段行号（同事 + 用户双实测踩坑）**：

- agent 在 artifact 里写 `index.tsx:54,81-84,99` / `SendOrderDetail.vue:20-88, 189-210` / `TaskInfo.vue:147-154、1350-1363` 这类**逗号 / 顿号多段行号**——违反 `_shared.md` 路径硬约束第 4 条（每段补完整 path）、但 prompt 防不住、前端接管：
  - `path-utils.ts`：`parsePathWithLine` 正则放宽（逗号 / 顿号 / 分隔符后空格都认）；`looksLikePath` 空格校验只查路径部分（原来整条含空格直接拒、多段写法整条丢链接）；新增 `parsePathSegments` 把每段完整拆解（text / 起始行 / 前置分隔符）
  - `artifact-panel.tsx`：多段行号渲染成**每段独立 cursor:// 链接**、点哪段跳哪段（原来只能跳首段）、分隔符原样保留视觉跟原文一致
  - 新增 `tests/path-utils.test.ts`（16 用例、两次实测踩坑 case 全覆盖）
- 旧症状备查：多段后缀被当文件名 encode 进链接 → Cursor 弹「路径不存在」（前台）或静默无反应（Cursor 在后台、用户感知「点了没反应」）

**B. task 详情可中途追加仓库（同事需求「做着做着发现依赖另一个仓」）**：

- **只增不删**（用户拍板：删仓涉及已建分支 / MR 残留引用、边界多收益低）
- `edit-task-dialog`：已绑仓只读、下方新增「追加仓库」MultiSelect（候选 = settings.repos 减已绑）、提交时从 settings 现取新仓 per-repo 快照（线上 / 测试 / dev 分支、命名模板、check 命令）随行传——跟建 task 同款逻辑、server 读不到 localStorage
- `task-fs.updateTaskFields` 加 `addRepoPaths` + 5 个 `addRepoXxx` 快照字段：并集语义、快照只 merge 新增仓 key 不覆盖老仓固化值；PATCH route / task-store 同步
- **关键配套：`ActionRecord.cwd` 快照**——追加仓库会让 `getEffectiveCwd` 从单仓自身变公共父目录、artifact 相对路径基准漂移；`appendAction` 现在快照创建时 cwd、详情页 `baseDir` 优先用快照（老数据回退实时计算）、改仓后老 artifact 链接不失效
- 生效语义跟切模型同款：正在跑的 run 不受影响（cwd 启动时绑死）、下一个 action 生效；新仓下次 build 自动建分支（`planBranchesForBuild` 对无条目仓新建、零额外处理）

### V0.6.27：全面 review 落地——3 bug 修复 + harness 硬化 + 测试基建（2026-06-10）

外部 review AI 全面审计（代码健壮性 / 流程设计 / prompt 闭环性）后用户拍板「全部都改」、一次性落地：

**A. 确认 bug 修复（3 条）**：
- **B1 跨 chunk 锁失效**：`task-fs.taskLocks` / `task-runner.advanceChains` 是 module-level Map、没挂 `globalThis`——跟 chat-mcp（V9）/ runningTasks（V4）的既有策略矛盾、Next.js dev 下不同 route chunk 各持一份锁、`withTaskLock` / `runAdvanceExclusive` 跨 route 不互斥。两个都改挂 `globalThis`（`__feAiFlowTaskFsLocksV1__` / `__feAiFlowAdvanceChainsV1__`）。
- **B2 DELETE 漏停 chat agent**：`DELETE /api/tasks/[id]` 只调 `cancelTaskRun`、漏 `cancelChatRun`（stop route 两个都调）——删运行中的 chat task 泄漏 agent。补上。
- **B3 finalize 不停运行中 agent**：`finalizeTask` 在 agent running 中（无 pending）时 `submitTaskTerminate` 返 false 只 log——abandon 后 agent 继续改代码、之后长挂到超时。改成 terminate 失败且有活 run → `cancelTaskRun` 硬停。
- 顺带：`appendEvent` 去 O(N²)——原来每条事件 `readMeta + writeMeta + hydrateTask(全量重读 events.jsonl)`、事件高频时是平方级写放大。改成轻量路径：追加事件行 + meta.updatedAt 节流写（>5s 才落盘）、不再 hydrate 返回 Task（调用方只用 event 本身）。

**B. harness 硬化（prompt 软约束 → 确定性约束）**：
- **shell 命令策略引擎**：`beforeShellExecution` hook（`scripts/shell-guard.sh` + `src/lib/server/shell-guard-rules.ts` 单一规则源）拦高危命令——`--fix` / `git push -f` / `git reset --hard` / dev server / 全局安装等、`_shared.md` 同款规则从「祈祷」升级「硬拦」。hooks.json 注入扩展为 stop + beforeShellExecution 两条（`stop-hook-inject.ts` 改名义保留、内容升级、已存在的旧 hooks.json 自动升级补缺）。
- **review 只读硬校验**：review action 启动时 `captureActionStartBaseline` 记录各仓 `worktreeFingerprint` 到 `action.startBaseline`、`checkReview` 重算比对——agent 在 review 期间改了任何仓即 check fail（原来纯 prompt 约束）。
- **plan / build artifact 小节 lint**：`checkPlan`（需求理解 / Task 拆分）/ `checkBuild`（全量校验 / 修改记录）加必需小节 regex 检查（抄 `checkReview` 现成做法）。
- **协议信号常量化**：新增 `src/lib/protocol-signals.ts`——`[NEXT_ACTION]` / `[ACTION_ACK ...]` / `[KEEPALIVE]` 等全部信号的单一常量源、`chat-mcp.ts` / `wait-ack route` / task-runner 全部引用它、防三处手写漂移。
- **多仓兄弟仓污染检测**：build action 启动时对 effective cwd 下「非本 task 的兄弟 git 仓」记 `git status` hash 基线、checkBuild 重算比对、变了在 details 记 warning 不拦（agent 越权改兄弟仓可见）。

**C. 流程演进**：
- **F1 每 action 新 agent 默认化**：原默认「单 SDK Run 跑全 task、forceNewAgent 是例外」反转为「**每 action 默认新 agent**、续用是例外」——context 膨胀是跑偏的物理根源、artifact 本来就是 action 间唯一通信媒介（review forceNewAgent 已验证可行）。连带 super prompt 不再全量注入 7 个 action playbook、只注入当前 action 的（体积 -60%+）；同 agent 续接收到 `[NEXT_ACTION]` 时由 server 在载荷里附带新 action 的完整 playbook。UI「换新 agent」勾选改为「续用当前 agent」（语义反转、默认不勾）。
- **F3 ship 未 review 提示**：ship-precheck 返回「最新 build 之后没有 review 记录」信号、推进 dialog 非阻断展示。

**D. 测试基建（0 → 1）**：
- 引入 vitest、`pnpm test`（37 用例、4 文件、tests/ 目录）。只测安全关键纯函数（不追覆盖率）：`shell-guard-rules` 拦截矩阵（每规则必拦 + 必放）、`validateSubmitMr` 越权矩阵 + remote URL 解析、`sanitizeCheckCommands` 清洗约束、`protocol-signals` ↔ `_super.md` 信号一致性 + 全部 prompt 模板占位符 ⊆ 渲染端供值表（防 placeholder 漏渲染 / 信号漂移）。历史上 checkShip 正则漏检 / review diff hash 死代码两个 bug 都是这类 5 行单测能当天抓住的。
- 一致性测试当场抓到真问题：`INTERNAL_ERROR` 在 grep 终态表里、`_super.md` 却从没教过 agent 这个头（review 发现的漂移）——prompt 补「重调一次 wait_for_user、连续 2 次才退 Run」。
- `validateSubmitMr` 从 task-runner 挪到独立 `src/lib/server/submit-mr-guard.ts`（task-runner 瘦身第一步、顺带抽 `parseProjectPathFromRemoteUrl` 纯函数）。
- `TaskMetaV06` 校验从手写 4 字段升级 zod schema（zod 已在依赖、chat-mcp 工具早在用）、含 actions[] 逐条 ActionRecord 校验、失败打前 5 条 issue 路径。

`pnpm typecheck` ✓ / `pnpm lint` ✓（0 warning）/ `pnpm test` 37/37 ✓。⚠️ 真机实测待用户验（重点：F1 默认新 agent 的推进体验、shell-guard 误伤率、review 指纹校验）。

---

### V0.6.26：CheckRun 自动检测常见检查命令（默认免配置、2026-06-09）

V0.6.25 CheckRun 上线后 check 命令全靠用户 per-repo 手填、没填的仓 build 后记 not_configured（如 crm-web 明明有 lint/tsc 却显示「未配置」）、手填心智负担高、不符合 harness「降低流程负担」。本版改成**自动检测为主、手动配置为 override**：

- **新增 `src/lib/server/repo-check-detect.ts`**：`detectRepoCheckCommands(repoPath)` 按 repo 文件结构识别常见检查命令、**只读不执行**、任何异常兜底返 `[]`（绝不挡建 task）。第一版保守覆盖：
  - **Node/前端**：读 `package.json.scripts`，`scripts.lint` → `<pm> run lint`、`scripts.typecheck`(优先)/`scripts.tsc` → `<pm> run <script>`、均 required=true + 120s。包管理器按 lockfile 判（pnpm-lock/yarn.lock/bun.lock(b)/package-lock、无则 npm）。**故意不输出 test/build**（test 慢 / 依赖 DB·Redis / CheckRun 期间卡用户；build 太重）——保留识别能力 + placeholder（`no test specified`/`exit 1`）过滤逻辑写在注释里、后续放开。
  - **Maven**：有 `pom.xml` → `mvn -DskipTests compile`（required=true + 10min；后端单测常依赖 DB/profile、默认跑 compile 最稳；kind 复用 typecheck、不为文案扩 enum）。
  - **Gradle**：有 `build.gradle(.kts)`/`settings.gradle(.kts)` → `<wrapper|gradle> compileTestJava`（**required=false** + 10min；reviewer 拍板——compileTestJava 在 Android[无此 task→报错]/纯 Kotlin[不编译 .kt→假绿] 不通用、不当自动 required gate、不自动挡 ship、用户可手动覆盖；选它而非 compileJava[多模块漏检]/`build -x test`[重型打包]——gradle 自动传播全子模块、覆盖完整且轻；优先 `./gradlew`、没有才退系统 `gradle`）。
- **合并优先级 `manual override > auto detect`**（`task-fs.createTask`）：抽 `sanitizeCheckCommands(cmds, source)` helper 让手动 + 自动两条来源走**同一道约束**；建 task 遍历 `repoPaths`——input 显式给了该仓命令数组 → 用手动(source=manual)、否则 `await detectRepoCheckCommands`(source=auto)。
- **数据语义**：`CheckCommand` 加 `source?: "manual" | "auto"`（不影响执行、审计 + 未来 UI 徽章、由 sanitize 统一打标不信 client）。
- **边界（第一版保守）**：只影响**新 task**（老 task 快照不动、后续可加「重新识别」按钮）；只看 **repo root**（不做 monorepo workspace 粒度）；**「空数组 = 禁用检测」暂不从 UI 暴露**——现状 settings→dialog→route→createTask 四环节都 `length>0` 过滤、空数组跟未配无法区分、语义就是「有手动用手动、没手动则检测」（createTask 层 `Array.isArray(manual)` 已为将来 route 放开空数组留好路）。
- **UI**：设置页 repo-card 文案改「检查命令（留空自动识别、可手填覆盖）」；不做「自动识别结果预览」复杂 UI（数据先落、build 后 `CheckRunSummaryCard` 已能看实际跑了啥）。
- `pnpm typecheck` ✓ / `pnpm lint` ✓。detect 模块 9 用例 smoke test 全过（Node 三 pm / Maven / Gradle wrapper·无 wrapper / 空仓 / placeholder 不输出 / 幽灵路径不抛错）。⚠️ 真机建 task 实测待用户验。

---

### V0.6.25.1：CheckRun review 二轮加固（ship gate 严密化、2026-06-09）

第二个 review AI 审 CheckRun 后提的 5 条 gate 语义问题、全部成立全修（typecheck + lint 全绿）：

- **工作区指纹绑定**：原 ship gate 只看 `checkRun.status === passed`、证明不了「ship 时工作区还是 check 过的内容」（build 改动停在工作区、HEAD 不变）。每仓加 `worktreeFingerprint = sha256(headCommit + git diff HEAD + untracked 逐文件 hash-object)`、check 结束记录、`checkShipCheckGate`（改 async）ship 前重算比对、不一致即使 passed 也要 override。新增 `GET /api/tasks/[id]/ship-precheck` 让 client 拿 server gate 结论展示 override 区（client 算不了 git 指纹、不自己猜）、`/advance` 仍重算 gate（precheck 仅 UI 不授权）。
- **多仓 not_configured 不再误判 passed**：原「全仓 not_configured 才算 not_configured」会让「A 仓过 + B 仓没配（但被改）」整体算 passed、掩盖 B 没检查。改成识别每仓是否被本次 build 改过（dirty）：没配但 dirty → not_configured（拉低整体、ship 要 override）、没配且 clean → skipped（不影响）；run 级**任一** not_configured 即整体 not_configured。
- **mutated 无视 required**：工作区污染是独立安全语义、`required=false` 可表「失败不挡 ship」但不能「改了源码还绿灯」。聚合改 `mutated || requiredFailed → failed`。
- **checkCommands 硬上限**：命令被 server 自动执行、加防呆——每仓≤10 条 / name≤80 / cmd≤2000 / timeoutMs clamp[5s,30min]；`runCheckShell` output 累积 >512KB 截断打 `[output truncated]`。
- **修注释漂移**：`action-checks.ts` 顶部「build V0.6.3 撤掉」旧注释更新为 V0.6.25 CheckRun 复活。
- **契约收口**：删除 `CheckOverride.headCommit` 字段（server 已不信 client 传 headCommit），override 只绑 `buildActionId + checkRunId + reason`；工作区内容是否仍有效统一由 server 重算 `worktreeFingerprint` 判定。

**踩坑记**：本轮改大文件（task-runner.ts 2200+ 行）时 StrReplace 多次「幻影成功」（报 updated 但没落盘）、Read/Grep 偶发返回错乱内容。最终靠 `pnpm typecheck` 当唯一可信 oracle 逐项验证 + 小块改 + 改完即 Grep 复核才收敛。教训：大文件改动必须 typecheck 验证、别信工具的「成功」回执。

### V0.6.25：review 5 连修复 + Build CheckRun（确定性校验、2026-06-09）

本轮两件事：先修另一个 review AI 审出的 5 条问题、再落地讨论收敛的 **Build CheckRun**（build 后置确定性校验、补 V0.6.3 撤掉的 build check 空白）。

**A. review 5 连修复**（验证事实后修、2 条「跟设计冲突」不修）：
- **P0-1 action ack 不绑 pending**：`chat-mcp.submitActionAck` 校验 `actionId` 命中 pendingMap 当前条目且未 resolved；`acknowledgeAction` 强制 `action.status === "awaiting_ack"`——防 agent 拿旧 / 错 actionId ack 蒙混。
- **P0-2 submit_mr 全信 agent 入参**：`task-runner` 加 `validateSubmitMr`——`repo_path` / `actionId` / `target_branch` / `source_branch` / `project_path` 全部跟权威 task 数据 + git remote 派生值核对、不信 agent 自报。
- **P1-1 ship 漏未提交改动**：`action-ship.md` 把 `git add -A && commit` 提到 `git diff` 判断**之前**——否则未提交改动会被「diff 为空 → 跳过 push」误跳。
- **P1-2 review diff hash 死代码**：旧正则找「git rev-parse hash: <x>」字面、跟骨架「基底 commit：`<x>`」对不上、从不命中。改正则抠「基底 commit」真值跟 `git rev-parse HEAD` 比对、prompt 同步澄清（review 不动工作树、无 diff hash 字段）。
- **P1-3 agent 启动并发竞态**：`advanceTask` 包一层 per-task 串行锁 `runAdvanceExclusive`——同 task 并发推进请求排队执行、防两个 agent 抢起。
- **不修**：P0-3（build 确定性 check 缺失——本轮用 CheckRun 正式补）、P1-4（fs / 附件任意绝对路径——HANDOFF 明确「server 同机、绝对路径是 feature 不是 bug」）。

**B. Build CheckRun**（门槛 2 的 build 实现、设计见 HANDOFF「当前架构快照 · Build 后置 CheckRun」段）：
- **复用现有钩子不新建机制**：CheckRun 是 build 的 side effect、走现成 `runActionCheck` → `action.postCheck`（红绿条）+ 新增 `action.checkRun`（结构化明细）、**不**新增用户可见 action 步骤。
- **per-repo 配命令 + 快照链**：`RepoConfig.checkCommands`（设置页 repo-card 配）→ 建 task 时快照进 `Task.repoCheckCommands`（server 读不到 localStorage）→ runner 按快照跑。绕开 V0.6.3「写死 pnpm 搞死多栈」：没配命令的仓按 dirty/clean 分 `not_configured` / `skipped`、不把未改仓误报失败。
- **执行健壮性**：`sh -c` 跑（支持 `&&` / `cd` / 管道）· `detached` + 进程组 kill（超时连 `pnpm test` 起的子进程一起杀、防孤儿）· PATH 继承 runner + 补常见 bin · 每条命令**跑前后比 git tracked 状态**、命令偷改源码（如手滑 `--fix`）判 `mutatedWorktree = failed` · 完整日志落 `actions/.checks/<actionId>/<slug>.log`、摘要进 meta。
- **ship gate + per-ship override**：ship 读最新 completed build 的 `checkRun`、没过 / 没配 / 没跑时拦、要求用户在提测 dialog 勾「仍继续」+ 填原因（`CheckOverride` 绑 `buildActionId` + `checkRunId`、重 build 自动失效）；reason 进事件流 + ship action 审计字段（HITL 底线：永远能 override、但留痕）。
- **顺手修 pre-existing bug**：`tasks/route.ts` POST 漏接 V0.6.7 的 `repoTestBranches` / `repoDevBranches` / `repoBranchTemplates`（new-task-dialog 快照了但 route 没透传 → 提测目标分支一直回退默认 test）、一并补上。
- **展示**：build 产物面板正文上方挂 `CheckRunSummaryCard`（每仓 / 每命令红绿 + 失败日志末尾 + 完整日志路径）；设置页 repo-card 每仓加 `RepoCheckCommands` 编辑器（name / cmd / kind / 失败是否挡提测 / 超时）。
- **暂不做**（阶段二+）：全量 artifact graph schema · LLM 判定类 analyze gate · 自动 lens 选择 · 自动跑重型 test · task 级永久忽略 check。
- `pnpm typecheck` ✓ / `pnpm lint` ✓（0 warning）。⚠️ 真机实测待用户验。

### V0.6.24：分批 build 打磨——批次显示 bug 修复 + 进度条 chip 化 + 文案（2026-06-09）

V0.6.23 批次功能上线后的真机打磨（用户拿大需求边跑边修）：

- **批次不显示 bug（RCA 锁定）**：`getLatestPlanBatches` 原要求 plan `completed` 才认其批次。但 plan 重跑场景——act_1 拆了批次却因 serve 重启被标 `error`、act_2 接续 `completed` 却没重调 `set_plan_batches`——两个都被跳过、批次读不到（advance-dialog 选批没选项）。**读取侧**去掉 `completed` 限制（planBatches 是 agent 主动落库的有效数据、run 中断不影响）；**写入侧** `action-plan.md` 加 ⚠️「重跑 / 接续 plan 必须重调 set_plan_batches」（批次绑当前 action、不从上一版继承、系统兜底回退但别依赖）。
- **进度条 chip 化（UI）**：原 timeline 下常驻进度条用户嫌占高度 + 挡。改成详情页头部「上下文文档 / MCP」chip 行里的 chip + 点开 Dialog（对齐那两个的 chip+dialog 模式）——拆了批次=实色「批次进度 N/M」、没拆=灰色「未分批」chip 占位（点开也有引导）。`batch-progress.tsx` 重写。
- **选批默认值 + 全选**：advance-dialog 默认勾从「全部未完成」改「只勾下一个未完成」（remaining[0]、用户拍板）+ 加「全选 / 全不选」按钮。
- **A' plan 无批次提示条**：plan 产物顶部、该 plan 无 planBatches 时显示「本方案未分批 · 大需求可再聊聊让 AI 拆批次」（`artifact-panel.tsx`）——给「AI 漏调 set_plan_batches」一个可见信号 + 兜底入口。
- **测试策略文案**：`after`「事后测」（用户反馈费解）→「实现后测试」、`tdd`「TDD(先写测试)」→「先写测试(TDD)」对仗；全局 5 处统一 + `batch-plan-table.tsx` 脚注改走 `TEST_STRATEGY_LABEL` 单一源（修之前硬编码漂移）。
- **加固决策**：讨论过给 build 加「测试必须真跑且绿才算完成」硬 gate、结论**暂不加**（前端多 after/none 会误伤 / 跨框架检测复杂 / 跟 review 重叠 / 符合分阶段验证 ROI）——靠 prompt 引导 + review 把关。
- `pnpm typecheck` ✓ / `pnpm lint` ✓。

### V0.6.23：大需求「批次 + 分批 build」（已实装、2026-06-08）

**动机**：一个大飞书需求、`plan + 单次 build` 跑完不保险——上下文越跑越长、agent 改着改着就乱了、质量滑。

**对齐四大库调研**（详见 `docs/PRODUCT-COMPARISON.md`）：
- **Superpowers / GSD = 真分批 + 多 Agent**：每批换 fresh subagent + 每批自动复查（防上下文污染）。Superpowers 还强制 TDD + 两阶段 review；GSD 波次 gate + 目标倒推 verify。
- **Spec Kit / OpenSpec = 单 Agent 顺序跑清单**：靠「实现前把 plan/spec 拆够细 + 人审到位」保证质量、不靠多 Agent。
- **我们的位置**：无 subagent 原语（`@cursor/sdk` 不支持）、用 **「新启 Agent」**（`forceNewAgent`、换全新上下文 + 读前序 artifact）当等价物。**清单结构化我们已做了一大半**（plan §5 task 已带 精确文件路径 + 依赖 + 验收点 + 关键参考、约等于 Spec Kit）。

**方案**：全程**一个 task**（不拆多任务、满足用户硬要求）、plan 多产出「批次」层、build 可选「全做 / 挑批」、每批可新启 Agent、review 两层。

**数据模型**（`types.ts`、最小化、**进度纯推导不存计数器**）：
- `TestStrategy = "tdd" | "after" | "none"`——自适应 TDD：逻辑批 TDD / UI 批实现后测试 / 纯样式免测（**不强制**、对齐 Spec Kit「TDD 可选」、契合我们前端为主的现实）
- `PlanBatch { id; title; testStrategy; taskRefs: string[] }`——批次 = 可独立交付功能块、下挂 plan §5 的 task
- `ActionRecord.planBatches?: PlanBatch[]`——plan action 落；plan agent 写完 artifact 调 **MCP `set_plan_batches`** 上报（跟 `submit_mr` / `set_feishu_testers` 同套路、**不靠解析 markdown**）
- `ActionRecord.requestedBatchIds?: string[]`——推进 build 时**用户在 dialog 勾的批次、后端 advance 时直接存**（不靠 agent 上报、省掉第 2 个 MCP 工具）
- **进度 = 派生**：已做批 = ∪(completed build 的 `requestedBatchIds`)、总批 = 最新 plan 的 `planBatches`——不存「已完成 N 批」、避免漂移

**四块改动**：
1. **plan**（`action-plan.md`）：§5 task 拆分上加一层「批次」分组、每批标 `testStrategy` + 一句话目标 + independent test；写完调 `set_plan_batches` 上报
2. **build**（`action-build.md`）：开头从 `[NEXT_ACTION]` 指令读「本次做哪批」（用户 dialog 选的）；只做选中批次的 task；**TDD 批先写测试看失败再实现**；build artifact 记「本次完成批次 X」（给人看）
3. **review**（`action-review.md`）：两层——**增量**（只审本批 build 的 diff）/ **集成**（所有 planBatches 都 built 后、审批次间是否打架、借 GSD「目标倒推」）；判用哪层 = 看 `requestedBatchIds` 并集是否已覆盖全部 `planBatches`
4. **UI**（`advance-dialog.tsx` + `batch-progress.tsx`）：推进 build 时若最新 plan 有 `planBatches`、用 ChoiceButton 卡片列批次让用户勾（**默认勾未完成批次**、已做的带角标）+ 显示「X/Y 批」进度；详情页 timeline 下常驻 `BatchProgress` 进度条（M/N + 每批 chip、纯派生、没批次不渲染）

**关键决策**：批次结构走 MCP 上报（不解析 markdown）· 进度纯派生不存状态 · TDD 自适应不强制 · 批次不是独立 task（全程一个 task）· review 增量 / 集成由后端派生进度注入 `[REVIEW_SCOPE]`（agent 不自己猜）。

**数据流闭环**（实装）：plan agent 调 MCP `set_plan_batches`（chat-mcp 第 5 工具）→ runner `taskActionHandler` patchAction 落 `planBatches`；build 推进时 advance-dialog 勾批 → `/advance` 透传 `requestedBatchIds` → 落 build action → runner `buildBatchDirective` 拼 `[BUILD_BATCHES]`；review 推进时 `buildReviewScopeDirective` 注入 `[REVIEW_SCOPE]`；进度全程走 `task-display.computeBatchProgress` 派生（前后端共用）。

`pnpm typecheck` ✓ / `pnpm lint` ✓（0 warning）。⚠️ 真机大需求实测待用户验。

### V0.6.22：无限重连实测修复（errexit 坑）+ chat 回答截断兜底（2026-06-08）

**背景**：V0.6.21 上线后真机测「离开 >30 分钟」——shell 在 30 分钟时退出码 28 断开、while **没重连**。实测推翻 V0.6.21「本地验证 ✓」结论（本地 mock ≠ 真机）。

- **根因（实测锁定、非推测）**：terminal 显示单轮 KEEPALIVE 连续 30 个（30 分钟）零重连、`exit_code=28`（curl 超时码、**不是**强杀 137/143）、elapsed 正好 1800s。→ **SDK 跑 shell 默认带 `set -e` + `pipefail`**：首轮 `curl --max-time 1800` 超时（28）→ pipefail 让管道返回 28 → errexit 直接终止整个脚本 → while 永远进不了第二轮。**不是 SDK 有 30 分钟硬上限**（那会是 137）、idle-timeout 也没看错（KEEPALIVE 撑满 30 分钟没被空闲杀）。
- **修复（`chat-mcp.ts: buildShellWaitGuidance`）**：脚本开头加 `set +e +o pipefail`、curl 行加 `|| true`——curl 首轮超时不再终止脚本、while 真正进下一轮重连。+ AI 兜底：异常 exit 段从「直接报告退出」改「先再调一次本 shell 兜底、连 2 次才报告」。
- **⚠️ 待验证**：本次只证明 errexit 是 bug、**没测到「修了能跨 30 分钟」**（脚本第一轮就崩、没机会进第二轮）。退出码 28（非 137）强烈暗示能、但得改完再实测一轮 >30min 才算数。
- **附带：chat 回答截断兜底**：另一个 chat task 踩坑——AI 把「一句概述」误当完整答案、提前调 wait_for_user、完整接口说明没发出去（用户「发我」才补全）。两层防：① `buildShellWaitGuidance` 给 chat 场景加「跑 shell 前自检：完整答案发了吗？没发现在补、跑 shell 前仍可 emit」近提示（纠正「调了 wait 本轮发不出」的错误认知）；② `chat-runner.ts` 标准动作强化「emit 完整答案、不是一句概述就停」+ 反模式警告。
- `pnpm typecheck` ✓ / `pnpm lint` ✓。

### V0.6.21：wait-ack 长连接「无限重连」——离开多久都不断（2026-06-05）

**背景**：用户离开 >30 分钟（午饭 / 开会）、`curl --max-time 1800` 单轮到点断、agent 按引导 emit「连接断开请手动推进」退 run、回来发现 agent 死了得手动点「推进」。

- **方案**：wait_for_user/ask_user 引导给的「单条 curl」改「`while` 循环」——单轮 30 分钟到点 / 网络抖断 → 命令内自动**同 token 重连**下一轮、拿到终态行才退出。用户离开多久都不会断。
- **零记忆依赖**（关键）：重连写进 guide 每次返回的命令本身（最近的提示词）、不是教 agent「记得超时后重连」（放 system prompt 离得远会忘）——agent 只做它一直做的「拿 guide → 跑命令」、循环在 shell 内部。
- **代码基础本就支持**：`subscribeWaitAck` 不消费 token、route abort 不清 pendingMap entry → 同 token 能反复接上同一个 entry（只要没 ack / 没停 / 服务没重启）。
- **keepalive 可见性**：用 `tee` 实时透传 curl 输出到 stdout（agent 持续看到 KEEPALIVE）+ 存文件给 grep 判终态行——避免 `OUT=$(curl)` 全捕获让 agent 30 分钟看不到 stdout 触发「shell 卡了」bias。
- **退出**：`grep -qE` 命中终态行（NEXT_ACTION/ACTION_ACK/USER_REPLY/.../INVALID_TOKEN）才 break；只有 [STALE]/[INVALID_TOKEN]（dev 热重载 / 服务重启丢 pendingMap）或命令异常 exit 才退 run。
- **为什么不被 SDK 杀**（关键验证）：SDK shell 工具是 **idle-timeout（空闲/无输出超时）、不是总时长超时**（bundle 里 shell exec 类带 `idleTimeoutSeconds` 字段 + 现网单 curl 靠 60s KEEPALIVE 已能跑满 30 分钟为证）。while 每轮 curl 经 `tee` 持续透传 KEEPALIVE → 永不空闲 → 不被杀；最终 task 级 24h 硬超时（`TASK_HARD_TIMEOUT_MS`）兜底、即「无限」实际上限 24h。
- 改动：`chat-mcp.ts: buildShellWaitGuidance`（curl→while）+ 文件头注释「不做断线重试」改「断线自动重连」；`_super.md` / `chat-runner.ts` 异常段同步；`wait-ack/route.ts` 连接建立即发首个 KEEPALIVE（把 while 每轮切换的无输出间隙从 ~60s 降到秒级、idle-timeout 额外保险）。
- `pnpm typecheck` ✓ / `pnpm lint` ✓ / 本地循环逻辑验证 ✓（round1 KEEPALIVE 重连 → round2 ACTION_ACK 退出）。
- ⚠️ **V0.6.22 真机实测推翻**：本地 mock 验证 ≠ 真机。真机 30 分钟时 while **没重连**、退出码 28 断开——SDK 跑 shell 默认 `set -e`+`pipefail`、首轮 curl 超时（28）触发 errexit 直接终止整个脚本、while 从未进第二轮。上面「idle-timeout 不被杀」判断对（KEEPALIVE 撑满 30 分钟没被空闲杀）、但漏了 errexit 这道坎。修复见 V0.6.22。

### V0.6.20：build 切错分支加固——checkout verify + 写代码前自检铁律（2026-06-05）

**背景**：实战踩坑——某 task 的 build 因 race + dev 热重载（改 chat-mcp bump GLOBAL_KEY）打断、agent 异常路径下没收到「含 checkout 引导的 NEXT_ACTION」就开干、直接在 crm-web 当时停留的**别的需求 feature 分支**上改了代码（本 task 的分支根本没建）、污染了那个分支。events 全程零 checkout 痕迹。

- **两层加固**：
  1. **runner checkout shell 加 verify**（`task-runner.ts: planBranchesForBuild`）：idempotent checkout 后追加 `CURRENT=$(git rev-parse --abbrev-ref HEAD)` 比对目标分支名、不符 `exit 1` + 报错——防 checkout 静默失败 / 仍停旧分支。
  2. **`action-build.md` 加独立硬铁律**：动任何代码前必须 `git rev-parse` 确认当前在本 task feature 分支、不符立刻停 `ask_user`——**即使 checkout 引导没注入 / 没跑成功也要自检**（覆盖异常路径、这是「代码改到别人分支」的最后一道闸）。
- 根因属异常路径（race + 热重载）次生、非常规 build bug；但 agent「不在正确分支也不自我保护就开干」是真实隐患、值得这道确定性闸。
- 数据修复（手动）：被污染 task 的 act_2 build 删除（meta.json + 2-build.md）、用户丢 crm-web 脏改动后重跑。
- `pnpm typecheck` ✓ / `pnpm lint` ✓。

### V0.6.19：修 build 阶段「NEXT_ACTION 静默丢失」race（挂起队列）（2026-06-05）

**背景**：用户 approve plan 后很快推 build、build 阶段没执行就结束。根因：approve ack 刚 resolve 的 pendingMap entry 还在 60s grace window 里、advanceTask 调 `submitNextAction` 发 build 的 NEXT_ACTION 时命中这个**已 resolved 的旧 entry**、试图二次 resolve 失败但仍返 true → advanceTask 把 build 标 running、agent 却从没收到指令。

- **挂起队列**：`chat-mcp.ts` 加 `pendingNextActions: Map<taskId, ToolReturn>`、`GLOBAL_KEY` V8→V9（热重载清旧结构）。
- **submitNextAction 三态**：① fresh pending entry（存在且未 resolved）→ 直达；② resolved entry（grace window）→ 入队 `pendingNextActions`、等 agent 重入待命态兑现；③ 无 entry（agent 已死）→ 返 false、让 advanceTask 走 forceNewAgent 兜底（保留原自愈）。
- **registerPendingEntry 兑现**：agent 重入「等下一 action 指令」待命态（无 actionId）时、查 `pendingNextActions` 有就立刻 finalize 兑现。
- **防泄漏 + 防抖动**：`cancelPending` 清队列；`wait_for_user` 的 `safeNotifyAwaiting` 加 `!entry.resolved` 守卫——刚兑现 NEXT_ACTION 的别再覆写成 awaiting_user。
- `pnpm typecheck` ✓ / `pnpm lint` ✓。

### V0.6.18：角色加「自适应」+ Label 必填星号封装（2026-06-05）

**背景**：① 角色硬二选一（fe/be）、全栈仓 / 不确定时不好归类；② 角色虽必填但 UI 漏星号、必填逻辑跟星号 UI 脱节（用户指出角色 select 没星号）。

- **角色加 `adaptive`（自适应）**：`TaskRole = "fe" | "be" | "adaptive"`、label「自适应」。选它 = 不锁端、agent 按仓库技术栈（`package.json`=前端 / `pom.xml`=Java 后端 / `go.mod`=Go 后端）+ story 自己定位视角、判不准 `ask_user`。改 `types` + new/edit dialog `ROLE_OPTIONS` + `route.sanitizeRole` 白名单 + `_super.md`/`action-plan.md` 加 role=adaptive 分支引导。**不做默认选中**（保持三选一主动选）。
- **Label 必填星号封装**：`label.tsx` 加 `required` prop、必填字段末尾统一渲染红星号——「必填校验」和「星号 UI」单一来源、调用方只传 `required` 不再各自手写 `<span>*</span>`。清原不一致：角色漏星号→补、类型纯文本 `*`→红星号、标题/仓库/飞书各自手写 span→统一走 required；task 必填有星号、chat 选填无（`required={mode==="task"}`）。new + edit dialog 都规范。

`pnpm typecheck` ✓ / `pnpm lint` ✓。

### V0.6.17：放开 build 必须先 plan + build 读 review「决定链」（2026-06-05）

**背景**：用户问流程灵活性——① 小改 / 修 bug 想跳过 plan 直接 build（当前被硬拦）；② review 提的 bug、build 要**知道**但解不解决归用户、且用户已否决的别重复问。

- **Q3 放开 build gate**：`checkActionPrerequisites` + `inferDisabledReason` 去掉「build 必须先 completed plan」。`action-build.md` 加无 plan 分支：有 plan 按 plan 工单 / 无 plan 按用户指令圈范围（含糊先 ask_user）——准入 / 目标 / 输入文件 / 改动范围约束 / 执行步骤全分两路。
- **Q2 build 读 review + 决定链落 md**：build 步骤 1.2 read 最近 review、把未解决 🔴/🟡 用 `ask_user` 问用户「本次修哪些」（**知道 ≠ 必须解决、归用户**）。**不重复问已否决**：扫两个来源——review artifact 新增「### 用户裁决」段（review ack 时用户对 bug 表态落这）+ 历史 build artifact 留痕（build 弹窗选跳过落这）、已否决的不再问、形成「决定链落 md」（换 agent 也读得到）。
- **review 配套（放开 build 的冰山连带）**：`action-review.md` 准入 plan 改可选、§1 加「无 plan 时差值基准退化为累积意图 + git diff + 飞书、跳过 plan 侧对照」+ revise 加「用户对 bug 表态 → 落『### 用户裁决』段、bug 本体保留」。否则无 plan build 后 review 找不到 plan 会懵。
- **自查闭环（/pua 蓝军）**：放开后 runner branch checkout 不依赖 plan（`planBranchesForBuild` 只吃 task 字段）；`checkBuild` 本就不存在（V0.6.3 撤）；`checkReview` 必备段只验总评 + 飞书对照 + bug 复审（不验 plan 段、无 plan review 不误判）。
- 改动面：1 ts 函数 + 1 UI 函数 + 2 prompt（build / review）。`pnpm typecheck` ✓ / `pnpm lint` ✓。

### V0.6.16：创建 task 强校验飞书两个 MCP（按 url 域名认）（2026-06-05）

**背景**：飞书 MCP + 飞书项目 MCP 是「需求 → PR」全流程命脉（plan 拉 story / build 摸需求 / ship @ 测试人员全靠它）。以前漏配也能建 task、agent 跑起来才发现没工具、白跑一趟。用户要求建 task 必须先配齐。

- **只卡 task 模式**：chat（自由对话）不依赖飞书、放行。
- **按 url 域名认、不认 key 名**（用户拍板）：校验「启用的 server 有没有 url 命中 `mcp.feishu.cn`（飞书 MCP）/ `project.feishu.cn`（飞书项目）」——别人把 key 叫 `lark-mcp` / `my-feishu` 也认、只要连的是飞书。初版按 key 名精确匹配（`feishu-mcp` / `feishu-project-mcp`）、用户指出团队 key 命名不可控、换名即失效 → 改域名判定。
- **「缺失」两种都拦**：① mcp.json 没配；② 配了但本次创建在 MCP 区关了（进黑名单）。
- **交互**：缺失 → 创建按钮置灰 + 底部红字「创建任务需先启用 飞书 MCP、飞书项目 MCP」。`mcpLoading`（首拉中）先按「不缺」、避免没拉回来闪红。
- **实现**：`new-task-dialog` 加 `REQUIRED_FEISHU_MCP`（host→label）+ `missingFeishuMcp` memo（读 `useCursorMcp().servers`、`"url" in cfg` 守卫取 url、滤黑名单后匹域名）、`canSubmit` 接入。复用既有 `"url" in cfg` 访问模式（mcp-probe / mcp-oauth）。

`pnpm typecheck` ✓ / `pnpm lint` ✓。

### V0.6.15：自由对话（chat）加「停止」按钮（2026-06-05）

**背景**：chat 模式详情页 agent 回复中只有「AI 正在回」转圈、没法打断——长篇生成 / 跑偏时只能干等。正经 task 模式早有「停止」、chat 一直缺。

- **根因**：chat agent 注册在 chat-runner 自己的 `runningChats`、不在 task-runner 的 `runningTasks`（两套 runtime state 刻意不混）；而 `/stop` route 只调 `cancelTaskRun`（查 runningTasks）→ 压根停不到 chat。
- **后端**：chat-runner 加 `cancelChatRun(taskId)`（停 runningChats）；`/stop` route 改 `cancelTaskRun(id) || cancelChatRun(id)`（一个 task 只落其一、两个都试、命中即停）；停止 info 文案按 `task.mode` 分「对话」/「action」语境。
- **前端**：`ChatView` 顶部 running 时「AI 正在回」旁加「停止」按钮 → `stopTask` → 清 streaming + onTaskUpdate。chat 打断是高频低风险（不改代码）、不弹二次确认、即点即停（区别于 task 模式 confirm）。
- **复用既有 cancel 收尾**：`run.cancel()` 让 stream 正常结束、`run.wait()` 返回 cancelled → 走 chat-runner cancelled 分支提前 return（不进 catch、不误报 error、跟实战验证过的 task-runner 同构）；该分支顺手去掉原「已被取消」info（和 /stop 的「用户停止了对话」重复）。

`pnpm typecheck` ✓ / `pnpm lint` ✓。

### V0.6.14：ship 提测「合并后删源分支」改可选（默认保留）（2026-06-05）

**背景**：ship 建 MR 写死 `remove_source_branch: true`、合并后源分支必删。用户痛点：合并后常要回看 / 续推该分支、删了得本地重新 push 一遍很麻烦——要求提测推进时能选、且默认保留（用户拍板）。

- **字段**：`Task.removeSourceBranchOnMerge`（缺省 / undefined = 保留、true = 删）。`gitlab-client.ts` 原写死的 `remove_source_branch:true` 改读 `CreateMRInput.removeSourceBranch`。
- **链路**：推进 dialog 选「提测」时冒出开关「合并后删除源分支」（默认按 task 上次选择、缺省不勾 = 保留）→ onSubmit 带 `removeSourceBranch` → `advance` route 起 agent 前 `setTaskRemoveSourceBranchOnMerge` 落 task 字段 → agent 调 `submit_mr` 时 handler 读 fresh task 传 createMR（不碰复杂的 advanceTask、也不单独 PATCH、走 advance 一条请求）。
- **`__conflict` 例外**：一次性解冲突分支由 handler `endsWith("__conflict")` 强制 `true`（必删、不留垃圾分支、不受用户开关影响）。
- **dialog 防抖**：开关初值用 `defaultRemoveSourceBranch` memo（依赖 primitive 字段、非整个 task）、避免 SSE 推 task 引用变时把表单打回默认（同既有 actionType 的处理）。
- **`findOpenMR` 入参精确化**：原图省事直接复用 `CreateMRInput`、加 required `removeSourceBranch` 后被波及 → 改 `Pick<CreateMRInput, config|projectPath|sourceBranch|targetBranch>`、`closeOpenMR` 去掉 title/description 占位。
- **附带 UI 文案精简**（用户「系统里很多文案太啰嗦」）：`forceNewAgent` 开关「强制起新 agent」→「新启 Agent」+ 删副标题；全局删一批自解释控件下的废话 help text（推进 / 新建 / 编辑弹窗的模型 / 角色 / 飞书 / 多仓说明、上下文输入规则——跟 placeholder 重复）；规则固化「控件标题能自解释就别加 help text」（`learned-conventions.mdc`）。

`pnpm typecheck` ✓ / `pnpm lint` ✓。

### V0.6.13：MCP 探测增量化 + 连通状态收敛两态 + 首探竞态修复 + 失败可看日志（2026-06-05）

**背景**：接 V0.6.11 的 MCP 连通可视——先把探测改增量（只探开启的、打开某个时单独探、对齐 Cursor 不浪费那 6s 超时），但留了 bug：进设置页开启的 MCP 不默认探测、一直不出状态。用户顺带提状态太杂（绿黄红灰四态）+ 失败看不到原因。

- **探测增量化**（前半、已落代码）：`useMcpHealth` 只探 `enabledServers`（关闭的不连）；`probeOne` 把某 server 关→开时单独探这一个、per-server `loadingServers` 哪行探哪行转圈；`GET /api/cursor-mcp/health?servers=a,b` 支持子集；`McpToggleList` 加 `onEnableProbe`。ref 存最新开启列表、effect 不依赖它（避免 toggle 触发全量重探）。
- **首探竞态修复**（本轮 bug）：根因——首探 effect 只在 mount 跑一次、但那一刻 `useCursorMcp` 异步还没回来、`enabledServers=[]`、探了空集合；之后 names 到位、ref 模式 + effect 不依赖列表 → 永不重探（设置页 100% 复现、详情页因 dialog 打开晚侥幸正常、本质同源）。修法：调用方保证 `active` 在「列表 ready 后」才置 true——设置页传 `!loading`、详情页传 `open && !mcpLoading`、复用现有 ref 模式不引入重复探测。
- **状态收敛两态**：`McpHealthStatus` 从 `ok/unauthorized/unreachable/local` 四态 → `ok/fail`（用户「不需要连不上、本地什么的」）。401/连不上/非 2xx 全归 `fail`；本地 stdio 没法 HTTP 探、乐观标 `ok`（由 SDK 启动时拉起、`filterHealthyMcp` 随 ok 一起保留）。失败原因不再靠 status 区分、全塞进 `detail`。
- **失败可看日志**：失败徽标渲染成可点 button → 弹 Dialog 展示 `detail`（连接错误原文 / HTTP 码 / URL）。复用现有 dialog、不引抽屉新依赖。两个 runner 的「跳过 MCP」info 提示也改成展示 `detail` 第一行（具体原因、不再只「失败」）。

`pnpm typecheck` ✓ / `pnpm lint` ✓。

### V0.6.12：artifact 产出不刷新事件驱动根治 + 终态任务恢复 + 角色必选 + chat 贴图修复（2026-06-04）

**背景**：用户实测连撞几个体验 bug——① artifact 产出后页面停在「没有产物」、要切 tab / 刷新才出（这是第 3 次修）；② 任务 abandon / merged 后右上角操作按钮全没、想回炉没入口；③ 新建任务角色默认「前端」、后端同学顺手提交错角色；④ chat 贴图不显示 + 回完一轮事件流不更新。

**① artifact 产出不刷新——事件驱动根治（第 3 次、前两次治标）**

- 现象：action 跑完、artifact 文件已落盘、前端面板仍停在「没有产物」。RCA：agent 可能写失败重写、文件落盘晚于它调 `wait_for_user`（signaling 完成）几秒、前端固定退避窗口刚好错过。
- 前两次治标：V0.6.8 SSE 被动断开自动重连；本轮先上「读到空退避重试 800ms×5」——都没根治、因为前端在「猜」文件啥时候落盘。
- 根治：`ActionRecord` 加 `artifactUpdatedAt`；`task-runner.handleSdkMessage` 检测到「写工具命中 `actions/<n>-<type>.md` 且 SDK tool done」→ patch 该字段 + 推 action 帧；`artifact-panel` effect 依赖 `artifactUpdatedAt` → 事件驱动重拉（不再靠退避猜落盘时刻）。退避升级成指数退避（800ms×1.7、单次封顶 5s、8 次）留作 SSE 极端断连兜底。

**② 终态任务一键恢复（reopen）+ 运行时收尾健壮性**

- reopen：`merged` / `abandoned` 任务一键回 `developing`（`reopen` API + task-store helper + 详情页「恢复」按钮）、修「终态任务无任何操作入口」。
- action 收尾一致性：force-new / finalize / cancel / error 统一走 `finalizeStaleActions`、修「提测卡 `awaiting_ack` 划不掉」。
- 事件流：`read` 不再误标「在写 artifact」（`WRITE_TOOL_NAMES` 白名单、只有写工具命中 `actions/` 才算产出）。
- SDK 错误详情：抽 `sdk-error.ts` 补全 code / cause（修 `ConnectError` 的 number code 丢失）、`chat-runner` 对齐。
- 全局兜底：`instrumentation` 注册 `unhandledRejection`、SDK 内部 reject 不再让 Web 进程退出。

**③ 新建任务角色改必选**：默认「前端」→ 初始置空 + task 模式角色纳入必填校验、强制主动选（防后端同学顺手提交错角色）。

**④ chat 体验**：chat 贴图不显示 + 回完一轮事件流不更新修复；推进任务弹窗指令框支持贴图（粘贴 / 拖拽 / 附图、复用 `useImageAttach`）。

`pnpm typecheck` ✓ / `pnpm lint` ✓。

---

### V0.6.11：MCP 容错（连不上不拖垮 run）+ 连通状态可视 + 飞书 @ mention 修复（2026-06-04）

**背景**：用户实测 chat agent「老是启动不起来」、报错只有 `SDK status=error message=(none)`、无从定位。RCA：起 agent 注入的远程 MCP 里飞书项目（`project.feishu.cn/mcp_server/v1`）走 OAuth、fe 这侧没授权（`data/mcp-oauth/` 空）→ enrich 注入不到 token → SDK 连它 401 → **整个 run error**、且 SDK 没透传错误。用户两条诉求：① MCP 异常别影响发问；② 能看到 MCP 启动状态、不能只有开关。

- **MCP 连通性探测**（`src/lib/server/mcp-probe.ts`、新）：`probeMcpHealth` 发 initialize 看 HTTP——2xx=ok / 401·403=unauthorized / 其它·连不上=unreachable；stdio 无 url=local（不探、交 SDK 起进程）。`probeMcpHealthAll` 并发。类型 `McpHealth` + `MCP_HEALTH_LABEL` 落 `types.ts`（前后端共享）。**探测前先 enrich 注入 OAuth token**、否则飞书项目永远 401。
- **容错（需求1）**：chat-runner / task-runner 起 agent 前 enrich → `filterHealthyMcp` 剔除 unauthorized/unreachable 的远程 MCP、agent 照常启动；被剔的写一条 info event「⚠️ 已跳过 N 个不可用的 MCP：xxx（未授权）…」、不再「莫名其妙报错」。复用 agent 不重探（MCP 已在跑）。
- **状态可视（需求2）**：`GET /api/cursor-mcp/health`（enrich 后探）+ `useMcpHealth` hook（enabled 控制、dialog 才探、省无谓请求）。`McpToggleList` 每行加状态点（绿正常/黄未授权/红连不上/灰本地 + hover 详情）；task MCP 面板 + 设置页 mcp-card 都接、带「重新检测」。
- **飞书 @ mention 修复**（接 V0.6.6 飞书通知链）：`action-ship.md` 之前要求 mention 块 id 加 `lark_user_id_` 前缀（照抄 add_comment schema 的坑爹举例）。对照实验确诊（同 story、只改前缀这一个变量）：**带前缀飞书返回 `no permission`（误导、看着像没权限、其实是 mention id 非法）、纯数字才成功**。4 处改纯数字 + 标注 schema 举例是坑（`notify_user_list` 本就纯数字、不动）。

`pnpm typecheck` ✓ / `pnpm lint` ✓。

---

### V0.6.10：review 阶段一对比基准改「累积意图」+ 已授权变更去双重确认（2026-06-03）

**背景**：用户洞察——「第二 / 三轮改 bug 的 build 其实也是合法『方案』、review 不该把所有 diff 都拿去跟初版 plan 对比」。实测 V0.6.9 的 review #17：两条标红的「实现偏差」（组合包名展示、主商品加粗）**其实都来自 build #13 / #15 的用户指令 / 产品反馈**——review 又把它们当偏差 `ask_user` 确认一遍 = **双重确认、是噪音**（用户在 build 轮已经拍过了）。

**机制**：review 阶段一的对比基准从「初版 plan」→「**累积意图** = 最新 plan + 各轮 build artifact 记录的用户指令 / 产品反馈 / ack 决策」。判定规则：

- diff 改动能**追溯到某轮 build 记录的用户指令 / 产品反馈** → **已授权变更**（列进新「## 已授权变更」段供用户知晓、**不重复 ask_user**）。
- diff 改动**无据可依**（plan 没写、任何 build artifact 也没记用户说过）→ **真·实现偏差 / 真·范围扩张** → 标红、走 §6 ask_user。

**关键**：不是「review 不对比 plan」、是「换对比基准」——仍然抓「build 偷偷跑偏、plan 和用户都没说」的未声明漂移（review 阶段一核心价值），只去掉「对已授权改动的双重确认」噪音。对齐 OpenSpec 的 living-spec 理念、但我们的 spec 自动累积、不用人维护。

**落地**（纯 prompt、无代码）：`prompts/action-review.md`——step 1 读取强调拉「各轮 build 记录的用户指令」拼累积意图；step 3 总纲 + 3.1 扩张 / 3.2 实现偏差 加「可追溯分流」；artifact 骨架加「## 已授权变更」段（放 plan 拍板口径复核 后）；总评「建议结论」+ §6 ask_user 触发条件改为「只真偏差 / 未完成 / 飞书未覆盖才触发」。

---

### V0.6.9：review 改 fresh peer 两阶段复审 + per-action 复用/强起 agent 默认（2026-06-03）

**背景**：用户反馈 review「鸡肋」——找不到 bug、只会做「plan vs diff 差值」。根因：当年 review prompt 明确写「不做 AI 自审代码对错」（怕「写代码的 agent 自己审自己」= Cognition 警告的共识盲点 anti-pattern）。调研 Spec Kit / OpenSpec / Superpowers / GStack 后定方向：借 Superpowers 的 **fresh subagent 复审**——复审交给一个没写过这代码的全新 agent、绕开盲点。

**① per-action「复用 / 强起 agent」默认表（机制层、泛化）**

- 因为每步都落 artifact（md）、「聊天记忆」不重要 → 每个 action 可按作用独立决定「复用上一个 agent」还是「强起 fresh agent」。
- `types.ts: ACTION_FRESH_AGENT_DEFAULT`（单一来源）：**review = true（fresh）**、其余（plan/build/ship/test/learn）= false（复用）。
- `task-runner.ts advanceTask`：`effective = forceNewAgent || ACTION_FRESH_AGENT_DEFAULT[type]`——UI「换新 agent」开关是附加覆盖（永远能手动强起）、这表只管「不手动时」的默认。复用现有 forceNewAgent 路由（cancel 旧 agent + 等停 + 兜底强清 + fork 不清孤儿）、零新机制、UI/API 不动。
- 注：**单 SDK run 不再是硬约束**——用户拍板「默认复用一次 run、但 review 这种该换人的就强起 fresh」。

**② review = fresh peer 两阶段复审（价值层）**

- **解锁逻辑**：复审现在是 fresh agent（没参与 build、没写过这代码）→ 是「换人复审 peer review」、不是「作者自审」→ 共识盲点不适用 → **可以也应该判代码对错、找 bug**。当年只禁自审、不禁 peer review。
- **阶段一·差值**（保留）：plan vs diff + 飞书逐条对照（确定性、零误判、基本盘）。
- **阶段二·bug 复审**（新增 §3.5）：需求层 bug（漏实现 / 跑偏需求 / 边界没覆盖、对照飞书验收基准——这是通用 AI review 没有的弹药）+ 代码层 bug（空指针 / 边界 / 错误处理等）、分级 🔴 阻塞 / 🟡 建议、带 file:line。
- **诚实边界写死 prompt（防鸡肋 v2）**：高置信才报 🔴、拿不准归 🟡、找不到就如实写「未发现高置信 bug」、绝不编假阳性、运行时 bug 不强求（那是后续浏览器 QA 的活）、不自己修（只报告、用户拍板回 build）。
- **门禁**：MVP 软门禁——🔴 写进 artifact、用户 ack 时看到、HITL 兜底（不带病 ship）；显式 ship 硬门禁后续再说。

**落地**：
- `types.ts`：+`ACTION_FRESH_AGENT_DEFAULT` map；postCheck 注释补 review bug 段。
- `task-runner.ts`：advanceTask 算 `effectiveForceNewAgent`、三处路由用它。
- `prompts/action-review.md`：重写定位（fresh peer 双阶段）+ step 3 改两阶段总纲（3.1–3.4 阶段一 / 3.5 阶段二 bug 复审）+ 飞书对照降级为 3.4 + artifact 骨架加「## bug 复审」段 + 总评加 bug 结论 + 后置检查加 bug 段非空 + 顺手修历史遗留「§7 ask_user」误写（ask_user 实为 §6）。
- `action-checks.ts: checkReview`：加「## bug 复审」段非空检查（防 fresh agent 跳过阶段二）。

**待办（后续）**：真实浏览器 QA（前端运行时 bug、用户暂缓、价值最大、Cursor 结构上做不了）；显式 ship 硬门禁。

**hotfix（同会话实测发现）**：首条 fresh review 实测产出很好（找到 2 个真 🟡 bug、诚实边界守住），但 postCheck 误判红条「缺少 2 类差异段」。根因：旧 `checkReview` 用松散 grep 强求全文出现「未实现 / 额外」等词、只容忍缺 1；但 review 骨架明确「无内容的差异段整段省略」、一份干净 review（无范围偏离 / 无未完成 / 无超范围）天然不含这些词 → 误判（prompt 自相矛盾、V0.6.9 前就埋着、干净 review 才触发、误判红条直接打击用户信任）。修：`checkReview` 改成只验骨架里「无省略豁免」的两段（总评 + 跟飞书需求对照）+ bug 复审段；`action-review.md` 后置检查 §2 + 骨架引言改成跟骨架一致（条件段无内容可整段省略）。

`pnpm typecheck` ✓ / `pnpm lint` ✓。

---

### V0.6.8：ship 智能解冲突 + 孤儿进程清理 + SSE 自动重连（2026-06-03）

**① ship 提测冲突「AI 智能解决」（不松「feature 保持干净」铁律）**

- 背景：feature→测试分支 提测遇冲突、以前只能 `ask_user` 让用户手动解。需求：像 IDEA 那样让 AI 智能解。
- **铁律不松**：绝不把测试分支合进 feature（test 是整合分支、塞满别人没测完的功能、合进 feature 会污染、还可能把未测功能带上线）。
- 方案：遇冲突 `ask_user` 给两选项「AI 智能解 / 自己解」。选 AI 解 → §3.6：
  - 另建**一次性** `<feature>__conflict` 分支（基于 `origin/<测试分支>`）、`git merge <feature>` 把 feature 合进去（方向 feature→__conflict、**不是** test→feature）、AI 逐个解冲突标记、`git push -f` 这条 __conflict、`submit_mr` 用 __conflict 当 source。
  - feature 分支全程不 checkout / 不改 / 不 push、本体干净——**这是铁律唯一豁免口**（只在一次性 __conflict 分支上 merge + force push）。解完 `git checkout <feature>` 恢复 HEAD（防 re-ship 误把 __conflict 当 feature）。
- **双 MR 自动清理**：`submit_mr` 检测到 source 分支跟该仓上次不同（feature→__conflict）、新 MR 建好后**自动关掉**被取代的旧 `feature→测试分支` MR（`gitlab-client.ts: closeOpenMR` 复用 `findOpenMR` 拿 iid + `closeMR` PUT state_event=close）。测试人员只看到一个干净 MR。`remove_source_branch:true` 早就默认、__conflict 合并后自动删。
- 落地：`gitlab-client.ts` +`closeMR`(内部)/`closeOpenMR`(导出)；`task-runner.ts` submit_mr handler 先读 fresh task 拿该仓上次 source、新 MR 建好后 `closeOpenMR` 旧分支（失败只 warn、不阻塞）；`prompts/action-ship.md` §3.5 改两选项 + 新增 §3.6 智能解冲突流程 + 反例 + artifact 表 + 顶部铁律豁免说明；`chat-mcp.ts` submit_mr describe 同步（第二指令源一致）。

**② 停 task 清理 agent 孤儿子进程（重大 bug）**

- bug：task 已停止、代码仓库还在被疯狂改。根因：agent 经 `npm run lint` 起的 `ng lint --fix` 子进程、agent 停了它没死、reparent 到 init（PPID=1）继续改文件。
- 层2（cure）：`src/lib/server/kill-orphans.ts`——`reapTaskOrphans(repoPaths)` 扫进程、命中「Cursor agent shell 签名」**或**「孤儿(PPID=1) + build/脚本工具名 + cwd 在本 task 仓内」的、SIGKILL 整棵子树（立即 + 2.5s 后各扫一次、抓延迟 reparent）。接进 stop 路由（即时清）+ task `finally`（force-new-agent restart 不清、防误杀新 agent）。
- 层1（prevent）：`_shared.md` §9 + `action-build.md`——禁自动改写命令（`lint --fix` / `prettier --write`）、禁长驻命令（dev server / `--watch`）、跑 lint script 前先 read 看清内部。

**③ SSE 被动断开自动重连（artifact 产出不刷新）**

- bug：artifact 产出了、详情页面板不自动刷新、要手动刷新 / 切阶段。根因：`useTaskWatch` SSE 流被动断开（maxDuration 超时 / 网络）后不重连、漏后续 action/artifact 更新。
- 修：`use-task-watch.ts` 加自动重连循环——被动断开（非 `done` 信号）按指数退避重试、收到 `done` / `reconnectKey` 变（主动断开 / 切流）则不重连。

`pnpm typecheck` ✓ / `pnpm lint` ✓。

### V0.6.7：ship 提测 / dev 分支 per-repo 配置 + feature 分支命名模板化（2026-06-02）

**需求**：① 给「ship 提测分支」「dev 分支」做 per-repo 配置（之前 ship 写死提测到 `test`）；② feature 分支命名从写死算法（`feature/<username>/<storyId>-<title>`）改成用户可配模板、支持前后端不同规范（前端 `feature/{username}/{storyId}-{taskTitle}`、后端 `feature/{date:MM-dd}/{storyId}-{taskTitle}`）。

**模板引擎**（`src/lib/branch-template.ts`、client + server 共用、不依赖 node）：
- 占位符 4 个：`{username}` / `{storyId}`（从 feishuStoryUrl 抠 `detail/<digits>`）/ `{taskTitle}`（原算法的 title 改名）/ `{date:FORMAT}`（FORMAT 支持 yyyy/yy/MM/dd/HH/mm/ss）。`{storyTitle}` 用户明确先不加（server 端没有飞书调用通道）
- `renderBranchName(template, vars, now?)`：每个变量值各自 `sanitizeBranchSegment`（git 非法字符 + 路径分隔 `/` 都换 `-`、模板字面的 `/` 保留 → 层级由模板控制、变量值不撑层级）、渲染后清连续 `//` + 去首尾 `/`
- `resolveBranchTemplate(repoTpl, globalTpl)`：算「有效模板」= per-repo 覆盖 > 全局默认 > 内置默认 `DEFAULT_BRANCH_TEMPLATE`

**配置层级**（用户选方案 1）：全局默认 `settings.branchTemplate` + per-repo 覆盖 `settings.repos[].branchTemplate`。测试 / dev 分支是「仓库属性」per-repo（`settings.repos[].testBranch / devBranch`）、放设置页不放任务编辑弹窗。devBranch 暂无用途、只存配置。

**数据流**（同 `repoBaseBranches` 模式、因 settings 在 localStorage、server 读不到、必须建 task 时固化）：

```
settings.repos[].{testBranch,devBranch,branchTemplate} + settings.branchTemplate
  → 建 task：new-task-dialog 快照（resolveBranchTemplate 算有效模板）
  → task.{repoTestBranches,repoDevBranches,repoBranchTemplates}（meta 落盘）
  → build：planBranchesForBuild 用 repoBranchTemplates 渲染分支名
  → ship：agent 从 super prompt「仓库分支配置」段读测试分支（没配回退 test）
```

**落地**：
- `types.ts`：`RepoConfig` +`testBranch?`/`devBranch?`/`branchTemplate?`；`FeAiFlowSettings` +`branchTemplate?`（全局默认）；`Task` +`repoTestBranches?`/`repoDevBranches?`/`repoBranchTemplates?`；`NewTaskInput` Pick 加这三个
- `local-store.ts`：`DEFAULT_SETTINGS.branchTemplate = DEFAULT_BRANCH_TEMPLATE` + `getSettings` 兜底
- `user-profile-card.tsx`：加「默认分支命名模板」输入框 + 占位符说明 + `useMemo` 实时预览
- `repo-card.tsx`：每仓单行改三行网格、加 test/dev/模板覆盖输入框、通用 `setRepoField(path, field, value)` + `onRepoFieldBlur` 替代原 `setOnlineBranch`
- `new-task-dialog.tsx`：handleSubmit 快照三字段进 createTask
- `task-fs.ts`：meta 加 3 字段 + createTask 清洗（key 限定 repoPaths + trim）+ hydrateTask 映射
- `task-runner.ts`：`planBranchesForBuild` 去 username 硬检查、改 `renderBranchName`(per-repo 模板)；新增 `renderRepoBranchSection(task)` 注入 super prompt
- `prompts/_super.md`：任务基本信息段后加「仓库分支配置」段 + `{{repoBranchSection}}`
- `prompts/action-ship.md`：测试分支不再写死 `test`（6 处）、改「读 super prompt 仓库分支配置段、没配回退 test」
- `chat-mcp.ts`：`submit_mr` 的 `target_branch` describe 同步改（跟 ship prompt 一致、避免第二指令源冲突）
- **hot-fix（接手补跑 typecheck 发现）**：`use-settings.ts` 的 `dirty`（`Record<keyof FeAiFlowSettings, boolean>`）+ `isFieldEqual` 字符串分支补 `branchTemplate`（不补报 TS2741、上一会话工具崩溃没跑成 typecheck 漏的）

`pnpm typecheck` ✓ / `pnpm lint` ✓。

### V0.6.6：详情页编辑任务 + 字段热更（2026-06-02）

**需求**：建完任务后能在详情页改「建任务时填的软配置」——以前填错只能删了重建。后续追加：编辑后若不换新 agent、长生 agent 读不到新值的问题。

**可改字段**（`EditTaskDialog`、详情页标题旁「编辑」按钮、`runStatus === "running"` 时隐藏避免跟正在跑的不一致）：角色 / 标题 / 飞书链接 / per-repo 已有工作分支。

**刻意不可改**：`model`（SDK Run 启动时绑定的硬约束、改了只能换新 agent、要换走推进 dialog 的模型选择）；`mode`（task/chat 两套通路、切了等于换任务）；`repoPaths`（副作用大：变 agent cwd、已建分支/MR 对不上）——只读展示；MCP 开关 / 上下文 doc——详情页已有各自面板。

**字段热更（关键、解决「长生 agent 读不到编辑」）**：单 SDK Run 永生 → super prompt 启动时构造一次、reused agent 推进不重建、编辑的 title/role/feishuStoryUrl 会 stale。解法：
- runner 在 `runningTasks` record 存 agent 启动快照 `startSnapshot = {title, role, feishuStoryUrl}`（内存、不落盘）
- reused 推进时 `buildTaskUpdateHint(最新 task, 启动快照)` diff、**有变才**拼一段 `[TASK_UPDATED]` 注入 `[NEXT_ACTION]` directive（角色变会说「从 X 改为 Y、忽略开头旧角色」）、注入后推进快照避免下次重复告知
- 机制本质：磁盘 meta = 最新真值、内存快照 = agent 已知值、推进时一 diff、差异 = 要告诉 agent 的变更
- `repoFeatureBranches` 不走此机制——build 前 runner 本就读盘拿最新、已 fresh

**落地**：
- `src/components/tasks/edit-task-dialog.tsx`（新）：表单初始化只依赖 `[open]` + `task` ref 化——避免 dialog 开着时 task 因 SSE 更新（引用变）重跑 effect 把草稿重置（advance-dialog 同款教训）；后续移除 model 字段（连带清理 task-store / route / task-fs 的 model 编辑链路、不留死代码）
- `task-runner.ts`：`TaskFieldsSnapshot` + `captureTaskFieldsSnapshot` + `buildTaskUpdateHint`（纯函数 diff）；`RunningTaskRecord.startSnapshot`（启动拍 + reused 注入后推进）；`buildNextActionDirective` 加 `taskUpdateHint` 入参（放 directive 最前、让 agent 先校准再读指令）
- `prompts/_super.md`：任务基本信息段加「以 `[TASK_UPDATED]` 最新值为准」兜底 + `[NEXT_ACTION]` 处理步骤加识别 `[TASK_UPDATED]` 段（角色变立刻切视角）
- `task-fs.ts: updateTaskFields`（新）：`withTaskLock` 包 read-modify-write；改飞书链接时**同步「建任务自动生成的 url 上下文文档」**（否则 agent 读 contextDocs 仍是旧链接、两处漂移）；repoFeatureBranches 同 createTask 清洗（key 限定 repoPaths + trim）
- `api/tasks/[id]/route.ts` PATCH：编辑字段分支（title/role/feishuStoryUrl/repoFeatureBranches、可一次传多个、role 限 fe/be、title 非空校验）
- `task-store.ts: updateTaskFields`（新 client helper、走 `handleJson`、传 `null` 显式清空）
- `tasks/[id]/page.tsx`：接入「编辑」按钮 + `EditTaskDialog`

`pnpm typecheck` ✓ / `pnpm lint` ✓。

---

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

### V0.6.3：stop hook 兜底「保证 agent 交卷」+ 多技术栈兼容（2026-06-01、已落地）

**背景**：质疑链「怎么保证 agent 干完一个 action 一定调 `wait_for_user` 交卷」。这不是小事——fe 所有后置 deterministic check 都挂在 `wait_for_user → runActionCheck` 上、**agent 不交卷、整条检查链（L1-L4）全部落空**。所以「保证交卷」= 保证质量门禁一定被触发。

**探针结论**（`/tmp/fe-hook-probe`、SDK local agent + `settingSources:["project"]` 实测、auto + gemini 两模型都验过）：

- SDK 官方声明 + 实测都确认 **SDK 会执行 repo `.cursor/hooks.json` 的 hook**（SDK skill 文档原文「Both SDKs respect them」）
- **stop hook 的 follow-up loop 成立**（行为 B）：agent 想结束 Run → stop hook 触发（还没真结束）→ 脚本返 `{"followup_message":...}` → agent **同会话**被拉回、带 followup 继续干 → 再次 stop → 放行。loop 上限由 hooks.json `loop_limit` 控制、`loop_count` 由 SDK 维护（stdin 给）
- **成本模型**（实测「2 次 AI 调用」核算）：hook 触发本身是本地 bash、**0 配额**；只有 followup「拉回」逼 agent 多生成一轮 LLM 才 +1 次。所以**正常交卷 = 0 额外、忘交卷才 +1 次把它救回来**、远比「整个 action 失败重跑」省

**落地方案 A（动态注入业务仓库、用户拍板）**：

- hooks.json 必须在 agent cwd（= 业务仓库）的 `.cursor/` 才被加载（`["project"]` 只够 project 层、够不着全局）
- **没 `.cursor/hooks.json` 就建 fe 的、有就不注入**（尊重业务仓库已有的、那种情况 stop hook 不生效、回退「事后标 error」兜底）；建了**留存复用** + 加 `.git/info/exclude` 防误 commit
- **hook 脚本 fail-open + 向 fe 认领**：因为 hooks.json 留在 repo、将来用 Cursor IDE 打开该 repo 时 IDE agent 也会触发它——所以脚本只把 stdin 的 `conversation_id`（= agent_id）curl 给 fe（如 `POST /api/hooks/stop-check`）、**fe 没开 / 不认领这个 agent → 立即放行**、绝不误伤 IDE agent
- **判断「交卷没」**：fe 后端 `agent_id → task_id`（`runningTasks` 已有映射）→ 读 `data/tasks/<id>/meta.json` 最后一个 action 的 `status`（`running` = 没交卷 → 返 followup 拉回 / `awaiting_ack` / task 终态 = 放行）。判断逻辑留 TS、bash 只转发

**双保险**：stop hook（事前强制拉回）+ 现有「Run 结束发现 action 没 ack 标 error」（事后兜底）。

**多层防御 L1-L5 战略**（stop hook 是「触发保证层」、保证下面 L1-L4 一定被跑到）：

| 层 | 防什么 | 实现 | 状态 |
|---|---|---|---|
| L1 静态确定性检查 | 编译 / 风格 / 无改动 | typecheck + lint + git status（门槛 2） | ✅ 已有 |
| L2 测试门禁 | 逻辑错（跑挂测试） | test action 跑真实测试 + 技术栈适配 | 🚧 待 |
| L3 AI review | 偏离需求 | review action 拿 diff × plan 结构化差值 | ✅ 已有、可增强（独立 reviewer） |
| L4 实时 QA | 跑起来才暴露 | 起服务 / 浏览器交互验证 | 🚧 待 |
| L5 HITL ack | 人最终把关 | wait_for_user + 用户 ack | ✅ 已有、**stop hook 加固「保证交卷」** |

**实装落地**（2026-06-01 第二批、随「给 Java 同事用」的多技术栈兼容一起）：

- **stop hook 三件套**：`scripts/stop-hook.sh`（bash 转发 `conversation_id`）+ `src/lib/server/stop-hook-inject.ts`（`ensureStopHookInstalled`：业务仓 `.cursor/hooks.json` 缺则注入 + 加 `.git/info/exclude`）+ `src/app/api/hooks/stop-check/route.ts`（`agent_id→task_id`、末 action `running`=没交卷返 followup 拉回、否则放行）。task-runner `Agent.create` 前调注入。诊断日志已埋、首跑真任务时确认 `agent_id == conversation_id` 映射
- **去 checkBuild（多技术栈兼容）**：`action-checks.ts` 撤掉写死 `pnpm` 的 typecheck/lint/git 检查（对 Java/Go 误报失败）、build action 直接 `passed:true` 跳过；后续把 check build 独立成技术栈自适应模块再加。质量暂靠 agent 自检 + 用户人眼 + stop hook 保证交卷
- **role 加 `be`（后端）**：`TaskRole = "fe" | "be"`、`new-task-dialog` 角色下拉加后端；prompt 去前端化（`action-plan`/`build`/`review` 把写死「前端」改成 role 分支 + 技术栈自适应：JS/TS `package.json`、Java `pom.xml`/`build.gradle`、Go `go.mod`）
- **「线上分支」per-repo 配置（选填、放设置页）**：feature 拉取基线。**why**：feature 必须从「线上分支」拉、后端默认分支常是 `develop`（探 `origin/HEAD` 会误拿）、从 dev/test 拉会把未上线 commit 带进 feature 污染线上。**设计**：线上分支是仓库级固定属性 → 放设置页 `RepoCard` 每仓配一次（`RepoConfig.onlineBranch`）、建 task 选仓时 client 从 settings 快照进 `task.repoBaseBranches`（`Record<repoPath,branch>`、因 settings 在 localStorage、server 读不到、故建 task 时固化）。build 时 `planBranchesForBuild` 按 repoPath 查：配了 → `BASE=<配的>` + 校验远程存在（防 typo）、没配 → 回退探 `origin/HEAD`。多仓不同线上分支天然支持。链路：`types` + `task-fs` + `route` + `repo-card` + `new-task-dialog` + `task-runner`
- **「已有工作分支」per-repo 覆盖（选填、放建 task 弹窗）**：解决「中途接入」——用户（尤其后端）建 task 前已自己 `checkout` 了分支、做了一部分。**问题**：build 的 branchName 是固定算法名 `feature/<username>/<storyId>-<title>`、checkout 只看「这个算法名存不存在」、**不看当前在哪个分支** → 后端手动建的不同名分支会触发重建（基于线上基线另起一个 fe 命名分支）、他已 commit 的代码不在新分支。**设计**：选 B2 显式 > 隐式（b1「自动检测当前分支」在 SDK Run 独立跑 + 多仓下不可控、分支错了代价大）。「已有分支」是 task 级（每需求不同、非仓库级固定属性）→ 放建 task 弹窗 per-repo 现填、快照进 `task.repoFeatureBranches`（`Record<repoPath,branch>`、跟 `repoBaseBranches` 对称）。`planBranchesForBuild` 每仓实际名 = 指定 || 算法、落 `gitBranches[].name`、checkout 命中 → 复用（代码都在）；ship 提测的 MR 源分支也取 `gitBranches[].name` 故自动用对、**不用改 ship**。顺手修了 hint 用顶层 branchName 而非 per-repo name 的潜在 bug。链路：`types` + `task-fs` + `route` + `new-task-dialog` + `task-runner`
- **chat 僵尸态误判修复**：`chat-reply` route 原来「`running` 且无 pending」一律当僵尸标 error、会把「正在说话的活 agent」误杀（前端 SSE 滞后发消息的 race）。改用 `isChatRunning(taskId)` 区分：进程活着=正在说话、返 409 让用户等；进程已死才标 error（410 引导重发重启）
- **prompts 技术栈中立化（给后端用）**：`_shared.md`(§3 路径示例) / `action-build.md`(骨架) / `action-plan.md`(task 示例) 的 `.vue` / `pnpm` 示例加「示例为前端、Java/Go 等同理」说明（规则与语言无关）；角色提示已分 fe/be、build 命令已技术栈自适应

### V0.6.2：跟 Cursor 共用工具（全局配置 fe 读 + MCP 只读化）（2026-06-01）

`pnpm typecheck` ✓ / `pnpm lint` ✓。承接 V0.6.1 的 settingSources、补完「全局层」配置读取 + fe 端 MCP 改只读。ai-flow 不再自己维护 MCP、统一消费 Cursor 配置（单一源在 Cursor、fe 只读不写）。

⚠️ **纠正 V0.6.1 settingSources 子段的误读**：原写「`settingSources:["project"]` 加载目标仓库 **+ 全局** `.cursor/`」——**错**。`SettingSource` 是分层枚举（SDK `options.d.ts`：`"project" | "user" | "team" | "mdm" | "plugins" | "all"`）、`["project"]` **只加载 project 层（repo `.cursor/`）、够不着全局 `~/.cursor/`**（全局要含 `"user"`）。旧探针「skillCount 13 来自全局」是误读：本地 `~/.cursor/skills/` 实测仅 3 个、那 13 大概率是 fixture cwd 自身的项目层 skills。

**最终分工**：repo 层 `.cursor/`（rules/skills/mcp/hooks）→ settingSources["project"] 由 SDK 读；全局层 `~/.cursor/`（rules/skills/mcp）→ **fe 后端自己读注入**。不用 `"user"` 层的原因：它是粗开关、把全局 20-30 个 MCP 全塞进 context、没法 per-task 精简；fe 自己读可控、可按 `task.disabledMcpServers` per-task 过滤。

- **新 `src/lib/server/cursor-config.ts`**（全局配置读取单一源）：
  - `readGlobalCursorMcpServers()` 读 `~/.cursor/mcp.json` 的 `mcpServers`
  - `readGlobalCursorRulesForPrompt()` 读 `~/.cursor/rules/*.mdc`（`alwaysApply: true` 全文注入、其余只列 index 让 agent 按需 read）
  - `getGlobalCursorDirs()` 跨平台候选目录（mac/linux/win 都 `home/.cursor/`、win 额外加 `%APPDATA%/.cursor/` fallback）
  - `filterDisabledMcp(servers, disabled)` per-task 黑名单过滤
- **MCP 注入移到 server 端**：task-runner / chat-runner 的 `mergedMcp` = 全局 mcp（按 `task.disabledMcpServers` 过滤）+ chat-tool；**删 client→server 传 mcpServers 全链路**——`run-args.ts` 不再 parse/filter（只剩 apiKey+model）、`advance` / `chat-reply` route body 去 `mcpServers`、runner input 去 `userMcpServers`。
- **rules 注入 prompt**：`prompts/_super.md` 加 `{{rulesSection}}`（Skills 段前）、`buildSuperPrompt` / chat `buildInitialPrompt` 填全局 rules 段。
- **skills 修订**：`loadSkills()` 改为读平台自带 `skills/` + 全局 `~/.cursor/skills/`（同名平台优先去重）——修正 V0.6.1「只读平台自带」（那样全局 skills 会丢、因 `["project"]` 够不着 user 层）。
- **fe 端 MCP 只读化**：
  - 新 `GET /api/cursor-mcp` 原样返回 `~/.cursor/mcp.json`（**不脱敏**、用户拍板：本地单机工具、跟 Cursor 展示一致）+ `dirs`（读自哪）
  - 新 `src/hooks/use-cursor-mcp.ts`：fetch + window focus 自动刷新（同步用户在 Cursor 改的 mcp.json）
  - `settings/mcp-card.tsx` 从可编辑 CodeEditor 改只读展示（disabled、显示来源路径 + server 数）
  - `new-task-dialog` / `task-mcp-panel` 的 MCP 黑名单候选源从 localStorage 换成 `useCursorMcp` hook
  - **localStorage `mcpServersJson` 整套废弃**：删 `local-store.ts`（DEFAULT_MCP_JSON / readMcpJson / isPlainObject / 字段）、`types.ts`（FeAiFlowSettings.mcpServersJson）、`use-settings.ts`（比较 / dirty 逻辑）、`route-helpers.ts`（isValidMcpServers）
- **后续（用户提过、很后面）**：MCP 来源可配置化——用户自选「用 Cursor 的 / fe 独立的」。

### V0.6.1：ship action 上线（2026-05-28）

**整体**：从 V0.6.0 收尾的 stub 状态、ship 升级成可用的「build 完成 → 自动 push → 提 MR → 飞书评论」端到端流程。设计期 5 个未拍板项跟用户对齐后落地：(1) CLI 选 server-side GitLab REST API、不依赖 glab CLI / 不写新的 MCP server、PAT 通过 settings 配；(2) 多仓 task 每仓 1 条 MR、共用 branch 名、各仓单独 push 单独提；(3) 用户 ack ship 后不再二次 ask_user、直接 push + 提 MR；(4) 同 branch 累计 commit、同仓多次 ship 累加 version、不开新 MR；(5) 自动评论飞书 story（带 PR 链接 + @ 测试人员）、**不**自动改 story 状态。`pnpm typecheck` ✓ / `pnpm lint` ✓。

#### Schema 改造（types.ts）

- `Task.gitBranch?: GitBranchInfo` → `Task.gitBranches?: GitBranchInfo[]`（每仓 1 条同名 branch、base 各仓自探）
- `MRRecord` 加 `repoPath` / `title` / `mergedAt` / `lastCommitHash`、status 字面量 `open / closed / merged`（V0.6.1 ship 时写 `open`、merged / closed 状态待 V0.6.4+ polling）
- `ActionRecord.sideEffects` 改成 `{ mrs?: Array<{ repoPath, mrUrl, mrVersion, branch, commitHash }>; feishuCommentId?: string }`
- `Task.feishuTesterUserIds?: string[]`：飞书测试人员 open_id 列表、首次 ship 自动探测 / fallback ask_user、之后 ship 复用
- `FeAiFlowSettings` 加 `gitHost` / `gitToken`（明文 localStorage、跟 apiKey 同安全级别）

#### Server 改造

- 新增 `src/lib/server/gitlab-client.ts`：`createMR` / `getMR` / `addMRNote` 三个函数走 GitLab REST API（`PRIVATE-TOKEN` header）、内部用 `formatGitLabError` 把 4xx/5xx 拼回 Chinese 错误段、`parseGitLabRemoteUrl` 解析 `git@host:group/repo.git` / `https://host/group/repo.git` 两种 remote 格式
- `task-fs.ts`：`appendMR` 改为 `upsertMR(taskId, repoPath, ...)`、同 repoPath 已存在则 version + 1 且 createdAt 保留首次值、首次创建则 version = 1；`patchMR` 按 `repoPath` 定位（不再按 `version`）；`setFeishuTesterUserIds` 持久化测试人员
- `chat-mcp.ts`：注册两个新 MCP 工具 `submit_mr` / `set_feishu_testers`、它们不直接动 task-fs、而是走 task-runner 通过 `setChatTaskActionHandler` 注册的 `ChatTaskActionHandler` 闭包；这样 chat-mcp 保持「纯协议适配层」、不耦合 GitLab / business 逻辑
- `task-runner.ts`：`internalStartAgent` 启动前注册 `taskActionHandler`、闭包捕获 `gitHost / gitToken`、`submit_mr` 走 `gitlab-client.createMR` + `task-fs.upsertMR` + `task-fs.appendActionSideEffectMR`（原子写 sideEffects.mrs）；`set_feishu_testers` 走 `task-fs.setFeishuTesterUserIds`；agent 退出 / 任务结束在 `finally` 走 conditional unset 注销 handler / notifier
- `action-checks.ts` 加 `checkShip`：①`sideEffects.mrs[]` 每条 mrUrl 非空 ②`task.repoPaths` 里没出现在 `mrs[]` 的、必须在 artifact 内出现「跳过」/「无改动」说明 ③至少 1 个 MR 或全部 repos 显式跳过

#### Prompt 改造

- `prompts/action-ship.md` 从 stub 全量改写：多仓 loop 模板（cd → git diff 检查 → commit if 有改动 → git push → git rev-parse HEAD → parseGitLabRemoteUrl → `submit_mr` MCP）、A+C 飞书 @ 流程（agent 先调 `list_workitem_role_config` + `search_user_info` 探测测试人员、探不到 ask_user 让用户填、结果 `set_feishu_testers` 持久化）、飞书评论模板（PR 链接 + 可选 @ 行）、artifact 骨架
- `prompts/action-build.md`：删 `task.gitBranch.checkedOut` 引用、改成「runner 每次 inject 多仓 idempotent checkout 命令、直接执行不要跳过」

#### UI 改造

- 新增 `src/components/settings/git-card.tsx`：GitLab Host + PAT 两个输入、跟 user-profile-card 同形态、明文 localStorage 注解放在 token 下面
- `src/app/settings/page.tsx`：引入 GitCard、跟其他 card 并列
- `use-settings.ts`：`isFieldEqual` 加 gitHost / gitToken 分支、dirty 计算覆盖
- `advance-dialog.tsx`：解锁 ship 卡片（从 `STUB_ACTIONS` 挪到 `IMPLEMENTED_ACTIONS`）、`inferDisabledReason` 加 ship 分支（缺 gitHost / gitToken 拒绝）、`inferDefaultActionType` review 完默认推 ship、`buildPlaceholder` ship 分支提示「多仓累计 commit 直接提同分支」/「飞书 @ 测试用户首次 ask_user」、`gitConfig` snapshot from settings 给 UI-side 校验用
- `src/app/tasks/[id]/page.tsx`：`handleAdvance` 从 localStorage 取 gitHost / gitToken 塞到 `/api/tasks/[id]/advance` body；详情页 repoPaths 下面加 MR 链接列表（按 repoPath tail + version tag、点击新窗打开、hover 看 title / status）
- `src/components/tasks/task-card.tsx`：首页卡片也展示 `task.mrs[]` 列表（同形态）

#### 关键设计决策

1. **不引外部 CLI / 外部 MCP server**：直接 fetch GitLab REST、PAT 闭包在 server 端、agent 永远拿不到 token
2. **多仓共用 branch、各仓独立 MR**：用户工作流就是「需求改两仓、两仓各发各的 PR」
3. **同仓多次 ship 累计 commit / 同 MR version + 1**：不开新 MR、跟 GitHub PR rebase 习惯一致
4. **A+C 飞书 @ 测试人员**：agent 优先自动探（A）、探不到 ask_user fallback（C）、不抽 helper、纯走 MCP + prompt
5. **不自动改飞书 story 状态**：只 add_comment 带 PR 链接 + @ 测试、用户 vibe 后人工流转状态（避免「自动一改、卡 PR 被拒了反悔很麻烦」）

#### 没做的事

- MR 状态 polling（`mr.status` 当前只在 ship 时写一次 `opened`、merged / closed 状态待 V0.6.4+ webhook / 手动 refresh）
- learn action 拿 MR 反馈做事后清单（V0.6.3）
- test action 走自动化（V0.6.2）

#### review 修复 + 加固（2026-05-29、bug fix）

V0.6.1 交付后一轮 review、修了 5 个真 bug + 5 项加固、`pnpm typecheck` ✓ / `pnpm lint` ✓：

- **bug：force-new-agent race 误清 handler**——旧 SDK Run cancel 卡 >5s 时 `forceClearStaleRunnerState` 只清 runningTasks、新 agent 注册的 `taskActionHandler` / `awaitingNotifier` 会被旧 agent 迟到的 finally 无条件 `set(null)` 误清、submit_mr 拿不到 handler。chat-mcp 加 `unsetChatTaskActionHandlerIf(taskId, expected)` / `unsetChatAwaitingNotifierIf`（conditional unset、比对实例引用）、task-runner 把 inline handler / notifier 具名化、finally 改调 conditional unset
- **bug：submit_mr 工具 schema 的 `target_branch` describe 跟 prompt 冲突**——describe 写「探 origin/HEAD 拿 master」、prompt 写「写死 test」、改 describe 跟 prompt 对齐
- **bug：set_feishu_testers 不带 actionId**——info 事件挂不到 ship action、补 `action_id`（ChatTaskAction type / MCP schema / handler writeEvent / prompt 样例 4 处）
- **bug：action-ship.md git fetch 静默吞**——`git fetch origin test` 失败时 `git diff` 拿空被误判「无改动跳过」、改 fail-fast（fetch 失败 exit 1）
- **bug：checkShip skip 关键词单向扫**——只看「仓名后 200 字」、agent 把关键词写仓名前会漏检、改双向扫
- **加固**：sideEffects.mrs 拼装从 task-runner「getTask→filter→patchAction」三段非原子、下沉成 task-fs `appendActionSideEffectMR`（withTaskLock 原子）；`titleSafe` 补 git ref 非法字符（~ ^ @ / 连续点 / 首尾点）；action-ship.md 补「多仓各用独立 shell」+「飞书 @ 用 lark_user_id 不能直拼文本、走工具 mention 能力」；`feishuCommentId` 注释标注「预留 V0.6.4 polling、勿删」；ROADMAP「6+1 种 action」笔误改「6 种」

#### ship 冲突检测 + test→feature 铁律（2026-05-29、V0.6.1.1）

用户实测发现「提测遇 MR 冲突时 agent 不管、照发飞书评论」。补一条端到端冲突门禁、保守策略（AI 不自己解冲突、`ask_user` 交用户决定）、`pnpm typecheck` ✓ / `pnpm lint` ✓：

- **gitlab-client.ts 新增 `getMRMergeStatus`**：MR 建好后 poll GitLab `detailed_merge_status`（GitLab 异步算 mergeability、最多 5 次 / 1.5s 间隔）、返回 `hasConflicts / mergeable / undetermined`、老实例退回 `merge_status`（can_be_merged / cannot_be_merged）；冲突判定命中 `conflict` / `cannot_be_merged` / `has_conflicts=true` 任一
- **createMR 幂等化**（自查发现的死锁修复）：撞 409/422「已有同分支 open MR」时降级新增的 `findOpenMR`（list MR API 按 source+target+opened 查）复用现有 MR、不再当失败（409/422 都兜、GitLab 版本差异；查不到退回原始错误不掩盖真因）。否则「解冲突后重跑 ship」/「同仓多次 ship」必撞 → `getMRMergeStatus` 不执行 → fe 侧 `hasConflicts` 永远停在 true → 飞书评论永远发不出 → 死锁。chat-mcp submit_mr 说明同步加「再次 ship 幂等」段
- **schema**：`MRRecord` 加 `hasConflicts / mergeStatus`、`sideEffects.mrs[]` 加 `hasConflicts`；task-fs `upsertMR` / `appendActionSideEffectMR` 入参带上（每次 ship 重新检测、解完冲突再 ship 会翻回无冲突）
- **task-runner submit_mr handler**：createMR 后调 poll、有冲突走 **error 事件**（红、醒目）/ 无冲突走 info、返回 JSON 加 `has_conflicts / merge_status / merge_undetermined`
- **chat-mcp submit_mr 工具说明**：写清返回值 +「has_conflicts=true 铁律」（不 merge/rebase/force、不评论、走 ask_user）
- **prompt（action-ship.md）**：push 改 fail-fast（拒推不 force）；工作流加 🔒 铁律「绝不 merge/rebase/pull test 进 feature、绝不 force push、冲突是用户的活」；新增 §3.5 冲突门禁（任一仓冲突 → 跳过飞书评论 + `ask_user` 抛给用户、解完重跑 ship）；§4 飞书评论加前置门禁（所有仓无冲突才发）；artifact §3 表加「冲突」列、反例补 3 条
- **checkShip**：任一 MR `hasConflicts=true` → ship 判不干净（逼用户解完重跑）
- **设计点**：冲突 ≠ 失败（MR 照建、用户才能在 GitLab 上解）、只是不评论 + 不算完成；`undetermined`（GitLab 还在算）保守当无冲突放行、artifact §6 注明待人工复核

#### settingSources 双向绑定实装 + 死代码清理（2026-05-29）

`pnpm typecheck` ✓ / `pnpm lint` ✓ / `knip` 仅剩 shadcn 标准件。

- **settingSources 实装**：task-runner / chat-runner 两处 `Agent.create` 开 `settingSources:["project"]`——加载目标仓库 repo `.cursor/` 的 rules/skills/mcp/hooks（跟 Cursor IDE 一致）；inline mcpServers 仍叠加（同名 inline 优先、不同名共存、脚本探针实测、详见 ROADMAP）。配套 `skills-loader`：只读平台自带 `skills/`、不再扫 repo `.cursor/skills/`（交给 settingSources）、`loadSkills()` 改无参、去掉 `source` 维度。
  - ⚠️ **本条「+ 全局 `.cursor/`」「skills 只读平台自带」已被上方 V0.6.2 段纠正**：`["project"]` 只加载 project 层、够不着全局 `~/.cursor/`；全局 rules/skills/mcp 改由 fe 后端自己读注入（skills-loader 改为读平台自带 + 全局 `~/.cursor/skills/`）。详见 V0.6.2 段 / ROADMAP。
- **删 `lastAgentId` 全链路**：写而不读的死链（Task/Meta 字段 + 2 处 hydrate 映射 + `setTaskLastAgentId` + 2 处调用 + import）；复活一律 `Agent.create` 新建、不依赖此字段。
- **删 V0.6.4 预留**（用户拍板「不预留、用时再写」）：`gitlab-client` 的 `getMR` / `addMRNote` / `parseGitLabRemoteUrl`、`task-fs` 的 `patchMR`、`MRRecord.lastChecked`、`sideEffects.feishuCommentId`（⚠️ 上文 ship 上线段描述的这几个「预留 / 勿删」已删、勿再找）。
- **删 client 死封装 / 无引用 export**：task-store `advanceTask` / `appendEvent`、chat-runner `cancelChat`、task-runner `isTaskRunning` / `markTaskForFork`、local-store 4 个 getter。
- **删未用文件**：3 个一次性探针脚本（probe-mcp-*.mjs）+ 3 个未引用 shadcn 组件（progress / tabs / scroll-area）。
- **收窄 21 个**内部用的多余 export（去 `export` 不删实现）；**保留** `src/components/ui/*` unused export（shadcn 标准件完整 API 面）+ shadcn/eslint 依赖（活工具链、knip 盲区）。

### V0.6.0.1：自由对话模式剥离 + 后置检查体验整改 + 推进时换模型（2026-05-27 / 2026-05-28）

**整体**：用户实测 V0.6.0 发现十个体验断点、本子版本修：(1) action=chat 跟 task 容器混用导致 agent 行为漂（用户问「你好啊」、agent 当成 plan 流程闷头思考调工具）、(2) action 完成后事件流把 deterministic 后置检查的 details 一坨贴出来（用户原话「这更像是调试内容」）、(3) plan 后置检查 V0.5.6.5 黑名单 grep 把「示例 / 或」等业务高频词误报、用户拍板「方案太粗暴、不是有效约束、直接删」、(4) 中途加过 ActionTimeline 失败 chip 的 retry 快捷入口、实测语义混乱（点旧 error chip 反而打断当前 running、起一个全新 action）、用户拍板砍掉、(5) 强制起新 agent 时没法临时换模型、只能去 settings 改全局、本版加 ModelPicker、(6) 多次推 plan / build 后时间线所有 chip 同等显著、看不出哪个是「当前生效版本」、stale 版本视觉降权、(7) review 发现偏差后 edit plan 的 strikethrough 留痕方案 prompt 高摩擦（5 子点 + 位置铁则、agent 经常踩坑）、简化为「原描述不动 + 章节末尾追加 blockquote」唯一姿势、(8) advance dialog 卡片上的「推荐」微标签语义草率（has_bug→build / plan→build 这种「流程顺推」也叫推荐显得 AI 在 narrate）、删微标签 + 删「error→同 type」那条 retry 残留 + 函数重命名为 `inferDefaultActionType`、保留默认选中作为「减少首次点击」的 UX 工具、(9) review artifact 里写「`actions/5-plan.md` §1」点击被当业务仓库路径跳 Cursor、报「找不到文件」、修 `looksLikeArtifactRef` 让它能识别 `actions/N-type.md` 这种带前缀的形式、命中后走 task 内 tab 跳转、(10) review 表格备注「同上：244-248」省略文件名导致整列点不开、`_shared.md §3` prompt 加严禁用「同上 / ↑ / ditto」类简写、表格 row 同一文件多个引用强制合并到一行用顿号分隔。`pnpm typecheck` ✓ / `pnpm lint` ✓。

#### chat 从 action 体系剥离 → 独立 mode

V0.6.0 把 V0.5 的 chat-runner 砍了、chat 吸收为 `action=chat`、用户反馈「自由聊全是问题」（agent 不回 / 走任务式公文体 / 暴露协议细节）。本版本 revert 这个决定、回到 V0.5 心智、但用 V0.6 schema 字段：

- `Task.kind` → `Task.mode`（`"task" | "chat"`、入口在新建任务 dialog 顶部 tab）
- `ActionType` 删 `"chat"`、改回 6 种：`plan / build / review / ship / test / learn`
- 新增 `src/lib/server/chat-runner.ts`：独立 runner、独立极简 prompt（只装 `wait_for_user` + shell long-poll 引导、没有 [NEXT_ACTION] / [ACTION_ACK] / [TASK_DONE] 概念）、agent 启动后第一句直接回应用户、然后 `wait_for_user` 等下一条
- 新增 `src/components/tasks/chat-view.tsx`：单栏 UI（顶部 bar + event stream + 输入框）、内部自己订阅 `useTaskWatch`、task page 按 `task.mode === "chat"` 分支渲染
- 新增 `/api/tasks/[id]/chat-reply`：处理用户消息、`runStatus === awaiting_user` 时 `submitUserMessage` 续接、idle / error / completed 时 `runChatSession` 重启 Run、收到消息立刻写 `user_reply` 事件（避免「我的你好啊没在聊天上」的体验问题）
- 新建任务 dialog：顶部 ChoiceButton tab 切换 task / chat、chat 模式 title / repoPaths / feishuStoryUrl 全选填、空 title 自动补「未命名对话 MM-DD HH:mm」
- 删 `prompts/action-chat.md`、`_super.md` 移除 chat action 段 / 例外规则 / placeholder
- 首页删「快速聊」按钮、统一从「新建任务」入

agent 永远不在 chat 模式 prompt 里看到 [NEXT_ACTION] / [ACTION_ACK] 这些概念、自然不会公文体；`ask_user` 在 chat-runner prompt 显式禁用、agent 想确认就直接 `assistant_message` 问。

#### action 失败后 retry 入口：加过、用户实测后砍掉

V0.6.0.1 中段试过给 `ActionTimeline` 的失败 chip 挂 🔄 retry 按钮、点了打开 advance-dialog、预填 actionType + `forceNewAgent=true`。意图是让 agent 从「Run 挂了 / 错误状态」状态更顺地恢复。

用户实测后反馈语义混乱：

- ActionRecord 是不可变历史、`appendAction` 永远追加新 `n`、不会改老条目
- 所以点旧 `error` chip retry、实际效果 = 「打断当前正在跑的 action」+「起一个新 action（n+1）」、跟用户直觉「修复那条历史」差太远
- task.runStatus = error 时、顶部「推进」按钮本身就是亮的、用户走标准推进 + 勾「强制起新 agent」开关即可恢复、retry chip 是冗余入口
- 多条 error chip 都长得能点、用户在「当前还在跑」时手抖点旧 chip 会把跑得好好的 agent 撞死

最终砍掉：

- `ActionTimeline` 去掉 retry icon + `onRetryAction` prop
- `page.tsx` 去掉 `advancePrefill` state + retry 触发回调
- `AdvanceDialog` 去掉 `initialActionType` / `retryHint` props + 顶部红条提示
- 「强制起新 agent」开关在 advance-dialog 保留、这才是真正从错误恢复的官方路径

教训：**UI 上额外的「快捷入口」不一定省事**——如果背后语义跟入口看起来要做的事不一致、用户会被绕进去。retry icon 看着像「修复这条」、实际是「再起一条」、两层语义冲突、宁可砍。

#### 强制起新 agent 时支持换模型 + 抽 ModelPicker 共享组件

V0.6.0 推进只能用 `task.model` / `settings.defaultModel`、想给某个 task 在不同阶段配不同模型（plan 用 opus 想得清、build 切 sonnet 省 token）只能去 settings 改全局再回来、麻烦且会影响别的 task。

本子版本末段在 `AdvanceDialog` 顶部「强制起新 agent」开关下面加了一段 `ModelPicker`：

- 开关 off：保持原行为、续接 Run、走 `task.model`
- 开关 on：露出 ModelPicker、默认值 = `settings.defaultModel`、用户可以临时换 base + 调 `thinking` / `effort` 等 params
- 提交时把 selection 透传给 `handleAdvance`、`/api/tasks/[id]/advance` body 的 `model` 字段用这个、不改 `task.model`（一次性、不污染 task 级 / 设置页全局）
- 续接 Run 时 SDK 不支持中途换模型、所以 dialog 里这段在 off 时直接隐藏、避免误以为「不开关也能改」

配套抽出 `src/components/ui/model-picker.tsx` 作为 base + parameters 双层 select 的纯 UI（不带 Card / SaveButton 包裹）、`settings/model-card.tsx` 和 `advance-dialog.tsx` 都 wrap 一层用、保证设置页和推进 dialog 行为一致——切 base 自动填默认 params、`thinking` 这种 false/true 参数显示成「关 / 开」等。符合编码约定「典型 UI 组件即使当前只有 1 个 caller 也应该抽到 `src/components/ui/`」、虽然 new-task-dialog 目前只用了 base id 没用 params、本次没急着改它、未来若想让新建任务也调 params、直接换 ModelPicker 即可。

#### 后置检查 details 不再 publish 到事件流

V0.5 / V0.6.0 在 action 切 `awaiting_ack` 时、把 `runActionCheck` 的 `details` 整段拼成一条 `info` / `error` 事件写进事件流。这套对开发期调试有用、但用户视角下：

- plan 这种「策略层」检查容易误报、用户看到一坨「artifact 出现 2 处不确定字眼」会困惑
- 真出问题（typecheck 红、lint 红）的细节也不应该塞在事件流里、agent 自己在下次 revise 时会读 `action.postCheck` 字段去修

本子版本改为：

- `task-runner.ts` 不再把 `postCheck.details` 拼进事件 text、只写一句简版「Action 产出完成、等待用户 ack（artifact=...）」
- `kind` 永远 `info`（不因 postCheck 失败标 `error`、避免红色卡片）
- `action.postCheck` 字段照样落到 `meta.json`（数据完整、想 debug 直接看文件、或后续 UI 加「调试信息」折叠面板）
- console.log 加上 `details` 截断 200 字符的输出、本地开发能从 server log 看到

#### plan 黑名单 grep 彻底删（2026-05-28）

V0.5.6.5 加过一组 13 字眼黑名单（或 / 约 / 大约 / 大概 / 可能 / 应该是 / 待定 / TBD / 暂定 / 节选 / 示例 / 部分 / 后续补全）、artifact substring 命中即 ❌、配套 `_super.md` 强制自检让 agent 自己 grep 一遍。**意图**：防 agent 写 plan 时用含糊词糊弄、build 阶段按模糊 plan 写代码会飘。**问题**：substring 不看语境、对「示例」（表格列名）、「或」（业务规则明确 or）等高频业务词误伤率高、V0.6.0.1 实测 2 条命中全是误报。**用户拍板**「方案太干脆简单了、不是个有效的方案、直接删掉、后面再考虑长远的」。

本子版本删 4 处：

- `src/lib/server/action-checks.ts`：删 `PLAN_BLACKLIST_TOKENS` 常量 + `checkPlan` 第 2 步黑名单 grep 逻辑、plan postCheck 退化为「artifact 文件存在 + 内容长度 >= 100」最低门槛
- `prompts/action-plan.md`：「后置检查」段 1. 黑名单 grep 那条删、「⛔ 严禁带不确定表述写 artifact」段的「黑名单字眼」子条删（语义引导整段保留——「不确定 → ask_user 拍板」「节选 / 示例类偷懒」反例都还在）
- `prompts/_super.md`：「写完 artifact 强制自检」段从 4 步缩成 3 步（黑名单 grep 那步删、保留业务名词全称扫 / ack 留痕位置 / 路径完整性）
- `src/lib/types.ts`：`ActionRecord.postCheck` 注释 plan 行改成「artifact 文件存在 + 内容长度 >= 100」

后续替代方案（**未做、留给将来**）：语义层质量靠 ⛔ artifact 段硬约束 + 用户人眼把关 + revise 兜底。如果以后还想做 deterministic、考虑「语义 diff（plan 跟 contextDocs 信息差）」「agent 自检 ask-LLM」等更靠谱方向、别再凑字符串。

#### `actions/N-type.md` 路径识别 hot-fix（review artifact 引用别的 action）

用户实测发现 review artifact 里写 `actions/5-plan.md §1` / `actions/5-plan.md §2.2` 这种 plan 位置引用、点击后跳 Cursor IDE 报「找不到文件」。

根因：`src/lib/path-utils.ts:looksLikeArtifactRef` 的 regex 是 `^(\d+)-([a-z]+)\.md$`、只能识别**不带任何前缀**的 `5-plan.md`。review agent 按 prompt 强约束写「actions/N-type.md」相对路径形式（_super.md「Artifact 文件路径」段、所有 artifact 互引都这么写）、不命中 `looksLikeArtifactRef`、退化到 `looksLikePath` 命中（含 `/`、最后一段 `plan.md` 有扩展名）、被当业务仓库路径走 `cursor://file/<repoPath>/actions/5-plan.md`、Cursor 找不到自然报错。

修：regex 改成 `^(?:actions\/)?(\d+)-([a-z]+)\.md$`、加可选 `actions/` 前缀；长度上限同步从 50 提到 60（多 8 个字符的前缀）。命中后渲染 / 跳转链路不变（蓝色按钮 → onArtifactRefClick → 切到目标 action panel）。

**仅识别 `actions/N-type.md` 这种相对前缀**——`data/tasks/xxx/actions/5-plan.md` 这种 fs 绝对路径不命中、保留走 `looksLikePath` + cursor:// 跳转兜底（不知道是不是 agent 写错路径、不该 task 内跳）。

#### prompt 加严：表格里不准用「同上 / ditto / ↑」类简写

紧挨上面 hot-fix——review artifact「plan 拍板口径复核」表格 row 1 写了完整 `tch-service-center/src/views/.../DetailDrawer.vue:93-95`、row 2-N 全写「同上：90」「同上：244-248」省略文件名。表格列空间有限、agent 偷懒挤一行、但用户拿这些 path 是要点击跳转的——「同上」不是 inline code、前端的 `looksLikePath` 自然识别不出来、整列全失效。

`prompts/_shared.md §3` 加严：

- **规则段加第 6 条**：明确「严禁同上 / 同前 / ↑ / 上同 / ditto 类省略词」、给出 fallback（同一文件多个引用合并成一行用顿号分隔多个 `path:line`）
- **反例段加一条 V0.6.0.1 实测的真实截图原文**：`review 表格备注：「同上：90」/「同上：244-248」/「↑ 同前」 ← V0.6.0.1 实测、表格 row 用「同上」指代上一行的文件名、用户没法点击跳转`
- 原反例里 `← 同上` 这种 inline 标注同步改成「← 没目录前缀」、避免「反例里也写同上」的歧义

reviewer agent 跑 V0.6.0.1 之后的下一份 review 时观察是否还会偷懒——如果继续踩、再考虑 review prompt 单独加显式说明。

#### 删 advance dialog「推荐」微标签 + 清掉 retry 在推断逻辑里的残留

V0.6.0 advance dialog 卡片右上角挂了一个「推荐」微标签（`type === recommended && !reason && <span>推荐</span>`）、底层逻辑 `inferRecommended(task)`：

- repoStatus = has_bug → build
- repoStatus = merged → plan（V0.6.3 起改 learn）
- 无 action → plan
- 最近 completed action：plan → build / build → review / review → plan
- **last action 是 error → 同 type**（V0.6.0.1 中段加的 retry 兜底）

用户实测后嫌「推荐」二字过重——「这个推荐逻辑太草率了太简单了、没什么意义」。逻辑本身其实是「业务状态映射 + 流程顺推」、谈不上智能：

- has_bug → build 是「业务状态决定」、不是推荐
- plan → build 是「下一步常识」、不是推荐
- 标了「推荐」反而暗示「我跟你说要走这个」、自抬身价、误导用户「这条路有什么特别理由」

V0.6.0.1 末段拍板：

- **删 UI 微标签**：`<span>推荐</span>` 整段渲染逻辑去掉、卡片右上角空着
- **删 last error → 同 type 那条**：跟「砍 retry 入口」的精神冲突（错误后不该让 dialog 默认走「再来一次」、用户应该手动决策要不要换 type）、删掉之后 error 状态默认仍走流程顺推
- **重命名 `inferRecommended` → `inferDefaultActionType`**：消除「推荐」二字的语义、明确这是「dialog 打开时默认选哪个 chip」、纯 UX 工具
- **保留默认选中本身**：dialog 打开时仍有一个 chip 是 selected、按上面 5 条逻辑算、用户每次省一次点击；这跟「推荐」不是一回事、是「初始焦点」

`new-task-dialog.tsx` 顶部注释里「任务（推荐）」也顺手清成「任务」、跟「不站队」语义一致。`action-timeline.tsx` 注释里提到「智能推荐」也改成「按 task 状态选默认 chip」。

涉及文件：`src/components/tasks/advance-dialog.tsx`（删 UI span + 改函数名 + 改 useState 变量名 + 改注释 + useEffect 依赖跟着改）、`src/components/tasks/new-task-dialog.tsx`（注释字面）、`src/components/tasks/action-timeline.tsx`（注释字面）。

#### review 改 latest plan 留痕策略简化（strikethrough → 末尾 blockquote）

V0.5.12 起 review action 走 §6 ask_user 闭环时、用户答 b（接受偏差并更新 plan）→ review agent 用 `edit` 改最新 plan artifact、`prompts/action-review.md` §6.2 b 写了 5 个子点 + blockquote 位置铁则：

- 段落 / 单层 list item 改 → `~~strikethrough~~ 新描述（review ack 补录、原计划 X）`
- 表格 cell 改 → 直接改新值 + 表末加 blockquote
- 嵌套 list item 改 → 上层字符串用 strikethrough、子 list 整体变更用 blockquote
- 反例若干 + blockquote 位置铁则（不能插表格行间 / list 项间 / 要留空行）

实测踩坑率高：

- agent 把 strikethrough 塞表格 cell 里破坏列对齐 + markdown 不渲染
- blockquote 插表格行之间、表格断成两段
- 嵌套 list 改时上下层位置拿不准、prompt 5 个子点反而越看越乱

V0.6.0.1 用户拍板「我们走敏捷开发、后面发现问题再说」+ 视觉焦点心智（latest plan = 用户在关注的、review 改它合理）下、prompt 简化为**统一一种姿势**：

- **原描述绝对不动**（保持 stale 之前那一刻的字面原文不变）
- 在**被改章节末尾**追加 ⚠️ blockquote、格式固定 2 行：

  ```
  > ⚠️ review #N 补录：原「<原描述 ≤ 25 字>」、build 跳 plan 上、改为「<新描述 ≤ 25 字>」。
  >    原因：<build agent 原因 / N/A>。详见 actions/N-review.md §用户决策 → 偏差 X。
  ```

- 位置铁则简化为 3 条：紧贴下一级标题前、留一空行；绝不插表格行间 / list 项间 / 被改字段那一行后面；多条按时序往末尾叠加、不合并

骨架「§ 用户决策」段例子同步重写、**强制要求贴「改前 / 改后片段」**（包含被改章节原文 25 字摘录 + 完整 blockquote 原文）、用户在 review artifact 一个文件能看清楚 plan 改了什么、不用切 tab 对照 plan diff。

未做（敏捷迭代留观察）：

- 同一 latest plan 被 review 修订 N 次的阈值提醒
- ArtifactPanel 加「快看 latest plan」按钮（ArtifactPanel 已支持选 chip 切 artifact、加专用按钮过度设计）
- `_shared.md §8`「review 例外可 edit plan」那条保留不动、与 Z' 思路一致

#### Action timeline stale 视觉降权

V0.6.0 时间线上所有 action chip 同等显著、只有 `currentActionId` 加一圈 ring。多次推进同 type（plan #1 → plan #3 / build #2 → build #4）后、用户看不出哪个 chip 是「当前生效版本」、哪些是「已被新版本取代的历史快照」、artifact 切回历史版本只能凭 n 大小硬记。

`src/components/tasks/action-timeline.tsx` 加 `computeLatestByType` helper、按「同 type n 最大的算 latest、其他都 stale」算 isStale：

- **stale chip**：`opacity-50 + text-muted-foreground`、状态点本身也淡化（不再用 `bg-emerald-500` 这种饱和色撞眼）
- **latest chip**：正常颜色、有 `currentActionId` 加 ring 高亮
- **hover title**：stale chip 后缀「（已被 #N type 取代）」、用户能确认是被哪个新版本顶掉
- **可点性不变**：stale chip 仍可点选中、ArtifactPanel 切到历史版本读 artifact 不受影响

跟 status 解耦——error / cancelled chip 在 stale 时同样淡化、不再用 status 跟 stale 双重打架。视觉表达原则：「opacity 表达时间维度（旧版本被取代）、status 点颜色表达本次执行结果」。

注意没引入「latest 但 status === error」的特殊外圈、跟原有视觉一致：状态点的红色已经能把 error 顶到顶层注意力、不需要再叠 ring。

**hot-fix（V0.6.0.1 末段、用户反馈 ring 视觉读不出意图）**：`isCurrent && !isSelected` 那圈 ring 用户 hover 完才反应过来是「当前 action」、看着像 hover 残留态。chip 的 title 由「单一信息」改成「多状态拼装」、把 isCurrent / isStale 各自的语义都拼进圆括号——例如「#8 复核 · 等用户确认（当前 action、点可跳回、已被 #9 取代）」——hover 一眼看清楚多个修饰来源、不用猜。

#### 不做的事

- chat 模式 task 不写 `actions/` 目录（没有 artifact 概念）
- chat 模式 task 不能走「推进」dialog、`advance` route 防御性 reject `task.mode === "chat"`
- 不写 V0.6.0 → V0.6.0.1 migration（开发期 / 本机清 `data/tasks/*` 即可）

---

### V0.6.0：核心重构（2026-05-27）

**整体**：按 `docs/V0.6-REFACTOR.md` 落地核心模型重构。从 phase chain 切到 task 容器 + action 历史、动了 30+ 文件、删 4 个旧路由 + 4 个旧组件、新增 ActionTimeline 等组件。V0.5 兼容代码 / 数据彻底删（不写 migration、开发期清空 data/tasks/*）。`pnpm typecheck` ✓ / `pnpm lint` ✓。

#### Day 1：Schema + Runner 骨架

- `src/lib/types.ts` 大改:ActionType / ActionStatus / RepoStatus / RunStatus / ActionRecord / MRRecord / GitBranchInfo 加入；V0.5 LegacyPhaseId / LegacyTaskData / task.legacy 等类型彻底删
- `src/lib/server/task-fs.ts` 大改:appendAction / patchAction / setTaskRepoStatus / setTaskRunStatus / snapshotActionArtifact 等 V0.6 API；isValidMetaShape 取代 isLegacyMeta（不匹配的 meta.json 直接 skip、不再 hydrate 老 task）
- `src/lib/server/task-runner.ts` 新增:整合 plan-runner + chat-runner、统一 advanceTask / acknowledgeAction / finalizeTask
- `src/lib/server/chat-mcp.ts` 大改:phase_* → action_*、submitNextAction / submitTaskTerminate 新增

#### Day 2：Prompt 重组

- `prompts/_super.md` 大改:一次性注入 7 种 action prompt + action history + first NEXT_ACTION 指令
- `prompts/_shared.md` 中改:phase → action 字眼、跨 action 一致性约束
- `phase-1-plan.md` → `action-plan.md`、`phase-2-build.md` → `action-build.md`、`phase-3-review.md` → `action-review.md`、骨架沿用 V0.5.15 改完版本、加准入 / 后置 / anti-patterns 段
- `action-ship.md` / `action-test.md` / `action-learn.md` / `action-chat.md` 新建（前 3 个是 V0.6.1+ 设计草稿、stub）

#### Day 3：UI 改造

- 删 `chat-view.tsx` / `phase-progress.tsx` / `approve-phase-dialog.tsx`（V0.6 不需要）
- 删旧路由:`start-workflow` / `phase-ack` / `chat-reply` / `watch-chat` / `artifact-revisions` / `artifact-diff`
- 新增路由:`advance` / `action-ack` / `finalize` / `watch-task` / `action-revisions` / `action-diff`
- `task-card.tsx` 重写:双状态 badge + 最近 action 简略
- `new-task-dialog.tsx` 重写:删 mode、全字段选填
- `advance-dialog.tsx` 重写:选 action 类型 + 用户指令 + forceNewAgent
- `action-timeline.tsx` 新增:横向 chip + 状态点
- `artifact-panel.tsx` 重写:接收 ActionRecord + 异步加载 content
- `task page` 重写:删 chat-view 分支、单一布局
- V0.5 兼容代码彻底删（LegacyTaskView 没保留、hydrateTaskLegacy 删、各路由 task.legacy 守卫删）
- `revise-dialog.tsx` 适配:phaseLabel → actionLabel
- `event-stream` 系列适配:phase → actionId
- `settings/repo-card.tsx` 加 `mainBranch` 字段输入（注：V0.6.1 重新废弃、base branch 由 agent 自探）
- `settings/user-profile-card.tsx` 新增:`username` 字段

#### Day 4：6 个 Harness 门槛 P0+P1

- `src/lib/server/action-checks.ts` 新增:plan 黑名单 grep / build typecheck+lint+git status / review 4 类段 + hash 一致（plan 黑名单 V0.6.0.1 已删、详见上方）
- `task-runner.ts` 在切 awaiting_ack 前调 `runActionCheck`、写 `action.postCheck`
- `advance-dialog.tsx` 加 `inferDisabledReason` + `inferRecommended` + `buildPlaceholder`、推荐 / 灰掉 / 动态 placeholder 三件套

#### 关键设计决策（不要回头）

1. phase 顺序拆掉、action 任意触发
2. 单 task 多 MR、`Task.mrs` 列表追踪（V0.6.1 ship 上线时填）
3. chat 吸收为 `action=chat`、删 chat-runner（V0.6.0.1 又拉回 chat 模式 / 独立 runner）
4. 单 SDK Run 永生（同 V0.5）
5. V0.6.0 实装 plan/build/review/chat、ship/test/learn 是 V0.6.1+ stub
6. 老 V0.5 task 只读、不写 migration

#### 没做的事

- ship / test / learn action 实际跑通（V0.6.1+ 分版本上）
- 门槛 5 cross-action 一致性自检（V0.6.4+）
- MR 状态 polling（V0.6.4+）
- learn 自动 cleanup（V0.6.4+）

### V0.5.16-design：V0.6 重构设计纪要（2026-05-27、代码未动）

**整体**：跟用户深入对齐工作流（飞书需求 → 多个 MR → 测试反馈 → 改代码再提 → 最终合入）后、确认 V0.5 phase chain 模型存在系统性错配。决定重构为 task 容器 + action history 模型、设计文档落 `docs/V0.6-REFACTOR.md`。**本子版本只产文档、不动代码**——后续 V0.6.0 实际落地代码。

#### 产出

- **`docs/V0.6-REFACTOR.md`**（新文件、~900 行）：V0.6 完整设计文档、14 节 + 3 附录、包含：
  - 0-1 节：接力上下文 + 重构背景（用户工作流复述 + 4 个错配）
  - 2-3 节：V0.5 核心问题 + V0.6 新架构总览（task 容器 + action history + 单 SDK Run 永生）
  - 4 节：task schema 新旧对比 + 文件系统改造（actions/ 目录、N-<type>.md）
  - 5 节：6 + 1 种 action 详细规格（plan / build / review / ship / test / learn / chat）
  - 6 节：6 个 harness 门槛设计
  - 7 节：prompt 文件重组方案
  - 8 节：UI 改造点
  - 9 节：「再聊聊」/ revise / chat 在新架构下的语义
  - 10 节：单 SDK Run 永生策略 + wait_for_user 协议改动
  - 11 节：老 task 兼容（只读 / 归档、不写 migration）
  - 12 节：分版本路径
  - 13 节：未拍板项（7 个动手前必须澄清的）
  - 14 节：新 AI 接力 checklist
- **`docs/HANDOFF.md`** 顶部加「即将到来：V0.6 重构」段、关键文件索引加 V0.6-REFACTOR.md 行
- **`docs/ROADMAP.md`** 顶部「下一阶段」段重写、原 V0.5.16 learn-phase-only 描述替换为 V0.6 重构概览

#### 关键设计决策（不要回头）

1. **phase 顺序拆掉**：plan / build / review / ship / test / learn / chat 是 action 类型、不是顺序约束
2. **单 task 多 MR**：MR 提了 task 不结束、可继续推进、`Task.mrs` 列表追踪
3. **chat 吸收**：删 chat-runner.ts、chat = `action=chat`、统一架构
4. **单 SDK Run 永生**：跟 V0.5 一致、Run 不退（除非 task 标完成 / abandon）
5. **6 harness 门槛补回**：准入 + 后置 + prompt + placeholder + 推荐 default
6. **老 task 只读**：不写 migration、按 project-context.mdc「不写向后兼容」原则

#### 没做的事

实际代码改动**全部留给下一个 AI**——用户拍板「设计这么大量级、单 agent 长对话上下文必塞爆、新 agent 拿设计文档接力更稳」、跟 harness 思想「不依赖单 LLM 连贯性、用结构化文档约束」自洽。

### V0.5.15：chat-runner 对齐 + V0.5.6.2 plan 重构后遗症清理（2026-05-26）

**整体**：接力时一锅做的两类清理。一类是「plan 有、chat 还没」的对齐性 bug（console.log 兜底）；一类是 V0.5.6.2 plan 重构（砍 §3.1 文件清单 + 验收点直接挂 task）只动了 plan、build / review prompt 没跟上的后遗症。无新功能、纯清理 + 对齐。

#### 1. chat-runner `case "status"` 加 console.log 兜底（对齐 plan-runner V0.5.5 增强）

**背景**：SDK 1.0.13 `status=error` 时偶尔不发详细 message、`run.wait()` 拿到的 RunResult 也不带具体描述、chat 模式只能 throw 一个空错误、用户 / dev 看不到任何诊断信息。plan-runner 早就在 case `status` 顶部加了一行无条件 `console.log` 兜底——chat-runner 漏了。

**修法**：`src/lib/server/chat-runner.ts` 的 `case "status"` 头部补一份同款 log。

#### 2. phase-2-build.md 骨架跟 V0.5.6.2 plan 重构对齐

V0.5.6.2 把 plan §3.1 文件清单砍掉、验收点直接挂在每个 task 上、但 build 骨架那时没跟上、留了「## 改动文件清单」+「## 验收对照」两个独立段、跟 task 自带字段重复 100%。同时 V0.5 加 review phase 后由 review 出 commit msg、build 还在出一份、也重复。本轮一次性清掉：

- **task 子条加「验收处理」字段**（4 → 5 字段）
- **删独立的「## 验收对照」段**
- **删独立的「## 改动文件清单」段**
- **删「## 给用户的交接」段**
- 同步更新顶部「⚠️ 路径写法」警告

#### 3. plan-runner.ts loadPhasePrompt 删 4 个 unused 占位符

历史残留：`title` / `feishuStoryUrl` / `description` / `artifactsDir` 注入了但 phase prompt 没一处引用、按「开发期不写兼容代码」原则清掉。

#### 4. phase-1 artifact 写入工具引用表述统一为 phase-2/3 同款（去括号注解）

`prompts/phase-1-plan.md` 的引用比 phase-2/3 多带括号注解、详细信息 `_super.md`「跨 phase 共享规范 §1」里已经说清楚、不需要每个 phase 都重复。

#### 5. ROADMAP.md V0.5 段「plan phase 校验前移」描述跟 V0.5.6.1 同步

ROADMAP 还写「plan agent 在 01-plan.md 里写『我的理解 vs 飞书原文』对照」、V0.5.6.1 已经撤了这个段、改成「跟原文有差异一律 ask_user 闭环」、ROADMAP 没跟。

#### 验证

`pnpm typecheck` ✓ / `pnpm lint` ✓

#### 没做的事（用户拍板「保持手动重启」）

接力文案里另一个小 bug「chat 模式加 `NGHTTP2_ENHANCE_YOUR_CALM` 自动降级（plan 已有、chat 还没）」**暂不做**——用户拍板「就还是用户手动重启」、保留 chat 模式现状。

---

### V0.5.14：事件流虚拟滚动 + memo（彻底解决「事件流多了卡」）（2026-05-26）

**背景**：用户实测发现事件流多了之后明显卡顿、滚动 / 输入 / 折叠展开都有延迟感。分析根因：

- 几百条 events 一起 render、每条一个 EventRow（card div + memo state + 可能的 markdown 渲染）
- SSE 一推 chunk → `task.events` 引用变 → 整个事件流子树 reconcile
- `react-markdown` parser 不便宜、几百条 assistant_message 一起 re-render 一下就堵 main thread

**方案 A+B 落地**（用户拍板「彻底解决」）：

1. **`react-virtuoso` 虚拟滚动接管主体**
   - 装 `react-virtuoso@4.18.7`
   - `<Virtuoso data={items} itemContent={...} />` 替代原 `<div onScroll>` + 手动 scroll ref
   - DOM 节点封顶 ~30 个（viewport + buffer）、几百条 events 性能持平
   - `followOutput={(isAtBottom) => isAtBottom ? "smooth" : false}` 一行替代老的「贴底跟随」逻辑：
     - 库自己维护「是否贴底」、不需要 `stickToBottomRef` + `handleScroll` + `useEffect`
     - 删了原本 ~25 行的滚动控制代码
   - `initialTopMostItemIndex={items.length - 1}` 初始定位末尾
2. **`streamingText` 拼成虚拟末尾 item 参与虚拟化**
   - 之前是「特殊渲染在事件列表之后」、需要单独 Footer 组件 + scrollIntoView
   - 现在：`__streaming__` 假事件 push 到 data 数组末尾、跟其他 event 一起 virtualize
   - `followOutput` 自动跟着追加滚动、不需要额外触发
3. **`React.memo` 包裹 row 组件**（`rows.tsx`）
   - `EventRow` / `AskUserRequestRow` / `StreamingAssistantRow` 全部 memo
   - SSE 频繁 setTask 时已渲染 item 跳过 reconcile、ID 稳定的 row props 不变就不重渲染
   - 配合 Virtuoso 的 item 复用、整体 reconcile 工作量降一个数量级

**bundle 影响**：`/tasks/[id]` First Load JS 270 KB → 290 KB（+20 KB / +7%）、`react-virtuoso` ~15 KB gzipped、可接受。

**V0.5.13.4 自动滚动 bug**（顺带修）：

之前 `useEffect` 依赖 `renderEvents.length`、但合并算法（thinking + tool_call）把多条合一条、length 不变、贴底也不滚——用户反馈「自动滚动经常失效」。

修法：dep 换回原始 `task.events.length`（单调递增）。**V0.5.14 接 Virtuoso 后该 useEffect 被整体删除**、bug 自然消失（库自己管贴底）、不需要单独 fix。

**验证**：`pnpm typecheck` ✓ / `pnpm lint` ✓ / `pnpm build` ✓（23 routes 全编译、`/tasks/[id]` First Load 290 KB）

**待联测**：跑一个事件多的真任务（几百条 events）、看滚动 / 切折叠 / 推 chunk 是否丝滑、贴底跟随是否正常。

### V0.5.13.2：所有 dialog 加 Cmd+Enter 提交（默认快捷键）（2026-05-26）

用户拍板「Cmd+Enter 成为所有 dialog 的默认提交快捷键」、跟 event-stream 输入框 / chat 应用通用习惯（Slack/Cursor/ChatGPT）对齐。

**4 个 dialog 一锅都加**（Textarea onKeyDown handler 模板：`Cmd/Ctrl+Enter` 阻止默认 + 调 `handleSubmit`）：

| Dialog | 改动 |
|---|---|
| `revise-dialog.tsx` | Textarea + onKeyDown、placeholder 加「（Cmd+Enter 发送）」 |
| `ask-user-dialog.tsx` | Other 模式 Textarea + onKeyDown（placeholder 不动、原本就很长） |
| `new-task-dialog.tsx` | description Textarea + onKeyDown |
| `advance-dialog.tsx` | fork reason Textarea + onKeyDown |

**安全保证**：每个 `handleSubmit` 内部已有 `!canSubmit` / `!allAnswered` 短路保护、未填完时 Cmd+Enter 无副作用（按钮 disable 也走同样校验）。

**单 `Enter` 保持换行**、避免误发。

**验证**：`pnpm typecheck` ✓ / `pnpm lint` ✓

### V0.5.13：事件流密度优化（summarize 全文压缩 + tool_call 合并）（2026-05-26）

**背景**（用户跑完 V0.5.12 第三轮联测后即时反馈）：

1. 思考块折叠态文本「没占满一排就省略 + 没省略号」、用户看到一句短话不知道下面还有几行
2. review 阶段 agent 频繁 edit `01-plan.md` / `03-review.md`、tool_call 一连十几条卡片刷屏（review 闭环的副作用）

**改动**（全在 `src/components/tasks/event-stream/`）：

1. **`summarize` 改全文空白压缩 + 200 字截**
   - 原本：取 `text.split("\n")[0]` 首行、80 字截、首行短不加省略号
   - 现在：`text.replace(/\s+/g, " ").trim()` 拍平、200 字兜底
   - 配合 truncate class：容器宽度截到哪算哪、自动 `…`、用户看到尽量满的预览
2. **`mergeAdjacentToolCall` 新增（V0.5.13.1 hot-fix 后）**
   - **初版**：同 phase + 同 `meta.name`（tool 名）连续 ≥2 条 tool_call 合一卡
   - **hot-fix 放宽**（用户实测拍板）：去掉「同 tool name」约束、改成「同 phase 连续 tool_call」就合并
     - 原因：AI 探索式调用经常 `read → grep → read → edit` 交错、严格相邻不触发、压不了几条
     - 折叠态：「工具调用 ×N」+ 最后一条 `summarize(ev.text)` 摘要（给用户看「收尾在干嘛」）
     - 展开态：每条子条带 `[tool name]` prefix（蓝色 badge）、看得清谁是谁
   - `meta.batch = [{ id, ts, text, name }]` 保留所有子条
   - `meta.count` 给折叠态显示「×N」后缀
   - 类似 `mergeAdjacentThinking` 不动 events.jsonl 落盘内容、只在 UI 渲染前合并
   - `event-stream.tsx` 的 `renderEvents` useMemo 两道 pass：thinking 合并 → tool_call 合并
3. **`EventRow` batch 折叠态展示**
   - 折叠态文本：`${summarize(ev.text)} ×N` 后缀
   - 展开态：列表展示每条 `[name] {text} {ts}`、字号 [11px] 紧凑 mono
   - 不可展开的 single tool_call 走原逻辑

**用户拍板未选**：C 方案「显示工具调用 / 思考 / phase 边界」过滤器 toggle——每次都要用户操作太烦。B 方案被动降密度、跟 Cursor IDE 行为一致。

**验证**：`pnpm typecheck` ✓ / `pnpm lint` ✓

---

### V0.5.12.3：review prompt 5 点精修 + 第二轮联测 hot-fix（2026-05-26）

**背景**：用户实测 V0.5.12.2 闭环后跑了一道任务 `t_1779688487844_9kzpdc`、闭环 work（agent 调 ask_user / 用户选 b / agent edit plan / 追加用户决策段）、但发现 5 个不完美点。本轮先做 prompt 精修、再跑一轮联测、发现 2 个新边界 case 一并修。

#### 第一轮：5 个 prompt 改动（全在 `prompts/phase-3-review.md`）

1. **P0 strikethrough 分场景规则**（§7.2）：表格 cell 里加 `~~xxx~~` 会破坏列对齐 + markdown 不渲染、agent 会偷偷绕过。改成分场景规则：
   - 段落 / 单层 list item → strikethrough 划掉旧描述、新值跟在后面、末尾加补录标记
   - 表格 cell → 表格直接改新值、用 blockquote 留痕「⚠️ review ack 补录：<字段> 原 X、改为 Y（用户在 ask_user 答 b 接受偏差）」
   - 嵌套 list item → 上层是字符串用 strikethrough、整体清单变更用 blockquote
   - 反例明确禁掉「`| field | ~~old~~ new | ... |`」
2. **P1 飞书未覆盖项纳入闭环**（§7 触发条件 + §7.1 第 3 个 question 模板 + §7.2 落地路径）：之前只闭「实现偏差 + 未完成 task」、漏了「跟飞书需求对照」表里 ❌ 未覆盖 项（飞书原文有、plan 漏列了、build 也没做的）。加 question 模板 `options = [a 加进 plan 作 follow-up / b 接受不做（plan §6 留痕）/ c 跨角色跨仓库不留痕]` + 三条落地路径
3. **P2「§ 用户决策」段位置固定**（骨架加 HTML 注释 + §7.4 第 1 条）：明确放在「未完成 task」段后、「跟飞书需求对照」段前、不要追加到 artifact 末尾。打破阅读流的 anti-pattern 列出来
4. **P3「§ 修改记录」段语义严格**（§7.4 第 2 条）：明确「§7 闭环动作（ask_user 问 / edit plan / 追加决策段）**不属于** §修改记录、§修改记录段只在用户 ack=revise 后按 feedback 改时才追加」。防止双写
5. **P4 plan 拍板口径显性复核**（§1 表格备注 + 骨架加 ## plan 拍板口径复核 段 + §6 提醒）：plan agent 内联的 `> ✅ ask_user 已确认 X` 备注、每条都得列到这个新段、给「✅ 一致 / ⚠️ 跑偏 / N/A 没用到」三选一结论

#### 第二轮：联测发现的 hot-fix（同日跑下来的边界 case）

跑了第二轮真任务（`t_1779688487844_9kzpdc` 回滚 plan + 重跑 review）、5 点行为全部按新规则执行——但发现 2 个新边界 case：

6. **P0.1 blockquote 位置铁则**（§7.2 新增第 4 条）：agent 把 blockquote 插到表格行之间 / list 项之间、破坏 markdown 结构。实测：
   - §2.1 表格被改的 `questionData` 那行紧下方插 blockquote、后面 `mathLevelV2` / `studyPurpose` 两行被切到 blockquote 后面、render 时表格断、那两行变成普通文本
   - §5 Task 1 子列表「`- 改动:`」和「`- 依赖:`」之间插 blockquote、`- 依赖` 起头一个新 list、不再是 task 子项
   - 修：明确「blockquote 必须放在**整个表格 / 整个 list 块结束之后**、不能插中间」、加正确做法 + 反例
7. **P4.1 拍板口径复核段职责严格**：agent 把 review ack 补录的项也列到「plan 拍板口径复核」段（混淆「plan 阶段拍板」和「review 阶段拍板」）。修：明确「本段只列 plan 阶段 `> ✅ ask_user 已确认` 备注、review ack 补录（`> ⚠️ review ack 补录`）归『§ 用户决策』段、不重复列」

#### 第三轮：start-workflow fork 模式漏 ack 上游 phase（代码修复）

8. **`plan-runner.ts` fork 路径自动 ack 上游 phase**（V0.5.12.3 hot-fix）：实测发现 `start-workflow` 路由的 fork 模式（用户在 AdvanceDialog 选「推进 → fork → fromPhase=review」）**只 reset 下游 phase 到 pending、不 markPhaseAcked 上游 phase**——build 状态永远卡在 `awaiting_ack`、UI 显示「BUILD 待确认」、但 review 已经基于 build 跑完了、状态机和实际进度脱节、用户视角懵。
   - 修：fork 路径加循环、对 fromPhase 之前的所有 phase 调 `patchPhase status=ack` + 写 `phase_ack` 事件（meta.autoAck=true）
   - 语义：「fork from X」= 「用户认可 X 之前所有 phase 的产出」、自动 ack 符合直觉
   - 区分 `phase-ack` 路由 fork：那条路径已经在自己路径里调 markPhaseAcked(ackPhase)、走到 plan-runner 时上游已 ack；本修复覆盖的是 `start-workflow` 路由直接 fork 的场景

**验证**：`pnpm typecheck` ✓ / `pnpm lint` ✓

**待联测**：跑新任务（或 fork 老任务再来一轮）、看 review agent 在新 prompt 下是否避开 blockquote 中插问题；fork 从 review 时上游 build phase 状态自动变 ack。

### V0.5.12.2：全局遗留清理（开发期不写兼容代码原则的一次集中执行）（2026-05-26）

**背景**：上一轮做 review phase ask_user 闭环时一度加了 `recommended` 字段、用户实测后拍板「都删、删赶紧、我不希望代码有各种遗留」、顺势让我扫整个项目把其它「向后兼容代码」也清一遍。项目规则原话「开发期不写向后兼容代码、改 schema 直接删旧」、这次集中兑现。

**删的四块**：

1. **`recommended` 推荐机制全链路**（`AskUserQuestion` 字段 + chat-mcp zod schema + ask-user-dialog 一键接受按钮 + 推荐徽章 + prompts/phase-3-review.md 推荐文案）
2. **`task-fs.ts` V0/V1 老 artifact 兜底**：
   - `readArtifact` / `writeArtifact` 不再回退到 task 根的 `<phase>.md`、只走 `artifacts/<NN>-<phase>.md`
   - `phaseArtifactFilename` idx<0 改成抛错（不再返 legacy `<phase>.md`）
   - 删 `sanitizeCurrentPhase`（V0 时代 `spec` phase 兜底）、`currentPhase` 直接读 meta
   - 文件头注释从「spec.md / plan.md / build.md 平铺在 task 根」改成 V0.5 的 `artifacts/01-plan.md` 子目录布局
3. **`repoPath` 单值字段**（V0.5.9 改 `repoPaths: string[]` 数组、当时留了 hydrate `[repoPath]` 兜底）：删 TaskMeta `repoPath?` 字段 + 删 hydrate 双向兼容、`repoPaths: meta.repoPaths ?? []` 一行搞定
4. **`start-workflow` mode 缺省 = restart**（V0.5.7 加的「老 UI 不传 mode 时默认 restart」）：mode 改成必传、不传返 400；`StartWorkflowOptions.mode` 改非可选；`task-store.startWorkflow` 签名 options 改非可选
5. **`local-store.ts` 老 schema 兼容**：删 `migrateDefaultModel`（早期 string → ModelSelection）+ `migrateMcpJson`（早期裸 server map → 带 wrapper）的迁移逻辑、改成纯校验「字段形态不对就回默认值」

**副作用** （用户拍板接受）：

- V0.5.9 之前的 task 打不开（meta.json 里只有 `repoPath` 单值的）——本地 data/tasks/ 老任务作废
- V0 时代 currentPhase=`spec` 的 task 打开会崩——更老的、应该已经没了
- localStorage 里存的老 schema settings 读不出来、用户需重配 API key + 模型 + MCP（5 分钟）
- 外部脚本不带 mode 调 `/start-workflow` API 会 400（项目内 UI 全部走 AdvanceDialog 显式传 mode、无影响）

**验证**：`pnpm typecheck` ✓ / `pnpm lint` ✓ / `pnpm build` ✓

### V0.5.12（迭代二）：review phase 闭环（ask_user + 直改 plan）（2026-05-25）

**背景**（用户实测 V0.5.12 迭代一 diff 视图后提的问题）：跑了一道任务、review phase 列出「实现偏差」段建议「接受偏差并更新 plan」、但用户在 ack 时不知道怎么落地——「更新 plan」这个动作没人做、review 不能动 plan、build 已结束、用户「再聊聊」也不一定能 trigger 改对 plan。流程**没闭环**。

用户拍板路径：「让 AI 通过 ask_user 主动问、像 plan phase 一样」、避免不熟悉的用户面对 artifact 里的 a/b/c 选项盲选。

**核心改动**（`prompts/phase-3-review.md` 重写流程）：

```
§6  写 03-review.md 初稿（不含「§ 用户决策」段）
§7  ⭐新增：如果有「实现偏差」or「未完成 task」段、必须调 ask_user 把所有条目一次性问完
     - 实现偏差 question：options=[a 改回 plan / b 接受偏差并更新 plan]
     - 未完成 task question：options=[a 现在补做 / b 建 follow-up / c 接受不做]
     - ⚠️ AI 不在 prompt / question 文本里偷偷暗示「建议 X」「推荐 Y」、HITL 是底线
§7.2 ask_user 答完后落地：
     - 答 b（接受偏差）→ edit 01-plan.md 对应段落、用 ~~strikethrough~~ 划掉旧描述 + 加 review ack 补录标记
     - 答 c（未完成 task 接受不做）→ edit 01-plan.md §5 task 加注解
     - 答 a → 不动 plan、用户 ack=revise 时回 build / 再走改回 plan 路径
     - 自定义文本 → 不落地、记到决策段、必要时 assistant_message 提示用户再回弹窗选
§7.3 把每条决策追加到 03-review.md「§ 用户决策」段（agent 自己 edit、不在初稿里）
§8  调 wait_for_user 等用户最终 ack

约束扩展：
  - review phase 允许写入 01-plan.md（破例、只在 §7 ask_user 答完 b/c 后、只动描述 / 注解）
  - 其它一切只读不变
  - V0.5.12 limitation：edit 01-plan.md 时**不自动 snapshot 旧 plan**、所以这次 review ack 改动不进 diff 历史、V0.5.13 再补
```

**验证**：`pnpm typecheck` ✓ / `pnpm lint` ✓

**待联测**：跑一道有「实现偏差」段的真任务、看 review agent 是否调 ask_user 弹偏差选项 / 用户选 b 后 01-plan.md 是否被改 + 留下 strikethrough 痕迹 / 03-review.md「§ 用户决策」段是否追加。

### V0.5.12（迭代一）：artifact diff 视图（snapshot + 内嵌 diff）（2026-05-25）

**背景**（用户痛点）：每次「再聊聊」让 AI 改 md 后、不知道哪些地方动了、需要重读长 artifact 找差异。

**核心设计**（用户拍板「第一版先简单」）：

```
后端 snapshot 机制：
  - phase-ack revise 分支、submitPhaseAck 前先 snapshotArtifact(taskId, phaseId)
  - 复制当前 artifact → data/tasks/<id>/artifacts/.revisions/<NN>-<phase>.<ISO>.md
  - meta.revisions[phaseId] 末尾追加 { timestamp, path, size }
  - 每 phase 上限 10 个、超出 GC 删最老（fs 文件 + meta 记录）
  - 仅覆盖「用户主动 revise」单一路径、agent 内部 edit 不触发——第一版聚焦最高频场景

前端 artifact-panel toolbar：
  - 加「正文 / Diff」切换（mode state、默认 content、保持 V0.5.11 hot-fix 简洁感）
  - Diff 模式下显示快照 dropdown（对比上次 / 初版 / 任意快照）+「行内 / 并排」切换
  - 顶部黄色 banner「✨ AI 刚修订了 N 处 [查看修改] [×]」在「有未看 revision」时浮现
  - banner「已看」状态走 localStorage（key: fe-ai-flow:artifact-revisions-seen:<taskId>:<phaseId>）
    不污染 task meta、不同浏览器各自独立（V0.5.12 第一版可接受妥协）

Diff 视图实现：
  - react-diff-viewer-continued 4.2.2、useDarkTheme=true（项目 next-themes forcedTheme="dark"）
  - compareMethod=WORDS_WITH_SPACE（词级 diff、对 markdown 段落级修改友好）
  - showDiffOnly=true 折叠未变行、hideSummary=true 隐藏 lib 自带顶部 bar
  - next/dynamic 懒加载（~36KB 库体积）、用户不切到 Diff 就不拉、First Load JS 270KB（V0.5.11 持平）
```

**新增 API**：

- `GET /api/tasks/[id]/artifact-revisions?phase=plan` → `{ revisions: ArtifactRevision[], current: { content, filename } | null }`
- `GET /api/tasks/[id]/artifact-diff?phase=plan&from=<ts>&to=<ts|current>` → `{ from: { content, timestamp }, to: { content, timestamp | null } }`
  - from / to 都用 timestamp 索引、不接 path 入参、防路径穿越

**新增组件 / 文件**：

- `src/components/tasks/artifact-diff.tsx` —— react-diff-viewer-continued 包装、props: oldText/newText/leftTitle/rightTitle/splitView
- `src/lib/server/task-fs.ts` 新增 `snapshotArtifact` / `listArtifactRevisions` / `readArtifactRevisionContent` / `readCurrentArtifact`
- `src/lib/task-store.ts` 加 `fetchArtifactRevisions` / `fetchArtifactDiff` client helper

**schema 扩展**：

- `Task.revisions?: Partial<Record<PhaseId, ArtifactRevision[]>>`
- `ArtifactRevision = { timestamp: number; path: string; size: number }`
- 老 task 没此字段、hydrate 时按 undefined 兜底、API 路由按 [] 兜底

**不做**（评估后 ROI 低、用户已拍）：

- ❌ rendered markdown + 段级高亮（手写段对齐算法易错、ROI 低）
- ❌ 双视图 split-view（artifact-panel 本就不大、拆栏挤）
- ❌ SDK toolCall 事件流 diff 卡片（事件流已拥挤、bash sed 拿不到 diff 不可靠）
- ❌ 覆盖「agent 自主 edit」（一版只覆盖用户主动 revise、最高频场景搞定就行）

**验证**：`pnpm typecheck` ✓ / `pnpm lint` ✓ / `pnpm build` ✓（23 routes 全编译、`/tasks/[id]` First Load 270 KB 跟 V0.5.11 持平）

**待联测**：跑一道真任务、plan 出方案 → 「再聊聊」改一处 → 等 AI 改完、看 banner 是否浮现、切 Diff 是否清晰看到红绿对比

---

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

**Hot-fix 4：artifact-panel 删「渲染 / 原文」切换（2026-05-25）**

- 用户反馈实际无看 raw markdown 的场景、保留切换徒增心智
- `artifact-panel.tsx`：删 `mode` useState / 「渲染 / 原文」两个 Button / `Code2`/`Eye` 图标 import / source 分支渲染
- toolbar 顶部只剩文件名、永远走 ReactMarkdown
- 净减 32 行

**验证**：`pnpm typecheck` ✓ / `pnpm lint` ✓ / `pnpm build` ✓（21 routes 全编译成功、10/10 static pages）

**下个迭代标记**：V0.5.12「artifact diff 视图」规划已对齐（见 `docs/ROADMAP.md`）、本轮代码 0 改动。

---

##### 补 V0.5.10：revise 交互二分类铁则 + Resizable 分栏（2026-05-23、用户拍板）

**背景**（用户原话）：「再聊聊的结果不可控、有时候 AI 是弹窗过来问问题、有时候是在事件流回答我、有时候甚至都不回答我就直接开始改 md、总之什么情况都有。这个交互需要统一」

V0.5.5 起 prompt 里写的是「A 明确改 / B 明确问 / C 含混 / D 带图」4 分类——动机本是「清晰直接干、模糊才 ask_user 复述」、但实操中标准模糊（什么算"明确改动指令"？什么算"明确询问"？）、AI 判得飘忽：

- 用户写「§3 加一行 X」明确改 → AI 大概率直接 edit（OK）
- 用户写「我觉得 §3 怪怪的」隐含改 → AI 可能弹 ask_user（OK）、也可能闷头改（炸）、也可能在事件流答疑（炸）
- 用户写「为什么这里这么写」纯疑问 → AI 大概率事件流答（OK）、偶尔弹 ask_user 复述（绕）

**用户体验**：每次再聊聊都是抽奖、不可预期。

**V0.5.10 设计**（用户拍板「二分类铁则、用户能预测 AI 行为」）：

```
按 feedback 是否纯疑问句、铁则 2 分类：

- 问类（纯疑问句、不含改动暗示）
  字面含「为什么 / 怎么 / 是不是 / 能否 / 为啥 / 是什么 / 干嘛 / 如何 /
       哪里 / 哪个 / 吗 / 呢 / ?」等疑问标记
  且 不含 改动暗示（无「改 / 删 / 加 / 调整 / 不对 / 怪怪的 / 再补 /
       详细点 / 优化」等动词或暗示）
  → 直接 emit assistant_message 答疑、不弹窗、不动 artifact

- 改类（其他所有 feedback、含模糊 / 兜底）
  含明确改动指令 / 含改动暗示 / 模糊看不懂
  → 先弹 ask_user 复述意图（固定模板「我打算 X、对吗?」、二选一 ✅/❌）
    用户 ✅ → 用 edit 改 artifact、按 _shared §5 留修改记录
    用户 ❌ 重说 → 当新一轮 revise feedback、重新走分类
    用户 deferred → 跳过本轮（不重问）
```

**判定护栏**（兜底偏改类）：判不准就当改类、走弹窗——错弹窗成本 1 click + 重说一句、错答疑成本「用户得再点再聊聊 + 重写指令」、明显改类更便宜。

**讨论过程的关键迭代**（用户多次拍板）：

1. **第一稿**：A 永远弹 ask_user 复述（含答疑场景也弹）。用户质疑「如果是事件流里在回答、突然弹个窗、不是打断用户行为吗」——撤回
2. **第二稿**：「动词白名单 → 改类、其他 → 问类」。用户质疑「我不一定非是动词啊、提示词是不是太刻板了」——撤回
3. **第三稿（落地）**：「疑问句白名单 → 问类、其他 → 改类（兜底偏改）」。判定标准是「疑问标记 + 无改动暗示」、改用「疑问标记」白名单替代「动词」白名单、覆盖更准（动词可能没出现、但疑问标记几乎稳定）

**用户的额外担心**：「prompt 是最不可控的、写不好总能带来些预期外的问题」。

针对性降风险动作（蓝军自检）：

- ✅ deferred 路径保留（用户点「稍后再补充」→ 跳过本轮、不重问）
- ✅ 带图先 read 保留（V0.5.4 治过、[ATTACHED_IMAGES] 必须先 read 转 vision 再分类）
- ✅ ask_user 说人话 / 禁公文体保留（V0.5.5 治过、禁词黑名单「[PHASE_ACK revise] / 反馈过短 / 无具体改进意图 / 待澄清」）
- ✅ 严禁趁机优化保留（问类不能偷偷动 artifact）
- ✅ ask_user options 用 `对` / `重说` 中文 id（不冲突 ask-user-dialog 字母前缀 A/B、它们是 letter prefix 不是 id）
- ✅ phase-1 §5.1（ask_user reply 分级）跟 §3（revise feedback 分类）拆开——之前 prompt 写「跟 §3 用同一套」是错引用、两个场景的「分级」根本不是同一回事

**改动文件**（共 6 处）：

- `src/lib/server/plan-runner.ts:402-456` super-prompt §3 revise 解读段（核心、~55 行重写）
- `src/lib/server/plan-runner.ts:L340 / L484` shell stdout 行解释 / §6 闭环段（同步换 2 分类描述）
- `src/lib/server/chat-mcp.ts:L84-86 / L543` 注释 + stdout 行解释（同步换）
- `prompts/_shared.md:L84` §5 修改记录段开头补「问类不留修改记录、改类才留」
- `prompts/phase-1-plan.md` / `phase-2-build.md` / `phase-3-review.md` 各 1 处 `[PHASE_ACK revise]` 处理段（同步换 2 分类、phrasing 按 phase 微调）
- `prompts/phase-1-plan.md:L141-143` §5.1 删除「跟 §3 revise 解读用同一套」错误引用、明确俩场景拆开
- `src/components/tasks/revise-dialog.tsx:L144-152` placeholder 反映新规则、让用户能预期 AI 行为

##### Resizable 分栏布局（V0.5.10、跟 prompt 改造一并落、用户拍板）

**背景**：「既然事件流要展示内容、那就还得优化优化了、可不可以加一个拖动条、可以拖动事件流模块的宽度」——纯疑问改 event-stream 答疑后、长答案需要更多横向空间、固定 `w-[400px]` 不够用了。

**用户拍板 3 个细节**：
- 默认比例：70 / 30（artifact / event-stream、跟当前接近）
- 边界：左 / 右 minSize 都 20%（双向可拖到极限、maxSize 80）
- 持久化：**存在 task 主体上**（不是 localStorage）——不同 task 可不同布局（调研类 task 偏大 event-stream / 改代码 task 偏大 artifact）

**实现**：

1. 装 `react-resizable-panels@4.11.1`（社区事实标准 5k★、shadcn 也用它、无 base-ui 同类替代）
2. `src/components/ui/resizable.tsx` shadcn-style stub：
   - ⚠️ 4.x API 跟 shadcn 文档（基于 2.x）已经不一样：`Group` / `Panel` / `Separator` 替代 `PanelGroup` / `Panel` / `PanelResizeHandle`、`onLayoutChanged(layout: Record<panelId, flexGrow>)` 替代 `onLayout(sizes: number[])`
   - re-export 三件套、保持 shadcn 命名（ResizablePanelGroup / ResizablePanel / ResizableHandle）方便心智模型一致
3. `Task.uiLayout = { artifactPanelSize?: number }` 加到 `types.ts` + `task-fs.ts` 的 `TaskMeta` + `hydrateTaskSummary`
4. `setTaskUiLayout` 持久化 API（`task-fs.ts`）：
   - 不写事件 / 不动 updatedAt（UI 偏好不算业务进展、避免污染时间线 / 自动归档计时）
   - 内置 [10, 90] clamp（防前端 bug 写出 -1 / 200）
5. `PATCH /api/tasks/[id]` 接 `uiLayout` 字段（返 `{ ok: true }` 不返完整 task、拖动期间高频不需要 round-trip 全量）
6. `task-store.ts` 加 `setTaskUiLayout(id, uiLayout)` client helper
7. `src/app/tasks/[id]/page.tsx` 主区双栏改 `<ResizablePanelGroup>`：
   - `defaultSize` 从 `task.uiLayout.artifactPanelSize` 读、没就 70
   - `onLayoutChanged` 拿 `layout["artifact"]`、debounce 500ms PATCH（双保险——onLayoutChanged 本身只在释放鼠标后触发、debounce 防用户连续点 reset / 快速拖几下也只发最后一次）
   - `key={task.id}`：切 task 时整个 Group 重建、defaultSize 重新生效（4.x 的 defaultSize 只在 mount 时读）
   - `minSize={20}` / `maxSize={80}` 双向约束

**验收点（用户实测）**：

1. 进 task 详情页、看到分栏中间有 1px 灰色 handle、hover 变主色 + 显示中间 grip 图标
2. 拖手柄、左右栏宽度实时变、释放后 500ms 内后端 meta.json 出现 `uiLayout.artifactPanelSize: <number>`
3. 刷新页面、布局保留
4. 切到另一个 task、再切回来、布局保留
5. 不同 task 之间布局独立、切换不串扰

##### V0.5.10 改动汇总

- 共 7 个源文件 + 5 个 prompt 文件、`pnpm typecheck` ✓ / `pnpm lint` ✓
- prompt 改动核心：plan-runner.ts super-prompt §3 + 4 个 prompt md 文件
- layout 改动核心：types.ts + task-fs.ts + route.ts + task-store.ts + page.tsx + ui/resizable.tsx + 新装 react-resizable-panels@4.11.1

##### ⚠️ 验证 prompt 必须新起 task（V0.5.10 验收踩坑、必记）

**super-prompt 在 `Agent.create()` 时一次性灌进 SDK Agent、之后 Agent.resume 不会重发**（plan-runner.ts L1068-69 注释明确）。

所以：

- **改 plan-runner.ts / \_shared.md / phase-X.md 任何 prompt → 已起的 task 永远拿不到新 prompt**
- 想验证 prompt 改动效果、**必须新建一个 task 从头跑**
- 已 awaiting_ack 的旧 task 点「再聊聊」、走的还是 task 创建时灌进去的旧 prompt——不是 prompt 写错了、是 prompt 根本没注入

**误判反例（V0.5.10 真实踩过）**：
- 23 日早上改完 V0.5.10 prompt、用户在 21 日起的旧 task 上点「再聊聊」、AI 行为还是旧 4 分类——用户以为「prompt 改坏了」、实际是旧 prompt 残留
- 排查 30 分钟才意识到 task createdAt < prompt mtime、是「prompt 没注入」不是「prompt 错」

**给接力 AI**：每次改 super-prompt 后、用户反馈「prompt 不生效」前先问一句「task 是改 prompt 前还是后起的？」、改后起的才有意义。

##### Resizable hot-fix 两轮（V0.5.10、用户实测拖不动当晚修）

**hot-fix 1：视觉/selector 问题**（用户：「拖不动」）

症状：用户拖左右分栏手柄拖不动、看不到明显的「拖动条」。

根因（挖到 react-resizable-panels 4.x library 源码）：

1. **Separator DOM 上没有 `data-orientation` 属性**——只有 `data-separator`（active/focus/inactive/disabled）+ `aria-orientation`（且值跟 Group orientation **相反**：horizontal group → separator aria-orientation=vertical）。我原本写的 `data-[orientation=vertical]:...` selector 全部不命中、纯 vertical group 视觉错乱（项目当前只用 horizontal、未踩到这部分）。
2. **视觉宽度太窄**：原本 1px 实体 + 4px hit region、用户根本看不到「这里能拖」、对不准就拖不动。
3. **`<Group>` 自带 inline style `display:flex; flexDirection:row; width:100%; height:100%; overflow:hidden`**——我原本用 className 包了一层冗余 `flex h-full w-full`、Group 还在源码里明确说「The following styles cannot be overridden: display, flex-direction, flex-wrap, overflow」、所以多余。

修复（`src/components/ui/resizable.tsx`）：

- ResizablePanelGroup 直 re-export `Group`、去掉所有 className（让 Group 自己控样式）
- ResizableHandle separator 视觉宽 → 1.5px、hit region → 2px（after pseudo）、grip 图标 `h-8 w-4` 更醒目
- selector 从 `data-[orientation=...]` 改成 `aria-[orientation=...]`、注意 separator 的 aria-orientation 跟 group orientation 相反
- 用 lib 自带 `data-[separator=active]` / `data-[separator=focus]` 走 state 颜色、删自定义 group/handle CSS group selector
- 加 `cursor-col-resize` / `cursor-row-resize` 明示鼠标态

**hot-fix 2：defaultSize 单位错（核心 bug）**（用户：「hover/active 有反应、但拖不动 panel」）

症状：手柄视觉已明显、hover/active 颜色切换正常、拖动时 separator 跟着鼠标走、**但左右 panel 完全没变化**。

根因：**4.x 的 `defaultSize / minSize / maxSize` 数字默认是 `px`、不是 `%`**！（lib.js:19-21：`case "number": return [e, "px"]`）

- 我原本传 `defaultSize={70} minSize={20} maxSize={80}` → 70px / 20px / 80px
- 在 1200px 视口里、panel 初始 70px、拖动范围 20-80px、相对视口只能动 60px、**用户视觉上几乎看不出变化**
- separator 自己 active 状态正常切换（事件正常）、看着「拖了但 panel 没变」是因为 panel size 已经卡在 maxSize=80px 上动不了

修复（`src/app/tasks/[id]/page.tsx`）：

- 改传字符串 `defaultSize={`${pct}%`} minSize="20%" maxSize="80%"` 显式百分比
- 字符串无单位 → `%`、`"70%"` 也 → `%`（lib.js:23 endsWith "%"）
- onLayoutChanged 拿到 `layout[panelId]` 已经是百分比（0..100、d.ts L43-45 确认）、可直接存 task.uiLayout.artifactPanelSize
- 删了 initialEventStreamSize、直接 inline `${100 - pct}%`、变量名 `artifactSizePercent` 更直观

**沉淀（避坑教训）**：

- ⚠️ react-resizable-panels 4.x 是 lib 4.0.0 breaking change（direction → orientation、PanelResizeHandle → Separator、defaultSize 默认单位 px）、跟 shadcn 文档基于 2.x 已经差太远
- 接入任何「数字尺寸」prop 前、必须查 source 确认默认单位、不能凭直觉
- 这种 bug 单测难发现（数字布局看不出错）、只能跑出来肉眼看「拖不动」

##### UX 精简（V0.5.10、用户实测当晚）

**1. 「再聊聊」placeholder 精简**：

之前 placeholder 写了 4 行「问类 / 改类」二分类规则——用户实测「不需要、系统该简洁」。

改成一行：「想改、想问、或者贴图说明（支持粘贴 / 拖拽）」。

沉淀到 `.cursor/rules/learned-conventions.mdc` 「UI 文案 / placeholder / 提示语简洁原则」段：placeholder 不超过一行、不把产品交互规则写进 placeholder、AI 行为规则在 prompt 里、用户用 1-2 次就懂、不要塞输入框。

**2. revise 复述 ask_user options 简化**：

之前固定模板：
- `id=对`、`label=「✅ 对、按你说的来」`
- `id=重说`、`label=「❌ 不对、我重新说」`

用户实测：「不对、我重新说」选了无法输入、要点确认 → 退出 → 再点「再聊聊」 → 重写——4 步换 1 件事、纯属多余。AskUserDialog UI 自带「自定义回答」就是「不同意 / 想重说」的入口。

改成只留 1 个 option（label 进一步精简到 2 字、用户拍板「同意」最中性通用）：
- `id=同意`、`label=「✅ 同意」`

用户想改 / 重说就走 UI 自带的「自定义回答」textarea。

**3. AskUserDialog「以上都不是 / 自定义回答…」→「自定义回答」**：

文案精简、不要「以上都不是」赘述。

**4. 加严 ask_user prompt 约束**：

`plan-runner.ts ask_user 段` 加一条：「严禁在 options[] 里塞『不对 / 不同意 / 重新说 / ❌』这类否定选项——UI 自带『自定义回答』就是入口、你列了 `id=不对` option 用户点了也无法继续输入、纯属多余」。

之前已经有「严禁塞『其他 / Other / 自定义』」约束、这次补「严禁塞『不对 / 否定』」、收紧死按钮陷阱。

**V0.5.10 待办（接力 AI / 用户实测）**：

1. **revise 二分类规则测**（重点、用户最担心的就是 prompt）：
   - ⚠️ **必须新建一个 task**——旧 task 拿不到新 prompt（见上方「验证 prompt 必须新起 task」段）
   - 新 task 跑到 plan ack、点「再聊聊」、试三种话验证 AI 行为：
     - 明确改：`§5 把 useState 改成 useReducer` → 弹 ask_user 复述意图、user ✅ 后改 artifact
     - 纯疑问：`§5 为什么用 useState 不用 useReducer？` → 直接事件流 emit assistant_message 答疑、不弹窗
     - 模糊：`§5 怪怪的` → 弹 ask_user 复述意图（兜底改类）
   - 看 ask_user options 是否只有 `对` / `重说`、question 是否说人话不带协议名
   - 看带图 case：发图 + 简短文字、AI 是否先 read 图再判分类
   - 看 deferred case：弹 ask_user 后点「稍后再补充」、AI 是否跳过本轮 revise、不重问
2. **resizable 拖动测**（hot-fix 后再测）：
   - 拖手柄、artifact / event-stream 宽度实时变
   - 释放鼠标后 ~500ms 内 `data/tasks/<id>/meta.json` 出现 `uiLayout`
   - 刷新页面、布局保留
   - 切 task / 回 task、布局保留
   - chat 模式没有 resizable（设计如此、chat 模式整页 ChatView、不分栏）


##### 补 V0.5.9：task 仓库字段单值 → 数组、多仓 cwd 走公共父目录（2026-05-22 晚、用户拍板）

**背景 / 触发**：

用户实操中遇到「一个需求涉及两个项目都要改代码」的场景。原架构 `task.repoPath: string` 只接受一个仓库、SDK Run cwd 也只能指向一个目录、跨仓需求只能拆 task 或者手动 cd——不够顺手。

经多轮场景澄清确认：用户的两个项目都在 `~/Documents/wukong/` 下、都要 AI 写代码、对边界 case（跨父目录）不想加严格限制。

**架构方案**：

```
Settings 配多个 repo（已有）→ 新建 task UI 多选 → task.repoPaths: string[]
                                                       ↓
                              getEffectiveCwd(repoPaths)
                              （单仓 = 仓自身、多仓 = 公共父目录）
                                                       ↓
                              SDK Run local.cwd = effective
                                                       ↓
                              AI 视角下面挂 N 个 git 子仓、路径首段是仓名
```

**改动**：

1. **数据层**
   - `src/lib/types.ts`：`Task.repoPath: string` → `Task.repoPaths: string[]`、`NewTaskInput` 同步
   - `src/lib/server/task-fs.ts:TaskMeta`：保留 `repoPath?: string` 字段标 `@deprecated`、`hydrateTaskSummary` 兼容兜底（老 meta 自动包成 `[repoPath]`）、`createTask` 新数据只写 `repoPaths`

2. **路径工具（`src/lib/path-utils.ts` 新加）**
   - `getCommonParentDir(paths)`：算多个绝对路径的最长共同前缀目录、用于 effective cwd
   - `getEffectiveCwd(repoPaths)`：单仓 = 仓自身、多仓 = `getCommonParentDir`
   - `getRepoShortNames(repoPaths, cwd)`：算每个仓相对 cwd 的短名（多仓 prompt 列子目录用）
   - `formatRepoSectionForPrompt(repoPaths)`：渲染 super-prompt「任务输入 - 仓库段」、单仓 / 多仓自动切换文案 + 多仓附路径约束 + git 命令 cd 子仓说明
   - `buildCursorLink` 第二参数从 `repoPath` 重命名为 `baseDir`（语义改为「effective cwd」、单仓 / 多仓通用）

3. **API**
   - `src/app/api/tasks/route.ts:POST`：body schema `repoPath` → `repoPaths`、`sanitizeRepoPaths` 校验非空数组

4. **UI（`src/components/tasks/new-task-dialog.tsx`）**
   - `repoPath: string` state → `repoPaths: string[]` state
   - 单 Select 控件 → 自实现 `RepoMultiSelect` 子组件（基于 base-ui Popover）：trigger 视觉对齐 shadcn Select、点击展开 Popover、内部 checkbox 列表多选
   - trigger 显示：0 个 = 占位文案、1 个 = 仓名 + 路径、多个 = 「已选 N 个 + projA + projB」
   - 多仓选中时 dialog 下方显示「多仓场景：agent cwd = 公共父目录」说明
   - canSubmit 校验 `repoPaths.length > 0`
   - **迭代记录**：第一稿做了 `ChoiceButton shape="card"` 2 列网格、用户实测反馈「仓库多时铺满屏、要 Select 那种紧凑」、当天迭代成 Popover-style multi-select

5. **后端 runner**
   - `plan-runner.ts` / `chat-runner.ts`：SDK Run `local.cwd` 从 `task.repoPath` → `getEffectiveCwd(task.repoPaths)`
   - prompt fillTemplate 的 `{{repoPath}}` 值改为 effective cwd（语义改为「agent cwd」、单仓行为不变）
   - super-prompt「任务输入」段用 `formatRepoSectionForPrompt` 渲染、单仓 = 一行「仓库根目录」、多仓 = 公共父目录 + 子仓清单 + 路径 / git 命令约束
   - `loadSkills` 接 effective cwd（多仓时跨仓 skill 后续真踩到再聚合）

6. **UI 显示层**
   - `src/lib/task-display.ts` 加 `formatRepoPathsForDisplay(paths)`：0 个 = 「(未配置仓库)」、1 个 = 完整路径、多个 = basename 用 ` + ` 拼
   - `task-card.tsx` / `app/tasks/[id]/page.tsx` 头部用这个 helper、hover tooltip 显示完整路径列表
   - `artifact-panel.tsx` prop `repoPath` 重命名 `baseDir`、`page.tsx` 传 `getEffectiveCwd(task.repoPaths)`
   - `event-stream.tsx` 文件选择器 `initialPath` 同步用 effective cwd

7. **prompt（`prompts/_shared.md` 小改）**
   - 顶部占位符注解加 V0.5.9 注：`{{repoPath}}` 语义改为「agent effective cwd」
   - §3 path 完整路径写法：第 1 条「从仓库根 ...」改成「从 agent cwd（即 `{{repoPath}}`）...」、段末加一段「V0.5.9 多仓场景：路径首段必须是子仓目录名」
   - §7 命令 / 端口自检：`{{repoPath}}/package.json` 加多仓注「多仓时读对应子仓 `{{repoPath}}/<repo>/package.json`」
   - **phase-1/2/3 prompt 不动**：super-prompt 顶部「任务输入」段已经按单 / 多仓自动渲染、AI 看上下文自然知道仓库结构；遵循「新约束 ≤ 3 行写完」原则、不大改 phase prompt 字眼

**收益**：

- 用户一个 task 能覆盖跨仓需求、不用拆 task / 不用手动 cd
- 单仓行为完全兼容（getEffectiveCwd 返仓自身、prompt 文本「仓库根」字眼仍然准确）
- 多仓时 AI 在公共父目录工作、写 `projA/path/...` 形式的路径、cursor link 自动拼回绝对路径、点击跳转 OK
- 老任务自动兼容（`hydrateTaskSummary` 把 `repoPath` 包成 `[repoPath]`、不删旧数据）

**边界**：

- **跨父目录多仓**（如 `~/Documents/A` + `~/Other/B`）：commonParent 算到 `~` 或更上、SDK cwd 设到这种宽目录、AI 多 read 几层才能看到仓——按用户拍板**走宽松**、不报错（V0.5.9 不做边界检查）
- **多仓 git 命令**：`{{repoPath}}` 是父目录、不在 git 仓库里、AI 跑 `git diff` 必报错——prompt 里 super-prompt 顶部「任务输入」段明确说「git 命令必须 cd 到对应子仓」、AI 看到这段自然遵守
- **多仓 skill**：当前 `loadSkills(cwd)` 只扫一个目录、多仓时只看公共父目录的 `.cursor/skills`——子仓里的 skill 暂时看不到、不阻塞使用（ai-flow 内置 skill 走绝对路径加载、不依赖 cwd）

**总改动**：

- `src/lib/types.ts` / `src/lib/path-utils.ts` / `src/lib/task-display.ts` / `src/lib/server/task-fs.ts` / `src/lib/server/plan-runner.ts` / `src/lib/server/chat-runner.ts`
- `src/app/api/tasks/route.ts` / `src/app/tasks/[id]/page.tsx`
- `src/components/tasks/new-task-dialog.tsx` / `src/components/tasks/artifact-panel.tsx` / `src/components/tasks/task-card.tsx` / `src/components/tasks/event-stream.tsx`
- `prompts/_shared.md`
- 共 ~13 个源文件 + 1 个 prompt 文件、`pnpm typecheck` ✓ / `pnpm lint` ✓

##### V0.5.9 hot-fix（用户实测、当天迭代）

1. **UI 第一稿 card grid 改成 Popover multi-select**：用户反馈「仓库多时铺一大片占空间、要 Select 那种紧凑」——当天换成 base-ui Popover + checkbox 列表、trigger 视觉对齐 shadcn SelectTrigger。

2. **`MultiSelect` 抽到 `src/components/ui/multi-select.tsx`**：用户拍板「典型组件就该抽出来、不要刻板的遵守『复用 ≥ 2 才抽』规则」、当天 generic over `T`、render props API（`getKey` / `renderOption` / `renderTrigger` / `placeholder`）。`new-task-dialog.tsx` 删内部 `RepoMultiSelect`、inline 调用通用版。已写进 `learned-conventions.mdc` 抽象门槛例外段。

3. **Dialog 内长内容溢出 fix**（用户实测踩到、附截图）：上下文文档列表里贴超长 chat 文本时、预览那一行撑破 dialog 右边界、textarea 粘日志也被撑宽。三层根因 + 三层修法（一次到位）：
   - **DialogContent 是 grid、grid item 默认 `min-width: auto` 跟内容撑**：`src/components/ui/dialog.tsx` DialogContent className 加 `*:min-w-0`（Tailwind 4 短写、等价 `[&>*]:min-w-0`）——所有 grid item 自动获得 min-w-0、被 max-w-lg 真正 cap 住。**所有 dialog 调用方自动受益、不用单独加**。
   - **`truncate` 在 flex item 上失效**：`context-docs-panel.tsx` 的 truncate span 加 `min-w-0`（dialog 兜底只覆盖第一层 grid item、嵌套 flex 的 truncate 还要自己加）。
   - **Textarea `field-sizing: content` 撑破父**：`src/components/ui/textarea.tsx` 加 `min-w-0 max-w-full wrap-anywhere`。所有 textarea 调用方自动受益。
   - 同步写进 `learned-conventions.mdc` 「Dialog 内长内容溢出」段、避免下次再踩。第一稿只 fix 后两条、用户实测仍然撑破、追加第一条 dialog 层兜底才彻底解决。

**V0.5.9 待办（接力 AI / 用户实测）**：

1. **多选 UI 测**：新建任务 dialog 仓库段、点 trigger 展开 Popover、点 2 个仓库都能选中、再点取消、trigger 显示「已选 N 个 + projA + projB」
2. **多仓 SDK Run cwd 测**：起一个多仓 task、看 plan-runner 日志里 `Agent.create({ local: { cwd: <commonParent> } })`、cwd 是公共父目录、不是其中某个仓
3. **多仓路径首段仓名测**：跑 plan + build、看 artifact 里 AI 写的文件路径是不是 `<repo>/<rest>` 形式（不是直接 `<rest>` 漏了仓名前缀）、点击能跳 Cursor 打开
4. **多仓 git 命令测**：跑 build / review、看 AI 跑 `git diff` 时是否先 `cd <repo>` 再跑（不是在父目录直接跑 git 报错）
5. **老任务 hydrate 测**：用户之前的单仓 task 详情页应该正常显示、不报「repoPath undefined」
6. **跨父目录多仓 case**：用户主动选 2 个不在同一父目录的仓、看 commonParent 是不是算到 `/` 或 `~`、SDK Run 是否能起（按设计宽松）

##### 补 V0.5.8：artifact 间引用走前端 tab 切换（2026-05-22、上述方案 B 落地）

**背景 / 触发**：

V0.5.7.7 hot-fix 段遗留候选——三 phase prompt 里有约 66 处「01-plan.md」「02-build.md」「03-review.md」裸文件名引用、`looksLikePath`（`src/lib/path-utils.ts`）要求路径含 `/` 才算 path、artifact 渲染时这些文件名只是普通 inline code、点不开。

选方案 B（前端识别 + tab 切换）、不动 prompt——prompt 保持简洁、AI 继续写「01-plan.md §4」就好、渲染层接管识别 + 切 tab。

**改动**：

1. `src/lib/path-utils.ts` 加 `looksLikeArtifactRef(s)`：
   - 正则 `^\d{2}-([a-z]+)\.md$`、匹配后用 `PHASE_IDS`（`src/lib/types.ts`）校验 phaseId 合法性
   - 返 `PhaseId`（让调用方按 phaseId 切 tab）、不返序号——序号会随 workflow 增删 phase 漂移、phaseId 是稳态锚点
   - 长度 cap 50、避免误判超长代码片段
2. `src/components/tasks/artifact-panel.tsx`：
   - `Props` 加可选 `onArtifactRefClick?: (phaseId: PhaseId) => void`
   - `buildMarkdownComponents` 接收同名参数、`code` 渲染时**优先** `looksLikeArtifactRef`、命中 + 回调存在 → 渲染成可点 `<button>`（蓝色 + hover 下划线、跟 cursor:// 链接视觉同款）、`onClick` 调回调
   - 不命中再走原 `looksLikePath` 分支（保留 cursor:// deep link 跳转）
3. `src/app/tasks/[id]/page.tsx`：`<ArtifactPanel onArtifactRefClick={setActivePhase} />` 一行接通

**收益**：

- 用户看 review artifact 里写「详见 `01-plan.md` §4」直接点过去、跳到同 task 的 plan tab、不需要手动切顶部 phase 切换条
- prompt 维持简洁（不引入 `data/tasks/{{taskId}}/artifacts/` 这种又长又丑的路径）、AI 写起来心智负担不变
- 实现成本低（path-utils +30 行 helper / artifact-panel +15 行渲染分支 / page +1 行 prop 传递）、风险窄
- 跟现有 `looksLikePath` + cursor:// 跳转互补——一个识别同 task 内 artifact、一个识别仓库内文件路径、各管一段、不冲突

**边界**：

- 切到 `pending` 状态的 phase tab（例如在 build artifact 里点 `03-review.md`、但 review 还没跑）→ `ArtifactPanel` 已有「该 phase 还未启动」占位、自动兜底、无需特殊处理
- 没传 `onArtifactRefClick` 的纯展示场景 → artifact ref 退化成普通 inline code、不可点、不报错
- 未来 workflow 加新 phase（如 `deploy`）→ 只需要 `PHASE_IDS` 加一项、`looksLikeArtifactRef` 自动识别、无需改 `path-utils` 正则

**单文件改动**：`src/lib/path-utils.ts` + `src/components/tasks/artifact-panel.tsx` + `src/app/tasks/[id]/page.tsx` + `docs/HANDOFF.md`、`pnpm typecheck` ✓ / `pnpm lint` ✓。

**V0.5.8 待办（接力 AI / 用户实测）**：

1. **可点测**：起 task 跑完 review、看 review artifact 里 `01-plan.md` / `02-build.md` 引用是否渲染成蓝色按钮、点击切到对应 tab
2. **样式校验**：button hover 是否带下划线、跟 cursor:// 路径链接视觉同款
3. **prompt 里漏 backtick 的 case**：如果 prompt 写 `01-plan.md`（无反引号）、不会被 react-markdown 当 inline code 渲染、识别不到——`grep '0[123]-(plan|build|review)\.md' prompts/` 看是否所有引用都加了反引号、没加的补一下


### V0.5.7：统一推进入口（合并继续监听 + 重启 workflow、解 ENHANCE_YOUR_CALM 死局、2026-05-20 中午）

V0.5.6.5 跑下一份 plan 时、用户在 build phase 后 wait-ack 长连接断、点「继续监听」→ Cursor backend 返 `NGHTTP2_ENHANCE_YOUR_CALM`（HTTP/2 错误码 0xb、服务端要求降速、典型场景是 agent 在 backend 已被清理）。`/resume-waiting` 路由抛 `agent run status=error`、task=failed。

**死局**：之前的 UI 只有两个按钮 ——「继续监听」（Agent.resume）和「重启 workflow」（Agent.create 从 plan 头）。resume 路径死、剩下唯一可走的「重启 workflow」会从 plan 重头跑、**已经写完的 plan / build artifact 被覆盖**——用户原话「重启只能从第一步开始」。

#### 1. 用户拍板：方案 D（一按钮 + 智能 dialog）

| 旧 | 新（V0.5.7） |
|---|---|
| 两个按钮：「继续监听」+ 「重启 workflow」（用户视角技术细节） | 一个按钮：「推进」、打开 AdvanceDialog 让用户选 mode |
| 「重启 workflow」固定从 plan 头 | dialog 内三选项：resume / fork from phase / restart from plan |
| `/resume-waiting` 独立路由 | 合并到 `/start-workflow`（body 加 `mode + fromPhase`、向后兼容 mode 缺省 = restart） |
| resume 失败抛错、task=failed、用户手动 | plan-runner catch 块检测 `NGHTTP2_ENHANCE_YOUR_CALM` / `Stream closed`、自动降级 fork（fromPhase=currentPhase）、用户视角一次推进就能续走 |

#### 2. 三种推进模式（mode）

| mode | 后端动作 | 适用场景 | 成本 |
|---|---|---|---|
| `resume` | `Agent.resume(lastAgentId)` + send 续接 prompt、保留对话历史 | wait-ack 长连接刚断、agent 在 backend 仍活着 | +1 send 配额 |
| `fork` | `Agent.create` 新 agent + super-prompt 顶部 fork banner、从 `fromPhase` 起跑、上游 artifact 复用 | 原 agent 已死、想从指定 phase 续走（默认 = 下一未 ack）/ 测试新模型 | +1 send 配额 |
| `restart` | `Agent.create` 新 agent 从 plan 完全重跑、**覆盖现有 artifact** | 改 prompt 大改动后想看一遍纯净重跑 | +1 send 配额 |

#### 3. resume 自动降级 fork（plan-runner catch 块）

```ts
// plan-runner.ts catch 块
const isEnhanceYourCalm = message.includes("NGHTTP2_ENHANCE_YOUR_CALM") ||
                          causeMessage.includes("NGHTTP2_ENHANCE_YOUR_CALM");
const isStreamClosed = causeMessage.includes("Stream closed") ||
                       causeMessage.includes("ERR_HTTP2_STREAM_ERROR");
const shouldFallbackFork = isResume && (isEnhanceYourCalm || isStreamClosed);

if (shouldFallbackFork) {
  // 不写 task=failed、不发 done 事件——保 SSE 流开着
  await writeEventAndPublish(task.id, {
    kind: "info",
    text: "原 agent 在 Cursor backend 已被清理（NGHTTP2_ENHANCE_YOUR_CALM）\n自动降级为「起新 agent 从当前 phase 接力」",
  });
  fallbackFork = { fromPhase: task.currentPhase };
}
// finally 块末尾 setTimeout 0 → runPlanWorkflow({ fork: { fromPhase } })
```

#### 4. 改动文件清单

| 文件 | 改动 |
|---|---|
| `src/app/api/tasks/[id]/start-workflow/route.ts` | 重写。body 加 `mode + fromPhase` 入参、内部按 mode 分发：resume → 拼 resumePrompt + Agent.resume；fork → runPlanWorkflow({ fork })；restart → 老路径。`mode=resume` 缺 lastAgentId 时自动降级 fork（fromPhase=currentPhase）；**isPlanRunning + task.status 是终态（draft/failed/completed）→ stale state、调 `forceClearStaleRunnerState` 自愈**（避免「点启动按钮无反应」） |
| `src/app/api/tasks/[id]/resume-waiting/route.ts` | **删**（V0.5.7 合并到 /start-workflow） |
| `src/lib/server/plan-runner.ts` | catch 块加 ENHANCE_YOUR_CALM / Stream closed 检测、isResume 命中时不写 failed 改写 info 提示降级、finally 末尾 setTimeout 0 调度 runPlanWorkflow({ fork })；fallbackFork 局部 state；**新加 export `forceClearStaleRunnerState(taskId)`**：暴力 delete runningPlans + forkPendingTasks entry、给 start-workflow 路由清 stale in-memory state 用；注释里 /resume-waiting 字样同步刷成 /start-workflow（mode=resume）；早退提示文案「重启 workflow」改「推进」 |
| `src/lib/task-store.ts` | startWorkflow 加 options（mode + fromPhase）参数；删 resumeWaiting；新加 `StartWorkflowMode` 类型 export |
| `src/components/tasks/advance-dialog.tsx` | **新建**。3 个 ChoiceButton（resume / fork / restart）+ fork 选项内嵌 phase chip 切换；默认值智能：resume 可用且非 draft → 默认 resume；其它 → fork；fromPhase 默认 = inferNextUnackedPhase(task) |
| `src/app/tasks/[id]/page.tsx` | 删「继续监听」按钮 + handleResumeWaiting + canResume + startLabel；加 advanceDialogOpen state + handleAdvance(mode, fromPhase) + handleAdvanceClick（draft 直接 restart、其它弹 dialog）；JSX 末尾挂 `<AdvanceDialog />`；删 useDialog import（不再用 confirm） |
| `src/lib/types.ts` | 加 `PHASE_IDS` 运行时数组（给 fromPhase 校验用）；lastAgentId 注释刷成「/start-workflow（V0.5.7 mode=resume）」 |
| 注释扫尾 | `src/lib/server/chat-mcp.ts` + `src/hooks/use-task-watch.ts` + `src/lib/server/task-fs.ts` + `src/app/api/tasks/[id]/wait-ack/route.ts` 4 个文件 6 处「/resume-waiting」 / 「继续监听」 / 「重启 workflow」字样同步刷 |

`pnpm typecheck` ✓ / `pnpm lint` ✓ 双绿。

#### 5. UX 流程对照（用户视角）

**旧 V0.5.6.x（用户原话「重启只能从第一步开始」）**：
```
wait-ack 断 → task=failed → 看到「继续监听」+ 「重启 workflow」两个按钮
  ├ 点「继续监听」→ resume → backend 拒 → 死局
  └ 点「重启 workflow」→ 从 plan 重跑 → 覆盖现有 artifact
```

**新 V0.5.7**：
```
wait-ack 断 → task=failed → 看到一个「推进」按钮
  └ 点「推进」→ AdvanceDialog 三选一：
       (•) 让原 agent 继续推进（默认、推荐）
            └ 后端 resume；失败 → 自动降级 fork(fromPhase=当前 phase)
       ( ) 从指定 phase 重启
            └ phase chip 切换（默认 = 下一未 ack）、上游 artifact 复用
       ( ) 从头完全重跑（覆盖现有 artifact）
```

##### 补丁：fork 时 reset 下游 phase（V0.5.7、2026-05-20 下午）

**bug**：fork 到 build 重启后、UI 上 review 还是「待确认」——因为 fork 路径只 patch `fromPhase` 自身、没碰下游 phase、`review` 上一轮 agent 留下的 `awaiting_ack` 状态没被清掉。

**修**：`plan-runner.ts` 的 `isFork` 分支里、在 patch `fromPhase` 为 running **之前**、先把 `fromPhase` 之后的所有 phase 全部 reset 为 pending：

```ts
const fromIdx = workflowDef.phases.indexOf(fork!.fromPhase);
const downstreamPhases = workflowDef.phases.slice(fromIdx + 1);
for (const pid of downstreamPhases) {
  await patchPhase(task.id, { phaseId: pid, status: "pending" });
}
```

这样 fork build 后 UI 显示 plan=ack / build=running / review=pending、跟实际进度对齐。

##### 补丁 V0.5.7.1：fork reason textarea + fix mode 提示（2026-05-20 下午）

**问题**（用户提）：方案再细、build 总会有 bug；fork 「从 build 重启」时、上一轮代码已经在仓库 / 上一轮 02-build.md 已经在硬盘、AI 会不会傻乎乎 **rewrite** 已有产物？

**当前实现现状**：
- forkBanner 只说「**上游 phase** 的 artifact 别重做」、**没说当前 phase 也可能有上一轮产物、要当成 fix 模式增量改**
- `fork.reason` 字段在路由里写死「用户主动 fork 从 phase X 重启」、用户根本没机会写具体「修什么 bug」

**改进（V0.5.7.1）**：

1. **AdvanceDialog 的 fork 选项加 textarea**：用户选「从某 phase 重启」时下面出一个 textarea「这次主要想修什么？（bug 描述、可留空、AI 会自己看 git diff）」
   - 用户填了 → 透传到后端、forkBanner 拼上「**本次 reason（用户描述要修的点）：xxx**」
   - 用户留空 → 默认 reason「用户主动 fork 从 phase X 重启」（兼容老路径）

2. **forkBanner 加 fix mode 判定段**：让 AI 自己 read 一下「当前 phase 的 artifact 路径」、然后按条件分支：
   - **如果 artifact 存在且非空** → fix 模式、read 旧 artifact + 跑 git diff（build 特别提醒）、**不要 rewrite、按 reason 增量改、用 `edit` 而非 `write`**
   - **如果 artifact 不存在** → 上一轮没跑到、按 phase 指令正常做

3. **数据流**：
   ```
   AdvanceDialog (用户填 reason) →
     task-store.startWorkflow({ reason }) →
       /api/tasks/[id]/start-workflow (body.reason) →
         runPlanWorkflow({ fork: { fromPhase, reason: "用户主动 fork 从 X 重启、想修：<用户填的>" } }) →
           buildSuperPrompt → forkBanner 拼到 super-prompt 顶部
   ```

4. **理想工作流（用户跑出 bug 后）**：
   ```
   跑代码 → 发现 bug A B C → 回 task 详情点「推进」→
     dialog 选「从 build 重启」+ textarea 填 "A B C" →
   AI fork build 起、read 旧 02-build.md + 跑 git diff、按 A B C 定向 edit、不 rewrite →
   ack → 再跑 verify → 还有 bug 继续 fork、直到干净 → ack 进 review
   ```

**关键代码改动**：
- `src/lib/task-store.ts` `StartWorkflowOptions` 加 `reason?: string`
- `src/app/api/tasks/[id]/start-workflow/route.ts` `PostBody.reason`、fork 分支拼 `finalReason`
- `src/components/tasks/advance-dialog.tsx` fork 选项展开后追加 `<Textarea>` + `onSubmit` 增加 `reason` 参数
- `src/app/tasks/[id]/page.tsx` `handleAdvance` 增加 `reason` 参数、透传给 `startWorkflow`
- `src/lib/server/plan-runner.ts` forkBanner 增加「关于本次 \`${fromPhase}\` phase（fix 模式判定）」段、build 特别提示跑 git diff、按 reason 是否填了分两种引导措辞

##### 补丁 V0.5.7.2：修改记录段 + 禁用内部技术词 + Task 完成情况同名段修正（2026-05-21 下午）

**问题**（用户提）：用户跑 V0.5.7.1 fix mode 联测、看到 AI 修完 bug 后在 `02-build.md` 顶部自行加了一段 `## Fork 修复（build phase 重启）`、底下挂多条 `revise: <标题>` + 「改动 / 内容」自由格式。用户原话：

> 「Fork 修复这个是什么意思、没太懂。可以去掉。其它的按你想得来吧、规范下。保证规范、简洁」

**根因分析**：

| 层 | 现状 | 问题 |
|---|---|---|
| `prompts/phase-2-build.md:113` | 只写「改完更新 02-build.md」、没规定写在哪、什么格式 | AI 自由发挥成顶置 `## Fork 修复` + `revise: xxx` |
| `prompts/phase-2-build.md` 骨架 | 没预留「fix log 段」 | AI 自己造段名 |
| `src/lib/server/plan-runner.ts` fix mode 第 5 条 | 「edit 而非 write、追加 / 修正局部」泛泛、没指明追加到哪 | AI 顶置造段 |
| 用户视角 | artifact 出现「Fork」「revise」等内部技术词、看不懂 | artifact 是给用户和 review agent 看的、不该有内部黑话 |

**额外发现**：`phase-2-build.md` 骨架里 line 129 和 line 170 都叫 `## Task 完成情况`、是 V0.5.5 删除「验收对照」表时遗留的重名 bug——line 170 实际语义是「验收对照」表、本次顺手修正。

**修法**：

1. **`prompts/phase-2-build.md` 骨架加 `## 修改记录` 段**（位置：`## 验收对照` 之后、`## 给用户的交接` 之前）：
   - 只有用户反馈触发修正才写本段、初次 happy path build 不写（整段省略）
   - 用「### 修改 N」三级标题 + 三字段（用户反馈 / 改动文件 / 概要）
   - ⛔ 严禁新建顶层标题（「## Fork 修复」「## Revise」「## 重启修复」等）
   - ⛔ 严禁出现「fork」「revise」「再聊聊」等内部技术词
   - ⛔ 严禁复述「Task 完成情况」「改动文件清单」段
2. **`prompts/phase-2-build.md` line 113 revise 处理段**改成显式指明「A 路径改完代码后用 edit 把本轮修正追加到 02-build.md 的 ## 修改记录 段末尾、按骨架格式」
3. **`src/lib/server/plan-runner.ts` fix mode 第 5 条按 phase 分流**：
   - `build` → 追加到 `## 修改记录` 段末尾、明示 3 禁
   - `plan` → 内联 `> ✅ 已确认：xxx` 留痕（参考 phase-1-plan §1 顶部规则）
   - `review` → 追加到 `## 修改记录` 段末尾（V0.5.7.4 统一规则、跟 build 同套）
   - 拆出第 6 条「写完调用 wait_for_user 让用户验收」、独立步骤更清晰
4. **`prompts/phase-2-build.md` line 170 `## Task 完成情况` 改成 `## 验收对照`**——修正 V0.5.5 删表时遗留的同名段 bug

**改动文件清单**（3 文件、净 +35/-7 行）：

| 文件 | 改动 |
|---|---|
| `prompts/phase-2-build.md` | 骨架加 `## 修改记录` 段 + 4 条禁律；line 113 revise 处理改成显式指向 ## 修改记录；line 170 `## Task 完成情况` → `## 验收对照` |
| `src/lib/server/plan-runner.ts` | forkBanner fix mode 第 5 条按 phase 分流、build 明示 ## 修改记录 + 3 禁、plan/review 内联留痕；拆出第 6 条 wait_for_user |
| `docs/HANDOFF.md` | 加本节 |

`pnpm typecheck` ✓ / `pnpm lint` ✓ 双绿。

**关键决策记录**：

| 决策点 | 用户拍板 | 备选 / 否决理由 |
|---|---|---|
| fix log 写不写 artifact | **写**（保留 V0.5.7.1 设计） | 否决「只动代码不写 log、靠 git log/diff 留痕」——artifact 是 review agent 读 build 的唯一入口、fix 不留痕 review 看不到上下文 |
| fix log 段位置 | **artifact 末尾** | 否决顶置——artifact 主体是「本次 build 报告」、fix log 是次要历史、不该挤掉主体 |
| 段名 | **「修改记录」**（中文、无技术词、用户拍板） | 否决「Fix 历史」「Revise 历史」「调整记录」——artifact 给用户读、不出现技术词；「修改」比「调整」更直白 |
| 一致性范围 | **plan / build / review 三 phase 都改**（fix mode 提示按 phase 分流） | 否决「只改 build」——三 phase 都可能 fork 修复、都需要规范、但段名只 build 强制（plan / review 用既有内联机制） |

**V0.5.7.2 待办（用户测试）**：

- **build 修改记录段格式测**：跑一道 task 到 build ack、点「再聊聊」反馈一个 bug、看 AI 是否：
  1. 不再造「## Fork 修复」顶层标题
  2. 把修正追加到 `## 修改记录` 段末尾、用「### 修改 1」三级标题
  3. 三字段（用户反馈 / 改动文件 / 概要）齐全
  4. artifact 里不出现「fork」「revise」「再聊聊」字样
  5. **不在 task 子条里塞「revise / 修复」子字段**（V0.5.7.3 补、`## Task 完成情况` 顶部加约束）
- **fork build 重启同测**：从 build 重启 + textarea 填 reason、看 AI 写「修改记录」格式是否一致（不是另起一段「## 重启修复」）

##### 补 V0.5.7.3：Task 完成情况字段禁塞 revise 子字段（2026-05-21 下午、V0.5.7.2 联测时补）

V0.5.7.2 改完用户跑了一道 task、回看 02-build.md 发现 fix log 被 AI 拆成两处写：
- 顶部「## Fork 修复（build phase 重启）」段下 10+ 条 `### revise:`（V0.5.7.2 已修）
- `## Task 完成情况` 段下 Task 1 / Task 4 子条**字段里又塞了一行「**revise 修复**：xxx」/ 14 条 `revise:`**（V0.5.7.2 没覆盖）

**根因**：V0.5.7.2 只在 `## 修改记录` 段说「不要复述已有内容」、但没在反向（`## Task 完成情况` 段）说「你这段不准接 revise 子字段」——AI 看 `## Task 完成情况` 字段宽松、把 fix log 当 task 子内容追加进去了。

**修法**：`prompts/phase-2-build.md` 02-build.md 骨架里 `## Task 完成情况` 顶部加一段：

```markdown
> 本段仅记 task 初稿做的事（4 个字段：改动文件 / 关键实现 / 偏离 plan / 局部校验）。
> ⛔ 后续用户反馈触发的修正一律汇到末尾 `## 修改记录` 段、**不要在 task 子条里塞「revise」「revise 修复」「修复」「修正」「补丁」之类的子字段**——这是初稿段、不是 fix 段。
> 反例：「### Task 4：xxx」下面加一行「**revise 修复**：xxx」——禁止；该信息挪到 `## 修改记录` 段下「### 修改 N」三级标题里。
```

**单文件改动**：仅 `prompts/phase-2-build.md`、`pnpm typecheck` ✓ / `pnpm lint` ✓。
- **plan / review fix mode 内联测**：分别从 plan / review fork 重启、看 AI 是否用 `> ✅ 已确认：xxx` 内联、不新建顶层标题
- **同名段修正测**：起新 task 跑完 build、看 02-build.md 顶部是不是「## 验收对照」（不再是「## Task 完成情况」重名）

##### 补 V0.5.7.4：review artifact 风格对齐 plan / build（2026-05-21 下午、用户实测复核交付后提的）

V0.5.7.2 / V0.5.7.3 把 build 段 fix log 规范化后、用户跑了一道 task 到 review、生成出 03-review.md、当面反馈「**这跟 01-plan.md / 02-build.md 格格不入**」。具体观感问题：

- 标题写「`# Review · <story title>`」——中英混排「Review」、跟 plan「`# 方案：xxx`」/ build「`# 实施日志：xxx`」（中文冒号开头）不齐
- 段落编号「`## 一、整体一致性总评` / `## 二、差异分类对照` / `## 三、跟飞书需求对照` / `## 四、交付信息`」——plan / build 都没用中文数字 + 顿号、看起来像两份文档
- 「二、差异分类对照」下挂 4 个 `### 2.1` / `### 2.2` / `### 2.3` / `### 2.4`、外层多一层抽象——plan / build 都是扁平 `##` 直接出顶层段
- fix log 留痕规则跟 build 不一致——V0.5.7.2 给 build 加了 `## 修改记录` 段、review 还在用「`## 二、差异分类对照` 内联 patch + `> ✅ 已确认：xxx`」、两套规则、回看时混乱
- artifact 开头如果带 frontmatter / yaml 头（V0.5.5 起 plan / build 都不带），review 没明文禁、AI 可能补加

**修法**：`prompts/phase-3-review.md` 骨架 + 引用整段重写、`src/lib/server/plan-runner.ts` review fix 提示对齐。

骨架变动总览：

| 段 | V0.5.7.3 之前 | V0.5.7.4 之后 |
|---|---|---|
| 主标题 | `# Review · <story title>` | `# 复核交付：<story title>` |
| 整体一致性 | `## 一、整体一致性总评` | `## 总评` |
| 差异 4 大类 | `## 二、差异分类对照` > `### 2.1/2.2/2.3/2.4` | 拍扁为 4 个独立顶层段：`## 范围扩张` / `## 范围收缩` / `## 实现偏差`（含 `### 偏差 N`）/ `## 未完成` |
| 飞书对照 | `## 三、跟飞书需求对照` | `## 跟飞书需求对照` |
| 交付信息 | `## 四、交付信息（用户复制走）` > `### 4.1/4.2/4.3/4.4` | `## 交付信息（用户复制走）` > `### Commit message 草稿` / `### PR title + body 草稿` / `### 飞书评论草稿（给 PM / 测试看）` / `### 自测 checklist`（无序号） |
| 修改记录 | 无、fix log 内联在「二、差异分类对照」 | **新增 `## 修改记录` 段**、跟 build 同套规则（`### 修改 N` + 「用户反馈 / 影响位置 / 概要」三字段） |
| 约束 | 没明文禁 frontmatter | **新加「严禁写 frontmatter / yaml 头」约束**（§5 严格约束） |

prompt 引用调整：

- 执行步骤标号 §1 ~ §5 全部刷新、跟新骨架对齐
- 「§5 产出交付信息」下子段 §5.1 ~ §5.4 保留、对应骨架里 4 个 `###` 段
- fix mode revise 处理（line 200）：从「内联在『二、差异分类对照』对应分类下」→「**用 `edit` 把本轮修正追加到 03-review.md 的 `## 修改记录` 段末尾**、按骨架「### 修改 N」+ 三字段」
- 「几条要点」段 7 条要点全部刷新引用（如「§4 交付信息」→「交付信息」段；「五、用户决策项」之类历史残留也清掉）

`plan-runner.ts` 同步改动（V0.5.7.2 改过一版「review 分支用内联留痕」、V0.5.7.4 改成「跟 build 同套、追加到 `## 修改记录`」）：

```ts
fork.fromPhase === "review"
  ? `  5. 改完代码 / 描述后**用 \`edit\` 把本轮修正追加到 03-review.md 的 \`## 修改记录\` 段末尾**（按 phase-3-review 骨架里「### 修改 N」三级标题 + 「用户反馈 / 影响位置 / 概要」三字段格式）。\n     ⛔ **严禁新建顶层标题**（如「## Fork 修复」「## Revise」「## 重启修复」），所有 fix log 都汇聚在 \`## 修改记录\` 段下、不要散在「实现偏差」「未完成」等正文章节里。\n     ⛔ **严禁在 artifact 里出现「fork」「revise」「再聊聊」等内部技术词**——artifact 是给用户看的、用「用户反馈」「本次修改」等中文表述。`
```

附带小修：

- 骨架里 commit msg 草稿那段 ` ``` ` 之前是裸三反引号、嵌套在外层 ` ```markdown ` 块里、markdown 渲染会撞、已转义为 `\`\`\``（V0.5.7.4 之前的纯小问题、顺手清掉）

**两文件改动**：`prompts/phase-3-review.md` + `src/lib/server/plan-runner.ts`、`pnpm typecheck` ✓ / `pnpm lint` ✓。

**V0.5.7.4 待办（用户实测）**：
1. **review 风格视觉对照**：起新 task 跑到 review、看 03-review.md 标题 / 段层级是否跟 01-plan.md / 02-build.md 视觉一致
2. **review fix mode 试**：从 review fork 重启 + textarea 填一两条假反馈、看 AI 是否把修正追加到 `## 修改记录` 而不是新建顶层「## Fork 修复」 / 「## Revise」
3. **frontmatter 禁项试**：观察新跑的 03-review.md 头部是否还出现 `---phase: review---` / `task_id:` / `generated_at:` 之类 yaml 块（V0.5.5 起 plan / build 都没了、review 之前缺这条明文）

##### 补 V0.5.7.5：review 段精简——4 类差异 → 三类、未完成段定义收紧、删跨角色项 + 飞书评论草稿（2026-05-21 下午、V0.5.7.4 联测后用户拍板）

V0.5.7.4 跑出来一份 03-review.md（`data/tasks/t_1779244321203_8i29s8` 那个补升任务）、虽然骨架对齐了 plan / build、但用户实测细看后提了三个产品层问题：

**问题 1：「未完成」段塞了非 task 的东西**

V0.5.7.4 那份 artifact 的「未完成」段塞了两行：
- 「跟进页橙色任务类型中文标签」——其实**前端已经做完了 `recordData.taskType` 写入、依赖后端 query_type 配置**、不是 task 未完成
- 「全量 yarn build:dev」——其实是**校验环境缺 OSS 密钥**、是 02-build.md「全量校验」该写的事、不是 plan task 未做完

**根因**：`prompts/phase-3-review.md` §3.4 + 骨架 `## 未完成` 段定义太宽（「02-build.md 标 ✗ 失败 / ⚠ 部分 / 完全没提」）、AI 看到 02-build.md 任意「没全 pass」就抓进来、抓到 校验环境 / 外部依赖 / 跨仓库 这些噪声。

**问题 2：飞书需求对照表塞了跨角色项**

V0.5.7.4 那份 artifact 末尾出现「数仓 / iOS 端改造 / story 跨角色 / ❌ 不在本仓库范围」这条记录。用户视角是「我做前端、数仓 / iOS 不关我事」、噪声。

**根因**：`prompts/phase-3-review.md` §4 + 骨架明文要求列跨角色项（「V0.4 multi-role 时代设计、给用户看 story 全景」）、跟用户实际诉求（「我只关心我做的部分」）错位。

**问题 3：review 整体偏重、调试期想精简**

V0.5.7.4 骨架顶层 7 段：总评 / 范围扩张 / 范围收缩 / 实现偏差 / 未完成 / 跟飞书对照 / 交付信息 + 修改记录。对比 01-plan.md（6 段）、02-build.md（4 段）确实重。

**修法（V0.5.7.5 一次性做完）**：

| 改动 | 修法 | 影响段 |
|---|---|---|
| **顶层段合并** | 「## 范围扩张」+「## 范围收缩」→ **`## 范围偏离`**（一张表、用「类型 = 扩张 / 收缩」字段标）| §3.1 + 骨架 |
| **段重命名 + 定义收紧** | `## 未完成` → `## 未完成 task`、明文「**只列 plan §5 拆分里贴了名、但 build 没做完的 task**」+ ⛔ 三禁项（不收 校验环境 / 外部依赖 / 本仓库以外）| §3.3 + 骨架 |
| **跨角色项删除** | 「跟飞书需求对照」段去「不在本仓库范围 / 跨角色 / 后端 / 测试」项、明文「只列跟本仓库 + 本 role 相关的需求项」| §4 + 骨架 |
| **交付信息删 1 项** | `### 飞书评论草稿（给 PM / 测试看）` 子项整段删——over-design、commit msg 已能给 PM 当沟通材料、用户实测不发飞书评论 | §5 子段编号 5.1~5.4 → 5.1~5.3、骨架表也同步 |
| **文案一致化** | 全文「4 类差异 / 四类差异」→「三类差异」；「飞书评论草稿」从「输出」「几条要点」「交付信息」段的描述里全删；「范围扩张 / 范围收缩」表段标题去除、改为「范围偏离」 | 全文 |
| **修改记录段同步** | 「严禁复述」清单里「范围扩张 / 范围收缩」→「范围偏离」；其它无影响 | 骨架 ## 修改记录 |

最终顶层段：**6 段**（总评 / 范围偏离 / 实现偏差 / 未完成 task / 跟飞书需求对照 / 交付信息 + 默认隐的修改记录）、跟 plan（6 段）持平、跟 build（4 段）仍重 1~2 段、但 review 本身有 4 类差异 + 飞书对照 + 交付 三大职责、6 段已是不可再压。

**单文件改动**：仅 `prompts/phase-3-review.md`、`pnpm typecheck` ✓ / `pnpm lint` ✓。

**V0.5.7.5 待办（用户实测）**：
1. **range 偏离表试**：起新 task 跑到 review、看「范围扩张」「范围收缩」是否真的合并成「范围偏离」单表 + 类型列
2. **未完成 task 段试**：故意做一道 task 让 build 校验环境出问题 + 留个 plan task 没做、看 review 是否只把后者收进「未完成 task」、前者归「总评」build 校验状态
3. **跨角色项消失试**：找一道飞书 story 涉及前端 + 后端 + 测试的、看 review「跟飞书对照」是否只列前端那些、后端 / 测试不出现
4. **飞书评论草稿消失试**：「交付信息」段是否只有 3 个子段：Commit message / PR title+body / 自测 checklist

##### 补 V0.5.7.6：自测 checklist 精简 + 实施位置 path 完整性（2026-05-21 下午、V0.5.7.5 重跑后即时反馈连发）

V0.5.7.5 改完用户立刻重跑了一道 review、拿到的 03-review.md 暴露 **3 个问题**、本节一次性收：

**问题 1：「自测 checklist」段塞前置步骤**

原文：
```
- [ ] 启动 dev：`yarn local`（https://localhost:8877/）
- [ ] 访问 ...
```

「启动 dev」是「跑测试的前提」、不是「测试本身」、PR reviewer 默认会做、写了是废话。

**问题 2：AI 凭空编命令 / 端口**

用户的项目实际跑在 `8080`、AI 没去 read package.json / README 拿真端口、脑补成 `8877`。这是 hallucination、用户视角直接踩雷。

**问题 3：「实施位置」简写文件名 → 前端识别不出 path 链接**

03-review.md「跟飞书需求对照」表的「实施位置」列里、AI 部分写了完整路径、部分简写了纯文件名（如 `recordModal.vue:2189-2221`）。

`src/lib/path-utils.ts: looksLikePath` 启发式判路径要求字符串**含 `/`**、纯文件名识别不出来、用户在 artifact 看到的是死字符串、不能点跳 Cursor。

**根因综合**：

1. §5.3 自测 checklist 段的指导原文「优先列『能自动验的』：启动 dev / 访问 URL / 点按钮 / 看结果」——把「启动 dev」明文列为「优先列」、AI 老实跟单
2. §5.3 没明文要求 AI 自测 step 出现命令 / 端口 / URL 时先 `read` 拿真值、AI 容易凭空编
3. §4 「跟飞书需求做对照」段对 path 写法只说「`path:lineRange` 引用」、没明文「必须从仓库根的完整相对路径起手」

**修法（单文件 + 接力反思）**：

`prompts/phase-3-review.md` 三处改动 + 复杂度自查：

| 段 | 改动 |
|---|---|
| `§5.3 自测 checklist` 段 | 4 条 bullet（净增 1）取代原本「不限 / 优先列启动 dev / 不列回归矩阵」3 条。**第一稿 V0.5.7.6 改了 9 条 bullet、用户反问「没增加复杂度吧」、立即精简到 4 条**（净增 1）：「功能验证 step / 不写前置环境 / 写命令前先 read 拿真值 / 不列回归矩阵」 |
| 骨架自测 checklist 示例 | 删「- [ ] 启动 dev server：`pnpm dev`」那一行、第一行直接是「- [ ] 访问 /users/list」 |
| `§4 跟飞书需求做对照` 段 | 加一段 path 完整性约束 + ✅/❌ 对照（`apps/.../recordModal.vue:2189` 对、`recordModal.vue:2189` 错）、附前端 `looksLikePath` 识别原理 |

**接力反思**：V0.5.7.6 第一稿改了 9 个 bullet、用户立刻问「没增加复杂度吧」——这是 prompt 维护过程中的一个长期教训：**新约束往往用「⛔ 三条子 bullet 展开」的形态写、复杂度叠加快**。后续改 prompt 时硬规则：**单次增量 ≤ 3 行、不展开 ⛔ 三层 bullet、能 fold 成单行就 fold**。

**单文件改动**：仅 `prompts/phase-3-review.md` + `docs/HANDOFF.md`、`pnpm typecheck` ✓ / `pnpm lint` ✓。

**V0.5.7.6 待办（用户实测）**：

1. **「启动 dev」消失试**：自测 checklist 第一项是不是直接「访问 xxx」、不再有「启动 dev」前置
2. **端口准确性试**：让 AI 写需要端口的 checklist step、看 AI 是不是 read package.json / README 拿真端口
3. **path 完整性试**：「实施位置」列每条都从仓库根的完整相对路径起手、前端 markdown 能点链接跳 Cursor

##### 补 V0.5.7.7：跨 phase 共享规范抽离到 `prompts/_shared.md`（2026-05-21 晚、架构 review 推动）

**背景 / 触发**：

用户跑完 V0.5.7.6 后让 AI 站 P8 架构视角 review 一遍 plan / build / review 三 phase 的 prompt 设计、本 AI 抓出几条结构性债：

1. **跨 phase 重复约束**：以下 4 条规则在 3 个 phase prompt 里各写了一遍（写法略有出入、改一处忘改另一处）：
   - artifact 写入工具用法（`write` 创建 / `edit` 改、首次写 `read` artifact-writer skill）
   - artifact 顶部禁 frontmatter（V0.5.5 起约束）
   - path 完整路径写法（V0.5.6.3 / V0.5.6.4 加严、V0.5.7.6 在 review 又加一遍）
   - `## 修改记录` 段格式 + 内部技术词禁项（V0.5.7.2 / V0.5.7.4 在 build / review 各加了一份「⛔ 三条子 bullet」）
2. **典型 bug**：V0.5.7.6 第一稿在 review prompt 加了 9 个 ⛔ bullet 防 AI 编命令 / 端口、用户立刻反问「没增加复杂度吧」——本质是 prompt 复杂度被「跨 phase 重复 + 历史注释 + 反例展开」叠了 3 倍。
3. **debt 量化**：plan 429 行 / build 245 行 / review 390 行、其中约 25-30% 是跨 phase 通用约束的重复。

**改动**：

抽 4 类通用约束到新文件 `prompts/_shared.md`（118 行）、`plan-runner.ts` 在 `buildSuperPrompt()` 里把它拼到「各 phase 详细 prompt」段之前。各 phase prompt 删重复段、只保留 phase 特有约束 + 一行「见 super-prompt 跨 phase 共享规范 §X」reference。

`prompts/_shared.md` 涵盖：

| § | 内容 |
|---|---|
| §1 artifact 写入工具 | `write` 创建 / `edit` 改、首次写前 read `artifact-writer` skill |
| §2 artifact 顶部格式 | 三 phase 都直接 `# 标题` 起头、不带 frontmatter |
| §3 path 完整路径写法 | 从 `{{repoPath}}` 起算、已知行号写 `path:line` 、同文件多次出现都写完整路径、不写绝对路径（带 ✅ / ❌ 反例） |
| §4 内部技术词禁项 | `fork` / `revise` / `[PHASE_ACK]` / `## Fork 修复` / 「fork 模式」「revise 路径」等 artifact 严禁出现 |
| §5 fix mode 修改记录 | §5.1 build / review 用 `## 修改记录` append；§5.2 plan 用内联 `> ✅ 已确认：...` |
| §6 中文表述 | artifact 全文中文（除代码 / 路径） |
| §7 数字 / 命名一致性自检 | task 计数、业务名词全称、命令 / 端口先 read 拿真值（V0.5.7.6 实测教训纳入） |

各 phase prompt 删的内容：

| 文件 | 删了什么 → 改成 |
|---|---|
| `phase-1-plan.md` | 「artifact-writer skill 详述（6 行）」+「路径硬约束段（27 行 + 反例 + 正例）」→ 引用「跨 phase 共享规范 §1 / §3」单行 reference |
| `phase-2-build.md` | 「artifact-writer 引导」+「写 artifact 的 `write` vs `edit` 详述」+「`## 修改记录` 段 ⛔ 三禁项」+「revise feedback 处的『不要新建顶层标题 / 不要复述 / 不要内部技术词』细节」+ 修正「本 phase 是 workflow 最后一个 phase」错误描述（V0.5 起 review 才是最后一个） → 多处引用 reference |
| `phase-3-review.md` | 「严禁写 frontmatter（§5 严格约束第 5 条）」+「写 03-review.md 段的 artifact-writer 详述」+「revise 处的修改记录格式 + 禁项细节」+「`## 修改记录` 段 ⛔ 三禁项」+「§4 跟飞书需求对照段的 path 完整性 ✅/❌ 示例（已在 _shared §3）」+「§5.3 自测 checklist 里命令 / 端口 read 规则（已在 _shared §7）」 → 多处引用 reference + 顶部加「artifact 通用约束见 super-prompt」 |

`plan-runner.ts` 加的代码（V0.5.7.7 注释标记）：

```typescript
const SHARED_PROMPT_FILE = "_shared.md";

const loadSharedPrompt = async (task: Task): Promise<string> => {
  const fpath = path.join(PROMPTS_DIR, SHARED_PROMPT_FILE);
  try {
    const tpl = await fs.readFile(fpath, "utf-8");
    return fillTemplate(tpl, { repoPath: task.repoPath, taskId: task.id });
  } catch (err) { /* 兜底返提示 */ }
};

// buildSuperPrompt() 中：
const sharedRules = await loadSharedPrompt(task);
// ... 拼装 super-prompt 时把 sharedRules 放在「各 phase 详细 prompt」段之前
```

**收益**：

- **改一处即同步**：以前改 frontmatter 规则要扫 3 个文件、漏一个就出 bug（V0.5.7.X 多次出现）；现在只改 `_shared.md` 一处
- **phase prompt 自身复杂度降低**：plan 429 → 403 行（-26）、build 245 → 214 行（-31）、review 390 → 357 行（-33）
- **新人 / 接力 AI 读懂成本下降**：先看 `_shared.md`（118 行）掌握通用约束、再读 phase prompt 看 phase 特有内容
- **总行数微涨**（1064 → 1092、+28 行）是加「见 super-prompt §X」reference 句的开销、属于可接受的偿还成本

**已知未做（V0.5.8 候选）**：

1. **Action A**：`phase-3-review.md` 的 revise 处理里、「明确指令通常是『改回 plan』『修改 plan 描述』『补做 task N』」与 §1「不动业务代码 / 不动 .git」存在内部冲突——按字面理解 review agent 在 revise 时被允许动 plan / 改代码、但本 phase 又禁止动这些。当前 fork mode 走 phase-2-build / phase-1-plan 接力是 OK 的、但 revise 路径下 review agent 自己动手的边界没收敛。**先记账、等用户实操踩到再修**。
2. **Action C**：phase prompt 里仍残留若干「V0.5.6.3 加」「V0.5.6.4 加严」「V0.5.7.6 实测踩坑」之类历史注释——对当前读者无信息量、靠 git blame 才有意义。暂时保留（删了 prompt 自身可读性反倒下降、靠未来定期清理）。

**单文件改动**：`prompts/_shared.md`（新建）+ `prompts/phase-1-plan.md` + `prompts/phase-2-build.md` + `prompts/phase-3-review.md` + `src/lib/server/plan-runner.ts` + `docs/HANDOFF.md`、`pnpm typecheck` ✓ / `pnpm lint` ✓。

**V0.5.7.7 待办（接力 AI / 用户实测）**：

1. **shared 段在 super-prompt 里的可见性测**：起一个新 task 跑 plan、看 SDK Run 日志里 super-prompt 首部是不是「## 跨 phase 共享规范」段（line 之间 _shared.md 内容）
2. **三 phase 引用 reference 命中测**：跑通 plan + build + review 三 phase、看 artifact 里 frontmatter / path 完整性 / 修改记录格式都遵守
3. **revise 路径回归测**：build / review phase 触发 revise、看 `## 修改记录` 段是不是按 `_shared §5.1` 格式追加

**V0.5.7.7 hot-fix（2026-05-21 晚补、用户实测踩坑）**：

抽完 `_shared.md` 后用户立即重跑了一个旧 task 的 build phase 验证、artifact 里出现 `promoteExpireReason.js`、`studentFollow.vue`、`lookStudentInformation.vue` 这种**纯 basename 改动文件**（前端 `looksLikePath` 不识别、用户看不到可点击链接）。

**第一轮修复**（hot-fix-1）：

原因：`_shared §3` 抽出后只在 `phase-1-plan.md`「改动 / 关键参考」和 `phase-3-review.md`「§4 实施位置」两处加了 reference、**`phase-2-build.md` 没在「Task 完成情况」段加显式 reference**——AI 看到骨架 demo 是 `src/api/sc.ts`（带 `src/`、`looksLikePath` 能识别）、自己写时又脑补「basename 应该也行」、就出问题。

修复：在 `phase-2-build.md` 的 `## Task 完成情况` 段顶部加一段⚠️：「改动文件路径必须写仓库根起算的完整相对路径」+ ✅/❌ 对照 + 「同样适用于改动文件清单表 + 验收对照表 + 修改记录」。

**第二轮深挖**（hot-fix-2、用户 /pua 后 P8 揪头发）：

继续审视后发现 build prompt 骨架自己**违反了 _shared §3**——「## 改动文件清单」表 3 个示例 `src/api/sc.ts` / `src/views/sc/PromoteDialog.vue` / `src/views/sc/list/Toolbar.vue` 虽然带 `src/` 能被 `looksLikePath` 识别、但**不是 monorepo 实际场景**（用户仓库是 `apps/cp-class-advisor-center/src/...`）；「## 验收对照」表更严重、3/4 是裸 basename `selList.vue` / `PromoteDialog.vue` / `recordModal.vue` ❌——AI 看到骨架自己就违反规则、自然会模仿。

修复：build 骨架里**所有**文件路径示例改成 monorepo 完整路径（`apps/cp-class-advisor-center/src/...`）、与用户实际仓库结构对齐。

同时给 `_shared §3` 加：

1. **plan / build / review 三 phase 的反例覆盖**——原本只有 plan 上下文反例（`BackLog.vue` / `home.vue`）、补充 build phase 实测反例（`studentFollow.vue` / `lookStudentInformation.vue` / `promoteExpireReason.js`）和 review phase 反例（`recordModal.vue:2189-2225`）、让 AI 直接看到自己 phase 的踩坑
2. **「前端判路径规则」说明**——直接引用 `src/lib/path-utils.ts:looksLikePath` 实现：「必须含 `/`、且最后一段含 `.` 扩展名——纯文件名 `foo.vue` 因为不含 `/` 直接 fall through 成纯文本」——让 AI 理解为什么要带目录前缀

**总改动**：

- `prompts/_shared.md`：+6 行（反例扩展 + 实现说明）
- `prompts/phase-2-build.md`：+11 行（顶部 ⚠️ + 骨架示例改 monorepo + 「同样适用于」扩展到验收对照）
- `pnpm typecheck` ✓ / `pnpm lint` ✓

**教训纳入 prompt 维护原则**：

1. **离骨架字段越近的约束越被遵守**——LLM 注意力衰减、顶部规则段抽离后必须在每个使用场景的字段附近加 reference、不是「顶部加一条就完事」
2. **骨架 demo 必须模拟用户实际仓库结构**——不要用 generic `src/api/sc.ts`、要用 `apps/<biz-app>/src/api/sc.ts` 这种 monorepo 路径；demo 是 AI 模仿的「正确写法」、demo 偷懒 AI 就跟着偷懒
3. **反例要覆盖每个 phase 的实测踩坑**——_shared 是给三 phase 共用的、反例就要分别给 plan / build / review 上下文、不能只给 plan 的让 build agent 自己脑内迁移

**已知未做（V0.5.8 候选）**：

- ~~**artifact 间互相引用问题**~~ ✅ **V0.5.8 落地、走方案 B**：03-review.md 写「详见 01-plan.md §4」时、`01-plan.md` 是裸文件名不含 `/`、`looksLikePath` 也识别不出（66 处类似引用散在三 phase prompt）。两条修复路径：(A) prompt 侧约束写 `data/tasks/{{taskId}}/artifacts/01-plan.md`——太长太丑；(B) 前端 ArtifactPanel 识别 `0N-xxx.md` 走 task 内 tab 切换、不走 cursor:// deep link——更彻底。


### V0.5.6.x：plan 模板三轮硬约束（2026-05-20 上午、V0.5.6.1 + .2 + .3 合订）

> **HANDOFF 分段约定**（V0.5.6.3 加）：同主题连续小版本（V0.x.y.1 / .2 / .3）写完后**立即合并**到 V0.x.y.x 一段、避免单一改动散段冗余。本节就是 V0.5.6.1 + V0.5.6.2 + V0.5.6.3 三段合订示范。

V0.5.6（ask_user 无次数上限 + 稍后再补充）测完、用户跑了几份真实业务 plan（补升任务改造）、暴露 plan 模板**结构** + **约束** + **agent 自律** 三层问题、连续三轮迭代收敛。

#### 0. 三轮驱动（用户原话精炼）

- **轮 1（.1）**：审 V0.5.6 出来的 plan 时直观反馈
  > 「（§1.1）我总感觉不是很懂是干嘛的、特别是差异类型这一块」
  > 「有差异的、我觉得也应该是 AI 要通过 ask 来问我呀、而不是列在方案上」
- **轮 2（.2）**：跑完 .1 模板后追问
  > 「3.1 和 5 的定位上算重复吗你觉得？」
  > 「3.2 和 3.3 你觉得要不要呢？还有技术决策的定位你觉得够清晰吗？」
- **轮 3（.3）**：再跑 .2 模板、连续发现 3 件 issue
  > 「task 里有些路径没有正确解析、确认下是不是没有给 AI 强调路径的规范」
  > 「这一段是我们的规则要求的吗」（指 agent 把 4 条 ack 备注堆 §1 段尾连一行）
  > 「这字段还有不确定的、还有或的、不行」（指 `promoteStatus（或 isMakeUp 同字段）`）

#### 1. 最终章节结构（V0.5.6.x 后 plan artifact 形态）

| 章节 | 内容要点 |
|---|---|
| **1. 需求理解** | 2-3 段总结 + 顶部 ask_user 留痕方式提示 |
| **2. 业务规则 / 文案 / 状态** | 关键枚举 / 状态机 / 字段；加「不要列」3 条 + PRD 复述反例 |
| **3. 涉及接口（跨后端边界）** | 接口名 / 方法 + 路径 / 来源 3 列；没新接口跳过本段 |
| **4. 关键技术决策（plan ack 用户能拍板的）** | 3 类允许 + 3 类禁止 + 反例 + 正例 |
| **5. Task 拆分（plan ack 的核心审计单元）** | 顶部跨包汇总句 + 路径硬约束（仓库根起算的完整路径）+ 每 task：改动 / 依赖 / 验收点 / 工作量 / 关键参考 |
| **6. 待澄清 / 不确定项** | deferred / 答「你定」按 default 走的 / 跨角色待澄清 |

**砍掉的章节**：§1.1（我的理解 vs 飞书原文）/ §3.1（本仓库改动）/ §3.3（不在本仓库范围）/ §6（上下文冲突已通过 ask_user 澄清）—— 6 章变 5 章。

#### 2. 决策清单（按类别）

**A. 结构精简（章节级）**

| ID | 决策 | 一句话理由 |
|---|---|---|
| A1 | 删 §1.1「我的理解 vs 飞书原文」 | 差异本质是 AI 不确定点、应该 ask_user 拍板、不是先列表让用户审；agent 实操大概率全写「✅ 一致」纯噪音 |
| A2 | 删 §6「上下文冲突已通过 ask_user 澄清」 | 信息跟 §1/§2/§4 正文里 ask_user 拍板备注重复、改正文内联；events.jsonl 已记录历史 Q&A、artifact 复述冗余 |
| A3 | §3.2 涉及接口表 5 列 → 3 列 + 升一级为 §3 | 字段细节看 contextDocs、plan ack 不审字段 |
| A4 | 砍 §3.1「本仓库改动」 | 跟 §5 task「改动」字段 100% 重复、用户 ack 跳过它直接看 §5 |
| A5 | 砍 §3.3「不在本仓库范围」 | 跨角色依赖归 §6 待澄清、纯参考信息（「iOS 也会做」）零价值 |

**B. 内容约束（什么该写、什么不该写）**

| ID | 决策 | 关键约束 |
|---|---|---|
| B1 | §2 加 PRD 复述反例 | 「不要列」3 条：业务背景大段叙述 / 验收标准抄一份 / PRD 段落标题直接当本段小标题；加反例代码块 |
| B2 | §4 加 3 类允许 + 3 类禁止 | 允许：全局选型 / 跨边界协议 / 产品体验；禁止：文件命名（进 §5）/ 待用户确认（进 §6）/ 已有技术栈复述 |
| B3 | §5 加跨包汇总句 | monorepo 顶部一句话「涉及 Y task、动 packages/<X> 共享 X 个 + apps/<Y> 业务 Y 个」 |
| B4 | §5 路径硬约束（4 条规则） | ①仓库根起算的相对完整路径 ②同名多 task 也写完整不简写 ③行号定位 `:line` / `:line-line`（V0.5.6.4 加强：**有就写**、前端解析后缀生成 `cursor://file/...:line` 链接、用户点击跳起始行；`:line-line` 末尾不传给协议、由 IDE 视口展示）④禁绝对路径；反例 `selList.vue` → 正例 `apps/cp-class-advisor-center/src/views/mainHome/selList.vue:271-279` |
| B5 | ⛔ 严禁不确定写 artifact | 字眼黑名单：或 / 待定 / TBD / 可能 / 应该是 / 大概 / 暂定；反例 `promoteStatus（或 isMakeUp 同字段）` → 正例：先 ask_user 拍板字段名再写 artifact；plan-runner super-prompt 同步加（双保险） |
| B6 | ask_user 留痕「就地」语义说清楚 | 「就地」= 紧跟用结论的那行 / 那段、不聚合段尾、一行一条；反例：§1 段尾堆 4 条 ack 连一行 → 正例：§2.4 段尾一行 / §2.5 段尾一行 各自就地；**定位是给下游 build / review agent 看的拍板标记**、不是给用户的「确认表」 |

**C. 跨模式策略**

| ID | 决策 | 理由 |
|---|---|---|
| C1 | chat（自由聊天）任务禁用 ask_user | 用户原话「自由 chat 模式下不用提问、直接回答、自由模式就是 talk 而已」；chat 没 artifact、ask_user 弹窗的留痕价值兑现不了；改 prompt 引导走 assistant_message + wait_for_user；先靠 prompt 自律、误调再加 server hardcode |

#### 3. 改动文件清单（.1 + .2 + .3 合表、按文件聚合）

| 文件 | 整体改动（三轮累计） |
|---|---|
| `prompts/phase-1-plan.md` | 骨架：删 §1.1 / §3.1 / §3.3 / §6 上下文冲突；§3.2 升 §3 + 表压 3 列；§4 加 3 类允许 + 3 类禁止 + 反例 + 正例；§5 加跨包汇总句 + 路径硬约束 + 反例 + 正例；原 §7 改名 §6 合 deferred + 跨角色；§2 加「不要列」3 条 + PRD 复述反例；几条要点加 ⛔ 严禁不确定写 artifact 字眼黑名单 + 反例。正文：§1 顶 ask_user 留痕方式说清楚「就地」语义 + 反例 + 正例；几条要点段引用全部刷新到新章节号 |
| `prompts/phase-2-build.md` | 读上游 artifact 段：§3 涉及接口（V0.5.6.2 起只列接口、文件清单挪 §5）/ §4 关键技术决策（V0.5.6.2 起 3 类约束）/ §5 task「改动」字段（V0.5.6.2 起改动范围必须在这里）；删 §1.1 / §6 上下文冲突引用 |
| `prompts/phase-3-review.md` | 关键定位 / 执行步骤 / 飞书对照 / 几条要点同步刷：「§3 涉及面」→「§5 task 改动字段」、「§1.1 我的理解 vs 飞书原文」→「正文内联 `> ✅ ask_user 已确认`」、「§6 上下文冲突已澄清」→「正文内联备注」 |
| `src/lib/server/plan-runner.ts` | 注释里 review phase 要读的章节同步刷；super-prompt「何时调 ask_user」段加 ⛔ 不确定字眼黑名单（B5 双保险）；super-prompt「§7 待澄清」→「§6」、「上下文冲突已澄清段」→「正文内联备注」 |
| `src/lib/server/chat-mcp.ts` | ask_user 工具 description 开头加 `## ⚠️ chat 任务禁用`（C1）；§7→§6；上下文冲突表述换正文内联备注 |
| `src/lib/server/chat-runner.ts` | chat 模式 prompt 原 `## ask_user` 段整段重写、改成「chat 模式禁用、直接 assistant_message + wait_for_user」（C1） |
| `src/app/api/tasks/[id]/ask-reply/route.ts` | 4 处注释 / deferred 提示 §7→§6、上下文冲突表述同步换 |
| `src/lib/task-store.ts` + `src/components/tasks/ask-user-dialog.tsx` | deferred 流程注释 §7→§6（共 4 处） |
| `src/lib/path-utils.ts`（V0.5.6.4） | `parsePathWithLine` 拆 `path[:line[-endLine]]` 后缀；`looksLikePath` 剥掉行号再做扩展名判断；`buildCursorLink` 拼 `cursor://file/<abs>:line`（取起始行、`-line` 末尾不传协议）——修复 AI 写 `:271-279` 后链接坏（`:` 被 encodeURIComponent 成 `%3A`） |
| `prompts/phase-1-plan.md`（V0.5.6.4 第二轮、用户实测后加严） | **§3 接口表**第二列加约束「只允许 METHOD + URL」、复用描述去「来源」列；**§4「不要列」第 1 条**补「**新建 X / 复用 Y / 拆出 Z**」（防 agent 把实施细节当决策）；**§5 路径硬约束 ②** 改「同一文件多次出现（**跨 task 或同行多段**）都写完整路径」+ 反例加「`TaskInfo.vue:75-100、:414-503、:540-760` 裸冒号续接」；**§5 路径硬约束 ③** 精简（删前端解析机制细节、保留「能写就写」语义）；**§5 顶部汇总句**加「数字口径」段（文件计数 = 改动字段去重后唯一文件数）；**⛔ 黑名单**加「节选 / 示例 / 部分 / 完整按 X 录入 / 后续补全」+ 「特别注意偷懒类」段；**几条要点**加「⛔ 不省略业务名词 / task name」（防「学情/关单」这种脑内简写让用户费解） |
| `src/lib/server/plan-runner.ts`（V0.5.6.4 同步） | super-prompt ⛔ 黑名单同步加「节选 / 示例 / 部分 / 完整按 X 录入 / 后续补全」、双保险 |
| `src/lib/server/plan-runner.ts`（V0.5.6.5 新增**写完自检步骤**） | super-prompt 新加 `## 写完 artifact 强制自检` 整段：触发时机 = 调 ask_user / wait_for_user 前；4 步走 ①`shell grep` 黑名单字眼 ②人肉扫业务名词全称 ③扫 ack 留痕位置（不堆 §1 段尾）④扫路径完整性（不裸冒号续接）；4 项 grep 命中数为 0 才允许进 ack。背景：实测同一份 plan agent **间歇性**踩黑名单（§3 严格遵守、§2.2 又写「URL 或 processVariables」）——不是规则不细、是写到后面状态衰减没回头扫、强制 grep 比纯靠记忆稳 |
| `prompts/phase-1-plan.md`（V0.5.6.5 配套）| ⛔ 黑名单加「约 / 大约」+ 行号反例「**约 `4869-5250` 段**」❌；B6 格式约束加第 4 条「ack 涉及多章节时先别在 §1 写」、严禁 §1 段尾连写多条对应下游章节的 ack |

`pnpm typecheck` ✓ / `pnpm lint` ✓ 三轮全程双绿。

#### 4. V0.5.6.x 待办（接力 AI / 用户测试）

- **结构待测**（起新 plan、看 01-plan.md 骨架）：
  1. **没有 §1.1 / §3.1 / §3.3 / §6 上下文冲突**——一气呵成 §1 → §2 → §3 → §4 → §5 → §6 待澄清
  2. §3 只列接口表（3 列、没新接口跳过本段）
  3. §4 决策 3 类允许、不出现「文件命名」「待用户确认」
  4. §5 顶部跨包汇总句、所有 task「改动」字段写仓库根起算的相对完整路径（不再 `selList.vue` 这种 basename）
  5. ask_user 拍板留痕「就地」放在用结论的那行 / 段、一行一条、不堆 §1 段尾连一行
  6. **task「改动 / 关键参考」字段里所有 `path:line` / `path:line-line` 后缀都是可点击链接**（V0.5.6.4）、点击 Cursor 跳起始行；行号缺失时 prompt 应该提醒 agent「有就写」
  7. **同行多段路径每段都带完整 path**（V0.5.6.4 第二轮、`TaskInfo.vue:75-100、TaskInfo.vue:414-503` 而非 `:414-503` 裸冒号续接）、`§3` 接口表第二列纯 METHOD + URL、`§4` 决策不出现「新建 X / 复用 Y」实施细节、`§5` 顶部汇总句文件数 = task 改动字段去重计数、artifact 无「节选 / 示例 / 关单 / 学情」这种偷懒省略
  8. **写完 artifact 自检 4 项**（V0.5.6.5、强制 grep）：①shell grep 黑名单字眼（或/约/大约/可能/待定/TBD/节选/示例 等）零命中 ②业务名词 / task name 全称、无「学情/关单」简写 ③`> ✅ ask_user 已确认` 不堆 §1 段尾（涉及 §2-§5 的挪到对应章节）④`path:line-line` 后缀前必有完整 path、不裸冒号续接
- **内容待测**：
  - 反例测：喂大段 PRD 看 agent 是否抄进 §2
  - 严禁不确定测：刻意问字段命名不清的需求、看 agent 是否真去 ask_user 拍字段名而不是写「A 或 B」
- **多 phase 联测**：build / review agent 读新结构、找文件 / 决策 / 拍板留痕都顺畅
- **chat 禁用 ask_user 测**（C1）：起 chat 任务、agent 走 assistant_message 路径不弹 modal；如果仍误调、加 server 端 `task.mode === "chat"` hardcode 拦截


### V0.5.6：ask_user 无次数上限 + 弹窗加「稍后再补充」（2026-05-20 上午）

> 用户对 V0.5.5 §6 遗留「ask_user 问两轮就停」的拍板——**取消所有「最多 1 次」上限、让 AI 按内容判断要不要继续问；同时弹窗加「稍后再补充」按钮、给用户一个退出循环的口子。**

#### 1. 设计动机（用户拍板）

V0.5.5 联测发现：用户第一轮 ask_user 答模糊（「你定」/「不清楚」）、agent 应该 read/grep 形成判断 → 二轮 ask_user 给具体选项让用户拍板。但实测下来 agent 问完一轮就**自我加戏「问够了」**、直接写 artifact 跳过 wait_for_user 之前的二轮 ask_user。

根因：旧 prompt 写「**写 artifact 初稿阶段最多调用 1 次 ask_user**」——这是 V0.3.2 给 modal 弹窗一次性打包问的设计、但被 agent 理解成了「整个 phase 都只能问一次」、用「问够了」自我说服跳过收敛。

**修法（用户拍板）**：
- ❌ 之前提议过的 B 方案「软上限 5 轮」——用户直接否决（「让 AI 根据内容判断要不要问」、不要预设次数）
- ✅ 用户拍的方向：**完全去掉上限、按内容收敛；UI 加「稍后再补充」按钮给用户退出循环的口子**

#### 2. 协议层 / API 层改造

**`task-store.ts.submitAskReply` 加 `options?: { deferred?: boolean }` 参数**：

```ts
submitAskReply(taskId, askId, answers, { deferred: true });
```

`deferred=true` 表示用户选「稍后再补充」、`answers` 可以为空、body 多带 `deferred:true` 字段。

**`/api/tasks/[id]/ask-reply/route.ts` 改造**：
- body 接 `deferred?: boolean` 字段
- 校验：`deferred=true` 时跳过「answers 必填非空」+「answers 覆盖所有 question」校验
- `buildReplyText(questions, answers, deferred)` 第三参数 deferred、按头分两种格式：
  - `deferred=false` → `[ASK_USER_REPLY]\nQ1: ...\nA: ...\n\nQ2: ...\nA: ...`（旧格式不变）
  - `deferred=true` → `[ASK_USER_REPLY deferred]\n\n用户选择**稍后再补充**、未提供任何答案。\n请按你判断的合理 default 推进、并把以下问题完整列入 artifact「§7 待澄清 / 不确定项」段...\n\n未答问题清单：\n\nQ1: ...\nQ2: ...`
- `ask_user_reply` 事件 meta 加 `deferred: true`（便于前端事件回放识别）

#### 3. UI 层改造（`ask-user-dialog.tsx`）

DialogFooter 加「稍后再补充」按钮、ghost variant 让位主操作「提交全部回答」：

```tsx
<Button size="sm" variant="ghost" disabled={submitting} onClick={() => void handleDefer()}>
  稍后再补充
</Button>
<Button size="sm" disabled={submitting || !allAnswered} onClick={() => void handleSubmit()}>
  {submitting ? "提交中…" : "提交全部回答"}
</Button>
```

`handleDefer` 用 `useDialog().confirm` 二次确认（统一走项目里的 confirm Promise API、不用 window.confirm）：

```ts
const ok = await confirm({
  title: "稍后再补充这些问题？",
  description: "AI 会跳过这一组问题、按 default 推进、并把它们列进方案文档「待澄清 / 不确定项」段。你可以稍后在「再聊聊」或上下文文档里补充。",
  confirmLabel: "确认稍后补",
  cancelLabel: "回去答题",
});
if (!ok) return;
await submitAskReply(task.id, askId, [], { deferred: true });
```

#### 4. Prompt 层重写（去掉「最多 1 次」+ 教 agent 处理 deferred）

**`src/lib/server/chat-mcp.ts` ask_user 工具描述**：
- 标题从「phase 内打包提问（一次问完所有不确定项）」改成「phase 内打包提问（按需多次调、单次内一次问完）」
- 「关键约束」段彻底重写：
  - **单次调用内**：当前轮想问的全部打包进 questions[]、不要同一时刻调多次
  - **整个 phase 内无次数上限**：按内容判断、按需多次调
  - **收敛标准**：所有问题都得到「明确的业务决策」（A 路径）才能 wait_for_user；判不准就再问
- 「返回值」段加 deferred 处理：拿到 `[ASK_USER_REPLY deferred]` 时必须 1) 不再就这组 Q 重新调 ask_user 2) 把这些 Q 列进 §7 待澄清 3) 按 default 推进继续 wait_for_user

**`src/lib/server/plan-runner.ts` super-prompt ask_user 段**：
- 标题改成「V0.5.6 无次数上限、按内容收敛」
- 核心约束段重写、加 V0.5.6 设计动机说明（agent 自我加戏问题）
- 删了 V0.5.1 修复段（「1 次限额仅针对初稿阶段」整段过时）
- 「返回值」段加 deferred 处理
- 「何时不该问」段加「拿到 deferred 头的那组 Q——用户已明示稍后补、不准重问」
- 「调用礼仪」段把「最多调一次 ask_user / 撤销」改成「按需多次调、不要自我加戏问够了」

**`prompts/phase-1-plan.md` §5 / §5.1 / §5.2 重写**：
- §5 标题改 V0.5.6、关键约束段重写（无次数上限 + 按需多次调 + 用户可点稍后再补充）
- §5.1 加 **D 路径**（deferred 头处理：不重问 + 列进 §7 + 按 default 走继续 wait_for_user）、护栏改成「只有 D 才用 default、其他场景一律问到 A」
- §5.2 改写收敛标准：「**全部收敛到 A 或拿到 deferred** 才 wait_for_user」、明示 agent 不预设次数上限不自我加戏

#### 5. 关键决策记录

| 决策点 | 用户拍板 | 备选 / 否决理由 |
|---|---|---|
| 上限策略 | **完全无上限**、AI 按内容判断 | ❌ 软上限 5 轮（用户否决：不要预设次数） |
| 退出循环的口子给谁 | **给用户**（弹窗按钮） | 不给 agent（之前给 agent 就会被自我加戏） |
| 「稍后补」UI 形态 | **全局 1 个 ghost 按钮**、跟「提交全部回答」并列 | 不做 per-question 跳过（复杂度高、用户「单数」表述含义） |
| 二次确认 | `useDialog().confirm` Promise API | 不用 window.confirm（项目规则） |
| 协议头 | `[ASK_USER_REPLY deferred]` | 保留旧 `[ASK_USER_REPLY]`、兼容回放、加后缀区分 |
| Q 的归宿 | agent 列进 artifact §7 待澄清 + 按 default 走 | 不跳过、要让用户在 ack 弹窗看到「哪些没答、走的什么 default」 |

#### 6. 改动文件清单（6 文件、净 +180/-50 行）

| 文件 | 改动 |
|---|---|
| `src/lib/task-store.ts` | `submitAskReply` 加 `options?.deferred` 参数、body 条件携带 |
| `src/app/api/tasks/[id]/ask-reply/route.ts` | body 接 deferred、跳过校验、`buildReplyText` 加 deferred 分支、meta 写 deferred |
| `src/components/tasks/ask-user-dialog.tsx` | 加「稍后再补充」ghost 按钮 + `useDialog().confirm` + `handleDefer` |
| `src/lib/server/chat-mcp.ts` | ask_user 工具 description 整段重写、加 deferred 处理、phase 描述加 review |
| `src/lib/server/plan-runner.ts` | super-prompt ask_user 段重写、删 V0.5.1 1 次限额段、顶部工具列表简介更新 |
| `prompts/phase-1-plan.md` | §5 标题改 V0.5.6、约束重写、§5.1 加 D 路径、§5.2 改收敛标准 |

`pnpm typecheck` ✓ / `pnpm lint` ✓ 双绿。

#### 7. V0.5.6 待办（接力 AI / 用户测试）

- **核心待测**：用户在 ask_user 弹窗答模糊（「你定」/「不清楚」）、看 agent 是否真 read/grep + 二轮 ask_user 给具体选项（不再「问够了」跳过）
- **deferred 闭环测**：用户点「稍后再补充」→ 二次 confirm 确认 → 看 agent
  1. 是否真的不再就这组 Q 重新调 ask_user
  2. 是否把所有未答 Q 完整列进 artifact §6（V0.5.6.1 改名前是 §7）
  3. 是否按合理 default 推进、artifact 各位置加 `> （ack 待澄清：xxx）` 标记
  4. 是否继续 wait_for_user 不退 run
- **revise 闭环也无上限测**：用户在「再聊聊」打模糊话（「test」/「111」）连发 3-4 次、agent 应该每次都 ask_user 复述、不闷头改、不自我加戏
- **没必要场景测**：用户答案明确时 agent 不应该重复多调 ask_user（无上限 ≠ 必须多调、要按内容判断）
- **极端场景**：用户连续点 5+ 次「稍后再补充」（理论上不会、但测一下幂等）


### V0.5.5：A+B 优化 + SDK 诊断 + SSE 重连 + plan 瘦身 + feedback 分级 + 重启加强（2026-05-19 下午 ~ 晚）

> 用户下午联测时遇到一堆细节问题、顺手抽公共代码 / 加诊断口 / 简化 plan 模板 / 重写 revise 解读逻辑 / 让 awaiting_user 也能重启。一晚改完 18 + 文件、净减 100+ 行手工代码。

#### 1. A 类（瘦身）+ B 类（诊断 / SSE）优化六件套

**A1. `task-card.tsx` 删 `AlertDialog` 三件套、改 `useDialog().confirm`**

`AlertDialog` + `useState(deleteOpen)` + 整段 JSX 一共 ~50 行手工状态机、换成 `const { confirm } = useDialog(); const ok = await confirm({...}); if (ok) ...` 一行。

跟 `task-detail/page.tsx` 已经在用的 `confirm` API 对齐、project rule `learned-conventions.mdc` 也明示不用 `window.confirm` 走 `useDialog`。

**A2. 修 `learned-conventions.mdc` 的 dayjs 描述**

之前写「new Date 是 OK 的、不强求 dayjs」、但实际项目里 dayjs 已经引、对齐到「已经在用的 dayjs 优先复用」。

**B3. 抽 `src/lib/server/route-helpers.ts`**

`chat-reply/route.ts` 跟 `phase-ack/route.ts` 各有一份 `errorResponse / isValidModel / isValidMcpServers / parseAndValidateImages / KEEPALIVE_RACE_RETRY_MS / sleep`、复制粘贴。V0.5.5 ask-reply 加贴图时本来又要复制第四份——直接抽 helper、未来加新 route 复用。

helper 内部加了 `MAX_TOTAL_UPLOAD_BYTES`（30MB 全局上限、跟 chat / phase-ack 同款）+ 详细 jsdoc。

**B4. `run-args.ts` 加 `prepareBootArgs` + page.tsx 复用**

`handleApproveWithFork` 之前内联了一段「读 settings → 校验 apiKey → parseMcpServers → filterMcpServersByTask」、跟 `prepareRunArgs` 几乎重复、唯一差是不校验 model（dialog 里挑过）。抽 `prepareBootArgs(task)` 共享前置逻辑、`prepareRunArgs` 内部也调它。

**B5. 抽 `src/lib/path-utils.ts`**

`pathBasename` / `looksLikePath` / `buildCursorLink` 之前散落在 `event-stream.tsx` / `repo-card.tsx` 等组件里、各自 inline 一份。挪到 `lib/path-utils.ts`、跟「`lib/task-display.ts` 是文案唯一源」一个套路。

**B6. `artifact-panel.tsx` 瘦身**

`artifact-panel.tsx` 之前自己实现了 `extractFenchedLanguage` + 一堆 path 兼容代码、复杂度顶到天花板。借 path-utils 抽出顺势精简、单文件 -45 行。

#### 2. SDK status=ERROR/EXPIRED 诊断口（实测见效）

**坑**：`run.wait()` 返 `RunResult { status: "error", durationMs: ... }`、但 RunResult 类型上**没有** `errorCode` / `errorMessage` 字段。throw 出去的报错是干瘪的 `agent run status=error`、完全无法诊断。

但 SDK stream 里其实有一种叫 `SDKStatusMessage` 的消息、`type: "status"` + `status: "CREATING" | "RUNNING" | "FINISHED" | "ERROR" | "CANCELLED" | "EXPIRED"` + `message?: string`——服务端致命错误的具体描述放在这个流消息里、被我们 `handlePlanSdkMessage` 的 `case "status"` 默 ignore 掉了。

**改造**（`plan-runner.ts` + `chat-runner.ts` 双 runner）：

- `AssistantBufferCtx` 加 `sdkErrorMessage` 字段
- `case "status"`：`status === "ERROR" || status === "EXPIRED"` && `message` 非空时、写一条 `error` 事件 + 把 message 存进 `assistantCtx.sdkErrorMessage`
- 最后 throw 时把 `sdkErrorMessage` 拼进 message：`agent run status=error\n--- SDK stream error message ---\n<message>\n--- SDK result dump ---\n...`

**V0.5.5 实测发现**（用户复现一次）：SDK 1.0.13 **偶尔**走到 `case "status"` 时 `message` 字段是空的——

```
[plan-runner] SDK status message: status=ERROR message=(none)
```

这是 SDK 自己的局限、不是我们漏了。加了**无条件 `console.log`** 把 raw status 消息打到 dev server 终端、下次复现能立刻看到「SDK 是真没传 message、还是被我们漏处理了」。

#### 3. SSE 重连修复（用户体感「点继续监听后必须刷新页面」）

**坑**：用户点「继续监听」/「重启 workflow」/「fork 新 agent」后、服务端确实重新跑了 agent、但客户端**不会看到新事件**、必须 F5 刷新。

**根因**：

1. 上一轮 agent 退出后客户端 SSE 已经 close
2. `useTaskWatch` 的 `useEffect` deps 没变化（taskId 不变、callbacks 不变）、不会重连
3. `start-workflow` / `resume-waiting` 路由 `void runPlanWorkflow(...)` 是 fire-and-forget、立刻返回 task 给客户端、`task.status` 还是 `failed`、客户端发起的新 `watch-chat` 请求服务端看到 failed 直接 bootstrap+close

**修法**（三处协同）：

- `use-task-watch.ts` 加 `reconnectKey: number | string = 0` 参数、纳入 `useEffect` deps
- `page.tsx` 加 `watchEpoch` state、`handleStart` / `handleResumeWaiting` / `handleApproveWithFork` 成功后 `++`、强制 `useTaskWatch` 重连
- `start-workflow/route.ts` + `resume-waiting/route.ts`：fire-and-forget 之前**同步**调 `patchPhase(taskStatus: "running")`、把 task.status 切到 running 再返回、客户端 SSE 看到 running 不会立刻 close

#### 4. plan / build / review prompt 模板瘦身

用户实操后觉得 `01-plan.md` 太冗余、「方案规划的内容过于冗余了」。删掉低价值字段：

- **删 plan §2「验收标准」**：跟 §1「需求理解」+ §3「业务规则」重叠、价值低
- **删 plan §7「验收对照」**：跟 review phase 的「跟飞书需求对照」重叠
- **删 plan §8「自动化校验计划」**：build phase 模板里有更具体的
- **删 plan §9「关联文档」**：context_docs 已经在 UI 上显示
- **压缩 plan §3「业务规则」**：原来是「逐字搬 PRD」、改成「只列关键表 / 枚举、不复述 PRD 全文」
- **压缩 plan §1.1「我的理解 vs 飞书原文」**：只列差异（补全 / 偏离 / 缺源）、不复述一致项

**phase-2-build.md / phase-3-review.md 同步更新**：

- 内部所有 `§X` 引用按新编号刷新（旧 §4 → 新 §3、旧 §6 → 新 §5、删了 §7/§8 的引用）
- review 「跟飞书需求对照」从「读 plan §2 验收标准」改成「读 plan §5 task 列表 + contextDocs 原文」、对齐 plan 瘦身后的产出
- build 「Task 完成情况」表替换之前的「验收对照」表（per-task 校验、对齐 plan 新结构）

#### 5. super-prompt `[PHASE_ACK revise]` 重写：feedback 清晰度 4 级分流

**用户反馈**：

> 我感觉这两点的提示词应该是可以共用的是不？AI 要么过度确认（明明用户说得很清楚还要 ask_user 复述）、要么模糊场景就闷头改（用户说「你看着办」就真的随便选了）

**重写后的规则**（`plan-runner.ts` §3 revise 解读、`chat-mcp.ts` shell 引导文案、phase-2 / phase-3 prompt 同步）：

```
A. 明确改动指令（含具体位置 + 动词 + 改前/后）
   → 跳过 ask_user 复述、直接走 3a 改 artifact
B. 明确询问（纯疑问、没改动指令）
   → 跳过 ask_user 复述、直接走 3b 答疑 + emit assistant_message
C. 含混 / 不确定 / 过短（看不懂用户想干嘛）
   → 走 1.1 调 ask_user 复述意图、给具体选项让用户拍板
D. 带图（feedback 含 [ATTACHED_IMAGES]）
   → 先用 read 工具逐一读图、合起来再分 A/B/C

护栏：判不准就当 C、宁多问一次也不要把模糊的判成 A 闷头改
```

**C 路径专用细则**：
- ask_user 的 `question` 直接对用户说话、问意图（不准出现「[PHASE_ACK revise]」「反馈过短」这种协议名 / 公文体）
- 用户答仍模糊 / 「你定 / 看代码再说 / 不知道」 → **read / grep 相关代码形成判断 → 再调一次 ask_user 给具体选项**（不要瞎默认）

#### 6. phase-1-plan.md §5.1 / §5.2：初稿 ask_user 答完后按 §5 同款分级处理

跟 super-prompt §3 用同一套 A/B/C/D 分级（plan 初稿 ask_user 是「主动问」、revise 是「被动收 feedback」、但答案解读规则同步）：

- A. 答案明确 → 直接把结论写进 01-plan.md 对应位置
- B. 答案是反问 → 在 01-plan.md 旁注里答疑、把答疑后结论一并写进去
- C. 答案模糊 → **必须** read / grep 相关代码形成判断 → **再调一次 ask_user** 给具体选项让用户拍板（**不能直接打 default 跳到 wait_for_user**）
- D. 部分清晰 + 部分模糊 → 清晰按 A 落、模糊按 C 二轮

> ⚠️ **已知遗留**（**等下一轮跟用户单独聊**）：用户实测发现「ask_user 问两轮后就直接写 artifact」。根因可能是 §5.2 写的「所有 Q 都按 A/B/C/D 处理完、ask_user 不再有可问的、再 wait_for_user」语义太软、agent 自己判断「问够了」就推进。修法已对齐方向（要么换成「Q 全部收敛到 A 才 wait_for_user、ask_user 没次数上限」、要么加软上限 5 轮）、未实施。

#### 7. awaiting_user 状态下也能「重启 workflow」

**痛点**：用户改了 prompt 想看新 prompt 效果、但 agent 卡在 awaiting_ack、「重启 workflow」按钮不显示——非要等 30 分钟 wait-ack 超时后才能点。

**改造**：

- `page.tsx` `canStart` 加 `awaiting_user` 状态、awaiting_ack 状态下三按钮并存 `[重启 workflow]` + `[再聊聊]` + `[通过 PHASE]`
- 「重启 workflow」在 awaiting_user 下用 `ghost` variant、让位主操作给「通过 PHASE」
- 点击先弹 `useDialog().confirm`（`destructive`）、告知「会 cancel 旧 agent + 从 plan 重头跑 + 已有产物被覆盖 + +1 配额」
- `start-workflow/route.ts` 加分支：`isPlanRunning && task.status === awaiting_user` 时走 fork 路径（`markPlanForFork → cancelPlan → waitForPlanToStop`）再起新 run、其他状态保持 already=true 幂等

中途用户曾要求加单独的「重跑 agent」按钮（保留 phase 状态、只重跑当前 phase）、加完后用户说「就用重启 workflow 就行」、撤销新按钮 + 路由 / helper、合并到 start-workflow。

#### 8. 三个 phase 骨架 YAML frontmatter 全删

`01-plan.md` / `02-build.md` / `03-review.md` 骨架开头之前都有：

```yaml
---
phase: 1-plan
status: ready_for_ack
upstream: raw_input
downstream: 02-build.md
task_id: <taskId>
context_docs: [...]
---
```

用户反馈：「这一块有什么意义吗？」——回看：
- `phase / status`：UI 顶部 PhaseProgress 徽章已经显示
- `task_id`：URL 里有
- `context_docs`：UI 顶部 ContextDocsPanel 完整列出
- `upstream / downstream`：纯架构 metadata、**没有任何代码消费**

**结论**：纯冗余、artifact panel 顶部一大块视觉噪音、删。删完直接从 `# 方案：xxx` 起头。

#### 9. V0.5.5 commit 全景

```
da6e788 feat(v0.5.5): A+B 优化 + SDK 诊断 + SSE 重连 + prompt 瘦身 + revise 分级 + 重启加强
```

> 23 文件 / +899 -540（HANDOFF +182 占大头、代码净减 70 行）。包含 V0.5.5 全部 8 大块改动。

#### 10. V0.5.5 待办（接力 AI / 用户测试）

- **核心待测**：跑完整 plan → build → review、看 V0.5.5 改动是否在用户操作路径上都生效
- ✅ **ask_user 问两轮就停的问题**（§6 末尾遗留）→ **已在 V0.5.6 解决**（用户拍板「无上限 + 加稍后再补充按钮」、见下方 V0.5.6 段）
- **SDK status=ERROR message=(none) 复现**：等下一次 status=error、看 dev server 终端 `[plan-runner] SDK status message: ...` 日志能否拿到 message——拿不到就是 SDK bug、可以反馈 Cursor 团队
- **诊断口扩**：如果下一轮还频发 status=error、考虑在 `case "status"` 同步 publish 一条 `info` 事件（而不只是 console.log）、让用户在前端事件流里也能看到所有 status 跳变

---


### V0.5.4：再聊聊抽组件 + 加贴图 + 弹窗滚动 + hook 复用（2026-05-19 上午）

> 用户上午联测发现 3 个体验问题、顺手抽公共 hook + 加规则。

#### 1. 「再聊聊」输入卡顿（核心修复）

**坑**：用户在「再聊聊」弹窗里打字、明显卡顿。
**根因**：`reviseDraft` state 放在 `TaskDetailPage` 顶层、每次按键触发整页 re-render。`EventStream` 虽然 `memo` 过、但 SSE 持续 `setTask({...prev, events: [...prev.events, ev]})` 让 task 引用持续变化、`memo` 浅比较失效、几百条事件子树参与 reconcile、单次 keystroke > 16ms。
**修法**：抽 `src/components/tasks/revise-dialog.tsx`、`draft` state 下沉到子组件内部、父组件只持 `reviseOpen` + `onSubmit(feedback, images?)`。`memo(ReviseDialogImpl)` 作第二道防线（父 re-render 时 props ref 没变就跳过本组件）。
关键 commit：`e451e73`。

#### 2. 「再聊聊」加贴图（端到端打通）

跟 chat 的贴图链路完全同款：
- 协议层：`ToolReturn.phase_revise` 多 `imagePaths?: string[]`、`formatToolReturnAsText` 在 feedback 后拼 `[ATTACHED_IMAGES]` 段（与 chat 的 user_reply 同款格式、agent 用 `read` 工具看图）
- 后端 API：`phase-ack/route.ts` body 多 `images?: []`、复用 `saveImageAttachments` 落盘、`user_reply.meta.images` 写跟 chat-reply 同款形状（UI 缩略图复用 `extractUserReplyImages`）
- `chat-mcp.ts` `submitPhaseAck(... imagePaths?)` 透传
- `prompts` 一线：`plan-runner.ts` revise 那段加 V0.5.4 段：**「带图时先 `read` 全部图、再 `ask_user` 复述」**、明确禁止「忽略图直接 ask_user」
- 前端：`ReviseDialog` 内嵌贴图 UI（粘贴 / 拖拽 / 选文件 / 缩略图 / 移除）

#### 3. 新建任务弹窗 MCP 多时被挤出屏幕 → 全局 mask 滚动改造（最终态）

**坑**：MCP 服务多、展开后弹窗高度超屏、底部「创建 / 取消」按钮被推出 viewport 看不到。

**演进**：
- 第一版：`NewTaskDialog` 单点修 `max-h-[90vh] overflow-y-auto`（弹窗内部出滚动条）
- 用户拍板：要 **mask 滚（弹窗长在文档流里、超长时整页连同 mask 一起滚）**、不要弹窗内滚
- 最终落地（commit `d413f9b`）：**改全局 `DialogContent` 默认布局**——所有 Dialog 自动获得 mask 滚动、不再需要单独加 max-h / overflow

**关键改动 `src/components/ui/dialog.tsx`**：
- 旧实现：Popup `fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 grid gap-4`、超长内容超屏看不到
- 新实现：
  - `DialogOverlay`（base-ui Backdrop）保留 `fixed inset-0`、只负责视觉遮罩 + click-close
  - **新增 scroll wrapper**：`fixed inset-0 z-50 overflow-y-auto grid place-items-center p-4`（短内容居中、长内容自然撑长 + 整页滚）
  - Popup 改 `relative` + 保留原 `grid gap-4`、随内容高度自然撑
- 注意 base-ui 限制：Backdrop / Popup 是 Portal 内的兄弟节点（不能 Backdrop 套 Popup）、scroll wrapper 必须跟 Backdrop 同层、跟 Popup 是父子

**已知回归 + 修复**（commit `8c4f4d9`）：第一次改造漏带 `grid` className、导致 Popup 内部子项 `gap-4` 失效（block 容器上 gap 是无效 CSS）、子项贴在一起。补回 `relative grid` 共存——`display: grid` + `position: relative` 合法。

**影响范围**：
- 所有 Dialog 自动获得 mask 滚动：`NewTaskDialog` / Settings / `ContextDocsPanel` / `TaskMcpPanel` / `ConfirmDialog` / `PromptDialog` / `FsPickerDialog` / `ApprovePhaseDialog` / `ReviseDialog`
- **`AskUserDialog` 自管布局不受影响**——它显式用 `flex max-h-[80vh] flex-col gap-0 overflow-hidden p-0` 三段布局（sticky header / scroll body / sticky footer）、className 后写 override 掉默认 `grid gap-4 p-4`、新 mask 滚 wrapper 只是把整窗居中、`max-h-[80vh]` 仍然兜住、Q 列表内部滚动行为完全保留
- `DialogFooter` 的 `-mx-4 -mb-4` 依赖父 `DialogContent` 有 `p-4`——新版仍然 `p-4`、不破

**调用方旧的 `max-h-[xx] overflow-y-auto` 应该删掉**（NewTaskDialog 已删）、否则会双层 scroll 体验差。

#### 4. 抽 `useImageAttach` hook（event-stream + revise-dialog 共用）

两处贴图逻辑长得一样、各写一遍 200 行——按用户拍板的新规则（复用 >= 2 且省 30+ 行手工代码 → 抽）抽出。
- `src/hooks/use-image-attach.ts` 新增：state（attachedImages / isDragging / fileInputRef）+ 所有 handler（粘贴 / 拖拽 / 选 / 移除）+ 校验 + `toUploadPayload()`
- `disabled` 选项：调用方未到可输入态时所有 handler 短路
- `ReviseDialog` -130 行 / `EventStream` -155 行 / 净减 60 行手工重复 / bug 以后修一次到位

关键 commit：`69f709a`。

#### 5. ApprovePhaseDialog 不再每次 page re-render 都读 localStorage

`defaultModel` / `apiKey` 之前是 IIFE 每次 page render 都 `getSettings()` 从 localStorage 读 + JSON.parse、SSE 频繁 setTask 时一秒打好几次。改 `useMemo(..., [approveDialogOpen])`、只在 dialog 打开瞬间读一次、关闭后忽略变化。

#### 6. 编码规则补强：减少手戳代码 / 优先复用 + 用成熟库（用户拍板）

`.cursor/rules/learned-conventions.mdc` 「减少 state / 优先用成熟库」段重写、扩三个子节：
- **减少 state**：useState 多 / 派生 state / 不下沉
- **减少重复代码 / 减少手戳方法**（V0.5.4 新加）：同样 handler / UI / 工具函数写两遍就抽；方法体 > 30 行 / 嵌套 > 3 / 单函数 setState > 3 → 拆；避免手撸状态机
- **优先用成熟库**：react-hook-form / @tanstack/react-query / immer / @use-gesture/react / dayjs（已引就直接用、没引但场景合适讨论引入）
- **抽象门槛**：复用 >= 2 且省 30+ 行 → 抽；< 30 行内嵌不抽；修同一类 bug 三次必抽

#### 7. V0.5.3 + V0.5.4 commit 全景

```
8c4f4d9 fix(v0.5.4): DialogContent 补回 grid className（gap-4 间距）
d413f9b feat(v0.5.4): DialogContent 改 mask 滚动（用户拍板方案 A、全局生效）
8b1a167 docs(handoff): 补 V0.5.3 + V0.5.4 演进段
69f709a refactor(v0.5.4): 抽 useImageAttach hook、event-stream + revise-dialog 共用
e451e73 feat(v0.5.4): 再聊聊抽组件 + 加贴图 + 新建任务弹窗整窗滚
cb70090 refactor(v0.5.3): D-1 首页提速 + D-2 删死字段
a15db37 refactor(v0.5.3): 抽 getNextPhase helper + 删死代码 + 注释对齐 V0.5
```

#### 8. 接力 AI 待办

- **真任务联测**（V0.5.2 §11 那些场景）+ **V0.5.4 贴图闭环**：
  - 「再聊聊」贴图（粘贴 / 拖拽 / 选文件）→ 看 agent 是不是**先 `read` 图再 `ask_user`**、还是偷懒跳过
  - mask 滚动跨所有 Dialog 验证：NewTask（MCP 多时）/ Settings / Context Docs / MCP Panel / Confirm/Prompt / FS Picker / Approve / Revise——确认子项间距正常、整窗能滚、不双层 scroll
  - AskUserDialog 自管布局回归测：sticky header / 中间 Q 列表滚 / sticky footer 三段保留
- **首页提速验证**：D-1 改完后用户没明确反馈「快了」、需要联测时确认
- **ask_user「其他答案」框贴图**（用户提议、设计待办、详见 §9）

#### 9. V0.5.7 设计预案：ask_user「其他答案」框支持贴图

> **状态**：用户提议 + 拍板「**每个 question 独立贴图**——做不到就宁可不做」、设计已对齐、**未实施**、延后到 V0.5.7（原本规划在 V0.5.6 号、但 V0.5.5 测完后用户先拍了「ask_user 无次数上限 + 稍后再补充」、那批落到了 V0.5.6、贴图顺延到 V0.5.7、等 V0.5.6 测稳再开）。

**为什么要做**：HITL 通道统一行为——`revise` / `chat-reply` 都允许贴图、唯独 `ask_user` 不允许、语义割裂。典型场景：AI 问「这个组件做 A/B/C/D 哪种」、用户想说「都不是、看截图我要 E」——贴图比文字直接得多。

**用户硬约束**（拒绝简化方案）：

| 方案 | 用户态度 | 理由 |
|---|---|---|
| 整批 ask 共用一组图（max 6） | ❌ **拒绝** | 「语义模糊、不知道图是给哪个问题的、宁可不做、走 ack 后再聊聊补图」 |
| 每 question 独立图集（max 6 / question） | ✅ **要做** | 「图绑特定 question、agent 不用猜归属」 |

**技术难点 + 解法**：

React Hooks 规则禁止在 map / 循环里动态调用 hook、所以「每 question 一个 `useImageAttach` instance」走不通。解法是**升级 `useImageAttach` 成多 key 图集**：

```ts
// 现状（V0.5.4、单 key）：
const { images, onPaste, removeImage, ... } = useImageAttach();

// V0.5.7（多 key、向后兼容）：
const attach = useImageAttach();
attach.getImages('q1');                    // 取 q1 的图
attach.onPaste(e, 'q1');                   // q1 贴图
attach.removeImage(0, 'q1');               // 删 q1 第 0 张
// 老调用方（ReviseDialog / EventStream）不传 key → 走 'default' → API 不变
```

**改动量预估**（≈ 235-255 行、跨 6 文件）：

| 文件 | 改动 |
|---|---|
| `src/hooks/use-image-attach.ts` | 内部 state 改 `Record<key, PendingImage[]>`、API 加 `key?` 默认 `'default'` ≈ 60-80 行重写 |
| `src/components/tasks/ask-user-dialog.tsx` | 每 question「其他答案」展开时附 attach 按钮 + 缩略图条 ≈ 60 行 |
| `src/lib/task-store.ts` | `submitAskReply` 加 `imagesByQuestion?: Record<string, ChatReplyImage[]>` ≈ 5 行 |
| `src/app/api/tasks/[id]/ask-reply/route.ts` | 按 questionId 分组校验 / 保存 + meta 分组 ≈ 70 行 |
| `src/lib/server/chat-mcp.ts` | `imagePathsByQuestion?` 参数 + 每 question reply 拼 `[ATTACHED_IMAGES for Qx]` ≈ 25 行 |
| `src/lib/server/plan-runner.ts` | prompt 增加「ask_user reply 按 Q 号各自 read 图、综合判断意图」≈ 15 行 |

**风险**：
1. **`useImageAttach` 是 V0.5.4 刚抽的 hook**——升级要确保 ReviseDialog / EventStream 两个老用户不退化、上 + 手测两条路径
2. **AskUserDialog 布局变长**——「其他答案」展开 + 缩略图条 + 多 question 场景、`max-h-[80vh]` 内部 scroll body 要兜得住
3. **agent prompt 复杂度**——「N 个 question 各带图集」对 agent 读图调度要求更高、要给清楚示例（建议给一段「3 个 question、Q1/Q3 带图」的标准处理流）

**节奏拍板**：等 V0.5.6 + V0.5.5 + V0.5.4 测稳再开 V0.5.7、避免叠改难定位 bug。

---


### V0.5.3：refactor / 性能 / 死代码清理（2026-05-18 晚 ~ 2026-05-19 早、不破功能）

> V0.5.2 联测过程中扫了一遍代码、发现几处过期注释 / 死字段 / 重复逻辑 / 首页慢、批量清掉。

#### 1. `getNextPhase(workflowDef, current)` helper（去重 `indexOf + idx+1` 三处）

`plan-runner.ts` / `phase-ack/route.ts` / `approve-phase-dialog.tsx` 各自 inline 一段 `workflowDef.phases.indexOf(current) + 1` → 抽到 `src/lib/types.ts` 一个 helper、三处都改用。同时删 `task-store.ts` 里 `FEISHU_WORKFLOW_NEXT_PHASE` 死表（漏网常量、没人 import）。
关键 commit：`a15db37`。

#### 2. D-1：首页加载慢——`listTasks` 不再 hydrate 全量 `events` / `artifact`

**坑**：首页任务列表慢、用户实测「确实慢」。原因：`listTasks` 对每个任务都 `hydrateTask`、跑 `readEvents`（jsonl 全文 parse）+ `readArtifact` × N phases 的 IO + JSON.parse。N 个任务 → N×5 文件 IO + N 次 jsonl 全解析。
**修法**：
- `src/lib/types.ts` 加 `TaskSummary = Omit<Task, "events" | "phases">`、首页只需要这部分字段
- `src/lib/server/task-fs.ts` 加 `hydrateTaskSummary`、`listTasks` 改返 `Promise<TaskSummary[]>`、跳过 events / artifact 读
- `src/lib/task-store.ts` `fetchTasks` 改返 `TaskSummary[]`
- `src/app/page.tsx` + `src/components/tasks/task-card.tsx`：state 改 `TaskSummary`、`canArchive` 入参改 `TaskSummary`

#### 3. D-2：删死字段 `attachedDocs` / `swaggerUrl`

V0.3 上下文文档机制已统一走 `contextDocs`、`attachedDocs` / `swaggerUrl` 仅在 schema / API 留着、UI / agent prompt 都没用。直接删：
- `src/lib/types.ts`：`Task` / `NewTaskInput` / `WorkflowDef.requiredFields` 去掉
- `src/lib/server/task-fs.ts` `TaskMeta` 去掉、`hydrateTask` / `createTask` 不再写
- `src/app/api/tasks/route.ts` POST 不再解析
- `src/lib/server/plan-runner.ts` 模板渲染去掉对应变量

D-1 + D-2 一起在 `cb70090`。

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


