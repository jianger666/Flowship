"use client";

/**
 * 首页排期甘特（V0.14.2、对齐飞书人员排期的呈现方式——用户两轮纠偏后定型）
 *
 * 核心：**排了期的需求本身是时间线上的条**——条从排期开始画到排期结束、
 * 条内（或条右侧溢出）直接写需求名 + 节点状态、一眼「什么需求排在什么时候」。
 * （第一版把需求名放左列、条上只写节点状态——用户实测「这是把节点放时间线上」、错）
 *
 * - 日期头（今天高亮）+ 今天贯穿竖线 + 周末底色
 * - 条色：逾期红 / 已合入绿 / 有 AI 任务主题色 / 未开始灰；AI 状态徽标跟在名字后
 * - 条太短放不下文字 → 文字向右溢出条外（飞书同款处理）
 * - 日期段筛选：窗口跨度 2/4/8 周 + 前后翻页 + 回今天
 * - 未排期项收在甘特下方平铺
 */

import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { AiStatusBadge, type BoardItem } from "@/components/feishu/feishu-board";
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

export const BoardTimeline = ({ items, onOpen }: Props) => {
  // 窗口跨度（天）
  const [span, setSpan] = useState<number>(28);
  // 窗口起点偏移（天）——翻页按钮改它
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

  // 只收「排期与窗口有交集」的上轴；没排期的不显示（用户拍板「只要一个甘特图」）；窗口外的翻页看
  const scheduled = useMemo(() => {
    const sch: Array<
      BoardItem & { colStart: number; colEnd: number; clippedL: boolean; clippedR: boolean }
    > = [];
    const windowEnd = windowStart + span * DAY_MS;
    for (const it of items) {
      const s = it.scheduleStart ?? it.scheduleEnd;
      const e = it.scheduleEnd ?? it.scheduleStart;
      // 没排期的不显示（用户拍板「只要一个甘特图」）；窗口外的翻页看
      if (!s || !e) continue;
      if (e < windowStart || s >= windowEnd) continue;
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
    // 开始早的在上（时间自然阅读序）；同起点按结束时间
    sch.sort(
      (a, b) =>
        (a.scheduleStart ?? a.scheduleEnd ?? 0) - (b.scheduleStart ?? b.scheduleEnd ?? 0) ||
        (a.scheduleEnd ?? 0) - (b.scheduleEnd ?? 0),
    );
    return sch;
  }, [items, windowStart, span]);

  // 条色（左侧竖色标 + 条底色）
  const barTone = (it: BoardItem): { bar: string; accent: string } => {
    if (it.task?.repoStatus === "merged")
      return { bar: "bg-emerald-500/12 hover:bg-emerald-500/20", accent: "bg-emerald-500" };
    if ((it.scheduleEnd ?? 0) < today0)
      return { bar: "bg-red-500/10 hover:bg-red-500/18", accent: "bg-red-500" };
    if (it.task)
      return { bar: "bg-primary/12 hover:bg-primary/20", accent: "bg-primary" };
    return { bar: "bg-muted/70 hover:bg-muted", accent: "bg-muted-foreground/50" };
  };

  return (
    <div className="flex h-full flex-col gap-3">
      {/* 工具条：窗口跨度 + 翻页 + 回今天 */}
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
        </span>
      </div>

      {/* 甘特主体：需求条铺在时间网格上（飞书排期同款阅读方式） */}
      <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-border/60">
        <div
          className="relative grid min-w-full"
          style={{ gridTemplateColumns: `repeat(${span}, minmax(28px, 1fr))` }}
        >
          {/* 日期头 */}
          {days.map((d, i) => (
            <div
              key={i}
              className={cn(
                "sticky top-0 z-30 flex flex-col items-center gap-0.5 border-b border-border/60 bg-background py-1.5 text-[10px]",
                d.isWeekend && "bg-muted/40",
                d.isToday && "bg-primary/10",
              )}
              style={{ gridColumn: i + 1, gridRow: 1 }}
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

          {/* 周末底色 */}
          {days.map(
            (d, i) =>
              d.isWeekend && (
                <div
                  key={`we-${i}`}
                  className="bg-muted/20"
                  style={{
                    gridColumn: i + 1,
                    gridRow: `2 / ${Math.max(scheduled.length, 1) + 2}`,
                  }}
                  aria-hidden
                />
              ),
          )}

          {/* 需求条：一行一条、条画在排期区间上、名字在条内（放不下向右溢出条外） */}
          {scheduled.length === 0 ? (
            <div
              className="py-10 text-center text-xs text-muted-foreground"
              style={{ gridColumn: `1 / ${span + 1}`, gridRow: 2 }}
            >
              窗口内没有已排期的工作项——用上面箭头翻别的时间段
            </div>
          ) : (
            scheduled.map((it, row) => {
              const tone = barTone(it);
              return (
                <button
                  key={it.id}
                  type="button"
                  onClick={() => onOpen(it)}
                  title={`${it.name}${it.statusLabel ? ` · ${it.statusLabel}` : ""}${
                    it.projectName ? `（${it.projectName}）` : ""
                  }`}
                  className={cn(
                    "group z-10 my-0.5 flex h-7 min-w-0 items-center gap-1.5 self-center rounded pl-0 pr-2 text-left transition-colors",
                    tone.bar,
                    it.clippedL && "rounded-l-none",
                    it.clippedR && "rounded-r-none",
                  )}
                  style={{
                    gridColumn: `${it.colStart + 1} / ${it.colEnd + 2}`,
                    gridRow: row + 2,
                    // 文字放不下时向右溢出条外显示（飞书同款）——不裁剪
                    overflow: "visible",
                  }}
                >
                  {/* 左端竖色标（状态色、飞书排期条同款视觉锚点） */}
                  <span
                    className={cn("h-full w-1 shrink-0 rounded-l", tone.accent)}
                    aria-hidden
                  />
                  {/* 需求名 + 节点状态 + AI 徽标：nowrap、条短时溢出到条右侧 */}
                  <span className="flex items-center gap-1.5 whitespace-nowrap">
                    <span className="text-xs font-medium">{it.name}</span>
                    {it.statusLabel && (
                      <span className="text-[10px] text-muted-foreground">
                        {it.statusLabel}
                      </span>
                    )}
                    <AiStatusBadge task={it.task} />
                  </span>
                </button>
              );
            })
          )}

          {/* 今天竖线 */}
          {todayVisible && (
            <div
              className="pointer-events-none z-20 w-px justify-self-center bg-primary/70"
              style={{
                gridColumn: todayIdx + 1,
                gridRow: `1 / ${Math.max(scheduled.length, 1) + 2}`,
              }}
              aria-hidden
            />
          )}
        </div>
      </div>

    </div>
  );
};
