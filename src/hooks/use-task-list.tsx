"use client";

/**
 * 全局任务列表 store（V0.8 侧栏导航）
 *
 * 为什么要：侧栏常驻 + 各页面（欢迎页 / 详情页）都读同一份任务列表、
 * 且新建 / 删除 / 状态变化要统一同步——不能侧栏一份、页面一份、各拉各的导致漂移。
 *
 * 提供：
 *  - tasks / loaded：列表 + 首次加载完成标记
 *  - refresh()：重新拉服务端列表（轻量 TaskSummary[]、N×1 IO）
 *  - upsertTask(task)：单条插入 / 更新（新建任务后即时插入、不等下次 refresh；
 *    详情页基本信息变化时同步侧栏状态点）
 *  - removeTask(id)：单条移除（删除任务乐观更新）
 *  - deletingIds / deleteTaskById：删除链路单一来源——锁 id 防双击、
 *    pendingDeletes 过滤 refresh 防「幽灵回魂」、404 当幂等成功
 *
 * 刷新时机：mount 一次 + 窗口重新聚焦（focus）时——多任务并行，切回 app 拿最新态。
 * 外加「条件轮询」：仅当列表里存在 running 任务时、每 POLL_INTERVAL_MS 刷一次、全跑完即停。
 * 这样切到 B 时、后台还在跑的 A 跑完几秒内侧栏就更新（停转圈 / 变成等你回复点）。
 * 没有任务在跑时不轮询、不浪费。
 *
 * refresh 请求 epoch + successfulDeletedIds——DELETE 200 后迟到的旧 refresh
 * 不得整表覆盖回灌；pendingDeletes 在 unmark 后为空，单靠它挡不住交叉时序。
 *
 * 订阅 TaskTerminalCoordinator——SSE task_deleted / watch 404·410 /
 * 本 tab DELETE 成功都走 commitTaskDeleted，推进 epoch + 记 sticky id。
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { getSettings } from "@/lib/local-store";
import {
  deleteTask as deleteTaskApi,
  fetchTasks,
  type DeleteTaskResult,
} from "@/lib/task-store";
import {
  canCommitTaskListRefresh,
  filterTaskListAfterRefresh,
  rememberSuccessfulDeletedId,
} from "@/lib/task-list-refresh";
import {
  canCommitTaskSnapshot,
  commitTaskDeleted,
  isTaskTerminalDeleted,
  subscribeTaskTerminalList,
} from "@/lib/task-terminal";
import type { Task, TaskSummary } from "@/lib/types";

interface TaskListContextValue {
  tasks: TaskSummary[];
  loaded: boolean;
  refresh: () => Promise<void>;
  upsertTask: (task: Task | TaskSummary) => void;
  removeTask: (id: string) => void;
  /** 正在删除中的 id（侧栏删除按钮 disabled） */
  deletingIds: ReadonlySet<string>;
  /**
   * 统一删除：锁 id → 乐观移除 →（可选 onLocked，如立刻离开详情页）→ DELETE。
   * 成功或 404 都返结果；非 404 错误抛出（调用方 toast + refresh）。
   */
  deleteTaskById: (
    id: string,
    options?: { onLocked?: () => void },
  ) => Promise<DeleteTaskResult>;
}

const TaskListContext = createContext<TaskListContextValue | null>(null);

// 条件轮询间隔：仅当有任务在跑时生效（本地读 meta.json 很轻、2s 兼顾实时与开销）
const POLL_INTERVAL_MS = 2000;

// Task（完整）→ TaskSummary：派生 actionCount / lastAction* / hasPendingAsk，剔除 events / actions / pendingAskId
// （避免把可能很大的 events 数组带进侧栏列表）。本身已是 Summary 则原样返回。
const toSummary = (task: Task | TaskSummary): TaskSummary => {
  if ("actionCount" in task) return task;
  const { events, actions, pendingAskId, ...rest } = task;
  void events; // 仅为从 rest 中剔除、不入列表
  const last = actions[actions.length - 1];
  return {
    ...rest,
    actionCount: actions.length,
    lastActionType: last?.type,
    lastActionStatus: last?.status,
    hasPendingAsk: !!pendingAskId,
  };
};

export const TaskListProvider = ({ children }: { children: ReactNode }) => {
  // 任务列表（原始顺序、排序 / 分组在消费方做）
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  // 首次加载完成——侧栏 loading 占位用
  const [loaded, setLoaded] = useState(false);
  // 删除中 id（驱动按钮 disabled；与 ref 同步，ref 给 refresh/upsert 同步读）
  const [deletingIds, setDeletingIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  // pendingDeletes：DELETE 等待窗口内（running 可等 8s）refresh 不得把任务加回
  const pendingDeletesRef = useRef<Set<string>>(new Set());
  // refresh 请求世代——DELETE 成功时推进，作废任何更早启动的在飞 refresh
  const refreshEpochRef = useRef(0);
  // 已成功删除 id（进程内有界 Set）——过滤迟到 refresh 里残留的已删任务
  const successfulDeletedIdsRef = useRef<Set<string>>(new Set());

  const markDeleting = useCallback((id: string) => {
    pendingDeletesRef.current.add(id);
    setDeletingIds(new Set(pendingDeletesRef.current));
  }, []);

  const unmarkDeleting = useCallback((id: string) => {
    pendingDeletesRef.current.delete(id);
    setDeletingIds(new Set(pendingDeletesRef.current));
  }, []);

  const refresh = useCallback(async () => {
    // 捕获发起时 epoch；响应到达时若已推进则整响应丢弃
    const startEpoch = refreshEpochRef.current;
    try {
      const list = await fetchTasks();
      if (!canCommitTaskListRefresh(startEpoch, refreshEpochRef.current)) {
        return;
      }
      // 再滤 sticky terminal（跨 tab task_deleted 与 epoch 双保险）
      setTasks(
        filterTaskListAfterRefresh(
          list,
          pendingDeletesRef.current,
          successfulDeletedIdsRef.current,
        ).filter((t) => !isTaskTerminalDeleted(t.id)),
      );
    } catch (err) {
      // 侧栏静默（不 toast 刷屏）；首页 / 详情页自己的拉取会暴露错误
      console.warn("[task-list] 刷新失败", err);
    } finally {
      // 过期 refresh 仍可标记 loaded（首次 mount 不应被 DELETE 卡死）
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 统一 terminal sink 的列表侧——推进 epoch、记 successfulDeletedId、移除行
  useEffect(() => {
    return subscribeTaskTerminalList((id) => {
      refreshEpochRef.current += 1;
      rememberSuccessfulDeletedId(successfulDeletedIdsRef.current, id);
      setTasks((prev) => prev.filter((t) => t.id !== id));
      // DELETE 进行中时一并解除 pending 锁（幂等）
      if (pendingDeletesRef.current.has(id)) {
        pendingDeletesRef.current.delete(id);
        setDeletingIds(new Set(pendingDeletesRef.current));
      }
    });
  }, []);

  // 窗口重新聚焦时同步一次（切回 app 拿其它任务的最新状态）
  useEffect(() => {
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  // 有没有任务在跑——条件轮询的开关（值只在 false↔true 切换时才重启 interval）
  const hasRunning = useMemo(
    () => tasks.some((t) => t.runStatus === "running"),
    [tasks],
  );

  // 飞书桥接开启时：服务端可能随时被飞书消息唤醒（新建对话 / 注入消息），
  // 客户端没有任何触发点——窗口不聚焦列表就一直陈旧（2026-07-19 用户双屏实测）。
  // 桥接用户常态轮询兜底；未开桥接保持原「仅 running 时轮询」的省电策略。
  // getSettings 是同步缓存读，每次渲染取一次即可（开关切换后 focus/refresh 自然带动重渲染）
  const bridgeOn = getSettings().feishuChatBridge === true;

  // 条件轮询：存在 running 任务、或飞书桥接开启时定时刷新
  useEffect(() => {
    if (!hasRunning && !bridgeOn) return;
    const timer = setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [hasRunning, bridgeOn, refresh]);

  const upsertTask = useCallback((task: Task | TaskSummary) => {
    const summary = toSummary(task);
    // sticky terminal / 删除中 / 已成功删除——禁止回灌复活
    if (!canCommitTaskSnapshot(summary.id)) return;
    if (pendingDeletesRef.current.has(summary.id)) return;
    if (successfulDeletedIdsRef.current.has(summary.id)) return;
    setTasks((prev) => {
      const idx = prev.findIndex((t) => t.id === summary.id);
      if (idx < 0) return [summary, ...prev];
      const next = [...prev];
      next[idx] = summary;
      return next;
    });
  }, []);

  const removeTask = useCallback((id: string) => {
    setTasks((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const deleteTaskById = useCallback(
    async (
      id: string,
      options?: { onLocked?: () => void },
    ): Promise<DeleteTaskResult> => {
      // 已在删：幂等短路，避免双击连发两次 DELETE
      if (pendingDeletesRef.current.has(id)) return "ok";
      // 已 sticky deleted → 幂等成功
      if (isTaskTerminalDeleted(id)) return "ok";
      markDeleting(id);
      removeTask(id);
      // 锁定后立刻回调（侧栏用来离开当前详情，避免 upsertTask 回灌）
      options?.onLocked?.();
      try {
        const result = await deleteTaskApi(id);
        // ok / not_found 都算成功
        // 走统一 sink（推进 epoch + sticky + 列表移除）
        commitTaskDeleted(id);
        unmarkDeleting(id);
        return result;
      } catch (err) {
        unmarkDeleting(id);
        throw err;
      }
    },
    [markDeleting, removeTask, unmarkDeleting],
  );

  return (
    <TaskListContext.Provider
      value={{
        tasks,
        loaded,
        refresh,
        upsertTask,
        removeTask,
        deletingIds,
        deleteTaskById,
      }}
    >
      {children}
    </TaskListContext.Provider>
  );
};

export const useTaskList = (): TaskListContextValue => {
  const ctx = useContext(TaskListContext);
  if (!ctx) throw new Error("useTaskList 必须在 <TaskListProvider> 内使用");
  return ctx;
};
