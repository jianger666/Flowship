/**
 * POST /api/tasks/[id]/question——任务页输入条的统一消息通道（V0.13.x）
 *
 * 薄壳：解析路径参数 + body 后交给 `handleTaskQuestionInject`（与飞书需求群回流
 * 共用同一套注入逻辑、行为零漂移）。状态机语义 / 传输分流说明见该模块头注释。
 *
 * Body: { text, images?, attachments?, skills?, bootArgs?: { apiKey, model }, forceModel? }
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

  return handleTaskQuestionInject(id, body);
};
