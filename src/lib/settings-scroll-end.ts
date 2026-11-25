/**
 * 设置页左侧导航的「滚动跟随高亮」：谁说了算（S-8g；第二十轮评审 R20-12 加了点击 / 深链后的锁定期；纯逻辑，不依赖 React / DOM）。
 *
 * 高亮有三个来源：
 *  1. 点导航 / `?focus=` 深链（页面的 scrollToFocus）：用户的明确意图；
 *  2. IntersectionObserver（rootMargin -20% 0px -60%，只有卡片进了视口上半区才算「在看」）：滚动跟随；
 *  3. 「滚到底」（S-8g）：最后一张卡片比视口矮时，滚到底它也进不了那个区间，导航就停在倒数第二项，所以到底时直接高亮最后一项。
 * R20-12：点靠后的导航项、而它下面的内容不足一屏时，smooth scroll 一路滚到容器底，第 3 条会把用户刚点的那项改写成「仓库」；
 * smooth scroll 途中路过的卡片、卡片比较矮时进观察区间的「下一张卡」，第 2 条同样会盖掉用户点的那项。
 * 所以点导航 / 深链之后留一段**锁定期**（{@link NAV_SCROLL_LOCK_MS}）：期间 2、3 两路都不改高亮，等 smooth scroll 落定；锁定期过后用户自己再滚，跟随照常恢复。
 * 三个来源都经 {@link createScrollSpy} 这一个控制器，锁定逻辑只有一份、能用假时钟单测（页面本身没有 jsdom，真滚动效果要在 Electron 里手点）。
 */

/**
 * 「滚到底了吗」（纯函数）。tolerancePx：浏览器缩放 / 小数像素下 scrollTop 凑不到整数底，留几像素误差。内容不够长（没有滚动条）不算滚到底。
 */
export const isScrolledToEnd = (
  box: { scrollTop: number; clientHeight: number; scrollHeight: number },
  tolerancePx = 4,
): boolean => box.scrollHeight > box.clientHeight && box.scrollTop + box.clientHeight >= box.scrollHeight - tolerancePx;

/**
 * 点导航 / 深链之后，滚动跟随不改高亮的时长。要盖住一次 smooth scroll 的全程：Chromium 的程序化平滑滚动一般几百毫秒（经验值，没有在本仓用的 Electron 版本里实测过时长），
 * 留到 1.5 秒。取舍：锁定期内用户自己的滚动也不更新高亮（最多 1.5 秒），换来「点哪项就亮哪项」；已经在目标位置、点了不滚的情形也只是这 1.5 秒内跟随暂停。
 */
export const NAV_SCROLL_LOCK_MS = 1500;

export interface ScrollSpy {
  /** 点导航 / 深链：立刻高亮目标，并开始锁定期 */
  navigate: (focus: string) => void;
  /** IntersectionObserver 算出的「当前在看」：锁定期内忽略 */
  observed: (focus: string) => void;
  /** 包含最后一张卡的滚动容器发出 scroll：锁定期内忽略；否则滚到底就高亮最后一项 */
  scrolled: (box: { scrollTop: number; clientHeight: number; scrollHeight: number }) => void;
}

export const createScrollSpy = (
  deps: { now: () => number; setActive: (focus: string) => void },
  lastFocus: string,
): ScrollSpy => {
  let lockUntil = 0;
  const locked = (): boolean => deps.now() < lockUntil;
  return {
    navigate: (focus) => {
      lockUntil = deps.now() + NAV_SCROLL_LOCK_MS;
      deps.setActive(focus);
    },
    observed: (focus) => {
      if (locked()) return;
      deps.setActive(focus);
    },
    scrolled: (box) => {
      if (locked()) return;
      if (isScrolledToEnd(box)) deps.setActive(lastFocus);
    },
  };
};
