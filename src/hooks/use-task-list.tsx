"use client";

/**
 * 全局任务列表 store（V0.8 侧栏导航）
 *
 * 为什么要：侧栏常驻 + 各页面（欢迎页 / 详情页）都读同一份任务列表、
 * 且新建 / 删除 / 状态变化要统一同步——不能侧栏一份、页面一份、各拉各的导致漂移。
 *
 * 提供：
 *  - tasks / loaded：列表 + 首次加载完成标记
 *  - corrupt：meta.json 损坏而无法列出的任务（同一个列表响应带回，侧栏据此提示「N 个任务数据损坏」）
 *  - refresh()：重新拉服务端列表（轻量 TaskSummary[]、N×1 IO）
 *  - upsertTask(task)：单条插入 / 更新（新建任务后即时插入、不等下次 refresh；
 *    详情页基本信息变化时同步侧栏状态点）
 *  - removeTask(id)：单条移除（删除任务乐观更新）
 *  - deletingIds / deleteTaskById：删除链路单一来源——锁 id 防双击、
 *    pendingDeletes 过滤 refresh 防「幽灵回魂」、404 当幂等成功
 *
 * 刷新时机：mount 一次 + 窗口重新聚焦（focus）时——多任务并行，切回 app 拿最新态。
 * 外加「条件轮询」（间隔 / 开关见 lib/task-list-poll 的 pickTaskListPollPlan）：
 *  - 列表里存在 running 任务（或飞书桥接开）→ 每 2s 刷一次、全跑完即停。
 *    这样切到 B 时、后台还在跑的 A 跑完几秒内侧栏就更新（停转圈 / 变成等你回复点）。
 *  - 没有任务在跑、但服务端说有会触发的定时（TaskSummary.hasLiveSchedule）→ 30s 低频兜底
 *    （页面不可见 60s），定时唤醒的 chat 才有机会被看见 / 通知；这一档内容没变沿用旧引用。
 *  - 都没有 → 不轮询、不浪费。
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
import { loadErrorMessage } from "@/lib/load-outcome";
import { sameCorruptTasks, type CorruptTaskInfo } from "@/lib/corrupt-task";
import {
  deleteTaskWithReport as deleteTaskWithReportApi,
  fetchTaskList,
  type DeleteTaskResult,
} from "@/lib/task-store";
import type { DeleteWorktreeReportBody } from "@/lib/worktree-report";
import {
  canCommitTaskListRefresh,
  filterTaskListAfterRefresh,
  applyPendingArchives,
  rememberSuccessfulDeletedId,
  shouldRejectArchiveSnapshot,
} from "@/lib/task-list-refresh";
import {
  BUSY_TAIL_REFRESH_MS,
  isTaskBusy,
  keepBackgroundSubagentCount,
  shouldTailRefreshAfterBusy,
} from "@/lib/task-background";
import {
  canStartPoll,
  hasLiveScheduleTask,
  createTaskListUpsertTracker,
  pickTaskListPollPlan,
  sameTaskList,
  shouldClearPollInflight,
  type PollInflight,
} from "@/lib/task-list-poll";
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
  /**
   * 最近一次列表拉取的失败原因（成功即清；null = 最近一次是好的）。
   * 消费方用它区分「首拉失败」与「真的没有任务」：loaded 且 tasks 为空时，
   * loadError 非空 = 没拉到、不是没有——画失败态 + 重试，别画「还没有任务」
   * （判定见 lib/load-outcome 的 deriveListLoadView）。
   */
  loadError: string | null;
  /**
   * meta.json 损坏而无法列出的任务（不在 tasks 里：它们没有可信的 runStatus / repoPaths，
   * 混进去会被各处当真任务用）。没有损坏 / 旧服务端没这个字段 = []。
   * 拉取失败时保留上一次成功的值（不拿「拉不到」当「没有损坏」）。侧栏据此显示提示。
   */
  corrupt: CorruptTaskInfo[];
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
    options?: {
      onLocked?: () => void;
      /** 服务端的工作区清理回报（保留的目录 / 落了快照的仓）：toast 据此说话，别默认「删干净了」 */
      onReport?: (report: DeleteWorktreeReportBody) => void;
    },
  ) => Promise<DeleteTaskResult>;
  /**
   * 归档中标记：归档是“改字段”不是“删行”，pendingDeletes 那套盖不上。
   * 带目标方向（归档 true / 恢复 false）：标记窗口内（服务端还没写完），与目标反向的
   * 旧快照不得盖掉乐观更新；同向提交态照常放行。失败必须 unmark + refresh。
   */
  markArchiving: (id: string, expectArchived: boolean) => void;
  unmarkArchiving: (id: string) => void;
}

const TaskListContext = createContext<TaskListContextValue | null>(null);

// 轮询间隔 / 开关条件见 lib/task-list-poll（pickTaskListPollPlan）：
// 忙 / 桥接 = 2s；仅有 live 定时 = 30s（页面不可见 60s）；都没有 = 不轮询

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
  // 最近一次拉取的失败原因（成功清掉）：区分「首拉失败」与「还没有任务」
  const [loadError, setLoadError] = useState<string | null>(null);
  // 损坏的任务（来自同一个列表响应，随成功的 refresh 一起更新）
  const [corrupt, setCorrupt] = useState<CorruptTaskInfo[]>([]);
  // 最近一次列表响应里有没有「还会触发的定时」（服务端打的 hasLiveSchedule）——兜底轮询的开关。
  // 单独存、不从 tasks 行上现算：详情页 upsertTask 回灌的行不带这个标记，会把它冲掉
  const [scheduleLive, setScheduleLive] = useState(false);
  // 页面不可见（最小化 / 切走）——兜底轮询据此降频
  const [pageHidden, setPageHidden] = useState(false);
  // 删除中 id（驱动按钮 disabled；与 ref 同步，ref 给 refresh/upsert 同步读）
  const [deletingIds, setDeletingIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  // pendingDeletes：DELETE 等待窗口内（running 可等 8s）refresh 不得把任务加回
  const pendingDeletesRef = useRef<Set<string>>(new Set());
  // pendingArchives：归档/恢复等待窗口内，反向旧快照不得盖掉乐观更新（值=目标方向）
  const pendingArchivesRef = useRef<Map<string, boolean>>(new Map());
  // 本地 upsert 时间表 + 响应落地合并（见 createTaskListUpsertTracker）。
  // 必须用 useState 初始化器持有：useMemo 只是性能提示、React 可以丢缓存——tracker 若随渲染重建，
  // 已记下的 upsert 时间会清零、Q8-06 同族的「新建任务被慢轮询抹掉」会复发
  const [upsertTracker] = useState(createTaskListUpsertTracker);
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

  const markArchiving = useCallback((id: string, expectArchived: boolean) => {
    pendingArchivesRef.current.set(id, expectArchived);
  }, []);

  const unmarkArchiving = useCallback((id: string) => {
    pendingArchivesRef.current.delete(id);
  }, []);

  // reuseIfSame：仅「live 定时兜底轮询」传 true——内容没变就沿用旧列表引用，30s 一次也不让整棵树白白重渲。
  // 2s 档与聚焦 / 手动刷新保持原行为（每次换新引用），不在这里顺手改
  const runRefresh = useCallback(async (reuseIfSame: boolean) => {
    // 捕获发起时 epoch；响应到达时若已推进则整响应丢弃
    const startEpoch = refreshEpochRef.current;
    // 请求发出时间：响应落地时用它补回「请求之后才本地新建」的行（第五轮 Q8-06 同族）
    const fetchStartedAt = Date.now();
    try {
      const { tasks: list, corrupt: corruptList } = await fetchTaskList();
      if (!canCommitTaskListRefresh(startEpoch, refreshEpochRef.current)) {
        return;
      }
      // 再滤 sticky terminal（跨 tab task_deleted 与 epoch 双保险）
      // 归档中 id：服务端旧快照archived:false 不得覆盖，强制按已归档保留（其它字段取服务端最新）
      const nextList = applyPendingArchives(
        filterTaskListAfterRefresh(
          list,
          pendingDeletesRef.current,
          successfulDeletedIdsRef.current,
        ).filter((t) => !isTaskTerminalDeleted(t.id)),
        pendingArchivesRef.current,
      );
      // Q8-06：本地行（SSE upsertTask 回灌）比响应行新时保留本地行——慢轮询不回滚新状态；
      // 请求发出之后才本地新建的行（响应里没有）也补回（第五轮同族）。合并逻辑全在 upsertTracker（纯函数 + 行为测试）
      setTasks((prev) => {
        const merged = upsertTracker.merge(
          prev,
          nextList,
          fetchStartedAt,
          // 补回的行同样不得是删除中 / 已删除的（与上面对响应行的过滤同口径，防复活）
          (id) =>
            pendingDeletesRef.current.has(id) ||
            successfulDeletedIdsRef.current.has(id) ||
            isTaskTerminalDeleted(id),
        );
        return reuseIfSame && sameTaskList(prev, merged) ? prev : merged;
      });
      // live 定时标记取自这次响应（拉不到时保留上次的值：不拿「拉不到」当「没有定时」）
      setScheduleLive(hasLiveScheduleTask(nextList));
      // 内容没变就沿用旧引用：运行中每 2s 轮询一次，别让侧栏底部的提示 / 弹层跟着白白重渲染
      setCorrupt((prev) =>
        sameCorruptTasks(prev, corruptList) ? prev : corruptList,
      );
      setLoadError(null);
    } catch (err) {
      // 不 toast 刷屏（轮询 / 聚焦刷新会反复触发）；但把失败原因记下来——
      // 否则首拉失败时 tasks 仍是空数组、侧栏会把它画成「还没有任务」（失败说谎）
      console.warn("[task-list] 刷新失败", err);
      // 过期 refresh（DELETE 等已推进 epoch）的失败不代表当前状态，别污染
      if (canCommitTaskListRefresh(startEpoch, refreshEpochRef.current)) {
        setLoadError(loadErrorMessage(err));
      }
    } finally {
      // 过期 refresh 仍可标记 loaded（首次 mount 不应被 DELETE 卡死）
      setLoaded(true);
    }
  }, [upsertTracker]);

  // 对外的 refresh：签名不变（聚焦 / 手动 / 各页面调用点都走它），行为 = 原来的 refresh
  const refresh = useCallback(() => runRefresh(false), [runRefresh]);
  // live 定时兜底轮询专用：内容没变不换列表引用
  const refreshQuiet = useCallback(() => runRefresh(true), [runRefresh]);

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
  // 后台子代理还在跑也算「忙」：主 AI 说完后 runStatus 已回等待态，没有这条轮询就不会再刷新列表，
  // 子代理的转圈既不会出现、也收不掉（读数只在列表接口里、详情页回灌不带）
  const hasRunning = useMemo(() => tasks.some(isTaskBusy), [tasks]);

  // 「忙 → 不忙」的边沿补刷一次：这个翻转可能来自详情页回灌（不带后台读数），
  // 最后 ≤ 2s 里才派出的后台子代理会因此漏读——见 shouldTailRefreshAfterBusy。
  const wasBusyRef = useRef(false);
  useEffect(() => {
    const wasBusy = wasBusyRef.current;
    wasBusyRef.current = hasRunning;
    if (!shouldTailRefreshAfterBusy(wasBusy, hasRunning)) return;
    const timer = setTimeout(() => void refresh(), BUSY_TAIL_REFRESH_MS);
    return () => clearTimeout(timer);
  }, [hasRunning, refresh]);

  // 飞书桥接开启时：服务端可能随时被飞书消息唤醒（新建对话 / 注入消息），
  // 客户端没有任何触发点——窗口不聚焦列表就一直陈旧（2026-07-19 用户双屏实测）。
  // 桥接用户常态轮询兜底；未开桥接保持原「仅 running 时轮询」的省电策略。
  // getSettings 是同步缓存读，每次渲染取一次即可（开关切换后 focus/refresh 自然带动重渲染）
  const bridgeOn = getSettings().feishuChatBridge === true;

  // 页面可见性：只用来给「live 定时兜底轮询」降频（最小化 / 切走时 30s → 60s，不停）
  useEffect(() => {
    const sync = () => setPageHidden(document.visibilityState === "hidden");
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => document.removeEventListener("visibilitychange", sync);
  }, []);

  // 条件轮询（间隔 / 开关见 pickTaskListPollPlan）：
  //  - 有任务在忙、或飞书桥接开启 → 2s（原行为）；
  //  - 都没有、但有会触发的定时（服务端打的 hasLiveSchedule）→ 30s 兜底：到点被唤醒的 chat
  //    才有机会被侧栏看到 / 被 watcher 通知（V7-03）；没有 live 定时 = 一次都不轮询。
  // 兜底档（quiet）内容没变沿用旧引用；一旦撞见 running 会自然切到 2s 档，结束后经尾刷回到兜底档。
  const plan = pickTaskListPollPlan({
    busy: hasRunning,
    bridgeOn,
    scheduleLive,
    pageHidden,
  });
  const pollMs = plan?.intervalMs ?? null;
  const pollQuiet = plan?.quiet ?? false;
  // 在途保护（第三轮 R11-07）：上一次轮询还没返回就不再叠发——慢响应 + SSE 回灌交错会让侧栏状态回跳、
  // 同一次完成被通知两次；服务端繁忙时 2s 档还会自叠加
  // Q8-06：守卫带超时 + 世代——卡住（> TASK_LIST_POLL_INFLIGHT_TIMEOUT_MS）的请求不能永久挡住后续轮询，
  // 旧请求迟到结束时也不能清掉新一轮的记录
  const pollInflightRef = useRef<PollInflight | null>(null);
  const pollTokenRef = useRef(0);
  useEffect(() => {
    if (pollMs === null) return;
    const timer = setInterval(() => {
      const now = Date.now();
      if (!canStartPoll(pollInflightRef.current, now)) return;
      const token = (pollTokenRef.current += 1);
      pollInflightRef.current = { token, startedAt: now };
      void (pollQuiet ? refreshQuiet() : refresh()).finally(() => {
        if (shouldClearPollInflight(pollInflightRef.current, token)) {
          pollInflightRef.current = null;
        }
      });
    }, pollMs);
    return () => clearInterval(timer);
  }, [pollMs, pollQuiet, refresh, refreshQuiet]);

  const upsertTask = useCallback((task: Task | TaskSummary) => {
    const summary = toSummary(task);
    // sticky terminal / 删除中 / 已成功删除——禁止回灌复活
    if (!canCommitTaskSnapshot(summary.id)) return;
    if (pendingDeletesRef.current.has(summary.id)) return;
    if (successfulDeletedIdsRef.current.has(summary.id)) return;
    // 归档中：旧快照（archived:false，多为轮询/SSE 在服务端写完前回来）不得盖掉乐观更新；
    // 已提交态（archived:true）照常放行，保证服务端其它新字段能落地
    if (
      shouldRejectArchiveSnapshot(
        summary.id,
        summary.archived,
        pendingArchivesRef.current,
      )
    ) {
      return;
    }
    // 记下本地 upsert 时间：慢轮询响应落地时据此补回「请求之后才新建」的行
    upsertTracker.mark(summary.id);
    setTasks((prev) => {
      const idx = prev.findIndex((t) => t.id === summary.id);
      if (idx < 0) return [summary, ...prev];
      const next = [...prev];
      next[idx] = keepBackgroundSubagentCount(prev[idx], summary);
      return next;
    });
  }, [upsertTracker]);

  const removeTask = useCallback((id: string) => {
    setTasks((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const deleteTaskById = useCallback(
    async (
      id: string,
      options?: {
        onLocked?: () => void;
        onReport?: (report: DeleteWorktreeReportBody) => void;
      },
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
        const { result, report } = await deleteTaskWithReportApi(id);
        // ok / not_found 都算成功
        // 走统一 sink（推进 epoch + sticky + 列表移除）
        commitTaskDeleted(id);
        unmarkDeleting(id);
        if (report) options?.onReport?.(report);
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
        loadError,
        corrupt,
        refresh,
        upsertTask,
        removeTask,
        deletingIds,
        deleteTaskById,
        markArchiving,
        unmarkArchiving,
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
