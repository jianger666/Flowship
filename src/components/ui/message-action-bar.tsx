"use client";

/**
 * 消息 hover 动作条（事件流单一来源）
 *
 * 为什么抽公共件：同一条「浮在消息块右上角、hover 才显形的分段小按钮条」在三处出现——
 * chat AI 回复（复制 / 分享 / 重新生成）、log AI 回复（复制 / 分享）、chat 用户消息
 * （回退 / 重发 / 编辑）。以前三处各写一份 className，已经漂出「-top-2 vs -top-3」
 * 「有没有 z-10」「log 形态压根没有复制」这些差异。视觉契约收在这里，加动作只改调用方数组。
 *
 * 宿主容器必须挂 `MESSAGE_ACTION_HOST`——动作条靠它的 hover 态显形、靠它的 relative 定位。
 */

import type { ReactNode } from "react";
import { Loader2 } from "lucide-react";

import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * 宿主容器 class：`group/msgbar` 驱动 hover 显形、`relative` 承载动作条的绝对定位。
 * 单独用具名 group（不是裸 `group`）——消息块内部还有别的 hover 作用域，别互相串。
 */
export const MESSAGE_ACTION_HOST = "group/msgbar relative";

export interface MessageAction {
  /** React key；同时用作动作语义标识 */
  key: string;
  icon: ReactNode;
  /** tooltip + aria-label（无文字按钮的唯一可读标签） */
  label: string;
  onClick: () => void;
  /** 可选行内文字（如「回退到这里」）；不传则是纯图标按钮 */
  text?: string;
  disabled?: boolean;
  /** 飞行中：图标换 spinner 并禁用（防双击连点） */
  busy?: boolean;
}

/** 调用方可以直接写 `cond && {...}`，falsy 项在这里被滤掉、不影响分隔线计算 */
export type MessageActionInput = MessageAction | false | null | undefined;

export const MessageActionBar = ({
  actions,
  className,
}: {
  actions: MessageActionInput[];
  className?: string;
}) => {
  const items = actions.filter((a): a is MessageAction => !!a);
  if (items.length === 0) return null;

  return (
    <div
      className={cn(
        "absolute -top-3 right-2 z-10 flex items-center overflow-hidden rounded-md border bg-background shadow-sm",
        // 平时透明、hover 或键盘聚焦时显形（tab 到按钮上也要看得见）
        "opacity-0 transition-opacity group-hover/msgbar:opacity-100 focus-within:opacity-100",
        className,
      )}
    >
      {items.map((action, idx) => (
        <Tooltip key={action.key} content={action.label}>
          <span className="inline-flex">
            <button
              type="button"
              onClick={action.onClick}
              disabled={action.disabled || action.busy}
              aria-label={action.label}
              className={cn(
                "flex cursor-pointer items-center gap-1 px-2 py-1.5 text-[11px] text-muted-foreground",
                "hover:bg-muted hover:text-foreground",
                "disabled:cursor-not-allowed disabled:opacity-50",
                idx > 0 && "border-l",
              )}
            >
              {action.busy ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                action.icon
              )}
              {action.text}
            </button>
          </span>
        </Tooltip>
      ))}
    </div>
  );
};
