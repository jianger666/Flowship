"use client";

/**
 * 代码改动面板的共享小件：状态徽标、增删统计、键帽、带 Tooltip 的图标按钮、复制按钮、文案常量。
 * 拆出来是因为文件列表、diff 头部、工具条都要用同一份，各写一份必然漂移。
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import type { TaskChangeStatus, TaskRepoChangesUnavailable } from "@/lib/types";
import { cn } from "@/lib/utils";

export const STATUS_META: Record<TaskChangeStatus, { letter: string; label: string; cls: string }> = {
  added: { letter: "A", label: "新增", cls: "bg-success/15 text-success" },
  modified: { letter: "M", label: "修改", cls: "bg-warning/15 text-warning" },
  deleted: { letter: "D", label: "删除", cls: "bg-destructive/15 text-destructive" },
  renamed: { letter: "R", label: "重命名", cls: "bg-info/15 text-info" },
};

export const UNAVAILABLE_TEXT: Record<TaskRepoChangesUnavailable, string> = {
  dir_missing: "工作区目录不存在（任务还没启动，或工作区已清理）",
  not_git: "该目录不是 git 仓库",
  no_head: "仓库还没有任何提交",
  git_error: "读取改动失败",
  scope_invalid: "所选提交已不在这个仓的当前分支上（可能切了分支或提交被改写），请换一个范围",
};

export const StatusBadge = ({ status }: { status: TaskChangeStatus }) => {
  const meta = STATUS_META[status];
  return (
    <Tooltip content={meta.label}>
      <span
        className={cn(
          "inline-flex size-4 shrink-0 items-center justify-center rounded-sm font-mono text-[11px] leading-none font-medium",
          meta.cls,
        )}
      >
        {meta.letter}
      </span>
    </Tooltip>
  );
};

export const LineStat = ({
  added,
  removed,
  className,
}: {
  added: number | null;
  removed: number | null;
  className?: string;
}) => {
  // 二进制 / 过大未统计：没有数字可显示
  if (added == null && removed == null) return null;
  return (
    <span className={cn("shrink-0 tabular-nums", className)}>
      {added != null && added > 0 && <span className="text-success">+{added}</span>}
      {removed != null && removed > 0 && (
        <span className={cn("text-destructive", added ? "ml-1" : "")}>−{removed}</span>
      )}
    </span>
  );
};

/** 键帽 */
export const Kbd = ({ children }: { children: ReactNode }) => (
  <kbd className="inline-flex min-w-4 items-center justify-center rounded border border-border bg-muted px-1 font-mono text-[11px] leading-4 text-muted-foreground">
    {children}
  </kbd>
);

/** 工具条图标按钮：Tooltip 里带快捷键提示；active = 开关态 */
export const ToolbarButton = ({
  label,
  hotkey,
  active,
  disabled,
  onClick,
  className,
  children,
}: {
  label: string;
  hotkey?: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  className?: string;
  children: ReactNode;
}) => (
  <Tooltip
    content={
      <span className="flex items-center gap-1.5">
        {label}
        {hotkey && <Kbd>{hotkey}</Kbd>}
      </span>
    }
  >
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={cn(active && "bg-muted text-foreground", className)}
    >
      {children}
    </Button>
  </Tooltip>
);

const COPIED_FEEDBACK_MS = 1800;

/** 复制图标按钮：点完图标切勾 */
export const CopyIconButton = ({
  text,
  label,
  className,
}: {
  /** 字符串，或点击时才求值的函数（大文本不必每次 render 都拼） */
  text: string | (() => string);
  label: string;
  className?: string;
}) => {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timerRef.current), []);

  const handleClick = async () => {
    try {
      await navigator.clipboard.writeText(typeof text === "string" ? text : text());
      setCopied(true);
      window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
    } catch {
      toast.error("复制失败");
    }
  };

  return (
    <Tooltip content={copied ? "已复制" : label}>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={label}
        onClick={() => void handleClick()}
        className={className}
      >
        {copied ? <Check className="text-success" /> : <Copy />}
      </Button>
    </Tooltip>
  );
};
