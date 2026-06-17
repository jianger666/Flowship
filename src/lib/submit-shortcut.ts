import type { KeyboardEvent } from "react";

import type { SubmitShortcut } from "@/lib/types";

export const SUBMIT_SHORTCUT_LABEL: Record<SubmitShortcut, string> = {
  "mod-enter": "Cmd/Ctrl+Enter 提交，Enter 换行",
  enter: "Enter 提交，Shift+Enter 换行",
};

export const getSubmitShortcutHint = (shortcut: SubmitShortcut): string =>
  shortcut === "enter" ? "Enter 发送，Shift+Enter 换行" : "Cmd/Ctrl+Enter 发送";

export const getSubmitShortcutTitle = (shortcut: SubmitShortcut): string =>
  shortcut === "enter" ? "Enter" : "Cmd/Ctrl+Enter";

export const shouldSubmitOnKeyDown = (
  event: KeyboardEvent<HTMLTextAreaElement>,
  shortcut: SubmitShortcut,
): boolean => {
  if (event.key !== "Enter") return false;
  // 中文输入法选词期间的 Enter 不是提交，必须让给 IME。
  if (event.nativeEvent.isComposing) return false;

  if (shortcut === "enter") {
    return !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey;
  }

  return (event.metaKey || event.ctrlKey) && !event.altKey;
};
