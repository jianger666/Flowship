/**
 * GET /api/tasks/[id]/watch-chat
 *
 * SSE 订阅 chat 任务的实时事件流（与启动解耦）。
 *
 * 协议：
 *   - 进来先发一帧 `task`（当前 task meta）+ 所有历史 `event` 帧
 *   - 然后挂着、agent 端有新事件 / task 变化就 push 增量
 *   - agent 终止时 push 一帧 `done` + 关闭流
 *
 * 行为：
 *   - 任务不存在 → 404
 *   - 任务还没启动（runningChats 里没）→ 仍然 SSE、但 push 完历史就静等
 *     （让前端能看到 draft / completed / failed 等终态、无须特殊处理）
 *   - 客户端断开 → unsubscribe + close、agent 不受影响
 *   - 多个 tab 同时 watch 同一个任务 → 各自一份 fanout、互不干扰
 *
 * race 处理：
 *   订阅在读 snapshot 之前就开始、新事件先入 buffer。读完 snapshot 后用
 *   sentEventIds 去重 buffer、保证不丢不重。
 */

import { getTask } from "@/lib/server/task-fs";
import {
  type ChatStreamEvent,
  subscribeChatStream,
} from "@/lib/server/chat-runner";

interface Ctx {
  params: Promise<{ id: string }>;
}

export const runtime = "nodejs";
// SSE 长连接：拉到 next.js 上限（5min），到点客户端会自己重连
export const maxDuration = 300;

const sseFrame = (payload: unknown): string =>
  `data: ${JSON.stringify(payload)}\n\n`;

const errorJson = (message: string, status = 400) =>
  new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });

export const GET = async (_req: Request, { params }: Ctx) => {
  const { id } = await params;

  const initial = await getTask(id);
  if (!initial) return errorJson("not_found", 404);
  // V0.2：watch-chat 路由现在是「watch」通用通道、plan 模式的 workflow run 也走这条
  // 路由名留 chat 是 V1 历史包袱、后续可改名 /watch（暂不动、保持调用方稳定）

  const encoder = new TextEncoder();

  // 共享变量：start 注册 unsubscribe、cancel 调用
  let unsubscribeFn: (() => void) | null = null;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const safeEnqueue = (frame: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(frame));
        } catch {
          closed = true;
        }
      };
      const send = (payload: unknown) => safeEnqueue(sseFrame(payload));

      // 1) 先订阅：增量先入 buffer、避免 snapshot 读取期间的事件丢失
      const sentEventIds = new Set<string>();
      const buffered: ChatStreamEvent[] = [];
      let bootstrapping = true;
      let doneSent = false;

      const closeStream = () => {
        if (closed) return;
        unsubscribeFn?.();
        unsubscribeFn = null;
        try {
          controller.close();
        } catch {
          /* noop */
        }
        closed = true;
      };

      const dispatchStreamEvent = (ev: ChatStreamEvent) => {
        switch (ev.kind) {
          case "event": {
            if (sentEventIds.has(ev.event.id)) return;
            sentEventIds.add(ev.event.id);
            send({ type: "event", event: ev.event });
            break;
          }
          case "task":
            send({ type: "task", task: ev.task });
            break;
          case "done":
            send({ type: "done", task: ev.task, ok: ev.ok });
            doneSent = true;
            // agent 终止 → 服务端主动关流、释放订阅句柄、客户端 fetch 自然 done
            closeStream();
            break;
          case "error":
            send({ type: "error", message: ev.message });
            break;
          case "assistant_delta":
            // 流式打字 chunk 透传给客户端
            // bootstrap 阶段不丢、buffered 里保留就好（reconnect 接 stream 时 streaming 早结束、不需要 replay）
            send({ type: "assistant_delta", text: ev.text });
            break;
        }
      };

      unsubscribeFn = subscribeChatStream(id, (ev) => {
        if (bootstrapping) {
          buffered.push(ev);
          return;
        }
        dispatchStreamEvent(ev);
      });

      // 2) 发当前 task + 历史 events（一次性 bootstrap）
      try {
        send({ type: "task", task: initial });
        for (const ev of initial.events) {
          sentEventIds.add(ev.id);
          send({ type: "event", event: ev });
        }
      } catch (err) {
        console.error("[watch-chat] bootstrap failed:", err);
      }

      // 3) flush bootstrap 期间收到的事件、之后切到直接推送
      bootstrapping = false;
      for (const ev of buffered) {
        dispatchStreamEvent(ev);
      }

      // 4) 已结束的任务（completed / failed）：bootstrap 完直接关
      // 还在跑的：挂着等 listener 推、客户端断了就 unsubscribe
      const taskFinished =
        initial.status === "completed" || initial.status === "failed";
      if (taskFinished && !doneSent) {
        send({
          type: "done",
          task: initial,
          ok: initial.status === "completed",
        });
        closeStream();
      }
    },
    cancel() {
      // 客户端断开（关页面 / 主动 abort）：解绑订阅、释放进程级资源
      unsubscribeFn?.();
      unsubscribeFn = null;
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
};
