/**
 * slash / `@` 菜单：键盘高亮项滚入可视区 + listbox 语义（纯函数、无 React；第二轮 review V5-03）
 *
 * 菜单是 `max-h-64 overflow-y-auto`，焦点留在 contentEditable、↑↓ 只改 activeIndex，
 * 高亮项不会自己滚进来；`↑` 从首项回绕到末项直接落在看不见处、Enter 选中的是看不见的项。
 *
 * 这里只算「新的 scrollTop」；写入由 hooks/use-active-option-scroll 对**列表容器**自己做。
 * 不用 scrollIntoView：它会连带滚动所有祖先滚动容器（事件流 / 页面），菜单 `absolute bottom-full`
 * 浮在输入岛上方、窗口矮时会把整页拽动。
 */

export interface RevealInput {
  /** 列表容器当前 scrollTop */
  scrollTop: number;
  /** 列表容器可视高度（clientHeight） */
  viewportHeight: number;
  /** 高亮项顶边，相对列表内容顶部（offsetTop，含容器 padding） */
  itemTop: number;
  itemHeight: number;
  /** 高亮项下标 / 总数（首尾项要把容器 padding 一起露出来） */
  index: number;
  count: number;
  /** 列表内容总高（scrollHeight） */
  contentHeight: number;
}

/**
 * nearest 语义：已完全可见 → 原样返回（高亮在视口内移动不抖）；
 * 在上方 → 对齐顶边；在下方 → 对齐底边；首项 → 0；末项被裁 → 滚到底（含底部 padding）。
 * 未布局（视口 / 项高为 0、坐标非有限数：jsdom / SSR / display:none）→ 原样返回。
 */
export const scrollTopToReveal = (i: RevealInput): number => {
  const { scrollTop, viewportHeight, itemTop, itemHeight } = i;
  const finite = [scrollTop, viewportHeight, itemTop, itemHeight].every(
    Number.isFinite,
  );
  if (!finite || viewportHeight <= 0 || itemHeight <= 0) return scrollTop;
  // 首项：回到 0，把顶部 padding 一起露出来（↓ 从末项回绕到首项）
  if (i.index <= 0) return 0;
  const itemBottom = itemTop + itemHeight;
  if (itemTop < scrollTop) return Math.max(0, itemTop);
  if (itemBottom > scrollTop + viewportHeight) {
    // 末项：滚到底，把底部 padding 一起露出来（↑ 从首项回绕到末项）
    if (i.index >= i.count - 1 && Number.isFinite(i.contentHeight)) {
      return Math.max(0, i.contentHeight - viewportHeight);
    }
    return Math.max(0, itemBottom - viewportHeight);
  }
  return scrollTop;
};

/** 选项 DOM id（aria-activedescendant 指向它） */
export const optionDomId = (listId: string, index: number): string =>
  `${listId}-opt-${index}`;

export interface MenuAriaInput {
  open: boolean;
  itemCount: number;
  activeIndex: number;
  listId: string;
}

/**
 * 输入框（textbox）侧的 aria 属性：
 * - 菜单没开 → 不挂任何属性；
 * - 开了 → aria-controls 指向列表；
 * - 且有合法高亮项 → aria-activedescendant 指向它（没有候选 / 下标越界时不挂、别指向空气）。
 * 不加 aria-expanded：它不属于 textbox 角色允许的属性。
 */
export const menuAria = (
  i: MenuAriaInput,
): { controls?: string; activeDescendant?: string } => {
  if (!i.open) return {};
  const out: { controls?: string; activeDescendant?: string } = {
    controls: i.listId,
  };
  if (
    Number.isInteger(i.activeIndex) &&
    i.activeIndex >= 0 &&
    i.activeIndex < i.itemCount
  ) {
    out.activeDescendant = optionDomId(i.listId, i.activeIndex);
  }
  return out;
};
