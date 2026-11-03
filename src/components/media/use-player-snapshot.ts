"use client";

import { useSyncExternalStore } from "react";

import { getPlayerSnapshot, subscribePlayer } from "@/lib/media/player-store";

/** 当前正在播放（非暂停）的文件路径；没在播为 null。给卡片 / chip 做「播放中」高亮 */
export const usePlayingMediaPath = (): string | null =>
  useSyncExternalStore(
    subscribePlayer,
    () => getPlayerSnapshot().playingPath,
    () => null,
  );

/** 当前会话选中的文件路径（暂停也算） */
export const useCurrentMediaPath = (): string | null =>
  useSyncExternalStore(
    subscribePlayer,
    () => getPlayerSnapshot().currentPath,
    () => null,
  );
