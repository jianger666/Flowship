"use client";

/**
 * diff 右侧的变更块小地图：一条竖带，每个变更块一个色块（位置按行序占比），点击跳到那一块。
 * 只给「粗略定位 + 一眼看出改动分布」用——split 视图折行后行高不等、位置只是近似，
 * 点击后真正的滚动由外层按 DOM 里的块起点（data-block）完成，所以落点是准的。
 *
 * 少于 2 个变更块不渲染（只有一块没什么可导航的）。
 */

import { memo, useMemo } from "react";

import { findChangeBlocks, type DiffRow } from "@/lib/diff/model";
import { cn } from "@/lib/utils";

const TONE: Record<"add" | "del" | "mixed", string> = {
  add: "bg-success",
  del: "bg-destructive",
  mixed: "bg-warning",
};

interface DiffMinimapProps {
  rows: readonly DiffRow[];
  activeBlock: number | null;
  onJump: (block: number) => void;
}

export const DiffMinimap = memo(function DiffMinimap({
  rows,
  activeBlock,
  onJump,
}: DiffMinimapProps) {
  const marks = useMemo(() => {
    const total = Math.max(rows.length, 1);
    return findChangeBlocks(rows).map((b, index) => ({
      index,
      top: (b.start / total) * 100,
      height: ((b.end - b.start) / total) * 100,
      tone: b.adds > 0 && b.dels > 0 ? ("mixed" as const) : b.adds > 0 ? ("add" as const) : ("del" as const),
    }));
  }, [rows]);

  if (marks.length < 2) return null;
  return (
    <div
      role="navigation"
      aria-label="变更块导航"
      className="relative w-3 shrink-0 border-l border-border bg-muted/30"
    >
      {marks.map((m) => (
        <button
          key={m.index}
          type="button"
          // 几百个块就是几百个 Tab 停靠点：键盘用户已有 n / p 跳转，这里只服务鼠标 / 读屏
          tabIndex={-1}
          aria-label={`第 ${m.index + 1} 处改动，共 ${marks.length} 处`}
          onClick={() => onJump(m.index)}
          // 太短的块也要有 3px 高才点得到
          style={{ top: `${m.top}%`, height: `max(${m.height}%, 3px)` }}
          className={cn(
            "absolute inset-x-0.5 cursor-pointer rounded-[1px] hover:brightness-110",
            TONE[m.tone],
            m.index === activeBlock && "ring-1 ring-foreground",
          )}
        />
      ))}
    </div>
  );
});
