/**
 * /api/tasks/[id]/events
 *
 * GET（v1.0.x 事件懒加载）：分页拉「某条事件之前」的更早历史
 *   query：before=<eventId>（必填、锚点）、limit=<N>（默认 300）
 *   返回：{ events, hasMore }——events 按时间正序、紧邻 before 之前的 N 条
 *
 * 写事件走 task-runner.writeEventAndPublish / task-fs.appendEvent，本 route 只读。
 */

import { NextResponse } from "next/server";
import {
  commitReadableTaskResponse,
  getTaskEventsBefore,
} from "@/lib/server/task-fs";
import { failpoint } from "@/lib/server/failpoints";
import { MAX_EVENTS_PAGE } from "@/lib/server/task-fs-core";

const DEFAULT_PAGE = 300;

interface Ctx {
  params: Promise<{ id: string }>;
}

export const GET = async (req: Request, { params }: Ctx) => {
  try {
    const { id } = await params;
    const url = new URL(req.url);
    const before = url.searchParams.get("before") ?? "";
    if (!before) {
      return NextResponse.json({ error: "before 必填" }, { status: 400 });
    }
    const limitRaw = url.searchParams.get("limit");
    const limitParsed = limitRaw ? Number.parseInt(limitRaw, 10) : NaN;
    const limit =
      Number.isFinite(limitParsed) && limitParsed > 0
        ? Math.min(limitParsed, MAX_EVENTS_PAGE)
        : DEFAULT_PAGE;

    // 流式向前扫到 cursor、只留一页窗口——不整文件 parse 进内存
    const page = await getTaskEventsBefore(id, before, limit);
    // R34-3：HTTP 提交点同步复查
    await failpoint("httpRead.afterHelper");
    if (!page) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    return commitReadableTaskResponse(id, () => page);
  } catch (err) {
    console.error("[GET /api/tasks/[id]/events] failed", err);
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
};
