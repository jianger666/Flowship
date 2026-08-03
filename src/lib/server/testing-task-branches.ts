import { execFile } from "node:child_process";

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

const execGit = (
  cwd: string,
  args: string[],
  signal: AbortSignal,
  timeout = 15_000,
): Promise<GitResult> =>
  new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd, timeout, signal, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              `${error.message}${stderr.trim() ? `：${stderr.trim()}` : ""}`,
            ),
          );
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

const assertLease = (lease: () => boolean): void => {
  if (!lease()) throw new TestingBranchLeaseLostError();
};

/**
 * 在测试任务的每个 Action 启动前，把所有已填写的「被测业务分支」确定性检出到原仓库。
 *
 * - 留空仓库不处理：允许开发分支尚未建立时先写测试方案；prompt 会限制 AI 不得验收当前代码。
 * - 工作区有任何未提交改动时拒绝切换，避免覆盖用户现场。
 * - 本地没有但 origin 有的分支会建立 tracking branch；只有本地 / 已知远端都没有时才 fetch 一次。
 * - 不 pull、不 reset；记录实际 HEAD，确保报告能对应到具体提交。
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
        await execGit(repoPath, ["check-ref-format", "--branch", branch], controller.signal);
      } catch {
        throw new Error(`仓库 ${repoPath} 的被测业务分支名不合法：${branch}`);
      }

      const status = await execGit(
        repoPath,
        ["status", "--porcelain", "--untracked-files=normal"],
        controller.signal,
      ).catch((err) => {
        throw new Error(`无法读取测试仓库状态：${repoPath}（${(err as Error).message}）`);
      });
      if (status.stdout.trim()) {
        throw new Error(
          `测试仓库存在未提交改动，未自动切换分支：${repoPath}。请先提交或自行处理这些改动，再启动 Action。`,
        );
      }

      const current = await execGit(
        repoPath,
        ["symbolic-ref", "--quiet", "--short", "HEAD"],
        controller.signal,
      ).catch(() => ({ stdout: "", stderr: "" }));
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
            30_000,
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
        currentBranch: current.stdout.trim() || null,
        currentCommit,
        checkoutFrom,
      });
    }

    const switched: PreparedRepo[] = [];
    try {
      for (const repo of prepared) {
        assertLease(lease);
        if (repo.currentBranch !== repo.branch) {
          await execGit(
            repo.repoPath,
            repo.checkoutFrom
              ? ["checkout", "--track", "-b", repo.branch, repo.checkoutFrom]
              : ["checkout", repo.branch],
            controller.signal,
          );
          switched.push(repo);
        }
      }
    } catch (err) {
      // checkout 失败时尽力回到进入本次准备前的分支 / detached 提交，避免多仓只切一半。
      if (lease()) {
        for (const repo of switched.reverse()) {
          const target = repo.currentBranch ?? repo.currentCommit;
          await execGit(
            repo.repoPath,
            repo.currentBranch ? ["checkout", target] : ["checkout", "--detach", target],
            controller.signal,
          ).catch(() => {});
        }
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
