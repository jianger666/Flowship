"use client";

/**
 * 整行可点的 Checkbox 行容器。
 *
 * ⚠️ 坑（已 CDP 实锤）：本仓 Checkbox 基于 @base-ui/react，渲染为
 * `<span role="checkbox">`、**不是**原生 `<input type="checkbox">`。
 * HTML `<label>` / `htmlFor` 的点击联动只对原生 labelable 控件生效——
 * 用 label 包 Checkbox 再点行文字/空白区，勾选状态不会变，体感就是「没反应」。
 *
 * 正确做法：受控状态 + 行上显式 onClick / Enter / Space 切换；
 * Checkbox 自身 onCheckedChange 保留，但点击时 stopPropagation，
 * 避免与行 onClick 双触发互相抵消；内部 Checkbox tabIndex=-1，
 * 键盘焦点统一走本行（role=button），避免嵌套双焦点。
 * 以后别再拷「label 包 Checkbox」期望整行可选中。
 */

import type { KeyboardEvent, MouseEvent, ReactNode } from "react";

import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";

type Props = {
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  disabled?: boolean;
  className?: string;
  /** 传给内部 Checkbox 的额外 class（如 mt-0.5） */
  checkboxClassName?: string;
  /** 透传给 Checkbox（如 confirm dialog 的 id） */
  checkboxId?: string;
  children: ReactNode;
};

export const CheckboxRow = ({
  checked,
  onCheckedChange,
  disabled = false,
  className,
  checkboxClassName,
  checkboxId,
  children,
}: Props) => {
  // 行点击 / 行键盘：直接切受控态（disabled 短路）
  const toggle = () => {
    if (disabled) return;
    onCheckedChange(!checked);
  };

  const onRowKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggle();
    }
  };

  return (
    <div
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-pressed={checked}
      aria-disabled={disabled || undefined}
      className={cn(
        "flex items-center gap-2",
        disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer",
        // 行焦点环（内部 Checkbox 已 tabIndex=-1）
        "rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
        className,
      )}
      onClick={toggle}
      onKeyDown={onRowKeyDown}
    >
      <Checkbox
        id={checkboxId}
        className={checkboxClassName}
        checked={checked}
        disabled={disabled}
        tabIndex={-1}
        onCheckedChange={onCheckedChange}
        // 点小方块时别冒泡到行，否则 onCheckedChange + 行 toggle 双触发抵消
        onClick={(e: MouseEvent<HTMLElement>) => e.stopPropagation()}
      />
      {children}
    </div>
  );
};
