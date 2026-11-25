/**
 * Windows「锁屏后台档」的纯函数部分：消息编码 / 按键与文本的消息计划 / 帧合成 / 空白检测 / 命中测试。
 *
 * 这里没有任何 FFI、没有 koffi、没有 Electron——Mac 上可以整条单测。驱动（win32-background.mjs）只负责把这里算好的
 * 「要发什么消息、画到哪里」交给系统。
 *
 * 背景：电脑锁屏时输入桌面切到了 Winlogon，SendInput / 全屏截图都失效；但用户桌面上的应用还活着，窗口句柄也还在，
 * 所以改用「窗口消息」操作、「逐窗口 PrintWindow」截图。这条路的已知边界（写进提示给 AI）：
 * - PostMessage 发出去的按键 / 鼠标消息不会改变线程的按键状态表（GetKeyState 永远读到「没按」），
 *   所以 Ctrl / Shift / Alt 组合键只能尽力模拟：Ctrl+A/C/V/X/Z 对 Edit 类控件改用专用消息（EM_SETSEL / WM_COPY…），其余照发修饰键消息；
 * - Win 键组合、Alt+Tab 这类系统级按键发不了（要求前台 / 真实输入）；
 * - 依赖 DirectComposition / GPU 的应用（Chromium、Electron 系）锁屏时窗口被当成被遮挡，可能画不出新内容。
 */
import { DesktopError } from "../types.mjs";
import { KEY_TABLE, MODIFIER_ORDER, MODIFIER_VK, WHEEL_DELTA, lookupKey } from "./win32-defs.mjs";
import { EDIT_CLASS_PREFIXES, EM_SETSEL, MK, WM } from "./win32-bg-defs.mjs";

const badArgs = (message) => new DesktopError("BAD_ARGS", message);

// ═══════════════════════════ 节奏参数 ═══════════════════════════

/** 点击：移动 → 按下之间 */
export const BG_MOVE_GAP_MS = 15;
/** 点击：按下 → 抬起之间（给应用一点处理时间；太短有的应用认不出是点击） */
export const BG_HOLD_MS = 40;
/** 多击：两次点击之间 */
export const BG_MULTI_GAP_MS = 40;
/** 拖拽：路径上除起点、终点之外的中间点个数（共 DRAG_STEPS + 1 次停顿，同前台驱动） */
export const BG_DRAG_STEPS = 10;
/** typeText：每批最多多少个 UTF-16 code unit、批间停顿（PostMessage 的队列上限 10000 条，不能一口气全灌进去） */
export const BG_TYPE_BATCH_UNITS = 30;
export const BG_TYPE_BATCH_GAP_MS = 10;
/** 一次 typeText 的 code unit 上限（同前台驱动） */
export const BG_TYPE_MAX_UNITS = 20000;
/** 滚轮：一次消息最多带几格（一格 = WHEEL_DELTA），单次调用最多滚多少格 */
export const BG_WHEEL_NOTCHES_PER_MESSAGE = 5;
export const BG_MAX_WHEEL_NOTCHES = 1000;

// ═══════════════════════════ 消息参数编码 ═══════════════════════════

/** MAKELPARAM(x, y)：低 16 位 x、高 16 位 y（各取低 16 位的补码），按无符号 32 位给——和系统自己发的鼠标消息一致 */
export const makeLParam = (x, y) => (((y & 0xffff) << 16) | (x & 0xffff)) >>> 0;

/** WM_MOUSEWHEEL / WM_MOUSEHWHEEL 的 wParam：低 16 位按键状态，高 16 位滚动量（有符号，120 的整数倍） */
export const makeWheelWParam = (keys, delta) => (((delta & 0xffff) << 16) | (keys & 0xffff)) >>> 0;

/**
 * 键盘消息的 lParam：位 0-15 重复次数（1）、16-23 扫描码、24 扩展键、29 Alt 状态（context code）、
 * 30 之前的键状态（抬起消息为 1）、31 转换状态（抬起消息为 1）。
 */
export const keyLParam = ({ scan = 0, extended = false, up = false, alt = false }) => {
  let value = 1 | ((scan & 0xff) << 16);
  if (extended) value |= 1 << 24;
  if (alt) value |= 1 << 29;
  if (up) value |= (1 << 30) | (1 << 31);
  return value >>> 0;
};

// ═══════════════════════════ 鼠标 ═══════════════════════════

/** 鼠标按钮 → 按下 / 抬起 / 双击消息与 wParam 里的按键位 */
export const BG_BUTTONS = Object.freeze({
  left: Object.freeze({ down: WM.LBUTTONDOWN, up: WM.LBUTTONUP, dbl: WM.LBUTTONDBLCLK, mk: MK.LBUTTON }),
  right: Object.freeze({ down: WM.RBUTTONDOWN, up: WM.RBUTTONUP, dbl: WM.RBUTTONDBLCLK, mk: MK.RBUTTON }),
  middle: Object.freeze({ down: WM.MBUTTONDOWN, up: WM.MBUTTONUP, dbl: WM.MBUTTONDBLCLK, mk: MK.MBUTTON }),
});

/** 校验鼠标按钮名 */
export const bgButton = (button = "left") => {
  if (typeof button !== "string" || !Object.hasOwn(BG_BUTTONS, button)) throw badArgs("button 只能是 left / right / middle");
  return BG_BUTTONS[button];
};

/**
 * 点击 → 消息序列（客户区坐标已经算好，作为 lParam 传入）。
 * 顺序：MOUSEMOVE → [DOWN → UP] → 第二下用 DBLCLK（Windows 自己就是这样：单击 DOWN/UP、双击的第二下是 DBLCLK/UP）→ 第三下又是 DOWN/UP。
 * 每条带 gapMs：发完这条之后要停多久。
 * @returns {Array<{ msg: number, wParam: number, lParam: number, gapMs: number }>}
 */
export const planClickMessages = ({ button = "left", count = 1, lParam }) => {
  const b = bgButton(button);
  if (!Number.isInteger(count) || count < 1 || count > 3) throw badArgs("count 必须是 1–3 的整数（单击 / 双击 / 三击）");
  const out = [{ msg: WM.MOUSEMOVE, wParam: 0, lParam, gapMs: BG_MOVE_GAP_MS }];
  for (let i = 0; i < count; i += 1) {
    out.push({ msg: i === 1 ? b.dbl : b.down, wParam: b.mk, lParam, gapMs: BG_HOLD_MS });
    out.push({ msg: b.up, wParam: 0, lParam, gapMs: i < count - 1 ? BG_MULTI_GAP_MS : 0 });
  }
  return out;
};

const lerp = (a, b, t) => Math.round(a + (b - a) * t);

/** 拖拽路径上的中间点（不含起点终点），线性插值，BG_DRAG_STEPS - 1 个 */
export const planDragPoints = (from, to) => {
  const points = [];
  for (let i = 1; i < BG_DRAG_STEPS; i += 1) {
    points.push({ x: lerp(from.x, to.x, i / BG_DRAG_STEPS), y: lerp(from.y, to.y, i / BG_DRAG_STEPS) });
  }
  return points;
};

/** 滚轮：滚动格数 → 若干条 WHEEL 消息（契约同前台：dy > 0 = 向下、dx > 0 = 向右；一条最多带 BG_WHEEL_NOTCHES_PER_MESSAGE 格） */
export const planWheelMessages = ({ dx, dy, screenX, screenY }) => {
  const check = (value, name) => {
    if (typeof value !== "number" || !Number.isFinite(value)) throw badArgs(`${name} 必须是数字（滚动的格数）`);
    if (Math.abs(value) > BG_MAX_WHEEL_NOTCHES) throw badArgs(`${name} 超出范围：一次最多滚动 ${BG_MAX_WHEEL_NOTCHES} 格`);
    return Math.round(value);
  };
  const vertical = check(dy, "dy");
  const horizontal = check(dx, "dx");
  if (vertical === 0 && horizontal === 0) throw badArgs("dx 和 dy 不能同时为 0");
  const lParam = makeLParam(screenX, screenY); // 滚轮消息的坐标是「屏幕坐标」
  const out = [];
  const push = (msg, notches) => {
    const sign = Math.sign(notches);
    let left = Math.abs(notches);
    while (left > 0) {
      const n = Math.min(left, BG_WHEEL_NOTCHES_PER_MESSAGE);
      out.push({ msg, wParam: makeWheelWParam(0, sign * n * WHEEL_DELTA), lParam });
      left -= n;
    }
  };
  // WM_MOUSEWHEEL 的正值 = 向上，所以「向下」取负；WM_MOUSEHWHEEL 的正值 = 向右
  push(WM.MOUSEWHEEL, -vertical);
  push(WM.MOUSEHWHEEL, horizontal);
  return out;
};

// ═══════════════════════════ 键盘 ═══════════════════════════

/** 美式键盘：规范键名 → [不按 shift 的字符, 按 shift 的字符] */
const PUNCTUATION_CHARS = Object.freeze({
  "=": ["=", "+"],
  minus: ["-", "_"],
  "-": ["-", "_"],
  plus: ["+", "+"],
  "[": ["[", "{"],
  "]": ["]", "}"],
  "\\": ["\\", "|"],
  ";": [";", ":"],
  "'": ["'", '"'],
  ",": [",", "<"],
  ".": [".", ">"],
  "/": ["/", "?"],
  "`": ["`", "~"],
});
const SHIFTED_DIGITS = ")!@#$%^&*(";

/** 不按 Ctrl 时会产生 WM_CHAR 的控制类按键 */
const CONTROL_CHARS = Object.freeze({ enter: 13, tab: 9, escape: 27, backspace: 8 });

/** 规范键名 → 它在美式键盘上产生的字符；不产生字符（方向键、F 键…）返回 null */
export const charOfKey = (key, shift = false) => {
  if (typeof key !== "string") return null;
  if (key.length === 1 && key >= "a" && key <= "z") return shift ? key.toUpperCase() : key;
  if (key.length === 1 && key >= "0" && key <= "9") return shift ? SHIFTED_DIGITS[Number(key)] : key;
  if (key === "space") return " ";
  if (Object.hasOwn(PUNCTUATION_CHARS, key)) return PUNCTUATION_CHARS[key][shift ? 1 : 0];
  return null;
};

/** 字符 → 产生它的按键（vk + 是否要 shift）；懒构建一次。只覆盖美式键盘的可打印 ASCII */
let charToKeyTable = null;
export const keyOfChar = (unit) => {
  if (!charToKeyTable) {
    const table = new Map();
    for (const [name, entry] of Object.entries(KEY_TABLE)) {
      for (const shift of [false, true]) {
        const ch = charOfKey(name, shift);
        if (ch === null || table.has(ch)) continue;
        table.set(ch, { vk: entry.vk, extended: entry.extended, shift });
      }
    }
    charToKeyTable = table;
  }
  return charToKeyTable.get(String.fromCharCode(unit)) ?? null;
};

/** Ctrl+字母 → 对 Edit / RichEdit 类控件直接说话的消息（见头注释：不依赖 Ctrl 键状态） */
export const CTRL_SPECIALS = Object.freeze({
  a: Object.freeze({ msg: EM_SETSEL, wParam: 0, lParam: -1 }), // 0..-1 = 全选
  c: Object.freeze({ msg: WM.COPY, wParam: 0, lParam: 0 }),
  v: Object.freeze({ msg: WM.PASTE, wParam: 0, lParam: 0 }),
  x: Object.freeze({ msg: WM.CUT, wParam: 0, lParam: 0 }),
  z: Object.freeze({ msg: WM.UNDO, wParam: 0, lParam: 0 }),
});

/** 类名是不是 Edit / RichEdit 类（不区分大小写，前缀匹配） */
export const isEditClass = (className) => {
  if (typeof className !== "string") return false;
  const lower = className.toLowerCase();
  return EDIT_CLASS_PREFIXES.some((prefix) => lower.startsWith(prefix));
};

/** Alt+这些键是切换前台窗口的系统快捷键，消息投递做不到 */
const ALT_UNSUPPORTED_KEYS = new Set(["tab", "escape"]);

/**
 * @typedef {{ kind: "key", vk: number, extended: boolean, up: boolean, sys: boolean } | { kind: "char", unit: number, sys: boolean }} KeyStep
 * @typedef {Object} BackgroundKeyPlan
 * @property {string | null} unsupported  非 null = 后台发不了这个组合键（人话原因；上层据此报 NEED_FOREGROUND）
 * @property {KeyStep[]} steps            模拟「真实按键」的步骤：修饰键按下 → 主键按下 → [WM_CHAR] → 主键抬起 → 修饰键倒序抬起
 * @property {{ msg: number, wParam: number, lParam: number } | null} special  Ctrl+A/C/V/X/Z 的专用消息（目标是 Edit 类控件时用它代替 steps，二选一，不能都发）
 * @property {boolean} approximate        发出去也不保证应用认（带 Ctrl / Alt、或 Shift 加非字符键）：上层提示 AI 看截图确认
 */

/** @returns {BackgroundKeyPlan} */
const unsupportedPlan = (reason) => ({ unsupported: reason, steps: [], special: null, approximate: false });

/**
 * 组合键 → 后台消息计划。校验规则与前台驱动一致（key 必须是规范键名、修饰键只有 ctrl / alt / shift / meta、plus 自动补 shift）。
 * @param {{ mods?: string[], key: string }} combo
 * @returns {BackgroundKeyPlan}
 */
export const planBackgroundKey = (combo) => {
  const entry = lookupKey(combo?.key);
  if (!entry) throw badArgs("不认识的按键，无法映射到 Windows 虚拟键码（key 必须是 keys.mjs 的规范键名）");
  const list = combo?.mods ?? [];
  if (!Array.isArray(list)) throw badArgs("mods 必须是数组");
  const wanted = new Set();
  for (const mod of list) {
    if (!MODIFIER_ORDER.includes(mod)) throw badArgs("不认识的修饰键（只支持 ctrl / alt / shift / meta）");
    wanted.add(mod);
  }
  if (entry.shift) wanted.add("shift");
  const ctrl = wanted.has("ctrl");
  const alt = wanted.has("alt");
  const shift = wanted.has("shift");
  if (wanted.has("meta")) return unsupportedPlan("带 Win 键的组合键只有真实键鼠才发得出去（窗口消息里没有对应的东西）");
  if (alt && ALT_UNSUPPORTED_KEYS.has(combo.key)) {
    return unsupportedPlan("Alt+Tab / Alt+Esc 是切换前台窗口的系统快捷键，窗口消息发不了");
  }

  const mods = ["ctrl", "alt", "shift"].filter((m) => wanted.has(m));
  /** @type {KeyStep[]} */
  const steps = [];
  for (const m of mods) steps.push({ kind: "key", vk: MODIFIER_VK[m], extended: false, up: false, sys: alt });
  steps.push({ kind: "key", vk: entry.vk, extended: entry.extended, up: false, sys: alt });

  // 系统在 TranslateMessage 里会把按键翻译成字符：Ctrl+字母 → 控制码 1–26；其余可打印键 → 它的字符；Enter / Tab / Esc / Backspace → 控制字符
  let unit = null;
  if (ctrl) {
    if (!alt && combo.key.length === 1 && combo.key >= "a" && combo.key <= "z") unit = combo.key.charCodeAt(0) - 96;
  } else if (Object.hasOwn(CONTROL_CHARS, combo.key)) {
    unit = CONTROL_CHARS[combo.key];
  } else {
    const ch = charOfKey(combo.key, shift);
    if (ch !== null) unit = ch.charCodeAt(0);
  }
  if (unit !== null) steps.push({ kind: "char", unit, sys: alt });

  steps.push({ kind: "key", vk: entry.vk, extended: entry.extended, up: true, sys: alt });
  for (const m of [...mods].reverse()) steps.push({ kind: "key", vk: MODIFIER_VK[m], extended: false, up: true, sys: alt });

  const special = ctrl && !alt && !shift && Object.hasOwn(CTRL_SPECIALS, combo.key) ? CTRL_SPECIALS[combo.key] : null;
  const approximate = ctrl || alt || (shift && unit === null);
  return { unsupported: null, steps, special, approximate };
};

/**
 * 计划步骤 → 具体消息（wParam / lParam 编码）。scanOf：虚拟键码 → 扫描码（驱动用 MapVirtualKeyW，缓存过）。
 * @param {KeyStep[]} steps
 * @param {(vk: number) => number} scanOf
 * @returns {Array<{ msg: number, wParam: number, lParam: number }>}
 */
export const renderKeySteps = (steps, scanOf) =>
  steps.map((step) => {
    if (step.kind === "char") {
      return { msg: step.sys ? WM.SYSCHAR : WM.CHAR, wParam: step.unit, lParam: keyLParam({ alt: step.sys }) };
    }
    const msg = step.sys ? (step.up ? WM.SYSKEYUP : WM.SYSKEYDOWN) : step.up ? WM.KEYUP : WM.KEYDOWN;
    return { msg, wParam: step.vk, lParam: keyLParam({ scan: scanOf(step.vk), extended: step.extended, up: step.up, alt: step.sys }) };
  });

const isHighSurrogate = (unit) => unit >= 0xd800 && unit <= 0xdbff;
const isLowSurrogate = (unit) => unit >= 0xdc00 && unit <= 0xdfff;

/**
 * 文本 → 输入单元：换行（\n、\r\n、孤立 \r 都算一个）→ Enter，\t → Tab，其余按 UTF-16 code unit（surrogate pair 合成一个单元）。
 * 其它控制字符没有可靠的输入方式，报错（只写位置，不写字符——文本可能是密码）。规则与前台驱动一致。
 * @returns {Array<{ units: number[] } | { key: "enter" | "tab" }>}
 */
export const planBackgroundTyping = (text) => {
  const items = [];
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i);
    if (unit === 0x0d) {
      if (text.charCodeAt(i + 1) === 0x0a) i += 1;
      items.push({ key: "enter" });
    } else if (unit === 0x0a) {
      items.push({ key: "enter" });
    } else if (unit === 0x09) {
      items.push({ key: "tab" });
    } else if (unit < 0x20 || unit === 0x7f) {
      throw badArgs(`文本里第 ${i + 1} 个字符是无法输入的控制字符（只支持换行和制表符），请去掉后重试`);
    } else if (isHighSurrogate(unit) && isLowSurrogate(text.charCodeAt(i + 1))) {
      items.push({ units: [unit, text.charCodeAt(i + 1)] });
      i += 1;
    } else {
      items.push({ units: [unit] });
    }
  }
  return items;
};

/** 输入单元按「每批 ≤ BG_TYPE_BATCH_UNITS 个 code unit」分批；单元不拆开 */
export const batchBackgroundTyping = (items) => {
  const batches = [];
  let current = [];
  let size = 0;
  for (const item of items) {
    const n = "units" in item ? item.units.length : 1;
    if (size + n > BG_TYPE_BATCH_UNITS && current.length > 0) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(item);
    size += n;
  }
  if (current.length > 0) batches.push(current);
  return batches;
};

/**
 * 一个输入单元 → 消息。ASCII 可打印字符按真实键盘的顺序发 KEYDOWN → CHAR → KEYUP（不发 Shift 键消息：按键状态表本来就不会更新，
 * 应用读的是 WM_CHAR 里的字符）；没有对应按键的字符（中文等）只发 WM_CHAR；Enter / Tab 走 planBackgroundKey。
 * @param {{ units: number[] } | { key: "enter" | "tab" }} item
 * @param {(vk: number) => number} scanOf
 */
export const renderTypingItem = (item, scanOf) => {
  if ("key" in item) return renderKeySteps(planBackgroundKey({ mods: [], key: item.key }).steps, scanOf);
  const out = [];
  for (const unit of item.units) {
    const key = item.units.length === 1 ? keyOfChar(unit) : null;
    if (key) {
      out.push({ msg: WM.KEYDOWN, wParam: key.vk, lParam: keyLParam({ scan: scanOf(key.vk), extended: key.extended }) });
      out.push({ msg: WM.CHAR, wParam: unit, lParam: keyLParam({ scan: scanOf(key.vk) }) });
      out.push({ msg: WM.KEYUP, wParam: key.vk, lParam: keyLParam({ scan: scanOf(key.vk), extended: key.extended, up: true }) });
    } else {
      out.push({ msg: WM.CHAR, wParam: unit, lParam: keyLParam({}) });
    }
  }
  return out;
};

// ═══════════════════════════ 命中测试 ═══════════════════════════

/**
 * 在「Z 序从上到下」的窗口列表里找屏幕点 (x, y) 命中的最上层窗口（矩形左 / 上闭、右 / 下开）；没有返回 null。
 * @template {{ x: number, y: number, width: number, height: number }} W
 * @param {W[]} windows
 * @returns {W | null}
 */
export const pickWindowAt = (windows, x, y) => {
  for (const w of windows) {
    if (x >= w.x && x < w.x + w.width && y >= w.y && y < w.y + w.height) return w;
  }
  return null;
};

// ═══════════════════════════ 截图合成 ═══════════════════════════

/**
 * 一个窗口的位图（左上角 = 窗口矩形左上角，宽高 = 窗口矩形宽高）里，要拷到画布哪里。
 * 可见区域 = frameRect（DWM 的真实边界，缺省用窗口矩形）；超出画布 / 位图的部分裁掉。
 * @param {{ width: number, height: number }} canvas
 * @param {{ left: number, top: number, right: number, bottom: number }} windowRect  GetWindowRect（位图覆盖的范围）
 * @param {{ left: number, top: number, right: number, bottom: number } | null} frameRect
 * @returns {{ srcX: number, srcY: number, dstX: number, dstY: number, w: number, h: number } | null}
 */
export const planBlit = (canvas, windowRect, frameRect) => {
  const frame = frameRect ?? windowRect;
  const bitmapW = windowRect.right - windowRect.left;
  const bitmapH = windowRect.bottom - windowRect.top;
  let srcX = frame.left - windowRect.left;
  let srcY = frame.top - windowRect.top;
  let w = frame.right - frame.left;
  let h = frame.bottom - frame.top;
  let dstX = frame.left;
  let dstY = frame.top;
  if (dstX < 0) {
    srcX -= dstX;
    w += dstX;
    dstX = 0;
  }
  if (dstY < 0) {
    srcY -= dstY;
    h += dstY;
    dstY = 0;
  }
  if (srcX < 0) {
    dstX -= srcX;
    w += srcX;
    srcX = 0;
  }
  if (srcY < 0) {
    dstY -= srcY;
    h += srcY;
    srcY = 0;
  }
  if (dstX + w > canvas.width) w = canvas.width - dstX;
  if (dstY + h > canvas.height) h = canvas.height - dstY;
  if (srcX + w > bitmapW) w = bitmapW - srcX;
  if (srcY + h > bitmapH) h = bitmapH - srcY;
  if (w <= 0 || h <= 0 || dstX >= canvas.width || dstY >= canvas.height) return null;
  return { srcX, srcY, dstX, dstY, w, h };
};

/**
 * 把若干窗口位图按「先下后上」叠到画布上，返回 BGRA 缓冲区（Alpha 一律 255）。
 * @param {{ width: number, height: number, fill?: [number, number, number] }} canvas  fill = [B, G, R]
 * @param {Array<{ data: Buffer, bitmapWidth: number, srcX: number, srcY: number, dstX: number, dstY: number, w: number, h: number }>} layers
 *        layers 要按「从下到上」的顺序给（后面的盖住前面的）
 */
export const composeFrame = (canvas, layers) => {
  const { width, height } = canvas;
  const [fb, fg, fr] = canvas.fill ?? [0x20, 0x20, 0x20];
  const out = Buffer.alloc(width * height * 4);
  for (let i = 0; i < out.length; i += 4) {
    out[i] = fb;
    out[i + 1] = fg;
    out[i + 2] = fr;
  }
  for (const layer of layers) {
    for (let row = 0; row < layer.h; row += 1) {
      const srcOffset = ((layer.srcY + row) * layer.bitmapWidth + layer.srcX) * 4;
      const dstOffset = ((layer.dstY + row) * width + layer.dstX) * 4;
      layer.data.copy(out, dstOffset, srcOffset, srcOffset + layer.w * 4);
    }
  }
  // GDI 取出来的 32 位位图 Alpha 通道不可靠（常为 0），统一不透明，免得 JPEG / nativeImage 把它当透明处理
  for (let i = 3; i < out.length; i += 4) out[i] = 255;
  return out;
};

/**
 * 位图「是不是空白」：抽样（≤ samples 个点），最常见的颜色占比 ≥ 99.5% 且是（接近）纯黑或纯白 → 空白。
 * 用来发现 PrintWindow 返回成功但什么都没画出来的窗口（常见于 GPU 合成的应用）。
 * @param {Buffer} data  BGRA
 * @returns {{ blank: boolean, dominantRatio: number }}
 */
export const bitmapBlankness = (data, pixelCount, samples = 2400) => {
  if (pixelCount <= 0) return { blank: true, dominantRatio: 1 };
  const counts = new Map();
  const n = Math.min(samples, pixelCount);
  let best = 0;
  let bestKey = 0;
  for (let i = 0; i < n; i += 1) {
    const offset = Math.floor((i * pixelCount) / n) * 4;
    const key = (data[offset] << 16) | (data[offset + 1] << 8) | data[offset + 2];
    const c = (counts.get(key) ?? 0) + 1;
    counts.set(key, c);
    if (c > best) {
      best = c;
      bestKey = key;
    }
  }
  const dominantRatio = best / n;
  const b = (bestKey >> 16) & 0xff;
  const g = (bestKey >> 8) & 0xff;
  const r = bestKey & 0xff;
  const black = b <= 8 && g <= 8 && r <= 8;
  const white = b >= 247 && g >= 247 && r >= 247;
  return { blank: dominantRatio >= 0.995 && (black || white), dominantRatio };
};

/** 要不要放过这个窗口：点击穿透的分层窗口（各种覆盖层）既不该出现在截图里，也不该吃掉点击 */
export const isClickThrough = (exStyle, wsEx) => (exStyle & wsEx.TRANSPARENT) !== 0 && (exStyle & wsEx.LAYERED) !== 0;
