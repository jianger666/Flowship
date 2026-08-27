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
 * Checkbox 只负责展示，并通过 pointer-events-none 让小方块区域的点击
 * 直接落到行上。不要依赖 base-ui 内部的 onCheckedChange / onClick：
 * 它在部分 Electron/base-ui 组合下会吞掉小方块的指针事件，就会出现
 * 「文字能勾、小方块没反应」。Checkbox tabIndex=-1，键盘焦点统一走本行
 * （role=button）。以后别再拷「label 包 Checkbox」期望整行可选中。
 */

import type { KeyboardEvent, ReactNode } from "react";

import { Checkbox } from "@/components/ui/checkbox";
import { useFormDisabled } from "@/components/ui/form-context";
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
  const locked = disabled || useFormDisabled();
  // 行点击 / 行键盘：直接切受控态（disabled 短路）
  const toggle = () => {
    if (locked) return;
    onCheckedChange(!checked);
  };

  const onRowKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (locked) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggle();
    }
  };

  return (
    <div
      role="button"
      tabIndex={locked ? -1 : 0}
      aria-pressed={checked}
      aria-disabled={locked || undefined}
      className={cn(
        "flex items-center gap-2",
        locked ? "cursor-not-allowed opacity-60" : "cursor-pointer",
        // 行焦点环（内部 Checkbox 已 tabIndex=-1）
        "rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
        className,
      )}
      onClick={toggle}
      onKeyDown={onRowKeyDown}
    >
      <Checkbox
        id={checkboxId}
        className={cn("pointer-events-none", checkboxClassName)}
        checked={checked}
        disabled={locked}
        tabIndex={-1}
        // CheckboxRow 是唯一状态入口；base-ui 内部 change 不再重复改受控态。
        onCheckedChange={() => {}}
      />
      {children}
    </div>
  );
};
