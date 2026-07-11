/**
 * GET /api/tasks/[id]/watch-task
 *
 * V0.6 任务实时事件流（SSE）。task 模式（action 容器）和 chat 模式（独立 chat-runner）共用这一个端点。
 *
 * 协议：
 *   - 进来先发一帧 `task`（当前 task meta、events 只带尾部 tail 条 + eventsTruncated 标记）
 *     + 尾部 `event` 帧；更早历史客户端走 GET /events?before= 分页（v1.0.x 事件懒加载）
 *   - 然后挂着、有新 task/event/action 变化就 push 增量
 *   - **中途的 task / done 帧一律不带 events（events: []）**——事件只经 event 帧走、
 *     不再每帧重传全量事件日志（长对话下这曾是每帧几百 KB 的带宽 / 序列化浪费）；
 *     客户端 mergeTaskEvents 保留本地已有 events
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
import type { Task } from "@/lib/types";

interface Ctx {
  params: Promise<{ id: string }>;
}

export const runtime = "nodejs";
export const maxDuration = 300;

// bootstrap 默认只带最近这么多条事件（?tail= 可覆盖）——长对话打开秒开、更早的上拉分页
const DEFAULT_TAIL = 300;

// 中途 task/done 帧统一剥掉 events：事件只经 event 帧走、别每帧重传全量日志
const stripEvents = (task: Task): Task => ({ ...task, events: [] });

const sseFrame = (payload: unknown): string =>
  `data: ${JSON.stringify(payload)}\n\n`;

const errorJson = (message: string, status = 400) =>
  new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });

export const GET = async (req: Request, { params }: Ctx) => {
  const { id } = await params;

  const initial = await getTask(id);
  if (!initial) return errorJson("not_found", 404);

  const tailRaw = new URL(req.url).searchParams.get("tail");
  const tailParsed = tailRaw ? Number.parseInt(tailRaw, 10) : NaN;
  const tail =
    Number.isFinite(tailParsed) && tailParsed > 0 ? tailParsed : DEFAULT_TAIL;
  const truncated = initial.events.length > tail;
  const tailEvents = truncated ? initial.events.slice(-tail) : initial.events;

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
            send({ type: "task", task: stripEvents(ev.task) });
            break;
          case "action":
            send({ type: "action", action: ev.action });
            break;
          case "done": {
            send({ type: "done", task: stripEvents(ev.task), ok: ev.ok });
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
        // bootstrap task 帧不带 events（事件走下面的 event 帧）、但带 eventsTruncated
        // 让客户端知道「还有更早的、可上拉分页」
        send({
          type: "task",
          task: { ...stripEvents(initial), eventsTruncated: truncated },
        });
        for (const ev of tailEvents) {
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
          task: stripEvents(initial),
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
