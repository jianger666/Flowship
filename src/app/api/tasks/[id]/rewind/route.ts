/**
 * POST /api/tasks/[id]/rewind
 *
 * Chat 消息级回退：恢复 checkpoint 文件状态 + 截断对话到该 user_reply 之前。
 * 二次确认文案由前端负责；本 API 只管执行。
 *
 * # Body
 * { eventId: string }  // 带 checkpointed:true 的 user_reply 事件 id
 *
 * # 成功
 * { ok: true, task, restoredRepos, truncatedEventCount, refreshRequired? }
 * task 可能为 null（回退已提交但 getTask 失败）；此时 refreshRequired=true，仍 200。
 *
 * # 错误
 * - 404 task 不存在 / 无对应检查点
 * - 409 非 chat / agent 正在跑
 * - 500 文件恢复失败
 */

import { getTask } from "@/lib/server/task-fs";
import {
  closeChatSessionUnconditional,
  isChatCompactInProgress,
  isChatQueueDraining,
  isChatRunActive,
} from "@/lib/server/chat-runner";
import {
  executeChatRewind,
  RewindError,
} from "@/lib/server/chat-checkpoint";
import {
  publishTaskStreamEvent,
  writeEventAndPublish,
} from "@/lib/server/task-stream";
import { errorResponse } from "@/lib/server/route-helpers";

interface Ctx {
  params: Promise<{ id: string }>;
}

interface PostBody {
  eventId?: string;
}

export const runtime = "nodejs";

export const POST = async (req: Request, { params }: Ctx) => {
  const { id } = await params;

  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return errorResponse("body 不是合法 JSON");
  }

  const eventId = typeof body.eventId === "string" ? body.eventId.trim() : "";
  if (!eventId) {
    return errorResponse("缺 eventId");
  }

  try {
    const result = await executeChatRewind(id, eventId, {
      closeSession: closeChatSessionUnconditional,
      isRunActive: isChatRunActive,
      isCompactInProgress: isChatCompactInProgress,
      isQueueDraining: isChatQueueDraining,
      // R29-P2：rewind info 改 writeEventAndPublish——磁盘序 = SSE 序（用户操作、无条件语义）
      appendInfoEvent: async (taskId, text) =>
        writeEventAndPublish(taskId, { kind: "info", text }),
      getTask,
    });

    // task 为 null 时不推 SSE（类型要求 Task）；客户端靠 refreshRequired 自行刷新
    if (result.task) {
      publishTaskStreamEvent(id, { kind: "task", task: result.task });
    }

    return new Response(
      JSON.stringify({
        ok: true,
        task: result.task,
        restoredRepos: result.restoredRepos,
        truncatedEventCount: result.truncatedEventCount,
        ...(result.refreshRequired ? { refreshRequired: true } : {}),
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    if (err instanceof RewindError) {
      return errorResponse(err.message, err.status);
    }
    console.error(`[rewind] task=${id} failed:`, err);
    return errorResponse(
      `rewind 失败：${err instanceof Error ? err.message : String(err)}`,
      500,
    );
  }
};
