/**
 * 「这条信号是不是属主主 run 的」判定（纯函数，task 页 onEvent / onDone 共用，第三轮 review D9-01）。
 *
 * 群协作开着的需求任务里，旁路只读答疑 run 与属主主 run 并存（`restricted_run` 帧就是为此单独成帧、
 * 不接进 runStatus）。旁路 run 的 `assistant_message` / `done` 走的是同一条 SSE 通道：
 * 若页面不区分，旁路一条回答 / 一次收尾就会清掉属主**正在吐字**的流式气泡，
 * 甚至在 runStatus 非 running 的收尾期把属主的 run latch 提前放掉。
 *
 * 区分依据（服务端早已给足，只是客户端没看）：
 *   - 事件：落盘时 `meta.groupRun = origin`（writeOwnedEventAndPublish 打标，UI 折叠答疑整轮事件也靠它）；
 *   - done 帧：`origin` 字段（旁路才有，属主主链 / stop 补发的 done 没有这个字段，帧形状不变）。
 */
import type { RunStatus, TaskEvent } from "./types";

/** 事件是否出自旁路群答疑 run（meta.groupRun 非空字符串） */
export const isSideRunEvent = (ev: Pick<TaskEvent, "meta">): boolean => {
  const v = ev.meta?.groupRun;
  return typeof v === "string" && v.trim() !== "";
};

/**
 * 这条落盘事件到达时，要不要清属主的流式气泡：
 * 只有属主主链的 assistant_message（流式文本已定稿落盘）才清；旁路的不清。
 */
export const shouldClearStreamingOnEvent = (ev: TaskEvent): boolean =>
  ev.kind === "assistant_message" && !isSideRunEvent(ev);

/**
 * task 页的运行态（D6-02 / R3-05 / 第四轮 Q5-01）：
 *   - `mainRunActive`：只看属主主 run——错误卡「当轮失败」资格 / 状态行 / 状态槽 / 组尾「处理中…」/ 输入条用。
 *   - `isRunning`：**与 `mainRunActive` 同值**，不再并入旁路群答疑 run。
 *
 * 为什么不再并入旁路：当初并入是怕旁路 run 写进流里的工具被画成「已中断」；但旁路过程事件早已整条被
 * `isHiddenFromEventStream`（`meta.groupRun`）藏进「群问答」tab，主流里没有旁路工具块可画。
 * 继续并入只剩副作用——仅旁路在飞、属主空闲时，组尾冒出「处理中…」转圈、历史组被撑开、
 * 末项是属主消息时还追加「等待 AI」占位（状态行说「没在跑」，组尾说「处理中」，口径打架）。
 * 两个字段保留是为了 EventStream 的 `isRunning`（必填）/ `mainRunActive`（可选）两个 prop 都能照旧传。
 *
 * `runStatus`（D9-03）：传了就让「主 run 在跑」在**渲染期**就吃到 task 当前态——latch 要等 effect
 * （paint 之后）才跟上 `runStatus === "running"`，首个 commit 的 isRunning=false 会把在跑的工具块
 * 画成「已中断」；task 页的 task 又是异步加载的，光改 useState 初值也不够。不传 = 只看 latch（旧行为）。
 */
export const deriveRunFlags = (input: {
  runActive: boolean;
  runStatus?: RunStatus;
}): { isRunning: boolean; mainRunActive: boolean } => {
  const mainRunActive = input.runStatus
    ? effectiveRunActive(input.runActive, input.runStatus)
    : input.runActive;
  return { isRunning: mainRunActive, mainRunActive };
};

/**
 * 渲染期的「主 run 在跑」：latch 或 task 当前 runStatus 任一为真（D9-03）。
 * latch 只负责「runStatus 已落下去但流式尾巴还在吐」那一段；runStatus=running 时不必等 latch 置位。
 */
export const effectiveRunActive = (latch: boolean, runStatus: RunStatus): boolean =>
  latch || runStatus === "running";

export interface DonePlan {
  /** 清属主流式气泡（含 thinking 直播等同类实时态） */
  clearStreaming: boolean;
  /** 把 done 帧里的 task 快照吸收进本地（过期快照不吸收） */
  absorbSnapshot: boolean;
  /** 放属主 run latch + 清运行中 shell 的直播缓冲（run 真的收尾了才放） */
  releaseRunLatch: boolean;
}

/**
 * done 帧的处理计划。
 * - 旁路 run 的 done（有 origin）：不动属主任何实时态；快照照常按 updatedAt 守卫吸收；
 * - 属主主链的 done：先清流式（即使快照过期也清——旁路之外的 done 就是「这一轮结束了」）；
 *   快照比本地旧（唤醒后迟到的失败 done）不吸收、不放 latch，否则输入条会被错误解锁；
 *   runStatus 仍是 running（服务端还在跑）不放 latch。
 */
export const planDoneFrame = (input: {
  /** done 帧的 origin；旁路才有 */
  origin?: string | null;
  doneUpdatedAt: number;
  /** 本地已有快照的 updatedAt；还没有快照则缺省 */
  currentUpdatedAt?: number;
  runStatus: RunStatus;
}): DonePlan => {
  const isSide = typeof input.origin === "string" && input.origin.trim() !== "";
  const stale =
    input.currentUpdatedAt !== undefined && input.doneUpdatedAt < input.currentUpdatedAt;
  return {
    clearStreaming: !isSide,
    absorbSnapshot: !stale,
    releaseRunLatch: !isSide && !stale && input.runStatus !== "running",
  };
};
