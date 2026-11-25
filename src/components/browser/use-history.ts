"use client";

/**
 * 订阅地址栏记忆 store（history-store.ts）：联想下拉 / 敲网址成功后的记录 / 「清除浏览历史」共用同一份数据。
 *
 * - `autoLoad`（默认 false）：历史只有「地址栏要出联想」时才用得上，所以默认不在挂载时拉——
 *   由调用方在地址栏获得焦点时显式 `reload`（后台刷新，失败保留陈旧列表）；
 * - 返回的动作函数是 store 的稳定引用，可放心进 effect 依赖；
 * - 服务端渲染恒为 idle 空快照，水合后自动更新。
 */

import { useEffect, useMemo, useSyncExternalStore } from "react";

import { getHistoryStore, IDLE_HISTORY_SNAPSHOT, type HistorySnapshot, type HistoryStore } from "./history-store";

export interface UseHistoryResult extends HistorySnapshot {
  reload: HistoryStore["load"];
  record: HistoryStore["record"];
  remove: HistoryStore["remove"];
  clear: HistoryStore["clear"];
}

export const useHistory = ({ autoLoad = false }: { autoLoad?: boolean } = {}): UseHistoryResult => {
  const store = getHistoryStore();
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, () => IDLE_HISTORY_SNAPSHOT);

  useEffect(() => {
    if (autoLoad && store.getSnapshot().status === "idle") void store.load();
  }, [autoLoad, store]);

  return useMemo(
    () => ({ ...snapshot, reload: store.load, record: store.record, remove: store.remove, clear: store.clear }),
    [snapshot, store],
  );
};
