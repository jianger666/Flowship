"use client";

/**
 * 顶栏「提测收件箱」入口：Inbox 图标 + 未读数 badge + Popover 面板
 *
 * 未读数 = 收件箱里没标已读的条数（useMrInbox 全局 store）；
 * meegle 未装 / 未登录（status != ok）时 unreadCount 恒 0——图标照常显示、
 * 不亮红点，点开面板见引导文案。badge 超 99 显示 99+。
 */

import { Inbox } from "lucide-react";

import { MrInboxPanel } from "@/components/mr-inbox/mr-inbox-panel";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useMrInbox } from "@/hooks/use-mr-inbox";
import { formatUnreadBadge } from "@/lib/mr-inbox";

export const MrInboxBell = () => {
  const { unreadCount } = useMrInbox();

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            className="relative [&_svg:not([class*='size-'])]:size-4.5"
            aria-label={
              unreadCount > 0 ? `收件箱（${unreadCount} 条未读）` : "收件箱"
            }
            title="收件箱"
          />
        }
      >
        <Inbox />
        {unreadCount > 0 && (
          <span
            aria-hidden
            className="absolute top-0.5 right-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-destructive px-1 text-[10px] leading-none font-medium text-white"
          >
            {formatUnreadBadge(unreadCount)}
          </span>
        )}
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={8} className="p-2">
        <MrInboxPanel />
      </PopoverContent>
    </Popover>
  );
};
