"use client";

/**
 * 媒体文件的「事实」：存不存在 / 多大 / 版本（ETag）——用 HEAD 探测，不开文件流。
 *
 * 为什么要轮询：你的流程是 AI 反复重渲、**同名覆盖**同一个 preview.mp4。播放器开着的时候文件被换掉，
 * 浏览器里放的还是旧内容；这里每几秒问一次 ETag，变了就让播放器提示「文件已更新，重新加载」。
 * 只在窗口可见时轮询，标签页 / 窗口回到前台立刻补一次。
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { localMediaUrl } from "@/lib/media/media-url";

export interface MediaFileInfo {
  ok: boolean;
  status: number;
  size: number;
  /** 强 ETag（带引号原样）；失败时为空串 */
  etag: string;
}

const FAILED = (status: number): MediaFileInfo => ({ ok: false, status, size: 0, etag: "" });

/** HEAD 探测一次。网络层失败（服务没起来）按 status 0 返回，不抛 */
export const fetchMediaInfo = async (
  path: string,
  signal?: AbortSignal,
): Promise<MediaFileInfo> => {
  try {
    const res = await fetch(localMediaUrl(path), { method: "HEAD", cache: "no-store", signal });
    if (!res.ok) return FAILED(res.status);
    return {
      ok: true,
      status: res.status,
      size: Number(res.headers.get("content-length") ?? 0) || 0,
      etag: res.headers.get("etag") ?? "",
    };
  } catch {
    return FAILED(0);
  }
};

/** HEAD 失败时给人看的原因 */
export const describeMediaInfoFailure = (status: number): string => {
  if (status === 404) return "文件不存在，可能已被移动或删除";
  if (status === 400) return "这个路径不能播放（类型不支持或不是本机磁盘路径）";
  if (status === 403) return "没有权限读取这个文件";
  if (status === 0) return "连不上本机服务";
  return `读取失败（HTTP ${status}）`;
};

/** ETag → URL 上的版本戳（去引号，URL 里干净） */
export const versionFromEtag = (etag: string): string => etag.replace(/^W\//, "").replace(/"/g, "");

export const MEDIA_WATCH_INTERVAL_MS = 3000;

/**
 * 监视某个路径的文件事实。`path` 为空 / `enabled` 为 false 时不探测。
 * 返回最新探测结果（路径切换时先回到 null，避免把上一个文件的版本当成新文件的）与手动刷新函数。
 */
export const useMediaFileInfo = (
  path: string | null,
  enabled: boolean,
  intervalMs: number = MEDIA_WATCH_INTERVAL_MS,
): { info: MediaFileInfo | null; refresh: () => Promise<MediaFileInfo | null> } => {
  const [state, setState] = useState<{ path: string; info: MediaFileInfo } | null>(null);
  const pathRef = useRef(path);
  pathRef.current = path;

  const refresh = useCallback(async (): Promise<MediaFileInfo | null> => {
    const p = pathRef.current;
    if (!p) return null;
    const info = await fetchMediaInfo(p);
    // 探测回来时路径已经换了：丢弃
    if (pathRef.current !== p) return null;
    setState((prev) =>
      prev && prev.path === p && prev.info.etag === info.etag && prev.info.status === info.status
        ? prev
        : { path: p, info },
    );
    return info;
  }, []);

  useEffect(() => {
    if (!path || !enabled) return;
    void refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, intervalMs);
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [path, enabled, intervalMs, refresh]);

  return { info: state && state.path === path ? state.info : null, refresh };
};
