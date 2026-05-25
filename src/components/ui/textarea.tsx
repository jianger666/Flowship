import * as React from "react"

import { cn } from "@/lib/utils"

// V0.5.9 hot-fix：长内容（一行很长的日志 / URL / 序列化 JSON）撑破容器问题
//  - `field-sizing: content` 让 textarea 高度跟内容自适应、但同时 intrinsic 宽度也跟 max-content 走
//  - textarea 作为父 grid/flex item 时、默认 min-width: auto = intrinsic 宽 → 撑破父
//  - 修法：min-w-0 让自己作为 grid/flex item 可收缩 + max-w-full 显式 cap 上限
//  - 同时 break-words / overflow-wrap-anywhere 让无空格长字符串能折断（避免 textarea 内部出横向滚）
function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex field-sizing-content min-h-16 w-full max-w-full min-w-0 wrap-anywhere rounded-lg border border-input bg-transparent px-2.5 py-2 text-base transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
