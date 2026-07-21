"use client";

/**
 * chat 排队提示条 + 可展开队列面板（D 批次、grok P1「队列可视化」）
 *
 * 原来只有一行文案「已排队…（第 N 条）」；现在点击展开 Popover 面板：
 * 列出排队中消息（GET /chat-queue 实时拉）、每行可「删除」/「立即发送」。
 * 删除走 DELETE /chat-queue → server removeQueuedChatMessages 会 publish
 * queue_failed(cancelled)，客户端 ledger 经 SSE 自动清 pending 占位、条数自然回落。
 * 「立即发送」= POST send_now（server：take → stop 清剩余队 → 用该条起新会话）；
 * 不再走 promote + stop（stop 会 failQueuedItems 清整队、含刚置顶那条）。
 */

import { useState } from "react";
import { ChevronDown, Loader2, Trash2, Zap } from "lucide-react";
import { toast } from "sonner";

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { EmptyHint } from "@/components/ui/empty-hint";
import { LoadingState } from "@/components/ui/loading-state";
import { summarize } from "@/components/tasks/event-stream/utils";
import { prepareRunArgs } from "@/lib/run-args";
import {
  fetchChatQueue,
  removeChatQueueItems,
  sendQueuedChatMessageNow,
  type ChatQueueItem,
} from "@/lib/task-store";
import type { Task } from "@/lib/types";

interface Props {
  task: Task;
  /** 本地 ledger 统计的排队条数（banner 文案用；面板列表以服务端为准） */
  queuedCount: number;
}

export const ChatQueueBanner = ({ task, queuedCount }: Props) => {
  const taskId = task.id;
  // 面板开关（受控：打开时拉一次服务端队列快照）
  const [open, setOpen] = useState(false);
  // 服务端队列快照（null = 尚未拉到）
  const [items, setItems] = useState<ChatQueueItem[] | null>(null);
  // 拉取飞行中
  const [loading, setLoading] = useState(false);
  // 删除飞行中的 itemId 集合（行内按钮 disabled、防连点）
  const [deleting, setDeleting] = useState<ReadonlySet<string>>(new Set());
  // 「立即发送」飞行中的 itemId 集合（防连点）
  const [sendingNow, setSendingNow] = useState<ReadonlySet<string>>(new Set());

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) return;
    setLoading(true);
    void fetchChatQueue(taskId)
      .then(setItems)
      .catch((err) => {
        toast.error(`拉取队列失败：${(err as Error).message}`);
        setItems(null);
      })
      .finally(() => setLoading(false));
  };

  const handleDelete = (itemId: string) => {
    setDeleting((prev) => new Set(prev).add(itemId));
    void removeChatQueueItems(taskId, [itemId])
      .then((removedIds) => {
        if (removedIds.length === 0) {
          // 队里已经没有它了（多半刚被发出）——刷新列表对齐现实
          toast.message("该消息已发出、无法删除");
        }
        setItems((prev) =>
          prev ? prev.filter((it) => it.itemId !== itemId) : prev,
        );
      })
      .catch((err) => {
        toast.error(`删除失败：${(err as Error).message}`);
      })
      .finally(() => {
        setDeleting((prev) => {
          const next = new Set(prev);
          next.delete(itemId);
          return next;
        });
      });
  };

  /**
   * 立即发送：prepareRunArgs 拿 bootArgs → POST send_now。
   * server 原子编排 take→stop→注入，本地列表直接去掉该条。
   */
  const handleSendNow = (itemId: string) => {
    const args = prepareRunArgs(task);
    if (!args) return; // prepareRunArgs 已 toast

    setSendingNow((prev) => new Set(prev).add(itemId));
    void sendQueuedChatMessageNow(taskId, itemId, {
      apiKey: args.apiKey,
      model: args.model,
    })
      .then(() => {
        setItems((prev) =>
          prev ? prev.filter((it) => it.itemId !== itemId) : prev,
        );
        setOpen(false);
      })
      .catch((err) => {
        toast.error(`立即发送失败：${(err as Error).message}`);
      })
      .finally(() => {
        setSendingNow((prev) => {
          const next = new Set(prev);
          next.delete(itemId);
          return next;
        });
      });
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger
        render={
          <button
            type="button"
            className="mx-2.5 mb-1.5 flex cursor-pointer items-center gap-1.5 rounded-md border border-border/60 bg-muted/40 px-2.5 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-muted/60"
          >
            <span className="min-w-0 flex-1 truncate">
              已排队 {queuedCount} 条，将在当前回复完成后发送
            </span>
            <ChevronDown className="size-3 shrink-0 opacity-60" />
          </button>
        }
      />
      <PopoverContent align="start" className="w-80 p-2">
        <div className="mb-1.5 px-1 text-xs font-medium">排队中的消息</div>
        {loading && items === null ? (
          <LoadingState variant="inline" className="px-1" />
        ) : !items || items.length === 0 ? (
          <EmptyHint size="sm">队列已空（可能刚被发出或删除）</EmptyHint>
        ) : (
          <ul className="space-y-1">
            {items.map((it) => {
              const busy =
                deleting.has(it.itemId) || sendingNow.has(it.itemId);
              return (
                <li
                  key={it.itemId}
                  className="flex items-center gap-1 rounded-md px-1.5 py-1 hover:bg-muted/40"
                >
                  <span
                    className="min-w-0 flex-1 truncate text-xs"
                    title={it.displayText}
                  >
                    {summarize(it.displayText) || "（纯附件消息）"}
                  </span>
                  <button
                    type="button"
                    onClick={() => handleSendNow(it.itemId)}
                    disabled={busy}
                    title="立即发送（打断当前回复）"
                    aria-label="立即发送"
                    className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
                  >
                    {sendingNow.has(it.itemId) ? (
                      <Loader2 className="size-3 animate-spin" />
                    ) : (
                      <Zap className="size-3" />
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDelete(it.itemId)}
                    disabled={busy}
                    title="从队列删除"
                    aria-label="删除"
                    className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-destructive disabled:opacity-50"
                  >
                    {deleting.has(it.itemId) ? (
                      <Loader2 className="size-3 animate-spin" />
                    ) : (
                      <Trash2 className="size-3" />
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
};
