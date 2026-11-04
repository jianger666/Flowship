"use client";

/**
 * chat 排队提示条（D 批次、grok P1「队列可视化」）——面板本体在 queue-banner（与 task 共用），
 * 这里只接 chat 的数据来源与动作：
 *
 * - 条目：打开面板 / 自动弹开时 GET /chat-queue 实时拉；
 * - 编辑：PUT /chat-queue 原地改文本；删除：DELETE /chat-queue；
 * - 「立即发送」= POST send_now，server 分两条路（chat-queue-send-now）：
 *   1. 能插话（Cursor 本地 run）：不停止、把这条插进正在跑的这一轮；
 *   2. 不能（自定义 provider 等）：take → 先救出其余排队 → stop → 用该条起新会话 → 其余排队放回队列
 *      （其余排队消息保留，只打断当前回复）。
 *   客户端按 provider 预判走哪条（lib/queue-banner.predictSendNowMode）：会打断时 tooltip 如实说明并先确认。
 *   不再走 promote + stop（stop 会 failQueuedItems 清整队、含刚置顶那条）。
 *
 * 「排队从无到有」由 chat-view 在订阅到的实时 dispatch 里判定、递增 autoOpenTick 通知（R6-01 / N1，见 queue-banner）。
 */

import { QueueBanner, type QueueBannerAdapter, type QueueRow } from "@/components/tasks/queue-banner";
import { resolveTaskProvider } from "@/lib/agent-provider";
import { getSettings } from "@/lib/local-store";
import { predictSendNowMode, sendNowCopy } from "@/lib/queue-banner";
import { prepareRunArgs } from "@/lib/run-args";
import {
  fetchChatQueue,
  removeChatQueueItems,
  sendQueuedChatMessageNow,
  updateChatQueueItem,
} from "@/lib/task-store";
import type { Task } from "@/lib/types";

interface Props {
  task: Task;
  /** 本地 ledger 统计的排队条数（banner 文案用；面板列表以服务端为准）；0 = 不显示（组件返回 null） */
  queuedCount: number;
  /**
   * 「排队从无到有」的实时信号：chat-view 在订阅到的 ledger dispatch 里发现 0→N 时递增。
   * 面板只认「变化」，初值取挂载时的值（挂载 = 恢复，不弹，N1）。
   */
  autoOpenTick: number;
}

export const ChatQueueBanner = ({ task, queuedCount, autoOpenTick }: Props) => {
  const taskId = task.id;

  /** 按窗口绑定的 provider 预判「立即发送」会不会打断当前回复（读设置，只在面板打开后 / 点击时调用） */
  const currentSendNowMode = () =>
    predictSendNowMode(resolveTaskProvider(task, getSettings()));

  const adapter: QueueBannerAdapter = {
    save: async (row, text) => {
      const updated = await updateChatQueueItem(taskId, row.id, text);
      return { text: updated.displayText };
    },
    remove: async (row) => {
      await removeChatQueueItems(taskId, [row.id]);
    },
    // 立即发送：prepareRunArgs 拿 bootArgs（缺了已 toast）；server 原子编排，见文件头
    prepareSendNow: (row) => {
      const args = prepareRunArgs(task);
      if (!args) return null;
      return async () => {
        await sendQueuedChatMessageNow(taskId, row.id, {
          apiKey: args.apiKey,
          model: args.model,
        });
        return "sent";
      };
    },
    sendNowCopy: () => sendNowCopy(currentSendNowMode()),
  };

  return (
    <QueueBanner
      queuedCount={queuedCount}
      autoOpenTick={autoOpenTick}
      adapter={adapter}
      fetchRows={async (): Promise<QueueRow[]> =>
        (await fetchChatQueue(taskId)).map((it) => ({
          id: it.itemId,
          text: it.displayText,
          canEdit: true,
          canSendNow: true,
        }))
      }
    />
  );
};
