/**
 * GET /api/tasks/search?q=
 *
 * 侧栏正文搜索：扫 chat 任务 events.jsonl 中 user_reply / assistant_message。
 * q 少于 2 字直接返空 hits（标题搜仍由客户端本地做）。
 */

import { NextResponse } from "next/server";

import { searchChatTaskContents } from "@/lib/server/task-content-search";

export const GET = async (req: Request) => {
  try {
    const url = new URL(req.url);
    const q = (url.searchParams.get("q") ?? "").trim();
    if (q.length < 2) {
      return NextResponse.json({ hits: [] as { taskId: string; snippet: string }[] });
    }
    const hits = await searchChatTaskContents(q);
    return NextResponse.json({ hits });
  } catch (err) {
    console.error("[GET /api/tasks/search] failed", err);
    return NextResponse.json({ error: "search_failed" }, { status: 500 });
  }
};
