/**
 * POST /api/tasks/[id]/rewind
 *
 * Chat 消息级回退：恢复 checkpoint 文件状态 + 截断对话到该 user_reply 之前。
 * 二次确认文案由前端负责；本 API 只管执行。
 *
 * # Body
 * { eventId: string, mode?: "rewind" | "edit" }
 * - 缺省 / "rewind"：eventId 是带 checkpointed:true 的 user_reply 事件 id；还原文件 + 截断对话
 * - "edit"（编辑已发送的消息）：eventId 是任意 user_reply；有文件检查点 → 同上（还原文件 + 截断对话），
 *   没有（没绑仓 / 检查点被裁掉 / 打点失败）→ 只截断对话、文件不动（响应 restoredRepos 为空数组）。
 *   发送新内容由客户端随后走普通发送接口，不在本接口里。
 *
 * # 成功
 * { ok: true, task, restoredRepos, truncatedEventCount, rewound, markerEventWritten, refreshRequired? }
 * rewound = { fromEventId, keptCount, markerEventId|null, ts }：回退标记，客户端据此截断本地事件窗口；
 * 同一份记录也落进 meta（`task.lastRewind`），随 task 快照下发，窗口外的标记事件不影响另一个窗口对齐（D9-04）；
 * markerEventWritten=false 表示标记 info 事件没写成（回退本身已成功，不回滚、不报错）
 * task 可能为 null（回退已提交但 getTask 失败）；此时 refreshRequired=true，仍 200。
 *
 * # 错误
 * - 404 task 不存在 / 无对应检查点
 * - 409 非 chat / agent 正在跑 / 任务正在停止或删除 / 排队消息在发送或还没清 / 正在启动新会话 / 已有回退在进行
 * - 500 文件恢复失败
 * 响应体 `{ error, code }`：`code` 是稳定的错误码（前端据此选提示、不匹配 `error` 文案），取值见
 * `@/lib/rewind-failure` 的 `RewindFailureCode`；409 的细分原因在 `RewindError.reason`，无细分退回 `RewindError.code`。
 */

import { getTask, setTaskLastRewind } from "@/lib/server/task-fs";
import type { LastRewind } from "@/lib/types";
import {
  closeChatSessionUnconditional,
  isChatQueueDraining,
  isChatRunActive,
} from "@/lib/server/chat-runner";
import {
  executeChatEditRewind,
  executeChatRewind,
  RewindError,
} from "@/lib/server/chat-checkpoint";
import {
  publishTaskStreamEvent,
  writeEventAndPublish,
} from "@/lib/server/task-stream";
import { errorResponse } from "@/lib/server/route-helpers";
import { buildRewindMeta } from "@/lib/rewind-marker";

interface Ctx {
  params: Promise<{ id: string }>;
}

interface PostBody {
  eventId?: string;
  mode?: unknown;
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
  if (
    body.mode !== undefined &&
    body.mode !== "rewind" &&
    body.mode !== "edit"
  ) {
    return errorResponse("mode 只能是 rewind / edit");
  }
  const run = body.mode === "edit" ? executeChatEditRewind : executeChatRewind;

  try {
    // 标记 info 事件写成功后记下它的 id；写失败（writeEventAndPublish 吞错返 null / 抛错）保持 null。
    // 回退本身（截断服务端事件）此时已提交，不因标记失败回滚或报错——客户端靠响应体 rewound 对齐本地
    const marker: { eventId: string | null; ts: number | null } = {
      eventId: null,
      ts: null,
    };
    const result = await run(id, eventId, {
      closeSession: closeChatSessionUnconditional,
      isRunActive: isChatRunActive,
      isQueueDraining: isChatQueueDraining,
      // rewind info 改 writeEventAndPublish——磁盘序 = SSE 序（用户操作、无条件语义）
      // meta 带回退标记（被回退事件 id + 保留条数）：客户端据此把本地「被删掉的后半段」截掉（见 rewind-marker.ts）
      appendInfoEvent: async (taskId, text, info) => {
        let written: Awaited<ReturnType<typeof writeEventAndPublish>> = null;
        try {
          written = await writeEventAndPublish(taskId, {
            kind: "info",
            text,
            meta: buildRewindMeta({
              fromEventId: eventId,
              keptCount: info.keptEventCount,
            }),
          });
        } catch (err) {
          console.warn(
            `[rewind] task=${taskId} 回退标记事件写入抛错（回退已提交，响应体 rewound 兜底）:`,
            err,
          );
        }
        if (written) {
          marker.eventId = written.id;
          marker.ts = typeof written.ts === "number" ? written.ts : null;
        } else {
          console.warn(
            `[rewind] task=${taskId} 回退标记事件未写入（回退已提交，响应体 rewound 兜底）`,
          );
        }
        return written;
      },
      getTask,
    });

    // 最近一次回退落 meta、随 task 快照下发（D9-04）：标记事件只是日志里普通的一条，回退后再产生 300+ 条
    // 事件它就被挤出尾部窗口，断线重连的另一个窗口拿不到标记、被删的事件会留在界面上；这个字段不随窗口滑走。
    // 写失败只告警——回退已提交，它只是多一道对齐信号，不能让已成功的回退报错
    const lastRewind: LastRewind = {
      fromEventId: eventId,
      keptCount: result.keptEventCount,
      markerEventId: marker.eventId,
      ts: marker.ts ?? Date.now(),
    };
    try {
      await setTaskLastRewind(id, lastRewind);
    } catch (err) {
      console.warn(`[rewind] task=${id} lastRewind 落盘失败（回退已提交）:`, err);
    }
    // result.task 是回退过程中读的、早于上面的落盘：把 lastRewind 补进去，响应体 / SSE 快照才带得上
    const task = result.task ? { ...result.task, lastRewind } : null;

    // task 为 null 时不推 SSE（类型要求 Task）；客户端靠 refreshRequired 自行刷新
    if (task) {
      publishTaskStreamEvent(id, { kind: "task", task });
    }

    return new Response(
      JSON.stringify({
        ok: true,
        task,
        restoredRepos: result.restoredRepos,
        truncatedEventCount: result.truncatedEventCount,
        // 回退标记直接放响应体：客户端据此对齐本地事件窗口，不依赖标记事件写入 / SSE 到达
        rewound: {
          fromEventId: eventId,
          keptCount: result.keptEventCount,
          markerEventId: marker.eventId,
          // 与 task.lastRewind.ts 同值：回退者本地据此把这次回退记成「已知」，不被自己的 task 帧触发多余重拉
          ts: lastRewind.ts,
        },
        markerEventWritten: marker.eventId !== null,
        ...(result.refreshRequired ? { refreshRequired: true } : {}),
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    if (err instanceof RewindError) {
      // 响应带稳定 code（V7-06）：前端按它选提示、不再匹配中文报错文案。
      // 409 的细分（停止/删除中、正在发排队、正在起会话……）在 reason 里，没有细分才用 RewindError.code；
      // error 文案原样保留（老前端仍读它）
      return errorResponse(err.message, err.status, {
        code: err.reason ?? err.code,
      });
    }
    console.error(`[rewind] task=${id} failed:`, err);
    return errorResponse(
      `rewind 失败：${err instanceof Error ? err.message : String(err)}`,
      500,
    );
  }
};
