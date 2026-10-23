/**
 * GET /api/tasks/[id]/changes/commits[?base=<分支名>]
 *
 * 各仓「基线（线上分支分叉点）之后」的提交列表，新到旧、最多 200 条——
 * 改动面板的「范围」选择器用它列出可单独查看的提交（点某个提交 = scope=commit:<sha>）。
 * 找不到线上分支的仓返回 unavailable="no_base"、不拿整段历史凑数。
 *
 * 工作目录从任务元数据算、不接受前端传路径。
 * 返：{ commits: TaskChangeCommits }
 */

import { NextResponse } from "next/server";

import { normalizeBaseRefParam } from "@/lib/changes/scope";
import { getTaskMeta } from "@/lib/server/task-fs";
import { readTaskChangeCommits } from "@/lib/server/task-changes";

export const runtime = "nodejs";

interface Ctx {
  params: Promise<{ id: string }>;
}

export const GET = async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  const baseRef = normalizeBaseRefParam(new URL(req.url).searchParams.get("base"));
  const task = await getTaskMeta(id);
  if (!task) return NextResponse.json({ error: "not_found" }, { status: 404 });
  try {
    const commits = await readTaskChangeCommits(task, { baseRef });
    return NextResponse.json({ commits });
  } catch (err) {
    console.error("[GET /api/tasks/[id]/changes/commits] failed", err);
    return NextResponse.json({ error: "读取提交列表失败" }, { status: 500 });
  }
};
