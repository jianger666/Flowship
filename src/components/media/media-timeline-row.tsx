"use client";

/**
 * 进度行：`已播时间 ──进度条──总时长`（YouTube / QuickTime 的标准摆法）。
 *
 * 时间放在进度条两端、不挤在按钮排里——窄窗口里按钮排没有地方给一串变长文字，
 * 之前就是时间被截成「0…」。已播时间的宽度按总时长的字数预留（等宽字体 + tabular-nums），
 * 播放时数字跳动不会推着进度条一起抖。
 */

import type { ReactNode } from "react";

import { Tooltip } from "@/components/ui/tooltip";
import { formatClock } from "@/lib/media/media-time";

export const MediaTimelineRow = ({
  time,
  duration,
  isVideo,
  fps,
  onGotoTime,
  children,
}: {
  time: number;
  duration: number;
  isVideo: boolean;
  fps: { value: number; estimated: boolean };
  onGotoTime: () => void;
  /** 进度条 / 波形 */
  children: ReactNode;
}) => {
  const total = formatClock(duration);
  return (
    <div className="flex shrink-0 items-center gap-2 px-3 pt-1.5">
      <Tooltip
        content={
          isVideo
            ? `点击输入时间跳转。帧率 ${fps.value}${fps.estimated ? "（估算）" : "（默认）"}`
            : "点击输入时间跳转"
        }
      >
        <button
          type="button"
          onClick={onGotoTime}
          aria-label="输入时间跳转"
          // 4px = 左右各 px-0.5：border-box 下 minWidth 含内边距，不加会让文字区比 N 个字符窄一点
          style={{ minWidth: `calc(${total.length}ch + 4px)` }}
          className="shrink-0 rounded px-0.5 text-left font-mono text-xs tabular-nums text-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
        >
          {formatClock(time)}
        </button>
      </Tooltip>
      <div className="min-w-0 flex-1">{children}</div>
      <span className="shrink-0 px-0.5 font-mono text-xs tabular-nums text-muted-foreground">{total}</span>
    </div>
  );
};
