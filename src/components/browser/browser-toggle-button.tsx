"use client";

import { memo } from "react";
import { Globe } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useBrowserSignals } from "./use-browser-session";

interface BrowserToggleButtonProps {
  taskId: string;
  /** 浏览器面板当前是否展开（aria-expanded；展开时「未读用户操作」角标不显示——你自己的操作你都看得见） */
  open: boolean;
  onToggle: () => void;
  size?: "xs" | "sm";
  className?: string;
}

/**
 * 头部入口：地球图标。
 *  - AI 正在用浏览器（controller === 'ai'）：文字后面一颗**静态**状态点（不带任何动画：ui-conventions「状态点静态、同屏只留一处主动效」；
 *    读屏靠可访问名里的「AI 正在使用」，不靠这颗点）（R2-07）；
 *  - AI 在等你操作（askRequest）：醒目的 ! 角标；
 *  - 有 AI 还没看到的用户操作：数字角标（面板收起时才显示）。
 * 它自己订阅「信号」（controller / ask / 未读数），这些没变就不重渲，所以父级（任务页 / ChatView）
 * 不会因为浏览器状态高频推送而重渲。
 */
const BrowserToggleButtonImpl = ({
  taskId,
  open,
  onToggle,
  size = "xs",
  className,
}: BrowserToggleButtonProps) => {
  const signals = useBrowserSignals(taskId);
  // 网页版 / 旧壳没有浏览器桥：入口整个不画（对这些用户零影响）
  if (!signals.available) return null;
  const aiActive = signals.controller === "ai";
  const asking = signals.askMessage !== null;
  const unseen = !open && !asking ? signals.pendingUserActivity : 0;

  // 可访问名随状态补充（读屏用户看不到点 / 角标）
  const hint = asking
    ? "AI 在等你操作"
    : aiActive
      ? "AI 正在使用"
      : unseen > 0
        ? `AI 还没看到你的 ${unseen} 步操作`
        : "";
  const label = hint ? `浏览器（${hint}）` : "浏览器";

  return (
    <Tooltip content={open ? "收起浏览器" : "打开内置浏览器"}>
      <Button
        type="button"
        variant="outline"
        size={size}
        className={cn("relative", className)}
        onClick={onToggle}
        aria-label={label}
        aria-expanded={open}
      >
        <Globe />
        浏览器
        {aiActive && !asking && (
          // 状态点静态（ui-conventions：同屏只留状态行那一处主动效；AI 在用的信号靠这颗点本身 + 可访问名）
          <span aria-hidden className="size-1.5 rounded-full bg-primary" />
        )}
        {asking && (
          <span
            aria-hidden
            className="ml-0.5 inline-flex size-3.5 items-center justify-center rounded-full bg-warning text-[11px] leading-none font-semibold text-background"
          >
            !
          </span>
        )}
        {unseen > 0 && (
          <span
            aria-hidden
            className="ml-0.5 inline-flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-primary px-1 text-[11px] leading-none font-medium tabular-nums text-primary-foreground"
          >
            {unseen > 99 ? "99+" : unseen}
          </span>
        )}
      </Button>
    </Tooltip>
  );
};

export const BrowserToggleButton = memo(BrowserToggleButtonImpl);
