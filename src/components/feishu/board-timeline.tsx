"use client";

/**
 * 看板时间线视图（V0.14、用户点名「要真时间线、不要简版分组」）
 *
 * 横向时间轴（甘特 lite、首版只读）：
 * - 时间窗：今天前 7 天 ~ 后 21 天（共 28 天）、CSS grid 按天分列
 * - 每个有排期的工作项一条横向排期条、起止映射到轴上（越界裁剪 + 边缘渐隐提示延伸）
 * - 「今天」一条主题色纵线贯穿、日期带高亮
 * - 逾期未完成 → 排期条红系；已合入 → 绿系；进行中 → 主题色；未开始 → 灰
 * - 无排期项归底部「未排期」组（平铺 chip、不占轴）
 * - hover 抬升 + 阴影、点击同列表（有任务直进、没任务进预览）
 */

import { useMemo } from "react";

import { AiStatusBadge, type BoardItem } from "@/components/feishu/feishu-board";
import { cn } from "@/lib/utils";

interface Props {
  items: BoardItem[];
  onOpen: (it: BoardItem) => void;
}

const DAY_MS = 24 * 60 * 60 * 1000;
// 时间窗：今天往前 7 天、往后 21 天
const DAYS_BEFORE = 7;
const DAYS_TOTAL = 28;

const WEEKDAY = ["日", "一", "二", "三", "四", "五", "六"];

export const BoardTimeline = ({ items, onOpen }: Props) => {
  // 窗口起点（今天 0 点 - 7 天）
  const windowStart = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime() - DAYS_BEFORE * DAY_MS;
  }, []);
  const todayIdx = DAYS_BEFORE; // 今天在第几列（0-based）

  // 日期带
  const days = useMemo(
    () =>
      Array.from({ length: DAYS_TOTAL }, (_, i) => {
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
    [windowStart, todayIdx],
  );

  // 分组：有排期（且与窗口有交集）上轴；其余归「未排期」
  const { scheduled, unscheduled } = useMemo(() => {
    const sch: Array<BoardItem & { colStart: number; colEnd: number; clippedL: boolean; clippedR: boolean }> = [];
    const unsch: BoardItem[] = [];
    const windowEnd = windowStart + DAYS_TOTAL * DAY_MS;
    for (const it of items) {
      const s = it.scheduleStart ?? it.scheduleEnd;
      const e = it.scheduleEnd ?? it.scheduleStart;
      if (!s || !e || e < windowStart || s >= windowEnd) {
        unsch.push(it);
        continue;
      }
      const rawStart = Math.floor((s - windowStart) / DAY_MS);
      const rawEnd = Math.floor((e - windowStart) / DAY_MS);
      sch.push({
        ...it,
        colStart: Math.max(0, rawStart),
        colEnd: Math.min(DAYS_TOTAL - 1, rawEnd),
        clippedL: rawStart < 0,
        clippedR: rawEnd > DAYS_TOTAL - 1,
      });
    }
    // 结束早的排上面（视觉上「先到期先看到」）
    sch.sort((a, b) => (a.scheduleEnd ?? 0) - (b.scheduleEnd ?? 0));
    return { scheduled: sch, unscheduled: unsch };
  }, [items, windowStart]);

  const today0 = windowStart + DAYS_BEFORE * DAY_MS;

  // 排期条配色：合入绿 / 逾期红 / 有 AI 任务主题色 / 未开始灰
  const barClass = (it: BoardItem): string => {
    if (it.task?.repoStatus === "merged")
      return "bg-emerald-500/15 border-emerald-500/40 text-emerald-600 dark:text-emerald-400";
    if ((it.scheduleEnd ?? 0) < today0)
      return "bg-red-500/10 border-red-500/40 text-red-600 dark:text-red-400";
    if (it.task)
      return "bg-primary/10 border-primary/40 text-foreground";
    return "bg-muted/60 border-border text-muted-foreground";
  };

  return (
    <div className="flex flex-col gap-4">
      {/* 时间轴主体：横向可滚、grid 按天分列 */}
      <div className="overflow-x-auto rounded-lg border border-border/60">
        <div
          className="relative grid min-w-[980px]"
          style={{ gridTemplateColumns: `repeat(${DAYS_TOTAL}, minmax(34px, 1fr))` }}
        >
          {/* 日期带 */}
          {days.map((d, i) => (
            <div
              key={i}
              className={cn(
                "flex flex-col items-center gap-0.5 border-b border-border/60 py-1.5 text-[10px]",
                d.isWeekend && "bg-muted/30",
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
              <span className={cn("text-muted-foreground/60", d.isToday && "text-primary/80")}>
                {d.isToday ? "今天" : d.weekday}
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
                  style={{ gridColumn: i + 1, gridRow: `2 / ${scheduled.length + 3}` }}
                  aria-hidden
                />
              ),
          )}

          {/* 排期条：每项占一行 */}
          {scheduled.map((it, row) => (
            <button
              key={it.id}
              type="button"
              onClick={() => onOpen(it)}
              title={it.name}
              className={cn(
                "group relative z-10 m-1 flex min-w-0 items-center gap-1.5 rounded-md border px-2 py-1 text-left transition-all hover:z-20 hover:-translate-y-px hover:shadow-md",
                barClass(it),
                // 越界渐隐：提示排期延伸到窗口外
                it.clippedL && "rounded-l-none border-l-0",
                it.clippedR && "rounded-r-none border-r-0",
              )}
              style={{
                gridColumn: `${it.colStart + 1} / ${it.colEnd + 2}`,
                gridRow: row + 2,
              }}
            >
              <span className="min-w-0 truncate text-xs font-medium">{it.name}</span>
              <span className="ml-auto hidden shrink-0 group-hover:block">
                <AiStatusBadge task={it.task} />
              </span>
            </button>
          ))}

          {/* 空轴占位（没有任何排期项时给一行、防塌） */}
          {scheduled.length === 0 && (
            <div
              className="py-8 text-center text-xs text-muted-foreground"
              style={{ gridColumn: `1 / ${DAYS_TOTAL + 1}`, gridRow: 2 }}
            >
              窗口内没有已排期的工作项
            </div>
          )}

          {/* 「今天」纵线（贯穿、置顶层） */}
          <div
            className="pointer-events-none z-20 w-px justify-self-center bg-primary/70"
            style={{
              gridColumn: todayIdx + 1,
              gridRow: `1 / ${Math.max(scheduled.length, 1) + 2}`,
            }}
            aria-hidden
          />
        </div>
      </div>

      {/* 未排期组：平铺 chip */}
      {unscheduled.length > 0 && (
        <div className="flex flex-col gap-2">
          <div className="text-xs text-muted-foreground">
            未排期 · {unscheduled.length} 项
          </div>
          <div className="flex flex-wrap gap-2">
            {unscheduled.map((it) => (
              <button
                key={it.id}
                type="button"
                onClick={() => onOpen(it)}
                className="flex max-w-full items-center gap-2 rounded-md border border-border/60 bg-card/50 px-2.5 py-1.5 text-xs transition-colors hover:bg-muted/40"
                title={it.name}
              >
                <span className="min-w-0 truncate">{it.name}</span>
                <AiStatusBadge task={it.task} />
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
