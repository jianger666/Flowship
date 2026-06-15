/**
 * Server-side 任务持久化层（V0.6）
 *
 * 数据布局：
 *
 *   data/
 *     tasks/
 *       <taskId>/
 *         meta.json          ← 任务元信息、含 actions[] / mrs[] / gitBranches[]
 *         events.jsonl       ← 事件流、每行一条 JSON、追加写
 *         actions/           ← 每条 action 一个 artifact
 *           1-plan.md
 *           2-build.md
 *           3-review.md
 *           4-ship.md
 *           5-build.md       ← 测试报 bug 后再次 build
 *           ...
 *           .revisions/      ← V0.5.12 「再聊聊」前的 snapshot、V0.6 按 actionId 分目录
 *             act_2/
 *               2026-05-25T05-44-39-123Z.md
 *         uploads/           ← 用户粘贴 / 拖的图片
 *           att_xxx.png
 *
 * V0.5 → V0.6 关键变化（不写 migration、老数据直接清空）：
 * - phase chain → action history（plan/build/review/ship/test/learn 自由触发；chat 走独立 mode、不在 actions[] 里）
 * - `phases` 三段位 → `actions[]` 数组（按时间正序、N 累计）
 * - artifact 命名 `01-plan.md` → `N-plan.md`（不前导 0、N 是 ActionRecord.n）
 * - `currentPhase` → `currentActionId`
 * - `TaskStatus` → `runStatus` + `repoStatus`（运行时 vs 业务）
 * - V0.5 的 `WorkflowId` 概念删除；`TaskMode` V0.6.0 砍了 / V0.6.0.1 又拉回来（chat 走独立通路、不复用 action 体系）
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import type {
  ActionRecord,
  ActionType,
  ArtifactRevision,
  CheckCommand,
  CheckCommandKind,
  GitBranchInfo,
  MRRecord,
  ModelSelection,
  NewTaskInput,
  RepoStatus,
  RunStatus,
  Task,
  TaskContextDoc,
  TaskContextDocType,
  TaskEvent,
  TaskMode,
  TaskRole,
  TaskSummary,
} from "@/lib/types";
import { CHECK_COMMAND_KIND_LABEL, ACTION_TYPES } from "@/lib/types";
import { getEffectiveCwd } from "@/lib/path-utils";
import { dataRoot } from "./data-root";
import { detectRepoCheckCommands } from "./repo-check-detect";
import { z } from "zod";

// ----------------- 路径常量 -----------------

const DATA_DIR = path.join(dataRoot(), "tasks");
const META_FILE = "meta.json";
const EVENTS_FILE = "events.jsonl";
const ACTIONS_DIR = "actions";
const REVISIONS_SUBDIR = ".revisions";
// 单 action 最多保留 10 个 revision、超出 GC 删最早（沿用 V0.5.12 的上限策略）
const MAX_REVISIONS_PER_ACTION = 10;

// ----------------- id 生成 / 校验 -----------------

const newTaskId = (): string =>
  `t_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

const newEventId = (): string =>
  `e_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

const newActionId = (n: number): string => `act_${n}`;

const newContextDocId = (): string =>
  `ctx_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

const newAttachmentId = (): string =>
  `att_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

// 防路径穿越：只允许字母数字下划线
const sanitizeId = (id: string): string => {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new Error(`非法 id: ${id}`);
  }
  return id;
};

const taskDir = (id: string): string => path.join(DATA_DIR, sanitizeId(id));

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
const actionArtifactFilename = (n: number, type: ActionType): string =>
  `${n}-${type}.md`;

/**
 * 给单条 action 算 artifact 相对路径（meta 里 `ActionRecord.artifactPath` 存这个）
 * 例：`actions/1-plan.md`
 */
const actionArtifactRelPath = (n: number, type: ActionType): string =>
  `${ACTIONS_DIR}/${actionArtifactFilename(n, type)}`;

/**
 * 给单条 action 算 artifact 绝对路径（prompt 里塞给 agent）
 */
export const getActionArtifactPath = (
  taskId: string,
  n: number,
  type: ActionType,
): string => path.join(getActionsDir(taskId), actionArtifactFilename(n, type));

/**
 * V0.6.25 CheckRun：单仓 check 完整日志的文件路径
 * - 落 actions/.checks/<actionId>/<slug>.log（.checks 隐藏目录、不混进 artifact 列表）
 * - 返绝对路径（写文件用）+ 相对路径（存进 CheckRepoResult.logPath、UI 按需读、防路径穿越）
 * - slug 由调用方保证唯一（如 `<idx>-<repo 末段>`、防多仓末段同名互相覆盖）
 */
export const getCheckLogPaths = (
  taskId: string,
  actionId: string,
  slug: string,
): { absPath: string; relPath: string } => {
  const safeAction = actionId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const safeSlug = slug.replace(/[^a-zA-Z0-9_.-]/g, "_");
  const relPath = `${ACTIONS_DIR}/.checks/${safeAction}/${safeSlug}.log`;
  return { absPath: path.join(taskDir(taskId), relPath), relPath };
};

// ----------------- 用户上传图片（V0.5.4、V0.6 不变）-----------------

const UPLOADS_DIR = "uploads";

const ALLOWED_IMAGE_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

// 单图 ≤ 10 MB（base64 解码后字节）
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export interface ImageAttachmentInput {
  data: string;
  mimeType: string;
  filename?: string;
}

export interface ImageAttachmentSaved {
  absPath: string;
  relPath: string;
  mimeType: string;
  bytes: number;
  filename?: string;
}

export const saveImageAttachments = async (
  taskId: string,
  images: ImageAttachmentInput[],
): Promise<ImageAttachmentSaved[]> => {
  if (images.length === 0) return [];
  sanitizeId(taskId);
  const uploadsDir = path.join(taskDir(taskId), UPLOADS_DIR);
  await fs.mkdir(uploadsDir, { recursive: true });

  const saved: ImageAttachmentSaved[] = [];
  for (const img of images) {
    const ext = ALLOWED_IMAGE_MIME[img.mimeType.toLowerCase()];
    if (!ext) {
      throw new Error(
        `不支持的图片 mimeType=${img.mimeType}（仅允许 ${Object.keys(
          ALLOWED_IMAGE_MIME,
        ).join(", ")}）`,
      );
    }
    let buf: Buffer;
    try {
      buf = Buffer.from(img.data, "base64");
    } catch (err) {
      throw new Error(
        `图片 base64 解码失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (buf.length === 0) {
      throw new Error("图片解码后为空、检查上传数据");
    }
    if (buf.length > MAX_IMAGE_BYTES) {
      throw new Error(
        `图片过大：${(buf.length / 1024 / 1024).toFixed(2)} MB（上限 ${
          MAX_IMAGE_BYTES / 1024 / 1024
        } MB）`,
      );
    }
    const id = newAttachmentId();
    const filename = `${id}.${ext}`;
    const absPath = path.join(uploadsDir, filename);
    const relPath = path.relative(dataRoot(), absPath);
    await fs.writeFile(absPath, buf);
    saved.push({
      absPath,
      relPath,
      mimeType: img.mimeType.toLowerCase(),
      bytes: buf.length,
      filename: img.filename,
    });
  }
  return saved;
};

// ----------------- 上下文文档（V0.3、V0.6 不变）-----------------

// 推断 contextDoc 类型
const inferContextDocType = (content: string): TaskContextDocType => {
  const t = content.trim();
  if (/^https?:\/\//i.test(t)) return "url";
  if (t.startsWith("/")) return "path";
  return "text";
};

const ensureDataDir = async (): Promise<void> => {
  await fs.mkdir(DATA_DIR, { recursive: true });
};

const exists = async (p: string): Promise<boolean> => {
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
interface TaskMetaV06 {
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
  /** V0.6.25：per-repo check 命令快照（build 后 runner 跑、详见 types.ts Task.repoCheckCommands） */
  repoCheckCommands?: Record<string, CheckCommand[]>;
  feishuStoryUrl?: string;
  contextDocs?: TaskContextDoc[];
  disabledMcpServers?: string[];
  /** V0.6.14：ship 合并后是否删源分支（缺省保留、详见 types.ts Task.removeSourceBranchOnMerge） */
  removeSourceBranchOnMerge?: boolean;
  archived: boolean;
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
    type: z.enum(ACTION_TYPES),
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
      "awaiting_test",
      "has_bug",
      "merged",
      "abandoned",
    ]),
    runStatus: z.enum(["idle", "running", "awaiting_user", "error"]),
    currentActionId: z.string().nullable(),
    actions: z.array(ActionRecordLooseSchema),
    mrs: z.array(z.looseObject({})),
    role: z.enum(["fe", "be", "adaptive"]),
    repoPaths: z.array(z.string()),
    archived: z.boolean(),
    createdAt: z.number(),
    updatedAt: z.number(),
  });

const isValidMetaShape = (raw: unknown): raw is TaskMetaV06 => {
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

const withTaskLock = async <T>(
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
const readMetaRaw = async (id: string): Promise<unknown | null> => {
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
const readMetaV06 = async (id: string): Promise<TaskMetaV06 | null> => {
  const raw = await readMetaRaw(id);
  if (!raw) return null;
  if (!isValidMetaShape(raw)) {
    throw new Error(
      `任务 ${id} meta.json schema 不匹配 V0.6（可能 V0.5 残留 / 文件破损）`,
    );
  }
  return raw;
};

const writeMeta = async (meta: TaskMetaV06): Promise<void> => {
  const dir = taskDir(meta.id);
  await fs.mkdir(dir, { recursive: true });
  const finalPath = path.join(dir, META_FILE);
  // 原子写：tmp + rename
  const tmpPath = `${finalPath}.tmp.${process.pid}.${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  try {
    await fs.writeFile(tmpPath, JSON.stringify(meta, null, 2), "utf-8");
    await fs.rename(tmpPath, finalPath);
  } catch (err) {
    await fs.unlink(tmpPath).catch(() => {});
    throw err;
  }
};

// ----------------- 事件流 -----------------

const readEvents = async (id: string): Promise<TaskEvent[]> => {
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

const appendEventLine = async (
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

// ----------------- artifact 读 -----------------

/**
 * 读单条 action 的 artifact 内容
 * 返 null：文件不存在 / action 没 artifactPath
 */
const readActionArtifactRaw = async (
  taskId: string,
  action: ActionRecord,
): Promise<{ filename: string; content: string } | null> => {
  if (!action.artifactPath) return null;
  const absPath = path.join(taskDir(taskId), action.artifactPath);
  if (!(await exists(absPath))) return null;
  const content = await fs.readFile(absPath, "utf-8");
  return { filename: action.artifactPath, content };
};

// ----------------- artifact 快照（V0.5.12 → V0.6 改 actionId 维度）-----------------

const isoForFilename = (ts: number): string =>
  new Date(ts).toISOString().replace(/[:.]/g, "-");

/**
 * V0.6：snapshot 当前 action artifact、追加到对应 ActionRecord.revisions
 *
 * 触发时机：action-ack 路由 revise 分支、submitActionAck 调用前调一次。
 *
 * 行为：
 *   - action 没 artifactPath / 文件不存在 / 内容为空 → 返 null、不写、不污染 meta
 *   - 否则复制到 `actions/.revisions/<actionId>/<ISO>.md`、追加到 action.revisions 末尾
 *   - 超过 MAX_REVISIONS_PER_ACTION → GC 删最早（fs 文件 + meta 记录）
 *
 * 失败不抛：snapshot 是辅助、出错不能挡 revise 主流程
 */
export const snapshotActionArtifact = async (
  taskId: string,
  actionId: string,
): Promise<ArtifactRevision | null> =>
  withTaskLock(taskId, async () => {
    const meta = await readMetaV06(taskId);
    if (!meta) return null;

    const action = meta.actions.find((a) => a.id === actionId);
    if (!action || !action.artifactPath) return null;

    const currentAbsPath = path.join(taskDir(taskId), action.artifactPath);
    let content: string;
    try {
      content = await fs.readFile(currentAbsPath, "utf-8");
    } catch {
      return null;
    }
    if (content.trim().length === 0) return null;

    const now = Date.now();
    const revRelPath = path.join(
      ACTIONS_DIR,
      REVISIONS_SUBDIR,
      actionId,
      `${isoForFilename(now)}.md`,
    );
    const revAbsPath = path.join(taskDir(taskId), revRelPath);
    await fs.mkdir(path.dirname(revAbsPath), { recursive: true });
    await fs.writeFile(revAbsPath, content, "utf-8");

    const rev: ArtifactRevision = {
      timestamp: now,
      path: revRelPath,
      size: Buffer.byteLength(content, "utf-8"),
    };

    const list = action.revisions ?? [];
    const next = [...list, rev];

    while (next.length > MAX_REVISIONS_PER_ACTION) {
      const oldest = next.shift();
      if (oldest) {
        await fs
          .unlink(path.join(taskDir(taskId), oldest.path))
          .catch(() => {});
      }
    }
    action.revisions = next;
    meta.updatedAt = now;
    await writeMeta(meta);
    return rev;
  });

export const listActionRevisions = async (
  taskId: string,
  actionId: string,
): Promise<ArtifactRevision[]> => {
  const meta = await readMetaV06(taskId);
  if (!meta) return [];
  const action = meta.actions.find((a) => a.id === actionId);
  if (!action?.revisions) return [];
  return [...action.revisions].sort((a, b) => a.timestamp - b.timestamp);
};

export const readActionRevisionContent = async (
  taskId: string,
  actionId: string,
  timestamp: number,
): Promise<{ content: string; revision: ArtifactRevision } | null> => {
  const meta = await readMetaV06(taskId);
  if (!meta) return null;
  const action = meta.actions.find((a) => a.id === actionId);
  if (!action?.revisions) return null;
  const rev = action.revisions.find((r) => r.timestamp === timestamp);
  if (!rev) return null;
  const absPath = path.join(taskDir(taskId), rev.path);
  try {
    const content = await fs.readFile(absPath, "utf-8");
    return { content, revision: rev };
  } catch {
    return null;
  }
};

export const readCurrentActionArtifact = async (
  taskId: string,
  actionId: string,
): Promise<{ content: string; filename: string } | null> => {
  const meta = await readMetaV06(taskId);
  if (!meta) return null;
  const action = meta.actions.find((a) => a.id === actionId);
  if (!action) return null;
  return await readActionArtifactRaw(taskId, action);
};

// ----------------- hydrate（meta → Task）-----------------

/**
 * meta → Task
 * - 读 events.jsonl + 每条 action 的 artifact、组合成完整 Task object
 */
const hydrateTask = async (meta: TaskMetaV06): Promise<Task> => {
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
    repoCheckCommands: meta.repoCheckCommands,
    feishuStoryUrl: meta.feishuStoryUrl,
    contextDocs: meta.contextDocs,
    disabledMcpServers: meta.disabledMcpServers,
    removeSourceBranchOnMerge: meta.removeSourceBranchOnMerge,
    archived: meta.archived,
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
const hydrateTaskSummary = (meta: TaskMetaV06): TaskSummary => {
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
    archived: meta.archived,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    model: meta.model,
    uiLayout: meta.uiLayout,
    actionCount: meta.actions.length,
    lastActionType: lastAction?.type,
    lastActionStatus: lastAction?.status,
  };
};

// ----------------- 自动归档 -----------------

// completed（merged）/ abandoned 且 7 天没动 → archived=true
const AUTO_ARCHIVE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

const shouldAutoArchive = (
  repoStatus: RepoStatus,
  archived: boolean,
  updatedAt: number,
): boolean => {
  if (archived) return false;
  if (repoStatus !== "merged" && repoStatus !== "abandoned") return false;
  return Date.now() - updatedAt > AUTO_ARCHIVE_AFTER_MS;
};

// ----------------- 进程冷启动恢复 -----------------
//
// V0.6 改：扫 task 时按 runStatus 判 zombie（运行时状态、不是业务状态）。
// runStatus in (running, awaiting_user) 时进程重启 = agent 上下文丢、标 error。

const RECOVERY_FLAG = "__feAiFlowBootRecoveryPromiseV2__";

const runBootRecovery = async (): Promise<void> => {
  await ensureDataDir();
  let ids: string[];
  try {
    const entries = await fs.readdir(DATA_DIR, { withFileTypes: true });
    ids = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (err) {
    console.warn("[task-fs] boot recovery: 读 DATA_DIR 失败", err);
    return;
  }

  let recovered = 0;
  for (const id of ids) {
    let raw: unknown | null;
    try {
      raw = await readMetaRaw(id);
    } catch (err) {
      console.warn(`[task-fs] boot recovery: 读 meta 失败 id=${id}`, err);
      continue;
    }
    if (!raw) continue;
    if (!isValidMetaShape(raw)) {
      // V0.5 残留 / schema 破损 → 不参与 recovery
      continue;
    }

    const meta = raw;
    if (meta.runStatus !== "running" && meta.runStatus !== "awaiting_user") {
      continue;
    }

    // 写 error 事件 + 标 runStatus=error
    const event: TaskEvent = {
      id: newEventId(),
      ts: Date.now(),
      kind: "error",
      text: "[boot-recovery] Web 进程已重启、agent 上下文已丢失。点「推进」可重新启动 agent。",
    };
    try {
      await appendEventLine(id, event);
    } catch (err) {
      console.warn(
        `[task-fs] boot recovery: 追加 error 事件失败 id=${id}`,
        err,
      );
      continue;
    }

    meta.runStatus = "error";
    meta.updatedAt = event.ts;
    // 当前 action 如果在跑、标 error
    if (meta.currentActionId) {
      const action = meta.actions.find((a) => a.id === meta.currentActionId);
      if (action && (action.status === "running" || action.status === "awaiting_ack")) {
        action.status = "error";
        action.endedAt = event.ts;
      }
    }
    try {
      await writeMeta(meta);
      recovered++;
    } catch (err) {
      console.warn(`[task-fs] boot recovery: 写 meta 失败 id=${id}`, err);
    }
  }

  if (recovered > 0) {
    console.log(
      `[task-fs] boot recovery: 标记 ${recovered} 个僵尸 task 的 runStatus 为 error`,
    );
  }
};

const ensureBootRecovery = async (): Promise<void> => {
  const g = globalThis as unknown as Record<string, Promise<void> | undefined>;
  if (g[RECOVERY_FLAG]) {
    await g[RECOVERY_FLAG];
    return;
  }
  const promise = runBootRecovery().catch((err) => {
    console.error("[task-fs] boot recovery 顶层异常（已吞）：", err);
  });
  g[RECOVERY_FLAG] = promise;
  await promise;
};

// ----------------- 公开 API：list / get / create / delete -----------------

export const listTasks = async (): Promise<TaskSummary[]> => {
  await ensureBootRecovery();
  await ensureDataDir();
  const entries = await fs.readdir(DATA_DIR, { withFileTypes: true });
  const ids = entries.filter((e) => e.isDirectory()).map((e) => e.name);

  const summaries: TaskSummary[] = [];
  for (const id of ids) {
    let raw: unknown | null;
    try {
      raw = await readMetaRaw(id);
    } catch (err) {
      console.warn(`[task-fs] listTasks: 读 meta 失败 id=${id}`, err);
      continue;
    }
    if (!raw) continue;
    if (!isValidMetaShape(raw)) {
      // V0.5 残留 / schema 破损 → 不显示
      continue;
    }

    const summary = hydrateTaskSummary(raw);
    if (shouldAutoArchive(summary.repoStatus, summary.archived, summary.updatedAt)) {
      await withTaskLock(id, async () => {
        const fresh = await readMetaRaw(id);
        if (
          fresh &&
          isValidMetaShape(fresh) &&
          shouldAutoArchive(fresh.repoStatus, fresh.archived, fresh.updatedAt)
        ) {
          fresh.archived = true;
          await writeMeta(fresh);
        }
      });
      summary.archived = true;
    }

    summaries.push(summary);
  }
  return summaries;
};

export const getTask = async (id: string): Promise<Task | null> => {
  await ensureBootRecovery();
  const raw = await readMetaRaw(id);
  if (!raw) return null;
  if (!isValidMetaShape(raw)) return null;
  return await hydrateTask(raw);
};

/**
 * V0.6.26：清洗单个 repo 的 check 命令数组（手动配置 + 自动检测共用、统一约束）
 *
 * 抽出来的动机：手动配置（createTask input）和自动检测（detectRepoCheckCommands）两条来源
 * 都要走同一道清洗、约束必须完全一致（否则自动检测的命令绕过了防呆上限）。
 *
 * - 丢无效命令（name / cmd 空）
 * - name / cmd 长度硬上限——命令会被 server 自动执行、防配置错误塞超长串
 * - kind 归一：非法值兜回 custom（否则 runner 取 CHECK_KIND_DEFAULT_TIMEOUT_MS[kind]=undefined → setTimeout(0) 秒杀命令）
 * - required 缺省视为 true（阻塞 ship gate）
 * - timeoutMs clamp 到 [5s, 30min]（防 0/负数秒杀命令、或超大值卡死 harness）
 * - source 由调用方统一打标（手动→manual、检测→auto）、不信入参里的 source（防伪造来源）
 * - 每仓最多 10 条命令、防刷爆 harness
 *
 * export 仅供单测（tests/sanitize-check-commands.test.ts）、业务方不要直接调。
 */
export const sanitizeCheckCommands = (
  cmds: CheckCommand[],
  source: "manual" | "auto",
): CheckCommand[] =>
  cmds
    .filter(
      (c) =>
        c &&
        typeof c.name === "string" &&
        c.name.trim() &&
        typeof c.cmd === "string" &&
        c.cmd.trim(),
    )
    .map((c) => ({
      name: c.name.trim().slice(0, 80),
      cmd: c.cmd.trim().slice(0, 2000),
      kind:
        typeof c.kind === "string" && c.kind in CHECK_COMMAND_KIND_LABEL
          ? (c.kind as CheckCommandKind)
          : "custom",
      required: c.required !== false,
      source,
      ...(c.timeoutMs && c.timeoutMs > 0
        ? {
            timeoutMs: Math.min(
              Math.max(Math.round(c.timeoutMs), 5_000),
              1_800_000,
            ),
          }
        : {}),
    }))
    .slice(0, 10);

/**
 * 创建新 task（V0.6）
 * - V0.6 不分 mode / workflowId、统一走 action 流
 * - 初始状态：repoStatus=developing / runStatus=idle / actions=[] / mrs=[]
 * - 飞书 story 自动 seed 到 contextDocs（V0.6 起新建表单不再有「补充说明」字段）
 */
export const createTask = async (input: NewTaskInput): Promise<Task> => {
  const now = Date.now();

  const initialContextDocs: TaskContextDoc[] = [];
  if (input.feishuStoryUrl && input.feishuStoryUrl.trim()) {
    initialContextDocs.push({
      id: newContextDocId(),
      title: "飞书 story",
      content: input.feishuStoryUrl.trim(),
      type: "url",
      createdAt: now,
    });
  }

  const finalTitle =
    input.title && input.title.trim() ? input.title.trim() : "未命名任务";

  const trimmedRepoPaths = (input.repoPaths ?? [])
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  // V0.6.3：清洗 per-repo 线上分支——key 限定在本 task 的 repoPaths 内、value 去空 trim
  //   （client 从 settings 快照来、这里再兜一道：删已不在列表的仓 + 空分支）
  const allowedRepos = new Set(trimmedRepoPaths);
  const repoBaseBranches: Record<string, string> = {};
  for (const [repo, branch] of Object.entries(input.repoBaseBranches ?? {})) {
    const b = branch?.trim();
    if (allowedRepos.has(repo) && b) repoBaseBranches[repo] = b;
  }

  // V0.6.3：同样清洗 per-repo「已有工作分支」覆盖（用户建 task 时填、key 限定 repoPaths、value trim）
  const repoFeatureBranches: Record<string, string> = {};
  for (const [repo, branch] of Object.entries(input.repoFeatureBranches ?? {})) {
    const b = branch?.trim();
    if (allowedRepos.has(repo) && b) repoFeatureBranches[repo] = b;
  }

  // V0.6.7：清洗测试分支 / dev 分支 / 命名模板快照（同款：key 限定 repoPaths、value trim 去空）
  const repoTestBranches: Record<string, string> = {};
  for (const [repo, branch] of Object.entries(input.repoTestBranches ?? {})) {
    const b = branch?.trim();
    if (allowedRepos.has(repo) && b) repoTestBranches[repo] = b;
  }
  const repoDevBranches: Record<string, string> = {};
  for (const [repo, branch] of Object.entries(input.repoDevBranches ?? {})) {
    const b = branch?.trim();
    if (allowedRepos.has(repo) && b) repoDevBranches[repo] = b;
  }
  const repoBranchTemplates: Record<string, string> = {};
  for (const [repo, tpl] of Object.entries(input.repoBranchTemplates ?? {})) {
    const t = tpl?.trim();
    if (allowedRepos.has(repo) && t) repoBranchTemplates[repo] = t;
  }

  // V0.6.26 CheckRun 自动检测——每仓走「manual override > auto detect」：
  //   - input 显式给了该仓命令数组（含空数组、= 调用方明确意图）→ 用手动配置（标 source=manual）
  //   - 没给（key 不存在）→ 调 detectRepoCheckCommands 按 repo 文件结构自动识别（标 source=auto）
  // 两条来源统一过 sanitizeCheckCommands、约束一致（长度 / kind 归一 / required 缺省 / 超时 clamp / 每仓≤10）。
  // 注：正常 UI 路径下 route 层已把空数组过滤、所以「空数组 = 禁用检测」当前只在直接调 createTask 时生效；
  //   第一版不从 UI 暴露「禁用」（详见 HANDOFF V0.6.26）。遍历 trimmedRepoPaths 本身就把 key 限定在本 task 仓内。
  const repoCheckCommands: Record<string, CheckCommand[]> = {};
  for (const repo of trimmedRepoPaths) {
    const manual = input.repoCheckCommands?.[repo];
    const cleaned = Array.isArray(manual)
      ? sanitizeCheckCommands(manual, "manual")
      : sanitizeCheckCommands(await detectRepoCheckCommands(repo), "auto");
    if (cleaned.length > 0) repoCheckCommands[repo] = cleaned;
  }

  const meta: TaskMetaV06 = {
    id: newTaskId(),
    title: finalTitle,
    mode: input.mode,
    repoStatus: "developing",
    runStatus: "idle",
    currentActionId: null,
    actions: [],
    mrs: [],
    role: input.role ?? "fe",
    repoPaths: trimmedRepoPaths,
    repoBaseBranches:
      Object.keys(repoBaseBranches).length > 0 ? repoBaseBranches : undefined,
    repoFeatureBranches:
      Object.keys(repoFeatureBranches).length > 0
        ? repoFeatureBranches
        : undefined,
    repoTestBranches:
      Object.keys(repoTestBranches).length > 0 ? repoTestBranches : undefined,
    repoDevBranches:
      Object.keys(repoDevBranches).length > 0 ? repoDevBranches : undefined,
    repoBranchTemplates:
      Object.keys(repoBranchTemplates).length > 0
        ? repoBranchTemplates
        : undefined,
    repoCheckCommands:
      Object.keys(repoCheckCommands).length > 0
        ? repoCheckCommands
        : undefined,
    feishuStoryUrl: input.feishuStoryUrl,
    contextDocs: initialContextDocs,
    disabledMcpServers:
      input.disabledMcpServers && input.disabledMcpServers.length > 0
        ? input.disabledMcpServers
        : undefined,
    model: input.model,
    archived: false,
    createdAt: now,
    updatedAt: now,
  };
  await writeMeta(meta);
  return await hydrateTask(meta);
};

export const deleteTask = async (id: string): Promise<boolean> => {
  const dir = taskDir(id);
  if (!(await exists(dir))) return false;
  await fs.rm(dir, { recursive: true, force: true });
  return true;
};

// ----------------- 公开 API：appendEvent / context docs / settings 类 patch -----------------

// updatedAt 落盘节流间隔——事件是高频流（每个 tool_call / thinking 一条）、原来每条
// 都整写 meta.json + hydrateTask（全量重读 events.jsonl）是 O(N²) 写放大。updatedAt
// 只影响列表排序 / 自动归档判断、5s 粒度足够。
const META_TOUCH_INTERVAL_MS = 5_000;
const lastMetaTouchAt = new Map<string, number>();

/**
 * 追加一条事件（V0.6.27 重写：轻量路径、返回写入的 event 而不是整个 Task）
 *
 * - task 不存在（已删、agent 残留写入）→ 返 null、不写、不复活目录
 * - 事件行直接 append（O_APPEND 单次 write 原子、无需拿 task 锁）
 * - meta.updatedAt 节流落盘（≥5s 才写一次、写时拿锁跟其它 read-modify-write 串行）
 * - 调用方需要完整 Task 的（低频 route 场景）自己再 getTask
 */
export const appendEvent = async (
  taskId: string,
  ev: Omit<TaskEvent, "id" | "ts">,
): Promise<TaskEvent | null> => {
  if (!(await exists(path.join(taskDir(taskId), META_FILE)))) return null;
  const event: TaskEvent = {
    id: newEventId(),
    ts: Date.now(),
    ...ev,
  };
  await appendEventLine(taskId, event);

  const last = lastMetaTouchAt.get(taskId) ?? 0;
  if (event.ts - last >= META_TOUCH_INTERVAL_MS) {
    lastMetaTouchAt.set(taskId, event.ts);
    await withTaskLock(taskId, async () => {
      const meta = await readMetaV06(taskId).catch(() => null);
      if (!meta) return;
      meta.updatedAt = event.ts;
      await writeMeta(meta);
    });
  }
  return event;
};

/**
 * 批量加上下文文档（V0.6.0.1 重写、支持图片）
 *
 * 入参分两部分：
 * - mainDoc：可选、用户在 dialog 里填的「主条目」（title + content、type 由 inferContextDocType 自动推断）
 * - imagePaths：可选、调用方已经用 saveImageAttachments 落盘完的图片绝对路径数组
 *
 * 两者至少有一个非空、否则报错。
 * 每张图都生成一条独立的 type=image doc（title = 主 doc title 或「贴图 N」、content = 图片绝对路径）、
 * 这样在 prompt 清单里每张图都单独列出、agent 用 read 工具直接读、SDK 自动转 vision。
 */
export const addContextDoc = async (
  taskId: string,
  input: {
    mainDoc?: { title: string; content: string };
    imagePaths?: string[];
    // image doc 的 title 前缀（用户没填 mainDoc.title 时回退到「贴图」、保证图清单有可读名字）
    imageTitleFallback?: string;
  },
): Promise<Task | null> =>
  withTaskLock(taskId, async () => {
    const meta = await readMetaV06(taskId);
    if (!meta) return null;
    const now = Date.now();

    const mainTitle = input.mainDoc?.title.trim() ?? "";
    const mainContent = input.mainDoc?.content.trim() ?? "";
    const imagePaths = (input.imagePaths ?? []).filter(
      (p) => typeof p === "string" && p.trim().length > 0,
    );

    const hasMain = mainTitle.length > 0 && mainContent.length > 0;
    const hasImages = imagePaths.length > 0;
    if (!hasMain && !hasImages) {
      throw new Error("mainDoc 和 imagePaths 至少一个非空");
    }
    if (hasMain && (mainTitle.length === 0 || mainContent.length === 0)) {
      throw new Error("mainDoc.title / content 不能为空");
    }

    const newDocs: TaskContextDoc[] = [];
    if (hasMain) {
      newDocs.push({
        id: newContextDocId(),
        title: mainTitle,
        content: mainContent,
        type: inferContextDocType(mainContent),
        createdAt: now,
      });
    }
    if (hasImages) {
      // 命名规则：mainDoc.title 存在 → 「<title> · 图N」；否则 → 「<fallback> N」（fallback 默认「贴图」）
      const fallback = input.imageTitleFallback?.trim() || "贴图";
      imagePaths.forEach((absPath, i) => {
        const title = hasMain
          ? imagePaths.length === 1
            ? `${mainTitle} · 图`
            : `${mainTitle} · 图${i + 1}`
          : imagePaths.length === 1
            ? fallback
            : `${fallback} ${i + 1}`;
        newDocs.push({
          id: newContextDocId(),
          title,
          content: absPath,
          type: "image",
          createdAt: now,
        });
      });
    }
    meta.contextDocs = [...(meta.contextDocs ?? []), ...newDocs];
    meta.updatedAt = now;
    await writeMeta(meta);
    return await hydrateTask(meta);
  });

export const removeContextDoc = async (
  taskId: string,
  docId: string,
): Promise<Task | null> =>
  withTaskLock(taskId, async () => {
    const meta = await readMetaV06(taskId);
    if (!meta) return null;
    const before = meta.contextDocs ?? [];
    const after = before.filter((d) => d.id !== docId);
    if (after.length === before.length) {
      return await hydrateTask(meta);
    }
    meta.contextDocs = after;
    meta.updatedAt = Date.now();
    await writeMeta(meta);
    return await hydrateTask(meta);
  });

export const setTaskDisabledMcpServers = async (
  id: string,
  servers: string[] | undefined,
): Promise<Task | null> =>
  withTaskLock(id, async () => {
    const meta = await readMetaV06(id);
    if (!meta) return null;
    meta.disabledMcpServers =
      servers && servers.length > 0 ? servers : undefined;
    await writeMeta(meta);
    return await hydrateTask(meta);
  });

// V0.6.14：ship 提测「合并后是否删源分支」开关落盘（推进 dialog 选「提测」时改、advance route 调）
export const setTaskRemoveSourceBranchOnMerge = async (
  id: string,
  value: boolean,
): Promise<Task | null> =>
  withTaskLock(id, async () => {
    const meta = await readMetaV06(id);
    if (!meta) return null;
    meta.removeSourceBranchOnMerge = value;
    meta.updatedAt = Date.now();
    await writeMeta(meta);
    return await hydrateTask(meta);
  });

export const setTaskArchived = async (
  id: string,
  archived: boolean,
): Promise<Task | null> =>
  withTaskLock(id, async () => {
    const meta = await readMetaV06(id);
    if (!meta) return null;
    meta.archived = archived;
    await writeMeta(meta);
    return await hydrateTask(meta);
  });

export const setTaskUiLayout = async (
  id: string,
  uiLayout: { artifactPanelSize?: number } | undefined,
): Promise<void> =>
  withTaskLock(id, async () => {
    const meta = await readMetaV06(id);
    if (!meta) return;
    if (uiLayout?.artifactPanelSize != null) {
      const v = uiLayout.artifactPanelSize;
      if (!Number.isFinite(v)) return;
      const clamped = Math.max(10, Math.min(90, v));
      meta.uiLayout = { artifactPanelSize: clamped };
    } else {
      meta.uiLayout = undefined;
    }
    await writeMeta(meta);
  });

/**
 * V0.6.6：编辑任务的「建任务字段」（详情页编辑弹窗用）
 *
 * 只放可安全后改的软配置：title / role / feishuStoryUrl / repoFeatureBranches。
 * 不在此改 model（SDK Run 启动时绑定、改了只能换新 agent）/ mode（切通路）/
 * repoPaths（副作用大、影响 cwd + 已建分支）/ repoStatus / runStatus / actions。
 *
 * 入参语义：字段为 undefined = 不改、传值 = 改、传 null = 显式清空（仅可空字段）。
 */
export interface UpdateTaskFieldsInput {
  title?: string;
  role?: TaskRole;
  feishuStoryUrl?: string | null;
  repoFeatureBranches?: Record<string, string> | null;
  /**
   * V0.6.28：中途**追加**仓库（只增不删、删仓涉及已建分支 / MR 残留引用、边界多收益低）
   * - 语义：跟现有 repoPaths 做并集、已存在的忽略；生效于下一个 action（正在跑的 run cwd 已绑死）
   * - 新仓的 per-repo 快照（线上 / 测试 / dev 分支、命名模板、check 命令）由前端从
   *   settings 取好随本字段一起传（settings 在 localStorage、server 读不到、跟建 task 同因）
   */
  addRepoPaths?: string[];
  /** 仅新增仓的快照、merge 进现有 map（已有仓的 key 忽略、不覆盖建 task 时的固化值） */
  addRepoBaseBranches?: Record<string, string>;
  addRepoTestBranches?: Record<string, string>;
  addRepoDevBranches?: Record<string, string>;
  addRepoBranchTemplates?: Record<string, string>;
  addRepoCheckCommands?: Record<string, CheckCommand[]>;
}

export const updateTaskFields = async (
  id: string,
  input: UpdateTaskFieldsInput,
): Promise<Task | null> =>
  withTaskLock(id, async () => {
    const meta = await readMetaV06(id);
    if (!meta) return null;

    // 标题：空忽略、保持原值（前端已校验非空、这里兜底防误清）
    if (input.title !== undefined) {
      const t = input.title.trim();
      if (t) meta.title = t;
    }

    if (input.role !== undefined) {
      meta.role = input.role;
    }

    // 飞书链接：改动时同步「建任务自动生成的那条 url 上下文文档」、否则 agent 读 contextDocs 仍是旧链接、两处漂移
    if (input.feishuStoryUrl !== undefined) {
      const oldUrl = meta.feishuStoryUrl;
      const newUrl = input.feishuStoryUrl?.trim() || undefined;
      meta.feishuStoryUrl = newUrl;
      if (oldUrl && oldUrl !== newUrl && newUrl && meta.contextDocs) {
        const doc = meta.contextDocs.find(
          (d) => d.type === "url" && d.content === oldUrl,
        );
        if (doc) doc.content = newUrl;
      }
    }

    // V0.6.28：追加仓库（只增不删、并集语义）——必须在 repoFeatureBranches 清洗之前处理、
    // 否则同一次请求里「新仓 + 新仓的已有工作分支」会被旧 repoPaths 集合误清掉
    if (input.addRepoPaths !== undefined) {
      const existing = new Set(meta.repoPaths);
      const added = input.addRepoPaths
        .map((p) => p.trim().replace(/\/+$/, ""))
        .filter((p) => p && !existing.has(p));
      if (added.length > 0) {
        meta.repoPaths = [...meta.repoPaths, ...added];
        // 新仓的 per-repo 快照 merge 进现有 map：只收新增仓的 key、不覆盖老仓固化值
        const addedSet = new Set(added);
        const mergeSnapshot = <V,>(
          current: Record<string, V> | undefined,
          incoming: Record<string, V> | undefined,
        ): Record<string, V> | undefined => {
          if (!incoming) return current;
          const merged: Record<string, V> = { ...current };
          for (const [repo, v] of Object.entries(incoming)) {
            if (addedSet.has(repo) && v) merged[repo] = v;
          }
          return Object.keys(merged).length > 0 ? merged : undefined;
        };
        meta.repoBaseBranches = mergeSnapshot(
          meta.repoBaseBranches,
          input.addRepoBaseBranches,
        );
        meta.repoTestBranches = mergeSnapshot(
          meta.repoTestBranches,
          input.addRepoTestBranches,
        );
        meta.repoDevBranches = mergeSnapshot(
          meta.repoDevBranches,
          input.addRepoDevBranches,
        );
        meta.repoBranchTemplates = mergeSnapshot(
          meta.repoBranchTemplates,
          input.addRepoBranchTemplates,
        );
        meta.repoCheckCommands = mergeSnapshot(
          meta.repoCheckCommands,
          input.addRepoCheckCommands,
        );
      }
    }

    // 已有工作分支：跟 createTask 同款清洗——key 限定在本 task 的 repoPaths 内、value trim 去空
    if (input.repoFeatureBranches !== undefined) {
      if (input.repoFeatureBranches === null) {
        meta.repoFeatureBranches = undefined;
      } else {
        const allowed = new Set(meta.repoPaths);
        const cleaned: Record<string, string> = {};
        for (const [repo, branch] of Object.entries(
          input.repoFeatureBranches,
        )) {
          const b = branch?.trim();
          if (allowed.has(repo) && b) cleaned[repo] = b;
        }
        meta.repoFeatureBranches =
          Object.keys(cleaned).length > 0 ? cleaned : undefined;
      }
    }

    meta.updatedAt = Date.now();
    await writeMeta(meta);
    return await hydrateTask(meta);
  });

/**
 * V0.6.24：chat 模式「切模型」——持久化到 meta.model
 *
 * 单独拎出来、不并进 updateTaskFields：model 不是软配置、是「下一个 SDK run 启动时用谁」的
 * 硬约束。改了不影响正在跑的 run（SDK 把模型绑死在 run 上）、下一轮 agent 启动时才生效。
 * 「running 时禁用切换」由调用方（chat-view 模型选择器）负责、这里只管落盘。
 */
export const setTaskModel = async (
  id: string,
  model: ModelSelection,
): Promise<Task | null> =>
  withTaskLock(id, async () => {
    const meta = await readMetaV06(id);
    if (!meta) return null;
    meta.model = model;
    meta.updatedAt = Date.now();
    await writeMeta(meta);
    return await hydrateTask(meta);
  });

// ----------------- 公开 API（V0.6 新）：action / repoStatus / runStatus / gitBranches / mr -----------------

/**
 * 创建一条新 action 记录、追加到 actions[] 末尾
 *
 * - 自动分配 n（= 现有 actions.length + 1、不复用 cancelled 的）
 * - 自动分配 id（= `act_<n>`）
 * - artifactPath：所有 action 都生成（V0.6.0.1 起 chat 独立 mode、不再是 action 类型）
 * - 写入后 runStatus 自动转为 running、currentActionId 指向新 action
 *
 * 返回新创建的 action（callers 拿 n / artifactPath 拼 prompt）
 */
export const appendAction = async (
  taskId: string,
  input: {
    type: ActionType;
    userInstruction: string;
    agentModel?: ModelSelection;
    /** V0.6.23：build 分批——本次做哪些批次（推进 dialog 勾选、仅 build 传、空=自由改动不计进度） */
    requestedBatchIds?: string[];
  },
): Promise<{ task: Task; action: ActionRecord } | null> =>
  withTaskLock(taskId, async () => {
    const meta = await readMetaV06(taskId);
    if (!meta) return null;
    const now = Date.now();
    const n = meta.actions.length + 1;
    const id = newActionId(n);
    const artifactPath = actionArtifactRelPath(n, input.type);

    const action: ActionRecord = {
      id,
      n,
      type: input.type,
      status: "running",
      userInstruction: input.userInstruction,
      artifactPath,
      startedAt: now,
      endedAt: null,
      // V0.6.28：快照创建时的 effective cwd——task 中途追加仓库后 cwd 会变、
      // artifact 链接渲染必须按写入时基准解析（详见 types.ts ActionRecord.cwd）
      cwd: getEffectiveCwd(meta.repoPaths),
      agentModel: input.agentModel,
      // V0.6.23：仅 build 带值（其它 action 为 undefined、JSON.stringify 自动忽略）
      requestedBatchIds:
        input.requestedBatchIds && input.requestedBatchIds.length > 0
          ? input.requestedBatchIds
          : undefined,
    };

    meta.actions = [...meta.actions, action];
    meta.currentActionId = id;
    meta.runStatus = "running";
    meta.updatedAt = now;
    await writeMeta(meta);
    const task = await hydrateTask(meta);
    return { task, action };
  });

/**
 * patch 单条 action 状态 / 后置检查 / 副作用
 * - status 转 awaiting_ack / completed / error / cancelled 时自动 set endedAt
 * - runStatus / currentActionId 不在这里改（独立 setTaskRunStatus）
 */
export const patchAction = async (
  taskId: string,
  actionId: string,
  patch: Partial<
    Pick<
      ActionRecord,
      | "status"
      | "postCheck"
      | "checkRun"
      | "checkOverride"
      | "sideEffects"
      | "agentModel"
      | "excluded"
      | "artifactUpdatedAt"
      | "planBatches"
      | "startBaseline"
    >
  >,
): Promise<Task | null> =>
  withTaskLock(taskId, async () => {
    const meta = await readMetaV06(taskId);
    if (!meta) return null;
    const idx = meta.actions.findIndex((a) => a.id === actionId);
    if (idx < 0) return null;
    const action = meta.actions[idx]!;
    const now = Date.now();
    const next: ActionRecord = {
      ...action,
      ...patch,
    };
    if (
      patch.status &&
      patch.status !== "running" &&
      action.status === "running"
    ) {
      next.endedAt = now;
    }
    if (patch.status === "running") {
      next.endedAt = null;
    }
    meta.actions = [
      ...meta.actions.slice(0, idx),
      next,
      ...meta.actions.slice(idx + 1),
    ];
    meta.updatedAt = now;
    await writeMeta(meta);
    return await hydrateTask(meta);
  });

/**
 * 原子地往 action.sideEffects.mrs[] 追加一条 MR 记录（V0.6.1 ship、防并发 submit_mr 丢更新）
 *
 * 按 repoPath 去重（同仓重试覆盖最新一条）、保留 sideEffects 其他字段（如 feishuCommentId）。
 * read-modify-write 整段在 withTaskLock 内完成——替代 task-runner 里「getTask → filter → patchAction」
 *   两段非原子写法（agent 串行不出问题、但接口被并行调时会丢 MR）。
 *
 * 跟 upsertMR 的区别：upsertMR 写 task.mrs[]（task 维度「当前最新 MR」）、本函数写
 *   action.sideEffects.mrs[]（action 维度「本次 ship 产出」、审计用）。
 */
export const appendActionSideEffectMR = async (
  taskId: string,
  actionId: string,
  mr: {
    repoPath: string;
    mrUrl: string;
    mrVersion: number;
    branch: string;
    commitHash: string;
    /** V0.6.1.1：本次 ship 该仓 MR 跟 test 是否有冲突 */
    hasConflicts?: boolean;
  },
): Promise<Task | null> =>
  withTaskLock(taskId, async () => {
    const meta = await readMetaV06(taskId);
    if (!meta) return null;
    const idx = meta.actions.findIndex((a) => a.id === actionId);
    if (idx < 0) return null;
    const action = meta.actions[idx]!;
    const existingMrs = action.sideEffects?.mrs ?? [];
    // 同 repoPath 已记录（重试 / 重复 ship）则去重、用最新这条覆盖
    const filtered = existingMrs.filter((m) => m.repoPath !== mr.repoPath);
    const nextAction: ActionRecord = {
      ...action,
      sideEffects: {
        ...(action.sideEffects ?? {}),
        mrs: [...filtered, mr],
      },
    };
    meta.actions = [
      ...meta.actions.slice(0, idx),
      nextAction,
      ...meta.actions.slice(idx + 1),
    ];
    meta.updatedAt = Date.now();
    await writeMeta(meta);
    return await hydrateTask(meta);
  });

/**
 * 直接设置 task 级 runStatus / currentActionId（runner 用）
 * - currentActionId = null 表示 idle
 */
export const setTaskRunStatus = async (
  taskId: string,
  runStatus: RunStatus,
  currentActionId?: string | null,
): Promise<Task | null> =>
  withTaskLock(taskId, async () => {
    const meta = await readMetaV06(taskId);
    if (!meta) return null;
    meta.runStatus = runStatus;
    if (currentActionId !== undefined) {
      meta.currentActionId = currentActionId;
    }
    meta.updatedAt = Date.now();
    await writeMeta(meta);
    return await hydrateTask(meta);
  });

/**
 * 直接设置 task 级 repoStatus（用户在 ack dialog 选「合入」/「abandon」时）
 */
export const setTaskRepoStatus = async (
  taskId: string,
  repoStatus: RepoStatus,
): Promise<Task | null> =>
  withTaskLock(taskId, async () => {
    const meta = await readMetaV06(taskId);
    if (!meta) return null;
    meta.repoStatus = repoStatus;
    meta.updatedAt = Date.now();
    await writeMeta(meta);
    return await hydrateTask(meta);
  });

/**
 * 单条仓库的 git branch upsert（V0.6.1 多仓适配）
 *
 * - 按 `repoPath` 匹配：已有同 repoPath 则替换、否则 append
 * - build action 第一次跑前、runner 为每个 repoPath 逐仓初始化一条（baseBranch 暂空、agent 探完再 patch）
 * - agent 跑完 git checkout 后、callers 再调一次把对应仓的 checkedOut=true / baseBranch 填好
 */
export const upsertGitBranch = async (
  taskId: string,
  gitBranch: GitBranchInfo,
): Promise<Task | null> =>
  withTaskLock(taskId, async () => {
    const meta = await readMetaV06(taskId);
    if (!meta) return null;
    const existing = meta.gitBranches ?? [];
    const idx = existing.findIndex((b) => b.repoPath === gitBranch.repoPath);
    meta.gitBranches =
      idx >= 0
        ? existing.map((b, i) => (i === idx ? gitBranch : b))
        : [...existing, gitBranch];
    meta.updatedAt = Date.now();
    await writeMeta(meta);
    return await hydrateTask(meta);
  });

/**
 * 写 task.feishuTesterUserKeys（V0.6.1 飞书 @ 测试人员记忆、2026-06-12 起存 user_key）
 *
 * - 首次 ship 时探到 / 用户填完后调一次、同 task 后续 ship 直接复用
 * - 空数组 = 显式记忆「没测试人 / 用户选了跳过 @」、跟 undefined 区分
 */
export const setFeishuTesterUserKeys = async (
  taskId: string,
  userKeys: string[],
): Promise<Task | null> =>
  withTaskLock(taskId, async () => {
    const meta = await readMetaV06(taskId);
    if (!meta) return null;
    meta.feishuTesterUserKeys = userKeys;
    meta.updatedAt = Date.now();
    await writeMeta(meta);
    return await hydrateTask(meta);
  });

/**
 * Upsert MR 记录（V0.6.1 ship action 多仓适配）
 *
 * 按 `repoPath` 匹配：
 *   - 已有：version++、更新 url/title/branch/status/lastCommitHash、保留 createdAt + createdByActionId（首次创建的）
 *   - 没有：插入新 record、version=1、createdAt=now
 *
 * 注意：本表 `task.mrs[]` 是 task 维度的「当前最新 MR」、跟 `action.sideEffects.mrs[]` 是 action 维度的「本次 ship 产出」不同——
 *   - task.mrs：每仓 1 条、查最新状态用
 *   - action.sideEffects.mrs：每次 ship action 落几条、审计用
 */
export const upsertMR = async (
  taskId: string,
  repoPath: string,
  input: {
    url: string;
    title: string;
    branch: string;
    status: MRRecord["status"];
    createdByActionId: string;
    lastCommitHash?: string;
    /** V0.6.1.1：本仓 MR 跟 test 是否有冲突（每次 ship push 后 poll GitLab 写） */
    hasConflicts?: boolean;
    /** V0.6.1.1：GitLab detailed_merge_status 原值 */
    mergeStatus?: string;
  },
): Promise<{ task: Task; mr: MRRecord } | null> =>
  withTaskLock(taskId, async () => {
    const meta = await readMetaV06(taskId);
    if (!meta) return null;
    const now = Date.now();
    const idx = meta.mrs.findIndex((m) => m.repoPath === repoPath);
    let nextMR: MRRecord;
    if (idx >= 0) {
      const old = meta.mrs[idx]!;
      nextMR = {
        ...old,
        url: input.url,
        title: input.title,
        branch: input.branch,
        status: input.status,
        lastCommitHash: input.lastCommitHash ?? old.lastCommitHash,
        // 每次 ship 重新检测冲突、用新值覆盖（解决冲突后再 ship 应翻回无冲突）
        hasConflicts: input.hasConflicts ?? old.hasConflicts,
        mergeStatus: input.mergeStatus ?? old.mergeStatus,
        version: old.version + 1,
      };
      meta.mrs = [
        ...meta.mrs.slice(0, idx),
        nextMR,
        ...meta.mrs.slice(idx + 1),
      ];
    } else {
      nextMR = {
        repoPath,
        url: input.url,
        title: input.title,
        branch: input.branch,
        status: input.status,
        lastCommitHash: input.lastCommitHash,
        hasConflicts: input.hasConflicts,
        mergeStatus: input.mergeStatus,
        createdByActionId: input.createdByActionId,
        version: 1,
        createdAt: now,
      };
      meta.mrs = [...meta.mrs, nextMR];
    }
    meta.updatedAt = now;
    await writeMeta(meta);
    const task = await hydrateTask(meta);
    return { task, mr: nextMR };
  });
