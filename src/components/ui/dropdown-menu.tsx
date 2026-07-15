"use client";

/**
 * DropdownMenu——base-ui Menu 的薄封装（对齐 Popover / Select 的 Portal+Positioner+Popup 结构）。
 * 收件箱 bug 状态 chip 等「点开选一项」场景用。
 */

import { Menu as MenuPrimitive } from "@base-ui/react/menu";

import { cn } from "@/lib/utils";

const DropdownMenu = MenuPrimitive.Root;
const DropdownMenuTrigger = MenuPrimitive.Trigger;

const DropdownMenuContent = ({
  className,
  side = "bottom",
  sideOffset = 4,
  align = "end",
  alignOffset = 0,
  ...props
}: MenuPrimitive.Popup.Props &
  Pick<
    MenuPrimitive.Positioner.Props,
    "side" | "sideOffset" | "align" | "alignOffset"
  >) => (
  <MenuPrimitive.Portal>
    <MenuPrimitive.Positioner
      side={side}
      sideOffset={sideOffset}
      align={align}
      alignOffset={alignOffset}
      className="isolate z-50"
    >
      <MenuPrimitive.Popup
        data-slot="dropdown-menu-content"
        className={cn(
          "relative z-50 max-h-(--available-height) min-w-32 origin-(--transform-origin) overflow-y-auto rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 duration-100 outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
          className,
        )}
        {...props}
      />
    </MenuPrimitive.Positioner>
  </MenuPrimitive.Portal>
);

const DropdownMenuItem = ({
  className,
  ...props
}: MenuPrimitive.Item.Props) => (
  <MenuPrimitive.Item
    data-slot="dropdown-menu-item"
    className={cn(
      "flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none select-none",
      "data-highlighted:bg-accent data-highlighted:text-accent-foreground",
      "data-disabled:pointer-events-none data-disabled:opacity-50",
      className,
    )}
    {...props}
  />
);

export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
};
