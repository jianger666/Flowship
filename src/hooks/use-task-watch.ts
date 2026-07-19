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
 *
 * - **被动断开自动重连（V0.6.8）**：SSE 流可能被动断开（route 的 maxDuration=300s 到点、
 *   网络抖动、服务端重启），此时 watchTaskStream 正常返回 / 抛错、但 effect 不会自己重跑、
 *   客户端就**静默停在断连那一刻的状态**——典型表现：agent 产出了 artifact 但页面不刷新、
 *   必须手动刷新 / 切 action tab 才看到。解法是 hook 内部用 loop 自动重连。
 * - **done ≠ 停止订阅（V0.11.6 修）**：V0.11 起 run = 一个回合、agent 每说完一轮都 publish
 *   done——旧「收到 done 就不再重连」会让页面在任意一轮后断流、后续 send 起的新 run 事件
 *   全收不到（实测：ask 弹窗答完永远卡「提交中」）。现在只有 done 里的 task 是业务终态
 *   （merged / abandoned、服务端也只在这种情况关流）才停止订阅、其余照常保持 / 重连。
 * - **R37-3 / R37-6**：已 hydrate watcher 的 404→deleted；503 unavailable 持续重试（不终止）。
 */

import { useEffect, useRef } from "react";

import {
  ApiRequestError,
  watchTaskStream,
  type TaskStreamCallbacks,
} from "@/lib/task-store";
import {
  classifyWatchHttpStatus,
  isTaskTerminalDeleted,
  resolveWatchReconnectPolicy,
  WATCH_CLEAN_RECONNECT_DELAY_MS,
} from "@/lib/task-terminal";
import type { ActionRecord, Task, TaskEvent } from "@/lib/types";

export {
  classifyWatchHttpStatus,
  resolveWatchReconnectPolicy,
  WATCH_CLEAN_RECONNECT_DELAY_MS,
  WATCH_MAX_TRANSIENT_FAILURES,
  WATCH_UNAVAILABLE_BACKOFF_CAP_MS,
} from "@/lib/task-terminal";

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
  /** R31-1：queue_failed 控制帧 → 按 itemIds 清 / 标错 pending */
  onQueueFailed?: (itemIds: string[], reason: string) => void;
  /** R32-2 / R33-1 / R36-4：bootstrap queue_state + operationSnapshot */
  onQueueState?: (
    itemIds: string[],
    recentSettled?: Array<{ itemId: string; outcome: string }>,
    operationSnapshot?: Array<{
      itemId: string;
      phase: string;
      fingerprint?: string;
    }>,
  ) => void;
  /**
   * R36-2：显式 message_op 帧（phase / outcome）——成功终态唯一来源之一。
   */
  onMessageOp?: (payload: {
    itemId: string;
    phase?: string;
    outcome?: string;
  }) => void;
  /**
   * R33-4 / R35-5 / R37-3：task_deleted / watch 410 / 已 hydrate 的 404 → 停重连。
   * 调用方接到后 `commitTaskDeleted`；503 unavailable 不可走此 sink。
   */
  onTaskDeleted?: (taskId: string) => void;
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
    let backoffTimer: ReturnType<typeof setTimeout> | undefined;
    let wakeBackoff: (() => void) | null = null;

    const clearBackoff = () => {
      if (backoffTimer !== undefined) {
        clearTimeout(backoffTimer);
        backoffTimer = undefined;
      }
      wakeBackoff?.();
      wakeBackoff = null;
    };

    const delay = (ms: number) =>
      new Promise<void>((resolve) => {
        wakeBackoff = resolve;
        backoffTimer = setTimeout(() => {
          backoffTimer = undefined;
          wakeBackoff = null;
          resolve();
        }, ms);
      });

    // 自动重连循环：被动断流就退避后重连；只有「任务业务终态的 done」/ deleted 才停
    // enabled=true 隐含已 hydrate——404 可安全当物理删除完成（R37-3）
    const loop = async () => {
      // R38-2：两类计数独立——503 不兑换成一次即终止的网络错误预算
      let unavailableAttempts = 0;
      let transientFailures = 0;
      let unavailableNotified = false; // unavailable 达阈值后只 toast 一次
      while (!cancelled) {
        // 本次连接是否收到「终态 done」（task merged/abandoned、服务端随即关流）——
        // 回合级 done（V0.11 每轮 run 结束都发）不算、流保持 / 断了照常重连
        let gotTerminalDone = false;
        // R33-4 / R37-3：收到 task_deleted / 410 / hydrated-404 后不再重连
        let gotTaskDeleted = false;
        const sseCallbacks: TaskStreamCallbacks = {
          onEvent: (ev) => {
            if (cancelled) return;
            callbacksRef.current.onEvent?.(ev);
          },
          onTaskUpdate: (t) => {
            if (cancelled) return;
            callbacksRef.current.onTaskUpdate?.(t);
          },
          onActionUpdate: (a) => {
            if (cancelled) return;
            callbacksRef.current.onActionUpdate?.(a);
          },
          onAssistantDelta: (text) => {
            if (cancelled) return;
            callbacksRef.current.onAssistantDelta?.(text);
          },
          onDone: (t, ok) => {
            if (cancelled) return;
            if (t.repoStatus === "merged" || t.repoStatus === "abandoned") {
              gotTerminalDone = true;
            }
            callbacksRef.current.onDone?.(t, ok);
          },
          onError: (msg) => {
            if (cancelled) return;
            callbacksRef.current.onErrorMessage?.(msg);
          },
          onQueueFailed: (itemIds, reason) => {
            if (cancelled) return;
            callbacksRef.current.onQueueFailed?.(itemIds, reason);
          },
          onQueueState: (itemIds, recentSettled, operationSnapshot) => {
            if (cancelled) return;
            callbacksRef.current.onQueueState?.(
              itemIds,
              recentSettled,
              operationSnapshot,
            );
          },
          onMessageOp: (payload) => {
            if (cancelled) return;
            callbacksRef.current.onMessageOp?.(payload);
          },
          onTaskDeleted: (deletedId) => {
            if (cancelled) return;
            gotTaskDeleted = true;
            // 已 sticky 则不再回调，保证恰好一次进入 terminal / toast
            if (!isTaskTerminalDeleted(deletedId)) {
              callbacksRef.current.onTaskDeleted?.(deletedId);
            }
          },
          // R39-2：首个合法 bootstrap task 帧即清零——不等流 EOF；
          // 否则「成功建连后 reader 抛错」会把上轮 transient 累加到本轮
          onConnectionEstablished: () => {
            unavailableAttempts = 0;
            transientFailures = 0;
            unavailableNotified = false;
          },
        };

        try {
          await watchTaskStream(taskId, sseCallbacks, ctrl.signal);
          // 流 clean resolve：再清一次（幂等；建连时多半已清过）
          unavailableAttempts = 0;
          transientFailures = 0;
          unavailableNotified = false;
        } catch (err) {
          if (
            (err as { name?: string }).name === "AbortError" ||
            ctrl.signal.aborted
          ) {
            return;
          }
          // R37-3：本 hook 仅在 enabled（已 hydrate）时运行 → 404 可 commit deleted
          const status =
            err instanceof ApiRequestError
              ? err.status
              : (err as { status?: number }).status;
          const kind =
            typeof status === "number"
              ? classifyWatchHttpStatus(status, { hydratedWatcher: true })
              : "retryable";

          const decision = resolveWatchReconnectPolicy({
            kind,
            unavailableAttempts,
            transientFailures,
            unavailableNotified,
          });

          if (decision.action === "terminate_deleted") {
            gotTaskDeleted = true;
            if (!cancelled && !isTaskTerminalDeleted(taskId)) {
              callbacksRef.current.onTaskDeleted?.(taskId);
            }
          } else if (decision.action === "terminate_exhausted") {
            if (!cancelled && decision.notifyException) {
              callbacksRef.current.onWatchException?.(err as Error);
            }
            return;
          } else {
            unavailableAttempts = decision.nextUnavailableAttempts;
            transientFailures = decision.nextTransientFailures;
            unavailableNotified = decision.nextUnavailableNotified;
            if (!cancelled && decision.notifyException) {
              callbacksRef.current.onWatchException?.(err as Error);
            }
            // unavailable / 未达上限的 retryable：静默退避后继续 loop
            await delay(decision.delayMs);
            if (cancelled) return;
            continue;
          }
        }

        // 终态 done / task_deleted / 410 / hydrated-404 → 停止订阅
        if (cancelled || gotTerminalDone || gotTaskDeleted) return;

        // 被动断流（maxDuration 到点 / 网络抖 / 服务端重启）→ 干净重连
        await delay(WATCH_CLEAN_RECONNECT_DELAY_MS);
        if (cancelled) return;
      }
    };
    void loop();

    return () => {
      cancelled = true;
      ctrl.abort();
      clearBackoff();
    };
  }, [taskId, enabled, reconnectKey]);
};
