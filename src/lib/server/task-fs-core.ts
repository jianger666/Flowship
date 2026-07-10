/**
 * task-fs 基建层（V0.9.x 从 task-fs.ts 拆出、纯搬家零逻辑变更）
 *
 * 职责（task-fs / task-artifacts 共用的底座）：
 *   - 数据目录路径常量 + id 生成 + 路径 helper（events.jsonl / actions/ / artifact / check log）
 *   - meta.json 类型（TaskMetaV06）+ zod schema 校验 + 原子读写
 *   - per-task mutex（withTaskLock、挂 globalThis）
 *   - 事件流读写（readEvents / appendEventLine）
 *   - hydrate（meta → Task / TaskSummary）
 *
 * 依赖方向（保证无环）：只依赖 types / data-root、不 import task-fs / task-artifacts。
 * 数据布局说明见 task-fs.ts 顶部注释。
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import type {
  ActionRecord,
  ActionType,
  GitBranchInfo,
  MRRecord,
  ModelSelection,
  RepoStatus,
  RunStatus,
  Task,
  TaskContextDoc,
  TaskEvent,
  TaskMode,
  TaskRole,
  TaskSummary,
} from "@/lib/types";
import { ACTION_TYPES, TASK_ROLES } from "@/lib/types";
import { dataRoot } from "./data-root";
// 只用其纯函数（getTaskCwd 路径计算、零 IO）、task-worktrees 不反向依赖本模块（无环）
import { getTaskCwd } from "./task-worktrees";
import { z } from "zod";

// ----------------- 路径常量 -----------------

export const DATA_DIR = path.join(dataRoot(), "tasks");
export const META_FILE = "meta.json";
export const EVENTS_FILE = "events.jsonl";
export const ACTIONS_DIR = "actions";
export const REVISIONS_SUBDIR = ".revisions";
// 划除（软删）的 artifact 挪进这个隐藏子目录——跟 .revisions / .checks 同风格、
// agent 的 ls / rg 默认都扫不到、防被按编号拼路径翻出来读（V0.8.16、见 setActionArtifactExcluded）
export const EXCLUDED_SUBDIR = ".excluded";
// 单 action 最多保留 10 个 revision、超出 GC 删最早（沿用 V0.5.12 的上限策略）
export const MAX_REVISIONS_PER_ACTION = 10;

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
 * agent cwd 是用户业务仓库、不是 ai-flow 本身、所以必须用绝对路径
 */
export const getEventsLogPath = (taskId: string): string =>
  path.join(taskDir(taskId), EVENTS_FILE);

/**
 * actions/ 目录的绝对路径（给 prompt 用、agent 写 artifact 走这里）
 */
export const getActionsDir = (taskId: string): string =>
  path.join(taskDir(taskId), ACTIONS_DIR);

/**
 * 给单条 action 算 artifact 文件名（相对名、不含目录前缀）
 * 命名规则：`<N>-<type>.md`、N 不前导 0、跟 V0.6-REFACTOR.md §4.3 一致
 */
export const actionArtifactFilename = (n: number, type: ActionType): string =>
  `${n}-${type}.md`;

/**
 * 给单条 action 算 artifact 相对路径（meta 里 `ActionRecord.artifactPath` 存这个）
 * 例：`actions/1-plan.md`
 */
export const actionArtifactRelPath = (n: number, type: ActionType): string =>
  `${ACTIONS_DIR}/${actionArtifactFilename(n, type)}`;

/**
 * 给单条 action 算 artifact 绝对路径（prompt 里塞给 agent）
 */
export const getActionArtifactPath = (
  taskId: string,
  n: number,
  type: ActionType,
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
  mode?: TaskMode;
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
  role: TaskRole;
  repoPaths: string[];
  /** V0.6.3：per-repo 线上分支（key=repoPath、建 task 时从 settings 快照、空则 build 探 origin/HEAD） */
  repoBaseBranches?: Record<string, string>;
  /** V0.6.3：per-repo「已有工作分支」覆盖（key=repoPath、建 task 时用户填、空则 build 用算法名） */
  repoFeatureBranches?: Record<string, string>;
  /** V0.6.7：per-repo 测试分支快照（ship 提测目标、空则回退默认 test） */
  repoTestBranches?: Record<string, string>;
  /** V0.6.7：per-repo dev 分支快照（暂存、无固定用途） */
  repoDevBranches?: Record<string, string>;
  /** V0.6.7：per-repo 有效命名模板快照（build 渲染分支名用） */
  repoBranchTemplates?: Record<string, string>;
  feishuStoryUrl?: string;
  contextDocs?: TaskContextDoc[];
  disabledMcpServers?: string[];
  /** V0.10：任务隔离工作区开关（新建默认 true、逃生口 false、详见 types.ts Task.isolateWorktree） */
  isolateWorktree?: boolean;
  /** V0.11.1：最近一次 agent 会话的 agentId（服务重启后 Agent.resume 续会话、详见 types.ts） */
  sessionAgentId?: string;
  /** V0.6.14：ship 合并后是否删源分支（缺省保留、详见 types.ts Task.removeSourceBranchOnMerge） */
  removeSourceBranchOnMerge?: boolean;
  /** V0.8 侧栏：用户置顶（缺省 false） */
  pinned?: boolean;
  createdAt: number;
  updatedAt: number;
  model?: ModelSelection;
  uiLayout?: { artifactPanelSize?: number };
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
    // V0.9：持久化的 action 可以是 custom（运行时类型、故意不进 ACTION_TYPES 内置清单）。
    // schema 必须放行 custom、否则推过 custom 的 task meta.json 会校验不过 → getTask 返 null /
    // readMetaV06 抛错 → 整个 task 从此读不了（404 / 历史报错）。漏了这条是 V0.9 首发的数据损坏 bug。
    type: z.enum([...ACTION_TYPES, "custom"] as const),
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
    role: z.enum(TASK_ROLES), // 单一源（CR-07）：枚举扩展只改 types.ts
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

// per-task mutex（防 read-modify-write race、沿用 V0.5）
//
// V0.6.27 改挂 globalThis：本模块被十几个 route import、Next.js dev 下不同 route
// 是不同 webpack chunk、module-level Map 会各持一份（chat-mcp V0.3.3 实测踩过）——
// 锁不共享 = withTaskLock 跨 route 不互斥、并发 patch meta.json 可能丢更新。
const TASK_LOCKS_KEY = "__feAiFlowTaskFsLocksV1__";
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

export const writeMeta = async (meta: TaskMetaV06): Promise<void> => {
  const dir = taskDir(meta.id);
  await fs.mkdir(dir, { recursive: true });
  const finalPath = path.join(dir, META_FILE);
  // 原子写：tmp + rename
  const tmpPath = `${finalPath}.tmp.${process.pid}.${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  try {
    await fs.writeFile(tmpPath, JSON.stringify(meta, null, 2), "utf-8");
    // Windows：目标文件被并发读 / 杀软扫描持有句柄时 rename 会 EPERM（同事线上实测、
    // mac/linux 无此语义）——短退避重试几轮、基本都能等到句柄释放；重试穿透才抛
    let lastErr: unknown;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await fs.rename(tmpPath, finalPath);
        return;
      } catch (err) {
        lastErr = err;
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "EPERM" && code !== "EACCES" && code !== "EBUSY") throw err;
        await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
      }
    }
    throw lastErr;
  } catch (err) {
    await fs.unlink(tmpPath).catch(() => {});
    throw err;
  }
};

// ----------------- 事件流 -----------------

export const readEvents = async (id: string): Promise<TaskEvent[]> => {
  const p = path.join(taskDir(id), EVENTS_FILE);
  if (!(await exists(p))) return [];
  const raw = await fs.readFile(p, "utf-8");
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line) as TaskEvent;
      } catch {
        return null;
      }
    })
    .filter((x): x is TaskEvent => x !== null);
};

export const appendEventLine = async (
  id: string,
  ev: TaskEvent,
): Promise<void> => {
  const dir = taskDir(id);
  await fs.mkdir(dir, { recursive: true });
  await fs.appendFile(
    path.join(dir, EVENTS_FILE),
    JSON.stringify(ev) + "\n",
    "utf-8",
  );
};

// ----------------- hydrate（meta → Task）-----------------

/**
 * meta → Task
 * - 读 events.jsonl + 每条 action 的 artifact、组合成完整 Task object
 */
export const hydrateTask = async (meta: TaskMetaV06): Promise<Task> => {
  const events = await readEvents(meta.id);
  return {
    id: meta.id,
    title: meta.title,
    mode: meta.mode,
    repoStatus: meta.repoStatus,
    runStatus: meta.runStatus,
    currentActionId: meta.currentActionId,
    actions: meta.actions,
    mrs: meta.mrs,
    gitBranches: meta.gitBranches,
    feishuTesterUserKeys: meta.feishuTesterUserKeys,
    role: meta.role,
    repoPaths: meta.repoPaths,
    repoBaseBranches: meta.repoBaseBranches,
    repoFeatureBranches: meta.repoFeatureBranches,
    repoTestBranches: meta.repoTestBranches,
    repoDevBranches: meta.repoDevBranches,
    repoBranchTemplates: meta.repoBranchTemplates,
    feishuStoryUrl: meta.feishuStoryUrl,
    contextDocs: meta.contextDocs,
    disabledMcpServers: meta.disabledMcpServers,
    isolateWorktree: meta.isolateWorktree,
    sessionAgentId: meta.sessionAgentId,
    // 计算字段（不落盘）：agent 实际工作目录——隔离 task = worktree cwd、否则 = 原仓库 cwd。
    // client 的「在 IDE 打开工作区 / 复制路径 / 预览」都要它、而 dataRoot 只有 server 知道
    workCwd: getTaskCwd(meta),
    removeSourceBranchOnMerge: meta.removeSourceBranchOnMerge,
    pinned: meta.pinned,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    model: meta.model,
    uiLayout: meta.uiLayout,
    events,
  };
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
    mode: meta.mode,
    repoStatus: meta.repoStatus,
    runStatus: meta.runStatus,
    currentActionId: meta.currentActionId,
    mrs: meta.mrs,
    gitBranches: meta.gitBranches,
    feishuTesterUserKeys: meta.feishuTesterUserKeys,
    role: meta.role,
    repoPaths: meta.repoPaths,
    feishuStoryUrl: meta.feishuStoryUrl,
    contextDocs: meta.contextDocs,
    disabledMcpServers: meta.disabledMcpServers,
    pinned: meta.pinned,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    model: meta.model,
    uiLayout: meta.uiLayout,
    actionCount: meta.actions.length,
    lastActionType: lastAction?.type,
    lastActionStatus: lastAction?.status,
  };
};
