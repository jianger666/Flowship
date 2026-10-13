"use client";

/**
 * 任务代码改动清单（/api/tasks/[id]/changes）的拉取 + 刷新。
 *
 * 刷新时机：
 * - 挂载 / 任务切换
 * - run 状态变化（跑完那一刻最终落盘的改动要拿到）
 * - 面板打开
 * - agent 运行中轮询（面板开着 4s、关着 10s；页面不可见时跳过）——能看着改动数一边跑一边涨
 *
 * 清单接口只读 name-status / numstat、很轻；轮询失败静默（下一轮自纠），不打扰用户。
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { fetchTaskChanges } from "@/lib/task-store";
import type { TaskChanges } from "@/lib/types";

const POLL_OPEN_MS = 4_000;
const POLL_CLOSED_MS = 10_000;

interface Options {
  taskId: string;
  /** false = 不拉（chat / 没有可看改动的任务） */
  enabled: boolean;
  /** agent 是否在运行（决定要不要轮询） */
  running: boolean;
  /** 改动面板是否打开 */
  open: boolean;
}

export const useTaskChanges = ({ taskId, enabled, running, open }: Options) => {
  const [data, setData] = useState<TaskChanges | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 仅「手动 / 首次」刷新显示 loading；静默轮询不闪
  const [loading, setLoading] = useState(false);
  // 每次成功拉到清单就换一个戳——面板据此在运行中静默重拉选中文件的 diff
  const [updatedAt, setUpdatedAt] = useState(0);
  const seqRef = useRef(0);

  const refresh = useCallback(
    async (opts?: { silent?: boolean }) => {
      if (!enabled) return;
      const seq = ++seqRef.current;
      if (!opts?.silent) setLoading(true);
      try {
        const next = await fetchTaskChanges(taskId);
        // 过期响应（更晚的请求已发出）丢弃
        if (seq !== seqRef.current) return;
        setData(next);
        setError(null);
        setUpdatedAt(Date.now());
      } catch (err) {
        if (seq !== seqRef.current) return;
        setError(err instanceof Error ? err.message : "读取代码改动失败");
      } finally {
        if (seq === seqRef.current) setLoading(false);
      }
    },
    [taskId, enabled],
  );

  // 挂载 / run 状态变化 / 面板打开：立刻拉一次（静默——已有数据时不闪 loading）
  useEffect(() => {
    void refresh({ silent: true });
  }, [refresh, running, open]);

  // 运行中轮询
  useEffect(() => {
    if (!enabled || !running) return;
    const timer = setInterval(
      () => {
        if (document.visibilityState === "visible") {
          void refresh({ silent: true });
        }
      },
      open ? POLL_OPEN_MS : POLL_CLOSED_MS,
    );
    return () => clearInterval(timer);
  }, [enabled, running, open, refresh]);

  return { data, error, loading, updatedAt, refresh };
};
