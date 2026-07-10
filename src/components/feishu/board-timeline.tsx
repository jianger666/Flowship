"use client";

/**
 * 首页排期甘特（V0.14.4、对齐飞书人员排期——用户多轮纠偏后定型）
 *
 * - **需求条 = 需求级排期跨度**（服务端聚合所有节点排期 min~max）、条内写需求名 +
 *   节点状态 + AI 徽标、条短时文字向右溢出条外（飞书同款）
 * - **默认收起、可展开**（用户拍板）：点条左端箭头展开、下方插入每个节点的排期子行
 *  （节点名 + 小号排期条）、再点收起
 * - 日期头 + 今天竖线 + 周末底色；时间范围 = 日期范围选择器（飞书同款、含快捷档）
 * - 未排期项不显示（用户拍板「只要一个甘特图」）
 */

import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { AiStatusBadge, type BoardItem } from "@/components/feishu/feishu-board";
import { Button } from "@/components/ui/button";
import { DateRangePicker, type DayRange } from "@/components/ui/date-range-picker";
import { cn } from "@/lib/utils";

interface Props {
  items: BoardItem[];
  onOpen: (it: BoardItem) => void;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAY = ["日", "一", "二", "三", "四", "五", "六"];
// 节点状态 → 中文（CLI basic.status 实测值）
const NODE_STATUS_LABEL: Record<string, string> = {
  not_started: "未开始",
  doing: "进行中",
  done: "已完成",
};

// 窗口内列区间（与窗口无交集返 null）
const toCols = (
  start: number | undefined,
  end: number | undefined,
  windowStart: number,
  span: number,
): { colStart: number; colEnd: number; clippedL: boolean; clippedR: boolean } | null => {
  const s = start ?? end;
  const e = end ?? start;
  if (!s || !e) return null;
  const windowEnd = windowStart + span * DAY_MS;
  if (e < windowStart || s >= windowEnd) return null;
  const rawStart = Math.floor((s - windowStart) / DAY_MS);
  const rawEnd = Math.floor((e - windowStart) / DAY_MS);
  return {
    colStart: Math.max(0, rawStart),
    colEnd: Math.min(span - 1, rawEnd),
    clippedL: rawStart < 0,
    clippedR: rawEnd > span - 1,
  };
};

export const BoardTimeline = ({ items, onOpen }: Props) => {
  // 时间范围（用户拍板「像飞书那样的日期范围筛选」）：默认今天前 7 天 ~ 后 21 天
  const [range, setRange] = useState<DayRange>(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return { from: d.getTime() - 7 * DAY_MS, to: d.getTime() + 21 * DAY_MS };
  });
  // 展开的需求 id 集合（展开 = 下方插节点排期子行）
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const windowStart = range.from;
  // 窗口天数（含首尾）
  const span = Math.max(1, Math.round((range.to - range.from) / DAY_MS) + 1);

  const today0 = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }, []);
  const todayIdx = Math.floor((today0 - windowStart) / DAY_MS);
  const todayVisible = todayIdx >= 0 && todayIdx < span;

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

  // 渲染行：需求主行 + （展开时）节点子行。gridRow 按顺序分配
  type RenderRow =
    | { kind: "item"; item: BoardItem; cols: NonNullable<ReturnType<typeof toCols>> }
    | {
        kind: "node";
        parentId: string;
        name: string;
        status?: string;
        /** 子任务行（缩进更深、名字是具体任务名——用户点名要的层级） */
        isSub?: boolean;
        finished?: boolean;
        cols: NonNullable<ReturnType<typeof toCols>> | null;
      };

  const rows = useMemo<RenderRow[]>(() => {
    const scheduled = items
      .map((it) => ({ it, cols: toCols(it.scheduleStart, it.scheduleEnd, windowStart, span) }))
      .filter((x): x is { it: BoardItem; cols: NonNullable<ReturnType<typeof toCols>> } => x.cols !== null)
      .sort(
        (a, b) =>
          (a.it.scheduleStart ?? 0) - (b.it.scheduleStart ?? 0) ||
          (a.it.scheduleEnd ?? 0) - (b.it.scheduleEnd ?? 0),
      );
    const out: RenderRow[] = [];
    for (const { it, cols } of scheduled) {
      out.push({ kind: "item", item: it, cols });
      if (expanded.has(it.id)) {
        for (const n of it.nodes ?? []) {
          const subs = n.subTasks ?? [];
          // 节点行：有排期或有子任务才出（都没有的节点画不上轴、纯噪音）
          if (n.start || n.end || subs.length > 0) {
            out.push({
              kind: "node",
              parentId: it.id,
              name: n.name,
              status: n.status,
              cols: toCols(n.start, n.end, windowStart, span),
            });
          }
          // 子任务行（具体任务名、飞书展开的最细粒度）
          for (const s of subs) {
            out.push({
              kind: "node",
              parentId: it.id,
              name: s.name,
              isSub: true,
              finished: s.finished,
              cols: toCols(s.start, s.end, windowStart, span),
            });
          }
        }
      }
    }
    return out;
  }, [items, windowStart, span, expanded]);

  const rowCount = Math.max(rows.length, 1);

  const toggleExpand = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // 条色（需求主条）
  const barTone = (it: BoardItem): { bar: string; accent: string } => {
    if (it.task?.repoStatus === "merged")
      return { bar: "bg-emerald-500/12 hover:bg-emerald-500/20", accent: "bg-emerald-500" };
    if ((it.scheduleEnd ?? 0) < today0)
      return { bar: "bg-red-500/10 hover:bg-red-500/18", accent: "bg-red-500" };
    if (it.task) return { bar: "bg-primary/12 hover:bg-primary/20", accent: "bg-primary" };
    return { bar: "bg-muted/70 hover:bg-muted", accent: "bg-muted-foreground/50" };
  };

  return (
    <div className="flex h-full flex-col gap-3">
      {/* 工具条：日期范围筛选（飞书同款）+ 前后平移 */}
      <div className="flex shrink-0 items-center gap-1.5">
        <DateRangePicker value={range} onChange={setRange} />
        <Button
          size="icon-xs"
          variant="ghost"
          onClick={() =>
            setRange((r) => {
              const shift = Math.floor(span / 2) * DAY_MS;
              return { from: r.from - shift, to: r.to - shift };
            })
          }
          aria-label="往前平移"
          title="往前平移"
        >
          <ChevronLeft />
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          onClick={() =>
            setRange((r) => {
              const shift = Math.floor(span / 2) * DAY_MS;
              return { from: r.from + shift, to: r.to + shift };
            })
          }
          aria-label="往后平移"
          title="往后平移"
        >
          <ChevronRight />
        </Button>
        <span className="ml-auto text-xs text-muted-foreground">
          {rows.filter((r) => r.kind === "item").length} 项排期中 · 点条展开节点
        </span>
      </div>

      {/* 甘特主体 */}
      <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-border/60">
        <div
          className="relative grid min-w-full"
          style={{ gridTemplateColumns: `repeat(${span}, minmax(28px, 1fr))` }}
        >
          {/* 日期头（sticky 顶部） */}
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
              <span className={cn("text-muted-foreground/60", d.isToday && "text-primary/80")}>
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
                  style={{ gridColumn: i + 1, gridRow: `2 / ${rowCount + 2}` }}
                  aria-hidden
                />
              ),
          )}

          {/* 行渲染 */}
          {rows.length === 0 ? (
            <div
              className="py-10 text-center text-xs text-muted-foreground"
              style={{ gridColumn: `1 / ${span + 1}`, gridRow: 2 }}
            >
              该空间在这个时间段没有排期——切换空间或调整时间范围
            </div>
          ) : (
            rows.map((row, idx) => {
              if (row.kind === "item") {
                const { item: it, cols } = row;
                const tone = barTone(it);
                const isOpen = expanded.has(it.id);
                const hasNodes = (it.nodes ?? []).some(
                  (n) => n.start || n.end || (n.subTasks ?? []).length > 0,
                );
                return (
                  <div
                    key={`i-${it.id}`}
                    className={cn(
                      "group z-10 my-0.5 flex h-7 min-w-0 items-center gap-1 self-center rounded pr-2 text-left transition-colors",
                      tone.bar,
                      cols.clippedL && "rounded-l-none",
                      cols.clippedR && "rounded-r-none",
                    )}
                    style={{
                      gridColumn: `${cols.colStart + 1} / ${cols.colEnd + 2}`,
                      gridRow: idx + 2,
                      overflow: "visible",
                    }}
                  >
                    <span className={cn("h-full w-1 shrink-0 rounded-l", tone.accent)} aria-hidden />
                    {/* 展开箭头（有带排期的节点才显示） */}
                    {hasNodes && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleExpand(it.id);
                        }}
                        aria-label={isOpen ? "收起节点" : "展开节点"}
                        className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-background/50 hover:text-foreground"
                      >
                        <ChevronRight className={cn("size-3 transition-transform", isOpen && "rotate-90")} />
                      </button>
                    )}
                    {/* 需求名 + 状态 + AI 徽标（点击进任务/预览；条短时溢出条外） */}
                    <button
                      type="button"
                      onClick={() => onOpen(it)}
                      title={`${it.name}${it.statusLabel ? ` · ${it.statusLabel}` : ""}${
                        it.projectName ? `（${it.projectName}）` : ""
                      }`}
                      className="flex items-center gap-1.5 whitespace-nowrap text-left"
                    >
                      <span className="text-xs font-medium">{it.name}</span>
                      {it.statusLabel && (
                        <span className="text-[10px] text-muted-foreground">{it.statusLabel}</span>
                      )}
                      <AiStatusBadge task={it.task} />
                    </button>
                  </div>
                );
              }
              // 展开子行：节点行（分组标题感）/ 子任务行（具体任务、用户要看的名字）
              const cols = row.cols;
              return (
                <div
                  key={`n-${row.parentId}-${row.name}-${idx}`}
                  className={cn(
                    "z-10 my-px flex h-5 min-w-0 items-center gap-1 self-center rounded pr-2",
                    row.isSub ? "bg-primary/8 pl-1.5" : "bg-muted/50 pl-1.5",
                    row.finished && "opacity-55",
                  )}
                  style={
                    cols
                      ? {
                          gridColumn: `${cols.colStart + 1} / ${cols.colEnd + 2}`,
                          gridRow: idx + 2,
                          overflow: "visible",
                        }
                      : { gridColumn: "1 / 5", gridRow: idx + 2, opacity: 0.45 }
                  }
                >
                  <span
                    className={cn(
                      "whitespace-nowrap text-[10px]",
                      row.isSub ? "text-foreground/80" : "text-muted-foreground",
                    )}
                  >
                    {row.isSub ? row.name : `【${row.name}】`}
                    {!row.isSub && row.status && NODE_STATUS_LABEL[row.status]
                      ? ` · ${NODE_STATUS_LABEL[row.status]}`
                      : ""}
                    {row.isSub && row.finished ? " ✓" : ""}
                    {!cols && "（窗口外）"}
                  </span>
                </div>
              );
            })
          )}

          {/* 今天竖线 */}
          {todayVisible && (
            <div
              className="pointer-events-none z-20 w-px justify-self-center bg-primary/70"
              style={{ gridColumn: todayIdx + 1, gridRow: `1 / ${rowCount + 2}` }}
              aria-hidden
            />
          )}
        </div>
      </div>
    </div>
  );
};
