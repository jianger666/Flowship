/**
 * 日期范围选择器「两次点击选一个区间」的状态机（纯函数、可测）。
 *
 * 为什么不用 react-day-picker range 模式自带的 onSelect：
 * 组件把「当前已生效的完整区间」当 selected 传进去，库对「完整区间 + 点一天」的语义是**移动其中一端**
 * （点在 from 之前 → { from: 点击日, to: 原 to }；之后 → { from: 原 from, to: 点击日 }），
 * 所以第一下点击就产出了完整区间、被当成提交并关掉弹层——用户永远没法点第二下、也选不了单日。
 * 这里自己维护锚点：第一下只记锚点（半选），第二下才提交；两下点同一天 = 单日区间。
 */

/** 一天的 0 点 ms */
export type DayMs = number;

export type RangeClickResult =
  | { kind: "anchor"; anchor: DayMs }
  | { kind: "commit"; from: DayMs; to: DayMs };

/**
 * @param anchor 已记下的第一下点击（0 点 ms）；null = 还没点过
 * @param clicked 这一下点击的日期（0 点 ms）
 */
export const resolveRangeClick = (
  anchor: DayMs | null,
  clicked: DayMs,
): RangeClickResult => {
  if (anchor === null) return { kind: "anchor", anchor: clicked };
  return {
    kind: "commit",
    from: Math.min(anchor, clicked),
    to: Math.max(anchor, clicked),
  };
};
