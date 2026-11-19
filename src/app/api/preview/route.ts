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
import { NextResponse } from "next/server";

import { launchTaskPreview } from "@/lib/server/preview-launch";
import { errorResponse } from "@/lib/server/route-helpers";
import {
  getPreviewStatus,
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

  // 准入（任务 / 终态 / 仓 / 命令 / 工作区）与启动都在 launchTaskPreview：agent 的 preview 工具走同一套。
  // UI 点「预览」是用户明确的接管动作 → takeOver: true（同仓被别的任务占着就顶掉、并返回被顶的任务名）
  const launched = await launchTaskPreview({ taskId, repoPath, takeOver: true });
  if (!launched.ok) return errorResponse(launched.error, launched.status);
  return NextResponse.json({
    slot: launched.slot,
    replacedTaskTitle: launched.replacedTaskTitle,
  });
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
