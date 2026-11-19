/**
 * 事件流里「这条事件是几点发生的」的短时间。
 *
 * - 今天 → `HH:mm`
 * - 今天之前（跨天）→ `MM-DD HH:mm`
 * - 跨年 → `YYYY-MM-DD HH:mm`
 *
 * 本地时区、24 小时制、不显示秒。为什么要带日期：一个任务 / 对话常常隔天再回来接着聊，
 * 只有 `16:55` 时看不出这是今天的还是前天的（2026-11-18 用户反馈）。
 *
 * 非法时间戳返回空串：流式中的合成事件还没有 ts（占位 0），不能显示成 1970 年那一天。
 *
 * 纯函数（`now` 可注入）、不碰 React，单测直接 import。
 */

const pad2 = (n: number): string => String(n).padStart(2, "0");

export const formatEventTime = (
  ts: number,
  now: number = Date.now(),
): string => {
  if (!Number.isFinite(ts) || ts <= 0) return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;

  const n = new Date(now);
  const sameYear = d.getFullYear() === n.getFullYear();
  const sameDay =
    sameYear && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  if (sameDay) return hm;

  const md = `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  return sameYear ? `${md} ${hm}` : `${d.getFullYear()}-${md} ${hm}`;
};
