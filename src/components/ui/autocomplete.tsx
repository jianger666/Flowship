"use client"

/**
 * Autocomplete（输入框 + 联想下拉）
 *
 * base-ui Autocomplete 的薄封装、结构与 popover.tsx / select.tsx 一致：
 * AutocompleteContent 把 Portal + Positioner + Popup 三层包成一个；输入框用本仓库的 <Input> 渲染（外观与别处的输入框一致）。
 *
 * 用法要点（base-ui 的语义，这里不改）：
 * - Root 的 `value` / `onValueChange` 是**输入框文字**（不是选中项）；`mode="none"` = 列表不过滤、输入框文字也不随高亮项变化
 *   （排序 / 过滤由调用方自己做，行内补全留给以后——它与输入法组词冲突）；
 * - 受控开关走 `open` / `onOpenChange`；Escape 在弹层没打开时会以 reason="escape-key" 把输入值清成 ""，调用方要忽略这类原因；
 * - 选中一项请用 <AutocompleteItem onClick>（指针点击和「已高亮时按 Enter」都会触发它）。
 *
 * 弹层带 role="listbox"（AutocompleteList）：内置浏览器的原生视图会据此自动遮盖让位（use-overlay-cover），不用额外接线。
 */

import * as React from "react"
import { Autocomplete as AutocompletePrimitive } from "@base-ui/react/autocomplete"

import { Input } from "@/components/ui/input"
import { usePopupContainer } from "@/components/ui/popup-container"
import { cn } from "@/lib/utils"

const Autocomplete = AutocompletePrimitive.Root

// className 收窄成 string：base-ui 允许传「按状态算 className 的函数」，但 <Input> 只收字符串
function AutocompleteInput({
  className,
  ...props
}: Omit<AutocompletePrimitive.Input.Props, "className"> & { className?: string }) {
  // render={<Input />}：base-ui 把联想需要的 ARIA / 键盘 / 焦点接线合并进我们的 Input，外观不变
  return <AutocompletePrimitive.Input render={<Input className={className} />} {...props} />
}

function AutocompleteContent({
  className,
  anchor,
  side = "bottom",
  sideOffset = 0,
  align = "start",
  alignOffset = 0,
  // fixed：弹层相对视口定位，不被祖先的 overflow-hidden 裁掉
  positionMethod = "fixed",
  // 默认 5px 的「离视口边缘留白」会把贴着窗口边的锚点（工具栏）上的弹层推歪 5px：这里要与锚点严格对齐，留白归 0
  collisionPadding = 0,
  ...props
}: AutocompletePrimitive.Popup.Props &
  Pick<
    AutocompletePrimitive.Positioner.Props,
    "anchor" | "side" | "sideOffset" | "align" | "alignOffset" | "positionMethod" | "collisionPadding"
  >) {
  // 全屏时浮层要挂进全屏元素才看得见（见 popup-container）；默认 undefined = <body>
  const container = usePopupContainer()
  return (
    <AutocompletePrimitive.Portal container={container}>
      <AutocompletePrimitive.Positioner
        anchor={anchor}
        side={side}
        sideOffset={sideOffset}
        align={align}
        alignOffset={alignOffset}
        positionMethod={positionMethod}
        collisionPadding={collisionPadding}
        className="isolate z-50"
      >
        <AutocompletePrimitive.Popup
          data-slot="autocomplete-content"
          className={cn(
            "relative z-50 w-(--anchor-width) max-w-[calc(100vw-1rem)] origin-(--transform-origin) overflow-hidden rounded-lg bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10 duration-100 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
            className,
          )}
          {...props}
        />
      </AutocompletePrimitive.Positioner>
    </AutocompletePrimitive.Portal>
  )
}

function AutocompleteList({ className, ...props }: AutocompletePrimitive.List.Props) {
  return (
    <AutocompletePrimitive.List
      data-slot="autocomplete-list"
      className={cn("max-h-72 scroll-py-1 overflow-y-auto p-1", className)}
      {...props}
    />
  )
}

function AutocompleteItem({ className, ...props }: AutocompletePrimitive.Item.Props) {
  return (
    <AutocompletePrimitive.Item
      data-slot="autocomplete-item"
      className={cn(
        "flex min-w-0 cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-xs outline-none select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground",
        className,
      )}
      {...props}
    />
  )
}

export { Autocomplete, AutocompleteInput, AutocompleteContent, AutocompleteList, AutocompleteItem }
