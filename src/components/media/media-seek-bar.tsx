"use client";

/**
 * 视频进度条：已播 / 悬停时间 + 缩略图。
 * 本地文件没有「缓冲」可言（文件就在本机，随时能 Range 读），所以不画缓冲段——
 * 之前画过，淡淡的一截一截深色看不出含义，反而像 bug。
 * 指针交互（点击跳转、拖动、悬停）走 use-timeline-pointer，与音频波形共用。
 */

import { useRef, useState } from "react";

import { useTimelinePointer } from "@/components/media/use-timeline-pointer";
import { clampNumber, formatClock } from "@/lib/media/media-time";
import type { SeekThumbnail } from "@/components/media/use-seek-thumbnail";
import { cn } from "@/lib/utils";

export interface TimelineProps {
  time: number;
  duration: number;
  onSeek: (t: number) => void;
  onHoverTime?: (t: number | null) => void;
  onScrubChange?: (scrubbing: boolean) => void;
  thumbnail?: SeekThumbnail | null;
  disabled?: boolean;
}

const pct = (t: number, duration: number): number =>
  duration > 0 ? clampNumber((t / duration) * 100, 0, 100) : 0;

export const MediaSeekBar = ({
  time,
  duration,
  onSeek,
  onHoverTime,
  onScrubChange,
  thumbnail,
  disabled,
}: TimelineProps) => {
  const ref = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ t: number; x: number } | null>(null);

  const { scrubTime, handlers } = useTimelinePointer({
    duration,
    onSeek,
    onScrubChange,
    disabled,
    onHover: (t, clientX) => {
      if (t === null) {
        setHover(null);
        onHoverTime?.(null);
        return;
      }
      const rect = ref.current?.getBoundingClientRect();
      setHover({ t, x: rect ? clientX - rect.left : 0 });
      onHoverTime?.(t);
    },
  });

  const shown = scrubTime ?? time;
  const width = ref.current?.clientWidth ?? 0;
  // 悬停气泡水平方向夹在条内，避免贴边时被裁掉
  const half = thumbnail ? thumbnail.width / 2 + 4 : 28;
  const popX = hover ? clampNumber(hover.x, half, Math.max(half, width - half)) : 0;

  return (
    <div
      ref={ref}
      role="slider"
      aria-label="播放进度"
      aria-valuemin={0}
      aria-valuemax={Math.round(duration)}
      aria-valuenow={Math.round(shown)}
      aria-valuetext={`${formatClock(shown)} / ${formatClock(duration)}`}
      aria-disabled={disabled || duration <= 0}
      className={cn(
        "group/seek relative flex h-6 touch-none items-center select-none",
        disabled || duration <= 0 ? "cursor-default opacity-60" : "cursor-pointer",
      )}
      {...handlers}
    >
      <div className="relative h-1 w-full rounded-full bg-muted-foreground/25 transition-[height] duration-100 group-hover/seek:h-1.5">
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-primary"
          style={{ width: `${pct(shown, duration)}%` }}
        />
        <div
          className={cn(
            "pointer-events-none absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary shadow transition-opacity",
            scrubTime !== null ? "opacity-100" : "opacity-0 group-hover/seek:opacity-100",
          )}
          style={{ left: `${pct(shown, duration)}%` }}
        />
      </div>
      {hover && !disabled && duration > 0 && (
        <div
          className="pointer-events-none absolute bottom-full z-20 mb-1.5 -translate-x-1/2 overflow-hidden rounded-md bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10"
          style={{ left: popX }}
        >
          {thumbnail && (
            // 缩略图是 canvas 生成的 data URL，用背景图画（全仓 <img> 入口有守卫，见 markdown-remote-image-ssr）
            <div
              aria-hidden
              className="bg-black bg-cover bg-center"
              style={{ width: thumbnail.width, height: thumbnail.height, backgroundImage: `url(${thumbnail.url})` }}
            />
          )}
          <div className="px-1.5 py-0.5 text-center font-mono text-[11px] tabular-nums">
            {formatClock(hover.t, { digits: 1 })}
          </div>
        </div>
      )}
    </div>
  );
};
