/**
 * 内存治理契约（纯函数，无 SDK 依赖、无副作用）。
 *
 * - ① 即用即还判定：shouldDisposeAfterAction（task-runner 正常结束路径调用）
 *
 * 2026-10-09：worker 进程隔离（v3.1）整体删除。本文件原先配套的 worker 专用契约
 * （双 guard 内存分级 / MAX_WORKERS 整机顶公式 / 续接双限额 / 意图日志幂等键与 at-most-once /
 * 接力预算 / epoch + fencing / 四档拦截点 / checkpoint 跨表校验 …）随之删除——它们的使用方
 * 只有 worker 子系统，生产路径从未引用。需要追溯：git 提交 a7874c2（引入）/ 19a914f（最后一次改动）。
 *
 * 档位标注（终审口径）：每条结论标 [源码证据 / 设计决策 / 待实验] 之一。
 */

export type ActionTerminalStatus =
  | "completed"
  | "cancelled"
  | "error"
  | "running"
  | "awaiting_ack"
  | "awaiting_user";

export interface DisposeAfterActionInput {
  /** 当前 run 绑定的 action 终态（无 action 传 undefined = 不 dispose） */
  lastActionStatus?: ActionTerminalStatus;
  /** pendingAsk 在等用户答 */
  askPending: boolean;
  /** 后置 check 在飞（交卷审阅中） */
  checkInFlight: boolean;
  /** 问一问 run（短问答，不动会话） */
  questionRun: boolean;
}

/**
 * [设计决策] action 已终态（completed / cancelled）且无 pending 追问/ask/check 在飞
 * → 堆上会话即用即还（keepPersisted=true）。
 * error 不在此 dispose（error 收尾分支已关会话，避免重复关）；
 * awaiting_*（等审阅/等用户）必须保留热会话。
 */
export const shouldDisposeAfterAction = (
  input: DisposeAfterActionInput,
): boolean => {
  if (input.questionRun) return false;
  if (input.askPending) return false;
  if (input.checkInFlight) return false;
  return (
    input.lastActionStatus === "completed" ||
    input.lastActionStatus === "cancelled"
  );
};
