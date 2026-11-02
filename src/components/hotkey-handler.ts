/**
 * 全局快捷键处理器工厂（纯逻辑，Cmd+B 切侧栏 / Cmd+K 搜索面板 / Cmd+N 新建对话共用）。
 *
 * 约定：
 * - 命中就 `preventDefault`（覆盖浏览器 / 系统默认行为）；
 * - 按键长按产生的 `repeat` 帧只吞默认行为、**不重复触发**（否则长按 Cmd+N 连开一串对话、长按 Cmd+K 面板开关闪烁、
 *   长按 Cmd+B 侧栏来回抖）；
 * - 不看焦点在哪：这几个键带修饰键、不会跟打字冲突；本仓输入区没有任何富文本（主输入条是 Lexical PlainTextPlugin、
 *   其余是 input / textarea），Cmd+B 在它们里面都没有「加粗」之类的编辑语义，让行只会让主输入条里的快捷键整个失效；
 * - 修饰键口径统一走 `isModCombo`：不吃 Shift / Alt（⌘⇧B、⌘⌥B 不触发）；mac 只认 ⌘、Windows / Linux 认 Ctrl——
 *   因为输入区不再让行，mac 上 Emacs 式 Ctrl+B / Ctrl+F / Ctrl+N / Ctrl+K（光标键）必须放过、不能被全局快捷键吞掉。
 */

import { isModCombo, type KeyComboEvent } from "@/lib/keyboard-shortcuts";

/** 处理器要用到的最小事件形状（原生 KeyboardEvent 直接满足） */
export interface HotkeyEventLike {
  repeat: boolean;
  preventDefault: () => void;
}

export const createModHotkeyHandler =
  <E extends HotkeyEventLike>(matches: (e: E) => boolean, run: () => void) =>
  (e: E): void => {
    if (!matches(e)) return;
    e.preventDefault();
    if (e.repeat) return;
    run();
  };

/**
 * 切侧栏的键位：与 ⌘K / ⌘N 同一口径（`isModCombo`）——不吃 Shift / Alt（⌘⇧B、⌘⌥B 不触发），
 * mac 只认 ⌘（Ctrl+B 是 Emacs 式光标左移，输入条不再让行后不能被它拦掉），Windows / Linux 认 Ctrl。
 */
export const isSidebarToggleCombo = (e: HotkeyEventLike & KeyComboEvent): boolean =>
  isModCombo(e, "b");
