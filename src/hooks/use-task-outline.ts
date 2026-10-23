"use client";

/**
 * 事件流左侧「提问时间线」的数据：服务端大纲（全部历史）+ 前端窗口里的实时事件。
 *
 * - **窗口已含全部历史（`truncated=false`）时一次请求都不发**：窗口里的事件就是全部，直接从它派生；
 *   只有窗口被截断（长会话、更早的靠上拉分页）才去取服务端大纲。短对话打开不多一个请求；
 * - 服务端大纲取一次；之后新提问靠窗口里的实时事件并进去（`mergeOutline`），不轮询；
 * - 回退（`lastRewind` 变了）：先本地把回退点及之后的项砍掉（别让用户点到已删的消息），同时重拉一次；
 * - 取失败不打扰用户：带退避重试两次（瞬时网络错误不该让长会话的时间线一直只剩窗口内的项）；
 *   仍失败就退回只用窗口里的项（时间线照样能用、只是看不到窗口之外的），下次回退 / 切任务再试。
 *
 * ## 一个不变量（改动时务必保持）
 * 服务端大纲只在「挂载 / 切任务 / 回退」时取，之后靠窗口里的实时事件补。这依赖：**事件窗口被整体替换
 * （`replaceTaskEventsWithSnapshot`）只发生在回退路径**——此时 `lastRewind.ts` 一定推进、本 hook 会重拉。
 * 若将来加了「非回退的整体替换」（窗口之外、大纲取过之后产生的提问会漏），必须同时让它触发重拉
 * （给本 hook 加一个重拉信号）。`tests/stream-outline-wiring-contract.test.ts` 钉住了现有的调用点集合。
 *
 * 返回的数组在内容没变时保持同一个引用（`stabilizeOutline`）：每来一条事件就让时间线重画一遍没有意义。
 */

import { useEffect, useMemo, useRef, useState } from "react";

import {
  fetchWithBackoff,
  mergeOutline,
  stabilizeOutline,
  type OutlineItem,
} from "@/lib/stream-outline";
import { ApiRequestError, fetchTaskOutline } from "@/lib/task-store";
import type { LastRewind, TaskEvent } from "@/lib/types";

const NO_ITEMS: readonly OutlineItem[] = [];
/** 取大纲失败后的重试间隔（ms）：失败 → 1.5s 后重试 → 6s 后再试 → 放弃（共 3 次） */
export const OUTLINE_RETRY_DELAYS_MS: readonly number[] = [1500, 6000];

export const useTaskOutline = (input: {
  taskId: string;
  events: readonly TaskEvent[];
  /** 窗口之外还有更早的事件（服务端 eventsTruncated）；false = 窗口就是全部历史、不必取服务端大纲 */
  truncated: boolean;
  lastRewind?: LastRewind | null;
}): readonly OutlineItem[] => {
  const { taskId, events, truncated, lastRewind } = input;
  const rewindTs = lastRewind?.ts ?? 0;
  const rewindFrom = lastRewind?.fromEventId ?? null;

  const [server, setServer] = useState<{
    taskId: string;
    items: readonly OutlineItem[];
  } | null>(null);

  useEffect(() => {
    if (!truncated) return;
    const ac = new AbortController();
    fetchWithBackoff(() => fetchTaskOutline(taskId, ac.signal), OUTLINE_RETRY_DELAYS_MS, {
      signal: ac.signal,
      // 任务已删 / 不存在（404 / 410）是确定结论，重试只会白等 7.5 秒；其余（含路由把内部 IO 错误统一回的 400）照常重试
      shouldRetry: (err) =>
        !(err instanceof ApiRequestError && (err.status === 404 || err.status === 410)),
    })
      .then((res) => {
        if (ac.signal.aborted) return;
        setServer({ taskId, items: res.items });
      })
      .catch((err: unknown) => {
        if (ac.signal.aborted) return;
        console.warn("[stream-outline] 取时间线大纲失败，退回只用窗口内的提问：", err);
      });
    return () => ac.abort();
    // rewindTs：回退之后服务端大纲变了，重拉；truncated 由 false 变 true（窗口被裁成尾窗口）也要取
  }, [taskId, truncated, rewindTs]);

  // 别的任务留下的大纲不能串进来（详情页内切任务不重挂）
  const serverItems = server && server.taskId === taskId ? server.items : NO_ITEMS;

  const merged = useMemo(
    () => mergeOutline(serverItems, events, rewindFrom),
    [serverItems, events, rewindFrom],
  );
  // 渲染期写 ref：stabilizeOutline 是纯函数、同输入同输出，StrictMode 双渲染也幂等
  const stableRef = useRef<readonly OutlineItem[]>(NO_ITEMS);
  const stable = stabilizeOutline(stableRef.current, merged);
  stableRef.current = stable;
  return stable;
};
