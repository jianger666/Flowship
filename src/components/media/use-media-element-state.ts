"use client";

/**
 * 把一个 <video> 元素的实时状态镜像成 React state。
 *
 * - 事件驱动 + 播放中用 rAF 补齐进度（`timeupdate` 只有 ~4Hz，进度条会一顿一顿）；
 *   为了不让整棵播放器 60Hz 重渲，进度更新限频到 ~15Hz，状态没变就不 setState。
 * - 元素本身常驻（换文件只改 src），所以事件只绑一次。
 */

import { useEffect, useState, type RefObject } from "react";

export interface MediaErrorInfo {
  kind: "aborted" | "network" | "decode" | "unsupported" | "unknown";
  code: number;
}

export interface MediaElementState {
  time: number;
  duration: number;
  paused: boolean;
  ended: boolean;
  /** 在等数据（缓冲 / 拖进度后加载） */
  waiting: boolean;
  /** 已经拿到元数据（能读时长 / 尺寸） */
  ready: boolean;
  buffered: Array<[number, number]>;
  error: MediaErrorInfo | null;
  videoWidth: number;
  videoHeight: number;
  pip: boolean;
}

export const INITIAL_MEDIA_STATE: MediaElementState = {
  time: 0,
  duration: 0,
  paused: true,
  ended: false,
  waiting: false,
  ready: false,
  buffered: [],
  error: null,
  videoWidth: 0,
  videoHeight: 0,
  pip: false,
};

const ERROR_KINDS: Record<number, MediaErrorInfo["kind"]> = {
  1: "aborted",
  2: "network",
  3: "decode",
  4: "unsupported",
};

const TICK_INTERVAL_MS = 66;

const readBuffered = (v: HTMLVideoElement): Array<[number, number]> => {
  const out: Array<[number, number]> = [];
  const ranges = v.buffered;
  for (let i = 0; i < ranges.length; i++) out.push([ranges.start(i), ranges.end(i)]);
  return out;
};

const sameBuffered = (a: Array<[number, number]>, b: Array<[number, number]>): boolean =>
  a.length === b.length && a.every((r, i) => r[0] === b[i]![0] && r[1] === b[i]![1]);

const read = (v: HTMLVideoElement): MediaElementState => {
  const code = v.error?.code ?? 0;
  const duration = Number.isFinite(v.duration) ? v.duration : 0;
  return {
    time: v.currentTime,
    duration,
    paused: v.paused,
    ended: v.ended,
    // readyState < 3（HAVE_FUTURE_DATA）且在播放意图下 = 在缓冲
    waiting: !v.paused && v.readyState < 3 && v.error === null && !v.ended,
    ready: v.readyState >= 1,
    buffered: readBuffered(v),
    error: code ? { code, kind: ERROR_KINDS[code] ?? "unknown" } : null,
    videoWidth: v.videoWidth,
    videoHeight: v.videoHeight,
    pip: typeof document !== "undefined" && document.pictureInPictureElement === v,
  };
};

const same = (a: MediaElementState, b: MediaElementState): boolean =>
  a.time === b.time &&
  a.duration === b.duration &&
  a.paused === b.paused &&
  a.ended === b.ended &&
  a.waiting === b.waiting &&
  a.ready === b.ready &&
  a.error?.code === b.error?.code &&
  a.videoWidth === b.videoWidth &&
  a.videoHeight === b.videoHeight &&
  a.pip === b.pip &&
  sameBuffered(a.buffered, b.buffered);

const EVENTS = [
  "loadstart",
  "loadedmetadata",
  "loadeddata",
  "durationchange",
  "canplay",
  "play",
  "playing",
  "pause",
  "waiting",
  "stalled",
  "seeking",
  "seeked",
  "progress",
  "timeupdate",
  "ended",
  "error",
  "emptied",
  "resize",
  "enterpictureinpicture",
  "leavepictureinpicture",
] as const;

export const useMediaElementState = (
  ref: RefObject<HTMLVideoElement | null>,
): MediaElementState => {
  const [state, setState] = useState<MediaElementState>(INITIAL_MEDIA_STATE);

  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    let raf = 0;
    let lastTick = 0;

    const sync = () => {
      const next = read(v);
      setState((prev) => (same(prev, next) ? prev : next));
    };
    const tick = (ts: number) => {
      raf = 0;
      if (v.paused) return;
      if (ts - lastTick >= TICK_INTERVAL_MS) {
        lastTick = ts;
        sync();
      }
      raf = requestAnimationFrame(tick);
    };
    const onEvent = () => {
      sync();
      if (!v.paused && raf === 0) raf = requestAnimationFrame(tick);
    };

    for (const e of EVENTS) v.addEventListener(e, onEvent);
    sync();
    if (!v.paused) raf = requestAnimationFrame(tick);
    return () => {
      for (const e of EVENTS) v.removeEventListener(e, onEvent);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [ref]);

  return state;
};
