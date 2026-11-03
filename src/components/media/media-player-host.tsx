"use client";

/**
 * 播放器宿主：订阅全局播放会话，有会话才懒加载并挂出播放窗。
 * 没人点过音视频时，播放器相关的代码一行都不会下载 / 执行。
 */

import dynamic from "next/dynamic";
import { useSyncExternalStore } from "react";

import {
  getPlayerSnapshot,
  getServerPlayerSnapshot,
  subscribePlayer,
} from "@/lib/media/player-store";

const MediaPlayerDock = dynamic(
  () => import("@/components/media/media-player-dock").then((m) => m.MediaPlayerDock),
  { ssr: false },
);

export const MediaPlayerHost = () => {
  const snap = useSyncExternalStore(subscribePlayer, getPlayerSnapshot, getServerPlayerSnapshot);
  if (!snap.session) return null;
  return <MediaPlayerDock session={snap.session} />;
};
