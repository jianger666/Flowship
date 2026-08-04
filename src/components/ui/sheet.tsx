"use client";

/**
 * 右侧 Sheet（基于 base-ui Dialog 定位成 drawer）
 *
 * 非模态侧栏：默认 `modal={false}` + 不渲染 Backdrop，左侧任务区仍可看/点；
 * `disablePointerDismissal` 默认 true，连点路径切换预览时不误关；Esc / X 仍可关。
 *
 * 为什么不用居中 Dialog：本地文件预览是「边看任务边瞄文件」、占右侧一条；
 * 以后若要换成左侧/全屏，只改 SheetContent 定位即可。
 */

import * as React from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { XIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useTitleBarOverlayDim } from "@/hooks/use-titlebar-overlay-dim";
import { cn } from "@/lib/utils";

function Sheet({
  modal = false,
  disablePointerDismissal = true,
  ...props
}: DialogPrimitive.Root.Props) {
  return (
    <DialogPrimitive.Root
      data-slot="sheet"
      modal={modal}
      disablePointerDismissal={disablePointerDismissal}
      {...props}
    />
  );
}

function SheetPortal({ ...props }: DialogPrimitive.Portal.Props) {
  return <DialogPrimitive.Portal data-slot="sheet-portal" {...props} />;
}

function SheetOverlay({
  className,
  ...props
}: DialogPrimitive.Backdrop.Props) {
  useTitleBarOverlayDim();
  return (
    <DialogPrimitive.Backdrop
      data-slot="sheet-overlay"
      className={cn(
        "fixed inset-0 z-50 bg-black/20 duration-200 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0 supports-backdrop-filter:backdrop-blur-xs",
        className,
      )}
      {...props}
    />
  );
}

function SheetContent({
  className,
  children,
  showCloseButton = true,
  ...props
}: DialogPrimitive.Popup.Props & { showCloseButton?: boolean }) {
  return (
    <SheetPortal>
      <DialogPrimitive.Popup
        data-slot="sheet-content"
        className={cn(
          "fixed inset-y-0 right-0 z-50 flex w-full max-w-lg flex-col border-l border-border bg-background text-foreground shadow-sm duration-200 outline-none data-open:animate-in data-open:slide-in-from-right data-closed:animate-out data-closed:slide-out-to-right *:min-w-0 [-webkit-app-region:no-drag]",
          className,
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close
            render={
              <Button
                variant="ghost"
                className="absolute top-2 right-2"
                size="icon-sm"
              />
            }
          >
            <XIcon />
            <span className="sr-only">关闭</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Popup>
    </SheetPortal>
  );
}

function SheetHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-header"
      className={cn("flex shrink-0 flex-col gap-1 border-b px-3 py-2 pr-10", className)}
      {...props}
    />
  );
}

function SheetTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return (
    <DialogPrimitive.Title
      data-slot="sheet-title"
      className={cn("truncate font-medium text-sm", className)}
      {...props}
    />
  );
}

function SheetDescription({
  className,
  ...props
}: DialogPrimitive.Description.Props) {
  return (
    <DialogPrimitive.Description
      data-slot="sheet-description"
      className={cn("truncate text-xs text-muted-foreground", className)}
      {...props}
    />
  );
}

function SheetBody({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-body"
      className={cn("min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-3 py-2", className)}
      {...props}
    />
  );
}

export {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetOverlay,
  SheetPortal,
  SheetTitle,
};
