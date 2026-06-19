/**
 * chat 工作目录的 git 分支读写（V0.8）
 *
 * 跟 task.gitBranches（agent 跑 checkout 后 upsert 的「工作分支记录」、task 模式用）是两码事——
 * 这里是「读某目录现有的本地分支 + 直接 checkout 切换」，给自由对话的工作目录分支选择器用
 * （对齐 codex / Cursor：cwd 是 git 仓时能看当前分支、下拉切换）。
 *
 * 全部 best-effort + execFile（不走 shell、无注入面）：非 git 仓 / 命令失败一律降级、不抛。
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { GitBranchState } from "../types";

const execFileAsync = promisify(execFile);

/**
 * 读某目录的本地 git 分支状态。
 * 非 git 仓 / 命令失败 → isRepo=false（调用方据此隐藏分支选择器）。
 */
export const readGitBranchState = async (
  dir: string,
): Promise<GitBranchState> => {
  const empty: GitBranchState = { isRepo: false, current: null, branches: [] };
  if (!dir) return empty;
  try {
    // 当前分支：detached HEAD 时 git 返回字面 "HEAD"、归一成 null
    const { stdout: head } = await execFileAsync(
      "git",
      ["rev-parse", "--abbrev-ref", "HEAD"],
      { cwd: dir, timeout: 10_000 },
    );
    const current = head.trim();
    // 本地分支列表：refname:short 只出名字（不带 * 前缀）、按最近提交倒序更顺手
    const { stdout: list } = await execFileAsync(
      "git",
      ["branch", "--format=%(refname:short)", "--sort=-committerdate"],
      { cwd: dir, timeout: 10_000 },
    );
    const branches = list
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    return {
      isRepo: true,
      current: current && current !== "HEAD" ? current : null,
      branches,
    };
  } catch {
    return empty;
  }
};

/**
 * 切换某目录的 git 分支（git checkout）。
 * 失败（分支不存在 / 工作区有未提交改动会被覆盖 / 非 git 仓）把 git stderr 带回、调用方 toast。
 */
export const checkoutGitBranch = async (
  dir: string,
  branch: string,
): Promise<{ ok: true } | { ok: false; error: string }> => {
  if (!dir) return { ok: false, error: "工作目录为空" };
  const b = branch.trim();
  if (!b) return { ok: false, error: "分支名为空" };
  // 防 "-" 开头被 git 当 flag 解析（合法分支名不以 - 开头）
  if (b.startsWith("-")) return { ok: false, error: `非法分支名：${b}` };
  try {
    await execFileAsync("git", ["checkout", b], { cwd: dir, timeout: 15_000 });
    return { ok: true };
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    const msg = (e.stderr || e.message || "git checkout 失败").trim();
    return { ok: false, error: msg };
  }
};
