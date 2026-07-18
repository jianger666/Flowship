/**
 * Chat 模式消息级 checkpoint / rewind（Phase 3 server）
 *
 * 方案：git tree 快照（非 GB 文件正文）。workdir 必是 git 仓；用临时 GIT_INDEX_FILE
 * + `git add -A` + `write-tree` 拿 treeOid，不改真实 index / 工作区，且含 untracked。
 * 比 GB「只快照 edit/write touched」能覆盖 shell 写（sed / 重定向）。
 *
 * 数据落盘抄 GB 流程改造：
 *   data/tasks/<id>/checkpoints/rewind_points.jsonl
 *   每行 { eventId, createdAt, repoSnapshots:[{ repoPath, treeOid }] }
 *   保留近 20 条；rewind 执行顺序：门闩 → 校验 → 锁内复查 → 安全快照落盘
 *   → 恢复文件 → 截断对话 / 裁剪 rewind_points / 写 meta。
 *
 * tree 用 refs/ai-flow/checkpoints/<taskId>/<treeOid> 保活，防 git gc 清掉
 * 仅被 JSONL 引用的对象。task 删除前由 cleanupCheckpointRefsForTask 清 refs，
 * 否则被删任务的历史 tree/blob 会永久留在用户仓里。
 *
 * 与 chat-runner / chat-reply 的配合：本侧 tryBeginChatRewind 占门闩；对侧在
 * 发送/启动/compact/drain 前同步检查 isChatRewindInProgress；本侧再查
 * isCompactInProgress / isQueueDraining，两侧 check-and-set 交叉闭合竞态窗口。
 */

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { Task, TaskEvent } from "@/lib/types";
import { renameWithRetry } from "./data-root";
import {
  endChatRewind,
  getChatLifecycle,
  hasChatStartReservation,
  tryBeginChatRewind,
} from "./chat-gate";
import { clearChatQueue, getChatQueueCount } from "./chat-queue";
import {
  EVENTS_FILE,
  readEvents,
  readMetaV06,
  taskDir,
  withTaskLock,
  writeMeta,
} from "./task-fs-core";
import { isGitRepoPath } from "./task-worktrees";

const execFileAsync = promisify(execFile);

/** 近 N 条 rewind 点，超出删最老 */
export const MAX_REWIND_POINTS = 20;

/** git 命令超时（任务书：15s） */
const GIT_TIMEOUT_MS = 15_000;

const CHECKPOINTS_DIR = "checkpoints";
const REWIND_POINTS_FILE = "rewind_points.jsonl";

/** checkpoint tree 的可达 ref 前缀（git 允许 ref 直接指向 tree 对象） */
const CHECKPOINT_REF_PREFIX = "refs/ai-flow/checkpoints";

// ----------------- 类型（给批 B UI / 测试共用）-----------------

/** 单仓 git tree 快照 */
export interface RepoTreeSnapshot {
  repoPath: string;
  /** `git write-tree` 产出的 tree oid（含当时 untracked） */
  treeOid: string;
}

/**
 * 一条 rewind 点（对齐 GB RewindPoint，prompt_index → eventId）
 * safety 点（误操作后路）的 eventId 形如 `pre_rewind_<ts>`，不对应 user_reply。
 */
export interface RewindPoint {
  eventId: string;
  createdAt: number;
  repoSnapshots: RepoTreeSnapshot[];
  /** 可选：是否为 rewind 前安全快照（无对应 user_reply） */
  kind?: "checkpoint" | "pre_rewind";
}

export interface CaptureCheckpointResult {
  /** 是否至少有一个仓快照成功 */
  ok: boolean;
  repoSnapshots: RepoTreeSnapshot[];
  /** 各仓耗时 ms（报告 / UI loading 用） */
  elapsedMsByRepo: Record<string, number>;
  warnings: string[];
}

export interface RestoreReposDetail {
  repoPath: string;
  treeOid: string;
  ok: boolean;
  /** restore 后清掉的 untracked（快照后新建的） */
  removedUntracked: string[];
  error?: string;
}

export interface RewindResult {
  ok: true;
  /**
   * 回退已提交后的最新 Task；锁外 getTask 仍失败时为 null。
   * 绝不能因读失败把已提交的回退报成 HTTP 错误（会诱导客户端重试破坏性请求）。
   */
  task: Task | null;
  restoredRepos: RestoreReposDetail[];
  /** 被截断掉的事件条数（含目标 user_reply 及之后） */
  truncatedEventCount: number;
  /** getTask 失败：回退已成功，客户端应刷新查看最新状态 */
  refreshRequired?: true;
}

export type RewindErrorCode =
  | "not_found"
  | "not_chat"
  | "no_checkpoint"
  | "run_active"
  | "restore_failed";

export class RewindError extends Error {
  readonly code: RewindErrorCode;
  readonly status: number;

  constructor(code: RewindErrorCode, message: string, status: number) {
    super(message);
    this.name = "RewindError";
    this.code = code;
    this.status = status;
  }
}

// ----------------- 路径 -----------------

export const getCheckpointsDir = (taskId: string): string =>
  path.join(taskDir(taskId), CHECKPOINTS_DIR);

export const getRewindPointsPath = (taskId: string): string =>
  path.join(getCheckpointsDir(taskId), REWIND_POINTS_FILE);

export const checkpointRefName = (taskId: string, treeOid: string): string =>
  `${CHECKPOINT_REF_PREFIX}/${taskId}/${treeOid}`;

// ----------------- git helper（execFile 传参、不拼 shell）-----------------

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

const runGit = async (
  repoPath: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<GitResult> => {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd: repoPath,
      timeout: opts.timeoutMs ?? GIT_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
    });
    return {
      ok: true,
      stdout: String(stdout).trim(),
      stderr: String(stderr).trim(),
    };
  } catch (err) {
    const e = err as Error & { stdout?: string; stderr?: string };
    return {
      ok: false,
      stdout: String(e.stdout ?? "").trim(),
      stderr: String(e.stderr ?? e.message ?? "").trim(),
    };
  }
};

/** tree oid 形态校验（sha1 40 / sha256 64） */
const isTreeOid = (s: string): boolean => /^[0-9a-f]{40,64}$/i.test(s);

/**
 * 无副作用快照工作区 → treeOid。
 * 临时 GIT_INDEX_FILE：`read-tree HEAD`（有则）+ `add -A` + `write-tree`，
 * 不碰真实 index / 工作区；untracked（非 ignore）进 tree。
 */
export const snapshotRepoTree = async (
  repoPath: string,
): Promise<{ treeOid: string } | { error: string }> => {
  if (!isGitRepoPath(repoPath)) {
    return { error: "不是 git 仓" };
  }

  const tmpIndex = path.join(
    os.tmpdir(),
    `fe-ckpt-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.index`,
  );
  const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };

  try {
    // 有 HEAD 则先铺底；空仓 / 无 commit 则空 index 起步，add -A 仍可收 untracked
    const head = await runGit(repoPath, ["rev-parse", "--verify", "HEAD"]);
    if (head.ok) {
      const rt = await runGit(repoPath, ["read-tree", "HEAD"], { env });
      if (!rt.ok) {
        return { error: `read-tree HEAD 失败：${rt.stderr}` };
      }
    }

    const add = await runGit(repoPath, ["add", "-A"], { env });
    if (!add.ok) {
      return { error: `add -A 失败：${add.stderr}` };
    }

    const tree = await runGit(repoPath, ["write-tree"], { env });
    if (!tree.ok || !isTreeOid(tree.stdout)) {
      return { error: `write-tree 失败：${tree.stderr || tree.stdout}` };
    }
    return { treeOid: tree.stdout.toLowerCase() };
  } finally {
    await fs.unlink(tmpIndex).catch(() => {});
  }
};

/**
 * 把工作区 + index 恢复到 treeOid，并清掉 restore 后仍 untracked 的文件
 *（= 快照之后新建、不在 tree 里的）。
 */
export const restoreRepoTree = async (
  repoPath: string,
  treeOid: string,
): Promise<RestoreReposDetail> => {
  const base: RestoreReposDetail = {
    repoPath,
    treeOid,
    ok: false,
    removedUntracked: [],
  };

  if (!isGitRepoPath(repoPath)) {
    return { ...base, error: "不是 git 仓" };
  }
  if (!isTreeOid(treeOid)) {
    return { ...base, error: `非法 treeOid：${treeOid}` };
  }

  // -u --reset：index + 工作区对齐到 tree（tracked 增删改一次到位）
  const reset = await runGit(repoPath, [
    "read-tree",
    "-u",
    "--reset",
    treeOid,
  ]);
  if (!reset.ok) {
    return { ...base, error: `read-tree 失败：${reset.stderr}` };
  }

  // 快照后新建的 untracked 仍留在盘上（含空目录）→ git clean -fd 对齐「当时」
  // 不进 -x：ignored 文件本就不进快照，保持不动
  const beforeClean = await runGit(repoPath, [
    "status",
    "--porcelain",
    "-uall",
  ]);
  const removedUntracked: string[] = [];
  if (beforeClean.ok && beforeClean.stdout) {
    for (const line of beforeClean.stdout.split("\n")) {
      if (!line.startsWith("?? ")) continue;
      let rel = line.slice(3);
      if (
        (rel.startsWith('"') && rel.endsWith('"')) ||
        (rel.startsWith("'") && rel.endsWith("'"))
      ) {
        rel = rel.slice(1, -1);
      }
      // 目录条目常带尾 /
      if (rel.endsWith("/")) rel = rel.slice(0, -1);
      if (rel) removedUntracked.push(rel);
    }
  }

  const cleaned = await runGit(repoPath, ["clean", "-fd"]);
  if (!cleaned.ok) {
    return {
      ...base,
      removedUntracked,
      error: `git clean 失败：${cleaned.stderr}`,
    };
  }

  return { ...base, ok: true, removedUntracked };
};

// ----------------- checkpoint ref（防 gc）-----------------

/**
 * 为 RewindPoint 的每个 repoSnapshot 建可达 ref，避免 write-tree 对象被 gc 清掉。
 * 失败只 warn，不挡主流程（JSONL 仍是真相源；最坏情况 rewind 时 preflight 会报对象丢失）。
 */
export const syncCheckpointRefs = async (
  taskId: string,
  point: RewindPoint,
): Promise<void> => {
  for (const s of point.repoSnapshots) {
    const ref = checkpointRefName(taskId, s.treeOid);
    const r = await runGit(s.repoPath, ["update-ref", ref, s.treeOid]);
    if (!r.ok) {
      console.warn(
        `[chat-checkpoint] syncCheckpointRefs 失败 task=${taskId} repo=${s.repoPath} tree=${s.treeOid}: ${r.stderr}`,
      );
    }
  }
};

/** 删除单条 checkpoint ref（best-effort） */
const deleteCheckpointRef = async (
  repoPath: string,
  taskId: string,
  treeOid: string,
): Promise<void> => {
  const ref = checkpointRefName(taskId, treeOid);
  const r = await runGit(repoPath, ["update-ref", "-d", ref]);
  if (!r.ok) {
    // ref 本就不存在时 git 也会非 0，属无害
    console.warn(
      `[chat-checkpoint] 删除 checkpoint ref 失败 task=${taskId} repo=${repoPath} tree=${treeOid}: ${r.stderr}`,
    );
  }
};

const repoTreeKey = (repoPath: string, treeOid: string): string =>
  `${repoPath}\0${treeOid}`;

/**
 * 对被丢弃的点：若其 treeOid 不再被该 task 剩余点引用，则删对应 ref。
 * 连续消息无改动时多点共享同一 treeOid，必须查引用计数，避免误删仍在用的 ref。
 */
const pruneCheckpointRefs = async (
  taskId: string,
  discarded: RewindPoint[],
  remaining: RewindPoint[],
): Promise<void> => {
  const stillUsed = new Set<string>();
  for (const p of remaining) {
    for (const s of p.repoSnapshots) {
      stillUsed.add(repoTreeKey(s.repoPath, s.treeOid));
    }
  }
  const seen = new Set<string>();
  for (const p of discarded) {
    for (const s of p.repoSnapshots) {
      const key = repoTreeKey(s.repoPath, s.treeOid);
      if (stillUsed.has(key) || seen.has(key)) continue;
      seen.add(key);
      await deleteCheckpointRef(s.repoPath, taskId, s.treeOid);
    }
  }
};

/** 验证 tree 对象仍在对象库（含 ^{tree} 剥皮，拒绝 blob/commit 误用） */
const verifyTreeObjectExists = async (
  repoPath: string,
  treeOid: string,
): Promise<boolean> => {
  const r = await runGit(repoPath, ["cat-file", "-e", `${treeOid}^{tree}`]);
  return r.ok;
};

// ----------------- rewind_points.jsonl IO（写路径持 withTaskLock）-----------------

const parseRewindLine = (raw: string): RewindPoint | null => {
  const text = raw.trim();
  if (!text) return null;
  try {
    const obj = JSON.parse(text) as Partial<RewindPoint>;
    if (typeof obj.eventId !== "string" || typeof obj.createdAt !== "number") {
      return null;
    }
    if (!Array.isArray(obj.repoSnapshots)) return null;
    const repoSnapshots: RepoTreeSnapshot[] = [];
    for (const s of obj.repoSnapshots) {
      if (
        !s ||
        typeof s.repoPath !== "string" ||
        typeof s.treeOid !== "string" ||
        !isTreeOid(s.treeOid)
      ) {
        continue;
      }
      repoSnapshots.push({ repoPath: s.repoPath, treeOid: s.treeOid });
    }
    const kind =
      obj.kind === "pre_rewind" || obj.kind === "checkpoint"
        ? obj.kind
        : undefined;
    return {
      eventId: obj.eventId,
      createdAt: obj.createdAt,
      repoSnapshots,
      kind,
    };
  } catch {
    return null;
  }
};

/** 读全量 rewind 点（文件不存在 → []） */
export const readRewindPoints = async (
  taskId: string,
): Promise<RewindPoint[]> => {
  const p = getRewindPointsPath(taskId);
  let raw: string;
  try {
    raw = await fs.readFile(p, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: RewindPoint[] = [];
  for (const line of raw.split("\n")) {
    const pt = parseRewindLine(line);
    if (pt) out.push(pt);
  }
  return out;
};

/** 原子重写 rewind_points.jsonl（先 mkdir） */
export const writeRewindPoints = async (
  taskId: string,
  points: RewindPoint[],
): Promise<void> => {
  const dir = getCheckpointsDir(taskId);
  await fs.mkdir(dir, { recursive: true });
  const finalPath = getRewindPointsPath(taskId);
  const body =
    points.length === 0
      ? ""
      : points.map((p) => JSON.stringify(p)).join("\n") + "\n";
  const tmpPath = `${finalPath}.tmp.${process.pid}.${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  try {
    await fs.writeFile(tmpPath, body, "utf-8");
    await renameWithRetry(tmpPath, finalPath);
  } catch (err) {
    await fs.unlink(tmpPath).catch(() => {});
    throw err;
  }
};

/**
 * 删除任务前清理各仓里该 task 的 checkpoint refs。
 * 不清理会让被删任务的历史 tree/blob 永久保留在用户仓里（refs 保活对象）。
 * 须在 deleteTask 之前调用（还要能读到 rewind_points）。全程 best-effort。
 */
export const cleanupCheckpointRefsForTask = async (
  taskId: string,
): Promise<void> => {
  let points: RewindPoint[];
  try {
    points = await readRewindPoints(taskId);
  } catch (err) {
    console.warn(
      `[chat-checkpoint] cleanupCheckpointRefs 读 rewind_points 失败 task=${taskId}:`,
      err instanceof Error ? err.message : err,
    );
    return;
  }
  if (points.length === 0) return;

  const repoPaths = new Set<string>();
  for (const p of points) {
    for (const s of p.repoSnapshots) {
      if (s.repoPath) repoPaths.add(s.repoPath);
    }
  }

  const refPrefix = `${CHECKPOINT_REF_PREFIX}/${taskId}/`;
  for (const repoPath of repoPaths) {
    const listed = await runGit(repoPath, [
      "for-each-ref",
      "--format=%(refname)",
      refPrefix,
    ]);
    if (!listed.ok) {
      console.warn(
        `[chat-checkpoint] cleanupCheckpointRefs for-each-ref 失败 task=${taskId} repo=${repoPath}: ${listed.stderr}`,
      );
      continue;
    }
    for (const ref of listed.stdout.split("\n")) {
      const name = ref.trim();
      if (!name) continue;
      const del = await runGit(repoPath, ["update-ref", "-d", name]);
      if (!del.ok) {
        console.warn(
          `[chat-checkpoint] cleanupCheckpointRefs 删 ref 失败 task=${taskId} repo=${repoPath} ref=${name}: ${del.stderr}`,
        );
      }
    }
  }
};

/**
 * 追加一条 checkpoint 并裁到近 MAX_REWIND_POINTS。
 * 整段在 withTaskLock 内；同步建/删 checkpoint refs（防 gc）。
 */
export const appendRewindPoint = async (
  taskId: string,
  point: RewindPoint,
): Promise<void> =>
  withTaskLock(taskId, async () => {
    const existing = await readRewindPoints(taskId);
    existing.push(point);
    const overflow = existing.length - MAX_REWIND_POINTS;
    const discarded = overflow > 0 ? existing.slice(0, overflow) : [];
    const trimmed =
      overflow > 0 ? existing.slice(overflow) : existing;
    await writeRewindPoints(taskId, trimmed);
    await syncCheckpointRefs(taskId, point);
    if (discarded.length > 0) {
      await pruneCheckpointRefs(taskId, discarded, trimmed);
    }
  });

// ----------------- 打点（消息发出前）-----------------

/**
 * 对已绑 workdir 打 git tree 快照。失败不抛——调用方 warn + 不带 checkpointed。
 * 空 repoPaths → ok:false（未绑仓不做 checkpoint）。
 */
export const captureChatCheckpoint = async (
  repoPaths: string[],
): Promise<CaptureCheckpointResult> => {
  const paths = (repoPaths ?? []).filter(
    (p) => typeof p === "string" && p.trim(),
  );
  if (paths.length === 0) {
    return { ok: false, repoSnapshots: [], elapsedMsByRepo: {}, warnings: [] };
  }

  const repoSnapshots: RepoTreeSnapshot[] = [];
  const elapsedMsByRepo: Record<string, number> = {};
  const warnings: string[] = [];

  for (const repoPath of paths) {
    const t0 = Date.now();
    const snap = await snapshotRepoTree(repoPath);
    elapsedMsByRepo[repoPath] = Date.now() - t0;
    if ("error" in snap) {
      warnings.push(`${repoPath}: ${snap.error}`);
      continue;
    }
    repoSnapshots.push({ repoPath, treeOid: snap.treeOid });
  }

  return {
    ok: repoSnapshots.length > 0,
    repoSnapshots,
    elapsedMsByRepo,
    warnings,
  };
};

/**
 * 落 rewind 点（有快照且有 eventId 时）。失败只 warn，不挡发消息。
 */
export const persistCheckpointForReply = async (
  taskId: string,
  eventId: string,
  capture: CaptureCheckpointResult,
): Promise<boolean> => {
  if (!capture.ok || capture.repoSnapshots.length === 0) return false;
  try {
    await appendRewindPoint(taskId, {
      eventId,
      createdAt: Date.now(),
      repoSnapshots: capture.repoSnapshots,
      kind: "checkpoint",
    });
    return true;
  } catch (err) {
    console.warn(
      `[chat-checkpoint] 写 rewind_points 失败 task=${taskId} event=${eventId}:`,
      err instanceof Error ? err.message : err,
    );
    return false;
  }
};

// ----------------- 截断 events.jsonl -----------------

/** 原子写文本文件（tmp + rename），供 events / 后置失败恢复复用 */
const atomicWriteTextFile = async (
  finalPath: string,
  body: string,
): Promise<void> => {
  const tmpPath = `${finalPath}.tmp.${process.pid}.${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  try {
    await fs.writeFile(tmpPath, body, "utf-8");
    await renameWithRetry(tmpPath, finalPath);
  } catch (err) {
    await fs.unlink(tmpPath).catch(() => {});
    throw err;
  }
};

/** 读 events.jsonl 原文（文件不存在 → ""）；后置失败时写回用 */
const readEventsRawText = async (taskId: string): Promise<string> => {
  const p = path.join(taskDir(taskId), EVENTS_FILE);
  try {
    return await fs.readFile(p, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw err;
  }
};

/** 原子重写 events：保留严格早于 eventId 的行（不含目标及之后） */
export const truncateEventsBeforeEventId = async (
  taskId: string,
  eventId: string,
): Promise<{ kept: TaskEvent[]; truncatedCount: number } | null> => {
  const events = await readEvents(taskId);
  const idx = events.findIndex((e) => e.id === eventId);
  if (idx < 0) return null;
  const kept = events.slice(0, idx);
  const truncatedCount = events.length - kept.length;

  const finalPath = path.join(taskDir(taskId), EVENTS_FILE);
  const body =
    kept.length === 0
      ? ""
      : kept.map((e) => JSON.stringify(e)).join("\n") + "\n";
  await atomicWriteTextFile(finalPath, body);
  return { kept, truncatedCount };
};

// ----------------- rewind 主流程 -----------------

export interface RewindDeps {
  /** 无条件关 chat 会话（清 sessionAgentId） */
  closeSession: (taskId: string) => void;
  /** 当前是否有 chat run 在跑 */
  isRunActive: (taskId: string) => boolean;
  /**
   * compact 是否进行中。与 chat-runner.compactChatSession 交叉闭合：
   * compact 侧先 set 再查 rewind 门闩；本侧占 rewind 门闩后再查 compact。
   */
  isCompactInProgress: (taskId: string) => boolean;
  /**
   * queue drain（flushChatQueue）是否进行中。与 flushChatQueue 入口的
   * rewind 门闩检查交叉闭合（另一侧在 chat-runner 做）。
   */
  isQueueDraining: (taskId: string) => boolean;
  /** 写 info 事件 */
  appendInfoEvent: (
    taskId: string,
    text: string,
  ) => Promise<TaskEvent | null>;
  /** 读完整 Task（截断后） */
  getTask: (taskId: string) => Promise<Task | null>;
}

/** 把回滚结果拼进错误文案：哪些仓已回滚、哪些需手工处理（带安全点 treeOid） */
const formatRollbackNote = (
  rollbackResults: RestoreReposDetail[],
  safetyByRepo: Map<string, string>,
): string => {
  const okRepos = rollbackResults.filter((d) => d.ok).map((d) => d.repoPath);
  const failRepos = rollbackResults.filter((d) => !d.ok);
  const parts: string[] = [];
  if (okRepos.length > 0) {
    parts.push(`已回滚成功：${okRepos.join(", ")}`);
  }
  if (failRepos.length > 0) {
    parts.push(
      `需手工处理：${failRepos
        .map((d) => {
          const safetyOid =
            safetyByRepo.get(d.repoPath) ?? (d.treeOid || "(无安全点)");
          return `${d.repoPath}（安全点 treeOid=${safetyOid}）${d.error ? `: ${d.error}` : ""}`;
        })
        .join("; ")}`,
    );
  }
  return parts.length > 0 ? parts.join("；") : "无仓需要回滚";
};

/**
 * 执行 rewind：门闩 → 校验 → 锁内复查 → 安全快照落盘 → 恢复文件 → 截断对话 / 写盘 → 关会话。
 * jsonl / meta / events / git 恢复整段在 withTaskLock 内；info 在锁外写（避免嵌套锁）。
 *
 * 事务语义：任一仓恢复失败或后置写盘失败 → 用安全快照回滚已改动的仓，
 * 尽量回到 rewind 前文件状态；安全点已先落盘，用户仍有恢复入口。
 * 后置写盘失败时还会尽量恢复 events.jsonl 原文，并把 rewind_points 恢复为
 * lockedPoints + safetyPoint（安全点保留——真实存在的安全快照，留着无害且有用）。
 * pruneCheckpointRefs 必须在 writeMeta 等最后一个可失败的提交写之后（复审 N4）：
 * 否则 writeMeta 失败时 catch 能恢复 JSONL 引用，但 refs 已被删，随后 git gc 会清掉对象。
 */
export const executeChatRewind = async (
  taskId: string,
  eventId: string,
  deps: RewindDeps,
): Promise<RewindResult> => {
  // 进程内门闩：先占位，阻止 chat-reply 在检查完 isRunActive 后仍启动 run
  if (!tryBeginChatRewind(taskId)) {
    throw new RewindError("run_active", "已有回退在进行中", 409);
  }

  try {
    // T2：占位后立刻查 stop/DELETE lifecycle——闭合「rewind 刚起步、DELETE 已在收尾」
    // 反向竞态；抛错走 finally endChatRewind，勿与删除交叉改仓
    const lifecycle = getChatLifecycle(taskId);
    if (lifecycle === "stopping" || lifecycle === "deleting") {
      throw new RewindError(
        "run_active",
        "任务正在停止/删除、无法回退",
        409,
      );
    }

    // 占位后再查 compact：与 compact 侧「先 set 再查 rewind」交叉闭合
    if (deps.isCompactInProgress(taskId)) {
      throw new RewindError(
        "run_active",
        "正在压缩会话、请稍后回退",
        409,
      );
    }

    const meta = await readMetaV06(taskId);
    if (!meta) {
      throw new RewindError("not_found", "task 不存在", 404);
    }
    if (meta.mode !== "chat") {
      throw new RewindError("not_chat", "仅 chat 模式支持 rewind", 409);
    }
    if (deps.isRunActive(taskId) || meta.runStatus === "running") {
      throw new RewindError(
        "run_active",
        "agent 正在跑、请先停止再回退",
        409,
      );
    }

    const pointsPeek = await readRewindPoints(taskId);
    const targetPeek = pointsPeek.find(
      (p) => p.eventId === eventId && p.kind !== "pre_rewind",
    );
    if (!targetPeek || targetPeek.repoSnapshots.length === 0) {
      throw new RewindError(
        "no_checkpoint",
        `找不到 eventId=${eventId} 的检查点`,
        404,
      );
    }

    const core = await withTaskLock(taskId, async () => {
      const lockedPoints = await readRewindPoints(taskId);
      const targetIdx = lockedPoints.findIndex(
        (p) => p.eventId === eventId && p.kind !== "pre_rewind",
      );
      if (targetIdx < 0) {
        throw new RewindError(
          "no_checkpoint",
          `找不到 eventId=${eventId} 的检查点`,
          404,
        );
      }
      const lockedTarget = lockedPoints[targetIdx]!;

      // —— 锁内复查（闭合 TOCTOU）：进锁前到破坏性操作之间，chat-reply / compact / drain 可能已启动 ——
      // 对侧会在发送/启动/compact/drain 前同步检查 isChatRewindInProgress；两侧配合闭合窗口。
      const lockedMeta = await readMetaV06(taskId);
      if (!lockedMeta) {
        throw new RewindError("not_found", "task 在 rewind 中被删", 404);
      }
      if (deps.isRunActive(taskId)) {
        throw new RewindError(
          "run_active",
          "agent 正在跑、请先停止再回退",
          409,
        );
      }
      if (lockedMeta.runStatus === "running") {
        throw new RewindError(
          "run_active",
          "任务 runStatus 为 running、请先停止再回退",
          409,
        );
      }
      if (deps.isCompactInProgress(taskId)) {
        throw new RewindError(
          "run_active",
          "正在压缩会话、请稍后回退",
          409,
        );
      }
      if (deps.isQueueDraining(taskId)) {
        // 与 flushChatQueue 入口的 rewind 门闩检查交叉闭合（另一侧在 chat-runner）
        throw new RewindError(
          "run_active",
          "正在发送排队消息、请稍后回退",
          409,
        );
      }
      if (hasChatStartReservation(taskId)) {
        throw new RewindError(
          "run_active",
          "正在启动新会话、请稍后回退",
          409,
        );
      }
      if (getChatQueueCount(taskId) > 0) {
        throw new RewindError(
          "run_active",
          "仍有排队中的消息、请先停止或等待发送完成再回退",
          409,
        );
      }
      // 复查通过：清掉排队（防竞态下刚入队的旧上下文消息在回退后幽灵发送）
      clearChatQueue(taskId);

      // —— preflight：确认目标 tree 仍在、events 里确有该 eventId ——
      for (const s of lockedTarget.repoSnapshots) {
        const exists = await verifyTreeObjectExists(s.repoPath, s.treeOid);
        if (!exists) {
          throw new RewindError(
            "restore_failed",
            `检查点 git 对象已丢失（可能被 git gc 清理）：${s.repoPath} tree=${s.treeOid}`,
            500,
          );
        }
      }
      const eventsPreflight = await readEvents(taskId);
      if (!eventsPreflight.some((e) => e.id === eventId)) {
        throw new RewindError(
          "no_checkpoint",
          `events.jsonl 里没有 eventId=${eventId}`,
          404,
        );
      }

      // 1) rewind 前安全快照 —— 先落盘再破坏；任一仓失败则中止（尚未做破坏性操作）
      const repoSet = new Set<string>([
        ...lockedTarget.repoSnapshots.map((s) => s.repoPath),
        ...(lockedMeta.repoPaths ?? []),
      ]);
      const safetySnaps: RepoTreeSnapshot[] = [];
      for (const repoPath of repoSet) {
        const snap = await snapshotRepoTree(repoPath);
        if ("error" in snap) {
          throw new RewindError(
            "restore_failed",
            `无法为 ${repoPath} 创建安全快照、已中止回退（${snap.error}）`,
            500,
          );
        }
        safetySnaps.push({ repoPath, treeOid: snap.treeOid });
      }
      const safetyByRepo = new Map(
        safetySnaps.map((s) => [s.repoPath, s.treeOid]),
      );

      const safetyPoint: RewindPoint = {
        eventId: `pre_rewind_${Date.now()}`,
        createdAt: Date.now(),
        repoSnapshots: safetySnaps,
        kind: "pre_rewind",
      };

      // 先 append 写进 rewind_points（目标点列表暂不裁剪）；再 sync ref
      await writeRewindPoints(taskId, [...lockedPoints, safetyPoint]);
      await syncCheckpointRefs(taskId, safetyPoint);

      const rollbackReposToSafety = async (
        repoPaths: string[],
      ): Promise<RestoreReposDetail[]> => {
        const results: RestoreReposDetail[] = [];
        for (const repoPath of repoPaths) {
          const treeOid = safetyByRepo.get(repoPath);
          if (!treeOid) {
            results.push({
              repoPath,
              treeOid: "",
              ok: false,
              removedUntracked: [],
              error: "无安全快照可回滚",
            });
            continue;
          }
          results.push(await restoreRepoTree(repoPath, treeOid));
        }
        return results;
      };

      // 2) 按 target 逐仓恢复；任一失败 → 回滚当前失败仓 + 此前已成功的仓
      // （read-tree 成功但 git clean 失败时，当前仓可能已被部分修改）
      const restoredRepos: RestoreReposDetail[] = [];
      const succeededPaths: string[] = [];
      for (const s of lockedTarget.repoSnapshots) {
        const detail = await restoreRepoTree(s.repoPath, s.treeOid);
        restoredRepos.push(detail);
        if (!detail.ok) {
          const rollbackResults = await rollbackReposToSafety([
            ...succeededPaths,
            s.repoPath,
          ]);
          const restoreMsg = restoredRepos
            .filter((d) => !d.ok)
            .map((d) => `${d.repoPath}: ${d.error ?? "失败"}`)
            .join("; ");
          throw new RewindError(
            "restore_failed",
            `恢复文件失败：${restoreMsg}；${formatRollbackNote(rollbackResults, safetyByRepo)}`,
            500,
          );
        }
        succeededPaths.push(s.repoPath);
      }

      // 截断前备份 events 原文：后置写盘失败时原子写回（文件可能本就不存在）
      const eventsRawBackup = await readEventsRawText(taskId);

      // 3–5) 截断 / 裁剪 rewind_points / 写 meta；失败则回滚仓 + 尽量恢复 events / points
      // closeSession 挪到写盘成功之后（纯内存、不会失败；门闩已挡新消息，无并发风险）
      // 复审（11 轮）：truncate 成功 = 「仓库 + 对话」双双到位、rewind 实质已提交；
      // 此后的失败只能前滚（记账 best-effort），绝不能回滚仓库 / 写回 events——
      // 单侧补偿失败会留下契约禁止的半完成态（如仓库回退了、对话没恢复）。
      let truncateDone = false;
      let truncCount = 0;
      try {
        const trunc = await truncateEventsBeforeEventId(taskId, eventId);
        if (!trunc) {
          // preflight 已查过；此处再 miss 多半是锁外并发写（理论上持锁不应发生）
          throw new RewindError(
            "no_checkpoint",
            `events.jsonl 里没有 eventId=${eventId}`,
            404,
          );
        }
        truncateDone = true;
        truncCount = trunc.truncatedCount;

        // 成功路径：保留目标之前的点 + 刚才那条 pre_rewind（已 append 过，这里按内存列表一次重写，避免重复）
        const keptPoints = lockedPoints.slice(0, targetIdx);
        keptPoints.push(safetyPoint);
        const overflow = keptPoints.length - MAX_REWIND_POINTS;
        const frontDiscarded =
          overflow > 0 ? keptPoints.slice(0, overflow) : [];
        const finalPoints =
          overflow > 0 ? keptPoints.slice(overflow) : keptPoints;

        // 被丢掉的：原目标及之后 + 因 MAX 从头部裁掉的
        const discardedPoints: RewindPoint[] = [
          ...lockedPoints.slice(targetIdx),
          ...frontDiscarded,
        ];

        await writeRewindPoints(taskId, finalPoints);

        const freshMeta = await readMetaV06(taskId);
        if (!freshMeta) {
          throw new RewindError("not_found", "task 在 rewind 中被删", 404);
        }
        freshMeta.sessionAgentId = undefined;
        freshMeta.runStatus = "idle";
        freshMeta.updatedAt = Date.now();
        await writeMeta(freshMeta);

        // prune 必须在最后一个可失败的提交写之后（复审 N4）：
        // writeMeta 成功 = 事务提交点；此前失败 catch 会恢复 points，refs 尚未动过无需重建。
        // best-effort：refs 多留无害，下次裁剪还会再删。
        if (discardedPoints.length > 0) {
          try {
            await pruneCheckpointRefs(taskId, discardedPoints, finalPoints);
          } catch (pruneErr) {
            console.warn(
              `[chat-checkpoint] pruneCheckpointRefs 失败 task=${taskId}:`,
              pruneErr instanceof Error ? pruneErr.message : pruneErr,
            );
          }
        }

        // 写盘全部成功后再关会话：失败路径根本不用恢复 session。
        // 门闩（isChatRewindInProgress）已挡新消息，无并发启动会话风险。
        deps.closeSession(taskId);

        return {
          restoredRepos,
          truncatedEventCount: trunc.truncatedCount,
          checkpointAt: lockedTarget.createdAt,
        };
      } catch (err) {
        // 复审（11 轮）：truncate 已成功 → rewind 实质提交，只能前滚。
        // 失败的只是 rewind_points / meta 记账——best-effort 补写、关会话、按成功返回。
        // 绝不回滚仓库 / 写回 events（单侧补偿失败会制造「仓库回退了、对话没恢复」
        // 或反向的半完成态）；也绝不 5xx 诱导客户端重试破坏性 rewind。
        if (truncateDone) {
          console.error(
            `[chat-checkpoint] rewind task=${taskId} 已提交（truncate 完成）、后置记账失败（前滚收尾）:`,
            err instanceof Error ? err.message : err,
          );
          try {
            const keptPoints = lockedPoints.slice(0, targetIdx);
            keptPoints.push(safetyPoint);
            await writeRewindPoints(
              taskId,
              keptPoints.slice(Math.max(0, keptPoints.length - MAX_REWIND_POINTS)),
            );
          } catch (pointsErr) {
            console.warn(
              `[chat-checkpoint] rewind 前滚补写 rewind_points 失败 task=${taskId}:`,
              pointsErr instanceof Error ? pointsErr.message : pointsErr,
            );
          }
          try {
            const freshMeta = await readMetaV06(taskId);
            if (freshMeta) {
              freshMeta.sessionAgentId = undefined;
              freshMeta.runStatus = "idle";
              freshMeta.updatedAt = Date.now();
              await writeMeta(freshMeta);
            }
          } catch (metaErr) {
            console.warn(
              `[chat-checkpoint] rewind 前滚补写 meta 失败 task=${taskId}:`,
              metaErr instanceof Error ? metaErr.message : metaErr,
            );
          }
          deps.closeSession(taskId);
          return {
            restoredRepos,
            truncatedEventCount: truncCount,
            checkpointAt: lockedTarget.createdAt,
          };
        }

        const rollbackResults = await rollbackReposToSafety(
          lockedTarget.repoSnapshots.map((s) => s.repoPath),
        );
        const note = formatRollbackNote(rollbackResults, safetyByRepo);

        // best-effort：恢复 events 原文 + rewind_points 中间态（locked + safety）
        const restoreNotes: string[] = [];
        try {
          await atomicWriteTextFile(
            path.join(taskDir(taskId), EVENTS_FILE),
            eventsRawBackup,
          );
        } catch (restoreErr) {
          restoreNotes.push(
            `events 恢复失败：${restoreErr instanceof Error ? restoreErr.message : String(restoreErr)}`,
          );
        }
        try {
          // 安全点保留：它是真实存在的安全快照，留着无害且有用
          await writeRewindPoints(taskId, [...lockedPoints, safetyPoint]);
        } catch (restoreErr) {
          restoreNotes.push(
            `rewind_points 恢复失败：${restoreErr instanceof Error ? restoreErr.message : String(restoreErr)}`,
          );
        }
        const restoreSuffix =
          restoreNotes.length > 0 ? `；${restoreNotes.join("；")}` : "";

        if (err instanceof RewindError) {
          throw new RewindError(
            err.code,
            `${err.message}（${note}）${restoreSuffix}`,
            err.status,
          );
        }
        throw new RewindError(
          "restore_failed",
          `回退后处理失败：${err instanceof Error ? err.message : String(err)}（${note}）${restoreSuffix}`,
          500,
        );
      }
    });

    const okCount = core.restoredRepos.filter((d) => d.ok).length;
    const timeLabel = new Date(core.checkpointAt).toLocaleString("zh-CN", {
      hour12: false,
    });
    // info 缺失无伤：锁外写失败只 warn，不把整次 rewind 判失败
    try {
      await deps.appendInfoEvent(
        taskId,
        `已回退到 ${timeLabel} 的检查点（恢复 ${okCount} 个仓库文件状态）`,
      );
    } catch (err) {
      console.warn(
        `[chat-checkpoint] appendInfoEvent 失败 task=${taskId}:`,
        err instanceof Error ? err.message : err,
      );
    }

    let task: Task | null = null;
    try {
      task = await deps.getTask(taskId);
    } catch (err) {
      console.warn(
        `[chat-checkpoint] getTask 失败 task=${taskId}，将重试一次:`,
        err instanceof Error ? err.message : err,
      );
    }
    if (!task) {
      try {
        task = await deps.getTask(taskId);
      } catch (err) {
        console.warn(
          `[chat-checkpoint] getTask 重试仍失败 task=${taskId}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
    if (!task) {
      // 回退已提交，绝不能用错误状态诱导客户端重试破坏性请求
      console.warn(
        `[chat-checkpoint] getTask 重试仍失败 task=${taskId}：回退已完成，返回 refreshRequired`,
      );
      return {
        ok: true,
        task: null,
        refreshRequired: true,
        restoredRepos: core.restoredRepos,
        truncatedEventCount: core.truncatedEventCount,
      };
    }

    return {
      ok: true,
      task,
      restoredRepos: core.restoredRepos,
      truncatedEventCount: core.truncatedEventCount,
    };
  } finally {
    endChatRewind(taskId);
  }
};
