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
import { existsSync, promises as fs, type Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";

import { dataRoot } from "./data-root";
import { failpoint } from "./failpoints";
// ownership 快照与活跃态读无环叶子模块（静态 import 不构环——
// 之前动态 import ./task-stream 躲环，在 Turbopack dev 下会拿到半初始化
// namespace 报 `snapshotTaskOp is not a function`）。
import {
  hasTaskAgentSession,
  isTaskRunning,
  snapshotTaskOp,
} from "./task-op";
import {
  beginResourceJob,
  endResourceJob,
  isWorkspaceQuarantined,
  registerJobAbort,
  type ResourceJobHandle,
} from "./resource-jobs";
import { getRepoSetupCommand } from "./settings-fs";
import {
  detectLockfileDrift,
  discoverDepDirs,
  ROOT_DEP_DIRS,
  rewriteBinShimPaths,
  runSetupCommand,
  type SetupRunResult,
} from "./worktree-deps";
import { getEffectiveCwd, getUniqueRepoDirNames } from "@/lib/path-utils";
import {
  DEFAULT_BRANCH_TEMPLATE,
  extractFeishuStoryId,
  isSafeBranchName,
  renderBranchName,
} from "@/lib/branch-template";
import { resolveFlowLock } from "@/lib/flow-mutex";
import type {
  GitBranchInfo,
  Task,
  TaskMode,
} from "@/lib/types";

/** re-export：调用方 / 单测可从本模块取分支名白名单校验 */
export { isSafeBranchName };
/** re-export：日常轻量态判定（实现在 client-safe 的 lightweight-task） */
export { isLightweightDailyTask } from "@/lib/lightweight-task";

/**
 * resource lease 失效时 ensureTaskWorktrees 抛此错让位——
 * **不吞**：错误冒泡给调用方；调用方不得继续 upsertGitBranch / 写事件 / 起 agent。
 */
export class WorktreeLeaseLostError extends Error {
  constructor(message = "worktree ensure 让位：resource lease 已失效") {
    super(message);
    this.name = "WorktreeLeaseLostError";
  }
}

const execFileAsync = promisify(execFile);

/** Node execFile 被 AbortSignal 杀掉时的错误识别 */
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

/** 本 task 是否走隔离工作区（只描述物理隔离，不参与主流程 / 分支所有权判断）。
 * 前端同口径镜像见 lib/lightweight-task.ts isWorktreeTaskLike（归档确认/toast 用），改规则时两边一起改。 */
export const isWorktreeTask = (t: WorktreeTaskLike): boolean =>
  t.mode !== "chat" &&
  t.isolateWorktree === true &&
  t.repoPaths.length > 0;

/**
 * 建 task 时的 isolateWorktree 落盘决策（单一来源）。
 * - chat → undefined（不隔离）
 * - 无飞书链接（日常轻量态）→ 强制 false（原仓、不建分支）
 * - 其余：显式 false 才原仓，缺省 / true → true
 */
export const resolveTaskIsolateWorktree = (
  mode: TaskMode | undefined,
  feishuStoryUrl: string | undefined,
  isolateWorktree: boolean | undefined,
): boolean | undefined => {
  if (mode === "chat") return undefined;
  if (!(feishuStoryUrl ?? "").trim()) return false;
  return isolateWorktree !== false;
};

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

/**
 * 解绑 / 改仓时 worktree 目录怎么变（纯函数、按旧列表短名定位）。
 *
 * 短名由 getUniqueRepoDirNames 按序分配：["a/foo","b/foo"] → foo / foo-2。
 * 删掉 a/foo 后新列表 ["b/foo"] 会重算成 foo，但磁盘上还在 foo-2——
 * 必须先按旧名拆已解绑的，再把仍绑着的仓从旧名挪到新名。
 */
export const planWorktreeDirChanges = (
  oldRepoPaths: string[],
  newRepoPaths: string[],
): {
  remove: Array<{ repoPath: string; dirName: string }>;
  relocate: Array<{ repoPath: string; fromName: string; toName: string }>;
} => {
  const oldNames = getUniqueRepoDirNames(oldRepoPaths);
  const newNames = getUniqueRepoDirNames(newRepoPaths);
  const newSet = new Set(newRepoPaths);
  const remove = oldRepoPaths.flatMap((repoPath, i) =>
    newSet.has(repoPath) ? [] : [{ repoPath, dirName: oldNames[i]! }],
  );
  const oldIndex = new Map(oldRepoPaths.map((p, i) => [p, i] as const));
  const relocate: Array<{
    repoPath: string;
    fromName: string;
    toName: string;
  }> = [];
  for (let i = 0; i < newRepoPaths.length; i++) {
    const repoPath = newRepoPaths[i]!;
    const oi = oldIndex.get(repoPath);
    if (oi === undefined) continue;
    const fromName = oldNames[oi]!;
    const toName = newNames[i]!;
    if (fromName !== toName) {
      relocate.push({ repoPath, fromName, toName });
    }
  }
  return { remove, relocate };
};

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
 * 逐仓算本 task 的工作分支（已有 gitBranches 记录 > 模板渲染）。
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
      return {
        repoPath,
        name: renderBranchName(
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
 * @param job 传入则把 AbortController 挂到该 resource job——revoke 可中止；
 *   被 abort 抛 {@link WorktreeLeaseLostError}（走让位/补偿路径）。补偿路径勿传 job。
 */
const runGit = async (
  repoPath: string,
  args: string[],
  timeoutMs = 60_000,
  job?: ResourceJobHandle,
): Promise<GitResult> => {
  // 长命令（checkout / worktree add / fetch）可被终态 owner revoke
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
    // revoke / abort → 让位（不吞成 ok:false）
    if (job && isExecAborted(err, ac?.signal)) {
      throw new WorktreeLeaseLostError(
        "git 子进程被 revoke 中止、资源操作让位",
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
 * 路径探测：只有「确定不存在」（ENOENT / ENOTDIR）才算 missing；
 * 其它 I/O 错误（EACCES / EIO / EMFILE …，高负载下会瞬时出现）一律 error——
 * 调用方不能把 error 当成「不存在 / 已损坏」去删除或改名用户的目录。
 */
const probePath = async (
  p: string,
): Promise<"dir" | "file" | "missing" | "error"> => {
  try {
    const st = await fs.stat(p);
    return st.isDirectory() ? "dir" : "file";
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? "missing" : "error";
  }
};

/**
 * 把 `.git` 指针文件里的 `gitdir:` 值解析成绝对路径；`baseDir` 是 `.git` 文件所在目录。
 *
 * 相对路径必须按 `baseDir` 的**真实路径**解析、不能 `path.resolve(baseDir, pointer)` 做字面量折叠：
 * git（含 `worktree.useRelativePaths`、git>=2.48 写出的相对指针）和内核都是顺着软链走的——
 * `baseDir` 路径里只要有一级软链（数据目录 / worktrees 目录换盘后软链回来），`..` 就是软链目标的真实上级，
 * 而字面量折叠会走到「字面上的上一级」，指到一个不存在的位置，把好好的工作区判成 broken、被改名隔离重建。
 *
 * 返回 null = `baseDir` 的 realpath 都取不到（刚被删 / I/O 错）：此时任何路径结论都不可信，
 * 调用方一律按「不下结论」处理（宁可 unknown 也不能误判 broken）。绝对指针不受软链影响，直接返回。
 */
const resolveGitPointer = async (
  baseDir: string,
  pointer: string,
): Promise<string | null> => {
  if (path.isAbsolute(pointer)) return path.resolve(pointer);
  try {
    return path.resolve(await fs.realpath(baseDir), pointer);
  } catch {
    return null;
  }
};

/**
 * 工作区 `.git` 的结构判定（只看文件系统、不跑 git）：
 * - `absent`：确定没有 `.git`（lstat ENOENT / ENOTDIR）——只剩依赖克隆残留之类的半截目录，可清；
 * - `broken`：**有正面证据**表明结构已坏——`.git` 文件里没有合法的 `gitdir:` 行 / 指针指向的 gitdir 不存在
 *   （且主仓确实可达，见下）/ gitdir 里缺 `HEAD` 或 `HEAD` 内容不是合法 ref / sha（worktree gitdir 还要有 `commondir`）/
 *   `.git` 目录里缺 `HEAD` 或 `HEAD` 非法 / `.git` 是悬空软链（目标所在目录可达）；
 *   这几种 git 必定认不出仓库（实测都是 `fatal: not a git repository` / `invalid gitfile format`）；
 * - `intact`：结构看起来完好（指针指到的 gitdir 在、关键文件在）；
 * - `unknown`：读不出来（权限 / I/O 错误）、**主仓 / 挂载点不可达**、或 `.git` 是没见过的形态——不下结论。
 *   其中「主仓 / 挂载点不可达」会带 `unreachablePath`，调用方据此抛带挂载提示的错（M6-01）。
 *
 * 为什么要自己看结构、而不是只信 `git rev-parse` 的退出码（N10-02）：runGit 把任何失败都折成 ok:false——
 * 60s 超时（机器高负载）、spawn 失败（EAGAIN / EMFILE / git 不在 PATH）、safe.directory / 权限问题，
 * 都和「目录真坏了」长得一模一样。旧实现据此把好好的工作区整个改名隔离、再 `git worktree add` 重建，
 * 用户会突然看到「改动全消失了」（改动其实在 `.orphaned-*` 里、但没人告诉他）。
 * 也不解析 stderr 做分类：git 的报错会随 LANG 本地化（zh_CN 下是「致命错误：不是 git 仓库」）；
 * 「不可达」一律用文件系统错误码（ENOENT / ENOTDIR 才算「不存在」，EACCES / EIO / ENXIO 等一律不下结论）。
 */
type WorkDirGitState = "absent" | "broken" | "intact" | "unknown";

interface WorkDirGitInspection {
  state: WorkDirGitState;
  /** 判定依据（broken 写进警告日志、unknown 写进报错，方便排查；absent / intact 无） */
  reason?: string;
  /** 因主仓 / 挂载点够不着才 unknown 时，够不着的那个路径 */
  unreachablePath?: string;
}

const brokenBecause = (reason: string): WorkDirGitInspection => ({
  state: "broken",
  reason,
});
const unknownBecause = (reason: string): WorkDirGitInspection => ({
  state: "unknown",
  reason,
});
const unreachableAt = (
  unreachablePath: string,
  reason: string,
): WorkDirGitInspection => ({ state: "unknown", reason, unreachablePath });

/**
 * HEAD 内容是否是 git 认的合法写法（对齐 git 的 validate_headref）：
 * `ref:` 后接 `refs/...`（冒号后空白可有可无）、或 detached 的十六进制 sha。
 * sha 只校验前 40 位十六进制：sha1 是 40 位、sha256 是 64 位、两者都以 40 位十六进制打头——
 * 宁可放过一点格式怪异的（落到「不动目录」那档）、也不把 git 认得的 HEAD 误判成损坏。
 */
const isValidHeadContent = (text: string): boolean =>
  /^ref:\s*refs\//.test(text) || /^[0-9a-f]{40}/i.test(text);

/**
 * `open(HEAD)` 报「不存在」时再 lstat 一次，区分「HEAD 确实没有」和「HEAD 是悬空软链」。
 *
 * 为什么要区分：旧式软链 HEAD（`core.preferSymlinkRefs=true`，HEAD → `refs/heads/<分支>`）指向的 loose ref
 * 文件在「未出生分支」或 `git pack-refs` / `git gc` 之后就不在了，软链随之悬空——但 git 认这种 HEAD
 * （实测 `rev-parse` 照常成功），`open` 却报 ENOENT，不加区分会把好好的仓判成「缺 HEAD」去改名隔离。
 * 软链指向 `refs/...` → 视为合法；指向别处 / lstat 还有别的错 → 不下结论（宁可放过、不动目录）。
 */
const probeMissingHead = async (
  headPath: string,
): Promise<"valid" | "missing" | "error"> => {
  try {
    const st = await fs.lstat(headPath);
    // lstat 看得到、open 却说没有：要么悬空软链、要么刚好撞上竞态，都不是「确定缺 HEAD」
    if (!st.isSymbolicLink()) return "error";
    // Windows 上软链目标可能是反斜杠写法，统一成 `/` 再比
    const target = (await fs.readlink(headPath)).replaceAll("\\", "/");
    return target.startsWith("refs/") ? "valid" : "error";
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? "missing" : "error";
  }
};

/**
 * 读 HEAD 并校验内容：valid / invalid（内容非法：空文件、垃圾）/ missing（确定不存在）/ error（读失败，不下结论）。
 * 只读头 256 字节：HEAD 正常只有几十字节、git 自己也只看这么多，防坏文件特别大。
 * 为什么不能只看「HEAD 在不在」：空 HEAD / 垃圾 HEAD git 同样报 `not a git repository`，
 * 只查存在性会把它们判成 intact、变成永远不自愈、要人工删目录（M6-02）。
 */
const probeHeadFile = async (
  headPath: string,
): Promise<"valid" | "invalid" | "missing" | "error"> => {
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(headPath, "r");
    const buf = Buffer.alloc(256);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    return isValidHeadContent(buf.toString("utf8", 0, bytesRead))
      ? "valid"
      : "invalid";
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return probeMissingHead(headPath);
    return "error";
  } finally {
    await handle?.close().catch(() => {});
  }
};

/** 软链最多跟这么多跳（对齐 Linux 的 MAXSYMLINKS），超了当环、不下结论 */
const MAX_SYMLINK_HOPS = 40;

/**
 * `.git` 是悬空软链（lstat 是 symlink、stat 报 ENOENT / ENOTDIR）：链尾目标所在目录可达才算正面证据。
 * 链尾所在目录本身都不存在 / 读不了，更可能是外接盘 / 网络盘没挂载（软链指过去的），不能当损坏处理（M6-03）。
 *
 * 为什么要沿链一跳一跳走到链尾、不能只看第一跳：`.git → 本地软链 → 没挂载的盘` 这种多跳形态里，
 * 第一跳的目标（那条本地软链）所在目录当然在，只看它会把「盘没挂载」误判成损坏、改名隔离。
 * 相对目标按「当前这条软链所在目录」解析，跟 OS 解析软链一致。
 */
const inspectDanglingDotGit = async (
  dotGit: string,
): Promise<WorkDirGitInspection> => {
  let current = dotGit;
  for (let hop = 0; hop < MAX_SYMLINK_HOPS; hop++) {
    let link: string;
    try {
      link = await fs.readlink(current);
    } catch {
      return unknownBecause(`.git 是软链、但读不出 ${current} 的目标`);
    }
    const target = path.resolve(path.dirname(current), link);
    let next: Stats | undefined;
    try {
      next = await fs.lstat(target);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        return unknownBecause(
          `.git 是软链、链上 ${target} 读取出错（${code ?? "未知错误"}）`,
        );
      }
    }
    if (next?.isSymbolicLink()) {
      current = target;
      continue;
    }
    if (next) {
      // 链尾对象明明在、整体解析却报「不存在」：多半是路径中间某个分量出了岔子（竞态 / 软链目录里的 `..`），不下结论
      return unknownBecause(`.git 软链链尾 ${target} 存在、但整体解析失败`);
    }
    // 链尾悬空：看它所在目录够不够得着，够得着才是确凿的损坏
    const targetDir = path.dirname(target);
    if ((await probePath(targetDir)) === "dir") {
      return brokenBecause(
        `.git 是悬空软链（链尾 ${target} 不存在、其所在目录可达）`,
      );
    }
    return unreachableAt(
      targetDir,
      `.git 是悬空软链、链尾指向 ${target}，但其所在目录 ${targetDir} 不存在或读不了`,
    );
  }
  return unknownBecause(`.git 软链层级超过 ${MAX_SYMLINK_HOPS} 跳（疑似环）`);
};

/**
 * 任务主仓 `repoPath` 的 git 目录是否够得着（重建 worktree 要靠它）：
 * - `.git` 是目录：在就算可达；
 * - `.git` 是文件（repoPath 自己是 linked worktree / 子模块）：它只是个 `gitdir:` 指针，文件在本地磁盘上
 *   不代表指针指向的真正 gitdir 也在——宿主仓恰好在没挂载的盘上时，光看「文件在」会误判成可重建，
 *   所以还要再看指针指向的目录在不在（相对路径按 repoPath 的真实路径解析，跟 git 一致）；
 * - 其它（不存在 / 读错 / 指针不合法）一律当够不着：宁可不隔离，也别在重建做不成时先把目录挪走。
 */
const isRepoGitReachable = async (repoPath: string): Promise<boolean> => {
  const dotGit = path.join(repoPath, ".git");
  const kind = await probePath(dotGit);
  if (kind === "dir") return true;
  if (kind !== "file") return false;
  try {
    const pointer = (await fs.readFile(dotGit, "utf8")).match(
      /^gitdir:\s*(.+?)\s*$/m,
    )?.[1];
    const gitDir = pointer ? await resolveGitPointer(repoPath, pointer) : null;
    return !!gitDir && (await probePath(gitDir)) === "dir";
  } catch {
    return false;
  }
};

/**
 * 指针指向的 gitdir 不存在时，区分「主仓在、登记没了」（broken）和「主仓够不着」（unknown，M6-01）。
 *
 * 为什么不能一律判 broken：指针指向 `<主仓>/.git/worktrees/<name>`，主仓在外接盘 / 网络盘上没挂载时
 * 这个 gitdir 同样「不存在」——此时改名隔离既丢了用户的可见改动、又因为主仓不在而重建不了，
 * 且用户看不到任何提示。判据只用 stat 的错误码：
 *  1. 主仓 `.git` 是可读目录、却没有 `worktrees/<name>` → 登记确实没了，正面证据；
 *  2. 主仓 `.git` stat 报 ENOENT / ENOTDIR 之外的错（EACCES / EIO / ENXIO …）→ 不下结论；
 *  3. 主仓 `.git` 不存在（上级目录没了：没挂载 / 被移走 / 被删，光看指针分不清暂时还是永久）→
 *     再看任务自己配置的主仓 `repoPath`（`isRepoGitReachable`：`.git` 是目录就看目录在不在，
 *     是指针文件就再看它指向的 gitdir 在不在）：够得着，说明「要挂回去的那个主仓」是好的、
 *     指针指向的只是个早已不存在的旧位置（主仓搬过家），重建能成功 → broken；否则重建也做不成 → unknown。
 *     第 3 条同时保证「隔离」只发生在「马上能重建」的前提下，不会先挪走目录、再因主仓不在而重建失败。
 */
const inspectMissingGitDir = async (
  gitDir: string,
  repoPath: string,
): Promise<WorkDirGitInspection> => {
  const worktreesDir = path.dirname(gitDir);
  // 形态不符（子模块 / 自定义 gitdir）时退而求其次，取 gitdir 的父目录当「主仓侧」
  const mainGitDir =
    path.basename(worktreesDir) === "worktrees"
      ? path.dirname(worktreesDir)
      : worktreesDir;
  const mainKind = await probePath(mainGitDir);
  if (mainKind === "dir") {
    return brokenBecause(
      `指针指向的 gitdir ${gitDir} 不存在（主仓 .git 可达、但 worktree 登记没了）`,
    );
  }
  if (mainKind === "error") {
    return unreachableAt(mainGitDir, `主仓 .git ${mainGitDir} 读取出错（权限 / I/O）`);
  }
  if (await isRepoGitReachable(repoPath)) {
    return brokenBecause(
      `指针指向的 gitdir ${gitDir} 不存在（旧主仓位置已失效、任务主仓 ${repoPath} 可达）`,
    );
  }
  return unreachableAt(
    mainGitDir,
    `指针指向的 gitdir ${gitDir} 不存在，主仓 .git 与任务主仓 ${repoPath} 都读不到`,
  );
};

const inspectWorkDirGit = async (
  workDir: string,
  repoPath: string,
): Promise<WorkDirGitInspection> => {
  const dotGit = path.join(workDir, ".git");
  let st: Stats;
  try {
    // lstat：`.git` 若是软链也算「存在」，不能因为软链悬空就当它不存在而递归删目录
    st = await fs.lstat(dotGit);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR"
      ? { state: "absent" }
      : unknownBecause(`.git 读取出错（${code ?? "未知错误"}）`);
  }

  // `.git` 是软链：看它指向的真实对象。目标不存在 → 悬空软链（单独判），其它读错不下结论
  if (st.isSymbolicLink()) {
    try {
      st = await fs.stat(dotGit);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      return code === "ENOENT" || code === "ENOTDIR"
        ? inspectDanglingDotGit(dotGit)
        : unknownBecause(`.git 是软链、解析目标出错（${code ?? "未知错误"}）`);
    }
  }

  // `.git` 是目录：独立仓形态（git worktree add 不会产出、但用户可能在里面 git init 过）。
  // 只有缺 HEAD / HEAD 内容非法才有把握说它坏了
  if (st.isDirectory()) {
    const head = await probeHeadFile(path.join(dotGit, "HEAD"));
    if (head === "valid") return { state: "intact" };
    if (head === "missing") return brokenBecause(".git 目录里缺 HEAD");
    if (head === "invalid") {
      return brokenBecause(".git/HEAD 内容不是合法的 ref / sha（空文件或垃圾内容）");
    }
    return unknownBecause(".git/HEAD 读取出错");
  }
  if (!st.isFile()) return unknownBecause(".git 既不是文件也不是目录");

  // `.git` 是文件：worktree 指针 `gitdir: <path>`（相对路径按 workDir 的真实路径解析、跟 git 一致）
  let content: string;
  try {
    content = await fs.readFile(dotGit, "utf8");
  } catch {
    return unknownBecause(".git 指针文件读取失败");
  }
  const pointer = content.match(/^gitdir:\s*(.+?)\s*$/m)?.[1];
  if (!pointer) return brokenBecause(".git 文件里没有合法的 gitdir: 行");

  const gitDir = await resolveGitPointer(workDir, pointer);
  if (!gitDir) return unknownBecause(".git 指针的所在目录解析真实路径失败");
  const gitDirKind = await probePath(gitDir);
  if (gitDirKind === "error") {
    // EACCES / EIO / ENXIO 等：主仓所在位置读不了，可能是没挂载 / 权限，绝不能当损坏
    return unreachableAt(gitDir, `指针指向的 gitdir ${gitDir} 读取出错（权限 / I/O）`);
  }
  if (gitDirKind === "missing") return inspectMissingGitDir(gitDir, repoPath);
  if (gitDirKind !== "dir") return brokenBecause(`指针指向的 ${gitDir} 不是目录`);

  const head = await probeHeadFile(path.join(gitDir, "HEAD"));
  if (head === "error") return unknownBecause(`gitdir ${gitDir} 的 HEAD 读取出错`);
  if (head === "missing") return brokenBecause(`gitdir ${gitDir} 缺 HEAD`);
  if (head === "invalid") {
    return brokenBecause(
      `gitdir ${gitDir} 的 HEAD 内容不是合法的 ref / sha（空文件或垃圾内容）`,
    );
  }
  // 主仓 `.git/worktrees/<name>` 形态的 gitdir 靠 commondir 找回共享对象库、缺了 git 同样认不出
  if (path.basename(path.dirname(gitDir)) === "worktrees") {
    const common = await probePath(path.join(gitDir, "commondir"));
    if (common === "error") {
      return unknownBecause(`gitdir ${gitDir} 的 commondir 读取出错`);
    }
    if (common === "missing") return brokenBecause(`gitdir ${gitDir} 缺 commondir`);
  }
  return { state: "intact" };
};

/** 仅供测试：直接对一个真实目录跑 `.git` 结构判定（不必走完整的 ensure 流程） */
export const __inspectWorkDirGitForTest = inspectWorkDirGit;

/** 改名隔离的目录后缀（`<workDir>.orphaned-<时间戳>`）；pruneUnmapped 靠它跳过、不当垃圾删 */
const ORPHANED_DIR_MARK = ".orphaned-";

/**
 * 把「存在但已不是合法 worktree」的目录改名隔离（保留里面可能的未提交改动），返回隔离后路径。
 * - 目标名用 `<dir>.orphaned-<时间戳>`，已存在则追加 `-<n>` 保证唯一、绝不覆盖旧隔离目录；
 * - rename 失败（Windows 目录被占用 EBUSY / EXDEV / 权限 / 竞态）**抛错、不降级**：
 *   调用方只在 `.git` 结构性损坏（inspectWorkDirGit 判 broken、目录里可能有用户未提交改动）时才进来，
 *   此时递归 rm 会丢数据
 *   （Windows 上还可能删一半），所以保留目录原样、让用户手动处理（R2-01）。
 * @param why inspectWorkDirGit 给出的判定依据，只写进警告日志（事后排查「为什么被隔离」用）
 */
const isolateBrokenWorkDir = async (
  workDir: string,
  why?: string,
): Promise<string> => {
  const stamp = Date.now();
  let target = `${workDir}${ORPHANED_DIR_MARK}${stamp}`;
  try {
    for (let n = 1; await pathExists(target); n++) {
      target = `${workDir}${ORPHANED_DIR_MARK}${stamp}-${n}`;
    }
    await fs.rename(workDir, target);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `工作区 ${workDir} 已不是合法的 git worktree（.git 指针失效等），里面可能有未提交的改动；` +
        `自动改名隔离失败（${reason}），为避免数据丢失已保留原目录、未做任何删除。` +
        `请关闭占用该目录的程序（编辑器 / 终端 / 杀软等）后重试，或手动备份并移走该目录。`,
    );
  }
  console.warn(
    `[task-worktrees] 工作区 ${workDir} 已不是合法 worktree（.git 指针失效等）、已改名隔离保留未提交改动：${target}${why ? `（判定依据：${why}）` : ""}`,
  );
  return target;
};

/**
 * `git worktree add` 失败 stderr 是否在说「分支已被某 worktree 占用」。
 * 英文两套 + 中文常见译法都要认，否则 LANG=zh_CN 时孤儿自愈整段跳过。
 */
export const isWorktreeOccupancyStderr = (stderr: string): boolean =>
  /already checked out|already used by worktree|已经检出|已经被工作区|已由工作区使用/i.test(
    stderr,
  );

/**
 * 从 `git worktree add` 失败 stderr 解析占用方路径。
 * 英文：`already checked out at '<path>'` /
 * `'<branch>' is already used by worktree at '<path>'`。
 * 中文 git.po：`已经检出到` / `已经在 'path' 检出`。
 */
export const parseOccupyingWorktreePath = (stderr: string): string | null => {
  const patterns = [
    /already (?:checked out|used by worktree) at ['"]?(.+?)['"]?\s*$/im,
    /已经检出到\s*['「"]?(.+?)['」"]?\s*$/im,
    /已经在\s*['「"](.+?)['」"]\s*检出/im,
    /已被工作区使用于\s*['"]?(.+?)['"]?\s*$/im,
    /已经被工作区 ['"](.+?)['"] 使用/im,
  ];
  for (const re of patterns) {
    const m = stderr.match(re);
    const p = m?.[1]?.trim().replace(/[」'"]+$/, "");
    if (p) return p;
  }
  return null;
};

/** stderr 里第一对单引号通常是被占用的分支名 */
const parseQuotedBranchFromStderr = (stderr: string): string | null => {
  const m = stderr.match(/'([^']+)'/);
  return m?.[1]?.trim() || null;
};

/** 文案正则吃不准时，用 `worktree list` 按分支名找占用路径 */
const findWorktreePathForBranch = async (
  repoPath: string,
  branch: string,
): Promise<string | null> => {
  const listed = await runGit(repoPath, ["worktree", "list", "--porcelain"]);
  if (!listed.ok) return null;
  const want = branch.startsWith("refs/heads/")
    ? branch
    : `refs/heads/${branch}`;
  let currentPath = "";
  for (const line of listed.stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      currentPath = line.slice("worktree ".length).trim();
    } else if (line.startsWith("branch ") && currentPath) {
      const ref = line.slice("branch ".length).trim();
      if (ref === want || ref === branch) return currentPath;
    }
  }
  return null;
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
  if (!isWorktreeOccupancyStderr(stderr)) return false;
  let occupying = parseOccupyingWorktreePath(stderr);
  // 中文/未知 locale 路径解析失败时，按引号里的分支名去 list 里找占用方
  if (!occupying) {
    const branch = parseQuotedBranchFromStderr(stderr);
    if (branch) occupying = await findWorktreePathForBranch(repoPath, branch);
  }
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

/** 依赖初始化命令（设置页 per-repo setupCommand）的执行结果 */
export interface DepSetupOutcome {
  command: string;
  ok: boolean;
  /** 失败时的退出码 / 超时 / 输出末尾（已限长） */
  detail?: string;
}

/** 单仓依赖准备结果：克隆到的目录（相对路径）+ 初始化命令执行情况 */
export interface DepPrepareEntry {
  repoPath: string;
  /** 本次克隆到的依赖目录（相对 worktree 根、posix 分隔；monorepo 子包形如 `apps/x/node_modules`） */
  dirs: string[];
  /** 本次执行了依赖初始化命令才有 */
  setup?: DepSetupOutcome;
}

export interface EnsureWorktreesResult {
  /** 逐仓分支信息（含已存在的历史记录、runner 拿去 upsert gitBranches） */
  infos: GitBranchInfo[];
  /** 本次真正新建了 worktree 的原仓库路径（写事件流告知用户用） */
  createdRepos: string[];
  /** 本次的依赖准备结果（秒级克隆 / 初始化命令；写事件流告知用户用） */
  clonedDeps: DepPrepareEntry[];
}

/**
 * ensure 可选策略：
 * - skipDepClone：纯答疑 oneshot——目录就绪即可、不挡首包
 * - deferDepClone：正式启动——worktree/分支先就绪，依赖拷贝交给
 *   {@link cloneMissingTaskDepDirs} 后台跑（与 Agent.create 重叠）
 */
export interface EnsureWorktreesOptions {
  skipDepClone?: boolean;
  deferDepClone?: boolean;
  /**
   * 只跳过「依赖初始化命令」（setupCommand，最长 15 分钟）、秒级克隆照做：
   * prewarm 路径用——它同步持有 runAdvanceExclusive，在这里跑 install 会把「建完任务立刻推进」
   * 卡满一个超时。命令留给推进启动后的后台补齐（{@link cloneMissingTaskDepDirs}）去跑。
   */
  skipDepSetup?: boolean;
  /**
   * 工作区与分支所有权分离：
   * - flowship：按 Flowship 模板规划 / 创建任务分支（旧流程）
   * - detached：只创建物理 worktree，不抢先创建业务分支（新任务预热 / WK 文档阶段）
   * - explicit：检出调用方已解析的现成分支；某仓解析不到 / 分支不存在时该仓按 detached 处理（不硬拦）
   */
  branchSelection?:
    | { kind: "flowship" }
    | { kind: "detached" }
    | { kind: "explicit"; infos: GitBranchInfo[] };
}

const defaultBranchSelection = (
  task: Task,
): NonNullable<EnsureWorktreesOptions["branchSelection"]> => {
  if (resolveFlowLock(task.actions) !== "wk") return { kind: "flowship" };
  const infos = task.gitBranches ?? [];
  const coveredRepos = new Set(infos.map((info) => info.repoPath));
  const allWritableGitReposCovered = task.repoPaths
    .filter((repoPath) => !skipsWorktreeIsolation(task, repoPath))
    .every((repoPath) => coveredRepos.has(repoPath));
  return infos.length > 0 && allWritableGitReposCovered
    ? { kind: "explicit", infos }
    : { kind: "detached" };
};

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
 * @param lease **必填** resource lease（同步）——mkdir 前 / fetch 后 / hot checkout 前 /
 *   每次 `git worktree add`（含 retry）前 / `.env` copy 前 / 每个 dep clone 单元前 / 结束复查。
 *   失效抛 {@link WorktreeLeaseLostError}（**不吞**、调用方按语义让位）。
 *   add / copy / clone 段失主：补偿移除本轮新建的 worktree（尽力而为）。
 */
export const ensureTaskWorktrees = async (
  task: Task,
  lease: () => boolean,
  opts?: EnsureWorktreesOptions,
): Promise<EnsureWorktreesResult> => {
  // join 超时后的 quarantine 挡住后继——旧慢清理未退前不得复用同路径
  if (isWorkspaceQuarantined(task.id)) {
    throw new WorktreeLeaseLostError(
      "workspace 仍在 quarantine（旧资源事务未退）、拒绝复用同路径",
    );
  }
  // 登记 resource job（带 handle）——finalize/stop/DELETE 可 revoke 子进程后 join
  // job 覆盖完整资源事务（含 abort 后半截 rm / 失主补偿），直到清理完才 end
  const job = beginResourceJob(task.id);
  try {
    // lease 失效即抛（每个不可逆副作用前复用；不再可选）
    const assertLease = (): void => {
      if (!lease()) throw new WorktreeLeaseLostError();
    };
    // 入场 ownership 快照——失主补偿比对用（静态 import 自 ./task-op，见文件头）。
    const entryHandle = snapshotTaskOp(task.id);
    const selection = opts?.branchSelection ?? defaultBranchSelection(task);
    const infos =
      selection.kind === "flowship"
        ? planWorktreeBranchInfos(task)
        : selection.kind === "explicit"
          ? selection.infos
          : [];
    // 混合隔离后 infos 只含 git 仓、跟 repoPaths 不再 index 对齐——按 repoPath 查
    const infoByRepo = new Map(infos.map((info) => [info.repoPath, info]));
    const workPaths = getTaskWorkRepoPaths(task);
    const createdRepos: string[] = [];
    const clonedDeps: DepPrepareEntry[] = [];

    // 让位错误冒泡——调用方不得 upsert / 写事件 / 起 agent
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
      selection,
      // skip / defer 都跳过同步 clone；defer 由 caller 调 cloneMissingTaskDepDirs 后台补
      skipDepClone: !!(opts?.skipDepClone || opts?.deferDepClone),
      skipDepSetup: !!opts?.skipDepSetup,
    });
  } finally {
    endResourceJob(job);
  }
};

/**
 * 后台补齐 worktree 里缺失的依赖目录（与 Agent.create 重叠用）。
 * 幂等：目标已存在则跳过；无缺失时秒过返空。lease 失效抛 WorktreeLeaseLostError。
 */
export const cloneMissingTaskDepDirs = async (
  task: Task,
  lease: () => boolean,
): Promise<DepPrepareEntry[]> => {
  if (isWorkspaceQuarantined(task.id)) {
    throw new WorktreeLeaseLostError(
      "workspace 仍在 quarantine（旧资源事务未退）、拒绝依赖克隆",
    );
  }
  if (!isWorktreeTask(task)) return [];
  const job = beginResourceJob(task.id);
  const clonedDeps: DepPrepareEntry[] = [];
  try {
    const assertLease = (): void => {
      if (!lease()) throw new WorktreeLeaseLostError();
    };
    const workPaths = getTaskWorkRepoPaths(task);
    for (let i = 0; i < task.repoPaths.length; i++) {
      const repoPath = task.repoPaths[i];
      const workDir = workPaths[i];
      if (skipsWorktreeIsolation(task, repoPath)) continue;
      if (!(await pathExists(workDir))) continue;
      assertLease();
      const prepared = await cloneDepDirs(repoPath, workDir, assertLease, job);
      if (prepared.dirs.length > 0 || prepared.setup) {
        clonedDeps.push({ repoPath, ...prepared });
      }
    }
    return clonedDeps;
  } finally {
    endResourceJob(job);
  }
};

/**
 * 失主补偿——尽力移除本轮新建的 worktree（含 git 注册）。
 * copy/clone 段失主也走这里，避免终态任务留下物理工作区。
 *
 * resourceJobs 超时后 fail-closed：quarantine，禁止在旧事务仍可写盘时清 worktree。
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
  // 补偿本身是资源事务——登记 job 让 stop/finalize/DELETE join 看得见
  const compensateJob = beginResourceJob(task.id);
  try {
    // 快照与活跃态读 ./task-op 叶子模块（静态 import，见文件头）。

    /** 现查：后继已 claim / 活跃 → 本仓不得删 */
    const hasSuccessorNow = (): boolean => {
      const fresh = snapshotTaskOp(task.id);
      const hasSuccessorClaim =
        fresh.claimSeq !== entryHandle.claimSeq ||
        (fresh.opId != null && fresh.opId !== entryHandle.opId);
      const hasActiveSuccessor =
        isTaskRunning(task.id) || hasTaskAgentSession(task.id);
      return hasSuccessorClaim || hasActiveSuccessor;
    };

    for (const repoPath of [...createdRepos]) {
      const idx = task.repoPaths.indexOf(repoPath);
      if (idx < 0) continue;
      const workDir = workPaths[idx];
      try {
        // 测试可在此注入后继 B；紧接着现查——过了才 remove
        await failpoint("compensate.beforeRemove");
        if (hasSuccessorNow()) {
          const fresh = snapshotTaskOp(task.id);
          console.warn(
            `[task-worktrees] 失主补偿跳过仓 ${repoPath}——后继已 claim/活跃（task=${task.id} claimSeq ${entryHandle.claimSeq}→${fresh.claimSeq} opId ${entryHandle.opId}→${fresh.opId} running=${isTaskRunning(task.id)} session=${hasTaskAgentSession(task.id)}）、留孤儿给当前 owner/finalize`,
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
          // fs.rm 同样紧前现查——remove 失败窗口内 B 可能已入场
          if (hasSuccessorNow()) {
            console.warn(
              `[task-worktrees] worktree remove 失败后跳过 fs.rm——后继已入场 workDir=${workDir}`,
            );
            continue;
          }
          await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
          await runGit(repoPath, ["worktree", "prune"]);
        }
      } catch (err) {
        console.warn(
          `[task-worktrees] 失主补偿移除 worktree 失败（尽力而为）：${workDir}`,
          err,
        );
      }
    }
    createdRepos.length = 0;
  } finally {
    endResourceJob(compensateJob);
  }
};

/** ensure 主体（lease 检查点贯穿全生命周期） */
const ensureTaskWorktreesInner = async (ctx: {
  task: Task;
  infos: GitBranchInfo[];
  infoByRepo: Map<string, GitBranchInfo>;
  workPaths: string[];
  createdRepos: string[];
  clonedDeps: DepPrepareEntry[];
  assertLease: () => void;
  lease: () => boolean;
  /** ensure 入场 ownership 快照（补偿身份比对） */
  entryHandle: { opId: number | null; gen: number; claimSeq: number };
  /** resource job——长 git / cp 子进程挂 abort */
  job: ResourceJobHandle;
  selection: NonNullable<EnsureWorktreesOptions["branchSelection"]>;
  /** true = 跳过同步 dep clone（oneshot skip / 正式路径 defer） */
  skipDepClone: boolean;
  /** true = 同步 clone 照做、但不跑依赖初始化命令（prewarm，见 EnsureWorktreesOptions.skipDepSetup） */
  skipDepSetup: boolean;
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
    selection,
    skipDepClone,
    skipDepSetup,
  } = ctx;

  // 根目录 mkdir 前插桩 + 验 lease（旧实现 mkdir 在首次 lease 前）
  await failpoint("ensure.beforeMkdir");
  assertLease();
  await fs.mkdir(getTaskWorktreesDir(task.id), { recursive: true });
  // 解绑后残留的旧短名目录（活任务开机孤儿扫描扫不到）
  await pruneUnmappedTaskWorktreeDirs(task);

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
    // flowship 必须有规划分支；explicit 某仓解析不到 → 当 detached 处理（帮切是锦上添花）
    if (!info && selection.kind === "flowship") {
      throw new Error(`仓库 ${repoPath} 缺少目标分支信息，无法准备隔离工作区`);
    }

    // 分支名白名单：拒空串 / 前导 - / 空白 / .. / 非法 ref 字符（防 git argv 当 flag）
    const branch = info?.name ?? "";
    if (info && !isSafeBranchName(branch)) {
      throw new Error(
        `仓库 ${repoPath} 任务分支名非法「${branch}」、拒绝创建 / 切换隔离工作区`,
      );
    }

    // 已存在且是合法工作区 → 复用（幂等热路径、每次推进都会走到）。
    // 必须校验当前分支：用户 / agent 可能在 worktree 里手动 checkout 切走，
    // 旧实现只查 is-inside-work-tree 就 continue，后续推进会静默在错误分支上干活。
    // 顺手补克隆依赖目录（老 worktree 建于克隆功能上线前 / 上次克隆失败）——
    // 缺依赖会连锁炸 pre-commit hook / lint / typecheck（实测：dev 联调 agent 被迫 --no-verify）
    //
    // rev-parse 没过只说明「这次 git 没跑通」，不等于目录坏了（超时 / 负载 / 权限 / git 不在 PATH
    // 都会 ok:false）——是否真坏要看下面「半截目录」处的结构判定（N10-02），这里只记下 stderr 供报错带上。
    let reuseCheckStderr = "";
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
        if (info && currentBranch !== branch) {
          // 已有 worktree 的 hot checkout 前插桩 + 验 lease
          await failpoint("ensure.beforeHotCheckout");
          assertLease();
          // hot checkout 挂 abort——stop/finalize revoke 可中止
          let checkoutArgs = ["checkout", branch];
          /** explicit 找不到现成分支时跳过帮切，不硬拦 */
          let skipCheckout = false;
          if (selection.kind === "explicit") {
            await runGit(repoPath, ["fetch", "origin", branch], 30_000, job);
            assertLease();
            const localExists = (
              await runGit(
                repoPath,
                ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
                60_000,
                job,
              )
            ).ok;
            const remoteExists = (
              await runGit(
                repoPath,
                ["rev-parse", "--verify", "--quiet", `origin/${branch}`],
                60_000,
                job,
              )
            ).ok;
            if (!localExists && !remoteExists) {
              console.warn(
                `[task-worktrees] 跳过帮切：仓库 ${repoPath} 找不到业务分支「${branch}」（本地 / origin 均不存在）`,
              );
              skipCheckout = true;
            } else if (!localExists && remoteExists) {
              checkoutArgs = [
                "checkout",
                "--no-track",
                "-b",
                branch,
                `origin/${branch}`,
              ];
            }
          } else if (selection.kind === "flowship" && !currentBranch) {
            // detached 预热后的首次旧流程推进：分支尚不存在时在当前基线原地创建；
            // 若远端已有同名分支则优先承接远端，不另造历史。
            await runGit(repoPath, ["fetch", "origin", branch], 30_000, job);
            assertLease();
            const localExists = (
              await runGit(
                repoPath,
                ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
                60_000,
                job,
              )
            ).ok;
            const remoteExists = (
              await runGit(
                repoPath,
                ["rev-parse", "--verify", "--quiet", `origin/${branch}`],
                60_000,
                job,
              )
            ).ok;
            if (!localExists) {
              checkoutArgs = remoteExists
                ? [
                    "checkout",
                    "--no-track",
                    "-b",
                    branch,
                    `origin/${branch}`,
                  ]
                : ["checkout", "--no-track", "-b", branch];
            }
          }
          if (!skipCheckout) {
            const switched = await runGit(workDir, checkoutArgs, 60_000, job);
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
        }
        // 热路径 dep clone：oneshot/defer 跳过同步拷贝；正式路径逐单元验 lease
        if (!skipDepClone) {
          const prepared = await cloneDepDirs(repoPath, workDir, assertLease, job, {
            skipSetup: skipDepSetup,
          });
          if (prepared.dirs.length > 0 || prepared.setup) {
            clonedDeps.push({ repoPath, ...prepared });
          }
        }
        continue;
      }
      reuseCheckStderr = check.stderr;
    }

    // 进入「需要新建」路径——先插桩再验 lease。
    // 矩阵降级用例在此挂起（空仓尚无 base/branch、若放 add 前会被「找不到线上分支」提前抛出）。
    // 真 add / retry 前另有 assertLease + 同名 failpoint。
    await failpoint("ensure.beforeWorktreeAdd");
    // 半截目录清掉重来——exists 可 await；清理动作紧前同步重验 lease，
    // 无 await 夹缝（递归 rm 本身不可中止、靠 ResourceJob + quarantine 兜）。
    // 目录已存在却没走通上面的复用，按 `.git` 的**结构**分四档（N10-02，不再只凭一次 rev-parse 失败就下结论）：
    //  - 确定没有 `.git`：真·半截目录（只有依赖克隆残留）、照旧删；
    //  - 有正面证据表明结构已坏（主仓在但 worktree 登记没了、`.git` 文件被截断、HEAD 空 / 非法、悬空软链等）：
    //    里面可能还有用户未提交的改动，改名隔离保留、不直接 rm（S03-01），随后重建；
    //  - 主仓 / 挂载点不可达（外接盘没挂载等，M6-01）：同样**不动目录**，但报错单独点明「主仓暂时不可达」，
    //    主仓恢复后下次推进自然重试——隔离了也重建不了（主仓不在），用户只会看到改动凭空消失；
    //  - 结构完好或读不出来：rev-parse 多半是临时失败（超时 / 负载 / 权限），**不动目录**、抛错让调用方稍后重试——
    //    误判成「坏了」会把好好的工作区改名移走、用户看到「改动消失」，而重建本身还可能因同一原因失败。
    if (await pathExists(workDir)) {
      assertLease();
      const inspection = await inspectWorkDirGit(workDir, repoPath);
      const detail = reuseCheckStderr.trim().slice(0, 300);
      if (inspection.state === "absent") {
        await fs.rm(workDir, { recursive: true, force: true });
      } else if (inspection.state === "broken") {
        // 改名失败会抛错、向上当 ensure 失败；绝不落到下面的 rm（R2-01）
        await isolateBrokenWorkDir(workDir, inspection.reason);
      } else if (inspection.unreachablePath) {
        throw new Error(
          `仓库 ${repoPath} 的工作区 ${workDir} 这次 git 校验没通过${detail ? `（${detail}）` : ""}，` +
            `原因是主仓暂时不可达（是否未挂载？）：${inspection.unreachablePath}（${inspection.reason}）。` +
            `此时无法判断目录有没有坏，为避免把有未提交改动的工作区误当成坏目录改名移走，已保留原目录、未做任何改动。` +
            `请确认主仓所在磁盘 / 网络盘已挂载且可读；恢复后下次推进会自动重试，无需手动处理。`,
        );
      } else {
        const why =
          inspection.state === "intact"
            ? ".git 指针与 gitdir 结构看起来完好"
            : `无法确认 .git 的结构（${inspection.reason ?? "读取失败"}）`;
        throw new Error(
          `仓库 ${repoPath} 的工作区 ${workDir} 这次 git 校验没通过${detail ? `（${detail}）` : ""}，` +
            `但${why}，没有证据表明目录已损坏（更像临时问题：机器负载 / 超时 / 权限）；` +
            `为避免把有未提交改动的工作区误当成坏目录改名移走，已保留原目录、未做任何改动。请稍后重试；` +
            `若反复失败，请手动检查该目录里 git 是否能正常运行（如 safe.directory / 权限）。`,
        );
      }
    } else {
      // 无旧目录也要验——与原先「进新建路径必验」对齐（finalize 已接管则让位）
      assertLease();
    }
    // 清「目录没了但 git 还记着」的僵尸 worktree 注册（否则 add 同路径报错）
    await runGit(repoPath, ["worktree", "prune"], 60_000, job);

    // addArgs 存下来：撞「已删任务孤儿占用」时可 force-remove 后原样重试一次
    let addArgs: string[];
    let resolvedBase = info?.baseBranch ?? "";

    // detached 预热只建立物理隔离，不创建 / 占用任何业务分支。
    if (!info) {
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
      if (!base || !isSafeBranchName(base)) {
        throw new Error(
          `仓库 ${repoPath} 探不到合法主分支——去设置页给该仓配「线上分支」后重试`,
        );
      }
      await runGit(repoPath, ["fetch", "origin", base], 30_000, job);
      assertLease();
      const remoteBase = (
        await runGit(
          repoPath,
          ["rev-parse", "--verify", "--quiet", `origin/${base}`],
          60_000,
          job,
        )
      ).ok;
      const localBase = (
        await runGit(
          repoPath,
          ["show-ref", "--verify", "--quiet", `refs/heads/${base}`],
          60_000,
          job,
        )
      ).ok;
      const startPoint = remoteBase ? `origin/${base}` : localBase ? base : "";
      if (!startPoint) {
        throw new Error(`仓库 ${repoPath} 找不到线上分支「${base}」（远程 / 本地都没有）`);
      }
      resolvedBase = base;
      addArgs = ["worktree", "add", "--detach", workDir, startPoint];
    } else {
      const localBranchExists = (
        await runGit(
          repoPath,
          ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
          60_000,
          job,
        )
      ).ok;
      if (localBranchExists) {
        // 本地已有任务分支（返工 / 用户自己建过）→ 直接挂到 worktree
        addArgs = ["worktree", "add", workDir, branch];
      } else {
        // 远程可能有同名分支（用户在别的机器 / 之前推过）→ fetch 后基于它建本地。
        // best-effort、30s 上限：fetch 只是「拿最新」的锦上添花、慢网络 / 被墙远程（github）
        // 挂太久会把整个推进卡住（实测 120s×2 把 advance 拖到 4 分钟+）、超时就用本地现有引用
        await runGit(repoPath, ["fetch", "origin", branch], 30_000, job);
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
        } else if (selection.kind === "explicit") {
          // 帮切找不到现成分支 → 退回 detached 物理隔离，不硬拦（规范侧自己管分支）
          console.warn(
            `[task-worktrees] 跳过帮切、改 detached：仓库 ${repoPath} 找不到业务分支「${branch}」`,
          );
          let base = task.repoBaseBranches?.[repoPath]?.trim() ?? "";
          if (!base) {
            const head = await runGit(
              repoPath,
              ["symbolic-ref", "refs/remotes/origin/HEAD"],
              60_000,
              job,
            );
            base = head.ok
              ? head.stdout.replace("refs/remotes/origin/", "")
              : "";
          }
          if (!base || !isSafeBranchName(base)) {
            throw new Error(
              `仓库 ${repoPath} 探不到合法主分支——去设置页给该仓配「线上分支」后重试`,
            );
          }
          await runGit(repoPath, ["fetch", "origin", base], 30_000, job);
          assertLease();
          const remoteBase = (
            await runGit(
              repoPath,
              ["rev-parse", "--verify", "--quiet", `origin/${base}`],
              60_000,
              job,
            )
          ).ok;
          const localBase = (
            await runGit(
              repoPath,
              ["show-ref", "--verify", "--quiet", `refs/heads/${base}`],
              60_000,
              job,
            )
          ).ok;
          const startPoint = remoteBase
            ? `origin/${base}`
            : localBase
              ? base
              : "";
          if (!startPoint) {
            throw new Error(
              `仓库 ${repoPath} 找不到线上分支「${base}」（远程 / 本地都没有）`,
            );
          }
          resolvedBase = base;
          addArgs = ["worktree", "add", "--detach", workDir, startPoint];
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
            base = head.ok
              ? head.stdout.replace("refs/remotes/origin/", "")
              : "";
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
          await runGit(repoPath, ["fetch", "origin", base], 30_000, job);
          assertLease();
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
    }

    // 每次 `git worktree add`（含孤儿自愈后的 retry）前验 lease + 插桩
    // 测试矩阵按此名注入（ensure.beforeWorktreeAdd）
    await failpoint("ensure.beforeWorktreeAdd");
    assertLease();
    // worktree add（可达 120s）挂 abort
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
      const hint = isWorktreeOccupancyStderr(added.stderr)
        ? "——该分支已在原仓库或其它任务的工作区检出：去原仓库把这个分支切走（checkout 别的分支）、或删掉占用它的任务后重试；若本机还开着另一个实例（正式 / test）、检查是否它的工作区占用了该分支"
        : "";
      throw new Error(
        `仓库 ${repoPath} 创建隔离工作区失败（${info ? `分支 ${branch}` : "detached 预热"}）：${added.stderr || added.stdout}${hint}`,
      );
    }

    // add 成功即记入本轮新建——后续 copy/clone 失主一并补偿
    createdRepos.push(repoPath);

    // add 成功后（可达 120s）再验一次——失主立即补偿
    await failpoint("worktree.afterAdd");
    if (!lease()) {
      await yieldAfterCompensate();
    }

    if (info) info.baseBranch = resolvedBase;
    // .env copy / dep clone 前与期间验 lease；失主补偿本轮新建
    try {
      assertLease();
      await copyRootEnvFiles(repoPath, workDir);
      // dep clone：oneshot/defer 跳过同步拷贝（600s 大头挪后台 / 答疑不需要）
      if (!skipDepClone) {
        const prepared = await cloneDepDirs(repoPath, workDir, assertLease, job, {
          skipSetup: skipDepSetup,
        });
        if (prepared.dirs.length > 0 || prepared.setup) {
          clonedDeps.push({ repoPath, ...prepared });
        }
      }
    } catch (err) {
      if (err instanceof WorktreeLeaseLostError) {
        await yieldAfterCompensate();
      }
      throw err;
    }
  }

  // 全部完成后结束复查（插桩在验 lease 前，矩阵可在此翻 lease）
  await failpoint("ensure.afterAllDone");
  if (!lease()) {
    await yieldAfterCompensate();
  }

  return { infos, createdRepos, clonedDeps };
};

/**
 * 依赖准备编排（V0.10.1 上线 node_modules 克隆、V0.11.3 泛化多语言白名单、本版补全 monorepo / 原子化 / 初始化命令）。
 * 可克隆目录的白名单与发现逻辑见 worktree-deps.ts（{@link discoverDepDirs}）。
 */

/** 依赖初始化命令超时（yarn / pnpm install 大仓可达数分钟） */
const DEP_SETUP_TIMEOUT_MS = 15 * 60_000;
/** 初始化命令失败后最多再试一次（避免每次启动 agent 都重跑一条必挂的命令） */
const DEP_SETUP_MAX_ATTEMPTS = 2;

/** 克隆中转目录名（挂在 worktrees 根下：开机孤儿扫描天然会清掉崩溃遗留） */
const DEP_CLONE_TMP_DIRNAME = ".dep-clone-tmp";

/** 某任务的克隆中转目录：cp 先落这里、完整后再 rename 到位，保证 node_modules 要么完整要么不存在 */
const getDepCloneTmpDir = (taskId: string): string =>
  path.join(getWorktreesRoot(), DEP_CLONE_TMP_DIRNAME, taskId);

/** 同一 worktree 的依赖准备串行（prewarm 与推进启动的后台补齐可能撞车：别两份 cp / 两遍 install 并发写同一目录） */
type DepPrepareGlobals = { __flowshipDepPrepareChains?: Map<string, Promise<void>> };
const getDepPrepareChains = (): Map<string, Promise<void>> => {
  const g = globalThis as DepPrepareGlobals;
  if (!g.__flowshipDepPrepareChains) g.__flowshipDepPrepareChains = new Map();
  return g.__flowshipDepPrepareChains;
};
const withDepPrepareLock = async <T>(
  key: string,
  fn: () => Promise<T>,
): Promise<T> => {
  const chains = getDepPrepareChains();
  const prev = chains.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  chains.set(key, tail);
  try {
    return await run;
  } finally {
    if (chains.get(key) === tail) chains.delete(key);
  }
};

const splitRel = (rel: string): string[] => rel.split("/");

/** 需要克隆的依赖目录：原仓有、worktree 没有、且 worktree 里存在它的父目录（不凭空建目录污染检出） */
const planDepClone = async (
  repoPath: string,
  workDir: string,
): Promise<string[]> => {
  const out: string[] = [];
  for (const rel of await discoverDepDirs(repoPath)) {
    const dst = path.join(workDir, ...splitRel(rel));
    if (await pathExists(dst)) continue;
    // 任务分支里没有这个子包目录（新分支缺包）→ 跳过；根目录级父目录就是 workDir、恒存在
    if (!(await pathExists(path.dirname(dst)))) continue;
    out.push(rel);
  }
  return out;
};

/**
 * 该目录名是否是仓库已提交（HEAD 树里有这个条目）的内容——检出自带的、不是 install / 克隆产物。
 * 用 `ls-tree --name-only HEAD -- <name>`：只输出一行，对提交了几十万文件的 vendor/ 也是 O(1) 量级
 * （`ls-files` 会把整个目录列出来、撞 maxBuffer）。git 失败 / 超时 = 判断不了 → false，保持旧口径
 * （目录在就算依赖已就位）。
 */
const isTrackedAtHead = async (
  workDir: string,
  name: string,
): Promise<boolean> => {
  const r = await runGit(workDir, ["ls-tree", "--name-only", "HEAD", "--", name], 15_000);
  return r.ok && r.stdout.split("\n").some((l) => l.trim() === name);
};

/**
 * worktree 根目录下是否已有任一白名单依赖目录（有 = 视为依赖已就位、不再跑初始化命令）。
 * 仓库已提交的目录（如 Go vendor 模式提交进仓库的 `vendor/`）不算：它随检出就在，
 * 并不说明依赖装过——否则配了初始化命令的仓永远不会执行（F5-03）。
 */
const hasAnyRootDepDir = async (workDir: string): Promise<boolean> => {
  for (const d of ROOT_DEP_DIRS) {
    if (!(await pathExists(path.join(workDir, d)))) continue;
    if (await isTrackedAtHead(workDir, d)) continue;
    return true;
  }
  return false;
};

/** worktree 私有 gitdir（`.git` 指针文件里的 gitdir:）——放标记文件、不进工作区、随 worktree 删除 */
const readWorktreeGitDir = async (workDir: string): Promise<string | null> => {
  try {
    const text = await fs.readFile(path.join(workDir, ".git"), "utf8");
    const m = text.match(/^gitdir:\s*(.+)$/m);
    if (!m) return null;
    // 相对指针必须走 resolveGitPointer（按 workDir 的 realpath 解析），不能 `path.resolve(workDir, p)` 字面量折叠：
    // git>=2.48 `worktree.useRelativePaths` 写出的相对指针，在 workDir 路径含软链时会被折叠到一个不存在的位置——
    // 标记读不到、写也写不进去（写入处吞了错），「命令最多试 2 次」的去重就失效、每次启动 agent 都重跑 install。
    // realpath 取不到返回 null：调用方按「不是真 worktree、不冒险反复执行」处理，不退回字面量。
    return await resolveGitPointer(workDir, m[1].trim());
  } catch {
    return null;
  }
};
export const __readWorktreeGitDirForTest = readWorktreeGitDir;

interface DepSetupMarker {
  command: string;
  ok: boolean;
  attempts: number;
  /**
   * 命令开跑前先落的标记、结束时被覆盖——读到 true 说明上次跑到一半进程就没了（崩溃 / 被杀），
   * 依赖目录可能是半截货。旧版本落的标记没有这个字段、按 false 处理。
   */
  started?: boolean;
  /** 命令失败 / 超时 / 被中止时，依赖目录已被它建出来了（可能是半截货） */
  leftDeps?: boolean;
}

const DEP_SETUP_MARKER_FILE = "flowship-dep-setup.json";

const readDepSetupMarker = async (
  gitDir: string,
): Promise<DepSetupMarker | null> => {
  try {
    const raw = JSON.parse(
      await fs.readFile(path.join(gitDir, DEP_SETUP_MARKER_FILE), "utf8"),
    ) as Partial<DepSetupMarker>;
    if (typeof raw.command !== "string") return null;
    return {
      command: raw.command,
      ok: raw.ok === true,
      attempts: typeof raw.attempts === "number" ? raw.attempts : 1,
      started: raw.started === true,
      leftDeps: raw.leftDeps === true,
    };
  } catch {
    return null;
  }
};

/**
 * 这条初始化命令在该 worktree 上是否还「该跑」。
 *
 * - 没跑过 / 命令换了：主路径——已有依赖目录（用户 / 克隆 / agent 自装的完好依赖）就不跑
 * - 同一条命令成功过 / 已试满次数：不再跑
 * - 同一条命令上次没成功、次数没用完：没有依赖目录 → 重试；有依赖目录时**只有**目录是它自己留下的
 *   半截货（崩溃时没落结束标记 / 失败·超时·中止时建出了目录）才重试——
 *   不能「有目录就一律不跑」：半截 node_modules 会让它永远不重试（F5-02）；
 *   也不能「有目录就一律重试」：命令干净失败（没建目录）后 agent 自己装好的完好依赖不该被再覆盖一遍。
 */
const setupStillDue = (
  marker: DepSetupMarker | null,
  command: string,
  hasDeps: boolean,
): boolean => {
  if (!marker || marker.command !== command) return !hasDeps;
  if (marker.ok || marker.attempts >= DEP_SETUP_MAX_ATTEMPTS) return false;
  return !hasDeps || marker.started === true || marker.leftDeps === true;
};

/**
 * 读盘判定这条命令此刻该不该跑（{@link runDepSetupIfDue} 与 {@link buildDepPrepareHint} 共用同一口径，
 * 免得提示说「正在后台执行」而实际没跑、或反过来）。拿不到标记落点（不是真 worktree）一律不跑。
 */
const inspectDepSetup = async (
  workDir: string,
  command: string,
): Promise<{
  due: boolean;
  /** 命令此刻正在执行（仅提示用）：开跑前已预占 attempts，最后一次重试在跑时 due 会是 false，提示不能因此哑掉 */
  running: boolean;
  gitDir: string | null;
  marker: DepSetupMarker | null;
}> => {
  const hasDeps = await hasAnyRootDepDir(workDir);
  const gitDir = await readWorktreeGitDir(workDir);
  const marker = gitDir ? await readDepSetupMarker(gitDir) : null;
  return {
    due: gitDir !== null && setupStillDue(marker, command, hasDeps),
    // 标记显示这条命令已开跑、且此刻确有一路 prepare 握着该 worktree 的锁——不靠标记单独判断，
    // 否则「崩溃后留下的 started」会被永远当成正在执行
    running:
      !!marker &&
      marker.command === command &&
      marker.started === true &&
      !marker.ok &&
      getDepPrepareChains().has(workDir),
    gitDir,
    marker,
  };
};

/**
 * 依赖准备（克隆 + 初始化命令兜底），幂等、可反复调。
 *
 * 1. 依赖目录秒级克隆：原仓库有白名单依赖目录（根目录 node_modules / vendor / Pods，
 *    以及 monorepo 各子包的 node_modules）时用 APFS copy-on-write 克隆（mac `cp -Rc`、clonefile(2)）：
 *    不走网络、秒到几十秒、磁盘块共享几乎不占空间、postinstall 产物原样带过来。
 *    两边是独立副本（非 symlink）、互不污染；分支间依赖有差异时 agent 增量 install 补齐。
 *    - **原子化**：先克隆到 `worktrees/.dep-clone-tmp/<taskId>/` 再 rename 到位——
 *      克隆期间 worktree 里看不到半截 node_modules（agent 不会误判环境就绪、也不会和 cp 抢写）。
 *    - 克隆后：删 `node_modules/.cache`（里面是原仓绝对路径）、改写 `.bin` 里写死原仓路径的 shim（pnpm）。
 * 2. 初始化命令兜底：本次一个依赖目录都没克隆出来、worktree 根目录也没有（仓库之外的）依赖目录
 *    （非 mac / 克隆失败 / 原仓没装过依赖）、且设置页给该仓配了「依赖初始化命令」时，
 *    在 worktree 里执行（标记文件去重、最多 2 次；上次自己失败 / 中止 / 崩溃留下半截目录也会重试，
 *    见 {@link setupStillDue}）。仓库已提交的 `vendor/` 之类不算「已有依赖」。
 *
 * 失败（跨卷 / 非 APFS / 非 mac / 命令失败）都只 warn、回退 agent 自装。lease 失效 / revoke 抛
 * {@link WorktreeLeaseLostError}（不吞）。
 * @returns 本次克隆到的依赖目录（相对路径）与初始化命令执行情况
 */
const cloneDepDirs = (
  repoPath: string,
  workDir: string,
  /** 每个 dep 单元真正开 clone 前验 lease（必填由调用方传入） */
  assertLease: () => void,
  /** resource job——`cp -Rc` / 初始化命令（可达十余分钟）挂 abort */
  job: ResourceJobHandle,
  /** skipSetup：只克隆、不跑依赖初始化命令（prewarm，见 EnsureWorktreesOptions.skipDepSetup） */
  opts?: { skipSetup?: boolean },
): Promise<{ dirs: string[]; setup?: DepSetupOutcome }> =>
  withDepPrepareLock(workDir, () =>
    cloneDepDirsLocked(repoPath, workDir, assertLease, job, opts),
  );

const cloneDepDirsLocked = async (
  repoPath: string,
  workDir: string,
  assertLease: () => void,
  job: ResourceJobHandle,
  opts?: { skipSetup?: boolean },
): Promise<{ dirs: string[]; setup?: DepSetupOutcome }> => {
  const cloned: string[] = [];
  for (const rel of await planDepClone(repoPath, workDir)) {
    const src = path.join(repoPath, ...splitRel(rel));
    const dst = path.join(workDir, ...splitRel(rel));
    // 锁内重查：等锁期间别的调用 / agent 自己 install 可能已经建好了
    if (await pathExists(dst)) continue;
    // 每个 dep 单元前插桩 + 验 lease（600s 大头、循环内逐单元）
    // 平台跳过也放在验 lease 之后——finalize 让位窗口与 darwin 一致可测
    await failpoint("ensure.beforeDepClone");
    assertLease();
    if (process.platform !== "darwin") continue; // clonefile 仅 APFS、其它平台走初始化命令 / agent 自装

    const tmpDir = getDepCloneTmpDir(job.taskId);
    const tmp = path.join(
      tmpDir,
      `${rel.replace(/\//g, "__")}-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    );
    // cp -Rc 挂 AbortController——revoke 中止后清半截残留并让位
    const ac = new AbortController();
    registerJobAbort(job.taskId, job.jobId, () => ac.abort());
    try {
      await fs.mkdir(tmpDir, { recursive: true });
      // -c = clonefile；大目录（几十万文件）逐文件克隆也只是元数据操作、给足超时
      await execFileAsync("cp", ["-Rc", src, tmp], {
        timeout: 600_000,
        signal: ac.signal,
      });
      // 构建工具缓存必须删（V0.13.x、用户实测「worktree 里 dev server 热更新极慢 /
      // 刷新一直 loading」）：webpack / babel / vue-cli 等的 node_modules/.cache 里
      // 记录的是**原仓库的绝对路径**、克隆过来后路径全错——dev server 每次都缓存
      // 失配 → 全量重编译。删掉让它在 worktree 里冷启动重建正确缓存、之后热更新正常。
      if (path.posix.basename(rel) === "node_modules") {
        await fs
          .rm(path.join(tmp, ".cache"), { recursive: true, force: true })
          .catch(() => {});
        // pnpm 的 .bin shim 写死原仓库绝对路径（NODE_PATH）——改写成 worktree 路径
        const realRepo = await fs.realpath(repoPath).catch(() => repoPath);
        await rewriteBinShimPaths(tmp, [repoPath, realRepo], workDir).catch(
          () => 0,
        );
      }
      // 测试挂点：cp 已完成、rename 未发生——此刻 worktree 里必须还看不到目标目录（原子性不变量）
      await failpoint("ensure.afterDepCloneBeforeRename");
      // rename 前再验一次：lease 已失 → 丢弃中转目录让位（不把半成品暴露给后继）
      assertLease();
      if (await pathExists(dst)) {
        // 克隆期间 agent 已自己装好了依赖（或 worktree 被别的路径填了）——不覆盖、丢弃中转副本
        await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
        console.log(
          `[task-worktrees] 依赖目录 ${rel} 克隆期间目标已存在、丢弃中转副本 repo=${repoPath}`,
        );
        continue;
      }
      await fs.rename(tmp, dst);
      cloned.push(rel);
    } catch (err) {
      // abort 后半截清理仍在同一 ResourceJob 内（外层 ensure finally 才 end）——
      // 此处先清残留再清 abort 登记；慢 rm 期间 join 仍看见 job，超时走 quarantine。
      await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
      // lease 让位 / revoke abort 必须冒泡（不可当 clone 失败静默吞掉）
      if (err instanceof WorktreeLeaseLostError) throw err;
      if (isExecAborted(err, ac.signal)) {
        throw new WorktreeLeaseLostError(
          "依赖克隆 cp 子进程被 revoke 中止、资源操作让位",
        );
      }
      console.warn(
        `[task-worktrees] 依赖目录 ${rel} 克隆失败（回退初始化命令 / agent 自装）repo=${repoPath}：`,
        err,
      );
    } finally {
      registerJobAbort(job.taskId, job.jobId, null);
    }
  }
  // 中转目录已空（rename 走了内容）——顺手清掉空壳、不留垃圾
  if (cloned.length > 0) {
    await fs.rmdir(getDepCloneTmpDir(job.taskId)).catch(() => {});
  }

  const setup =
    cloned.length === 0 && !opts?.skipSetup
      ? await runDepSetupIfDue(repoPath, workDir, assertLease, job)
      : undefined;
  return setup ? { dirs: cloned, setup } : { dirs: cloned };
};

/**
 * 依赖初始化命令兜底：没克隆出任何依赖目录、且设置页给该仓配了命令、
 * 且这条命令在该 worktree 上还「该跑」（见 {@link setupStillDue}：已有完好依赖目录就不跑、
 * 自己失败 / 中止 / 崩溃留下半截目录则仍重试）时执行。
 * 失败只 warn（结果带回给调用方写事件）；revoke 中止抛 {@link WorktreeLeaseLostError}。
 */
const runDepSetupIfDue = async (
  repoPath: string,
  workDir: string,
  assertLease: () => void,
  job: ResourceJobHandle,
): Promise<DepSetupOutcome | undefined> => {
  const command = await getRepoSetupCommand(repoPath);
  if (!command) return undefined;
  // gitDir 为 null = 不是真 worktree（拿不到标记落点）——不冒险反复执行（inspectDepSetup 里 due=false）
  const { due, gitDir, marker } = await inspectDepSetup(workDir, command);
  if (!due || !gitDir) return undefined;

  await failpoint("ensure.beforeDepSetup");
  assertLease();
  const prevAttempts = marker && marker.command === command ? marker.attempts : 0;
  const writeMarker = (m: DepSetupMarker) =>
    fs
      .writeFile(
        path.join(gitDir, DEP_SETUP_MARKER_FILE),
        JSON.stringify({ ...m, at: Date.now() }),
      )
      .catch(() => {});
  // 开跑前先落「started」：进程在命令跑到一半时崩溃 / 被杀，结束标记永远写不出来——
  // 没有这一步，下次看到的是「没有标记 + 半截 node_modules」，会被当成用户自己的依赖而永不重试。
  // attempts 同时预先 +1，崩溃循环也受「最多 2 次」约束。
  await writeMarker({ command, ok: false, attempts: prevAttempts + 1, started: true });
  const ac = new AbortController();
  registerJobAbort(job.taskId, job.jobId, () => ac.abort());
  let result: SetupRunResult;
  try {
    result = await runSetupCommand(command, workDir, {
      rootWorktreePath: repoPath,
      timeoutMs: DEP_SETUP_TIMEOUT_MS,
      signal: ac.signal,
    });
  } finally {
    registerJobAbort(job.taskId, job.jobId, null);
  }
  // revoke 中止：让位不是命令自己的错，不占重试次数（attempts 退回开跑前的值）；
  // 但命令已经动过依赖目录，要记下「可能留有半截目录」，下次同一条命令才会越过 hasAnyRootDepDir 重试
  if (result.aborted) {
    await writeMarker({
      command,
      ok: false,
      attempts: prevAttempts,
      leftDeps: await hasAnyRootDepDir(workDir),
    });
    throw new WorktreeLeaseLostError(
      "依赖初始化命令被 revoke 中止、资源操作让位",
    );
  }
  const attempts = prevAttempts + 1;
  await writeMarker({
    command,
    ok: result.ok,
    attempts,
    // 失败 / 超时时它自己是否留下了依赖目录（半截货）：只有这种目录才允许下次越过「已有依赖」重试
    leftDeps: !result.ok && (await hasAnyRootDepDir(workDir)),
  });
  if (result.ok) return { command, ok: true };
  const why = result.timedOut
    ? `超时（${DEP_SETUP_TIMEOUT_MS / 60_000} 分钟）`
    : `退出码 ${result.code ?? "未知"}`;
  const detail = `${why}${result.tail ? `：${result.tail.slice(-400)}` : ""}`;
  console.warn(
    `[task-worktrees] 依赖初始化命令失败（回退 agent 自装）repo=${repoPath} cmd=${command}：${detail}`,
  );
  return { command, ok: false, detail };
};

/**
 * 推进 agent 前的「依赖准备状态」提示（拼进 prompt、让 agent 知道别和系统抢）。
 * 只在有事可说时返回文案，没有则 undefined（不给 prompt 加噪音）：
 * - 依赖正在后台克隆 / 初始化命令还没跑：别自己 install、克隆期间 node_modules 不存在属正常
 * - 克隆来的依赖与任务分支锁文件不一致：跑构建 / 测试前先增量 install
 * - 本机无法克隆又没配初始化命令：需要依赖时自行安装
 * 纯读盘、不改任何东西；失败静默当没有提示。
 */
export const buildDepPrepareHint = async (
  task: Task,
): Promise<string | undefined> => {
  if (!isWorktreeTask(task)) return undefined;
  try {
    const workPaths = getTaskWorkRepoPaths(task);
    const lines: string[] = [];
    for (let i = 0; i < task.repoPaths.length; i++) {
      const repoPath = task.repoPaths[i];
      const workDir = workPaths[i];
      if (skipsWorktreeIsolation(task, repoPath)) continue;
      if (!(await pathExists(workDir))) continue;
      const name = repoPath.split("/").filter(Boolean).pop() ?? repoPath;
      const wantClone = await planDepClone(repoPath, workDir);
      const repoLines: string[] = [];

      if (wantClone.length > 0 && process.platform === "darwin") {
        repoLines.push(
          `依赖目录（${wantClone.some((d) => !d.includes("/")) ? "node_modules 等" : "子包 node_modules"}）正在从原仓库后台克隆（通常 30–90 秒，大仓更久）：克隆期间 \`node_modules\` 暂时不存在属正常——先做读 / 改代码这类不依赖它的工作；要跑 install / build / test 前先 \`ls node_modules\` 确认已出现。**不要此时自己 install**（会和克隆抢写同一目录）；等 3 分钟仍没出现再自行安装`,
        );
      } else if (wantClone.length > 0) {
        // 非 mac：克隆不可用——有没有初始化命令兜底
        const command = await getRepoSetupCommand(repoPath);
        if (command) {
          // 与 runDepSetupIfDue 同口径（含「半截目录仍重试」）：不能只看有没有依赖目录
          const st = await inspectDepSetup(workDir, command);
          if (st.due || st.running) {
            repoLines.push(
              `依赖正在后台执行设置页配置的初始化命令 \`${command}\`（可能耗时数分钟）：完成前别重复安装；事件流出现「依赖初始化命令执行完成」后再跑 build / test`,
            );
          }
        } else if (!(await hasAnyRootDepDir(workDir))) {
          repoLines.push(
            "本机不支持依赖目录秒级克隆、也没配「依赖初始化命令」：需要跑 install / build / test 前请先按仓库的包管理器自行安装依赖",
          );
        }
      } else {
        const command = await getRepoSetupCommand(repoPath);
        const st = command ? await inspectDepSetup(workDir, command) : null;
        if (command && st && (st.due || st.running)) {
          repoLines.push(
            `依赖正在后台执行设置页配置的初始化命令 \`${command}\`（可能耗时数分钟）：完成前别重复安装；事件流出现「依赖初始化命令执行完成」后再跑 build / test`,
          );
        }
      }

      // 锁文件漂移：克隆的是原仓库当前分支的依赖，任务分支锁文件不同时可能缺包 / 版本不对
      const nmDir = path.join(workDir, "node_modules");
      if ((await pathExists(nmDir)) || wantClone.includes("node_modules")) {
        const drift = await detectLockfileDrift(repoPath, workDir);
        if (drift.length > 0 && !(await installedSinceClone(nmDir))) {
          repoLines.push(
            `⚠️ ${drift.map((f) => `\`${f}\``).join("、")} 与原仓库不一致——克隆来的依赖来自原仓库当前分支、可能与本任务分支不匹配：跑 build / test 前先按仓库的包管理器做一次增量安装（如 \`yarn install --frozen-lockfile\` / \`pnpm install --frozen-lockfile\`），装完再继续`,
          );
        }
      }

      if (repoLines.length > 0) {
        lines.push(`- \`${name}\`：${repoLines.join("；")}`);
      }
    }
    if (lines.length === 0) return undefined;
    return ["**依赖准备状态（系统已处理 / 处理中，请先看这里）：**", ...lines].join(
      "\n",
    );
  } catch (err) {
    console.warn(`[task-worktrees] 生成依赖准备提示失败（忽略）task=${task.id}：`, err);
    return undefined;
  }
};

/**
 * node_modules 克隆之后是否又被安装过（有人在 worktree 里跑过 install）：
 * 安装器每次都会重写这几个元数据文件——mtime 比 node_modules 目录自身的创建时间（rename 落位时刻）晚，
 * 说明依赖已经被同步到任务分支，漂移提示不用再唠叨。birthtime 取不到（部分平台为 0）→ 当没装过。
 */
const installedSinceClone = async (nmDir: string): Promise<boolean> => {
  try {
    const born = (await fs.stat(nmDir)).birthtimeMs;
    if (!born) return false;
    for (const f of [".yarn-integrity", ".package-lock.json", ".modules.yaml"]) {
      try {
        const st = await fs.stat(path.join(nmDir, f));
        if (st.mtimeMs > born + 2000) return true;
      } catch {
        /* 该安装器的元数据文件不存在 */
      }
    }
  } catch {
    /* node_modules 不存在 */
  }
  return false;
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
    "-c", "user.name=flowship",
    "-c", "user.email=flowship@local",
    "commit", "--no-verify", "-m", "WIP：任务终结前自动快照（Flowship）",
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
  // 依赖克隆中转目录（cp 到一半被终止 / 崩溃的遗留）——无论 worktree 还在不在都清
  await fs
    .rm(getDepCloneTmpDir(t.id), { recursive: true, force: true })
    .catch(() => {});
  if (!(await pathExists(taskDir))) {
    return { removedAny: false, snapshotRepos: [], snapshotFailedRepos: [] };
  }

  // 测试挂点：pathExists 之后、第一次 git status / snapshot 之前——
  // 验证 reservation 已转 executing 时 reopen 409（含无 ResourceJob 的同步 finalize）；
  // 旧 remove 不得与 reopen/prewarm 并发写同路径。
  await failpoint("removeTaskWorktrees.afterPathExists");

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

/** 用户主动解绑时拆 / 挪 worktree 失败——调用方不得写 meta */
export class WorktreeUnbindError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorktreeUnbindError";
  }
}

export type SyncTaskWorktreesResult = {
  unboundRepos: string[];
  snapshotRepos: string[];
  snapshotFailedRepos: string[];
};

/**
 * 用户主动改仓：按旧短名拆已解绑仓的 worktree，再把仍绑着的仓挪到新短名。
 * 只读 / 非 git 从没建过 worktree，跳过（候选目录不存在也跳过，绝不对原仓下手）。
 * WIP 快照失败仍强制拆（对齐 removeTaskWorktrees）。拆 / 挪失败抛错。
 */
export const syncTaskWorktreesToRepoPaths = async (
  t: WorktreeTaskLike,
  oldRepoPaths: string[],
  newRepoPaths: string[],
): Promise<SyncTaskWorktreesResult> => {
  const oldLike: WorktreeTaskLike = { ...t, repoPaths: oldRepoPaths };
  const unboundRepos = oldRepoPaths.filter((p) => !newRepoPaths.includes(p));
  const empty: SyncTaskWorktreesResult = {
    unboundRepos,
    snapshotRepos: [],
    snapshotFailedRepos: [],
  };
  if (!isWorktreeTask(oldLike)) return empty;

  const taskDir = getTaskWorktreesDir(t.id);
  const planned = planWorktreeDirChanges(oldRepoPaths, newRepoPaths);
  const snapshotRepos: string[] = [];
  const snapshotFailedRepos: string[] = [];

  const forceRemove = async (
    repoPath: string,
    workDir: string,
  ): Promise<void> => {
    if (!(await pathExists(workDir))) return;
    const snap = await snapshotDirtyWorktree(workDir);
    if (snap === "snapshotted") snapshotRepos.push(repoPath);
    else if (snap === "failed") {
      console.warn(
        `[task-worktrees] 解绑仓 WIP 快照失败、仍强制删除 worktree：${workDir}`,
      );
      snapshotFailedRepos.push(repoPath);
    }
    const removed = await runGit(
      repoPath,
      ["worktree", "remove", "--force", workDir],
      60_000,
    );
    if (!removed.ok) {
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
      await runGit(repoPath, ["worktree", "prune"]);
    }
    if (await pathExists(workDir)) {
      throw new WorktreeUnbindError(
        `无法拆掉隔离工作区 ${workDir}：${removed.stderr || removed.stdout || "目录仍在"}`,
      );
    }
  };

  for (const item of planned.remove) {
    if (skipsWorktreeIsolation(oldLike, item.repoPath)) continue;
    await forceRemove(item.repoPath, path.join(taskDir, item.dirName));
  }

  const moves = planned.relocate.filter(
    (m) => !skipsWorktreeIsolation(oldLike, m.repoPath),
  );
  const pending: Array<{
    repoPath: string;
    from: string;
    to: string;
  }> = [];
  for (const m of moves) {
    const from = path.join(taskDir, m.fromName);
    const to = path.join(taskDir, m.toName);
    if (!(await pathExists(from))) continue;
    pending.push({ repoPath: m.repoPath, from, to });
  }

  const fromBasenames = new Set(pending.map((m) => path.basename(m.from)));
  const conflict = pending.some((m) => fromBasenames.has(path.basename(m.to)));
  const moveOne = async (
    repoPath: string,
    from: string,
    to: string,
  ): Promise<void> => {
    const moved = await runGit(repoPath, ["worktree", "move", from, to], 60_000);
    if (!moved.ok || !(await pathExists(to))) {
      throw new WorktreeUnbindError(
        `无法移动隔离工作区 ${from} → ${to}：${moved.stderr || moved.stdout || "目标不存在"}`,
      );
    }
  };

  if (!conflict) {
    for (const m of pending) {
      await moveOne(m.repoPath, m.from, m.to);
    }
  } else {
    const stamp = `${process.pid}-${Date.now()}`;
    const temps: Array<{
      repoPath: string;
      temp: string;
      from: string;
      to: string;
    }> = [];
    try {
      for (const m of pending) {
        const temp = `${m.from}.reloc-${stamp}`;
        await moveOne(m.repoPath, m.from, temp);
        temps.push({ ...m, temp });
      }
      for (const x of temps) {
        await moveOne(x.repoPath, x.temp, x.to);
      }
    } catch (err) {
      for (const x of temps) {
        if (await pathExists(x.temp)) {
          await runGit(x.repoPath, ["worktree", "move", x.temp, x.from], 60_000);
        }
      }
      throw err;
    }
  }

  return { unboundRepos, snapshotRepos, snapshotFailedRepos };
};

/**
 * 活任务兜底：容器里有、但不在当前短名映射里的子目录（解绑后残留的 foo-2）。
 * 开机孤儿扫描扫不到活 taskId 目录，所以 ensure 时自己剪。
 * `.reloc-*` 是两阶段挪目录的临时名，不动（失败回滚后还可能在）；
 * `.orphaned-*` 是 ensure 改名隔离的损坏工作区（保留未提交改动），同样不动。
 */
const pruneUnmappedTaskWorktreeDirs = async (
  t: WorktreeTaskLike,
): Promise<void> => {
  if (!isWorktreeTask(t)) return;
  const taskDir = getTaskWorktreesDir(t.id);
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(taskDir, { withFileTypes: true });
  } catch {
    return;
  }
  const names = getUniqueRepoDirNames(t.repoPaths);
  const keep = new Set(
    t.repoPaths
      .map((p, i) => (skipsWorktreeIsolation(t, p) ? null : names[i]))
      .filter((n): n is string => Boolean(n)),
  );
  for (const e of entries) {
    if (!e.isDirectory() || keep.has(e.name)) continue;
    if (e.name.includes(".reloc-")) continue;
    // 改名隔离保留的损坏 worktree（含用户未提交改动）：不自动清、留给用户处理
    if (e.name.includes(ORPHANED_DIR_MARK)) continue;
    const workDir = path.join(taskDir, e.name);
    let repoPath = "";
    try {
      const gitFile = await fs.readFile(path.join(workDir, ".git"), "utf8");
      const mainGitDir = parseMainGitDirFromPointer(gitFile);
      if (mainGitDir) repoPath = path.dirname(mainGitDir);
    } catch {
      /* 不是 worktree 指针、下面 rm 兜底 */
    }
    const snap = await snapshotDirtyWorktree(workDir);
    if (snap === "failed") {
      console.warn(
        `[task-worktrees] 未映射 worktree WIP 快照失败、仍强制删除：${workDir}`,
      );
    }
    if (repoPath) {
      const removed = await runGit(
        repoPath,
        ["worktree", "remove", "--force", workDir],
        60_000,
      );
      if (!removed.ok) {
        await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
        await runGit(repoPath, ["worktree", "prune"]);
      }
    } else {
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  }
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
