/**
 * GET /api/tasks/[id]/ask-wait?token=…
 *
 * 只给 ask_user 返回的那条前台 curl 用。挂着直到：
 *   - 用户提交答案（stdout 写出 [ASK_USER_REPLY]…）
 *   - 提问被顶替 / 停止（stdout 一行 `# ask-wait ended: …`）
 *   - 客户端断开（槽留下，允许同 token 重连）
 *
 * 不是旧 wait-ack：交卷不走这里。
 */

import { getTask } from "@/lib/server/task-fs";
import {
  ASK_WAIT_IDLE_MS,
  attachAskWaiter,
  detachAskWaiter,
  getAskWait,
  type AskWaitWaiter,
} from "@/lib/server/ask-wait";
import { getPendingAsk } from "@/lib/server/chat-pending";

interface Ctx {
  params: Promise<{ id: string }>;
}

export const runtime = "nodejs";
/** 用户可能隔很久才答；本机 Node server，长挂可以 */
export const maxDuration = 86400;

const errorJson = (message: string, status: number) =>
  new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });

export const GET = async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  const token = new URL(req.url).searchParams.get("token")?.trim() ?? "";
  if (!token) return errorJson("缺少 token", 400);

  const task = await getTask(id);
  if (!task) return errorJson("任务不存在", 404);

  const slot = getAskWait(id);
  const pending = getPendingAsk(id);
  const expected = slot?.token ?? pending?.token;
  if (!expected || expected !== token) {
    return errorJson("提问已失效或 token 不匹配", 410);
  }
  if (slot?.settled) {
    return errorJson("这组提问已经结束", 410);
  }

  const encoder = new TextEncoder();
  let idleTimer: ReturnType<typeof setInterval> | undefined;
  let attached: AskWaitWaiter | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const write = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          closed = true;
        }
      };
      const close = () => {
        if (closed) return;
        closed = true;
        if (idleTimer) clearInterval(idleTimer);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      attached = { write, close };
      const live = attachAskWaiter(id, token, attached);
      if (!live) {
        write("# ask-wait ended: missing\n");
        close();
        return;
      }
      // 秒答已经压在槽里：attach 把答案写进 stdout 并 close 了，不要再挂 idle
      if (live.settled) return;
      write(`# ask-wait connected ${new Date().toISOString()}\n`);
      idleTimer = setInterval(() => {
        write(`# ask-wait idle ${new Date().toISOString()}\n`);
      }, ASK_WAIT_IDLE_MS);

      const onAbort = () => {
        if (attached) detachAskWaiter(id, attached);
        close();
      };
      if (req.signal.aborted) {
        onAbort();
        return;
      }
      req.signal.addEventListener("abort", onAbort, { once: true });
    },
    cancel() {
      if (idleTimer) clearInterval(idleTimer);
      if (attached) detachAskWaiter(id, attached);
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    },
  });
};
