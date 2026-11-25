/**
 * 组合键解析：把模型写的「cmd+shift+v」「Enter」「ctrl+alt+Delete」这类自然写法
 * 规范化成平台无关的 `{ mods, key }`，再由各平台驱动映射到真实键码。纯函数、无副作用。
 *
 * 语法：用 `+` 分隔，大小写不敏感；恰好一个「主键」+ 0 到 4 个修饰键。
 * 字符本身是 `+` / `-` / 空格时写成 `plus` / `minus` / `space`，避免歧义。
 *
 * 修饰键别名（统一成 meta / ctrl / alt / shift）：
 *   cmd command meta win windows super → meta（mac 的 Command / Windows 的 Win 键）
 *   ctrl control → ctrl；alt option opt → alt；shift → shift
 *   mod → 「平台主修饰键」：mac = meta、Windows = ctrl（写 `mod+c` 可以跨平台复制）
 */
import { DesktopError } from "./types.mjs";

/** 修饰键别名 → 规范名（mod 单独处理，依赖平台） */
const MOD_ALIASES = Object.freeze({
  cmd: "meta",
  command: "meta",
  meta: "meta",
  win: "meta",
  windows: "meta",
  super: "meta",
  ctrl: "ctrl",
  control: "ctrl",
  alt: "alt",
  option: "alt",
  opt: "alt",
  shift: "shift",
});

/** 主键别名 → 规范名（导出给测试：server 侧入参脱敏 redact-args.ts 要和这里认同一批「会打出字符」的写法） */
export const KEY_ALIASES = Object.freeze({
  return: "enter",
  enter: "enter",
  esc: "escape",
  escape: "escape",
  del: "delete",
  delete: "delete",
  forwarddelete: "delete",
  bksp: "backspace",
  backspace: "backspace",
  tab: "tab",
  space: "space",
  spacebar: "space",
  up: "up",
  arrowup: "up",
  down: "down",
  arrowdown: "down",
  left: "left",
  arrowleft: "left",
  right: "right",
  arrowright: "right",
  home: "home",
  end: "end",
  pgup: "pageup",
  pageup: "pageup",
  pgdn: "pagedown",
  pagedown: "pagedown",
  plus: "plus",
  minus: "minus",
});

/** 标点主键（直接写字符本身；`+` `-` 空格不在其中，必须写 plus / minus / space） */
const PUNCTUATION_KEYS = Object.freeze(["=", "[", "]", "\\", ";", "'", ",", ".", "/", "`"]);

/** 规范主键全集：字母、数字、F1–F20、命名键、标点 */
export const CANONICAL_KEYS = Object.freeze([
  ..."abcdefghijklmnopqrstuvwxyz".split(""),
  ..."0123456789".split(""),
  ...Array.from({ length: 20 }, (_, i) => `f${i + 1}`),
  "enter",
  "escape",
  "delete",
  "backspace",
  "tab",
  "space",
  "up",
  "down",
  "left",
  "right",
  "home",
  "end",
  "pageup",
  "pagedown",
  "plus",
  "minus",
  ...PUNCTUATION_KEYS,
]);

const CANONICAL_KEY_SET = new Set(CANONICAL_KEYS);
/** 修饰键在 mods 里的固定输出顺序（保证 `shift+cmd+v` 与 `cmd+shift+v` 规范化后相同） */
const MOD_ORDER = Object.freeze(["ctrl", "alt", "shift", "meta"]);

const bad = (message) => new DesktopError("BAD_ARGS", message);

/**
 * 只认别名表自己的键。两张表是普通对象、继承 Object.prototype：part 已经转成小写，`constructor` 和 `__proto__` 照样会命中原型上的同名属性
 * ——`MOD_ALIASES["constructor"]` 是 Object 函数、truthy，`constructor+a` 就会被当成「修饰键」静默吞掉、只按下 a。
 */
const lookup = (table, name) => (Object.hasOwn(table, name) ? table[name] : undefined);

/**
 * 解析组合键。
 * @param {unknown} input 如 "cmd+shift+v"
 * @param {'darwin'|'win32'|string} [platform] 只用来解析 `mod`
 * @returns {{ mods: Array<'meta'|'ctrl'|'alt'|'shift'>, key: string }}
 */
export const parseCombo = (input, platform = process.platform) => {
  if (typeof input !== "string" || input.trim() === "") {
    throw bad("keys 必须是非空字符串，例如 \"enter\"、\"cmd+c\"、\"ctrl+shift+t\"");
  }
  const raw = input.trim();
  if (raw.length > 60) throw bad("keys 太长：一次只能按一个组合键（例如 \"cmd+shift+v\"），多个按键请分多次调用");
  const parts = raw.split("+").map((s) => s.trim().toLowerCase());
  // 「cmd++」「+」这类写法：split 后出现空段。明确拒绝并提示写 plus，避免静默按错键
  if (parts.some((p) => p === "")) {
    throw bad("keys 里不能有空段：字符「+」请写成 plus（例如 \"cmd+plus\"），空格请写成 space");
  }
  const mods = new Set();
  let key = null;
  for (const part of parts) {
    const modName = part === "mod" ? (platform === "darwin" ? "meta" : "ctrl") : lookup(MOD_ALIASES, part);
    if (modName) {
      mods.add(modName);
      continue;
    }
    const k = lookup(KEY_ALIASES, part) ?? part;
    // 报错里不回显模型传来的原文（也不回显已识别出的键）：keys 参数常被拿来「一个键一个键地打」密码 / 验证码，
    // 回显会把它们原样带进工具结果（落盘 / 进飞书 / 进审计）。模型自己的上下文里有它传的值，不需要我们复述
    if (!CANONICAL_KEY_SET.has(k)) {
      throw bad("keys 里有不认识的按键（出于隐私，报错不复述你传的内容）。可用：字母 / 数字 / f1–f20 / enter / escape / tab / space / backspace / delete / 方向键 / home / end / pageup / pagedown / 标点；修饰键 cmd ctrl alt shift");
    }
    if (key !== null) throw bad("一次只能按一个主键（keys 里出现了两个主键）；多个按键请分多次调用，或用 desktop_type 输入文字");
    key = k;
  }
  if (key === null) throw bad("只有修饰键、没有主键：例如 \"cmd+c\" 里的 c。单独按修饰键没有意义");
  return { mods: MOD_ORDER.filter((m) => mods.has(m)), key };
};

/**
 * 被安全规则拦下的组合键。返回原因（中文）或 null。
 * 只拦「会让整个登录会话终止、Flowship 与任务一起没掉、AI 无法自救」的组合：
 * macOS 的注销（⌘⇧Q、⌥⌘⇧Q）。关窗 / 退出应用 / 锁屏等照常允许（会话管理器会处理锁屏后的状态）。
 * @param {{ mods: string[], key: string }} combo
 * @param {string} [platform]
 * @returns {string | null}
 */
export const blockedComboReason = (combo, platform = process.platform) => {
  if (platform === "darwin" && combo.key === "q" && combo.mods.includes("meta") && combo.mods.includes("shift")) {
    return "⌘⇧Q 会注销当前用户，Flowship 和这个任务都会随之结束，AI 无法恢复——已拦下。需要退出某个应用请用 cmd+q";
  }
  return null;
};
