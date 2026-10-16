/**
 * POST /api/tasks/[id]/question——任务页输入条的统一消息通道（V0.13.x）
 *
 * 薄壳：解析路径参数 + body 后交给 `handleTaskQuestionInject`（与飞书需求群回流
 * 共用同一套注入逻辑、行为零漂移）。状态机语义 / 传输分流说明见该模块头注释。
 *
 * Body: { text, images?, attachments?, skills?, bootArgs?: { apiKey, model }, forceModel?,
 *         queueIfBusy?, clientItemId? }
 * queueIfBusy=true：agent 正在跑时不 409，入 task 待送达队列并返回 202 `{ queued: true }`。
 */

import { handleTaskQuestionInject } from "@/lib/server/task-question-inject";
import { errorResponse } from "@/lib/server/route-helpers";

interface Ctx {
  params: Promise<{ id: string }>;
}

export const runtime = "nodejs";

export const POST = async (req: Request, { params }: Ctx) => {
  const { id } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse("body 不是合法 JSON");
  }

  // 输入条运行中也能发：queueIfBusy 只认严格的 true，clientItemId 做入队幂等（前端重试不重复排）。
  // 空闲直送路径的幂等不在这里做：body 原样透传，注入链入口按 (task, clientItemId, 正文指纹)
  // 同步登记「处理中」——并发重发等第一次的结果、送达后重试命中回 200 `deduped:true`、
  // 失败则撤销登记让重试真正再注入（见 task-question-inject 的空闲直送幂等：在途 / 已送达两张表）
  const b = (body ?? {}) as { queueIfBusy?: unknown; clientItemId?: unknown };
  const clientItemId =
    typeof b.clientItemId === "string" && b.clientItemId.trim()
      ? b.clientItemId.trim()
      : undefined;
  return handleTaskQuestionInject(
    id,
    body,
    b.queueIfBusy === true
      ? { queueIfBusy: { source: "app", ...(clientItemId ? { clientItemId } : {}) } }
      : {},
  );
};
