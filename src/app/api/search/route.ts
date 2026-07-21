/**
 * GET /api/search?q=
 *
 * 对话 / 任务全文检索：标题 + events 正文。路由只做参数解析，检索逻辑在 task-search。
 */

import { NextResponse } from "next/server";

import { searchTasks } from "@/lib/server/task-search";

export const GET = async (req: Request) => {
  try {
    const q = new URL(req.url).searchParams.get("q") ?? "";
    const results = await searchTasks(q);
    return NextResponse.json({ ok: true, results });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { ok: false, error: `搜索失败：${message}` },
      { status: 500 },
    );
  }
};
