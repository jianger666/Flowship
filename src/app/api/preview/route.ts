/**
 * /api/preview——按仓多预览位 dev server
 *
 *   GET    → { slots: PreviewSlotStatus[] }（全部预览位）
 *   POST   → 起预览：{ taskId, repoPath }——只顶掉同仓旧位、其它仓不动
 *   DELETE → 停预览：body { repoPath? }——带 = 停该仓、不带 = 全停（幂等）
 *
 * workDir 由 server 按 task 算（隔离 task = worktree、否则原仓库）、不信 client 传目录。
 * CR-01：**命令也不信 client**——原来接受任意 command 直接 spawn(shell:true)、
 * 构成「建 chat task → 起 preview」的无鉴权 RCE 链；改为服务端按 repoPath 从权威
 * config.json 查设置页配的 previewCommand、client 只能选「预览哪个仓」。
 */
import { promises as fs } from "node:fs";
import { NextResponse } from "next/server";

import { errorResponse } from "@/lib/server/route-helpers";
import { getRepoPreviewCommand } from "@/lib/server/settings-fs";
import { getTask } from "@/lib/server/task-fs";
import { getTaskWorkRepoPaths } from "@/lib/server/task-worktrees";
import {
  getPreviewStatus,
  startPreview,
  stopAllPreviews,
  stopPreview,
} from "@/lib/server/preview-manager";

export const runtime = "nodejs";

export const GET = async () => NextResponse.json({ slots: getPreviewStatus() });

export const POST = async (req: Request) => {
  let body: { taskId?: string; repoPath?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return errorResponse("body 不是合法 JSON");
  }
  const taskId = body.taskId?.trim();
  const repoPath = body.repoPath?.trim();
  if (!taskId || !repoPath) {
    return errorResponse("缺少 taskId / repoPath");
  }

  const task = await getTask(taskId);
  if (!task) return errorResponse("task 不存在", 404);
  const idx = task.repoPaths.indexOf(repoPath);
  if (idx < 0) {
    return errorResponse(`repoPath 不属于该任务：${repoPath}`);
  }

  // 命令唯一来源 = 设置页 per-repo 配置（服务端权威 config.json）、不接受请求注入
  const command = await getRepoPreviewCommand(repoPath);
  if (!command) {
    return errorResponse("该仓库未配置预览启动命令（设置页 → 仓库列表）", 409);
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

export const DELETE = async (req: Request) => {
  let repoPath: string | undefined;
  try {
    const body = (await req.json()) as { repoPath?: string };
    repoPath = body.repoPath?.trim() || undefined;
  } catch {
    // 无 body / 非法 JSON → 全停
  }
  if (repoPath) {
    await stopPreview(repoPath);
  } else {
    await stopAllPreviews();
  }
  return NextResponse.json({ ok: true });
};
