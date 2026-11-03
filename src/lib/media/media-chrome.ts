/**
 * 全屏时「控件自动隐藏」的规则（纯函数，hook 和 dock 都调这里）。
 *
 * 目标：全屏看片时，鼠标几秒不动就把顶栏 / 控制区 / 鼠标指针收掉，画面铺满；
 * 动一下鼠标 / 按任意键就回来。暂停时一直显示（要操作的人多半就在暂停态）。
 */

/** 鼠标静止多久后收起控件 */
export const IDLE_HIDE_MS = 3000;

export interface ChromeInput {
  /** 是否全屏：非全屏永远显示（窗口模式不自动隐藏） */
  fullscreen: boolean;
  /** 暂停 / 已结束 / 还没开始播 */
  paused: boolean;
  /** 已经静止超过 IDLE_HIDE_MS */
  idle: boolean;
  /** 有东西需要用户看着：菜单展开中 / 快捷键帮助 / 报错提示 */
  pinned: boolean;
}

export const chromeVisible = ({ fullscreen, paused, idle, pinned }: ChromeInput): boolean =>
  !fullscreen || paused || pinned || !idle;

/**
 * 是不是真的「鼠标动了」。
 * 浏览器会在布局变化（比如控件淡出后指针下面的元素变了）时补发一个坐标没变的 pointermove，
 * 如果把它当活动，控件会「隐藏 → 补发事件 → 又显示」来回闪。所以只认坐标变化。
 */
export const isRealPointerMove = (
  prev: { x: number; y: number } | null,
  next: { x: number; y: number },
): boolean => prev === null || prev.x !== next.x || prev.y !== next.y;
