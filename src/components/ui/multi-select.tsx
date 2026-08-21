"use client";

/**
 * MultiSelect = Picker 薄封装（multiple）
 *
 * generic over T：调用方传 options / getKey / renderOption，点选 toggle、弹层不关。
 * 视觉和弹层行为统一走 Picker，避免再手写一套 Portal。
 */

import { useMemo, type ReactNode } from "react";

import { Picker } from "@/components/ui/picker";

interface MultiSelectProps<T> {
  // 可选项原始对象数组
  options: T[];
  // 已选 key 列表（按用户选中顺序、用于 renderTrigger）
  value: string[];
  onChange: (next: string[]) => void;
  // 取 key（通常是 id / path 之类全局唯一字段）
  getKey: (item: T) => string;
  // 渲染单个列表项内容；checkbox icon 由 Picker 自带、调用方只管 label 区
  renderOption: (item: T) => ReactNode;
  // trigger 已选状态自定义；不传走默认「已选 N 个」
  renderTrigger?: (selected: T[]) => ReactNode;
  // 未选时 trigger 占位
  placeholder?: ReactNode;
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
  const pickerOptions = useMemo(
    () =>
      options.map((item) => ({
        value: getKey(item),
        label: renderOption(item),
      })),
    [options, getKey, renderOption],
  );

  // 把已选 key 换回 item、保持选中顺序（点 trigger 时调用方拿到的就是「先选谁后选谁」）
  const selectedItems = useMemo(() => {
    const byKey = new Map(options.map((o) => [getKey(o), o] as const));
    return value
      .map((k) => byKey.get(k))
      .filter((x): x is T => x !== undefined);
  }, [options, value, getKey]);

  return (
    <Picker
      multiple
      options={pickerOptions}
      value={value}
      onChange={onChange}
      renderTrigger={() => {
        if (renderTrigger) return renderTrigger(selectedItems);
        if (selectedItems.length === 0) {
          return (
            <span className="text-muted-foreground">
              {placeholder ?? "请选择"}
            </span>
          );
        }
        if (selectedItems.length === 1) return renderOption(selectedItems[0]!);
        return (
          <span className="truncate font-medium">
            已选 {selectedItems.length} 个
          </span>
        );
      }}
    />
  );
};
