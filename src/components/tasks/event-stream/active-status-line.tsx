"use client";

/**
 * 运行中粘性状态行（CHAT-REDESIGN Batch B）
 *
 * Composer 上方一行：当前步骤 label + 可选 detail。
 * globals.css 无现成 shimmer keyframes，本组件内联 @keyframes，避免为单行动画改全局。
 * 纯展示、无内部状态；Batch C 接线挂 Composer。
 */

import type { ActiveStatus } from "@/lib/chat-turns";
import { cn } from "@/lib/utils";

/** 组件级 keyframes 名：避免与全局动画撞名 */
const SHIMMER_ANIM = "active-status-shimmer";

export const ActiveStatusLine = ({ status }: { status: ActiveStatus }) => (
  <div className="flex h-7 min-w-0 items-center gap-2 px-1 text-xs">
    {/* 内联 keyframes：globals 无 shimmer，不改全局文件 */}
    <style>{`
      @keyframes ${SHIMMER_ANIM} {
        0% { background-position: 200% center; }
        100% { background-position: -200% center; }
      }
    `}</style>
    {/* 左侧动效点：细小脉冲，不抢 label shimmer */}
    <span
      className="size-1.5 shrink-0 rounded-full bg-foreground/50 animate-pulse"
      aria-hidden
    />
    <span
      className={cn(
        "shrink-0 bg-gradient-to-r from-muted-foreground via-foreground to-muted-foreground",
        "bg-[length:200%_100%] bg-clip-text text-transparent",
      )}
      style={{ animation: `${SHIMMER_ANIM} 2s linear infinite` }}
    >
      {status.label}
    </span>
    {status.detail ? (
      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground/70">
        {status.detail}
      </span>
    ) : null}
  </div>
);
