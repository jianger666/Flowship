/**
 * GET /api/schedules
 *
 * 定时任务管理页的数据源：全部会话的定时（含已结束的历史），每条带所属会话的
 * 标题 / 模式（chat | task）/ 是否已归档。排序：进行中的在前（按下次触发升序），已结束的在后。
 *
 * 只读；读失败 → 500（带 JSON 体 `{ error, code: "list_failed" }`）。改状态（取消 / 暂停 / 恢复 / 立即触发 / 删除记录）走 `/api/tasks/[id]/schedules/[sid]`。
 */

import { errorResponse } from "@/lib/server/route-helpers";
import { ensureScheduleRunnerStarted, listScheduleItems } from "@/lib/server/schedule-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// route 模块加载即确保调度器已起（与 /api/tasks 同款锚点；重复调用无副作用）
ensureScheduleRunnerStarted();

export const GET = async () => {
  let schedules;
  try {
    schedules = await listScheduleItems();
  } catch (err) {
    // 几乎不会抛（listScheduleItems 内部已按会话吞错），但与另两个定时路由保持一致：给前端带 JSON 体的 500，不是 Next 默认的空 500
    console.warn("[schedules-api] 列出定时失败", err instanceof Error ? err.message : err);
    return errorResponse("读取定时失败，请稍后重试", 500, { code: "list_failed" });
  }
  return new Response(JSON.stringify({ schedules }), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
};
