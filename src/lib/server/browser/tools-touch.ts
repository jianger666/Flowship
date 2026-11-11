/**
 * 增强包 E2 · C2 browser_touch（server 工具定义）：tap / long_press / swipe / pinch 触屏手势。
 * 主进程实现在 electron-app/browser/ops/touch.mjs，纯逻辑在 electron-app/browser/touch-kit.mjs（server 先拦一道参数，主进程独立再校验）。
 *
 * 这个工具**没有文本入参**，不产生字符输入（文字输入走 browser_type / browser_fill_form；2026-11-11 起写入侧对密码框已不再拒绝）。
 * 积木从 `kit` 取（见 tools.ts 的 buildToolKit）；不要 import "./tools"（成环），类型用 `import type`。
 */
import { Enum as TBEnum, Number as TBNumber, Object as TBObject, Optional as TBOptional } from "typebox/type";
import type { FlowshipToolDef } from "../flowship-tools";
import type { BrowserToolKit } from "./tools";

export const TOUCH_TOOL_ACTIONS = ["tap", "long_press", "swipe", "pinch"] as const;
export const TOUCH_SWIPE_DIRECTIONS = ["up", "down", "left", "right"] as const;
type TouchAction = (typeof TOUCH_TOOL_ACTIONS)[number];

/** 与主进程 touch-kit.mjs 的 TOUCH_LIMITS 同口径 */
export const TOUCH_TOOL_LIMITS = {
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
} as const;

type ErrCtor = new (message: string) => Error;

export interface TouchOpArgs {
  action: TouchAction;
  ref?: string;
  x?: number;
  y?: number;
  durationMs?: number;
  toX?: number;
  toY?: number;
  direction?: (typeof TOUCH_SWIPE_DIRECTIONS)[number];
  distance?: number;
  scale?: number;
}

const num = (v: unknown): number | undefined => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
};
const given = (v: unknown): boolean => v !== undefined && v !== null && v !== "";

/**
 * browser_touch 的参数解析（纯函数；错误类型由调用方注入，tools.ts 的 BadArgs 会渲染成「参数有误：…」）。
 * 互斥 / 范围规则与主进程 normalizeTouchArgs 一致；默认值交给主进程补（这里只传给了的项）。
 * @param ref 已校验过的 ref（调用方用 optRef）
 */
export const parseTouchArgs = (args: Record<string, unknown>, ref: string | undefined, Bad: ErrCtor): TouchOpArgs => {
  const bad = (m: string): never => {
    throw new Bad(m);
  };
  const L = TOUCH_TOOL_LIMITS;
  const rawAction = typeof args.action === "string" ? args.action.trim() : "";
  if (!(TOUCH_TOOL_ACTIONS as readonly string[]).includes(rawAction)) {
    bad(`action 只能是 ${TOUCH_TOOL_ACTIONS.join(" / ")}，收到的是「${rawAction.slice(0, 20)}」`);
  }
  const action = rawAction as TouchAction;
  const hasX = given(args.x);
  const hasY = given(args.y);
  if (ref && (hasX || hasY)) bad("ref 与 x / y 互斥：要么用 ref（元素中心），要么用 x + y（视口 CSS 像素），请二选一");
  if (!ref && hasX !== hasY) bad("x 与 y 必须同时给出（视口 CSS 像素，原点在视口左上角）");
  if (!ref && !hasX) bad("缺少目标：请给 ref（来自最近一次 browser_snapshot），或同时给 x 与 y（视口 CSS 像素）");

  const out: TouchOpArgs = { action };
  const coord = (key: string, v: unknown): number => {
    const n = num(v);
    if (n === undefined) return bad(`${key} 必须是数字`);
    if (n < 0) return bad(`${key} 不能为负，原点是视口左上角`);
    return n;
  };
  if (ref) out.ref = ref;
  else {
    out.x = coord("x", args.x);
    out.y = coord("y", args.y);
  }
  const ranged = (key: string, v: unknown, min: number, max: number): number | undefined => {
    if (!given(v)) return undefined;
    const n = num(v);
    if (n === undefined) return bad(`${key} 必须是数字`);
    if (n < min || n > max) return bad(`${key} 必须在 ${min}–${max} 之间，收到 ${n}`);
    return n;
  };

  const duration = args.duration_ms;
  if (action === "long_press") {
    const d = ranged("duration_ms", duration, L.longPressMinMs, L.maxDurationMs);
    if (d !== undefined) out.durationMs = Math.round(d);
  } else if (action === "swipe") {
    const hasTo = given(args.to_x) || given(args.to_y);
    const direction = typeof args.direction === "string" && args.direction.trim() !== "" ? args.direction.trim() : undefined;
    if (direction !== undefined && !(TOUCH_SWIPE_DIRECTIONS as readonly string[]).includes(direction)) {
      bad(`direction 只能是 ${TOUCH_SWIPE_DIRECTIONS.join(" / ")}，收到的是「${direction.slice(0, 20)}」`);
    }
    if (hasTo && direction) bad("swipe 的终点二选一：to_x + to_y，或 direction（+ distance），不能同时给");
    if (!hasTo && !direction) bad("swipe 需要终点：to_x + to_y（视口 CSS 像素），或 direction（up / down / left / right）+ 可选 distance");
    if (hasTo) {
      if (!given(args.to_x) || !given(args.to_y)) bad("to_x 与 to_y 必须同时给出");
      if (given(args.distance)) bad("distance 只能与 direction 一起用，给了 to_x / to_y 就不需要它");
      out.toX = coord("to_x", args.to_x);
      out.toY = coord("to_y", args.to_y);
    } else {
      out.direction = direction as TouchOpArgs["direction"];
      const dist = ranged("distance", args.distance, 1, L.maxSwipeDistance);
      if (dist !== undefined) out.distance = dist;
    }
    const d = ranged("duration_ms", duration, L.minDurationMs, L.maxDurationMs);
    if (d !== undefined) out.durationMs = Math.round(d);
  } else if (action === "pinch") {
    if (!given(args.scale)) bad(`pinch 需要 scale（${L.minScale}–${L.maxScale}；>1 放大 / 两指张开，<1 缩小 / 两指捏合）`);
    out.scale = ranged("scale", args.scale, L.minScale, L.maxScale);
    const d = ranged("duration_ms", duration, L.minDurationMs, L.maxDurationMs);
    if (d !== undefined) out.durationMs = Math.round(d);
  }
  return out;
};

interface TouchResult {
  tabId?: string;
  url?: string;
  title?: string;
  navigated?: boolean;
  newTabId?: string;
  gesture?: {
    action?: string;
    from?: { x: number; y: number };
    to?: { x: number; y: number };
    distance?: number;
    durationMs?: number;
    scale?: number;
    events?: number;
  };
}

/** 工具结果里「触屏手势」的一句话（只含手势类型与坐标 / 数值，没有页面文字） */
export const describeTouchDone = (action: TouchAction, g: TouchResult["gesture"], viaRef: boolean): string => {
  const at = g?.from ? `(${g.from.x}, ${g.from.y})` : "";
  const where = viaRef ? `元素中心 ${at}` : at;
  switch (action) {
    case "tap":
      return `已轻触 ${where}`;
    case "long_press":
      return `已长按 ${where} ${g?.durationMs ?? ""}ms`;
    case "swipe":
      return `已从 ${where} 滑到 (${g?.to?.x ?? "?"}, ${g?.to?.y ?? "?"})（${g?.distance ?? "?"}px，${g?.durationMs ?? "?"}ms）`;
    default:
      return `已在 ${where} 做双指${(g?.scale ?? 1) >= 1 ? "放大" : "缩小"}（×${g?.scale ?? "?"}，${g?.durationMs ?? "?"}ms）`;
  }
};

export const createTouchTools = (kit: BrowserToolKit): FlowshipToolDef[] => {
  const { run, guarded, BadArgs, optRef, renderAction, REF_SCHEMA } = kit;
  return [
    {
      name: "browser_touch",
      label: "浏览器·触屏手势",
      description:
        "触屏手势 tap / long_press / swipe / pinch（双指缩放）：目标用 ref（元素中心）或视口坐标 x、y；移动端页面 / 手势交互用它，普通点击仍用 browser_click。动作期间自动开触屏模拟、结束恢复，不会输入文字。",
      parameters: TBObject({
        action: TBEnum([...TOUCH_TOOL_ACTIONS]),
        ref: TBOptional(REF_SCHEMA),
        x: TBOptional(TBNumber({ description: "视口 CSS 像素，与 y 成对；swipe / pinch 为起点 / 中心" })),
        y: TBOptional(TBNumber()),
        duration_ms: TBOptional(TBNumber({ description: "long_press 默认 600（100-3000）；swipe 默认 300、pinch 默认 400（50-3000）" })),
        to_x: TBOptional(TBNumber({ description: "swipe 终点 x，与 to_y 成对（或改用 direction）" })),
        to_y: TBOptional(TBNumber()),
        direction: TBOptional(TBEnum([...TOUCH_SWIPE_DIRECTIONS], { description: "swipe 手指移动方向（up = 手指上划 = 内容下滚）" })),
        distance: TBOptional(TBNumber({ description: "swipe 配 direction 用，默认 300（1-4000），到视口边缘截止" })),
        scale: TBOptional(TBNumber({ description: "pinch 缩放倍数 0.2-5；>1 放大（两指张开），<1 缩小" })),
      }),
      handler: guarded(async (args, ctx) => {
        const ref = optRef(args, "ref");
        const p = parseTouchArgs(args, ref, BadArgs);
        return run<TouchResult>(ctx, {
          op: "touch",
          args: p as unknown as Record<string, unknown>,
          render: (r, b) => renderAction(describeTouchDone(p.action, r?.gesture, Boolean(p.ref)))(r, b),
        });
      }),
    },
  ];
};
