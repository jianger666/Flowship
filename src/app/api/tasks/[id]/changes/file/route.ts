/**
 * GET /api/tasks/[id]/changes/file?repoPath=<原仓路径>&path=<仓内相对路径>
 *     [&oldPath=<重命名前路径>][&scope=…][&base=…][&ws=1][&full=1]
 *
 * 单个文件的 unified diff（按需拉取、避免一次吞下整个大 diff）。
 * scope / base / ws 与 /changes 含义一致；full=1 返回整文件内容（-U1000000），给「展开上下文」用。
 *
 * 安全：repoPath 必须在本任务的改动范围内（任务元数据权威）；path / oldPath 必须是仓内相对路径；
 * 未跟踪文件只有确实「未跟踪且未被 ignore」才会读盘（读不到 .env 之类被忽略的文件）；
 * commit:<sha> 必须是当前分支上、线上分支分叉点之后的提交（否则 409），不能借此翻任意历史。
 * 返：{ file: TaskChangeFileDiff }
 */

import { NextResponse } from "next/server";

import { parseChangesQuery } from "@/lib/changes/scope";
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
  const query = parseChangesQuery(url.searchParams);
  if (!query) return NextResponse.json({ error: "scope 参数不合法" }, { status: 400 });
  const task = await getTaskMeta(id);
  if (!task) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const result = await readTaskChangeFileDiff(task, repoPath, filePath, oldPath, {
    ...query,
    fullContext: url.searchParams.get("full") === "1",
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json({ file: result.data });
};
