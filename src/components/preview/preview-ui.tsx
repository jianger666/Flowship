"use client";

/**
 * 文件预览各 viewer 共用的小件：工具栏容器 / 图标按钮 / 分段页签 / 查找条 / 复制
 *
 * 约定同站内其它面板：hover 提示一律 Tooltip（不用原生 title=）、文字最小 11px、颜色只走语义 token。
 */

import { useCallback, type ReactNode, type RefObject } from "react";
import { ArrowDown, ArrowUp, CaseSensitive, X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip } from "@/components/ui/tooltip";
import { isImeComposing } from "@/lib/ime";
import { cn } from "@/lib/utils";

/** 查看器顶部的一条工具栏（左：信息；右：动作） */
export const PreviewToolbar = ({
  left,
  right,
  className,
}: {
  left?: ReactNode;
  right?: ReactNode;
  className?: string;
}) => (
  <div
    className={cn(
      "flex min-h-9 shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-border/70 bg-muted/20 px-3 py-1",
      className,
    )}
  >
    <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-muted-foreground">
      {left}
    </div>
    <div className="flex shrink-0 flex-wrap items-center gap-1">{right}</div>
  </div>
);

export const ToolButton = ({
  label,
  shortcut,
  onClick,
  active,
  disabled,
  children,
  className,
}: {
  label: string;
  shortcut?: string;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  children: ReactNode;
  className?: string;
}) => (
  <Tooltip content={shortcut ? `${label}（${shortcut}）` : label}>
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={cn("text-muted-foreground", active && "bg-muted text-foreground", className)}
    >
      {children}
    </Button>
  </Tooltip>
);

/** 带文字的小按钮（保存 / 放弃 / 编辑 …） */
export const TextButton = ({
  onClick,
  disabled,
  variant = "ghost",
  children,
  className,
}: {
  onClick: () => void;
  disabled?: boolean;
  variant?: "ghost" | "default" | "outline" | "destructive";
  children: ReactNode;
  className?: string;
}) => (
  <Button
    type="button"
    variant={variant}
    size="xs"
    disabled={disabled}
    onClick={onClick}
    className={cn("h-6 gap-1 px-2", variant === "ghost" && "text-muted-foreground", className)}
  >
    {children}
  </Button>
);

/** 分段页签（预览 / 源码；表格 / 源码 …） */
export const SegmentedTabs = <T extends string>({
  tabs,
  value,
  onChange,
}: {
  tabs: { id: T; label: string; icon?: ReactNode }[];
  value: T;
  onChange: (id: T) => void;
}) => (
  <div role="tablist" className="inline-flex items-center rounded-md border border-border/70 bg-background p-0.5">
    {tabs.map((t) => (
      <button
        key={t.id}
        type="button"
        role="tab"
        aria-selected={t.id === value}
        onClick={() => onChange(t.id)}
        className={cn(
          "inline-flex h-6 items-center gap-1 rounded-sm px-2 text-xs transition-colors",
          t.id === value
            ? "bg-muted font-medium text-foreground"
            : "text-muted-foreground hover:text-foreground",
        )}
      >
        {t.icon}
        {t.label}
      </button>
    ))}
  </div>
);

export interface FindBarProps {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  inputRef?: RefObject<HTMLInputElement | null>;
  /** 命中位置（1 起）与总数；total 为 null 表示不显示计数 */
  current?: number;
  total?: number | null;
  capped?: boolean;
  caseSensitive?: boolean;
  onToggleCase?: () => void;
  onNext: () => void;
  onPrev: () => void;
  onClose: () => void;
  /** 计数位置的替代文案（如「回车跳到第 12 行」） */
  hint?: string;
}

export const FindBar = ({
  value,
  onChange,
  placeholder,
  inputRef,
  current = 0,
  total = null,
  capped,
  caseSensitive,
  onToggleCase,
  onNext,
  onPrev,
  onClose,
  hint,
}: FindBarProps) => (
  <div className="flex shrink-0 items-center gap-1.5 border-b border-border/70 bg-background px-3 py-1.5">
    <Input
      ref={inputRef}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (isImeComposing(e)) return;
        if (e.key === "Enter") {
          e.preventDefault();
          if (e.shiftKey) onPrev();
          else onNext();
        } else if (e.key === "Escape") {
          // 只关查找条：别冒泡成「关预览窗」
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }
      }}
      className="h-7 w-64 max-w-full text-xs md:text-xs"
      aria-label="查找"
    />
    {onToggleCase && (
      <ToolButton label="区分大小写" onClick={onToggleCase} active={caseSensitive}>
        <CaseSensitive />
      </ToolButton>
    )}
    <span className="min-w-14 text-xs tabular-nums text-muted-foreground">
      {hint ??
        (total === null || !value
          ? ""
          : total === 0
            ? "无结果"
            : `${current} / ${total}${capped ? "+" : ""}`)}
    </span>
    <ToolButton label="上一个" shortcut="Shift+Enter" onClick={onPrev} disabled={!total}>
      <ArrowUp />
    </ToolButton>
    <ToolButton label="下一个" shortcut="Enter" onClick={onNext} disabled={!total}>
      <ArrowDown />
    </ToolButton>
    <ToolButton label="关闭查找" shortcut="Esc" onClick={onClose}>
      <X />
    </ToolButton>
  </div>
);

/** 复制文本到剪贴板，成功 / 失败都给提示 */
export const useCopyText = (): ((text: string, what?: string) => Promise<void>) =>
  useCallback(async (text: string, what = "内容") => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`已复制${what}`);
    } catch {
      toast.error("复制失败");
    }
  }, []);

/** 简短的分隔点 */
export const Dot = () => <span aria-hidden className="text-border">·</span>;
