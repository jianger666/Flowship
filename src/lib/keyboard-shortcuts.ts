/**
 * 全局快捷键 / composer 键位的纯判定逻辑（2026-07-20 命令面板批次）
 *
 * 只做「事件 → 动作」匹配、不碰 DOM——global-shortcuts / composer-editor
 * 引用这里，单测直接构造最小事件对象。
 */

import type { SubmitShortcut } from "@/lib/types";

/** 判定用的最小键盘事件形状（原生 / React 事件都能喂） */
export interface KeyComboEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  /** IME 组合输入中（原生 event.isComposing）；缺省当 false */
  isComposing?: boolean;
}

/**
 * Cmd/Ctrl + 单字母组合（无 Alt / Shift——避免劫持 Cmd+Shift+K 这类系统位）。
 * mac 用 metaKey、win/linux 用 ctrlKey、两者等价接受。
 */
export const isModCombo = (e: KeyComboEvent, key: string): boolean =>
  (e.metaKey || e.ctrlKey) &&
  !e.altKey &&
  !e.shiftKey &&
  e.key.toLowerCase() === key.toLowerCase();

/** 提交快捷键的对位：enter ↔ mod-enter（运行中「立即发送」用对位键） */
export const oppositeSubmitShortcut = (s: SubmitShortcut): SubmitShortcut =>
  s === "enter" ? "mod-enter" : "enter";

/**
 * 某个提交偏好下、这次按键是否算「提交」。
 * 与 lib/submit-shortcut 的 shouldSubmitOnKeyDown 同口径（IME 让行、
 * enter 模式排除所有修饰键、mod-enter 模式要求 meta/ctrl）——
 * 这里收窄到最小事件形状、供运行态双通道判定复用。
 */
const matchesSubmitCombo = (
  e: KeyComboEvent,
  shortcut: SubmitShortcut,
): boolean => {
  if (e.key !== "Enter") return false;
  if (e.isComposing) return false;
  if (shortcut === "enter") {
    return !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey;
  }
  return (e.metaKey || e.ctrlKey) && !e.altKey;
};

/**
 * agent 运行中 composer 提交按键的双通道判定：
 * - 命中当前提交偏好 → "queue"（排队、现行为）
 * - 命中对位组合 → "sendNow"（打断当前回复立即发）
 * - 都不命中 → null（换行等交回编辑器）
 */
export const resolveRunningSubmitAction = (
  e: KeyComboEvent,
  shortcut: SubmitShortcut,
): "queue" | "sendNow" | null => {
  if (matchesSubmitCombo(e, shortcut)) return "queue";
  if (matchesSubmitCombo(e, oppositeSubmitShortcut(shortcut))) return "sendNow";
  return null;
};

// ---------- 双击 Esc 清空草稿 ----------

/** 两次 Esc 的判定窗口（ms）——超窗按第一次重记 */
export const DOUBLE_ESC_WINDOW_MS = 600;

/** 距上次 Esc 是否在双击窗口内 */
export const isDoubleEsc = (
  lastEscTs: number | null,
  nowTs: number,
  windowMs = DOUBLE_ESC_WINDOW_MS,
): boolean => lastEscTs != null && nowTs - lastEscTs <= windowMs;
