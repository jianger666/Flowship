/**
 * 答题卡「提交态」的状态迁移（纯函数，ask-user-inline 用；第三轮 review D7-01）。
 *
 * 为什么收成 reducer：提交态由 `submitting`（请求在飞）与 `inFlight`（>30s 未返回 / 409 投递冲突后转只读）
 * 两个量组成，原先各自 setState——失败分支只清了 submitting、漏了 inFlight，于是「30s 转投递中」之后
 * 请求自己失败，toast 说失败、卡片却继续写「回答投递中，请勿重复提交」约 90s，期间无法重答，
 * 而答案其实没送达、AI 在干等。一个 reducer 里把「每种事件两个量怎么一起迁」写成一张表，漏不掉。
 */
import { ApiRequestError } from "@/lib/task-store";

export interface AskSubmitState {
  /** 请求在飞（按钮「提交中…」） */
  submitting: boolean;
  /** 投递中只读：首次提交的链还在送答案（>30s 未返回，或撞上另一条链的 409） */
  inFlight: boolean;
}

export const ASK_SUBMIT_IDLE: AskSubmitState = { submitting: false, inFlight: false };

export type AskSubmitEvent =
  /** 点了提交 / 稍后再补充，请求发出 */
  | { type: "start" }
  /** 请求 >30s 还没返回：转投递中只读（不 abort，服务端可能还在送） */
  | { type: "slow" }
  /** 409 ask_in_flight：另一条链在送同一份答案，转投递中只读等终态 */
  | { type: "conflict" }
  /** 提交成功（含稍后再补充） */
  | { type: "succeeded" }
  /** 请求自己失败（非投递冲突）：答案没送达，回到可提交 */
  | { type: "failed" }
  /** 投递中 90s 兜底解锁（防事件丢失卡死） */
  | { type: "fallback_unlock" }
  /** 换了一道 ask：整体重置 */
  | { type: "reset" };

export const reduceAskSubmit = (
  state: AskSubmitState,
  event: AskSubmitEvent,
): AskSubmitState => {
  switch (event.type) {
    case "start":
      return { ...state, submitting: true };
    case "slow":
    case "conflict":
      return { submitting: false, inFlight: true };
    case "fallback_unlock":
      return { ...state, inFlight: false };
    case "succeeded":
    case "failed":
    case "reset":
      return ASK_SUBMIT_IDLE;
  }
};

/** 卡片是否锁住（选项 / 输入 / 按钮只读） */
export const isAskSubmitLocked = (s: AskSubmitState): boolean => s.submitting || s.inFlight;

export type AskSubmitErrorPlan =
  | { kind: "in_flight" }
  /** 可重试：网络断 / 5xx / 400 这类「答案没送达、改一改或稍后再点提交就行」 */
  | { kind: "failed"; message: string }
  /** 终态拒绝：服务端明说这组提问不用再答了（找不到 / 已答 / 已跳过 / 已过期 / 已失效）——不能叫用户「可重新提交」 */
  | { kind: "rejected"; message: string };

/**
 * 服务端用这些状态码表示「这组提问已是终态、别再答了」（ask-reply 路由：404 找不到提问、
 * 409 已回答 / 已跳过 / 已过期 / 已失效、410 同义）。其余 4xx（400 校验等）仍是「改好再提交」。
 */
const ASK_REJECTED_STATUSES: readonly number[] = [404, 409, 410];

/** 终态拒绝但服务端没给原因时的兜底（别留空 toast） */
const ASK_REJECTED_FALLBACK = "这组提问已经不需要再回答了";

/**
 * 提交失败怎么处理（Q6-18：按服务端原因分三类）：
 * - 409 ask_in_flight：投递冲突转只读（不报错）；
 * - 404 / 409 / 410（终态）：只写服务端原文——它本身就是「已回答 / 已跳过 / 已过期，无需再答」，
 *   前面再加「可重新提交」就自相矛盾；
 * - 其余（网络 / 5xx / 400 …）：明说「回答未送达，可重新提交」并带原因。
 */
export const classifyAskSubmitError = (err: unknown): AskSubmitErrorPlan => {
  if (err instanceof ApiRequestError && err.status === 409 && err.code === "ask_in_flight") {
    return { kind: "in_flight" };
  }
  const reason = (err instanceof Error ? err.message : String(err)).trim();
  if (err instanceof ApiRequestError && ASK_REJECTED_STATUSES.includes(err.status)) {
    return { kind: "rejected", message: reason || ASK_REJECTED_FALLBACK };
  }
  return {
    kind: "failed",
    message: reason ? `回答未送达，可重新提交：${reason}` : "回答未送达，可重新提交",
  };
};
