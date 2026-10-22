/**
 * 推进弹窗提交结果 → UI 处置（纯函数、可单测；client / server 都能 import）
 *
 * 背景：推进失败（建隔离工作区失败 / wk 门禁拦截 / 准入不满足……）原先一律
 * 「toast 只留首行 + 立刻关弹窗 + 清预填」，用户在弹窗里写好的指令、贴的图、
 * 收件箱深链预填的 bug 指令全丢，只剩一行被截断的 toast，只能重写重贴。
 *
 * 现在的契约：
 *  - 成功：关弹窗 + 清预填（深链预填只用一次，否则下次手动推进会灌入旧指令）
 *  - 失败：**不关弹窗、不清预填**（指令 / 附图本来就活在弹窗的输入态里，只要不关就还在），
 *    完整原因展示在弹窗内（`inlineError`，多行原样），toast 只留一句结论
 */

/** toast 只留一句结论：多行原因（结论 + 逐条明细 + 下一步）整段塞 toast 又长又会盖住半屏 */
export const toastLine = (message: string): string => {
  const [first = "", ...rest] = message.split("\n").map((l) => l.trim());
  return rest.some(Boolean) ? `${first}（完整原因见弹窗）` : first;
};

/** 从 advance 接口的非 2xx 响应体里取错误文案（服务端 errorResponse 返回 `{ error: "文字" }`） */
export const advanceErrorMessage = (data: unknown, status: number): string => {
  const error =
    data && typeof data === "object"
      ? (data as { error?: unknown }).error
      : undefined;
  return typeof error === "string" && error.trim() ? error : `HTTP ${status}`;
};

export type AdvanceSubmitOutcome =
  | { ok: true }
  | { ok: false; error: unknown };

export interface AdvanceSubmitUi {
  /** 是否关闭推进弹窗 */
  closeDialog: boolean;
  /** 是否清掉外部预填（深链带来的指令 / 预选 action） */
  clearPrefill: boolean;
  /** 弹窗内展示的完整错误（null = 不展示） */
  inlineError: string | null;
  /** 要弹的 error toast 文案（null = 不弹） */
  toastError: string | null;
}

export const planAdvanceUi = (outcome: AdvanceSubmitOutcome): AdvanceSubmitUi => {
  if (outcome.ok) {
    return {
      closeDialog: true,
      clearPrefill: true,
      inlineError: null,
      toastError: null,
    };
  }
  const raw =
    outcome.error instanceof Error
      ? outcome.error.message
      : String(outcome.error);
  // 空文案兜底：inlineError 为空串会被当成「没错误」、弹窗里什么都不显示
  const message = raw.trim() ? raw : "未知错误（服务端未返回原因）";
  return {
    closeDialog: false,
    clearPrefill: false,
    inlineError: message,
    toastError: `推进失败：${toastLine(message)}`,
  };
};
