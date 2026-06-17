// ===========================================
// 基础配置类型：仓库 / 模型 / Settings
// ===========================================

/**
 * 仓库配置（V0.5.9 多仓引入）
 *
 * V0.6.3 重新引入「线上分支」（曾在 V0.6 删过、当时叫 mainBranch 让 agent 探）：
 *   - mainBranch（默认分支）≠ 线上分支：后端默认分支常是 develop、但 feature 要从
 *     master / release（线上）拉、探 origin/HEAD 拿到的是 develop（错）、故让用户按仓手填
 *   - 前端常见 master = 默认 = 线上、留空即可、build 时 agent 探 origin/HEAD 兜底
 *   - 这份配置在 settings（localStorage）、建 task 时快照进 task.repoBaseBranches 给 server 用
 */
export interface RepoConfig {
  name: string;
  path: string;
  /** V0.6.3：feature 拉取基线 = 线上分支（如 master / release）、留空则 build 时 agent 探 origin/HEAD */
  onlineBranch?: string;
  /**
   * V0.6.7：测试分支 = ship 提测 MR 的目标分支（如 test / testing / qa）
   * - 留空则 ship 回退默认 `test`（兼容老工作流）
   * - per-repo：不同仓测试分支名可能不同（后端 ≠ 前端）
   */
  testBranch?: string;
  /**
   * V0.6.7：dev 分支（如 develop）——当前仅存配置、暂无固定用途（联调场景预留）
   */
  devBranch?: string;
  /**
   * V0.6.7：feature 分支命名模板覆盖（per-repo、留空则用 settings.branchTemplate 全局默认）
   * 占位符见 branch-template.ts：{username} / {storyId} / {taskTitle} / {date:MM-dd}
   */
  branchTemplate?: string;
  /**
   * V0.6.25 CheckRun：本仓「确定性校验命令」清单（per-repo、build 后 runner 自动跑）
   * - 建 task 时快照进 task.repoCheckCommands（settings 在 localStorage、server 读不到）
   * - 留空 / 不配 → 该仓 build 后 check 记 not_configured、不阻塞 ship（不是 failed）
   */
  checkCommands?: CheckCommand[];
}

/**
 * V0.6.25 CheckRun：一条「确定性校验命令」配置（per-repo、build 后由 runner 自动跑）
 *
 * 设计背景（对齐 V0.6.3 撤掉 build 写死 check 的教训）：
 * - 当年 runner 写死 `pnpm typecheck/lint` 对多技术栈（Java / Go）误报、被撤掉。
 * - 现在改成「用户 per-repo 配命令」：前端配 pnpm、Java 配 mvn、没配就跳过、绕开「写死搞死多栈」。
 *
 * - kind：仅用于 UI 分组 + 给默认 timeout（不影响执行逻辑、custom 给最大自由度）
 * - required：失败是否阻塞 ship gate（false = 仅展示、不挡提测、给「可选 check」用）
 * - timeoutMs：留空按 kind 给默认（typecheck/lint 短、unit-test/build 长）、超时算 failed
 * - cmd：走 `sh -c` 执行、支持 `pnpm typecheck && pnpm lint`、`cd sub && pnpm test` 这种组合
 */
export type CheckCommandKind =
  | "typecheck"
  | "lint"
  | "unit-test"
  | "build"
  | "custom";

export interface CheckCommand {
  name: string;
  cmd: string;
  kind: CheckCommandKind;
  required: boolean;
  timeoutMs?: number;
  /**
   * V0.6.26：命令来源——manual（设置页手动配、建 task 快照）/ auto（建 task 时按 repo 文件结构自动识别）
   * - 不影响执行、纯审计 + 未来 UI 区分「自动识别 / 手动配置」徽章用
   * - 落库时由 task-fs.sanitizeCheckCommands 统一打标（手动→manual、检测→auto）、不信 client 传值
   */
  source?: "manual" | "auto";
}

/** CheckCommand kind 中文标签（repo-card 配置 + check 结果展示共享单一源） */
export const CHECK_COMMAND_KIND_LABEL: Record<CheckCommandKind, string> = {
  typecheck: "类型检查",
  lint: "Lint",
  "unit-test": "单元测试",
  build: "构建",
  custom: "自定义",
};

/** 各 kind 的默认超时（ms）——typecheck/lint 短、测试 / 构建给长、custom 居中 */
export const CHECK_KIND_DEFAULT_TIMEOUT_MS: Record<CheckCommandKind, number> = {
  typecheck: 120_000,
  lint: 120_000,
  "unit-test": 600_000,
  build: 600_000,
  custom: 300_000,
};

/**
 * 用户最终选定的模型（含参数）
 * Schema 跟 SDK ModelSelection 同步、agent 启动时直接传过去。
 */
export interface ModelSelection {
  id: string;
  params?: Array<{ id: string; value: string }>;
}

/**
 * settings：localStorage 持久化的用户配置
 * V0.6 新增 username：用于 ship action 的 branch prefix
 *   （branch 模板 = `feature/<username>/<飞书id>-<task.title>`、多人用 ai-flow 不互踩）
 * V0.6.1 新增 gitHost + gitToken：ship action 走 server 内置 GitLab REST API、
 *   不依赖外部 glab CLI；当前公司场景所有仓共用同一个 GitLab 实例、所以是全局字段。
 */
/**
 * 代码跳转目标 IDE（2026-06-12 加、用户要求支持 IDEA）
 * - cursor：`cursor://file/<path>:<line>`
 * - idea：`idea://open?file=<path>&line=<line>`（需装 JetBrains Toolbox 或 IDE 自带协议）
 */
export type JumpIde = "cursor" | "idea";

export const JUMP_IDE_LABEL: Record<JumpIde, string> = {
  cursor: "Cursor",
  idea: "IDEA",
};

export type SubmitShortcut = "mod-enter" | "enter";

export interface FeAiFlowSettings {
  apiKey: string;
  defaultModel: ModelSelection;
  username?: string;
  /** 代码路径点击跳转的 IDE、默认 cursor */
  jumpIde?: JumpIde;
  /** 输入框提交快捷键：默认 Cmd/Ctrl+Enter，Enter 换行 */
  submitShortcut?: SubmitShortcut;
  /**
   * V0.6.1 ship：GitLab 自建实例 host（如 `gitlab.wukongedu.net`、不带 https://）
   * 空时 ship action 准入会拦、提示用户先配
   */
  gitHost?: string;
  /**
   * V0.6.1 ship：GitLab Personal Access Token（`glpat-` 开头）
   * 明文 localStorage、跟 apiKey 同安全级别——别在共用机器配
   */
  gitToken?: string;
  repos: RepoConfig[];
  /**
   * V0.6.7：全局默认 feature 分支命名模板（per-repo 没配 branchTemplate 时用这份）
   * 默认 `feature/{username}/{storyId}-{taskTitle}`、占位符见 branch-template.ts
   */
  branchTemplate?: string;
  /**
   * V0.6.5：设置页配的「常用 MCP」默认黑名单——建任务时取这份快照作默认禁用、
   * 省得每次新建都手动关一堆不常用的。新增 server 不在黑名单 = 默认开。
   */
  disabledMcpServers?: string[];
}

/**
 * 单个模型可调参数定义（如 "thinking"）
 * Schema 来自 SDK ModelParameterDefinition、不要随意改。
 */
export interface ModelParameter {
  id: string;
  displayName?: string;
  values: Array<{
    value: string;
    displayName?: string;
  }>;
}

/**
 * 模型预设组合（如 "Opus 4.7 thinking xhigh"）
 * SDK 直接返、用户选 variant 时可以直接拿到完整 params 数组。
 */
interface ModelVariant {
  params: Array<{ id: string; value: string }>;
  displayName: string;
  description?: string;
  isDefault?: boolean;
}

export interface ModelOption {
  id: string;
  displayName: string;
  description?: string;
  parameters?: ModelParameter[];
  variants?: ModelVariant[];
}

// ===========================================
// V0.6 任务模型：task 容器 + action 历史
// ===========================================
//
// 设计原则（详见 docs/V0.6-REFACTOR.md、已 archived）：
// 1. task = 一个需求的完整生命周期容器（飞书 story 进来 → 合入 main / abandon）
// 2. action = task 内的单次动作（plan / build / review / ship / test / learn；chat 走独立 mode）
//    - 自由触发顺序（不强制 plan→build→review、靠 6 个 harness 门槛兜底质量）
//    - N 累计序号、文件名 actions/N-<type>.md（cancelled 也占 N、不释放）
// 3. 单 SDK Run 永生（task 不终态 Run 不退、wait_for_user 阻塞等下一 action 指令）
// 4. 不写 V0.5 → V0.6 migration 脚本、V0.5 老 task 数据靠 listTasks 自动跳过（schema 不匹配的 meta.json 在 hydrate 时被 skip）

/**
 * 6 种 action 类型（V0.6.0.1 起 chat 从 action 里剥离、走独立 mode=chat 通路）
 * - `plan`     出方案
 * - `build`    改代码
 * - `review`   复核（plan/build 差异核对 + fresh peer bug 复审）
 * - `ship`     提测（push 改动 + 提 MR 到 test 分支 + 飞书 story 评论 @ 测试人员）
 * - `test`     AI 手测
 * - `learn`    沉淀
 */
export type ActionType =
  | "plan"
  | "build"
  | "review"
  | "ship"
  | "test"
  | "learn";

export const ACTION_TYPES = [
  "plan",
  "build",
  "review",
  "ship",
  "test",
  "learn",
] as const;

/**
 * action 中文 label（UI 选 action / timeline 展示用、统一来源）
 */
export const ACTION_LABEL: Record<ActionType, string> = {
  plan: "出方案",
  build: "改代码",
  review: "复核",
  ship: "提测",
  test: "AI 手测",
  learn: "沉淀",
};

/**
 * 每个 action 推进时「是否默认强起一个全新 agent（fresh）」的默认值（V0.6.9）
 *
 * 背景：task 默认复用同一个 agent 跑完所有 action（省 Cursor 计费）。但因为每一步都落
 * artifact（md），「聊天记忆」其实不重要，所以每个 action 可以按它自己的作用，独立决定
 * 「复用上一个 agent」还是「强起 fresh agent」。
 *
 * V0.6.27 默认反转：**全部 action 默认 fresh**（原来只有 review fresh、其余复用）。理由：
 * - context 膨胀是「跑偏」的物理根源（lost in the middle）——单 Run 跑全 task 几十轮工具调用后、
 *   super prompt 开头的规则遵循率必然下降、改 prompt 措辞治不了、截断 context 才能
 * - artifact 本来就是 action 间唯一合法通信媒介、新 agent 冷启动所需上下文全量可重建
 *   （review forceNewAgent 自 V0.6.9 已验证这条路可行且效果更好）
 * - 连带收益：super prompt 不再全量注入 6 个 playbook、只注入当前 action 的（体积 -60%+）
 * - review = true 是铁律（「换人复审」绕开自己审自己、UI 勾「续用」也压不掉）
 *
 * 生效逻辑见 task-runner.advanceTask：`effective = !reuseAgent || ACTION_FRESH_AGENT_DEFAULT[type]`
 * ——UI「续用当前 agent」开关是例外逃生口（省 send 配额 / 需要连续上下文时手动勾）、
 * 这张表里 true 的 action 即使勾了续用也强起 fresh。
 */
export const ACTION_FRESH_AGENT_DEFAULT: Record<ActionType, boolean> = {
  plan: false,
  build: false,
  review: true,
  ship: false,
  test: false,
  learn: false,
};

/**
 * action 状态机
 * - running：agent 正在跑该 action
 * - awaiting_ack：跑完 artifact 已落、等用户 ack
 * - completed：用户 approve、后续 action 可基于本 action artifact 推进
 * - error：后置检查失败 / agent 报错
 * - cancelled：用户中途取消（N 不释放、避免 race）
 */
export type ActionStatus =
  | "running"
  | "awaiting_ack"
  | "completed"
  | "error"
  | "cancelled";

/**
 * V0.6.23：批次测试策略（自适应 TDD、不强制）
 * - tdd：先写测试看失败再实现（逻辑密集批：数据转换 / 工具函数 / 接口逻辑）
 * - after：实现完补测试（一般业务批）
 * - none：免测（纯样式 / 文案 / 配置批）
 * plan 给每批标一个、build 跑该批时按策略走（tdd 批引导「先写测试看红 → 实现到绿」）。
 * why 自适应不强制：我们前端为主、UI/交互很难先写测试、强制 = 为凑测试而写测试（对齐 Spec Kit「TDD 可选」）。
 */
export type TestStrategy = "tdd" | "after" | "none";

/** 测试策略中文标签（plan artifact / UI 展示共享单一源） */
export const TEST_STRATEGY_LABEL: Record<TestStrategy, string> = {
  tdd: "先写测试（TDD）",
  after: "实现后测试",
  none: "免测",
};

/**
 * V0.6.23：plan 产出的「批次」——大需求在 task 拆分之上再加一层「可独立交付的功能块」。
 *
 * 背景：一个大飞书需求 plan + 单次 build 跑完不保险（上下文越长 agent 越容易跑乱、质量滑）。
 * 对齐 Superpowers/GSD「分批 + 每批换新 Agent」思路、但全程留在**一个 task** 里（不拆多任务、用户硬要求）。
 *
 * - id：plan 内唯一（如 "b1" / "b2"）——build 推进时用户勾选 + 进度推导都靠它
 * - title：一句话功能块标题（如「接口层 + 数据转换」）
 * - testStrategy：这批的测试策略（自适应 TDD、见 TestStrategy）
 * - taskRefs：这批包含 plan §5 的哪些 task（如 ["Task 1", "Task 2"]、给人看 + build 定位范围）
 *
 * 存储：plan agent 写完 artifact 调 MCP `set_plan_batches` 上报、落到该 plan ActionRecord.planBatches
 *（跟 submit_mr / set_feishu_testers 同套路、不靠解析 markdown）。
 */
export interface PlanBatch {
  id: string;
  title: string;
  testStrategy: TestStrategy;
  taskRefs: string[];
}

/**
 * V0.6.25 CheckRun：单条 check 命令的执行结果
 * - status：passed（exit 0）/ failed（exit≠0）/ timed_out（超时强杀）/ skipped（预留、暂不用）
 * - mutatedWorktree：跑完该仓 tracked 文件被改了（命令偷改源码、如手滑配了 --fix）→ 视为不可信、判 failed
 * - logTail：末尾若干行（UI 摘要直接看）、完整输出在 CheckRepoResult.logPath 文件里
 */
export interface CheckCommandResult {
  name: string;
  cmd: string;
  kind: CheckCommandKind;
  required: boolean;
  status: "passed" | "failed" | "timed_out" | "skipped";
  exitCode: number;
  durationMs: number;
  mutatedWorktree: boolean;
  logTail: string;
}

/**
 * V0.6.25 CheckRun：单仓 check 结果
 * - status：
 *   · passed —— 所有 required 命令过、且没有命令污染工作区
 *   · failed —— 有 required 命令挂、或任一命令污染了工作区（mutated 无视 required、独立安全语义）
 *   · not_configured —— 没配 check 命令、但本仓**被本次 build 改过（dirty）**（= 改了没检查、ship 要 override）
 *   · skipped —— 没配 check 命令、且本仓**没被改过（clean）**（= 没碰不用检查、不拉低整体）
 * - headCommit：跑 check 时该仓 `git rev-parse HEAD`（非 git 仓为 null）
 * - worktreeFingerprint：跑 check 时该仓「工作区内容指纹」= sha256(headCommit + tracked diff + untracked 文件内容 hash)
 *   ship gate 前重算比对——不一致 = check 后工作区又变了、旧 checkRun 不能代表当前要 ship 的内容（非 git 仓 null）
 * - logPath：相对 data/tasks/<id>/ 的完整日志文件路径（所有命令输出拼一起、null = 没产出日志）
 */
export interface CheckRepoResult {
  repoPath: string;
  status: "passed" | "failed" | "not_configured" | "skipped";
  headCommit: string | null;
  worktreeFingerprint: string | null;
  logPath: string | null;
  commands: CheckCommandResult[];
}

/**
 * V0.6.25 CheckRun：一次 build 后置 check 的整体摘要（挂 ActionRecord.checkRun）
 * - id：本次 checkRun 唯一 id——ship override 绑这个、重 build 换新 id 后旧 override 自动失效
 * - status 聚合：任一 repo failed → failed；任一 repo not_configured（没配 check 但被本次 build 改过）→ not_configured；否则 passed（含没改的 skipped 仓）
 * - 完整命令日志落 data/tasks/<id>/actions/.checks/<actionId>/<repo>.log、这里只存摘要（meta.json 不撑大）
 */
export interface CheckRunSummary {
  id: string;
  status: "passed" | "failed" | "not_configured";
  startedAt: number;
  endedAt: number;
  repos: CheckRepoResult[];
}

/**
 * V0.6.25 CheckRun：ship gate override（per-ship、风险接受记录、不是偏好设置）
 *
 * 背景：build 的 check failed / not_configured 时 ship gate 默认拦。但 HITL 底线 = 用户永远能强推。
 * override 让用户「知情后仍 ship」、但必须留痕：
 * - 绑 checkRunId + buildActionId：重 build（换新 checkRun）后这条自动失效、要重填
 * - 工作区是否仍是 check 过的内容由 server 重算 worktreeFingerprint 判定、不信 client 上报
 * - reason：必填、进 ship action 审计（为什么明知 check 没过还提测）
 */
export interface CheckOverride {
  checkRunId: string;
  buildActionId: string;
  reason: string;
  createdAt: number;
}

/**
 * V0.6.25 review：ship 前置预检结果（GET /api/tasks/[id]/ship-precheck 返回）
 *
 * 纯 UI 展示用——advance-dialog 据此决定是否显示 override 区、不再自己用 checkRun.status 猜。
 * gate 逻辑单一源在 server（checkShipCheckGate）、client 拉结论。
 * ⚠ 不是最终授权：/advance 的 ship 分支会再跑一次 gate（防 precheck 到 submit 之间又改工作区）。
 *
 * - needsOverride：最新 build 的 check 没过 / 没配 / 工作区指纹变了 → ship 需勾 override
 * - reason：需要 override 的原因（needsOverride=false 时为空）
 * - buildActionId / checkRunId：给 client 构造 CheckOverride 绑定用（没 build 时 null）
 * - reviewMissing：最新 build 之后没有 completed review（V0.6.27 F3）——**非阻断**、
 *   只在 dialog 展示一行提醒（HITL：用户有权跳过 review 直接提测、但要知情）
 */
export interface ShipPrecheck {
  needsOverride: boolean;
  reason: string;
  buildActionId: string | null;
  checkRunId: string | null;
  reviewMissing: boolean;
}

/**
 * 单条 action 记录
 *
 * - id：任务内唯一（如 act_1 / act_2、生成时单调递增不复用）
 * - n：累计序号、对应文件名 actions/N-<type>.md（不释放、cancelled 也占）
 * - userInstruction：用户在推进 dialog textarea 写的指令（首次 plan 可能为空）
 * - artifactPath：相对 data/tasks/<id>/、如 "actions/1-plan.md"；action 没产物时为 null
 */
export interface ActionRecord {
  id: string;
  n: number;
  type: ActionType;
  status: ActionStatus;
  userInstruction: string;
  artifactPath: string | null;
  startedAt: number;
  endedAt: number | null;

  /**
   * V0.6.28：action 创建时的 effective cwd 快照（= 当时 getEffectiveCwd(task.repoPaths)）
   * - why：task 支持中途追加仓库后、effectiveCwd 会从单仓自身变成公共父目录、
   *   artifact 里 agent 写的相对路径基准随之漂移；前端渲染 cursor:// 链接必须用
   *   「artifact 写入时」的基准而不是实时计算值、否则改仓后老 artifact 链接集体失效
   * - 老数据没这字段 → 前端回退实时 getEffectiveCwd（改过仓的老 task 接受历史链接漂移）
   */
  cwd?: string;

  /**
   * artifact 文件最后一次成功写入的时间戳（V0.6.12）
   * - agent 每次 write/edit 写成功（SDK tool done = 文件已落盘）后端就刷新这个字段并推 action 帧
   * - 前端 artifact 面板 effect 依赖它 → 事件驱动重拉、不再靠固定退避猜「文件啥时候落盘」
   * - 根治「artifact 产出后页面停在『没有产物』、要切 tab / 刷新」（前 3 次靠 SSE 重连 / 退避都治标）
   */
  artifactUpdatedAt?: number;

  /**
   * 软删标记（V0.6.x「划除」）——用户主动把这个 action 从 agent 上下文里排除
   * - 区别于 status=cancelled（中途停了没跑完）：excluded 是「不管跑没跑完、用户判定它冗余/跑歪、别再进上下文」
   *   （所以是独立 flag、不是 status 的一个值——一个 completed 的 action 也能被 excluded）
   * - renderActionHistorySection 跳过它（不进 prompt、不引导 read artifact）→ 治本上下文污染
   * - 数据 / artifact / events 全部物理保留、UI 划线展示、可一键恢复（可逆、比真删安全）
   */
  excluded?: boolean;

  /**
   * 后置 deterministic 检查（V0.6 门槛 2）
   * - plan: artifact 文件存在 + 内容长度 >= 100 + 必备段（需求理解 / Task 拆分、V0.6.27）
   * - build: V0.6.25 CheckRun——per-repo 跑 checkCommands、passed/details 是聚合摘要、明细看 checkRun 字段
   * - review: 基底 commit 一致 + 必备段非空 + bug 复审段非空（V0.6.9 fresh peer 阶段二）
   *   + 工作区指纹未变（V0.6.27、review 只读硬校验）
   * - ship（V0.6.1）：需提 MR 的仓都有 task.mrs 记录 + URL 非空、跳过仓有原因
   * - test: pass 率 ≥ 阈值
   * - learn: propose 段有内容 + evidence 路径都能 read 到
   */
  postCheck?: {
    passed: boolean;
    details: string;
  };

  /**
   * V0.6.27：action 启动时记录的工作区基线（path → 指纹 / 状态 hash）、后置检查比对用
   * - review action：key = task 各仓 path、value = worktreeFingerprint——checkReview 重算比对、
   *   不一致 = agent 在 review 期间改了代码（review 只读铁律从 prompt 软约束升级硬校验）
   * - build action：key = effective cwd 下「非本 task 的兄弟 git 仓」path、value = git status hash——
   *   checkBuild 重算比对、变了 = agent 越权改了兄弟仓（多仓 cwd=公共父目录的 harness 缺口）
   * - 记录失败（非 git 仓 / 命令失败）的仓不进 map、检查端对缺 key 跳过比对（fail-open）
   */
  startBaseline?: Record<string, string>;

  /**
   * V0.6.25 CheckRun：build action 的确定性校验结果摘要（只 build action 有）
   * - runner 在 build agent 调 wait_for_user 时自动跑（复用 postCheck 钩子、见 action-checks.checkBuild）
   * - 完整命令日志落文件、这里只存结构化摘要（per-repo per-command pass/fail + 日志路径）
   * - ship gate 读「最新 completed build 的 checkRun.status」决定是否拦
   */
  checkRun?: CheckRunSummary;

  /**
   * V0.6.25 CheckRun：ship action 的 gate override（只 ship action 有、用户强推时记）
   * - build 的 check failed / not_configured 时、用户在 ship dialog 勾「仍继续」+ 填 reason → 落这里
   * - 绑 checkRunId、重 build 后失效（见 CheckOverride）
   */
  checkOverride?: CheckOverride;

  /**
   * 副作用记录（对外部世界的影响）
   *
   * V0.6.1：ship 改成多仓数组——同一 ship action 多仓场景产出 N 条 MR、一仓 1 条记录
   * - test: agent 起服务 / 用例结果摘要（V0.6.2 上线时再细化字段）
   */
  sideEffects?: {
    mrs?: Array<{
      repoPath: string;
      mrUrl: string;
      mrVersion: number;
      branch: string;
      commitHash: string;
      /** V0.6.1.1：本次 ship 该仓 MR 跟 test 是否有冲突（true 时 ship 不发飞书评论、checkShip 判不干净） */
      hasConflicts?: boolean;
    }>;
  };

  /**
   * V0.6.23：plan action 产出的批次清单（plan agent 调 set_plan_batches 上报、只 plan action 有）
   * - build 选批 + 进度推导都基于「最新 completed plan 的 planBatches」
   * - 空 / 不存 = 这次 plan 没拆批次（小需求、build 默认全做、退化成老流程）
   */
  planBatches?: PlanBatch[];

  /**
   * V0.6.23：build action 本次「做哪些批次」——推进 build 时用户在 dialog 勾选、advance 时后端直接存
   * - 不靠 agent 上报（省一个 MCP 工具）：build agent 从 NEXT_ACTION 指令读做哪批、老实做完
   * - 进度推导：已做批 = ∪(completed build 的 requestedBatchIds)、总批 = 最新 plan.planBatches
   * - 空 / 不存 = 无批次的 plan、或自由改动（V0.6.29 批次选填：不勾批 = 修 bug / 跨批散改、不计进度）
   */
  requestedBatchIds?: string[];

  /**
   * 模型选择（V0.6 推进 dialog 高级选项支持切模型）
   * - 不存 = 沿用 task.model / settings.defaultModel
   */
  agentModel?: ModelSelection;

  /**
   * artifact 修订快照清单（V0.5.12 沿用、V0.6 由 phase 维度改 action 维度）
   * - 用户「再聊聊」前后端先 snapshot 当前 artifact、复制到 actions/.revisions/<actionId>/<ISO>.md
   * - 每条 action 上限 10、GC 删最老
   */
  revisions?: ArtifactRevision[];
}

/**
 * MR 记录（ship action 跑完落、polling 状态更新留 V0.6.4+）
 *
 * V0.6.1 拍板：
 * - 多仓 task → 每仓 1 条记录、按 repoPath 区分（一个 task.mrs[] 数组可能 N 条）
 * - 同 repoPath 多次 ship → 同名 branch 累计 commit、跳过 createMR、
 *   只更新 version / lastCommitHash、`createdAt` 保持首次值
 * - title 落到字段里是为了列表 / 详情页直接展示、不用每次拉 GitLab API
 */
export interface MRRecord {
  /**
   * V0.6.1：关联到 task.repoPaths 里的某个仓、单仓 task 时 = task.repoPaths[0]
   */
  repoPath: string;
  /**
   * 本仓累计 push 次数（首次 createMR 时 = 1、之后每次 ship 都 ++）
   * 跟 GitLab MR ID（iid）没关系、只是 ai-flow 内部计数
   */
  version: number;
  url: string;
  /**
   * V0.6.1：MR 标题（task 卡片 / 详情页直接显示、不用每次拉 GitLab API）
   */
  title: string;
  branch: string;
  status: "open" | "closed" | "merged";
  createdAt: number;
  /**
   * V0.6.1：status 转 merged 时记 timestamp、统计「ship → merge 耗时」用
   * 当前 V0.6.1 不实现 polling、只在用户手动 mark-merged 时更新
   */
  mergedAt?: number;
  /**
   * V0.6.1：当前最新 commit hash（每次 ship push 后更新）
   * version 是「push 次数」、lastCommitHash 是「当前最新 commit」、互补
   */
  lastCommitHash?: string;
  /**
   * V0.6.1.1：本仓 MR 跟 target(test) 是否有冲突
   * 每次 ship push 后 server poll GitLab detailed_merge_status 写入：
   * - true：feature 跟 test 冲突、待用户手动解决（AI 绝不 merge/rebase test→feature）；
   *   有冲突时 ship 不发飞书评论（不能让测试人员收到合不了的 MR）、checkShip 也判 ship 不干净
   * - false：可干净合 / 无冲突
   * - undefined：还没检测 / GitLab 还在异步算（undetermined）
   */
  hasConflicts?: boolean;
  /**
   * V0.6.1.1：GitLab detailed_merge_status 原值（mergeable / conflict / ci_must_pass / checking ...）
   * 留作审计 + UI 展示「为什么没法合」
   */
  mergeStatus?: string;
  createdByActionId: string;
}

/**
 * Git branch 状态（build 第一次跑前生成、不可改写）
 *
 * 时机（V0.6.1 起为每仓 1 条）：
 * - plan action 不建 branch（plan 不写代码）
 * - build action 第一次跑前、runner 检测 task.gitBranches 是否覆盖所有 repoPath
 *   → prompt inject「逐仓先 `git checkout -b <name> origin/<baseBranch>`、再写代码」
 *   → agent shell 跑、跑完 patch 对应仓的 checkedOut=true
 * - 多仓 task：每仓 1 条 GitBranchInfo、name 同名、base branch 各仓自探
 * - 后续 build / ship 都复用同一条 branch（V0.6.1：每仓同名 branch、累计 commit、单仓 1 MR）
 *
 * 命名规则（V0.6 拍板、V0.6.1 沿用）：
 *   name = `feature/<username>/<飞书 story id>-<task.title>`（多仓共用同一 name）
 *   - username 取自 settings.username
 *   - 飞书 story id 从 task.feishuStoryUrl 抠（URL 末段数字）
 *   - task.title 保留中文、非法字符（\s / : * ? " < > | 【 】 ( ) 等）换成 -
 *   baseBranch 由 agent 启动 build 时自己探测（origin/HEAD 或 git remote show）、不在 settings 里配
 */
export interface GitBranchInfo {
  /**
   * V0.6.1：关联到 task.repoPaths 里的某个仓、多仓 task 时区分用
   * 单仓 task 时 = task.repoPaths[0]
   */
  repoPath: string;
  name: string;
  baseBranch: string;
  checkedOut: boolean;
  createdAt: number;
}

/**
 * task 级仓库状态机（跟 MR 生命周期对齐）
 *
 * 状态转移（用户 ack dialog 拍板）：
 *   developing → ship → awaiting_test → (has_bug → build → ship)* → merged
 *   任何状态可转 abandoned
 */
export type RepoStatus =
  | "developing"
  | "awaiting_test"
  | "has_bug"
  | "merged"
  | "abandoned";

/**
 * task 级 runtime 状态（独立于 repoStatus）
 *
 * - idle：当前没 action 在跑、等用户推进
 * - running：有 action 在跑
 * - awaiting_user：action 跑完 artifact 已落、等 ack（或在 ask_user）
 * - error：action 报错、用户可推进重试 / abandon
 */
export type RunStatus = "idle" | "running" | "awaiting_user" | "error";

// ===========================================
// 上下文文档（V0.3、V0.6.0.1 加 image 类型）
// ===========================================
//
// 用户在任务详情页随时加 / 删上下文（飞书文档 URL / 本地路径 / 自由文本 / 截图）、
// agent 在 super-prompt 里看到清单、但内容不全量 inject：
//  - url 类型：agent 用 feishu-mcp / fetch 工具按需拉
//  - path 类型：agent 用 SDK 内置 `read` 工具按需读
//  - text 类型：内容 ≤ 1000 字默认直接 inject、> 1000 字截断
//  - image 类型（V0.6.0.1）：content 是图片绝对路径、agent 用 `read` 工具读、SDK 自动转 vision

export type TaskContextDocType = "url" | "path" | "text" | "image";

export interface TaskContextDoc {
  id: string;
  title: string;
  content: string;
  type: TaskContextDocType;
  createdAt: number;
}

// ===========================================
// 任务角色（V0.4、保留）
// ===========================================
//
// 飞书 story 是「跨角色共享」的、每个研发只关心 story 里跟自己角色相关的部分。
// 当前枚举 `fe` / `be` / `adaptive`、未来扩 data / mobile-ios / mobile-android / qa（详见 docs/MULTI-ROLE.md）。
// adaptive（自适应）：不锁端、agent 按仓库技术栈（package.json=前端 / pom.xml=Java 后端 / go.mod=Go 后端 等）+ story 自己定位本仓库该用什么视角、再按那个视角做（给「全栈仓 / 不确定 / 懒得纠结」用）。

export type TaskRole = "fe" | "be" | "adaptive";

export const TASK_ROLE_LABEL: Record<TaskRole, string> = {
  fe: "前端",
  be: "后端",
  adaptive: "自适应",
};

// ===========================================
// 事件流（V0.6：phase_* → action_*）
// ===========================================

export type EventKind =
  | "info"
  | "thinking"
  | "action_start"
  | "action_ack"
  | "action_failed"
  | "tool_call"
  | "user_reply"
  | "assistant_message"
  | "ask_user_request"
  | "ask_user_reply"
  | "error";

// ask_user 单条问题
export interface AskUserQuestion {
  id: string;
  question: string;
  options?: Array<{ id: string; label: string }>;
  allowText?: boolean;
}

// 用户对单条问题的回答
export interface AskUserAnswer {
  questionId: string;
  answer: string;
  optionId?: string;
}

/**
 * 事件流单条事件
 *
 * V0.6 改：原 `phase?: PhaseId` 改为 `actionId?: string`、指向 ActionRecord.id。
 */
export interface TaskEvent {
  id: string;
  ts: number;
  kind: EventKind;
  actionId?: string;
  text: string;
  meta?: Record<string, unknown>;
}

// ===========================================
// Artifact 修订快照（V0.5.12 沿用）
// ===========================================
//
// - timestamp：snapshot 时刻（ms epoch）
// - path：相对 `data/tasks/<id>/` 的路径、如 `actions/.revisions/act_3/2026-05-25T05-44-39-123Z.md`
//   完整路径在服务端拼回 `path.join(taskDir(id), rev.path)`、防路径穿越
// - size：字节数、UI dropdown 展示「这条快照大小」无需拉文件
export interface ArtifactRevision {
  timestamp: number;
  path: string;
  size: number;
}

// ===========================================
// V0.6 Task：核心
// ===========================================

/**
 * V0.6.0.1：task 模式（重新引入 V0.5 概念、用户拍板「自由模式跟以前一样」）
 *
 * - `task`：默认、走完整 V0.6 task 容器流（plan / build / review / ship / test / learn）
 *   UI = ActionTimeline + ArtifactPanel + EventStream 三栏布局
 * - `chat`：自由对话、不走 action 体系、跑独立 chat-runner + chat-reply 通路
 *   UI = ChatView 单栏（事件流 + 输入框）、用户消息立刻显示、agent 长存活靠 wait_for_user 阻塞
 *
 * 两套通路完全独立、不共享 runner / prompt / API、避免 chat 场景被 V0.6 task 容器协议夹胀。
 */
export type TaskMode = "task" | "chat";

export interface Task {
  id: string;
  title: string;

  /**
   * V0.6.0.1：task 模式（"task" / "chat"）
   * 默认 "task"、决定 runner / API / 详情页 UI 走哪套。详见 TaskMode 定义。
   */
  mode?: TaskMode;

  /**
   * V0.6：任务级仓库状态机（跟 MR 生命周期对齐）
   */
  repoStatus: RepoStatus;

  /**
   * V0.6：runtime 状态（独立于 repoStatus）
   */
  runStatus: RunStatus;

  /**
   * V0.6：当前正在跑 / 等 ack 的 action id（null = idle）
   */
  currentActionId: string | null;

  /**
   * V0.6：action 历史（按时间正序、N 单调递增）
   */
  actions: ActionRecord[];

  /**
   * V0.6：MR 列表（V0.6.1 ship action 上线后才会有内容）
   */
  mrs: MRRecord[];

  /**
   * V0.6.1：每仓 1 条 GitBranchInfo、build 第一次跑前由 runner 按仓数生成
   * 多仓 task 各仓 name 同名、base branch 不同；单仓 task 数组长度 1
   * （V0.6.0 单数字段 `gitBranch` 在 V0.6.1 改为数组）
   */
  gitBranches?: GitBranchInfo[];

  /**
   * V0.6.1：飞书 story 测试人员 user_key 列表（纯数字、飞书项目体系的用户标识）
   * - 首次 ship 时 agent 自动探测（get_workitem_brief 的 role_members[].key 就是 user_key）
   * - 探不到时 ask_user 让用户填、search_user_info 转 user_key 后记忆到这里
   * - 同 task 后续 ship 直接复用、不再探测 / 不再问用户
   * - 2026-06-12 起从 lark_user_id 切到 user_key：官方 MCP add_comment 改按 user_key
   *   校验 mention/notify、lark_user_id 直接报 cross tenant（详见 action-ship.md §4）
   */
  feishuTesterUserKeys?: string[];

  // ===== 保留字段（V0.5 → V0.6 不变）=====

  role: TaskRole;
  repoPaths: string[];
  /**
   * V0.6.3：每个仓的「线上分支」= feature 拉取基线（per-repo、key=repoPath、value=分支名）
   * - 来源：建 task 时从 settings.repos[].onlineBranch 快照固化（settings 在 localStorage、
   *   server 端读不到、所以建 task 时 client 快照进 task、之后 build 用这份）
   * - why：feature 必须从「线上分支」拉、否则把 test/dev 未上线 commit 带进 feature 污染线上；
   *   后端默认分支常是 develop（探 origin/HEAD 会误拿）、故让用户在设置页按仓配
   * - 某仓没配（key 不存在 / 空）→ build 时该仓回退 agent 探 origin/HEAD（前端 master 场景够用）
   */
  repoBaseBranches?: Record<string, string>;
  /**
   * V0.6.3：每个仓的「已有工作分支」覆盖（per-repo、key=repoPath、value=分支名、选填）
   * - 场景：用户（尤其后端）建 task 前已自己 checkout 了分支、做了一部分 → 建 task 时填进来、
   *   build 不再按算法名建新分支、而是复用这个已有分支（git show-ref 命中 → checkout、他的代码都在）
   * - 来源：建 task 弹窗 per-repo 现填（每个需求不一样、不是仓库级固定属性、故不放设置页）
   * - 没填（key 不存在 / 空）→ build 用算法名 `feature/<username>/<storyId>-<title>`（现状默认）
   * - 落到 gitBranches[].name = 这个名、ship 提测自动用对（MR 源分支取自 gitBranches[].name）
   */
  repoFeatureBranches?: Record<string, string>;
  /**
   * V0.6.7：per-repo 测试分支快照（key=repoPath、建 task 时从 settings.repos[].testBranch 固化）
   * - ship 提测 MR 的目标分支取这份；某仓没配 → ship 回退默认 `test`
   * - 快照原因同 repoBaseBranches：settings 在 localStorage、server 读不到
   */
  repoTestBranches?: Record<string, string>;
  /**
   * V0.6.7：per-repo dev 分支快照（key=repoPath、建 task 时从 settings.repos[].devBranch 固化）
   * 当前仅存、暂无固定用途
   */
  repoDevBranches?: Record<string, string>;
  /**
   * V0.6.7：per-repo「有效」feature 命名模板快照（key=repoPath）
   * = repos[].branchTemplate ?? settings.branchTemplate ?? 内置默认、建 task 时算好固化
   * build 时按这份渲染分支名（占位符见 branch-template.ts）
   */
  repoBranchTemplates?: Record<string, string>;
  /**
   * V0.6.25 CheckRun：per-repo 校验命令快照（key=repoPath、建 task 时从 settings.repos[].checkCommands 固化）
   * - build 后 runner 按这份跑 check；某仓没配 → 该仓 check 记 not_configured（不阻塞 ship）
   * - 快照原因同 repoBaseBranches：settings 在 localStorage、server 读不到
   */
  repoCheckCommands?: Record<string, CheckCommand[]>;
  feishuStoryUrl?: string;
  contextDocs?: TaskContextDoc[];
  disabledMcpServers?: string[];
  /**
   * V0.6.14：ship 提测建 MR 时「合并后是否删源分支」。
   * - 缺省 / undefined → 保留源分支（用户拍板默认保留：合并后常要看 / 续推、删了得去 GitLab 重推很麻烦）
   * - true → 合并后删源分支（GitLab remove_source_branch）
   * - 推进 dialog 选「提测」时可改、走 advance 落盘；submit_mr handler 读这字段传给 createMR
   * - 注意：`<feature>__conflict` 一次性解冲突分支由 handler 强制删（不受本字段影响、否则留垃圾分支）
   */
  removeSourceBranchOnMerge?: boolean;
  /** V0.8 侧栏：用户手动置顶（排到任务列表最上）。缺省 / undefined = 未置顶。 */
  pinned?: boolean;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
  model?: ModelSelection;
  uiLayout?: { artifactPanelSize?: number };
  events: TaskEvent[];
}

/**
 * 新建任务表单的入参
 *
 * V0.6.0.1 重新加 mode（task / chat、对应 dialog 顶部 tab 切换）
 */
export type NewTaskInput = Pick<
  Task,
  | "title"
  | "repoPaths"
  | "feishuStoryUrl"
  | "disabledMcpServers"
  | "model"
  | "repoBaseBranches"
  | "repoFeatureBranches"
  | "repoTestBranches"
  | "repoDevBranches"
  | "repoBranchTemplates"
  | "repoCheckCommands"
> & {
  role?: TaskRole;
  mode?: TaskMode;
};

/**
 * 加上下文文档 input
 *
 * V0.6.0.1 加 images：用户可以贴图（粘贴 / 拖拽 / 选文件）、
 * 每张图作为独立的 type=image doc 落到清单、agent 用 read 工具按需读、SDK 自动转 vision。
 *
 * 至少一个非空：要么 title+content（主文本 doc）、要么 images（一张或多张图）、要么都有。
 */
export interface AddContextDocInput {
  title?: string;
  content?: string;
  images?: Array<{
    data: string;
    mimeType: string;
    filename?: string;
  }>;
}

/**
 * 任务摘要：列表场景专用（V0.5.3 引入、V0.6 调整字段）
 *
 * 跟 Task 比少 events（events.jsonl 可能几千行、parse 开销大）+ actions 详细内容
 * 仍保留 actionCount 让 UI 卡片显示「N 个 action」徽章
 */
export type TaskSummary = Omit<Task, "events" | "actions"> & {
  actionCount: number;
  // V0.6：列表卡片需要展示「最近一个 action」简略信息
  lastActionType?: ActionType;
  lastActionStatus?: ActionStatus;
};

// ---- MCP 连通性健康（V0.6.11） ----

/**
 * MCP server 连通性状态（起 agent 前探测 + 设置页 / 任务面板展示共用）
 *
 * V0.6.13 起只分两态（用户拍板「不需要连不上 / 本地什么的」、降低噪音）：
 * - ok   探测 2xx 可用 / 或本地 stdio（没 url 没法 HTTP 探、由 SDK 启动时拉起、乐观当可用）
 * - fail 探测失败：连不上 / 超时 / 401 未授权 / 非 2xx——具体原因落在 detail、失败可点开看日志
 */
export type McpHealthStatus = "ok" | "fail";

export interface McpHealth {
  name: string;
  status: McpHealthStatus;
  // HTTP 状态码（探测到响应时有）
  httpCode?: number;
  // 状态详情（失败原因 / 说明、给 tooltip + 失败日志弹窗展示）
  detail?: string;
}

/** MCP 健康状态中文标签（前后端共享、单一源） */
export const MCP_HEALTH_LABEL: Record<McpHealthStatus, string> = {
  ok: "正常",
  fail: "失败",
};
