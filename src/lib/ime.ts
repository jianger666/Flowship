/**
 * IME（输入法）组合输入判定——所有「Enter 触发提交 / 确认」的键盘处理共用这一个口径。
 *
 * 为什么不只看 `isComposing`：中文 / 日文输入法选词时按 Enter，
 * - Chromium：keydown 的 `isComposing === true`；
 * - Safari / 部分旧内核：compositionend 先于 keydown 触发，keydown 上 `isComposing` 已是 false，
 *   但 `keyCode` 仍是 229（IME 处理中的占位键码）。
 * 只判一个会在某些环境下把「选词」误当「提交」，所以两个都要判。
 *
 * 入参兼容三种形状：原生 KeyboardEvent、React 合成事件（带 nativeEvent）、测试里的最小对象。
 */

/** 判定用的最小事件形状 */
export interface ImeEventLike {
  isComposing?: boolean;
  keyCode?: number;
  /** React 合成事件才有；原生事件 / 最小对象可缺省 */
  nativeEvent?: { isComposing?: boolean; keyCode?: number } | null;
}

/** IME 处理中的占位 keyCode */
export const IME_PROCESSING_KEYCODE = 229;

/** 这次按键是否发生在输入法组合输入期间（是 → Enter 等键应交给输入法，不能当提交） */
export const isImeComposing = (e: ImeEventLike): boolean =>
  e.isComposing === true ||
  e.keyCode === IME_PROCESSING_KEYCODE ||
  e.nativeEvent?.isComposing === true ||
  e.nativeEvent?.keyCode === IME_PROCESSING_KEYCODE;
