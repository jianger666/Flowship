/**
 * R35-5 / R36-7 / R37-3：client TaskTerminalCoordinator（sticky deleted）
 *
 * 进程内唯一 terminal identity：同 taskId 一旦 deleted，迟到的 detail / list /
 * chat mutation 200 一律不得复活 UI。挂 globalThis 防 route-chunk / HMR 分裂。
 *
 * 三个入口只调 `commitTaskDeleted`：
 * 1) SSE `task_deleted` 帧
 * 2) watch 410，以及「已 hydrate watcher」的 404 not_found（完整物理删除后
 *    journal 已清；证据 unknown 由 server 独立编码为 503，不得走此 sink）
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

/** watch HTTP → visibility 的三类结果 */
export type WatchHttpVisibility = "deleted" | "unavailable" | "retryable";

/**
 * R37-3：分类上下文——404→deleted 只对「已成功 hydrate 的 watcher」安全。
 * 非 watch / 未 hydrate 的 404 仍按 unavailable（不 commit）。
 */
export type ClassifyWatchHttpContext = {
  /** 当前订阅是否从已 hydrate 的 task 启动（useTaskWatch enabled 时恒为 true） */
  hydratedWatcher: boolean;
};

/**
 * R36-7 / R37-3：watch HTTP 状态 → visibility。
 * - 410 = 明确 deleted（可 commit sticky）
 * - 503 = unavailable（journal/tombstone I/O 证据未知；重试、不 commit）
 * - 404 = 已 hydrate watcher → deleted（物理删完 journal 已清）；否则 unavailable
 * - 其它 = 可重试（含 5xx 非 503）
 */
export const classifyWatchHttpStatus = (
  status: number,
  context: ClassifyWatchHttpContext,
): WatchHttpVisibility => {
  if (status === 410) return "deleted";
  if (status === 503) return "unavailable";
  if (status === 404) {
    // 已 hydrate：任务曾存在；server 把证据 unknown 编成 503，故此处 404 = 删干净
    return context.hydratedWatcher ? "deleted" : "unavailable";
  }
  return "retryable";
};

/** 普通网络错 / 非 HTTP 失败的连续重试上限（达则终止 loop） */
export const WATCH_MAX_TRANSIENT_FAILURES = 6;
/** unavailable（503）退避上限——持续重试，不因次数终止 */
export const WATCH_UNAVAILABLE_BACKOFF_CAP_MS = 12_000;
/** 干净断流（无失败）后的重连间隔 */
export const WATCH_CLEAN_RECONNECT_DELAY_MS = 1_000;

/**
 * R37-6 / R38-2：watch 失败后的重连策略（纯函数）。
 *
 * - deleted → 立即终止（由调用方 commit terminal）
 * - unavailable → 只推进 unavailableAttempts（退避 + 只 toast 一次）；不占 transient 预算
 * - retryable（fetch reject 等）→ 只推进 transientFailures；连续达上限后终止
 *
 * R38-2：两类计数独立——长期 503 后一次 fetch reject 不得立刻 terminate_exhausted。
 */
export type WatchReconnectDecision =
  | { action: "terminate_deleted" }
  | {
      action: "terminate_exhausted";
      /** 是否回调 onWatchException */
      notifyException: true;
    }
  | {
      action: "retry";
      delayMs: number;
      nextUnavailableAttempts: number;
      nextTransientFailures: number;
      notifyException: boolean;
      nextUnavailableNotified: boolean;
    };

export const resolveWatchReconnectPolicy = (input: {
  kind: WatchHttpVisibility;
  /** 连续 unavailable（503）次数——仅用于退避与 toast 节流 */
  unavailableAttempts: number;
  /** 连续 transient/retryable 次数——达上限才 terminate_exhausted */
  transientFailures: number;
  /** unavailable 是否已提示过一次（避免 toast 刷屏） */
  unavailableNotified: boolean;
}): WatchReconnectDecision => {
  if (input.kind === "deleted") {
    return { action: "terminate_deleted" };
  }

  if (input.kind === "unavailable") {
    // R37-6 / R38-2：503 活着重试；不推进 transientFailures
    const nextUnavailableAttempts = input.unavailableAttempts + 1;
    const delayMs = Math.min(
      nextUnavailableAttempts * 1500,
      WATCH_UNAVAILABLE_BACKOFF_CAP_MS,
    );
    const notifyException =
      nextUnavailableAttempts >= WATCH_MAX_TRANSIENT_FAILURES &&
      !input.unavailableNotified;
    return {
      action: "retry",
      delayMs,
      nextUnavailableAttempts,
      nextTransientFailures: input.transientFailures,
      notifyException,
      nextUnavailableNotified: input.unavailableNotified || notifyException,
    };
  }

  // 普通网络错 / 其它 retryable：只计 transient；达上限终止
  const nextTransientFailures = input.transientFailures + 1;
  const delayMs = Math.min(
    nextTransientFailures * 1500,
    WATCH_UNAVAILABLE_BACKOFF_CAP_MS,
  );
  if (nextTransientFailures >= WATCH_MAX_TRANSIENT_FAILURES) {
    return { action: "terminate_exhausted", notifyException: true };
  }
  return {
    action: "retry",
    delayMs,
    nextUnavailableAttempts: input.unavailableAttempts,
    nextTransientFailures,
    notifyException: false,
    nextUnavailableNotified: input.unavailableNotified,
  };
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
