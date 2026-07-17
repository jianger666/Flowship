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
 * - phase chain → action history（plan/build/review/ship/dev 自由触发；chat 走独立 mode、不在 actions[] 里）
 * - `phases` 三段位 → `actions[]` 数组（按时间正序、N 累计）
 * - artifact 命名 `01-plan.md` → `N-plan.md`（不前导 0、N 是 ActionRecord.n）
 * - `currentPhase` → `currentActionId`
 * - `TaskStatus` → `runStatus` + `repoStatus`（运行时 vs 业务）
 * - V0.5 的 `WorkflowId` 概念删除；`TaskMode` V0.6.0 砍了 / V0.6.0.1 又拉回来（chat 走独立通路、不复用 action 体系）
 *
 * V0.9.x 拆分（纯搬家零逻辑变更）：
 * - `task-fs-core.ts`：路径 / id / meta schema + 原子读写 / withTaskLock / 事件流 IO / hydrate（本文件与 task-artifacts 共用底座）
 * - `task-artifacts.ts`：上传图片 / artifact 读 / revisions 快照 / 划除挪移
 * - 本文件保留：boot recovery + 公开 CRUD（list / get / create / delete）+ 各类 meta patch API
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import type {
  ActionRecord,
  ActionType,
  DevPushMode,
  GitBranchInfo,
  ModelSelection,
  MRRecord,
  NewTaskInput,
  RepoStatus,
  ReplanMode,
  RunStatus,
  Task,
  TaskContextDoc,
  TaskContextDocType,
  TaskEvent,
  TaskSummary,
} from "@/lib/types";
import { mrTargetBranchOf } from "@/lib/task-display";
import {
  cleanupOrphanTaskWorktrees,
  computeNonGitRepoPaths,
  computeReadonlyRepoPaths,
  computeScriptRepoPaths,
  getTaskCwd,
  isWorktreeTask,
  removeTaskWorktrees,
} from "./task-worktrees";
import { readSettingsFile } from "./settings-fs";
import {
  killStalePreview,
  stopPreviewsForTask,
} from "./preview-manager";
import {
  DATA_DIR,
  META_FILE,
  actionArtifactRelPath,
  appendEventLine,
  ensureDataDir,
  exists,
  getTaskWorkspaceDir,
  hydrateTask,
  hydrateTaskSummary,
  hydrateTaskWithTailEvents,
  isValidMetaShape,
  newActionId,
  newContextDocId,
  newEventId,
  newTaskId,
  readEventsBefore,
  readMetaRaw,
  readMetaV06,
  taskDir,
  withTaskLock,
  writeMeta,
  type TaskMetaV06,
} from "./task-fs-core";

// ----------------- 仓库 flag 快照（只读 / 脚本仓）-----------------

/** 读 settings.repos 算「只读 / 脚本仓」快照（失败 / 无匹配 → 各自 undefined） */
const snapshotRepoFlagPaths = async (
  repoPaths: string[],
): Promise<{ readonly: string[] | undefined; script: string[] | undefined }> => {
  const result = await readSettingsFile().catch(
    () => ({ status: "error" as const, reason: "read_failed" }),
  );
  const settings = result.status === "ok" ? result.settings : null;
  const repos = Array.isArray(settings?.repos) ? settings.repos : [];
  // config.json 里 repos 是宽松 JSON、只收带 path 的条目
  const entries = (repos as unknown[]).filter(
    (r): r is { path?: string; readonly?: boolean; scriptRepo?: boolean } =>
      !!r && typeof r === "object" && !Array.isArray(r),
  );
  return {
    readonly: computeReadonlyRepoPaths(repoPaths, entries),
    script: computeScriptRepoPaths(repoPaths, entries),
  };
};

// ----------------- 上下文文档（V0.3、V0.6 不变）-----------------

// 推断 contextDoc 类型
const inferContextDocType = (content: string): TaskContextDocType => {
  const t = content.trim();
  if (/^https?:\/\//i.test(t)) return "url";
  if (t.startsWith("/")) return "path";
  return "text";
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
  // V0.10：顺路收集「存活 task」id（meta 读得到、且未终结）——扫完清孤儿 worktree 用。
  // meta 破损的保守当存活（读不出 repoStatus、宁可留着不误删）。
  const liveTaskIds = new Set<string>();
  for (const id of ids) {
    let raw: unknown | null;
    try {
      raw = await readMetaRaw(id);
    } catch (err) {
      console.warn(`[task-fs] boot recovery: 读 meta 失败 id=${id}`, err);
      liveTaskIds.add(id);
      continue;
    }
    if (!raw) continue;
    if (!isValidMetaShape(raw)) {
      // V0.5 残留 / schema 破损 → 不参与 recovery
      liveTaskIds.add(id);
      continue;
    }

    const meta = raw;
    if (meta.repoStatus !== "merged" && meta.repoStatus !== "abandoned") {
      liveTaskIds.add(id);
    }
    // V0.11.1：awaiting_user 不再标 error——这是新模型的正常静息态（agent 答完 / 交卷完
    // run 已自然结束、没有「断掉的连接」可言）。会话内存虽丢、但 sessionAgentId 落盘了、
    // 用户下一步操作（再聊聊 / 答弹窗 / 发消息 / 续用推进）会 Agent.resume 无缝接回。
    // 只有 running（run 真在跑时进程死了）才是僵尸、标 error。
    if (meta.runStatus !== "running") {
      continue;
    }

    // 写 error 事件 + 标 runStatus=error
    const event: TaskEvent = {
      id: newEventId(),
      ts: Date.now(),
      kind: "error",
      // task / chat 共用：chat 没有「推进」按钮、用通用措辞（任务点推进 / 对话发消息都算「重新发起」）
      text: "[boot-recovery] Web 进程重启时本任务的 agent 正在运行、这一轮已中断。重新发起即可恢复。",
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

  // V0.10：清孤儿 worktree（task 被删 / 终结但清理没跑成的残留）、best-effort 不抛
  await cleanupOrphanTaskWorktrees(liveTaskIds);

  // V0.10.1：杀上一次进程遗留的预览 dev server（内存 slot 已丢、进程还占端口）、pidfile 兜底
  await killStalePreview().catch(() => {});
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
 * 只读 meta + 尾部 n 条事件（不整文件 parse）。
 * 形状与 getTask 相同；有更早事件时带 eventsTruncated=true。
 */
export const getTaskWithTailEvents = async (
  id: string,
  tail: number,
): Promise<Task | null> => {
  await ensureBootRecovery();
  const raw = await readMetaRaw(id);
  if (!raw) return null;
  if (!isValidMetaShape(raw)) return null;
  return await hydrateTaskWithTailEvents(raw, tail);
};

/**
 * cursor 分页：before 之前更早的一页。任务不存在返 null；锚点缺失返空页。
 */
export const getTaskEventsBefore = async (
  id: string,
  beforeId: string,
  limit: number,
): Promise<{ events: TaskEvent[]; hasMore: boolean } | null> => {
  await ensureBootRecovery();
  const raw = await readMetaRaw(id);
  if (!raw) return null;
  if (!isValidMetaShape(raw)) return null;
  return await readEventsBefore(id, beforeId, limit);
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

  // 去尾斜杠：settings.repos 落盘无尾 /、快照匹配（readonly / scriptRepo）是精确字符串比对，
  // 带尾 / 会静默匹配空（跟 addRepoPaths / setTaskRepoPaths 同款归一）
  const trimmedRepoPaths = (input.repoPaths ?? [])
    .map((p) => p.trim().replace(/\/+$/, ""))
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

  // 只读 / 脚本仓快照：从 settings.repos 匹配（server 端读 config.json、不信 client 传）
  const repoFlags = await snapshotRepoFlagPaths(trimmedRepoPaths);

  const meta: TaskMetaV06 = {
    id: newTaskId(),
    title: finalTitle,
    mode: input.mode,
    repoStatus: "developing",
    runStatus: "idle",
    currentActionId: null,
    actions: [],
    mrs: [],
    repoPaths: trimmedRepoPaths,
    // 建 task 时快照：之后路径映射 / cwd 聚合读这份，不再运行时 existsSync
    nonGitRepoPaths: computeNonGitRepoPaths(trimmedRepoPaths),
    readonlyRepoPaths: repoFlags.readonly,
    scriptRepoPaths: repoFlags.script,
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
    // V0.10：task 模式默认隔离工作区、显式传 false（新建弹窗逃生口）才直跑原仓库；
    // chat 模式恒不隔离（不建分支、直接用所选目录）
    isolateWorktree:
      input.mode === "chat" ? undefined : input.isolateWorktree !== false,
    model: input.model,
    pinned: false,
    createdAt: now,
    updatedAt: now,
  };
  await writeMeta(meta);
  // 任务专属可写工作目录（task 模式）：artifact 之外的产出兜底落点——只读仓 / 无仓任务
  // 也永远有合法可写位置。best-effort：建失败不挡建任务（runner 起 agent 前会再 ensure 一次）
  if (input.mode !== "chat") {
    await fs
      .mkdir(getTaskWorkspaceDir(meta.id), { recursive: true })
      .catch((err) =>
        console.warn(`[task-fs] createTask: 建 workspace 目录失败（忽略）id=${meta.id}`, err),
      );
  }
  return await hydrateTask(meta);
};

export const deleteTask = async (id: string): Promise<boolean> => {
  // 审查发现：原先无锁 fs.rm，与锁内 writeMeta（会 mkdir）竞态 → 删完被写回「复活」。
  // 存在检查 + 清理 + rm 整段持锁，与 writeMeta / 其它 meta RMW 互斥。
  return withTaskLock(id, async () => {
    const dir = taskDir(id);
    if (!(await exists(dir))) return false;
    // 清 worktree / 删目录前先停本任务预览：dev server 还挂着目录就被删 → 进程悬空占端口。
    // best-effort：失败不挡删除主流程（跟下面 worktree 清理同口径）。
    try {
      await stopPreviewsForTask(id);
    } catch (err) {
      console.warn(`[task-fs] deleteTask: 停预览失败（忽略）id=${id}`, err);
    }
    // V0.10：先清隔离工作区（要读 meta 拿 repoPaths、必须在删 task 目录前）；
    // 失败不挡删除、boot 孤儿扫描兜底
    try {
      const meta = await readMetaV06(id).catch(() => null);
      if (meta && isWorktreeTask(meta)) await removeTaskWorktrees(meta);
    } catch (err) {
      console.warn(`[task-fs] deleteTask: 清理 worktree 失败（忽略）id=${id}`, err);
    }
    // maxRetries：防「迟到的 events.jsonl 写入」跟递归删除撞车（ENOTEMPTY/EBUSY 短暂重试即过）
    await fs.rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
    return true;
  });
};

// ----------------- 公开 API：appendEvent / context docs / settings 类 patch -----------------

// updatedAt 落盘节流间隔——事件是高频流（每个 tool_call / thinking 一条）、原来每条
// 都整写 meta.json + hydrateTask（全量重读 events.jsonl）是 O(N²) 写放大。updatedAt
// 只影响列表排序、5s 粒度足够。
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

/**
 * V0.11.1：落 / 清「最近会话 agentId」（会话持久化、服务重启后 Agent.resume 续会话用）。
 * 不动 updatedAt（纯运行时锚点、与任务活跃度无关）。best-effort：调用方一般 void 掉。
 */
export const setTaskSessionAgentId = async (
  id: string,
  agentId: string | undefined,
): Promise<void> => {
  await withTaskLock(id, async () => {
    const meta = await readMetaV06(id);
    if (!meta) return;
    meta.sessionAgentId = agentId;
    await writeMeta(meta);
  });
};

// V0.8 侧栏：置顶 / 取消置顶（排到任务列表最上）。不动 updatedAt（置顶与活跃度无关）。
export const setTaskPinned = async (
  id: string,
  pinned: boolean,
): Promise<Task | null> =>
  withTaskLock(id, async () => {
    const meta = await readMetaV06(id);
    if (!meta) return null;
    meta.pinned = pinned;
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
 * 只放可安全后改的软配置：title / feishuStoryUrl / repoFeatureBranches。
 * 不在此改 model（SDK Run 启动时绑定、改了只能换新 agent）/ mode（切通路）/
 * repoPaths（副作用大、影响 cwd + 已建分支）/ repoStatus / runStatus / actions。
 *
 * 入参语义：字段为 undefined = 不改、传值 = 改、传 null = 显式清空（仅可空字段）。
 */
export interface UpdateTaskFieldsInput {
  title?: string;
  feishuStoryUrl?: string | null;
  repoFeatureBranches?: Record<string, string> | null;
  /**
   * V0.6.28：中途**追加**仓库（只增不删、删仓涉及已建分支 / MR 残留引用、边界多收益低）
   * - 语义：跟现有 repoPaths 做并集、已存在的忽略；生效于下一个 action（正在跑的 run cwd 已绑死）
   * - 新仓的 per-repo 快照（线上 / 测试 / dev 分支、命名模板）由前端从
   *   settings 取好随本字段一起传（settings 在 localStorage、server 读不到、跟建 task 同因）
   */
  addRepoPaths?: string[];
  /** 仅新增仓的快照、merge 进现有 map（已有仓的 key 忽略、不覆盖建 task 时的固化值） */
  addRepoBaseBranches?: Record<string, string>;
  addRepoTestBranches?: Record<string, string>;
  addRepoDevBranches?: Record<string, string>;
  addRepoBranchTemplates?: Record<string, string>;
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
        // 追加仓后重算非 git / 只读 / 脚本仓快照。注意：flag 快照按「当前」settings
        // 对全部 repoPaths 全量重算（沿用只读快照旧行为）——用户中途在设置页改过
        // 开关的话、老仓标记也会一并刷新到最新
        meta.nonGitRepoPaths = computeNonGitRepoPaths(meta.repoPaths);
        const flags = await snapshotRepoFlagPaths(meta.repoPaths);
        meta.readonlyRepoPaths = flags.readonly;
        meta.scriptRepoPaths = flags.script;
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

/**
 * V0.8：chat 模式「选工作目录」——替换 meta.repoPaths（区别于 updateTaskFields 的追加语义）。
 *
 * 自由对话直接用原生 picker 选文件夹当 agent cwd（对齐 codex / Cursor Agent Window）、重选即替换、
 * 空数组 = 不绑（agent 起在 ai-flow 项目本身、getEffectiveCwd fallback process.cwd()）。
 * 跟切模型同款硬约束：cwd 在 SDK run 启动时绑死、改了下一轮 agent 启动才生效（调用方 running 时禁用入口）。
 */
export const setTaskRepoPaths = async (
  id: string,
  repoPaths: string[],
): Promise<Task | null> =>
  withTaskLock(id, async () => {
    const meta = await readMetaV06(id);
    if (!meta) return null;
    meta.repoPaths = repoPaths
      .map((p) => p.trim().replace(/\/+$/, ""))
      .filter((p) => p.length > 0);
    // chat 重选工作目录也要刷新快照（cwd / 路径映射契约同一份）
    meta.nonGitRepoPaths = computeNonGitRepoPaths(meta.repoPaths);
    const flags = await snapshotRepoFlagPaths(meta.repoPaths);
    meta.readonlyRepoPaths = flags.readonly;
    meta.scriptRepoPaths = flags.script;
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
    /** V0.8.x：plan 重跑时如何合并批次 */
    replanMode?: ReplanMode;
    /** V0.x：联调推送方式（仅 dev 传）——direct 直推 / mr 提 PR */
    devPushMode?: DevPushMode;
    /** V0.9：自定义 action 指向的定义 id（仅 type=custom 传） */
    customActionId?: string;
    /** V0.9：自定义 action 展示名快照（仅 type=custom 传） */
    customLabel?: string;
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
      // V0.10：隔离 task 快照的是 worktree cwd（artifact 相对路径基准就是 worktree）
      cwd: getTaskCwd(meta),
      agentModel: input.agentModel,
      // V0.6.23：仅 build 带值（其它 action 为 undefined、JSON.stringify 自动忽略）
      requestedBatchIds:
        input.requestedBatchIds && input.requestedBatchIds.length > 0
          ? input.requestedBatchIds
          : undefined,
      replanMode: input.type === "plan" ? input.replanMode : undefined,
      // V0.x：仅 dev action 带推送方式（其它 undefined）
      devPushMode: input.type === "dev" ? input.devPushMode : undefined,
      // V0.9：仅 custom action 带定义 id + 展示名快照（用于运行时读 playbook + 历史展示）
      customActionId: input.type === "custom" ? input.customActionId : undefined,
      customLabel: input.type === "custom" ? input.customLabel : undefined,
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
      | "sideEffects"
      | "agentModel"
      | "excluded"
      | "artifactUpdatedAt"
      | "planBatches"
      | "startBaseline"
      | "readonlyBaseline"
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
    /** V0.x：MR 目标分支（提测=测试分支 / 联调=dev 分支） */
    targetBranch?: string;
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
 * 条件切等待：仅当「当前没有正在跑的 action」时、才把 runStatus 切 awaiting_user（+ 清 currentActionId）。
 *
 * 防「秒推下一 action」race（僵尸组合、旧 wait 协议时代踩过、V0.11 沿用防御）：
 *   用户推进新 action → runStatus 已设 running、新 action 在跑；此时旧 agent 迟到的
 *   awaiting 通知（不带 action_id 的 submit_work 调用）若用裸 setTaskRunStatus、会把
 *   running 错覆盖回 awaiting_user（还顺手清了 currentActionId）→ 新 action 明明在跑、
 *   UI 却显示「等待回复」、推进 / 终结 / 再聊聊按钮误亮（点了会和正在跑的 action 打架）。
 * 治法：read-compare-set 整段在 withTaskLock 内原子完成——读到「当前 action 已 running」就直接跳过、
 *   保住 running（杜绝「裸读 fresh + 再 set」之间的 TOCTOU race）。
 *
 * @returns 设成功 → 新 Task；跳过（已有 running action）或 meta 不存在 → null（调用方据此决定是否 publish）
 */
export const setTaskAwaitingIfIdle = async (
  taskId: string,
): Promise<Task | null> =>
  withTaskLock(taskId, async () => {
    const meta = await readMetaV06(taskId);
    if (!meta) return null;
    // 已有正在跑的新 action（说明用户已推进下一步）→ 不打回 awaiting_user、保住 running
    const current = meta.actions.find((a) => a.id === meta.currentActionId);
    if (current?.status === "running") return null;
    meta.runStatus = "awaiting_user";
    meta.currentActionId = null;
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
 * - build / worktree 首次建条目时写入；之后可 patch baseBranch
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
 * 用「client 随推进带来的设置页最新分支配置」刷新 task 的分支快照（V0.x A 方案）。
 *
 * 背景：线上/测试/dev 分支建 task 时从设置页快照固化、设置页后改不影响老 task。
 *   为了「设置页改了、老 task 下次推进也能用上」、advanceTask 每次推进前调本函数同步一次。
 *
 * upsert 语义（关键边界、防误清）：
 *   - 只覆盖「本 task 绑了的仓（allowed）+ 传来非空值」的 key
 *   - 没传的仓 / 传空值的、保留原快照（用户从设置页移除某仓时、不把 task 里该仓分支清成空）
 *   - 不动 feature 分支（git 已建、必须固化、不在本函数范围）
 */
export const refreshRepoBranches = async (
  taskId: string,
  input: {
    base?: Record<string, string>;
    test?: Record<string, string>;
    dev?: Record<string, string>;
  },
): Promise<Task | null> =>
  withTaskLock(taskId, async () => {
    const meta = await readMetaV06(taskId);
    if (!meta) return null;
    const allowed = new Set(meta.repoPaths);
    const apply = (
      current: Record<string, string> | undefined,
      incoming: Record<string, string> | undefined,
    ): Record<string, string> | undefined => {
      if (!incoming) return current;
      const merged: Record<string, string> = { ...current };
      for (const [repo, v] of Object.entries(incoming)) {
        const b = v?.trim();
        if (allowed.has(repo) && b) merged[repo] = b;
      }
      return Object.keys(merged).length > 0 ? merged : undefined;
    };
    meta.repoBaseBranches = apply(meta.repoBaseBranches, input.base);
    meta.repoTestBranches = apply(meta.repoTestBranches, input.test);
    meta.repoDevBranches = apply(meta.repoDevBranches, input.dev);
    meta.updatedAt = Date.now();
    await writeMeta(meta);
    return await hydrateTask(meta);
  });

/**
 * Upsert MR 记录（V0.6.1 ship action 多仓适配）
 *
 * 按 `repoPath` 匹配：
 *   - 已有：version++、更新 url/title/branch/status/lastCommitHash、保留 createdAt（首次创建的）
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
    /** V0.x：MR 目标分支（提测=测试分支 / 联调=dev 分支）、去重按 repoPath+targetBranch */
    targetBranch: string;
    url: string;
    title: string;
    branch: string;
    status: MRRecord["status"];
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
    // 去重键 = repoPath + 目标分支：同仓提测 MR（→test）和联调 MR（→dev）各记各的、各自累计 version。
    // 老记录缺 targetBranch（历史只有提测）→ mrTargetBranchOf 兜底成该仓测试分支、跟新提测 MR 正确合并、不跟联调 MR 撞。
    const idx = meta.mrs.findIndex(
      (m) =>
        m.repoPath === repoPath &&
        mrTargetBranchOf(m, meta.repoTestBranches) === input.targetBranch,
    );
    let nextMR: MRRecord;
    if (idx >= 0) {
      const old = meta.mrs[idx]!;
      nextMR = {
        ...old,
        targetBranch: input.targetBranch,
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
        targetBranch: input.targetBranch,
        url: input.url,
        title: input.title,
        branch: input.branch,
        status: input.status,
        lastCommitHash: input.lastCommitHash,
        hasConflicts: input.hasConflicts,
        mergeStatus: input.mergeStatus,
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
