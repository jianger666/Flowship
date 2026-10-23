/**
 * task-fs 基建层（V0.9.x 从 task-fs.ts 拆出、纯搬家零逻辑变更）
 *
 * 职责（task-fs / task-artifacts 共用的底座）：
 *   - 数据目录路径常量 + id 生成 + 路径 helper（events.jsonl / actions/ / artifact / check log）
 *   - meta.json 类型（TaskMetaV06）+ zod schema 校验 + 原子读写
 *   - per-task mutex（withTaskLock、挂 globalThis）
 *   - 事件流读写（readEvents / readEventsTail / readEventsBefore / appendEventLine）
 *   - hydrate（meta → Task / TaskSummary）
 *
 * 依赖方向（保证无环）：只依赖 types / data-root、不 import task-fs / task-artifacts。
 * 数据布局说明见 task-fs.ts 顶部注释。
 */

import { createReadStream, readFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";

import type { CorruptTaskInfo, CorruptTaskKind } from "@/lib/corrupt-task";
import type {
  ActionRecord,
  GitBranchInfo,
  LastRewind,
  MRRecord,
  ModelSelection,
  RepoStatus,
  RunStatus,
  Task,
  TaskContextDoc,
  TaskEvent,
  TaskMode,
  TaskSummary,
  TokenUsageRollup,
  UserRole,
} from "@/lib/types";
import { dataRoot, RenameAbortedError, renameWithRetry } from "./data-root";
import { isDirGoneError } from "./fs-gone";
import { serializeEventLineRedacted } from "./event-secret-redact";
import { failpoint } from "./failpoints";
import { coalesceAdjacentThinking } from "@/lib/merge-thinking";
// 只用其纯函数（getTaskCwd 路径计算、零 IO）、task-worktrees 不反向依赖本模块（无环）
import { getTaskCwd } from "./task-worktrees";
import { z } from "zod";

// ----------------- 路径常量 -----------------

export const DATA_DIR = path.join(dataRoot(), "tasks");
export const META_FILE = "meta.json";
/**
 * meta.json 的「上一版有效备份」：每次覆盖写前由 refreshMetaBackup 滚动一次，
 * 只存能通过 schema 校验的版本（坏文件绝不顶掉好备份）。
 * 用途：崩溃 / 降级后 meta.json 内容损坏时，启动期 restoreMetaFromBackup 用它原子恢复主文件。
 */
export const META_BACKUP_FILE = "meta.json.bak";
/** 恢复时被替换掉的坏 meta.json 原件（单槽、下次恢复覆盖）：留给人工排查，也避免「降级再升级」丢掉新版数据 */
export const META_INVALID_FILE = "meta.json.invalid";
export const EVENTS_FILE = "events.jsonl";
export const ACTIONS_DIR = "actions";
// 任务专属可写工作目录（V0.x「产出解耦」）：artifact 之外的文件产出（脚本 / 数据 / 中间产物）
// 没有明确去处时写这里——只读仓 / 无仓任务也永远有合法可写落点。建任务时创建、随任务删除。
export const WORKSPACE_DIR = "workspace";
/** 工具超长输出全量落盘目录（Phase 1 tool_result 截断后查看完整输出用、随任务删） */
export const TOOL_OUTPUTS_DIR = "tool-outputs";
export const REVISIONS_SUBDIR = ".revisions";
// 划除（软删）的 artifact 挪进这个隐藏子目录——跟 .revisions / .checks 同风格、
// agent 的 ls / rg 默认都扫不到、防被按编号拼路径翻出来读（V0.8.16、见 setActionArtifactExcluded）
export const EXCLUDED_SUBDIR = ".excluded";
// 单 action 最多保留 10 个 revision、超出 GC 删最早（沿用 V0.5.12 的上限策略）
export const MAX_REVISIONS_PER_ACTION = 10;
/**
 * 逻辑删除标记：
 * - Windows EBUSY：deleteTask 降级写此标记、卸 meta，UI 立刻消失
 * - DELETE 延迟分支：HTTP 200 前先写此标记（durable logical delete），list/get 不暴露；
 *   boot recovery 见标记继续物理 rm（绝不动 bench/fixture 等无标记手工目录）
 */
export const DELETED_TOMBSTONE_FILE = ".deleted-tombstone";

// ----------------- id 生成 / 校验 -----------------

export const newTaskId = (): string =>
  `t_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

export const newEventId = (): string =>
  `e_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

export const newActionId = (n: number): string => `act_${n}`;

export const newContextDocId = (): string =>
  `ctx_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

// 防路径穿越：只允许字母数字下划线
export const sanitizeId = (id: string): string => {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new Error(`非法 id: ${id}`);
  }
  return id;
};

export const taskDir = (id: string): string =>
  path.join(DATA_DIR, sanitizeId(id));

// ----------------- 路径 helper（给 prompt / runner 用）-----------------

/**
 * events.jsonl 的绝对路径
 * agent cwd 是用户业务仓库、不是 Flowship 本身、所以必须用绝对路径
 */
export const getEventsLogPath = (taskId: string): string =>
  path.join(taskDir(taskId), EVENTS_FILE);

/**
 * actions/ 目录的绝对路径（给 prompt 用、agent 写 artifact 走这里）
 */
export const getActionsDir = (taskId: string): string =>
  path.join(taskDir(taskId), ACTIONS_DIR);

/**
 * 任务工作目录 workspace/ 的绝对路径（给 prompt / runner 用）
 * agent 的非 artifact 产出兜底落点、绝对路径注入 prompt（agent cwd 是业务仓库）
 */
export const getTaskWorkspaceDir = (taskId: string): string =>
  path.join(taskDir(taskId), WORKSPACE_DIR);

/**
 * 给单条 action 算 artifact 文件名（相对名、不含目录前缀）
 * 命名规则：`<N>-<type>.md`、N 不前导 0、跟 V0.6-REFACTOR.md §4.3 一致
 * type 用 string：历史退役类型（learn / test）磁盘上仍可能有 artifact、路径拼装不能卡死在枚举。
 */
export const actionArtifactFilename = (n: number, type: string): string =>
  `${n}-${type}.md`;

/**
 * 给单条 action 算 artifact 相对路径（meta 里 `ActionRecord.artifactPath` 存这个）
 * 例：`actions/1-plan.md`
 */
export const actionArtifactRelPath = (n: number, type: string): string =>
  `${ACTIONS_DIR}/${actionArtifactFilename(n, type)}`;

/**
 * 给单条 action 算 artifact 绝对路径（prompt 里塞给 agent）
 */
export const getActionArtifactPath = (
  taskId: string,
  n: number,
  type: string,
): string => path.join(getActionsDir(taskId), actionArtifactFilename(n, type));

// ----------------- 基础 fs helper -----------------

export const ensureDataDir = async (): Promise<void> => {
  await fs.mkdir(DATA_DIR, { recursive: true });
};

export const exists = async (p: string): Promise<boolean> => {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
};

// ----------------- meta.json 类型 + 读写 -----------------

/**
 * meta.json 的实际结构（V0.6）
 * - 跟 Task 比少 events（events.jsonl 独立、避免大字段反复读写）
 */
export interface TaskMetaV06 {
  id: string;
  title: string;
  /**
   * chat 首轮后待 SDK 自动生成标题（详见 types.ts Task.titleAutoPending）。
   * 仅 chat 建任务时写 true；手动改名 / 生成完成 / 超时放弃时删掉。
   */
  titleAutoPending?: boolean;
  mode?: TaskMode;
  /** 创建时工作角色快照；测试任务的分支语义据此保持稳定。 */
  workRole?: UserRole;
  repoStatus: RepoStatus;
  runStatus: RunStatus;
  currentActionId: string | null;
  actions: ActionRecord[];
  mrs: MRRecord[];
  /**
   * V0.6.1：每仓 1 条、build 第一次跑前按仓数初始化
   * （V0.6.0 时是单数 `gitBranch?: GitBranchInfo`、为支持多仓 task 改为数组）
   */
  gitBranches?: GitBranchInfo[];
  /**
   * V0.6.1：飞书测试人员记忆（A+C 兜底后落库、同 task 后续 ship 直接复用）
   * 2026-06-12 起存 user_key（原 lark_user_id 体系被官方 MCP 封死、详见 types.ts）
   */
  feishuTesterUserKeys?: string[];
  repoPaths: string[];
  /**
   * 非 git 目录清单快照（详见 types.ts Task.nonGitRepoPaths）。
   * undefined = 全 git（老任务）。
   */
  nonGitRepoPaths?: string[];
  /**
   * 只读仓清单快照（详见 types.ts Task.readonlyRepoPaths）。
   * undefined = 无只读仓（老任务）。
   */
  readonlyRepoPaths?: string[];
  /**
   * 脚本仓清单快照（详见 types.ts Task.scriptRepoPaths）。
   * undefined = 无脚本仓（老任务）。
   */
  scriptRepoPaths?: string[];
  /** V0.6.3：per-repo 线上分支（key=repoPath、建 task 时从 settings 快照、空则 build 探 origin/HEAD） */
  repoBaseBranches?: Record<string, string>;
  /** V0.6.3：per-repo 被测业务分支（仅 QA 测试任务、key=repoPath、选填可后补） */
  repoFeatureBranches?: Record<string, string>;
  /** V0.6.7：per-repo 测试分支快照（ship 提测目标、空则回退默认 test） */
  repoTestBranches?: Record<string, string>;
  /** V0.6.7：per-repo dev 分支快照（暂存、无固定用途） */
  repoDevBranches?: Record<string, string>;
  /** V0.6.7：per-repo 有效命名模板快照（build 渲染分支名用） */
  repoBranchTemplates?: Record<string, string>;
  feishuStoryUrl?: string;
  /**
   * 本任务关联的飞书群 chat_id（任务本地关联，详见 types.ts Task.feishuGroupChatId）。
   * 落盘字段（looseObject schema 透传）；空/缺 = 回落读项目群。
   */
  feishuGroupChatId?: string;
  /** 本任务关联群的群名快照（展示用） */
  feishuGroupChatName?: string;
  /** 手填的 wk 需求编号（详见 types.ts Task.reqId；空 = 这个 task 没有 REQ-ID） */
  reqId?: string;
  contextDocs?: TaskContextDoc[];
  disabledMcpServers?: string[];
  /** V0.10：任务隔离工作区开关（新建默认 true、逃生口 false、详见 types.ts Task.isolateWorktree） */
  isolateWorktree?: boolean;
  /** V0.11.1：最近一次 agent 会话的 agentId（服务重启后 Agent.resume 续会话、详见 types.ts） */
  sessionAgentId?: string;
  /**
   * 保命轮换水位（2026-09-03 OOM 根治）：当前 SDK 会话累计 input token。
   * - recordTurnUsage 每轮累加；setTaskSessionAgentId 换到新 agentId 时清零
   *   （create/轮换/懒重启；resume 不走 set，胖会话水位重启不丢）。
   * - 缺字段（老任务）= 0，阈值见 session-rotate.ts。
   */
  sessionInputTokens?: number;
  /** V0.6.14：ship 合并后是否删源分支（缺省保留、详见 types.ts Task.removeSourceBranchOnMerge） */
  removeSourceBranchOnMerge?: boolean;
  /** V0.8 侧栏：用户置顶（缺省 false） */
  pinned?: boolean;
  /** 会话管理：归档后侧栏默认隐藏（缺省 false） */
  archived?: boolean;
  /**
   * 当前未答 ask_user 的 askId（落盘、app 重启不丢）。
   * 与内存 pendingAsks 同步写/清；老任务无此字段 = 无 pending ask。
   */
  pendingAskId?: string | null;
  createdAt: number;
  updatedAt: number;
  /** token 用量汇总（每轮 turn-ended 落一次账、详见 types.ts TokenUsageRollup） */
  tokenUsage?: TokenUsageRollup;
  model?: ModelSelection;
  /** 本窗口绑定的 agent 提供方（cursor 或 customProviders.id） */
  provider?: string;
  uiLayout?: { artifactPanelSize?: number };
  /** 最近一次 chat 回退的记录（回退路由写；语义见 types.ts Task.lastRewind，D9-04） */
  lastRewind?: LastRewind;
}

/**
 * V0.6 meta schema 校验（V0.6.27 从手写 4 字段检查升级 zod）
 *
 * 分层策略：顶层关键字段 + actions 元素关键字段严格（枚举 / 类型）、
 * 其余嵌套对象宽松（passthrough、不逐字段建模——schema 跟着 types.ts 全量双写会漂移）。
 * 半损坏 meta（手改出错 / schema 演进漏字段）在这里被拦、不再带病传播到 UI / prompt 渲染。
 */
const ActionRecordLooseSchema = z
  .looseObject({
    id: z.string().min(1),
    n: z.number().int().nonnegative(),
    // 放行任意非空字符串：内置 ACTION_TYPES + custom + 历史退役类型（learn / test）。
    // 若收窄成枚举、带旧 learn 记录的 meta.json 会整单读失败（404）。
    // 新推进仍由 advance route 用 ACTION_TYPES / custom 白名单拦。
    type: z.string().min(1),
    status: z.enum(["running", "awaiting_ack", "completed", "error", "cancelled"]),
    userInstruction: z.string(),
    artifactPath: z.string().nullable(),
    startedAt: z.number(),
    endedAt: z.number().nullable(),
  });

const TaskMetaV06Schema = z
  .looseObject({
    id: z.string().min(1),
    title: z.string(),
    mode: z.enum(["task", "chat"]).optional(),
    repoStatus: z.enum([
      "developing",
      "merged",
      "abandoned",
    ]),
    runStatus: z.enum(["idle", "running", "awaiting_user", "error"]),
    currentActionId: z.string().nullable(),
    actions: z.array(ActionRecordLooseSchema),
    mrs: z.array(z.looseObject({})),
    // 旧 role 已退役；workRole 是新任务创建时的稳定角色快照。
    workRole: z.enum(["fe", "be", "qa", "other"]).optional(),
    repoPaths: z.array(z.string()),
    pinned: z.boolean().optional(),
    createdAt: z.number(),
    updatedAt: z.number(),
  });

export const isValidMetaShape = (raw: unknown): raw is TaskMetaV06 => {
  const parsed = TaskMetaV06Schema.safeParse(raw);
  if (!parsed.success) {
    // 校验失败打出具体哪个字段坏了（手写检查时代只能知道「不合法」、定位要人肉 diff）
    console.warn(
      `[task-fs] meta schema 校验失败：${parsed.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
    return false;
  }
  return true;
};

type MetaTextParse =
  | { ok: true; meta: TaskMetaV06 }
  | { ok: false; kind: Exclude<CorruptTaskKind, "read_error">; reason: string };

/**
 * 纯函数：把 meta 文本解析 + schema 校验成「有效 / 损坏（带类别与原因）」，不打日志。
 * 给 .bak 校验、损坏任务识别用——它们要的是一个结论，而不是 isValidMetaShape 那种每次失败都 warn。
 *
 * reason 会进 API 响应：只写类别 / JSON 出错位置 / schema 出错字段路径，
 * 绝不拼文件内容（V8 的 JSON.parse 报错里带内容片段，所以不直接用 e.message）。
 */
const parseMetaText = (text: string): MetaTextParse => {
  if (text.trim().length === 0) {
    return {
      ok: false,
      kind: "empty",
      reason: "meta.json 为空（可能上次进程写一半挂了）",
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    const pos = /position (\d+)/.exec(e instanceof Error ? e.message : "")?.[1];
    return {
      ok: false,
      kind: "invalid_json",
      reason: `meta.json 不是合法 JSON${pos ? `（位置 ${pos}）` : ""}`,
    };
  }
  const checked = TaskMetaV06Schema.safeParse(parsed);
  if (!checked.success) {
    const issues = checked.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    return {
      ok: false,
      kind: "schema_mismatch",
      reason: `meta.json 不符合当前 schema：${issues}`,
    };
  }
  // 与 isValidMetaShape 一致：返回原始对象（looseObject 透传未知字段，不能返回 zod 的 data）
  return { ok: true, meta: parsed as TaskMetaV06 };
};

// per-task mutex（防 read-modify-write race、沿用 V0.5）
//
// V0.6.27 改挂 globalThis：本模块被十几个 route import、Next.js dev 下不同 route
// 是不同 webpack chunk、module-level Map 会各持一份（chat-mcp V0.3.3 实测踩过）——
// 锁不共享 = withTaskLock 跨 route 不互斥、并发 patch meta.json 可能丢更新。
const TASK_LOCKS_KEY = "__flowshipTaskFsLocksV1__";
const getTaskLocks = (): Map<string, Promise<unknown>> => {
  const g = globalThis as unknown as Record<
    string,
    Map<string, Promise<unknown>> | undefined
  >;
  if (!g[TASK_LOCKS_KEY]) g[TASK_LOCKS_KEY] = new Map();
  return g[TASK_LOCKS_KEY]!;
};
const taskLocks = getTaskLocks();

export const withTaskLock = async <T>(
  taskId: string,
  fn: () => Promise<T>,
): Promise<T> => {
  const previous = taskLocks.get(taskId) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  taskLocks.set(taskId, next);
  try {
    return await next;
  } finally {
    if (taskLocks.get(taskId) === next) {
      taskLocks.delete(taskId);
    }
  }
};

/**
 * 读 meta.json、返回 raw JSON
 * - 文件不存在 → null
 * - 文件破损 / V0.5 残留 → 抛错（让上层决定 skip 还是 propagate）
 */
export const readMetaRaw = async (id: string): Promise<unknown | null> => {
  const p = path.join(taskDir(id), META_FILE);
  if (!(await exists(p))) return null;
  const raw = await fs.readFile(p, "utf-8");
  if (raw.trim().length === 0) {
    throw new Error(
      `meta.json 为空 taskId=${id}（可能上次进程写一半挂了、检查 data/tasks/${id}/）`,
    );
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      `meta.json 解析失败 taskId=${id}：${msg}\n` +
        `文件长度=${raw.length}、前 200 字符=${raw.slice(0, 200)}`,
    );
  }
};

/**
 * 读 V0.6 meta（不符合 schema 直接抛错、写操作前必须 schema 完整）
 */
export const readMetaV06 = async (id: string): Promise<TaskMetaV06 | null> => {
  const raw = await readMetaRaw(id);
  if (!raw) return null;
  if (!isValidMetaShape(raw)) {
    throw new Error(
      `任务 ${id} meta.json schema 不匹配 V0.6（可能 V0.5 残留 / 文件破损）`,
    );
  }
  return raw;
};

/**
 * meta 删除证据三态——absent | valid | unknown。
 * 不用 exists() 预探（EACCES 会假 absent）；直接 readFile，仅 ENOENT → absent。
 */
export type MetaEvidenceRead =
  | { kind: "absent" }
  | { kind: "valid"; value: TaskMetaV06 }
  | { kind: "unknown"; error: unknown };

type MetaEvidenceReadOp = "metaSync" | "metaAsync";
let metaEvidenceReadInjector:
  | ((op: MetaEvidenceReadOp, filePath: string) => void)
  | null = null;

/** 测试注入：模拟 meta EACCES/EIO */
export const setMetaEvidenceReadInjectorForTest = (
  fn: ((op: MetaEvidenceReadOp, filePath: string) => void) | null,
): void => {
  metaEvidenceReadInjector = fn;
};

const isMetaEnoent = (err: unknown): boolean =>
  (err as NodeJS.ErrnoException)?.code === "ENOENT";

const parseMetaEvidence = (raw: string, id: string): MetaEvidenceRead => {
  if (raw.trim().length === 0) {
    return {
      kind: "unknown",
      error: new Error(`meta.json 为空 taskId=${id}`),
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { kind: "unknown", error: e };
  }
  if (!isValidMetaShape(parsed)) {
    return {
      kind: "unknown",
      error: new Error(
        `任务 ${id} meta.json schema 不匹配 V0.6（可能 V0.5 残留 / 文件破损）`,
      ),
    };
  }
  return { kind: "valid", value: parsed };
};

/** 异步三态读 meta（DELETE / manifest 构建用） */
export const readMetaV06Evidence = async (
  id: string,
): Promise<MetaEvidenceRead> => {
  const p = path.join(taskDir(id), META_FILE);
  try {
    metaEvidenceReadInjector?.("metaAsync", p);
    const raw = await fs.readFile(p, "utf-8");
    return parseMetaEvidence(raw, id);
  } catch (err) {
    if (isMetaEnoent(err)) return { kind: "absent" };
    console.error(`[task-fs-core] 读 meta 未知错误 id=${id}`, err);
    return { kind: "unknown", error: err };
  }
};

/** 同步三态读 meta（TaskVisibility 用） */
export const readMetaV06EvidenceSync = (id: string): MetaEvidenceRead => {
  const p = path.join(taskDir(id), META_FILE);
  try {
    metaEvidenceReadInjector?.("metaSync", p);
    const raw = readFileSync(p, "utf-8");
    return parseMetaEvidence(raw, id);
  } catch (err) {
    if (isMetaEnoent(err)) return { kind: "absent" };
    console.error(`[task-fs-core] sync 读 meta 未知错误 id=${id}`, err);
    return { kind: "unknown", error: err };
  }
};

// ----------------- meta 损坏识别 / .bak 恢复 / 备份滚动 -----------------

const metaFilePath = (id: string): string => path.join(taskDir(id), META_FILE);
const metaBackupPath = (id: string): string =>
  path.join(taskDir(id), META_BACKUP_FILE);

/** 同步读 .bak 并判有效（只回答「能不能用来恢复」，读失败 / 不存在都算无效） */
const isBackupValidSync = (id: string): boolean => {
  try {
    return parseMetaText(readFileSync(metaBackupPath(id), "utf-8")).ok;
  } catch {
    return false;
  }
};

/**
 * 同步识别「这个任务目录的 meta.json 是否损坏」，损坏返回描述、否则 null。
 *
 * 为什么需要它：getTaskVisibility 对 meta 读 unknown（内容损坏 / schema 不合）一律 fail-closed
 * 判 unavailable，listTasks 因此直接跳过——任务从侧栏静默消失、用户不知道它还在磁盘上。
 * 列表在「已确认不是删除证据导致的 unavailable」后调它，把这类任务单独暴露出去（不混进 Task[]）。
 *
 * - meta.json 不存在（ENOENT）→ null：不是任务目录 / 已降级删除，不算损坏
 * - 读文件本身失败 → kind=read_error（可能是瞬时 I/O 故障、不一定内容坏，所以不会据此自动恢复）
 * - 内容空 / 非 JSON / schema 不合 → 对应 kind
 */
export const inspectMetaCorruptionSync = (id: string): CorruptTaskInfo | null => {
  const metaPath = metaFilePath(id);
  let text: string;
  try {
    text = readFileSync(metaPath, "utf-8");
  } catch (err) {
    if (isMetaEnoent(err)) return null;
    const code = (err as NodeJS.ErrnoException)?.code ?? "unknown";
    return {
      id,
      kind: "read_error",
      reason: `读取 meta.json 失败（${code}）`,
      metaPath,
      backupValid: false,
    };
  }
  const parsed = parseMetaText(text);
  if (parsed.ok) return null;
  return {
    id,
    kind: parsed.kind,
    reason: parsed.reason,
    metaPath,
    backupValid: isBackupValidSync(id),
  };
};

/**
 * 写文件并 fsync（meta 原子写的 tmp 阶段用）。
 *
 * 为什么：只有 tmp + rename 时，断电 / 内核崩溃可能出现「rename 已持久化、tmp 的数据块没落盘」
 * ——meta.json 变成空文件或半截文件，任务整个读不出来。rename 之前 fsync(tmp) 才能保证
 * rename 之后看到的一定是完整内容。
 *
 * fsync 本身失败（个别网络盘 / 文件系统不支持）只 warn、不挡写：效果不会比改前（完全不 fsync）更差。
 */
const writeFileFsynced = async (
  filePath: string,
  content: string,
): Promise<void> => {
  const fh = await fs.open(filePath, "w");
  try {
    await fh.writeFile(content, "utf-8");
    await fh.sync().catch((err: unknown) => {
      console.warn(
        `[task-fs] meta fsync 失败（忽略、继续 rename）：${
          (err as NodeJS.ErrnoException)?.code ?? String(err)
        }`,
      );
    });
  } finally {
    await fh.close();
  }
};

/**
 * 覆盖写 meta.json 之前，把「当前有效的旧 meta」滚成 meta.json.bak。
 *
 * - 旧文件不存在（首次写）→ 不动
 * - 旧文件本身已坏（空 / 非 JSON / schema 不合）→ **不动 .bak**：坏文件不能顶掉好备份
 * - 失败只 warn、不挡主写：备份是兜底、不是前置条件
 * - 用 fs.writeFile 直写而不是 tmp+rename：.bak 先于主文件 rename 写完，写 .bak 中途崩溃时主文件
 *   仍是完整的旧版（rename 还没发生），下次写会重新滚备份，不存在「主文件与 .bak 同时是坏的」窗口；
 *   同时避免多走一次 renameWithRetry（它挂着 rename.beforeAttempt failpoint，测试靠它定位 meta 的 rename）。
 * - 开销：多一次读 + 校验 + 写（实测 24KB meta 约 +0.7ms，其中 zod 校验约 0.03ms）。
 */
const refreshMetaBackup = async (metaFile: string): Promise<void> => {
  try {
    let oldText: string;
    try {
      oldText = await fs.readFile(metaFile, "utf-8");
    } catch (err) {
      if (isMetaEnoent(err)) return;
      throw err;
    }
    if (!parseMetaText(oldText).ok) return;
    await fs.writeFile(
      path.join(path.dirname(metaFile), META_BACKUP_FILE),
      oldText,
      "utf-8",
    );
  } catch (err) {
    console.warn(
      `[task-fs] 刷新 meta.json.bak 失败（忽略、不挡主写）：${
        (err as NodeJS.ErrnoException)?.code ??
        (err instanceof Error ? err.message : String(err))
      }`,
    );
  }
};

export type MetaRestoreResult =
  /** 主文件内容损坏、.bak 有效 → 已用 .bak 原子恢复 */
  | "restored"
  /** 主文件有效 / 不存在 / 读文件失败（I/O 故障不是内容损坏）→ 什么都没做 */
  | "not_needed"
  /** 主文件内容损坏、但没有可用的 .bak */
  | "no_backup"
  /** 想恢复但写失败（磁盘满 / 权限）；主文件保持原样 */
  | "failed";

/**
 * 主 meta.json 内容损坏（空 / 非 JSON / schema 不合）且 meta.json.bak 有效 → 用 .bak 原子恢复主文件。
 *
 * 只在启动期（boot recovery）调：恢复发生在任何读写之前、没有「手改 meta 到一半被覆盖」的风险；
 * 运行中遇到损坏只通过 listTasksWithCorrupt 暴露、不自动动文件。
 *
 * 安全边界：
 * - 主文件不存在（ENOENT）绝不「复活」：deleteTask 降级删除只卸了 meta、不能被 .bak 拉回来
 * - 主文件读失败（EACCES / EIO / 杀软占用）不算损坏：可能是瞬时错误，拿旧备份顶上去等于回退数据
 * - 持 withTaskLock，与 meta 的读改写互斥
 * - 恢复前把坏原件留成 meta.json.invalid（非空才留）：「新版写入新枚举 → 回滚旧版」这种场景里
 *   被判坏的其实是较新的数据，不留一份就等于恢复时把它销毁了
 * - 写 tmp 同样 fsync 后 rename；.bak 保持不动（恢复后它与主文件同内容）
 */
export const restoreMetaFromBackup = (id: string): Promise<MetaRestoreResult> =>
  withTaskLock(id, async (): Promise<MetaRestoreResult> => {
    const finalPath = metaFilePath(id);
    let primaryText: string;
    try {
      primaryText = await fs.readFile(finalPath, "utf-8");
    } catch {
      return "not_needed";
    }
    if (parseMetaText(primaryText).ok) return "not_needed";

    let backupText: string;
    try {
      backupText = await fs.readFile(metaBackupPath(id), "utf-8");
    } catch {
      return "no_backup";
    }
    if (!parseMetaText(backupText).ok) return "no_backup";

    const tmpPath = `${finalPath}.tmp.${process.pid}.${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    try {
      if (primaryText.trim().length > 0) {
        await fs
          .writeFile(path.join(taskDir(id), META_INVALID_FILE), primaryText, "utf-8")
          .catch((err) => {
            console.warn(
              `[task-fs] 保留损坏 meta 原件失败（继续恢复）id=${id}：${
                (err as NodeJS.ErrnoException)?.code ?? String(err)
              }`,
            );
          });
      }
      await writeFileFsynced(tmpPath, backupText);
      await renameWithRetry(tmpPath, finalPath);
      console.warn(
        `[task-fs] meta.json 内容损坏、已用 meta.json.bak 恢复 id=${id}（坏原件留在 ${META_INVALID_FILE}）`,
      );
      return "restored";
    } catch (err) {
      await fs.unlink(tmpPath).catch(() => {});
      console.warn(`[task-fs] 用 meta.json.bak 恢复失败 id=${id}`, err);
      return "failed";
    }
  });

/**
 * 把序列化 + 写 tmp 与原子 rename 拆开。
 * prepare 期间脏值只在 tmp、meta.json 未动；commit = rename；abort = unlink tmp。
 * 条件事务 helper 用「prepare → 同步复查 → commit(finalGuard)」消灭写后回滚窗口。
 *
 * 线性化：finalGuard 在 failpoint await 之后、rename 发起前同步执行——
 * owner/caller map 不受 task lock 约束，B 可在「prepare 后检查」与 rename 之间接管；
 * 权威检查必须落在 rename 紧前，否则 A 仍会提交旧值。
 */
export const prepareMetaWrite = async (
  meta: TaskMetaV06,
): Promise<{
  /** @returns true=已 rename；false=finalGuard 拒写 / 已 settled（tmp 已清） */
  commit: (finalGuard?: () => boolean) => Promise<boolean>;
  abort: () => Promise<void>;
}> => {
  const dir = taskDir(meta.id);
  // createTask 靠这里 mkdir 建任务目录；deleteTask 持 withTaskLock 后与之互斥，不会「删完被写回复活」
  await fs.mkdir(dir, { recursive: true });
  const finalPath = path.join(dir, META_FILE);
  // 原子写：tmp（fsync）+ 滚 .bak + rename（Windows 重试逻辑与 writePrivateFileAtomic 共用 renameWithRetry）
  const tmpPath = `${finalPath}.tmp.${process.pid}.${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  try {
    // fsync(tmp) 后才允许 rename：防断电后 meta.json 变空文件 / 半截（见 writeFileFsynced）
    await writeFileFsynced(tmpPath, JSON.stringify(meta, null, 2));
  } catch (err) {
    await fs.unlink(tmpPath).catch(() => {});
    throw err;
  }
  let settled = false;
  return {
    commit: async (finalGuard?: () => boolean) => {
      if (settled) return false;
      settled = true;
      try {
        // rename 已发起未落盘窗口——矩阵可在此注入 stop，
        // 验证 stop 的锁内收尾必排在本 commit 持锁返回之后（见 finalizeStaleAndIdleLocked）
        await failpoint("metaCommit.beforeRename");
        // 权威 lease——同步、无 await 夹缝；false 则 unlink tmp、不 rename
        if (finalGuard && !finalGuard()) {
          await fs.unlink(tmpPath).catch(() => {});
          return false;
        }
        // 确认要提交了才滚 .bak（被 finalGuard 拒写的事务不碰备份）。
        // 这里有 await，但权威 lease 不受影响：下面 renameWithRetry 每次 fs.rename 前仍会再验 finalGuard
        await refreshMetaBackup(finalPath);
        // finalGuard 压进 rename retry 循环——每次 fs.rename 前再验；
        // 首轮失败退避期间换主 → RenameAbortedError → 清 tmp、返 false
        await renameWithRetry(tmpPath, finalPath, finalGuard);
        return true;
      } catch (err) {
        await fs.unlink(tmpPath).catch(() => {});
        // beforeAttempt 拒写 = 未提交（不是 IO 故障）
        if (err instanceof RenameAbortedError) return false;
        throw err;
      }
    },
    abort: async () => {
      if (settled) return;
      settled = true;
      await fs.unlink(tmpPath).catch(() => {});
    },
  };
};

/** 无条件写 meta：prepare + commit（finalGuard 不传、照常 rename） */
export const writeMeta = async (meta: TaskMetaV06): Promise<void> => {
  const prepared = await prepareMetaWrite(meta);
  await prepared.commit();
};

// ----------------- 事件流 -----------------

/** 尾部 / bootstrap 最多带这么多条（调用方传入更大值会被 clamp） */
export const MAX_EVENTS_TAIL = 1000;
/** cursor 分页单页上限 */
export const MAX_EVENTS_PAGE = 500;
/** 为凑够 limit 条「收口后」事件，最多反向扫这么多原始行（防 1.7 万 thinking token 把正文挤出窗口） */
const MAX_EVENTS_TAIL_RAW = 50_000;
/** 反向读尾部时每块字节数——IO 量跟「要的条数 × 平均行宽」同阶，不跟文件总长 */
const EVENTS_TAIL_CHUNK = 64 * 1024;

/** 解析一行 JSONL（容忍 CRLF、空行、崩溃半行） */
const parseEventLine = (raw: string): TaskEvent | null => {
  const text = raw.trim();
  if (!text) return null;
  try {
    return JSON.parse(text) as TaskEvent;
  } catch {
    return null;
  }
};

/** 从 Buffer 行去 CR 再 parse（反向按字节扫 \n 时用） */
export const parseEventLineBuf = (buf: Buffer): TaskEvent | null => {
  let s = buf;
  if (s.length > 0 && s[s.length - 1] === 0x0d) s = s.subarray(0, s.length - 1);
  return parseEventLine(s.toString("utf-8"));
};

/**
 * 全量读 events.jsonl（诊断包 / 真需要全量的路径）。
 * 长任务热点路径请用 readEventsTail / readEventsBefore。
 */
export const readEvents = async (id: string): Promise<TaskEvent[]> => {
  const p = path.join(taskDir(id), EVENTS_FILE);
  if (!(await exists(p))) return [];
  const raw = await fs.readFile(p, "utf-8");
  return raw
    .split(/\r?\n/)
    .map((line) => parseEventLine(line))
    .filter((x): x is TaskEvent => x !== null);
};

/** 倒着找满足条件的最后一个下标（没有 = -1；不依赖 ES2023 的 findLastIndex） */
const lastIndexWhere = <T>(arr: readonly T[], pred: (x: T) => boolean): number => {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (pred(arr[i]!)) return i;
  }
  return -1;
};

/**
 * 从文件尾按块反向读。
 * 相邻 thinking 收口后再计 limit——token 级思考不会把 user_reply / 工具挤出窗口。
 * hasMore = 收口后还有更早事件（或触及原始行扫描上限）。
 *
 * `opts.anchor`（300 条窗口一致性，第三轮 review D8-01/02/03）：传了就把窗口补到「含最近一条满足
 * anchor 的事件」——错误卡恢复入口 / 状态行起点 / ↑ 历史都要往前找触发这一轮的 user_reply / action_start，
 * 一轮长 run 之后它在最近 n 条之外就静默失效。补读有上限 {@link MAX_EVENTS_TAIL}（总条数不超过它，
 * 防巨型任务的首屏失控）；n 本身已不小于上限、或锚点就在最近 n 条里时与不传完全一致。
 */
export const readEventsTail = async (
  id: string,
  n: number,
  opts?: { anchor?: (ev: TaskEvent) => boolean },
): Promise<{ events: TaskEvent[]; hasMore: boolean }> => {
  const limit = Math.max(0, Math.min(Math.floor(n), MAX_EVENTS_TAIL));
  if (limit === 0) return { events: [], hasMore: false };
  const anchor = opts?.anchor;
  // 补读后的总条数上限（n 已不小于它时 = n，不额外放大）
  const maxTotal = Math.max(limit, MAX_EVENTS_TAIL);

  const p = path.join(taskDir(id), EVENTS_FILE);
  if (!(await exists(p))) return { events: [], hasMore: false };

  const fh = await fs.open(p, "r");
  try {
    const { size } = await fh.stat();
    if (size === 0) return { events: [], hasMore: false };

    let pos = size;
    // 更靠文件尾一侧、尚未与更早块拼成「行首」的碎片（跨块行）
    let carry = Buffer.alloc(0);
    // collected[0] = 文件中最后一条有效事件（倒序）
    const collected: TaskEvent[] = [];

    while (pos > 0 && collected.length < MAX_EVENTS_TAIL_RAW) {
      const toRead = Math.min(EVENTS_TAIL_CHUNK, pos);
      pos -= toRead;
      const buf = Buffer.allocUnsafe(toRead);
      const { bytesRead } = await fh.read(buf, 0, toRead, pos);
      const data = Buffer.concat([buf.subarray(0, bytesRead), carry]);

      // 按字节找 \n，再整行 decode——避免 UTF-8 多字节字符被块边界切断后乱码
      const linesFromRight: Buffer[] = [];
      let end = data.length;
      for (let i = data.length - 1; i >= 0; i--) {
        if (data[i] !== 0x0a) continue;
        linesFromRight.push(data.subarray(i + 1, end));
        end = i;
      }
      if (pos > 0) {
        carry = data.subarray(0, end);
      } else {
        carry = Buffer.alloc(0);
        if (end > 0) linesFromRight.push(data.subarray(0, end));
      }

      let hitRawCap = false;
      for (const lineBuf of linesFromRight) {
        const ev = parseEventLineBuf(lineBuf);
        if (!ev) continue; // 空行 / 崩溃半行 / 坏 JSON
        collected.push(ev);
        if (collected.length >= MAX_EVENTS_TAIL_RAW) {
          hitRawCap = true;
          break;
        }
      }
      const logical = coalesceAdjacentThinking([...collected].reverse());
      if (hitRawCap) break;
      if (logical.length > limit) {
        // 不要锚点 / 锚点已在手里 / 已读到补读上限：够了；否则接着往前读
        if (!anchor) break;
        if (logical.length >= maxTotal) break;
        if (lastIndexWhere(logical, anchor) >= 0) break;
      }
    }

    const coalesced = coalesceAdjacentThinking([...collected].reverse());
    // 窗口起点：默认只留最近 limit 条；锚点比这更早、且离末尾不超过 maxTotal 条 → 起点退到锚点。
    // 锚点远在上限之外（或根本没有）= 补了也拿不到它，不白白放大首屏，保持 limit 条（派生态走客户端降级）
    let start = Math.max(0, coalesced.length - limit);
    if (anchor) {
      const ai = lastIndexWhere(coalesced, anchor);
      if (ai >= 0 && ai < start && coalesced.length - ai <= maxTotal) start = ai;
    }
    const hasMore =
      pos > 0 || start > 0 || collected.length >= MAX_EVENTS_TAIL_RAW;
    const events = start > 0 ? coalesced.slice(start) : coalesced;
    return { events, hasMore };
  } finally {
    await fh.close();
  }
};

/**
 * 文件内**反向**逐行扫描：从 fromPos（不含）往文件头方向，按行从右到左回调。
 * 回调拿到「整行字节（不含 \n）」和「该行行首的文件偏移」，返回 false 即停止。
 * 按字节找 \n 再整行 decode——不会被块边界切断 UTF-8 多字节字符；跨块的长行靠 carry 拼接。
 */
const scanLinesBackward = async (
  fh: import("node:fs/promises").FileHandle,
  fromPos: number,
  onLine: (line: Buffer, lineStart: number) => boolean,
): Promise<void> => {
  let pos = fromPos;
  // 更靠文件尾一侧、尚未与更早块拼成「行首」的碎片（跨块行）；它在文件里的起点恒为 pos
  let carry = Buffer.alloc(0);
  while (pos > 0) {
    const toRead = Math.min(EVENTS_TAIL_CHUNK, pos);
    pos -= toRead;
    const buf = Buffer.allocUnsafe(toRead);
    const { bytesRead } = await fh.read(buf, 0, toRead, pos);
    const data = Buffer.concat([buf.subarray(0, bytesRead), carry]);
    let end = data.length;
    for (let i = data.length - 1; i >= 0; i--) {
      if (data[i] !== 0x0a) continue;
      if (!onLine(data.subarray(i + 1, end), pos + i + 1)) return;
      end = i;
    }
    carry = data.subarray(0, end);
  }
  // 文件第一行（行首偏移 0）
  if (carry.length > 0) onLine(carry, 0);
};

/**
 * 「事件 id → 它所在行的行首字节偏移」的小缓存，给连续上拉翻页用。
 *
 * 翻页是从最新往最旧一页接一页：下一页的锚点 = 上一页的第一条事件，我们刚刚扫过它、知道偏移，
 * 直接 seek 过去即可，不必再从文件尾重新扫到锚点。缓存只是**提示**：用之前必校验
 * （该偏移是行首、且那一行 parse 出来的 id 确实是锚点），对不上（文件被 rewind 重写等）就退回扫描，
 * 所以不会因为缓存陈旧而翻出错的页。
 */
const ANCHOR_OFFSET_CACHE_MAX = 256;
const anchorOffsetCache = new Map<string, number>();
const anchorKey = (taskId: string, eventId: string): string =>
  `${taskId}\u0000${eventId}`;
const rememberAnchorOffset = (
  taskId: string,
  eventId: string,
  offset: number,
): void => {
  const k = anchorKey(taskId, eventId);
  anchorOffsetCache.delete(k); // 重新插入 = 最近使用
  anchorOffsetCache.set(k, offset);
  while (anchorOffsetCache.size > ANCHOR_OFFSET_CACHE_MAX) {
    const oldest = anchorOffsetCache.keys().next().value;
    if (oldest === undefined) break;
    anchorOffsetCache.delete(oldest);
  }
};

/** 校验缓存的偏移：是行首，且这一行就是锚点事件 */
const verifyAnchorOffset = async (
  fh: import("node:fs/promises").FileHandle,
  size: number,
  offset: number,
  eventId: string,
): Promise<boolean> => {
  if (offset < 0 || offset >= size) return false;
  if (offset > 0) {
    const one = Buffer.allocUnsafe(1);
    const { bytesRead } = await fh.read(one, 0, 1, offset - 1);
    if (bytesRead !== 1 || one[0] !== 0x0a) return false;
  }
  // 从 offset 往后读到第一个 \n（或文件尾）。一行事件通常几百字节、但也可能是 MB 级的大行：
  // 块大小从 2KB 起步、逐次翻倍到 EVENTS_TAIL_CHUNK——常见情况只读一小块，大行也不会读成碎片
  let line = Buffer.alloc(0);
  let pos = offset;
  let chunkSize = 2048;
  while (pos < size) {
    const toRead = Math.min(chunkSize, size - pos);
    chunkSize = Math.min(chunkSize * 2, EVENTS_TAIL_CHUNK);
    const buf = Buffer.allocUnsafe(toRead);
    const { bytesRead } = await fh.read(buf, 0, toRead, pos);
    if (bytesRead === 0) break;
    const chunk = buf.subarray(0, bytesRead);
    const nl = chunk.indexOf(0x0a);
    if (nl >= 0) {
      line = Buffer.concat([line, chunk.subarray(0, nl)]);
      break;
    }
    line = Buffer.concat([line, chunk]);
    pos += bytesRead;
  }
  return parseEventLineBuf(line)?.id === eventId;
};

/**
 * 取 cursor（beforeId）之前紧邻的一页更早事件（时间正序）。
 *
 * **反向**读：翻历史总是从最新往旧翻，所以从文件尾往回找锚点、再往前收一页——IO 量跟「锚点离文件尾多远」
 * 同阶，而不是（旧实现）永远从文件头流式扫到锚点（翻最近几页也要读几乎整个文件）。
 * 连续翻页时下一页的锚点偏移已知（见 anchorOffsetCache），直接 seek，每页只读一页的量。
 * 语义与旧实现逐字节一致：返回原始行解析出的事件（不做 thinking 收口）、坏行 / 半行跳过、
 * hasMore = 锚点之前还有更早的有效事件、锚点不存在 → { events: [], hasMore: false }。
 * 前提：事件 id 在文件内唯一（appendEvent 契约「一个 id 只落一条」）——反向扫命中的是最后一次出现，
 * 旧实现命中第一次出现，唯一时两者等价。
 */
export const readEventsBefore = async (
  id: string,
  beforeId: string,
  limit: number,
): Promise<{ events: TaskEvent[]; hasMore: boolean }> => {
  const page = Math.max(0, Math.min(Math.floor(limit), MAX_EVENTS_PAGE));
  if (page === 0 || !beforeId) return { events: [], hasMore: false };

  const p = path.join(taskDir(id), EVENTS_FILE);
  if (!(await exists(p))) return { events: [], hasMore: false };

  const fh = await fs.open(p, "r");
  try {
    const { size } = await fh.stat();
    if (size === 0) return { events: [], hasMore: false };

    // 缓存命中且校验通过：直接从锚点行首往前收；否则从文件尾往回找锚点
    let startPos = size;
    let anchorFound = false;
    let anchorStart = -1;
    const cached = anchorOffsetCache.get(anchorKey(id, beforeId));
    if (cached !== undefined) {
      if (await verifyAnchorOffset(fh, size, cached, beforeId)) {
        startPos = cached;
        anchorFound = true;
        anchorStart = cached;
      } else {
        anchorOffsetCache.delete(anchorKey(id, beforeId));
      }
    }

    // 倒序收集：collected[0] = 紧邻锚点之前的那条。多收 1 条只为判 hasMore
    const collected: Array<{ ev: TaskEvent; start: number }> = [];
    await scanLinesBackward(fh, startPos, (lineBuf, lineStart) => {
      const ev = parseEventLineBuf(lineBuf);
      if (!ev) return true; // 空行 / 崩溃半行 / 坏 JSON
      if (!anchorFound) {
        if (ev.id === beforeId) {
          anchorFound = true;
          anchorStart = lineStart;
        }
        return true;
      }
      collected.push({ ev, start: lineStart });
      return collected.length <= page;
    });

    if (!anchorFound) return { events: [], hasMore: false };
    rememberAnchorOffset(id, beforeId, anchorStart);

    const hasMore = collected.length > page;
    const pageItems = hasMore ? collected.slice(0, page) : collected;
    // 这一页最旧的一条 = 下一页的锚点：记下它的行首偏移，连续上拉直接 seek
    const oldest = pageItems[pageItems.length - 1];
    if (oldest) rememberAnchorOffset(id, oldest.ev.id, oldest.start);
    return {
      events: pageItems.map((x) => x.ev).reverse(),
      hasMore,
    };
  } finally {
    await fh.close();
  }
};

/**
 * per-task events.jsonl 追加串行队列。
 *
 * Node 文档明确：同一文件并发 appendFile 不安全；且 tool_result 单行常 >8KB，
 * 超过 POSIX O_APPEND 原子写保证（管道缓冲通常 4KB～PIPE_BUF）。同 task 的写源
 * 含 run 流 / 后台 post-check / ask notifier 等，必须按 taskId 串行化。
 * 挂 globalThis：与 withTaskLock 同因——Next.js dev 多 chunk 下 module-level Map 会分裂。
 */
const EVENT_APPEND_CHAINS_KEY = "__flowshipEventAppendChainsV1__";
const getEventAppendChains = (): Map<string, Promise<void>> => {
  const g = globalThis as unknown as Record<
    string,
    Map<string, Promise<void>> | undefined
  >;
  if (!g[EVENT_APPEND_CHAINS_KEY]) g[EVENT_APPEND_CHAINS_KEY] = new Map();
  return g[EVENT_APPEND_CHAINS_KEY]!;
};

/**
 * per-task 进程内事件单调序号（与 append 链同挂 globalThis，防 chunk 分裂）。
 * 只在链内写行前发号，保证 seq 与磁盘 / publish 顺序一致。
 */
const EVENT_SEQ_COUNTERS_KEY = "__flowshipEventSeqCountersV1__";
const getEventSeqCounters = (): Map<string, number> => {
  const g = globalThis as unknown as Record<
    string,
    Map<string, number> | undefined
  >;
  if (!g[EVENT_SEQ_COUNTERS_KEY]) g[EVENT_SEQ_COUNTERS_KEY] = new Map();
  return g[EVENT_SEQ_COUNTERS_KEY]!;
};

/**
 * 从 events.jsonl **尾部窗口**求 max(seq)（近期兜底）。
 *
 * 分块向后扩展（64KB 起翻倍、上限 4MB）+ 对所见完整行求 max。
 * 尾窗 alone 不足以覆盖「末条 >4MB」——无完整行时强制全量扫。
 * 文件不存在 / 无 seq → foundAny=false。仅在 per-task append 链内调用（天然串行）。
 */
const SEQ_RECOVER_CHUNK_MIN = 64 * 1024;
const SEQ_RECOVER_CHUNK_MAX = 4 * 1024 * 1024;

/**
 * per-task seq high-water sidecar（task 目录下 `.event-seq`、内容 = 数字）。
 *
 * ## 恢复不变量（断言：任意恢复路径 restored ≥ durable 历史 max）
 *
 * - 内存 counter 在进程内精确；sidecar **批量推进**：成功 append 后若
 *   `seq - lastPersisted ≥ SEQ_SIDECAR_FLUSH_EVERY`（16）才异步原子写盘（tmp+rename、
 *   best-effort）。故 crash 时 sidecar ≤ durable max，且协议上落后至多 15 条。
 * - 恢复：`restored = max(sidecar ?? 全量扫, scanResult)`。
 *   - 缺 / 坏 sidecar → scanResult = 全量流式扫。
 *   - 有合法 sidecar → 先尾扫；若尾窗无任何完整 seq（含「文件 > 尾窗上限且窗口
 *     全是残行」——单条 assistant_message >4MB）→ **强制全量扫**，不再信 sidecar
 *     单独兜底（sidecar=0 合法落后时旧逻辑会重号）。
 *   - 统一 `restored = max(sidecar, scanResult)`：sidecar 只在 ≥ 扫描结果时抬水位。
 * - 写入：per-task promise 链串行 + 写前读盘只升不降（防两路异步 rename 反序回退）。
 * - DELETE：sidecar 随 task 目录删（天然，无需单独清理）。
 */
export const EVENT_SEQ_SIDECAR_FILE = ".event-seq";
/** sidecar 落后上限（条）；典型事件下 N 条落在 SEQ_RECOVER_CHUNK_MAX 内 */
const SEQ_SIDECAR_FLUSH_EVERY = 16;

/** 进程内「已调度/已确认写入 sidecar」水位（与 counter 同挂 globalThis） */
const EVENT_SEQ_SIDECAR_WRITTEN_KEY = "__flowshipEventSeqSidecarWrittenV1__";
const getEventSeqSidecarWritten = (): Map<string, number> => {
  const g = globalThis as unknown as Record<
    string,
    Map<string, number> | undefined
  >;
  if (!g[EVENT_SEQ_SIDECAR_WRITTEN_KEY]) {
    g[EVENT_SEQ_SIDECAR_WRITTEN_KEY] = new Map();
  }
  return g[EVENT_SEQ_SIDECAR_WRITTEN_KEY]!;
};

/** per-task sidecar 写串行链（挂 globalThis，与 HMR 寿命对齐） */
const EVENT_SEQ_SIDECAR_WRITE_CHAIN_KEY =
  "__flowshipEventSeqSidecarWriteChainV1__";
const getEventSeqSidecarWriteChains = (): Map<string, Promise<void>> => {
  const g = globalThis as unknown as Record<
    string,
    Map<string, Promise<void>> | undefined
  >;
  if (!g[EVENT_SEQ_SIDECAR_WRITE_CHAIN_KEY]) {
    g[EVENT_SEQ_SIDECAR_WRITE_CHAIN_KEY] = new Map();
  }
  return g[EVENT_SEQ_SIDECAR_WRITE_CHAIN_KEY]!;
};

const parseSeqNumber = (raw: string): number | null => {
  const t = raw.trim();
  if (!t) return null;
  // 只认纯整数字面（拒 "11abc" / 科学计数）
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  if (!Number.isSafeInteger(n) || n < 0) return null;
  return n;
};

/** 读 sidecar；缺文件 / 损坏 / 非数字 → null（调用方走全量扫描） */
export const readSeqSidecar = async (
  taskId: string,
): Promise<number | null> => {
  const p = path.join(taskDir(taskId), EVENT_SEQ_SIDECAR_FILE);
  try {
    const raw = await fs.readFile(p, "utf-8");
    return parseSeqNumber(raw);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    // 其它读错当损坏——不抛、走全量扫描
    console.warn(
      `[task-fs-core] 读 seq sidecar 失败 task=${taskId}，fallback 全量扫描：`,
      err,
    );
    return null;
  }
};

/**
 * 原子写 sidecar（tmp+rename、best-effort）。
 * per-task 串行 + 写前读盘只升不降——两路异步 rename 反序也不得把水位打退。
 * 导出供 反序写测试直接调度。
 */
export const persistSeqSidecar = async (
  taskId: string,
  seq: number,
): Promise<void> => {
  const chains = getEventSeqSidecarWriteChains();
  const prev = chains.get(taskId) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(async () => {
    // 只升不降——盘上已有更大值则跳过本次写
    const current = await readSeqSidecar(taskId);
    if (current !== null && current >= seq) return;

    const finalPath = path.join(taskDir(taskId), EVENT_SEQ_SIDECAR_FILE);
    const tmpPath = `${finalPath}.tmp.${process.pid}.${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    try {
      await fs.writeFile(tmpPath, String(seq), "utf-8");
      await renameWithRetry(tmpPath, finalPath);
    } catch (err) {
      await fs.unlink(tmpPath).catch(() => {});
      console.warn(
        `[task-fs-core] 写 seq sidecar 失败（best-effort）task=${taskId} seq=${seq}：`,
        err,
      );
    }
  });
  // 链上挂 settled promise，前序失败不堵后续
  chains.set(
    taskId,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  await run;
};

/**
 * 批量推进 sidecar——seq 相对 lastPersisted 跨过 N 才 fire-and-forget。
 * 乐观记水位防 stampede；写失败则 sidecar 更旧，恢复靠尾扫 / 全量扫兜住。
 */
const maybeFlushSeqSidecar = (taskId: string, seq: number): void => {
  const written = getEventSeqSidecarWritten();
  const last = written.get(taskId) ?? 0;
  if (seq - last < SEQ_SIDECAR_FLUSH_EVERY) return;
  written.set(taskId, seq);
  void persistSeqSidecar(taskId, seq);
};

/** 从一行 JSON 抽 seq（坏行 / 无字段 → 忽略） */
const seqFromEventLine = (line: string): number | null => {
  const t = line.trim();
  if (!t) return null;
  try {
    const parsed = JSON.parse(t) as { seq?: unknown };
    if (typeof parsed.seq === "number" && Number.isFinite(parsed.seq)) {
      return parsed.seq;
    }
  } catch {
    // 坏行
  }
  return null;
};

/**
 * 全文件流式扫 max(seq)——旧数据缺 sidecar / sidecar 损坏 / 尾窗空时用；
 * 逐行 readline，不整读进内存。
 */
const scanMaxSeqFullFile = async (taskId: string): Promise<number> => {
  const p = path.join(taskDir(taskId), EVENTS_FILE);
  try {
    const stream = createReadStream(p, { encoding: "utf-8" });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    let maxSeq = 0;
    try {
      for await (const line of rl) {
        const s = seqFromEventLine(line);
        if (s !== null && s > maxSeq) maxSeq = s;
      }
    } finally {
      rl.close();
      stream.destroy();
    }
    return maxSeq;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw err;
  }
};

/** 尾扫结果——带 foundAny / fileSize，供「无完整行 → 强制全量扫」判定 */
type TailSeqScan = {
  maxSeq: number;
  foundAny: boolean;
  fileSize: number;
};

const readMaxSeqFromDurableTail = async (
  taskId: string,
): Promise<TailSeqScan> => {
  const p = path.join(taskDir(taskId), EVENTS_FILE);
  try {
    const st = await fs.stat(p);
    if (st.size <= 0) {
      return { maxSeq: 0, foundAny: false, fileSize: 0 };
    }
    const fh = await fs.open(p, "r");
    try {
      // 64KB 起翻倍扩块；首行截断（start>0）时跳过残行
      // 上限 4MB——对窗口内所有完整行求 max(seq)，不是「尾部第一个」
      let chunk = Math.min(SEQ_RECOVER_CHUNK_MIN, st.size);
      let maxSeq = 0;
      let foundAny = false;
      for (;;) {
        const start = Math.max(0, st.size - chunk);
        const len = st.size - start;
        const buf = Buffer.alloc(len);
        await fh.read(buf, 0, len, start);
        const text = buf.toString("utf-8");
        const lines = text.split("\n");
        // 非文件头起读时首行可能被截断，跳过
        const startIdx = start > 0 ? 1 : 0;
        // 每轮重算本窗口 max（扩块后覆盖更大历史）
        maxSeq = 0;
        foundAny = false;
        for (let i = startIdx; i < lines.length; i++) {
          const s = seqFromEventLine(lines[i] ?? "");
          if (s !== null) {
            foundAny = true;
            if (s > maxSeq) maxSeq = s;
          }
        }
        // 已到文件头 / 触顶 → 收工；否则首行仍可能截断（含末条 >64KB）→ 翻倍扩块
        if (start === 0 || chunk >= SEQ_RECOVER_CHUNK_MAX || chunk >= st.size) {
          return {
            maxSeq: foundAny ? maxSeq : 0,
            foundAny,
            fileSize: st.size,
          };
        }
        chunk = Math.min(chunk * 2, SEQ_RECOVER_CHUNK_MAX, st.size);
      }
    } finally {
      await fh.close();
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { maxSeq: 0, foundAny: false, fileSize: 0 };
    }
    throw err;
  }
};

/**
 * Map miss 时恢复 durable max 灌入 counter，再发号。
 * 必须在 append 链内 await——恢复与发号同序、无并发。
 *
 * ## 不变量（任何恢复路径）
 * `restored ≥ durable max(seq)`——缺 sidecar 全量扫；有 sidecar 时
 * `restored = max(sidecar, scanResult)`，且尾窗无完整行时 scanResult 必为全量扫。
 */
const ensureEventSeqCounter = async (taskId: string): Promise<void> => {
  const counters = getEventSeqCounters();
  if (counters.has(taskId)) return;

  const sidecar = await readSeqSidecar(taskId);
  let restored: number;
  if (sidecar === null) {
    // 缺 / 坏 sidecar → 一次性全文件流式扫（旧数据迁移 / 损坏兜底）
    restored = await scanMaxSeqFullFile(taskId);
  } else {
    const tail = await readMaxSeqFromDurableTail(taskId);
    let scanResult = tail.maxSeq;
    // 尾窗无完整 seq → 强制全量扫。
    // 主触发面：fileSize > SEQ_RECOVER_CHUNK_MAX（4MB）且窗口全是残行（末条超窗）；
    // 同时覆盖「sidecar 合法但尾窗空」——不再用 sidecar 单独把 restored 定成 0。
    if (!tail.foundAny) {
      scanResult = await scanMaxSeqFullFile(taskId);
    }
    restored = Math.max(sidecar, scanResult);
  }
  // 断言注释：此处 restored 已 ≥ durable max（全量扫或「尾扫+sidecar≤15 协议」保证）

  // 链内串行：await 后仍 miss 才写入（防极端重复 ensure）
  if (!counters.has(taskId)) {
    counters.set(taskId, restored);
  }
  // 懒恢复后立刻对齐 sidecar（异步 best-effort；内存水位同步记上；盘写只升不降）
  getEventSeqSidecarWritten().set(taskId, restored);
  void persistSeqSidecar(taskId, restored);
};

/** 为 task 发下一个单调 seq（1-based）；调用前须 ensureEventSeqCounter */
const nextEventSeq = (taskId: string): number => {
  const counters = getEventSeqCounters();
  const n = (counters.get(taskId) ?? 0) + 1;
  counters.set(taskId, n);
  return n;
};

/**
 * appendFile 失败（ENOENT）时回退刚发的号——同步链内无并发，
 * 仅当 counter 仍等于本次 seq 才回退，避免误伤后续成功写入。
 */
const rollbackEventSeq = (taskId: string, seq: number): void => {
  const counters = getEventSeqCounters();
  if (counters.get(taskId) !== seq) return;
  if (seq <= 1) counters.delete(taskId);
  else counters.set(taskId, seq - 1);
};

/**
 * 仅在 events 文件真删（deleteTask）时清 seq counter。
 * stop / cleanupChatTaskState 不再清——文件还在、counter 保持才单调。
 * 同时清 sidecar 内存水位（盘上 sidecar 随目录删 / 模拟重启时保留）。
 * 顺带摘掉写链入口（进行中的写仍会跑完；新写重新挂链）。
 */
export const clearEventSeqCounter = (taskId: string): void => {
  getEventSeqCounters().delete(taskId);
  getEventSeqSidecarWritten().delete(taskId);
  getEventSeqSidecarWriteChains().delete(taskId);
};

/**
 * 「本进程已确认 events.jsonl 末尾是换行」的 taskId 集合（2026-10-20 第二轮 review V8-01）。
 *
 * 崩溃 / ENOSPC 可能在文件末尾留下一条没写完的半行（不以 `\n` 结尾）。下一条事件若直接 append，
 * 会被粘进那行坏数据：当次已 publish 上屏，但刷新 / 重连 / 换窗口都读不回来，而 seq、sidecar 照常前进。
 * 所以每个 task 在本进程内第一次写之前（以及任何一次写失败之后）读一下末字节，不是 `\n` 就先补一个——
 * 坏半行被隔离成独立一行（读侧本来就会跳过解析失败的行），新事件完整落盘。
 * 挂 globalThis：与其他 per-task 状态同因，Next dev 多 chunk 下 module-level 会分裂。
 */
const EVENT_TAIL_VERIFIED_KEY = "__flowshipEventTailVerifiedV1__";
const getEventTailVerified = (): Set<string> => {
  const g = globalThis as unknown as Record<string, Set<string> | undefined>;
  if (!g[EVENT_TAIL_VERIFIED_KEY]) g[EVENT_TAIL_VERIFIED_KEY] = new Set();
  return g[EVENT_TAIL_VERIFIED_KEY]!;
};

/** 文件非空且末字节不是 `\n` → true（需要先补一个换行）；文件不存在 / 为空 → false */
const eventsFileTailNeedsNewline = async (file: string): Promise<boolean> => {
  let fh: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    fh = await fs.open(file, "r");
    const { size } = await fh.stat();
    if (size === 0) return false;
    const buf = Buffer.alloc(1);
    await fh.read(buf, 0, 1, size - 1);
    return buf[0] !== 0x0a;
  } catch (err) {
    // 文件还没建（首条事件）/ 目录已删：没有坏尾巴可言；appendFile 自己会处理 ENOENT
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    // 其它读失败不挡写入：保持旧行为（直接 append）
    return false;
  } finally {
    await fh?.close().catch(() => {});
  }
};

/**
 * 实际 append（无串行）。
 * @returns true=已写入；false=ENOENT（任务目录已删、透传给上层不 publish）
 */
const appendEventLineUnlocked = async (
  id: string,
  ev: TaskEvent,
): Promise<boolean> => {
  // 不再无条件 mkdir：审查发现与 deleteTask 竞态时会把已删目录「复活」。
  // 调用方约定目录已存在（createTask 先 writeMeta；appendEvent 先查 meta；boot recovery 已有 meta）。
  // 目录没了 = 任务已删 → ENOENT 返 false（上层不构造成功、不 publish 幽灵事件）。
  const file = path.join(taskDir(id), EVENTS_FILE);
  const verified = getEventTailVerified();
  try {
    const healNewline = verified.has(id)
      ? false
      : await eventsFileTailNeedsNewline(file);
    await fs.appendFile(
      file,
      // 落盘前精确脱敏 gitToken / apiKey / 公司环境密码（agent 读 config.json / company-env.json
      // 取凭据会让它进 tool_result）；命中时原地改 ev，之后 publish 的也是脱敏版
      (healNewline ? "\n" : "") + serializeEventLineRedacted(ev) + "\n",
      "utf-8",
    );
    verified.add(id);
    return true;
  } catch (err) {
    // 写失败可能留下半行：下次写前重新核对末字节
    verified.delete(id);
    // 任务目录已删 → false（第五轮 Q3-08：macOS 并发删除时可能是 EINVAL / ENOTDIR 而不只是 ENOENT，见 fs-gone.ts）
    if (await isDirGoneError(err, taskDir(id))) return false;
    throw err;
  }
};

/**
 * 在某 task 的 events.jsonl **追加链**里跑一段（与 {@link appendEventLine} 同一条 per-task 链、同一套
 * 「前一个失败也跑本次 / 链尾永不 reject」语义）。
 *
 * 为什么要有它（2026-10-23 评审 BE5）：回退要**整文件重写** events.jsonl（读全量 → slice → tmp + rename），
 * 而 {@link appendEventLine} 不拿 `withTaskLock`，两者互不排斥——读和 rename 之间若有 `appendFile` 落到旧文件，
 * rename 之后那一行就没了（客户端已经收到 publish、磁盘上却没有，seq 出现空洞）。现实写者：
 * 旁路群答疑 run（`restricted-question` 的 `writeOwnedEventAndPublish`）不被回退的 idle 守卫挡住。
 * 整文件重写必须排进这条链：链内写者先落完、重写拿到的是一致快照，之后排队的写者落在截断后的文件上。
 *
 * ⚠ `fn` 里**不能**再调 `appendEventLine` / `appendEvent` / 本函数（同 task）——它们要等本条链，会死锁。
 * 也不要在 `fn` 里去取 `withTaskLock`：调用方可能已经持锁（回退就是），链内再取锁、而持锁者在等链 = 互等。
 * （链内现有写者——lease / onCommitted / seq 发号——都不取 withTaskLock，所以「先持锁、再进链」是安全的。）
 */
export const withEventAppendChain = async <T>(
  id: string,
  fn: () => Promise<T>,
): Promise<T> => {
  const chains = getEventAppendChains();
  const previous = chains.get(id) ?? Promise.resolve();
  // previous 失败也跑本次（.then(fn, fn)）；本次失败仍抛给 await 方
  const next = previous.then(fn, fn);
  // 链尾永不 reject，避免一次失败毒死后续排队者
  const retained = next.then(
    () => undefined,
    () => undefined,
  );
  chains.set(id, retained);
  try {
    return await next;
  } finally {
    if (chains.get(id) === retained) {
      chains.delete(id);
    }
  }
};

/**
 * 追加一条事件行（按 taskId 串行）。
 * 链上单次写入失败会抛给调用方，但不中断后续写入（catch 后继续）。
 *
 * OrderedEventCommit：写行成功后、链内同步调用 onCommitted（通常 = publish），
 * 再释放链——杜绝「A 写完等 meta touch、B 先 publish」的 SSE/磁盘反序。
 *
 * @param lease 可选；在 chain 回调内、appendFile 之前同步执行。
 *   false → 跳过写盘、返 false（堵死「检查通过后入队、B claim、队列才执行 A」）。
 * @param onCommitted 可选；写行成功且 failpoint 通过后、仍在链内同步调用。
 * @returns true=已 append；false=lease 拒写或 ENOENT
 */
export const appendEventLine = async (
  id: string,
  ev: TaskEvent,
  lease?: () => boolean,
  onCommitted?: (event: TaskEvent) => void,
): Promise<boolean> => {
  // lease 必须在 chain 内、appendFile 前同步验——入队后失主则拒写
  const run = async (): Promise<boolean> => {
    await failpoint("event.inQueue");
    // lease 拒绝路径不发号（不烧号）；发号紧挨即将 appendFile
    if (lease && !lease()) return false;
    // Map miss（stop 后 / 进程重启）→ 先从 durable 尾部恢复再发号
    await ensureEventSeqCounter(id);
    // 链内、lease 通过后发号——与写盘 / publish 同序
    ev.seq = nextEventSeq(id);
    // ENOENT 透传 false——上层 appendEvent 返 null、write* 不 publish
    const ok = await appendEventLineUnlocked(id, ev);
    if (!ok) {
      // 未落盘——回退刚发的号，避免烧号空洞
      rollbackEventSeq(id, ev.seq);
      delete ev.seq;
      return false;
    }
    // 落盘成功后批量推进 sidecar（每 N 条异步原子写，非每条同步）
    maybeFlushSeqSidecar(id, ev.seq);
    // 写行成功后、publish 前——矩阵可挂起证明 B 不能插队 publish
    await failpoint("event.beforePublish");
    // onCommitted（通常 publish）抛错不得断 append 链——写盘已成功，吞错继续放链
    try {
      onCommitted?.(ev);
    } catch (err) {
      console.error(
        `[task-fs-core] onCommitted 抛错 task=${id} seq=${ev.seq}：`,
        err,
      );
    }
    return true;
  };
  return withEventAppendChain(id, run);
};

/**
 * 同步读盘上 sessionAgentId（finalGuard 用、无 await 夹缝）。
 * 读失败 / 缺字段 → undefined。
 */
export const readSessionAgentIdSync = (taskId: string): string | undefined => {
  try {
    const raw = JSON.parse(
      readFileSync(path.join(taskDir(taskId), META_FILE), "utf-8"),
    ) as { sessionAgentId?: unknown };
    return typeof raw.sessionAgentId === "string"
      ? raw.sessionAgentId
      : undefined;
  } catch {
    return undefined;
  }
};

// ----------------- hydrate（meta → Task）-----------------

/** meta + 已读好的 events → Task（不 IO） */
export const assembleTask = (
  meta: TaskMetaV06,
  events: TaskEvent[],
): Task => ({
  id: meta.id,
  title: meta.title,
  titleAutoPending: meta.titleAutoPending,
  mode: meta.mode,
  workRole: meta.workRole,
  repoStatus: meta.repoStatus,
  runStatus: meta.runStatus,
  currentActionId: meta.currentActionId,
  actions: meta.actions,
  mrs: meta.mrs,
  gitBranches: meta.gitBranches,
  feishuTesterUserKeys: meta.feishuTesterUserKeys,
  repoPaths: meta.repoPaths,
  nonGitRepoPaths: meta.nonGitRepoPaths,
  readonlyRepoPaths: meta.readonlyRepoPaths,
  scriptRepoPaths: meta.scriptRepoPaths,
  repoBaseBranches: meta.repoBaseBranches,
  repoFeatureBranches: meta.repoFeatureBranches,
  repoTestBranches: meta.repoTestBranches,
  repoDevBranches: meta.repoDevBranches,
  repoBranchTemplates: meta.repoBranchTemplates,
  feishuStoryUrl: meta.feishuStoryUrl,
  feishuGroupChatId: meta.feishuGroupChatId,
  feishuGroupChatName: meta.feishuGroupChatName,
  reqId: meta.reqId,
  contextDocs: meta.contextDocs,
  disabledMcpServers: meta.disabledMcpServers,
  isolateWorktree: meta.isolateWorktree,
  sessionAgentId: meta.sessionAgentId,
  // 保命轮换水位透传（2026-09-03 OOM 根治、meta 落盘、见 session-rotate.ts）
  sessionInputTokens: meta.sessionInputTokens,
  // 计算字段（不落盘）：agent 实际工作目录——隔离 task = worktree cwd、否则 = 原仓库 cwd。
  // client 的「在 IDE 打开工作区 / 复制路径 / 预览」都要它、而 dataRoot 只有 server 知道
  workCwd: getTaskCwd(meta),
  // 计算字段（不落盘）：任务数据目录（artifact / workspace / 事件日志所在）——
  // client 的「打开任务文件夹」按钮用
  taskDirPath: taskDir(meta.id),
  removeSourceBranchOnMerge: meta.removeSourceBranchOnMerge,
  pinned: meta.pinned,
  archived: meta.archived,
  pendingAskId: meta.pendingAskId,
  createdAt: meta.createdAt,
  updatedAt: meta.updatedAt,
  tokenUsage: meta.tokenUsage,
  model: meta.model,
  provider: meta.provider,
  uiLayout: meta.uiLayout,
  lastRewind: meta.lastRewind,
  events,
});

/**
 * meta → Task
 * - 读全量 events.jsonl + 每条 action 的 artifact、组合成完整 Task object
 */
export const hydrateTask = async (meta: TaskMetaV06): Promise<Task> => {
  const events = await readEvents(meta.id);
  return assembleTask(meta, events);
};

/**
 * meta → Task，只带尾部 n 条事件（长任务详情 / SSE bootstrap 用）。
 * eventsTruncated = hasMore（文件里还有更早事件）。
 */
export const hydrateTaskWithTailEvents = async (
  meta: TaskMetaV06,
  tail: number,
  opts?: { anchor?: (ev: TaskEvent) => boolean },
): Promise<Task> => {
  const { events, hasMore } = await readEventsTail(meta.id, tail, opts);
  const task = assembleTask(meta, events);
  if (hasMore) task.eventsTruncated = true;
  return task;
};

/**
 * task summary（V0.5.3 引入、V0.6 调整字段）
 * 列表场景用、不读 events.jsonl / artifact 内容
 */
export const hydrateTaskSummary = (meta: TaskMetaV06): TaskSummary => {
  const lastAction = meta.actions[meta.actions.length - 1];
  return {
    id: meta.id,
    title: meta.title,
    titleAutoPending: meta.titleAutoPending,
    mode: meta.mode,
    workRole: meta.workRole,
    repoStatus: meta.repoStatus,
    runStatus: meta.runStatus,
    currentActionId: meta.currentActionId,
    mrs: meta.mrs,
    gitBranches: meta.gitBranches,
    feishuTesterUserKeys: meta.feishuTesterUserKeys,
    repoPaths: meta.repoPaths,
    feishuStoryUrl: meta.feishuStoryUrl,
    // 本任务群关联进摘要：群回流按摘要扫任务（省得为反查读全量事件），缺了本地关联就不可见
    feishuGroupChatId: meta.feishuGroupChatId,
    feishuGroupChatName: meta.feishuGroupChatName,
    contextDocs: meta.contextDocs,
    disabledMcpServers: meta.disabledMcpServers,
    pinned: meta.pinned,
    archived: meta.archived,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    model: meta.model,
    provider: meta.provider,
    uiLayout: meta.uiLayout,
    sessionAgentId: meta.sessionAgentId,
    actionCount: meta.actions.length,
    lastActionType: lastAction?.type,
    lastActionStatus: lastAction?.status,
    // 侧栏「待回答」看这个、不看 action 状态组合（断掉态同为 awaiting_user+running）
    hasPendingAsk: !!meta.pendingAskId,
  };
};
