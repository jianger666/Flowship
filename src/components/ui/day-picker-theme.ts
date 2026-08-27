import type { CSSProperties } from "react";

/** DayPicker 主题变量：必须打在 rdp-root 上，写外层会被库默认值盖掉 */
export const DAY_PICKER_THEME = {
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
} as CSSProperties;
