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
 */

import { useEffect, useRef } from "react";

import { watchTaskStream, type TaskStreamCallbacks } from "@/lib/task-store";
import type { ActionRecord, Task, TaskEvent } from "@/lib/types";

// 被动断流后重连退避：干净结束（maxDuration 到点）等这么久再连
const RECONNECT_DELAY_MS = 1000;
// 连续报错（网络断 / 服务端没起来）最多重试几次、超了才弹 onWatchException、避免无限刷
const MAX_CONSECUTIVE_FAILURES = 6;

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

    // 自动重连循环：被动断流就退避后重连；只有「任务业务终态的 done」才停止订阅
    const loop = async () => {
      let failures = 0; // 连续报错次数、用于退避 + 兜底放弃
      while (!cancelled) {
        // 本次连接是否收到「终态 done」（task merged/abandoned、服务端随即关流）——
        // 回合级 done（V0.11 每轮 run 结束都发）不算、流保持 / 断了照常重连
        let gotTerminalDone = false;
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
        };

        try {
          await watchTaskStream(taskId, sseCallbacks, ctrl.signal);
          failures = 0; // 成功连过一次、清零退避
        } catch (err) {
          if (
            (err as { name?: string }).name === "AbortError" ||
            ctrl.signal.aborted
          ) {
            return;
          }
          failures += 1;
          if (failures >= MAX_CONSECUTIVE_FAILURES) {
            if (!cancelled) callbacksRef.current.onWatchException?.(err as Error);
            return;
          }
          // 否则静默重试（不弹 toast、避免抖一下就报错刷屏）
        }

        // 终态 done（merged/abandoned、服务端已关流）→ 停止订阅（reopen 走 reconnectKey）；
        // 卸载 / 切 task 也停
        if (cancelled || gotTerminalDone) return;

        // 被动断流（maxDuration 到点 / 网络抖 / 服务端重启）→ 退避后重连
        // 重连时服务端 bootstrap 会重发当前 task 快照、把断连期间漏掉的更新对齐回来
        const backoff =
          failures > 0
            ? Math.min(failures * 1500, 8000)
            : RECONNECT_DELAY_MS;
        await delay(backoff);
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
