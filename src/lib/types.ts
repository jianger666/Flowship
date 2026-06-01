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
 * settings：localStorage 持久化的用户配置
 * V0.6 新增 username：用于 ship action 的 branch prefix
 *   （branch 模板 = `feature/<username>/<飞书id>-<task.title>`、多人用 fe-ai-flow 不互踩）
 * V0.6.1 新增 gitHost + gitToken：ship action 走 server 内置 GitLab REST API、
 *   不依赖外部 glab CLI；当前公司场景所有仓共用同一个 GitLab 实例、所以是全局字段。
 */
export interface FeAiFlowSettings {
  apiKey: string;
  defaultModel: ModelSelection;
  username?: string;
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
 * - `review`   代码复核
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
  review: "代码复核",
  ship: "提测",
  test: "AI 手测",
  learn: "沉淀",
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
   * 软删标记（V0.6.x「划除」）——用户主动把这个 action 从 agent 上下文里排除
   * - 区别于 status=cancelled（中途停了没跑完）：excluded 是「不管跑没跑完、用户判定它冗余/跑歪、别再进上下文」
   *   （所以是独立 flag、不是 status 的一个值——一个 completed 的 action 也能被 excluded）
   * - renderActionHistorySection 跳过它（不进 prompt、不引导 read artifact）→ 治本上下文污染
   * - 数据 / artifact / events 全部物理保留、UI 划线展示、可一键恢复（可逆、比真删安全）
   */
  excluded?: boolean;

  /**
   * 后置 deterministic 检查（V0.6 门槛 2）
   * - plan: artifact 文件存在 + 内容长度 >= 100（V0.6.0.1 拍板删黑名单 grep、详见 action-checks.ts）
   * - build: typecheck/lint exit 0 + git status 有改动
   * - review: git diff hash 一致 + 4 类差异段非空
   * - ship（V0.6.1）：需提 MR 的仓都有 task.mrs 记录 + URL 非空、跳过仓有原因
   * - test: pass 率 ≥ 阈值
   * - learn: propose 段有内容 + evidence 路径都能 read 到
   */
  postCheck?: {
    passed: boolean;
    details: string;
  };

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
   * 跟 GitLab MR ID（iid）没关系、只是 fe-ai-flow 内部计数
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
// 当前枚举 `fe` / `be`、未来扩 data / mobile-ios / mobile-android / qa（详见 docs/MULTI-ROLE.md）。

export type TaskRole = "fe" | "be";

export const TASK_ROLE_LABEL: Record<TaskRole, string> = {
  fe: "前端",
  be: "后端",
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
   * V0.6.1：飞书 story 测试人员 lark_user_id 列表
   * - 首次 ship 时 agent 自动探测（list_workitem_field_config + get_workitem_brief
   *   + search_user_info）、探到的人写回这里
   * - 探不到时 ask_user 让用户填、记忆到这里
   * - 同 task 后续 ship 直接复用、不再探测 / 不再问用户
   */
  feishuTesterUserIds?: string[];

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
  feishuStoryUrl?: string;
  contextDocs?: TaskContextDoc[];
  disabledMcpServers?: string[];
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
