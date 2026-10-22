/**
 * 看板空态的口径（Q9-05）：刷新期间不对「没有排期」下结论。
 *
 * 空看板点「往后平移」→ 区间变了、旧响应仍是 0 条，此前立刻显示新区间网格 + 「这个时间段没有排期」，
 * 直到 300ms 去抖 + 串行队列（最多 6 段 CLI）回来——对尚未得出的结论下断言。
 * 现在：没有任何行 且 正在刷新 → 画加载态；刷新结束仍为空才说「没有排期」。
 * 非空看板不受影响（旧行为：旧数据照画，刷新靠右上角转圈）。
 */
export type BoardEmptyKind = "none" | "loading" | "empty";

export const boardEmptyKind = (input: {
  rowCount: number;
  refreshing: boolean;
}): BoardEmptyKind => {
  if (input.rowCount > 0) return "none";
  return input.refreshing ? "loading" : "empty";
};
