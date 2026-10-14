"use client";

/**
 * task 模式「待送达」队列：一行提示条 + 可展开面板（来源标签 / 预览 / 删除）。
 *
 * 数据只认 SSE `talk_queue` 帧的整份快照（每次连接 bootstrap 都会补发），不另拉接口——
 * 删除走 DELETE，服务端删完会再推一帧快照，条数自然回落；
 * 与 chat 的排队条一致：排队从无到有时自动弹开一次（用户要常驻感知），关了等下一轮 0→N 再弹。
 */

import { useEffect, useRef, useState } from "react";
import { ChevronRight, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyHint } from "@/components/ui/empty-hint";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { removeTalkQueueItems, type TalkQueueItem } from "@/lib/task-store";
import { TALK_QUEUE_SOURCE_LABEL } from "@/lib/talk-queue";

interface Props {
  taskId: string;
  /** SSE 实时快照（整份，含群里排队的提问） */
  talkQueue: TalkQueueItem[];
}

export const TalkQueueBanner = ({ taskId, talkQueue }: Props) => {
  const queuedCount = talkQueue.length;
  // 面板开关
  const [open, setOpen] = useState(false);
  // 删除飞行中的条目 id（行内按钮 disabled 防连点；快照里消失后无需再清）
  const [deleting, setDeleting] = useState<ReadonlySet<string>>(new Set());
  // 上一次的条数：用来识别「从无到有」的那一下
  const prevCountRef = useRef(0);

  useEffect(() => {
    const prev = prevCountRef.current;
    prevCountRef.current = queuedCount;
    if (prev <= 0 && queuedCount > 0) setOpen(true);
  }, [queuedCount]);

  const handleDelete = (itemId: string) => {
    setDeleting((prev) => new Set(prev).add(itemId));
    void removeTalkQueueItems(taskId, [itemId])
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

  if (queuedCount <= 0) return null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            title="点击管理排队消息"
            className="mx-2.5 mb-1.5 flex cursor-pointer items-center gap-2 rounded-full border border-primary/30 bg-primary/10 px-3 py-1.5 text-left text-xs font-medium text-foreground shadow-sm transition-colors hover:bg-primary/15"
          >
            <span className="relative flex size-2 shrink-0">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary/50" />
              <span className="relative inline-flex size-2 rounded-full bg-primary" />
            </span>
            <span className="inline-flex min-w-5 shrink-0 items-center justify-center rounded-full bg-primary px-1.5 py-0.5 text-[11px] font-semibold tabular-nums text-primary-foreground">
              {queuedCount}
            </span>
            <span className="min-w-0 flex-1 truncate">
              条消息排队中，当前这轮跑完自动送达
            </span>
            <ChevronRight className="size-3.5 shrink-0 opacity-70" />
          </button>
        }
      />
      <PopoverContent align="start" className="w-80 p-2">
        <div className="mb-1.5 px-1 text-xs font-medium">排队中的消息</div>
        {talkQueue.length === 0 ? (
          <EmptyHint className="px-1 py-2">队列已空</EmptyHint>
        ) : (
          <ul className="max-h-64 space-y-1 overflow-y-auto">
            {talkQueue.map((it) => (
              <li
                key={it.id}
                className="flex items-start gap-2 rounded-md border border-border/60 px-2 py-1.5 text-xs"
              >
                <div className="min-w-0 flex-1">
                  <div className="mb-0.5 flex flex-wrap items-center gap-1">
                    <Badge variant="secondary" className="text-[11px]">
                      {TALK_QUEUE_SOURCE_LABEL[it.source] ?? it.source}
                    </Badge>
                    {it.senderName ? (
                      <span className="text-muted-foreground">
                        {it.senderName}
                        {it.senderIsBot ? (
                          <Badge
                            variant="outline"
                            className="ml-1 px-1 py-0 text-[11px]"
                          >
                            机器人
                          </Badge>
                        ) : null}
                      </span>
                    ) : null}
                  </div>
                  <p className="line-clamp-3 whitespace-pre-wrap break-words text-foreground/90">
                    {it.preview}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  title="从队列移除"
                  disabled={deleting.has(it.id)}
                  className="shrink-0 text-muted-foreground hover:text-destructive"
                  onClick={() => handleDelete(it.id)}
                >
                  <Trash2 />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
};
