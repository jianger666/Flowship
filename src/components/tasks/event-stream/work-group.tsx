"use client";

/**
 * 工作过程组折叠行（CHAT-REDESIGN Batch B）
 *
 * 把 turn 内正文之前的 thinking / 工具调用收成一行摘要；
 * running 自动展开、完成后自动收起；用户手动 toggle 后以手动为准。
 * error 事件**不**进组（2026-07-28）——自动收起会把用户正在读的错误吃掉、见 lib/chat-turns.ts。
 * 本文件只交付组件，Batch C 再接到 event-stream items 管线。
 */

import { memo, useRef, useState } from "react";
import { ChevronRight, Loader2, X } from "lucide-react";

import { useStreamFollowContext } from "@/hooks/use-stream-follow";
import type { WorkGroupItem } from "@/lib/chat-turns";
import { formatDurationCoarse } from "@/lib/duration-display";
import { shouldPinWorkGroupOpen } from "@/lib/scroll-follow";
import {
  isToolBlock,
  isToolVerbGroup,
  type StreamRenderItem,
} from "@/lib/tool-display";
import type { Task, TaskEvent } from "@/lib/types";
import { cn } from "@/lib/utils";

import { EventRow } from "./rows";
import { ToolBlockRow, ToolVerbGroupRow } from "./tool-block";

// ---------- 耗时 / 活动摘要 ----------

/** 组头耗时：口径（秒级密度、<1s 不显示）收在 lib/duration-display、跟事件流其它耗时同源 */
const formatGroupDuration = (startTs: number, endTs: number): string | null =>
  formatDurationCoarse(Math.max(0, endTs - startTs));

/**
 * 折叠且 running 时右侧活动摘要：从末尾找最近一个 running 工具名即可。
 * 不追 liveOutput、不拼复杂文案——组头要极淡不抢戏。
 */
const lastRunningName = (members: StreamRenderItem[]): string | null => {
  for (let i = members.length - 1; i >= 0; i--) {
    const m = members[i]!;
    if (isToolBlock(m) && m.status === "running") return m.name;
    if (isToolVerbGroup(m)) {
      for (let j = m.members.length - 1; j >= 0; j--) {
        const child = m.members[j]!;
        if (child.status === "running") return child.name;
      }
    }
  }
  return null;
};

// ---------- 成员渲染 ----------

const WorkGroupMember = ({
  member,
  taskId,
  task,
  variant,
  liveToolOutputs,
}: {
  member: StreamRenderItem;
  taskId: string;
  task: Task;
  /** 跟随宿主形态：chat 细行 / log 卡片行（task 模式也走分组、2026-07-21 用户拍板） */
  variant: "log" | "chat";
  liveToolOutputs?: Record<string, string>;
}) => {
  if (isToolBlock(member)) {
    return (
      <ToolBlockRow
        block={member}
        taskId={taskId}
        liveOutput={liveToolOutputs?.[member.callId]}
      />
    );
  }
  if (isToolVerbGroup(member)) {
    return <ToolVerbGroupRow group={member} taskId={taskId} />;
  }
  // thinking（assistant 插话 / error 都不进组、各自独立平铺）→ EventRow 细行分支
  return (
    <EventRow
      ev={member as TaskEvent}
      taskId={taskId}
      task={task}
      variant={variant}
    />
  );
};

// ---------- 组头 chevron（与 ToolBlockRow 同款旋转） ----------

const CollapseChevron = ({ open }: { open: boolean }) => (
  <ChevronRight
    className={cn(
      "size-3 shrink-0 opacity-50 transition-transform duration-150",
      open && "rotate-90",
    )}
  />
);

// ---------- WorkGroupRow ----------

const WorkGroupRowImpl = ({
  group,
  taskId,
  task,
  variant = "chat",
  liveToolOutputs,
  isRunningTail,
}: {
  group: WorkGroupItem;
  taskId: string;
  task: Task;
  /** 宿主形态（成员 EventRow 渲染跟随；组头样式两形态同款） */
  variant?: "log" | "chat";
  /** callId → 直播输出（透传给成员 ToolBlockRow） */
  liveToolOutputs?: Record<string, string>;
  /** 本组是全流最后一个组且 agent 正在 running（展开判定用） */
  isRunningTail?: boolean;
}) => {
  // null = 未手动干预，跟随 autoExpanded；boolean = 用户点过，以手动为准
  const [manual, setManual] = useState<boolean | null>(null);

  const autoExpanded = group.hasRunning || !!isRunningTail;

  // 自动收起的「防打扰」闸（2026-07-28、用户实测「自动折叠也感觉怪」）：
  // 判定见 shouldPinWorkGroupOpen（纯函数、可单测）。
  // 用渲染期 latch 而不是 useEffect：effect 跑在 commit 之后，会先闪一帧折叠再弹回来。
  const followCtl = useStreamFollowContext();
  const prevAutoExpandedRef = useRef(autoExpanded);
  const stickyOpenRef = useRef(false);
  if (
    shouldPinWorkGroupOpen(
      prevAutoExpandedRef.current,
      autoExpanded,
      // 拿不到控制器（组件被单独复用）时按「跟随中」算、维持原自动收起行为
      followCtl ? followCtl.isFollowing() : true,
    )
  ) {
    stickyOpenRef.current = true;
  }
  prevAutoExpandedRef.current = autoExpanded;
  // 用户手动点过就完全以他为准（含手动收起被钉住的组）
  const expanded = manual ?? (autoExpanded || stickyOpenRef.current);

  const runningTail =
    !expanded && group.hasRunning ? lastRunningName(group.members) : null;

  return (
    <div className="min-w-0">
      <button
        type="button"
        onClick={() => setManual(!expanded)}
        className="flex h-7 w-full cursor-pointer items-center gap-1.5 rounded px-1 text-left text-[11px] text-muted-foreground/70 transition-colors hover:bg-muted/30 hover:text-muted-foreground"
      >
        <CollapseChevron open={expanded} />
        <span className="shrink-0">工作过程</span>
        <span className="shrink-0 tabular-nums">· {group.stepCount} 步</span>
        {group.hasRunning ? (
          <Loader2 className="size-3 shrink-0 animate-spin text-info" />
        ) : (
          // 同秒完成（<1s）不显示「0s」——空字符串时整段不渲染
          formatGroupDuration(group.startTs, group.endTs) && (
            <span className="shrink-0 tabular-nums">
              · {formatGroupDuration(group.startTs, group.endTs)}
            </span>
          )
        )}
        {group.hasError && (
          <X
            className="size-3 shrink-0 text-destructive"
            aria-label="含错误"
          />
        )}
        {runningTail && (
          <span className="min-w-0 flex-1 truncate font-mono opacity-80">
            {runningTail}
          </span>
        )}
      </button>

      {expanded && (
        <div className="ml-2 mt-0.5 space-y-0.5 border-l border-border/40 pl-2.5">
          {group.members.map((m) => (
            <WorkGroupMember
              key={m.id}
              member={m}
              taskId={taskId}
              task={task}
              variant={variant}
              liveToolOutputs={liveToolOutputs}
            />
          ))}
        </div>
      )}
    </div>
  );
};

export const WorkGroupRow = memo(WorkGroupRowImpl);
