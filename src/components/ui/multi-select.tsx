"use client";

/**
 * MultiSelect（V0.5.9 抽出、用户拍板「典型组件就该抽出来」）
 *
 * 形态：复刻 shadcn SelectTrigger 风格的 trigger 按钮、点开 base-ui Popover、内部 checkbox 列表多选。
 *
 * 为什么自己拼：
 *  - shadcn/ui 原生 Select 是单选语义、改造代价大
 *  - base-ui Select 也只单选
 *  - 社区惯例就是 Popover + 自拼列表（cmdk combobox 是同套路、多了搜索框）
 *
 * API：
 *  - generic over T、调用方传 options[] / value[](key) / onChange / getKey
 *  - renderOption(item) 渲染列表项内容（图标、双行 label / sublabel 等由调用方决定）
 *  - renderTrigger(selected) 可选、自定义 trigger 显示已选状态；
 *    不传 → 默认「已选 N 个」或单选时直接调 renderOption
 *  - placeholder：未选时 trigger 显示文案
 *
 * 视觉契约：
 *  - trigger / popup 跟 src/components/ui/select.tsx 的 SelectTrigger / SelectContent 完全对齐
 *  - 不会出现 dialog 内一会儿 shadcn 风一会儿自实现风的漂移
 */

import { useMemo, type ReactNode } from "react";
import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { Check, ChevronDown } from "lucide-react";

import { cn } from "@/lib/utils";

interface MultiSelectProps<T> {
  // 可选项原始对象数组
  options: T[];
  // 已选 key 列表（按用户选中顺序、用于 renderTrigger）
  value: string[];
  onChange: (next: string[]) => void;
  // 取 key（通常是 id / path 之类全局唯一字段）
  getKey: (item: T) => string;
  // 渲染单个列表项内容；checkbox icon 由本组件自带、调用方只管 label 区
  renderOption: (item: T) => ReactNode;
  // trigger 已选状态自定义；不传走默认「已选 N 个」
  renderTrigger?: (selected: T[]) => ReactNode;
  // 未选时 trigger 占位
  placeholder?: ReactNode;
  // popup 宽度跟 trigger 等宽（默认）；若需固定 / 撑开自定
  // 不开 prop、留给以后真的用到再加
}

export const MultiSelect = <T,>({
  options,
  value,
  onChange,
  getKey,
  renderOption,
  renderTrigger,
  placeholder,
}: MultiSelectProps<T>) => {
  // 把已选 key 换回 item、保持选中顺序（点 trigger 时调用方拿到的就是「先选谁后选谁」）
  const selectedItems = useMemo(() => {
    const byKey = new Map(options.map((o) => [getKey(o), o] as const));
    return value
      .map((k) => byKey.get(k))
      .filter((x): x is T => x !== undefined);
  }, [options, value, getKey]);

  const handleToggle = (key: string) => {
    onChange(value.includes(key) ? value.filter((k) => k !== key) : [...value, key]);
  };

  // 默认 trigger 内容：根据已选数量分支
  const defaultTrigger = (selected: T[]): ReactNode => {
    if (selected.length === 0) {
      return (
        <span className="text-muted-foreground">{placeholder ?? "请选择"}</span>
      );
    }
    if (selected.length === 1) return renderOption(selected[0]!);
    return (
      <span className="truncate font-medium">已选 {selected.length} 个</span>
    );
  };

  return (
    <PopoverPrimitive.Root>
      <PopoverPrimitive.Trigger
        render={
          <button
            type="button"
            // 视觉对齐 shadcn SelectTrigger（src/components/ui/select.tsx）
            className={cn(
              "flex h-9 w-full items-center justify-between gap-1.5 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30 dark:hover:bg-input/50",
            )}
          >
            <span className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
              {renderTrigger
                ? renderTrigger(selectedItems)
                : defaultTrigger(selectedItems)}
            </span>
            <ChevronDown className="pointer-events-none size-4 shrink-0 text-muted-foreground" />
          </button>
        }
      />
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Positioner sideOffset={4} className="isolate z-50">
          <PopoverPrimitive.Popup
            // 视觉对齐 shadcn SelectContent、保证 dialog 内多个下拉风格一致
            className={cn(
              "max-h-72 w-(--anchor-width) min-w-72 origin-(--transform-origin) overflow-y-auto rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-hidden",
            )}
          >
            <ul className="flex flex-col gap-0.5">
              {options.map((item) => {
                const key = getKey(item);
                const selected = value.includes(key);
                return (
                  <li key={key}>
                    <button
                      type="button"
                      onClick={() => handleToggle(key)}
                      className={cn(
                        "flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent",
                        selected && "bg-accent/40",
                      )}
                    >
                      <Check
                        className={cn(
                          "mt-0.5 size-4 shrink-0",
                          selected ? "opacity-100" : "opacity-0",
                        )}
                      />
                      <span className="flex min-w-0 flex-1 flex-col items-start gap-0.5 overflow-hidden">
                        {renderOption(item)}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </PopoverPrimitive.Popup>
        </PopoverPrimitive.Positioner>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
};
