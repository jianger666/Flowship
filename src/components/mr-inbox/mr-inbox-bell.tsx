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
import { Tooltip } from "@/components/ui/tooltip";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useMrInbox } from "@/hooks/use-mr-inbox";
import { formatUnreadBadge } from "@/lib/mr-inbox";

export const MrInboxBell = () => {
  const { unreadCount } = useMrInbox();

  // PopoverTrigger 的 render 必须是可交互 DOM（Button）。
  // 之前把 Tooltip 塞进 render：Base UI 的 onClick/ref/children 落到不透传的 Tooltip 上 →
  // Inbox 图标进不了 Button（空方块）、点击打不开面板（combobox.tsx 同款坑）。
  // Tooltip 包外层 span，hover tip 与 Popover 点击各走各的。
  return (
    <Popover>
      <Tooltip content="收件箱">
        <span className="inline-flex">
          <PopoverTrigger
            render={
              <Button
                variant="ghost"
                size="icon"
                className="relative [&_svg:not([class*='size-'])]:size-4.5"
                aria-label={
                  unreadCount > 0
                    ? `收件箱（${unreadCount} 条未读）`
                    : "收件箱"
                }
              />
            }
          >
            <Inbox />
            {unreadCount > 0 && (
              <span
                aria-hidden
                className="absolute top-0.5 right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[11px] leading-none font-medium text-white"
              >
                {formatUnreadBadge(unreadCount)}
              </span>
            )}
          </PopoverTrigger>
        </span>
      </Tooltip>
      <PopoverContent align="end" sideOffset={8} className="p-2">
        <MrInboxPanel />
      </PopoverContent>
    </Popover>
  );
};
