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
 *   必须「先 subscribe → 再 getTask 快照」——订阅期间事件一律进 buffer，
 *   否则 getTask 到 subscribe 之间产生的事件既不在快照里、也进不了 buffer（真丢）。
 *   快照发完后用 sentEventIds 去重回放 buffer，再转直通；快照 tail 的 event id
 *   也预先写入 sentEventIds，保证不丢不重。
 *
 * 进行中思考的快照（2026-10-13，帧 `thinking_snapshot`）：
 *   thinking_delta 是纯内存帧、从不回放；前端的实时思考态又只活在组件本地 state 里——
 *   切到别的对话再切回（组件重挂）、SSE 断流重连，新订阅者只能从「订阅之后的第一帧」开始，
 *   之前累积的几千字全丢、文本区从第一个字重新长（用户反馈「切窗口再切回来思考又从头吐」）。
 *   所以 bootstrap 末尾**无条件**补一帧：live = 对象（此刻正在思考，带已发出的文本 / 累计数 / 首帧时刻）
 *   或 null（没在思考——前端据此清掉本地残留）。
 *   - 订阅与读快照**同步配对**（中间没有 await）：快照 = 订阅那一刻之前已发出的全部，
 *     之后的帧都进 buffer、在快照后面回放，不重不漏；
 *   - 这段思考的落盘事件已经在 tail 里 → 发 live:null（思考其实已结束，别复活幽灵「思考中」）；
 *   - bootstrap 回放的历史 event 帧带 `replay: true`：前端不能把「重新读一遍旧账」当成
 *     「刚发生了一个落盘事件 = 这段思考结束了」而清掉刚从快照接上的实时态。
 */

import {
  listChatQueueItemIds,
  listMessageOperationSnapshot,
  listRecentSettled,
} from "@/lib/server/chat-queue";
import { getLiveThinkingSnapshot } from "@/lib/server/sdk-message-handler";
import { getBackgroundSubagentSnapshot } from "@/lib/server/subagent-background";
import {
  getTaskVisibility,
  getTaskWithTailEvents,
} from "@/lib/server/task-fs";
import { MAX_EVENTS_TAIL } from "@/lib/server/task-fs-core";
import { buildTalkQueueSnapshot } from "@/lib/server/task-talk-queue";
import { isTailAnchorEvent } from "@/lib/tail-anchor";
import {
  hasRestrictedQuestionInFlight,
  type TaskStreamEvent,
  subscribeTaskStream,
} from "@/lib/server/task-stream";
import type { Task } from "@/lib/types";

// 内联临时实现已删——统一走 task-fs 的正式 getTaskVisibility
// （同步、含 journal schema 校验与 meta unknown 口径、与 detail/events route 同源）

interface Ctx {
  params: Promise<{ id: string }>;
}

export const runtime = "nodejs";
// 注意：这个 maxDuration 在本应用的自托管运行时（Electron 内嵌的 `next start` / standalone server）里**不会被执行**——
// Next 只在类型 / typegen 里认它，真正按它掐流的是 Vercel 之类的托管平台；这里路由也没有任何定时关流逻辑。
// 所以 SSE 不会「每 300s 到点断一次」，断流只来自网络抖动 / 服务端重启 / 终态 close（第三轮 review §7）。
// 保留它只是为了万一被部署到会执行它的平台时有个上限声明；客户端的自动重连（use-task-watch）与它无依赖。
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

  const tailRaw = new URL(req.url).searchParams.get("tail");
  const tailParsed = tailRaw ? Number.parseInt(tailRaw, 10) : NaN;
  const tail = Math.min(
    Number.isFinite(tailParsed) && tailParsed > 0 ? tailParsed : DEFAULT_TAIL,
    MAX_EVENTS_TAIL,
  );

  // 订阅必须先于快照读取——controller 尚未 ready 时事件只能进 buffer。
  // liveDispatch 在 ReadableStream start 里装上后才转直通。
  const buffered: TaskStreamEvent[] = [];
  let bootstrapping = true;
  let liveDispatch: ((ev: TaskStreamEvent) => void) | null = null;
  let unsubscribeFn: (() => void) | null = subscribeTaskStream(id, (ev) => {
    if (bootstrapping) {
      buffered.push(ev);
      return;
    }
    liveDispatch?.(ev);
  });

  // 紧跟订阅、**同步**读进行中思考的快照——这两步之间不能有任何 await：
  // 快照 = 订阅那一刻之前已发出的全部；之后发的每一帧都进 buffered、bootstrap 完在快照后面回放。
  // 一旦隔了 await（比如挪到下面读完磁盘之后再读），期间发的帧会既进快照又进 buffer，
  // 前端按「快照 + 增量」重建就会把那段文字重复一遍
  const thinkingSnap = getLiveThinkingSnapshot(id);

  // 幂等清理：ReadableStream.cancel / req.signal abort / closeStream 都可能触发，防 double-clean
  const cleanup = () => {
    unsubscribeFn?.();
    unsubscribeFn = null;
    liveDispatch = null;
  };

  // 异常断连（tab 关 / 代理掐流）不一定走 cancel——挂 AbortSignal 兜底退订
  req.signal.addEventListener("abort", cleanup, { once: true });

  // 订阅已挂上：此 await 期间产生的事件进 buffer，不会丢
  // 尾部反向读、不整文件 parse
  let initial: Task | null;
  try {
    // 窗口补到含最近一条 user_reply / action_start（300 条窗口一致性，D8-01/02/03）：
    // 错误卡恢复入口 / 状态行 / ↑ 历史都往前找触发这一轮的事件，一轮长 run 之后它在最近 300 条之外就静默失效。
    // 与首屏 GET ?anchor=1 同一个判定：两边窗口一致，客户端「只追加」的合并不会乱序
    initial = await getTaskWithTailEvents(id, tail, { anchor: isTailAnchorEvent });
  } catch (err) {
    cleanup();
    throw err;
  }
  // 可读性三态——deleted→410+task_deleted；unavailable→503（不发 task_deleted）
  const visibility = getTaskVisibility(id);
  if (visibility === "deleted") {
    cleanup();
    return errorJson("task_deleted", 410);
  }
  if (visibility === "unavailable") {
    cleanup();
    return errorJson("temporarily_unavailable", 503);
  }
  if (!initial) {
    cleanup();
    return errorJson("not_found", 404);
  }

  const truncated = !!initial.eventsTruncated;
  const tailEvents = initial.events;

  const encoder = new TextEncoder();

  // 去重 Set 上限：长会话 SSE 挂着只增不减会胀内存；超限丢最老一半（偶发重发可接受）
  const SENT_EVENT_IDS_MAX = 5000;

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

      // 快照 tail + buffer 回放共用：同一 event id 只发一次
      const sentEventIds = new Set<string>();
      let doneSent = false;

      const rememberEventId = (eventId: string) => {
        sentEventIds.add(eventId);
        if (sentEventIds.size <= SENT_EVENT_IDS_MAX) return;
        // Set 迭代序 = 插入序：删掉最老一半
        const drop = Math.floor(sentEventIds.size / 2);
        let i = 0;
        for (const id of sentEventIds) {
          if (i++ >= drop) break;
          sentEventIds.delete(id);
        }
      };

      const closeStream = () => {
        if (closed) return;
        cleanup();
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
            rememberEventId(ev.event.id);
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
            // 旁路群答疑 run 的 done 带 origin：客户端据此不动属主的流式气泡 / run latch（D9-01）。
            // 属主主链的 done 没有 origin，不带这个字段（帧形状与改前一致）
            send({
              type: "done",
              task: stripEvents(ev.task),
              ok: ev.ok,
              ...(ev.origin ? { origin: ev.origin } : {}),
            });
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
            // 旁路群答疑 run 的增量带 origin，不能流进属主 UI 实时气泡
            if (ev.origin) break;
            send({ type: "assistant_delta", text: ev.text });
            break;
          // 思考实时帧（纯内存、不落盘）：思考进行中让 UI 把「进行中的 thinking 行」画进流程；
          // eventId 与这段思考落盘后的事件 id 一致
          case "thinking_delta":
            send({
              type: "thinking_delta",
              text: ev.text,
              eventId: ev.eventId,
            });
            break;
          // 队列整队失败控制帧（纯内存、不落盘）
          case "queue_failed":
            send({
              type: "queue_failed",
              itemIds: ev.itemIds,
              reason: ev.reason,
            });
            break;
          // MessageOperation 终态帧（handedOff=delivered / failed 家族）
          case "message_op":
            send({
              type: "message_op",
              itemId: ev.itemId,
              phase: ev.phase,
              outcome: ev.outcome,
            });
            break;
          // 旁路（受限群答疑）run 在飞与否——它不写 runStatus，前端只能靠这一帧
          // 知道「工具块还该转圈」（否则渲染成灰色「已中断」）
          case "restricted_run":
            send({ type: "restricted_run", active: ev.active });
            break;
          case "talk_queue":
            send({ type: "talk_queue", items: ev.items });
            break;
          // 后台子代理在飞清单（整份快照、纯内存）：主 AI 说完一轮后它们可能还在干活，
          // 界面据此在输入框上方画「子代理在后台工作」条
          case "background_subagents":
            send({ type: "background_subagents", jobs: ev.jobs });
            break;
          // DELETE 逻辑删除提交 → 通知客户端并关流
          case "task_deleted":
            send({ type: "task_deleted", taskId: ev.taskId });
            closeStream();
            break;
        }
      };

      // 装上直通入口：bootstrapping 关掉后新事件走这里
      liveDispatch = dispatchStreamEvent;

      try {
        // bootstrap task 帧不带 events（事件走下面的 event 帧）、但带 eventsTruncated
        // 让客户端知道「还有更早的、可上拉分页」
        send({
          type: "task",
          task: { ...stripEvents(initial), eventsTruncated: truncated },
        });
        for (const ev of tailEvents) {
          rememberEventId(ev.id);
          // replay：这是重新读一遍的旧账、不是刚发生的事（前端据此不清实时思考态）
          send({ type: "event", event: ev, replay: true });
        }
        // bootstrap 附带 queue itemIds（旧字段兼容）+
        // 完整 operationSnapshot（含 accepting/persisted，关闭 ghost→delivered 窗口）+
        // recentSettled ledger。
        send({
          type: "queue_state",
          itemIds: listChatQueueItemIds(id),
          operationSnapshot: listMessageOperationSnapshot(id),
          recentSettled: listRecentSettled(id),
        });
        // 旁路答疑在飞与否的补位：中途打开页面 / 断线重连都收不到 register/unregister
        // 那两帧——在飞不补 → 工具块被当脏数据渲染「已中断」；已结束不补 → 断线前的
        // true 会一直挂着（转圈不停）。所以**无条件**发一帧当前值、让客户端对齐。
        send({
          type: "restricted_run",
          active: hasRestrictedQuestionInFlight(id),
        });
        send({ type: "talk_queue", items: buildTalkQueueSnapshot(id) });
        // 后台子代理在飞清单的补位：中途打开页面 / 切走再切回 / 断线重连都收不到「转入后台 / 收尾」
        // 那几帧——在跑不补 → 用户看不到子代理还在干活；已结束不补 → 断线前的非空清单会一直挂着。
        // 所以**无条件**发一帧当前整份（空数组 = 没有），客户端整份替换
        send({
          type: "background_subagents",
          jobs: getBackgroundSubagentSnapshot(id),
        });
        // 进行中思考的快照：无条件发一帧（对象 = 接着长；null = 没在思考、前端清残留）。
        // 这段思考的落盘事件已经在 tail 里 = 思考其实结束了（节流状态还没来得及清），发 null 防幽灵
        const liveSnap =
          thinkingSnap &&
          !tailEvents.some((e) => e.id === thinkingSnap.eventId)
            ? thinkingSnap
            : null;
        send({ type: "thinking_snapshot", live: liveSnap });
      } catch (err) {
        console.error("[watch-task] bootstrap failed:", err);
      }

      // 先回放 buffer（与快照重叠的 event 被 sentEventIds 丢掉），再转直通
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
      cleanup();
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
