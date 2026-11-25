"use client";

/**
 * 订阅收藏夹 store（bookmarks-store.ts）：星标 / 菜单 / 对话框 / 空状态快捷入口共用同一份数据。
 *
 * - `autoLoad`（默认 true）：挂载时若还没加载过（idle）就拉一次；加载过的不重复拉（重拉由调用方在需要时显式 `reload`，比如对话框打开）；
 * - 返回的动作函数是 store 的稳定引用，可放心进 effect 依赖；
 * - 服务端渲染恒为 idle 空快照，水合后自动更新。
 */

import { useEffect, useMemo, useSyncExternalStore } from "react";

import {
  getBookmarksStore,
  IDLE_BOOKMARKS_SNAPSHOT,
  type BookmarksSnapshot,
  type BookmarksStore,
} from "./bookmarks-store";

export interface UseBookmarksResult extends BookmarksSnapshot {
  reload: BookmarksStore["load"];
  add: BookmarksStore["add"];
  remove: BookmarksStore["remove"];
}

export const useBookmarks = ({ autoLoad = true }: { autoLoad?: boolean } = {}): UseBookmarksResult => {
  const store = getBookmarksStore();
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, () => IDLE_BOOKMARKS_SNAPSHOT);

  useEffect(() => {
    if (autoLoad && store.getSnapshot().status === "idle") void store.load();
  }, [autoLoad, store]);

  return useMemo(
    () => ({ ...snapshot, reload: store.load, add: store.add, remove: store.remove }),
    [snapshot, store],
  );
};
