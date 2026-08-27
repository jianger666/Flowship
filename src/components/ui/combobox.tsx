"use client";

/**
 * Combobox = Picker 薄封装（searchable + allowCustom）
 *
 * 给「候选列表 + 允许手填」的字段用（仓库分支等）。底层视觉 / 弹层 / 搜索都走 Picker，
 * 本文件只锁对外 API：options 是 string[]、onValueChange、选中即关、可清空、可手填。
 */

import { useMemo } from "react";

import { Picker } from "@/components/ui/picker";

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
  /** trigger hover 提示（原生 title；新场景请用外层 Tooltip，不要扩大使用） */
  title?: string;
  className?: string;
}

export const Combobox = ({
  value,
  onValueChange,
  options,
  placeholder = "请选择",
  disabled = false,
  loading = false,
  allowCustom = true,
  emptyHint = "无候选",
  title,
  className,
}: ComboboxProps) => {
  const pickerOptions = useMemo(
    () => options.map((o) => ({ value: o, label: o })),
    [options],
  );

  return (
    <Picker
      options={pickerOptions}
      value={value}
      onChange={onValueChange}
      searchable
      allowCustom={allowCustom}
      clearable
      placeholder={placeholder}
      disabled={disabled}
      loading={loading}
      emptyHint={emptyHint}
      title={title}
      className={className}
      searchPlaceholder="搜索或输入自定义选项"
    />
  );
};
