/**
 * 群问答 tab 的「统计范围」派生（第三轮 review D8-01，300 条窗口一致性）。
 *
 * 群问答轮次 / 「待你决定」都从 task.events 聚合；task 页首屏与 watch-task bootstrap 只带最近一段事件，
 * 窗口外的群问答不在统计里。全量日志有 1 轮需属主拍板、窗口内 0 轮时，tab 不出现、红点不亮，
 * 用户没有任何线索——「没有」和「不知道」长得一样。
 *
 * 本函数只回答「怎么把这件事说清楚」（纯函数，组件只管渲染）：
 *   - 窗口完整（没有更早事件）：口径不变，无提示；
 *   - 有轮次 + 还有更早：计数带「+」（至少这么多），面板顶部说明仅统计已加载；
 *   - 0 轮 + 还有更早 + 任务绑了飞书群：tab 照常出现，说明窗口外可能还有（否则漏报无从发现）；
 *   - 0 轮 + 没绑群：不出 tab——长任务不该都多一个永远为空的 tab。
 *     （只认任务本地关联的群 `feishuGroupChatId`；仅靠工作项项目群回落的任务看不到这条兜底，已接受。）
 */

export interface GroupQaScope {
  /** 群问答 tab 要不要出现 */
  showTab: boolean;
  /** tab 标题里的计数文本：「3」「3+」；没有轮次时为空串（标题不带括号） */
  countText: string;
  /** 面板顶部的范围说明；null = 窗口完整，不用说 */
  notice: string | null;
}

export const GROUP_QA_PARTIAL_NOTICE =
  "仅统计已加载的最近事件，更早的群问答（含「待你决定」）不在内";
export const GROUP_QA_EMPTY_PARTIAL_NOTICE =
  "已加载的最近事件里没有群问答，更早的可能还有";

export const deriveGroupQaScope = (input: {
  /** 已加载事件里聚合出的轮次数 */
  roundCount: number;
  /** 还有更早的事件没加载（EventStream 的 hasMoreEarlier） */
  hasMoreEarlier: boolean;
  /** 任务绑了飞书群（task.feishuGroupChatId 非空） */
  hasGroup: boolean;
  /** chat 形态没有群桥接 */
  isChat: boolean;
}): GroupQaScope => {
  if (input.isChat) return { showTab: false, countText: "", notice: null };
  if (input.roundCount > 0) {
    return {
      showTab: true,
      countText: `${input.roundCount}${input.hasMoreEarlier ? "+" : ""}`,
      notice: input.hasMoreEarlier ? GROUP_QA_PARTIAL_NOTICE : null,
    };
  }
  if (input.hasMoreEarlier && input.hasGroup) {
    return { showTab: true, countText: "", notice: GROUP_QA_EMPTY_PARTIAL_NOTICE };
  }
  return { showTab: false, countText: "", notice: null };
};
