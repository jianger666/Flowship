import { execFile, type ExecFileException } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

import type { GitBranchInfo, Task } from "@/lib/types";
import { testingTaskConfiguredBranchRepoPaths } from "@/lib/testing-task";
import {
  beginResourceJob,
  endResourceJob,
  registerJobAbort,
} from "./resource-jobs";

export class TestingBranchLeaseLostError extends Error {
  constructor() {
    super("测试任务分支准备已让位");
    this.name = "TestingBranchLeaseLostError";
  }
}

interface GitResult {
  stdout: string;
  stderr: string;
}

interface PreparedRepo {
  repoPath: string;
  branch: string;
  currentBranch: string | null;
  currentCommit: string;
  checkoutFrom?: string;
}

const GIT_QUICK_TIMEOUT_MS = 15_000;
const GIT_FETCH_TIMEOUT_MS = 30_000;
/** 大仓从 master 切到远端 feature 可能要写大量文件，15s 会被杀掉、留下半截 index。 */
const GIT_CHECKOUT_TIMEOUT_MS = 60_000;
const DIRTY_PATH_PREVIEW = 8;

/**
 * 未跟踪时不挡切分支的编译 / 缓存目录名。
 * 只过滤 `??` 行；已跟踪文件的改动仍会拦住，避免把用户源码当产物丢掉。
 */
const BUILD_ARTIFACT_SEGMENTS = new Set([
  "target",
  "node_modules",
  ".next",
  "dist",
  "build",
  "out",
  "coverage",
  "__pycache__",
  ".turbo",
  ".gradle",
  ".nuxt",
  ".output",
  ".parcel-cache",
  "bower_components",
]);

export const isBuildArtifactPath = (filePath: string): boolean => {
  const normalized = filePath.replaceAll("\\", "/").replace(/\/+$/, "");
  return normalized
    .split("/")
    .some((seg) => BUILD_ARTIFACT_SEGMENTS.has(seg));
};

const stripPorcelainQuotes = (value: string): string => {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replaceAll('\\"', '"');
  }
  return trimmed;
};

/** porcelain v1 一行里的路径；rename/copy 取箭头右侧。 */
const porcelainPath = (line: string): string => {
  const rest = line.slice(3);
  const arrow = rest.lastIndexOf(" -> ");
  if ((line.startsWith("R") || line.startsWith("C")) && arrow >= 0) {
    return stripPorcelainQuotes(rest.slice(arrow + 4));
  }
  return stripPorcelainQuotes(rest);
};

/**
 * `git status -u normal` 会把整棵未跟踪目录收成 `?? pkg/`。
 * 目录名本身不是 target，但里面可能全是编译产物。
 */
const untrackedDirOnlyBuildArtifacts = async (
  repoPath: string,
  relPath: string,
): Promise<boolean> => {
  const abs = path.join(repoPath, relPath);
  try {
    const st = await fs.stat(abs);
    if (!st.isDirectory()) return false;
    const children = await fs.readdir(abs);
    if (children.length === 0) return false;
    return children.every((name) =>
      isBuildArtifactPath(path.posix.join(relPath.replaceAll("\\", "/"), name)),
    );
  } catch {
    return false;
  }
};

/** 会挡住自动切分支的路径：已跟踪改动 + 非编译产物的未跟踪文件。 */
export const blockingPorcelainPaths = (porcelain: string): string[] => {
  const paths: string[] = [];
  for (const line of porcelain.split("\n")) {
    if (line.length < 4) continue;
    const xy = line.slice(0, 2);
    const filePath = porcelainPath(line);
    if (!filePath) continue;
    if (xy === "??" && isBuildArtifactPath(filePath)) continue;
    paths.push(filePath);
  }
  return paths;
};

const collectDirtyPaths = async (
  repoPath: string,
  porcelain: string,
): Promise<string[]> => {
  const dirty: string[] = [];
  for (const filePath of blockingPorcelainPaths(porcelain)) {
    if (await untrackedDirOnlyBuildArtifacts(repoPath, filePath)) continue;
    dirty.push(filePath);
  }
  return dirty;
};

const formatGitError = (
  error: ExecFileException,
  args: string[],
  stderr: string,
): string => {
  const stderrText = stderr.trim();
  const timedOut =
    error.killed === true ||
    error.signal === "SIGTERM" ||
    error.code === "ABORT_ERR";
  if (timedOut) {
    return `git ${args.join(" ")} 超时或被中断${stderrText ? `：${stderrText}` : ""}`;
  }
  if (stderrText) return stderrText;
  const stripped = error.message.replace(/^Command failed: [^\n]*\n?/, "").trim();
  return stripped || error.message;
};

const execGit = (
  cwd: string,
  args: string[],
  signal: AbortSignal,
  timeout = GIT_QUICK_TIMEOUT_MS,
): Promise<GitResult> =>
  new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        cwd,
        timeout,
        signal,
        encoding: "utf8",
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(formatGitError(error, args, stderr)));
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });

const refExists = async (
  cwd: string,
  ref: string,
  signal: AbortSignal,
): Promise<boolean> => {
  try {
    await execGit(cwd, ["show-ref", "--verify", "--quiet", ref], signal);
    return true;
  } catch {
    return false;
  }
};

const currentBranchName = async (
  cwd: string,
  signal: AbortSignal,
): Promise<string> =>
  (
    await execGit(
      cwd,
      ["symbolic-ref", "--quiet", "--short", "HEAD"],
      signal,
    ).catch(() => ({ stdout: "", stderr: "" }))
  ).stdout.trim();

const assertLease = (lease: () => boolean): void => {
  if (!lease()) throw new TestingBranchLeaseLostError();
};

const formatDirtyError = (repoPath: string, paths: string[]): string => {
  const lines = [
    `测试仓库存在未提交改动，未自动切换分支：${repoPath}`,
    ...paths.slice(0, DIRTY_PATH_PREVIEW).map((p) => `  ${p}`),
  ];
  if (paths.length > DIRTY_PATH_PREVIEW) {
    lines.push(`  …其余 ${paths.length - DIRTY_PATH_PREVIEW} 个`);
  }
  lines.push("请先提交或自行处理这些改动，再启动 Action。");
  return lines.join("\n");
};

/**
 * 切分支失败后把仓拉回进入前的干净状态。
 * 调用方保证切之前工作区没有用户改动（编译产物除外），所以这里可以 hard reset。
 * 不走 job 的 AbortSignal：checkout 被 SIGTERM 杀掉时那个 signal 已经 aborted，
 * 再用它复位会立刻失败，半截 index 就留给用户了。
 */
export const restoreRepoAfterFailedTestingCheckout = async (
  repo: PreparedRepo,
  signal: AbortSignal,
): Promise<void> => {
  const git = (args: string[], timeout = GIT_CHECKOUT_TIMEOUT_MS) =>
    execGit(repo.repoPath, args, signal, timeout);
  await git(["reset", "--hard", "HEAD"]).catch(() => {});
  // 失败的 checkout 可能留下对端分支的未跟踪新文件（reset --hard 不管 untracked）。
  // 切之前已挡住用户源码，这里清掉的只可能是编译产物或半截检出文件。
  await git(["clean", "-fd"], GIT_QUICK_TIMEOUT_MS).catch(() => {});
  const nowBranch = await currentBranchName(repo.repoPath, signal);
  if (nowBranch === repo.branch && repo.currentBranch !== repo.branch) {
    const target = repo.currentBranch ?? repo.currentCommit;
    await git(
      repo.currentBranch
        ? ["checkout", target]
        : ["checkout", "--detach", target],
    ).catch(() => {});
  }
  // `--track -b` 可能半截建出本地分支；进入前本地没有这条才删，避免误删用户已有分支。
  if (!repo.checkoutFrom) return;
  const localRef = `refs/heads/${repo.branch}`;
  if (!(await refExists(repo.repoPath, localRef, signal))) return;
  const after = await currentBranchName(repo.repoPath, signal);
  if (after === repo.branch) return;
  await git(["branch", "-D", repo.branch], GIT_QUICK_TIMEOUT_MS).catch(() => {});
};

/**
 * 在测试任务的每个 Action 启动前，把所有已填写的「被测业务分支」确定性检出到原仓库。
 *
 * - 留空仓库不处理：允许开发分支尚未建立时先写测试方案；prompt 会限制 AI 不得验收当前代码。
 * - 已跟踪改动 / 非编译产物的未跟踪文件拒绝切换，避免覆盖用户现场。
 * - `target/`、`node_modules/` 这类未跟踪编译产物不挡；git 若会覆盖同路径跟踪文件，checkout 自己会失败。
 * - 本地没有但 origin 有的分支会建立 tracking branch；只有本地 / 已知远端都没有时才 fetch 一次。
 * - 不 pull；checkout 失败会 hard reset 失败仓并回滚已切成功的仓，不把半截 index 留给下一轮。
 *   复位会 `clean -fd`：半截检出留下的未跟踪新文件会删掉（含未跟踪的编译产物）。
 * - 记录实际 HEAD，确保报告能对应到具体提交。
 */
export const prepareTestingTaskBranches = async (
  task: Task,
  lease: () => boolean,
): Promise<GitBranchInfo[]> => {
  const repoPaths = testingTaskConfiguredBranchRepoPaths(task);
  if (repoPaths.length === 0) return [];

  const job = beginResourceJob(task.id);
  const controller = new AbortController();
  registerJobAbort(task.id, job.jobId, () => controller.abort());

  try {
    const prepared: PreparedRepo[] = [];
    for (const repoPath of repoPaths) {
      assertLease(lease);
      const branch = task.repoFeatureBranches?.[repoPath]?.trim();
      if (!branch) continue;

      try {
        await execGit(
          repoPath,
          ["check-ref-format", "--branch", branch],
          controller.signal,
        );
      } catch {
        throw new Error(`仓库 ${repoPath} 的被测业务分支名不合法：${branch}`);
      }

      const status = await execGit(
        repoPath,
        ["status", "--porcelain", "--untracked-files=normal"],
        controller.signal,
      ).catch((err) => {
        throw new Error(
          `无法读取测试仓库状态：${repoPath}（${(err as Error).message}）`,
        );
      });
      const dirtyPaths = await collectDirtyPaths(repoPath, status.stdout);
      if (dirtyPaths.length > 0) {
        throw new Error(formatDirtyError(repoPath, dirtyPaths));
      }

      const currentBranch = await currentBranchName(repoPath, controller.signal);
      const currentCommit = (
        await execGit(repoPath, ["rev-parse", "HEAD"], controller.signal)
      ).stdout.trim();

      let checkoutFrom: string | undefined;
      const localRef = `refs/heads/${branch}`;
      if (!(await refExists(repoPath, localRef, controller.signal))) {
        const originRef = `refs/remotes/origin/${branch}`;
        if (!(await refExists(repoPath, originRef, controller.signal))) {
          // 手填的远端新分支可能不在本地 refs 中；只在缺失时 fetch，不在每次 Action 偷偷更新。
          await execGit(
            repoPath,
            [
              "fetch",
              "origin",
              `refs/heads/${branch}:refs/remotes/origin/${branch}`,
            ],
            controller.signal,
            GIT_FETCH_TIMEOUT_MS,
          ).catch((err) => {
            throw new Error(
              `找不到被测业务分支 ${branch}，且从 origin 获取失败：${repoPath}（${(err as Error).message}）`,
            );
          });
          if (!(await refExists(repoPath, originRef, controller.signal))) {
            throw new Error(`仓库 ${repoPath} 中不存在被测业务分支：${branch}`);
          }
        }
        checkoutFrom = `origin/${branch}`;
      }

      prepared.push({
        repoPath,
        branch,
        currentBranch: currentBranch || null,
        currentCommit,
        checkoutFrom,
      });
    }

    const switched: PreparedRepo[] = [];
    let inFlight: PreparedRepo | null = null;
    try {
      for (const repo of prepared) {
        assertLease(lease);
        if (repo.currentBranch === repo.branch) continue;
        inFlight = repo;
        await execGit(
          repo.repoPath,
          repo.checkoutFrom
            ? ["checkout", "--track", "-b", repo.branch, repo.checkoutFrom]
            : ["checkout", repo.branch],
          controller.signal,
          GIT_CHECKOUT_TIMEOUT_MS,
        );
        switched.push(repo);
        inFlight = null;
      }
    } catch (err) {
      // job signal 可能已经 aborted（超时 / 让位 / 连点推进），复位必须换新 signal。
      const cleanup = new AbortController();
      if (inFlight) {
        await restoreRepoAfterFailedTestingCheckout(inFlight, cleanup.signal);
      }
      for (const repo of switched.reverse()) {
        await restoreRepoAfterFailedTestingCheckout(repo, cleanup.signal);
      }
      if (err instanceof TestingBranchLeaseLostError) throw err;
      const failed = inFlight;
      const detail = err instanceof Error ? err.message : String(err);
      if (failed) {
        throw new Error(
          `无法检出被测业务分支 ${failed.branch}：${failed.repoPath}\n${detail}`,
        );
      }
      throw err;
    }

    const infos: GitBranchInfo[] = [];
    for (const repo of prepared) {
      assertLease(lease);
      const headCommit = (
        await execGit(repo.repoPath, ["rev-parse", "HEAD"], controller.signal)
      ).stdout.trim();
      infos.push({
        repoPath: repo.repoPath,
        name: repo.branch,
        baseBranch: "",
        headCommit,
      });
    }
    return infos;
  } catch (err) {
    if (!lease() || controller.signal.aborted) {
      throw new TestingBranchLeaseLostError();
    }
    throw err;
  } finally {
    registerJobAbort(task.id, job.jobId, null);
    endResourceJob(job);
  }
};
