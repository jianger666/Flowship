/**
 * Server-side 任务持久化层（V0.6）
 *
 * 数据布局：
 *
 *   data/
 *     tasks/
 *       <taskId>/
 *         meta.json ← 任务元信息、含 actions[] / mrs[] / gitBranches[]
 *         events.jsonl ← 事件流、每行一条 JSON、追加写
 *         actions/ ← 每条 action 一个 artifact
 *           1-plan.md
 *           2-build.md
 *           3-review.md
 *           4-ship.md
 *           5-build.md ← 测试报 bug 后再次 build
 *           ...
 *           .revisions/ ← V0.5.12 「再聊聊」前的 snapshot、V0.6 按 actionId 分目录
 *             act_2/
 *               2026-05-25.md
 *         uploads/ ← 用户粘贴 / 拖的图片
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

import { accessSync, readFileSync, promises as fs } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";

import type {
  ActionRecord,
  ActionStatus,
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
import {
  cleanupCheckpointRefsForTask,
  cleanupCheckpointRefsFromManifest,
  resolveCheckpointRefManifestForDelete,
  type CheckpointRefManifest,
} from "./chat-checkpoint";
import { dataRoot } from "./data-root";
import { readSettingsFile } from "./settings-fs";
import {
  killStalePreview,
  stopPreviewsForTask,
} from "./preview-manager";
import {
  DATA_DIR,
  DELETED_TOMBSTONE_FILE,
  META_FILE,
  actionArtifactRelPath,
  appendEventLine,
  clearEventSeqCounter,
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
  readMetaV06EvidenceSync,
  taskDir,
  withTaskLock,
  prepareMetaWrite,
  readSessionAgentIdSync,
  writeMeta,
  type TaskMetaV06,
} from "./task-fs-core";
import { failpoint } from "./failpoints";

/** 终态 task 上任何旧链的 action/runStatus 条件写都非法（finalize 走裸 set） */
const isTerminalRepoStatus = (repoStatus: RepoStatus): boolean =>
  repoStatus === "merged" || repoStatus === "abandoned";

/** Windows 长期句柄锁：fs.rm 的 maxRetries 扛不住，deleteTask 降级走 tombstone */
const isDeleteBusyError = (err: unknown): boolean => {
  const code = (err as NodeJS.ErrnoException)?.code;
  return (
    code === "EBUSY" ||
    code === "EPERM" ||
    code === "ENOTEMPTY" ||
    code === "EACCES"
  );
};

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

/**
 * deletion journal 目录（taskDir 外）。
 * tombstone 在 taskDir 内，rm 后会丢——refs 清单必须落盘在 dataRoot 下独立目录，
 * 崩溃任意点重启都能按 journal 完成遗留清理。
 *
 * 状态机（崩溃最终一致、每阶段可重入）：
 * 1. 写 journal phase=prepared（含 checkpointRefs）
 * 2. tombstone rename 成功 / 快速路径进入不可逆前 → 原子推进 phase=committed
 * 3. 清 refs（失败项写回 refsPending，不删 journal）
 * 4. rm taskDir（逻辑删除已 committed，目录可先删）
 * 5. refs 全部确认成功后才删 journal
 * boot：只执行 committed；prepared → 删 journal + warn（任务保留）。
 */
const DELETION_JOURNAL_DIR = "deletion-journal";

export const getDeletionJournalDir = (): string =>
  path.join(dataRoot(), DELETION_JOURNAL_DIR);

export const getDeletionJournalPath = (taskId: string): string =>
  path.join(getDeletionJournalDir(), `${taskId}.json`);

/**
 * 删除证据三态读——只有明确 ENOENT 才是 absent。
 * JSON 损坏 / EACCES / EBUSY / EIO → unknown（fail-closed，禁止当「不存在」）。
 */
export type DeletionEvidenceRead<T> =
  | { kind: "absent" }
  | { kind: "present"; value: T }
  | { kind: "unknown"; error: unknown };

/** journal 是否已有可前滚的完整恢复描述（非空 repoPaths 或确认零仓） */
export const hasDurableDeleteDescriptor = (
  manifest: CheckpointRefManifest,
): boolean =>
  (manifest.repoPaths?.length ?? 0) > 0 || manifest.confirmedEmpty === true;

/**
 * 测试注入：在真实 I/O 前抛错，模拟 journal/tombstone 的 EACCES/EIO。
 * 生产路径保持 null、零开销。
 */
type DeletionEvidenceReadOp =
  | "journalSync"
  | "journalAsync"
  | "tombstoneSync"
  | "tombstoneAsync";
let deletionEvidenceReadInjector:
  | ((op: DeletionEvidenceReadOp, filePath: string) => void)
  | null = null;

export const setDeletionEvidenceReadInjectorForTest = (
  fn: ((op: DeletionEvidenceReadOp, filePath: string) => void) | null,
): void => {
  deletionEvidenceReadInjector = fn;
};

const isEnoent = (err: unknown): boolean =>
  (err as NodeJS.ErrnoException)?.code === "ENOENT";

/**
 * deletion journal 完整 runtime schema——不用 TS cast 代替磁盘校验。
 * phase ∈ {prepared,committed}；checkpointRefs 元素须有 repoPath+refs[]；
 * repoPaths 须字符串数组；manifestPending/confirmedEmpty 类型正确。
 * 任何未知 phase / 字段形状 → null（调用方返 unknown、fail-closed）。
 */
const isJournalRefEntry = (e: unknown): boolean => {
  if (!e || typeof e !== "object") return false;
  const o = e as Record<string, unknown>;
  return (
    typeof o.repoPath === "string" &&
    Array.isArray(o.refs) &&
    o.refs.every((r) => typeof r === "string")
  );
};

const parseDeletionJournalValue = (
  parsed: unknown,
): CheckpointRefManifest | null => {
  if (!parsed || typeof parsed !== "object") return null;
  const o = parsed as Record<string, unknown>;
  if (typeof o.deletedAt !== "number" || !Number.isFinite(o.deletedAt)) {
    return null;
  }
  if (!Array.isArray(o.checkpointRefs) || !o.checkpointRefs.every(isJournalRefEntry)) {
    return null;
  }
  // phase 必须显式且合法——缺省 / typo（commited）一律非法
  if (o.phase !== "prepared" && o.phase !== "committed") return null;
  if (
    o.manifestPending !== undefined &&
    typeof o.manifestPending !== "boolean"
  ) {
    return null;
  }
  if (
    o.confirmedEmpty !== undefined &&
    typeof o.confirmedEmpty !== "boolean"
  ) {
    return null;
  }
  if (o.repoPaths !== undefined) {
    if (
      !Array.isArray(o.repoPaths) ||
      !o.repoPaths.every((p) => typeof p === "string")
    ) {
      return null;
    }
  }
  if (o.refsPending !== undefined) {
    if (
      !Array.isArray(o.refsPending) ||
      !o.refsPending.every(isJournalRefEntry)
    ) {
      return null;
    }
  }
  return {
    deletedAt: o.deletedAt,
    checkpointRefs: o.checkpointRefs as CheckpointRefManifest["checkpointRefs"],
    phase: o.phase,
    ...(o.refsPending
      ? {
          refsPending:
            o.refsPending as CheckpointRefManifest["refsPending"],
        }
      : {}),
    ...(o.manifestPending === true ? { manifestPending: true } : {}),
    ...(Array.isArray(o.repoPaths) ? { repoPaths: o.repoPaths as string[] } : {}),
    ...(o.confirmedEmpty === true ? { confirmedEmpty: true } : {}),
  };
};

/** 异步读 deletion journal（三态 + 完整 schema） */
export const readDeletionJournal = async (
  taskId: string,
): Promise<DeletionEvidenceRead<CheckpointRefManifest>> => {
  const p = getDeletionJournalPath(taskId);
  try {
    deletionEvidenceReadInjector?.("journalAsync", p);
    const raw = await fs.readFile(p, "utf-8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      console.error(
        `[task-fs] 读 deletion journal JSON 损坏 id=${taskId}`,
        err,
      );
      return { kind: "unknown", error: err };
    }
    const value = parseDeletionJournalValue(parsed);
    if (!value) {
      const err = new Error("invalid deletion journal schema");
      console.error(
        `[task-fs] 读 deletion journal schema 非法 id=${taskId}`,
        err,
      );
      return { kind: "unknown", error: err };
    }
    return { kind: "present", value };
  } catch (err) {
    if (isEnoent(err)) return { kind: "absent" };
    console.error(
      `[task-fs] 读 deletion journal 未知错误 id=${taskId}`,
      err,
    );
    return { kind: "unknown", error: err };
  }
};

/** 同步读 deletion journal（三态 + 完整 schema；HTTP 读闸用） */
const readDeletionJournalSync = (
  taskId: string,
): DeletionEvidenceRead<CheckpointRefManifest> => {
  const p = getDeletionJournalPath(taskId);
  try {
    deletionEvidenceReadInjector?.("journalSync", p);
    // 不用 existsSync：它对 EACCES 常返回 false（fail-open）
    const raw = readFileSync(p, "utf-8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      console.error(
        `[task-fs] sync 读 journal JSON 损坏 id=${taskId}`,
        err,
      );
      return { kind: "unknown", error: err };
    }
    const value = parseDeletionJournalValue(parsed);
    if (!value) {
      const err = new Error("invalid deletion journal schema");
      console.error(
        `[task-fs] sync 读 journal schema 非法 id=${taskId}`,
        err,
      );
      return { kind: "unknown", error: err };
    }
    return { kind: "present", value };
  } catch (err) {
    if (isEnoent(err)) return { kind: "absent" };
    console.error(
      `[task-fs] sync 读 journal 未知错误 id=${taskId}`,
      err,
    );
    return { kind: "unknown", error: err };
  }
};

/** 异步探针 tombstone（三态；仅 ENOENT → absent） */
export const probeDeleteTombstone = async (
  taskId: string,
): Promise<DeletionEvidenceRead<true>> => {
  const p = path.join(taskDir(taskId), DELETED_TOMBSTONE_FILE);
  try {
    deletionEvidenceReadInjector?.("tombstoneAsync", p);
    await fs.access(p);
    return { kind: "present", value: true };
  } catch (err) {
    if (isEnoent(err)) return { kind: "absent" };
    console.error(
      `[task-fs] tombstone access 未知错误 id=${taskId}`,
      err,
    );
    return { kind: "unknown", error: err };
  }
};

/** 同步探针 tombstone（三态） */
const probeDeleteTombstoneSync = (
  taskId: string,
): DeletionEvidenceRead<true> => {
  const p = path.join(taskDir(taskId), DELETED_TOMBSTONE_FILE);
  try {
    deletionEvidenceReadInjector?.("tombstoneSync", p);
    accessSync(p);
    return { kind: "present", value: true };
  } catch (err) {
    if (isEnoent(err)) return { kind: "absent" };
    console.error(
      `[task-fs] sync tombstone access 未知错误 id=${taskId}`,
      err,
    );
    return { kind: "unknown", error: err };
  }
};

/**
 * 原子写 deletion journal（同目录 tmp+rename）。
 * 须在写 tombstone / 清 refs / rm taskDir 之前调用；默认 phase=prepared。
 */
export const writeDeletionJournal = async (
  taskId: string,
  manifest: CheckpointRefManifest,
): Promise<void> => {
  const dir = getDeletionJournalDir();
  await fs.mkdir(dir, { recursive: true });
  const finalPath = getDeletionJournalPath(taskId);
  const tmpPath = path.join(
    dir,
    `.${taskId}.${process.pid}.${Date.now()}.tmp`,
  );
  const phase = manifest.phase ?? "prepared";
  const body = JSON.stringify({
    deletedAt: manifest.deletedAt,
    checkpointRefs: manifest.checkpointRefs,
    // 缺省 prepared——未显式 commit 前 boot 不得执行删除
    phase,
    ...(manifest.refsPending && manifest.refsPending.length > 0
      ? { refsPending: manifest.refsPending }
      : {}),
    // 清单未确认 / 仓路径快照——boot 前滚重建用
    ...(manifest.manifestPending ? { manifestPending: true } : {}),
    // 完整描述须在 commit 前持久化；非空才写入（空 = unknown）
    ...(manifest.repoPaths && manifest.repoPaths.length > 0
      ? { repoPaths: manifest.repoPaths }
      : {}),
    // 构建成功确认的零仓——与「空未知」区分
    ...(manifest.confirmedEmpty ? { confirmedEmpty: true } : {}),
  });
  await fs.writeFile(tmpPath, body, "utf-8");
  try {
    // 测试：prepared / committed 写失败可分别注入
    await failpoint(
      phase === "committed"
        ? "deletionJournal.commit.beforeRename"
        : "deletionJournal.prepared.beforeRename",
    );
    await fs.rename(tmpPath, finalPath);
  } catch (err) {
    await fs.unlink(tmpPath).catch(() => {});
    throw err;
  }
};

/**
 * 原子推进 journal → committed（重写文件、tmp+rename）。
 * 快速物理删路径须在进入不可逆 refs/rm 之前调用。
 */
export const commitDeletionJournal = async (taskId: string): Promise<void> => {
  const journal = await readDeletionJournal(taskId);
  if (journal.kind === "absent") {
    throw new Error(
      `[task-fs] commitDeletionJournal: journal 不存在 id=${taskId}`,
    );
  }
  // unknown 禁止覆盖推进
  if (journal.kind === "unknown") {
    throw new Error(
      `[task-fs] commitDeletionJournal: journal 读未知 id=${taskId}`,
    );
  }
  await writeDeletionJournal(taskId, {
    ...journal.value,
    phase: "committed",
  });
};

/** 物理删 + refs 全确认后移除 journal（幂等） */
export const removeDeletionJournal = async (taskId: string): Promise<void> => {
  await fs.unlink(getDeletionJournalPath(taskId)).catch(() => {});
};

/**
 * 回滚未提交的删除意图——**只许删 prepared**。
 * committed journal 或 tombstone 任一证据在 → 保留、只前滚；绝不能因 taskDir 仍在就清掉 committed。
 */
export const rollbackDeletionJournalIfTaskDirRemains = async (
  taskId: string,
): Promise<void> => {
  if (!(await exists(taskDir(taskId)))) return;
  // tombstone 三态——unknown 禁止回滚（可能已提交）
  const tomb = await probeDeleteTombstone(taskId);
  if (tomb.kind === "unknown") {
    console.error(
      `[task-fs] rollback: tombstone 读未知、跳过回滚 id=${taskId}`,
      tomb.error,
    );
    return;
  }
  if (tomb.kind === "present") return;
  const journal = await readDeletionJournal(taskId);
  // unknown → 不删 journal（可能已 committed）
  if (journal.kind === "unknown") {
    console.error(
      `[task-fs] rollback: journal 读未知、跳过回滚 id=${taskId}`,
      journal.error,
    );
    return;
  }
  // phase 单调——committed 永不回滚；absent 无事可做
  if (journal.kind === "absent" || journal.value.phase === "committed") return;
  await removeDeletionJournal(taskId);
};

/**
 * 按 journal（优先）或 rewind_points 清 checkpoint refs，再 rm taskDir；
 * refs 未全成功 / manifestPending → 写回 pending 并保留 journal（只前滚）。
 * boot recovery / DELETE 后台共用——任意崩溃点重启后重入仍最终一致。
 */
export const recoverDeletedTaskArtifacts = async (
  taskId: string,
): Promise<void> => {
  const journalRead = await readDeletionJournal(taskId);
  // journal 读未知 → 本轮跳过，下次重试（不误删不误放）
  if (journalRead.kind === "unknown") {
    console.error(
      `[task-fs] recover: journal 读未知、本轮跳过 id=${taskId}`,
      journalRead.error,
    );
    return;
  }
  let journal: CheckpointRefManifest | null =
    journalRead.kind === "present" ? journalRead.value : null;
  let refsAllOk = true;

  // 清单未确认 → 先重建；无完整描述则停 pending，绝不 ok-empty
  if (journal?.manifestPending) {
    const rebuilt = await resolveCheckpointRefManifestForDelete(
      taskId,
      journal.repoPaths,
    );
    if (!rebuilt.ok) {
      console.error(
        `[task-fs] recover: manifest 仍 unknown/失败、继续 pending id=${taskId}: ${rebuilt.error}`,
      );
      // taskDir 若仍在则保留（meta/rewind 恢复源）；已 rm 则靠 journal.repoPaths
      return;
    }
    // 重建结果必须带完整描述（非空 repoPaths 或 confirmedEmpty）
    if (!hasDurableDeleteDescriptor(rebuilt.manifest)) {
      console.error(
        `[task-fs] recover: 重建结果无完整描述、继续 pending id=${taskId}`,
      );
      return;
    }
    journal = {
      ...rebuilt.manifest,
      phase: "committed",
      deletedAt: journal.deletedAt,
      manifestPending: undefined,
      repoPaths: rebuilt.manifest.repoPaths ?? journal.repoPaths,
      ...(rebuilt.manifest.confirmedEmpty ? { confirmedEmpty: true } : {}),
    };
    await writeDeletionJournal(taskId, journal);
  }

  if (journal) {
    try {
      const result = await cleanupCheckpointRefsFromManifest(taskId, journal);
      refsAllOk = result.allSucceeded;
      if (!result.allSucceeded) {
        // 失败项写回 journal，禁止 catch 后假成功删清单
        await writeDeletionJournal(taskId, {
          ...journal,
          phase: "committed",
          refsPending: result.pending,
        });
      }
    } catch (err) {
      refsAllOk = false;
      console.warn(
        `[task-fs] recover: journal 清 refs 失败 id=${taskId}`,
        err,
      );
    }
  } else {
    // 无 journal（旧 tombstone / committed journal 补写失败）：趁 taskDir 还在读 / 扫
    try {
      const result = await cleanupCheckpointRefsForTask(taskId);
      refsAllOk = result.allSucceeded;
      // tombstone 在而 journal 缺——清 refs 失败也不得「假装完成」
      if (!result.allSucceeded) {
        const meta = await readMetaV06(taskId).catch(() => null);
        await writeDeletionJournal(taskId, {
          deletedAt: Date.now(),
          checkpointRefs: [],
          phase: "committed",
          manifestPending: true,
          repoPaths: meta?.repoPaths ?? [],
        });
      }
    } catch (err) {
      refsAllOk = false;
      console.warn(
        `[task-fs] recover: rewind_points 清 refs 失败 id=${taskId}`,
        err,
      );
    }
  }
  const dir = taskDir(taskId);
  if (await exists(dir)) {
    await fs.rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
  // refs 未全确认或 manifest 未确认 → 保留 journal 供二次 boot 重试
  if (refsAllOk) {
    const still = await readDeletionJournal(taskId);
    if (still.kind === "unknown") {
      console.error(
        `[task-fs] recover: 收尾读 journal 未知、保留 id=${taskId}`,
        still.error,
      );
      return;
    }
    if (still.kind === "absent" || !still.value.manifestPending) {
      await removeDeletionJournal(taskId);
    }
  }
};

/**
 * 扫 deletion-journal/——执行 committed；
 * prepared + 无 tombstone → 丢弃；prepared + tombstone 在 → 按 committed 前滚（tombstone rename 即提交点）。
 */
const recoverDeletionJournals = async (): Promise<void> => {
  const journalDir = getDeletionJournalDir();
  let names: string[];
  try {
    const entries = await fs.readdir(journalDir, { withFileTypes: true });
    names = entries
      .filter((e) => e.isFile() && e.name.endsWith(".json"))
      .map((e) => e.name.replace(/\.json$/, ""));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    console.warn("[task-fs] journal 清扫: 读目录失败", err);
    return;
  }
  for (const taskId of names) {
    try {
      const journalRead = await readDeletionJournal(taskId);
      // unknown → 本轮跳过该 task，下次重试
      if (journalRead.kind === "unknown") {
        console.error(
          `[task-fs] journal 清扫: 读未知、本轮跳过 id=${taskId}`,
          journalRead.error,
        );
        continue;
      }
      if (journalRead.kind === "absent") continue;
      let journal = journalRead.value;
      if (journal.phase !== "committed") {
        const tomb = await probeDeleteTombstone(taskId);
        if (tomb.kind === "unknown") {
          console.error(
            `[task-fs] journal 清扫: tombstone 读未知、本轮跳过 id=${taskId}`,
            tomb.error,
          );
          continue;
        }
        if (tomb.kind === "present") {
          // tombstone rename 即提交点——journal 仍 prepared / 缺 committed 补写 → 前滚
          console.warn(
            `[task-fs] prepared journal + tombstone → 按 committed 前滚 id=${taskId}`,
          );
          journal = { ...journal, phase: "committed" };
          await writeDeletionJournal(taskId, journal);
        } else {
          // prepared 且无 tombstone = 删除从未提交——丢弃 journal，任务保留
          console.warn(
            `[task-fs] prepared journal 未提交、丢弃 id=${taskId}`,
          );
          await removeDeletionJournal(taskId);
          continue;
        }
      }
      await recoverDeletedTaskArtifacts(taskId);
      const still = await readDeletionJournal(taskId);
      if (still.kind === "unknown") {
        console.error(
          `[task-fs] journal 清扫: 收尾读未知 id=${taskId}`,
          still.error,
        );
      } else if (still.kind === "present") {
        console.warn(
          `[task-fs] journal 清扫: refs/manifest 仍 pending、下次再试 id=${taskId}`,
        );
      } else {
        console.log(`[task-fs] journal 清扫: 已完成 id=${taskId}`);
      }
    } catch (err) {
      console.warn(
        `[task-fs] journal 清扫失败（下次启动再试）id=${taskId}`,
        err,
      );
    }
  }
};

/**
 * 清扫 deleteTask 降级留下的 tombstone 目录。
 * 只删带 `.deleted-tombstone` 的——tasks 下 bench/fixture 等手工目录绝不能误删。
 * rm 前先清 checkpoint refs（journal 优先，否则 rewind_points）。
 * 重启后句柄通常已释放，fs.rm 多数能成功；失败 warn 留给下次启动。
 */
const cleanupTombstonedTaskDirs = async (): Promise<void> => {
  // 先扫 taskDir 外的 journal（覆盖「tombstone 已写、refs 未清、进程退出」）
  await recoverDeletionJournals();

  let ids: string[];
  try {
    const entries = await fs.readdir(DATA_DIR, { withFileTypes: true });
    ids = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (err) {
    console.warn("[task-fs] tombstone 清扫: 读 DATA_DIR 失败", err);
    return;
  }
  for (const name of ids) {
    const tomb = await probeDeleteTombstone(name);
    // unknown → 跳过本轮（不误删）
    if (tomb.kind === "unknown") {
      console.error(
        `[task-fs] tombstone 清扫: access 未知、本轮跳过 id=${name}`,
        tomb.error,
      );
      continue;
    }
    if (tomb.kind === "absent") continue;
    // journal 路径已在 recoverDeletionJournals 处理过则目录应已消失；残留 = 无 journal 遗留
    try {
      await recoverDeletedTaskArtifacts(name);
      console.log(`[task-fs] tombstone 清扫: 已删 id=${name}`);
    } catch (err) {
      console.warn(
        `[task-fs] tombstone 清扫失败（下次启动再试）id=${name}`,
        err,
      );
    }
  }
};

const runBootRecovery = async (): Promise<void> => {
  await ensureDataDir();
  // 先清 tombstone 残留（句柄已随进程重启释放），再扫 zombie runStatus
  await cleanupTombstonedTaskDirs();

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
  // 含 tombstone 的目录一律跳过（清扫失败残留时不能当存活、也不能写 boot-recovery error）。
  const liveTaskIds = new Set<string>();
  for (const id of ids) {
    if (await exists(path.join(taskDir(id), DELETED_TOMBSTONE_FILE))) continue;
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

/**
 * TaskVisibility——DeleteEvidence 与对外可见性分离。
 * - deleted：committed journal / tombstone present（不可逆终态）
 * - unavailable：证据 unknown（EACCES/EIO/schema 非法）或 meta 读未知
 * - readable：删除证据明确非终态，且 meta 非 unknown
 * list/detail 对 deleted/unavailable 均 fail-closed 隐藏；HTTP 语义再分流 410 vs 503。
 */
export type TaskVisibility = "readable" | "deleted" | "unavailable";

export const getTaskVisibility = (taskId: string): TaskVisibility => {
  const tomb = probeDeleteTombstoneSync(taskId);
  if (tomb.kind === "unknown") {
    console.error(
      `[task-fs] getTaskVisibility: tombstone 未知 → unavailable id=${taskId}`,
      tomb.error,
    );
    return "unavailable";
  }
  if (tomb.kind === "present") return "deleted";

  const journal = readDeletionJournalSync(taskId);
  if (journal.kind === "unknown") {
    console.error(
      `[task-fs] getTaskVisibility: journal 未知 → unavailable id=${taskId}`,
      journal.error,
    );
    return "unavailable";
  }
  if (journal.kind === "present" && journal.value.phase === "committed") {
    return "deleted";
  }

  // 删除证据 absent（或 prepared）时，meta unknown → unavailable（临时 I/O / schema）
  const meta = readMetaV06EvidenceSync(taskId);
  if (meta.kind === "unknown") {
    console.error(
      `[task-fs] getTaskVisibility: meta 未知 → unavailable id=${taskId}`,
      meta.error,
    );
    return "unavailable";
  }
  return "readable";
};

/**
 * 统一读提交闸（同步）——visibility !== readable 即隐藏。
 * list / get-tail / events / watch bootstrap 在最后一个 await 后、返回前调用。
 */
export const assertTaskReadable = (taskId: string): boolean =>
  getTaskVisibility(taskId) === "readable";

/** list 循环结束后最终过滤（防 A push 后 await B 期间 A 被删仍回灌） */
export const filterCommittedReads = <T extends { id: string }>(
  items: T[],
): T[] => items.filter((item) => assertTaskReadable(item.id));

/**
 * 按 TaskVisibility 映射 HTTP——deleted→410、unavailable→503、其余 not_found→404。
 */
export const taskVisibilityErrorResponse = (taskId: string): NextResponse => {
  const v = getTaskVisibility(taskId);
  if (v === "deleted") {
    return NextResponse.json({ error: "task_deleted" }, { status: 410 });
  }
  if (v === "unavailable") {
    return NextResponse.json(
      { error: "temporarily_unavailable" },
      { status: 503 },
    );
  }
  return NextResponse.json({ error: "not_found" }, { status: 404 });
};

/**
 * HTTP 提交点同步可读性复查——async helper 返回后、NextResponse.json 之前调用。
 * helper 内 guard 是防御层；此处才是对外线性化点（防 helper resolve → route continuation 空隙）。
 */
export const commitReadableTaskResponse = (
  taskId: string,
  buildJson: () => unknown,
): NextResponse => {
  const v = getTaskVisibility(taskId);
  if (v !== "readable") {
    return taskVisibilityErrorResponse(taskId);
  }
  return NextResponse.json(buildJson());
};

/**
 * taskDir 存在性三态——仅明确 ENOENT 为 absent。
 * 目录在即 present（即使 meta 损坏/unknown——仍须进事务并 keep pending）。
 * meta 可读性由 prepareDeleteManifest / buildCheckpointRefManifest 三态处理。
 */
export const probeTaskDurablePresence = async (
  taskId: string,
): Promise<"absent" | "present" | "unknown"> => {
  try {
    await fs.access(taskDir(taskId));
    return "present";
  } catch (err) {
    if (isEnoent(err)) return "absent";
    console.error(
      `[task-fs] probeTaskDurablePresence: taskDir 未知 id=${taskId}`,
      err,
    );
    return "unknown";
  }
};

/**
 * list / board 最终数组在 Response 前再 filter 一次（同步、无 await）。
 */
export const commitReadableTaskListResponse = <T extends { id: string }>(
  items: T[],
  wrap: (filtered: T[]) => unknown,
): NextResponse => NextResponse.json(wrap(filterCommittedReads(items)));

export const listTasks = async (): Promise<TaskSummary[]> => {
  await ensureBootRecovery();
  await ensureDataDir();
  const entries = await fs.readdir(DATA_DIR, { withFileTypes: true });
  const ids = entries.filter((e) => e.isDirectory()).map((e) => e.name);

  const summaries: TaskSummary[] = [];
  for (const id of ids) {
    // 双保险：tombstone / committed journal 存在一律 skip
    if (!assertTaskReadable(id)) continue;
    let raw: unknown | null;
    try {
      raw = await readMetaRaw(id);
    } catch (err) {
      console.warn(`[task-fs] listTasks: 读 meta 失败 id=${id}`, err);
      continue;
    }
    // 读 meta 后可挂起——矩阵在此注入 tombstone，验证 push 前复查生效
    await failpoint("listTasks.afterReadMeta");
    if (!raw) continue;
    if (!isValidMetaShape(raw)) {
      // V0.5 残留 / schema 破损 → 不显示
      continue;
    }

    const summary = hydrateTaskSummary(raw);
    // push 前同步复查——防「无 tombstone 入场 → 读 meta 挂起 → DELETE 200」回灌
    if (!assertTaskReadable(id)) continue;
    summaries.push(summary);
  }
  // 循环结束后最终过滤——A 已 push 后仍可能 await B/C，期间 A 被删须剔除
  return filterCommittedReads(summaries);
};

/**
 * tombstone 存在 → 视为已删（与 listTasks 一致）。
 * 仅 present 为 true；unknown/absent 均为 false（调用方若需 fail-closed 请用 probeDeleteTombstone）。
 */
export const isTaskTombstoned = async (id: string): Promise<boolean> => {
  const r = await probeDeleteTombstone(id);
  return r.kind === "present";
};

/**
 * durable logical delete——
 * 1) 先写 taskDir 外 deletion journal phase=prepared（**失败则中止、不写 tombstone**）
 * 2) 再原子写 `.deleted-tombstone`——**rename 成功即视为 committed**（提交点）
 * 3) journal → committed 补写 best-effort：失败只前滚（保留 tombstone、不抛给 catch 回滚）
 *
 * 口径：journal 是删除事务唯一真相；tombstone 是物理辅助。
 * 读闸认「tombstone ∪ committed journal」；boot 见 tombstone 而 journal 缺/仍 prepared → 按 committed 前滚。
 * DELETE 延迟分支须在返回 200 **之前**调用，否则 refresh / 重启会把任务「复活」。
 * journal/tombstone 读 unknown → 中止本次操作（不重写 prepared、不推进 rename）。
 */
export const writeDeleteTombstone = async (taskId: string): Promise<void> => {
  const dir = taskDir(taskId);
  await fs.mkdir(dir, { recursive: true });

  const tombstonePath = path.join(dir, DELETED_TOMBSTONE_FILE);
  const existingJournal = await readDeletionJournal(taskId);
  // unknown → 中止，禁止把 journal 重写回 prepared / 推进 rename
  if (existingJournal.kind === "unknown") {
    throw new Error(
      `[task-fs] writeDeleteTombstone: journal 读未知、中止 id=${taskId}`,
    );
  }
  const tombProbe = await probeDeleteTombstone(taskId);
  if (tombProbe.kind === "unknown") {
    throw new Error(
      `[task-fs] writeDeleteTombstone: tombstone 读未知、中止 id=${taskId}`,
    );
  }
  const existingValue =
    existingJournal.kind === "present" ? existingJournal.value : null;
  const tombstoneExists = tombProbe.kind === "present";
  // 已 committed（快速路径后 EBUSY 降级）→ 禁止把 phase 写回 prepared
  const alreadyCommitted =
    existingValue?.phase === "committed" || tombstoneExists;

  // tombstone 已在：补写 committed journal（best-effort）后返回
  if (tombstoneExists) {
    try {
      await writeDeletionJournal(taskId, {
        ...(existingValue ?? {
          deletedAt: Date.now(),
          checkpointRefs: [],
        }),
        phase: "committed",
        ...(existingValue?.manifestPending ? { manifestPending: true } : {}),
      });
    } catch (err) {
      console.warn(
        `[task-fs] writeDeleteTombstone: tombstone 已在、committed 补写失败前滚 id=${taskId}`,
        err,
      );
    }
    return;
  }

  // manifest Result——失败则带 manifestPending，绝不降级「零 ref 成功」
  const resolved = await resolveCheckpointRefManifestForDelete(taskId);
  const meta = await readMetaV06(taskId).catch(() => null);
  const manifest: CheckpointRefManifest =
    alreadyCommitted && existingValue
      ? existingValue
      : resolved.ok
        ? { ...resolved.manifest, phase: "prepared" }
        : {
            deletedAt: Date.now(),
            checkpointRefs: [],
            phase: "prepared",
            manifestPending: true,
            // 可信快照优先写入 journal（commit 前持久化）
            repoPaths: meta?.repoPaths ?? [],
          };
  if (!resolved.ok && !alreadyCommitted) {
    console.warn(
      `[task-fs] writeDeleteTombstone: manifest 未确认 id=${taskId}: ${resolved.error}`,
    );
  }

  // prepared journal 写失败 → 中止（任务完整可见、无 tombstone）
  // 已 committed 则跳过 prepared 写，避免 phase 倒退导致短暂可读
  if (!alreadyCommitted) {
    await writeDeletionJournal(taskId, { ...manifest, phase: "prepared" });
  }
  // 同目录 tmp + rename = 同文件系统原子提交（写半截不会被 list 当成有效 tombstone）
  const tmpPath = path.join(
    dir,
    `.${DELETED_TOMBSTONE_FILE}.${process.pid}.${Date.now()}.tmp`,
  );
  const payload = JSON.stringify({
    deletedAt: manifest.deletedAt,
    // 区分 Windows EBUSY 降级 vs DELETE 延迟分支的逻辑删除
    reason: "logical-delete",
    // tombstone 内冗余清单（taskDir 未 rm 前可读；真正 durable 靠 journal）
    checkpointRefs: manifest.checkpointRefs,
  });
  await fs.writeFile(tmpPath, payload, "utf-8");
  try {
    // 测试：rename 前可注入失败，验证 prepared 回滚
    await failpoint("deleteTombstone.beforeRename");
    await fs.rename(tmpPath, tombstonePath);
  } catch (err) {
    await fs.unlink(tmpPath).catch(() => {});
    // tombstone 未提交 → 仅回滚 prepared；已 committed 绝不动 journal
    if (!alreadyCommitted) {
      await removeDeletionJournal(taskId);
    }
    throw err;
  }
  // tombstone rename = 提交点；committed journal 补写失败只前滚、不抛
  try {
    const existing = await readDeletionJournal(taskId);
    // 补写时读 unknown → 不覆盖（tombstone 已提交，只前滚）
    if (existing.kind === "unknown") {
      console.warn(
        `[task-fs] writeDeleteTombstone: committed 补写前 journal 读未知、前滚 id=${taskId}`,
        existing.error,
      );
      return;
    }
    const existingVal = existing.kind === "present" ? existing.value : null;
    await writeDeletionJournal(taskId, {
      ...(existingVal ?? manifest),
      deletedAt: manifest.deletedAt,
      checkpointRefs: (existingVal ?? manifest).checkpointRefs,
      phase: "committed",
      ...(manifest.manifestPending || existingVal?.manifestPending
        ? { manifestPending: true }
        : {}),
      repoPaths:
        existingVal?.repoPaths ??
        manifest.repoPaths ??
        meta?.repoPaths ??
        [],
      ...(manifest.confirmedEmpty || existingVal?.confirmedEmpty
        ? { confirmedEmpty: true }
        : {}),
    });
  } catch (err) {
    console.warn(
      `[task-fs] writeDeleteTombstone: committed journal 补写失败、tombstone 已提交前滚 id=${taskId}`,
      err,
    );
  }
};

export const getTask = async (id: string): Promise<Task | null> => {
  await ensureBootRecovery();
  // 统一闸——tombstone 或 committed journal
  if (!assertTaskReadable(id)) return null;
  const raw = await readMetaRaw(id);
  if (!raw) return null;
  if (!isValidMetaShape(raw)) return null;
  // meta 已读、hydrate events 未完成——矩阵可在此注入 finalize，
  // 验证 route 陈旧 developing 快照 + 裸写 running 窗口已被条件事务 / fresh 终态闸堵住
  await failpoint("taskread.beforeHydrate");
  const task = await hydrateTask(raw);
  // 返回前同步复查
  if (!assertTaskReadable(id)) return null;
  return task;
};

/**
 * 轻量读盘上 repoStatus（不 hydrate events）——启动副作用边界 / 准入用，
 * 避免 getTask 握着旧 meta 在 hydrate await 期间吃到已终态任务。
 */
export const readTaskRepoStatusFresh = async (
  taskId: string,
): Promise<RepoStatus | null> => {
  const meta = await readMetaV06(taskId);
  if (!meta) return null;
  return meta.repoStatus;
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
  if (!assertTaskReadable(id)) return null;
  const raw = await readMetaRaw(id);
  if (!raw) return null;
  if (!isValidMetaShape(raw)) return null;
  const task = await hydrateTaskWithTailEvents(raw, tail);
  // hydrate 后可挂起——矩阵在此注入删除，验证不发 stale
  await failpoint("getTaskWithTailEvents.afterHydrate");
  if (!assertTaskReadable(id)) return null;
  return task;
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
  if (!assertTaskReadable(id)) return null;
  const raw = await readMetaRaw(id);
  if (!raw) return null;
  if (!isValidMetaShape(raw)) return null;
  const page = await readEventsBefore(id, beforeId, limit);
  // 分页读完后复查
  await failpoint("getTaskEventsBefore.afterRead");
  if (!assertTaskReadable(id)) return null;
  return page;
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
    // 测试：不可逆 rm 前可注入抛错，验证 DELETE 回滚 journal
    await failpoint("deleteTask.beforeRm");
    // maxRetries：防「迟到的 events.jsonl 写入」跟递归删除撞车（ENOTEMPTY/EBUSY 短暂重试即过）
    try {
      await fs.rm(dir, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
      // 文件真删后才清 seq——stop/cleanup 不再清
      clearEventSeqCounter(id);
      return true;
    } catch (err) {
      if (!isDeleteBusyError(err)) throw err;
      // 降级 tombstone（Windows v1.1.20 实锤）：
      // 根因链——shell 卡死残留子进程 cwd 停在任务 workspace → 目录句柄长期占用 →
      // fs.rm maxRetries 只能扛瞬时锁；且 kill-orphans.ts 在 win32 是 no-op（无轻量
      // 可靠的按 cwd 查进程手段、本批不实现 Windows 进程清理），所以这里只能「先让
      // UI 消失、磁盘残留留给 boot 清扫」。tombstone 写入几乎必成功；meta unlink
      // best-effort（listTasks 靠 meta 判定，删掉即从列表消失；失败则靠 tombstone skip）。
      // 复用 writeDeleteTombstone（与 DELETE 延迟分支同一协议）
      await writeDeleteTombstone(id);
      await fs.unlink(path.join(dir, META_FILE)).catch(() => {});
      // tombstone 后 events 不再作为合法日志——一并清 counter
      clearEventSeqCounter(id);
      console.warn(
        `[task-fs] deleteTask: 目录被锁，已降级 tombstone id=${id}`,
        err,
      );
      return true;
    }
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
 * - 事件行经 appendEventLine 按 taskId 串行 append（同文件并发 appendFile 不安全，
 *   且超长 tool_result 行超出 POSIX O_APPEND 原子写保证；无需拿 task 锁）
 * - onCommitted（通常 publish）在 append 链内、写行成功后同步调用——
 *   与落盘同序提交；meta.updatedAt 节流 touch 移出关键路径（fire-and-forget）
 * - 调用方需要完整 Task 的（低频 route 场景）自己再 getTask
 *
 * @param lease 可选；透传到 appendEventLine 队内检查（false → 不写盘、返 null）
 * @param onCommitted 可选；链内写行成功后同步回调（writeEventAndPublish 传 publish）
 *
 * 错误语义（调用方零影响、透传已存在）：
 * - ENOENT / lease 拒写 → 返 null（不抛）
 * - 其它 IO 错误（EIO / ENOSPC / EACCES…）→ 向上抛，由 writeEventAndPublish 吞、
 *   或由 writeUserEventAndPublishStrict 交给 route 处理
 */
export const appendEvent = async (
  taskId: string,
  ev: Omit<TaskEvent, "id" | "ts" | "seq">,
  lease?: () => boolean,
  onCommitted?: (event: TaskEvent) => void,
): Promise<TaskEvent | null> => {
  if (!(await exists(path.join(taskDir(taskId), META_FILE)))) return null;
  const event: TaskEvent = {
    id: newEventId(),
    ts: Date.now(),
    ...ev,
  };
  // 写行 + onCommitted（publish）同进 per-task append 链
  // 非 ENOENT 错误由 appendEventLineUnlocked 原样抛出（透传、不吞）
  const wrote = await appendEventLine(taskId, event, lease, onCommitted);
  if (!wrote) return null;

  // meta.updatedAt 移出关键路径——列表排序 5s 粒度足够；失败只 warn
  const last = lastMetaTouchAt.get(taskId) ?? 0;
  if (event.ts - last >= META_TOUCH_INTERVAL_MS) {
    lastMetaTouchAt.set(taskId, event.ts);
    void withTaskLock(taskId, async () => {
      const meta = await readMetaV06(taskId).catch(() => null);
      if (!meta) return;
      meta.updatedAt = event.ts;
      await writeMeta(meta);
    }).catch((err) => {
      console.warn(
        `[task-fs] appendEvent meta touch 失败（best-effort）task=${taskId}:`,
        err instanceof Error ? err.message : err,
      );
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
 * V0.11.1 / 落 / 清「最近会话 agentId」（会话持久化、服务重启后 Agent.resume 续会话用）。
 * 不动 updatedAt（纯运行时锚点、与任务活跃度无关）。best-effort：调用方一般 void 掉。
 *
 * set 与 clear 对称——走 prepareMetaWrite + commit(finalGuard)；
 * 调用方传「本 session 仍是当前注册」闭包，堵 read/write await 夹缝里被后继覆盖。
 *
 * 错误在函数内部消化、绝不 reject——调用方几十处都是 fire-and-forget
 * `void setTaskSessionAgentId(...)`，任一处漏 .catch 都会在「任务目录刚被 DELETE 删掉」
 * 时产生 ENOENT unhandled rejection（高负载全量测试实锤随机红灯）。best-effort 语义
 * 的单一源就该在这里兜：ENOENT（任务已删、锚点无处可落）静默，其他错误 warn。
 */
export const setTaskSessionAgentId = async (
  id: string,
  agentId: string | undefined,
  /** 可选 finalGuard——rename 前同步复查（调用方现查，非入场快照） */
  finalGuard?: () => boolean,
): Promise<void> => {
  try {
    await withTaskLock(id, async () => {
      if (finalGuard && !finalGuard()) return;
      const meta = await readMetaV06(id);
      if (!meta) return;
      meta.sessionAgentId = agentId;
      if (finalGuard) {
        // 条件事务——与 clearTaskSessionAgentIdIf 对称
        const prepared = await prepareMetaWrite(meta);
        const guard = (): boolean => !finalGuard || finalGuard();
        if (!guard()) {
          await prepared.abort();
          return;
        }
        await prepared.commit(guard);
      } else {
        await writeMeta(meta);
      }
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      console.warn(
        `[task-fs] setTaskSessionAgentId 失败（best-effort、忽略）task=${id}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
};

/**
 * 条件清 sessionAgentId。
 * 前置：锁内同步 extraGuard + 盘上锚点 === expectedAgentId；
 * 提交：prepareMetaWrite + commit(finalGuard)——每次 rename attempt 前复查
 * 「盘上仍是 expectedAgentId && extraGuard 仍 true」（beforeAttempt）。
 * 用于 Agent.resume 确定性失败 catch：避免迟到 clear 抹掉 B 同 agentId 新装的锚点。
 * @returns true=已清；false=条件不符 / meta 不存在（best-effort 不抛）
 */
export const clearTaskSessionAgentIdIf = async (
  taskId: string,
  expectedAgentId: string,
  extraGuard?: () => boolean,
): Promise<boolean> => {
  try {
    return await withTaskLock(taskId, async () => {
      // 同步 guard 先查——B 已装内存 session / 已失主则不清
      if (extraGuard && !extraGuard()) return false;
      const meta = await readMetaV06(taskId);
      if (!meta || meta.sessionAgentId !== expectedAgentId) return false;
      meta.sessionAgentId = undefined;
      // 条件事务——prepare 后 finalGuard 进 commit，堵 read/write await 夹缝
      const prepared = await prepareMetaWrite(meta);
      // 矩阵在此注入同 agentId 的 B 安装，断言锚点保留
      await failpoint("clear.beforeCommit");
      const finalGuard = (): boolean => {
        // 盘上仍是本次要清的锚点（同步读、无 await）
        if (readSessionAgentIdSync(taskId) !== expectedAgentId) return false;
        // 内存无后继 / lease 仍 current——调用方闭包现查，不是入场快照
        if (extraGuard && !extraGuard()) return false;
        return true;
      };
      if (!finalGuard()) {
        await prepared.abort();
        return false;
      }
      return await prepared.commit(finalGuard);
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      console.warn(
        `[task-fs] clearTaskSessionAgentIdIf 失败（best-effort、忽略）task=${taskId}:`,
        err instanceof Error ? err.message : err,
      );
    }
    return false;
  }
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
  /**
   * 锁内 prepare → 同步复查 guard → commit。
   * advance 传 `() => isOpOwner(opHandle)`：claim 后若已被 stop revoke，
   * 拒绝追加幽灵 action（与 stop 重读收尾形成互斥闭环，见 stop-task）。
   */
  opts?: { guard?: () => boolean },
): Promise<{ task: Task; action: ActionRecord } | null> =>
  withTaskLock(taskId, async () => {
    // ① 锁内同步 guard 快查
    if (opts?.guard && !opts.guard()) return null;
    const meta = await readMetaV06(taskId);
    if (!meta) return null;
    // 终态 task 上追加 running action 一律非法（finalize 裸写不受影响）
    if (isTerminalRepoStatus(meta.repoStatus)) return null;
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

    // ③ prepare：脏值只在 tmp——meta.json 未动
    const prepared = await prepareMetaWrite(meta);
    // 测试插桩：prepare 之后、同步复查之前（故意 await，模拟 IO 间隙）
    await failpoint("append.afterPrepare");
    // ④ 提前短路（省 rename）——权威检查在 commit(finalGuard) 内、rename 紧前
    if (opts?.guard && !opts.guard()) {
      await prepared.abort();
      return null;
    }
    // finalGuard 进 commit——failpoint await 后、rename 前同步验；失主拒写
    const committed = await prepared.commit(opts?.guard);
    if (!committed) return null;
    const task = await hydrateTask(meta);
    return { task, action };
  });

/** patchAction / patchActionIfOwner 共用的可改字段 */
type ActionPatchFields = Partial<
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
>;

/**
 * patch 单条 action 状态 / 后置检查 / 副作用
 * - status 转 awaiting_ack / completed / error / cancelled 时自动 set endedAt
 * - runStatus / currentActionId 不在这里改（独立 setTaskRunStatus）
 */
export const patchAction = async (
  taskId: string,
  actionId: string,
  patch: ActionPatchFields,
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

// appendActionSideEffectMR 已删——MR 双投影改走 upsertMRWithActionSideEffect 单事务

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
 * stop / finalize 的「扫非终态 action + 置 idle」锁内单次事务。
 *
 * 线性化：appendAction 持 withTaskLock 直到 `prepared.commit()`（含内部
 * renameWithRetry await）返回才放锁——本函数同锁排队，必排在 append 提交之后，
 * 因此必见刚落盘的 running action，不会漏扫成「action=running + task=idle」幽灵。
 *
 * @param exceptActionId 排除某 action（advance force-new 不用本函数；预留给对称 API）
 * @param toStatus 非终态收尾成 cancelled（stop/finalize）或 error
 * @returns 收尾后 hydrate 的 Task（事件文案 / publish 用）；meta 不存在 → null
 */
export const finalizeStaleAndIdleLocked = async (
  taskId: string,
  opts?: { exceptActionId?: string; toStatus?: "cancelled" | "error" },
): Promise<Task | null> =>
  withTaskLock(taskId, async () => {
    const meta = await readMetaV06(taskId);
    if (!meta) return null;
    const toStatus = opts?.toStatus ?? "cancelled";
    const now = Date.now();
    meta.actions = meta.actions.map((a) => {
      if (opts?.exceptActionId && a.id === opts.exceptActionId) return a;
      if (a.status !== "running" && a.status !== "awaiting_ack") return a;
      return {
        ...a,
        status: toStatus,
        // running→终态自动落 endedAt；已有 endedAt（少见）保留
        endedAt: a.endedAt ?? now,
      };
    });
    meta.runStatus = "idle";
    meta.updatedAt = now;
    const prepared = await prepareMetaWrite(meta);
    await prepared.commit();
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
 * 条件写 runStatus——仅当 `currentActionId` 仍等于本操作的 action 时才改。
 *
 * 防 stale owner 清理覆盖后继 B：旧 advance 见 gen stale 想把 running→idle，
 * 但 B 已 append 并改 currentActionId——CAS 失败则不碰共享状态。
 * read-compare-set 整段在 withTaskLock 内（同 setTaskAwaitingIfIdle）。
 *
 * @returns 写成功 → 新 Task；指针已变 / meta 不存在 → null
 */
export const setTaskRunStatusIfCurrentAction = async (
  taskId: string,
  expectedCurrentActionId: string,
  runStatus: RunStatus,
): Promise<Task | null> =>
  withTaskLock(taskId, async () => {
    const meta = await readMetaV06(taskId);
    if (!meta) return null;
    // 后继 B 已接管（currentActionId 已变）→ 不覆盖其 runStatus
    if (meta.currentActionId !== expectedCurrentActionId) return null;
    meta.runStatus = runStatus;
    meta.updatedAt = Date.now();
    await writeMeta(meta);
    return await hydrateTask(meta);
  });

/**
 * 锁内结构条件——同 epoch 的并发 advance 不 bump opGen，仅靠 isFresh 挡不住。
 * 调用方（如 /question ack）应传入 ack 当时的 currentActionId + 期望的 action status。
 */
export type OpFreshExpected = {
  currentActionId?: string | null;
  actionStatus?: ActionStatus | readonly ActionStatus[];
  /** 可选 action.type 结构条件（如 set_plan_batches 须 plan） */
  actionType?: ActionType | readonly ActionType[];
};

/** 锁内验 expected（读完 meta / 定位 action 后调用） */
const matchesOpFreshExpected = (
  meta: TaskMetaV06,
  action: ActionRecord,
  expected?: OpFreshExpected,
): boolean => {
  if (!expected) return true;
  if (
    "currentActionId" in expected &&
    meta.currentActionId !== expected.currentActionId
  ) {
    return false;
  }
  if (expected.actionStatus !== undefined) {
    const allowed = (
      Array.isArray(expected.actionStatus)
        ? expected.actionStatus
        : [expected.actionStatus]
    ) as readonly ActionStatus[];
    if (!allowed.includes(action.status)) return false;
  }
  // action.type 结构条件
  if (expected.actionType !== undefined) {
    const allowedTypes = (
      Array.isArray(expected.actionType)
        ? expected.actionType
        : [expected.actionType]
    ) as readonly ActionType[];
    if (!allowedTypes.includes(action.type)) return false;
  }
  return true;
};

/**
 * 锁内验「actionId === currentActionId 且 status === running」。
 * submit_work 在 abort runningChecks 之前调用——旧 action 迟到重试不得杀新 action 的 check。
 */
export const isCurrentRunningAction = async (
  taskId: string,
  actionId: string,
): Promise<boolean> =>
  withTaskLock(taskId, async () => {
    const meta = await readMetaV06(taskId);
    if (!meta) return false;
    if (meta.currentActionId !== actionId) return false;
    const action = meta.actions.find((a) => a.id === actionId);
    return action?.status === "running";
  });

/**
 * 锁内条件 patch action（不动 runStatus / currentActionId）。
 *
 * 复用 prepare/commit + 锁内复查 isOwner 协议（同 patchActionAndRunStatusIfOpFresh），
 * 给 claim 前的 auto-approve 等「只改 action、已有 admission gen」路径用——
 * stop 若已把 awaiting_ack 写成 cancelled，结构条件 / isOwner 失败则拒写、不落「已通过」。
 *
 * @returns 写成功 → 新 Task；失主 / 结构不符 / 复查失败 / meta 不存在 → null
 */
export const patchActionIfOwner = async (
  taskId: string,
  actionId: string,
  patch: ActionPatchFields,
  isOwner: () => boolean,
  expected?: OpFreshExpected,
): Promise<Task | null> =>
  withTaskLock(taskId, async () => {
    // ① 锁内同步 owner 快查
    if (!isOwner()) return null;
    // ② readMeta + 结构条件
    const meta = await readMetaV06(taskId);
    if (!meta) return null;
    // 终态后旧链 action 写非法（finalize 走裸 patchAction）
    if (isTerminalRepoStatus(meta.repoStatus)) return null;
    if (
      expected &&
      "currentActionId" in expected &&
      meta.currentActionId !== expected.currentActionId
    ) {
      return null;
    }
    const idx = meta.actions.findIndex((a) => a.id === actionId);
    if (idx < 0) return null;
    const action = meta.actions[idx]!;
    if (!matchesOpFreshExpected(meta, action, expected)) return null;

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

    // ③ prepare：脏值只在 tmp
    const prepared = await prepareMetaWrite(meta);
    // ④ 提前短路（省 rename）；权威检查在 commit(finalGuard) 内
    const structureStillOk =
      !expected ||
      !("currentActionId" in expected) ||
      expected.currentActionId === actionId;
    const finalGuard = (): boolean => isOwner() && structureStillOk;
    if (!finalGuard()) {
      await prepared.abort();
      return null;
    }
    const committed = await prepared.commit(finalGuard);
    if (!committed) return null;
    return await hydrateTask(meta);
  });

/**
 * op-fresh 条件事务——锁内验 isFresh + 结构条件后，
 * 一把写 action.status + runStatus + currentActionId；权威检查进 commit(finalGuard)。
 *
 * 时序：/question ackContext 分支若先 patchAction 再 setTaskRunStatus，两段 await 之间
 * stop 可完成并把 idle/cancelled 写回；旧代码无条件第二段写又把 running 盖回去。
 * 把「确认仍是 op owner + 状态变更」放进同一 withTaskLock 临界区。
 *
 * generation 只在 stop/DELETE/finalize 时 bump，普通 advance 不 bump——
 * 同 epoch 后继不是 stale。故额外验 expected.currentActionId / actionStatus，
 * 防旧 Q 把已 completed 的 A 改回 running、把 currentActionId 从 B 抢回 A。
 *
 * prepare / 复查 / commit 单次提交的线性化论证：
 * - prepare 只写 tmp，meta.json 未动——无锁读者（getTask/listTasks）看不到「被拒绝的」新值；
 * - prepare 后同步复查可提前短路（省 rename）；权威检查在 commit 内、rename 发起前同步执行
 *   （owner map 不受 task lock 约束——B 可在 failpoint await 期间接管）；
 * - 口径保留：换主若落在 rename await 内 ⇒ 线性序等于「A 先提交、B 后接管」；
 *   已保证每个接管者在 claim 之后紧跟一次过同一把 withTaskLock 的状态写——
 *   本临界区持锁直到 commit 返回，B 的写必然排在 A 的 rename 之后覆盖它。
 *
 * 为什么闭包注入而不是直接 import task-stream：task-fs 是底座、不反向依赖 runner 层状态
 * （opGen / runningTasks 等挂在 task-stream）；调用方传 `() => !isTaskOpStale(taskId, opGen)`。
 *
 * @returns 写成功 → 新 Task；已 stale / 结构不符 / 复查失败 abort / meta 不存在 → null
 */
export const patchActionAndRunStatusIfOpFresh = async (
  taskId: string,
  actionId: string,
  actionStatus: ActionStatus,
  runStatus: RunStatus,
  isFresh: () => boolean,
  expected?: OpFreshExpected,
  /**
   * 与 status 同事务写入的附加字段（如 postCheck）。
   * 不得用二次裸 patch——两写之间 stop 会留下「cancelled 后又写元数据」窗口。
   */
  extraPatch?: Partial<Pick<ActionRecord, "postCheck">>,
): Promise<Task | null> =>
  withTaskLock(taskId, async () => {
    // ① 锁内同步快查（内存 owner / epoch）
    if (!isFresh()) return null;
    // ② readMeta
    const meta = await readMetaV06(taskId);
    if (!meta) return null;
    // 终态后旧链 action+runStatus 写非法（finalize 走裸 setTaskRepoStatus/setTaskRunStatus）
    if (isTerminalRepoStatus(meta.repoStatus)) return null;
    // 结构条件——同 epoch 并发 advance 后 currentActionId / action.status 可能已变
    if (
      expected &&
      "currentActionId" in expected &&
      meta.currentActionId !== expected.currentActionId
    ) {
      return null;
    }
    const idx = meta.actions.findIndex((a) => a.id === actionId);
    if (idx < 0) return null;
    const action = meta.actions[idx]!;
    if (!matchesOpFreshExpected(meta, action, expected)) return null;

    const now = Date.now();
    const next: ActionRecord = {
      ...action,
      ...(extraPatch ?? {}),
      status: actionStatus,
    };
    if (
      actionStatus !== "running" &&
      action.status === "running"
    ) {
      next.endedAt = now;
    }
    if (actionStatus === "running") {
      next.endedAt = null;
    }
    meta.actions = [
      ...meta.actions.slice(0, idx),
      next,
      ...meta.actions.slice(idx + 1),
    ];
    meta.runStatus = runStatus;
    meta.currentActionId = actionId;
    meta.updatedAt = now;

    // ③ prepare：脏值只在 tmp
    const prepared = await prepareMetaWrite(meta);

    // ④ 提前短路（省 rename）；权威检查在 commit(finalGuard) 内
    // （写后 action.status 已是目标态，结构复查 = expected.currentActionId 仍是本 actionId）
    const structureStillOk =
      !expected ||
      !("currentActionId" in expected) ||
      expected.currentActionId === actionId;
    const finalGuard = (): boolean => isFresh() && structureStillOk;
    if (!finalGuard()) {
      await prepared.abort();
      return null;
    }
    const committed = await prepared.commit(finalGuard);
    if (!committed) return null;
    // 返回的是提交时快照；提交后换主不影响已提交事实（hydrate 只是读、无需再查）
    return await hydrateTask(meta);
  });

/**
 * run-owner 条件写 runStatus——prepare / 同步复查 / 单次 commit。
 *
 * 锚点应是 runningTasks.instanceId（或 opGen），不能只比 currentActionId：
 * stop 后 B「唤醒同一 action」时指针可与旧 Q 相同，旧回滚仍会把 B 的 running 写成 idle。
 * 调用方传 `() => runningTasks.get(taskId)?.instanceId === myInstanceId`。
 *
 * owner Map（runningTasks）不受 task lock 保护——入口 isOwner 成功后仍可能在
 * readMeta/prepare 的 await 间被 forceClear + B 换主。prepare 后再同步查 isOwner，
 * false 则 abort（tmp 丢弃、meta.json 从未出现新值）。线性化论证同
 * {@link patchActionAndRunStatusIfOpFresh}。
 *
 * 闭包注入理由同 {@link patchActionAndRunStatusIfOpFresh}：task-fs 不反向依赖 task-stream。
 *
 * expectedRunStatus 结构条件——调用方入场读到的盘上状态（如 ask 僵尸兜底的
 * awaiting_user）在多段 await 后可能已被并发唤醒的后继写成 running；仅靠「无 session」
 * 挡不住 Agent.create 前窗口。锁内 readMeta 后验证盘上 runStatus 仍是入场值，变了拒写。
 *
 * @returns 写成功 → 新 Task；已非 owner / 结构不符 / 复查失败 abort / meta 不存在 → null
 */
export const setTaskRunStatusIfRunOwner = async (
  taskId: string,
  runStatus: RunStatus,
  isOwner: () => boolean,
  currentActionId?: string | null,
  expectedRunStatus?: RunStatus,
): Promise<Task | null> =>
  withTaskLock(taskId, async () => {
    // ① 同步 isOwner 快查（false 早退）
    if (!isOwner()) return null;
    // ② readMeta
    const meta = await readMetaV06(taskId);
    if (!meta) return null;
    // 终态后旧链 runStatus 写非法（finalize 走裸 setTaskRunStatus）
    if (isTerminalRepoStatus(meta.repoStatus)) return null;
    // 盘上 runStatus 已不是调用方入场看到的值（后继已接管写入）→ 拒写
    if (expectedRunStatus !== undefined && meta.runStatus !== expectedRunStatus) {
      return null;
    }
    // ③ 构造新值 + prepare（脏值只在 tmp）
    meta.runStatus = runStatus;
    if (currentActionId !== undefined) {
      meta.currentActionId = currentActionId;
    }
    meta.updatedAt = Date.now();
    const prepared = await prepareMetaWrite(meta);
    // ④ 提前短路（省 rename）；权威检查在 commit(finalGuard) 内
    if (!isOwner()) {
      await prepared.abort();
      return null;
    }
    const committed = await prepared.commit(isOwner);
    if (!committed) return null;
    // 返回提交时快照；hydrate 只是读
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
 * - 可选 isOwner 合进 finalGuard（ensure 成功后的迟到 upsert 不得在失主后落盘）
 */
export const upsertGitBranch = async (
  taskId: string,
  gitBranch: GitBranchInfo,
  /** 可选 owner lease——合进 commit(finalGuard) */
  isOwner?: () => boolean,
): Promise<Task | null> =>
  withTaskLock(taskId, async () => {
    if (isOwner && !isOwner()) return null;
    const meta = await readMetaV06(taskId);
    if (!meta) return null;
    // 终态拒写——finalize 后 prewarm 迟到不得重建 gitBranches
    // （与 finalize/setTaskRepoStatus 同把 withTaskLock，持锁期间终态不会被并发改）
    if (isTerminalRepoStatus(meta.repoStatus)) return null;
    const existing = meta.gitBranches ?? [];
    const idx = existing.findIndex((b) => b.repoPath === gitBranch.repoPath);
    meta.gitBranches =
      idx >= 0
        ? existing.map((b, i) => (i === idx ? gitBranch : b))
        : [...existing, gitBranch];
    meta.updatedAt = Date.now();
    // 走 prepare+commit(finalGuard) 体系
    const prepared = await prepareMetaWrite(meta);
    const finalGuard = (): boolean =>
      !isTerminalRepoStatus(meta.repoStatus) && (!isOwner || isOwner());
    if (!finalGuard()) {
      await prepared.abort();
      return null;
    }
    const committed = await prepared.commit(finalGuard);
    if (!committed) return null;
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
  /** 可选锁内 caller 闸 */
  isOwner?: () => boolean,
  /**
   * 可选锁内结构条件（action lease）——该 action 必须仍是 currentActionId、
   * status running、且类型在允许集内（set_feishu_testers 语义 = ship 流程记忆）。
   * 结构条件真正进锁内 expected + finalGuard（验收点名「报告声称进了锁内、实际没有」）。
   */
  expectedAction?: { actionId: string; types: readonly ActionType[] },
): Promise<Task | null> =>
  withTaskLock(taskId, async () => {
    if (isOwner && !isOwner()) return null;
    const meta = await readMetaV06(taskId);
    if (!meta) return null;
    // 锁内验结构条件——外层 fresh 检查后、拿锁前 action 可能已切换
    if (expectedAction) {
      const a = meta.actions.find((x) => x.id === expectedAction.actionId);
      if (
        meta.currentActionId !== expectedAction.actionId ||
        !a ||
        a.status !== "running" ||
        !expectedAction.types.includes(a.type)
      ) {
        return null;
      }
    }
    meta.feishuTesterUserKeys = userKeys;
    meta.updatedAt = Date.now();
    if (isOwner || expectedAction) {
      const prepared = await prepareMetaWrite(meta);
      // finalGuard = caller 闸 + 结构条件（结构基于锁内 meta——写锁互斥、即最新盘上状态）
      const structureOk = (): boolean => {
        if (!expectedAction) return true;
        const a = meta.actions.find((x) => x.id === expectedAction.actionId);
        return (
          meta.currentActionId === expectedAction.actionId &&
          !!a &&
          a.status === "running" &&
          expectedAction.types.includes(a.type)
        );
      };
      const finalGuard = (): boolean =>
        (!isOwner || isOwner()) && structureOk();
      // 提前短路（省 rename）；权威检查在 commit 内
      if (!finalGuard()) {
        await prepared.abort();
        return null;
      }
      const committed = await prepared.commit(finalGuard);
      if (!committed) return null;
    } else {
      await writeMeta(meta);
    }
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
 *
 * submit_mr 本地落盘请用 {@link upsertMRWithActionSideEffect}（双投影单事务）；
 * 本函数保留给 mr-inbox 等只改 task.mrs 的路径。
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
  /**
   * 可选锁内 owner 闸（submit_mr 传 callerStillValid）——失主拒写、
   * createMR 已发生后的迟到落盘不再污染新主时间线。
   */
  isOwner?: () => boolean,
  /** 可选锁内结构条件——该 action 必须仍是 currentActionId 且 running（action lease） */
  expectedActionId?: string,
): Promise<{ task: Task; mr: MRRecord } | null> =>
  withTaskLock(taskId, async () => {
    if (isOwner && !isOwner()) return null;
    const meta = await readMetaV06(taskId);
    if (!meta) return null;
    // action lease 锁内验——action 已切换/结束则拒写（历史 action 迟到 submit_mr）
    if (expectedActionId !== undefined) {
      const a = meta.actions.find((x) => x.id === expectedActionId);
      if (
        meta.currentActionId !== expectedActionId ||
        a?.status !== "running"
      ) {
        return null;
      }
    }
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
    if (isOwner || expectedActionId !== undefined) {
      const prepared = await prepareMetaWrite(meta);
      // finalGuard = caller + action lease 结构条件
      const structureOk = (): boolean => {
        if (expectedActionId === undefined) return true;
        const a = meta.actions.find((x) => x.id === expectedActionId);
        return (
          meta.currentActionId === expectedActionId && a?.status === "running"
        );
      };
      const finalGuard = (): boolean =>
        (!isOwner || isOwner()) && structureOk();
      if (!finalGuard()) {
        await prepared.abort();
        return null;
      }
      const committed = await prepared.commit(finalGuard);
      if (!committed) return null;
    } else {
      await writeMeta(meta);
    }
    const task = await hydrateTask(meta);
    return { task, mr: nextMR };
  });

/**
 * MR 双投影单事务——一把 task lock 内同时更新
 *   `task.mrs[]`（upsertMR 语义、含 mrVersion 推进）与
 *   `action.sideEffects.mrs[]`（原 appendActionSideEffectMR 语义）。
 *
 * 关闭「两写之间被 post-check/stop/advance 插队 → task.mrs 有、action 审计缺、
 * mrVersion 不一致」的半状态窗口。caller/action lease 合进 finalGuard。
 */
export const upsertMRWithActionSideEffect = async (
  taskId: string,
  actionId: string,
  mr: {
    repoPath: string;
    /** V0.x：MR 目标分支（提测=测试分支 / 联调=dev 分支） */
    targetBranch: string;
    url: string;
    title: string;
    branch: string;
    status: MRRecord["status"];
    lastCommitHash?: string;
    hasConflicts?: boolean;
    mergeStatus?: string;
  },
  /** 锁内 caller 闸 */
  isOwner?: () => boolean,
  /**
   * 结构条件——默认要求该 action 仍是 current + running。
   * 传 `requireCurrentRunning: false` 仅测试旁路（生产 submit_mr 不传）。
   */
  expected?: { requireCurrentRunning?: boolean },
): Promise<{ task: Task; mr: MRRecord } | null> =>
  withTaskLock(taskId, async () => {
    if (isOwner && !isOwner()) return null;
    const meta = await readMetaV06(taskId);
    if (!meta) return null;
    const requireCurrentRunning = expected?.requireCurrentRunning !== false;
    const actionIdx = meta.actions.findIndex((a) => a.id === actionId);
    if (actionIdx < 0) return null;
    const action = meta.actions[actionIdx]!;
    // 历史 / 已切 action 的迟到写拒
    if (
      requireCurrentRunning &&
      (meta.currentActionId !== actionId || action.status !== "running")
    ) {
      return null;
    }

    const now = Date.now();
    const { repoPath } = mr;
    // ── ① task.mrs upsert（与 upsertMR 同语义）──
    const mrIdx = meta.mrs.findIndex(
      (m) =>
        m.repoPath === repoPath &&
        mrTargetBranchOf(m, meta.repoTestBranches) === mr.targetBranch,
    );
    let nextMR: MRRecord;
    if (mrIdx >= 0) {
      const old = meta.mrs[mrIdx]!;
      nextMR = {
        ...old,
        targetBranch: mr.targetBranch,
        url: mr.url,
        title: mr.title,
        branch: mr.branch,
        status: mr.status,
        lastCommitHash: mr.lastCommitHash ?? old.lastCommitHash,
        hasConflicts: mr.hasConflicts ?? old.hasConflicts,
        mergeStatus: mr.mergeStatus ?? old.mergeStatus,
        version: old.version + 1,
      };
      meta.mrs = [
        ...meta.mrs.slice(0, mrIdx),
        nextMR,
        ...meta.mrs.slice(mrIdx + 1),
      ];
    } else {
      nextMR = {
        repoPath,
        targetBranch: mr.targetBranch,
        url: mr.url,
        title: mr.title,
        branch: mr.branch,
        status: mr.status,
        lastCommitHash: mr.lastCommitHash,
        hasConflicts: mr.hasConflicts,
        mergeStatus: mr.mergeStatus,
        version: 1,
        createdAt: now,
      };
      meta.mrs = [...meta.mrs, nextMR];
    }

    // ── ② action.sideEffects.mrs 追加（同 repoPath 去重覆盖、mrVersion 用刚算的 version）──
    const existingMrs = action.sideEffects?.mrs ?? [];
    const filtered = existingMrs.filter((m) => m.repoPath !== repoPath);
    const nextAction: ActionRecord = {
      ...action,
      sideEffects: {
        ...(action.sideEffects ?? {}),
        mrs: [
          ...filtered,
          {
            repoPath,
            targetBranch: mr.targetBranch,
            mrUrl: mr.url,
            mrVersion: nextMR.version,
            branch: mr.branch,
            commitHash: mr.lastCommitHash ?? "",
            hasConflicts: mr.hasConflicts,
          },
        ],
      },
    };
    meta.actions = [
      ...meta.actions.slice(0, actionIdx),
      nextAction,
      ...meta.actions.slice(actionIdx + 1),
    ];
    meta.updatedAt = now;

    const prepared = await prepareMetaWrite(meta);
    // finalGuard = caller + 结构条件（rename 前同步复查）
    const structureOk = (): boolean => {
      if (!requireCurrentRunning) return true;
      const a = meta.actions.find((x) => x.id === actionId);
      return meta.currentActionId === actionId && a?.status === "running";
    };
    const finalGuard = (): boolean => (!isOwner || isOwner()) && structureOk();
    if (!finalGuard()) {
      await prepared.abort();
      return null;
    }
    const committed = await prepared.commit(finalGuard);
    if (!committed) return null;
    const task = await hydrateTask(meta);
    return { task, mr: nextMR };
  });
