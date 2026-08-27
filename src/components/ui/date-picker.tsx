"use client";

/**
 * 单日日期选择（计划上线日等）
 *
 * 不用原生 type=date：Electron/Chrome 要点右边图标才出日历。
 * 整格可点，弹出 react-day-picker（和甘特 DateRangePicker 同一套）。
 */

import { useState } from "react";
import { DayPicker } from "react-day-picker";
import { zhCN } from "react-day-picker/locale";
import { Calendar } from "lucide-react";
import "react-day-picker/style.css";

import { DAY_PICKER_THEME } from "@/components/ui/day-picker-theme";
import { useFormDisabled } from "@/components/ui/form-context";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

const toYmd = (d: Date): string => {
  const yyyy = String(d.getFullYear()).padStart(4, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
};

const fromYmd = (raw: string): Date | undefined => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return undefined;
  const parsed = new Date(`${raw}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
};

const fmtDisplay = (raw: string): string => {
  const d = fromYmd(raw);
  if (!d) return "";
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
};

export const DatePicker = ({
  value,
  onChange,
  disabled = false,
  invalid = false,
  placeholder = "请选择",
  id,
  className,
}: {
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
  invalid?: boolean;
  placeholder?: string;
  id?: string;
  className?: string;
}) => {
  const formDisabled = useFormDisabled();
  const locked = disabled || formDisabled;
  const [open, setOpen] = useState(false);
  const selected = fromYmd(value);
  const label = fmtDisplay(value);

  return (
    <Popover
      open={locked ? false : open}
      onOpenChange={(next) => {
        if (locked) return;
        setOpen(next);
      }}
    >
      <PopoverTrigger
        render={
          <button
            id={id}
            type="button"
            disabled={locked}
            aria-invalid={invalid || undefined}
            className={cn(
              "flex h-8 w-full min-w-0 items-center justify-between gap-1.5 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none transition-colors",
              "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
              "disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50",
              "aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20",
              "dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
              className,
            )}
          >
            <span
              className={cn(
                "min-w-0 truncate text-left",
                label ? "text-foreground" : "text-muted-foreground",
              )}
            >
              {label || placeholder}
            </span>
            <Calendar className="size-3.5 shrink-0 text-muted-foreground" />
          </button>
        }
      />
      <PopoverContent align="start" className="w-auto p-3">
        <DayPicker
          mode="single"
          locale={zhCN}
          style={DAY_PICKER_THEME}
          selected={selected}
          defaultMonth={selected}
          onSelect={(day) => {
            if (!day) return;
            onChange(toYmd(day));
            setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
};
