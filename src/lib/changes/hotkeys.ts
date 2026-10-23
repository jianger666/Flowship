/**
 * 代码改动面板的快捷键解析：纯函数（只吃「长得像键盘事件」的结构，不依赖 DOM 类型）。
 *
 * 判定顺序与原因：
 *   1. 输入法组合中（isComposing / keyCode 229）：此时按键属于输入法，抢了会打断中文输入。
 *   2. ctrl / meta / alt 组合：留给浏览器与系统（复制、刷新、切标签……），一律不抢。
 *   3. 目标是输入控件（input / textarea / select / contenteditable / 带 textbox 类 role）：
 *      用户在打字，字母键不能被当成快捷键（搜索框里敲 `j` 不该跳文件）。
 *   4. 按住不放（repeat）：只放行 j / k / n / p 这类导航，连发有用；
 *      切换类动作长按会反复翻转，必须屏蔽。
 *   5. 再按键位映射。方向键 / Enter / Space / Esc / Tab 一律不处理，留给滚动、焦点与面板自身。
 *
 * 键位与大小写：
 *   字母不区分大小写（兼容 CapsLock），但 `v` 与 shift+V 是两个动作：
 *   不带 shift 的 v → viewedAndNext，带 shift 的 v（无论 key 是 "V" 还是 CapsLock 下的 "v"）→ toggleViewed。
 *   其余带 shift 的字母返回 null，避免 shift 误触。
 *   `?` 与 `/` 在不同键盘布局上 shiftKey 状态不一致，所以按 key 本身判断、不看 shift。
 */

/** 面板快捷键动作 */
export type ChangesHotkey =
  | "nextFile"
  | "prevFile"
  | "nextChange"
  | "prevChange"
  | "viewedAndNext"
  | "toggleViewed"
  | "toggleSplit"
  | "toggleIgnoreWs"
  | "toggleExpandAll"
  | "focusSearch"
  | "toggleWide"
  | "toggleTree"
  | "help";

/** 键盘事件的最小结构：真实 KeyboardEvent 与测试对象都满足它 */
export interface HotkeyEventLike {
  key: string;
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  isComposing?: boolean;
  keyCode?: number;
  repeat?: boolean;
  target?: {
    tagName?: string;
    isContentEditable?: boolean;
    getAttribute?(name: string): string | null;
  } | null;
}

/** 不带 shift 的小写字母 → 动作（v 单独处理，因为它依赖 shift） */
const LETTER_MAP: Readonly<Record<string, ChangesHotkey>> = {
  j: "nextFile",
  k: "prevFile",
  n: "nextChange",
  p: "prevChange",
  s: "toggleSplit",
  w: "toggleIgnoreWs",
  e: "toggleExpandAll",
  f: "toggleWide",
  t: "toggleTree",
};

/** 按住不放时仍放行的动作 */
const REPEATABLE: ReadonlySet<ChangesHotkey> = new Set<ChangesHotkey>([
  "nextFile",
  "prevFile",
  "nextChange",
  "prevChange",
]);

const TYPING_TAGS: ReadonlySet<string> = new Set(["INPUT", "TEXTAREA", "SELECT"]);
const TYPING_ROLES: ReadonlySet<string> = new Set(["textbox", "combobox", "searchbox"]);

/** 事件目标是否是「用户正在打字」的控件 */
const isTypingTarget = (target: HotkeyEventLike["target"]): boolean => {
  if (!target) return false;
  if (typeof target.tagName === "string" && TYPING_TAGS.has(target.tagName.toUpperCase())) return true;
  if (target.isContentEditable === true) return true;
  if (typeof target.getAttribute === "function") {
    const role = target.getAttribute("role");
    if (typeof role === "string" && TYPING_ROLES.has(role.trim().toLowerCase())) return true;
  }
  return false;
};

/** 把键盘事件解析成面板动作；不该处理（修饰键 / 打字中 / 输入法 / 无映射）返回 null */
export const resolveChangesHotkey = (e: HotkeyEventLike): ChangesHotkey | null => {
  if (e.isComposing === true || e.keyCode === 229) return null;
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  if (isTypingTarget(e.target)) return null;

  const action = mapKey(e);
  if (action === null) return null;
  if (e.repeat === true && !REPEATABLE.has(action)) return null;
  return action;
};

const mapKey = (e: HotkeyEventLike): ChangesHotkey | null => {
  if (e.key === "?") return "help";
  if (e.key === "/") return "focusSearch";
  // 只处理单个字符的字母键；Enter / Escape / ArrowDown / " " 等都落到 null
  if (e.key.length !== 1) return null;
  const letter = e.key.toLowerCase();
  if (letter === "v") return e.shiftKey ? "toggleViewed" : "viewedAndNext";
  if (e.shiftKey) return null;
  return Object.hasOwn(LETTER_MAP, letter) ? LETTER_MAP[letter] : null;
};

/** 快捷键帮助弹层的一行：keys 是按键展示名，label 是中文说明 */
export const CHANGES_HOTKEY_HELP: ReadonlyArray<{ keys: readonly string[]; label: string }> = [
  { keys: ["j"], label: "下一个文件" },
  { keys: ["k"], label: "上一个文件" },
  { keys: ["n"], label: "下一处改动" },
  { keys: ["p"], label: "上一处改动" },
  { keys: ["v"], label: "标记已查看并跳到下一个未查看文件" },
  { keys: ["Shift", "V"], label: "切换已查看（不跳转）" },
  { keys: ["s"], label: "切换统一 / 分栏视图" },
  { keys: ["w"], label: "切换忽略空白差异" },
  { keys: ["e"], label: "展开 / 收起当前文件的全部上下文" },
  { keys: ["/"], label: "聚焦文件搜索" },
  { keys: ["f"], label: "加宽 / 还原面板" },
  { keys: ["t"], label: "显示 / 隐藏文件栏" },
  { keys: ["?"], label: "显示快捷键帮助" },
];
