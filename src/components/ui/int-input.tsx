"use client";

/**
 * 整数输入（端口 / DB 序号）：编辑中允许留空、失焦才校验 + 回填（S13-16）
 *
 * - 输入过程只改本地文本，不往上抛——原来每次击键就 `Number(v) || 默认值`，
 *   清空想重敲时被立刻塞回默认值
 * - 失焦：留空 → 回填 fallback 并提交；非整数 / 越界 → toast 提示并回退到旧值、不提交
 * - 外部 value 变了（导入 / 重置）→ 同步本地文本
 */

import { useState, type ComponentProps } from "react";
import { toast } from "sonner";

import { Input } from "@/components/ui/input";
import { parseIntField, type IntFieldRange } from "@/lib/int-field";

type IntInputProps = Omit<
  ComponentProps<typeof Input>,
  "type" | "value" | "onChange" | "onBlur" | "min" | "max"
> &
  IntFieldRange & {
    value: number;
    /** 失焦校验通过且值有变化时调用 */
    onCommit: (next: number) => void;
    /** toast 里的字段名，如「端口」 */
    label: string;
  };

export const IntInput = ({
  value,
  onCommit,
  label,
  min,
  max,
  fallback,
  ...props
}: IntInputProps) => {
  // 输入框里的文本（编辑中可为空串）
  const [text, setText] = useState(String(value));
  // 上一次见到的外部 value：变了就把文本同步过去（render 期派生、不用 effect）
  const [seen, setSeen] = useState(value);
  if (seen !== value) {
    setSeen(value);
    setText(String(value));
  }

  // badInput 来自浏览器的 `validity.badInput`：type="number" 里敲了 `22e` 这类无法解析的内容时 `.value` 是空串，
  // 只看文本会把它当成「留空」、静默回填默认值并提交；所以失焦时要把浏览器的判定带进来
  const handleBlur = (badInput: boolean) => {
    const result = parseIntField(text, { min, max, fallback }, { badInput });
    if (result.status === "invalid") {
      toast.warning(`${label}需为 ${min}–${max} 的整数`, {
        id: `int-input-${label}`,
      });
      setText(String(value));
      return;
    }
    setText(String(result.value));
    if (result.value !== value) onCommit(result.value);
  };

  return (
    <Input
      {...props}
      type="number"
      min={min}
      max={max}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={(e) => handleBlur(e.currentTarget.validity.badInput)}
    />
  );
};
