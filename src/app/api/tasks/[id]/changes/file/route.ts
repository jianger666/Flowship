/**
 * GET /api/tasks/[id]/changes/file?repoPath=<原仓路径>&path=<仓内相对路径>[&oldPath=<重命名前路径>]
 *
 * 单个文件相对基线的 unified diff（按需拉取、避免一次吞下整个大 diff）。
 *
 * 安全：repoPath 必须在本任务的改动范围内（task 权威数据）；path / oldPath 必须是仓内相对路径；
 * 未跟踪文件只有确实「未跟踪且未被 ignore」才会读盘（读不到 .env 之类被忽略的文件）。
 * 返：{ file: TaskChangeFileDiff }
 */

import { NextResponse } from "next/server";

import { getTaskMeta } from "@/lib/server/task-fs";
import { readTaskChangeFileDiff } from "@/lib/server/task-changes";

export const runtime = "nodejs";

interface Ctx {
  params: Promise<{ id: string }>;
}

export const GET = async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  const url = new URL(req.url);
  const repoPath = url.searchParams.get("repoPath")?.trim();
  const filePath = url.searchParams.get("path");
  const oldPath = url.searchParams.get("oldPath");
  if (!repoPath || !filePath) {
    return NextResponse.json({ error: "repoPath / path 必填" }, { status: 400 });
  }
  const task = await getTaskMeta(id);
  if (!task) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const result = await readTaskChangeFileDiff(task, repoPath, filePath, oldPath);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json({ file: result.data });
};
