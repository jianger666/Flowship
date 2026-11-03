"use client";

/**
 * 音频波形：两层 canvas（淡的底 + 实的已播层，已播层用 clip-path 按进度裁），
 * 进度变化只改 CSS，不重画 canvas。A-B 区间叠在上面。
 * 峰值没到之前画一排低矮占位条（布局不跳），指针交互照常可用。
 */

import { useEffect, useRef, useState } from "react";

import { abSpan, type TimelineProps } from "@/components/media/media-seek-bar";
import { useTimelinePointer } from "@/components/media/use-timeline-pointer";
import { clampNumber, formatClock } from "@/lib/media/media-time";
import { cn } from "@/lib/utils";

const BAR_W = 2;
const BAR_GAP = 1;

const drawBars = (
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  peaks: Float32Array | null,
  alpha: number,
) => {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.floor(width * dpr));
  canvas.height = Math.max(1, Math.floor(height * dpr));
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = getComputedStyle(canvas).color;
  ctx.globalAlpha = alpha;
  const barW = BAR_W * dpr;
  const step = (BAR_W + BAR_GAP) * dpr;
  const count = Math.max(1, Math.floor(canvas.width / step));
  const mid = canvas.height / 2;
  for (let i = 0; i < count; i++) {
    let peak: number;
    if (peaks && peaks.length > 0) {
      const from = Math.floor((i / count) * peaks.length);
      const to = Math.max(from + 1, Math.floor(((i + 1) / count) * peaks.length));
      peak = 0;
      for (let k = from; k < to && k < peaks.length; k++) peak = Math.max(peak, peaks[k]!);
    } else {
      // 占位：低矮、略有起伏
      peak = 0.08 + 0.04 * Math.sin(i / 3);
    }
    const h = Math.max(2 * dpr, peak * canvas.height * 0.92);
    ctx.fillRect(i * step, mid - h / 2, barW, h);
  }
};

export const MediaWaveform = ({
  peaks,
  time,
  duration,
  ab,
  onSeek,
  onHoverTime,
  onScrubChange,
  disabled,
}: Omit<TimelineProps, "thumbnail"> & { peaks: Float32Array | null }) => {
  const wrapRef = useRef<HTMLDivElement>(null);
  const baseRef = useRef<HTMLCanvasElement>(null);
  const playedRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!size.w || !size.h) return;
    if (baseRef.current) drawBars(baseRef.current, size.w, size.h, peaks, 0.28);
    if (playedRef.current) drawBars(playedRef.current, size.w, size.h, peaks, 1);
  }, [peaks, size]);

  const { scrubTime, handlers } = useTimelinePointer({
    duration,
    onSeek,
    onScrubChange,
    disabled,
    onHover: (t) => {
      setHover(t);
      onHoverTime?.(t);
    },
  });

  const shown = scrubTime ?? time;
  const progress = duration > 0 ? clampNumber((shown / duration) * 100, 0, 100) : 0;
  const span = abSpan(ab, duration);

  return (
    <div
      ref={wrapRef}
      role="slider"
      aria-label="播放进度（波形）"
      aria-valuemin={0}
      aria-valuemax={Math.round(duration)}
      aria-valuenow={Math.round(shown)}
      aria-valuetext={`${formatClock(shown)} / ${formatClock(duration)}`}
      aria-disabled={disabled || duration <= 0}
      className={cn(
        "relative h-16 w-full touch-none overflow-hidden rounded-md bg-muted/40 text-primary select-none",
        disabled || duration <= 0 ? "cursor-default opacity-60" : "cursor-pointer",
      )}
      {...handlers}
    >
      {span && (
        <div
          className={cn("absolute inset-y-0", ab.enabled ? "bg-warning/25" : "bg-warning/12")}
          style={{ left: `${span.left}%`, width: `${span.width}%` }}
        />
      )}
      <canvas ref={baseRef} className="pointer-events-none absolute inset-0 size-full" />
      <canvas
        ref={playedRef}
        className="pointer-events-none absolute inset-0 size-full"
        style={{ clipPath: `inset(0 ${100 - progress}% 0 0)` }}
      />
      <div
        className="pointer-events-none absolute inset-y-0 w-px bg-primary"
        style={{ left: `${progress}%` }}
      />
      {hover !== null && duration > 0 && (
        <div
          className="pointer-events-none absolute inset-y-0 w-px bg-foreground/40"
          style={{ left: `${clampNumber((hover / duration) * 100, 0, 100)}%` }}
        >
          <span className="absolute top-0 left-1 rounded bg-popover px-1 font-mono text-[11px] tabular-nums text-popover-foreground shadow ring-1 ring-foreground/10">
            {formatClock(hover, { digits: 1 })}
          </span>
        </div>
      )}
    </div>
  );
};
