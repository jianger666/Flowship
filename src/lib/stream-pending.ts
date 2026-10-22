/**
 * 事件流尾部「真实事件 / 流式回复 / 本地占位」的排序，以及「本地新发起的占位出现」的判定
 * （2026-10-20 第二轮 review：V1-01 / V2-01）。
 *
 * 都是纯函数，EventStream 只负责接线；行为测试在 tests/stream-pending.test.ts。
 */

import { classifyPendingBubble, type PendingBubbleMode } from "@/lib/chat-pending-display";
import { insertBeforeTrailingCompaction } from "@/lib/compaction-display";

/** 排序只需要看 kind / meta（压缩过程行靠它们识别），不绑具体的 RenderItem 联合类型 */
type OrderedItemLike = {
  kind?: string;
  meta?: Record<string, unknown>;
};

/**
 * 拼事件流尾部：`flow`（真实事件，含已收进来的压缩过程行）→ 流式回复 → 本地 pending 占位。
 *
 * 为什么 streaming 必须插在 `flow` 里、不能插在 `[...flow, ...pending]` 里（V1-01）：
 * 老写法对「已经拼好 pending 的数组」调 insertBeforeTrailingCompaction——此时尾项是 pending、不是压缩行，
 * 流式气泡于是落到所有 pending 之后，排队气泡画在流式回复**上方**；而回复定稿后它变成 flow 里的
 * assistant_message、pending 仍在其后，气泡又跳到回复**下方**——排队期间每个文本段都来回跳一次。
 * 现在的顺序与定稿后一致：流式项（连同「回复 → 正在压缩」的压缩行顺序）永远排在 pending 之前。
 *
 * 不改入参；`streaming` 为 null / undefined 时就是 `[...flow, ...pending]`。
 */
export const composeStreamTail = <T extends OrderedItemLike>(
  flow: readonly T[],
  pending: readonly T[],
  streaming?: T | null,
): T[] => [
  ...(streaming ? insertBeforeTrailingCompaction(flow, streaming) : flow),
  ...pending,
];

/** 占位只需要 id；`local` 见 {@link nextPendingScan} */
export type PendingScanItem = {
  id: string;
  /**
   * 是不是本窗口本次挂载内用户自己提交的。**只有 `true` 才算**（fail-closed，R5-03）：
   * bootstrap 从服务端快照重建的、别的窗口登记的占位标 `false`；今后新增的占位来源忘了标，
   * 缺省也只是「不触发滚动」，而不是把正在翻历史的人拽到底部。
   */
  local?: boolean;
};

/**
 * 「提交即到底」的判定（V2-01）：这一轮渲染相对上一轮，有没有**本窗口新发起**的占位出现。
 *
 * 只认「本地发起」：飞书 / 别的窗口的消息走 user_reply 事件、不会有占位；SSE 重连 bootstrap 会把
 * 服务端还活着的条目重建成占位（`local: false`），这些出现不是用户这次按了回车——
 * 否则正在翻历史的人会被它们拽到底部。
 *
 * @param prevIds 上一轮看到的占位 id；`null` = 基线还没建（首次挂载 / 刚切 task），
 *   此刻已经在的占位都只当基线、不算「新发起」。
 * @returns `ids` = 本轮占位 id 全集（调用方存起来当下一轮的基线；已消失的占位不留）。
 */
export const nextPendingScan = (
  prevIds: ReadonlySet<string> | null,
  pending: readonly PendingScanItem[],
): { ids: Set<string>; hasNewLocal: boolean } => {
  const ids = new Set(pending.map((p) => p.id));
  if (prevIds === null) return { ids, hasNewLocal: false };
  const hasNewLocal = pending.some((p) => p.local === true && !prevIds.has(p.id));
  return { ids, hasNewLocal };
};

/** {@link applyPendingScan} 存的基线（EventStream 里放在 ref） */
export type PendingScanBaseline = { taskId: string; ids: Set<string> };

/**
 * 「提交即到底」的 effect 体（纯函数，EventStream 的 effect 只负责传 ref 与回调；R5-03）。
 * 基线按 task 存：切 task 时不拿上个任务的占位 id 当基线（否则新任务里已有的占位被当成「刚发的」）；
 * 有本窗口新发起的占位就调 `scrollToBottom`（缓动回底并恢复跟随）。
 * @returns 新基线（调用方写回 ref）
 */
export const applyPendingScan = (
  prev: PendingScanBaseline | null,
  taskId: string,
  pending: readonly PendingScanItem[],
  scrollToBottom: () => void,
): PendingScanBaseline => {
  const scan = nextPendingScan(prev && prev.taskId === taskId ? prev.ids : null, pending);
  if (scan.hasNewLocal) scrollToBottom();
  return { taskId, ids: scan.ids };
};

/**
 * chat 的 ledger 占位 → 事件流占位（纯函数，R5-03）：
 *  - `visible`：谁该画（隐藏的终态占位 / 没有内容可画的 bootstrap 重建占位不送进事件流）；
 *  - `mode`：展示分类取「提交那一刻 run 是否在跑」的快照（`queuedAtSubmit`），没登记过的退回当前 `runActive`；
 *  - `local`：**只有本窗口本次挂载内登记过的**（`queuedAtSubmit` 里有）才是「用户刚按了回车」。
 *    bootstrap 重建的占位没登记过 → false，出现时不能把正在翻历史的人拽到底部。
 */
export const projectPendingForStream = <
  P extends { itemId: string; uncertain?: boolean },
>(
  pending: readonly P[],
  ctx: {
    visible: (p: P) => boolean;
    queuedAtSubmit: ReadonlyMap<string, boolean>;
    runActive: boolean;
  },
): Array<P & { mode: PendingBubbleMode | undefined; local: boolean }> =>
  pending
    .filter(ctx.visible)
    .map((p) => ({
      ...p,
      mode: classifyPendingBubble({
        uncertain: p.uncertain,
        queued: ctx.queuedAtSubmit.get(p.itemId) ?? ctx.runActive,
      }),
      local: ctx.queuedAtSubmit.has(p.itemId),
    }));
