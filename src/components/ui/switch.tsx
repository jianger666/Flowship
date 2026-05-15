"use client";

/**
 * Switch（开关）—— shadcn base-nova 风格、底层用 @base-ui/react/switch
 *
 * 对外接口：
 *   - checked / onCheckedChange：受控 boolean
 *   - disabled：禁用态
 *
 * 视觉：
 *   - 关：bg-input；开：bg-primary
 *   - thumb 用 absolute + transform 平移、跟 shadcn radix 版本对齐
 */

import { Switch as SwitchPrimitive } from "@base-ui/react/switch";

import { cn } from "@/lib/utils";

interface SwitchProps {
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  disabled?: boolean;
  className?: string;
  id?: string;
}

export const Switch = ({
  checked,
  onCheckedChange,
  disabled,
  className,
  id,
}: SwitchProps) => {
  return (
    <SwitchPrimitive.Root
      id={id}
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      className={cn(
        "peer relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors",
        "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-none",
        "disabled:cursor-not-allowed disabled:opacity-50",
        checked ? "bg-primary" : "bg-input",
        className,
      )}
    >
      <SwitchPrimitive.Thumb
        className={cn(
          "pointer-events-none block size-4 rounded-full bg-background shadow-md ring-0 transition-transform",
          checked ? "translate-x-4" : "translate-x-0",
        )}
      />
    </SwitchPrimitive.Root>
  );
};
