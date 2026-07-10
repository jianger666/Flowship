"use client";

/**
 * 首页排期甘特（V0.14.4、对齐飞书人员排期——用户多轮纠偏后定型）
 *
 * - **需求条 = 需求级排期跨度**（服务端聚合所有节点排期 min~max）、条内写需求名 +
 *   节点状态 + AI 徽标、条短时文字向右溢出条外（飞书同款）
 * - **默认收起、可展开**（用户拍板）：点条左端箭头展开、下方插入每个节点的排期子行
 *  （节点名 + 小号排期条）、再点收起
 * - 日期头 + 今天竖线 + 周末底色；窗口跨度 2/4/8 周 + 前后翻页 + 回今天
 * - 未排期项不显示（用户拍板「只要一个甘特图」）
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
const SPAN_OPTIONS = [
  { days: 14, label: "2 周" },
  { days: 28, label: "4 周" },
  { days: 56, label: "8 周" },
] as const;

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
  // 窗口跨度（天）
  const [span, setSpan] = useState<number>(28);
  // 窗口起点偏移（天）——翻页按钮改
  const [offset, setOffset] = useState(0);
  // 展开的需求 id 集合（展开 = 下方插节点排期子行）
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // 窗口起点：默认「今天」落在窗口前 1/4 处（重点看未来）
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
        // 有排期的节点才出子行（没排期的节点画不上轴、跳过）
        for (const n of it.nodes ?? []) {
          const nCols = toCols(n.start, n.end, windowStart, span);
          if (n.start || n.end) {
            out.push({ kind: "node", parentId: it.id, name: n.name, status: n.status, cols: nCols });
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
              窗口内没有已排期的工作项——用上面箭头翻别的时间段
            </div>
          ) : (
            rows.map((row, idx) => {
              if (row.kind === "item") {
                const { item: it, cols } = row;
                const tone = barTone(it);
                const isOpen = expanded.has(it.id);
                const hasNodes = (it.nodes ?? []).some((n) => n.start || n.end);
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
              // 节点子行：窗口内有排期画小条、窗口外的显示在最左（弱化）
              const cols = row.cols;
              return (
                <div
                  key={`n-${row.parentId}-${row.name}-${idx}`}
                  className="z-10 my-px flex h-5 min-w-0 items-center gap-1 self-center rounded bg-muted/50 pl-1.5 pr-2"
                  style={
                    cols
                      ? {
                          gridColumn: `${cols.colStart + 1} / ${cols.colEnd + 2}`,
                          gridRow: idx + 2,
                          overflow: "visible",
                        }
                      : { gridColumn: "1 / 4", gridRow: idx + 2, opacity: 0.5 }
                  }
                >
                  <span className="whitespace-nowrap text-[10px] text-muted-foreground">
                    {row.name}
                    {row.status && NODE_STATUS_LABEL[row.status]
                      ? ` · ${NODE_STATUS_LABEL[row.status]}`
                      : ""}
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
