"use client";

/**
 * Combobox = Picker 薄封装（searchable + 可选手填）
 *
 * 给「候选列表 + 可搜索」的字段用（仓库分支、环境名等）。底层视觉 / 弹层 / 搜索都走 Picker，
 * 本文件只锁对外 API：options 是 string[]、onValueChange、选中即关、可清空。
 *
 * 默认不许造新值——搜不到就提示没有匹配，不要出「使用「xxx」」。
 * 环境字段这类需要手填的调用方显式传 allowCustom。
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
  /** 搜索无匹配时允许把搜索词当值用（出「使用「xxx」」行）。分支字段不要开。 */
  allowCustom?: boolean;
  /** 候选为空（且非 loading）时列表区提示 */
  emptyHint?: string;
  /** trigger hover 提示（原生 title；新场景请用外层 Tooltip，不要扩大使用） */
  title?: string;
  className?: string;
  /** 打在包 trigger 的那层。flex 行里跟固定宽 label 并排必须传 `w-auto min-w-0 flex-1` */
  wrapperClassName?: string;
}

export const Combobox = ({
  value,
  onValueChange,
  options,
  placeholder = "请选择",
  disabled = false,
  loading = false,
  allowCustom = false,
  emptyHint = "无候选",
  title,
  className,
  wrapperClassName,
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
      wrapperClassName={wrapperClassName}
      searchPlaceholder={allowCustom ? "搜索或输入自定义选项" : "搜索…"}
    />
  );
};
