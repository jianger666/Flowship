"use client";

/**
 * 会话内「定时」条（输入框上方）
 *
 * AI 用 `schedule` 工具给自己设了定时之后，会话看上去和平时没两样——用户完全不知道「过一会儿它会自己
 * 醒来干活」。这一条就是把已有的定时亮出来：有进行中的 / 暂停的 / 错过没处理的就挂在输入框上方，
 * 一个都没有时收起。点开是这个会话的全部定时，可以立即触发 / 暂停 / 取消；底部直达「定时任务」管理页。
 *
 * 版式对齐 `BackgroundSubagentsBar`（同一排的兄弟）：白卡 + 边、静止（不加新动效）、
 * 颜色只落在图标 / 状态点上，文字保持中性；出没走 `Collapse`（高度过渡）。
 * chat 挂在 EventStream 的输入岛上方；task 挂在底部「跟 AI 说」输入条上方。
 */

import { memo, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AlarmClock, ChevronRight } from "lucide-react";

import { ScheduleRow } from "@/components/schedules/schedule-row";
import { Collapse } from "@/components/tasks/event-stream/collapse";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useTaskSchedules } from "@/hooks/use-task-schedules";
import {
  chipText,
  isFinishedStatus,
  scheduleEventSignal,
  summarizeSchedules,
  type ScheduleRecord,
} from "@/lib/schedule";
import { cn } from "@/lib/utils";

/** 「现在」刷新间隔：条上显示的是「下次 14:30」这类分钟级文案，30 秒足够 */
const NOW_TICK_MS = 30_000;
/** 弹层里「最近结束」最多列几条（更早的去管理页看） */
const RECENT_FINISHED_MAX = 3;

/** `active=false`（这个会话一条定时都没有）时不起定时器：绝大多数会话没有定时，不该每 30 秒白白重渲一次 */
const useNow = (active: boolean): number => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), NOW_TICK_MS);
    return () => window.clearInterval(id);
  }, [active]);
  return now;
};

const BAR_CLASS =
  "flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-lg border border-border bg-card px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-muted/50";

const ChipBody = ({
  label,
  hasLive,
  hasMissed,
  schedules,
  now,
  onChanged,
  inset,
}: {
  label: string;
  hasLive: boolean;
  hasMissed: boolean;
  schedules: readonly ScheduleRecord[];
  now: number;
  onChanged: () => void;
  inset: boolean;
}) => {
  // 「是否展开」放在这个子组件里：条收起（Collapse 卸载）时状态跟着丢，下次出现不会自己弹开
  const [open, setOpen] = useState(false);
  const ongoing = schedules.filter((r) => !isFinishedStatus(r.status) || r.status === "missed");
  const finished = schedules
    .filter((r) => r.status === "done" || r.status === "cancelled")
    .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
    .slice(0, RECENT_FINISHED_MAX);

  return (
    // 间距放在折叠体里面：条收起时这点间距一起收掉（inset：task 底部输入条上方要自带左右 / 顶部留白）
    <div className={cn("pb-1.5", inset && "px-2.5 pt-1.5")}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <button type="button" className={BAR_CLASS}>
              <span className="flex size-5 shrink-0 items-center justify-center rounded-sm bg-info/15">
                <AlarmClock className="size-3.5 text-info" aria-hidden />
              </span>
              {/* 静态点：进行中 = info；只有「错过」要用户注意时 = warning */}
              <span
                className={cn(
                  "size-1.5 shrink-0 rounded-full",
                  hasLive ? "bg-info" : hasMissed ? "bg-warning" : "bg-muted-foreground/60",
                )}
                aria-hidden
              />
              <span className="min-w-0 flex-1 truncate font-medium text-foreground">{label}</span>
              <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            </button>
          }
        />
        <PopoverContent side="top" align="start" className="w-96 p-2">
          <div className="mb-1 px-1 text-xs font-medium">这个会话的定时</div>
          <div className="max-h-72 divide-y overflow-y-auto">
            {ongoing.map((r) => (
              <ScheduleRow key={r.id} record={r} now={now} onChanged={onChanged} />
            ))}
          </div>
          {finished.length > 0 ? (
            <>
              <div className="mt-2 mb-0.5 px-1 text-[11px] text-muted-foreground">最近结束</div>
              <div className="divide-y">
                {finished.map((r) => (
                  <ScheduleRow key={r.id} record={r} now={now} onChanged={onChanged} />
                ))}
              </div>
            </>
          ) : null}
          <div className="mt-1.5 flex items-center justify-between px-1 text-[11px] text-muted-foreground">
            <span>应用没开 / 电脑睡眠错过的不会补发</span>
            <Link
              href="/schedules"
              className="text-foreground underline underline-offset-2"
              onClick={() => setOpen(false)}
            >
              全部定时任务
            </Link>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
};

/**
 * 真正干活的那层：只吃 taskId / signal / inset 三个基本类型 props、套 memo。
 * EventStream 每个流式 chunk 都会重渲、`events` 数组每次都是新引用；
 * 把「events → signal」留在外层、这一层只在 signal / taskId / inset 真变时才重渲，流式输出时不再带着它一起刷。
 */
const ScheduleChipInner = memo(function ScheduleChipInner({
  taskId,
  signal,
  inset,
}: {
  taskId: string;
  signal: string;
  inset: boolean;
}) {
  const { schedules, reload } = useTaskSchedules(taskId, signal);
  const now = useNow(schedules.length > 0);
  const summary = useMemo(() => summarizeSchedules(schedules), [schedules]);
  const label = chipText(summary, now);

  return (
    <Collapse open={label !== null}>
      {label !== null ? (
        <ChipBody
          label={label}
          hasLive={summary.activeCount > 0}
          hasMissed={summary.missedCount > 0}
          schedules={schedules}
          now={now}
          // 返回 Promise：操作按钮要等列表刷新回来才放开
          onChanged={reload}
          inset={inset}
        />
      ) : null}
    </Collapse>
  );
});

export const ScheduleChip = ({
  taskId,
  events,
  inset = false,
}: {
  taskId: string;
  /** 会话事件（只用来判断「定时有没有新动静」，见 scheduleEventSignal） */
  events: ReadonlyArray<{ id: string; meta?: Record<string, unknown> | null }>;
  /** task 页：条贴着底部输入条，自带左右 / 顶部留白（chat 在输入岛的容器里，不需要） */
  inset?: boolean;
}) => {
  const signal = useMemo(() => scheduleEventSignal(events), [events]);
  return <ScheduleChipInner taskId={taskId} signal={signal} inset={inset} />;
};
