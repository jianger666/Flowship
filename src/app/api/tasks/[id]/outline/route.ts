/**
 * /api/tasks/[id]/outline
 *
 * GET：事件流左侧「提问时间线」的大纲——这个任务里全部属主可见的 user_reply / action_start
 *   返回：{ items: OutlineItem[], truncated }——items 时间正序、只有 id / ts / kind / 预览（≤120 字），
 *        最多最新的 5000 项；truncated = 还有更早的没带上。
 *
 * 前端只持有最近一段事件（更早的靠上拉分页），长会话里提问大多落在窗口之外，所以要单独给一份轻量大纲。
 * 本 route 只读；读法（顺序扫 + 增量缓存）见 lib/server/events-outline。
 */

import { NextResponse } from "next/server";
import {
  commitReadableTaskResponse,
  getTaskEventsOutline,
  taskVisibilityErrorResponse,
} from "@/lib/server/task-fs";
import { failpoint } from "@/lib/server/failpoints";

export const runtime = "nodejs";

interface Ctx {
  params: Promise<{ id: string }>;
}

export const GET = async (_req: Request, { params }: Ctx) => {
  try {
    const { id } = await params;
    const outline = await getTaskEventsOutline(id);
    // HTTP 提交点同步复查
    await failpoint("httpRead.afterHelper");
    if (!outline) {
      // deleted→410 / unavailable→503 / 其余 404
      return taskVisibilityErrorResponse(id);
    }
    return commitReadableTaskResponse(id, () => outline);
  } catch (err) {
    console.error("[GET /api/tasks/[id]/outline] failed", err);
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
};
