"use client";

/**
 * task 模式「待送达」队列的提示条——面板本体在 queue-banner（与 chat 共用），这里只接 task 的数据来源与动作：
 *
 * - 条目只认 SSE `talk_queue` 帧的整份快照（每次连接 bootstrap 都会补发），不另拉接口；
 *   编辑 / 删除 / 立即发送后服务端都会再推一帧快照，列表与条数自然更新；
 * - 一行能做什么由来源决定（lib/talk-queue 的 canEditTalkQueueItem / canSendNowTalkQueueItem，服务端同样校验）：
 *   我自己输入条排的（app）可编辑 / 立即发送 / 删除；群里属主的话可立即发送 / 删除；群回执、群提问只能删；
 * - 「立即发送」只有「打断重发」一条路（task-talk-queue-send-now）：agent 在跑时先确认再停这一轮；
 * - 编辑要完整正文：快照里的 preview 只有 ≤120 字，点「编辑」时才 GET ?full=1 取，别把长消息截断了。
 *
 * 与 chat 的排队条一致：排队从无到有时自动弹开一次（用户要常驻感知），关了等下一轮 0→N 再弹。
 * 「从无到有」在这里由条数变化判定：prevCountRef 初值取挂载时的条数（N1：进入一个本来就有排队的任务不算，不弹）。
 */

import { useEffect, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { QueueBanner, type QueueBannerAdapter, type QueueRow } from "@/components/tasks/queue-banner";
import { shouldAutoOpenQueue, taskSendNowCopy } from "@/lib/queue-banner";
import {
  canEditTalkQueueItem,
  canSendNowTalkQueueItem,
  TALK_QUEUE_SOURCE_LABEL,
} from "@/lib/talk-queue";
import {
  fetchTalkQueueEditTexts,
  isTalkQueueItemGone,
  removeTalkQueueItems,
  sendTalkQueueItemNow,
  updateTalkQueueItem,
  type TalkQueueItem,
} from "@/lib/task-store";
import type { Task } from "@/lib/types";

interface Props {
  task: Task;
  /** SSE 实时快照（整份，含群里排队的提问） */
  talkQueue: TalkQueueItem[];
}

const rowOf = (it: TalkQueueItem): QueueRow => ({
  id: it.id,
  text: it.preview,
  canEdit: canEditTalkQueueItem(it),
  canSendNow: canSendNowTalkQueueItem(it),
  allowEmptyEdit: it.hasAttachments === true,
  held: it.held === true,
  prefix: (
    <>
      <Badge variant="secondary" className="text-[11px]">
        {TALK_QUEUE_SOURCE_LABEL[it.source] ?? it.source}
      </Badge>
      {it.senderName ? (
        <span className="text-muted-foreground">
          {it.senderName}
          {it.senderIsBot ? (
            <Badge variant="outline" className="ml-1 px-1 py-0 text-[11px]">
              机器人
            </Badge>
          ) : null}
        </span>
      ) : null}
    </>
  ),
});

export const TalkQueueBanner = ({ task, talkQueue }: Props) => {
  const taskId = task.id;
  const queuedCount = talkQueue.length;
  // 「排队从无到有」的信号：条数 0→N 时递增（面板只认变化）。
  // 初值取挂载时的条数（N1）：进入一个本来就有排队的任务不算「从无到有」，不弹（否则切回来时
  // composer 的自动聚焦会被弹层抢走）
  const prevCountRef = useRef(queuedCount);
  const [autoOpenTick, setAutoOpenTick] = useState(0);

  useEffect(() => {
    const prev = prevCountRef.current;
    prevCountRef.current = queuedCount;
    if (shouldAutoOpenQueue(prev, queuedCount)) setAutoOpenTick((t) => t + 1);
  }, [queuedCount]);

  const adapter: QueueBannerAdapter = {
    loadEditText: async (row) => (await fetchTalkQueueEditTexts(taskId))[row.id] ?? null,
    save: async (row, text) => {
      try {
        const updated = await updateTalkQueueItem(taskId, row.id, text);
        return { text: updated.preview };
      } catch (err) {
        if (isTalkQueueItemGone(err)) return "gone";
        throw err;
      }
    },
    remove: async (row) => {
      await removeTalkQueueItems(taskId, [row.id]);
    },
    // bootArgs（apiKey / model）入队时已随消息存在服务端，不用再传
    prepareSendNow: (row) => () => sendTalkQueueItemNow(taskId, row.id),
    sendNowCopy: () => taskSendNowCopy(task.runStatus === "running"),
  };

  return (
    <QueueBanner
      queuedCount={queuedCount}
      autoOpenTick={autoOpenTick}
      adapter={adapter}
      rows={talkQueue.map(rowOf)}
    />
  );
};
