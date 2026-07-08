/**
 * GET /api/tasks/[id]/watch-task
 *
 * V0.6 任务实时事件流（SSE）。task 模式（action 容器）和 chat 模式（独立 chat-runner）共用这一个端点。
 *
 * 协议：
 *   - 进来先发一帧 `task`（当前 task meta）+ 所有历史 `event` 帧
 *   - 然后挂着、有新 task/event/action 变化就 push 增量
 *   - agent run 终止时 push 一帧 `done`；**只有任务业务终态（merged / abandoned）才关流**
 *
 * V0.11.6 修「done 即关流」：V0.11 起 run = 一个回合（交卷 / 提问 / 说完都自然 finished）、
 * 每回合结束都会 publish done——沿用旧「done 即关流」语义会让页面在 agent 每说完一轮后断流、
 * 后续 send 起的新 run 事件全部收不到（实测：ask 弹窗答完卡「提交中」、页面永远不更新）。
 * 回合结束 ≠ 订阅结束、流保持挂着跨 run 存活。
 *
 * 行为：
 *   - 任务不存在 → 404
 *   - 任务还没启动 → 仍然 SSE、push 完历史就静等
 *   - 客户端断开 → unsubscribe + close、agent 不受影响
 *   - 多个 tab 同时 watch 同一个任务 → 各自一份 fanout、互不干扰
 *
 * race 处理：
 *   订阅在读 snapshot 之前就开始、新事件先入 buffer。读完 snapshot 后用
 *   sentEventIds 去重 buffer、保证不丢不重。
 */

import { getTask } from "@/lib/server/task-fs";
import {
  type TaskStreamEvent,
  subscribeTaskStream,
} from "@/lib/server/task-stream";

interface Ctx {
  params: Promise<{ id: string }>;
}

export const runtime = "nodejs";
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

  const encoder = new TextEncoder();
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

      const sentEventIds = new Set<string>();
      const buffered: TaskStreamEvent[] = [];
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

      const dispatchStreamEvent = (ev: TaskStreamEvent) => {
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
          case "action":
            send({ type: "action", action: ev.action });
            break;
          case "done": {
            send({ type: "done", task: ev.task, ok: ev.ok });
            doneSent = true;
            // V0.11.6：done = 本回合 run 结束、不再等于「本次订阅结束」——
            // 只有任务真终态才关流、否则保持挂着接后续 send 起的新 run
            const finalNow =
              ev.task.repoStatus === "merged" ||
              ev.task.repoStatus === "abandoned";
            if (finalNow) closeStream();
            break;
          }
          case "error":
            send({ type: "error", message: ev.message });
            break;
          case "assistant_delta":
            send({ type: "assistant_delta", text: ev.text });
            break;
        }
      };

      unsubscribeFn = subscribeTaskStream(id, (ev) => {
        if (bootstrapping) {
          buffered.push(ev);
          return;
        }
        dispatchStreamEvent(ev);
      });

      try {
        send({ type: "task", task: initial });
        for (const ev of initial.events) {
          sentEventIds.add(ev.id);
          send({ type: "event", event: ev });
        }
      } catch (err) {
        console.error("[watch-task] bootstrap failed:", err);
      }

      bootstrapping = false;
      for (const ev of buffered) {
        dispatchStreamEvent(ev);
      }

      // V0.6：已合入 / abandoned 的 task → bootstrap 完直接关
      // runStatus=idle 但 repoStatus=developing → 等用户推进、保持挂着
      const isFinal =
        initial.repoStatus === "merged" || initial.repoStatus === "abandoned";
      if (isFinal && !doneSent) {
        send({
          type: "done",
          task: initial,
          ok: initial.repoStatus === "merged",
        });
        closeStream();
      }
    },
    cancel() {
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
