"use client";

/**
 * Combobox（v0.9.11 抽、可搜索单选下拉 + 自由输入）
 *
 * 给「候选列表 + 允许手填」的字段用（首个场景：仓库分支选择——本地 refs 可能缺远端新分支、
 * 必须留手填兜底）。跟 ModelSelect 同款「trigger + 可搜索 popover」结构、popover 内零嵌套弹层。
 *
 * 行为约定：
 * - 点选 / 选自由输入项 → onValueChange + 关 popover（离散选择、调用方直接落盘）
 * - 值非空时 trigger 右侧显示清空 X（选填字段要能清回空）
 * - 搜索词不在候选里且 allowCustom → 列表底部出「使用 "xxx"」项
 * - loading → 列表区显示加载态（trigger 不动、禁用与否由调用方 disabled 控制）
 */

import { useMemo, useRef, useState } from "react";
import { Check, ChevronDown, CornerDownLeft, Search, X } from "lucide-react";

import { LoadingState } from "@/components/ui/loading-state";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

interface ComboboxProps {
  value: string;
  onValueChange: (next: string) => void;
  options: string[];
  placeholder?: string;
  disabled?: boolean;
  /** 候选加载中（列表区显示加载态） */
  loading?: boolean;
  /** 搜索无匹配时允许把搜索词当值用（默认开） */
  allowCustom?: boolean;
  /** 候选为空（且非 loading）时列表区提示 */
  emptyHint?: string;
  /** trigger hover 提示（对齐原生 Input 的 title 用法） */
  title?: string;
  className?: string;
}

export const Combobox = ({
  value,
  onValueChange,
  options,
  placeholder = "选择…",
  disabled = false,
  loading = false,
  allowCustom = true,
  emptyHint = "无候选",
  title,
  className,
}: ComboboxProps) => {
  // popover 开关（受控）：选中即关、点外 / Esc 关
  const [open, setOpen] = useState(false);
  // 搜索词：大小写不敏感过滤候选、无匹配时兼当自由输入值
  const [query, setQuery] = useState("");
  // 搜索框 ref：打开时自动聚焦、直接敲字过滤
  const searchRef = useRef<HTMLInputElement>(null);

  // 过滤后的候选
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.toLowerCase().includes(q));
  }, [options, query]);

  // 自由输入候选：搜索词非空且不与任何候选精确相同才出（精确命中时选原项即可）
  const customCandidate = useMemo(() => {
    const q = query.trim();
    if (!allowCustom || !q || options.includes(q)) return null;
    return q;
  }, [allowCustom, query, options]);

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) {
      setQuery("");
      // portal 渲染后下一帧再聚焦搜索框（直接 focus 拿不到节点）
      requestAnimationFrame(() => searchRef.current?.focus());
    }
  };

  const pick = (v: string) => {
    onValueChange(v);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger
        render={
          <button
            type="button"
            disabled={disabled}
            title={title}
            // 视觉对齐 shadcn SelectTrigger / ModelSelect trigger
            className={cn(
              "flex h-9 w-full items-center justify-between gap-1.5 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30 dark:hover:bg-input/50",
              className,
            )}
          >
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-left",
                !value && "text-muted-foreground",
              )}
            >
              {value || placeholder}
            </span>
            {value && !disabled ? (
              // 清空按钮：span 模拟（button 不能嵌 button）、拦下事件不透给 trigger
              <span
                role="button"
                tabIndex={-1}
                aria-label="清空"
                onClick={(e) => {
                  e.stopPropagation();
                  onValueChange("");
                }}
                onPointerDown={(e) => e.stopPropagation()}
                className="shrink-0 rounded-sm p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <X className="size-3.5" />
              </span>
            ) : (
              <ChevronDown className="pointer-events-none size-4 shrink-0 text-muted-foreground" />
            )}
          </button>
        }
      />
      <PopoverContent align="start" sideOffset={4} className="w-64 overflow-hidden p-0">
        {/* 搜索框：敲字实时过滤、无匹配时兼当自由输入 */}
        <div className="flex items-center gap-2 border-b px-2.5 py-2">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              // Enter 快捷选中：优先首个过滤命中、其次自由输入值
              if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
              e.preventDefault();
              const target = filtered[0] ?? customCandidate;
              if (target) pick(target);
            }}
            placeholder="搜索或输入…"
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>

        <ul className="max-h-56 overflow-y-auto p-1">
          {loading ? (
            <li className="px-2 py-4">
              <LoadingState variant="inline" label="加载中…" />
            </li>
          ) : (
            <>
              {filtered.map((o) => {
                const selected = o === value;
                return (
                  <li key={o}>
                    <button
                      type="button"
                      onClick={() => pick(o)}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent",
                        selected && "bg-accent/40",
                      )}
                    >
                      <Check
                        className={cn(
                          "size-4 shrink-0",
                          selected ? "opacity-100" : "opacity-0",
                        )}
                      />
                      <span className="min-w-0 flex-1 truncate text-sm">{o}</span>
                    </button>
                  </li>
                );
              })}
              {filtered.length === 0 && !customCandidate && (
                <li className="px-2 py-6 text-center text-xs text-muted-foreground">
                  {query.trim() ? `没有匹配「${query.trim()}」的项` : emptyHint}
                </li>
              )}
              {customCandidate && (
                <li>
                  <button
                    type="button"
                    onClick={() => pick(customCandidate)}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent"
                  >
                    <CornerDownLeft className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate text-sm">
                      使用「{customCandidate}」
                    </span>
                  </button>
                </li>
              )}
            </>
          )}
        </ul>
      </PopoverContent>
    </Popover>
  );
};
