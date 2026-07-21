"use client";

/**
 * 工作过程组折叠行（CHAT-REDESIGN Batch B）
 *
 * 把 turn 内正文之前的 thinking / 工具 / 旁白 / error 收成一行摘要；
 * running 自动展开、完成后自动收起；用户手动 toggle 后以手动为准。
 * 本文件只交付组件，Batch C 再接到 event-stream items 管线。
 */

import { memo, useState } from "react";
import { ChevronRight, Loader2, X } from "lucide-react";

import { MarkdownText } from "@/components/markdown-text";
import type { WorkGroupItem } from "@/lib/chat-turns";
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

/** 组头耗时：秒级密度（`12s` / `2m14s`）；同秒完成（<1s）返回空、组头不显示 0s */
const formatGroupDuration = (startTs: number, endTs: number): string => {
  const ms = Math.max(0, endTs - startTs);
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 1) return "";
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}m${s}s`;
};

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
  liveToolOutputs,
}: {
  member: StreamRenderItem;
  taskId: string;
  task: Task;
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
  // 组内旁白：不用 EventRow（会全权重平铺抢戏）——降权 markdown
  if (member.kind === "assistant_message") {
    const ev = member as TaskEvent;
    return (
      <div className="px-1 text-[13px] leading-relaxed text-muted-foreground">
        <MarkdownText text={ev.text} />
      </div>
    );
  }
  // thinking / error / 其它 TaskEvent → EventRow chat 细行分支
  return (
    <EventRow
      ev={member as TaskEvent}
      taskId={taskId}
      task={task}
      variant="chat"
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
  liveToolOutputs,
  isRunningTail,
}: {
  group: WorkGroupItem;
  taskId: string;
  task: Task;
  /** callId → 直播输出（透传给成员 ToolBlockRow） */
  liveToolOutputs?: Record<string, string>;
  /** 本组是全流最后一个组且 agent 正在 running（展开判定用） */
  isRunningTail?: boolean;
}) => {
  // null = 未手动干预，跟随 autoExpanded；boolean = 用户点过，以手动为准
  const [manual, setManual] = useState<boolean | null>(null);

  const autoExpanded = group.hasRunning || !!isRunningTail;
  const expanded = manual ?? autoExpanded;

  const runningTail =
    !expanded && group.hasRunning ? lastRunningName(group.members) : null;

  return (
    <div className="min-w-0">
      <button
        type="button"
        onClick={() => setManual(!(manual ?? autoExpanded))}
        className="flex h-7 w-full cursor-pointer items-center gap-1.5 rounded px-1 text-left text-[11px] text-muted-foreground/70 transition-colors hover:bg-muted/30 hover:text-muted-foreground"
      >
        <CollapseChevron open={expanded} />
        <span className="shrink-0">工作过程</span>
        <span className="shrink-0 tabular-nums">· {group.stepCount} 步</span>
        {group.hasRunning ? (
          <Loader2 className="size-3 shrink-0 animate-spin opacity-70" />
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
              liveToolOutputs={liveToolOutputs}
            />
          ))}
        </div>
      )}
    </div>
  );
};

export const WorkGroupRow = memo(WorkGroupRowImpl);
