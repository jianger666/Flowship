/**
 * macOS 桌面驱动（koffi → CoreGraphics / CoreFoundation / ApplicationServices）。
 *
 * 只做「把一个低层动作交给系统」，不含策略（权限判断 / 会话 / 安全 / 日志都在上层 manager / session）。
 * 契约见 ../types.mjs 的 DesktopDriver。
 *
 * 选型依据（本机 macOS 27.2 / Electron 42 实测）：
 * - 进程内调 CoreGraphics 一次约 0.12ms；起一个 osascript 子进程约 175ms，所以输入 / 状态全走 koffi，
 *   只有「应用 / 窗口列表」这类低频、且要 NSWorkspace 的查询才用 JXA 子进程。
 * - 事件投递需要「辅助功能」权限，没有权限时 CGEventPost 静默无效（不报错）——权限判断在上层做。
 * - 输入坐标系 = 全局显示坐标，单位「点」，原点在主显示器左上（Retina 不乘 2）。
 *
 * 键盘：
 * - typeText 用「Unicode 键盘事件」（CGEventKeyboardSetUnicodeString），不依赖键盘布局，中文 / emoji 也能直接进输入框；
 *   换行 / 制表符走真实键码（Return / Tab）。
 * - keyCombo 用美式布局的虚拟键码 + 修饰键标志（同时发修饰键自己的事件，部分应用只认真实的修饰键事件）。
 * - backspace = ⌫（向前删一个字符），delete = ⌦（向后删一个字符）。
 *
 * 不得打印 / 记录 typeText 的文本（可能是密码）。
 */
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const requireFromHere = createRequire(import.meta.url);

const CG_PATH = "/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics";
const CF_PATH = "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation";
const AS_PATH = "/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices";
/** 私有框架：SACLockScreenImmediate 是脚本 / 第三方工具锁屏的通用入口；符号不在了就退回快捷键 */
const LOGIN_PATH = "/System/Library/PrivateFrameworks/login.framework/login";

/** kCFStringEncodingUTF8 */
const CF_UTF8 = 0x08000100;
/** CGEventTapLocation：kCGHIDEventTap = 0（最贴近真实硬件）、kCGSessionEventTap = 1 */
const TAP_HID = 0;

const BUTTON_EVENTS = Object.freeze({
  left: { down: 1, up: 2, drag: 6, button: 0 },
  right: { down: 3, up: 4, drag: 7, button: 1 },
  middle: { down: 25, up: 26, drag: 27, button: 2 },
});
const EV_MOUSE_MOVED = 5;
/** kCGMouseEventClickState：双击 / 三击靠它区分 */
const FIELD_CLICK_STATE = 1;
/** kCGScrollEventUnitLine */
const SCROLL_UNIT_LINE = 1;

/** CGEventFlags */
const FLAG = Object.freeze({ shift: 0x20000, ctrl: 0x40000, alt: 0x80000, meta: 0x100000 });
/** 修饰键自身的虚拟键码（左侧） */
const MOD_KEYCODE = Object.freeze({ meta: 55, shift: 56, alt: 58, ctrl: 59 });
/** 修饰键的固定按下顺序（抬起时倒序） */
const MOD_ORDER = Object.freeze(["ctrl", "alt", "shift", "meta"]);

const KEY_RETURN = 36;
const KEY_TAB = 48;

/** 美式布局虚拟键码（ANSI）。规范键名来自 ../keys.mjs 的 CANONICAL_KEYS，必须全覆盖（单测遍历校验） */
export const MAC_KEYCODES = Object.freeze({
  a: 0, s: 1, d: 2, f: 3, h: 4, g: 5, z: 6, x: 7, c: 8, v: 9, b: 11, q: 12, w: 13, e: 14, r: 15, y: 16, t: 17,
  1: 18, 2: 19, 3: 20, 4: 21, 6: 22, 5: 23, "=": 24, 9: 25, 7: 26, minus: 27, 8: 28, 0: 29, "]": 30, o: 31, u: 32,
  "[": 33, i: 34, p: 35, enter: 36, l: 37, j: 38, "'": 39, k: 40, ";": 41, "\\": 42, ",": 43, "/": 44, n: 45, m: 46,
  ".": 47, tab: 48, space: 49, "`": 50, backspace: 51, escape: 53,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100, f9: 101, f10: 109, f11: 103, f12: 111,
  f13: 105, f14: 107, f15: 113, f16: 106, f17: 64, f18: 79, f19: 80, f20: 90,
  delete: 117, home: 115, end: 119, pageup: 116, pagedown: 121,
  left: 123, right: 124, down: 125, up: 126,
  // 「+」在美式布局上是 Shift + 「=」：keyCombo 里会自动补 shift
  plus: 24,
});

/** 美式布局：必须按住 Shift 才能打出的符号 → 对应的基键（MAC_KEYCODES 的键名） */
const SHIFTED_SYMBOLS = Object.freeze({
  "!": "1", "@": "2", "#": "3", "$": "4", "%": "5", "^": "6", "&": "7", "*": "8", "(": "9", ")": "0",
  _: "minus", "+": "=", "{": "[", "}": "]", "|": "\\", ":": ";", '"': "'", "<": ",", ">": ".", "?": "/", "~": "`",
});
/** 不用 Shift 的符号 / 空格 → MAC_KEYCODES 的键名 */
const PLAIN_SYMBOLS = Object.freeze({
  "-": "minus", "=": "=", "[": "[", "]": "]", "\\": "\\", ";": ";", "'": "'", ",": ",", ".": ".", "/": "/", "`": "`", " ": "space",
});

/**
 * 单个 ASCII 可打印字符 → 美式布局的 { code, shift }；不是 ASCII 可打印字符返回 null。
 * 给「真实键码」输入用（密码框 / 锁屏界面这类不一定认 Unicode 事件的地方）。
 * @param {string} ch
 * @returns {{ code: number, shift: boolean } | null}
 */
export const asciiToKey = (ch) => {
  if (typeof ch !== "string" || ch.length !== 1) return null;
  if (ch >= "a" && ch <= "z") return { code: MAC_KEYCODES[ch], shift: false };
  if (ch >= "A" && ch <= "Z") return { code: MAC_KEYCODES[ch.toLowerCase()], shift: true };
  if (ch >= "0" && ch <= "9") return { code: MAC_KEYCODES[ch], shift: false };
  if (Object.hasOwn(PLAIN_SYMBOLS, ch)) return { code: MAC_KEYCODES[PLAIN_SYMBOLS[ch]], shift: false };
  if (Object.hasOwn(SHIFTED_SYMBOLS, ch)) return { code: MAC_KEYCODES[SHIFTED_SYMBOLS[ch]], shift: true };
  return null;
};

/** JXA：运行中的普通应用 + 前台应用 + 屏幕上的窗口（标题需要「屏幕录制」权限，没有就是空串） */
const LIST_APPS_JXA = `
ObjC.import('AppKit');
ObjC.import('CoreGraphics');
const ws = $.NSWorkspace.sharedWorkspace;
const front = ws.frontmostApplication;
const frontPid = front ? Number(front.processIdentifier) : -1;
const apps = {};
const running = ws.runningApplications;
for (let i = 0; i < running.count; i++) {
  const a = running.objectAtIndex(i);
  if (Number(a.activationPolicy) !== 0) continue;
  const pid = Number(a.processIdentifier);
  const bid = ObjC.unwrap(a.bundleIdentifier);
  apps[pid] = { name: ObjC.unwrap(a.localizedName) || '', pid: pid, bundleId: bid || undefined, frontmost: pid === frontPid, windows: [] };
}
const raw = $.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, $.kCGNullWindowID);
const wins = ObjC.deepUnwrap(ObjC.castRefToObject(raw)) || [];
for (const w of wins) {
  if (w.kCGWindowLayer !== 0) continue;
  const app = apps[w.kCGWindowOwnerPID];
  if (!app) continue;
  const b = w.kCGWindowBounds || {};
  app.windows.push({ title: w.kCGWindowName || '', x: Math.round(b.X || 0), y: Math.round(b.Y || 0), width: Math.round(b.Width || 0), height: Math.round(b.Height || 0) });
}
JSON.stringify(Object.values(apps));
`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const execFileP = (exec, file, args, opts) =>
  new Promise((resolve, reject) => {
    exec(file, args, opts, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        reject(err);
      } else resolve(String(stdout));
    });
  });

/**
 * @param {{
 *   koffi?: any,
 *   log?: (msg: string) => void,
 *   platform?: string,
 *   execFile?: typeof execFile,
 *   tap?: number,
 *   homeDir?: string,
 * }} [deps] 全部可注入（单测用假 koffi / 假 execFile；homeDir 只给 openApp 按显示名找应用时认 ~/Applications 用）
 * @returns {import("../types.mjs").DesktopDriver}
 */
export const createDarwinDriver = (deps = {}) => {
  const { log = () => {}, platform = process.platform, execFile: exec = execFile, tap = TAP_HID } = deps;

  /** 绑定好的原生函数（init 之后才有） */
  const fn = {};
  const bindFailures = [];
  const loaded = { coreGraphics: false, coreFoundation: false, applicationServices: false, loginFramework: false };
  let koffiVersion = null;
  let ready = false;
  /** 事件源（HID 系统状态）：整个驱动生命周期共用一个 */
  let source = null;

  /** 声明一个原生函数；失败（符号不存在等）只记录，由调用方决定是不是致命 */
  const bind = (lib, name, proto) => {
    try {
      fn[name] = lib.func(proto);
    } catch (err) {
      bindFailures.push(name);
      log(`[desktop-darwin] 绑定 ${name} 失败：${err?.message || err}`);
    }
  };

  const REQUIRED = [
    "CGEventCreateMouseEvent",
    "CGEventCreateKeyboardEvent",
    "CGEventKeyboardSetUnicodeString",
    "CGEventSetFlags",
    "CGEventSetIntegerValueField",
    "CGEventPost",
    "CGEventCreateScrollWheelEvent2",
    "CGEventSourceCreate",
    "CGSessionCopyCurrentDictionary",
    "CGEventSourceSecondsSinceLastEventType",
    "CGMainDisplayID",
    "CGDisplayBounds",
    "CFRelease",
    "CFDictionaryGetValue",
    "CFStringCreateWithCString",
    "CFBooleanGetValue",
  ];

  const init = async () => {
    if (ready) return { ok: true };
    if (platform !== "darwin") return { ok: false, error: "仅 macOS 可用" };
    try {
      const koffi = deps.koffi ?? requireFromHere("koffi");
      koffiVersion = koffi.version ?? null;
      const CGPoint = koffi.struct("CGPoint", { x: "double", y: "double" });
      const CGSize = koffi.struct("CGSize", { width: "double", height: "double" });
      koffi.struct("CGRect", { origin: CGPoint, size: CGSize });

      const cg = koffi.load(CG_PATH);
      loaded.coreGraphics = true;
      const cf = koffi.load(CF_PATH);
      loaded.coreFoundation = true;
      const as = koffi.load(AS_PATH);
      loaded.applicationServices = true;

      bind(cg, "CGEventCreateMouseEvent", "void *CGEventCreateMouseEvent(void *source, uint32 type, CGPoint position, uint32 button)");
      bind(cg, "CGEventCreateKeyboardEvent", "void *CGEventCreateKeyboardEvent(void *source, uint16 virtualKey, bool keyDown)");
      bind(cg, "CGEventKeyboardSetUnicodeString", "void CGEventKeyboardSetUnicodeString(void *event, uint64 stringLength, const uint16 *unicodeString)");
      bind(cg, "CGEventSetFlags", "void CGEventSetFlags(void *event, uint64 flags)");
      bind(cg, "CGEventSetIntegerValueField", "void CGEventSetIntegerValueField(void *event, uint32 field, int64 value)");
      bind(cg, "CGEventPost", "void CGEventPost(uint32 tap, void *event)");
      // 不用 variadic 的 CGEventCreateScrollWheelEvent：Apple arm64 的可变参数走栈，FFI 声明更容易出错
      bind(cg, "CGEventCreateScrollWheelEvent2", "void *CGEventCreateScrollWheelEvent2(void *source, uint32 units, uint32 wheelCount, int32 wheel1, int32 wheel2, int32 wheel3)");
      bind(cg, "CGEventSourceCreate", "void *CGEventSourceCreate(int32 stateID)");
      bind(cg, "CGSessionCopyCurrentDictionary", "void *CGSessionCopyCurrentDictionary()");
      bind(cg, "CGEventSourceSecondsSinceLastEventType", "double CGEventSourceSecondsSinceLastEventType(int32 stateID, uint32 eventType)");
      bind(cg, "CGMainDisplayID", "uint32 CGMainDisplayID()");
      bind(cg, "CGDisplayBounds", "CGRect CGDisplayBounds(uint32 display)");
      bind(cf, "CFRelease", "void CFRelease(void *cf)");
      bind(cf, "CFDictionaryGetValue", "void *CFDictionaryGetValue(void *dict, void *key)");
      bind(cf, "CFStringCreateWithCString", "void *CFStringCreateWithCString(void *alloc, const char *cStr, uint32 encoding)");
      bind(cf, "CFBooleanGetValue", "bool CFBooleanGetValue(void *boolean)");
      bind(as, "AXIsProcessTrusted", "bool AXIsProcessTrusted()");

      // 私有框架：加载失败不致命（锁屏退回快捷键）
      try {
        const login = koffi.load(LOGIN_PATH);
        loaded.loginFramework = true;
        bind(login, "SACLockScreenImmediate", "int SACLockScreenImmediate()");
      } catch (err) {
        log(`[desktop-darwin] login.framework 不可用，锁屏将退回快捷键：${err?.message || err}`);
      }

      const missing = REQUIRED.filter((name) => typeof fn[name] !== "function");
      if (missing.length > 0) {
        return { ok: false, error: `系统接口缺失：${missing.join("、")}（可能是 macOS 版本不兼容），电脑操作暂不可用` };
      }
      source = fn.CGEventSourceCreate(1);
      ready = true;
      return { ok: true };
    } catch (err) {
      return { ok: false, error: `桌面操作组件加载失败：${err?.message || err}` };
    }
  };

  // ── 事件投递（内部） ──

  const postMouse = (type, x, y, button, clickState) => {
    const ev = fn.CGEventCreateMouseEvent(source, type, { x, y }, button);
    if (!ev) throw new Error("系统没有创建出鼠标事件（CGEventCreateMouseEvent 返回空）");
    try {
      if (clickState) fn.CGEventSetIntegerValueField(ev, FIELD_CLICK_STATE, clickState);
      fn.CGEventPost(tap, ev);
    } finally {
      fn.CFRelease(ev);
    }
  };

  const postKey = (keyCode, down, flags, unicodeUnits) => {
    const ev = fn.CGEventCreateKeyboardEvent(source, keyCode, down);
    if (!ev) throw new Error("系统没有创建出键盘事件（CGEventCreateKeyboardEvent 返回空）");
    try {
      if (unicodeUnits) fn.CGEventKeyboardSetUnicodeString(ev, unicodeUnits.length, unicodeUnits);
      // 显式写 flags（包括 0）：不让用户此刻物理按着的修饰键混进我们的事件
      fn.CGEventSetFlags(ev, flags);
      fn.CGEventPost(tap, ev);
    } finally {
      fn.CFRelease(ev);
    }
  };

  // ── 状态 ──

  /** 辅助功能权限：没有时 CGEventPost 静默丢弃事件。读不到返回 null */
  const inputPermitted = () => {
    if (!ready || typeof fn.AXIsProcessTrusted !== "function") return null;
    try {
      return !!fn.AXIsProcessTrusted();
    } catch {
      return null;
    }
  };

  const isScreenLocked = () => {
    if (!ready) return null;
    let dict = null;
    try {
      dict = fn.CGSessionCopyCurrentDictionary();
      if (!dict) return null;
      const key = fn.CFStringCreateWithCString(null, "CGSSessionScreenIsLocked", CF_UTF8);
      try {
        const v = fn.CFDictionaryGetValue(dict, key);
        // 没有这个键 = 没锁屏；有且为 true = 锁屏
        return v ? !!fn.CFBooleanGetValue(v) : false;
      } finally {
        fn.CFRelease(key);
      }
    } catch (err) {
      log(`[desktop-darwin] 读锁屏状态失败：${err?.message || err}`);
      return null;
    } finally {
      if (dict) fn.CFRelease(dict);
    }
  };

  /** kCGEventSourceStateHIDSystemState = 1；kCGAnyInputEventType = ~0 */
  const idleSeconds = () => Number(fn.CGEventSourceSecondsSinceLastEventType(1, 0xffffffff));

  const getPrimaryDisplay = () => {
    const b = fn.CGDisplayBounds(fn.CGMainDisplayID());
    const r = (v) => Math.round(v) || 0; // 归一 -0
    return { x: r(b.origin.x), y: r(b.origin.y), width: r(b.size.width), height: r(b.size.height) };
  };

  // ── 鼠标 ──

  const mouseMove = (x, y) => {
    postMouse(EV_MOUSE_MOVED, x, y, 0, 0);
  };

  const click = async (x, y, opts = {}) => {
    const spec = BUTTON_EVENTS[opts.button ?? "left"];
    if (!spec) throw new Error(`不支持的鼠标按键：${String(opts.button)}`);
    const count = Math.min(3, Math.max(1, Math.trunc(opts.count ?? 1)));
    // 先移过去：悬停态（菜单高亮、tooltip）要先生效，点击才稳
    postMouse(EV_MOUSE_MOVED, x, y, 0, 0);
    await sleep(25);
    for (let i = 1; i <= count; i += 1) {
      postMouse(spec.down, x, y, spec.button, i);
      postMouse(spec.up, x, y, spec.button, i);
      if (i < count) await sleep(40);
    }
  };

  const drag = async (from, to, opts = {}) => {
    const spec = BUTTON_EVENTS[opts.button ?? "left"];
    if (!spec) throw new Error(`不支持的鼠标按键：${String(opts.button)}`);
    const durationMs = Math.min(5000, Math.max(50, opts.durationMs ?? 300));
    const steps = 10;
    postMouse(EV_MOUSE_MOVED, from.x, from.y, 0, 0);
    await sleep(30);
    postMouse(spec.down, from.x, from.y, spec.button, 1);
    try {
      for (let i = 1; i <= steps; i += 1) {
        await sleep(durationMs / steps);
        const x = Math.round(from.x + ((to.x - from.x) * i) / steps);
        const y = Math.round(from.y + ((to.y - from.y) * i) / steps);
        postMouse(spec.drag, x, y, spec.button, 1);
      }
    } finally {
      // 任何一步失败都要把按键抬起来，否则鼠标会卡在按下状态
      postMouse(spec.up, to.x, to.y, spec.button, 1);
    }
  };

  const scroll = async (x, y, dx, dy) => {
    postMouse(EV_MOUSE_MOVED, x, y, 0, 0);
    await sleep(15);
    // CG 的滚轮：wheel1 正值 = 内容向上滚（看到更上面）。对外语义 dy>0 = 向下看，所以取负
    // 末尾的 `|| 0` 把 -0 归一成 0
    let remainV = -Math.trunc(dy || 0) || 0;
    let remainH = -Math.trunc(dx || 0) || 0;
    // 单个事件别塞太多行，分段发（部分应用对大滚动量会丢弃 / 惯性失控）
    while (remainV !== 0 || remainH !== 0) {
      const v = Math.max(-10, Math.min(10, remainV));
      const h = Math.max(-10, Math.min(10, remainH));
      const ev = fn.CGEventCreateScrollWheelEvent2(source, SCROLL_UNIT_LINE, 2, v, h, 0);
      if (!ev) throw new Error("系统没有创建出滚轮事件");
      try {
        fn.CGEventPost(tap, ev);
      } finally {
        fn.CFRelease(ev);
      }
      remainV -= v;
      remainH -= h;
      if (remainV !== 0 || remainH !== 0) await sleep(20);
    }
  };

  // ── 键盘 ──

  const keyCombo = async ({ mods, key }) => {
    const mainKey = MAC_KEYCODES[key];
    if (mainKey === undefined) throw new Error(`不认识的按键：${key}`);
    // 「+」要 Shift：美式布局上它是 Shift + 「=」
    const effective = key === "plus" && !mods.includes("shift") ? [...mods, "shift"] : [...mods];
    const ordered = MOD_ORDER.filter((m) => effective.includes(m));
    let flags = 0;
    const pressed = [];
    try {
      for (const m of ordered) {
        flags |= FLAG[m];
        postKey(MOD_KEYCODE[m], true, flags);
        pressed.push(m);
      }
      postKey(mainKey, true, flags);
      await sleep(8);
      postKey(mainKey, false, flags);
    } finally {
      // 修饰键一定要抬起来（否则整台电脑像按住了 Cmd / Shift）
      for (const m of pressed.reverse()) {
        flags &= ~FLAG[m];
        postKey(MOD_KEYCODE[m], false, flags);
      }
    }
  };

  /**
   * 真实键码输入（美式布局）：和物理键盘的事件一致，锁屏界面 / 密码框也认。
   * 只支持 ASCII 可打印字符 + 换行 / 制表符；先整段预检，免得输到一半才发现有打不出的字符。
   * 报错不回显字符（这条路径会被用来输入密码）。
   */
  const keysTypeable = (chars) => chars.every((ch) => ch === "\n" || ch === "\r" || ch === "\t" || Boolean(asciiToKey(ch)));

  /**
   * 键码输入模式（锁屏界面输密码用的那条路）能不能打出这段文字。
   * 保存开机密码时先问一句，解锁时也先问一句：打不出来的密码存了也是白存，而且不能等「输到一半才发现」。
   * @param {string} text
   * @returns {boolean}
   */
  const canTypeKeys = (text) => keysTypeable([...String(text)]);

  const typeKeys = async (text) => {
    const chars = [...String(text)];
    if (!keysTypeable(chars)) throw new Error("键码输入模式只支持英文字母、数字和常见符号");
    let n = 0;
    for (const ch of chars) {
      if (ch === "\n" || ch === "\r") {
        postKey(KEY_RETURN, true, 0);
        postKey(KEY_RETURN, false, 0);
      } else if (ch === "\t") {
        postKey(KEY_TAB, true, 0);
        postKey(KEY_TAB, false, 0);
      } else {
        const k = asciiToKey(ch);
        const flags = k.shift ? FLAG.shift : 0;
        if (k.shift) postKey(MOD_KEYCODE.shift, true, FLAG.shift);
        try {
          postKey(k.code, true, flags);
          postKey(k.code, false, flags);
        } finally {
          if (k.shift) postKey(MOD_KEYCODE.shift, false, 0);
        }
      }
      n += 1;
      if (n % 8 === 0) await sleep(5);
    }
  };

  /**
   * @param {string} text
   * @param {{ mode?: 'unicode' | 'keys', shouldStop?: () => boolean }} [opts] unicode（默认）：Unicode 事件，不依赖键盘布局，中文 / emoji 可用，且绕过输入法；
   *   keys：真实键码，仅 ASCII（锁屏界面输入密码用这个）；
   *   shouldStop（仅 unicode 模式）：每个批次开头问一次，返回 true 就立刻收手（不抛错）——会话已在收尾，
   *   剩下的字不能再打（锁屏界面一出来，它们就会进密码框）
   */
  const typeText = async (text, opts = {}) => {
    if (opts.mode === "keys") return typeKeys(text);
    const shouldStop = typeof opts.shouldStop === "function" ? opts.shouldStop : null;
    let n = 0;
    for (const ch of String(text)) {
      if (shouldStop && n % 12 === 0 && shouldStop()) return;
      if (ch === "\n" || ch === "\r") {
        postKey(KEY_RETURN, true, 0);
        postKey(KEY_RETURN, false, 0);
      } else if (ch === "\t") {
        postKey(KEY_TAB, true, 0);
        postKey(KEY_TAB, false, 0);
      } else {
        const units = new Uint16Array(ch.length);
        for (let i = 0; i < ch.length; i += 1) units[i] = ch.charCodeAt(i);
        postKey(0, true, 0, units);
        postKey(0, false, 0, units);
      }
      n += 1;
      // 每 12 个字符让出一下：目标应用来得及处理，主进程事件循环也不被长文本卡住
      if (n % 12 === 0) await sleep(4);
    }
  };

  // ── 应用 / 窗口 ──

  const runJxa = async (script) => {
    const out = await execFileP(exec, "/usr/bin/osascript", ["-l", "JavaScript", "-e", script], { timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
    return out.trim();
  };

  const listApps = async () => {
    const out = await runJxa(LIST_APPS_JXA);
    let parsed;
    try {
      parsed = JSON.parse(out);
    } catch {
      throw new Error("读取应用列表失败（系统返回了无法解析的内容）");
    }
    return Array.isArray(parsed) ? parsed : [];
  };

  const frontmostApp = async () => {
    const apps = await listApps();
    return apps.find((a) => a.frontmost) ?? null;
  };

  /** 按显示名找应用时认的目录（优先级从高到低）：Spotlight 会把应用包里的辅助程序、别处的副本也搜出来，只认这几处的顶层应用 */
  const appRoots = () => ["/Applications/", "/System/Applications/", "/System/Library/CoreServices/", `${deps.homeDir ?? os.homedir()}/Applications/`];

  /**
   * 用显示名（系统当前语言下 Finder 里看到的名字，如「微信」「飞书」「访达」「系统设置」）找应用——`open -a` 只认文件名
   * （WeChat / Lark / Finder / System Settings），用户和模型说的却常常是显示名。
   * 精确匹配（不是模糊搜索）：「微信」只会找到微信，不会连「企业微信」「微信开发者工具」一起打开。
   * @returns {Promise<string[]>} 应用路径（去重，不含应用包里面的辅助程序）；搜不到 / 名字里有会进查询语法的字符 / Spotlight 出错 = 空
   */
  const findAppsByDisplayName = async (name) => {
    // 名字会被拼进 Spotlight 查询：引号 / 反斜杠 / 通配符 / 控制字符都不可能是真实的应用名，直接不查
    if (name.length > 100 || /["\\*\u0000-\u001f]/.test(name)) return [];
    let out;
    try {
      out = await execFileP(exec, "/usr/bin/mdfind", [`kMDItemContentType == "com.apple.application-bundle" && kMDItemDisplayName == "${name}"c`], {
        timeout: 8000,
        maxBuffer: 1024 * 1024,
      });
    } catch {
      return [];
    }
    return [...new Set(out.split("\n").filter((p) => p.endsWith(".app") && !p.includes(".app/")))];
  };

  const openFailure = (label, err) => {
    const stderr = String(err?.stderr || "").trim();
    return new Error(`打不开应用「${label.slice(0, 60)}」${stderr ? `：${stderr.slice(0, 120)}` : "（可能没有安装，或名字不对；可先用 desktop_apps 看运行中的应用）"}`);
  };

  const openApp = async (nameOrPath) => {
    const target = String(nameOrPath ?? "").trim();
    if (target === "" || target.length > 300) throw new Error("应用名不能为空，也不能超过 300 个字符");
    // execFile 不经 shell，没有注入；但以 - 开头会被 open 当成选项，直接拒绝
    if (target.startsWith("-")) throw new Error("应用名不能以「-」开头");
    if (target.startsWith("/")) {
      // 绝对路径：只打开应用（和 Windows 驱动同一语义）——open 对任意文件都会照做（.command / .terminal 之类甚至会被执行）
      if (!/\.app\/*$/i.test(target)) throw new Error("只能打开应用：路径要指向一个 .app（如 /Applications/Safari.app）");
      // 而且只认和「按显示名找」同一批目录里的顶层应用（第三轮评审：以前任何位置的 .app 都能被一条路径跑起来）：
      // 下载目录 / 桌面 / 临时目录 / U 盘 / 应用包里面的辅助程序，都可能是刚下载或刚放进去的任意程序，
      // 模型（可能被屏幕上的内容带偏）不该凭一条路径就把它跑起来。
      // 先按 POSIX 规则规范化（.. / . / 重复斜杠）再判断，打开的也是规范化后的这条路径——验证的和执行的是同一个字符串
      // （`/Applications/link/../x.app` 这类词法上在白名单里、实际经符号链接绕出去的写法，规范化后就是 /Applications/x.app，系统不会再替它绕）
      const resolved = path.posix.normalize(target);
      const bare = resolved.replace(/\/+$/, "");
      if (!appRoots().some((root) => bare.startsWith(root)) || /\.app\//i.test(bare)) {
        throw new Error(
          "只能打开「应用程序」文件夹里的应用（/Applications、/System/Applications、/System/Library/CoreServices、~/Applications 下面，不含应用包里面的辅助程序）；别处的应用请先让用户把它放进「应用程序」文件夹，或者直接用应用名",
        );
      }
      try {
        await execFileP(exec, "/usr/bin/open", [resolved], { timeout: 15000 });
      } catch (err) {
        throw openFailure(target, err);
      }
      return;
    }
    let first;
    try {
      await execFileP(exec, "/usr/bin/open", ["-a", target], { timeout: 15000 });
      return;
    } catch (err) {
      first = err;
    }
    // `open -a` 没认出这个名字：超时之类的不再试（总时长会超）；否则按显示名找一遍（「微信」→ WeChat.app）
    if (first?.killed || first?.signal) throw openFailure(target, first);
    // 只在认可的目录里挑（别处的副本、安装包里的不算），按目录优先级：同一目录里只有一个才打开，多个就让模型指明
    const found = await findAppsByDisplayName(target);
    for (const root of appRoots()) {
      const hit = found.filter((p) => p.startsWith(root));
      if (hit.length === 0) continue;
      if (hit.length > 1) {
        throw new Error(`有多个叫「${target.slice(0, 60)}」的应用：${hit.slice(0, 5).join("、")}。请把要打开的那个的完整路径填进 name 再试`);
      }
      try {
        await execFileP(exec, "/usr/bin/open", [hit[0]], { timeout: 15000 });
        return;
      } catch (err) {
        throw openFailure(target, err);
      }
    }
    throw openFailure(target, first);
  };

  // ── 屏幕 / 电源 ──

  const wakeDisplay = async () => {
    // caffeinate -u 声明「用户活动」会点亮熄灭的显示器；子进程自己 5 秒后退出，不等它
    const child = exec("/usr/bin/caffeinate", ["-u", "-t", "5"], { timeout: 10000 }, () => {});
    child?.unref?.();
  };

  /**
   * 锁屏。默认走 SACLockScreenImmediate（不依赖键盘事件），没有或失败就退回快捷键；
   * method:"shortcut" 直接按快捷键——上一次「命令发出了但电脑没进入锁屏」时的兜底，换一条路再试。
   * @param {{ method?: 'auto' | 'shortcut' }} [opts]
   */
  const lockScreen = async (opts = {}) => {
    if (opts.method !== "shortcut" && typeof fn.SACLockScreenImmediate === "function") {
      try {
        fn.SACLockScreenImmediate();
        return;
      } catch (err) {
        log(`[desktop-darwin] SACLockScreenImmediate 调用失败，退回快捷键：${err?.message || err}`);
      }
    }
    // 系统快捷键 Ctrl + Cmd + Q 锁屏（需要辅助功能权限）
    await keyCombo({ mods: ["ctrl", "meta"], key: "q" });
  };

  const diagnostics = () => {
    const out = {
      platform: "darwin",
      osRelease: os.release(),
      arch: process.arch,
      electron: process.versions.electron ?? null,
      node: process.versions.node,
      koffi: koffiVersion,
      ready,
      loaded: { ...loaded },
      bindFailures: [...bindFailures],
      lockScreenApi: typeof fn.SACLockScreenImmediate === "function" ? "SACLockScreenImmediate" : "shortcut",
    };
    if (ready) {
      try {
        out.axTrusted = inputPermitted();
        out.locked = isScreenLocked();
        out.display = getPrimaryDisplay();
        out.idleSeconds = idleSeconds();
      } catch (err) {
        out.diagnosticsError = String(err?.message || err).slice(0, 200);
      }
    }
    return out;
  };

  return {
    platform: "darwin",
    init,
    diagnostics,
    inputPermitted,
    isScreenLocked,
    idleSeconds,
    getPrimaryDisplay,
    mouseMove,
    click,
    drag,
    scroll,
    keyCombo,
    typeText,
    canTypeKeys,
    frontmostApp,
    listApps,
    openApp,
    wakeDisplay,
    lockScreen,
  };
};
