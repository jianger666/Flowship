/**
 * 全局快捷键 / composer 键位的纯判定逻辑（2026-07-20 命令面板批次）
 *
 * 只做「事件 → 动作」匹配、不碰 DOM——global-shortcuts / composer-editor
 * 引用这里，单测直接构造最小事件对象。
 */

import { isImeComposing } from "@/lib/ime";
import { getShellPlatform, isMacPlatform, type ShellPlatform } from "@/lib/platform-shortcuts";
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
  /** 兼容 Safari：IME 选词的 Enter 在 keydown 上 isComposing 为 false 但 keyCode 为 229 */
  keyCode?: number;
}

/**
 * Cmd/Ctrl + 单字母组合（无 Alt / Shift——避免劫持 Cmd+Shift+K 这类系统位）。
 *
 * 平台口径：
 * - darwin：**只认 metaKey（⌘）**。mac 的文本框原生支持 Emacs 式光标键（Ctrl+B 左移 / Ctrl+F 右移 / Ctrl+N 下移 /
 *   Ctrl+K 删到行尾），Ctrl 一并接受只会把这些光标键吞掉；界面文案对应按平台显示——mac 写 ⌘、其它平台写 Ctrl
 *   （见下面的 `getModShortcutLabel` / platform-shortcuts 的 ⌘F · Ctrl+F）；
 * - win32 / linux：meta 与 ctrl 都认（Windows 的 Ctrl+K / Ctrl+N 是主口径；Win / Super 键组合到不了应用，认了无害）；
 * - 未知（SSR / 浏览器无壳 / 单测默认）：与旧行为一致，meta 与 ctrl 都认。
 *
 * @param platform 默认读壳平台（`window.__shell.platform`）；单测里显式传即可覆盖各平台
 */
export const isModCombo = (
  e: KeyComboEvent,
  key: string,
  platform: ShellPlatform = getShellPlatform(),
): boolean =>
  (isMacPlatform(platform) ? e.metaKey : e.metaKey || e.ctrlKey) &&
  !e.altKey &&
  !e.shiftKey &&
  e.key.toLowerCase() === key.toLowerCase();

/**
 * Mod + 键的界面文案：mac 写 `⌘K`，其它平台写 `Ctrl+K`（`key` 原样拼接，如 "K" / "End"）。
 *
 * 与 `isModCombo` 的平台口径、platform-shortcuts 的 `getModFShortcutLabel`（⌘F / Ctrl+F）同一套——
 * 后者等价于 `getModShortcutLabel(platform, "F")`（见 tests/keyboard-shortcuts-labels.test.ts）。
 * 平台未知（SSR / 首次渲染 / 浏览器无壳）按非 mac 渲染成 `Ctrl+…`：
 * **组件里必须传 `useShellPlatform()` 的结果**——它在 SSR 与首次客户端渲染都是 ""，mount 后才切到 mac，
 * 所以不会 hydration 不一致；不要在 render 里直接 `getShellPlatform()`（服务端 "" / 客户端 "darwin" 会对不上）。
 */
export const getModShortcutLabel = (platform: ShellPlatform, key: string): string =>
  `${isMacPlatform(platform) ? "⌘" : "Ctrl+"}${key}`;

/** 右侧抽屉（`Sheet` 的 SheetContent）根节点上的 data-slot，焦点归属判定用 */
export const SHEET_CONTENT_SELECTOR = '[data-slot="sheet-content"]';

/**
 * 焦点 / 按键目标是否落在右侧抽屉里。
 *
 * 抽屉是非模态的（焦点离开也不会关），用户盯着子代理详情按空格 / 翻页时，
 * 主界面的「自动聚焦输入框」「Cmd/Ctrl+End 回到最新」都不该把键盘抢走。
 * 只收最小形状（有 `closest` 就行），不碰 document，单测可直接喂假对象。
 */
export const isInsideSheet = (
  target: { closest?: (selector: string) => unknown } | EventTarget | null | undefined,
): boolean => {
  const el = target as { closest?: (selector: string) => unknown } | null | undefined;
  if (!el || typeof el.closest !== "function") return false;
  return el.closest(SHEET_CONTENT_SELECTOR) != null;
};

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
  if (isImeComposing(e)) return false;
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
