"use client";

/**
 * 订阅任务事件流（SSE）的公共 hook
 *
 * 抽出来的动机：chat-view.tsx 跟 task/[id]/page.tsx 几乎一模一样地写了一遍 SSE useEffect、
 * 包括 ref 化 callback、AbortController、AbortError 静默吞、组件卸载清理。
 *
 * 用法：
 * ```
 * useTaskWatch(task.id, {
 *   onEvent: (ev) => { ... },
 *   onTaskUpdate: (t) => setTask(t),
 *   onAssistantDelta: (text) => setStreamingText(p => p + text),
 *   onDone: (t) => { ... },
 *   onErrorMessage: (msg) => toast.error(`watch 出错：${msg}`),
 * });
 * ```
 *
 * 设计取舍：
 * - callback 走 ref：避免父组件 re-render 触发 callback 引用变化、effect 反复 abort/重连
 * - 仅在 taskId 变化时重连（dep 故意只有 taskId）
 * - errorChannel 区分两类错误：
 *   - SSE 协议层错误（onError envelope）→ onErrorMessage
 *   - watchChatStream 自己 throw（HTTP 4xx / 网络断）→ onWatchException
 *   两类 toast 文案不同（前者「watch 出错」、后者「watch 异常」）、保留原代码语义
 * - enabled 开关：plan 任务详情页里 chat 模式不要订阅（ChatView 自己订）、传 false 跳过
 */

import { useEffect, useRef } from "react";

import { watchChatStream, type ChatStreamCallbacks } from "@/lib/task-store";
import type { Task, TaskEvent } from "@/lib/types";

export interface UseTaskWatchCallbacks {
  onEvent?: (ev: TaskEvent) => void;
  onTaskUpdate?: (task: Task) => void;
  onAssistantDelta?: (text: string) => void;
  onDone?: (task: Task, ok: boolean) => void;
  // SSE envelope 里的 error 帧（服务端主动发的协议错误）
  onErrorMessage?: (message: string) => void;
  // watchChatStream 自己 throw 出来的异常（HTTP 4xx / 网络断 / 解析错）
  // AbortError 已被 hook 内部吞掉、不会触发这个回调
  onWatchException?: (err: Error) => void;
}

export const useTaskWatch = (
  taskId: string | null | undefined,
  callbacks: UseTaskWatchCallbacks,
  enabled: boolean = true,
): void => {
  // 把所有 callback ref 化、effect 依赖只放 taskId / enabled
  // 父组件随便 re-render 都不会重连
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;

  useEffect(() => {
    if (!enabled || !taskId) return;

    const ctrl = new AbortController();
    let cancelled = false;

    const sseCallbacks: ChatStreamCallbacks = {
      onEvent: (ev) => callbacksRef.current.onEvent?.(ev),
      onTaskUpdate: (t) => callbacksRef.current.onTaskUpdate?.(t),
      onAssistantDelta: (text) =>
        callbacksRef.current.onAssistantDelta?.(text),
      onDone: (t, ok) => callbacksRef.current.onDone?.(t, ok),
      onError: (msg) => {
        if (!cancelled) callbacksRef.current.onErrorMessage?.(msg);
      },
    };

    const run = async () => {
      try {
        await watchChatStream(taskId, sseCallbacks, ctrl.signal);
      } catch (err) {
        // unmount / 切 task 主动 abort、不算异常
        if (
          (err as { name?: string }).name === "AbortError" ||
          ctrl.signal.aborted
        ) {
          return;
        }
        if (!cancelled) {
          callbacksRef.current.onWatchException?.(err as Error);
        }
      }
    };
    void run();

    return () => {
      cancelled = true;
      ctrl.abort();
    };
  }, [taskId, enabled]);
};
