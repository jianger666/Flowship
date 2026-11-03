"use client";

/**
 * 媒体卡片的懒加载元数据：HEAD 拿大小 / ETag → 命中缓存直接用 → 否则排队用离屏 <video> 取时长和封面。
 * 不依赖 ffmpeg；只用浏览器自己的解码器（和播放器同一套，能出封面就一定能播）。
 */

import { useEffect, useState } from "react";

import {
  createLimiter,
  createMediaCardCache,
  mediaCardCacheKey,
  posterSeekTime,
  type MediaCardMeta,
  type MediaCardMetaReady,
} from "@/lib/media/media-card-cache";
import type { MediaKind } from "@/lib/media/media-kind";
import { localMediaUrl } from "@/lib/media/media-url";
import {
  describeMediaInfoFailure,
  fetchMediaInfo,
  versionFromEtag,
} from "@/components/media/use-media-file-info";

const POSTER_WIDTH = 240;
const METADATA_TIMEOUT_MS = 10_000;
const SEEK_TIMEOUT_MS = 4_000;

const cache = createMediaCardCache();
const limiter = createLimiter(2);

const once = (target: HTMLMediaElement, event: string, timeoutMs: number): Promise<"event" | "timeout" | "error"> =>
  new Promise((resolve) => {
    let done = false;
    const finish = (r: "event" | "timeout" | "error") => {
      if (done) return;
      done = true;
      window.clearTimeout(timer);
      target.removeEventListener(event, onEvent);
      target.removeEventListener("error", onError);
      resolve(r);
    };
    const onEvent = () => finish("event");
    const onError = () => finish("error");
    const timer = window.setTimeout(() => finish("timeout"), timeoutMs);
    target.addEventListener(event, onEvent);
    target.addEventListener("error", onError);
  });

const loadMeta = async (
  path: string,
  kind: MediaKind,
  version: string,
  size: number,
): Promise<MediaCardMetaReady | { status: "error"; reason: string }> => {
  const v = document.createElement("video");
  v.preload = "metadata";
  v.muted = true;
  v.playsInline = true;
  try {
    const metaWait = once(v, "loadedmetadata", METADATA_TIMEOUT_MS);
    v.src = localMediaUrl(path, version);
    const r = await metaWait;
    if (r === "error") return { status: "error", reason: "浏览器解码不了这个文件（格式 / 编码不支持，或文件还没写完）" };
    if (r === "timeout") return { status: "error", reason: "读取元数据超时" };
    const duration = Number.isFinite(v.duration) ? v.duration : 0;
    const out: MediaCardMetaReady = { status: "ready", duration, size };
    if (kind !== "video" || !v.videoWidth || !v.videoHeight) return out;
    out.width = v.videoWidth;
    out.height = v.videoHeight;
    const target = posterSeekTime(duration);
    if (target > 0) {
      const seeked = once(v, "seeked", SEEK_TIMEOUT_MS);
      v.currentTime = target;
      await seeked;
    } else {
      // 不用跳：等第一帧可画
      await once(v, "loadeddata", SEEK_TIMEOUT_MS);
    }
    try {
      const w = POSTER_WIDTH;
      const h = Math.max(1, Math.round((w * v.videoHeight) / v.videoWidth));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.drawImage(v, 0, 0, w, h);
        out.poster = canvas.toDataURL("image/jpeg", 0.72);
      }
    } catch {
      // 取帧失败只是没封面，不影响时长
    }
    return out;
  } finally {
    v.removeAttribute("src");
    v.load();
  }
};

/**
 * @param enabled 进入视口后才为 true（懒加载）
 */
export const useMediaCardMeta = (path: string, kind: MediaKind, enabled: boolean): MediaCardMeta => {
  const [slot, setSlot] = useState<{ path: string; meta: MediaCardMeta }>({
    path,
    meta: { status: "loading" },
  });

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const ac = new AbortController();
    void (async () => {
      const info = await fetchMediaInfo(path, ac.signal);
      if (cancelled) return;
      if (!info.ok) {
        setSlot({ path, meta: { status: "error", reason: describeMediaInfoFailure(info.status) } });
        return;
      }
      const key = mediaCardCacheKey(path, info.etag);
      const hit = cache.get(key);
      if (hit) {
        setSlot({ path, meta: hit });
        return;
      }
      const result = await limiter.run(() => loadMeta(path, kind, versionFromEtag(info.etag), info.size));
      if (cancelled) return;
      if (result.status === "ready") cache.set(key, result);
      setSlot({ path, meta: result });
    })();
    return () => {
      cancelled = true;
      ac.abort();
    };
  }, [path, kind, enabled]);

  return slot.path === path ? slot.meta : { status: "loading" };
};
