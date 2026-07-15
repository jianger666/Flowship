"use client";

/**
 * 任务内提测提醒条（任务详情页顶部）
 *
 * task.feishuStoryUrl 对应的工作项在收件箱里有未读 MR 时才渲染：
 * 「本需求有 N 个待测 MR」+ 点开同一个面板组件（过滤到本工作项）+ 手动刷新。
 * 数据与顶栏收件箱同一份 store——一处标已读、两处同步灭灯。
 */

import { Inbox, RefreshCw } from "lucide-react";

import { MrInboxPanel } from "@/components/mr-inbox/mr-inbox-panel";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useMrInbox } from "@/hooks/use-mr-inbox";
import { extractFeishuStoryId } from "@/lib/branch-template";
import { cn } from "@/lib/utils";

interface MrInboxTaskBannerProps {
  /** 任务绑定的飞书工作项 URL（无 / 抠不出 id 则不渲染） */
  feishuStoryUrl?: string;
  className?: string;
}

export const MrInboxTaskBanner = ({
  feishuStoryUrl,
  className,
}: MrInboxTaskBannerProps) => {
  const { data, refreshing, refresh } = useMrInbox();

  const workItemId = extractFeishuStoryId(feishuStoryUrl);
  if (!workItemId || data?.status !== "ok") return null;

  // 本需求的未读待测 MR（有才挂条、已读完就撤——轻量提醒不常驻）
  const unread = data.pendingMr.filter(
    (it) => it.workItemId === workItemId && it.seenAtMs === null,
  );
  if (unread.length === 0) return null;

  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-md border border-primary/25 bg-primary/5 px-3 py-1.5 text-xs",
        className,
      )}
    >
      <Inbox className="size-3.5 shrink-0 text-primary" />
      <span className="min-w-0 flex-1 truncate">
        本需求有 <span className="font-semibold">{unread.length}</span> 个待测 MR
      </span>
      <Popover>
        <PopoverTrigger
          render={
            <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" />
          }
        >
          查看
        </PopoverTrigger>
        <PopoverContent align="end" sideOffset={6} className="p-2">
          <MrInboxPanel filterWorkItemId={workItemId} />
        </PopoverContent>
      </Popover>
      <Button
        variant="ghost"
        size="icon-sm"
        className="size-6"
        onClick={() => void refresh({ force: true })}
        disabled={refreshing}
        aria-label="刷新提测收件箱"
        title="重新扫描提测评论"
      >
        <RefreshCw className={cn("size-3", refreshing && "animate-spin")} />
      </Button>
    </div>
  );
};
