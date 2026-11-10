"use client";

/**
 * 侧栏右缘的拖动手柄：拖动调宽、拖到很窄自动收起、收起态从左缘拖出来展开、双击复位、键盘调整。
 *
 * 为什么不用 react-resizable-panels：侧栏在 AppShell 里和主区是两个独立的 flex 子元素，
 * 主区内部各页还有自己的分栏组（任务页 / 对话页）；把整个应用套进一个 Group 会让每页的 Group 嵌套、
 * 折叠 / 宽度记忆也要和页型默认值（设置页默认收）搅在一起。这里只是一根 6px 的命中条 + 纯函数
 * （lib/sidebar-width：夹取 / 收起阈值 / 键盘），行为都能单测。
 *
 * 布局：零宽包裹（不占位）+ 绝对定位的命中条，骑在侧栏与主区的交界上，主区位置不受影响。
 * 浏览器的原生视图（WebContentsView）跟着主区位置走（ResizeObserver 见 browser-viewport），
 * 拖动期间鼠标按下发生在本元素上，macOS / Windows 的拖动事件始终投递给按下的那个视图，不会被原生视图截走。
 */

import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";
import {
  SIDEBAR_MIN_WIDTH,
  resolveSidebarDrag,
  resolveSidebarKey,
  type SidebarDragResult,
} from "@/lib/sidebar-width";

interface SidebarResizeHandleProps {
  open: boolean;
  /** 展开时的当前宽度（px），用于抓取偏移与 aria-valuenow */
  width: number;
  /** 当前能拖到的最大宽度（px），仅用于 aria-valuemax（随窗口宽度变，由 AppShell 算好传入） */
  maxWidth: number;
  /** 拖动 / 键盘产生的新状态；width 为 null = 不改宽度 */
  onChange: (next: SidebarDragResult) => void;
  /**
   * 调整开始 / 结束：开始时关侧栏的宽度过渡；结束（含键盘调整后：键盘没有「松手」，每次按键即结束）
   * 由调用方把宽度落盘
   */
  onResizingChange: (resizing: boolean) => void;
  /** 双击：复位默认宽度并展开 */
  onReset: () => void;
}

interface DragState {
  pointerId: number;
  /** 容器（侧栏所在的整行）左缘相对视口的 px */
  rowLeft: number;
  /** 按下时指针相对「分隔条位置」的偏移：拖动中扣掉它，分隔条才不会在按下的一瞬间跳几像素 */
  grabOffset: number;
  containerWidth: number;
}

export const SidebarResizeHandle = ({
  open,
  width,
  maxWidth,
  onChange,
  onResizingChange,
  onReset,
}: SidebarResizeHandleProps) => {
  const handleRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const [dragging, setDragging] = useState(false);

  // 拖动期间全局光标 / 禁选：指针移出命中条后光标不该变回箭头、划过的文字不该被选中
  useEffect(() => {
    if (!dragging) return;
    const { cursor, userSelect } = document.body.style;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    return () => {
      document.body.style.cursor = cursor;
      document.body.style.userSelect = userSelect;
    };
  }, [dragging]);

  const containerWidth = () => handleRef.current?.parentElement?.parentElement?.clientWidth ?? null;

  const endDrag = () => {
    if (!dragRef.current) return;
    dragRef.current = null;
    setDragging(false);
    onResizingChange(false);
  };

  return (
    <div className="relative z-20 w-0 shrink-0">
      <div
        ref={handleRef}
        role="separator"
        aria-orientation="vertical"
        aria-label="调整侧栏宽度（拖动、方向键，双击复位，回车收起 / 展开）"
        aria-valuenow={open ? width : 0}
        aria-valuemin={open ? SIDEBAR_MIN_WIDTH : 0}
        aria-valuemax={maxWidth}
        tabIndex={0}
        // 展开态骑在交界线上（左 2px 右 4px）；收起态交界就是窗口左缘，只往右伸，别在窗口外留一截
        className={cn(
          "group absolute inset-y-0 w-1.5 cursor-col-resize touch-none outline-none",
          open ? "-left-0.5" : "left-0",
        )}
        onPointerDown={(e) => {
          // 只认主键；右键菜单会吞掉 pointerup，把拖动卡在进行态
          if (e.button !== 0 || dragRef.current) return;
          const row = handleRef.current?.parentElement?.parentElement;
          if (!row) return;
          const rowRect = row.getBoundingClientRect();
          e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
          dragRef.current = {
            pointerId: e.pointerId,
            rowLeft: rowRect.left,
            grabOffset: e.clientX - (rowRect.left + (open ? width : 0)),
            containerWidth: rowRect.width,
          };
          setDragging(true);
          onResizingChange(true);
        }}
        onPointerMove={(e) => {
          const drag = dragRef.current;
          if (!drag || drag.pointerId !== e.pointerId) return;
          onChange(
            resolveSidebarDrag(e.clientX - drag.grabOffset - drag.rowLeft, drag.containerWidth),
          );
        }}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
        onDoubleClick={onReset}
        onKeyDown={(e) => {
          const next = resolveSidebarKey(e.key, { open, width }, containerWidth());
          if (!next) return;
          e.preventDefault();
          onChange(next);
          onResizingChange(false);
        }}
      >
        <span
          aria-hidden
          className={cn(
            "pointer-events-none absolute inset-y-0 left-px w-0.5 transition-colors",
            dragging
              ? "bg-primary"
              : "bg-transparent group-hover:bg-primary/40 group-focus-visible:bg-primary/60",
          )}
        />
      </div>
    </div>
  );
};
