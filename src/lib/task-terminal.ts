/**
 * R35-5：client TaskTerminalCoordinator（sticky deleted）
 *
 * 进程内唯一 terminal identity：同 taskId 一旦 deleted，迟到的 detail / list /
 * chat mutation 200 一律不得复活 UI。挂 globalThis 防 route-chunk / HMR 分裂。
 *
 * 三个入口只调 `commitTaskDeleted`：
 * 1) SSE `task_deleted` 帧
 * 2) watch 初次/重连 404/410
 * 3) 本 tab DELETE 成功
 */

import {
  rememberSuccessfulDeletedId,
  SUCCESSFUL_DELETED_IDS_MAX,
} from "@/lib/task-list-refresh";

type TaskTerminalStore = {
  /** sticky：同 id 删除后永不因迟到 200 解除 */
  deletedIds: Set<string>;
  /** 每 id 删除世代（同 id 重复 commit 仍递增，便于诊断） */
  generationById: Map<string, number>;
  /** 列表侧订阅：推进 refreshEpoch + 记 successfulDeletedIds + 移除行 */
  listListeners: Set<(taskId: string) => void>;
};

const GLOBAL_KEY = "__feAiFlowTaskTerminalR35" as const;

const getStore = (): TaskTerminalStore => {
  const g = globalThis as typeof globalThis & {
    [GLOBAL_KEY]?: TaskTerminalStore;
  };
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = {
      deletedIds: new Set(),
      generationById: new Map(),
      listListeners: new Set(),
    };
  }
  return g[GLOBAL_KEY];
};

/** R35-5：同 id 是否已进入 deleted terminal（sticky） */
export const isTaskTerminalDeleted = (taskId: string): boolean =>
  getStore().deletedIds.has(taskId);

/** R35-5：读取该 id 的 terminal generation（未删除为 0） */
export const getTaskTerminalGeneration = (taskId: string): number =>
  getStore().generationById.get(taskId) ?? 0;

/**
 * R35-5：原子记 sticky deleted（幂等可重复调用）。
 * 有界淘汰最旧 id，防进程内无限涨。
 */
export const rememberTaskTerminalDeleted = (
  taskId: string,
  maxSize: number = SUCCESSFUL_DELETED_IDS_MAX,
): number => {
  const s = getStore();
  s.deletedIds.add(taskId);
  const nextGen = (s.generationById.get(taskId) ?? 0) + 1;
  s.generationById.set(taskId, nextGen);
  // Set 无插入序保证在所有引擎一致——用 generation Map 键序近似 FIFO 淘汰
  while (s.deletedIds.size > maxSize) {
    const oldest = s.deletedIds.values().next().value;
    if (oldest === undefined) break;
    s.deletedIds.delete(oldest);
    s.generationById.delete(oldest);
  }
  return nextGen;
};

/**
 * R35-5：列表 Provider 注册——commit 时推进 epoch / successfulDeletedIds / 移除行。
 * 返回取消订阅。
 */
export const subscribeTaskTerminalList = (
  listener: (taskId: string) => void,
): (() => void) => {
  const s = getStore();
  s.listListeners.add(listener);
  return () => {
    s.listListeners.delete(listener);
  };
};

/**
 * R35-5：统一 terminal sink——记 sticky + 通知列表侧。
 * 调用方（page / ChatView）自行清 page state / pending / streaming。
 */
export const commitTaskDeleted = (taskId: string): void => {
  if (!taskId) return;
  rememberTaskTerminalDeleted(taskId);
  // 同步通知：与 remember 同临界区语义（单线程事件循环）
  for (const listener of getStore().listListeners) {
    try {
      listener(taskId);
    } catch (err) {
      console.warn("[task-terminal] list listener 异常", err);
    }
  }
};

/**
 * R35-5：提交闸——已 deleted 的 task 快照不得写入 UI。
 * absorbTask / upsertTask / chat mutation 回调共用。
 */
export const canCommitTaskSnapshot = (taskId: string): boolean =>
  !isTaskTerminalDeleted(taskId);

/** 测试专用：清空 sticky / listeners */
export const __resetTaskTerminalForTests = (): void => {
  const s = getStore();
  s.deletedIds.clear();
  s.generationById.clear();
  s.listListeners.clear();
};

/** 测试 / 列表侧：把 id 记入 successfulDeletedIds 的薄封装（与 refresh 过滤对齐） */
export const rememberDeletedIdForList = (
  set: Set<string>,
  id: string,
): void => {
  rememberSuccessfulDeletedId(set, id);
};
