/**
 * GET /api/tasks/[id]/changes[?scope=branch|uncommitted|commit:<sha>][&base=<分支名>][&ws=1]
 *
 * 「代码改动」的文件清单：每个仓相对基线（HEAD 与线上分支的分叉点）改了哪些文件、
 * 各增删多少行。不含 patch（单文件 diff 走 /changes/file、按需拉），所以很轻、前端 chip 可轮询。
 *
 * task 与 chat 都能用。chat 以「当前所在分支」为准（每次实时读 HEAD，切分支自动跟随）。
 * 工作目录从任务元数据算、不接受前端传路径；没绑工作目录的 chat / 未启动的任务返回空 repos。
 *
 * query（都可省，默认 = 整条分支 / 自动基线 / 不忽略空白）：
 * - scope：branch（整条分支，含未提交）｜uncommitted（只看没提交的）｜commit:<sha>（单个提交）
 * - base：手动指定对比的线上分支名；找不到会回落自动探测（响应里 baseOverride.applied=false 告知）
 * - ws=1：忽略空白改动
 * 返：{ changes: TaskChanges }
 */

import { NextResponse } from "next/server";

import { parseChangesQuery } from "@/lib/changes/scope";
import { getTaskMeta } from "@/lib/server/task-fs";
import { readTaskChanges } from "@/lib/server/task-changes";

export const runtime = "nodejs";

interface Ctx {
  params: Promise<{ id: string }>;
}

export const GET = async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  const query = parseChangesQuery(new URL(req.url).searchParams);
  if (!query) return NextResponse.json({ error: "scope 参数不合法" }, { status: 400 });
  // 只读 repoPaths / worktree 等 meta 字段，不整文件 parse 事件日志
  const task = await getTaskMeta(id);
  if (!task) return NextResponse.json({ error: "not_found" }, { status: 404 });
  try {
    const changes = await readTaskChanges(task, query);
    return NextResponse.json({ changes });
  } catch (err) {
    console.error("[GET /api/tasks/[id]/changes] failed", err);
    return NextResponse.json({ error: "读取代码改动失败" }, { status: 500 });
  }
};
