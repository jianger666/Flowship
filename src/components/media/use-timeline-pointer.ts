"use client";

/**
 * 进度条 / 波形共用的指针交互：点击跳转、按住拖动（scrub）、悬停报告位置。
 *
 * - 拖动期间 seek 限频到每帧一次（rAF），别让大文件被每个 pointermove 压垮
 * - 拖动期间 UI 用 `scrubTime` 显示指针所在位置（不等视频真的 seek 到那里），手感跟手
 */

import { useCallback, useEffect, useRef, useState, type PointerEvent } from "react";

import { clampNumber } from "@/lib/media/media-time";

export interface TimelinePointerOptions {
  duration: number;
  onSeek: (t: number) => void;
  onHover?: (t: number | null, clientX: number) => void;
  onScrubChange?: (scrubbing: boolean) => void;
  disabled?: boolean;
}

export const useTimelinePointer = ({
  duration,
  onSeek,
  onHover,
  onScrubChange,
  disabled,
}: TimelinePointerOptions) => {
  const [scrubTime, setScrubTime] = useState<number | null>(null);
  const rafRef = useRef(0);
  const pendingRef = useRef<number | null>(null);
  const optsRef = useRef({ duration, onSeek, onHover, onScrubChange });
  optsRef.current = { duration, onSeek, onHover, onScrubChange };

  useEffect(
    () => () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    },
    [],
  );

  const timeAt = useCallback((e: PointerEvent<HTMLElement>): number => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return 0;
    const ratio = clampNumber((e.clientX - rect.left) / rect.width, 0, 1);
    return ratio * optsRef.current.duration;
  }, []);

  const flush = useCallback(() => {
    rafRef.current = 0;
    const t = pendingRef.current;
    pendingRef.current = null;
    if (t !== null) optsRef.current.onSeek(t);
  }, []);

  const scheduleSeek = useCallback(
    (t: number) => {
      pendingRef.current = t;
      if (!rafRef.current) rafRef.current = requestAnimationFrame(flush);
    },
    [flush],
  );

  const onPointerDown = (e: PointerEvent<HTMLElement>) => {
    if (disabled || duration <= 0 || e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const t = timeAt(e);
    setScrubTime(t);
    optsRef.current.onScrubChange?.(true);
    optsRef.current.onSeek(t);
  };

  const onPointerMove = (e: PointerEvent<HTMLElement>) => {
    if (disabled || duration <= 0) return;
    const t = timeAt(e);
    optsRef.current.onHover?.(t, e.clientX);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      setScrubTime(t);
      scheduleSeek(t);
    }
  };

  const endScrub = (e: PointerEvent<HTMLElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    }
    // 松手那一刻补一次精确 seek
    optsRef.current.onSeek(timeAt(e));
    pendingRef.current = null;
    setScrubTime(null);
    optsRef.current.onScrubChange?.(false);
  };

  const onPointerLeave = () => {
    optsRef.current.onHover?.(null, 0);
  };

  return {
    scrubTime,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: endScrub,
      onPointerCancel: endScrub,
      onPointerLeave,
    },
  };
};
