/**
 * 从时间流里点一个音视频入口时，决定「开哪一组、从哪一项、从哪个时间开始」。
 *
 * 同一条消息里出现的多个音视频自动成一个对比组（A/B 对比 mp3 / 前后两版视频是主要场景），
 * 点哪一个就从哪一个开始；时间点 / 区间只作用于被点的那一项。
 */

import { openMedia, type MediaItem } from "@/lib/media/player-store";

export interface MediaTarget {
  absolute: string;
  start?: number;
  end?: number;
}

/** 组 + 被点项 → 播放器入参（纯函数，便于测试）。被点项不在组内 / 没有组 → 单项会话 */
export const buildMediaOpenRequest = (
  group: ReadonlyArray<{ absolute: string }> | null | undefined,
  clicked: MediaTarget,
): { items: MediaItem[]; index: number } => {
  const single = (): { items: MediaItem[]; index: number } => ({
    items: [{ path: clicked.absolute, start: clicked.start, end: clicked.end }],
    index: 0,
  });
  if (!group || group.length < 2) return single();
  const index = group.findIndex((g) => g.absolute === clicked.absolute);
  if (index < 0) return single();
  return {
    items: group.map((g, i) =>
      i === index
        ? { path: g.absolute, start: clicked.start, end: clicked.end }
        : { path: g.absolute },
    ),
    index,
  };
};

export const openMediaInGroup = (
  group: ReadonlyArray<{ absolute: string }> | null | undefined,
  clicked: MediaTarget,
): void => {
  const req = buildMediaOpenRequest(group, clicked);
  openMedia(req.items, { index: req.index });
};
