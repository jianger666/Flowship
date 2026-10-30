/**
 * 自定义 pi 内层自动重试的展示契约（R14 Q11-02）。
 *
 * 背景：流被对端掐断 / 网关 5xx 之后，pi 会自己退避、把这一条回复整个重新生成一遍。
 * 出错的那半截在重试之前已经推给 UI 了；不分开的话，半截和重新生成的全文会被焊成同一条
 * assistant_message（落盘就是「半截 + 全文」，读起来是一段重复的话）。
 *
 * 做法：重试开始时把半截落成独立的一条，紧跟一行说明，之后重新生成的全文才是新的一条。
 * **不删已经流出去的字**——用户看到过的内容不能凭空消失；说明行告诉他为什么会有两段。
 *
 * 说明行是普通 info（灰细线），不是 spinner 过程行：
 * `ReconnectingRow` 只有在后面出现 reconnected / error 才停转，而 pi 内层重试成功时没有对应的
 * 「已恢复」事件，复用它会一直转到 run 结束。
 */

export const AUTO_RETRY_META_KIND = "auto_retry" as const;

/** 次数不是正整数（合成 / 异常事件）时不写「第 n/m 次」，免得显示出 NaN / 0/0 */
const isCount = (n: unknown): n is number =>
  typeof n === "number" && Number.isInteger(n) && n > 0;

export const autoRetryEventText = (input: {
  attempt?: unknown;
  max?: unknown;
}): string =>
  isCount(input.attempt) && isCount(input.max)
    ? `连接中断，已自动重试（第 ${input.attempt}/${input.max} 次）`
    : "连接中断，已自动重试";

export const autoRetryEventMeta = (input: {
  attempt?: unknown;
  max?: unknown;
}): {
  kind: typeof AUTO_RETRY_META_KIND;
  attempt?: number;
  max?: number;
} => ({
  kind: AUTO_RETRY_META_KIND,
  ...(isCount(input.attempt) ? { attempt: input.attempt } : {}),
  ...(isCount(input.max) ? { max: input.max } : {}),
});
