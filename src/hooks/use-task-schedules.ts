"use client";

/**
 * 一个会话的定时列表（会话内定时条用）。
 *
 * 为什么不是 SSE：定时的变化（创建 / 取消 / 到点触发 / 错过）都会在会话事件流里落一条带标记的事件，
 * 调用方把「最新那条定时相关事件的 id」当 `refreshSignal` 传进来，变了就重拉——不用再开一条订阅。
 * 但「自动结束」「窗口耗尽」这类纯服务端状态变化没有事件，所以只要还有活着的定时就每 30 秒兜底拉一次。
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { fetchTaskSchedules } from "@/lib/schedule-client";
import type { ScheduleRecord } from "@/lib/schedule";

const POLL_MS = 30_000;

export const useTaskSchedules = (
  taskId: string,
  refreshSignal: string,
): { schedules: ScheduleRecord[]; reload: () => Promise<void> } => {
  const [schedules, setSchedules] = useState<ScheduleRecord[]>([]);
  // 请求序号：切会话 / 连续刷新时，只认最后一次发出的那个响应（慢的旧响应不得盖掉新的）
  const seqRef = useRef(0);

  const reload = useCallback(async (): Promise<void> => {
    const seq = ++seqRef.current;
    try {
      const list = await fetchTaskSchedules(taskId);
      if (seq === seqRef.current) setSchedules(list);
    } catch {
      /* 拉不到就保持现状；下次信号 / 轮询再试，不打扰用户 */
    }
  }, [taskId]);

  // 切会话：先清掉上一个会话的列表，别让旧的闪一下
  useEffect(() => {
    setSchedules([]);
  }, [taskId]);

  useEffect(() => {
    void reload();
  }, [reload, refreshSignal]);

  const hasLive = schedules.some((r) => r.status === "active" || r.pending !== undefined);
  useEffect(() => {
    if (!hasLive) return;
    const id = window.setInterval(() => void reload(), POLL_MS);
    return () => window.clearInterval(id);
  }, [hasLive, reload]);

  return { schedules, reload };
};
