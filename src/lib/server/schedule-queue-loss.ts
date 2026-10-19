/**
 * 排队中的定时消息被清掉 → 会话内提示。
 *
 * 会话正在跑时，定时消息进 chat 队列、下游回 202「已受理」，runner 据此记成已送达。
 * 之后用户点停止 / 回退，队列被 `failQueuedItems` 清空并向全局流 publish `queue_failed { itemIds, reason }`——
 * 这条消息其实没执行，一次性定时就此静默蒸发。这里订阅全局流，认出 itemId 形如 `<scheduleId>.<seq>.<attempt>`
 * 的（见 `parseScheduleClientItemId`），往会话里补一条 info 提示。
 *
 * 只提示、不改定时记录：记录的结算语义（done / fired 次数 / max_runs 名额）不为这种事回滚；提示本身就是事实陈述。
 * 全程吞错：这是锦上添花的通知，绝不能影响队列清理链路（listener 里抛错会被 task-stream 记 error，但别制造噪音）。
 */

import {
  buildScheduleInfoMeta,
  parseScheduleClientItemId,
  QUEUE_LOSS_SILENT_REASONS,
  queueLostText,
} from "@/lib/schedule";

import { readSchedules } from "./schedule-store";
import { subscribeAllTaskStreams, writeEventAndPublish } from "./task-stream";

const warn = (msg: string, err?: unknown): void => {
  console.warn(`[schedule-queue-loss] ${msg}`, err instanceof Error ? err.message : (err ?? ""));
};

/** 同一条消息的 queue_failed 可能双发（ledger 重放 / 多路径清队）：已提示过的不再提示 */
const NOTIFIED_MAX = 500;
const notifiedKeys = (): Set<string> => {
  const g = globalThis as unknown as Record<string, Set<string> | undefined>;
  return (g.__flowshipScheduleQueueLossNotifiedV1__ ??= new Set());
};

/** 处理一帧 queue_failed；返回实际写出的提示条数（测试用） */
export const handleQueueFailedFrame = async (
  taskId: string,
  itemIds: readonly string[],
  reason: string,
): Promise<number> => {
  if (QUEUE_LOSS_SILENT_REASONS.includes(reason)) return 0;
  let written = 0;
  for (const itemId of itemIds) {
    const parsed = parseScheduleClientItemId(itemId);
    if (!parsed) continue;
    const seen = notifiedKeys();
    const key = `${taskId}:${parsed.scheduleId}.${parsed.seq}`;
    if (seen.has(key)) continue;
    if (seen.size >= NOTIFIED_MAX) seen.clear(); // 清空只会让极少数重复帧多提示一次
    seen.add(key);
    try {
      let rec;
      try {
        rec = (await readSchedules(taskId)).find((r) => r.id === parsed.scheduleId);
      } catch {
        rec = undefined; // 读不出来就用通用措辞，提示照发
      }
      const ev = await writeEventAndPublish(taskId, {
        kind: "info",
        text: queueLostText(rec, reason),
        meta: buildScheduleInfoMeta(parsed.scheduleId, "failed"),
      });
      // null = 任务已经不在了（appendEvent 不会替它重建目录）：没写出去就不计数
      if (ev) written += 1;
    } catch (err) {
      warn(`写提示失败 task=${taskId} item=${itemId}`, err);
    }
  }
  return written;
};

const UNSUB_KEY = "__flowshipScheduleQueueLossUnsubV1__";

/** 订阅全局流（幂等；dev HMR 下重复调用会先摘掉旧订阅，不会叠出多份） */
export const startScheduleQueueLossWatcher = (): void => {
  const g = globalThis as unknown as Record<string, (() => void) | undefined>;
  g[UNSUB_KEY]?.();
  g[UNSUB_KEY] = subscribeAllTaskStreams((taskId, ev) => {
    if (ev.kind !== "queue_failed") return;
    void handleQueueFailedFrame(taskId, ev.itemIds, ev.reason).catch((err) =>
      warn(`处理 queue_failed 失败 task=${taskId}`, err),
    );
  });
};
