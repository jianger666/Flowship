"use client";

/**
 * Checkbox（勾选框）—— shadcn base-nova 风格、底层用 @base-ui/react/checkbox
 *
 * 对外接口：
 *   - checked / onCheckedChange：受控 boolean
 *   - indeterminate：部分选中态（「全选」父勾选框用、显示横杠）
 *   - disabled：禁用态
 */

import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox";
import { CheckIcon, MinusIcon } from "lucide-react";

import { cn } from "@/lib/utils";

interface CheckboxProps {
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  indeterminate?: boolean;
  disabled?: boolean;
  className?: string;
  id?: string;
}

export const Checkbox = ({
  checked,
  onCheckedChange,
  indeterminate,
  disabled,
  className,
  id,
}: CheckboxProps) => {
  return (
    <CheckboxPrimitive.Root
      id={id}
      checked={checked}
      onCheckedChange={onCheckedChange}
      indeterminate={indeterminate}
      disabled={disabled}
      className={cn(
        "peer flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-input shadow-xs transition-colors outline-none",
        "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
        "disabled:cursor-not-allowed disabled:opacity-50",
        checked || indeterminate
          ? "border-primary bg-primary text-primary-foreground"
          : "bg-background",
        className,
      )}
    >
      <CheckboxPrimitive.Indicator
        className="flex items-center justify-center text-current"
        // indeterminate 态 base-ui 也会渲染 Indicator、keepMounted 不需要
      >
        {indeterminate ? (
          <MinusIcon className="size-3" />
        ) : (
          <CheckIcon className="size-3" />
        )}
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
};
