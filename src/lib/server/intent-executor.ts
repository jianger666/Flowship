/**
 * 意图执行器主循环（v3.1 §5，接线层 B1-②：主进程侧唯一外部出口）。
 *
 * - 流程：pending 扫描（WAL + shim 合并）→ 按 kind 派发 handler → 成功 markDone，
 *   查不到/对不上/无 handler/抛错 → markAbandoned 人工兜底；
 * - 同 task 串行执行（防双执行）；本地写不进本循环（只记账、走 checkpoint）；
 * - 5 kind 的真实 handler（调 GitLab/飞书/git）在 task-runner 接线时注册，
 *   本模块只定接口 + 恢复语义，单测用 mock handler 锁定行为。
 */

import {
  decideIntentRecovery,
  loadIntents,
  markIntentAbandoned,
  markIntentDone,
  pendingIntentsWithShim,
  type IntentKind,
  type IntentRecord,
} from "./intent-log";

export type IntentVerdict =
  | { verdict: "done" }
  | { verdict: "abandoned"; reason: string }
  | { verdict: "not-present" };

export type IntentHandler = (rec: IntentRecord) => Promise<IntentVerdict>;

export type IntentHandlerRegistry = Partial<Record<IntentKind, IntentHandler>>;

export interface ExecuteSummary {
  done: number;
  abandoned: number;
  errors: { key: string; error: string }[];
}

/**
 * 恢复扫描主循环：扫出有 intent 无 done 的条目逐条执行。
 * - 无 handler 的 kind → abandoned（不静默跳过）；
 * - handler 抛错 → abandoned（不确定即不重试，at-most-once 安全侧）；
 * - handler 报 not-present → 按 decideIntentRecovery 定 retry/abandoned，
 *   本循环内 retry 即当场重调一次 handler，仍 not-present 则 abandoned。
 */
export const sweepPendingIntents = async (
  taskId: string,
  stateRoot: string,
  handlers: IntentHandlerRegistry,
): Promise<ExecuteSummary> =>
  executeIntentRecords(taskId, await pendingIntentsWithShim(taskId, stateRoot), handlers);

/** 对给定记录表执行主循环（recoverWithWorker 用合并扫描后的表，语义与 sweep 一致）。 */
export const executeIntentRecords = async (
  taskId: string,
  records: IntentRecord[],
  handlers: IntentHandlerRegistry,
): Promise<ExecuteSummary> => {
  const summary: ExecuteSummary = { done: 0, abandoned: 0, errors: [] };
  const pending = records;
  for (const rec of pending) {
    const key = rec.idempotencyKey;
    const handler = handlers[rec.kind];
    if (!handler) {
      await markIntentAbandoned(taskId, key);
      summary.abandoned += 1;
      continue;
    }
    let out: IntentVerdict;
    try {
      out = await handler(rec);
    } catch (err) {
      summary.errors.push({
        key,
        error: err instanceof Error ? err.message : String(err),
      });
      await markIntentAbandoned(taskId, key);
      summary.abandoned += 1;
      continue;
    }
    if (out.verdict === "done") {
      await markIntentDone(taskId, key);
      summary.done += 1;
    } else if (out.verdict === "abandoned") {
      await markIntentAbandoned(taskId, key);
      summary.abandoned += 1;
    } else {
      // not-present：反查确认缺席才允许重试（at-most-once 的一律 abandoned）。
      const decision = decideIntentRecovery({ kind: rec.kind, verifiedAbsent: true });
      if (decision === "retry") {
        try {
          const second = await handler(rec);
          if (second.verdict === "done") {
            await markIntentDone(taskId, key);
            summary.done += 1;
          } else {
            await markIntentAbandoned(taskId, key);
            summary.abandoned += 1;
          }
        } catch (err) {
          summary.errors.push({
            key,
            error: err instanceof Error ? err.message : String(err),
          });
          await markIntentAbandoned(taskId, key);
          summary.abandoned += 1;
        }
      } else {
        await markIntentAbandoned(taskId, key);
        summary.abandoned += 1;
      }
    }
  }
  return summary;
};

/** 调试/验收用：查某幂等键的最新状态。 */
export const intentStatusOf = async (
  taskId: string,
  idempotencyKey: string,
): Promise<string | null> => {
  const all = await loadIntents(taskId);
  const hit = [...all].reverse().find((r) => r.idempotencyKey === idempotencyKey);
  return hit ? hit.status : null;
};
