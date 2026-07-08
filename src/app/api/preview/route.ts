/**
 * /api/preview——单预览位 dev server（V0.10.1）
 *
 *   GET    → 当前预览位状态（null = 没在预览）
 *   POST   → 起预览：{ taskId, repoPath, command }——自动停掉上一个任务的预览（单位语义）
 *   DELETE → 停预览（幂等）
 *
 * workDir 由 server 按 task 算（隔离 task = worktree、否则原仓库）、不信 client 传目录。
 * 信任模型同 /api/repo-branches：本地单用户桌面 app、repoPath 校验「属于该 task」即可。
 */
import { promises as fs } from "node:fs";
import { NextResponse } from "next/server";

import { errorResponse } from "@/lib/server/route-helpers";
import { getTask } from "@/lib/server/task-fs";
import { getTaskWorkRepoPaths } from "@/lib/server/task-worktrees";
import {
  getPreviewStatus,
  startPreview,
  stopPreview,
} from "@/lib/server/preview-manager";

export const runtime = "nodejs";

export const GET = async () => NextResponse.json({ slot: getPreviewStatus() });

export const POST = async (req: Request) => {
  let body: { taskId?: string; repoPath?: string; command?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return errorResponse("body 不是合法 JSON");
  }
  const taskId = body.taskId?.trim();
  const repoPath = body.repoPath?.trim();
  const command = body.command?.trim();
  if (!taskId || !repoPath || !command) {
    return errorResponse("缺少 taskId / repoPath / command");
  }
  if (command.length > 500) {
    return errorResponse("command 过长（上限 500 字符）");
  }

  const task = await getTask(taskId);
  if (!task) return errorResponse("task 不存在", 404);
  const idx = task.repoPaths.indexOf(repoPath);
  if (idx < 0) {
    return errorResponse(`repoPath 不属于该任务：${repoPath}`);
  }

  // 工作目录：隔离 task = 该仓 worktree、非隔离 = 原仓库（getTaskWorkRepoPaths 统一处理）
  const workDir = getTaskWorkRepoPaths(task)[idx];
  try {
    await fs.access(workDir);
  } catch {
    return errorResponse(
      "任务工作区还没创建（先推进一次任务、系统会自动建隔离工作区）",
      409,
    );
  }

  const { replacedTaskTitle, status } = await startPreview({
    taskId,
    taskTitle: task.title,
    repoPath,
    workDir,
    command,
  });
  return NextResponse.json({ slot: status, replacedTaskTitle });
};

export const DELETE = async () => {
  await stopPreview();
  return NextResponse.json({ ok: true });
};
