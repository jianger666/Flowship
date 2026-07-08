"use client";

/**
 * 侧栏 / 欢迎页共用的「任务行」（V0.8 侧栏导航）
 *
 * 精简一行：行首指示 + 标题（truncate + hover tooltip 补全）。
 * 当前任务高亮（左侧强调竖条 + 底色）。行尾 hover 出「置顶 / 删除」操作；
 * 已置顶时置顶按钮常显高亮（既是状态标记、又是取消入口）。
 *
 * 行首指示按 runStatus 三态切换（复用同一个槽位、不回到「满屏色点」）：
 *  - running       → 转圈（多任务并行时一眼看出哪个 AI 在跑）
 *  - awaiting_user → 琥珀色脉冲点（哪个在等我回复）
 *  - idle / error  → 类型图标（对话气泡 / 任务清单）
 * （error 不特殊标：断线类 error 常见、标了反而噪声。）
 */

import Link from "next/link";
import { ListTodo, Loader2, MessageCircle, Pin, Trash2 } from "lucide-react";

import { Tooltip } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { TaskSummary } from "@/lib/types";

// 行首指示：runStatus 优先（运行 / 等你回复）、否则回退类型图标。
// 所有形态统一 size-3.5 占位、保证各行标题左缘对齐。
const LeadingIndicator = ({ task }: { task: TaskSummary }) => {
  // AI 正在跑：转圈
  if (task.runStatus === "running") {
    return (
      <Loader2
        className="size-3.5 shrink-0 animate-spin text-muted-foreground"
        aria-label="AI 运行中"
      />
    );
  }
  // 跑完等你 ack / 回复：琥珀脉冲点（注意力信号、跟运行中区分开）
  if (task.runStatus === "awaiting_user") {
    return (
      <span
        className="flex size-3.5 shrink-0 items-center justify-center"
        aria-label="等待你回复"
      >
        <span className="size-2 animate-pulse rounded-full bg-amber-500" />
      </span>
    );
  }
  // 空闲 / 失败：类型图标（对话 = 气泡、任务 = 清单）
  const Icon = task.mode === "chat" ? MessageCircle : ListTodo;
  return (
    <Icon className="size-3.5 shrink-0 text-muted-foreground/60" aria-hidden />
  );
};

interface TaskListItemProps {
  task: TaskSummary;
  active?: boolean;
  // 点击导航后回调（侧栏可借此做收起等；不传则纯跳转）
  onNavigate?: () => void;
  // 传则行尾 hover 出删除按钮（二次确认由调用方处理）
  onDelete?: (task: TaskSummary) => void;
  // 传则行尾出置顶按钮（已置顶常显高亮、未置顶 hover 出；切换由调用方处理）
  onPin?: (task: TaskSummary) => void;
}

export const TaskListItem = ({
  task,
  active,
  onNavigate,
  onDelete,
  onPin,
}: TaskListItemProps) => {
  const hasActions = !!(onPin || onDelete);
  return (
    <div className="group/item relative">
      {/* 当前任务：左侧 2px 强调竖条（对标 Cursor / Linear 的 active 指示） */}
      {active && (
        <span className="absolute inset-y-1 left-0 z-10 w-0.5 rounded-full bg-primary" />
      )}
      <Link
        href={`/tasks/${task.id}`}
        onClick={onNavigate}
        className={cn(
          "flex min-w-0 items-center gap-2 rounded-md py-1.5 pl-3 text-sm no-underline transition-colors",
          // 有操作按钮时给行尾留白、避免标题被盖
          hasActions ? "pr-14" : "pr-2",
          active
            ? "bg-muted font-medium text-foreground"
            : "text-foreground/75 hover:bg-muted/50 hover:text-foreground",
        )}
      >
        {/* 行首指示：runStatus（运行中 / 等你回复）优先、否则类型图标——所有行左缘对齐 */}
        <LeadingIndicator task={task} />
        {/* 标题 truncate + hover tooltip 补全完整标题（侧栏窄、长标题看不全） */}
        <Tooltip content={task.title}>
          <span className="min-w-0 flex-1 truncate">{task.title}</span>
        </Tooltip>
      </Link>
      {hasActions && (
        <div className="absolute inset-y-0 right-1 my-auto flex h-6 items-center gap-0.5">
          {onPin && (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => onPin(task)}
              title={task.pinned ? "取消置顶" : "置顶"}
              aria-label={
                task.pinned ? `取消置顶 ${task.title}` : `置顶 ${task.title}`
              }
              className={cn(
                "size-6 transition-opacity",
                task.pinned
                  ? "text-primary opacity-100"
                  : "text-muted-foreground opacity-0 hover:text-foreground group-hover/item:opacity-100 focus-visible:opacity-100",
              )}
            >
              <Pin className={cn("size-3.5", task.pinned && "fill-current")} />
            </Button>
          )}
          {onDelete && (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => onDelete(task)}
              title="删除任务"
              aria-label={`删除任务 ${task.title}`}
              className="size-6 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover/item:opacity-100 focus-visible:opacity-100"
            >
              <Trash2 className="size-3.5" />
            </Button>
          )}
        </div>
      )}
    </div>
  );
};
