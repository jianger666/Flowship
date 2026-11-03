"use client";

/**
 * 接入系统媒体控制（键盘媒体键 / 控制中心 Now Playing / 耳机按键）。
 * 不支持 `navigator.mediaSession` 的环境整体空操作。
 */

import { useEffect, useRef } from "react";

export interface MediaSessionOptions {
  title: string;
  playing: boolean;
  duration: number;
  position: number;
  rate: number;
  onPlay: () => void;
  onPause: () => void;
  onSeekBy: (seconds: number) => void;
  onSeekTo: (seconds: number) => void;
  onPrev?: () => void;
  onNext?: () => void;
}

export const useMediaSession = (opts: MediaSessionOptions): void => {
  const ref = useRef(opts);
  ref.current = opts;
  const supported = typeof navigator !== "undefined" && "mediaSession" in navigator;

  useEffect(() => {
    if (!supported) return;
    navigator.mediaSession.metadata = new MediaMetadata({ title: opts.title, artist: "Flowship" });
  }, [supported, opts.title]);

  useEffect(() => {
    if (!supported) return;
    navigator.mediaSession.playbackState = opts.playing ? "playing" : "paused";
  }, [supported, opts.playing]);

  useEffect(() => {
    if (!supported || !(opts.duration > 0)) return;
    try {
      navigator.mediaSession.setPositionState({
        duration: opts.duration,
        playbackRate: opts.rate || 1,
        position: Math.min(Math.max(0, opts.position), opts.duration),
      });
    } catch {
      // 个别内核对非法组合抛错：位置状态只是锦上添花
    }
    // 只在播放 / 暂停 / 时长 / 倍速变化时同步，不随每帧进度刷（系统自己会按倍速外推）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supported, opts.duration, opts.rate, opts.playing]);

  const hasPrev = !!opts.onPrev;
  const hasNext = !!opts.onNext;
  useEffect(() => {
    if (!supported) return;
    const ms = navigator.mediaSession;
    const set = (action: MediaSessionAction, handler: MediaSessionActionHandler | null) => {
      try {
        ms.setActionHandler(action, handler);
      } catch {
        // 个别 action 在该内核不支持：忽略
      }
    };
    set("play", () => ref.current.onPlay());
    set("pause", () => ref.current.onPause());
    set("seekbackward", (d) => ref.current.onSeekBy(-(d.seekOffset ?? 10)));
    set("seekforward", (d) => ref.current.onSeekBy(d.seekOffset ?? 10));
    set("seekto", (d) => {
      if (typeof d.seekTime === "number") ref.current.onSeekTo(d.seekTime);
    });
    set("previoustrack", hasPrev ? () => ref.current.onPrev?.() : null);
    set("nexttrack", hasNext ? () => ref.current.onNext?.() : null);
    return () => {
      for (const a of ["play", "pause", "seekbackward", "seekforward", "seekto", "previoustrack", "nexttrack"] as const) {
        set(a, null);
      }
      ms.playbackState = "none";
      ms.metadata = null;
    };
  }, [supported, hasPrev, hasNext]);
};
