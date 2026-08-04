/**
 * WK 业务分支解析（帮切用）与联调 / 提测源分支校验。
 *
 * 「有现成业务分支就帮切」是 Flowship 工作区准备的锦上添花；解析失败不拦推进。
 * 分支对错的权威检查在团队规范（harness / AI），不在本模块硬门禁。
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { resolveFlowLock } from "@/lib/flow-mutex";
import { resolveReqId } from "@/lib/req-id";
import type { GitBranchInfo, Task } from "@/lib/types";

import { getTaskWorkRepoPaths } from "./task-worktrees";

const STATUS_BRANCH_KEYS = [
  "expected_git_branch",
  "git_branch",
  "branch",
] as const;

const execFileAsync = promisify(execFile);

export const parseWkExpectedBranch = (statusText: string): string | null => {
  for (const key of STATUS_BRANCH_KEYS) {
    // 只认顶层字段；integration.readiness.branch 等嵌套字段不属于 repo-execute 分支门禁。
    // 不能用 `\s*`：它会跨过空值后的换行，把下一行（如 `integration:`）吞成字段值。
    const match = statusText.match(
      new RegExp(`^${key}:[ \\t]*([^\\r\\n]*)$`, "m"),
    );
    const value = match?.[1]?.trim().replace(/^["']|["']$/g, "");
    if (value && !["null", "None", "~"].includes(value)) return value;
  }
  return null;
};

const repoWorkPath = (task: Task, repoPath: string): string => {
  const index = task.repoPaths.indexOf(repoPath);
  return index >= 0 ? getTaskWorkRepoPaths(task)[index] : repoPath;
};

const readExpectedBranch = async (
  task: Task,
  repoPath: string,
  reqId: string,
): Promise<string | null> => {
  const roots = [repoWorkPath(task, repoPath), repoPath];
  for (const root of new Set(roots)) {
    const statusPath = path.join(
      root,
      "wk-doc",
      "requirements",
      reqId,
      "status.yaml",
    );
    try {
      const expected = parseWkExpectedBranch(
        await fs.readFile(statusPath, "utf8"),
      );
      if (expected) return expected;
    } catch {
      // detached 预热可能还看不到业务分支上的 status.yaml，继续回退原仓 / refs。
    }
  }
  return null;
};

const branchesContainingReqId = async (
  repoPath: string,
  reqId: string,
): Promise<string[]> => {
  const names: string[] = [];
  try {
    const { stdout } = await execFileAsync(
      "git",
      [
        "for-each-ref",
        "--format=%(refname:short)",
        "refs/heads",
        "refs/remotes/origin",
      ],
      { cwd: repoPath, timeout: 30_000, maxBuffer: 2 * 1024 * 1024 },
    );
    names.push(
      ...stdout
        .split(/\r?\n/)
        .map((name) => name.trim().replace(/^origin\//, ""))
        .filter((name) => name && name !== "HEAD" && name.includes(reqId)),
    );
  } catch {
    // 继续探远端；离线时最终使用已收集到的引用。
  }
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["ls-remote", "--heads", "origin"],
      { cwd: repoPath, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
    );
    names.push(
      ...stdout
        .split(/\r?\n/)
        .map((line) => line.trim().split(/\s+/)[1] ?? "")
        .map((ref) => ref.replace(/^refs\/heads\//, ""))
        .filter((name) => name.includes(reqId)),
    );
  } catch {
    // 无 origin / 离线不阻断本地分支发现。
  }
  return [...new Set(names)].sort();
};

/** 本地 heads 或 origin 上是否已有该分支（帮切前提：现成才切） */
const branchExistsInRepo = async (
  repoPath: string,
  branch: string,
): Promise<boolean> => {
  try {
    await execFileAsync(
      "git",
      ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
      { cwd: repoPath, timeout: 30_000 },
    );
    return true;
  } catch {
    // 本地没有，再看 origin
  }
  try {
    await execFileAsync(
      "git",
      ["rev-parse", "--verify", "--quiet", `origin/${branch}`],
      { cwd: repoPath, timeout: 30_000 },
    );
    return true;
  } catch {
    return false;
  }
};

/**
 * WK 进入代码执行 / 复核前，尽力解析各仓业务分支——供隔离 worktree「有现成的就帮切」。
 *
 * 解析不到 / 多候选 / 缺 REQ-ID / 声明了但不存在 → 跳过该仓，**不抛错、不拦推进**。
 * 分支对不对由团队规范（harness 门禁 / AI）在 execute 里自己管；Flowship 只做工作区锦上添花。
 */
export const resolveWkWorktreeBranchInfos = async (
  task: Task,
): Promise<GitBranchInfo[]> => {
  const reqId = resolveReqId(task);
  if (!reqId) return [];

  const infos: GitBranchInfo[] = [];
  for (const repoPath of task.repoPaths) {
    if ((task.nonGitRepoPaths ?? []).includes(repoPath)) continue;
    if ((task.readonlyRepoPaths ?? []).includes(repoPath)) continue;

    const declared = await readExpectedBranch(task, repoPath, reqId);
    if (declared) {
      if (await branchExistsInRepo(repoPath, declared)) {
        infos.push({ repoPath, name: declared, baseBranch: "" });
      }
      continue;
    }

    const recorded = (task.gitBranches ?? []).find(
      (item) => item.repoPath === repoPath && item.name.includes(reqId),
    );
    if (recorded) {
      if (await branchExistsInRepo(repoPath, recorded.name)) {
        infos.push(recorded);
      }
      continue;
    }

    // 未声明时只在「唯一候选」时帮切；0 / 多个都交给规范侧，不在这里猜或硬拦
    const candidates = await branchesContainingReqId(repoPath, reqId);
    if (candidates.length === 1) {
      infos.push({ repoPath, name: candidates[0], baseBranch: "" });
    }
  }
  return infos;
};

export const taskUsesWkPrimaryFlow = (task: Task): boolean =>
  resolveFlowLock(task.actions) === "wk";

export const validateWkSubmitSourceBranch = async (
  task: Task,
  repoPath: string,
  sourceBranch: string,
): Promise<{ ok: true } | { ok: false; error: string }> => {
  const reqId = resolveReqId(task);
  if (!reqId) {
    return {
      ok: false,
      error: "WK 流程缺少 REQ-ID，无法确认联调/提测源分支",
    };
  }

  const source = sourceBranch.trim();
  const baseSource = source.endsWith("__conflict")
    ? source.slice(0, -"__conflict".length)
    : source;
  const expected = await readExpectedBranch(task, repoPath, reqId);
  if (expected) {
    if (baseSource === expected) return { ok: true };
    return {
      ok: false,
      error: `WK source_branch 必须是 status.yaml 声明的「${expected}」或其 __conflict 分支，收到「${sourceBranch}」`,
    };
  }

  if (baseSource.includes(reqId)) return { ok: true };
  return {
    ok: false,
    error: `WK status.yaml 未声明分支时，source_branch 必须包含 REQ-ID「${reqId}」，收到「${sourceBranch}」`,
  };
};
