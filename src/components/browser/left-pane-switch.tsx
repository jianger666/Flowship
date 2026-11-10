"use client";

import { memo } from "react";
import { FileText, Globe } from "lucide-react";

import { cn } from "@/lib/utils";
import { useBrowserAvailable } from "./use-browser-session";

export type LeftPaneTab = "artifact" | "browser";

interface LeftPaneSwitchProps {
  value: LeftPaneTab;
  onChange: (tab: LeftPaneTab) => void;
  className?: string;
}

const TABS: ReadonlyArray<{ id: LeftPaneTab; label: string; Icon: typeof FileText }> = [
  { id: "artifact", label: "产物", Icon: FileText },
  { id: "browser", label: "浏览器", Icon: Globe },
];

/**
 * 任务页左栏顶部的「产物 | 浏览器」分段切换。
 * 没有浏览器桥（网页版 / 旧壳）时整个不画：这些用户的任务页应该与改动前一模一样。
 */
export const LeftPaneSwitch = memo(function LeftPaneSwitch({
  value,
  onChange,
  className,
}: LeftPaneSwitchProps) {
  const available = useBrowserAvailable();
  if (!available) return null;
  return (
    <div className={cn("flex shrink-0 items-center border-b px-3 py-1.5", className)}>
      <div
        role="tablist"
        aria-label="左栏内容"
        className="inline-flex items-center gap-0.5 rounded-lg bg-muted p-0.5"
      >
        {TABS.map(({ id, label, Icon }) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={value === id}
            onClick={() => onChange(id)}
            className={cn(
              "inline-flex h-6 items-center gap-1 rounded-md px-2.5 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
              value === id
                ? "bg-background font-medium text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className="size-3.5" aria-hidden />
            {label}
          </button>
        ))}
      </div>
    </div>
  );
});
