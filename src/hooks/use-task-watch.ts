"use client";

/**
 * 订阅任务事件流（SSE）的公共 hook（V0.6 重命名：原 watchChatStream → watchTaskStream）
 *
 * 抽出来的动机：原来 chat-view.tsx 跟 task/[id]/page.tsx 几乎一模一样地写了一遍 SSE useEffect、
 * 包括 ref 化 callback、AbortController、AbortError 静默吞、组件卸载清理。
 *
 * 用法：
 * ```
 * useTaskWatch(task.id, {
 *   onEvent: (ev) => { ... },
 *   onTaskUpdate: (t) => setTask(t),
 *   onActionUpdate: (a) => { ... },
 *   onAssistantDelta: (text) => setStreamingText(p => p + text),
 *   onDone: (t) => { ... },
 *   onErrorMessage: (msg) => toast.error(`watch 出错：${msg}`),
 * });
 * ```
 *
 * 设计取舍：
 * - callback 走 ref：避免父组件 re-render 触发 callback 引用变化、effect 反复 abort/重连
 * - 仅在 taskId / enabled / reconnectKey 变化时重连
 * - errorChannel 区分两类错误：
 *   - SSE 协议层错误（onError envelope）→ onErrorMessage
 *   - watchTaskStream 自己 throw（HTTP 4xx / 网络断）→ onWatchException
 *   两类 toast 文案不同（前者「watch 出错」、后者「watch 异常」）、保留原代码语义
 * - enabled 开关：父组件可控制（如未 hydrate 时禁用订阅）
 * - reconnectKey：调用方需要主动让 SSE 重连的场景下使用——
 *   服务端在 task 终态（merged/abandoned）时收到 watch-task 请求会 bootstrap 完直接 close、
 *   后续用户点「推进」让 agent 重新跑起来的入口、
 *   光 setTask(latest) 不会触发 effect 重跑、客户端 SSE 已断 → 收不到新事件 → 必须刷页面、
 *   解法是调用方维护一个 epoch 计数、每次「让 agent 又活了」的成功路径 ++、effect dep 加它自然重连
 */

import { useEffect, useRef } from "react";

import { watchTaskStream, type TaskStreamCallbacks } from "@/lib/task-store";
import type { ActionRecord, Task, TaskEvent } from "@/lib/types";

export interface UseTaskWatchCallbacks {
  onEvent?: (ev: TaskEvent) => void;
  onTaskUpdate?: (task: Task) => void;
  onActionUpdate?: (action: ActionRecord) => void;
  onAssistantDelta?: (text: string) => void;
  onDone?: (task: Task, ok: boolean) => void;
  // SSE envelope 里的 error 帧（服务端主动发的协议错误）
  onErrorMessage?: (message: string) => void;
  // watchTaskStream 自己 throw 出来的异常（HTTP 4xx / 网络断 / 解析错）
  // AbortError 已被 hook 内部吞掉、不会触发这个回调
  onWatchException?: (err: Error) => void;
}

export const useTaskWatch = (
  taskId: string | null | undefined,
  callbacks: UseTaskWatchCallbacks,
  enabled: boolean = true,
  reconnectKey: number | string = 0,
): void => {
  // 把所有 callback ref 化、effect 依赖只放 taskId / enabled / reconnectKey
  // 父组件随便 re-render 都不会重连
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;

  useEffect(() => {
    if (!enabled || !taskId) return;

    const ctrl = new AbortController();
    let cancelled = false;

    const sseCallbacks: TaskStreamCallbacks = {
      onEvent: (ev) => callbacksRef.current.onEvent?.(ev),
      onTaskUpdate: (t) => callbacksRef.current.onTaskUpdate?.(t),
      onActionUpdate: (a) => callbacksRef.current.onActionUpdate?.(a),
      onAssistantDelta: (text) =>
        callbacksRef.current.onAssistantDelta?.(text),
      onDone: (t, ok) => callbacksRef.current.onDone?.(t, ok),
      onError: (msg) => {
        if (!cancelled) callbacksRef.current.onErrorMessage?.(msg);
      },
    };

    const run = async () => {
      try {
        await watchTaskStream(taskId, sseCallbacks, ctrl.signal);
      } catch (err) {
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
  }, [taskId, enabled, reconnectKey]);
};
