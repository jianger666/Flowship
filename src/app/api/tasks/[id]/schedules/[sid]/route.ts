/**
 * POST /api/tasks/[id]/schedules/[sid]   body: { action }
 *
 * 对一条定时做操作（UI：会话内定时条 / 定时任务管理页共用）：
 * - `cancel`  取消（进行中 / 已暂停的；已错过 / 已完成 / 已取消的都算「已结束」，返回 409——已错过的只能「立即触发」拉回来或「删除记录」）
 * - `pause`   暂停（只对进行中的；不触发，数据保留）
 * - `resume`  恢复（周期任务从现在起重新计一个完整间隔；一次性若已过点则记为已错过）
 * - `fire`    立即触发：额外多发一次（不改原计划）；已错过的一次性任务也能这样拉回来。
 *             会话这会儿接不了（忙 / 有未答提问）时返回 outcome=retry，之后由调度器自动送达
 * - `remove`  从历史里删掉一条已结束的记录
 *
 * 错误：404 会话 / 定时不存在（含非法的会话 id）；409 当前状态不允许该操作；400 请求体不是 JSON 对象 / action 非法。
 */

import { errorResponse } from "@/lib/server/route-helpers";
import {
  ensureScheduleRunnerStarted,
  fireScheduleNow,
  noteScheduleEvent,
} from "@/lib/server/schedule-service";
import {
  cancelSchedule,
  pauseSchedule,
  removeFinishedSchedule,
  resumeSchedule,
  type OpResult,
} from "@/lib/server/schedule-store";
import { getTaskMeta } from "@/lib/server/task-fs";
import { sanitizeId } from "@/lib/server/task-fs-core";

interface Ctx {
  params: Promise<{ id: string; sid: string }>;
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

ensureScheduleRunnerStarted();

const ACTIONS = ["cancel", "pause", "resume", "fire", "remove"] as const;
type Action = (typeof ACTIONS)[number];

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

const failure = (r: { error: string; code: "not_found" | "bad_state" | "task_gone" | "busy" }): Response =>
  errorResponse(
    r.error,
    r.code === "not_found" || r.code === "task_gone" ? 404 : 409,
    { code: r.code },
  );

export const POST = async (req: Request, { params }: Ctx) => {
  const { id, sid } = await params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse("请求体不是合法 JSON");
  }
  // JSON `null` / 数组 / 数字也是「合法 JSON」：不挡的话下面 body.action 会抛 TypeError → 500
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return errorResponse("请求体必须是 JSON 对象");
  }
  const action = (body as { action?: unknown }).action as Action;
  if (!ACTIONS.includes(action)) {
    return errorResponse(`action 必须是 ${ACTIONS.join(" / ")} 之一`);
  }

  // 非法的会话 id（带点 / 斜杠…）taskDir() 会抛：按「会话不存在」处理，不是 500
  try {
    sanitizeId(id);
  } catch {
    return errorResponse("会话不存在", 404, { code: "not_found" });
  }
  const task = await getTaskMeta(id);
  if (!task) return errorResponse("会话不存在", 404, { code: "not_found" });

  // 读写定时文件可能抛（EMFILE / EIO / EACCES，或文件损坏改名失败）：统一成带 JSON 体的 500，
  // 前端 runScheduleAction 能把 error 展示出来，而不是拿到 Next 默认的空 500
  try {
    if (action === "fire") {
      const r = await fireScheduleNow(id, sid);
      if (!r.ok) return failure(r);
      return json({ ok: true, schedule: r.record, outcome: r.outcome });
    }

    let r: OpResult;
    if (action === "cancel") r = await cancelSchedule(id, sid, "用户取消");
    else if (action === "pause") r = await pauseSchedule(id, sid);
    else if (action === "resume") r = await resumeSchedule(id, sid);
    else r = await removeFinishedSchedule(id, sid);
    if (!r.ok) return failure(r);

    if (action === "cancel") {
      await noteScheduleEvent(id, sid, "cancelled", `定时「${r.record.title}」已取消`);
    }
    return json({ ok: true, schedule: r.record });
  } catch (err) {
    console.warn(
      `[schedules-api] 操作失败 task=${id} schedule=${sid} action=${action}`,
      err instanceof Error ? err.message : err,
    );
    return errorResponse("读写定时记录失败，请稍后重试", 500, { code: "store_error" });
  }
};
