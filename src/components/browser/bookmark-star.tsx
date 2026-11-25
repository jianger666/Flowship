"use client";

/**
 * 地址栏右端的收藏星标（点一下收藏 / 取消收藏当前页）。
 *
 * 画在地址输入框**里面**（绝对定位在右端，输入框给它留右内边距），而不是工具栏里再多一个按钮：
 * 工具栏面板最窄 300px、地址栏已经被压得很小（R9-05），多一个 28px 的按钮只会把地址栏继续挤没。
 * 必须是 `type="button"`：它在地址栏的 <form> 里，不能让回车 / 点击触发提交导航。
 * 窄于 360px 时由调用方用 `@max-[360px]:hidden` 隐藏（「更多」菜单里有同样的入口）。
 */
import { Star } from "lucide-react";

import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

import { bookmarkToggleLabel } from "./bookmark-flow";

export const BookmarkStar = ({
  starred,
  busy,
  onToggle,
  className,
}: {
  /** 当前页已收藏 */
  starred: boolean;
  /** 上一次切换还没落地：置灰，防连点 */
  busy?: boolean;
  onToggle: () => void;
  className?: string;
}) => {
  const label = bookmarkToggleLabel(starred);
  return (
    // 工具栏在视口上方：tooltip 一律朝上，免得气泡落在视口里（原生视图盖在 HTML 之上，会触发整块遮盖）
    <Tooltip content={label} side="top">
      <button
        type="button"
        aria-label={label}
        aria-pressed={starred}
        disabled={busy}
        onClick={onToggle}
        className={cn(
          "absolute top-1/2 right-1 flex size-5 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:text-muted-foreground",
          className,
        )}
      >
        <Star className={cn("size-3.5", starred && "fill-warning text-warning")} aria-hidden />
      </button>
    </Tooltip>
  );
};
