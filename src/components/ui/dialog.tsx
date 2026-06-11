"use client"

import * as React from "react"
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { XIcon } from "lucide-react"

function Dialog({ ...props }: DialogPrimitive.Root.Props) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />
}

function DialogTrigger({ ...props }: DialogPrimitive.Trigger.Props) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />
}

function DialogPortal({ ...props }: DialogPrimitive.Portal.Props) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />
}

function DialogClose({ ...props }: DialogPrimitive.Close.Props) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />
}

function DialogOverlay({
  className,
  ...props
}: DialogPrimitive.Backdrop.Props) {
  return (
    <DialogPrimitive.Backdrop
      data-slot="dialog-overlay"
      className={cn(
        "fixed inset-0 isolate z-50 bg-black/10 duration-100 supports-backdrop-filter:backdrop-blur-xs data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
        className
      )}
      {...props}
    />
  )
}

// V0.5.4 改造：DialogContent 改为「mask 滚动」模式（用户拍板）。
//
// 旧实现：Popup `fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2`、超长内容超屏看不到。
// 老兜底：调用方在 Popup className 加 `max-h-[90vh] overflow-y-auto`、弹窗内部出滚动条。
//
// 新实现（用户期望）：弹窗本身不固定居中、放在一个 viewport 满铺的 scrollable wrapper 里、
// 超长内容时整个 mask + 弹窗一起滚动（页面级滚动条、不在弹窗内部出条）。
//   - DialogOverlay（base-ui Backdrop）保留为 fixed inset-0、只负责视觉遮罩 + click-close
//   - 新增 scroll wrapper：fixed inset-0 z-50 overflow-y-auto + grid place-items-center
//     （`place-items-center` 让内容短时居中、长时贴顶 + 自然撑长）
//   - DialogPrimitive.Popup 改为 relative + my-8 自然布局、随内容高度自然撑
//
// 注意：base-ui Backdrop / Popup 是 Portal 内的兄弟节点（不能 Backdrop 套 Popup）、
// scroll wrapper 必须跟 Backdrop 同层、跟 Popup 是父子。
//
// 影响范围：所有 Dialog 自动获得 mask 滚动、不需要单独加 max-h-[xx] / overflow-y-auto。
// 调用方如果在 Popup 上还塞了 max-h / overflow（如 NewTaskDialog V0.5.4 加的）、应该去掉。
function DialogContent({
  className,
  children,
  showCloseButton = true,
  ...props
}: DialogPrimitive.Popup.Props & {
  showCloseButton?: boolean
}) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <div className="fixed inset-0 z-50 grid place-items-center overflow-y-auto p-4">
        <DialogPrimitive.Popup
          data-slot="dialog-content"
          className={cn(
            // grid 是为了让 gap-4 在 Popup 内部 stack（header / body / footer）生效——原版同款
            // relative 替代原 fixed top/left/transform、配合外层 wrapper 实现 mask 滚动
            //
            // V0.5.9 hot-fix：`*:min-w-0` 防止 grid item 撑破 max-w 限制（用户实测踩到）
            //   - dialog 内贴超长无空格字符串（日志 / URL / 序列化 JSON）时、grid item 默认 min-width:auto
            //     = max-content of 内容、撑大 grid item 边界、超出 dialog max-w
            //   - 加 `*:min-w-0`（Tailwind 4 短写、等价 `[&>*]:min-w-0`）让所有直接 children 可以收缩到 0、
            //     内部 truncate / 自动折行才真正生效
            //   - 如果你后面真有一个 dialog 想让内容撑大（罕见）、再单独 override
            "relative grid w-full max-w-[calc(100%-2rem)] gap-4 rounded-xl bg-popover p-4 text-sm text-popover-foreground ring-1 ring-foreground/10 duration-100 outline-none sm:max-w-sm data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 *:min-w-0",
            className
          )}
          {...props}
        >
          {children}
          {showCloseButton && (
            <DialogPrimitive.Close
              data-slot="dialog-close"
              render={
                <Button
                  variant="ghost"
                  className="absolute top-2 right-2"
                  size="icon-sm"
                />
              }
            >
              <XIcon />
              <span className="sr-only">Close</span>
            </DialogPrimitive.Close>
          )}
        </DialogPrimitive.Popup>
      </div>
    </DialogPortal>
  )
}

// V0.6.33：非模态「角落停靠」内容——「再聊聊」这类**边看文档边写**的输入场景用。
//
// 跟 DialogContent 的差异：
//   - 无 Backdrop 遮罩、不满屏居中——固定在视口右下角、页面主内容完全可见
//   - 必须配合 Root 上 `modal={false}`（不锁滚动 / 不拦外部点击 / 不 focus trap）+
//     `disablePointerDismissal`（点外部不关——用户去左侧滚方案 / 选文本不会误关、草稿不丢）用
//   - Esc / X / 取消按钮仍可关（Esc 是 base-ui Popup 自带、不受 disablePointerDismissal 影响）
//
// 超长内容：max-h + 内部滚动（停靠场景没有「mask 滚动」可言）。
function DialogDockedContent({
  className,
  children,
  showCloseButton = true,
  ...props
}: DialogPrimitive.Popup.Props & {
  showCloseButton?: boolean
}) {
  return (
    <DialogPortal>
      <DialogPrimitive.Popup
        data-slot="dialog-docked-content"
        className={cn(
          "fixed right-4 bottom-4 z-50 grid max-h-[min(80vh,40rem)] w-[min(28rem,calc(100vw-2rem))] gap-4 overflow-y-auto rounded-xl bg-popover p-4 text-sm text-popover-foreground shadow-2xl ring-1 ring-foreground/10 duration-100 outline-none data-open:animate-in data-open:fade-in-0 data-open:slide-in-from-bottom-4 data-closed:animate-out data-closed:fade-out-0 data-closed:slide-out-to-bottom-4 *:min-w-0",
          className
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close
            data-slot="dialog-close"
            render={
              <Button
                variant="ghost"
                className="absolute top-2 right-2"
                size="icon-sm"
              />
            }
          >
            <XIcon />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Popup>
    </DialogPortal>
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-2", className)}
      {...props}
    />
  )
}

// DialogFooter
// 默认带 -mx-4 -mb-4——shadcn 约定的「全宽 footer」效果、依赖父 DialogContent 有 p-4。
// 如果你把父 DialogContent 改成 p-0（比如自己手控 header / 滚动 body / footer 三段布局）、
// 记得在 DialogFooter className 上加 `mx-0 mb-0` 覆盖、否则负 margin 会把 footer
// 拉出 content 边界、又被 overflow-hidden 裁掉、视觉上「贴底没下间距」。
function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  showCloseButton?: boolean
}) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "-mx-4 -mb-4 flex flex-col-reverse gap-2 rounded-b-xl border-t bg-muted/50 p-4 sm:flex-row sm:justify-end",
        className
      )}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close render={<Button variant="outline" />}>
          Close
        </DialogPrimitive.Close>
      )}
    </div>
  )
}

function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn(
        "text-base leading-none font-medium",
        className
      )}
      {...props}
    />
  )
}

function DialogDescription({
  className,
  ...props
}: DialogPrimitive.Description.Props) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn(
        "text-sm text-muted-foreground *:[a]:underline *:[a]:underline-offset-3 *:[a]:hover:text-foreground",
        className
      )}
      {...props}
    />
  )
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogDockedContent,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
}
