"use client";

/**
 * 视频进度条：已播 / 已缓冲 / A-B 区间 / 悬停时间 + 缩略图。
 * 指针交互（点击跳转、拖动、悬停）走 use-timeline-pointer，与音频波形共用。
 */

import { useRef, useState } from "react";

import { useTimelinePointer } from "@/components/media/use-timeline-pointer";
import type { AbRange } from "@/lib/media/media-ab";
import { clampNumber, formatClock } from "@/lib/media/media-time";
import type { SeekThumbnail } from "@/components/media/use-seek-thumbnail";
import { cn } from "@/lib/utils";

export type { AbRange };

export interface TimelineProps {
  time: number;
  duration: number;
  ab: AbRange;
  onSeek: (t: number) => void;
  onHoverTime?: (t: number | null) => void;
  onScrubChange?: (scrubbing: boolean) => void;
  thumbnail?: SeekThumbnail | null;
  disabled?: boolean;
}

const pct = (t: number, duration: number): number =>
  duration > 0 ? clampNumber((t / duration) * 100, 0, 100) : 0;

/** A-B 区间的百分比跨度：只有 A 时从 A 到末尾，只有 B 时从开头到 B */
export const abSpan = (ab: AbRange, duration: number): { left: number; width: number } | null => {
  if (ab.a === null && ab.b === null) return null;
  const a = ab.a ?? 0;
  const b = ab.b ?? duration;
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  const left = pct(lo, duration);
  return { left, width: Math.max(0.3, pct(hi, duration) - left) };
};

export const MediaSeekBar = ({
  time,
  duration,
  buffered,
  ab,
  onSeek,
  onHoverTime,
  onScrubChange,
  thumbnail,
  disabled,
}: TimelineProps & { buffered: Array<[number, number]> }) => {
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
  const span = abSpan(ab, duration);
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
        {buffered.map(([s, e], i) => (
          <div
            key={i}
            className="absolute inset-y-0 rounded-full bg-muted-foreground/30"
            style={{ left: `${pct(s, duration)}%`, width: `${Math.max(0, pct(e, duration) - pct(s, duration))}%` }}
          />
        ))}
        {span && (
          <div
            className={cn("absolute -inset-y-0.5 rounded-sm", ab.enabled ? "bg-warning/45" : "bg-warning/25")}
            style={{ left: `${span.left}%`, width: `${span.width}%` }}
          />
        )}
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
