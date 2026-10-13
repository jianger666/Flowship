/**
 * GET /api/tasks/[id]/changes
 *
 * task 模式「代码改动预览」的文件清单：每个仓相对基线（HEAD 与线上分支的分叉点）改了哪些文件、
 * 各增删多少行。不含 patch（单文件 diff 走 /changes/file、按需拉），所以很轻、前端 chip 可轮询。
 *
 * 工作目录从 task 权威数据算、不接受前端传路径；chat 任务 / 未启动的任务返回空 repos。
 * 返：{ changes: TaskChanges }
 */

import { NextResponse } from "next/server";

import { getTaskMeta } from "@/lib/server/task-fs";
import { readTaskChanges } from "@/lib/server/task-changes";

export const runtime = "nodejs";

interface Ctx {
  params: Promise<{ id: string }>;
}

export const GET = async (_req: Request, { params }: Ctx) => {
  const { id } = await params;
  // 只读 repoPaths / worktree 等 meta 字段，不整文件 parse 事件日志
  const task = await getTaskMeta(id);
  if (!task) return NextResponse.json({ error: "not_found" }, { status: 404 });
  try {
    const changes = await readTaskChanges(task);
    return NextResponse.json({ changes });
  } catch (err) {
    console.error("[GET /api/tasks/[id]/changes] failed", err);
    return NextResponse.json({ error: "读取代码改动失败" }, { status: 500 });
  }
};
