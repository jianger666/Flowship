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
import { ChoiceButton } from "@/components/ui/choice-button";
import { DateRangePicker, type DayRange } from "@/components/ui/date-range-picker";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

interface Props {
  items: BoardItem[];
  onOpen: (it: BoardItem) => void;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAY = ["日", "一", "二", "三", "四", "五", "六"];
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
  // 时间范围（用户拍板）：默认今天前 3 天 ~ 后 10 天（两周、一屏正好放下）
  const [range, setRange] = useState<DayRange>(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return { from: d.getTime() - 3 * DAY_MS, to: d.getTime() + 10 * DAY_MS };
  });
  // 展开的需求 id 集合（展开 = 下方插节点排期子行）
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // 只看自己的子任务（默认开、用户拍板「展开全部人的太多了」）
  const [mineOnly, setMineOnly] = useState(true);

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
        // 只出子任务行（用户拍板：【技术排期】【测试排期】节点分组行不要、只关心自己的活）
        for (const n of it.nodes ?? []) {
          for (const s of (n.subTasks ?? []).filter((s) => !mineOnly || s.mine)) {
            out.push({
              kind: "node",
              parentId: it.id,
              name: s.name,
              // 节点名收进 tooltip（行上不占地）
              status: n.name,
              isSub: true,
              finished: s.finished,
              cols: toCols(s.start, s.end, windowStart, span),
            });
          }
        }
      }
    }
    return out;
  }, [items, windowStart, span, expanded, mineOnly]);

  const rowCount = Math.max(rows.length, 1);

  const toggleExpand = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // 条色（需求主条）：底色 + 同色系边框——纯透明底色在浅色模式下几乎隐形（用户点名对比度太低）
  const barTone = (it: BoardItem): { bar: string; accent: string } => {
    if (it.task?.repoStatus === "merged")
      return {
        bar: "border border-emerald-500/50 bg-emerald-500/18 hover:bg-emerald-500/28",
        accent: "bg-emerald-500",
      };
    if ((it.scheduleEnd ?? 0) < today0)
      return {
        bar: "border border-red-500/50 bg-red-500/15 hover:bg-red-500/25",
        accent: "bg-red-500",
      };
    if (it.task)
      return {
        bar: "border border-primary/50 bg-primary/18 hover:bg-primary/28",
        accent: "bg-primary",
      };
    return {
      bar: "border border-muted-foreground/35 bg-muted-foreground/12 hover:bg-muted-foreground/20",
      accent: "bg-muted-foreground/70",
    };
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
        <div className="mx-1 h-4 w-px bg-border" />
        <ChoiceButton
          shape="chip"
          selected={mineOnly}
          onClick={() => setMineOnly((v) => !v)}
          className="px-2.5 py-1 text-xs"
        >
          只看自己
        </ChoiceButton>
        <span className="ml-auto text-xs text-muted-foreground">
          {rows.filter((r) => r.kind === "item").length} 项排期中 · 点条展开节点
        </span>
      </div>

      {/* 甘特主体 */}
      <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-border/60">
        <div
          className="relative grid min-w-full"
          style={{
            gridTemplateColumns: `repeat(${span}, minmax(56px, 1fr))`,
            // 每列保底 56px：跨度大时横向滚动、一屏可见约半个月（用户拍板「太窄了」）
            minWidth: `${span * 56}px`,
          }}
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
                  (n) => (n.subTasks ?? []).length > 0,
                );
                const tip = `${it.name}${it.statusLabel ? ` · ${it.statusLabel}` : ""}${
                  it.projectName ? `（${it.projectName}）` : ""
                }`;
                return (
                  <Tooltip key={`i-${it.id}`} content={tip} delay={100} side="top">
                  <div
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
                      className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                    >
                      <span className="min-w-0 truncate text-xs font-medium">{it.name}</span>
                      {it.statusLabel && (
                        <span className="shrink-0 text-[10px] text-muted-foreground">
                          {it.statusLabel}
                        </span>
                      )}
                      <AiStatusBadge task={it.task} />
                    </button>
                  </div>
                  </Tooltip>
                );
              }
              // 展开子行：节点行（分组标题感）/ 子任务行（具体任务名）。
              // 文字超出条宽 → 省略号、hover title 看全部（用户拍板、不再溢出条外）
              const cols = row.cols;
              const label = `${row.name}${row.finished ? " ✓" : ""}${!cols ? "（窗口外）" : ""}`;
              // tooltip 补节点归属（行上不占地、悬停可查）
              const tipLabel = row.status ? `${label}（${row.status}）` : label;
              return (
                <Tooltip key={`n-${row.parentId}-${row.name}-${idx}`} content={tipLabel} delay={100} side="top">
                <div
                  className={cn(
                    "z-10 my-px flex h-5 min-w-0 items-center gap-1 self-center overflow-hidden rounded pl-1.5 pr-2",
                    row.isSub
                      ? "border border-primary/35 bg-primary/14"
                      : "border border-muted-foreground/25 bg-muted-foreground/10",
                    row.finished && "opacity-55",
                  )}
                  style={
                    cols
                      ? {
                          gridColumn: `${cols.colStart + 1} / ${cols.colEnd + 2}`,
                          gridRow: idx + 2,
                        }
                      : { gridColumn: "1 / 5", gridRow: idx + 2, opacity: 0.45 }
                  }
                >
                  <span
                    className={cn(
                      "min-w-0 truncate text-[10px]",
                      row.isSub ? "text-foreground/80" : "text-muted-foreground",
                    )}
                  >
                    {label}
                  </span>
                </div>
                </Tooltip>
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
