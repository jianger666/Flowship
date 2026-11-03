/**
 * 播放器会话的全局 store（模块级、无 React）。
 *
 * 为什么不是 Context：发起播放的地方遍布各处（行内路径、消息末尾的媒体条、预览入口、右键菜单），
 * 有的在 Virtuoso 的虚拟列表里、有的在 Dialog 里——像 `insertIntoComposer` 一样直接 import 函数最省事；
 * 要跟随状态的（卡片高亮「正在播放」）用 `useSyncExternalStore` 订阅。
 *
 * 会话 = 一组文件（对比组）+ 当前第几个 + 一次「请求」。每次 `openMedia` 都会让 `reqNonce` 加一：
 * 播放器据此区分「同一个文件再点一次（从指定时间重播）」和「没有新请求」。
 */

import { detectMediaKind } from "@/lib/media/media-kind";

export interface MediaItem {
  /** 绝对路径 */
  path: string;
  /** 从这里开始播（秒） */
  start?: number;
  /** 终点（秒）：和 start 一起给时，播到这里就暂停（不循环）；用户手动拖进度即取消 */
  end?: number;
}

export interface PlayerSession {
  items: MediaItem[];
  index: number;
  /** 每次 openMedia 递增 */
  reqNonce: number;
}

export interface PlayerSnapshot {
  session: PlayerSession | null;
  /** 当前正在播放（非暂停）的文件路径；没在播为 null */
  playingPath: string | null;
  /** 当前会话里选中的文件路径（暂停也算）；没有会话为 null */
  currentPath: string | null;
}

const CLOSED: PlayerSnapshot = Object.freeze({
  session: null,
  playingPath: null,
  currentPath: null,
}) as PlayerSnapshot;

let snapshot: PlayerSnapshot = CLOSED;
let nonce = 0;
const listeners = new Set<() => void>();

const emit = (next: PlayerSnapshot) => {
  snapshot = next;
  for (const l of [...listeners]) l();
};

export const getPlayerSnapshot = (): PlayerSnapshot => snapshot;
export const getServerPlayerSnapshot = (): PlayerSnapshot => CLOSED;

export const subscribePlayer = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const sameItems = (a: MediaItem[], b: MediaItem[]): boolean =>
  a.length === b.length && a.every((it, i) => it.path === b[i]!.path);

/** 下标规整：NaN / undefined 当 0，小数向下取整；±Infinity 与越界一样由调用方夹到首 / 尾 */
const toIndex = (v: number | undefined): number =>
  v === undefined || Number.isNaN(v) ? 0 : Math.floor(v);

/**
 * 打开 / 切换播放：
 * - 文件组和现有会话相同 → 只换当前项（播放器不重建）
 * - 否则开新会话
 * 非音视频路径、空列表被丢弃。`index` 指的是传入列表里的位置（过滤之前），越界会夹进范围；
 * 被点的那一项自己被过滤掉时，落到它后面第一个有效项（后面没有就取最后一个）。
 */
export const openMedia = (
  rawItems: MediaItem[],
  opts: { index?: number } = {},
): void => {
  const wanted = toIndex(opts.index);
  const items: MediaItem[] = [];
  // 被点位置之前保留下来的项数 = 被点项（或其后第一个有效项）在过滤后列表里的下标
  let before = 0;
  rawItems.forEach((it, i) => {
    if (!it.path || detectMediaKind(it.path) === null) return;
    if (i < wanted) before += 1;
    items.push(it);
  });
  if (items.length === 0) return;
  const index = Math.min(items.length - 1, before);
  nonce += 1;
  const prev = snapshot.session;
  // 同一组文件：保留会话里已有的各项 start（只覆盖被点的那一项），别因为再点一次就丢掉其它项
  const nextItems = prev && sameItems(prev.items, items)
    ? prev.items.map((it, i) => (i === index ? items[i]! : it))
    : items;
  emit({
    session: { items: nextItems, index, reqNonce: nonce },
    playingPath: snapshot.playingPath,
    currentPath: nextItems[index]!.path,
  });
};

/** 播放器内部切换当前项（对比组切换 / 上一首下一首）：不产生「新请求」语义以外的副作用 */
export const selectMediaIndex = (index: number): void => {
  const s = snapshot.session;
  if (!s || s.items.length === 0) return;
  // NaN 没有「第几个」可言：忽略，别让下面按 NaN 取下标炸掉（±Infinity 照旧夹到首 / 尾）
  if (Number.isNaN(index)) return;
  const next = Math.min(s.items.length - 1, Math.max(0, Math.floor(index)));
  if (next === s.index) return;
  nonce += 1;
  emit({
    session: { items: s.items.map((it, i) => (i === next ? { path: it.path } : it)), index: next, reqNonce: nonce },
    playingPath: snapshot.playingPath,
    currentPath: s.items[next]!.path,
  });
};

/** 播放器上报播放状态（给卡片 / 路径 chip 高亮用） */
export const reportPlaying = (path: string | null): void => {
  if (snapshot.playingPath === path) return;
  emit({ ...snapshot, playingPath: path });
};

export const closeMedia = (): void => {
  if (snapshot === CLOSED) return;
  emit(CLOSED);
};

/** 测试用：回到初始状态 */
export const resetPlayerStoreForTests = (): void => {
  snapshot = CLOSED;
  nonce = 0;
  listeners.clear();
};

