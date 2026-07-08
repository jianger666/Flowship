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
   * V0.10.1：预览启动命令（如 `npm run dev`）——配了任务页才显示「预览」按钮。
   * 点预览 = 单预览位：停掉上一个任务的 dev server、在当前任务工作区起这条命令
   * （app 不理解命令语义、只负责执行；见 preview-manager.ts）
   */
  previewCommand?: string;
}

/**
 * 用户最终选定的模型（含参数）
 * Schema 跟 SDK ModelSelection 同步、agent 启动时直接传过去。
 */
export interface ModelSelection {
  id: string;
  params?: Array<{ id: string; value: string }>;
}

/**
 * 单预览位状态（V0.10.1、client / server 共用——server 端管理见 preview-manager.ts）
 * 全局最多一个 dev server 在跑、点任务「预览」自动停旧起新
 */
export interface PreviewSlotStatus {
  taskId: string;
  taskTitle: string;
  repoPath: string;
  workDir: string;
  command: string;
  startedAt: number;
  /** 从 dev server 输出探到的本地地址（探不到为 null、UI 不显示「打开」） */
  url: string | null;
  /** 进程已退出（启动失败 / 被外部杀）——UI 显示失败态 + 日志 */
  exited: boolean;
  exitCode: number | null;
  /** 最近日志（启动失败排查用） */
  logTail: string[];
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
// V0.11.8 从写死 cursor/idea 扩成四个、设置页按后端探测结果动态列（未装的置灰）
export type JumpIde = "cursor" | "vscode" | "idea" | "webstorm";

export const JUMP_IDE_LABEL: Record<JumpIde, string> = {
  cursor: "Cursor",
  vscode: "VS Code",
  idea: "IDEA",
  webstorm: "WebStorm",
};

/**
 * 跳转走浏览器协议（deep link）还是后端拉起（V0.11.8）：
 * - cursor / vscode：安装器可靠注册协议、deep link 直开（零往返、体验最好）
 * - JetBrains 系：`idea://` 只有 JetBrains Toolbox 会注册、直接装 IDEA 的机器点了弹
 *   「找不到应用」（用户同事 Windows 实测）——改走 POST /api/system/open-in-ide、
 *   后端探测安装位置直接 spawn 可执行文件、不依赖协议
 */
export const JUMP_IDE_USES_PROTOCOL: Record<JumpIde, boolean> = {
  cursor: true,
  vscode: true,
  idea: false,
  webstorm: false,
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
  /**
   * V0.9：推进面板布局偏好（「推进」弹窗里 action 的顺序 + 显隐、个人级、落 config.json）
   */
  actionLayout?: ActionLayoutPref;
  /**
   * v0.9.11：推进 dialog「续用当前 Agent」开关的默认值（默认 false = 每 action 起新 agent）。
   * 只影响 dialog 打开时的初始勾选、review 强起新 agent 的 server 铁律不受它影响。
   */
  reuseAgentDefault?: boolean;
  /**
   * V0.11.x：模型使用计数（「常用模型」快捷 chip 的数据源、用户拍板自动按次数排序）。
   * 每次真正提交使用某模型（推进起新 agent / 重启阶段 / 新建任务 / chat 换模型）计一次、
   * 按「模型 id + 参数组合」区分（Fable High 和 Fable Low 是两个条目）。上限 20 条防膨胀。
   */
  modelUsage?: ModelUsageEntry[];
}

/** 单条模型使用计数（key = id + params 组合） */
export interface ModelUsageEntry {
  id: string;
  params?: Array<{ id: string; value: string }>;
  count: number;
  lastUsedAt: number;
}

/**
 * 推进面板布局偏好——自定义「推进」弹窗里 action 卡片的顺序 + 显隐。
 * 内置 + 自定义混排成一个列表统一排。
 */
export interface ActionLayoutPref {
  /** action key 排序：内置用 type（"plan"）、自定义用 id（"custom_xxx"）；不在表里的排末尾 */
  order: string[];
  /** 在「推进」弹窗隐藏的 action key（v0.9.12 起直接不出现、去 /actions 页开关恢复） */
  hidden: string[];
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

/**
 * API Key 归属信息（来自 SDK `Cursor.me`、设置页展示用）
 * - 团队 / service-account key 没有 userId / 邮箱 / 姓名、相应字段缺省
 * - apiKeyName / createdAt 任何 key 都有
 */
export interface ApiKeyInfo {
  apiKeyName: string;
  userId?: number;
  userEmail?: string;
  userFirstName?: string;
  userLastName?: string;
  createdAt: string;
}

// ===========================================
// V0.6 任务模型：task 容器 + action 历史
// ===========================================
//
// 设计原则（详见 docs/V0.6-REFACTOR.md、已 archived）：
// 1. task = 一个需求的完整生命周期容器（飞书 story 进来 → 合入 main / abandon）
// 2. action = task 内的单次动作（plan / build / review / ship / learn / dev；chat 走独立 mode）
//    - 自由触发顺序（不强制 plan→build→review、靠 6 个 harness 门槛兜底质量）
//    - N 累计序号、文件名 actions/N-<type>.md（cancelled 也占 N、不释放）
// 3. agent 会话跨 run 存活（V0.11：交卷 / 提问后 run 自然结束、用户操作经 agent.send 续接同一会话）
// 4. 不写 V0.5 → V0.6 migration 脚本、V0.5 老 task 数据靠 listTasks 自动跳过（schema 不匹配的 meta.json 在 hydrate 时被 skip）

/**
 * action 类型（V0.6.0.1 起 chat 从 action 里剥离、走独立 mode=chat 通路）
 *
 * 6 个内置：
 * - `plan`     出方案
 * - `build`    改代码
 * - `review`   复核（plan/build 差异核对 + fresh peer bug 复审）
 * - `ship`     提测（push 改动 + 提 MR 到 test 分支 + 飞书 story 评论 @ 测试人员）
 * - `learn`    沉淀
 * - `dev`      联调
 *
 * `custom`（自定义 action）：用户在 /actions 页自己封装的 action（playbook + skill + 可选 check）。
 *   一条 type=custom 的 ActionRecord 用 `customActionId` 指向 custom-actions/<id>.md 定义。
 *   custom **不进** ACTION_TYPES（那是「内置 action 选择」清单）、但要补进所有 `Record<ActionType,X>` 兜底键。
 *   展示文案以定义里的 label 为准、表里的 "自定义" 只是没拿到定义时的兜底。
 */
export type ActionType =
  | "plan"
  | "build"
  | "review"
  | "ship"
  | "learn"
  | "dev"
  | "custom";

// 内置 action 类型清单（advance 准入 / UI 内置选项；custom 不在内、单独走自定义清单）
export const ACTION_TYPES = [
  "plan",
  "build",
  "review",
  "ship",
  "learn",
  "dev",
] as const;

/**
 * V0.x：联调（dev action）的推送方式——推进 dialog 二选一、advance 时落 ActionRecord.devPushMode。
 * - direct：本地基于 origin/dev merge feature 后直推（默认、最快触发流水线、省 MR review）
 * - mr：提 PR（feature→dev、走 submit_mr、跟 ship 同一套落详情页 MR 列表 + 冲突门禁）
 */
export type DevPushMode = "direct" | "mr";

/**
 * action 中文 label（UI 选 action / timeline 展示用、统一来源）
 */
export const ACTION_LABEL: Record<ActionType, string> = {
  plan: "出方案",
  build: "改代码",
  review: "复核",
  ship: "提测",
  learn: "沉淀",
  dev: "联调",
  // 兜底——custom action 实际展示用定义里的 label、拿不到定义才回退到这个
  custom: "自定义",
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
  learn: false,
  dev: false,
  // 自定义 action 默认 fresh（跟 V0.6.27 全员默认 fresh 一致、各 custom 可在定义里覆盖）
  custom: true,
};

/**
 * V0.9：自定义 action 定义（用户在 /actions 页建、存 dataRoot()/custom-actions/<id>.md）
 *
 * 存储格式：md 文件——frontmatter 配元信息 + 正文是 playbook。
 * 运行时：一条 type="custom" 的 ActionRecord 用 customActionId 指向这里、runner 把 playbook
 *   当 action prompt 注入、按 skills 提示 agent 重点用。
 *
 * - id：唯一（= 文件名 <id>.md 的 id 段、如 custom_xxx）
 * - label：动作名（如「性能审计」、推进菜单 + timeline 展示）
 * - summary：一句话简介（列表副标题、可选）
 * - playbook：正文（干什么 / 怎么做 / 产出什么、markdown）
 * - skills：选用的 skill name 列表（loadSkills 扫出来的、可选；本机没有的
 *   渲染 prompt 时静默跳过、见 task-prompts.loadCustomActionPlaybook）
 * - freshAgent：是否强起新 agent（默认 true、跟内置默认 fresh 一致）
 * - placeholder：推进弹窗输入框的提示文案（可选、告诉使用者该填什么——
 *   轻量版「参数化」、缺省用通用文案）
 */
export interface CustomActionDef {
  id: string;
  label: string;
  summary?: string;
  playbook: string;
  skills?: string[];
  freshAgent?: boolean;
  placeholder?: string;
  createdAt: number;
  updatedAt: number;
}

/** 新建 / 更新自定义 action 的入参（不含 id / 时间戳、那些由存储层管、前后端共用） */
export type CustomActionInput = Omit<
  CustomActionDef,
  "id" | "createdAt" | "updatedAt"
>;

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

export type ReplanMode = "append" | "rebuild";

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
   * 后置 deterministic 检查（V0.6 门槛 2；v0.9.13 起只查 agent 交付诚实性、不跑项目命令）
   * - plan: artifact 文件存在 + 内容长度 >= 100 + 必备段（需求理解 / Task 拆分、V0.6.27）
   * - build: artifact 落盘非空（CheckRun 跑 typecheck/lint 那套 v0.9.13 删——存量项目基线红、全仓检查语义错配）
   * - review: 基底 commit 一致 + 必备段非空 + bug 复审段非空（V0.6.9 fresh peer 阶段二）
   *   + 工作区指纹未变（V0.6.27、review 只读硬校验）
   * - ship（V0.6.1）：需提 MR 的仓都有 task.mrs 记录 + URL 非空、跳过仓有原因
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
   * 副作用记录（对外部世界的影响）
   *
   * V0.6.1：ship 改成多仓数组——同一 ship action 多仓场景产出 N 条 MR、一仓 1 条记录
   * - test: agent 起服务 / 用例结果摘要（V0.6.2 上线时再细化字段）
   */
  sideEffects?: {
    mrs?: Array<{
      repoPath: string;
      /** V0.x：MR 目标分支（提测=测试分支 / 联调=dev 分支）、区分同仓提测/联调 MR */
      targetBranch?: string;
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
   * - build 选批 + 进度推导基于 task-display.deriveEffectiveBatches 派生出的当前有效批次
   * - 空 / 不存 = 这次 plan 没拆批次（小需求、build 默认全做、退化成老流程）
   */
  planBatches?: PlanBatch[];

  /**
   * V0.8.x：多次 plan 时，本 plan 的批次如何进入当前有效批次集。
   * - append：只上报新增/补充批次 delta，旧批次继续由旧 plan 派生
   * - rebuild：重建后续批次，之前仍 pending 的批次派生为 superseded（已 built 历史保留）
   * - 旧 action 缺省：保持 legacy latest-only 语义，避免历史 task 批次突然被合并
   */
  replanMode?: ReplanMode;

  /**
   * V0.6.23：build action 本次「做哪些批次」——推进 build 时用户在 dialog 勾选、advance 时后端直接存
   * - 不靠 agent 上报（省一个 MCP 工具）：build agent 从 NEXT_ACTION 指令读做哪批、老实做完
   * - 新数据存 effectiveId（planActionId:batchId）；旧数据裸 b1/b2 由派生层按 legacy 单 plan 兼容映射
   * - 空 / 不存 = 无批次的 plan、或自由改动（V0.6.29 批次选填：不勾批 = 修 bug / 跨批散改、不计进度）
   */
  requestedBatchIds?: string[];

  /**
   * V0.x：联调（dev action）本次推送方式——推进 dialog 选、advance 时后端直接存（仅 dev action 有意义）
   * - direct：本地 merge dev + 直推
   * - mr：提 PR（feature→dev、走 submit_mr）
   * 不存 = 非 dev action / 老数据（dev handler 读时兜底 direct）
   */
  devPushMode?: DevPushMode;

  /**
   * V0.9：自定义 action 指向的定义 id（仅 type="custom" 的 action 有）
   * - 指向 dataRoot()/custom-actions/<customActionId>.md
   * - runner 据此读 playbook 当 action prompt、按定义里的 skills/freshAgent 跑
   * - 不存 = 非 custom action（内置 6 个走 ACTION_PROMPT_FILE 文件）
   */
  customActionId?: string;

  /**
   * V0.9：自定义 action 的展示名快照（advance 时从定义 label 固化、仅 type="custom" 有）
   * - 展示层直接用这个、不用每次回查定义文件（同 MRRecord.title 思路）
   * - 快照原因：定义后来改名 / 删了、历史 action 仍显示当时的名字、不漂移
   */
  customLabel?: string;

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
   * V0.x：MR 目标分支（提测=测试分支 / 联调=dev 分支）。
   * 同仓的提测 MR 和联调 MR 按 repoPath+targetBranch 区分（各自累计 version、各自关旧 MR、互不覆盖）。
   * 老记录缺这字段 → 读时兜底当测试分支（历史上只有提测 MR、见 mrTargetBranchOf）。
   */
  targetBranch?: string;
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
/**
 * chat 工作目录的本地 git 分支状态（V0.8、前后端共用）
 *
 * 读自 git-branches.readGitBranchState：自由对话工作目录是 git 仓时给分支选择器用。
 * 跟 GitBranchInfo（agent 工作分支记录）无关——这只是「目录现在有哪些本地分支 + 在哪个分支上」。
 */
export interface GitBranchState {
  /** 该目录是不是 git 仓（false 时 current/branches 为空、前端隐藏分支选择器） */
  isRepo: boolean;
  /** 当前分支名；detached HEAD 时为 null */
  current: string | null;
  /** 本地分支名列表（不含 remote、按最近提交倒序） */
  branches: string[];
}

/**
 * 仓库分支候选列表（v0.9.11、前后端共用）
 *
 * 读自 git-branches.listRepoBranches：本地 + 远端合并去重（远端去 origin/ 前缀）、
 * 给设置页仓库分支字段 / 任务 dialog「已有工作分支」的下拉候选用。
 * 跟 GitBranchState 的区别：这份含远端分支（线上 / test / develop 常常本地没 checkout 过）、不关心当前分支。
 */
export interface RepoBranchList {
  /** 该目录是不是 git 仓（false 时前端禁用分支选择） */
  isRepo: boolean;
  /** 分支名候选（本地 + 远端去重、按最近提交倒序） */
  branches: string[];
}

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
 * - `task`：默认、走完整 V0.6 task 容器流（plan / build / review / ship / learn / dev）
 *   UI = ActionTimeline + ArtifactPanel + EventStream 三栏布局
 * - `chat`：自由对话、不走 action 体系、跑独立 chat-runner + chat-reply 通路
 *   UI = ChatView 单栏（事件流 + 输入框）、用户消息立刻显示、会话跨 run 存活（send 续接）
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
  feishuStoryUrl?: string;
  contextDocs?: TaskContextDoc[];
  disabledMcpServers?: string[];
  /**
   * V0.10：任务隔离工作区（git worktree）开关。
   * - true（新建 task 默认）→ runner 起 agent 前在 dataRoot/worktrees/<taskId>/ 逐仓
   *   `git worktree add` 并确定性检出任务分支、agent cwd / 后置检查全走 worktree、
   *   并行任务不再互踩同一个仓的工作区
   * - false（新建弹窗的逃生口「直接在原仓库运行」）/ undefined（V0.10 前的老 task）
   *   → 直接在原仓库目录运行、分支靠 build checkout hint 引导 agent 自己切（旧行为）
   * - chat 模式恒不隔离（自由对话不建分支、直接用所选目录）
   */
  isolateWorktree?: boolean;
  /**
   * V0.11.1：最近一次 agent 会话的 agentId（会话持久化）。
   * - 会话创建（Agent.create / 每次换新 agent）时写入；停止 / 终结 / 会话报错时清空
   * - 服务重启后内存会话丢了、但这个 id 还在 → 用户再聊聊 / 答弹窗 / 续用推进时
   *   `Agent.resume(agentId)` 无缝接回原会话（上下文不丢）；resume 失败自动清空、退回 fresh agent
   * - 空闲回收（会话闲置自动 close 省内存）**不清**这个 id——下次操作 resume 回来
   */
  sessionAgentId?: string;
  /**
   * V0.10.1：agent 实际工作目录（**计算字段、不落盘**——hydrateTask 时由 getTaskCwd 算出）。
   * - 隔离 task → worktree cwd（单仓 = worktree 自身、多仓 = worktrees/<taskId> 公共父目录）
   * - 非隔离 → 原仓库 effective cwd
   * client 的「在 IDE 打开工作区」「复制路径」「预览」按钮用（dataRoot 只有 server 知道、client 拼不出）
   */
  workCwd?: string;
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
  | "isolateWorktree"
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
