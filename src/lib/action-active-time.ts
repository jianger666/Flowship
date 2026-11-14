/**
 * Action「实际运行时长」结算（纯函数，服务端写盘点与前端展示共用）
 *
 * 为什么不能直接用 `endedAt - startedAt`：
 *   「再聊聊」会把 awaiting_ack 的 action 拉回 running，所以一个 action 的起止跨度里
 *   80%+ 是「交卷后人没回来」的闲置空档（实测 >20 分钟无事件的占 80–98%），
 *   拿它当耗时会把「等人」算成「agent 慢」。
 *
 * 口径：只累计 status=running 的区间。
 *   - running → 非 running：把 [区间起点, now] 结算进 activeMs，清掉 runningSince
 *   - 非 running → running：runningSince = now 开新区间
 *   - 其它迁移（awaiting_ack → completed 等）：不动
 *   区间起点缺省回退 startedAt（action 新建即 running，首段不必单独记起点）。
 *
 * 老数据（没有 activeMs）读出来是 null =「未知」，不拿跨度冒充。
 * 「老数据被『再聊聊』拉回运行」也是未知：它第一段的真实时长没记过，只累后一段会得到一个偏小的真数（R21-01），
 * 所以这类 action 从拉回那一刻起一直保持未知，不开始累计（判据见 {@link isLegacyPartial}）。
 */
import type { ActionRecord, ActionStatus } from "@/lib/types";

type ActiveTimeFields = Pick<
  ActionRecord,
  "status" | "startedAt" | "activeMs" | "runningSince"
>;

/**
 * 这个 action 是不是「上线前就跑过一段、没记 activeMs，又被拉回运行」的老数据（运行时长已无法还原，只能一直未知）。
 *
 * 判据是精确的：新 action 首段 runningSince 为空（回退 startedAt），首段一结束就一定有 activeMs；
 * runningSince 只在「非 running → running」时由本模块写入。所以「activeMs 缺失 + runningSince 有值」
 * **只可能**是老 action 被拉回——这时已结算的第一段丢了，后一段单独算出来的数不能当完整值。
 */
const isLegacyPartial = (a: Pick<ActionRecord, "activeMs" | "runningSince">): boolean =>
  a.activeMs === undefined && a.runningSince !== undefined;

/** 结算结果：直接展开合并进新的 ActionRecord（runningSince 置 undefined 会在 JSON 落盘时被丢弃） */
export type ActiveTimeSettlement = Pick<ActionRecord, "activeMs" | "runningSince">;

/**
 * 状态迁移时结算运行时长。
 *
 * @param settleAt 结算时刻，缺省 prev 之外的调用方传 now；
 *   僵尸恢复这类「真实停止时刻未知」的场景传保守下界（宁可低估，不让关机空档灌水）
 * @returns 需要合并进 next 的字段；本次迁移不影响运行时长 → null（调用方什么都不用做）
 */
export const settleActiveTime = (
  prev: ActiveTimeFields,
  nextStatus: ActionStatus,
  now: number,
  settleAt: number = now,
): ActiveTimeSettlement | null => {
  const wasRunning = prev.status === "running";
  const willRun = nextStatus === "running";
  if (wasRunning === willRun) return null;
  if (willRun) {
    return { activeMs: prev.activeMs, runningSince: now };
  }
  // 老 action 被拉回后再结算：第一段已丢，保持「未知」（activeMs 仍缺省），不拿后一段冒充完整值
  if (isLegacyPartial(prev)) return { activeMs: undefined, runningSince: undefined };
  // running → 非 running：结算本段。起点之前的结算时刻（时钟回拨 / 保守下界）按 0 算，不出负数
  const since = prev.runningSince ?? prev.startedAt;
  return {
    activeMs: (prev.activeMs ?? 0) + Math.max(0, settleAt - since),
    runningSince: undefined,
  };
};

/**
 * 读取侧：这个 action 实际跑了多久（毫秒）。
 *
 * - 运行中：已结算 + 当前区间到 now（实时增长）
 * - 非运行：已结算值
 * - 老数据（非运行且没有 activeMs）→ null，展示层按「未知」处理
 * - 老数据被拉回运行（运行中但第一段已丢，见 isLegacyPartial）→ 同样 null，不给「只含本段」的偏小值
 */
export const getActionActiveMs = (
  action: ActiveTimeFields,
  now: number,
): number | null => {
  if (action.status === "running") {
    if (isLegacyPartial(action)) return null;
    const since = action.runningSince ?? action.startedAt;
    return (action.activeMs ?? 0) + Math.max(0, now - since);
  }
  return typeof action.activeMs === "number" ? action.activeMs : null;
};
