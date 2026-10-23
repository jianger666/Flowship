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
 * 发送/启动/drain 前同步检查 isChatRewindInProgress；本侧再查
 * isQueueDraining，两侧 check-and-set 交叉闭合竞态窗口。
 */

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { RewindFailureCode } from "@/lib/rewind-failure";
import type { Task, TaskEvent } from "@/lib/types";
import { renameWithRetry } from "./data-root";
import { isDirGoneError } from "./fs-gone";
import {
  endChatRewind,
  getChatLifecycle,
  hasChatStartReservation,
  tryBeginChatRewind,
} from "./chat-gate";
import { failQueuedItems, getChatQueueCount } from "./chat-queue";
import { failpoint } from "./failpoints";
import { stripHostInjectedEnv } from "./host-env";
import { buildTargetFoldSet, isTargetTreeAlias } from "./rewind-target-alias";
import {
  EVENTS_FILE,
  readEvents,
  readMetaV06,
  readMetaV06Evidence,
  taskDir,
  withEventAppendChain,
  withTaskLock,
  writeMeta,
} from "./task-fs-core";
import { isGitRepoPath } from "./task-worktrees";

const execFileAsync = promisify(execFile);

/** 近 N 条 rewind 点，超出删最老 */
export const MAX_REWIND_POINTS = 20;

/** git 命令超时（任务书：15s） */
const GIT_TIMEOUT_MS = 15_000;

/** 破坏性写工作区的 git 命令（`read-tree -u --reset`）超时：被杀掉会留下半恢复的工作区，所以比只读命令宽得多 */
export const RESET_GIT_TIMEOUT_MS = 120_000;

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
  /**
   * restore 时清掉的未跟踪文件（相对仓根；= 安全快照里有、目标 tree 里没有的，能从安全快照找回）。
   * 不在安全快照里的未跟踪文件（被 .gitignore 忽略的 .env.local / 本地库 / 日志等）绝不会出现在这里、也不会被删。
   */
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
  /**
   * 回退后服务端保留的事件条数（严格早于目标 user_reply 的那段；不含随后追加的回退 info）。
   * 客户端本地窗口里找不到被回退事件时，靠它对「完整窗口」做权威截断（见 rewind-marker.ts）。
   */
  keptEventCount: number;
  /** getTask 失败：回退已成功，客户端应刷新查看最新状态 */
  refreshRequired?: true;
}

export type RewindErrorCode =
  | "not_found"
  | "not_chat"
  | "no_checkpoint"
  | "run_active"
  | "bad_target"
  | "restore_failed";

export class RewindError extends Error {
  readonly code: RewindErrorCode;
  readonly status: number;
  /**
   * `run_active` 这一大类 409 的细分原因（V7-06）：停止/删除中、正在发排队、正在起会话、还有排队、
   * 已有回退在进行……它们的 `code` 都是 run_active（既有测试 / 调用方都按它判），
   * 但前端要对它们各说各的话——路由把 `reason ?? code` 当 409 响应的稳定 `code` 发出去，
   * 前端据此选提示、不再靠匹配中文报错文案。没有细分（agent 正在跑）时缺省。
   */
  readonly reason?: RewindFailureCode;

  constructor(
    code: RewindErrorCode,
    message: string,
    status: number,
    reason?: RewindFailureCode,
  ) {
    super(message);
    this.name = "RewindError";
    this.code = code;
    this.status = status;
    this.reason = reason;
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

/**
 * 容量上限 256MiB：`ls-tree -r --name-only -z` / `diff-tree` 的输出 = 全部路径总字节，8–12 万文件的 monorepo 轻松超 8MiB，
 * 撞线后整体中止回退、且旧写法 `e.stderr ?? e.message` 在 stderr 为空串时不回落 → 原因为空（第四轮 Q3-01）。
 */
export const CHECKPOINT_GIT_MAX_BUFFER = 256 * 1024 * 1024;

const runGit = async (
  repoPath: string,
  args: string[],
  opts: { env?: Record<string, string | undefined>; timeoutMs?: number } = {},
): Promise<GitResult> => {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd: repoPath,
      timeout: opts.timeoutMs ?? GIT_TIMEOUT_MS,
      maxBuffer: CHECKPOINT_GIT_MAX_BUFFER,
      // 剔宿主注入变量（ELECTRON_RUN_AS_NODE / PORT / __NEXT_PRIVATE_* …）：read-tree -u / checkout 会触发用户仓的
      // post-checkout / post-index-change 等钩子，钩子整份继承 server 环境会拿到这些变量（第四轮 Q3-14）
      env: { ...stripHostInjectedEnv(), ...(opts.env ?? {}) },
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
      // `||` 而非 `??`：maxBuffer 超限 / 被信号杀时 e.stderr 是空串，`??` 不回落 → 失败原因为空
      stderr: String(e.stderr || e.message || "").trim(),
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
  // 只传增量（runGit 自己会叠在「剔掉宿主注入变量」的 env 上；这里再展开 process.env 会把宿主变量带回去，Q3-14）
  const env = { GIT_INDEX_FILE: tmpIndex };

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

/** {@link restoreRepoTree} 的可选参数 */
export interface RestoreRepoTreeOptions {
  /**
   * 回退前对当前工作区取的安全快照 tree oid——决定「哪些未跟踪文件可以删」的唯一依据：
   * 只有安全快照里有、目标 tree 里没有的路径才会被删（删了还能从安全快照找回）。
   * 不传则本函数动手前自己对当前工作区取一份当基线（多一次快照的耗时，语义相同）。
   */
  safetyTreeOid?: string;
}

/**
 * 路径是否在仓内且形态正常：git 吐出来的相对路径理论上都规矩，这里仍挡一道，
 * 防止任何畸形路径（绝对路径 / `..` / 空段）让后续 `fs.unlink` 删到仓外。
 */
const toRepoAbsPath = (repoPath: string, rel: string): string | null => {
  if (!rel || rel.includes("\0") || path.isAbsolute(rel)) return null;
  const parts = rel.split("/");
  if (parts.some((p) => p === "" || p === "." || p === ".." || p === ".git")) {
    return null;
  }
  return path.join(repoPath, ...parts);
};

/**
 * 把工作区 + index 恢复到 treeOid，并清掉「回退区间内新建、又能从安全快照找回」的未跟踪文件。
 *
 * ⚠️ 为什么不能再 `git clean -fd`（2026-10-20 review #3）：
 * 回退会先把已跟踪的 `.gitignore` 还原成目标点的旧版——回退区间内新增的忽略规则随之消失，
 * 原先被它忽略的 `.env.local` / 本地库 / 日志一下子变成「未跟踪」，`clean -fd` 会把它们永久删掉；
 * 而它们在安全快照时被新规则忽略、**根本不在快照里**，删了就找不回。
 * 所以改成算差集：只删「安全快照有、目标 tree 无」的路径（`diff-tree --diff-filter=A target safety`）——
 * 这些文件都在 pre_rewind 安全点里，回滚 / 用户手工都能找回；不在安全快照里的未跟踪文件
 * （被忽略的、安全快照之后才冒出来的）一律不碰。
 * tracked 文件的增删改仍由 `read-tree -u --reset` 一次到位（index 里有的、目标没有的它会删）。
 */
export const restoreRepoTree = async (
  repoPath: string,
  treeOid: string,
  opts: RestoreRepoTreeOptions = {},
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

  // 「可删范围」的基线：必须在任何破坏性操作之前拿到，拿不到就中止（工作区原样不动）
  let safetyOid = opts.safetyTreeOid;
  if (safetyOid !== undefined && !isTreeOid(safetyOid)) {
    return { ...base, error: `非法安全快照 treeOid：${safetyOid}` };
  }
  if (safetyOid === undefined) {
    const snap = await snapshotRepoTree(repoPath);
    if ("error" in snap) {
      return {
        ...base,
        error: `无法确定可安全清理的文件范围（安全快照失败：${snap.error}），已中止、未改动工作区`,
      };
    }
    safetyOid = snap.treeOid;
  }

  // 先把「要删的未跟踪文件」算出来（只读）：算不出来同样在动手前中止，
  // 不能退化成「不知道删什么就全删」
  const added = await runGit(repoPath, [
    "diff-tree",
    "-r",
    "--no-renames",
    "--diff-filter=A",
    "--name-only",
    "-z",
    treeOid,
    safetyOid,
  ]);
  if (!added.ok) {
    return {
      ...base,
      error: `diff-tree 失败（无法确定可清理的文件）：${added.stderr || "git 未给出原因"}`,
    };
  }
  const safetyOnlyPaths = added.stdout.split("\0").filter(Boolean);

  // 目标树的全部路径（折叠后）：「绝不删与目标树仅大小写 / 规范化不同的路径」的依据（第三轮 review R1-01）。
  // 同样在动手前只读地取：取不到就中止，不退化成「不设防地删」。
  const targetPaths = await runGit(repoPath, [
    "ls-tree",
    "-r",
    "--name-only",
    "-z",
    treeOid,
  ]);
  if (!targetPaths.ok) {
    return {
      ...base,
      error: `ls-tree 失败（无法确定哪些路径属于目标版本）：${targetPaths.stderr || "git 未给出原因"}`,
    };
  }
  const targetFold = buildTargetFoldSet(targetPaths.stdout);

  // -u --reset：index + 工作区对齐到 tree（tracked 增删改一次到位）
  // 超时放宽到 120s（第五轮 P4）：这是**破坏性**命令——被 15s 超时杀掉会留下一半恢复的工作区，代价远高于多等一会儿。
  // 极端构造（空工作区一次性检出 3.4 万个独立目录）实测 10~11s，离 15s 只剩几秒余量；现实形状 < 1.5s。
  const reset = await runGit(
    repoPath,
    ["read-tree", "-u", "--reset", treeOid],
    { timeoutMs: RESET_GIT_TIMEOUT_MS },
  );
  if (!reset.ok) {
    return { ...base, error: `read-tree 失败：${reset.stderr}` };
  }

  // 此刻 index == 目标 tree：safetyOnlyPaths 里仍在盘上的 = 当时未跟踪（非 ignored）的文件，逐个删
  const removedUntracked: string[] = [];
  const touchedDirs = new Set<string>();
  let realRepo: string;
  try {
    realRepo = await fs.realpath(repoPath);
  } catch (err) {
    return {
      ...base,
      error: `解析仓库真实路径失败：${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // ⚠️ 大小写不敏感文件系统（macOS APFS 默认 / Windows NTFS）上，diff-tree 给的路径字面量不可信
  // （2026-10-20 第二轮 review F1-01）：目标点叫 `Components/`、区间内被改名 `components/` 并提交时，
  // safetyOnlyPaths 里有 `components/Button.tsx`；read-tree 把磁盘改回 `Components/Button.tsx` 后，
  // 这条路径在盘上仍指向刚恢复的目标文件，unlink 就等于把目标版本删了（还报 ok）。
  // 所以只删「回退后 git 自己认为真正未跟踪」的路径：与 `ls-files -o` 的实际结果取交集，
  // 别名路径（已被 index 按大小写不敏感匹配成 tracked）不会出现在里面。
  // 查不出来就整体跳过清理——宁可留下几个多余文件，也不冒删到目标文件的险。
  const untrackedNow = await runGit(repoPath, [
    "ls-files",
    "-o",
    "--exclude-standard",
    "-z",
  ]);
  let actuallyUntracked: Set<string> | null = null;
  if (untrackedNow.ok) {
    actuallyUntracked = new Set(untrackedNow.stdout.split("\0").filter(Boolean));
  } else {
    console.warn(
      `[chat-checkpoint] ls-files -o 失败，跳过未跟踪文件清理 repo=${repoPath}：${untrackedNow.stderr}`,
    );
  }

  for (const rel of safetyOnlyPaths) {
    if (!actuallyUntracked) break;
    if (!actuallyUntracked.has(rel)) continue;
    // 第二道防线（R1-01）：`ls-files -o` 的裁决依赖 core.ignorecase——false 的仓建在大小写不敏感的盘上时，
    // 别名路径照样被它列出。直接对目标树做折叠比较：与目标树任一路径仅大小写 / 规范化不同 → 绝不删。
    // 真大小写敏感的盘上最多多留一个同名异大小写的文件（在安全快照里、能找回），好过删错一个
    if (isTargetTreeAlias(rel, targetFold)) continue;
    const abs = toRepoAbsPath(repoPath, rel);
    if (!abs) {
      console.warn(`[chat-checkpoint] 跳过形态异常的路径 repo=${repoPath} path=${rel}`);
      continue;
    }
    try {
      const st = await fs.lstat(abs);
      // 目录（子模块 gitlink / 文件变目录）不动：只清文件与软链
      if (st.isDirectory()) continue;
      // 父目录若被换成指向仓外的软链，unlink 会删到仓外——realpath 校验后再动手
      const realDir = await fs.realpath(path.dirname(abs));
      if (realDir !== realRepo && !realDir.startsWith(realRepo + path.sep)) {
        console.warn(
          `[chat-checkpoint] 跳过父目录越出仓库的路径 repo=${repoPath} path=${rel}`,
        );
        continue;
      }
      await fs.unlink(abs);
      removedUntracked.push(rel);
      touchedDirs.add(path.dirname(abs));
    } catch (err) {
      // ENOTDIR：文件 ↔ 目录互换后父路径变成了文件（F1-02），该路径已不存在、等同 ENOENT
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") continue;
      return {
        ...base,
        removedUntracked,
        error: `清理未跟踪文件失败（${rel}）：${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // 删完后变空的目录一并收掉（对齐旧 clean -fd 「回到当时」的观感）；非空目录 rmdir 会失败即停，不会误删
  const repoRoot = path.resolve(repoPath);
  for (const dir of [...touchedDirs].sort((a, b) => b.length - a.length)) {
    let cur = path.resolve(dir);
    while (cur !== repoRoot && cur.startsWith(repoRoot + path.sep)) {
      try {
        await fs.rmdir(cur);
      } catch {
        break;
      }
      cur = path.dirname(cur);
    }
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

/**
 * 原子重写 rewind_points.jsonl。
 *
 * 只建 `checkpoints/` 这一层、**不 recursive**（第四轮 Q3-08，同 tool-result-persist 的 D4b-02）：任务目录不存在 = 任务已被删，
 * 迟到的写入（DELETE 200 之后 chat-runner / 回退收尾还在落盘）若 `mkdir -p` 会把已删任务的目录复活成一个只有
 * `checkpoints/rewind_points.jsonl` 的空壳，再次 DELETE 还会落成 202 recoveryPending。任务目录缺失 → 降级为不写（已删任务不需要）。
 */
export const writeRewindPoints = async (
  taskId: string,
  points: RewindPoint[],
): Promise<void> => {
  const dir = getCheckpointsDir(taskId);
  try {
    await fs.mkdir(dir);
  } catch (err) {
    // taskDir 已不在：任务被删，不复活（第五轮 Q3-08：macOS 并发删除时可能是 EINVAL 而不只是 ENOENT，见 fs-gone.ts）
    if (await isDirGoneError(err, path.dirname(dir))) return;
    if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") throw err;
  }
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
    // mkdir 之后目录又被并发删掉：writeFile / rename 不会建父目录，目录不在了 = 任务刚被删，同样降级
    // （第五轮 Q3-08：macOS 上并发删除时 rename 抛的是 EINVAL、不是 ENOENT——只认 ENOENT 会让上面的「不抛」约定在 macOS 上失效）
    if (await isDirGoneError(err, dir)) return;
    throw err;
  }
};

/** 单仓 checkpoint ref 清单（deletion journal / tombstone 共用） */
export interface CheckpointRefManifestEntry {
  repoPath: string;
  refs: string[];
}

/**
 * 可恢复删除事务的 refs 清单。
 * 写 tombstone / journal 时从 rewind_points 提取；rm taskDir 后仍可凭 journal 重试。
 *
 * phase：
 * - prepared：manifest 已落盘、逻辑删除尚未提交（boot 必须丢弃、不得 rm）
 * - committed：tombstone rename 成功或快速路径进入不可逆 refs/rm 前已原子推进
 *
 * refsPending：update-ref / for-each-ref 未确认成功的子集；有则 boot 只重试这些、成功前不删 journal。
 *
 * manifestPending：清单本身未能确认（rewind 读失败且仓扫也失败）——
 * 不得当「零 ref」完成删除；boot 凭 repoPaths 重试构建。
 *
 * manifestPending 携带 unknown 语义——无完整 repoPaths 时不得 rm 最后恢复源；
 * 空 repoPaths + 恢复源已消失绝不能解释成合法零清单。真正零仓须显式 confirmedEmpty。
 *
 * 最终口径：journal 是删除事务唯一真相；tombstone 是物理/Windows EBUSY 辅助。
 * 实现上「journal.committed 或 tombstone 任一证据在 → 只前滚、绝不回滚」。
 */
export interface CheckpointRefManifest {
  deletedAt: number;
  checkpointRefs: CheckpointRefManifestEntry[];
  /** 删除事务阶段 */
  phase?: "prepared" | "committed";
  /** 尚未确认清掉的 refs（子集）；缺省表示按 checkpointRefs 全量清 */
  refsPending?: CheckpointRefManifestEntry[];
  /** 清单未确认，禁止当零 ref 收尾 */
  manifestPending?: boolean;
  /** manifestPending 时快照的仓路径，供 taskDir 已 rm 后 boot 重扫 */
  repoPaths?: string[];
  /**
   * 构建成功路径写入——确认本 task 确实零仓/零 ref。
   * 缺省 + 空 repoPaths ≠ 合法空；只有本标志才允许前滚完成空清单。
   */
  confirmedEmpty?: boolean;
}

/** 按清单清 refs 的逐仓/逐 ref 结果 */
export interface CheckpointRefCleanupResult {
  /** 未确认成功、须写回 journal 的失败项 */
  pending: CheckpointRefManifestEntry[];
  allSucceeded: boolean;
}

/** manifest 构建显式 Result——读失败不得降级为空成功 */
export type BuildCheckpointRefManifestResult =
  | { ok: true; manifest: CheckpointRefManifest }
  | { ok: false; error: string };

/**
 * 按给定仓路径 for-each-ref 扫 task 前缀。
 * 任一仓扫失败 → ok:false（无法确认空清单）；全成功才允许空清单。
 */
export const scanCheckpointRefsFromRepoPaths = async (
  taskId: string,
  repoPaths: string[],
): Promise<BuildCheckpointRefManifestResult> => {
  const deletedAt = Date.now();
  const paths = [...new Set(repoPaths.filter((p) => typeof p === "string" && p))];
  if (paths.length === 0) {
    return { ok: false, error: "no repoPaths to scan" };
  }
  const refPrefix = `${CHECKPOINT_REF_PREFIX}/${taskId}/`;
  const checkpointRefs: CheckpointRefManifestEntry[] = [];
  for (const repoPath of paths) {
    const listed = await runGit(repoPath, [
      "for-each-ref",
      "--format=%(refname)",
      refPrefix,
    ]);
    if (!listed.ok) {
      console.warn(
        `[chat-checkpoint] scanManifest for-each-ref 失败 task=${taskId} repo=${repoPath}: ${listed.stderr}`,
      );
      return {
        ok: false,
        error: `for-each-ref failed: ${repoPath}: ${listed.stderr || listed.ok}`,
      };
    }
    const refs: string[] = [];
    for (const line of listed.stdout.split("\n")) {
      const name = line.trim();
      if (name) refs.push(name);
    }
    checkpointRefs.push({ repoPath, refs });
  }
  return {
    ok: true,
    manifest: { deletedAt, checkpointRefs, repoPaths: paths },
  };
};

/**
 * 从 rewind_points + for-each-ref 提取本 task 的 checkpoint refs 清单。
 * rewind 读失败 → ok:false（绝不降级空清单）。
 * meta 三态——只有 valid meta 显式 repoPaths=[] 且 rewind 成功且相关扫描成功
 * 才 confirmedEmpty；meta unknown/损坏 → ok:false（manifestPending），「目录存在」不再当零仓证据。
 */
export const buildCheckpointRefManifest = async (
  taskId: string,
): Promise<BuildCheckpointRefManifestResult> => {
  const deletedAt = Date.now();
  let points: RewindPoint[];
  try {
    points = await readRewindPoints(taskId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[chat-checkpoint] buildManifest 读 rewind_points 失败 task=${taskId}:`,
      msg,
    );
    return { ok: false, error: `readRewindPoints: ${msg}` };
  }
  const repoPaths = new Set<string>();
  // JSONL 里记下的 treeOid → 期望 ref 名（for-each-ref 失败时仍有显式清单）
  const expectedByRepo = new Map<string, Set<string>>();
  for (const p of points) {
    for (const s of p.repoSnapshots) {
      if (!s.repoPath) continue;
      repoPaths.add(s.repoPath);
      if (!s.treeOid) continue;
      let set = expectedByRepo.get(s.repoPath);
      if (!set) {
        set = new Set();
        expectedByRepo.set(s.repoPath, set);
      }
      set.add(checkpointRefName(taskId, s.treeOid));
    }
  }
  // meta 三态合并 repoPaths——unknown 不得折叠成「无仓」
  const metaRead = await readMetaV06Evidence(taskId);
  if (metaRead.kind === "valid") {
    for (const p of metaRead.value.repoPaths ?? []) {
      if (p) repoPaths.add(p);
    }
  } else if (metaRead.kind === "unknown") {
    console.warn(
      `[chat-checkpoint] buildManifest meta 未知 task=${taskId}`,
      metaRead.error,
    );
  }

  // 零仓仅当 valid meta 显式 [] + rewind 已成功构建（走到这里）
  if (repoPaths.size === 0) {
    if (metaRead.kind === "unknown") {
      return {
        ok: false,
        error:
          "meta unknown with empty rewind repos — cannot confirm empty manifest",
      };
    }
    if (metaRead.kind !== "valid") {
      // meta absent：没有「显式 repoPaths=[]」证据，不得 confirmedEmpty（目录存在也不算）
      return {
        ok: false,
        error:
          "meta absent with empty rewind repos — cannot confirm empty manifest",
      };
    }
    // valid meta + 显式空仓（repoPaths 合并后仍空）+ rewind 成功 → 合法零清单
    return {
      ok: true,
      manifest: {
        deletedAt,
        checkpointRefs: [],
        repoPaths: [],
        confirmedEmpty: true,
      },
    };
  }

  const refPrefix = `${CHECKPOINT_REF_PREFIX}/${taskId}/`;
  const checkpointRefs: CheckpointRefManifestEntry[] = [];
  let anyScanFailed = false;
  for (const repoPath of repoPaths) {
    const refs = new Set<string>(expectedByRepo.get(repoPath) ?? []);
    const listed = await runGit(repoPath, [
      "for-each-ref",
      "--format=%(refname)",
      refPrefix,
    ]);
    if (listed.ok) {
      for (const line of listed.stdout.split("\n")) {
        const name = line.trim();
        if (name) refs.add(name);
      }
    } else {
      anyScanFailed = true;
      console.warn(
        `[chat-checkpoint] buildManifest for-each-ref 失败 task=${taskId} repo=${repoPath}: ${listed.stderr}`,
      );
    }
    checkpointRefs.push({ repoPath, refs: [...refs] });
  }
  const totalRefs = checkpointRefs.reduce((n, e) => n + e.refs.length, 0);
  // 扫失败且无任何已知 ref → 不能宣称「零 ref」
  if (totalRefs === 0 && anyScanFailed) {
    return {
      ok: false,
      error: "for-each-ref failed and no expected refs from rewind_points",
    };
  }
  // meta unknown 但 rewind 带了仓路径——可扫则返回清单，绝不标 confirmedEmpty
  return {
    ok: true,
    manifest: {
      deletedAt,
      checkpointRefs,
      repoPaths: [...repoPaths],
    },
  };
};

/**
 * 删除路径统一解析 manifest。
 * - 若调用方已给 fallbackRepoPaths（journal 快照）→ **优先扫仓**（taskDir / rewind 可能已 rm，
 *   build 会误得「合法空清单」导致 ref 泄漏）。
 * - 否则先 rewind 构建，失败再按 meta.repoPaths 扫前缀。
 * - fallback 为空且 taskDir/meta/rewind 恢复源已不存在 → ok:false（unknown），
 *   绝不返回 ok-empty。
 */
export const resolveCheckpointRefManifestForDelete = async (
  taskId: string,
  fallbackRepoPaths?: string[],
): Promise<BuildCheckpointRefManifestResult> => {
  const fallback = (fallbackRepoPaths ?? []).filter(
    (p): p is string => typeof p === "string" && p.length > 0,
  );
  // journal 带来的仓路径：taskDir 已删时唯一可信来源，禁止先走 build 吃到空成功
  if (fallback.length > 0) {
    const scanned = await scanCheckpointRefsFromRepoPaths(taskId, fallback);
    if (scanned.ok) return scanned;
    console.warn(
      `[chat-checkpoint] resolveManifest：journal.repoPaths 扫失败 task=${taskId}: ${scanned.error}`,
    );
    return scanned;
  }

  const primary = await buildCheckpointRefManifest(taskId);
  if (primary.ok) return primary;
  // meta 三态——unknown 不得当「无仓」去碰 taskDir 假成功
  const metaRead = await readMetaV06Evidence(taskId);
  if (metaRead.kind === "unknown") {
    console.error(
      `[chat-checkpoint] resolveManifest：meta 未知、keep pending task=${taskId}`,
      metaRead.error,
    );
    return {
      ok: false,
      error: `meta unknown — ${String(metaRead.error)}`,
    };
  }
  const repos =
    metaRead.kind === "valid"
      ? (metaRead.value.repoPaths ?? []).filter(
          (p): p is string => typeof p === "string" && p.length > 0,
        )
      : [];
  if (repos.length === 0) {
    // 无 fallback、无可信 meta 仓路径 → unknown（非空成功）
    console.error(
      `[chat-checkpoint] resolveManifest：manifestPending unknown（无可信 repoPaths）task=${taskId}`,
    );
    return {
      ok: false,
      error: primary.error,
    };
  }
  console.warn(
    `[chat-checkpoint] resolveManifest：rewind 失败、改扫 meta.repoPaths task=${taskId} repos=${repos.length}`,
  );
  return scanCheckpointRefsFromRepoPaths(taskId, repos);
};

/**
 * 按清单删 checkpoint refs（幂等）。
 * 先删清单内 refs，再 for-each-ref 扫前缀兜底（防清单不全）。
 * 返回逐仓失败项——调用方必须写回 journal.refsPending，不能假成功删 journal。
 * 测试挂点：首个成功 delete 后可注入崩溃。
 */
export const cleanupCheckpointRefsFromManifest = async (
  taskId: string,
  manifest: CheckpointRefManifest,
): Promise<CheckpointRefCleanupResult> => {
  const refPrefix = `${CHECKPOINT_REF_PREFIX}/${taskId}/`;
  let deletedOnce = false;
  // 优先只清 refsPending（boot 重试）；否则清全量 checkpointRefs
  const entries =
    manifest.refsPending && manifest.refsPending.length > 0
      ? manifest.refsPending
      : manifest.checkpointRefs;
  const pending: CheckpointRefManifestEntry[] = [];
  for (const entry of entries) {
    const { repoPath } = entry;
    const toDelete = new Set(entry.refs.filter(Boolean));
    let forEachOk = true;
    // 再扫一遍前缀——崩溃重试 / 清单落后时补漏
    const listed = await runGit(repoPath, [
      "for-each-ref",
      "--format=%(refname)",
      refPrefix,
    ]);
    if (listed.ok) {
      for (const line of listed.stdout.split("\n")) {
        const name = line.trim();
        if (name) toDelete.add(name);
      }
    } else {
      forEachOk = false;
      console.warn(
        `[chat-checkpoint] cleanupCheckpointRefs for-each-ref 失败 task=${taskId} repo=${repoPath}: ${listed.stderr}`,
      );
    }
    const failedRefs: string[] = [];
    for (const name of toDelete) {
      const del = await runGit(repoPath, ["update-ref", "-d", name]);
      if (!del.ok) {
        console.warn(
          `[chat-checkpoint] cleanupCheckpointRefs 删 ref 失败 task=${taskId} repo=${repoPath} ref=${name}: ${del.stderr}`,
        );
        failedRefs.push(name);
        continue;
      }
      // 测试：首个成功删后可挂起，模拟「清到一半崩溃」
      if (!deletedOnce) {
        deletedOnce = true;
        await failpoint("checkpointRefs.afterFirstDelete");
      }
    }
    // for-each-ref 失败时无法确认前缀扫干净——整仓 refs 留 pending 给 boot 重试
    if (!forEachOk || failedRefs.length > 0) {
      pending.push({
        repoPath,
        refs: !forEachOk ? [...toDelete] : failedRefs,
      });
    }
  }
  return { pending, allSucceeded: pending.length === 0 };
};

/**
 * 删除任务前清理各仓里该 task 的 checkpoint refs。
 * 不清理会让被删任务的历史 tree/blob 永久保留在用户仓里（refs 保活对象）。
 * 须在 deleteTask 之前调用（还要能读到 rewind_points），或传入已落盘的 journal 清单。
 * 返回逐项结果，不再吞成 void 成功。
 * 无传入 manifest 时走 resolve；构建失败 → allSucceeded:false（禁止当零 ref）。
 */
export const cleanupCheckpointRefsForTask = async (
  taskId: string,
  manifest?: CheckpointRefManifest,
): Promise<CheckpointRefCleanupResult> => {
  let m = manifest;
  if (!m) {
    const resolved = await resolveCheckpointRefManifestForDelete(taskId);
    if (!resolved.ok) {
      return { pending: [], allSucceeded: false };
    }
    m = resolved.manifest;
  }
  if (m.manifestPending) {
    return { pending: [], allSucceeded: false };
  }
  if (m.checkpointRefs.length === 0 && !m.refsPending?.length) {
    return { pending: [], allSucceeded: true };
  }
  return cleanupCheckpointRefsFromManifest(taskId, m);
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

  // 多仓并行：每个仓一份独立的临时 index、互不碰真实 index / 工作区，没有串行的理由；
  // 串行时绑 N 个仓的 chat 每次发送都要多等 (N-1)×~0.4s（这段在 agent.send 之前、用户干等）。
  // 汇总严格按入参顺序（不是完成先后）——repoSnapshots 的顺序会落进 rewind 点、
  // 与 task.repoPaths 的「第一项是 cwd」语义对齐
  const results = await Promise.all(
    paths.map(async (repoPath) => {
      const t0 = Date.now();
      const snap = await snapshotRepoTree(repoPath);
      return { repoPath, snap, ms: Date.now() - t0 };
    }),
  );
  for (const { repoPath, snap, ms } of results) {
    elapsedMsByRepo[repoPath] = ms;
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

/**
 * 原子重写 events：保留严格早于 eventId 的行（不含目标及之后）。
 *
 * **整段「读全量 → slice → tmp + rename」排进 events 的追加链**（评审 BE5）：追加走 `appendEventLine` 的
 * per-task 链、不拿 `withTaskLock`，回退持的锁挡不住它——旁路群答疑 run 等写者在读和 rename 之间 `appendFile`
 * 到旧文件，那一行会被 rename 吃掉（客户端已收到 publish、磁盘没有、seq 出现空洞）。进链后：链里已排的写者先落完，
 * 这里读到的是一致快照；之后排队的写者落在截断后的文件上（= 落在截断点之后）。
 * 调用方已持 `withTaskLock`，链内写者都不取锁，先持锁再进链不会互等（见 `withEventAppendChain`）。
 */
export const truncateEventsBeforeEventId = async (
  taskId: string,
  eventId: string,
): Promise<{ kept: TaskEvent[]; truncatedCount: number } | null> =>
  withEventAppendChain(taskId, async () => {
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
  });

/**
 * 后置失败时把 events 恢复成截断前的原文（best-effort 的补偿）。同样排进追加链，并且**只在文件
 * 真被改写过时才写回**：
 * - 备份之后文件只被追加（现状就是这种：走到这条补偿路径时截断没有成功、文件没动，期间只可能有旁路
 *   run 追加）→ 当前内容以备份为前缀，什么都不用做——原样写回备份反而会把这期间追加的行抹掉；
 * - 当前内容不以备份为前缀（文件被改写过，截断落了盘却走到这里，按设计不该发生）→ 写回备份，保持旧行为。
 */
export const restoreEventsRawText = (
  taskId: string,
  backup: string,
): Promise<void> =>
  withEventAppendChain(taskId, async () => {
    const current = await readEventsRawText(taskId);
    if (current.startsWith(backup)) return;
    await atomicWriteTextFile(path.join(taskDir(taskId), EVENTS_FILE), backup);
  });

// ----------------- rewind 主流程 -----------------

export interface RewindDeps {
  /** 无条件关 chat 会话（清 sessionAgentId） */
  closeSession: (taskId: string) => void;
  /** 当前是否有 chat run 在跑 */
  isRunActive: (taskId: string) => boolean;
  /**
   * queue drain（flushChatQueue）是否进行中。与 flushChatQueue 入口的
   * rewind 门闩检查交叉闭合（另一侧在 chat-runner 做）。
   */
  isQueueDraining: (taskId: string) => boolean;
  /**
   * 写 info 事件。info.keptEventCount = 回退后服务端保留的事件条数
   * （调用方据此给事件打回退标记，见 rewind-marker.ts）
   */
  appendInfoEvent: (
    taskId: string,
    text: string,
    info: { keptEventCount: number },
  ) => Promise<TaskEvent | null>;
  /** 读完整 Task（截断后） */
  getTask: (taskId: string) => Promise<Task | null>;
}

/**
 * rewind / 编辑回退共用的「进锁前」检查：lifecycle（停止 / 删除中）、task 存在且是 chat、没有 run 在跑。
 * 抛错一律是 RewindError；调用方已占着 rewind 门闩、在 finally 里释放。
 */
const assertRewindPreflight = async (
  taskId: string,
  deps: RewindDeps,
): Promise<void> => {
  const lifecycle = getChatLifecycle(taskId);
  if (lifecycle === "stopping" || lifecycle === "deleting") {
    throw new RewindError(
      "run_active",
      "任务正在停止/删除、无法回退",
      409,
      "task_closing",
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
    throw new RewindError("run_active", "agent 正在跑、请先停止再回退", 409);
  }
};

/**
 * rewind / 编辑回退共用的「锁内复查」（闭合 TOCTOU）：进锁前到破坏性操作之间，
 * chat-reply / drain 可能已启动。通过后清掉排队，返回锁内读到的最新 meta。
 * 对侧在发送 / 启动 / drain 前同步检查 isChatRewindInProgress；两侧配合闭合窗口。
 */
const assertRewindIdleLocked = async (
  taskId: string,
  deps: RewindDeps,
): Promise<NonNullable<Awaited<ReturnType<typeof readMetaV06>>>> => {
  const lockedMeta = await readMetaV06(taskId);
  if (!lockedMeta) {
    throw new RewindError("not_found", "task 在 rewind 中被删", 404);
  }
  if (deps.isRunActive(taskId)) {
    throw new RewindError("run_active", "agent 正在跑、请先停止再回退", 409);
  }
  if (lockedMeta.runStatus === "running") {
    throw new RewindError(
      "run_active",
      "任务 runStatus 为 running、请先停止再回退",
      409,
    );
  }
  if (deps.isQueueDraining(taskId)) {
    // 与 flushChatQueue 入口的 rewind 门闩检查交叉闭合（另一侧在 chat-runner）
    throw new RewindError(
      "run_active",
      "正在发送排队消息、请稍后回退",
      409,
      "queue_draining",
    );
  }
  if (hasChatStartReservation(taskId)) {
    throw new RewindError(
      "run_active",
      "正在启动新会话、请稍后回退",
      409,
      "session_starting",
    );
  }
  if (getChatQueueCount(taskId) > 0) {
    throw new RewindError(
      "run_active",
      "仍有排队中的消息、请先停止或等待发送完成再回退",
      409,
      "queue_pending",
    );
  }
  // 复查通过：清掉排队（防竞态下刚入队的旧上下文消息在回退后幽灵发送）
  // 走唯一终态 sink——复查后到清队之间若有消息挤入（202 已返回）、
  // 它必须收到 queue_failed 终态、不能被裸 clear 静默丢
  failQueuedItems(taskId, { reason: "rewound" });
  return lockedMeta;
};

/**
 * 回退已提交之后的收尾（rewind / 编辑回退共用）：写回退标记 info（失败只 warn）→ 读最新 Task
 * （失败重试一次；仍失败返回 refreshRequired，**绝不**报错——回退已提交，错误状态会诱导客户端重试破坏性请求）。
 */
const finishRewind = async (
  taskId: string,
  deps: RewindDeps,
  core: {
    restoredRepos: RestoreReposDetail[];
    truncatedEventCount: number;
    keptEventCount: number;
  },
  infoText: string,
): Promise<RewindResult> => {
  // info 缺失无伤：锁外写失败只 warn，不把整次 rewind 判失败
  try {
    await deps.appendInfoEvent(taskId, infoText, {
      keptEventCount: core.keptEventCount,
    });
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
      keptEventCount: core.keptEventCount,
    };
  }

  return {
    ok: true,
    task,
    restoredRepos: core.restoredRepos,
    truncatedEventCount: core.truncatedEventCount,
    keptEventCount: core.keptEventCount,
  };
};

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
 * pruneCheckpointRefs 必须在 writeMeta 等最后一个可失败的提交写之后（）：
 * 否则 writeMeta 失败时 catch 能恢复 JSONL 引用，但 refs 已被删，随后 git gc 会清掉对象。
 */
export const executeChatRewind = async (
  taskId: string,
  eventId: string,
  deps: RewindDeps,
): Promise<RewindResult> => {
  // 进程内门闩：先占位，阻止 chat-reply 在检查完 isRunActive 后仍启动 run
  if (!tryBeginChatRewind(taskId)) {
    throw new RewindError(
      "run_active",
      "已有回退在进行中",
      409,
      "rewind_in_progress",
    );
  }

  try {
    // 占位后立刻查 stop/DELETE lifecycle——闭合「rewind 刚起步、DELETE 已在收尾」
    // 反向竞态；抛错走 finally endChatRewind，勿与删除交叉改仓
    await assertRewindPreflight(taskId, deps);

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

      // —— 锁内复查（闭合 TOCTOU）：进锁前到破坏性操作之间，chat-reply / drain 可能已启动 ——
      // 对侧会在发送/启动/drain 前同步检查 isChatRewindInProgress；两侧配合闭合窗口。
      const lockedMeta = await assertRewindIdleLocked(taskId, deps);

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
          // 目标 = 安全快照本身：差集为空、不会删任何未跟踪文件；
          // 前面已清掉的（安全快照里有的）文件会被 read-tree 写回来
          results.push(
            await restoreRepoTree(repoPath, treeOid, { safetyTreeOid: treeOid }),
          );
        }
        return results;
      };

      // 2) 按 target 逐仓恢复；任一失败 → 回滚当前失败仓 + 此前已成功的仓
      // （read-tree 成功但清理未跟踪文件失败时，当前仓可能已被部分修改）
      // 传入刚落盘的安全快照：只有它里面有的未跟踪文件才允许被清（见 restoreRepoTree）
      const restoredRepos: RestoreReposDetail[] = [];
      const succeededPaths: string[] = [];
      for (const s of lockedTarget.repoSnapshots) {
        const detail = await restoreRepoTree(s.repoPath, s.treeOid, {
          safetyTreeOid: safetyByRepo.get(s.repoPath),
        });
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
      // truncate 成功 = 「仓库 + 对话」双双到位、rewind 实质已提交；
      // 此后的失败只能前滚（记账 best-effort），绝不能回滚仓库 / 写回 events——
      // 单侧补偿失败会留下契约禁止的半完成态（如仓库回退了、对话没恢复）。
      let truncateDone = false;
      let truncCount = 0;
      let keptCount = 0;
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
        keptCount = trunc.kept.length;

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

        // prune 必须在最后一个可失败的提交写之后（）：
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
          keptEventCount: trunc.kept.length,
          checkpointAt: lockedTarget.createdAt,
        };
      } catch (err) {
        // truncate 已成功 → rewind 实质提交，只能前滚。
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
            keptEventCount: keptCount,
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
          await restoreEventsRawText(taskId, eventsRawBackup);
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
            // 细分 409 的 reason 不能在这层重包时丢掉（前端按它选提示）
            err.reason,
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
    return await finishRewind(
      taskId,
      deps,
      core,
      `已回退到 ${timeLabel} 的检查点（恢复 ${okCount} 个仓库文件状态）`,
    );
  } finally {
    endChatRewind(taskId);
  }
};

// ----------------- 编辑回退（只回退对话；可选择是否同时还原文件）-----------------

/** 编辑回退（只回退对话）写进事件流的标记文案 */
export const EDIT_REWIND_CONVERSATION_ONLY_INFO =
  "已回退到这条消息之前的对话（文件未改动）";

/**
 * 只回退对话、不碰文件：删掉目标 user_reply 及之后的事件、关会话（下一条消息会用截断后的历史
 * 开新会话）。给「编辑已发送的消息」用——这条消息没有文件检查点（没绑仓 / 检查点已被裁掉 / 打点失败）
 * 时也能编辑。
 *
 * 与 {@link executeChatRewind} 共用门闩 / 进锁前检查 / 锁内复查 / 收尾，区别只在没有文件操作：
 * 没有安全快照、没有恢复、也就没有「回滚仓库」这一段——截断之前没有任何改动（原子写、失败即原样），
 * 截断之后的记账（rewind_points / meta / refs）全部前滚、绝不让已提交的回退报错。
 *
 * rewind_points：丢掉锚在被截断事件上的点（它们对应的 user_reply 没了、回退不到），其余保留；
 * 不另打 pre_rewind 安全点（没动文件）。
 */
export const executeChatConversationRewind = async (
  taskId: string,
  eventId: string,
  deps: RewindDeps,
): Promise<RewindResult> => {
  if (!tryBeginChatRewind(taskId)) {
    throw new RewindError(
      "run_active",
      "已有回退在进行中",
      409,
      "rewind_in_progress",
    );
  }

  try {
    await assertRewindPreflight(taskId, deps);

    const core = await withTaskLock(taskId, async () => {
      await assertRewindIdleLocked(taskId, deps);

      const events = await readEvents(taskId);
      const idx = events.findIndex((e) => e.id === eventId);
      if (idx < 0) {
        throw new RewindError("not_found", "找不到这条消息", 404);
      }
      if (events[idx]!.kind !== "user_reply") {
        throw new RewindError("bad_target", "只能从用户消息处回退", 400);
      }
      const truncatedIds = new Set(events.slice(idx).map((e) => e.id));
      const lockedPoints = await readRewindPoints(taskId);

      const trunc = await truncateEventsBeforeEventId(taskId, eventId);
      if (!trunc) {
        // 刚才读到了、现在没了：持锁不该发生（锁外并发写）；此时什么都没改
        throw new RewindError("not_found", "找不到这条消息", 404);
      }

      // —— 截断已提交，以下全部前滚（best-effort）——
      const keptPoints = lockedPoints.filter((p) => !truncatedIds.has(p.eventId));
      const discardedPoints = lockedPoints.filter((p) =>
        truncatedIds.has(p.eventId),
      );
      if (discardedPoints.length > 0) {
        try {
          await writeRewindPoints(taskId, keptPoints);
        } catch (err) {
          console.warn(
            `[chat-checkpoint] 编辑回退 task=${taskId} 写 rewind_points 失败（对话已截断、前滚）:`,
            err instanceof Error ? err.message : err,
          );
        }
      }
      try {
        const freshMeta = await readMetaV06(taskId);
        if (freshMeta) {
          freshMeta.sessionAgentId = undefined;
          freshMeta.runStatus = "idle";
          freshMeta.updatedAt = Date.now();
          await writeMeta(freshMeta);
        }
      } catch (err) {
        console.warn(
          `[chat-checkpoint] 编辑回退 task=${taskId} 写 meta 失败（对话已截断、前滚）:`,
          err instanceof Error ? err.message : err,
        );
      }
      if (discardedPoints.length > 0) {
        try {
          await pruneCheckpointRefs(taskId, discardedPoints, keptPoints);
        } catch (err) {
          console.warn(
            `[chat-checkpoint] 编辑回退 task=${taskId} pruneCheckpointRefs 失败:`,
            err instanceof Error ? err.message : err,
          );
        }
      }

      // 门闩已挡新消息；关会话 = 清 sessionAgentId 对应的内存会话，下一条消息开新会话
      deps.closeSession(taskId);

      return {
        restoredRepos: [] as RestoreReposDetail[],
        truncatedEventCount: trunc.truncatedCount,
        keptEventCount: trunc.kept.length,
      };
    });

    return await finishRewind(
      taskId,
      deps,
      core,
      EDIT_REWIND_CONVERSATION_ONLY_INFO,
    );
  } finally {
    endChatRewind(taskId);
  }
};

/**
 * 「编辑已发送的消息」的回退入口：这条消息还有文件检查点 → 完整回退（还原文件 + 截断对话，
 * 同 {@link executeChatRewind}）；没有 → 只回退对话（{@link executeChatConversationRewind}）。
 * 调用方（界面）要对「会还原文件」先做确认；检查点已被裁掉时这里自动降级成只回退对话，
 * 方向是安全的（文件只会少改、不会多改）。
 */
export const executeChatEditRewind = async (
  taskId: string,
  eventId: string,
  deps: RewindDeps,
): Promise<RewindResult> => {
  const points = await readRewindPoints(taskId);
  const hasCheckpoint = points.some(
    (p) =>
      p.eventId === eventId &&
      p.kind !== "pre_rewind" &&
      p.repoSnapshots.length > 0,
  );
  return hasCheckpoint
    ? executeChatRewind(taskId, eventId, deps)
    : executeChatConversationRewind(taskId, eventId, deps);
};
