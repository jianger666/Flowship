/**
 * 会话管理页「占用统计」的纯逻辑（无 React / 无 IO，便于单测）。
 *
 * 背景：工作区占用由服务端后台单路量尺（几 GB 一个、十几秒），页面隔几秒静默拉一次缓存，量完自动停。
 * 评审 R15-01：旧实现的下一次轮询只由「storage 状态变了」这个事件排出来——静默请求失败 / 到轮询上限时
 * 链条悄悄断掉，而 pending 仍 > 0，「重新统计」按钮永久禁用、顶部一直挂「统计中…」。
 * 现在轮询由独立的定时链驱动：失败也排下一次（指数退避、连续失败有上限），到上限或失败过多时**明确放弃**，
 * 界面改成「统计超时 / 失败，点重新统计」并让按钮可点。
 */

/** 静默轮询间隔（量一个 3~8GB 的工作区要十几秒、一个页面停留内总会量完） */
export const STORAGE_POLL_MS = 2500;
/** 一轮轮询最长持续多久，超了放弃（别在页面上无限轮询） */
export const STORAGE_POLL_MAX_MS = 10 * 60_000;
/** 连续失败多少次放弃（Mac 合盖休眠 / server 重启期间的偶发失败不该立刻放弃） */
export const STORAGE_POLL_MAX_FAILS = 5;
/** 失败后的退避：间隔 ×2、最多放大 8 倍 */
const BACKOFF_MAX_SHIFT = 3;
/**
 * 单次统计请求的超时。服务端平时读缓存、秒回；但请求一旦挂住（server 卡住 / 网络层吞掉），
 * 没有超时的 fetch 永远不返回，轮询链停在 `await scan` 上、「重新统计」永久禁用（评审 R16-06）。超时按失败处理。
 */
export const STORAGE_FETCH_TIMEOUT_MS = 30_000;

export type PollDecision =
  | { action: "wait"; delayMs: number }
  | { action: "giveup"; reason: "timeout" | "errors" };

/**
 * 一次静默请求结束后：继续等多久再拉，还是放弃。
 * - `startedAt`：这一轮轮询开始的时间（毫秒）；`now`：当前时间
 * - `consecutiveFailures`：到目前为止连续失败的次数（成功一次清零）
 */
export const decideNextPoll = (input: {
  startedAt: number;
  now: number;
  consecutiveFailures: number;
}): PollDecision => {
  const { startedAt, now, consecutiveFailures } = input;
  if (consecutiveFailures >= STORAGE_POLL_MAX_FAILS) return { action: "giveup", reason: "errors" };
  if (now - startedAt > STORAGE_POLL_MAX_MS) return { action: "giveup", reason: "timeout" };
  const shift = Math.min(Math.max(consecutiveFailures, 0), BACKOFF_MAX_SHIFT);
  return { action: "wait", delayMs: STORAGE_POLL_MS * 2 ** shift };
};

/** 一次统计请求的结果：是否成功、服务端还剩几个工作区在量（失败时 pending 无意义） */
export interface PollOutcome {
  ok: boolean;
  pending: number;
}

export type PollStepDecision = PollDecision | { action: "done" };

/**
 * 一次静默请求结束后推进轮询状态：算出新的连续失败数 + 下一步。
 * - 成功且服务端已经量完（pending ≤ 0）→ `done`：这一轮到此为止，**不论耗了多久都不是「超时」**。
 *   （评审 R16-04：最后一次请求恰好在 10 分钟线之后返回时，旧代码先把「放弃」标记清掉、紧接着又按超时重新置上，
 *   界面显示「统计超时」而实际早已统计完。）
 * - 否则交给 {@link decideNextPoll}（失败退避 / 失败过多 / 超时放弃）。
 */
export const stepPoll = (
  state: { startedAt: number; failures: number },
  outcome: PollOutcome,
  now: number,
): { failures: number; decision: PollStepDecision } => {
  const failures = outcome.ok ? 0 : state.failures + 1;
  if (outcome.ok && outcome.pending <= 0) return { failures, decision: { action: "done" } };
  return {
    failures,
    decision: decideNextPoll({ startedAt: state.startedAt, now, consecutiveFailures: failures }),
  };
};

/**
 * 一个工作区占用的显示状态：
 * - measured：有数
 * - measuring：没数、后台还在量（pending > 0 且没放弃轮询）——显示「统计中」
 * - unmeasurable：没数、也不会再变（后台已经量完 / 量不出，或页面放弃了轮询）——显示「量不出」，别一直转圈
 */
export type WorktreeSizeState = "measured" | "measuring" | "unmeasurable";

export const worktreeSizeState = (
  bytes: number | null,
  ctx: { pending: number; gaveUp: boolean },
): WorktreeSizeState => {
  if (bytes !== null) return "measured";
  return ctx.pending > 0 && !ctx.gaveUp ? "measuring" : "unmeasurable";
};

/** 「按大小排序」是否可用：占用数据在、且还有工作区在统计时顺序会随轮询跳，所以统计完（或放弃轮询）才开放 */
export const isSizeSortReady = (input: {
  hasStorage: boolean;
  pending: number;
  gaveUp: boolean;
}): boolean => input.hasStorage && (input.pending <= 0 || input.gaveUp);
