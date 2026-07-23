"use client";

/**
 * Tooltip（V0.8 加）—— base-ui Tooltip 薄封装、对齐 popover.tsx 的 Portal/Positioner/Popup 结构。
 *
 * 典型用法（hover 显示完整文本气泡、侧栏长标题 truncate 后补全）：
 *   <Tooltip content={task.title}>
 *     <span className="truncate">{task.title}</span>
 *   </Tooltip>
 *
 * - content 为空时直接渲染 children、不挂 tooltip（避免空气泡）。
 * - 走 Root 自带 delay、不强制外层 Provider（Provider 仅用于多 tooltip 共享 delay group）。
 * - 默认 disableHoverablePopup + Popup pointer-events-none：弹层不参与命中。
 *   Dialog / 密集 grid 里 Floating UI 碰撞避让常把气泡叠回 trigger，若不挡指针会
 *   「进 trigger → 出气泡盖住 → leave → 关 → 再进」死循环，cursor 在 default/pointer 间狂闪
 *   （推进弹窗 action 卡实测）。纯展示 tip 不需要在气泡上悬停；真要可点内容另开 Popover。
 */

import * as React from "react";
import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";

import { cn } from "@/lib/utils";

interface TooltipProps {
  content: React.ReactNode;
  children: React.ReactElement;
  side?: TooltipPrimitive.Positioner.Props["side"];
  sideOffset?: number;
  /** hover 多久后显示（ms）、默认 300 */
  delay?: number;
  className?: string;
}

export const Tooltip = ({
  content,
  children,
  side = "top",
  sideOffset = 6,
  delay = 300,
  className,
}: TooltipProps) => {
  if (content == null || content === "") return children;
  return (
    <TooltipPrimitive.Provider delay={delay}>
      {/* disableHoverablePopup：Positioner 在 open 时走 inert → pointer-events:none（见 usePositioner） */}
      <TooltipPrimitive.Root disableHoverablePopup>
        <TooltipPrimitive.Trigger render={children} />
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Positioner
            side={side}
            sideOffset={sideOffset}
            className="isolate z-50"
          >
            <TooltipPrimitive.Popup
              className={cn(
                // pointer-events-none：双保险（Root 已 inert；显式写上防回归、也挡动画帧里的误命中）
                "pointer-events-none max-w-xs rounded-md bg-popover px-2 py-1 text-xs wrap-break-word text-popover-foreground shadow-md ring-1 ring-foreground/10 duration-100 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
                className,
              )}
            >
              {content}
            </TooltipPrimitive.Popup>
          </TooltipPrimitive.Positioner>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
};
