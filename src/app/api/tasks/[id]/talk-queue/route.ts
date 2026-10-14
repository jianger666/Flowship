/**
 * task 模式待送达队列（GET 快照 / DELETE 按 id 删除）
 *
 * 快照含 app / group_owner / group_reply（本模块）+ group_question（群模块合并）。
 * group_question 的 id 为飞书 message_id，删除时走 removeGroupQuestionFromQueue。
 */

import { getTask } from "@/lib/server/task-fs";
import {
  buildTalkQueueSnapshot,
  removeTalkQueueItems,
} from "@/lib/server/task-talk-queue";
import { errorResponse } from "@/lib/server/route-helpers";

interface Ctx {
  params: Promise<{ id: string }>;
}

export const runtime = "nodejs";

export const GET = async (_req: Request, { params }: Ctx) => {
  const { id } = await params;
  const task = await getTask(id);
  if (!task) return errorResponse("not_found", 404);

  return new Response(
    JSON.stringify({ items: buildTalkQueueSnapshot(id) }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
};

export const DELETE = async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  const task = await getTask(id);
  if (!task) return errorResponse("not_found", 404);

  let itemIds: string[];
  try {
    const body = (await req.json()) as { itemIds?: unknown };
    if (
      !Array.isArray(body.itemIds) ||
      body.itemIds.some((x) => typeof x !== "string")
    ) {
      return errorResponse("itemIds 必须是字符串数组");
    }
    itemIds = body.itemIds as string[];
  } catch {
    return errorResponse("请求体不是合法 JSON");
  }
  if (itemIds.length === 0) return errorResponse("itemIds 不能为空");

  const removedIds = removeTalkQueueItems(id, itemIds);
  return new Response(
    JSON.stringify({ ok: true, removedIds }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
};
