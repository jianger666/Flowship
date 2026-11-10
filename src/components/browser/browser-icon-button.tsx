"use client";

/**
 * 浏览器面板里的纯图标按钮（V4 新增组件共用）：Tooltip 朝上 + aria-label。
 * 工具栏 / 查找条都在视口上方：气泡朝下会落进视口里（原生视图盖在 HTML 之上，会触发整块遮盖），所以一律朝上。
 */
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";

export const BrowserIconButton = ({
  label,
  onClick,
  disabled,
  size = "icon-xs",
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  size?: "icon-xs" | "icon-sm";
  children: ReactNode;
}) => (
  <Tooltip content={label} side="top">
    <Button
      type="button"
      variant="ghost"
      size={size}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="shrink-0"
    >
      {children}
    </Button>
  </Tooltip>
);
