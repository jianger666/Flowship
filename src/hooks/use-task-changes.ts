"use client";

/**
 * 代码改动清单（/api/tasks/[id]/changes）的拉取 + 刷新（task 与 chat 共用）。
 *
 * 刷新时机：
 * - 挂载 / 任务切换 / query（范围、对比基线、忽略空白）变化
 * - run 状态变化（跑完那一刻最终落盘的改动要拿到）
 * - 面板打开
 * - 窗口重新聚焦 / 页面重新可见：用户常在终端里 commit、stash、切分支，回到窗口就该是新的
 * - 分支切换器切分支成功（window 事件）
 * - agent 运行中轮询（面板开着 4s、关着 10s；页面不可见时跳过）——能看着改动数一边跑一边涨
 *
 * 并发控制（lib/changes/refresh.ts）：静默刷新不叠加（在途时只记一笔「跑完补一次」）、
 * 显式刷新（换范围 / 手动）取代在途请求、换任务 / 卸载时中止；轮询是「读完再排下一次」的定时链，
 * 间隔随上一次读取的耗时自适应（大仓里读得慢就自动慢下来，不会越叠越多）。
 *
 * 清单接口只读 name-status / numstat / raw、很轻；轮询失败静默（下一轮自纠），不打扰用户。
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { onGitBranchChanged } from "@/lib/changes/events";
import {
  createRefreshGate,
  nextPollDelay,
  type RefreshGateOptions,
} from "@/lib/changes/refresh";
import {
  changesQueryKey,
  DEFAULT_CHANGES_QUERY,
  formatChangeScope,
  parseChangeScope,
  type ChangesQuery,
} from "@/lib/changes/scope";
import { fetchTaskChanges } from "@/lib/task-store";
import type { TaskChanges } from "@/lib/types";

const POLL_OPEN_MS = 4_000;
const POLL_CLOSED_MS = 10_000;
/** 窗口聚焦 / 分支切换触发的静默刷新最小间隔（聚焦事件常成串到来） */
const KICK_MIN_INTERVAL_MS = 1_500;

interface Options {
  taskId: string;
  /** false = 不拉（没绑工作目录 / 没有可看改动的任务） */
  enabled: boolean;
  /** agent 是否在运行（决定要不要轮询） */
  running: boolean;
  /** 改动面板是否打开 */
  open: boolean;
  /** 看哪一段 / 对比谁 / 是否忽略空白；缺省 = 整条分支、自动基线 */
  query?: ChangesQuery;
}

export const useTaskChanges = ({
  taskId,
  enabled,
  running,
  open,
  query = DEFAULT_CHANGES_QUERY,
}: Options) => {
  const [data, setData] = useState<TaskChanges | null>(null);
  // data 是按哪个 query 拉的：和当前 query 对不上 = 手里是旧范围的数据（面板据此显示加载态、不把旧数据当新的）
  const [dataKey, setDataKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 仅「手动 / 首次 / 换 query」刷新显示 loading；静默轮询不闪
  const [loading, setLoading] = useState(false);
  // 每次成功拉到清单就换一个戳——面板据此在运行中静默重拉选中文件的 diff
  const [updatedAt, setUpdatedAt] = useState(0);

  // 切任务：上一个任务的数据不能留着
  const [prevTaskId, setPrevTaskId] = useState(taskId);
  if (prevTaskId !== taskId) {
    setPrevTaskId(taskId);
    setData(null);
    setDataKey(null);
    setError(null);
  }

  // query 拆成基本类型进 deps：调用方每次 render 传新对象也不会引起重复拉取
  const scopeStr = formatChangeScope(query.scope);
  const { baseRef, ignoreWs } = query;
  const queryKey = changesQueryKey(query);

  // 上一次读取的耗时：轮询间隔据此自适应
  const lastMsRef = useRef<number | null>(null);
  // 实际读取逻辑（闭包了 taskId / query）。闸门本身稳定、不随它们重建，读取逻辑每次变化后交给它
  const loadRef = useRef<RefreshGateOptions["load"]>(async () => {});
  const [gate] = useState(() =>
    createRefreshGate({
      load: (ctx) => loadRef.current(ctx),
      onTiming: (ms) => {
        lastMsRef.current = ms;
      },
    }),
  );

  // 必须声明在所有会触发读取的 effect 之前：同一次提交里 effect 按声明顺序执行，触发时拿到的要是最新逻辑
  useEffect(() => {
    loadRef.current = async ({ signal, isCurrent }) => {
      const q: ChangesQuery = {
        scope: parseChangeScope(scopeStr) ?? DEFAULT_CHANGES_QUERY.scope,
        baseRef,
        ignoreWs,
      };
      try {
        const next = await fetchTaskChanges(taskId, q, signal);
        // 被更晚的显式刷新取代 / 已中止：这份结果过期了，丢弃
        if (!isCurrent()) return;
        setData(next);
        setDataKey(changesQueryKey(q));
        setError(null);
        setUpdatedAt(Date.now());
      } catch (err) {
        if (!isCurrent()) return;
        setError(err instanceof Error ? err.message : "读取代码改动失败");
      } finally {
        if (isCurrent()) setLoading(false);
      }
    };
  }, [taskId, scopeStr, baseRef, ignoreWs]);

  // 换任务 / 不再可读 / 卸载：中止在途读取、清掉待补的那一次（否则上个任务的响应会落到新任务的面板上）
  useEffect(() => () => gate.abort(), [gate, taskId, enabled]);

  const refresh = useCallback(
    async (opts?: { silent?: boolean }) => {
      if (!enabled) return;
      if (!opts?.silent) setLoading(true);
      await gate.request(opts);
    },
    [enabled, gate],
  );

  // 挂载 / run 状态变化 / 面板打开 / query 变化：立刻拉一次。
  // 换 query 不静默——旧范围的数据还在屏幕上，得让用户看到「正在换」
  const lastQueryKeyRef = useRef(queryKey);
  useEffect(() => {
    const queryChanged = lastQueryKeyRef.current !== queryKey;
    lastQueryKeyRef.current = queryKey;
    void refresh({ silent: !queryChanged });
  }, [refresh, running, open, queryKey, taskId]);

  // 运行中轮询：读完再排下一次（不是固定 setInterval——请求慢的时候不会叠起来），间隔随读取耗时自适应
  useEffect(() => {
    if (!enabled || !running) return;
    const base = open ? POLL_OPEN_MS : POLL_CLOSED_MS;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (document.visibilityState === "visible") await refresh({ silent: true });
      if (!cancelled) timer = setTimeout(tick, nextPollDelay(base, lastMsRef.current));
    };
    timer = setTimeout(tick, nextPollDelay(base, lastMsRef.current));
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [enabled, running, open, refresh]);

  // 窗口重新聚焦 / 页面重新可见 / 分支切换：静默刷新（节流）
  useEffect(() => {
    if (!enabled) return;
    let last = 0;
    const kick = () => {
      const now = Date.now();
      if (now - last < KICK_MIN_INTERVAL_MS) return;
      last = now;
      void refresh({ silent: true });
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") kick();
    };
    window.addEventListener("focus", kick);
    document.addEventListener("visibilitychange", onVisible);
    const offBranch = onGitBranchChanged(taskId, kick);
    return () => {
      window.removeEventListener("focus", kick);
      document.removeEventListener("visibilitychange", onVisible);
      offBranch();
    };
  }, [enabled, taskId, refresh]);

  return {
    data,
    error,
    loading,
    updatedAt,
    refresh,
    /** true = 手里的数据不是当前 query 拉的（正在换范围 / 基线） */
    stale: data !== null && dataKey !== queryKey,
  };
};
