"use client";

/**
 * 一条定时的展示行（会话内定时条的弹层 / 定时任务管理页共用，视觉只此一份）。
 *
 * 版式：左边小圆点（状态色，只落在点上、文字保持中性）+ 标题 + 副标题（类型 · 时间 · 计数）；
 * 右边操作按钮组。标题悬停可看「到点要对 AI 说的话」全文——用户一眼看出这条定时到底会让 AI 干什么。
 */

import type { ReactNode } from "react";

import { ScheduleActions } from "@/components/schedules/schedule-actions";
import { Tooltip } from "@/components/ui/tooltip";
import {
  describeSchedulePlan,
  describeScheduleTiming,
  SCHEDULE_STATUS_LABEL,
  type ScheduleRecord,
  type ScheduleStatus,
} from "@/lib/schedule";
import { cn } from "@/lib/utils";

/** 状态点颜色：进行中 info（全站「运行中」同色）；已暂停 / 已结束中性；错过 warning（要用户注意） */
const DOT_CLASS: Record<ScheduleStatus, string> = {
  active: "bg-info",
  paused: "bg-muted-foreground/60",
  done: "bg-muted-foreground/60",
  cancelled: "bg-muted-foreground/60",
  missed: "bg-warning",
};

export const ScheduleRow = ({
  record,
  now,
  onChanged,
  footer,
  className,
}: {
  record: ScheduleRecord;
  now: number;
  onChanged: () => void | Promise<void>;
  /** 副标题下方的额外一行（管理页放所属会话） */
  footer?: ReactNode;
  className?: string;
}) => {
  const finished = record.status === "done" || record.status === "cancelled";
  return (
    <div className={cn("flex items-start gap-2 px-1.5 py-1.5 text-xs", className)}>
      {/* 状态点：hover 提示走 Tooltip（规范「Hover 提示」：不用原生 title）；
          点本身只有颜色、读屏靠 role=img + aria-label */}
      <Tooltip content={SCHEDULE_STATUS_LABEL[record.status]}>
        <span
          role="img"
          className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", DOT_CLASS[record.status])}
          aria-label={SCHEDULE_STATUS_LABEL[record.status]}
        />
      </Tooltip>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <Tooltip
            content={
              <span className="line-clamp-8 block max-w-72 whitespace-pre-wrap break-words">
                {record.message}
              </span>
            }
          >
            <span
              className={cn(
                "min-w-0 flex-1 truncate font-medium",
                finished ? "text-muted-foreground" : "text-foreground",
              )}
            >
              {record.title}
            </span>
          </Tooltip>
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[11px] text-muted-foreground">
          <span>{describeSchedulePlan(record)}</span>
          <span aria-hidden>·</span>
          <span className="tabular-nums">{describeScheduleTiming(record, now)}</span>
        </div>
        {record.endNote && (record.status === "missed" || record.status === "cancelled") ? (
          <div className="mt-0.5 text-[11px] text-muted-foreground">{record.endNote}</div>
        ) : null}
        {footer}
      </div>
      <ScheduleActions record={record} onChanged={onChanged} />
    </div>
  );
};
