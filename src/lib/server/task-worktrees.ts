/**
 * 任务隔离工作区（git worktree）管理（V0.10）
 *
 * 动机：多 task 并行改同一个仓库时、共享同一个工作区会互相踩（A task 切走分支、
 * B task 的半成品全乱）。V0.10 起新建 task 默认给每个仓建一个专属 worktree：
 *
 *   <dataRoot>/worktrees/<taskId>/<仓短名>/
 *
 * - worktree 跟原仓库共享同一 git 对象库（占用小、commit/push 全通用）、
 *   但各自有独立的 HEAD / index / 工作区文件——并行任务物理隔离
 * - 分支检出由 runner 确定性完成（本模块 ensureTaskWorktrees）、不再靠 prompt
 *   引导 agent 自己 checkout（软约束 → 硬保证、符合 harness 哲学）
 * - 逃生口：task.isolateWorktree === false 时全部函数退化为原仓库路径直跑（V0.9 行为）
 *
 * 依赖方向：本模块只依赖 types / data-root / path-utils / branch-template、
 * 不 import task-fs / task-runner（task-fs 反过来 import 本模块、保证无环）。
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";

import { dataRoot } from "./data-root";
import { failpoint } from "./failpoints";
import {
  beginResourceJob,
  endResourceJob,
  isWorkspaceQuarantined,
  registerJobAbort,
  type ResourceJobHandle,
} from "./resource-jobs";
import { getEffectiveCwd, getUniqueRepoDirNames } from "@/lib/path-utils";
import {
  DEFAULT_BRANCH_TEMPLATE,
  extractFeishuStoryId,
  isSafeBranchName,
  renderBranchName,
} from "@/lib/branch-template";
import type { GitBranchInfo, Task, TaskMode } from "@/lib/types";

/** re-export：调用方 / 单测可从本模块取分支名白名单校验 */
export { isSafeBranchName };

/**
 * R27-2 / R28-1：resource lease 失效时 ensureTaskWorktrees 抛此错让位——
 * **不吞**：错误冒泡给调用方；调用方不得继续 upsertGitBranch / 写事件 / 起 agent。
 */
export class WorktreeLeaseLostError extends Error {
  constructor(message = "worktree ensure 让位：resource lease 已失效") {
    super(message);
    this.name = "WorktreeLeaseLostError";
  }
}

const execFileAsync = promisify(execFile);

/** R29-2：Node execFile 被 AbortSignal 杀掉时的错误识别 */
const isExecAborted = (err: unknown, signal?: AbortSignal): boolean => {
  if (signal?.aborted) return true;
  if (!err || typeof err !== "object") return false;
  const e = err as { name?: string; code?: string; message?: string };
  if (e.name === "AbortError") return true;
  if (e.code === "ABORT_ERR") return true;
  // Node 杀子进程时常见：killed + signal SIGTERM
  if (
    (err as { killed?: boolean; signal?: string }).killed === true &&
    signal
  ) {
    return true;
  }
  return false;
};

/**
 * 目录是否为 git 仓（同步 existsSync）。
 * **只给建 / 编辑任务时算 nonGitRepoPaths 快照用**——运行时路径映射 / 分支规划
 * 一律读 task.nonGitRepoPaths，禁止再调本函数分流（原仓漂移会打破 cwd 不变式）。
 * `.git` 可以是目录（普通仓）或文件（worktree 指针）——两者都算。
 */
export const isGitRepoPath = (repoPath: string): boolean =>
  existsSync(path.join(repoPath, ".git"));

/**
 * 从当前磁盘状态算出 nonGitRepoPaths 快照（createTask / updateTaskFields 落库用）。
 * 全是 git → undefined（跟老任务缺省语义一致、meta 不占空数组）。
 */
export const computeNonGitRepoPaths = (
  repoPaths: string[],
): string[] | undefined => {
  const nonGit = repoPaths.filter((p) => !isGitRepoPath(p));
  return nonGit.length > 0 ? nonGit : undefined;
};

/**
 * 从 settings.repos 算出只读仓快照（createTask / updateTaskFields / setTaskRepoPaths 落库用）。
 * 无匹配 → undefined（跟老任务缺省一致）。
 */
export const computeReadonlyRepoPaths = (
  repoPaths: string[],
  settingsRepos: ReadonlyArray<{ path?: string; readonly?: boolean }>,
): string[] | undefined => {
  const readonlySet = new Set(
    settingsRepos
      .filter((r) => r.readonly === true && typeof r.path === "string" && r.path)
      .map((r) => r.path as string),
  );
  const matched = repoPaths.filter((p) => readonlySet.has(p));
  return matched.length > 0 ? matched : undefined;
};

/**
 * 从 settings.repos 算出脚本仓快照（跟 computeReadonlyRepoPaths 同款、按 scriptRepo 开关匹配）。
 * 纯提示性标注——不影响 worktree 隔离 / 门禁；无匹配 → undefined（跟老任务缺省一致）。
 */
export const computeScriptRepoPaths = (
  repoPaths: string[],
  settingsRepos: ReadonlyArray<{ path?: string; scriptRepo?: boolean }>,
): string[] | undefined => {
  const scriptSet = new Set(
    settingsRepos
      .filter((r) => r.scriptRepo === true && typeof r.path === "string" && r.path)
      .map((r) => r.path as string),
  );
  const matched = repoPaths.filter((p) => scriptSet.has(p));
  return matched.length > 0 ? matched : undefined;
};

// ----------------- 类型：Task / TaskMetaV06 都能喂的最小形状 -----------------

/**
 * worktree 判定 / 路径映射需要的最小 task 形状——Task 和 TaskMetaV06 都满足、
 * 让 task-fs（只有 meta）和 runner（有完整 Task）共用同一套函数。
 */
export interface WorktreeTaskLike {
  id: string;
  mode?: TaskMode;
  repoPaths: string[];
  isolateWorktree?: boolean;
  /** 非 git 目录快照；undefined = 全 git（老任务） */
  nonGitRepoPaths?: string[];
  /** 只读仓快照；undefined = 无只读仓（老任务） */
  readonlyRepoPaths?: string[];
  /** 脚本仓快照（纯提示性标注、不参与路径映射）；undefined = 无脚本仓（老任务） */
  scriptRepoPaths?: string[];
}

// ----------------- 纯函数：判定 + 路径映射 -----------------

/** 本 task 是否走隔离工作区（chat 模式 / 逃生口 / 无仓库一律不隔离） */
export const isWorktreeTask = (t: WorktreeTaskLike): boolean =>
  t.mode !== "chat" && t.isolateWorktree === true && t.repoPaths.length > 0;

/**
 * 读快照判断某仓是否非 git（undefined / 未列入 = git）。
 * 路径映射 / 分支规划 / prompt / action-gates 统一走这里，禁止运行时 existsSync。
 */
export const isTaskNonGitRepo = (
  t: WorktreeTaskLike,
  repoPath: string,
): boolean => (t.nonGitRepoPaths ?? []).includes(repoPath);

/**
 * 读快照判断某仓是否只读（undefined / 未列入 = 可写）。
 * 只读仓不进 worktree、prompt / 门禁 / 后置检测共用。
 */
export const isTaskReadonlyRepo = (
  t: WorktreeTaskLike,
  repoPath: string,
): boolean => (t.readonlyRepoPaths ?? []).includes(repoPath);

/**
 * 读快照判断某仓是否脚本仓（undefined / 未列入 = 非脚本仓）。
 * 只用于 prompt 标注（📜 + 「先看仓内约定」指引）——不影响 worktree / cwd / 门禁。
 */
export const isTaskScriptRepo = (
  t: WorktreeTaskLike,
  repoPath: string,
): boolean => (t.scriptRepoPaths ?? []).includes(repoPath);

/** 是否跳过隔离 worktree（非 git 或只读 → 原地使用） */
export const skipsWorktreeIsolation = (
  t: WorktreeTaskLike,
  repoPath: string,
): boolean => isTaskNonGitRepo(t, repoPath) || isTaskReadonlyRepo(t, repoPath);

/** task 是否至少绑了一个可进 worktree 的 git 仓（git 且非只读） */
export const taskHasGitRepo = (t: WorktreeTaskLike): boolean =>
  t.repoPaths.some((p) => !skipsWorktreeIsolation(t, p));

/** 任务绑定的仓是否全部只读（有仓且每个都在快照里） */
export const taskAllReposReadonly = (t: WorktreeTaskLike): boolean =>
  t.repoPaths.length > 0 &&
  t.repoPaths.every((p) => isTaskReadonlyRepo(t, p));

/** 所有 task worktree 的根目录 */
export const getWorktreesRoot = (): string => path.join(dataRoot(), "worktrees");

/** 单个 task 的 worktree 容器目录（多仓时也是 effective cwd 的公共父目录） */
export const getTaskWorktreesDir = (taskId: string): string =>
  path.join(getWorktreesRoot(), taskId);

// 路径归一：反斜杠转正斜杠 + 去尾斜杠（对齐 path-utils 的比较口径）
const normPath = (p: string): string => p.replace(/\\/g, "/").replace(/\/+$/, "");

/**
 * task 的「工作路径」列表——agent 实际干活的目录：
 * - 隔离 task → 逐仓读快照：git 且非只读 → 映射到 worktree 子目录；非 git / 只读
 *   **原样返回 repoPath**（无分支隔离需求 / 验证要用原仓 pull 切提测分支）
 * - 非隔离 → 原样返回 repoPaths
 * - 顺序始终跟 repoPaths 一一对应（index 对齐是全站路径映射契约）
 */
export const getTaskWorkRepoPaths = (t: WorktreeTaskLike): string[] => {
  if (!isWorktreeTask(t)) return t.repoPaths;
  const dir = getTaskWorktreesDir(t.id);
  const names = getUniqueRepoDirNames(t.repoPaths);
  return t.repoPaths.map((repoPath, i) =>
    skipsWorktreeIsolation(t, repoPath) ? repoPath : path.join(dir, names[i]),
  );
};

/**
 * task 的 effective cwd（Agent.create / 后置检查 / orphan reap 统一走这里）。
 *
 * 隔离任务：只对「映射进 worktree 的仓」算公共父——非 git / 只读靠绝对路径访问、
 * 不参与聚合（否则 worktree 在 Application Support、原仓在 Documents → 聚到 $HOME）。
 * - 纯 / 多可隔离仓：现状语义不变（单 = worktree 自身、多 = worktrees/<taskId> 容器）
 * - 全跳过隔离：退回原 repoPaths 的公共父
 */
export const getTaskCwd = (t: WorktreeTaskLike): string => {
  if (!isWorktreeTask(t)) return getEffectiveCwd(t.repoPaths);
  const isolatedWorkPaths = getTaskWorkRepoPaths(t).filter(
    (_, i) => !skipsWorktreeIsolation(t, t.repoPaths[i]),
  );
  if (isolatedWorkPaths.length === 0) return getEffectiveCwd(t.repoPaths);
  return getEffectiveCwd(isolatedWorkPaths);
};

/**
 * 把 agent 上报的路径归一回「原仓库路径」（submit_mr 校验 / MR 落库用）。
 * agent 在 worktree 里 `pwd` 拿到的是 worktree 路径、而 task.repoPaths / gitBranches /
 * repoTestBranches 等权威数据全按原仓库路径记——不归一 validateSubmitMr 必拦。
 * 匹配不上（agent 报了原路径 / 幻觉路径）原样返回、由下游校验兜底。
 */
export const resolveOriginalRepoPath = (
  t: WorktreeTaskLike,
  reported: string,
): string => {
  const target = normPath(reported);
  const workPaths = getTaskWorkRepoPaths(t);
  for (let i = 0; i < workPaths.length; i++) {
    if (normPath(workPaths[i]) === target) return t.repoPaths[i];
  }
  return reported;
};

// ----------------- 分支规划（worktree 检出用、跟 planBranchesForBuild 同规则） -----------------

/**
 * 逐仓算本 task 的工作分支（已有 gitBranches 记录 > 用户指定已有分支 > 模板渲染）。
 * 跟 action-gates.planBranchesForBuild 同一套命名规则；区别是这里必须**总能**给出
 * 分支名（worktree 创建不能没分支）——storyId 抠不到时兜底用 task id 的时间戳段。
 *
 * 混合隔离：只给 **可隔离的 git 仓**造记录（非 git / 只读无隔离需求、不进 gitBranches）。
 */
export const planWorktreeBranchInfos = (task: Task): GitBranchInfo[] => {
  const storyId =
    extractFeishuStoryId(task.feishuStoryUrl) ??
    // task id 形如 t_<ts>_<rand>、取时间戳段兜底（branch-safe 纯数字、跨 task 唯一性够用）
    task.id.split("_")[1] ??
    task.id;
  const existing = task.gitBranches ?? [];
  return task.repoPaths
    .filter((repoPath) => !skipsWorktreeIsolation(task, repoPath))
    .map((repoPath) => {
      const old = existing.find((b) => b.repoPath === repoPath);
      if (old) return old;
      const explicitName = task.repoFeatureBranches?.[repoPath]?.trim();
      return {
        repoPath,
        name:
          explicitName ||
          renderBranchName(
            task.repoBranchTemplates?.[repoPath] || DEFAULT_BRANCH_TEMPLATE,
            { storyId, taskTitle: task.title },
          ),
        baseBranch: "",
      };
    });
};

// ----------------- git 执行底座 -----------------

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/**
 * 跑一条 git 子命令。
 * @param job R29-2：传入则把 AbortController 挂到该 resource job——revoke 可中止；
 *   被 abort 抛 {@link WorktreeLeaseLostError}（走让位/补偿路径）。补偿路径勿传 job。
 */
const runGit = async (
  repoPath: string,
  args: string[],
  timeoutMs = 60_000,
  job?: ResourceJobHandle,
): Promise<GitResult> => {
  // R29-2：长命令（checkout / worktree add / fetch）可被终态 owner revoke
  const ac = job ? new AbortController() : null;
  if (job && ac) {
    registerJobAbort(job.taskId, job.jobId, () => ac.abort());
  }
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd: repoPath,
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      ...(ac ? { signal: ac.signal } : {}),
    });
    return { ok: true, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (err) {
    // R29-2：revoke / abort → 让位（不吞成 ok:false）
    if (job && isExecAborted(err, ac?.signal)) {
      throw new WorktreeLeaseLostError(
        "R29-2：git 子进程被 revoke 中止、资源操作让位",
      );
    }
    const e = err as Error & { stdout?: string; stderr?: string };
    return {
      ok: false,
      stdout: (e.stdout ?? "").trim(),
      stderr: (e.stderr ?? e.message ?? "").trim(),
    };
  } finally {
    if (job) registerJobAbort(job.taskId, job.jobId, null);
  }
};

const pathExists = async (p: string): Promise<boolean> => {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
};

/**
 * 从 `git worktree add` 失败 stderr 解析占用方路径。
 * 兼容两套文案：`already checked out at '<path>'` /
 * `'<branch>' is already used by worktree at '<path>'`。
 */
export const parseOccupyingWorktreePath = (stderr: string): string | null => {
  const m = stderr.match(
    /already (?:checked out|used by worktree) at ['"]?(.+?)['"]?\s*$/im,
  );
  const p = m?.[1]?.trim();
  return p || null;
};

/**
 * 占用路径是否为「已删任务的孤儿 worktree」：
 * 路径落在 `<dataRoot>/worktrees/<taskId>/…`，且 `<dataRoot>/tasks/<taskId>` 已不存在。
 * 活任务目录还在 → 不是孤儿（可能并行占用 / 另一实例）、不能强删。
 *
 * macOS 注意：git stderr 常给 `/private/var/...`，而 dataRoot 可能是 `/var/...`
 *（/var → /private/var 软链）——必须 realpath 后再比前缀，否则永远判不成孤儿。
 */
const isDeletedTaskOrphanWorktree = async (
  occupyingPath: string,
): Promise<boolean> => {
  const resolveNorm = async (p: string): Promise<string> => {
    try {
      return normPath(await fs.realpath(p));
    } catch {
      return normPath(path.resolve(p));
    }
  };
  const root = await resolveNorm(getWorktreesRoot());
  const p = await resolveNorm(occupyingPath);
  const prefix = `${root}/`;
  if (!p.startsWith(prefix)) return false;
  const taskId = p.slice(prefix.length).split("/")[0];
  if (!taskId) return false;
  return !(await pathExists(path.join(dataRoot(), "tasks", taskId)));
};

/**
 * 撞「already checked out / already used by worktree」时：若占用方是已删任务孤儿，
 * 则 force remove + prune 释放分支，返回 true 让调用方重试 add；否则返回 false。
 */
const tryReleaseDeletedTaskOrphan = async (
  repoPath: string,
  stderr: string,
): Promise<boolean> => {
  if (!/already checked out|already used by worktree/i.test(stderr)) return false;
  const occupying = parseOccupyingWorktreePath(stderr);
  if (!occupying) return false;
  if (!(await isDeletedTaskOrphanWorktree(occupying))) return false;
  console.log(
    `[task-worktrees] 发现已删任务孤儿 worktree，强制释放后重试：${occupying}`,
  );
  const removed = await runGit(
    repoPath,
    ["worktree", "remove", "--force", occupying],
    60_000,
  );
  if (!removed.ok) {
    await fs.rm(occupying, { recursive: true, force: true }).catch(() => {});
    await runGit(repoPath, ["worktree", "prune"]);
  }
  return true;
};

// ----------------- worktree 创建（确定性、幂等） -----------------

export interface EnsureWorktreesResult {
  /** 逐仓分支信息（含已存在的历史记录、runner 拿去 upsert gitBranches） */
  infos: GitBranchInfo[];
  /** 本次真正新建了 worktree 的原仓库路径（写事件流告知用户用） */
  createdRepos: string[];
  /** 本次从原仓库秒级克隆到的依赖目录（写事件流告知用户用）：原仓路径 + 目录名列表 */
  clonedDeps: { repoPath: string; dirs: string[] }[];
}

/**
 * 确保本 task 每个仓的 worktree 都存在且检出了任务分支（幂等、可反复调）。
 *
 * 单仓流程：
 *   0. 非 git 目录（纯脚本库等）→ 跳过（原地使用、不建 worktree、不抛错；
 *      全仓非 git = 等效 no-op）
 *   1. worktree 目录已是合法 git 工作区 → 复用；复用前校验当前分支 == 任务分支，
 *      被手动 checkout / detached HEAD 切走则自动 `git checkout` 切回（失败抛错、不带病推进）
 *   2. `git worktree prune` 清掉「目录被手删但 git 还记着」的僵尸注册
 *   3. 定分支起点：本地已有分支 → 直接挂；远程有同名分支（用户自己建过）→ fetch 后基于它建本地；
 *      都没有 → 基于线上分支（设置页快照、缺省探 origin/HEAD）新建、`--no-track` 防误推线上
 *   4. 拷根目录 `.env*`（gitignore 的本地配置不在检出里、不拷 dev server 起不来）
 *
 * 失败抛错（带仓名 + git stderr + 处置建议）——worktree 是硬前置、创建不了不该带病起 agent。
 *
 * @param lease R28-1：**必填** resource lease（同步）——mkdir 前 / fetch 后 / hot checkout 前 /
 *   每次 `git worktree add`（含 retry）前 / `.env` copy 前 / 每个 dep clone 单元前 / 结束复查。
 *   失效抛 {@link WorktreeLeaseLostError}（**不吞**、调用方按语义让位）。
 *   add / copy / clone 段失主：补偿移除本轮新建的 worktree（尽力而为）。
 */
export const ensureTaskWorktrees = async (
  task: Task,
  lease: () => boolean,
): Promise<EnsureWorktreesResult> => {
  // R30-2：join 超时后的 quarantine 挡住后继——旧慢清理未退前不得复用同路径
  if (isWorkspaceQuarantined(task.id)) {
    throw new WorktreeLeaseLostError(
      "R30-2：workspace 仍在 quarantine（旧资源事务未退）、拒绝复用同路径",
    );
  }
  // R28-1 / R29-2：登记 resource job（带 handle）——finalize/stop/DELETE 可 revoke 子进程后 join
  // R30-2：job 覆盖完整资源事务（含 abort 后半截 rm / 失主补偿），直到清理完才 end
  const job = beginResourceJob(task.id);
  try {
    // R28-1：lease 失效即抛（每个不可逆副作用前复用；不再可选）
    const assertLease = (): void => {
      if (!lease()) throw new WorktreeLeaseLostError();
    };
    // R29-A：入场 ownership 快照——失主补偿比对用。
    // 动态 import 避 task-worktrees → task-stream → task-fs → task-worktrees 静态环。
    const { snapshotTaskOp } = await import("./task-stream");
    const entryHandle = snapshotTaskOp(task.id);
    const infos = planWorktreeBranchInfos(task);
    // 混合隔离后 infos 只含 git 仓、跟 repoPaths 不再 index 对齐——按 repoPath 查
    const infoByRepo = new Map(infos.map((info) => [info.repoPath, info]));
    const workPaths = getTaskWorkRepoPaths(task);
    const createdRepos: string[] = [];
    const clonedDeps: { repoPath: string; dirs: string[] }[] = [];

    // R28-1：让位错误冒泡——调用方不得 upsert / 写事件 / 起 agent
    return await ensureTaskWorktreesInner({
      task,
      infos,
      infoByRepo,
      workPaths,
      createdRepos,
      clonedDeps,
      assertLease,
      lease,
      entryHandle,
      job,
    });
  } finally {
    endResourceJob(job);
  }
};

/**
 * R28-1 / R29-A / R30-2：失主补偿——尽力移除本轮新建的 worktree（含 git 注册）。
 * copy/clone 段失主也走这里，避免终态任务留下物理工作区。
 *
 * R30-2：
 * - 单独登记 ResourceJob（**不接 abort**——`git worktree remove` 最长 60s 不可中止；
 *   终态 owner join 等本 job 归零；超时走 quarantine 而非开闸）。
 * - 逐仓 remove / fs.rm **紧前**现查 successor（snapshot + runningTasks/agentSessions），
 *   不再只靠入场一次性快照——避免卡在 remove 期间 B 入场后被误删。
 */
const compensateRemoveCreatedWorktrees = async (
  task: Task,
  workPaths: string[],
  createdRepos: string[],
  entryHandle: { opId: number | null; gen: number; claimSeq: number },
): Promise<void> => {
  // R30-2：补偿本身是资源事务——登记 job 让 stop/finalize/DELETE join 看得见
  const compensateJob = beginResourceJob(task.id);
  try {
    // R29-A / R30-2：动态 import 避静态环
    const { snapshotTaskOp, runningTasks, agentSessions } = await import(
      "./task-stream"
    );

    /** 现查：后继已 claim / 活跃 → 本仓不得删 */
    const hasSuccessorNow = (): boolean => {
      const fresh = snapshotTaskOp(task.id);
      const hasSuccessorClaim =
        fresh.claimSeq !== entryHandle.claimSeq ||
        (fresh.opId != null && fresh.opId !== entryHandle.opId);
      const hasActiveSuccessor =
        runningTasks.has(task.id) || agentSessions.has(task.id);
      return hasSuccessorClaim || hasActiveSuccessor;
    };

    for (const repoPath of [...createdRepos]) {
      const idx = task.repoPaths.indexOf(repoPath);
      if (idx < 0) continue;
      const workDir = workPaths[idx];
      try {
        // R30-2：测试可在此注入后继 B；紧接着现查——过了才 remove
        await failpoint("compensate.beforeRemove");
        if (hasSuccessorNow()) {
          const fresh = snapshotTaskOp(task.id);
          console.warn(
            `[task-worktrees] R30-2：失主补偿跳过仓 ${repoPath}——后继已 claim/活跃（task=${task.id} claimSeq ${entryHandle.claimSeq}→${fresh.claimSeq} opId ${entryHandle.opId}→${fresh.opId} running=${runningTasks.has(task.id)} session=${agentSessions.has(task.id)}）、留孤儿给当前 owner/finalize`,
          );
          continue;
        }
        // 故意不传 ResourceJob / 不接 abort——remove 不可中止；靠 compensateJob + quarantine 兜
        const removed = await runGit(
          repoPath,
          ["worktree", "remove", "--force", workDir],
          60_000,
        );
        if (!removed.ok) {
          // R30-2：fs.rm 同样紧前现查——remove 失败窗口内 B 可能已入场
          if (hasSuccessorNow()) {
            console.warn(
              `[task-worktrees] R30-2：worktree remove 失败后跳过 fs.rm——后继已入场 workDir=${workDir}`,
            );
            continue;
          }
          await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
          await runGit(repoPath, ["worktree", "prune"]);
        }
      } catch (err) {
        console.warn(
          `[task-worktrees] R28-1 失主补偿移除 worktree 失败（尽力而为）：${workDir}`,
          err,
        );
      }
    }
    createdRepos.length = 0;
  } finally {
    endResourceJob(compensateJob);
  }
};

/** R28-1：ensure 主体（lease 检查点贯穿全生命周期） */
const ensureTaskWorktreesInner = async (ctx: {
  task: Task;
  infos: GitBranchInfo[];
  infoByRepo: Map<string, GitBranchInfo>;
  workPaths: string[];
  createdRepos: string[];
  clonedDeps: { repoPath: string; dirs: string[] }[];
  assertLease: () => void;
  lease: () => boolean;
  /** R29-A：ensure 入场 ownership 快照（补偿身份比对） */
  entryHandle: { opId: number | null; gen: number; claimSeq: number };
  /** R29-2：resource job——长 git / cp 子进程挂 abort */
  job: ResourceJobHandle;
}): Promise<EnsureWorktreesResult> => {
  const {
    task,
    infos,
    infoByRepo,
    workPaths,
    createdRepos,
    clonedDeps,
    assertLease,
    lease,
    entryHandle,
    job,
  } = ctx;

  // R28-1：根目录 mkdir 前插桩 + 验 lease（旧实现 mkdir 在首次 lease 前）
  await failpoint("ensure.beforeMkdir");
  assertLease();
  await fs.mkdir(getTaskWorktreesDir(task.id), { recursive: true });

  /** 失主：补偿本轮新建后抛让位错 */
  const yieldAfterCompensate = async (): Promise<never> => {
    await compensateRemoveCreatedWorktrees(
      task,
      workPaths,
      createdRepos,
      entryHandle,
    );
    throw new WorktreeLeaseLostError();
  };

  for (let i = 0; i < task.repoPaths.length; i++) {
    const repoPath = task.repoPaths[i];
    const workDir = workPaths[i];

    // 非 git / 只读仓（读快照）：路径映射已原地返回、这里跳过建 worktree
    if (skipsWorktreeIsolation(task, repoPath)) {
      console.log(
        `[task-worktrees] 跳过${isTaskReadonlyRepo(task, repoPath) ? "只读" : "非 git"}目录（原地使用、不建隔离工作区）：${repoPath}`,
      );
      continue;
    }

    const info = infoByRepo.get(repoPath);
    if (!info) {
      // planWorktreeBranchInfos 已 filter 非 git、此处不应缺失——防御性跳过
      continue;
    }

    // 分支名白名单：拒空串 / 前导 - / 空白 / .. / 非法 ref 字符（防 git argv 当 flag）
    const branch = info.name;
    if (!isSafeBranchName(branch)) {
      throw new Error(
        `仓库 ${repoPath} 任务分支名非法「${branch}」、拒绝创建 / 切换隔离工作区`,
      );
    }

    // 已存在且是合法工作区 → 复用（幂等热路径、每次推进都会走到）。
    // 必须校验当前分支：用户 / agent 可能在 worktree 里手动 checkout 切走，
    // 旧实现只查 is-inside-work-tree 就 continue，后续推进会静默在错误分支上干活。
    // 顺手补克隆依赖目录（老 worktree 建于克隆功能上线前 / 上次克隆失败）——
    // 缺依赖会连锁炸 pre-commit hook / lint / typecheck（实测：dev 联调 agent 被迫 --no-verify）
    if (await pathExists(path.join(workDir, ".git"))) {
      const check = await runGit(
        workDir,
        ["rev-parse", "--is-inside-work-tree"],
        60_000,
        job,
      );
      if (check.ok) {
        // show-current：detached HEAD 时 stdout 为空，跟任务分支不一致同样要切回
        const show = await runGit(
          workDir,
          ["branch", "--show-current"],
          60_000,
          job,
        );
        const currentBranch = show.ok ? show.stdout : "";
        if (currentBranch !== branch) {
          // R28-1：已有 worktree 的 hot checkout 前插桩 + 验 lease
          await failpoint("ensure.beforeHotCheckout");
          assertLease();
          // R29-2：hot checkout 挂 abort——stop/finalize revoke 可中止
          const switched = await runGit(
            workDir,
            ["checkout", branch],
            60_000,
            job,
          );
          if (!switched.ok) {
            // 工作区脏 / 冲突等会导致 checkout 失败——抛清晰提示，让用户先处理，不带病推进
            const where = currentBranch || "detached HEAD";
            throw new Error(
              `仓库 ${repoPath} 当前在 ${where} 分支、任务分支是 ${branch}、自动切回失败：${switched.stderr || switched.stdout}`,
            );
          }
          console.log(
            `[task-worktrees] worktree 已切回任务分支：${workDir}（${currentBranch || "detached HEAD"} → ${branch}）`,
          );
        }
        // 热路径 dep clone：逐单元验 lease（不补偿移除已有 worktree）
        const dirs = await cloneDepDirs(repoPath, workDir, assertLease, job);
        if (dirs.length > 0) clonedDeps.push({ repoPath, dirs });
        continue;
      }
    }

    // R27-2 / R28-1：进入「需要新建」路径——先插桩再验 lease。
    // 矩阵降级用例在此挂起（空仓尚无 base/branch、若放 add 前会被「找不到线上分支」提前抛出）。
    // 真 add / retry 前另有 assertLease + 同名 failpoint。
    await failpoint("ensure.beforeWorktreeAdd");
    // R30-2：半截目录清掉重来——exists 可 await；删除动作紧前同步重验 lease，
    // 无 await 夹缝（递归 rm 本身不可中止、靠 ResourceJob + quarantine 兜）。
    if (await pathExists(workDir)) {
      assertLease();
      await fs.rm(workDir, { recursive: true, force: true });
    } else {
      // 无旧目录也要验——与原先「进新建路径必验」对齐（finalize 已接管则让位）
      assertLease();
    }
    // 清「目录没了但 git 还记着」的僵尸 worktree 注册（否则 add 同路径报错）
    await runGit(repoPath, ["worktree", "prune"], 60_000, job);

    const localBranchExists = (
      await runGit(
        repoPath,
        ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
        60_000,
        job,
      )
    ).ok;

    // addArgs 存下来：撞「已删任务孤儿占用」时可 force-remove 后原样重试一次
    let addArgs: string[];
    let resolvedBase = info.baseBranch;
    if (localBranchExists) {
      // 本地已有任务分支（返工 / 用户自己建过）→ 直接挂到 worktree
      addArgs = ["worktree", "add", workDir, branch];
    } else {
      // 远程可能有同名分支（用户在别的机器 / 之前推过）→ fetch 后基于它建本地。
      // best-effort、30s 上限：fetch 只是「拿最新」的锦上添花、慢网络 / 被墙远程（github）
      // 挂太久会把整个推进卡住（实测 120s×2 把 advance 拖到 4 分钟+）、超时就用本地现有引用
      // R29-2：fetch 挂 abort（可达 30s）
      await runGit(repoPath, ["fetch", "origin", branch], 30_000, job);
      // fetch（可达 30s）完成后验 lease——期间 finalize 可已终结任务
      assertLease();
      const remoteBranchExists = (
        await runGit(
          repoPath,
          ["rev-parse", "--verify", "--quiet", `origin/${branch}`],
          60_000,
          job,
        )
      ).ok;
      if (remoteBranchExists) {
        addArgs = [
          "worktree",
          "add",
          "--no-track",
          "-b",
          branch,
          workDir,
          `origin/${branch}`,
        ];
      } else {
        // 全新分支：基于线上分支建。base = 设置页快照、缺省探 origin/HEAD
        let base = task.repoBaseBranches?.[repoPath]?.trim() ?? "";
        if (!base) {
          const head = await runGit(
            repoPath,
            ["symbolic-ref", "refs/remotes/origin/HEAD"],
            60_000,
            job,
          );
          base = head.ok ? head.stdout.replace("refs/remotes/origin/", "") : "";
        }
        if (!base) {
          throw new Error(
            `仓库 ${repoPath} 探不到主分支（origin/HEAD 未设置）——去设置页给该仓配「线上分支」后重试`,
          );
        }
        if (!isSafeBranchName(base)) {
          throw new Error(
            `仓库 ${repoPath} 线上分支名非法「${base}」、拒绝创建隔离工作区`,
          );
        }
        // R29-2：base fetch 挂 abort
        await runGit(repoPath, ["fetch", "origin", base], 30_000, job);
        // base fetch 完成后同样验 lease
        assertLease();
        // 起点优先 origin/<base>（最新）、离线 / 无远程时回退本地 <base>
        const startPoint = (
          await runGit(
            repoPath,
            ["rev-parse", "--verify", "--quiet", `origin/${base}`],
            60_000,
            job,
          )
        ).ok
          ? `origin/${base}`
          : (
                await runGit(
                  repoPath,
                  ["show-ref", "--verify", "--quiet", `refs/heads/${base}`],
                  60_000,
                  job,
                )
              ).ok
            ? base
            : "";
        if (!startPoint) {
          throw new Error(
            `仓库 ${repoPath} 找不到线上分支「${base}」（远程 / 本地都没有）——核对设置页该仓的线上分支名`,
          );
        }
        resolvedBase = base;
        // --no-track：防 git 自动设 upstream=origin/<线上>、之后裸 push 误推线上（同 build hint 老规则）
        addArgs = [
          "worktree",
          "add",
          "--no-track",
          "-b",
          branch,
          workDir,
          startPoint,
        ];
      }
    }

    // R27-2 / R28-1：每次 `git worktree add`（含孤儿自愈后的 retry）前验 lease + 插桩
    // 测试矩阵按此名注入（ensure.beforeWorktreeAdd）
    await failpoint("ensure.beforeWorktreeAdd");
    assertLease();
    // R29-2：worktree add（可达 120s）挂 abort
    let added = await runGit(repoPath, addArgs, 120_000, job);
    if (!added.ok) {
      // 存量孤儿自愈：老版本删任务时快照失败会 skip 删除，留下 worktree 目录 + 分支占用。
      // 若占用方是「已删任务」的孤儿 → force remove + prune 后重试一次 add。
      if (await tryReleaseDeletedTaskOrphan(repoPath, added.stderr)) {
        // retry 也是一次独立 add——同样验 lease
        await failpoint("ensure.beforeWorktreeAdd");
        assertLease();
        added = await runGit(repoPath, addArgs, 120_000, job);
      }
    }
    if (!added.ok) {
      // 最常见：分支已在原仓库 / 别的 worktree 检出（git 同一分支只允许一个检出点）。
      // 旧文案 `already checked out`；git 2.4x+ 部分场景改成
      // `'<branch>' is already used by worktree at '<path>'`——两套都要认，否则用户看不到中文处置提示。
      //（不提「改用直接在原仓库运行」——isolateWorktree 建完没有入口能改、提了也做不到）
      const hint = /already checked out|already used by worktree/i.test(added.stderr)
        ? "——该分支已在原仓库或其它任务的工作区检出：去原仓库把这个分支切走（checkout 别的分支）、或删掉占用它的任务后重试；若本机还开着另一个实例（正式 / test）、检查是否它的工作区占用了该分支"
        : "";
      throw new Error(
        `仓库 ${repoPath} 创建隔离工作区失败（分支 ${branch}）：${added.stderr || added.stdout}${hint}`,
      );
    }

    // R28-1：add 成功即记入本轮新建——后续 copy/clone 失主一并补偿
    createdRepos.push(repoPath);

    // add 成功后（可达 120s）再验一次——失主立即补偿
    await failpoint("worktree.afterAdd");
    if (!lease()) {
      await yieldAfterCompensate();
    }

    info.baseBranch = resolvedBase;
    // R28-1：.env copy / dep clone 前与期间验 lease；失主补偿本轮新建
    try {
      assertLease();
      await copyRootEnvFiles(repoPath, workDir);
      // dep clone：每单元前验 lease（600s 大头）；失主走外层补偿
      const dirs = await cloneDepDirs(repoPath, workDir, assertLease, job);
      if (dirs.length > 0) clonedDeps.push({ repoPath, dirs });
    } catch (err) {
      if (err instanceof WorktreeLeaseLostError) {
        await yieldAfterCompensate();
      }
      throw err;
    }
  }

  // R28-1：全部完成后结束复查（插桩在验 lease 前，矩阵可在此翻 lease）
  await failpoint("ensure.afterAllDone");
  if (!lease()) {
    await yieldAfterCompensate();
  }

  return { infos, createdRepos, clonedDeps };
};

/**
 * 各生态「可安全整目录克隆」的依赖目录白名单（V0.11.3 从写死 node_modules 泛化、
 * 用户点名「通用项目、别只考虑前端」）。探测到就克、都是可重定位目录（拷到新路径直接可用）：
 * - `node_modules`：JS/TS（npm / pnpm / yarn）
 * - `vendor`：PHP composer / Ruby bundler（vendor/bundle 嵌套在内）/ Go vendor 模式
 * - `Pods`：iOS CocoaPods
 *
 * 明确**不在**白名单里的：
 * - ⚠️ `.venv` / `venv`（Python 虚拟环境）：shebang / activate 写死绝对路径、克隆到新路径
 *   是坏的、比不克更坑（agent 以为环境可用、一跑就炸）——Python 由 agent 在 worktree 自建
 * - Java（~/.m2 / ~/.gradle）、Go（module cache）、.NET（NuGet）走全局缓存、
 *   不在项目目录里、worktree 天然秒可用、无需克隆
 */
const CLONABLE_DEP_DIRS = ["node_modules", "vendor", "Pods"];

/**
 * 依赖目录秒级克隆（V0.10.1 上线 node_modules、V0.11.3 泛化多语言白名单；
 * 用户实测痛点：umi 类大包每个 worktree 重装太久、且 postinstall 在新环境偶发失败）。
 *
 * 原仓库有白名单目录时用 APFS copy-on-write 克隆（mac `cp -Rc`、clonefile(2)）：
 * 不走网络、秒到十几秒级、磁盘块共享几乎不占空间、postinstall 产物原样带过来。
 * 两边是独立副本（非 symlink）、互不污染；分支间依赖有差异时 agent 增量 install 补齐。
 * 失败（跨卷 / 非 APFS / 非 mac）静默跳过、回退 agent 自装。
 * @returns 本次真正克隆到的目录名列表（一个没克 = 空数组）
 */
const cloneDepDirs = async (
  repoPath: string,
  workDir: string,
  /** R28-1：每个 dep 单元真正开 clone 前验 lease（必填由调用方传入） */
  assertLease: () => void,
  /** R29-2：resource job——`cp -Rc`（可达 600s）挂 abort */
  job: ResourceJobHandle,
): Promise<string[]> => {
  const cloned: string[] = [];
  for (const dir of CLONABLE_DEP_DIRS) {
    const src = path.join(repoPath, dir);
    const dst = path.join(workDir, dir);
    // 原仓没有该目录 / worktree 已有（tracked 检出自带 / 上次克过）→ 跳过
    if (!(await pathExists(src)) || (await pathExists(dst))) continue;
    // R28-1：每个 dep 单元前插桩 + 验 lease（600s 大头、循环内逐单元）
    // 平台跳过也放在验 lease 之后——finalize 让位窗口与 darwin 一致可测
    await failpoint("ensure.beforeDepClone");
    assertLease();
    if (process.platform !== "darwin") continue; // clonefile 仅 APFS、其它平台回退 agent 自装
    // R29-2：cp -Rc 挂 AbortController——revoke 中止后清半截残留并让位
    const ac = new AbortController();
    registerJobAbort(job.taskId, job.jobId, () => ac.abort());
    try {
      // -c = clonefile；大目录（几十万文件）逐文件克隆也只是元数据操作、给足超时
      await execFileAsync("cp", ["-Rc", src, dst], {
        timeout: 600_000,
        signal: ac.signal,
      });
      // 构建工具缓存必须删（V0.13.x、用户实测「worktree 里 dev server 热更新极慢 /
      // 刷新一直 loading」）：webpack / babel / vue-cli 等的 node_modules/.cache 里
      // 记录的是**原仓库的绝对路径**、克隆过来后路径全错——dev server 每次都缓存
      // 失配 → 全量重编译。删掉让它在 worktree 里冷启动重建正确缓存、之后热更新正常。
      if (dir === "node_modules") {
        await fs
          .rm(path.join(dst, ".cache"), { recursive: true, force: true })
          .catch(() => {});
      }
      cloned.push(dir);
    } catch (err) {
      // R30-2：abort 后半截清理仍在同一 ResourceJob 内（外层 ensure finally 才 end）——
      // 此处先清残留再清 abort 登记；慢 rm 期间 join 仍看见 job，超时走 quarantine。
      await fs.rm(dst, { recursive: true, force: true }).catch(() => {});
      // R28-1 / R29-2：lease 让位 / revoke abort 必须冒泡（不可当 clone 失败静默吞掉）
      if (err instanceof WorktreeLeaseLostError) throw err;
      if (isExecAborted(err, ac.signal)) {
        throw new WorktreeLeaseLostError(
          "R29-2：依赖克隆 cp 子进程被 revoke 中止、资源操作让位",
        );
      }
      console.warn(
        `[task-worktrees] 依赖目录 ${dir} 克隆失败（回退 agent 自装）repo=${repoPath}：`,
        err,
      );
    } finally {
      registerJobAbort(job.taskId, job.jobId, null);
    }
  }
  return cloned;
};

// 拷原仓库根目录的 .env* 到 worktree（只拷 worktree 里没有的——tracked 的 .env 检出自带、不覆盖）
// dev server / 本地脚本常依赖 gitignore 的 .env.local 等、不拷新工作区直接跑不起来
const copyRootEnvFiles = async (repoPath: string, workDir: string): Promise<void> => {
  try {
    const entries = await fs.readdir(repoPath, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isFile() || !e.name.startsWith(".env")) continue;
      const target = path.join(workDir, e.name);
      if (await pathExists(target)) continue;
      await fs.copyFile(path.join(repoPath, e.name), target);
    }
  } catch (err) {
    // 拷贝失败不挡启动（agent 跑不起 dev server 时用户自己补）、只 log
    console.warn(`[task-worktrees] 拷贝 .env* 失败（忽略）repo=${repoPath}：`, err);
  }
};

// ----------------- worktree 清理 -----------------

/** WIP 快照三态：干净 / 已落快照 / 脏但落不了（调用方决定是否仍删） */
type SnapshotResult = "clean" | "snapshotted" | "failed";

/**
 * 删 worktree 前的产物保底：工作区脏（build 完没 ship 时、改动只以未提交形式存在）
 * → 自动 commit 一份 WIP 快照到任务分支再删——「分支保留 = 产物保留」才真成立、
 * reopen 重建 worktree 检出分支还能无缝续推。
 *
 * 返回三态（调用方按场景决定是否仍删目录）：
 * - clean：干净（porcelain 空）→ 可直接删
 * - snapshotted：脏且已 commit 成功 → 可删（产物在分支上）
 * - failed：脏但落不了快照（merge 冲突 / status 挂 / commit 失败）
 *   - `removeTaskWorktrees`（用户主动删/终结）：仍强制删，接受未提交改动丢失
 *   - `cleanupOrphanTaskWorktrees`（开机自动）：保守保留，防误伤
 *
 * merge / rebase 冲突中：porcelain 会出现 UU/AA/DU 等未合并码。此时若盲目
 * `git add -A` 会把带 <<<<<<< 的文件当成「已解决」并成功 commit 出脏 merge、
 * 掩盖真实冲突——所以未合并时直接 failed，不特判 MERGE_HEAD 文件是否存在。
 */
const snapshotDirtyWorktree = async (workDir: string): Promise<SnapshotResult> => {
  const status = await runGit(workDir, ["status", "--porcelain"]);
  // status 本身跑不了（原仓被移走 / .git 指针坏 / git 不在 PATH）时无法证明干净 → failed
  if (!status.ok) {
    console.warn(
      `[task-worktrees] git status 失败、无法证明工作区干净、WIP 快照失败：${workDir}：${status.stderr}`,
    );
    return "failed";
  }
  if (status.stdout.length === 0) return "clean";
  // 未合并路径（merge/rebase 冲突）：add 会假解决、记 failed 让调用方决定
  const hasUnmerged = status.stdout
    .split("\n")
    .some((line) => /^(?:DD|AU|UD|UA|DU|AA|UU)\s/.test(line));
  if (hasUnmerged) {
    console.warn(
      `[task-worktrees] 工作区有未合并冲突、跳过 WIP 快照：${workDir}`,
    );
    return "failed";
  }
  const added = await runGit(workDir, ["add", "-A"]);
  if (!added.ok) {
    console.warn(`[task-worktrees] WIP 快照 git add 失败：${workDir}：${added.stderr}`);
    return "failed";
  }
  // 本地快照 commit：绕过业务仓库自己的 hooks（可能装了 lint-staged 等、失败会挡快照）；
  // 用户没配 git 身份时给个兜底身份、保证「能 commit 的场景」一定能落。
  const committed = await runGit(workDir, [
    "-c", "user.name=fe-ai-flow",
    "-c", "user.email=fe-ai-flow@local",
    "commit", "--no-verify", "-m", "WIP：任务终结前自动快照（fe-ai-flow）",
  ]);
  if (!committed.ok) {
    console.warn(
      `[task-worktrees] WIP 快照 commit 失败：${workDir}：${committed.stderr}`,
    );
    return "failed";
  }
  return "snapshotted";
};

export interface RemoveWorktreesResult {
  /** 是否真的清理了至少一个目录 */
  removedAny: boolean;
  /** 删前自动 commit 了 WIP 快照的原仓库路径（写事件告知用户用） */
  snapshotRepos: string[];
  /**
   * WIP 快照失败但仍已强制删除的原仓库路径。
   * 未提交改动可能已丢（已 commit 的仍在任务分支上）——用户主动删/终结可接受。
   */
  snapshotFailedRepos: string[];
}

/**
 * 删掉本 task 的全部 worktree（task 终结 / 删除时调）。
 * feature 分支**保留**在原仓库（worktree 删了分支还在）；工作区有未提交改动时
 * 先尽力 commit WIP 快照到任务分支（见 snapshotDirtyWorktree）。
 *
 * ⚠️ 强制删除决策（用户拍板）：快照失败也继续删——否则孤儿 worktree 目录残留会一直
 * 占用 feature 分支，删任务后重建同 story/同标题任务会撞 `already checked out`。
 * 代价：快照失败时该仓未提交改动会丢（已 commit 的在分支上、reopen 不依赖此目录）。
 * best-effort：单仓失败只 log、不抛（boot 孤儿扫描兜底）。
 */
export const removeTaskWorktrees = async (
  t: WorktreeTaskLike,
): Promise<RemoveWorktreesResult> => {
  const taskDir = getTaskWorktreesDir(t.id);
  if (!(await pathExists(taskDir))) {
    return { removedAny: false, snapshotRepos: [], snapshotFailedRepos: [] };
  }

  // 不走 getTaskWorkRepoPaths：那个映射按 nonGitRepoPaths 快照分流、非 git 返回原路径——
  // 删除逻辑绝不能对原路径下手（会毁掉用户目录）。
  // 这里独立算「worktree 候选路径」（容器目录 + 仓短名）、只对真实存在的候选目录操作：
  // 非 git 仓从没建过 worktree、候选不存在天然跳过；原仓被移走时候选还在、照常走快照保护。
  const names = getUniqueRepoDirNames(t.repoPaths);
  let removedAny = false;
  const snapshotRepos: string[] = [];
  const snapshotFailedRepos: string[] = [];
  for (let i = 0; i < t.repoPaths.length; i++) {
    const repoPath = t.repoPaths[i];
    const workDir = path.join(taskDir, names[i]);
    if (!(await pathExists(workDir))) continue;
    // 未提交改动先尽力落 WIP 快照；无论成败都继续删，释放分支占用
    const snap = await snapshotDirtyWorktree(workDir);
    if (snap === "snapshotted") {
      snapshotRepos.push(repoPath);
    } else if (snap === "failed") {
      console.warn(
        `[task-worktrees] WIP 快照失败、仍强制删除 worktree（未提交改动可能丢失）：${workDir}`,
      );
      snapshotFailedRepos.push(repoPath);
    }
    // 优先走 git worktree remove（同时清 .git/worktrees 注册）；原仓库没了 / 命令失败退回 rm + prune
    const removed = await runGit(
      repoPath,
      ["worktree", "remove", "--force", workDir],
      60_000,
    );
    if (!removed.ok) {
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
      await runGit(repoPath, ["worktree", "prune"]);
    }
    removedAny = true;
  }
  // 容器目录清空后移除（还有残留就留着、不 force 递归删以防误伤）
  await fs.rmdir(taskDir).catch(() => {});
  return { removedAny, snapshotRepos, snapshotFailedRepos };
};

/**
 * 从 worktree `.git` 指针文件内容解析主仓公共 git dir。
 * 内容形如 `gitdir: <原仓>/.git/worktrees/<name>`——注意 git 在 Windows 上也写
 * **正斜杠**、不能用 path.sep 匹配（git 在 Windows 也写正斜杠、双端分隔符都认）。
 * 解析不了返 null。
 */
export const parseMainGitDirFromPointer = (pointer: string): string | null => {
  const m = pointer.match(/^gitdir:\s*(.+)$/m);
  if (!m) return null;
  const gitdir = m[1].trim();
  const idx = gitdir.search(/[\\/]worktrees[\\/][^\\/]+[\\/]?$/);
  return idx > 0 ? gitdir.slice(0, idx) : null;
};

/**
 * 启动孤儿扫描（boot recovery 调）：worktrees/ 下不属于任何「存活 task」的目录整个清掉。
 * 覆盖：task 被删但清理失败 / 终结时 app 崩了没来得及清。
 * 反向解析原仓库：worktree 的 `.git` 指针（见 parseMainGitDirFromPointer）
 * 找到原仓库跑 `worktree prune` 清注册；脏工作区删前照样落 WIP 快照。全程 best-effort、绝不抛。
 */
export const cleanupOrphanTaskWorktrees = async (
  liveTaskIds: Set<string>,
): Promise<void> => {
  const root = getWorktreesRoot();
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return; // 目录不存在 = 没建过 worktree
  }
  for (const e of entries) {
    if (!e.isDirectory() || liveTaskIds.has(e.name)) continue;
    const orphanDir = path.join(root, e.name);
    try {
      // 删目录前先收集各仓的主 .git 目录（删完就读不到 gitdir 指针了）
      const mainGitDirs = new Set<string>();
      // 任一仓 WIP 快照失败 → 整棵孤儿目录本轮保留。
      // 开机自动清理≠用户主动删：保守保留防误伤；用户主动删走 removeTaskWorktrees 强制释放。
      let snapshotFailed = false;
      const repoDirs = await fs.readdir(orphanDir, { withFileTypes: true });
      for (const r of repoDirs) {
        if (!r.isDirectory()) continue;
        const workDir = path.join(orphanDir, r.name);
        try {
          const gitFile = await fs.readFile(path.join(workDir, ".git"), "utf8");
          const mainGitDir = parseMainGitDirFromPointer(gitFile);
          if (mainGitDir) mainGitDirs.add(mainGitDir);
          // 未提交改动先尽力 commit 到任务分支；失败则整棵保留（开机保守）
          const snap = await snapshotDirtyWorktree(workDir);
          if (snap === "failed") snapshotFailed = true;
        } catch {
          // .git 文件读不到（非 worktree 残留）、直接随目录删
        }
      }
      if (snapshotFailed) {
        console.warn(
          `[task-worktrees] 孤儿 worktree WIP 快照失败、本轮保留目录（下次 boot 再试）：${orphanDir}`,
        );
        continue;
      }
      await fs.rm(orphanDir, { recursive: true, force: true });
      for (const gitDir of mainGitDirs) {
        await runGit(path.dirname(gitDir), ["worktree", "prune"]);
      }
      console.log(`[task-worktrees] 已清理孤儿 worktree：${orphanDir}`);
    } catch (err) {
      console.warn(`[task-worktrees] 清理孤儿 worktree 失败（忽略）${orphanDir}：`, err);
    }
  }
};
