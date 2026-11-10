/**
 * 页面 JS 对话框条的纯逻辑（无 React、可在 node 里测）：抢焦点判定 + 展示文本清洗。
 *
 * 注意 `describeDialogBar`（模型）在 browser-user-logic.ts——那份不归这里管；这里只放「渲染这个模型时要不要自动聚焦」
 * 与「展示前怎么清洗页面给的文字」。
 */

import { clipOneLine, stripFormatChars } from "./browser-status";

/** 判定用的最小元素形状（运行时是 DOM Element，测试里用对象字面量） */
export interface FocusTargetLike {
  tagName?: string | null;
  /** input 的 type（已小写规整的 DOM 属性） */
  type?: string | null;
  readOnly?: boolean;
  disabled?: boolean;
  /** DOM 的 isContentEditable（jsdom 里没实现，所以还要再看 contenteditable 属性） */
  isContentEditable?: boolean;
  getAttribute?: ((name: string) => string | null) | null;
}

/** 这些 type 的 `<input>` 按键不会往里打字（按钮 / 勾选 / 滑块 / 取色 / 文件…），焦点在它们上不算「正在打字」 */
const NON_TEXT_INPUT_TYPES: ReadonlySet<string> = new Set([
  "button",
  "checkbox",
  "radio",
  "submit",
  "reset",
  "image",
  "file",
  "range",
  "color",
  "hidden",
]);

/**
 * 这个元素是不是「用户可以往里打字」的可编辑元素：文本类 `<input>`（含 password / search / number / date…）、
 * `<textarea>`、`contenteditable`（含 `plaintext-only`、空串）。disabled / readOnly 的不算（按键写不进去，也就不会泄漏）。
 * `<select>` 不算：它的按键是选项跳转，不是内容。
 */
export const isEditableElement = (el: FocusTargetLike | null | undefined): boolean => {
  if (!el) return false;
  if (el.isContentEditable === true) return true;
  const ce = typeof el.getAttribute === "function" ? el.getAttribute("contenteditable") : null;
  if (ce !== null && ce !== undefined && ce.trim().toLowerCase() !== "false") return true;
  const tag = String(el.tagName ?? "").toUpperCase();
  if (tag === "TEXTAREA") return !el.disabled && !el.readOnly;
  if (tag === "INPUT") {
    if (el.disabled || el.readOnly) return false;
    return !NON_TEXT_INPUT_TYPES.has(String(el.type ?? "text").toLowerCase());
  }
  return false;
};

/**
 * 页面的 `prompt()` 弹出时，对话框条里的输入框要不要自动聚焦（R2-13 ③）。
 *
 * 用户正在应用里的某个输入框 / 编辑器里打字时，页面随时能弹 `prompt()`：这时自动聚焦等于把焦点从用户手里抢走，
 * 用户接下来的按键（包括 Enter）会落进「要回答给页面的输入框」，Enter 直接把用户正写的半截内容（可能是别的任务里的指令、
 * 密码、聊天草稿）**提交给页面**。所以：焦点已经在可编辑元素里 → 不抢；条上改给醒目提示，等用户自己点进来。
 */
export const shouldAutoFocusDialogInput = (active: FocusTargetLike | null | undefined): boolean =>
  !isEditableElement(active);

/** 对话框条挂载时输入框的焦点处置：聚焦 / 不抢（显示提示）/ 已经在我们自己的输入框里（无事可做） */
export type DialogFocusAction = "focus" | "held" | "already";

/**
 * @param active `document.activeElement`
 * @param activeIsInsideBar 焦点是否已经落在对话框条自己的输入框里（StrictMode 开发期 effect 会跑两遍，第二遍看到的是第一遍聚焦的结果）
 */
export const decideDialogInputFocus = (
  active: FocusTargetLike | null | undefined,
  activeIsInsideBar: boolean,
): DialogFocusAction => {
  if (activeIsInsideBar) return "already";
  return shouldAutoFocusDialogInput(active) ? "focus" : "held";
};

/** 对话框说明文字的展示上限（页面可给到数 MB；条上只显示两行，更长的没有意义） */
export const DIALOG_MESSAGE_MAX_CHARS = 1000;
/** `prompt()` 默认值的展示 / 预填上限（与输入框 maxLength 对齐） */
export const DIALOG_DEFAULT_MAX_CHARS = 2000;

/** 页面没给文字（或全是不可见字符）时条上显示的占位 */
export const DIALOG_EMPTY_MESSAGE = "（页面没有提供说明文字）";

/**
 * 对话框说明文字的展示形态：压成单行并剥掉格式 / 控制字符（U+202E 之类的方向控制符能把文字反向显示，R2-13 ③），
 * 剥完是空的给占位。只影响展示，不影响回给页面的答复。
 */
export const dialogMessageText = (message: string | null | undefined): string =>
  clipOneLine(String(message ?? ""), DIALOG_MESSAGE_MAX_CHARS) || DIALOG_EMPTY_MESSAGE;

/**
 * `prompt()` 默认值预填进输入框前的清洗：换行 / 制表折成空格（单行输入框本来就放不下），再剥格式 / 控制字符。
 * 用户看到什么、提交什么——不会出现「框里看着是 abc、实际带着方向控制符 / 零宽字符回给页面」。
 */
export const dialogDefaultText = (value: string | null | undefined): string =>
  stripFormatChars(String(value ?? "").replace(/[\r\n\t]+/g, " ")).slice(0, DIALOG_DEFAULT_MAX_CHARS);

/** 没抢焦点时条上给用户看的提示（醒目、说清楚为什么没聚焦、怎么办） */
export const DIALOG_FOCUS_HELD_HINT = "你正在别处输入，没有抢走你的焦点。要回答页面的提问，请先点一下下面的输入框。";
