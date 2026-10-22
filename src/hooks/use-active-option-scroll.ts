"use client";

/**
 * 菜单键盘高亮项滚入可视区（slash / `@` 菜单共用；第二轮 review V5-03）
 *
 * 只写**列表容器**自己的 scrollTop（位置由纯函数 `scrollTopToReveal` 算），
 * 不碰祖先滚动容器——菜单浮在输入岛上方、窗口矮时整页滚动会很怪。
 *
 * 触发时机：activeIndex / 候选数 / 菜单开关变化。activeIndex 只由键盘（↑↓）与
 * 「新结果落地重置为 0」改变；鼠标 hover 走 CSS、不改 activeIndex，所以天然只在键盘导航时滚，
 * hover 不会抖。选项节点靠 `data-option-index` 定位。
 */

import { useEffect, useRef, type RefObject } from "react";

import { scrollTopToReveal } from "@/lib/menu-scroll";

export const useActiveOptionScroll = (opts: {
  activeIndex: number;
  itemCount: number;
  open: boolean;
}): RefObject<HTMLDivElement | null> => {
  const listRef = useRef<HTMLDivElement | null>(null);
  const { activeIndex, itemCount, open } = opts;

  useEffect(() => {
    if (!open || itemCount <= 0) return;
    const list = listRef.current;
    if (!list) return;
    const item = list.querySelector<HTMLElement>(
      `[data-option-index="${activeIndex}"]`,
    );
    if (!item) return;
    const next = scrollTopToReveal({
      scrollTop: list.scrollTop,
      viewportHeight: list.clientHeight,
      itemTop: item.offsetTop,
      itemHeight: item.offsetHeight,
      index: activeIndex,
      count: itemCount,
      contentHeight: list.scrollHeight,
    });
    if (next !== list.scrollTop) list.scrollTop = next;
  }, [activeIndex, itemCount, open]);

  return listRef;
};
