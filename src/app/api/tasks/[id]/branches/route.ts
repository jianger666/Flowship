/**
 * /api/tasks/[id]/branches
 *
 *   GET  → 读某仓工作目录的本地 git 分支状态（?repoPath= 可选；缺省 = repoPaths[0]，chat 行为）
 *   POST → 切分支（body {branch, repoPath?} → git checkout）
 *
 * 工作目录从 task 权威数据取（不接受前端传任意 path、防越权 git 操作）：
 * - 带 repoPath：task 模式按仓切——用 worktree 感知的该仓工作目录（与前端 WorkspaceActions 同源）
 * - 不带：自由对话单仓（repoPaths[0]）
 */

import { NextResponse } from "next/server";
import { existsSync } from "node:fs";

import {
  checkoutGitBranch,
  readGitBranchState,
} from "@/lib/server/git-branches";
import { getTask } from "@/lib/server/task-fs";
import { getRepoWorkDirs } from "@/lib/path-utils";
import type { Task } from "@/lib/types";

export const runtime = "nodejs";

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * 某仓的工作目录解析：
 * - 带 repoPath（task 模式按仓切）→ worktree 感知的该仓目录（与 WorkspaceActions 的
 *   ideTargets.workDir 同源）；worktree 目录不存在（任务未启动 / 已清）→ worktreeMissing=true，
 *   只读提示、禁止切换；repoPath 不在 task.repoPaths → null（防越权）
 * - 不带（chat 单仓）→ repoPaths[0]、无 worktree 概念
 */
const resolveWorkDir = (
  task: Task,
  repoPath?: string | null,
): { dir: string | null; worktreeMissing: boolean } => {
  if (repoPath) {
    if (!task.repoPaths.includes(repoPath)) {
      return { dir: null, worktreeMissing: false };
    }
    if (!task.workCwd) {
      return { dir: repoPath, worktreeMissing: false };
    }
    const dirs = getRepoWorkDirs(
      task.repoPaths,
      task.workCwd,
      task.isolateWorktree === true,
      task.nonGitRepoPaths,
      task.readonlyRepoPaths,
    );
    const workDir = dirs.find((d) => d.repoPath === repoPath)?.workDir ?? null;
    if (workDir) {
      return { dir: workDir, worktreeMissing: !existsSync(workDir) };
    }
    return { dir: repoPath, worktreeMissing: false };
  }
  return { dir: task.repoPaths[0] ?? null, worktreeMissing: false };
};

export const GET = async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  const task = await getTask(id);
  if (!task) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const repoPath = new URL(req.url).searchParams.get("repoPath")?.trim() || null;
  const { dir, worktreeMissing } = resolveWorkDir(task, repoPath);
  if (!dir) {
    return NextResponse.json({
      state: { isRepo: false, current: null, branches: [] },
    });
  }
  const state = await readGitBranchState(dir);
  if (worktreeMissing) state.worktreeMissing = true;
  return NextResponse.json({ state });
};

export const POST = async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  let body: { branch?: string; repoPath?: string };
  try {
    body = (await req.json()) as { branch?: string; repoPath?: string };
  } catch {
    return NextResponse.json({ error: "body 不是合法 JSON" }, { status: 400 });
  }
  const branch = body.branch?.trim();
  if (!branch) {
    return NextResponse.json({ error: "branch 必填" }, { status: 400 });
  }
  const task = await getTask(id);
  if (!task) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const repoPath = body.repoPath?.trim() || null;
  if (
    repoPath &&
    (task.readonlyRepoPaths ?? []).includes(repoPath)
  ) {
    return NextResponse.json(
      { error: "只读仓库不能切分支" },
      { status: 400 },
    );
  }
  const { dir, worktreeMissing } = resolveWorkDir(task, repoPath);
  if (!dir) {
    return NextResponse.json(
      { error: "该对话未绑定工作目录" },
      { status: 400 },
    );
  }
  // worktree 未就绪：不给切（隔离语义下切原仓会干扰后续建 worktree / 提交）
  if (worktreeMissing) {
    return NextResponse.json(
      { error: "worktree 尚未就绪，暂不能切换分支" },
      { status: 400 },
    );
  }
  // running 时不许切：agent 正用这个 cwd 跑、切分支会扰乱工作区
  if (task.runStatus === "running") {
    return NextResponse.json(
      { error: "agent 运行中、停下再切分支" },
      { status: 409 },
    );
  }
  const result = await checkoutGitBranch(dir, branch);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  const state = await readGitBranchState(dir);
  return NextResponse.json({ ok: true, state });
};
