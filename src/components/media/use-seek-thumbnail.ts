"use client";

/**
 * 进度条悬停缩略图：用一个看不见的第二个 <video> 同源加载同一个文件，悬停到哪就 seek 到哪、画一帧小图。
 *
 * - 第一次悬停才创建（不悬停就一次额外请求都没有），换文件 / 卸载时销毁
 * - 同一时刻只做一次 seek，悬停移动太快时只处理最新的位置（中间的丢掉）
 * - 画到 160px 宽的小 canvas 再转 JPEG data URL，几 KB，不占内存
 */

import { useCallback, useEffect, useRef, useState } from "react";

export interface SeekThumbnail {
  /** 这张图对应的时间（秒） */
  t: number;
  url: string;
  width: number;
  height: number;
}

const THUMB_WIDTH = 160;
const SEEK_TIMEOUT_MS = 1500;

export const useSeekThumbnail = (src: string | null, enabled: boolean) => {
  // 缩略图连同它所属的 src 一起存：换文件后旧图自然不再匹配、读出来就是 null（不用在 effect 里同步清 state）
  const [stored, setStored] = useState<{ src: string; thumb: SeekThumbnail } | null>(null);
  const srcRef = useRef(src);
  srcRef.current = src;
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const pendingRef = useRef<number | null>(null);
  const busyRef = useRef(false);
  const aliveRef = useRef(true);

  const destroy = useCallback(() => {
    const v = videoRef.current;
    if (v) {
      v.removeAttribute("src");
      v.load();
    }
    videoRef.current = null;
    pendingRef.current = null;
    busyRef.current = false;
  }, []);

  // src 变了 / 关闭功能：销毁旧的、清掉缩略图
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      destroy();
    };
  }, [src, enabled, destroy]);

  const process = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      while (pendingRef.current !== null && aliveRef.current) {
        const v = videoRef.current;
        if (!v) break;
        const t = pendingRef.current;
        pendingRef.current = null;
        await new Promise<void>((resolve) => {
          let done = false;
          const finish = () => {
            if (done) return;
            done = true;
            v.removeEventListener("seeked", finish);
            window.clearTimeout(timer);
            resolve();
          };
          const timer = window.setTimeout(finish, SEEK_TIMEOUT_MS);
          v.addEventListener("seeked", finish);
          v.currentTime = t;
        });
        if (!aliveRef.current || videoRef.current !== v) break;
        if (!v.videoWidth || !v.videoHeight) continue;
        const w = THUMB_WIDTH;
        const h = Math.max(1, Math.round((w * v.videoHeight) / v.videoWidth));
        const canvas = (canvasRef.current ??= document.createElement("canvas"));
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) continue;
        ctx.drawImage(v, 0, 0, w, h);
        const owner = srcRef.current;
        if (owner) {
          setStored({
            src: owner,
            thumb: { t, url: canvas.toDataURL("image/jpeg", 0.6), width: w, height: h },
          });
        }
      }
    } finally {
      busyRef.current = false;
    }
  }, []);

  const request = useCallback(
    (t: number) => {
      if (!src || !enabled) return;
      if (!videoRef.current) {
        const v = document.createElement("video");
        v.muted = true;
        v.preload = "auto";
        v.playsInline = true;
        v.src = src;
        videoRef.current = v;
      }
      pendingRef.current = Math.max(0, t);
      void process();
    },
    [src, enabled, process],
  );

  const thumb = stored && stored.src === src ? stored.thumb : null;
  return { thumb, request };
};
