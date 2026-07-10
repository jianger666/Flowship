"use client";

/**
 * 日期范围选择器（V0.14.5、甘特时间筛选用——用户点名「像飞书那样」）
 *
 * Popover + react-day-picker 双月 range 日历 + 快捷项（本周 / 本双周 / 本月 / 2 个月 / 半年）。
 * 触发按钮显示当前范围「M/D ~ M/D」。典型标准件、按约定放 ui/。
 */

import { useState } from "react";
import { DayPicker, type DateRange } from "react-day-picker";
import { zhCN } from "react-day-picker/locale";
import { CalendarRange } from "lucide-react";
import "react-day-picker/style.css";

import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export interface DayRange {
  /** 起止（含）、均为当天 0 点 ms */
  from: number;
  to: number;
}

interface Props {
  value: DayRange;
  onChange: (range: DayRange) => void;
  className?: string;
}

const day0 = (d: Date): number => {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x.getTime();
};

const DAY_MS = 24 * 60 * 60 * 1000;

// 快捷项（跟飞书排期筛选的快捷档对齐、按我们场景取舍）
const buildPresets = (): Array<{ label: string; range: DayRange }> => {
  const today = day0(new Date());
  const dow = new Date(today).getDay() || 7; // 周一为一周起点
  const weekStart = today - (dow - 1) * DAY_MS;
  const d = new Date(today);
  const monthStart = day0(new Date(d.getFullYear(), d.getMonth(), 1));
  const monthEnd = day0(new Date(d.getFullYear(), d.getMonth() + 1, 0));
  return [
    { label: "本周", range: { from: weekStart, to: weekStart + 6 * DAY_MS } },
    { label: "本双周", range: { from: weekStart, to: weekStart + 13 * DAY_MS } },
    { label: "本月", range: { from: monthStart, to: monthEnd } },
    { label: "2 个月", range: { from: today - 7 * DAY_MS, to: today + 53 * DAY_MS } },
    { label: "半年", range: { from: today - 30 * DAY_MS, to: today + 150 * DAY_MS } },
  ];
};

const fmt = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()}`;
};

export const DateRangePicker = ({ value, onChange, className }: Props) => {
  const [open, setOpen] = useState(false);
  // 日历上的半选状态（选了 from 还没选 to）
  const [draft, setDraft] = useState<DateRange | undefined>(undefined);

  const presets = buildPresets();

  const commit = (from: number, to: number) => {
    onChange({ from, to });
    setDraft(undefined);
    setOpen(false);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setDraft(undefined);
      }}
    >
      <PopoverTrigger
        render={
          <Button variant="outline" size="sm" className={cn("h-7 gap-1.5 text-xs", className)}>
            <CalendarRange className="size-3.5" />
            {fmt(value.from)} ~ {fmt(value.to)}
          </Button>
        }
      />
      <PopoverContent align="start" className="w-auto p-3">
        <div
          className="flex flex-col gap-2"
          // react-day-picker 主题变量接 app token（dark 自动跟随）；不用 styled-jsx（App Router 下多一层风险）
          style={
            {
              // v10 真实变量名（node_modules style.css 核对过）——range_middle 的
              // 背景不覆盖会用默认 accent-background、dark 下渲染成大白块（用户截图踩过）
              "--rdp-accent-color": "var(--primary)",
              "--rdp-accent-background-color":
                "color-mix(in oklab, var(--primary) 16%, transparent)",
              "--rdp-range_middle-background-color":
                "color-mix(in oklab, var(--primary) 16%, transparent)",
              "--rdp-range_middle-color": "var(--foreground)",
              "--rdp-range_start-background":
                "color-mix(in oklab, var(--primary) 16%, transparent)",
              "--rdp-range_end-background":
                "color-mix(in oklab, var(--primary) 16%, transparent)",
              "--rdp-range_start-color": "var(--primary-foreground)",
              "--rdp-range_end-color": "var(--primary-foreground)",
              "--rdp-range_start-date-background-color": "var(--primary)",
              "--rdp-range_end-date-background-color": "var(--primary)",
              "--rdp-selected-border": "1px solid var(--primary)",
              "--rdp-today-color": "var(--primary)",
              "--rdp-day-height": "30px",
              "--rdp-day-width": "30px",
              "--rdp-day_button-height": "28px",
              "--rdp-day_button-width": "28px",
              fontSize: "12px",
            } as React.CSSProperties
          }
        >
          <DayPicker
            mode="range"
            numberOfMonths={2}
            locale={zhCN}
            selected={
              draft ?? { from: new Date(value.from), to: new Date(value.to) }
            }
            defaultMonth={new Date(value.from)}
            onSelect={(range) => {
              setDraft(range);
              if (range?.from && range.to && range.from.getTime() !== range.to.getTime()) {
                commit(day0(range.from), day0(range.to));
              }
            }}
          />
          <div className="flex flex-wrap gap-1.5 border-t pt-2">
            {presets.map((p) => (
              <Button
                key={p.label}
                size="xs"
                variant="outline"
                className="h-6 px-2 text-xs"
                onClick={() => commit(p.range.from, p.range.to)}
              >
                {p.label}
              </Button>
            ))}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
};
