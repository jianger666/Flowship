"use client";

/**
 * 「选中一段正文 → 就地浮出一个小按钮」的公共件。
 *
 * 两处在用、视觉与交互必须同款（所以样式常量 + 逻辑都收在本文件、单一来源）：
 * - 事件流 AI 回复：选中 → 浮「引用」→ 写进输入框草稿
 * - 产物面板正文：选中 → 浮「分享到群」→ 直接分享这一段
 *
 * 交互约定（踩过才有的几条）：
 * - 位置相对**容器**算（容器须是 `relative`）：容器跟着滚动条走，按钮就一直贴着选区
 * - `onMouseDown` 必须 `preventDefault`：否则点按钮时选区先塌陷 → selectionchange 把
 *   按钮 unmount 掉 → 这一下点了个空
 * - `mouseup` 里用 rAF 再读选区：部分浏览器在 mouseup 那一刻 selection 还没 commit
 * - 跨容器选区（anchor / focus 不在同一容器）一律不出按钮
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { cn } from "@/lib/utils";

/** 浮动按钮的位置（相对容器）+ 选中文本（已按 maxLength 截断） */
export interface SelectionFloatState {
  top: number;
  left: number;
  text: string;
}

interface UseSelectionFloatOpts {
  /** 关掉时不检测、并清掉已有的浮动按钮（如「不可发送」态 / 切任务） */
  enabled: boolean;
  /** 选中文本上限；不传 = 不截断 */
  maxLength?: number;
}

/**
 * 选区检测 + 浮动按钮定位。
 * 返回的 `containerRef` 挂在正文容器上（该容器要有 `relative`），
 * `onMouseUp` 挂同一个容器；`enabled=false` 时它是 undefined、不绑监听。
 */
export const useSelectionFloat = ({
  enabled,
  maxLength,
}: UseSelectionFloatOpts) => {
  // 正文容器：选区归属判定 + 按钮定位基准
  const containerRef = useRef<HTMLDivElement>(null);
  // 当前浮动按钮状态；null = 不显示
  const [selection, setSelection] = useState<SelectionFloatState | null>(null);

  /** 收起按钮；dropRange=true 连浏览器选区一起清（点完按钮后不留高亮） */
  const clear = useCallback((dropRange = false) => {
    setSelection(null);
    if (dropRange) window.getSelection()?.removeAllRanges();
  }, []);

  // 能力关掉 → 清掉残留按钮
  useEffect(() => {
    if (!enabled) setSelection(null);
  }, [enabled]);

  // 选区被清空 / 落到容器外 → 藏按钮（出现由 mouseup 负责，这里只做清理）
  useEffect(() => {
    if (!enabled) return;
    const onSelectionChange = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
        setSelection(null);
        return;
      }
      const container = containerRef.current;
      const { anchorNode, focusNode } = sel;
      if (
        !container ||
        !anchorNode ||
        !focusNode ||
        !container.contains(anchorNode) ||
        !container.contains(focusNode)
      ) {
        setSelection(null);
      }
    };
    document.addEventListener("selectionchange", onSelectionChange);
    return () =>
      document.removeEventListener("selectionchange", onSelectionChange);
  }, [enabled]);

  const handleMouseUp = useCallback(() => {
    // rAF：等浏览器把选区 commit 完再读
    requestAnimationFrame(() => {
      const sel = window.getSelection();
      const container = containerRef.current;
      if (!sel || sel.isCollapsed || sel.rangeCount === 0 || !container) {
        setSelection(null);
        return;
      }
      const { anchorNode, focusNode } = sel;
      if (
        !anchorNode ||
        !focusNode ||
        !container.contains(anchorNode) ||
        !container.contains(focusNode)
      ) {
        setSelection(null);
        return;
      }
      const trimmed = sel.toString().trim();
      if (!trimmed) {
        setSelection(null);
        return;
      }
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      setSelection({
        top: rect.top - containerRect.top,
        left: rect.left - containerRect.left + rect.width / 2,
        text:
          maxLength !== undefined && trimmed.length > maxLength
            ? trimmed.slice(0, maxLength)
            : trimmed,
      });
    });
  }, [maxLength]);

  return {
    containerRef,
    selection,
    onMouseUp: enabled ? handleMouseUp : undefined,
    clear,
  };
};

/** 浮动按钮外观：深底浅字小药丸，贴在选区顶部中间（两处共用、别各写一份） */
const SELECTION_FLOAT_CLASS =
  "absolute z-10 flex -translate-x-1/2 -translate-y-full items-center gap-1 " +
  "rounded-md bg-foreground px-2 py-1 text-xs text-background shadow-md " +
  "disabled:cursor-not-allowed disabled:opacity-60";

export const SelectionFloatButton = ({
  state,
  label,
  icon,
  disabled,
  onTrigger,
  className,
}: {
  state: SelectionFloatState;
  /** 按钮文案（同时当 aria-label） */
  label: string;
  icon?: ReactNode;
  disabled?: boolean;
  onTrigger: (text: string) => void;
  className?: string;
}) => (
  <button
    type="button"
    aria-label={label}
    disabled={disabled}
    className={cn(SELECTION_FLOAT_CLASS, className)}
    style={{ top: state.top, left: state.left }}
    // 见文件头：不拦 mousedown 的话选区先塌陷、按钮当场消失
    onMouseDown={(e) => e.preventDefault()}
    onClick={() => onTrigger(state.text)}
  >
    {icon}
    {label}
  </button>
);
