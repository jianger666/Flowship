import type { KeyboardEvent } from "react";

import { isImeComposing } from "@/lib/ime";
import type { SubmitShortcut } from "@/lib/types";

export const SUBMIT_SHORTCUT_LABEL: Record<SubmitShortcut, string> = {
  "mod-enter": "Cmd/Ctrl+Enter 提交，Enter 换行",
  enter: "Enter 提交，Shift+Enter 换行",
};

export const getSubmitShortcutHint = (shortcut: SubmitShortcut): string =>
  shortcut === "enter" ? "Enter 发送，Shift+Enter 换行" : "Cmd/Ctrl+Enter 发送";

/**
 * AI 运行中输入框的 placeholder：提示的键位必须跟个人提交快捷键一致。
 * 之前写死「回车排队」，而默认设置是 `mod-enter`——用户按 Enter 只会换行、排不进去
 * （2026-10-20 第二轮 review U3b-04）。
 */
export const getRunningQueuePlaceholder = (shortcut: SubmitShortcut): string =>
  `AI 正在跑，${getSubmitShortcutTitle(shortcut)} 排队，跑完自动发送…`;

export const getSubmitShortcutTitle = (shortcut: SubmitShortcut): string =>
  shortcut === "enter" ? "Enter" : "Cmd/Ctrl+Enter";

// 接受任意元素的 KeyboardEvent（textarea / dialog 容器都可传）——只读 key / 修饰键 / isComposing、
// 不碰 textarea 专属属性。这样既能绑在 textarea 上、也能绑在 DialogContent 容器上（ask_user 弹窗）。
export const shouldSubmitOnKeyDown = (
  event: KeyboardEvent<HTMLElement>,
  shortcut: SubmitShortcut,
): boolean => {
  if (event.key !== "Enter") return false;
  // 中文输入法选词期间的 Enter 不是提交，必须让给 IME。
  if (isImeComposing(event)) return false;

  if (shortcut === "enter") {
    return !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey;
  }

  return (event.metaKey || event.ctrlKey) && !event.altKey;
};
