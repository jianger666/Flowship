"use client";

/** 右键菜单——Base UI ContextMenu 的项目样式封装。 */

import { ContextMenu as ContextMenuPrimitive } from "@base-ui/react/context-menu";

import { cn } from "@/lib/utils";

const ContextMenu = ContextMenuPrimitive.Root;
const ContextMenuTrigger = ContextMenuPrimitive.Trigger;

const ContextMenuContent = ({
  className,
  ...props
}: ContextMenuPrimitive.Popup.Props) => (
  <ContextMenuPrimitive.Portal>
    <ContextMenuPrimitive.Positioner className="isolate z-50">
      <ContextMenuPrimitive.Popup
        data-slot="context-menu-content"
        className={cn(
          "relative z-50 max-h-(--available-height) min-w-40 origin-(--transform-origin) overflow-y-auto rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 duration-100 outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
          className,
        )}
        {...props}
      />
    </ContextMenuPrimitive.Positioner>
  </ContextMenuPrimitive.Portal>
);

const itemClassName =
  "flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50";

const ContextMenuItem = ({
  className,
  ...props
}: ContextMenuPrimitive.Item.Props) => (
  <ContextMenuPrimitive.Item
    data-slot="context-menu-item"
    className={cn(itemClassName, className)}
    {...props}
  />
);

const ContextMenuLinkItem = ({
  className,
  ...props
}: ContextMenuPrimitive.LinkItem.Props) => (
  <ContextMenuPrimitive.LinkItem
    data-slot="context-menu-link-item"
    className={cn(itemClassName, className)}
    {...props}
  />
);

const ContextMenuSeparator = ({
  className,
  ...props
}: ContextMenuPrimitive.Separator.Props) => (
  <ContextMenuPrimitive.Separator
    className={cn("my-1 h-px bg-border", className)}
    {...props}
  />
);

export {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLinkItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
};
