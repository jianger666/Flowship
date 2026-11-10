/**
 * 任务分支漂移守卫（纯探测 + 文案，不做任何写操作）。
 *
 * 背景（用户反馈）：task 本来在目标分支上，用户自己去 IDE 里把仓库切到了 master；回到 Flowship 在输入条里
 * 让 AI 改代码，AI 就直接在 master 上改了——没人把它切回目标分支。
 *
 * 根因：推进 / 唤醒 / 一次性问答三条「起 agent」的路径都会先确认分支（ensureTaskWorktrees 的 hot checkout、
 * 测试任务的 prepareTestingTaskBranches、build 的 checkout hint），但「给**存活会话**送一条消息」
 * （输入条 / ask 答复 / 定时消息）这条最常用的路径一直没人看一眼 HEAD——会话活着，cwd 还是原来的目录，
 * 目录里的分支被用户切走了也无人知晓。
 *
 * 本模块只回答两个问题（执行与事件落盘在 task-runner 的 guardTaskBranchForUserTurn）：
 *   1. 这个 task 的每个仓「现在应该在哪条分支」（collectBranchTargets，三种口径见 BranchGuardMode）
 *   2. 哪些仓现在**不在**那条分支上（detectBranchDrift）
 * 另外给「只能提醒、不能替用户切」的仓（in-place）产出一段附在消息末尾的提醒（buildBranchDriftNotice）。
 *
 * 依赖方向：只读 types / branch-template / flow-mutex / testing-task / git-exec / task-worktrees（纯函数）；
 * 不 import task-runner / task-fs（无环、方便单测用真 git 仓库跑）。
 */

import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { isSafeBranchName } from "@/lib/branch-template";
import { resolveFlowLock } from "@/lib/flow-mutex";
import {
  isTestingRequirementTask,
  testingTaskConfiguredBranchRepoPaths,
} from "@/lib/testing-task";
import type { Task } from "@/lib/types";

import {
  CURRENT_BRANCH_ARGS,
  gitEnv,
  parseCurrentBranchOutput,
} from "./git-exec";
import {
  getTaskWorkRepoPaths,
  isWorktreeTask,
  resolveExpectedWorktreeBranches,
  skipsWorktreeIsolation,
} from "./task-worktrees";

const execFileAsync = promisify(execFile);

/**
 * 读 HEAD / show-ref 的超时：只读小命令（正常 ~10ms），卡住就当「读不出」、不据此判漂移。
 * 这条在「用户发消息」的热路径上，所以取小：git 真卡死（网络盘掉线 / 杀软扫描风暴）时最多多等 3 秒就放行，而不是 10 秒。
 */
const GIT_READ_TIMEOUT_MS = 3_000;

/**
 * 三种口径（决定「漂移了怎么办」）：
 * - worktree：隔离 task 的专属 worktree。目录归本 task 独占，runner 可以放心 `git checkout` 切回（硬）。
 * - testing：测试任务填了被测业务分支的原仓。每个 Action 前本来就由 runner 硬检出（prepareTestingTaskBranches）、
 *   这里沿用同一个函数切回（硬；有未提交改动会拒绝并报错）。
 * - in-place：没开隔离、AI 直接在用户原仓里干活。原仓可能同时被别的 task / 用户自己用着，
 *   runner 不替用户切（会打断别的 agent、也会带着 master 上的未提交改动一起搬走），只给 AI 附一段提醒（软）。
 */
export type BranchGuardMode = "worktree" | "testing" | "in-place";

export interface BranchTarget {
  /** task.repoPaths 里的原仓路径（展示 / 对账用） */
  repoPath: string;
  /** agent 实际干活的目录（worktree 目录或原仓） */
  workDir: string;
  /** 应该在的分支 */
  branch: string;
  mode: BranchGuardMode;
}

export interface BranchDrift extends BranchTarget {
  /** 现在所在分支；null = detached HEAD */
  actual: string | null;
}

/** 本守卫失败时给用户看的错误（路由映射成 409 + 固定 code，不当 500）。 */
export class TaskBranchGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskBranchGuardError";
  }
}

/** 路由 / 队列识别用的稳定 code */
export const TASK_BRANCH_GUARD_CODE = "task_branch_guard";

/**
 * 每个仓「应该在哪条分支」。纯函数、不碰磁盘。
 *
 * 有意不管的情形（返回空）：
 * - chat 任务（没有任务分支概念）
 * - WK 主流程（分支归 WK 工作流管：AI 会自己建 / 切业务分支，runner 只在 Action 边界按 status/REQ-ID 结果帮切；
 *   在消息送达时按落盘记录硬切，可能把 AI 刚切好的分支切回旧记录）
 * - 非 git / 只读仓、没记录分支名的仓（轻量日常任务不建分支）
 */
export const collectBranchTargets = (task: Task): BranchTarget[] => {
  if (task.mode === "chat") return [];
  if (resolveFlowLock(task.actions ?? []) === "wk") return [];
  const targets: BranchTarget[] = [];

  if (isWorktreeTask(task)) {
    const expected = new Map(
      resolveExpectedWorktreeBranches(task).map((info) => [info.repoPath, info]),
    );
    const workPaths = getTaskWorkRepoPaths(task);
    task.repoPaths.forEach((repoPath, i) => {
      if (skipsWorktreeIsolation(task, repoPath)) return;
      const branch = expected.get(repoPath)?.name?.trim();
      const workDir = workPaths[i];
      if (!branch || !workDir) return;
      targets.push({ repoPath, workDir, branch, mode: "worktree" });
    });
  }

  if (isTestingRequirementTask(task)) {
    for (const repoPath of testingTaskConfiguredBranchRepoPaths(task)) {
      const branch = task.repoFeatureBranches?.[repoPath]?.trim();
      if (!branch) continue;
      targets.push({ repoPath, workDir: repoPath, branch, mode: "testing" });
    }
    return targets;
  }

  if (!isWorktreeTask(task)) {
    // in-place：只认 build 起跑时落库的任务分支记录（gitBranches）；没记录 = 还没建分支、不管
    for (const info of task.gitBranches ?? []) {
      const branch = info.name?.trim();
      if (!branch || !task.repoPaths.includes(info.repoPath)) continue;
      if (skipsWorktreeIsolation(task, info.repoPath)) continue;
      targets.push({
        repoPath: info.repoPath,
        workDir: info.repoPath,
        branch,
        mode: "in-place",
      });
    }
  }
  return targets;
};

export interface BranchGuardDeps {
  /** string = 在该分支；null = detached；undefined = 读不出（非 git / unborn / 目录没了 / 超时）——不据此判漂移 */
  readBranch: (dir: string) => Promise<string | null | undefined>;
  /** 本地是否有这条分支（in-place 判「还没建出来」用） */
  localBranchExists: (dir: string, branch: string) => Promise<boolean>;
}

const defaultDeps: BranchGuardDeps = {
  readBranch: async (dir) => {
    try {
      const { stdout } = await execFileAsync("git", [...CURRENT_BRANCH_ARGS], {
        cwd: dir,
        timeout: GIT_READ_TIMEOUT_MS,
        env: gitEnv(),
      });
      return parseCurrentBranchOutput(stdout);
    } catch {
      return undefined;
    }
  },
  localBranchExists: async (dir, branch) => {
    try {
      await execFileAsync(
        "git",
        ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
        { cwd: dir, timeout: GIT_READ_TIMEOUT_MS, env: gitEnv() },
      );
      return true;
    } catch {
      return false;
    }
  },
};

/**
 * 哪些仓现在不在应在的分支上。只读（每仓一条 `git rev-parse`、并行），读不出来的仓一律当没漂移——
 * 探测是尽力而为的护栏，不能因为 git 偶发失败卡住用户发消息（推进 / 唤醒路径仍会硬校验）。
 */
export const detectBranchDrift = async (
  task: Task,
  deps: BranchGuardDeps = defaultDeps,
): Promise<BranchDrift[]> => {
  const targets = collectBranchTargets(task);
  if (targets.length === 0) return [];
  const checked = await Promise.all(
    targets.map(async (t): Promise<BranchDrift | null> => {
      const actual = await deps.readBranch(t.workDir);
      if (actual === undefined || actual === t.branch) return null;
      // in-place 的分支记录在 build 起跑时就落库了、但分支本身要等 agent 按 hint 建出来：
      // 本地还没有这条分支 = 还没轮到切，不算漂移（否则会提醒 AI 切到一条不存在的分支）
      if (t.mode === "in-place" && !(await deps.localBranchExists(t.workDir, t.branch))) {
        return null;
      }
      return { ...t, actual };
    }),
  );
  return checked.filter((d): d is BranchDrift => d !== null);
};

const repoLabel = (repoPath: string): string =>
  path.basename(repoPath.replace(/[\\/]+$/, "")) || repoPath;

/** 一仓一句人话：「foo 在 master、任务分支是 feature/x」 */
export const describeBranchDrift = (d: BranchDrift): string =>
  `${repoLabel(d.repoPath)} 当前在「${d.actual ?? "游离 HEAD"}」、任务分支是「${d.branch}」`;

/** bash 单引号包裹：内部 `'` → `'\''`（分支名已过白名单，这里是双保险） */
const shellQuoteSingle = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * in-place 漂移时附在消息末尾的提醒（软约束）。
 * - 只列分支名过白名单的仓（名字会进 shell 命令）
 * - 明说「纯提问不用切」：用户只是想问个问题时不该被迫动他的工作区
 * - 切不过去不许 stash / reset / force：原仓里可能有用户自己的未提交改动
 * 没有可列的仓返回空串。
 */
export const buildBranchDriftNotice = (drifts: readonly BranchDrift[]): string => {
  const safe = drifts.filter((d) => isSafeBranchName(d.branch));
  if (safe.length === 0) return "";
  const lines: string[] = [
    "〈分支漂移〉系统检测到任务仓库当前所在的分支和任务分支不一致（多半是用户在 IDE 里手动切走了）：",
  ];
  for (const d of safe) lines.push(`- ${describeBranchDrift(d)}（仓库路径：${d.workDir}）`);
  lines.push(
    "如果这条消息需要**改文件 / 提交**：动手之前先逐仓切回任务分支——",
  );
  for (const d of safe) {
    lines.push(
      `\`git -C ${shellQuoteSingle(d.workDir)} checkout ${shellQuoteSingle(d.branch)}\`，` +
        `再用 \`git -C ${shellQuoteSingle(d.workDir)} branch --show-current\` 确认输出就是 ${d.branch}。`,
    );
  }
  lines.push(
    "切不过去（工作区有未提交改动会被覆盖 / 分支被别处占用等）→ **不要** stash / reset / force，调 ask_user 把情况告诉用户、等他处理；确认没在任务分支上之前绝不在当前分支改代码。",
    "如果这条消息只是提问、不需要改文件，直接回答即可，不用切分支。",
  );
  return lines.join("\n");
};
