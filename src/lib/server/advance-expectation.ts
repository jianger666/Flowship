/**
 * 推进（advance）的「乐观并发」期望值（R14 Q7a-04，纯函数、可单测）
 *
 * 背景：`advanceTask` 靠 `runAdvanceExclusive` 把同一任务的推进串行化，但串行只解决「同时跑」，
 * 不解决「重复提交」——同一页面连点两下 / 两个窗口都点了「推进」，第二个请求排在第一个之后出队，
 * 照样往下走：再 `appendAction` 一条新 action，并把刚起的第一条标成 cancelled（实际是用户的一次意图
 * 被执行了两遍，前一遍还被误杀）。
 *
 * 修法：客户端在请求里带上「我点推进时看到的当前 action」（`expectedCurrentActionId`），
 * 服务端在串行队列里**出队后第一件事**对照盘上最新的 `currentActionId`——不一致说明
 * 页面已经陈旧 / 别的请求抢先推进过，直接以 {@link ADVANCE_STALE_MESSAGE} 拒掉（不留 error 事件、不动任何状态）。
 *
 * 取值语义（三态，刻意区分「没带」和「带了 null」）：
 *  - `undefined`：没带——老客户端 / 飞书群路径，保持旧行为（不做 CAS）
 *  - `null`：客户端看到的是「当前没有 action」（新任务 / 已回到空闲）
 *  - `string`：客户端看到的当前 action id
 */

/**
 * 期望值陈旧时给用户看的文案（路由入场早拒绝 / runner 出队后拒绝共用）。
 *
 * 刻意不复用 task-runner 的 `TASK_OP_STALE_HTTP_MESSAGE`（「正在停止/任务已变更、请重发」）：
 * 那句的「请重发」对「重复提交」是误导——第一次其实已经推进成功了，用户照着重发就会再起一条 action，
 * 正好是本机制要防的事。这里明说「这次没有重复推进」，并让用户先看最新进度、确需再推进再重新发起。
 * 路由靠它识别「陈旧」（409 `advance_stale`、不写 error 事件），所以不能与别处的让位文案相同。
 */
export const ADVANCE_STALE_MESSAGE =
  "任务状态已变化（可能刚被推进过）、这次没有重复推进——请先看最新进度，确需再推进请重新发起";

/** 路由 body 里 `expectedCurrentActionId` 的解析结果 */
export type ParsedExpectedCurrentActionId =
  | { ok: true; value: string | null | undefined }
  | { ok: false; error: string };

/** 解析请求体里的 `expectedCurrentActionId`：缺省 / null / 非空字符串合法，其余（数字、对象、空串）400 */
export const parseExpectedCurrentActionId = (
  raw: unknown,
): ParsedExpectedCurrentActionId => {
  if (raw === undefined) return { ok: true, value: undefined };
  if (raw === null) return { ok: true, value: null };
  if (typeof raw === "string" && raw.trim()) {
    return { ok: true, value: raw.trim() };
  }
  return {
    ok: false,
    error: "expectedCurrentActionId 必须是非空字符串或 null",
  };
};

/**
 * 客户端的期望是否已陈旧：没带期望（undefined）一律不算陈旧；
 * 盘上 `currentActionId` 缺省（undefined）与 null 等价（老任务 / 迁移残留）。
 */
export const isAdvanceExpectationStale = (
  currentActionId: string | null | undefined,
  expected: string | null | undefined,
): boolean => expected !== undefined && (currentActionId ?? null) !== expected;
