"use client"

/**
 * Popover（V0.6.24 抽）
 *
 * base-ui Popover 的薄封装、对齐 select.tsx 的 Portal/Positioner/Popup 结构。
 * PopoverContent 把 Portal + Positioner + Popup 三层包成一个、调用方只写 <PopoverContent>。
 * 受控开关走 <Popover open onOpenChange>（Root 透传）。
 */

import * as React from "react"
import { Popover as PopoverPrimitive } from "@base-ui/react/popover"

import { cn } from "@/lib/utils"

const Popover = PopoverPrimitive.Root
const PopoverTrigger = PopoverPrimitive.Trigger

function PopoverContent({
  className,
  side = "bottom",
  sideOffset = 6,
  align = "center",
  alignOffset = 0,
  // fixed：弹层相对视口定位。absolute 会吃到 Card 的 overflow-hidden
  //（设置页「模型」卡点开下拉会被裁在卡片底、看起来像把「凭据」挤下去）。
  positionMethod = "fixed",
  ...props
}: PopoverPrimitive.Popup.Props &
  Pick<
    PopoverPrimitive.Positioner.Props,
    "side" | "sideOffset" | "align" | "alignOffset" | "positionMethod"
  >) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Positioner
        side={side}
        sideOffset={sideOffset}
        align={align}
        alignOffset={alignOffset}
        positionMethod={positionMethod}
        className="isolate z-50"
      >
        <PopoverPrimitive.Popup
          data-slot="popover-content"
          className={cn(
            "relative z-50 max-w-[calc(100vw-1rem)] origin-(--transform-origin) overflow-x-hidden rounded-lg bg-popover p-3 text-popover-foreground shadow-md ring-1 ring-foreground/10 duration-100 *:min-w-0 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
            className,
          )}
          {...props}
        />
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  )
}

export { Popover, PopoverTrigger, PopoverContent }
