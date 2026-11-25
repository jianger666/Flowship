"use client";

/**
 * 收藏的交互动作（在 useBookmarks 之上加 toast / 防连点）：地址栏星标、「更多」菜单、收藏夹对话框共用。
 *
 * - `toggle`：星标 / 菜单项的一次点击。切换进行中再点直接忽略（返回 "busy"）——连点两下不会出现「加了又立刻删」，
 *   也不会同时发两个请求；取消收藏成功后弹带「撤销」的提示。失败弹错误 toast（收藏夹满了 / 网络错 …）；
 * - `removeWithUndo`：对话框里删一条。不二次确认（收藏很轻、可撤销，确认框反而碍事）：删完给 8 秒的「撤销」，
 *   撤销带着原来的收藏时间加回去，列表里回到原位。
 *
 * 判断「这页是否已收藏」用调用时 store 里的最新快照，不用闭包里的旧列表：连续操作时不会拿着过期列表做错判断。
 */
import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";

import type { Bookmark } from "@/lib/browser-bookmarks";

import {
  bookmarkErrorText,
  restoreRequestOf,
  runToggleBookmark,
  type BookmarkTarget,
  type ToggleBookmarkOutcome,
} from "./bookmark-flow";
import { getBookmarksStore } from "./bookmarks-store";
import { clipOneLine } from "./browser-status";
import { useBookmarks, type UseBookmarksResult } from "./use-bookmarks";

/** toast 里引用标题的长度上限（完整标题在列表里看） */
const TOAST_TITLE_MAX = 28;
/** 「撤销」停留的时间 */
const UNDO_TOAST_MS = 8000;

export interface UseBookmarkActionsResult extends UseBookmarksResult {
  /** 星标 / 菜单项切换进行中（给按钮置灰用；防连点本身靠内部 ref，不依赖这个 state 的渲染时机） */
  busy: boolean;
  toggle: (target: BookmarkTarget) => Promise<ToggleBookmarkOutcome | "busy">;
  /** 删除并给「撤销」；返回是否删成功（失败已弹错误 toast） */
  removeWithUndo: (bookmark: Bookmark) => Promise<boolean>;
}

export const useBookmarkActions = ({ autoLoad = true }: { autoLoad?: boolean } = {}): UseBookmarkActionsResult => {
  const api = useBookmarks({ autoLoad });
  const { add, remove } = api;
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);

  const offerUndo = useCallback(
    (bookmark: Bookmark, what: string) => {
      toast(`${what}「${clipOneLine(bookmark.title, TOAST_TITLE_MAX)}」`, {
        duration: UNDO_TOAST_MS,
        action: {
          label: "撤销",
          onClick: () => {
            void add(restoreRequestOf(bookmark)).catch((err) => toast.error(`恢复收藏失败：${bookmarkErrorText(err)}`));
          },
        },
      });
    },
    [add],
  );

  const toggle = useCallback(
    async (target: BookmarkTarget): Promise<ToggleBookmarkOutcome | "busy"> => {
      if (busyRef.current) return "busy";
      busyRef.current = true;
      setBusy(true);
      try {
        return await runToggleBookmark({
          target,
          bookmarks: getBookmarksStore().getSnapshot().bookmarks,
          add,
          remove,
          onRemoved: (bookmark) => offerUndo(bookmark, "已取消收藏"),
          onError: (message) => toast.error(message),
        });
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [add, remove, offerUndo],
  );

  const removeWithUndo = useCallback(
    async (bookmark: Bookmark): Promise<boolean> => {
      try {
        await remove(bookmark.id);
      } catch (err) {
        toast.error(`删除失败：${bookmarkErrorText(err)}`);
        return false;
      }
      offerUndo(bookmark, "已删除收藏");
      return true;
    },
    [remove, offerUndo],
  );

  return { ...api, busy, toggle, removeWithUndo };
};
