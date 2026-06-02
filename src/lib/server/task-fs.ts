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

// ----------------- 路径常量 -----------------

const DATA_DIR = path.join(process.cwd(), "data", "tasks");
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
 * agent cwd 是用户业务仓库、不是 fe-ai-flow 本身、所以必须用绝对路径
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
    const relPath = path.relative(path.join(process.cwd(), "data"), absPath);
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
   */
  feishuTesterUserIds?: string[];
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
  archived: boolean;
  createdAt: number;
  updatedAt: number;
  model?: ModelSelection;
  uiLayout?: { artifactPanelSize?: number };
}

/**
 * V0.6 meta schema 快速校验：必须有 `actions` 数组、`repoStatus`、`runStatus`
 * - 不符合 = 文件破损 / V0.5 残留、listTasks 静默跳过、不抛错
 */
const isValidMetaShape = (raw: unknown): raw is TaskMetaV06 => {
  if (!raw || typeof raw !== "object") return false;
  const obj = raw as Record<string, unknown>;
  return (
    typeof obj.id === "string" &&
    typeof obj.title === "string" &&
    Array.isArray(obj.actions) &&
    typeof obj.repoStatus === "string" &&
    typeof obj.runStatus === "string"
  );
};

// per-task mutex（防 read-modify-write race、沿用 V0.5）
const taskLocks = new Map<string, Promise<unknown>>();

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
    feishuTesterUserIds: meta.feishuTesterUserIds,
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
    feishuTesterUserIds: meta.feishuTesterUserIds,
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

export const appendEvent = async (
  taskId: string,
  ev: Omit<TaskEvent, "id" | "ts">,
): Promise<Task | null> =>
  withTaskLock(taskId, async () => {
    const meta = await readMetaV06(taskId);
    if (!meta) return null;
    const event: TaskEvent = {
      id: newEventId(),
      ts: Date.now(),
      ...ev,
    };
    await appendEventLine(taskId, event);
    meta.updatedAt = event.ts;
    await writeMeta(meta);
    return await hydrateTask(meta);
  });

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
 * 只放可安全后改的软配置：title / role / feishuStoryUrl / model / repoFeatureBranches。
 * 不在此改 mode（切通路）/ repoPaths（副作用大、影响 cwd + 已建分支）/ repoStatus / runStatus / actions。
 *
 * 入参语义：字段为 undefined = 不改、传值 = 改、传 null = 显式清空（仅可空字段）。
 */
export interface UpdateTaskFieldsInput {
  title?: string;
  role?: TaskRole;
  feishuStoryUrl?: string | null;
  model?: ModelSelection | null;
  repoFeatureBranches?: Record<string, string> | null;
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

    // 模型：null = 清空（回退用 settings 默认）
    if (input.model !== undefined) {
      meta.model = input.model ?? undefined;
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
      agentModel: input.agentModel,
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
      "status" | "postCheck" | "sideEffects" | "agentModel" | "excluded"
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
 * 写 task.feishuTesterUserIds（V0.6.1 飞书 @ 测试人员记忆）
 *
 * - 首次 ship 时探到 / 用户填完后调一次、同 task 后续 ship 直接复用
 * - 空数组 = 显式记忆「没测试人 / 用户选了跳过 @」、跟 undefined 区分
 */
export const setFeishuTesterUserIds = async (
  taskId: string,
  userIds: string[],
): Promise<Task | null> =>
  withTaskLock(taskId, async () => {
    const meta = await readMetaV06(taskId);
    if (!meta) return null;
    meta.feishuTesterUserIds = userIds;
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
