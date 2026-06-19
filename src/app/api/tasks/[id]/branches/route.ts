/**
 * /api/tasks/[id]/branches
 *
 *   GET  → 读 chat 工作目录（task.repoPaths[0]）的本地 git 分支状态
 *   POST → 切分支（body {branch} → git checkout）
 *
 * V0.8 自由对话工作目录分支切换。工作目录从 task 权威数据取（不接受前端传任意 path、防越权 git 操作）。
 */

import { NextResponse } from "next/server";

import {
  checkoutGitBranch,
  readGitBranchState,
} from "@/lib/server/git-branches";
import { getTask } from "@/lib/server/task-fs";

export const runtime = "nodejs";

interface Ctx {
  params: Promise<{ id: string }>;
}

// chat 工作目录 = repoPaths[0]（chat 只绑单个）；空则无目录
const workdirOf = (repoPaths: string[]): string | null => repoPaths[0] ?? null;

export const GET = async (_req: Request, { params }: Ctx) => {
  const { id } = await params;
  const task = await getTask(id);
  if (!task) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const dir = workdirOf(task.repoPaths);
  if (!dir) {
    return NextResponse.json({
      state: { isRepo: false, current: null, branches: [] },
    });
  }
  const state = await readGitBranchState(dir);
  return NextResponse.json({ state });
};

export const POST = async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  let body: { branch?: string };
  try {
    body = (await req.json()) as { branch?: string };
  } catch {
    return NextResponse.json({ error: "body 不是合法 JSON" }, { status: 400 });
  }
  const branch = body.branch?.trim();
  if (!branch) {
    return NextResponse.json({ error: "branch 必填" }, { status: 400 });
  }
  const task = await getTask(id);
  if (!task) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const dir = workdirOf(task.repoPaths);
  if (!dir) {
    return NextResponse.json(
      { error: "该对话未绑定工作目录" },
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
