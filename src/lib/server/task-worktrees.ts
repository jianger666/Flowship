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
import { createHash, randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { existsSync, promises as fs, type Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";

import { dataRoot } from "./data-root";
import { failpoint } from "./failpoints";
import { GIT_MAX_BUFFER, gitEnv } from "./git-exec";
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
import { parseWorktreeStatusV2 } from "./worktree-status";
import {
  beginWorktreeAdd,
  describeLiveInitializing,
  isWorktreeAddInFlight,
  judgeInitializingLock,
  parseGitdirPointerValue,
  worktreePathFromAdminGitdirFile,
  type InitializingLockVerdict,
} from "./worktree-residue";
import {
  detectLockfileDrift,
  discoverDepDirs,
  ROOT_DEP_DIRS,
  rewriteBinShimPaths,
  runSetupCommand,
  type SetupRunResult,
} from "./worktree-deps";
import { getEffectiveCwd, getUniqueRepoDirNames, repoTail } from "@/lib/path-utils";
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
  /**
   * 任务分支记录（可选）——只给「删 worktree 前 WIP 快照」用：知道任务分支才能确认
   * worktree 的 HEAD 真的附着在它上面、再把 WIP commit 记到分支上；不传则沿用「HEAD 附着在哪个本地分支就记在哪个」。
   */
  gitBranches?: ReadonlyArray<{ repoPath: string; name: string }>;
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

/**
 * git 子进程 stdout/stderr 的容量上限（见 runGit 内注释；导出给测试断言「不再是 4MiB」）。
 * 定义在 git-exec.ts（git-branches / wk-source-branch 共用），这里保留原来的导出名。
 */
export { GIT_MAX_BUFFER };

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
  /** 额外环境变量（叠在清洗后的 process.env 上）；WIP 快照用 GIT_INDEX_FILE 指向临时 index */
  extraEnv?: Record<string, string>,
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
      // 守卫的 `status --porcelain=v2 -z --untracked-files=all` 每条记录比 v1 长约 3 倍，且 -uall 把整棵未跟踪目录
      // 展开：数万文件全改 / 新增（codemod、lint --fix、build 产物未进 .gitignore）轻松超 4MiB。超限不丢数据
      // （failed、保留目录），但会让大改动任务的归档 / 删除永远卡在「保留」——放大到 256MiB（只在真有输出时才占内存）
      maxBuffer: GIT_MAX_BUFFER,
      // 一律走 gitEnv()：worktree add / checkout 会触发用户仓的 post-checkout 等钩子（husky 里常有
      // `pnpm install` / `next build`），钩子整份继承 server 环境会吃到 ELECTRON_RUN_AS_NODE / PORT /
      // __NEXT_PRIVATE_STANDALONE_CONFIG，还会拿到 GitLab PAT。旧注释说「fetch 之类的 git 网络命令要靠 token 认证」
      // 不成立（git 不读这个变量，Flowship 调 GitLab 另有通道），详见 git-exec.ts 头注释；
      // 同时设 GIT_TERMINAL_PROMPT=0 / GCM_INTERACTIVE=never（没凭据就失败、不阻塞也不弹窗）。extraEnv 叠在最后。
      env: gitEnv(extraEnv),
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
      // `||` 而非 `??`：maxBuffer 超限 / 被信号杀时 e.stderr 是空串，`??` 不回落会让失败原因变成空（Q3-02）
      stderr: (e.stderr || e.message || "").trim(),
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

// ----------------- `git worktree add` 被硬杀的残留（R14 B5-2 / Q10-01） -----------------
//
// 判据与 live / stale 的划分见 worktree-residue.ts 头注释；这里是读盘、跑 git、动手的部分。
// 一句话：`<主仓>/.git/worktrees/<名>/locked` 停在 `initializing`、又没有活的 add 在跑（本进程在途登记 + 年龄 ≥ 5 分钟）
// → 半截检出残留。ensure 把目录改名隔离（不删文件）并 unlock（不碰分支）；6 处 `remove --force` 遇到它升级成 `--force --force`；
// 老版本留下的「目录没了、登记还锁着」的僵尸，在 prune 前先 unlock。三条路径都只对 stale 动手，live / 用户手动 lock 的一律不碰。

/** 比较用的规范形：正斜杠 + 去尾斜杠；Windows 再统一小写 */
const normForCompare = (p: string): string => {
  const n = normPath(p);
  return process.platform === "win32" ? n.toLowerCase() : n;
};

/**
 * 路径的规范形态：对最近的**存在**祖先取 realpath、再拼回不存在的尾段。
 * git 在登记里写 realpath（macOS 上 `/tmp` → `/private/tmp`，实测），而 add 之前目标目录还不存在，
 * 所以登记表 / 反查比较都必须先过这一步，否则 mac 上永远对不上。
 */
const canonicalizeWorktreePath = async (p: string): Promise<string> => {
  const abs = path.resolve(p);
  const tail: string[] = [];
  let cur = abs;
  for (;;) {
    try {
      const real = await fs.realpath(cur);
      return tail.length > 0 ? path.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return abs;
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
};

/** 读 `<adminDir>/locked`；没有 / 读不出来 → null（= 没有锁）。`ageMs` 是 mtime 距今 */
const readAdminLock = async (
  adminDir: string,
): Promise<{ lockText: string; ageMs: number } | null> => {
  const lockFile = path.join(adminDir, "locked");
  try {
    const [lockText, st] = await Promise.all([
      fs.readFile(lockFile, "utf8"),
      fs.stat(lockFile),
    ]);
    return { lockText, ageMs: Date.now() - st.mtimeMs };
  } catch {
    return null;
  }
};

/** 目录还在：从 `<workDir>/.git` 指针找到它在主仓里的登记目录（不跑 git）；指针读不到 / 不是 gitdir 行 → null */
const adminDirFromPointer = async (workDir: string): Promise<string | null> => {
  let text: string;
  try {
    text = await fs.readFile(path.join(workDir, ".git"), "utf8");
  } catch {
    return null;
  }
  const value = parseGitdirPointerValue(text);
  return value ? resolveGitPointer(workDir, value) : null;
};

/** 主仓里所有 worktree 的登记（`<commonDir>/worktrees/<名>/gitdir` 记着各自目录的 realpath）；读不出来 → 空 */
const listWorktreeAdminEntries = async (
  repoPath: string,
  job?: ResourceJobHandle,
): Promise<Array<{ adminDir: string; registeredPath: string }>> => {
  const common = await runGit(repoPath, ["rev-parse", "--git-common-dir"], 60_000, job);
  if (!common.ok || !common.stdout) return [];
  const adminRoot = path.join(path.resolve(repoPath, common.stdout), "worktrees");
  let names: string[];
  try {
    names = await fs.readdir(adminRoot);
  } catch {
    return [];
  }
  const entries: Array<{ adminDir: string; registeredPath: string }> = [];
  for (const name of names) {
    const adminDir = path.join(adminRoot, name);
    try {
      const registered = worktreePathFromAdminGitdirFile(
        await fs.readFile(path.join(adminDir, "gitdir"), "utf8"),
      );
      if (registered) entries.push({ adminDir, registeredPath: registered });
    } catch {
      /* 没有 gitdir 的登记不是 worktree（或已被别人清掉）、跳过 */
    }
  }
  return entries;
};

/**
 * workDir 对应的 git 登记是不是「`git worktree add` 中断留下的 initializing 锁」。
 * 目录在：直接读 `.git` 指针找登记目录（热路径、不起 git 子进程）；目录没了 / 指针不可用：按 `gitdir` 反查。
 * none = 没有 initializing 锁（没登记 / 没 `locked` / 用户手动 lock 的）；live = 看起来 add 还在进行；stale = 残留。
 */
const judgeWorktreeInitializingLock = async (
  repoPath: string,
  workDir: string,
): Promise<InitializingLockVerdict> => {
  let adminDir = await adminDirFromPointer(workDir);
  if (!adminDir) {
    const want = normForCompare(await canonicalizeWorktreePath(workDir));
    for (const entry of await listWorktreeAdminEntries(repoPath)) {
      if (normForCompare(await canonicalizeWorktreePath(entry.registeredPath)) === want) {
        adminDir = entry.adminDir;
        break;
      }
    }
  }
  if (!adminDir) return { kind: "none" };
  const lock = await readAdminLock(adminDir);
  if (!lock) return { kind: "none" };
  return judgeInitializingLock({
    lockText: lock.lockText,
    ageMs: lock.ageMs,
    inFlight: isWorktreeAddInFlight(await canonicalizeWorktreePath(workDir)),
  });
};

/**
 * stale 的半截检出：把目录改名隔离（保留里面所有文件——包括老版本把它当健康 worktree 复用后 agent 已经写进去的）
 * + `git worktree unlock`（只去掉 initializing 锁、不碰分支）。绝不删任何文件。
 * 返回 "skipped" = 动手前二次判定已不是 stale（并发的另一次 ensure 已经处理 / 又变成 live），什么都没动。
 * rename 失败沿用 isolateBrokenWorkDir 的语义：抛错、保留原目录、不降级成 rm（R2-01）。
 */
const healStaleInitializingWorkDir = async (
  repoPath: string,
  workDir: string,
  job: ResourceJobHandle,
): Promise<"healed" | "skipped"> => {
  // 测试挂点：判定为 stale 之后、动手之前（并发用例在此让另一次 ensure 先处理完）
  await failpoint("ensure.beforeHealHalfCheckout");
  // 二次判定：检查与动手之间隔了 await，别的 ensure 可能已经隔离 + 重建了——别把人家刚建好的健康 worktree 再隔离一次
  const again = await judgeWorktreeInitializingLock(repoPath, workDir);
  if (again.kind !== "stale") return "skipped";
  const ageSec = Math.round(again.ageMs / 1000);
  try {
    await isolateBrokenWorkDir(
      workDir,
      `半截检出：git worktree add 被硬杀，locked=initializing 已 ${ageSec}s`,
    );
  } catch (err) {
    // 目录已经不在 = 并发的另一次刚把它隔离走了，接着 unlock（幂等）；别的原因（占用 / 权限）照旧抛、原目录原样保留
    if (await pathExists(workDir)) throw err;
  }
  const unlocked = await runGit(repoPath, ["worktree", "unlock", workDir], 60_000, job);
  if (!unlocked.ok) {
    // 并发的另一次已经解开了 → 没有 initializing 锁就算成功；还在才是真失败
    if ((await judgeWorktreeInitializingLock(repoPath, workDir)).kind !== "none") {
      throw new Error(
        `仓库 ${repoPath} 的工作区 ${workDir} 是「git worktree add 被中断」留下的半截检出，已改名隔离、里面的文件都保留；` +
          `但解除 git 的 initializing 锁失败（${unlocked.stderr || unlocked.stdout || "无输出"}）。` +
          `请手动执行 git -C "${repoPath}" worktree unlock "${workDir}" 后重试。`,
      );
    }
  }
  // 测试挂点：隔离 + 解锁刚做完、后面的「存量僵尸」兜底与 prune 还没跑——用例在此断言自愈本身已经解了锁（不靠兜底）
  await failpoint("ensure.afterHealHalfCheckout");
  return "healed";
};

/**
 * 存量僵尸：老版本被硬杀、又把目录删了（或本版自愈改名之后），git 里留着「目录已不存在 + locked=initializing + 已 stale」的登记。
 * `worktree prune` 清不掉被锁定的登记（实测），同名分支因此永远报 `already checked out`——先 unlock，再交给 prune。
 * 只动 Flowship 自己的 worktrees 根下的登记（用户手建的 worktree 不碰）；目录还在的不碰（归 ensure 的自愈 / 各 remove 路径）；
 * live 的不碰。返回解开的个数。
 */
const unlockStaleInitializingZombies = async (
  repoPath: string,
  job?: ResourceJobHandle,
): Promise<number> => {
  const root = normForCompare(await canonicalizeWorktreePath(getWorktreesRoot()));
  let unlocked = 0;
  for (const entry of await listWorktreeAdminEntries(repoPath, job)) {
    const registered = await canonicalizeWorktreePath(entry.registeredPath);
    if (!normForCompare(registered).startsWith(`${root}/`)) continue;
    if (await pathExists(entry.registeredPath)) continue;
    const lock = await readAdminLock(entry.adminDir);
    if (!lock) continue;
    const verdict = judgeInitializingLock({
      lockText: lock.lockText,
      ageMs: lock.ageMs,
      inFlight: isWorktreeAddInFlight(registered),
    });
    if (verdict.kind !== "stale") continue;
    const r = await runGit(repoPath, ["worktree", "unlock", entry.registeredPath], 60_000, job);
    if (r.ok) {
      unlocked++;
      console.warn(
        `[task-worktrees] 解开僵尸 worktree 登记的 initializing 锁（git worktree add 被硬杀、目录已不存在）：${entry.registeredPath}`,
      );
    } else {
      console.warn(
        `[task-worktrees] 解开僵尸 worktree 登记失败（尽力而为）：${entry.registeredPath}：${r.stderr || r.stdout}`,
      );
    }
  }
  return unlocked;
};

/**
 * `git worktree remove --force`——6 处删除路径共用。
 * `--force` 拦不住 locked 的 worktree（要 `--force --force`）：被硬杀的 add 留下 `locked=initializing`，
 * 旧实现于是总落到「`fs.rm` + `prune`」，而 prune 清不掉被锁定的登记 → 目录没了、同名分支永远报 already checked out。
 * 这里只在**确认是 stale 的 initializing 锁**时才升级成 `--force --force`；用户手动 lock 的 / live 的 / 别的失败原因，
 * 原样返回失败，各调用点既有的守卫与「退回 fs.rm + prune」不变。
 * 调用点必须已经过自己的快照守卫——`--force --force` 会删目录。
 */
const forceRemoveWorktree = async (
  repoPath: string,
  workDir: string,
  timeoutMs = 60_000,
  job?: ResourceJobHandle,
): Promise<GitResult> => {
  const removed = await runGit(repoPath, ["worktree", "remove", "--force", workDir], timeoutMs, job);
  if (removed.ok) return removed;
  const verdict = await judgeWorktreeInitializingLock(repoPath, workDir);
  if (verdict.kind !== "stale") return removed;
  console.warn(
    `[task-worktrees] worktree remove 被 initializing 锁拦住（git worktree add 被硬杀的残留，已 ${Math.round(verdict.ageMs / 1000)}s）、升级为 remove --force --force：${workDir}`,
  );
  return runGit(repoPath, ["worktree", "remove", "--force", "--force", workDir], timeoutMs, job);
};

/**
 * 删前快照的 `taskBranch` 口径：stale 的半截检出传 `null`（只写 ref、不动分支）。
 * 半截检出里 HEAD 附着在任务分支上、索引却是空的——`snapshotDirtyWorktree` 会把「缺了大半文件」的树
 * 写成 WIP commit 并**记到任务分支上**，分支末端从此是个删光的树，reopen 后检出就是缺文件的工作区。
 * 其它情形原样返回调用方给的口径。
 */
const snapshotBranchFor = async (
  repoPath: string | null | undefined,
  workDir: string,
  branch: string | null | undefined,
): Promise<string | null | undefined> => {
  if (!repoPath) return branch;
  return (await judgeWorktreeInitializingLock(repoPath, workDir)).kind === "stale"
    ? null
    : branch;
};

/**
 * `git worktree add`（含孤儿自愈后的 retry），期间在进程内登记「这个目录有 add 在跑」——
 * 判残留时靠它区分「本进程正在 add」与「被硬杀的残留」（git 状态上二者逐字相同）。
 */
const runWorktreeAdd = async (
  repoPath: string,
  workDir: string,
  addArgs: string[],
  job: ResourceJobHandle,
): Promise<GitResult> => {
  const end = beginWorktreeAdd(await canonicalizeWorktreePath(workDir));
  try {
    return await runGit(repoPath, addArgs, 120_000, job);
  } finally {
    end();
  }
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
const findDeletedTaskOrphanWorktree = async (
  occupyingPath: string,
): Promise<{ taskId: string; dirName: string } | null> => {
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
  if (!p.startsWith(prefix)) return null;
  const [taskId, dirName] = p.slice(prefix.length).split("/");
  if (!taskId) return null;
  if (await pathExists(path.join(dataRoot(), "tasks", taskId))) return null;
  // dirName 只用来给 WIP 快照 ref 命名；占用路径就是任务容器目录本身时退回 basename
  return { taskId, dirName: dirName || path.basename(p) };
};

/**
 * 撞「already checked out / already used by worktree」时：若占用方是已删任务孤儿，
 * 则 force remove + prune 释放分支，返回 true 让调用方重试 add；否则返回 false。
 *
 * ⚠️ 强删前必须先落 WIP 快照（2026-10-20 review #2）：这类孤儿正是「快照失败后被保留下来的 worktree」
 * （removeTaskWorktrees / 开机孤儿清理在快照失败时不再强删），里面可能还躺着唯一一份未提交改动。
 * 快照仍失败 → **不释放**、返回 false，让 ensure 带着「分支被占用」的报错抛给用户（报错里有占用路径），
 * 宁可新任务暂时建不起来，也不在这里悄悄销毁用户的未提交改动。
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
  const orphan = await findDeletedTaskOrphanWorktree(occupying);
  if (!orphan) return false;
  // 目录已经没了（只剩 git 里一条过期登记）→ 没有可丢的东西、直接走下面的 remove / prune
  if (await pathExists(occupying)) {
    // 任务已删、不会再 reopen：taskBranch=null → 只写 ref、不往分支上记 WIP commit
    const snap = await snapshotDirtyWorktree(occupying, {
      taskId: orphan.taskId,
      dirName: orphan.dirName,
      taskBranch: null,
    });
    if (snap.kind === "failed") {
      console.warn(
        `[task-worktrees] 已删任务孤儿 worktree 的 WIP 快照失败、不强制释放（避免销毁未提交改动）：${occupying}：${snap.reason}`,
      );
      return false;
    }
  }
  console.log(
    `[task-worktrees] 发现已删任务孤儿 worktree，强制释放后重试：${occupying}`,
  );
  const removed = await forceRemoveWorktree(repoPath, occupying);
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
        const removed = await forceRemoveWorktree(repoPath, workDir);
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

    // `git worktree add` 被硬杀（SIGKILL / 崩溃 / 断电）会留下「半截检出 + locked=initializing」——下面的复用判据
    //（rev-parse 为 true、当前分支就是任务分支）它全部满足，会被当健康工作区复用（Q10-01）。所以必须在复用判断**之前**识别：
    //  - stale（没有活的 add：本进程无在途登记、locked 已超 5 分钟）→ 目录改名隔离（不删文件）+ unlock，随后按「目录不存在」重建；
    //  - live（看起来 add 还在进行）→ 不动目录与登记、抛可重试错误；
    //  - none（没有 initializing 锁，含用户手动 lock 的健康 worktree）→ 照常复用。
    // 目录里的文件一个不删：老版本把半截检出当健康复用后，agent 可能已经往里写了东西。判据与取舍见 worktree-residue.ts / HANDOFF「R14 B5-2」。
    if (await pathExists(path.join(workDir, ".git"))) {
      let half = await judgeWorktreeInitializingLock(repoPath, workDir);
      if (half.kind === "stale") {
        assertLease();
        const healed = await healStaleInitializingWorkDir(repoPath, workDir, job);
        // skipped = 动手前二次判定已变（并发的另一次已处理 / 又变 live）：按最新状态复判，别带着过期结论往下走
        half =
          healed === "skipped"
            ? await judgeWorktreeInitializingLock(repoPath, workDir)
            : { kind: "none" };
      }
      if (half.kind === "live") {
        throw new Error(
          `仓库 ${repoPath} 的工作区 ${workDir} 看起来有一次 git worktree add 还在进行（${describeLiveInitializing(half)}），` +
            `为避免破坏正在建的目录，本次未做任何改动。请稍后重试。`,
        );
      }
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
    // 清「目录没了但 git 还记着」的僵尸 worktree 注册（否则 add 同路径报错）。
    // 被硬杀的 add 留下的登记是 locked=initializing，prune 清不掉（实测）——先把「目录已不存在 + stale」的解锁
    await unlockStaleInitializingZombies(repoPath, job);
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
    // worktree add（可达 120s）挂 abort；期间登记「本进程在 add 这个目录」（判残留时区分进行中 / 被硬杀）
    let added = await runWorktreeAdd(repoPath, workDir, addArgs, job);
    if (!added.ok) {
      // 存量孤儿自愈：老版本删任务时快照失败会 skip 删除，留下 worktree 目录 + 分支占用。
      // 若占用方是「已删任务」的孤儿 → force remove + prune 后重试一次 add。
      if (await tryReleaseDeletedTaskOrphan(repoPath, added.stderr)) {
        // retry 也是一次独立 add——同样验 lease
        await failpoint("ensure.beforeWorktreeAdd");
        assertLease();
        added = await runWorktreeAdd(repoPath, workDir, addArgs, job);
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
      const name = repoTail(repoPath);
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

/** WIP 快照 ref 的命名空间：不在 heads / tags / remotes 下，不进分支列表、默认也不会被 push / fetch 带走 */
const WIP_REF_PREFIX = "refs/flowship/wip";

/**
 * ref 名的一段：只留 `[A-Za-z0-9_-]`，其余（空格 / 点 / 中文 / `~^:?*[\` 等 git 不允许或易出事的字符）换成 `_`。
 * 清洗过的名字追加原名的短哈希，避免 `my repo` 与 `my_repo` 这类不同目录撞同一个 ref（互相覆盖快照）。
 */
const sanitizeRefPart = (raw: string): string => {
  const safe = raw.replace(/[^A-Za-z0-9_-]/g, "_");
  if (safe === raw && safe.length > 0) return safe;
  const hash = createHash("sha1").update(raw).digest("hex").slice(0, 8);
  return `${safe || "x"}-${hash}`;
};

/** 某任务某仓的 WIP 快照 ref：`refs/flowship/wip/<taskId>-<仓短名>`（同名重复快照靠 reflog 保留历史版本） */
export const wipSnapshotRefName = (taskId: string, dirName: string): string =>
  `${WIP_REF_PREFIX}/${sanitizeRefPart(taskId)}-${sanitizeRefPart(dirName)}`;

/** 一次成功落地的 WIP 快照（写事件告知用户「改动在哪、怎么找回」） */
export interface WipSnapshotInfo {
  /** 原仓库路径 */
  repoPath: string;
  /** `refs/flowship/wip/<task>-<repo>`（指向快照 commit，不会悬空） */
  ref: string;
  /** 快照 commit 的完整 sha */
  commit: string;
  /**
   * 快照 commit 同时被记到了这个本地分支上（= 任务分支）——reopen 重建 worktree 检出分支即无缝续推。
   * undefined = 只落在 ref 上（detached HEAD / 任务已删 / HEAD 不在任务分支上）。
   */
  branch?: string;
}

/** 一次未能落地的 WIP 快照（该仓 worktree 已**保留**、没有被删） */
export interface WipSnapshotFailure {
  /** 原仓库路径 */
  repoPath: string;
  /** 被保留下来的 worktree 目录 */
  workDir: string;
  reason: string;
}

/** WIP 快照三态：干净（可直接删）/ 已落快照（可删）/ 脏但落不了（**不得删**） */
type SnapshotOutcome =
  | { kind: "clean" }
  | { kind: "snapshotted"; ref: string; commit: string; branch?: string }
  | { kind: "failed"; reason: string };

/**
 * 子模块当前 HEAD 提交是否「只在本地」：返回 null = 已存在于某个远端跟踪 ref 上（删 worktree 后仍可从远端取回）；
 * 返回字符串 = 不可恢复的描述（短 sha / 无法判断的原因）。**判断不了一律按「只在本地」处理**（宁可保留目录）。
 */
const submoduleHeadOnlyLocal = async (workDir: string, sub: string): Promise<string | null> => {
  const subDir = path.join(workDir, sub);
  const head = await runGit(subDir, ["rev-parse", "-q", "--verify", "HEAD^{commit}"]);
  if (!head.ok || !head.stdout) return `无法读取子模块 HEAD：${head.stderr || "空输出"}`;
  const onRemote = await runGit(subDir, [
    "for-each-ref", "--count=1", "--format=%(refname)", `--contains=${head.stdout}`, "refs/remotes",
  ]);
  if (!onRemote.ok) return `无法判断提交 ${head.stdout.slice(0, 8)} 是否已推送：${onRemote.stderr}`;
  return onRemote.stdout ? null : `提交 ${head.stdout.slice(0, 8)}`;
};

/** snapshotDirtyWorktree 的上下文（命名 ref + 决定要不要把 WIP commit 记到任务分支） */
interface SnapshotContext {
  taskId: string;
  /** worktree 在任务容器目录下的短名（getUniqueRepoDirNames 产出，也是 ref 名的一部分） */
  dirName: string;
  /**
   * 是否把 WIP commit 记到本地分支上：
   * - string：只有 HEAD 恰好附着在这个分支上才记（手滑 checkout 到别的分支时不污染它）
   * - null：只写 ref、绝不动任何分支（任务已删、不会再 reopen）
   * - undefined：调用方不知道任务分支 → HEAD 附着在哪个本地分支就记在哪个（沿用旧行为）
   */
  taskBranch?: string | null;
}

/**
 * 删 worktree 前的产物保底：工作区脏（build 完没 ship 时、改动只以未提交形式存在）
 * → 把整个工作区快照成一个 WIP commit、并让 ref 指住它，再允许删。
 *
 * 为什么用 plumbing、不用 `git add -A && git commit`（2026-10-20 review #2，已用真 git 复现三条）：
 * 1. `commit --no-verify` 只绕 pre-commit / commit-msg，**绕不过 prepare-commit-msg**，也关不掉
 *    `commit.gpgsign`——签名程序不可用 / hook 失败时 commit 直接失败；
 * 2. worktree 常是 detached HEAD（新任务预热、帮切找不到分支都会 detached），commit 出来没有任何 ref 指向，
 *    删完 worktree 就是 dangling、等 gc 回收，事件却还写「已 commit 到任务分支」；
 * 3. commit 失败后旧实现仍 `worktree remove --force`，未提交改动随目录一起没了。
 * 现在：临时 index（拷一份真实 index，不动真实 index / 工作区）→ `add -A` → `write-tree` →
 * `commit-tree`（不触发任何 hook / 签名）→ `update-ref refs/flowship/wip/<task>-<repo>`（有 ref 指向、不悬空）。
 * 只有「HEAD 附着在任务分支上」时才额外把分支 fast-forward 到快照 commit（见 {@link SnapshotContext.taskBranch}），
 * 保住既有约定：「分支保留 = 产物保留」、reopen 重建 worktree 检出分支即无缝续推。
 *
 * 快照范围 = `git add -A` 的范围：已跟踪文件的改动 / 删除 + 未跟踪且**未被 .gitignore 忽略**的文件。
 * 被忽略的文件（.env.local、node_modules、构建产物…）不进快照——它们本来就是可再生 / 机器本地的，
 * 且 worktree 建的时候靠「拷 .env* + 克隆依赖」补齐；这是有意的取舍、不是漏网。
 *
 * 三态（调用方据此决定能不能删目录）：
 * - clean：干净（porcelain 空 / 快照树与 HEAD 一致 / 目录里压根没有 .git）→ 可直接删
 * - snapshotted：脏且已落 ref → 可删（产物在 ref / 分支上）
 * - failed：脏但落不了快照（merge 冲突 / status 挂 / git 命令失败）→ **调用方不得删**，保留目录等用户处理
 *
 * merge / rebase 冲突中：porcelain 会出现 UU/AA/DU 等未合并码。此时若盲目
 * `git add -A` 会把带 <<<<<<< 的文件当成「已解决」并成功落快照、
 * 掩盖真实冲突——所以未合并时直接 failed，不特判 MERGE_HEAD 文件是否存在。
 */
const snapshotDirtyWorktree = async (
  workDir: string,
  ctx: SnapshotContext,
): Promise<SnapshotOutcome> => {
  const fail = (reason: string): SnapshotOutcome => {
    console.warn(`[task-worktrees] WIP 快照失败：${workDir}：${reason}`);
    return { kind: "failed", reason };
  };

  // 目录里没有 .git（只剩依赖克隆残留的半截目录）：没有 git 状态可丢，维持「可清」——
  // 与 ensure 对 `absent` 的处置一致。若连 status 都是因为别的原因挂了，下面照常判 failed。
  if ((await probePath(path.join(workDir, ".git"))) === "missing") {
    return { kind: "clean" };
  }

  // v2 + -z：能区分「子模块指针变了」与「子模块里有未提交改动」（见 worktree-status.ts）。
  // --ignore-submodules=none：用户配了 diff.ignoreSubmodules=all / submodule.<n>.ignore 时 status 默认就不报子模块。
  // --untracked-files=all：命令行旗标压过 `status.showUntrackedFiles=no`（否则「只新增文件」的 worktree 被判干净直接删，
  // 第四轮 Q3-05）；且把未跟踪目录展开到文件级——默认 normal 模式把 `refs/inner/` 折成 `? refs/`，嵌套 git 仓在深度 ≥2
  // 时守卫只探 `refs/.git` 而漏过（Q3-04）。展开后 untrackedDirs 里就只剩「git 自己都不往里进的目录」= 嵌套仓。
  const status = await runGit(workDir, [
    "status",
    "--porcelain=v2",
    "-z",
    "--ignore-submodules=none",
    "--untracked-files=all",
  ]);
  // status 本身跑不了（原仓被移走 / .git 指针坏 / git 不在 PATH）时无法证明干净 → failed
  if (!status.ok) {
    return fail(`git status 失败、无法证明工作区干净：${status.stderr}`);
  }
  if (status.stdout.length === 0) return { kind: "clean" };
  const summary = parseWorktreeStatusV2(status.stdout);
  // 未合并路径（merge/rebase 冲突）：add 会假解决、记 failed 让调用方决定
  if (summary.unmerged.length > 0) {
    return fail("工作区有未合并冲突（merge / rebase 进行中），不做快照");
  }
  // 子模块里的未提交改动进不了父仓 tree（只存一个 gitlink 指针）：下面的 add -A / write-tree 会得出
  // 「快照树 == HEAD 树」而判 clean → 整目录被删、改动永久丢失（第三轮 review D2b-15）。存不下就别删。
  if (summary.dirtySubmodules.length > 0) {
    return fail(
      `子模块内有未提交的改动（${summary.dirtySubmodules.join("、")}）：这类改动存不进快照，` +
        "请先在子模块里提交或处理掉",
    );
  }
  // 子模块指针移动（`SC..`）：父仓 tree 里记得住新的 gitlink sha，但若该提交只存在于子模块自己的 gitdir
  // （在 worktree 里 `submodule update --init` 后本地提交、没推送），删 worktree 会连 `.git/worktrees/<n>/modules/<sub>` 一起删，
  // 提交在原仓 / 任何远端都不可达——快照里只剩一个指向空气的 sha（第四轮 Q3-03）。已在某个远端上的提交才放行。
  const lostSubmoduleCommits: string[] = [];
  for (const sub of summary.movedSubmodules) {
    const lost = await submoduleHeadOnlyLocal(workDir, sub);
    if (lost) lostSubmoduleCommits.push(`${sub}（${lost}）`);
  }
  if (lostSubmoduleCommits.length > 0) {
    return fail(
      `子模块 ${lostSubmoduleCommits.join("、")} 的 HEAD 已移动到没推送到任何远端的提交：` +
        "该提交只存在于子模块自己的 gitdir、删除 worktree 后无法找回，请先在子模块里推送或处理掉",
    );
  }
  // 未跟踪的嵌套 git 仓：add -A 只会记一个 gitlink，嵌套仓里的内容（含它自己的未提交改动）随目录一起丢
  // （无提交的嵌套仓则 add -A 直接报错）。同样存不下就别删（F1-05）。
  const nestedRepos: string[] = [];
  for (const dir of summary.untrackedDirs) {
    if ((await probePath(path.join(workDir, dir, ".git"))) !== "missing") {
      nestedRepos.push(dir.replace(/\/$/, ""));
    }
  }
  if (nestedRepos.length > 0) {
    return fail(
      `含有未跟踪的嵌套 git 仓库（${nestedRepos.join("、")}）：快照不会保存它里面的内容，` +
        "请先移走或处理掉",
    );
  }

  // HEAD：空仓（unborn）时没有，快照 commit 就没有 parent
  const head = await runGit(workDir, ["rev-parse", "-q", "--verify", "HEAD^{commit}"]);
  const headSha = head.ok ? head.stdout : "";

  // 真实 index（worktree 专属 gitdir 下）。--git-path 可能给相对 cwd 的路径、统一按 workDir 解析
  const idxOut = await runGit(workDir, ["rev-parse", "--git-path", "index"]);
  if (!idxOut.ok || !idxOut.stdout) {
    return fail(`解析 index 路径失败：${idxOut.stderr || idxOut.stdout}`);
  }
  const realIndex = path.resolve(workDir, idxOut.stdout);
  // 临时 index 放在真实 index 的同一目录：拆分索引（core.splitIndex）的 sharedindex.* 也按该目录解析
  // 后缀必须带随机量：同一进程内并发快照同一个 worktree 时 `Date.now()` 会同毫秒撞名 → `index.lock` 已存在 → 误报失败（Q3-09）
  const tmpIndex = `${realIndex}.flowship-wip-${process.pid}-${Date.now()}-${randomBytes(4).toString("hex")}`;
  const idxEnv = { GIT_INDEX_FILE: tmpIndex };

  try {
    // 铺底：拷真实 index（保留 stat 缓存、add -A 只需重算改动的文件；也保住「已 git add -f 的被忽略文件」）。
    // 真实 index 不在（极少）就退回 read-tree HEAD / 空 index——add -A 都能补全。
    let seeded = false;
    try {
      await fs.copyFile(realIndex, tmpIndex);
      seeded = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        return fail(`拷贝 index 失败：${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (!seeded && headSha) {
      const rt = await runGit(workDir, ["read-tree", "HEAD"], 60_000, undefined, idxEnv);
      if (!rt.ok) return fail(`read-tree HEAD 失败：${rt.stderr}`);
    }

    // 超时放宽到 120s：add -A 要哈希所有改动 / 未跟踪文件，大仓上 60s 偏紧；超时即 failed、保留目录，不会误删
    const added = await runGit(workDir, ["add", "-A"], 120_000, undefined, idxEnv);
    if (!added.ok) return fail(`git add -A 失败：${added.stderr}`);
    const written = await runGit(workDir, ["write-tree"], 60_000, undefined, idxEnv);
    const tree = written.stdout.toLowerCase();
    if (!written.ok || !/^[0-9a-f]{40,64}$/.test(tree)) {
      return fail(`write-tree 失败：${written.stderr || written.stdout}`);
    }

    // 快照树 == HEAD 的树：status 看着脏、内容层却没有任何差异（如纯换行符归一化）→ 没有可保存的东西
    if (headSha) {
      const headTree = await runGit(workDir, ["rev-parse", "-q", "--verify", "HEAD^{tree}"]);
      if (headTree.ok && headTree.stdout.toLowerCase() === tree) {
        return { kind: "clean" };
      }
    }

    // commit-tree 本身不跑任何 hook、也不读 commit.gpgsign；`-c commit.gpgsign=false` 是显式兜底。
    // 用户没配 git 身份时给个兜底身份、保证「能写对象的场景」一定能落。
    const committed = await runGit(workDir, [
      "-c", "user.name=flowship",
      "-c", "user.email=flowship@local",
      "-c", "commit.gpgsign=false",
      "commit-tree", tree,
      ...(headSha ? ["-p", headSha] : []),
      "-m", "WIP：任务终结前自动快照（Flowship）",
    ]);
    const commit = committed.stdout.toLowerCase();
    if (!committed.ok || !/^[0-9a-f]{40,64}$/.test(commit)) {
      return fail(`commit-tree 失败：${committed.stderr || committed.stdout}`);
    }

    // 先让 ref 指住它——从这一刻起快照不会悬空。--create-reflog：refs/flowship 不在 git 默认记 reflog 的
    // 命名空间里，不显式要求就没有历史；同一任务同一仓再次快照（reopen 后又脏了）覆盖 ref 时旧版本仍能从 reflog 找回。
    const ref = wipSnapshotRefName(ctx.taskId, ctx.dirName);
    const updated = await runGit(workDir, [
      "update-ref", "--create-reflog", "-m", "Flowship WIP 快照（删 worktree 前）", ref, commit,
    ]);
    if (!updated.ok) return fail(`update-ref ${ref} 失败：${updated.stderr}`);

    // 兼容既有约定：HEAD 附着在任务分支上时，把分支 fast-forward 到快照 commit（旧实现就是 commit 到分支）。
    // 带旧值做 CAS——期间分支被别处动过就放弃这一步（ref 已经保住了数据）。
    let advancedBranch: string | undefined;
    if (headSha && ctx.taskBranch !== null) {
      const sym = await runGit(workDir, ["symbolic-ref", "-q", "HEAD"]);
      const prefix = "refs/heads/";
      if (sym.ok && sym.stdout.startsWith(prefix)) {
        const branch = sym.stdout.slice(prefix.length);
        if (ctx.taskBranch === undefined || ctx.taskBranch === branch) {
          const moved = await runGit(workDir, [
            "update-ref", "-m", "Flowship WIP 快照（删 worktree 前）",
            sym.stdout, commit, headSha,
          ]);
          if (moved.ok) {
            advancedBranch = branch;
            // 分支前进后真实 index 还停在旧 HEAD：mixed reset 把它对齐到新 HEAD（工作区不动），
            // 免得目录万一没删成（Windows 占用等）时 git status 出现「已暂存的反向 diff」。失败无碍。
            await runGit(workDir, ["reset", "-q"]);
          } else {
            console.warn(
              `[task-worktrees] WIP 快照未能记到分支 ${branch}（分支已变动？），仅保存在 ${ref}：${moved.stderr}`,
            );
          }
        }
      }
    }

    return { kind: "snapshotted", ref, commit, branch: advancedBranch };
  } finally {
    await fs.rm(tmpIndex, { force: true }).catch(() => {});
  }
};

export interface RemoveWorktreesResult {
  /** 是否真的清理了至少一个目录 */
  removedAny: boolean;
  /** 删前把未提交改动落了 WIP 快照（refs/flowship/wip/…）的原仓库路径（写事件告知用户用） */
  snapshotRepos: string[];
  /**
   * WIP 快照失败的原仓库路径——**这些仓的 worktree 已保留、没有被删**（未提交改动还在原目录里）。
   * 调用方（task-runner 的事件文案）必须如实告知「已保留、需手动处理」，不能再写「已强制删除」。
   */
  snapshotFailedRepos: string[];
  /** 每个成功快照的 ref / commit / 是否记到了任务分支（比 snapshotRepos 详细；旧调用方 / mock 可不带） */
  snapshots?: WipSnapshotInfo[];
  /** 每个失败仓的保留目录与原因（比 snapshotFailedRepos 详细；旧调用方 / mock 可不带） */
  snapshotFailures?: WipSnapshotFailure[];
}

/**
 * 把 removeTaskWorktrees 的快照结果写成事件文案片段（snapshotNote / failedNote，各自带「；」前缀、无内容为空串）。
 * 集中在这里是为了让文案与行为同源：成功说「已保存到 refs/flowship/wip/…」、失败如实说「工作区已保留」，
 * 不再有「已强制删除」「已自动 commit 到任务分支」这类与实际不符的描述。
 */
export const formatWorktreeCleanupNotes = (
  removed: Pick<
    RemoveWorktreesResult,
    "snapshotRepos" | "snapshotFailedRepos" | "snapshots" | "snapshotFailures"
  >,
  tailOf: (repoPath: string) => string = (p) => p,
): { snapshotNote: string; failedNote: string } => {
  const saved =
    removed.snapshots && removed.snapshots.length > 0
      ? removed.snapshots.map(
          (s) =>
            `${tailOf(s.repoPath)} → ${s.ref}${s.branch ? `（同时记在任务分支 ${s.branch}）` : ""}`,
        )
      : removed.snapshotRepos.map(tailOf);
  const snapshotNote =
    saved.length > 0
      ? `；未提交改动已保存到 ${saved.join("、")}（可用 git log / git checkout 该 ref 找回）`
      : "";
  const kept =
    removed.snapshotFailures && removed.snapshotFailures.length > 0
      ? removed.snapshotFailures.map(
          (f) => `${tailOf(f.repoPath)}（${f.reason}；目录 ${f.workDir}）`,
        )
      : removed.snapshotFailedRepos.map(tailOf);
  const failedNote =
    kept.length > 0
      ? `；⚠️ 以下仓的未提交改动无法自动保存、工作区已保留未删除，请手动处理后再清理：${kept.join("、")}`
      : "";
  return { snapshotNote, failedNote };
};

/**
 * 删掉本 task 的全部 worktree（task 终结 / 删除时调）。
 * feature 分支**保留**在原仓库（worktree 删了分支还在）；工作区有未提交改动时
 * 先落 WIP 快照（refs/flowship/wip/…，见 snapshotDirtyWorktree）再删。
 *
 * ⚠️ 快照失败 → **保留该仓 worktree、不删**（2026-10-20 review #2 改：此前是「快照失败也强制删」，
 * 未提交改动随目录一起丢）。失败仓记进 `snapshotFailedRepos` / `snapshotFailures`，由调用方告知用户；
 * 其它仓照常处理。代价：该目录会继续占用 feature 分支，直到用户处理——ensure 撞「分支被占用」时
 * 对已删任务孤儿的自愈（tryReleaseDeletedTaskOrphan）同样会先快照、失败也不会强删。
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
  const snapshots: WipSnapshotInfo[] = [];
  const snapshotFailures: WipSnapshotFailure[] = [];
  for (let i = 0; i < t.repoPaths.length; i++) {
    const repoPath = t.repoPaths[i];
    const workDir = path.join(taskDir, names[i]);
    if (!(await pathExists(workDir))) continue;
    // 未提交改动先落 WIP 快照：成功才允许删；失败则保留这个 worktree（见函数头注释）
    const snap = await snapshotDirtyWorktree(workDir, {
      taskId: t.id,
      dirName: names[i],
      // 半截检出残留（locked=initializing）不往任务分支上记 WIP——见 snapshotBranchFor
      taskBranch: await snapshotBranchFor(
        repoPath,
        workDir,
        t.gitBranches?.find((b) => b.repoPath === repoPath)?.name,
      ),
    });
    if (snap.kind === "snapshotted") {
      snapshotRepos.push(repoPath);
      snapshots.push({
        repoPath,
        ref: snap.ref,
        commit: snap.commit,
        branch: snap.branch,
      });
    } else if (snap.kind === "failed") {
      console.warn(
        `[task-worktrees] WIP 快照失败、保留 worktree 不删（未提交改动仍在原目录）：${workDir}：${snap.reason}`,
      );
      snapshotFailedRepos.push(repoPath);
      snapshotFailures.push({ repoPath, workDir, reason: snap.reason });
      continue;
    }
    // 优先走 git worktree remove（同时清 .git/worktrees 注册）；原仓库没了 / 命令失败退回 rm + prune
    const removed = await forceRemoveWorktree(repoPath, workDir);
    if (!removed.ok) {
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
      await runGit(repoPath, ["worktree", "prune"]);
    }
    // 删后复核（第四轮 Q3-10d）：`fs.rm(...).catch(()=>{})` 吞掉了 EACCES / EBUSY（Windows 占用 / 权限），目录实际还在却无条件
    // 记「已清理」→ 归档 toast 说「已清理隔离工作区」。目录还在就如实记进保留列表（快照若已落，原因里一并说明）
    if (await pathExists(workDir)) {
      const reason =
        "目录没能删掉（可能被占用或没有权限）" +
        (snap.kind === "snapshotted" ? `；未提交改动已存到 ${snap.ref}、不会丢` : "");
      console.warn(`[task-worktrees] worktree 目录删除后仍在、保留：${workDir}：${reason}`);
      snapshotFailedRepos.push(repoPath);
      snapshotFailures.push({ repoPath, workDir, reason });
      continue;
    }
    removedAny = true;
  }
  // 容器目录清空后移除（还有残留就留着、不 force 递归删以防误伤）
  await fs.rmdir(taskDir).catch(() => {});
  return { removedAny, snapshotRepos, snapshotFailedRepos, snapshots, snapshotFailures };
};

/** 一个因 WIP 快照失败而被保留的残留 worktree 目录 */
export interface StaleWorktreeKept {
  /** 容器目录下的仓短名 */
  dirName: string;
  workDir: string;
  reason: string;
  /**
   * 快照其实**已经落了 ref**、只是目录没删掉（Windows 占用 / 权限）：未提交改动安全，别再说「找不回了」（第四轮 Q3-07）。
   * 缺省 = 快照没存下（或没尝试）。
   */
  snapshotSaved?: boolean;
}

export interface StaleWorktreeCleanupResult {
  /** 已删掉的仓短名目录 */
  removedDirs: string[];
  /** 删前落了 WIP 快照的目录（refs/flowship/wip/…） */
  snapshots: Array<WipSnapshotInfo & { dirName: string }>;
  /**
   * 快照失败 / 目录删不掉、目录**保留**未删的。
   * 非 force：快照失败的都在这里。force：只剩「目录删不掉」的（快照失败的越过去、记在 {@link forced}）。
   */
  kept: StaleWorktreeKept[];
  /** `force` 时：仍尝试了快照、但存不下，用户确认后越过守卫强删的目录（记录在案，第四轮 Q3-06） */
  forced: StaleWorktreeKept[];
}

/**
 * 从 worktree 目录自己的 `.git` 指针反查原仓（残留目录没有 meta、不知道原仓）。
 * 非 bare 仓返回仓根（`.git` 的上一级），bare 仓返回 gitdir 本身；原仓不可用 → null。
 */
const resolveWorktreeOwnerRepo = async (workDir: string): Promise<string | null> => {
  const common = await runGit(workDir, ["rev-parse", "--git-common-dir"]);
  if (!common.ok || !common.stdout) return null;
  const gitDir = path.resolve(workDir, common.stdout);
  return path.basename(gitDir) === ".git" ? path.dirname(gitDir) : gitDir;
};

/**
 * 删一个 worktree 目录并清掉原仓里的登记（`.git/worktrees/<n>`，不清的话任务分支会一直报 already checked out）。
 * 原仓不可用 → 只能直接删目录。
 */
const removeWorktreeDirAndRegistration = async (workDir: string): Promise<void> => {
  const repoCwd = await resolveWorktreeOwnerRepo(workDir);
  if (repoCwd) {
    const removed = await forceRemoveWorktree(repoCwd, workDir);
    if (removed.ok) return;
  }
  await fs.rm(workDir, { recursive: true, force: true });
  if (repoCwd) await runGit(repoCwd, ["worktree", "prune"]);
};

/**
 * 存储页「删除残留工作区」（任务已删、`worktrees/<taskId>/` 还在）：和 {@link removeTaskWorktrees} 同一道守卫。
 *
 * 旧实现是裸 `fs.rm`——而被 removeTaskWorktrees「快照失败 → 保留」下来的目录，恰好就是之后出现在这个列表里的那批：
 * 守卫保住的未提交改动，在这里被一键清掉（第三轮 review D2b-01 / F1-04，实测复现）。
 * 现在逐个仓目录：先 {@link snapshotDirtyWorktree}（`taskBranch:null`：任务已删，只写 ref、不动任何分支），
 * 存得下 / 本来就干净才删；存不下 → 保留并记进 `kept`。`force` 是用户在二次确认里明确选「仍然删除」的出口
 * （没有它，原仓被移走这类永远快照失败的残留目录就永远清不掉）。
 */
export const cleanupStaleTaskWorktrees = async (
  taskId: string,
  opts: { force?: boolean } = {},
): Promise<StaleWorktreeCleanupResult> => {
  const result: StaleWorktreeCleanupResult = { removedDirs: [], snapshots: [], kept: [], forced: [] };
  const taskDir = getTaskWorktreesDir(taskId);
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(taskDir, { withFileTypes: true });
  } catch {
    return result;
  }
  for (const e of entries) {
    // 软链 / 普通文件不当 worktree 处理：最后随容器目录一起清（rm 不跟软链）
    if (!e.isDirectory()) continue;
    const workDir = path.join(taskDir, e.name);
    // force 也先尽力快照（第四轮 Q3-06）：存得下就存（强删不该白白丢掉本可保住的改动）；存不下才越过——并记录在案
    const snap = await snapshotDirtyWorktree(workDir, {
      taskId,
      dirName: e.name,
      taskBranch: null,
    });
    let snapshotSaved = false;
    if (snap.kind === "failed") {
      if (!opts.force) {
        console.warn(
          `[task-worktrees] 残留工作区 WIP 快照失败、保留不删：${workDir}：${snap.reason}`,
        );
        result.kept.push({ dirName: e.name, workDir, reason: snap.reason });
        continue;
      }
      console.warn(
        `[task-worktrees] 残留工作区 WIP 快照失败、用户确认强删（未提交改动将丢失）：${workDir}：${snap.reason}`,
      );
      result.forced.push({ dirName: e.name, workDir, reason: snap.reason });
    } else if (snap.kind === "snapshotted") {
      snapshotSaved = true;
      result.snapshots.push({
        dirName: e.name,
        repoPath: (await resolveWorktreeOwnerRepo(workDir)) ?? workDir,
        ref: snap.ref,
        commit: snap.commit,
        branch: snap.branch,
      });
    }
    try {
      await removeWorktreeDirAndRegistration(workDir);
      result.removedDirs.push(e.name);
    } catch (err) {
      // 目录删不掉（Windows 占用 / 权限）：如实保留、不吞成功
      const reason = `删除目录失败：${err instanceof Error ? err.message : String(err)}`;
      console.warn(`[task-worktrees] 残留工作区删除失败：${workDir}：${reason}`);
      result.kept.push({ dirName: e.name, workDir, reason, ...(snapshotSaved ? { snapshotSaved: true } : {}) });
    }
  }
  if (result.kept.length === 0) {
    // 容器目录里剩下的（普通文件 / 软链）一并清
    await fs.rm(taskDir, { recursive: true, force: true }).catch(() => {});
  } else {
    await fs.rmdir(taskDir).catch(() => {});
  }
  return result;
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
  /** 恒为空：快照失败不再「删了再报」，而是直接抛 WorktreeUnbindError（保留字段只为兼容旧调用方） */
  snapshotFailedRepos: string[];
};

/**
 * 用户主动改仓：按旧短名拆已解绑仓的 worktree，再把仍绑着的仓挪到新短名。
 * 只读 / 非 git 从没建过 worktree，跳过（候选目录不存在也跳过，绝不对原仓下手）。
 * WIP 快照失败**不拆**、抛 WorktreeUnbindError（与 removeTaskWorktrees 同口径：不销毁没存下来的未提交改动；
 * 区别是这里是用户主动改仓、可以直接把失败原因抛回去让他处理）。拆 / 挪失败同样抛错。
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
    dirName: string,
  ): Promise<void> => {
    if (!(await pathExists(workDir))) return;
    const snap = await snapshotDirtyWorktree(workDir, {
      taskId: t.id,
      dirName,
      // 半截检出残留（locked=initializing）不往任务分支上记 WIP——见 snapshotBranchFor
      taskBranch: await snapshotBranchFor(
        repoPath,
        workDir,
        t.gitBranches?.find((b) => b.repoPath === repoPath)?.name,
      ),
    });
    if (snap.kind === "snapshotted") {
      snapshotRepos.push(repoPath);
    } else if (snap.kind === "failed") {
      // 快照失败 → 不删、抛错：调用方（updateTaskFields）据此不写 meta，用户看到原因后手动处理再重试。
      // 比「删了再告知」安全：这是用户主动解绑，没有「必须立刻释放」的时限，丢未提交改动不可逆。
      console.warn(
        `[task-worktrees] 解绑仓 WIP 快照失败、保留 worktree 不删：${workDir}：${snap.reason}`,
      );
      throw new WorktreeUnbindError(
        `无法保存 ${workDir} 里未提交的改动（${snap.reason}），已保留该隔离工作区、未解绑。请先手动提交 / 备份其中的改动，或解决上述问题后重试。`,
      );
    }
    const removed = await forceRemoveWorktree(repoPath, workDir);
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
    await forceRemove(item.repoPath, path.join(taskDir, item.dirName), item.dirName);
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
    // 任务还活着、解绑后残留的目录：能从 .git 指针反查出原仓就用任务分支记录对一下 HEAD；
    // 查不到（undefined）→ 沿用「HEAD 附着在哪个分支就记在哪个」
    const snap = await snapshotDirtyWorktree(workDir, {
      taskId: t.id,
      dirName: e.name,
      // 半截检出残留（locked=initializing）不往任务分支上记 WIP——见 snapshotBranchFor
      taskBranch: await snapshotBranchFor(
        repoPath || null,
        workDir,
        repoPath
          ? t.gitBranches?.find((b) => b.repoPath === repoPath)?.name
          : undefined,
      ),
    });
    if (snap.kind === "failed") {
      // 快照落不了就别删：目录留着、下次 ensure 再试（改名隔离目录 .orphaned-* 也是同样的「留给用户」口径）
      console.warn(
        `[task-worktrees] 未映射 worktree WIP 快照失败、保留目录不删：${workDir}：${snap.reason}`,
      );
      continue;
    }
    if (repoPath) {
      const removed = await forceRemoveWorktree(repoPath, workDir);
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
          // 未提交改动先落 WIP 快照（任务已删、不会 reopen：只写 ref、不动分支）；失败则整棵保留（开机保守）
          const snap = await snapshotDirtyWorktree(workDir, {
            taskId: e.name,
            dirName: r.name,
            taskBranch: null,
          });
          if (snap.kind === "failed") snapshotFailed = true;
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
        // 目录刚被 rm 掉、登记可能还锁着 initializing（硬杀的 add 残留）：prune 清不掉被锁的，先解锁（R14 Q10-01）
        await unlockStaleInitializingZombies(path.dirname(gitDir));
        await runGit(path.dirname(gitDir), ["worktree", "prune"]);
      }
      console.log(`[task-worktrees] 已清理孤儿 worktree：${orphanDir}`);
    } catch (err) {
      console.warn(`[task-worktrees] 清理孤儿 worktree 失败（忽略）${orphanDir}：`, err);
    }
  }
};
