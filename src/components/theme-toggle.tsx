"use client";

/**
 * 主题切换开关（三态：浅色 / 深色 / 跟随系统）
 * - 放顶栏设置按钮旁、点击弹 popover 选主题、当前选项高亮
 * - 触发按钮图标：跟随系统→Monitor、否则跟「生效主题」（dark→Moon / light→Sun）
 * - next-themes 在服务端拿不到主题、mounted 前先渲染占位图标、避免水合不一致
 */

import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { Monitor, Moon, Sun, type LucideIcon } from "lucide-react";

import { buttonVariants } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

// 三个主题选项（value 对应 next-themes 的 theme 字段）
const THEME_OPTIONS: { value: string; label: string; icon: LucideIcon }[] = [
  { value: "light", label: "浅色", icon: Sun },
  { value: "dark", label: "深色", icon: Moon },
  { value: "system", label: "跟随系统", icon: Monitor },
];

export const ThemeToggle = () => {
  // theme = 用户选的（light/dark/system）；resolvedTheme = system 解析后的实际值
  const { theme, setTheme, resolvedTheme } = useTheme();
  // 防 hydration mismatch：服务端无主题信息、挂载后再按真实主题渲染图标
  const [mounted, setMounted] = useState(false);
  // popover 开关
  const [open, setOpen] = useState(false);

  useEffect(() => setMounted(true), []);

  // 触发按钮图标：跟随系统→Monitor、否则跟生效主题
  const TriggerIcon = !mounted
    ? Sun
    : theme === "system"
      ? Monitor
      : resolvedTheme === "dark"
        ? Moon
        : Sun;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label="切换主题"
        className={cn(buttonVariants({ variant: "ghost", size: "icon" }))}
      >
        <TriggerIcon className="size-4.5" />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-40 space-y-0.5 p-1.5">
        {THEME_OPTIONS.map(({ value, label, icon: Icon }) => {
          // 仅在 mounted 后高亮、否则 SSR 会把 system 当默认全亮
          const active = mounted && theme === value;
          return (
            <button
              key={value}
              type="button"
              onClick={() => {
                setTheme(value);
                setOpen(false);
              }}
              className={cn(
                "flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-colors",
                active
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              <Icon className="size-4" />
              <span className="flex-1 text-left">{label}</span>
            </button>
          );
        })}
      </PopoverContent>
    </Popover>
  );
};
