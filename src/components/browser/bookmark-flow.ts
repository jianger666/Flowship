/**
 * 收藏的交互流程（无 React、可在 node 里测）：地址栏星标与「更多」菜单共用的「收藏 ⇄ 取消收藏」切换、
 * 撤销删除的请求、点收藏项时的打开方式。副作用（toast / 导航）全由调用方注入，这里只管判定与顺序。
 */
import { filterBookmarks, findBookmarkByUrl, normalizeBookmarkUrl, type Bookmark } from "@/lib/browser-bookmarks";

import type { AddBookmarkRequest } from "./bookmarks-store";

/** 当前页里能收藏的那部分：规整前的原始地址 + 页面给的标题（服务端再清洗，没标题就用主机名） */
export interface BookmarkTarget {
  url: string;
  title: string;
}

/** 对话框列表超过这个数才出过滤框（几条的时候多一个输入框只是噪音） */
export const BOOKMARK_FILTER_THRESHOLD = 8;
/** 空白页快捷列表最多露几条（其余进「全部收藏」） */
export const BOOKMARK_QUICK_LIMIT = 6;

/**
 * 对话框列表的显示视图：超过阈值才出过滤框；过滤框不显示时**忽略残留的查询词**——
 * 删着删着列表缩到阈值以下、过滤框随之消失，用户看不见也改不了那个词，不能让它把剩下的收藏全藏掉。
 */
export const bookmarkListView = (
  bookmarks: readonly Bookmark[],
  query: string,
): { showFilter: boolean; query: string; visible: readonly Bookmark[] } => {
  const showFilter = bookmarks.length > BOOKMARK_FILTER_THRESHOLD;
  const q = showFilter ? query.trim() : "";
  return { showFilter, query: q, visible: filterBookmarks(bookmarks, q) };
};

export const BOOKMARK_ADD_LABEL = "收藏此页";
export const BOOKMARK_REMOVE_LABEL = "取消收藏";
export const bookmarkToggleLabel = (starred: boolean): string => (starred ? BOOKMARK_REMOVE_LABEL : BOOKMARK_ADD_LABEL);

/**
 * 活动标签 → 可收藏的目标。只有 http / https 网页能收藏（about:blank、没有标签、错误页都返回 null——UI 据此不画星标、菜单项置灰）。
 * 规整口径与服务端共用（@/lib/browser-bookmarks），所以这里判「能收藏」与服务端判「合法」不会出现分歧。
 */
export const bookmarkTargetOf = (tab: { url?: string | null; title?: string | null } | null | undefined): BookmarkTarget | null => {
  if (!tab) return null;
  const normalized = normalizeBookmarkUrl(tab.url);
  if (!normalized.ok) return null;
  return { url: String(tab.url), title: typeof tab.title === "string" ? tab.title : "" };
};

/** 失败原因 → 给用户看的一句话（store 抛的是中文 Error；别的东西兜底成通用文案，不把 [object Object] 之类透给用户） */
export const bookmarkErrorText = (err: unknown): string => {
  const message = err instanceof Error ? err.message.trim() : "";
  return message || "操作失败，请稍后重试";
};

export type ToggleBookmarkOutcome = "added" | "removed" | "failed";

export interface ToggleBookmarkDeps {
  target: BookmarkTarget;
  /** 当前已加载的收藏（用来判断这个页面是不是已收藏）；没加载成功过时传空数组也安全——服务端按地址幂等 */
  bookmarks: readonly Bookmark[];
  add: (input: AddBookmarkRequest) => Promise<unknown>;
  remove: (id: string) => Promise<void>;
  /** 取消收藏成功后（调用方在这里弹带「撤销」的提示） */
  onRemoved: (bookmark: Bookmark) => void;
  onError: (message: string) => void;
}

/**
 * 星标 / 菜单项的一次点击：已收藏 → 取消；没收藏 → 加上。永远不抛，失败走 onError 并返回 "failed"。
 * 判断「已收藏」用与服务端同一套 URL 规整（尾斜杠 / 默认端口 / host 大小写 / userinfo 不会让星标和服务端对不上）。
 */
export const runToggleBookmark = async ({ target, bookmarks, add, remove, onRemoved, onError }: ToggleBookmarkDeps): Promise<ToggleBookmarkOutcome> => {
  const existing = findBookmarkByUrl(bookmarks, target.url);
  try {
    if (existing) {
      await remove(existing.id);
      onRemoved(existing);
      return "removed";
    }
    await add({ url: target.url, title: target.title });
    return "added";
  } catch (err) {
    onError(bookmarkErrorText(err));
    return "failed";
  }
};

/**
 * 「撤销删除」要重新加回去的请求：带着原来的收藏时间，列表按时间倒序它就回到原来的位置
 * （不带的话会被当成「刚收藏」顶到最前面）。
 */
export const restoreRequestOf = (bookmark: Bookmark): AddBookmarkRequest => ({
  url: bookmark.url,
  title: bookmark.title,
  createdAt: bookmark.createdAt,
});

/**
 * 点收藏项的打开方式。默认在当前标签打开（和浏览器的书签一致）；
 * 「在新标签页打开」只在会话已存在时有意义——没有会话时 navigate 本身会启动会话并打开，退回它。
 */
export const resolveBookmarkOpen = ({ newTab, sessionExists }: { newTab: boolean; sessionExists: boolean }): "navigate" | "new-tab" =>
  newTab && sessionExists ? "new-tab" : "navigate";
