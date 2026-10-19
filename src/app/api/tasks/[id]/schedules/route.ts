/**
 * GET /api/tasks/[id]/schedules
 *
 * 会话内「定时条」的数据源：这个会话的全部定时记录（含已结束的历史，UI 自己按状态分组）。
 * 只读；任务不存在（含非法的会话 id）→ 404；定时文件读不出来 → 500（带 JSON 体 `{ error, code: "read_failed" }`）。
 */

import { errorResponse } from "@/lib/server/route-helpers";
import { ensureScheduleRunnerStarted } from "@/lib/server/schedule-service";
import { readSchedules } from "@/lib/server/schedule-store";
import { getTaskMeta } from "@/lib/server/task-fs";
import { sanitizeId } from "@/lib/server/task-fs-core";

interface Ctx {
  params: Promise<{ id: string }>;
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

ensureScheduleRunnerStarted();

export const GET = async (_req: Request, { params }: Ctx) => {
  const { id } = await params;
  // 非法的会话 id（带点 / 斜杠…）taskDir() 会抛：按「会话不存在」处理，不是 500
  try {
    sanitizeId(id);
  } catch {
    return errorResponse("会话不存在", 404, { code: "not_found" });
  }
  const task = await getTaskMeta(id);
  if (!task) return errorResponse("会话不存在", 404, { code: "not_found" });
  let schedules;
  try {
    schedules = await readSchedules(id);
  } catch (err) {
    // 读不出来（EMFILE / EIO / EACCES…）：给前端一个带 JSON 体的 500，而不是 Next 默认的空 500
    console.warn(`[schedules-api] 读取定时失败 task=${id}`, err instanceof Error ? err.message : err);
    return errorResponse("读取定时失败，请稍后重试", 500, { code: "read_failed" });
  }
  return new Response(JSON.stringify({ schedules }), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
};
