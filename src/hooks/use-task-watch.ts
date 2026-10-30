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
 * - **被动断开自动重连（V0.6.8）**：SSE 流可能被动断开（网络抖动、服务端重启、代理 / 系统休眠掐连接；
 *   注意不含 route 的 `maxDuration=300`——自托管运行时不执行它，不会每 300s 断一次），此时 watchTaskStream 正常返回 / 抛错、但 effect 不会自己重跑、
 *   客户端就**静默停在断连那一刻的状态**——典型表现：agent 产出了 artifact 但页面不刷新、
 *   必须手动刷新 / 切 action tab 才看到。解法是 hook 内部用 loop 自动重连。
 * - **done ≠ 停止订阅（V0.11.6 修）**：V0.11 起 run = 一个回合、agent 每说完一轮都 publish
 *   done——旧「收到 done 就不再重连」会让页面在任意一轮后断流、后续 send 起的新 run 事件
 *   全收不到（实测：ask 弹窗答完永远卡「提交中」）。现在只有 done 里的 task 是业务终态
 *   （merged / abandoned、服务端也只在这种情况关流）才停止订阅、其余照常保持 / 重连。
 * - 已 hydrate watcher 的 404→deleted；503 unavailable 持续重试（不终止）。
 * - **重试预算耗尽不再静默停更**：连续 6 次建连失败（约 22s 退避）后进入「休眠待重连」——
 *   提示一次（带 resume 句柄供「重连」按钮）、之后靠 online / 页面回可见 / 60s 兜底（仅可见且在线）
 *   自动重连，唤醒后预算清零；页面隐藏时不重试。
 * - **预算只在「稳定连接」后清零（Q16-01）**：建连（首个合法 bootstrap 帧）只记时刻，连接结束时撑过 2s
 *   （WATCH_STABLE_CONNECTION_MS）才清零；建连后立刻被掐断 / 回调立刻抛错的连接按失败累计，
 *   不会因为「每轮都先建连、先清零」而永远攒不到上限（永不休眠、不提示、静默无限重连）。
 *   终态（merged/abandoned 的 done、task_deleted）后关流不看稳定性、直接停止订阅。
 */

import { useEffect, useRef } from "react";

import {
  ApiRequestError,
  watchTaskStream,
  type TaskEventMeta,
  type TaskStreamCallbacks,
} from "@/lib/task-store";
import {
  classifyWatchHttpStatus,
  isTaskTerminalDeleted,
  resolveWatchCleanEof,
  resolveWatchReconnectPolicy,
  WATCH_CLEAN_RECONNECT_DELAY_MS,
} from "@/lib/task-terminal";
import {
  applyReconnectDecision,
  createDormantWaiter,
  freshWatchBudget,
  settleWatchBudget,
  stepDormantNotice,
  withBootstrapNotice,
} from "@/lib/watch-reconnect";
import type { BackgroundSubagentJobView } from "@/lib/background-subagents";
import type { AssistantSnapshot } from "@/lib/assistant-live";
import type { ThinkingSnapshot } from "@/lib/thinking-live";
import type { StorageDegradedState } from "@/lib/storage-degraded";
import type { TalkQueueItem } from "@/lib/talk-queue";
import type { ActionRecord, Task, TaskEvent } from "@/lib/types";

export {
  classifyWatchHttpStatus,
  resolveWatchCleanEof,
  resolveWatchReconnectPolicy,
  WATCH_CLEAN_RECONNECT_DELAY_MS,
  WATCH_DORMANT_RETRY_INTERVAL_MS,
  shouldResumeWatch,
  WATCH_MAX_TRANSIENT_FAILURES,
  WATCH_UNAVAILABLE_BACKOFF_CAP_MS,
} from "@/lib/task-terminal";

export interface UseTaskWatchCallbacks {
  /**
   * 落盘事件。meta.replay === true = 每次（重）连接 bootstrap 回放的历史尾部事件，不是刚发生的——
   * 不能据此认为「这段思考 / 流式回复结束了」。实时事件不传 meta
   */
  onEvent?: (ev: TaskEvent, meta?: TaskEventMeta) => void;
  onTaskUpdate?: (task: Task) => void;
  onActionUpdate?: (action: ActionRecord) => void;
  onAssistantDelta?: (text: string) => void;
  /**
   * 思考实时增量（纯内存、不落盘）——chat 用它在思考进行中把「进行中的 thinking 行」画进流程。
   * eventId = 这段思考落盘后那条 thinking 事件的 id（同一段内不变、id 变了 = 新的一段）
   */
  onThinkingDelta?: (text: string, eventId: string) => void;
  /**
   * 进行中思考的快照：每次（重）连接 bootstrap 末尾恰好一帧。对象 = 此刻正在思考（带已发出的文本，
   * 前端接着长、不从头吐）；null = 没在思考（清掉本地残留的实时态）
   */
  onThinkingSnapshot?: (snapshot: ThinkingSnapshot | null) => void;
  /**
   * 进行中正文的快照：每次（重）连接 bootstrap 恰好一帧。对象 = 此刻正在吐字（带已发出的整段，
   * 前端铺上再接着拼、不只剩后半截）；null = 没在吐字（清掉本地残留的流式文字）
   */
  onAssistantSnapshot?: (snapshot: AssistantSnapshot | null) => void;
  /** origin 有值 = 旁路群答疑 run 的 done，不是属主主 run 的（见 owner-run-signal.planDoneFrame） */
  onDone?: (task: Task, ok: boolean, origin?: string) => void;
  // SSE envelope 里的 error 帧（服务端主动发的协议错误）
  onErrorMessage?: (message: string) => void;
  // watchTaskStream 自己 throw 出来的异常（HTTP 4xx / 网络断 / 解析错）
  // AbortError 已被 hook 内部吞掉、不会触发这个回调
  // resume 仅在「重试预算耗尽、已进入休眠」时给：调用方可在提示里挂「重连」按钮，点了立即重连
  // （不点也会在网络恢复 / 页面回到前台 / 低频兜底时自动重连，不会静默停更）
  onWatchException?: (err: Error, resume?: () => void) => void;
  /**
   * 休眠待重连结束：连接重新建立（自动 / 手动唤醒成功），或 hook 卸载 / 切换任务时回调。
   * 调用方在这里撤掉 onWatchException 里挂的常驻「重连」提示。没休眠过不回调。
   * taskId 取自 hook 内闭包（切换任务的 cleanup 里 callbacksRef 已指向新 render，别在回调里读当前 task）。
   */
  onWatchDormantEnd?: (taskId: string) => void;
  /**
   * 每个连接的第一帧 task 快照（= 服务端 bootstrap，权威）。重连 / 休眠唤醒后同样会来，
   * 调用方用它校准「只靠 done 事件释放」的本地 latch（见 reconcileRunActive）。
   */
  onBootstrapSnapshot?: (t: Task) => void;
  /** queue_failed 控制帧 → 按 itemIds 清 / 标错 pending */
  onQueueFailed?: (itemIds: string[], reason: string) => void;
  /** bootstrap queue_state + operationSnapshot */
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
   * 显式 message_op 帧（phase / outcome）——成功终态唯一来源之一。
   */
  onMessageOp?: (payload: {
    itemId: string;
    phase?: string;
    outcome?: string;
  }) => void;
  /**
   * 旁路（受限群答疑）run 在飞与否——它不写 task.runStatus，
   * 调用方要把它并进「运行中」判定，否则它的工具块会被渲染成「已中断」。
   * 每次连接的 bootstrap 会补发当前值，断线重连后不会停在旧状态。
   */
  onRestrictedRun?: (active: boolean) => void;
  /** task 模式待送达队列快照 */
  onTalkQueue?: (items: TalkQueueItem[]) => void;
  /**
   * chat 会话后台子代理在飞清单（整份快照、空数组 = 没有）——主 AI 说完一轮后它们可能还在干活，
   * 调用方据此在输入框上方画「子代理在后台工作」条。每次连接的 bootstrap 会补发当前值。
   */
  onBackgroundSubagents?: (jobs: BackgroundSubagentJobView[]) => void;
  /**
   * 存储降级状态（事件写盘失败：磁盘满 / 只读 / IO 错误…）——`{ code }` = 降级中，`null` = 没降级 / 已恢复。
   * 调用方据此在事件流顶部画红条。每次连接的 bootstrap 会补发当前值，断线重连后不会停在旧状态。
   */
  onStorageDegraded?: (state: StorageDegradedState | null) => void;
  /**
   * task_deleted / watch 410 / 已 hydrate 的 404 → 停重连。
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

    // 退避预算耗尽后的「休眠待重连」状态机在 lib/watch-reconnect.ts（可单测）：
    // 唤醒源 online / 页面回可见 / 低频兜底定时（仅可见且在线才生效）/ 用户点「重连」，唤醒后预算清零
    const waiter = createDormantWaiter();
    let dormant = false;
    const endDormantNotice = (event: "connected" | "teardown") => {
      const step = stepDormantNotice(dormant, event);
      dormant = step.dormant;
      if (step.dismiss) callbacksRef.current.onWatchDormantEnd?.(taskId);
    };

    const decisionCtx = {
      isCancelled: () => cancelled,
      delay,
      waiter,
      notify: (err: Error, resume?: () => void) =>
        callbacksRef.current.onWatchException?.(err, resume),
      onDormant: () => {
        dormant = stepDormantNotice(dormant, "enter").dormant;
      },
    };

    // 自动重连循环：被动断流就退避后重连；只有「任务业务终态的 done」/ deleted 才停
    // enabled=true 隐含已 hydrate——404 可安全当物理删除完成
    const loop = async () => {
      // 两类计数独立——503 不兑换成一次即终止的网络错误预算
      // unavailableNotified：unavailable 达阈值后只 toast 一次
      const budget = freshWatchBudget();
      while (!cancelled) {
        // 本次连接是否收到「终态 done」（task merged/abandoned、服务端随即关流）——
        // 回合级 done（V0.11 每轮 run 结束都发）不算、流保持 / 断了照常重连
        let gotTerminalDone = false;
        // 收到 task_deleted / 410 / hydrated-404 后不再重连
        let gotTaskDeleted = false;
        // 本次连接建连（首个合法 bootstrap 帧）的时刻；null = 还没建连。连接结束时据此判断撑没撑过稳定窗口
        // （`as` 写法：让 TS 不把它窄化成 null——赋值发生在下面的回调闭包里）
        let establishedAt = null as number | null;
        const forwardTaskUpdate = (t: Task) => {
          callbacksRef.current.onTaskUpdate?.(t);
        };
        // 先转发、再对本连接第一帧（bootstrap 快照）补一个校准回调
        const bootstrapAwareTaskUpdate = withBootstrapNotice(
          forwardTaskUpdate,
          (t) => callbacksRef.current.onBootstrapSnapshot?.(t),
        );
        const sseCallbacks: TaskStreamCallbacks = {
          onEvent: (ev, meta) => {
            if (cancelled) return;
            // meta 原样透传（回放才有）；没有时仍按单参数调，保持实时事件的调用形状不变
            if (meta) callbacksRef.current.onEvent?.(ev, meta);
            else callbacksRef.current.onEvent?.(ev);
          },
          onTaskUpdate: (t) => {
            if (cancelled) return;
            bootstrapAwareTaskUpdate(t);
          },
          onActionUpdate: (a) => {
            if (cancelled) return;
            callbacksRef.current.onActionUpdate?.(a);
          },
          onAssistantDelta: (text) => {
            if (cancelled) return;
            callbacksRef.current.onAssistantDelta?.(text);
          },
          onThinkingDelta: (text, eventId) => {
            if (cancelled) return;
            callbacksRef.current.onThinkingDelta?.(text, eventId);
          },
          onThinkingSnapshot: (snapshot) => {
            if (cancelled) return;
            callbacksRef.current.onThinkingSnapshot?.(snapshot);
          },
          onAssistantSnapshot: (snapshot) => {
            if (cancelled) return;
            callbacksRef.current.onAssistantSnapshot?.(snapshot);
          },
          onDone: (t, ok, origin) => {
            if (cancelled) return;
            if (t.repoStatus === "merged" || t.repoStatus === "abandoned") {
              gotTerminalDone = true;
            }
            callbacksRef.current.onDone?.(t, ok, origin);
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
          onRestrictedRun: (active) => {
            if (cancelled) return;
            callbacksRef.current.onRestrictedRun?.(active);
          },
          onTalkQueue: (items) => {
            if (cancelled) return;
            callbacksRef.current.onTalkQueue?.(items);
          },
          onBackgroundSubagents: (jobs) => {
            if (cancelled) return;
            callbacksRef.current.onBackgroundSubagents?.(jobs);
          },
          onStorageDegraded: (state) => {
            if (cancelled) return;
            callbacksRef.current.onStorageDegraded?.(state);
          },
          onTaskDeleted: (deletedId) => {
            if (cancelled) return;
            gotTaskDeleted = true;
            // 已 sticky 则不再回调，保证恰好一次进入 terminal / toast
            if (!isTaskTerminalDeleted(deletedId)) {
              callbacksRef.current.onTaskDeleted?.(deletedId);
            }
          },
          // 首个合法 bootstrap task 帧只记建连时刻；预算等连接结束时、看撑没撑过稳定窗口再清零（Q16-01）——
          // 建连即清零会让「建连后立刻断」的连接每轮都先清零再记成第 1 次失败，永远攒不到上限
          onConnectionEstablished: () => {
            establishedAt = Date.now();
            // 休眠后重连成功：撤掉常驻的「重连」提示
            endDormantNotice("connected");
          },
        };

        try {
          await watchTaskStream(taskId, sseCallbacks, ctrl.signal);
          // 终态 done / task_deleted 后服务端关流是「正常结束」：必须先于稳定性判定返回——
          // merged 任务 bootstrap + done 后毫秒级关流，不能被当成「建连后立刻断开」而重连
          if (cancelled || gotTerminalDone || gotTaskDeleted) return;
          // 撑过稳定窗口才清预算（settleWatchBudget 内清零）；
          // 没撑过 / 建连前就空流的 clean EOF 走 retryable 预算（与 fetch reject 同账）
          const stable = settleWatchBudget(budget, establishedAt, Date.now());
          const eof = resolveWatchCleanEof({ established: stable, ...budget });
          if (eof.kind === "epoch_reset") {
            budget.unavailableAttempts = eof.nextUnavailableAttempts;
            budget.transientFailures = eof.nextTransientFailures;
            budget.unavailableNotified = eof.nextUnavailableNotified;
          } else if (eof.decision.action !== "terminate_deleted") {
            const outcome = await applyReconnectDecision(eof.decision, {
              budget,
              error: new Error(
                establishedAt === null
                  ? "SSE 流在建立前关闭"
                  : "SSE 连接建立后立即断开",
              ),
              ...decisionCtx,
            });
            if (outcome === "stop") return;
            continue;
          }
        } catch (err) {
          if (
            (err as { name?: string }).name === "AbortError" ||
            ctrl.signal.aborted
          ) {
            return;
          }
          // 建连后撑过稳定窗口再断 / 抛错：先清零，再把这次记成新一轮的第 1 次失败（不把上轮累计带进来）；
          // 没撑过（建连后立刻断、回调立刻抛错）、从未建连：预算原样，失败照常累计
          settleWatchBudget(budget, establishedAt, Date.now());
          // 本 hook 仅在 enabled（已 hydrate）时运行 → 404 可 commit deleted
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
            ...budget,
          });

          if (decision.action === "terminate_deleted") {
            gotTaskDeleted = true;
            if (!cancelled && !isTaskTerminalDeleted(taskId)) {
              callbacksRef.current.onTaskDeleted?.(taskId);
            }
          } else {
            // retry：unavailable / 未达上限的 retryable 静默退避；terminate_exhausted：
            // 提示一次 → 休眠待重连（而非静默放弃）→ 被唤醒后预算清零重新来
            const outcome = await applyReconnectDecision(decision, {
              budget,
              error: err as Error,
              ...decisionCtx,
            });
            if (outcome === "stop") return;
            continue;
          }
        }

        // 终态 done / task_deleted / 410 / hydrated-404 → 停止订阅
        if (cancelled || gotTerminalDone || gotTaskDeleted) return;

        // 被动断流（网络抖 / 服务端重启 / 休眠恢复；route 的 maxDuration 在自托管运行时不生效，不是断流原因）→ 干净重连
        await delay(WATCH_CLEAN_RECONNECT_DELAY_MS);
        if (cancelled) return;
      }
    };
    void loop();

    return () => {
      cancelled = true;
      ctrl.abort();
      clearBackoff();
      // 休眠中卸载 / 切换任务：拆监听 / 定时器并让挂起的 loop 退出，同时撤掉常驻的「重连」提示
      waiter.resume(false);
      endDormantNotice("teardown");
    };
  }, [taskId, enabled, reconnectKey]);
};
