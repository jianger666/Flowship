"use client";

/**
 * 任务的「相对路径拼接基准」（= agent 实际工作目录）
 *
 * 谁用：事件流工具块把文件路径渲染成 IDE 跳转链接时，相对路径要拼成绝对路径才能跳。
 *
 * 为什么单独一层、而不是直接读全局任务列表：
 * - `useTaskList()` 的 TaskSummary **不带 workCwd**（hydrateTaskSummary 没这字段、
 *   只有单任务详情的 assembleTask 才算这个计算字段）——拿不到；而且列表 running 时
 *   2s 轮一次、几十个工具块跟着订阅会白重渲。
 * - 所以按 taskId 拉一次单任务详情（`tail=1`：只要 meta，不拉事件正文），
 *   进模块级缓存 + 逐 taskId 订阅：同一任务几十个工具块只发一个请求，
 *   值落地后也只通知用到它的那几行。
 *
 * 按需触发（enabled）：SDK 给的路径**绝大多数是绝对路径**、根本不需要 baseDir，
 * 只有真出现相对路径的块才会去拉——常态下零请求。
 */

import { useCallback, useEffect, useSyncExternalStore } from "react";

import { fetchTask } from "@/lib/task-store";

/** 单任务的 cwd 快照：任务级 + 逐 action 级（action 创建时的 cwd 快照，改仓后老 action 仍准） */
interface TaskCwdEntry {
  workCwd?: string;
  actionCwds: Record<string, string>;
}

/** taskId → cwd 快照；进程内缓存一次就够（cwd 只在改仓 / 切隔离时变，属重开级变更） */
const cwdCache = new Map<string, TaskCwdEntry>();
/** 正在飞的请求：同一任务几十个工具块同时挂载也只发一次 */
const inflight = new Set<string>();
/** taskId → 订阅者（只通知等这个任务的行） */
const listeners = new Map<string, Set<() => void>>();

const subscribeTask = (taskId: string, listener: () => void): (() => void) => {
  let set = listeners.get(taskId);
  if (!set) {
    set = new Set();
    listeners.set(taskId, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(taskId);
  };
};

/**
 * 拉一次任务 cwd 快照。失败也写空条目——不重试刷屏；
 * 拿不到就是拿不到，调用方（路径链接）退化成纯文本即可。
 */
const ensureTaskCwdLoaded = (taskId: string): void => {
  if (!taskId || cwdCache.has(taskId) || inflight.has(taskId)) return;
  inflight.add(taskId);
  void fetchTask(taskId, { tail: 1 })
    .then((task) => {
      const actionCwds: Record<string, string> = {};
      for (const action of task?.actions ?? []) {
        if (action.cwd) actionCwds[action.id] = action.cwd;
      }
      cwdCache.set(taskId, { workCwd: task?.workCwd, actionCwds });
    })
    .catch(() => {
      cwdCache.set(taskId, { actionCwds: {} });
    })
    .finally(() => {
      inflight.delete(taskId);
      listeners.get(taskId)?.forEach((notify) => notify());
    });
};

/**
 * @param enabled 只有真需要（出现相对路径）时才置 true——false 时不发请求
 * @param actionId 有值则优先用该 action 的 cwd 快照（改仓后老 action 的相对路径基准才对）
 */
export const useTaskBaseDir = (
  taskId: string,
  enabled: boolean,
  actionId?: string,
): string | undefined => {
  const subscribe = useCallback(
    (listener: () => void) => subscribeTask(taskId, listener),
    [taskId],
  );
  // 快照返回的是字符串 / undefined（原始值），useSyncExternalStore 用 Object.is 比对、稳定
  const getSnapshot = useCallback(() => {
    const entry = cwdCache.get(taskId);
    if (!entry) return undefined;
    return (actionId ? entry.actionCwds[actionId] : undefined) ?? entry.workCwd;
  }, [taskId, actionId]);

  const baseDir = useSyncExternalStore(subscribe, getSnapshot, () => undefined);

  useEffect(() => {
    if (enabled) ensureTaskCwdLoaded(taskId);
  }, [enabled, taskId]);

  return baseDir;
};
