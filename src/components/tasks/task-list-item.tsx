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
 *  - awaiting_user 且**真有事等你**（task 模式、action 等审阅 / ask 等答案）→ 琥珀色脉冲点
 *  - 其余（idle / error / chat 静息 / approve 后静息）→ 类型图标（对话气泡 / 任务清单）
 * （error 不特殊标：断线类 error 常见、标了反而噪声。）
 *
 * V0.11.x 收窄琥珀点（用户点名「黄点什么时候才会消失」）：V0.11 后 chat 每轮说完、
 * task 交卷等 ack 都停在 awaiting_user——老条件下侧栏几乎满屏常亮黄点、失去注意力信号价值。
 * 现在只有「需要你行动」才亮：等你审阅（awaiting_ack）或 agent 提问等答案（action 还 running）。
 * chat 静息（你一句我一句的正常状态）不亮。
 *
 * 2026-07-20 grok 化：可选重命名（双击标题 / 菜单）、置顶区上/下移。
 */

import Link from "next/link";
import { useCallback, useSyncExternalStore } from "react";
import {
  ChevronDown,
  ChevronUp,
  ListTodo,
  Loader2,
  MessageCircle,
  MoreHorizontal,
  Pencil,
  Pin,
  Trash2,
} from "lucide-react";

import { Tooltip } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { actionDisplayLabel, formatRelative } from "@/lib/task-display";
import { cn } from "@/lib/utils";
import { getTaskSeenAt } from "@/lib/view-memory";
import type { TaskSummary } from "@/lib/types";

/** 同页 markTaskSeen 后派发，驱动侧栏重读 localStorage（storage 事件只跨 tab） */
export const TASK_SEEN_EVENT = "flowship:task-seen";

const subscribeTaskSeen = (onStoreChange: () => void) => {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(TASK_SEEN_EVENT, onStoreChange);
  window.addEventListener("storage", onStoreChange);
  return () => {
    window.removeEventListener(TASK_SEEN_EVENT, onStoreChange);
    window.removeEventListener("storage", onStoreChange);
  };
};

/** 订阅已读时间戳：markTaskSeen 写 localStorage 后侧栏能立刻熄灭琥珀点 */
const useTaskSeenAt = (taskId: string): number => {
  const getSnapshot = useCallback(() => getTaskSeenAt(taskId), [taskId]);
  return useSyncExternalStore(subscribeTaskSeen, getSnapshot, () => 0);
};

// v1.0.x 监控行降噪（用户实测「有了那么多状态反而更杂乱」）：
// **只有活跃态才出第二行**——运行中 / 待确认 / 待回答；空闲 / 静息 / 失败一律单行只标题。
// 监控信号只对「正在发生事」的任务有价值、满屏「方案 · 空闲」是废话 + 多色噪音。
// error 也不标（跟行首指示同一原则：断线类 error 常见、老任务红字刷屏反而噪声；
// 真失败有系统通知 + 打开任务可见）。
const taskStageLine = (
  task: TaskSummary,
  seenAt: number,
): { stage: string; status: string; tone: "run" | "wait" } | null => {
  if (task.mode === "chat") return null;
  const stage = task.lastActionType
    ? actionDisplayLabel({ type: task.lastActionType }, "short")
    : "未开始";
  if (task.runStatus === "running") {
    return { stage, status: "运行中", tone: "run" };
  }
  if (task.runStatus === "awaiting_user") {
    // awaiting_ack = 交卷等审阅；running（此刻不在跑但 action 挂 running）= agent 提问等答
    if (task.lastActionStatus === "awaiting_ack") {
      // 已读即清（v1.1.x 用户拍板「点进去看过、状态就该清掉」）：交卷后打开过详情
      //（seenAt 晚于任务最后动静）→ 回归静息单行；再有新交卷 updatedAt 前移、重新亮
      if (seenAt >= task.updatedAt) return null;
      return { stage, status: "待确认", tone: "wait" };
    }
    // 待回答不做已读清除：AI 被阻塞在等答案、不答永远停——必须一直亮
    if (task.lastActionStatus === "running") {
      return { stage, status: "待回答", tone: "wait" };
    }
  }
  // 空闲 / 静息 / 失败：不出第二行
  return null;
};

const TONE_CLASS: Record<"run" | "wait", string> = {
  run: "text-primary",
  wait: "text-amber-600 dark:text-amber-500",
};

// 行首指示：runStatus 优先（运行 / 等你回复）、否则回退类型图标。
// 所有形态统一 size-3.5 占位、保证各行标题左缘对齐。
const LeadingIndicator = ({
  task,
  seenAt,
}: {
  task: TaskSummary;
  seenAt: number;
}) => {
  // AI 正在跑：转圈
  if (task.runStatus === "running") {
    return (
      <Loader2
        className="size-3.5 shrink-0 animate-spin text-muted-foreground"
        aria-label="AI 运行中"
      />
    );
  }
  // 真有事等你才亮琥珀点（task 模式限定、见文件头 V0.11.x 收窄说明）：
  // - awaiting_ack 且**未读**（v1.1.x：看过详情即清、跟监控行同判定）
  // - running + awaiting_user：agent 提问（ask 弹窗）等你答案（不做已读清除）
  const needsAttention =
    task.runStatus === "awaiting_user" &&
    task.mode !== "chat" &&
    ((task.lastActionStatus === "awaiting_ack" &&
      seenAt < task.updatedAt) ||
      task.lastActionStatus === "running");
  if (needsAttention) {
    return (
      <span
        className="flex size-3.5 shrink-0 items-center justify-center"
        aria-label="等待你处理"
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

/** 置顶区手动重排（按钮式、不引拖拽库） */
export type PinReorderControls = {
  onMoveUp: () => void;
  onMoveDown: () => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
};

interface TaskListItemProps {
  task: TaskSummary;
  active?: boolean;
  // 点击导航后回调（侧栏可借此做收起等；不传则纯跳转）
  onNavigate?: () => void;
  // 传则行尾 hover 出删除按钮（二次确认由调用方处理）
  onDelete?: (task: TaskSummary) => void;
  // 删除中禁用（防双击连发 / DELETE 等待窗口内再点）
  deleteDisabled?: boolean;
  // 传则行尾出置顶按钮（已置顶常显高亮、未置顶 hover 出；切换由调用方处理）
  onPin?: (task: TaskSummary) => void;
  // 侧栏重命名（双击标题 / 菜单「重命名」）；不传则无入口
  onRename?: (task: TaskSummary) => void;
  // 置顶区内上/下移；仅置顶组分发
  pinReorder?: PinReorderControls;
}

export const TaskListItem = ({
  task,
  active,
  onNavigate,
  onDelete,
  deleteDisabled,
  onPin,
  onRename,
  pinReorder,
}: TaskListItemProps) => {
  const hasMenu = !!onRename;
  const hasActions = !!(onPin || onDelete || hasMenu || pinReorder);
  // 订阅已读：打开详情 markTaskSeen 后本行立刻重算、熄灭琥珀点
  const seenAt = useTaskSeenAt(task.id);
  // v1.0：task 行的「阶段 · 状态」监控行（chat 行为 null）
  const stageLine = taskStageLine(task, seenAt);
  // 相对时间副行仅 chat 行（grok 化）；task 行保持工作台原样——静息单行只标题、不占空间
  const subtitle = task.mode === "chat" ? formatRelative(task.updatedAt) : null;

  // 行尾按钮数决定右 padding（避免标题被盖）
  const actionCount =
    (pinReorder ? 2 : 0) + (onPin ? 1 : 0) + (hasMenu ? 1 : 0) + (onDelete ? 1 : 0);
  const prClass =
    actionCount >= 5
      ? "pr-28"
      : actionCount >= 4
        ? "pr-24"
        : actionCount >= 3
          ? "pr-20"
          : hasActions
            ? "pr-14"
            : "pr-2";

  return (
    <div className="group/item relative">
      {/* 当前任务：左侧 2px 强调竖条（对标 Cursor / Linear 的 active 指示） */}
      {active && (
        <span className="absolute inset-y-1 left-0 z-10 w-0.5 rounded-full bg-primary" />
      )}
      <Link
        href={`/tasks/${task.id}`}
        onClick={onNavigate}
        onDoubleClick={(e) => {
          // 双击标题区重命名：仍会先导航一次，对话框叠在详情上可接受
          if (!onRename) return;
          e.preventDefault();
          onRename(task);
        }}
        className={cn(
          "flex min-w-0 items-start gap-2 rounded-md py-1.5 pl-3 text-sm no-underline transition-colors",
          prClass,
          active
            ? "bg-selected font-medium text-selected-foreground"
            : "text-foreground/75 hover:bg-muted/50 hover:text-foreground",
        )}
      >
        {/* 行首指示：runStatus（运行中 / 等你回复）优先、否则类型图标——顶对齐两行 */}
        <span className="mt-0.5">
          <LeadingIndicator task={task} seenAt={seenAt} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          {/* 标题 truncate + hover tooltip 补全完整标题（侧栏窄、长标题看不全） */}
          <Tooltip content={task.title}>
            <span className="min-w-0 truncate leading-tight">{task.title}</span>
          </Tooltip>
          {/* task 活跃态：阶段 · 状态；chat：相对时间；其余单行只标题 */}
          {stageLine ? (
            <span className="flex min-w-0 items-center gap-1 text-[11px] leading-none">
              <span className="min-w-0 truncate text-muted-foreground/70">
                {stageLine.stage}
              </span>
              <span className="text-muted-foreground/40">·</span>
              <span className={TONE_CLASS[stageLine.tone]}>{stageLine.status}</span>
            </span>
          ) : subtitle ? (
            <span className="min-w-0 truncate text-[11px] leading-none text-muted-foreground/70">
              {subtitle}
            </span>
          ) : null}
        </span>
      </Link>
      {hasActions && (
        <div className="absolute inset-y-0 right-1 my-auto flex h-6 items-center gap-0.5">
          {pinReorder && (
            <>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={pinReorder.onMoveUp}
                disabled={!pinReorder.canMoveUp}
                title="上移"
                aria-label={`上移 ${task.title}`}
                className="size-6 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover/item:opacity-100 focus-visible:opacity-100 disabled:opacity-30"
              >
                <ChevronUp className="size-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={pinReorder.onMoveDown}
                disabled={!pinReorder.canMoveDown}
                title="下移"
                aria-label={`下移 ${task.title}`}
                className="size-6 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover/item:opacity-100 focus-visible:opacity-100 disabled:opacity-30"
              >
                <ChevronDown className="size-3.5" />
              </Button>
            </>
          )}
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
          {hasMenu && (
            <DropdownMenu>
              <DropdownMenuTrigger
                title="更多"
                aria-label={`更多操作 ${task.title}`}
                className={cn(
                  "inline-flex size-6 items-center justify-center rounded-md text-muted-foreground outline-none transition-opacity",
                  "opacity-0 hover:bg-accent hover:text-foreground group-hover/item:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring",
                  "data-popup-open:opacity-100",
                )}
              >
                <MoreHorizontal className="size-3.5" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" side="bottom" className="min-w-28">
                <DropdownMenuItem
                  onClick={() => onRename?.(task)}
                  className="gap-2"
                >
                  <Pencil className="size-3.5" />
                  重命名
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {onDelete && (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => onDelete(task)}
              disabled={deleteDisabled}
              title="删除任务"
              aria-label={`删除任务 ${task.title}`}
              className="size-6 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover/item:opacity-100 focus-visible:opacity-100 disabled:opacity-50"
            >
              <Trash2 className="size-3.5" />
            </Button>
          )}
        </div>
      )}
    </div>
  );
};
