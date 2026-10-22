/**
 * task 详情页「产物区选中哪个 action」的跟随判定（纯函数、可单测；client / server 都能 import）
 *
 * 背景（第二轮 review V18-03）：选中态原先只在「切 task / 没选 / 选的已不存在」时被设置。
 * 不经本页推进弹窗产生的新 action（飞书需求群里推进、另一个窗口）出现时，旧选中仍存在 → 什么都不做：
 * 右栏事件流在输出 build，左栏产物区与时间线高亮还停在方案。
 *
 * 改法 S（wasLatest）：用户原本就选中「上一次的最新条」→ 新 action 出现时自动跟随；
 * 用户手动选了更早的 → 不动（不抢用户正在看的东西）。
 */

/** 最新 action = 数组最后一条（actions 是追加序；与「切到新 task 默认选最后一个」同口径） */
export const latestActionId = (actions: ReadonlyArray<{ id: string }>): string | null =>
  actions[actions.length - 1]?.id ?? null;

/**
 * 返回新的选中 id：`undefined` = 不用改；`null` = 清成没选中；string = 改选它。
 *
 * @param prevLatestId 上一次 effect 跑完时的最新 action id（调用方用 ref 记着）
 */
export const resolveSelectedActionOnChange = (input: {
  selectedActionId: string | null;
  actions: ReadonlyArray<{ id: string }>;
  currentActionId: string | null | undefined;
  prevLatestId: string | null;
}): string | null | undefined => {
  const { selectedActionId, actions, currentActionId, prevLatestId } = input;
  // 没选 / 选的已被 GC：回到 currentActionId（原有行为）
  if (!selectedActionId || !actions.some((a) => a.id === selectedActionId)) {
    return currentActionId ?? null;
  }
  // wasLatest：选中的就是上一次的最新条，且现在最新条换了 → 跟随
  const latestId = latestActionId(actions);
  if (latestId && latestId !== prevLatestId && selectedActionId === prevLatestId) {
    return latestId;
  }
  return undefined;
};
