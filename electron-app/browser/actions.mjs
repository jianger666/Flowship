/**
 * 动作类 op 的实现（契约 §4.3 / §8）：click / hover / type / press_key / select / scroll / drag。
 *
 * 所有动作都经 `session.runAction({ op, tabId, signal }, fn)`：它负责串行、USER_CONTROL 校验、AI 状态与宽限、日志。
 * 本文件只管「怎么把一个动作稳稳地做在页面上」：
 *   ref → 滚入视野 → 内容 quad → OOPIF 偏移换算 → 可点击性检查 → 带归因 flag / 临时解锁的 CDP 输入 → 动作后稳定期。
 *
 * 纯逻辑（按键解析、quad 取点、滚动量计算、描述文案）全部导出，单测在 tests/browser-actions.test.ts。
 * 与 electron 零耦合：只靠 tab 对象（BrowserTab 或同形假对象）。
 *
 * 隐私：AI 动作摘要里**只写字符数，绝不写输入内容**（可能是账号口令）；单字符按键也不写具体字符。
 */
import { BrowserError } from "./server-channel.mjs";
import { aiWriteLedgerOf, isPasteCombo, pasteRejection } from "./clipboard-policy.mjs";
import { runUntilStable, UNTIL_STABLE_EXPR } from "./scroll-kit.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ───────────────────────── 纯函数：几何 ─────────────────────────

/** CDP quad = [x1,y1,x2,y2,x3,y3,x4,y4]（四个角，顺时针）。 */
const isQuad = (q) => Array.isArray(q) && q.length >= 8 && q.slice(0, 8).every((v) => typeof v === "number" && Number.isFinite(v));

/** quad 的几何中心（四角平均，旋转 / 变形元素也准）。 */
export const quadCenter = (q) => ({ x: (q[0] + q[2] + q[4] + q[6]) / 4, y: (q[1] + q[3] + q[5] + q[7]) / 4 });

/** quad 的外接矩形。 */
export const quadRect = (q) => {
  const xs = [q[0], q[2], q[4], q[6]];
  const ys = [q[1], q[3], q[5], q[7]];
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
};

/** 多边形面积（鞋带公式取绝对值）。 */
export const quadArea = (q) => {
  let s = 0;
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    s += q[i * 2] * q[j * 2 + 1] - q[j * 2] * q[i * 2 + 1];
  }
  return Math.abs(s) / 2;
};

/** 多个 quad（多行文本折行 / inline 元素会有多个）里挑面积最大的；没有合法 quad 返回 null。 */
export const pickBestQuad = (quads) => {
  if (!Array.isArray(quads)) return null;
  let best = null;
  let bestArea = -1;
  for (const q of quads) {
    if (!isQuad(q)) continue;
    const a = quadArea(q);
    if (a > bestArea) {
      best = q;
      bestArea = a;
    }
  }
  return best;
};

/** 两矩形交集；不相交返回 null。 */
export const intersectRect = (a, b) => {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  return x2 > x1 && y2 > y1 ? { x: x1, y: y1, width: x2 - x1, height: y2 - y1 } : null;
};

/**
 * 由 quads + OOPIF 偏移 + 视口算出点击点。
 * @param {number[][]} quads DOM.getContentQuads 的结果（目标所在 frame 的局部坐标）
 * @param {{x:number,y:number}} offset 该 frame 在主 frame 视口里的偏移（tab.frameOffset）
 * @param {{width:number,height:number}|null} viewport 主 frame 视口；宽高为 0 / null 时不做视口检查
 * @returns {{ point, rect, local } | { error: "no-box" | "zero-size" | "offscreen", rect?: object }}
 *   point / rect：主 frame 视口坐标（鼠标事件用）；local：目标 frame 局部坐标（遮挡检查用）
 */
export const computeTarget = (quads, offset = { x: 0, y: 0 }, viewport = null) => {
  const quad = pickBestQuad(quads);
  if (!quad) return { error: "no-box" };
  const lr = quadRect(quad);
  if (lr.width < 1 || lr.height < 1) return { error: "zero-size" };
  const rect = { x: lr.x + offset.x, y: lr.y + offset.y, width: lr.width, height: lr.height };
  const c = quadCenter(quad);
  let point = { x: c.x + offset.x, y: c.y + offset.y };
  if (viewport && viewport.width > 0 && viewport.height > 0) {
    const vis = intersectRect(rect, { x: 0, y: 0, width: viewport.width, height: viewport.height });
    if (!vis) return { error: "offscreen", rect };
    // 中心点落在视口外（元素比视口大 / 被裁）：改取可见部分的中心
    if (point.x < 0 || point.y < 0 || point.x >= viewport.width || point.y >= viewport.height) {
      point = { x: vis.x + vis.width / 2, y: vis.y + vis.height / 2 };
    }
  }
  return { point, rect, local: { x: point.x - offset.x, y: point.y - offset.y } };
};

/**
 * 滚动量：direction 缺省 down；amount 缺省 0.8 个视口（上下按高、左右按宽）；top / bottom 直达。
 * @returns {{ mode: "by" | "top" | "bottom", dx: number, dy: number, direction: string }}
 */
export const computeScrollDelta = ({ direction, amount, viewportW, viewportH } = {}) => {
  const dir = direction ?? "down";
  if (!["up", "down", "left", "right", "top", "bottom"].includes(dir)) {
    throw new BrowserError("BAD_ARGS", `direction 只能是 up / down / left / right / top / bottom，收到「${String(dir).slice(0, 20)}」`);
  }
  if (dir === "top" || dir === "bottom") return { mode: dir, dx: 0, dy: 0, direction: dir };
  const horizontal = dir === "left" || dir === "right";
  const base = horizontal ? viewportW : viewportH;
  const unit = Number.isFinite(base) && base > 0 ? base : 600;
  let amt = amount === undefined || amount === null ? Math.round(unit * 0.8) : Number(amount);
  if (!Number.isFinite(amt) || amt < 0) throw new BrowserError("BAD_ARGS", "amount 必须是非负数字（像素）");
  amt = Math.min(Math.round(amt), 100_000);
  const sign = dir === "down" || dir === "right" ? 1 : -1;
  return { mode: "by", dx: horizontal ? sign * amt : 0, dy: horizontal ? 0 : sign * amt, direction: dir };
};

// ───────────────────────── 纯函数：按键解析 ─────────────────────────

export const MODIFIER_BITS = Object.freeze({ Alt: 1, Control: 2, Meta: 4, Shift: 8 });
/** 修饰键按下时的事件参数；按这个顺序依次按下、反序抬起 */
const MODIFIER_KEYS = Object.freeze({
  Control: { key: "Control", code: "ControlLeft", vk: 17 },
  Alt: { key: "Alt", code: "AltLeft", vk: 18 },
  Shift: { key: "Shift", code: "ShiftLeft", vk: 16 },
  Meta: { key: "Meta", code: "MetaLeft", vk: 91 },
});
const MODIFIER_ORDER = ["Control", "Alt", "Shift", "Meta"];

const MODIFIER_ALIASES = {
  alt: "Alt",
  option: "Alt",
  opt: "Alt",
  control: "Control",
  ctrl: "Control",
  meta: "Meta",
  cmd: "Meta",
  command: "Meta",
  super: "Meta",
  win: "Meta",
  shift: "Shift",
  controlormeta: "ControlOrMeta",
  cmdorctrl: "ControlOrMeta",
  commandorcontrol: "ControlOrMeta",
  mod: "ControlOrMeta",
};

const NAMED_KEYS = {
  enter: { key: "Enter", code: "Enter", vk: 13, text: "\r" },
  return: { key: "Enter", code: "Enter", vk: 13, text: "\r" },
  escape: { key: "Escape", code: "Escape", vk: 27 },
  esc: { key: "Escape", code: "Escape", vk: 27 },
  tab: { key: "Tab", code: "Tab", vk: 9 },
  backspace: { key: "Backspace", code: "Backspace", vk: 8 },
  delete: { key: "Delete", code: "Delete", vk: 46 },
  del: { key: "Delete", code: "Delete", vk: 46 },
  space: { key: " ", code: "Space", vk: 32, text: " " },
  spacebar: { key: " ", code: "Space", vk: 32, text: " " },
  arrowup: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
  up: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
  down: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
  left: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
  right: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
  home: { key: "Home", code: "Home", vk: 36 },
  end: { key: "End", code: "End", vk: 35 },
  pageup: { key: "PageUp", code: "PageUp", vk: 33 },
  pagedown: { key: "PageDown", code: "PageDown", vk: 34 },
  insert: { key: "Insert", code: "Insert", vk: 45 },
};
for (let i = 1; i <= 12; i++) NAMED_KEYS[`f${i}`] = { key: `F${i}`, code: `F${i}`, vk: 111 + i };

const SYMBOL_KEYS = {
  "-": ["Minus", 189],
  "=": ["Equal", 187],
  "[": ["BracketLeft", 219],
  "]": ["BracketRight", 221],
  "\\": ["Backslash", 220],
  ";": ["Semicolon", 186],
  "'": ["Quote", 222],
  ",": ["Comma", 188],
  ".": ["Period", 190],
  "/": ["Slash", 191],
  "`": ["Backquote", 192],
};

/** Ctrl / Cmd + 字母 → Blink 编辑命令（CDP 派发的快捷键不会自动走原生编辑命令，必须显式带 commands） */
const EDIT_COMMANDS = { a: "selectAll", c: "copy", v: "paste", x: "cut", z: "undo", y: "redo" };

const KEY_HELP = "可用：Enter、Escape、Tab、Backspace、Delete、Space、ArrowUp/Down/Left/Right、Home、End、PageUp、PageDown、F1-F12、单个字符；组合键用 + 连接，如 Control+a、Meta+Enter、Shift+Tab";

/**
 * 解析 `"Control+a"` / `"Meta+Enter"` / `"Shift+Tab"` / `"Enter"` / `"Control++"`。
 * @returns {{ key: string, code: string, windowsVirtualKeyCode: number, modifiers: number, modifierList: string[], text?: string, commands?: string[], isModifierKey: boolean }}
 */
export const parseKeyCombo = (spec, { platform = process.platform } = {}) => {
  if (typeof spec !== "string" || spec.trim() === "") throw new BrowserError("BAD_ARGS", `key 不能为空。${KEY_HELP}`);
  const raw = spec.trim();
  let parts;
  if (raw === "+") parts = ["+"];
  else if (raw.endsWith("++")) parts = [...raw.slice(0, -2).split("+"), "+"];
  else parts = raw.split("+");
  parts = parts.map((s) => s.trim());
  if (parts.some((p) => p === "")) throw new BrowserError("BAD_ARGS", `按键格式不对：「${raw.slice(0, 30)}」。${KEY_HELP}`);

  const keyPart = parts.pop();
  const mods = new Set();
  for (const p of parts) {
    let name = MODIFIER_ALIASES[p.toLowerCase()];
    if (!name) throw new BrowserError("BAD_ARGS", `不认识的修饰键「${p.slice(0, 20)}」（可用 Control / Alt / Shift / Meta）`);
    if (name === "ControlOrMeta") name = platform === "darwin" ? "Meta" : "Control";
    mods.add(name);
  }
  const modifierList = MODIFIER_ORDER.filter((m) => mods.has(m));
  const modifiers = modifierList.reduce((acc, m) => acc | MODIFIER_BITS[m], 0);

  // 主键本身就是修饰键（"Shift"）：只按它一下
  const asMod = MODIFIER_ALIASES[keyPart.toLowerCase()];
  if (asMod && asMod !== "ControlOrMeta" && keyPart.length > 1) {
    const def = MODIFIER_KEYS[asMod];
    return {
      key: def.key,
      code: def.code,
      windowsVirtualKeyCode: def.vk,
      modifiers: modifiers | MODIFIER_BITS[asMod],
      modifierList,
      isModifierKey: true,
    };
  }

  const hasCtrlMetaAlt = mods.has("Control") || mods.has("Meta") || mods.has("Alt");
  const named = NAMED_KEYS[keyPart.toLowerCase()];
  if (named && keyPart.length > 1) {
    return {
      key: named.key,
      code: named.code,
      windowsVirtualKeyCode: named.vk,
      modifiers,
      modifierList,
      ...(named.text && !hasCtrlMetaAlt ? { text: named.text } : {}),
      isModifierKey: false,
    };
  }

  const chars = Array.from(keyPart);
  if (chars.length !== 1) throw new BrowserError("BAD_ARGS", `不认识的按键「${keyPart.slice(0, 20)}」。${KEY_HELP}`);
  let ch = chars[0];
  let code = "";
  let vk = 0;
  if (/^[a-z]$/i.test(ch)) {
    code = `Key${ch.toUpperCase()}`;
    vk = ch.toUpperCase().charCodeAt(0);
    if (mods.has("Shift")) ch = ch.toUpperCase();
  } else if (/^[0-9]$/.test(ch)) {
    code = `Digit${ch}`;
    vk = ch.charCodeAt(0);
  } else if (SYMBOL_KEYS[ch]) {
    [code, vk] = SYMBOL_KEYS[ch];
  } else if (ch === " ") {
    code = "Space";
    vk = 32;
  }
  const lower = ch.toLowerCase();
  let commands;
  if ((mods.has("Control") || mods.has("Meta")) && !mods.has("Alt") && EDIT_COMMANDS[lower]) {
    commands = [lower === "z" && mods.has("Shift") ? "redo" : EDIT_COMMANDS[lower]];
  }
  return {
    key: ch,
    code,
    windowsVirtualKeyCode: vk,
    modifiers,
    modifierList,
    ...(!hasCtrlMetaAlt ? { text: ch } : {}),
    ...(commands ? { commands } : {}),
    isModifierKey: false,
  };
};

/** 解析结果 → 要依次派发的 Input.dispatchKeyEvent 参数序列（修饰键按下 → 主键按下 / 抬起 → 修饰键反序抬起）。 */
export const keyEventSequence = (parsed) => {
  const events = [];
  let bits = 0;
  for (const m of parsed.modifierList) {
    const def = MODIFIER_KEYS[m];
    bits |= MODIFIER_BITS[m];
    events.push({ type: "rawKeyDown", key: def.key, code: def.code, windowsVirtualKeyCode: def.vk, modifiers: bits });
  }
  const base = { key: parsed.key, code: parsed.code, windowsVirtualKeyCode: parsed.windowsVirtualKeyCode, modifiers: parsed.modifiers };
  events.push({
    ...base,
    type: parsed.text ? "keyDown" : "rawKeyDown",
    ...(parsed.text ? { text: parsed.text, unmodifiedText: parsed.text } : {}),
    ...(parsed.commands ? { commands: parsed.commands } : {}),
  });
  events.push({ ...base, type: "keyUp" });
  for (const m of [...parsed.modifierList].reverse()) {
    const def = MODIFIER_KEYS[m];
    bits &= ~MODIFIER_BITS[m];
    events.push({ type: "keyUp", key: def.key, code: def.code, windowsVirtualKeyCode: def.vk, modifiers: bits });
  }
  return events;
};

/** 按键的人话描述：单个普通字符不写出来（可能是在逐字输入口令），其余写按键名。 */
export const describeKey = (parsed, raw) => {
  const plainChar = !parsed.isModifierKey && Array.from(parsed.key).length === 1 && parsed.key !== " " && parsed.modifierList.length === 0;
  return plainChar ? "一个字符键" : String(raw).trim().slice(0, 40);
};

// ───────────────────────── 纯函数：文案 ─────────────────────────

const ROLE_ZH = {
  button: "按钮",
  link: "链接",
  textbox: "文本框",
  searchbox: "搜索框",
  checkbox: "复选框",
  radio: "单选框",
  combobox: "下拉框",
  listbox: "列表框",
  menuitem: "菜单项",
  menuitemcheckbox: "菜单项",
  menuitemradio: "菜单项",
  tab: "标签",
  switch: "开关",
  option: "选项",
  slider: "滑块",
  spinbutton: "数字框",
  treeitem: "树节点",
  img: "图片",
  heading: "标题",
  cell: "单元格",
  row: "行",
};

/** `按钮「登录」`：AI 时间线 / 覆盖层的目标称呼；名字截到 30 字，空名只写角色。 */
export const labelOf = (entry) => {
  const role = ROLE_ZH[entry?.role] ?? (entry?.role ? String(entry.role) : "元素");
  const name = String(entry?.name ?? "").replace(/\s+/g, " ").trim();
  return name ? `${role}「${name.length > 30 ? `${name.slice(0, 30)}…` : name}」` : role;
};

const targetOf = (entry, ref) => ({ role: entry?.role, name: entry?.name, ref });

// ───────────────────────── CDP 小工具 ─────────────────────────

/** 在某个 ref 节点上执行函数（OOPIF 走子会话）。CDP 的「节点没了」类错误统一翻成 REF_STALE / NOT_INTERACTABLE。 */
export const callOnNode = async (tab, entry, ref, functionDeclaration, args = []) => {
  let objectId;
  try {
    const r = await tab.send("DOM.resolveNode", { backendNodeId: entry.backendNodeId }, entry.sessionId ?? null);
    objectId = r?.object?.objectId;
    if (!objectId) throw new BrowserError("REF_STALE", `ref ${ref} 对应的元素已不在页面上。请先重新调用 browser_snapshot`);
    const res = await tab.send(
      "Runtime.callFunctionOn",
      {
        objectId,
        functionDeclaration,
        arguments: args.map((value) => ({ value })),
        returnByValue: true,
        awaitPromise: false,
        silent: true,
      },
      entry.sessionId ?? null,
    );
    if (res?.exceptionDetails) {
      throw new BrowserError("INTERNAL", `在元素 ${ref} 上执行脚本出错：${String(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text ?? "").slice(0, 200)}`);
    }
    return res?.result?.value;
  } catch (err) {
    throw tab.mapNodeError(err, ref);
  } finally {
    if (objectId) tab.send("Runtime.releaseObject", { objectId }, entry.sessionId ?? null, 3000).catch(() => {});
  }
};

// 页内函数（都在元素所在 frame 的主世界里跑，`this` = 目标元素）。刻意写成 ES5 朴素语法，页面把内建弄坏也尽量能跑。

// 点击位置的遮挡检查：命中元素是目标本身 / 后代 / 祖先 / 目标的 <label> 关联控件 → 视为自己人
const OCCLUSION_FN = `function (x, y) {
  try {
    var t = this;
    if (!t || t.nodeType !== 1) return { hit: 'skip' };
    if (window.frameElement) return { hit: 'skip' };
    var root = t.getRootNode && t.getRootNode();
    var scope = root && typeof root.elementFromPoint === 'function' ? root : document;
    var el = scope.elementFromPoint(x, y);
    if (!el) return { hit: 'skip' };
    if (el === t || t.contains(el) || el.contains(t)) return { hit: 'self' };
    var lbl = el.closest ? el.closest('label') : null;
    if (lbl && lbl.control === t) return { hit: 'self' };
    var tl = t.closest ? t.closest('label') : null;
    if (tl && (tl === el || tl.contains(el))) return { hit: 'self' };
    var txt = (el.getAttribute && el.getAttribute('aria-label')) || el.innerText || el.textContent || '';
    return { hit: 'other', tag: String(el.tagName || '').toLowerCase(), text: String(txt).replace(/\\s+/g, ' ').trim().slice(0, 40) };
  } catch (e) { return { hit: 'skip' }; }
}`;

// 输入控件分类（type 用：判断能不能输入、是不是日期 / 时间这类分段控件）
const INPUT_KIND_FN = `function () {
  var el = this;
  var tag = String(el.tagName || '').toLowerCase();
  var type = String(el.type || '').toLowerCase();
  var textTypes = ['', 'text', 'search', 'url', 'tel', 'email', 'password', 'number', 'date', 'datetime-local', 'month', 'time', 'week'];
  var ro = !!(el.readOnly || el.disabled);
  if (tag === 'textarea') return { kind: 'textarea', readOnly: ro };
  if (tag === 'input') return { kind: textTypes.indexOf(type) >= 0 ? 'input' : 'noninput', type: type, readOnly: ro };
  if (el.isContentEditable) return { kind: 'editable', readOnly: false };
  return { kind: 'other', readOnly: false };
}`;

// input / textarea 清空：用原生 setter（React 受控组件才会感知）并派发 input 事件；contenteditable 全选等 Delete
const CLEAR_FN = `function () {
  var el = this;
  var tag = String(el.tagName || '').toLowerCase();
  try { el.focus(); } catch (e) {}
  if (tag === 'input' || tag === 'textarea') {
    var proto = tag === 'input' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    var desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, ''); else el.value = '';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return { kind: 'input' };
  }
  if (el.isContentEditable) {
    var sel = el.ownerDocument.getSelection();
    if (sel) sel.selectAllChildren(el);
    return { kind: 'editable' };
  }
  return { kind: 'other' };
}`;

// 日期 / 时间类 input（date / datetime-local / month / time / week）：它们是分段控件，`Input.insertText` 往里插字符不生效（真机冒烟发现 fill_form 返回 ok 但值仍为空），
// 所以改用原生 setter 写 ISO 值并派发 input + change；写完回读 `el.value`，浏览器认为非法（如 2026-13-45）会回读成空串 → 调用方报错而不是假装成功
export const TEMPORAL_INPUT_FORMATS = {
  date: { re: /^\d{4,}-\d{2}-\d{2}$/, hint: "YYYY-MM-DD，如 2026-11-09" },
  "datetime-local": { re: /^\d{4,}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?$/, hint: "YYYY-MM-DDTHH:mm，如 2026-11-09T08:30" },
  month: { re: /^\d{4,}-\d{2}$/, hint: "YYYY-MM，如 2026-11" },
  time: { re: /^\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?$/, hint: "HH:mm，如 08:30" },
  week: { re: /^\d{4,}-W\d{2}$/, hint: "YYYY-Www，如 2026-W45" },
};
const SET_TEMPORAL_FN = `function (text) {
  var el = this;
  try { el.focus(); } catch (e) {}
  var desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  if (desc && desc.set) desc.set.call(el, text); else el.value = text;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { value: String(el.value == null ? '' : el.value) };
}`;

// 不清空时把光标放到末尾（追加输入）
const CARET_END_FN = `function () {
  var el = this;
  try { el.focus(); } catch (e) {}
  try {
    if (typeof el.value === 'string' && typeof el.setSelectionRange === 'function') { var n = el.value.length; el.setSelectionRange(n, n); return true; }
  } catch (e) {}
  try {
    if (el.isContentEditable) { var s = el.ownerDocument.getSelection(); if (s) { s.selectAllChildren(el); s.collapseToEnd(); } }
  } catch (e) {}
  return true;
}`;

// <select>：按 value → 文本 → label → 忽略大小写的文本 依次匹配；找不到的值带可选项回报
const SELECT_FN = `function (values) {
  var el = this;
  if (!el || String(el.tagName || '').toLowerCase() !== 'select') return { error: 'not-select' };
  if (el.disabled) return { error: 'disabled' };
  var opts = Array.prototype.slice.call(el.options || []);
  var norm = function (s) { return String(s == null ? '' : s).replace(/\\s+/g, ' ').trim(); };
  var picks = [];
  var missing = [];
  for (var i = 0; i < values.length; i++) {
    var v = String(values[i]);
    var hit = null;
    for (var a = 0; a < opts.length && !hit; a++) if (opts[a].value === v) hit = opts[a];
    for (var b = 0; b < opts.length && !hit; b++) if (norm(opts[b].text) === norm(v)) hit = opts[b];
    for (var c = 0; c < opts.length && !hit; c++) if (norm(opts[c].label) === norm(v)) hit = opts[c];
    for (var d = 0; d < opts.length && !hit; d++) if (norm(opts[d].text).toLowerCase() === norm(v).toLowerCase()) hit = opts[d];
    if (hit && !hit.disabled) picks.push(hit); else missing.push(v);
  }
  var list = opts.map(function (o) { return { value: o.value, text: norm(o.text), disabled: !!o.disabled }; }).slice(0, 60);
  if (missing.length) return { missing: missing, options: list };
  if (!el.multiple && picks.length > 1) return { error: 'single', options: list };
  try { el.focus(); } catch (e) {}
  if (el.multiple) { opts.forEach(function (o) { o.selected = picks.indexOf(o) >= 0; }); }
  else { el.selectedIndex = opts.indexOf(picks[0]); }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { selected: picks.map(function (o) { return norm(o.text) || o.value; }) };
}`;

// 元素滚动：自己或最近的可滚动祖先 scrollBy；找不到可滚动容器返回 moved:false
const SCROLL_ELEMENT_FN = `function (dx, dy, mode) {
  var el = this;
  var scrollable = function (e) {
    var s = getComputedStyle(e);
    var oy = /(auto|scroll|overlay)/.test(s.overflowY) && e.scrollHeight > e.clientHeight + 1;
    var ox = /(auto|scroll|overlay)/.test(s.overflowX) && e.scrollWidth > e.clientWidth + 1;
    return oy || ox;
  };
  while (el && el !== document.body && el !== document.documentElement && !scrollable(el)) el = el.parentElement;
  if (!el || el === document.body || el === document.documentElement) return { moved: false };
  var before = { x: el.scrollLeft, y: el.scrollTop };
  if (mode === 'top') el.scrollTo({ top: 0, behavior: 'instant' });
  else if (mode === 'bottom') el.scrollTo({ top: el.scrollHeight, behavior: 'instant' });
  else el.scrollBy({ left: dx, top: dy, behavior: 'instant' });
  return { moved: el.scrollLeft !== before.x || el.scrollTop !== before.y, tag: String(el.tagName || '').toLowerCase() };
}`;

const SCROLL_INTO_VIEW_FN = `function () {
  try { this.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); } catch (e) { try { this.scrollIntoView(); } catch (e2) {} }
  return true;
}`;

// 无 ref 时先滚 window；window 没动（页面主滚动区是内部容器，常见于 SPA / 聊天界面）再找视口中心的可滚动祖先
const PAGE_SCROLL_EXPR = (dx, dy, mode) => `(function () {
  var dx = ${Number(dx)}, dy = ${Number(dy)}, mode = ${JSON.stringify(mode)};
  var de = document.documentElement;
  var before = { x: window.scrollX, y: window.scrollY };
  if (mode === 'top') window.scrollTo({ left: window.scrollX, top: 0, behavior: 'instant' });
  else if (mode === 'bottom') window.scrollTo({ left: window.scrollX, top: Math.max(de.scrollHeight, document.body ? document.body.scrollHeight : 0), behavior: 'instant' });
  else window.scrollBy({ left: dx, top: dy, behavior: 'instant' });
  if (window.scrollX !== before.x || window.scrollY !== before.y) return { moved: true, where: 'page' };
  var scrollable = function (e) {
    var s = getComputedStyle(e);
    var oy = /(auto|scroll|overlay)/.test(s.overflowY) && e.scrollHeight > e.clientHeight + 1;
    var ox = /(auto|scroll|overlay)/.test(s.overflowX) && e.scrollWidth > e.clientWidth + 1;
    return oy || ox;
  };
  var el = document.elementFromPoint(Math.floor(innerWidth / 2), Math.floor(innerHeight / 2));
  while (el && el !== document.body && el !== de && !scrollable(el)) el = el.parentElement;
  if (!el || el === document.body || el === de) return { moved: false, where: 'page' };
  var b = { x: el.scrollLeft, y: el.scrollTop };
  if (mode === 'top') el.scrollTo({ top: 0, behavior: 'instant' });
  else if (mode === 'bottom') el.scrollTo({ top: el.scrollHeight, behavior: 'instant' });
  else el.scrollBy({ left: dx, top: dy, behavior: 'instant' });
  return { moved: el.scrollLeft !== b.x || el.scrollTop !== b.y, where: 'container' };
})()`;

// ───────────────────────── 通用步骤 ─────────────────────────

const notInteractable = (ref, entry, reason) => {
  const what = `元素 ${ref}（${labelOf(entry)}）`;
  const tips = {
    "no-box": `${what}没有可见的布局区域（可能 display:none 或已脱离页面）。请先展开它所在的区域 / 滚动后重新 snapshot`,
    "zero-size": `${what}尺寸为 0，点不到。请换一个可见的相关元素，或先让它显示出来再重新 snapshot`,
    offscreen: `${what}在可视区域之外（可能被 overflow 容器裁掉）。请先 scroll 让它进入视野，再重新 snapshot`,
  };
  return new BrowserError("NOT_INTERACTABLE", tips[reason] ?? `${what}当前不可操作`);
};

/** 动作前的快照：动作后据此判断是否导航 / 开了新标签。 */
const beforeState = (tab) => ({ url: tab.url, navCommitted: tab.navCommitted ?? 0, navStarted: tab.navStarted ?? 0 });

const findNewTab = (session, tabSeqAtStart) => {
  if (!(session.tabSeq > tabSeqAtStart)) return null;
  return session.tabs.find((t) => t.id === `t${session.tabSeq}`) ?? null;
};

/**
 * 动作后的稳定期：给页面一个很短的缓冲；若导航已开始就等 load（上限 maxWaitMs）；
 * 若点击开了新标签，也等新标签加载一小会儿——避免 AI 立刻拿到半加载的状态。
 */
export const settle = async (session, tab, ctx, before, { maxWaitMs = 8000 } = {}) => {
  await sleep(140);
  ctx.check();
  if ((tab.navStarted ?? 0) > before.navStarted || tab.isLoading()) await tab.waitForLoad(maxWaitMs, ctx.signal);
  const newTab = findNewTab(session, ctx.tabSeqAtStart);
  if (newTab) {
    await sleep(80);
    await newTab.waitForLoad(Math.min(maxWaitMs, 5000), ctx.signal);
  }
  await sleep(80);
  ctx.check();
};

/** @returns {{ tabId: string, url: string, title: string, navigated: boolean, newTabId?: string }} */
const actionResult = (session, tab, ctx, before) => {
  const res = {
    tabId: tab.id,
    url: tab.url,
    title: tab.title,
    navigated: (tab.navCommitted ?? 0) > before.navCommitted || tab.url !== before.url,
  };
  const newTab = findNewTab(session, ctx.tabSeqAtStart);
  if (newTab) res.newTabId = newTab.id;
  return res;
};

/**
 * 定位 ref：解析 → 外层 iframe 滚入视野 → 元素滚入视野 → quad → OOPIF 偏移 → 视口 → 遮挡检查。
 * @returns {Promise<{ entry, ref, point, rect, local, label }>}
 */
export const locate = async (tab, ref, ctx, { checkOcclusion = true } = {}) => {
  await tab.ensureCdp();
  const entry = tab.resolveRef(ref);
  const sid = entry.sessionId ?? null;
  let geo;
  try {
    // 目标在 OOPIF 里时，外层 iframe 自己也要先滚进主页面视野，否则偏移换算出来在视口外
    for (const owner of entry.chain ?? []) {
      await tab.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: owner.backendNodeId }, owner.sessionId ?? null);
    }
    await tab.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: entry.backendNodeId }, sid);
    await sleep(50);
    ctx.check();
    const { quads } = await tab.send("DOM.getContentQuads", { backendNodeId: entry.backendNodeId }, sid);
    const off = await tab.frameOffset(entry.chain ?? []);
    const m = await tab.layoutMetrics();
    geo = computeTarget(quads, off, { width: m.viewportW, height: m.viewportH });
  } catch (err) {
    throw tab.mapNodeError(err, ref);
  }
  if (geo.error) throw notInteractable(ref, entry, geo.error);

  if (checkOcclusion) {
    const probe = () => callOnNode(tab, entry, ref, OCCLUSION_FN, [geo.local.x, geo.local.y]);
    let hit = await probe();
    if (hit?.hit === "other") {
      // 弹窗 / 遮罩可能正在淡出：等一拍再看一次，仍被盖住才报错
      await sleep(180);
      ctx.check();
      hit = await probe();
    }
    if (hit?.hit === "other") {
      const by = hit.text ? `「${hit.text}」（<${hit.tag}>）` : `<${hit.tag}>`;
      throw new BrowserError(
        "NOT_INTERACTABLE",
        `元素 ${ref}（${labelOf(entry)}）的点击位置被 ${by} 遮挡（可能是弹窗 / 浮层 / 固定导航栏）。请先关闭或处理遮挡物，或 scroll 让目标离开遮挡区域，再重新 snapshot`,
      );
    }
  }
  return { entry, ref, point: geo.point, rect: geo.rect, local: geo.local, label: labelOf(entry) };
};

/** 覆盖层的「点这里」反馈：失败不影响动作。 */
const showAction = async (tab, target, label, kind, ctx) => {
  // R2-08：被 takeover / cancel 打断、或因对话框竞速提前返回的动作，其 fn 仍在后台跑；此时再点亮覆盖层（光标 / 高亮），
  // 控制权早已不是 AI，没有人会再 hide，它就永久留在用户的页面上。CDP 命令按发出顺序执行，所以「发出前判一次」足够：
  // 中止发生在发出之前就不发；发生在之后，随后的 overlayHide 排在它后面，会把它收掉
  if (ctx && (ctx.signal?.aborted === true || (typeof ctx.isActive === "function" && !ctx.isActive()))) return;
  try {
    await tab.overlayShowAction({ point: target.point, rect: target.rect, label, kind });
  } catch {
    /* 覆盖层只是视觉反馈 */
  }
};

const BUTTON_BITS = { left: 1, right: 2, middle: 4 };

const mouse = (tab, params) => tab.send("Input.dispatchMouseEvent", params, null, 5000);

/**
 * 修饰键名数组 → CDP modifiers 位掩码（V1：click / mouse 的 modifiers 参数）。
 * 未知名字忽略（参数校验在 index.mjs / ops/input.mjs 的 normalize 里做，这里只管换算）。
 */
export const modifierBits = (list) => {
  if (!Array.isArray(list)) return 0;
  return list.reduce((acc, m) => acc | (MODIFIER_BITS[m] ?? 0), 0);
};

/** 修饰键的人话前缀：`["Control","Shift"]` → `Ctrl+Shift+`（固定顺序，给 AI 时间线 / 日志用） */
export const describeModifiers = (list) => {
  if (!Array.isArray(list) || list.length === 0) return "";
  const names = { Control: "Ctrl", Alt: "Alt", Shift: "Shift", Meta: "Cmd" };
  return ["Control", "Alt", "Shift", "Meta"].filter((m) => list.includes(m)).map((m) => `${names[m]}+`).join("");
};

/**
 * 点击序列：先移动到位，再按下 / 抬起 clickCount 次。
 * modifiers：CDP 位掩码，带在每个鼠标事件上（Blink 据此判断 Ctrl/Cmd+点击链接 = 新标签页、Shift+点击 = 新窗口等）。
 */
const mouseClickAt = async (tab, { x, y }, { button = "left", clickCount = 1, modifiers = 0 } = {}) => {
  const bit = BUTTON_BITS[button] ?? 1;
  await mouse(tab, { type: "mouseMoved", x, y, button: "none", buttons: 0, modifiers });
  for (let n = 1; n <= clickCount; n++) {
    await mouse(tab, { type: "mousePressed", x, y, button, buttons: bit, clickCount: n, modifiers });
    await mouse(tab, { type: "mouseReleased", x, y, button, buttons: 0, clickCount: n, modifiers });
  }
};

const dispatchKey = async (tab, parsed) => {
  for (const ev of keyEventSequence(parsed)) await tab.send("Input.dispatchKeyEvent", ev, null, 5000);
};

/**
 * 整个动作包在 AI 归因 flag 里（locate 阶段的 scrollIntoView 也会触发 scroll 事件，必须被标成 AI，否则成了「用户滚动了页面」）。
 * 内部的 withAiInput 结束时会把 flag 复位，所以输入派发完后重新置位，覆盖动作后的稳定期；最终一定在 finally 里复位。
 */
const aiScope = async (tab, fn) => {
  await tab.setAI(true);
  try {
    return await fn();
  } finally {
    await tab.setAI(false);
  }
};

// ───────────────────────── click / hover ─────────────────────────

/**
 * click 的主体（click op 与 fill_form 的 checked / submitRef 共用，不复制第二份）。
 * 必须在 runAction 的 ctx 与 aiScope 里调用。quick=true：fill_form 逐项点复选框时用，只留一个短缓冲、不等导航稳定。
 */
const clickBody = async (session, ctx, args, { quick = false } = {}) => {
  const tab = ctx.tab;
  const button = args.button ?? "left";
  const dbl = args.doubleClick === true;
  const mods = Array.isArray(args.modifiers) ? args.modifiers : [];
  const before = beforeState(tab);
  const target = await locate(tab, args.ref, ctx);
  const verb = describeModifiers(mods) + (dbl ? "双击" : button === "right" ? "右键点击" : button === "middle" ? "中键点击" : "点击");
  ctx.describe({ kind: "click", summary: `${verb}了${target.label}`, label: `${verb} ${target.label}`, target: targetOf(target.entry, args.ref) });
  await showAction(tab, target, `${verb} ${target.label}`, "click", ctx);
  ctx.check();
  await tab.withAiInput(() => mouseClickAt(tab, target.point, { button, clickCount: dbl ? 2 : 1, modifiers: modifierBits(mods) }));
  await tab.setAI(true);
  if (quick) {
    await sleep(80);
    ctx.check();
  } else {
    await settle(session, tab, ctx, before);
  }
  return actionResult(session, tab, ctx, before);
};

/** click：`{ ref, button?, doubleClick?, modifiers? }` → ActionResult（modifiers 用于 Ctrl/Cmd+点击链接 = 新标签页等） */
export const click = (session, args, { signal } = {}) =>
  session.runAction({ op: "click", tabId: args.tabId, signal }, (ctx) => aiScope(ctx.tab, () => clickBody(session, ctx, args)));

/** hover：`{ ref }` → ActionResult */
export const hover = (session, args, { signal } = {}) =>
  session.runAction({ op: "hover", tabId: args.tabId, signal }, (ctx) =>
    aiScope(ctx.tab, async () => {
      const tab = ctx.tab;
      const before = beforeState(tab);
      const target = await locate(tab, args.ref, ctx);
      ctx.describe({ kind: "click", summary: `悬停在${target.label}上`, label: `悬停 ${target.label}`, target: targetOf(target.entry, args.ref) });
      await showAction(tab, target, `悬停 ${target.label}`, "hover", ctx);
      await tab.withAiInput(async () => {
        // 先从旁边划过来，再落到目标上：mouseenter / mouseover 型菜单需要真实的移动轨迹
        await mouse(tab, { type: "mouseMoved", x: Math.max(0, target.point.x - 6), y: Math.max(0, target.point.y - 6), button: "none", buttons: 0 });
        await mouse(tab, { type: "mouseMoved", x: target.point.x, y: target.point.y, button: "none", buttons: 0 });
      });
      await tab.setAI(true);
      // 悬停菜单 / tooltip 常有一点出现动画
      await sleep(250);
      ctx.check();
      return actionResult(session, tab, ctx, before);
    }),
  );

// ───────────────────────── type ─────────────────────────

/**
 * type 的主体（type op 与 fill_form 的文本字段共用）。必须在 runAction 的 ctx 与 aiScope 里调用。
 * quick=true：fill_form 逐项填写时只留短缓冲，不做导航稳定等待（最后的 submit 点击才等）。
 */
const typeBody = async (session, ctx, args, { quick = false } = {}) => {
  const tab = ctx.tab;
  const text = String(args.text ?? "");
  const submit = args.submit === true;
  const clear = args.clear !== false;
  const count = Array.from(text).length;
  const before = beforeState(tab);
  const target = await locate(tab, args.ref, ctx, { checkOcclusion: false });
  const info = await callOnNode(tab, target.entry, args.ref, INPUT_KIND_FN);
  if (info?.kind === "noninput") {
    throw new BrowserError("BAD_ARGS", `元素 ${args.ref}（${target.label}）不是可输入文字的控件（类型 ${info.type || "未知"}）。勾选 / 按钮类请用 browser_click，选择下拉请用 browser_select`);
  }
  if (info?.readOnly) {
    throw new BrowserError("NOT_INTERACTABLE", `元素 ${args.ref}（${target.label}）是只读或已禁用状态，无法输入。请确认前置条件（如先勾选 / 解锁）后重新 snapshot`);
  }
  // 日期 / 时间类控件：只接受该类型的 ISO 文本（或空串清空）；格式不对就地报错并给示例，不去「碰运气」插字符
  const temporal = info?.kind === "input" ? TEMPORAL_INPUT_FORMATS[info.type] : undefined;
  if (temporal && text !== "" && !temporal.re.test(text)) {
    throw new BrowserError("BAD_ARGS", `元素 ${args.ref}（${target.label}）是 ${info.type} 类型的输入框，text 必须是 ${temporal.hint} 这种格式（或空串清空）`);
  }
  const summary = `在${target.label}输入了 ${count} 个字符${submit ? "并按回车提交" : ""}`;
  ctx.describe({ kind: "type", summary, label: `输入 ${count} 个字符到 ${target.label}`, target: targetOf(target.entry, args.ref) });
  await showAction(tab, target, `输入 ${count} 个字符`, "type", ctx);
  ctx.check();
  const sid = target.entry.sessionId ?? null;
  await tab.withAiInput(async () => {
    // 聚焦：DOM.focus 优先；元素不可聚焦（div 套的自定义输入框）就点一下中心
    try {
      await tab.send("DOM.focus", { backendNodeId: target.entry.backendNodeId }, sid);
    } catch {
      await mouseClickAt(tab, target.point);
    }
    if (clear) {
      const cleared = await callOnNode(tab, target.entry, args.ref, CLEAR_FN);
      if (cleared?.kind === "editable") {
        await dispatchKey(tab, parseKeyCombo("Delete"));
      }
    } else {
      await callOnNode(tab, target.entry, args.ref, CARET_END_FN);
    }
    ctx.check();
    if (temporal) {
      // 分段控件：clear 阶段已经把值清空；text 非空时用原生 setter 写入并回读校验
      if (text !== "") {
        const wrote = await callOnNode(tab, target.entry, args.ref, SET_TEMPORAL_FN, [text]);
        if (wrote?.value !== text) {
          throw new BrowserError("BAD_ARGS", `元素 ${args.ref}（${target.label}）拒绝了这个值（浏览器认为不是合法的 ${info.type}，如月份 / 日期超出范围）。请改用 ${temporal.hint} 的合法取值`);
        }
      }
    } else if (text !== "") {
      await tab.send("Input.insertText", { text }, null, 10_000);
    }
    if (submit) await dispatchKey(tab, parseKeyCombo("Enter"));
  });
  await tab.setAI(true);
  if (quick) {
    await sleep(60);
    ctx.check();
  } else {
    await settle(session, tab, ctx, before, { maxWaitMs: submit ? 8000 : 2000 });
  }
  return actionResult(session, tab, ctx, before);
};

/** type：`{ ref, text, submit?, clear? }` → ActionResult。摘要只写字符数。 */
export const type = (session, args, { signal } = {}) =>
  session.runAction({ op: "type", tabId: args.tabId, signal }, (ctx) => aiScope(ctx.tab, () => typeBody(session, ctx, args)));

// ───────────────────────── press_key ─────────────────────────

/**
 * R6-07：粘贴键的剪贴板闸门。`clipboard` 由 index.mjs 注入（Electron 的 clipboard，只用 readText；不注入 = 读不到 → 拒，fail-closed）。
 * 比较的是 SHA-256 摘要，账本里不存原文；读系统剪贴板的结果只在本函数内存在，不进日志 / 报错。
 */
export const assertAiPasteAllowed = (session, clipboard) => {
  let current;
  try {
    current = typeof clipboard?.readText === "function" ? clipboard.readText() : undefined;
  } catch {
    current = undefined;
  }
  const rejection = pasteRejection(aiWriteLedgerOf(session), current);
  if (rejection) throw new BrowserError("BAD_ARGS", rejection);
};

/** press_key：`{ key, ref? }` → ActionResult。有 ref 先聚焦该元素。`clipboard` = 注入的系统剪贴板读取（R6-07，粘贴键用）。 */
export const pressKey = (session, args, { signal, clipboard } = {}) =>
  session.runAction({ op: "press_key", tabId: args.tabId, signal }, (ctx) =>
    aiScope(ctx.tab, async () => {
      const tab = ctx.tab;
      const parsed = parseKeyCombo(args.key);
      const before = beforeState(tab);
      await tab.ensureCdp();
      let focusLabel = "";
      let entry = null;
      if (args.ref) {
        entry = tab.resolveRef(args.ref);
        focusLabel = labelOf(entry);
      }
      const keyText = describeKey(parsed, args.key);
      ctx.describe({
        kind: "key",
        summary: focusLabel ? `在${focusLabel}上按下了 ${keyText}` : `按下了 ${keyText}`,
        label: `按键 ${keyText}`,
        ...(entry ? { target: targetOf(entry, args.ref) } : {}),
      });
      await tab.withAiInput(async () => {
        if (entry) {
          try {
            await tab.send("DOM.focus", { backendNodeId: entry.backendNodeId }, entry.sessionId ?? null);
          } catch (err) {
            throw tab.mapNodeError(err, args.ref);
          }
        }
        // R6-07：粘贴键只放行「AI 本轮自己 browser_clipboard write 写入」的剪贴板；用户复制的内容不许被贴进页面再靠回显读出
        if (isPasteCombo(parsed)) assertAiPasteAllowed(session, clipboard);
        ctx.check();
        await dispatchKey(tab, parsed);
      });
      await tab.setAI(true);
      await settle(session, tab, ctx, before, { maxWaitMs: 8000 });
      return actionResult(session, tab, ctx, before);
    }),
  );

// ───────────────────────── select ─────────────────────────

/** select 的主体（select op 与 fill_form 的下拉字段共用）。必须在 runAction 的 ctx 与 aiScope 里调用。 */
const selectBody = async (session, ctx, args) => {
  const tab = ctx.tab;
  const before = beforeState(tab);
  const target = await locate(tab, args.ref, ctx, { checkOcclusion: false });
  let result;
  await tab.withAiInput(async () => {
    result = await callOnNode(tab, target.entry, args.ref, SELECT_FN, [args.values]);
  });
  if (result?.error === "not-select") {
    throw new BrowserError("BAD_ARGS", `元素 ${args.ref}（${target.label}）不是原生下拉框 <select>。自定义下拉请先 browser_click 展开，再点击具体选项`);
  }
  if (result?.error === "disabled") {
    throw new BrowserError("NOT_INTERACTABLE", `下拉框 ${args.ref}（${target.label}）已禁用，无法选择`);
  }
  if (result?.error === "single") {
    throw new BrowserError("BAD_ARGS", `下拉框 ${args.ref} 是单选，只能传 1 个值。可选项：${formatOptions(result.options)}`);
  }
  if (result?.missing) {
    throw new BrowserError(
      "BAD_ARGS",
      `下拉框 ${args.ref} 里找不到选项「${result.missing.map((v) => String(v).slice(0, 30)).join("」「")}」。可选项（value / 文本）：${formatOptions(result.options)}`,
    );
  }
  const shown = (result?.selected ?? []).map((s) => String(s).slice(0, 30)).join("、");
  ctx.describe({
    kind: "select",
    summary: `在${target.label}选择了「${shown}」`,
    label: `选择 ${shown}`,
    target: targetOf(target.entry, args.ref),
  });
  await tab.setAI(true);
  await sleep(120);
  ctx.check();
  return actionResult(session, tab, ctx, before);
};

/** select：`{ ref, values }` → ActionResult。只支持原生 <select>；值按 value / 文本 / label 匹配。 */
export const select = (session, args, { signal } = {}) =>
  session.runAction({ op: "select", tabId: args.tabId, signal }, (ctx) => aiScope(ctx.tab, () => selectBody(session, ctx, args)));

const formatOptions = (options) =>
  (options ?? [])
    .map((o) => (o.value && o.value !== o.text ? `${o.text}（value=${o.value}）` : String(o.text || o.value)))
    .join(" | ")
    .slice(0, 600);

// ───────────────────────── scroll ─────────────────────────

/**
 * E2·P5a C3 · until_stable（无限滚动辅助）：反复滚到底、等页面高度增长，连续 2 轮没增长或到步数上限就停。
 * 走 runAction（队列 / AI 归因 / 用户接管打断一致）；每次轮询 sleep 都响应 ctx.signal，并过 ctx.check()，不会无限循环。
 * 结果带 untilStable { steps, heightBefore, heightAfter, atBottom, reason: "stable" | "max_steps", elapsedMs }。
 */
const scrollUntilStable = (session, args, { signal } = {}) =>
  session.runAction({ op: "scroll", tabId: args.tabId, signal }, (ctx) =>
    aiScope(ctx.tab, async () => {
      const tab = ctx.tab;
      await tab.ensureCdp();
      const before = beforeState(tab);
      const evalExpr = async (expr) => {
        const r = await tab.send("Runtime.evaluate", { expression: expr, returnByValue: true, silent: true });
        const v = r?.result?.value;
        if (!v || typeof v.scrollHeight !== "number") throw new BrowserError("INTERNAL", "读取页面滚动高度失败（页面可能正在导航），请稍后重试");
        return v;
      };
      ctx.describe({ kind: "scroll", summary: "滚动页面直到内容不再增长", label: "滚动到底并等待加载" });
      const sleepAbortable = (ms) =>
        new Promise((resolve, reject) => {
          if (ctx.signal.aborted) return reject(ctx.signal.reason);
          const t = setTimeout(() => {
            ctx.signal.removeEventListener("abort", onAbort);
            resolve();
          }, ms);
          const onAbort = () => {
            clearTimeout(t);
            reject(ctx.signal.reason);
          };
          ctx.signal.addEventListener("abort", onAbort, { once: true });
        });
      const stable = await runUntilStable(
        {
          measure: () => evalExpr(UNTIL_STABLE_EXPR(false)),
          scrollToBottom: () => evalExpr(UNTIL_STABLE_EXPR(true)),
          sleep: sleepAbortable,
          now: () => Date.now(),
          check: () => ctx.check(),
        },
        args.untilStable,
      );
      // scroll 事件在下一帧才触发：等它发完再复位 AI flag，否则会被录制器当成用户滚动
      await sleep(160);
      ctx.check();
      const res = actionResult(session, tab, ctx, before);
      const info = await tab.scrollInfo().catch(() => ({ x: 0, y: 0, viewportW: 0, viewportH: 0, docH: 0 }));
      return { ...res, scroll: info, untilStable: stable };
    }),
  );

/** scroll：`{ ref?, direction?, amount?, scrollIntoView?, untilStable? }` → ActionResult & { scroll } */
export const scroll = (session, args, opts = {}) => (args.untilStable ? scrollUntilStable(session, args, opts) : scrollOnce(session, args, opts));

const scrollOnce = (session, args, { signal } = {}) =>
  session.runAction({ op: "scroll", tabId: args.tabId, signal }, (ctx) =>
    aiScope(ctx.tab, async () => {
      const tab = ctx.tab;
      await tab.ensureCdp();
      const before = beforeState(tab);
      let moved = true;
      let summary;
      let label;
      let target;

      if (args.ref && !args.direction) {
        // 只给 ref：把元素滚到视野中央
        const entry = tab.resolveRef(args.ref);
        for (const owner of entry.chain ?? []) {
          await tab.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: owner.backendNodeId }, owner.sessionId ?? null);
        }
        await callOnNode(tab, entry, args.ref, SCROLL_INTO_VIEW_FN);
        if (args.scrollIntoView) {
          // 显式 scroll_into_view：scrollIntoView() 对 display:none / 无布局的元素是静默空操作，必须核对它真的有布局框，
          // 否则会回报「已滚到」但其实什么都没发生；沿用 NOT_INTERACTABLE / REF_STALE 错误码
          const q = await tab.send("DOM.getContentQuads", { backendNodeId: entry.backendNodeId }, entry.sessionId ?? null).catch((err) => {
            throw tab.mapNodeError(err, args.ref);
          });
          if (!q?.quads?.length) throw notInteractable(args.ref, entry, "no-box");
        }
        summary = `滚动到${labelOf(entry)}`;
        label = `滚动到 ${labelOf(entry)}`;
        target = targetOf(entry, args.ref);
      } else {
        const m = await tab.layoutMetrics();
        const delta = computeScrollDelta({ direction: args.direction, amount: args.amount, viewportW: m.viewportW, viewportH: m.viewportH });
        const dirZh = { up: "向上", down: "向下", left: "向左", right: "向右", top: "到顶部", bottom: "到底部" }[delta.direction];
        if (args.ref) {
          const entry = tab.resolveRef(args.ref);
          const r = await callOnNode(tab, entry, args.ref, SCROLL_ELEMENT_FN, [delta.dx, delta.dy, delta.mode]);
          moved = r?.moved !== false;
          if (r?.moved === false && !r?.tag) {
            // 元素和它的祖先都不是滚动容器：退化为滚页面
            const page = await tab.send("Runtime.evaluate", { expression: PAGE_SCROLL_EXPR(delta.dx, delta.dy, delta.mode), returnByValue: true, silent: true });
            moved = page?.result?.value?.moved !== false;
          }
          summary = `滚动${labelOf(entry)}${dirZh}`;
          label = `滚动 ${dirZh}`;
          target = targetOf(entry, args.ref);
        } else {
          const page = await tab.send("Runtime.evaluate", { expression: PAGE_SCROLL_EXPR(delta.dx, delta.dy, delta.mode), returnByValue: true, silent: true });
          moved = page?.result?.value?.moved !== false;
          summary = `滚动页面${dirZh}`;
          label = `滚动页面 ${dirZh}`;
        }
      }
      ctx.describe({ kind: "scroll", summary, label, ...(target ? { target } : {}) });
      // scroll 事件在下一帧才触发：等它发完再复位 AI flag，否则会被录制器当成用户滚动
      await sleep(160);
      ctx.check();
      const res = actionResult(session, tab, ctx, before);
      const info = await tab.scrollInfo().catch(() => ({ x: 0, y: 0, viewportW: 0, viewportH: 0, docH: 0 }));
      return { ...res, scroll: info, ...(moved ? {} : { note: "没有可滚动的内容（可能已到边界）" }) };
    }),
  );

// ───────────────────────── drag ─────────────────────────

const DRAG_STEPS = 10;

/**
 * drag：`{ fromRef, toRef }` → ActionResult。
 * 普通鼠标拖拽（滑块 / 排序 / 画布）：mousePressed → 分步 mouseMoved → mouseReleased。
 * HTML5 原生拖放（draggable=true + dragstart）：打开 Input.setInterceptDrags，拿到 dragIntercepted 的数据后改用
 * Input.dispatchDragEvent 发 dragEnter / dragOver / drop。尽力而为：OOPIF 内的拖放、跨 frame 拖放不保证；拦截不可用时退回普通鼠标。
 */
export const drag = (session, args, { signal } = {}) =>
  session.runAction({ op: "drag", tabId: args.tabId, signal }, (ctx) =>
    aiScope(ctx.tab, async () => {
      const tab = ctx.tab;
      const before = beforeState(tab);
      const from = await locate(tab, args.fromRef, ctx);
      const to = await locate(tab, args.toRef, ctx, { checkOcclusion: false });
      // 目标定位可能又滚动了页面，起点坐标要重新取（fromRef 的几何会变）
      const from2 = await locate(tab, args.fromRef, ctx).catch(() => from);
      ctx.describe({
        kind: "click",
        summary: `把${from2.label}拖到${to.label}`,
        label: `拖动 ${from2.label}`,
        target: targetOf(from2.entry, args.fromRef),
      });
      await showAction(tab, from2, `拖动 ${from2.label}`, "drag", ctx);
      ctx.check();

      let dragData = null;
      const off = tab.onCdpEvent((method, params) => {
        if (method === "Input.dragIntercepted") dragData = params?.data ?? null;
      });
      let intercepting = false;
      try {
        await tab.send("Input.setInterceptDrags", { enabled: true }, null, 3000);
        intercepting = true;
      } catch {
        /* 老内核没有该命令：退回普通鼠标拖拽 */
      }
      try {
        await tab.withAiInput(async () => {
          const a = from2.point;
          const b = to.point;
          // R1-28：mousePressed 发出后，只要中途出错 / 被取消（ctx.check 抛 CANCELLED / USER_TOOK_OVER 等），
          // 就必须补发 mouseReleased（HTML5 拖放进行中再补一个 dragCancel），否则页面卡在「左键按下」态、后续点击全部错乱。
          let held = false;
          let dndStarted = false;
          let last = a;
          try {
            await mouse(tab, { type: "mouseMoved", x: a.x, y: a.y, button: "none", buttons: 0 });
            // R2-08：先置位再发——mousePressed 超时但页面其实已经处理了的话，finally 里也要补 release（对没按下的键发 release 无害）
            held = true;
            await mouse(tab, { type: "mousePressed", x: a.x, y: a.y, button: "left", buttons: 1, clickCount: 1 });
            for (let i = 1; i <= DRAG_STEPS; i++) {
              ctx.check();
              const x = a.x + ((b.x - a.x) * i) / DRAG_STEPS;
              const y = a.y + ((b.y - a.y) * i) / DRAG_STEPS;
              last = { x, y };
              await mouse(tab, { type: "mouseMoved", x, y, button: "left", buttons: 1 });
              await sleep(i === 1 ? 60 : 20);
              if (dragData) {
                // 页面发起了 HTML5 拖放：后续移动改走 dispatchDragEvent
                // R2-08：dragEnter 失败（超时但页面已处理）也要走 dragCancel，所以先置位再发
                const enterType = dndStarted ? "dragOver" : "dragEnter";
                dndStarted = true;
                await tab.send("Input.dispatchDragEvent", { type: enterType, x, y, data: dragData }, null, 5000);
              }
            }
            last = b;
            if (dragData) {
              await tab.send("Input.dispatchDragEvent", { type: "dragOver", x: b.x, y: b.y, data: dragData }, null, 5000);
              await tab.send("Input.dispatchDragEvent", { type: "drop", x: b.x, y: b.y, data: dragData }, null, 5000);
              dndStarted = false;
              // 拖放期间鼠标状态由浏览器接管，仍补一个 release 让页面的 mouseup 逻辑收尾（失败无妨）
              held = false;
              await mouse(tab, { type: "mouseReleased", x: b.x, y: b.y, button: "left", buttons: 0, clickCount: 1 }).catch(() => {});
            } else {
              await mouse(tab, { type: "mouseReleased", x: b.x, y: b.y, button: "left", buttons: 0, clickCount: 1 });
              held = false;
            }
          } finally {
            if (dndStarted) {
              await tab.send("Input.dispatchDragEvent", { type: "dragCancel", x: last.x, y: last.y, data: dragData }, null, 3000).catch(() => {});
            }
            if (held) {
              await mouse(tab, { type: "mouseReleased", x: last.x, y: last.y, button: "left", buttons: 0, clickCount: 1 }).catch(() => {});
            }
          }
        });
      } finally {
        off();
        if (intercepting) await tab.send("Input.setInterceptDrags", { enabled: false }, null, 3000).catch(() => {});
      }
      await tab.setAI(true);
      await settle(session, tab, ctx, before, { maxWaitMs: 4000 });
      return actionResult(session, tab, ctx, before);
    }),
  );

// ───────────────────────── V1：给 ops/input.mjs 复用的内部件 ─────────────────────────

// 读复选 / 单选 / 开关的当前选中状态（fill_form 的 checked 字段：状态不同才点，避免把已勾的勾掉）
const CHECKED_STATE_FN = `function () {
  var el = this;
  var tag = String(el.tagName || '').toLowerCase();
  var type = String(el.type || '').toLowerCase();
  if (tag === 'input' && (type === 'checkbox' || type === 'radio')) return { kind: type, checked: !!el.checked, disabled: !!el.disabled };
  var role = el.getAttribute ? String(el.getAttribute('role') || '') : '';
  var aria = el.getAttribute ? el.getAttribute('aria-checked') : null;
  if ((role === 'checkbox' || role === 'radio' || role === 'switch' || role === 'menuitemcheckbox' || role === 'menuitemradio') && (aria === 'true' || aria === 'false')) {
    return { kind: role === 'radio' || role === 'menuitemradio' ? 'radio' : 'checkbox', checked: aria === 'true', disabled: el.getAttribute('aria-disabled') === 'true' };
  }
  return { kind: 'other' };
}`;

/**
 * mouse / fill_form 在 ops/input.mjs 里实现，但必须与 click / type / select 共用同一套「定位 → 归因 → 稳定期」内核，
 * 所以把内部件集中导出而不是复制一份。仅限 V1 的 ops/input.mjs 使用，别的切片不要依赖这个对象。
 */
export const v1Internals = Object.freeze({
  aiScope,
  beforeState,
  actionResult,
  showAction,
  mouse,
  mouseClickAt,
  settle,
  callOnNode,
  labelOf,
  targetOf,
  clickBody,
  typeBody,
  selectBody,
  INPUT_KIND_FN,
  CHECKED_STATE_FN,
});
