"use client";

/**
 * 首页甘特图（V0.14.1、用户拍板「首页只要一个像飞书排期那样的甘特图」）
 *
 * 对齐飞书人员排期的阅读结构：
 * - 左侧固定名称列（sticky、工作项名 + AI 状态徽标）、右侧按天分列的时间网格
 * - 排期条落在网格上（逾期红 / 已合入绿 / 有 AI 任务主题色 / 未开始灰）
 * - 「今天」贯穿竖线 + 日期头高亮、周末底色
 * - 日期段筛选：窗口跨度（2 周 / 4 周 / 8 周）+ 前后翻页 + 回今天
 * - 未排期项收在甘特下方平铺 chip
 */

import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { AiStatusBadge, type BoardItem } from "@/components/feishu/feishu-board";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ChoiceButton } from "@/components/ui/choice-button";
import { cn } from "@/lib/utils";

interface Props {
  items: BoardItem[];
  onOpen: (it: BoardItem) => void;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAY = ["日", "一", "二", "三", "四", "五", "六"];
// 可选窗口跨度（天）
const SPAN_OPTIONS = [
  { days: 14, label: "2 周" },
  { days: 28, label: "4 周" },
  { days: 56, label: "8 周" },
] as const;

// 名称列宽（左侧 sticky）
const NAME_COL = "232px";

export const BoardTimeline = ({ items, onOpen }: Props) => {
  // 窗口跨度（天）
  const [span, setSpan] = useState<number>(28);
  // 窗口起点偏移（天、相对「今天往前 1/4 窗口」的默认锚点）——翻页按钮改它
  const [offset, setOffset] = useState(0);

  // 窗口起点：默认让「今天」落在窗口前 1/4 处（重点看未来）
  const windowStart = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime() - Math.floor(span / 4) * DAY_MS + offset * DAY_MS;
  }, [span, offset]);

  const today0 = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }, []);
  // 今天在窗口内的列号（0-based、不在窗口内 = -1）
  const todayIdx = Math.floor((today0 - windowStart) / DAY_MS);
  const todayVisible = todayIdx >= 0 && todayIdx < span;

  // 日期带
  const days = useMemo(
    () =>
      Array.from({ length: span }, (_, i) => {
        const d = new Date(windowStart + i * DAY_MS);
        return {
          date: d.getDate(),
          weekday: WEEKDAY[d.getDay()],
          isToday: i === todayIdx,
          isWeekend: d.getDay() === 0 || d.getDay() === 6,
          isMonthStart: d.getDate() === 1,
          month: d.getMonth() + 1,
        };
      }),
    [windowStart, span, todayIdx],
  );

  // 分组：有排期（与窗口有交集）上甘特；其余归「未排期」
  const { scheduled, unscheduled } = useMemo(() => {
    const sch: Array<
      BoardItem & { colStart: number; colEnd: number; clippedL: boolean; clippedR: boolean }
    > = [];
    const unsch: BoardItem[] = [];
    const windowEnd = windowStart + span * DAY_MS;
    for (const it of items) {
      const s = it.scheduleStart ?? it.scheduleEnd;
      const e = it.scheduleEnd ?? it.scheduleStart;
      if (!s || !e) {
        unsch.push(it);
        continue;
      }
      if (e < windowStart || s >= windowEnd) {
        // 有排期但不在窗口内——不进未排期组（翻页能看到）、直接不渲染
        continue;
      }
      const rawStart = Math.floor((s - windowStart) / DAY_MS);
      const rawEnd = Math.floor((e - windowStart) / DAY_MS);
      sch.push({
        ...it,
        colStart: Math.max(0, rawStart),
        colEnd: Math.min(span - 1, rawEnd),
        clippedL: rawStart < 0,
        clippedR: rawEnd > span - 1,
      });
    }
    sch.sort((a, b) => (a.scheduleEnd ?? 0) - (b.scheduleEnd ?? 0));
    return { scheduled: sch, unscheduled: unsch };
  }, [items, windowStart, span]);

  // 排期条配色
  const barClass = (it: BoardItem): string => {
    if (it.task?.repoStatus === "merged")
      return "bg-emerald-500/20 border-emerald-500/50";
    if ((it.scheduleEnd ?? 0) < today0)
      return "bg-red-500/15 border-red-500/50";
    if (it.task) return "bg-primary/20 border-primary/50";
    return "bg-muted border-border";
  };

  return (
    <div className="flex h-full flex-col gap-3">
      {/* 甘特工具条：窗口跨度 + 翻页 + 回今天 */}
      <div className="flex shrink-0 items-center gap-1.5">
        {SPAN_OPTIONS.map((o) => (
          <ChoiceButton
            key={o.days}
            shape="chip"
            selected={span === o.days}
            onClick={() => setSpan(o.days)}
            className="px-2.5 py-1 text-xs"
          >
            {o.label}
          </ChoiceButton>
        ))}
        <div className="mx-1 h-4 w-px bg-border" />
        <Button
          size="icon-xs"
          variant="ghost"
          onClick={() => setOffset((v) => v - Math.floor(span / 2))}
          aria-label="往前翻"
          title="往前翻"
        >
          <ChevronLeft />
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          onClick={() => setOffset((v) => v + Math.floor(span / 2))}
          aria-label="往后翻"
          title="往后翻"
        >
          <ChevronRight />
        </Button>
        {offset !== 0 && (
          <Button
            size="xs"
            variant="ghost"
            className="text-xs text-primary"
            onClick={() => setOffset(0)}
          >
            回今天
          </Button>
        )}
        <span className="ml-auto text-xs text-muted-foreground">
          {scheduled.length} 项排期中
          {unscheduled.length > 0 && ` · ${unscheduled.length} 项未排期`}
        </span>
      </div>

      {/* 甘特主体：左名称列（sticky）+ 右时间网格 */}
      <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-border/60">
        <div
          className="relative grid w-max min-w-full"
          style={{
            gridTemplateColumns: `${NAME_COL} repeat(${span}, minmax(30px, 42px))`,
          }}
        >
          {/* 表头：名称列头 + 日期带 */}
          <div
            className="sticky left-0 z-30 border-b border-r border-border/60 bg-background px-3 py-1.5 text-[11px] text-muted-foreground"
            style={{ gridColumn: 1, gridRow: 1 }}
          >
            工作项
          </div>
          {days.map((d, i) => (
            <div
              key={i}
              className={cn(
                "flex flex-col items-center gap-0.5 border-b border-border/60 py-1.5 text-[10px]",
                d.isWeekend && "bg-muted/30",
                d.isToday && "bg-primary/10",
              )}
              style={{ gridColumn: i + 2, gridRow: 1 }}
            >
              <span
                className={cn(
                  "font-mono",
                  d.isToday ? "font-bold text-primary" : "text-muted-foreground",
                )}
              >
                {d.isMonthStart || i === 0 ? `${d.month}/${d.date}` : d.date}
              </span>
              <span
                className={cn("text-muted-foreground/60", d.isToday && "text-primary/80")}
              >
                {d.isToday ? "今" : d.weekday}
              </span>
            </div>
          ))}

          {/* 周末底色（贯穿行区） */}
          {days.map(
            (d, i) =>
              d.isWeekend && (
                <div
                  key={`we-${i}`}
                  className="bg-muted/20"
                  style={{
                    gridColumn: i + 2,
                    gridRow: `2 / ${Math.max(scheduled.length, 1) + 2}`,
                  }}
                  aria-hidden
                />
              ),
          )}

          {/* 行：左名称 + 右排期条 */}
          {scheduled.length === 0 ? (
            <div
              className="py-10 text-center text-xs text-muted-foreground"
              style={{ gridColumn: `1 / ${span + 2}`, gridRow: 2 }}
            >
              窗口内没有已排期的工作项——用上面箭头翻别的时间段
            </div>
          ) : (
            scheduled.map((it, row) => (
              <div key={it.id} className="contents">
                {/* 名称列（sticky left、点击同排期条） */}
                <button
                  type="button"
                  onClick={() => onOpen(it)}
                  title={it.name}
                  className="group sticky left-0 z-20 flex min-w-0 items-center gap-1.5 border-b border-r border-border/40 bg-background px-3 py-1.5 text-left transition-colors hover:bg-muted/40"
                  style={{ gridColumn: 1, gridRow: row + 2 }}
                >
                  <span className="min-w-0 flex-1 truncate text-xs">{it.name}</span>
                  <AiStatusBadge task={it.task} />
                </button>
                {/* 行底线（时间网格区） */}
                <div
                  className="border-b border-border/40"
                  style={{ gridColumn: `2 / ${span + 2}`, gridRow: row + 2 }}
                  aria-hidden
                />
                {/* 排期条 */}
                <button
                  type="button"
                  onClick={() => onOpen(it)}
                  title={`${it.name}${it.statusLabel ? ` · ${it.statusLabel}` : ""}`}
                  className={cn(
                    "z-10 my-1 flex min-w-0 items-center gap-1 self-center rounded border px-1.5 py-0.5 text-left transition-all hover:z-20 hover:shadow-md",
                    barClass(it),
                    it.clippedL && "rounded-l-none border-l-0",
                    it.clippedR && "rounded-r-none border-r-0",
                  )}
                  style={{
                    gridColumn: `${it.colStart + 2} / ${it.colEnd + 3}`,
                    gridRow: row + 2,
                  }}
                >
                  {it.statusLabel && (
                    <span className="truncate text-[10px] text-muted-foreground">
                      {it.statusLabel}
                    </span>
                  )}
                </button>
              </div>
            ))
          )}

          {/* 今天竖线（在窗口内才画、置顶层不挡点击） */}
          {todayVisible && (
            <div
              className="pointer-events-none z-20 w-px justify-self-center bg-primary/70"
              style={{
                gridColumn: todayIdx + 2,
                gridRow: `1 / ${Math.max(scheduled.length, 1) + 2}`,
              }}
              aria-hidden
            />
          )}
        </div>
      </div>

      {/* 未排期：甘特下方平铺 */}
      {unscheduled.length > 0 && (
        <div className="flex shrink-0 flex-col gap-2">
          <div className="text-xs text-muted-foreground">未排期 · {unscheduled.length} 项</div>
          <div className="flex max-h-28 flex-wrap gap-2 overflow-y-auto">
            {unscheduled.map((it) => (
              <button
                key={it.id}
                type="button"
                onClick={() => onOpen(it)}
                className="flex max-w-full items-center gap-2 rounded-md border border-border/60 bg-card/50 px-2.5 py-1.5 text-xs transition-colors hover:bg-muted/40"
                title={it.name}
              >
                <span className="min-w-0 truncate">{it.name}</span>
                {it.statusLabel && (
                  <Badge variant="outline" className="shrink-0 text-[10px]">
                    {it.statusLabel}
                  </Badge>
                )}
                <AiStatusBadge task={it.task} />
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
