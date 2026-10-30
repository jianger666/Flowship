/**
 * 收件箱操作结果的提示文案决策（纯函数）。
 *
 * 面板没有 jsdom 可渲染：把「该弹哪种 toast、说什么」从组件里拎出来，行为才测得到。
 */

/** 合并成功的提示：MR 在我们动手前已经被合并过（双击 / 两个窗口 / 别人先合了）要换一句更准的话（Q10-05） */
export const describeMergeSuccess = (result: {
  alreadyMerged: boolean;
}): string =>
  result.alreadyMerged ? "该 MR 已经合并过了，已为你更新列表" : "MR 已合并";

export interface RegressionToast {
  level: "success" | "warning";
  text: string;
}

/**
 * 待回归行「通过 / 不通过」流转成功后的提示（Q21-02）。
 * 不通过 = 先流转、后发原因评论：评论没发出去时流转已经成功、没法回滚，不能报失败也不能说「已写评论」——
 * 给 warning，调用方配一个「去飞书」补发。
 */
export const describeRegressionTransition = (
  action: "pass" | "reject",
  result: { commentFailed?: boolean },
): RegressionToast => {
  if (action === "pass") return { level: "success", text: "已标记通过并关闭" };
  if (result.commentFailed) {
    return {
      level: "warning",
      text: "已打回，但原因评论没发出去，请到飞书补发",
    };
  }
  return { level: "success", text: "已打回并写评论" };
};
