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
 *
 * 刷新时机：mount 一次 + 窗口重新聚焦（focus）时——多任务并行，切回 app 拿最新态。
 * 外加「条件轮询」：仅当列表里存在 running 任务时、每 POLL_INTERVAL_MS 刷一次、全跑完即停。
 * 这样切到 B 时、后台还在跑的 A 跑完几秒内侧栏就更新（停转圈 / 变成等你回复点）。
 * 没有任务在跑时不轮询、不浪费。
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { fetchTasks } from "@/lib/task-store";
import type { Task, TaskSummary } from "@/lib/types";

interface TaskListContextValue {
  tasks: TaskSummary[];
  loaded: boolean;
  refresh: () => Promise<void>;
  upsertTask: (task: Task | TaskSummary) => void;
  removeTask: (id: string) => void;
}

const TaskListContext = createContext<TaskListContextValue | null>(null);

// 条件轮询间隔：仅当有任务在跑时生效（本地读 meta.json 很轻、2s 兼顾实时与开销）
const POLL_INTERVAL_MS = 2000;

// Task（完整）→ TaskSummary：派生 actionCount / lastAction*，剔除 events / actions
// （避免把可能很大的 events 数组带进侧栏列表）。本身已是 Summary 则原样返回。
const toSummary = (task: Task | TaskSummary): TaskSummary => {
  if ("actionCount" in task) return task;
  const { events, actions, ...rest } = task;
  void events; // 仅为从 rest 中剔除、不入列表
  const last = actions[actions.length - 1];
  return {
    ...rest,
    actionCount: actions.length,
    lastActionType: last?.type,
    lastActionStatus: last?.status,
  };
};

export const TaskListProvider = ({ children }: { children: ReactNode }) => {
  // 任务列表（原始顺序、排序 / 分组在消费方做）
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  // 首次加载完成——侧栏 loading 占位用
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const list = await fetchTasks();
      setTasks(list);
    } catch (err) {
      // 侧栏静默（不 toast 刷屏）；首页 / 详情页自己的拉取会暴露错误
      console.warn("[task-list] 刷新失败", err);
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

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

  // 条件轮询：仅当存在 running 任务时定时刷新、抓后台任务的状态变化（跑完 / 转等你回复）
  useEffect(() => {
    if (!hasRunning) return;
    const timer = setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [hasRunning, refresh]);

  const upsertTask = useCallback((task: Task | TaskSummary) => {
    const summary = toSummary(task);
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

  return (
    <TaskListContext.Provider
      value={{ tasks, loaded, refresh, upsertTask, removeTask }}
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
