/**
 * 增强包 E2 · C2 触屏手势的纯逻辑（参数规整 / 手势事件序列规划 / 带「失败必取消」保证的执行器）。
 *
 * 与 electron 零耦合：`ops/touch.mjs` 负责 locate / runAction / 触屏模拟开关，这里只管
 *   - `normalizeTouchArgs`：tap / long_press / swipe / pinch 的参数校验（BAD_ARGS 文案让模型能自修复）；
 *   - `planGesture`：手势 → `Input.dispatchTouchEvent` 事件序列（touchStart → touchMove* → touchEnd；pinch 两个触点 id 0 / 1）；
 *   - `runGesture`：按序列派发，**任何一步失败 / 被取消（接管、signal）都补发 touchCancel**，页面不会卡在「手指还按着」的状态。
 * 做成纯函数（sleep / send / check 全部注入）是为了能用假 CDP 断言事件序列与失败路径，而不必起 Electron。
 */
import { BrowserError } from "./server-channel.mjs";

export const TOUCH_ACTIONS = Object.freeze(["tap", "long_press", "swipe", "pinch"]);
export const SWIPE_DIRECTIONS = Object.freeze(["up", "down", "left", "right"]);

/** 时长 / 距离 / 缩放上限（server 与主进程两处都校验；这里是主进程的独立校验） */
export const TOUCH_LIMITS = Object.freeze({
  longPressDefaultMs: 600,
  longPressMinMs: 100,
  swipeDefaultMs: 300,
  pinchDefaultMs: 400,
  minDurationMs: 50,
  maxDurationMs: 3000,
  swipeDefaultDistance: 300,
  maxSwipeDistance: 4000,
  minScale: 0.2,
  maxScale: 5,
});

/** pinch 默认的两指半间距（CSS 像素）：Chromium 的缩放识别需要两指有足够的起始间距 */
const PINCH_BASE_HALF = 60;

const num = (h, args, key, { min, max, dflt, integer = false } = {}) => {
  const v = args[key];
  if (v === undefined || v === null) return dflt;
  if (typeof v !== "number" || !Number.isFinite(v)) throw h.bad(`参数 ${key} 必须是有限数字`);
  if (v < min || v > max) throw h.bad(`参数 ${key} 必须在 ${min}–${max} 之间，收到 ${v}`);
  return integer ? Math.round(v) : v;
};

/**
 * touch 参数规整（纯函数）。只放行白名单字段——这个工具**没有任何文本入参**，不产生字符输入。
 * 目标二选一：`ref`（元素中心）或 `x`+`y`（视口 CSS 像素）。
 * @returns {{ action: string, ref?: string, x?: number, y?: number, durationMs: number, toX?: number, toY?: number, direction?: string, distance?: number, scale?: number, tabId?: string }}
 */
export const normalizeTouchArgs = (args, h) => {
  const action = h.reqEnum(args, "action", TOUCH_ACTIONS);
  const refRaw = h.optStr(args, "ref", 20);
  const ref = refRaw ? refRaw.trim() : undefined;
  const hasX = args.x !== undefined && args.x !== null;
  const hasY = args.y !== undefined && args.y !== null;
  if (ref && (hasX || hasY)) throw h.bad("ref 与 x / y 互斥：要么用 ref（元素中心），要么用 x + y（视口 CSS 像素），请二选一");
  if (!ref && hasX !== hasY) throw h.bad("x 与 y 必须同时给出（视口 CSS 像素，原点在视口左上角）");
  if (!ref && !hasX) throw h.bad("缺少目标：请给 ref（来自最近一次 browser_snapshot），或同时给 x 与 y（视口 CSS 像素）");
  const out = { action };
  if (ref) out.ref = ref;
  else {
    const x = num(h, args, "x", { min: 0, max: 100_000 });
    const y = num(h, args, "y", { min: 0, max: 100_000 });
    out.x = x;
    out.y = y;
  }

  const L = TOUCH_LIMITS;
  switch (action) {
    case "tap":
      out.durationMs = 0;
      break;
    case "long_press":
      out.durationMs = num(h, args, "durationMs", { min: L.longPressMinMs, max: L.maxDurationMs, dflt: L.longPressDefaultMs, integer: true });
      break;
    case "swipe": {
      const hasTo = (args.toX !== undefined && args.toX !== null) || (args.toY !== undefined && args.toY !== null);
      const direction = h.optEnum(args, "direction", SWIPE_DIRECTIONS, undefined);
      if (hasTo && direction) throw h.bad("swipe 的终点二选一：to_x + to_y，或 direction（+ distance），不能同时给");
      if (!hasTo && !direction) throw h.bad("swipe 需要终点：to_x + to_y（视口 CSS 像素），或 direction（up / down / left / right）+ 可选 distance");
      if (hasTo) {
        if (args.toX === undefined || args.toX === null || args.toY === undefined || args.toY === null) throw h.bad("to_x 与 to_y 必须同时给出");
        if (args.distance !== undefined && args.distance !== null) throw h.bad("distance 只能与 direction 一起用，给了 to_x / to_y 就不需要它");
        out.toX = num(h, args, "toX", { min: 0, max: 100_000 });
        out.toY = num(h, args, "toY", { min: 0, max: 100_000 });
      } else {
        out.direction = direction;
        out.distance = num(h, args, "distance", { min: 1, max: L.maxSwipeDistance, dflt: L.swipeDefaultDistance });
      }
      out.durationMs = num(h, args, "durationMs", { min: L.minDurationMs, max: L.maxDurationMs, dflt: L.swipeDefaultMs, integer: true });
      break;
    }
    default: {
      // pinch
      if (args.scale === undefined || args.scale === null) throw h.bad(`pinch 需要 scale（${L.minScale}–${L.maxScale}；>1 放大 / 两指张开，<1 缩小 / 两指捏合）`);
      out.scale = num(h, args, "scale", { min: L.minScale, max: L.maxScale });
      out.durationMs = num(h, args, "durationMs", { min: L.minDurationMs, max: L.maxDurationMs, dflt: L.pinchDefaultMs, integer: true });
      break;
    }
  }
  const tabId = h.optStr(args, "tabId", 20);
  return tabId ? { ...out, tabId } : out;
};

/** 方向 → 单位向量（屏幕坐标：y 向下）。注意是「手指移动方向」：swipe up = 手指向上划 = 页面内容向下滚。 */
const DIR_VECTOR = Object.freeze({ up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] });

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round2 = (n) => Math.round(n * 100) / 100;

/**
 * swipe 终点：给了 to_x / to_y 就用它（必须在视口内，否则 BAD_ARGS——显式坐标越界是模型算错了，静默钳制会掩盖）；
 * 给了 direction + distance 就从起点沿方向走，**超出视口的部分钳制到视口边缘**（「往下划 300」在页面底部附近不该报错，只是划不满）。
 * @returns {{ x: number, y: number, distance: number }}
 */
export const swipeEnd = (start, a, viewport) => {
  const w = Number(viewport?.width) || 0;
  const hgt = Number(viewport?.height) || 0;
  let x;
  let y;
  if (a.toX !== undefined) {
    x = a.toX;
    y = a.toY;
    if (w > 0 && hgt > 0 && (x >= w || y >= hgt)) {
      throw new BrowserError("BAD_ARGS", `swipe 终点 (${Math.round(x)}, ${Math.round(y)}) 超出视口：视口是 ${w}×${hgt} CSS 像素（x 取 0–${w - 1}，y 取 0–${hgt - 1}）`);
    }
  } else {
    const [dx, dy] = DIR_VECTOR[a.direction];
    x = start.x + dx * a.distance;
    y = start.y + dy * a.distance;
    if (w > 0 && hgt > 0) {
      x = clamp(x, 0, w - 1);
      y = clamp(y, 0, hgt - 1);
    }
  }
  const distance = Math.hypot(x - start.x, y - start.y);
  if (distance < 1) {
    throw new BrowserError("BAD_ARGS", "swipe 的起点与终点重合（起点可能已贴着视口边缘、无法沿该方向再移动）。请换一个起点 / 方向，或用 tap");
  }
  return { x: round2(x), y: round2(y), distance: round2(distance) };
};

/**
 * pinch 的两指轨迹：水平对称，围绕中心 (cx, cy)。起始半间距 = 60（scale<1 与 >1 都从 60 起）、结束半间距 = 60 × scale，
 * 为避免手指出视口，整体按比例收缩到「较大半间距 ≤ 中心到左右边缘的最小距离」——收缩是等比的，实际缩放倍数仍等于 scale。
 * @returns {{ startHalf: number, endHalf: number }}
 */
export const planPinchSpan = ({ cx, scale, viewport }) => {
  const w = Number(viewport?.width) || 0;
  let startHalf = PINCH_BASE_HALF;
  let endHalf = PINCH_BASE_HALF * scale;
  if (w > 0) {
    const room = Math.min(cx, w - 1 - cx);
    const larger = Math.max(startHalf, endHalf);
    if (room < 8) {
      throw new BrowserError("BAD_ARGS", `pinch 的中心 x=${Math.round(cx)} 太靠近视口左右边缘（需要至少 8 像素余量放两根手指），请把中心移向页面中间`);
    }
    if (larger > room) {
      const f = room / larger;
      startHalf *= f;
      endHalf *= f;
    }
  }
  return { startHalf: round2(startHalf), endHalf: round2(endHalf) };
};

const pt = (x, y, id = 0) => ({ x: round2(x), y: round2(y), id });
const MOVE_STEP_MS = 16;
const MAX_MOVE_STEPS = 40;
const MIN_MOVE_STEPS = 4;

/**
 * 手势 → 事件序列 `[{ type, touchPoints, delayMs }]`；`delayMs` = 发完这一步后等多久（长按的「按住」就是这里的延时）。
 * 序列一定以 touchStart 开头、touchEnd（touchPoints 为空 = 抬起所有触点）结尾；pinch 的 touchStart / touchMove 带 id 0 与 1 两个触点。
 * @param {{ action: string, durationMs: number, scale?: number }} a  规整后的参数
 * @param {{ x: number, y: number }} from  起点 / 中心（视口 CSS 像素）
 * @param {{ to?: { x: number, y: number }, viewport?: { width: number, height: number } }} [extra]  swipe 终点（swipeEnd 的结果）/ 视口
 */
export const planGesture = (a, from, extra = {}) => {
  const steps = [];
  const stepsFor = (ms) => clamp(Math.round(ms / MOVE_STEP_MS), MIN_MOVE_STEPS, MAX_MOVE_STEPS);
  switch (a.action) {
    case "tap":
      steps.push({ type: "touchStart", touchPoints: [pt(from.x, from.y)], delayMs: 50 });
      steps.push({ type: "touchEnd", touchPoints: [], delayMs: 0 });
      return steps;
    case "long_press":
      steps.push({ type: "touchStart", touchPoints: [pt(from.x, from.y)], delayMs: a.durationMs });
      steps.push({ type: "touchEnd", touchPoints: [], delayMs: 0 });
      return steps;
    case "swipe": {
      const to = extra.to;
      if (!to) throw new BrowserError("INTERNAL", "swipe 缺少终点");
      const n = stepsFor(a.durationMs);
      const each = Math.max(1, Math.round(a.durationMs / n));
      steps.push({ type: "touchStart", touchPoints: [pt(from.x, from.y)], delayMs: each });
      for (let i = 1; i <= n; i++) {
        const t = i / n;
        steps.push({ type: "touchMove", touchPoints: [pt(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t)], delayMs: i === n ? 30 : each });
      }
      steps.push({ type: "touchEnd", touchPoints: [], delayMs: 0 });
      return steps;
    }
    default: {
      // pinch：左指 id 0、右指 id 1，围绕 from 水平对称
      const { startHalf, endHalf } = planPinchSpan({ cx: from.x, scale: a.scale, viewport: extra.viewport });
      const n = stepsFor(a.durationMs);
      const each = Math.max(1, Math.round(a.durationMs / n));
      const two = (half) => [pt(from.x - half, from.y, 0), pt(from.x + half, from.y, 1)];
      steps.push({ type: "touchStart", touchPoints: two(startHalf), delayMs: each });
      for (let i = 1; i <= n; i++) {
        const t = i / n;
        steps.push({ type: "touchMove", touchPoints: two(startHalf + (endHalf - startHalf) * t), delayMs: i === n ? 30 : each });
      }
      steps.push({ type: "touchEnd", touchPoints: [], delayMs: 0 });
      return steps;
    }
  }
};

/**
 * 按序列派发事件。**保证**：一旦 touchStart 发出，只要后面任何一步抛错 / 被取消，finally 里补发一次 touchCancel（失败也吞掉），
 * 页面不会留下「手指一直按着」的幽灵触点。长延时（长按）按 ≤120ms 分片 sleep 并在每片前 `check()`，接管 / signal 能在 ~100ms 内打断。
 *
 * @param {{ send: (params: object) => Promise<unknown>, sleep: (ms: number) => Promise<void>, check?: () => void }} io
 * @param {Array<{ type: string, touchPoints: object[], delayMs: number }>} steps
 * @returns {Promise<{ events: number }>}
 */
export const runGesture = async (io, steps) => {
  const check = io.check ?? (() => {});
  let started = false;
  let ended = false;
  let events = 0;
  try {
    for (const step of steps) {
      check();
      // 先置位再发：touchStart 超时但页面其实已处理时，也要走 cancel 收尾
      if (step.type === "touchStart") started = true;
      await io.send({ type: step.type, touchPoints: step.touchPoints });
      events++;
      if (step.type === "touchEnd") ended = true;
      let left = step.delayMs;
      while (left > 0) {
        const slice = Math.min(120, left);
        await io.sleep(slice);
        left -= slice;
        if (left > 0) check();
      }
    }
    return { events };
  } finally {
    if (started && !ended) {
      try {
        await io.send({ type: "touchCancel", touchPoints: [] });
      } catch {
        /* 收尾失败只能算了：状态已按「没有活动触点」处理 */
      }
    }
  }
};

/** 触屏当前是否已开：显式 touch 优先，否则跟随 mobile（与 emulation.mjs 的 viewport 方面同一规则） */
export const touchAlreadyEmulated = (emulation) => {
  const e = emulation && typeof emulation === "object" ? emulation : {};
  return typeof e.touch === "boolean" ? e.touch : e.mobile === true;
};

/**
 * 动作期间临时开触屏模拟，结束（含失败路径）恢复原状。已开着就什么都不动（不会误关用户 / AI 设的模拟）。
 * @param {{ send: (method: string, params: object) => Promise<unknown>, emulation: object, log?: (msg: string) => void }} tab
 */
export const withTouchEmulation = async (tab, fn) => {
  const already = touchAlreadyEmulated(tab.emulation);
  if (!already) await tab.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  try {
    return await fn();
  } finally {
    // 恢复要看「此刻」的状态：fn 期间若有人把 touch 模拟设成了开（emulate touch:true），就不能关
    if (!already && !touchAlreadyEmulated(tab.emulation)) {
      try {
        await tab.send("Emulation.setTouchEmulationEnabled", { enabled: false });
      } catch (err) {
        tab.log?.(`[browser] 恢复触屏模拟失败（已忽略）：${err?.message || err}`);
      }
    }
  }
};

/** 活动日志 / 覆盖层的一句话；只含手势类型与坐标 / 数值，不含页面文字（ref 目标的名字由调用方拼 label） */
export const describeTouch = (a, at) => {
  const p = at ? `(${Math.round(at.x)}, ${Math.round(at.y)})` : "";
  switch (a.action) {
    case "tap":
      return { verb: "轻触", detail: p };
    case "long_press":
      return { verb: "长按", detail: `${p}，${a.durationMs}ms` };
    case "swipe":
      return { verb: "滑动", detail: a.direction ? `${p}向${{ up: "上", down: "下", left: "左", right: "右" }[a.direction]}` : p };
    default:
      return { verb: a.scale >= 1 ? "双指放大" : "双指缩小", detail: `${p}，×${a.scale}` };
  }
};
