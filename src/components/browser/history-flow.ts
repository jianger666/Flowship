/**
 * 地址栏记忆的交互流程（无 React、可在 node 里测）：联想何时出现、「清除浏览历史」的确认 → 执行流程。
 * 副作用（弹确认框 / 请求 / toast）全由调用方注入，这里只管判定与顺序。
 */
import type { AddressSuggestion, HistoryEntry } from "@/lib/browser-history";
import { suggestAddresses } from "@/lib/browser-history";
import type { Bookmark } from "@/lib/browser-bookmarks";

/**
 * 联想只在「用户正在地址栏里敲字」时出：聚焦后什么都没敲（地址栏里是当前页地址、已被全选）不弹——
 * 否则每次点一下地址栏就有一个下拉盖住页面；也不会用「当前页地址」当查询词去匹配出一堆自己。
 */
export const addressSuggestionsOf = (input: {
  editing: boolean;
  /** 聚焦之后用户是否改过文字（键入 / 粘贴） */
  typed: boolean;
  query: string;
  history: readonly HistoryEntry[];
  bookmarks: readonly Bookmark[];
  now: number;
}): AddressSuggestion[] =>
  input.editing && input.typed ? suggestAddresses({ query: input.query, history: input.history, bookmarks: input.bookmarks, now: input.now }) : [];

/** 联想里一行显示的标题：历史 / 收藏的标题就是页面标题，页面没有标题时存的是主机名；这里再兜一层，空标题不留空行 */
export const suggestionLabel = (s: Pick<AddressSuggestion, "title" | "url">): string => s.title.trim() || s.url;

/** 「×」按钮的无障碍名称 */
export const removeSuggestionLabel = (s: Pick<AddressSuggestion, "title" | "url">): string => `从联想中删除「${suggestionLabel(s)}」`;

/** 与 `useDialog().confirm` 的 ConfirmOptions 子集同形；这里不 import hook，保持无 React 依赖 */
export interface ClearHistoryConfirmOptions {
  title: string;
  description: string;
  confirmLabel: string;
  destructive: true;
}

export const CLEAR_HISTORY_CONFIRM: ClearHistoryConfirmOptions = {
  title: "清除浏览历史？",
  description: "会清掉地址栏联想里记住的网址。所有任务共用同一份；不影响收藏夹、登录状态和已打开的页面。",
  confirmLabel: "清除",
  destructive: true,
};

/** 清除成功后的 toast：清掉了几条就说几条；本来就是空的也要有个交代（不然用户以为没点上） */
export const clearHistorySuccessMessage = (removed: number): string =>
  Number.isInteger(removed) && removed > 0 ? `已清除浏览历史（${removed} 条）` : "没有需要清除的浏览历史";

export type ClearHistoryOutcome = "cancelled" | "cleared" | "failed";

export interface ClearHistoryDeps {
  /** 弹确认框；resolve true = 用户确认 */
  confirm: (opts: ClearHistoryConfirmOptions) => Promise<boolean>;
  /** 真正清除（history store 的 clear），返回清掉了几条 */
  clear: () => Promise<number>;
  onSuccess: (removed: number) => void;
  onError: (message: string) => void;
}

/**
 * 先确认、确认了才清；取消 = 一次 `clear` 都不调。
 * `clear` 同步抛错 / 异步 reject 都落到 onError（不向上抛——调用方是点击处理器，抛出去就是未处理的 rejection）。
 */
export const runClearHistory = async (deps: ClearHistoryDeps): Promise<ClearHistoryOutcome> => {
  const ok = await deps.confirm(CLEAR_HISTORY_CONFIRM);
  if (!ok) return "cancelled";
  let removed: number;
  try {
    removed = await deps.clear();
  } catch (err) {
    deps.onError(historyErrorText(err));
    return "failed";
  }
  // 成功提示放在 try 外：清除已经成功了，提示本身出岔子不能被误报成「清除失败」
  deps.onSuccess(removed);
  return "cleared";
};

/** 失败原因 → 给用户看的一句话（store 抛的是中文 Error；别的东西兜底成通用文案，不把 [object Object] 之类透给用户） */
export const historyErrorText = (err: unknown): string => {
  const message = err instanceof Error ? err.message.trim() : "";
  return message || "操作失败，请稍后重试";
};
