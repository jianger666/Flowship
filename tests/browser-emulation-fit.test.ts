/**
 * 设备模拟下的视图适配（契约 §14.4「设备模拟下的视图适配」）：
 *  - A（视图比模拟视口大）：视图收窄、水平居中、顶部对齐，不留白板；
 *  - B（视图比模拟视口小）：整体缩小适应（CDP scale + dontSetVisibleSize），不再裁切；
 *    AI 的输入坐标（鼠标 / 触屏 / 拖放）在 Tab.send 这唯一出口乘 scale 补偿，AI 看到的视口 / 截图 / 几何不变；
 *  - BrowserTab：槽位与视图矩形分开记；换设备 / 改尺寸 / reset / 拖面板 / 失败回滚 / 重放 / 停车场往返，视图与缩放都跟着变；
 *  - 渲染端：viewFitCssOf（遮盖占位图的百分比定位）、fitScaleLabelOf、store 的 sameTab 比 viewFit / fitScale。
 *
 * 「scale 下页面真的恰好铺满视图、用户点击被 Chromium 正确反向映射、AI 补偿后点击命中、截图 / clip / 几何不变」
 * 这些只有真 Chromium 才能证明，见 scripts/browser-e2e/r10-emulation-fit.cjs。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

import {
  INPUT_COORD_METHODS,
  INPUT_PLAIN_METHODS,
  MIN_FIT_SCALE,
  fitBoundsToEmulation,
  fitScaleFor,
  fitViewportOf,
  mergeEmulation,
  sameViewFit,
  scaleInputParams,
  viewportMetricsCommand,
  withFitScale,
} from "../electron-app/browser/emulation.mjs";
import { createActivityLog } from "../electron-app/browser/activity-log.mjs";
import { BrowserSession } from "../electron-app/browser/session.mjs";
import { BrowserTab, PARKING_BOUNDS } from "../electron-app/browser/tab.mjs";
import { createBrowserStore } from "@/components/browser/browser-state-store";
import { fitScaleLabelOf, fitScalePercentOf, viewFitCssOf } from "@/components/browser/browser-user-logic";
import type { BrowserState, TabInfo } from "@/lib/browser-bridge-types";

import { blockAfter, maskLiterals, readSource, stripComments } from "./helpers/source-text";

const root = resolve(__dirname, "..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8");

type Rect = { x: number; y: number; width: number; height: number };
const SLOT: Rect = { x: 100, y: 50, width: 1700, height: 700 };

describe("fitBoundsToEmulation（纯函数，A：视图比模拟视口大）", () => {
  it("模拟视口比槽位窄：水平居中、顶部对齐、整数；fit 是占槽位的比例", () => {
    const r = fitBoundsToEmulation({ x: 100, y: 50, width: 1700, height: 1000 }, { width: 1440, height: 900 });
    expect(r.bounds).toEqual({ x: 230, y: 50, width: 1440, height: 900 });
    expect(r.fit).toEqual({ left: 130 / 1700, top: 0, width: 1440 / 1700, height: 0.9 });
  });

  it("手机预设放进宽面板：393 宽居中；模拟高度比槽位高、又没有缩放时占满槽位高度", () => {
    const r = fitBoundsToEmulation({ x: 0, y: 0, width: 1000, height: 600 }, { width: 393, height: 852 });
    expect(r.bounds).toEqual({ x: 303, y: 0, width: 393, height: 600 });
    expect(r.fit?.height).toBe(1);
  });

  it("模拟高度比槽位矮：顶部对齐，下面留空（不垂直居中）", () => {
    const r = fitBoundsToEmulation({ x: 10, y: 20, width: 400, height: 900 }, { width: 400, height: 600 });
    expect(r.bounds).toEqual({ x: 10, y: 20, width: 400, height: 600 });
    expect(r.fit).toEqual({ left: 0, top: 0, width: 1, height: 600 / 900 });
  });

  it("没有缩放且模拟视口不比槽位小：原样返回同一个对象、fit 为 null", () => {
    const slot = { x: 0, y: 0, width: 800, height: 600 };
    for (const emu of [{ width: 1440, height: 900 }, { width: 800, height: 600 }, { width: 800 }, { height: 600 }]) {
      const r = fitBoundsToEmulation(slot, emu);
      expect(r.bounds).toBe(slot);
      expect(r.fit).toBeNull();
    }
  });

  it("只给宽或只给高（另一维自适应）", () => {
    expect(fitBoundsToEmulation({ x: 0, y: 0, width: 1000, height: 600 }, { width: 400 }).bounds).toEqual({ x: 300, y: 0, width: 400, height: 600 });
    expect(fitBoundsToEmulation({ x: 0, y: 0, width: 1000, height: 600 }, { height: 300 }).bounds).toEqual({ x: 0, y: 0, width: 1000, height: 300 });
  });

  it("没有视口模拟 / 宽高为 0 / 非法值：不动", () => {
    const slot = { x: 0, y: 0, width: 1000, height: 600 };
    for (const emu of [undefined, null, {}, { colorScheme: "dark" }, { width: 0, height: 0 }, { width: -5 }, { width: Number.NaN }, { width: "400" }]) {
      const r = fitBoundsToEmulation(slot, emu as never);
      expect(r.bounds).toBe(slot);
      expect(r.fit).toBeNull();
    }
  });

  it("退化槽位（0 宽 / 0 高 / 缺失）：原样返回，不除零", () => {
    for (const slot of [{ x: 0, y: 0, width: 0, height: 600 }, { x: 0, y: 0, width: 600, height: 0 }, null, undefined]) {
      const r = fitBoundsToEmulation(slot as never, { width: 300, height: 300 }, 0.5);
      expect(r.bounds).toBe(slot);
      expect(r.fit).toBeNull();
    }
  });

  it("小数宽度向下取整；任何尺寸组合下：整数、落在槽位内、左右留白相差 ≤1、fit 与 bounds 自洽（含各种缩放比例）", () => {
    expect(fitBoundsToEmulation({ x: 0, y: 0, width: 1000, height: 600 }, { width: 393.7 }).bounds.width).toBe(393);
    for (const scale of [1, 0.9, 0.5, 0.333]) {
      for (let sw = 1; sw <= 61; sw += 5) {
        for (let ew = 1; ew <= 70; ew += 3) {
          const slot = { x: 7, y: 9, width: sw * 17, height: 480 };
          const { bounds, fit } = fitBoundsToEmulation(slot, { width: ew * 17 + 1, height: 300 }, scale);
          expect(Number.isInteger(bounds.x) && Number.isInteger(bounds.width) && Number.isInteger(bounds.height)).toBe(true);
          expect(bounds.width).toBeGreaterThanOrEqual(1);
          expect(bounds.x).toBeGreaterThanOrEqual(slot.x);
          expect(bounds.x + bounds.width).toBeLessThanOrEqual(slot.x + slot.width);
          const leftGap = bounds.x - slot.x;
          const rightGap = slot.x + slot.width - (bounds.x + bounds.width);
          expect(Math.abs(leftGap - rightGap)).toBeLessThanOrEqual(1);
          if (fit) {
            expect(Math.round(fit.left * slot.width)).toBe(leftGap);
            expect(Math.round(fit.width * slot.width)).toBe(bounds.width);
            expect(Math.round(fit.height * slot.height)).toBe(bounds.height);
          } else {
            expect(bounds).toBe(slot);
          }
        }
      }
    }
  });

  it("不改入参", () => {
    const slot = Object.freeze({ x: 0, y: 0, width: 1000, height: 600 });
    const emu = Object.freeze({ width: 400, height: 300 });
    expect(() => fitBoundsToEmulation(slot, emu, 0.5)).not.toThrow();
  });

  it("接 mergeEmulation：预设展开出的 width / height 就是这里读的字段", () => {
    const emu = mergeEmulation({}, { device: "iPhone 15" });
    const r = fitBoundsToEmulation({ x: 0, y: 0, width: 1000, height: 1000 }, emu);
    expect(r.bounds.width).toBe(393);
    expect(r.bounds.height).toBe(852);
  });
});

describe("fitBoundsToEmulation + scale（B：视图 = floor(模拟尺寸 × scale)，居中）", () => {
  it("scale 生效：视图尺寸按比例缩小后水平居中；两个方向都不超出槽位", () => {
    const slot = { x: 100, y: 50, width: 1170, height: 650 };
    const emu = { width: 1440, height: 900 };
    const s = fitScaleFor(slot, emu);
    expect(s).toBe(0.722);
    const r = fitBoundsToEmulation(slot, emu, s);
    expect(r.bounds).toEqual({ x: 100 + Math.floor((1170 - 1039) / 2), y: 50, width: 1039, height: 649 });
    expect(r.bounds.width).toBeLessThanOrEqual(slot.width);
    expect(r.bounds.height).toBeLessThanOrEqual(slot.height);
  });

  it("scale ≥ 1 / 非法 scale：按不缩放处理", () => {
    const slot = { x: 0, y: 0, width: 2000, height: 1000 };
    const emu = { width: 1440, height: 900 };
    const base = fitBoundsToEmulation(slot, emu);
    for (const bad of [1, 1.5, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, undefined]) {
      expect(fitBoundsToEmulation(slot, emu, bad as never)).toEqual(base);
    }
  });

  it("缩放后视图仍可能被槽位截断（槽位在拖动中比上次生效的比例要求的更小）：不超出槽位", () => {
    // 上次生效的 scale=0.9（对应更大的槽位），槽位现在只有 800 宽：视图被钳到槽位内
    const r = fitBoundsToEmulation({ x: 0, y: 0, width: 800, height: 700 }, { width: 1440, height: 900 }, 0.9);
    expect(r.bounds.width).toBe(800);
    expect(r.bounds.x).toBe(0);
  });
});

describe("fitScaleFor / fitViewportOf", () => {
  it("min(1, 槽位宽 / 模拟宽, 槽位高 / 模拟高)，向下取 3 位小数", () => {
    expect(fitScaleFor({ x: 0, y: 0, width: 1170, height: 650 }, { width: 1440, height: 900 })).toBe(0.722); // 受高度限制 650/900
    expect(fitScaleFor({ x: 0, y: 0, width: 900, height: 2000 }, { width: 1440, height: 900 })).toBe(0.625); // 受宽度限制
    expect(fitScaleFor({ x: 0, y: 0, width: 900, height: 500 }, { width: 393, height: 852 })).toBe(0.586);
    expect(fitScaleFor({ x: 0, y: 0, width: 1000, height: 700 }, { width: 1000, height: 700 })).toBe(1);
  });

  it("不放大：槽位比模拟视口大 = 1", () => {
    expect(fitScaleFor({ x: 0, y: 0, width: 3000, height: 2000 }, { width: 1440, height: 900 })).toBe(1);
  });

  it("向下取整：floor(模拟尺寸 × scale) 永远放得进槽位", () => {
    for (let sw = 120; sw <= 1900; sw += 37) {
      for (let sh = 90; sh <= 1200; sh += 53) {
        const slot = { x: 0, y: 0, width: sw, height: sh };
        const emu = { width: 1440, height: 900 };
        const s = fitScaleFor(slot, emu);
        if (s >= 1) continue;
        expect(Math.floor(1440 * s)).toBeLessThanOrEqual(sw);
        expect(Math.floor(900 * s)).toBeLessThanOrEqual(sh);
      }
    }
  });

  it("只给宽或高（另一维自适应）= 不缩放：另一维取多少取决于槽位，没有「整页缩成多大」的答案", () => {
    const slot = { x: 0, y: 0, width: 500, height: 400 };
    expect(fitScaleFor(slot, { width: 1440 })).toBe(1);
    expect(fitScaleFor(slot, { height: 900 })).toBe(1);
    expect(fitViewportOf({ width: 1440 })).toBeNull();
    expect(fitViewportOf({ width: 1440, height: 900 })).toEqual({ width: 1440, height: 900 });
  });

  it("下限：缩到比 MIN_FIT_SCALE 还小时不缩（退回裁切）", () => {
    expect(MIN_FIT_SCALE).toBe(0.1);
    expect(fitScaleFor({ x: 0, y: 0, width: 100, height: 100 }, { width: 1440, height: 900 })).toBe(1);
    expect(fitScaleFor({ x: 0, y: 0, width: 144, height: 90 }, { width: 1440, height: 900 })).toBe(0.1);
  });

  it("退化槽位 / 没有模拟：1", () => {
    for (const slot of [null, undefined, { x: 0, y: 0, width: 0, height: 100 }, { x: 0, y: 0, width: 100, height: 0 }]) {
      expect(fitScaleFor(slot as never, { width: 1440, height: 900 })).toBe(1);
    }
    expect(fitScaleFor({ x: 0, y: 0, width: 500, height: 500 }, {})).toBe(1);
    expect(fitScaleFor({ x: 0, y: 0, width: 500, height: 500 }, undefined)).toBe(1);
  });
});

describe("viewportMetricsCommand / withFitScale", () => {
  it("带缩放：scale + dontSetVisibleSize 必须一起给（不给 dontSetVisibleSize 时 Chromium 会再缩一次）", () => {
    expect(viewportMetricsCommand({ width: 1000, height: 700, mobile: false }, 0.6)).toEqual({
      method: "Emulation.setDeviceMetricsOverride",
      params: { width: 1000, height: 700, deviceScaleFactor: 0, mobile: false, scale: 0.6, dontSetVisibleSize: true },
    });
  });

  it("不缩放：与 toCdpCommands 里的视口命令参数一致，不带 scale / dontSetVisibleSize", () => {
    expect(viewportMetricsCommand({ width: 1000, height: 700 }, 1)).toEqual({
      method: "Emulation.setDeviceMetricsOverride",
      params: { width: 1000, height: 700, deviceScaleFactor: 0, mobile: false },
    });
  });

  it("没有视口项（只有 touch / 外观类）= null", () => {
    expect(viewportMetricsCommand({}, 0.5)).toBeNull();
    expect(viewportMetricsCommand({ touch: true, colorScheme: "dark" }, 0.5)).toBeNull();
  });

  it("withFitScale 只改 setDeviceMetricsOverride、不改入参；scale ≥ 1 原样返回", () => {
    const cmds = [
      { method: "Emulation.setDeviceMetricsOverride", params: { width: 1, height: 2, deviceScaleFactor: 0, mobile: false } },
      { method: "Emulation.setTouchEmulationEnabled", params: { enabled: true } },
    ];
    const frozen = JSON.stringify(cmds);
    const out = withFitScale(cmds, 0.5);
    expect(out[0].params).toMatchObject({ scale: 0.5, dontSetVisibleSize: true });
    expect(out[1]).toBe(cmds[1]);
    expect(JSON.stringify(cmds)).toBe(frozen);
    expect(withFitScale(cmds, 1)).toBe(cmds);
    expect(withFitScale(cmds, undefined as never)).toBe(cmds);
  });
});

describe("scaleInputParams（AI 输入坐标：页面 CSS 像素 → 视图坐标）", () => {
  it("鼠标：x / y 乘 scale，其余字段（含滚轮 delta）原样", () => {
    const p = { type: "mouseWheel", x: 500, y: 350, deltaX: 0, deltaY: 200, button: "none", buttons: 0 };
    expect(scaleInputParams("Input.dispatchMouseEvent", p, 0.6)).toEqual({ ...p, x: 300, y: 210 });
  });

  it("触屏：每个触点的 x / y 乘 scale，id / force 等原样", () => {
    const p = { type: "touchStart", touchPoints: [{ x: 100, y: 200, id: 0, force: 0.5 }, { x: 300, y: 400, id: 1 }] };
    expect(scaleInputParams("Input.dispatchTouchEvent", p, 0.5)).toEqual({
      type: "touchStart",
      touchPoints: [{ x: 50, y: 100, id: 0, force: 0.5 }, { x: 150, y: 200, id: 1 }],
    });
    // touchEnd 没有触点：不出错
    expect(scaleInputParams("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }, 0.5)).toEqual({ type: "touchEnd", touchPoints: [] });
  });

  it("拖放：x / y 乘 scale，data 原样", () => {
    const data = { items: [], dragOperationsMask: 1 };
    expect(scaleInputParams("Input.dispatchDragEvent", { type: "drop", x: 200, y: 100, data }, 0.25)).toEqual({ type: "drop", x: 50, y: 25, data });
  });

  it("scale ≥ 1 / 非法：返回同一个对象；不带坐标的方法与非输入方法：同一个对象", () => {
    const p = { type: "mousePressed", x: 1, y: 2 };
    for (const bad of [1, 2, 0, -0.5, Number.NaN, undefined]) expect(scaleInputParams("Input.dispatchMouseEvent", p, bad as never)).toBe(p);
    const key = { type: "keyDown", key: "a" };
    expect(scaleInputParams("Input.dispatchKeyEvent", key, 0.5)).toBe(key);
    const shot = { format: "png", clip: { x: 1, y: 2, width: 3, height: 4, scale: 1 } };
    expect(scaleInputParams("Page.captureScreenshot", shot, 0.5)).toBe(shot);
    expect(scaleInputParams("DOM.getContentQuads", { backendNodeId: 1 }, 0.5)).toEqual({ backendNodeId: 1 });
  });

  it("不改入参；缺 x / y 或类型不对的字段不被凭空造出数字", () => {
    const p = Object.freeze({ type: "mouseMoved", x: 10, y: 20 });
    expect(() => scaleInputParams("Input.dispatchMouseEvent", p, 0.5)).not.toThrow();
    const odd = { type: "mouseMoved", x: "10", y: undefined };
    expect(scaleInputParams("Input.dispatchMouseEvent", odd, 0.5)).toEqual({ type: "mouseMoved", x: "10", y: undefined });
  });
});

describe("Input.* 白名单：新增任何 CDP 输入方法都必须决定「带不带视口坐标」", () => {
  const listMjs = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      const f = join(dir, n);
      return statSync(f).isDirectory() ? listMjs(f) : f.endsWith(".mjs") ? [f] : [];
    });

  it("electron-app/browser 里出现过的 Input.<方法> 全部在「带坐标（补偿）」或「不带坐标」两个清单里", () => {
    const known = new Set<string>([...INPUT_COORD_METHODS, ...INPUT_PLAIN_METHODS]);
    const found = new Map<string, string>();
    for (const f of listMjs(resolve(root, "electron-app/browser"))) {
      // `Input.dispatch*`（注释里的通配写法）不算方法名；`Input.dragIntercepted` 是 CDP 事件（浏览器 → 我们），不是我们发出的命令
      for (const m of readFileSync(f, "utf8").matchAll(/\bInput\.([A-Za-z]+)\b(?!\*)/g)) found.set(`Input.${m[1]}`, f);
    }
    const events = new Set(["Input.dragIntercepted"]);
    const unknown = [...found.entries()].filter(([name]) => !known.has(name) && !events.has(name));
    expect(unknown).toEqual([]);
    // 清单本身没有多余项（防止清单和代码脱节）
    for (const name of known) expect(found.has(name)).toBe(true);
    expect(found.has("Input.dragIntercepted")).toBe(true); // 事件白名单同样不能有多余项
  });

  it("两个清单互不重叠；带坐标的方法 scaleInputParams 都处理", () => {
    for (const m of INPUT_COORD_METHODS) expect(INPUT_PLAIN_METHODS).not.toContain(m);
    const sample: Record<string, object> = {
      "Input.dispatchMouseEvent": { x: 10, y: 10 },
      "Input.dispatchDragEvent": { x: 10, y: 10 },
      "Input.dispatchTouchEvent": { touchPoints: [{ x: 10, y: 10 }] },
    };
    for (const m of INPUT_COORD_METHODS) {
      expect(scaleInputParams(m, sample[m], 0.5)).not.toEqual(sample[m]);
    }
  });
});

// ───────────────────────── BrowserTab：槽位 vs 视图矩形 / 缩放 / 输入补偿 ─────────────────────────

interface Sent {
  method: string;
  params: Record<string, unknown>;
  /** 子会话 id（只有命令发给子会话时才有；主会话的条目没有这个字段） */
  sessionId?: string;
}

/** 1×1 PNG：截图命令的假应答（让 tab.screenshot() 的取尺寸 / 解码能真走一遍；没人读它的像素） */
const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

interface FakeWin {
  contentView: { addChildView: ReturnType<typeof vi.fn>; removeChildView: ReturnType<typeof vi.fn> };
}
const makeWin = (): FakeWin => ({ contentView: { addChildView: vi.fn(), removeChildView: vi.fn() } });

/** opts：session 层的用例要几个真 Tab 共用同一对窗口、并用 session 给的 hooks / id 造 Tab */
const makeTab = (opts: { id?: string; hooks?: Record<string, unknown>; windows?: { main: FakeWin; parking: FakeWin }; timers?: { setTimeoutFn: never; clearTimeoutFn: never } | "default" } = {}) => {
  const sent: Sent[] = [];
  const failMethods: Record<string, string> = {};
  /** Tab 的 log 回调收到的行（日志用例看它；其余用例不看） */
  const logs: string[] = [];
  /** 假 wc 的「已销毁」标志：`wcGone()` 靠 `wc.isDestroyed?.()` 判，缺这个方法就永远判成没销毁（第十二轮评审 P3-9），destroyWc() 翻它 */
  let wcDestroyed = false;
  let attached = false;
  let onDetach: (e: unknown, reason: string) => void = () => {};
  const gates: Record<string, Promise<void> | undefined> = {};
  const dbg = {
    isAttached: () => attached,
    attach: () => {
      attached = true;
    },
    detach: () => {
      attached = false;
    },
    on: (ev: string, fn: never) => {
      if (ev === "detach") onDetach = fn;
    },
    sendCommand: vi.fn(async (method: string, params: Record<string, unknown> = {}, sessionId?: string) => {
      sent.push(sessionId ? { method, params, sessionId } : { method, params });
      const gate = gates[method];
      if (gate) await gate;
      const fail = failMethods[method];
      if (fail) throw new Error(fail);
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "F1" } } };
      if (method === "Page.addScriptToEvaluateOnNewDocument") return { identifier: "s1" };
      if (method === "Page.createIsolatedWorld") return { executionContextId: 7 };
      if (method === "Page.captureScreenshot") return { data: PNG_1X1 };
      return {};
    }),
  };
  const wc = {
    debugger: dbg,
    on: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    setAudioMuted: vi.fn(),
    loadURL: vi.fn(async () => {}),
    getURL: () => "https://example.com/",
    getTitle: () => "示例页",
    isLoading: () => false,
    isDestroyed: () => wcDestroyed,
    navigationHistory: { canGoBack: () => false, canGoForward: () => false },
    getZoomLevel: () => 0,
    close: vi.fn(),
  };
  class FakeView {
    webContents = wc;
    setBackgroundColor = vi.fn();
    setBounds = vi.fn();
    setVisible = vi.fn();
  }
  const defaultHooks = {
    onChange: vi.fn(),
    onLoaded: vi.fn(),
    onNewTab: vi.fn(),
    onRecorder: vi.fn(),
    onBlocked: vi.fn(),
    onDialog: vi.fn(),
    onNeedLockSync: vi.fn(),
    onCrashed: vi.fn(),
  };
  const hooks = (opts.hooks ?? defaultHooks) as typeof defaultHooks;
  const parking = opts.windows?.parking ?? makeWin();
  const main = opts.windows?.main ?? makeWin();
  const tab = new BrowserTab({
    id: opts.id ?? "t1",
    WebContentsView: FakeView as never,
    parkingWindow: parking,
    pageScripts: { PAGE_WORLD_NAME: "flowship", RECORDER_BINDING: "__rec", buildPageScript: () => "//" } as never,
    isAppUrl: () => false,
    hooks,
    log: (line: string) => {
      logs.push(String(line));
    },
    // Tab 的定时器（兜底重摆 / 对话框）走注入版（第十三轮评审 P3-6）。默认的两个函数在**调用时**才去取全局 setTimeout / clearTimeout：
    // 好些用例在 makeTab 之后才 vi.useFakeTimers，Tab 构造时就把全局函数捕获下来的话，假定时器接管不到它；timers 可整体换成手动假时钟
    // timers: "default" = 一个都不注入，走 Tab 自己的回退（`deps.setTimeoutFn ?? setTimeout`，构造时捕获全局函数）——生产里就是这一条路径（第十四轮评审 P3-4 ⑦：别的用例都注入了，这条回退 vitest 里从没走到过）
    ...(opts.timers === "default"
      ? {}
      : {
          setTimeoutFn: opts.timers?.setTimeoutFn ?? ((fn: () => void, ms?: number) => setTimeout(fn, ms)),
          clearTimeoutFn: opts.timers?.clearTimeoutFn ?? ((timer: ReturnType<typeof setTimeout>) => clearTimeout(timer)),
        }),
  } as never);
  const setBounds = (tab.view as unknown as { setBounds: ReturnType<typeof vi.fn> }).setBounds;
  const setVisible = (tab.view as unknown as { setVisible: ReturnType<typeof vi.fn> }).setVisible;
  const lastBounds = (): Rect => setBounds.mock.calls.at(-1)![0] as Rect;
  const info = () => tab.info(true) as TabInfo;
  const overrides = () => sent.filter((s) => s.method === "Emulation.setDeviceMetricsOverride").map((s) => s.params);
  const lastOverride = () => overrides().at(-1);
  /** 让排在模拟队列里的任务（缩放重算）跑完 */
  const flush = async () => {
    for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
  };
  /** 发一条输入命令，返回落到 CDP 上的实际参数 */
  const wireOf = async (method: string, params: Record<string, unknown>) => {
    const before = sent.length;
    await tab.send(method, params);
    return sent.slice(before).find((s) => s.method === method)!.params;
  };
  return {
    tab,
    sent,
    failMethods,
    gates,
    main,
    parking,
    hooks,
    setBounds,
    setVisible,
    lastBounds,
    info,
    overrides,
    lastOverride,
    flush,
    wireOf,
    logs,
    /** 页面的 webContents 销毁了：之后 `isDestroyed()` 为真，tab.send 一律 TAB_NOT_FOUND、不再发 CDP */
    destroyWc: () => {
      wcDestroyed = true;
    },
    detach: () => {
      attached = false;
      onDetach(null, "target closed");
    },
  };
};

const D1440 = { device: "Desktop 1440" } as const; // 1440×900

describe("BrowserTab：A —— 视图比模拟视口大（不缩放，只居中收窄）", () => {
  it("没有模拟：视图就是槽位，TabInfo 不带 viewFit / fitScale（普通标签的 info 形状不变）", async () => {
    const h = makeTab();
    await h.tab.ready;
    h.tab.moveToMain(h.main as never, SLOT);
    await h.flush();
    expect(h.lastBounds()).toEqual(SLOT);
    const i = h.info();
    expect("viewFit" in i).toBe(false);
    expect("fitScale" in i).toBe(false);
  });

  it("槽位比模拟视口大：不缩放（override 不带 scale）、视图居中收窄、viewFit 带出；reset 放回整个槽位", async () => {
    const h = makeTab();
    await h.tab.ready;
    const big = { x: 0, y: 40, width: 2000, height: 1000 };
    h.tab.moveToMain(h.main as never, big);
    await h.tab.applyEmulation(D1440);
    expect(h.lastOverride()).toEqual({ width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    expect(h.lastBounds()).toEqual({ x: 280, y: 40, width: 1440, height: 900 });
    expect(h.info().viewFit).toEqual({ left: 280 / 2000, top: 0, width: 1440 / 2000, height: 0.9 });
    expect("fitScale" in h.info()).toBe(false);

    await h.tab.resetEmulation();
    expect(h.lastBounds()).toEqual(big);
    expect("viewFit" in h.info()).toBe(false);
  });

  it("只给宽（高度自适应）：不缩放；槽位比它窄时视图 = 槽位（裁切），比它宽时居中收窄", async () => {
    const h = makeTab();
    await h.tab.ready;
    h.tab.moveToMain(h.main as never, { x: 0, y: 0, width: 1000, height: 600 });
    await h.tab.applyEmulation({ width: 1440 });
    expect(h.lastOverride()).not.toHaveProperty("scale");
    expect(h.lastBounds()).toEqual({ x: 0, y: 0, width: 1000, height: 600 });
    h.tab.setBounds({ x: 0, y: 0, width: 2000, height: 600 });
    await h.flush();
    expect(h.lastBounds()).toEqual({ x: 280, y: 0, width: 1440, height: 600 });
    expect(h.overrides().every((o) => !("scale" in o))).toBe(true);
  });

  it("停车场里换模拟不会把停车场的视图改成槽位矩形", async () => {
    const h = makeTab();
    await h.tab.ready;
    h.tab.moveToMain(h.main as never, SLOT);
    h.tab.moveToParking(h.parking as never);
    h.setBounds.mockClear();
    await h.tab.applyEmulation({ device: "iPhone 15" });
    await h.flush();
    expect(h.setBounds).not.toHaveBeenCalled();
  });

  it("只改外观类模拟（暗色等）不影响视图矩形，也不发视口命令", async () => {
    const h = makeTab();
    await h.tab.ready;
    h.tab.moveToMain(h.main as never, SLOT);
    await h.tab.applyEmulation({ colorScheme: "dark" });
    await h.flush();
    expect(h.lastBounds()).toEqual(SLOT);
    expect(h.overrides()).toHaveLength(0);
  });
});

describe("BrowserTab：B —— 视图比模拟视口小（整体缩小适应）", () => {
  it("Desktop 1440 放进 1700×700 的槽位：override 带 scale + dontSetVisibleSize，视图 = floor(模拟尺寸 × scale)、居中", async () => {
    const h = makeTab();
    await h.tab.ready;
    h.tab.moveToMain(h.main as never, SLOT);
    await h.tab.applyEmulation(D1440);
    const s = fitScaleFor(SLOT, { width: 1440, height: 900 }); // 700/900 = 0.777
    expect(s).toBe(0.777);
    expect(h.lastOverride()).toEqual({ width: 1440, height: 900, deviceScaleFactor: 1, mobile: false, scale: s, dontSetVisibleSize: true });
    const w = Math.floor(1440 * s);
    expect(h.lastBounds()).toEqual({ x: 100 + Math.floor((1700 - w) / 2), y: 50, width: w, height: Math.floor(900 * s) });
    expect(h.info().fitScale).toBe(s);
    expect(h.info().viewFit?.left).toBeCloseTo((Math.floor((1700 - w) / 2)) / 1700, 10);
  });

  it("页面看到的模拟视口不变：override 的 width / height 仍是 1440×900（缩放只发生在 scale 上）", async () => {
    const h = makeTab();
    await h.tab.ready;
    h.tab.moveToMain(h.main as never, { x: 0, y: 0, width: 600, height: 400 });
    await h.tab.applyEmulation(D1440);
    expect(h.lastOverride()).toMatchObject({ width: 1440, height: 900 });
    expect(h.tab.emulation).toMatchObject({ width: 1440, height: 900, device: "Desktop 1440" });
  });

  it("先有模拟再挂到主窗口（moveToMain）：挂上后重算缩放并收成对应大小", async () => {
    const h = makeTab();
    await h.tab.ready;
    await h.tab.applyEmulation({ device: "iPhone 15" }); // 停车场里：没有槽位，不缩放
    expect(h.lastOverride()).not.toHaveProperty("scale");
    h.tab.moveToMain(h.main as never, { x: 0, y: 0, width: 1000, height: 600 });
    await h.flush();
    const s = fitScaleFor({ x: 0, y: 0, width: 1000, height: 600 }, { width: 393, height: 852 }); // 600/852
    expect(s).toBe(0.704);
    expect(h.lastOverride()).toMatchObject({ width: 393, height: 852, mobile: true, scale: s, dontSetVisibleSize: true });
    expect(h.lastBounds()).toEqual({ x: Math.floor((1000 - Math.floor(393 * s)) / 2), y: 0, width: Math.floor(393 * s), height: Math.floor(852 * s) });
  });

  it("拖面板（setBounds）：同步改成「已生效比例」对应的视图，随后补发新 scale，成功后视图收成新大小；槽位变大到够用时回到 1", async () => {
    const h = makeTab();
    await h.tab.ready;
    h.tab.moveToMain(h.main as never, SLOT);
    await h.tab.applyEmulation(D1440);
    const s1 = h.info().fitScale as number;

    const narrow = { x: 100, y: 50, width: 1000, height: 700 };
    h.tab.setBounds(narrow);
    // 同步这一帧：还是旧比例，但视图不会超出槽位
    expect(h.lastBounds().width).toBeLessThanOrEqual(narrow.width);
    await h.flush();
    const s2 = fitScaleFor(narrow, { width: 1440, height: 900 }); // 1000/1440 = 0.694
    expect(s2).toBe(0.694);
    expect(s2).toBeLessThan(s1);
    expect(h.lastOverride()).toMatchObject({ scale: s2, dontSetVisibleSize: true });
    expect(h.info().fitScale).toBe(s2);
    expect(h.lastBounds().width).toBe(Math.floor(1440 * s2));

    h.tab.setBounds({ x: 0, y: 0, width: 2000, height: 1000 }); // 比模拟视口还大：不用缩放了
    await h.flush();
    expect(h.lastOverride()).toEqual({ width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }); // 不带 scale / dontSetVisibleSize
    expect("fitScale" in h.info()).toBe(false);
    expect(h.lastBounds()).toEqual({ x: 280, y: 0, width: 1440, height: 900 });
  });

  it("拖面板每帧一次 setBounds：重算任务合并，只按最新槽位发一条 CDP", async () => {
    const h = makeTab();
    await h.tab.ready;
    h.tab.moveToMain(h.main as never, SLOT);
    await h.tab.applyEmulation(D1440);
    const before = h.overrides().length;
    let last = SLOT;
    for (let w = 1690; w >= 1500; w -= 10) {
      last = { x: 100, y: 50, width: w, height: 700 };
      h.tab.setBounds(last);
    }
    await h.flush();
    // 槽位高 700、模拟高 900：比例由高度决定（0.777），宽度变化不影响比例 → 一条都不用发
    expect(h.overrides().length - before).toBe(0);
    // 换成受宽度限制的情形：每帧一次 setBounds，合并成一条
    for (let w = 1400; w >= 1000; w -= 20) {
      last = { x: 100, y: 50, width: w, height: 2000 };
      h.tab.setBounds(last);
    }
    await h.flush();
    expect(h.overrides().length - before).toBe(1);
    expect(h.lastOverride()?.scale).toBe(fitScaleFor(last, { width: 1440, height: 900 }));
  });

  it("换设备（Desktop 1440 → iPhone 15）：scale 按新设备重算", async () => {
    const h = makeTab();
    await h.tab.ready;
    const slot = { x: 0, y: 0, width: 900, height: 500 };
    h.tab.moveToMain(h.main as never, slot);
    await h.tab.applyEmulation(D1440);
    await h.tab.applyEmulation({ device: "iPhone 15" });
    expect(h.lastOverride()).toMatchObject({ width: 393, height: 852, mobile: true, scale: fitScaleFor(slot, { width: 393, height: 852 }) });
    expect(h.info().fitScale).toBe(0.586);
  });

  it("reset：发 clearDeviceMetricsOverride、比例回到 1、视图放回整个槽位、输入不再补偿", async () => {
    const h = makeTab();
    await h.tab.ready;
    h.tab.moveToMain(h.main as never, SLOT);
    await h.tab.applyEmulation(D1440);
    await h.tab.resetEmulation();
    expect(h.sent.at(-1)?.method === "Emulation.setTouchEmulationEnabled" || h.sent.some((s) => s.method === "Emulation.clearDeviceMetricsOverride")).toBe(true);
    expect(h.lastBounds()).toEqual(SLOT);
    expect("fitScale" in h.info()).toBe(false);
    expect("viewFit" in h.info()).toBe(false);
    expect(await h.wireOf("Input.dispatchMouseEvent", { type: "mousePressed", x: 100, y: 50 })).toEqual({ type: "mousePressed", x: 100, y: 50 });
  });

  it("缩放百分比整数变了就推状态（拖面板把比例拖到另一个整数百分比）", async () => {
    const h = makeTab();
    await h.tab.ready;
    h.tab.moveToMain(h.main as never, { x: 0, y: 0, width: 1000, height: 2000 });
    await h.tab.applyEmulation(D1440); // 1000/1440 = 0.694
    await h.flush();
    h.hooks.onChange.mockClear();
    h.tab.setBounds({ x: 0, y: 0, width: 800, height: 2000 }); // 0.555：整数百分比变了
    await h.flush();
    expect(h.info().fitScale).toBe(0.555);
    expect(h.hooks.onChange.mock.calls.length).toBeGreaterThan(0);
  });

  // ───────── R9-03：viewFit 变了就要推（缩放百分比不变也一样） ─────────

  it("R9-03 ① A 模式（模拟视口比槽位小、不缩放）：拖宽面板——百分比恒为 100，但 viewFit 变了 → 推状态，info 里是新值", async () => {
    const h = makeTab();
    await h.tab.ready;
    h.tab.moveToMain(h.main as never, { x: 0, y: 0, width: 900, height: 500 });
    await h.tab.applyEmulation({ width: 600, height: 400 });
    await h.flush();
    expect(h.info().viewFit).toEqual({ left: 150 / 900, top: 0, width: 600 / 900, height: 400 / 500 });
    expect("fitScale" in h.info()).toBe(false); // 没缩放：百分比永远 100，以前就是因为这个一次都不推
    h.hooks.onChange.mockClear();
    h.tab.setBounds({ x: 0, y: 0, width: 1200, height: 500 });
    await h.flush();
    expect(h.info().viewFit).toEqual({ left: 300 / 1200, top: 0, width: 600 / 1200, height: 400 / 500 });
    expect("fitScale" in h.info()).toBe(false);
    expect(h.hooks.onChange.mock.calls.length).toBeGreaterThan(0);
  });

  it("R9-03 ② B 模式被高度限制（比例不变，只有居中偏移变）：拖宽面板 → viewFit 变了 → 推状态", async () => {
    const h = makeTab();
    await h.tab.ready;
    h.tab.moveToMain(h.main as never, { x: 0, y: 0, width: 1200, height: 450 });
    await h.tab.applyEmulation(D1440); // 450/900 = 0.5（受高度限制）
    await h.flush();
    expect(h.info().fitScale).toBe(0.5);
    const before = h.info().viewFit;
    h.hooks.onChange.mockClear();
    h.tab.setBounds({ x: 0, y: 0, width: 1600, height: 450 }); // 比例仍是 0.5，只有左右留白变了
    await h.flush();
    expect(h.info().fitScale).toBe(0.5);
    const after = h.info().viewFit;
    expect(after).not.toEqual(before);
    expect(after).toEqual({ left: 440 / 1600, top: 0, width: 720 / 1600, height: 1 });
    expect(h.hooks.onChange.mock.calls.length).toBeGreaterThan(0);
  });

  it("R9-03 对照：viewFit 与缩放百分比都没变就不推——同一个槽位重复汇报、槽位只挪位置不改大小（比例不变）", async () => {
    const h = makeTab();
    await h.tab.ready;
    const slot = { x: 0, y: 0, width: 900, height: 500 };
    h.tab.moveToMain(h.main as never, slot);
    await h.tab.applyEmulation({ width: 600, height: 400 });
    await h.flush();
    h.hooks.onChange.mockClear();
    h.tab.setBounds({ ...slot }); // 渲染端每次布局都会汇报一次，内容没变
    h.tab.setBounds({ ...slot });
    await h.flush();
    expect(h.hooks.onChange).not.toHaveBeenCalled();
    h.tab.setBounds({ x: 40, y: 30, width: 900, height: 500 }); // 只是整体挪了位置：视图仍占槽位的同一比例，遮盖图不用重摆
    await h.flush();
    expect(h.hooks.onChange).not.toHaveBeenCalled();
    expect(h.lastBounds()).toEqual({ x: 40 + 150, y: 30, width: 600, height: 400 }); // 视图本身当然跟着挪了
  });

  it("R9-03 对照：没有设备模拟时拖面板不推（viewFit 恒为 null，普通浏览不会因为布局汇报刷状态）", async () => {
    const h = makeTab();
    await h.tab.ready;
    h.tab.moveToMain(h.main as never, SLOT);
    await h.flush();
    h.hooks.onChange.mockClear();
    for (let w = 1700; w >= 1500; w -= 20) h.tab.setBounds({ x: 100, y: 50, width: w, height: 700 });
    await h.flush();
    expect(h.hooks.onChange).not.toHaveBeenCalled();
    expect("viewFit" in h.info()).toBe(false);
  });

  it("R9-03：拖面板每帧都在变 viewFit 时每帧都会调 onChange——下游（session.#changed → manager 的 50ms 去抖）负责合并，这里不自己节流", async () => {
    const h = makeTab();
    await h.tab.ready;
    h.tab.moveToMain(h.main as never, { x: 0, y: 0, width: 900, height: 500 });
    await h.tab.applyEmulation({ width: 600, height: 400 });
    await h.flush();
    h.hooks.onChange.mockClear();
    let last = h.info().viewFit;
    for (let w = 920; w <= 1100; w += 20) {
      h.tab.setBounds({ x: 0, y: 0, width: w, height: 500 });
      expect(h.info().viewFit).not.toEqual(last); // 同步就已经是新值（不用等 refit 的异步任务）
      last = h.info().viewFit;
    }
    await h.flush();
    expect(h.hooks.onChange.mock.calls.length).toBeGreaterThanOrEqual(10); // 920..1100 共 10 帧
  });
});

describe("sameViewFit（主进程与渲染端 store 同口径）", () => {
  const fit = { left: 0.25, top: 0, width: 0.5, height: 0.8 };
  it("null / undefined 等价；逐字段严格相等；任一字段不同就不同", () => {
    expect(sameViewFit(null, null)).toBe(true);
    expect(sameViewFit(undefined, null)).toBe(true);
    expect(sameViewFit(fit, { ...fit })).toBe(true); // 不是引用比较
    expect(sameViewFit(fit, null)).toBe(false);
    expect(sameViewFit(undefined, fit)).toBe(false);
    for (const k of ["left", "top", "width", "height"] as const) {
      expect(sameViewFit(fit, { ...fit, [k]: fit[k] + 0.0001 }), k).toBe(false);
    }
  });
});

describe("BrowserTab：B —— AI 输入坐标补偿（Tab.send 唯一出口）", () => {
  const scaled = async () => {
    const h = makeTab();
    await h.tab.ready;
    h.tab.moveToMain(h.main as never, { x: 0, y: 0, width: 600, height: 420 });
    await h.tab.applyEmulation({ width: 1000, height: 700 }); // 600/1000、420/700 → 0.6
    expect(h.info().fitScale).toBe(0.6);
    return h;
  };

  it("鼠标：x / y 乘 scale 才落到页面 CSS 坐标；滚轮 delta 不变；调用方传入的对象不被改", async () => {
    const h = await scaled();
    const params = { type: "mouseWheel", x: 500, y: 350, deltaX: 0, deltaY: 200 };
    const wire = await h.wireOf("Input.dispatchMouseEvent", params);
    expect(wire).toEqual({ type: "mouseWheel", x: 300, y: 210, deltaX: 0, deltaY: 200 });
    expect(params).toEqual({ type: "mouseWheel", x: 500, y: 350, deltaX: 0, deltaY: 200 });
  });

  it("触屏 / 拖放同样补偿；键盘、插入文本、截图（含 clip）、几何查询不动", async () => {
    const h = await scaled();
    expect(await h.wireOf("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 100, y: 200, id: 0 }] })).toEqual({
      type: "touchStart",
      touchPoints: [{ x: 60, y: 120, id: 0 }],
    });
    expect(await h.wireOf("Input.dispatchDragEvent", { type: "dragOver", x: 100, y: 50, data: { items: [] } })).toMatchObject({ x: 60, y: 30 });
    expect(await h.wireOf("Input.dispatchKeyEvent", { type: "keyDown", key: "a" })).toEqual({ type: "keyDown", key: "a" });
    expect(await h.wireOf("Input.insertText", { text: "你好" })).toEqual({ text: "你好" });
    const clip = { format: "png", clip: { x: 480, y: 330, width: 40, height: 40, scale: 1 } };
    expect(await h.wireOf("Page.captureScreenshot", clip)).toEqual(clip);
    expect(await h.wireOf("DOM.getContentQuads", { backendNodeId: 7 })).toEqual({ backendNodeId: 7 });
  });

  it("补偿比例在「缩放命令发出时」就切换（不等应答）：应答前发出的输入已经按新比例算", async () => {
    const h = makeTab();
    await h.tab.ready;
    h.tab.moveToMain(h.main as never, { x: 0, y: 0, width: 600, height: 420 });
    let release: () => void = () => {};
    h.gates["Emulation.setDeviceMetricsOverride"] = new Promise<void>((r) => {
      release = r;
    });
    const applying = h.tab.applyEmulation({ width: 1000, height: 700 });
    for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0)); // 命令已发出、尚未应答
    expect(h.lastOverride()?.scale).toBe(0.6);
    const wire = await h.wireOf("Input.dispatchMouseEvent", { type: "mousePressed", x: 500, y: 350 });
    expect(wire).toMatchObject({ x: 300, y: 210 });
    release();
    await applying;
  });

  it("缩放命令失败：补偿比例回滚到失败前，视图仍按已生效的比例摆（不错位）", async () => {
    const h = await scaled();
    const boundsBefore = h.lastBounds();
    h.failMethods["Emulation.setDeviceMetricsOverride"] = "boom";
    h.tab.setBounds({ x: 0, y: 0, width: 300, height: 210 }); // 要求 0.3，但命令会失败
    await h.flush();
    // 页面仍是 0.6：输入仍按 0.6 补偿
    expect(await h.wireOf("Input.dispatchMouseEvent", { type: "mousePressed", x: 100, y: 100 })).toMatchObject({ x: 60, y: 60 });
    expect(h.info().fitScale).toBe(0.6);
    // 视图不超出新槽位（钳制），宽度不会比已生效比例对应的更大
    expect(h.lastBounds().width).toBeLessThanOrEqual(300);
    expect(boundsBefore.width).toBe(600);
    delete h.failMethods["Emulation.setDeviceMetricsOverride"];
  });

  it("模拟应用失败：状态回滚后补偿比例 / 视图 / fitScale 都回到 prev 的样子", async () => {
    const h = await scaled();
    h.failMethods["Emulation.setDeviceMetricsOverride"] = "boom";
    await expect(h.tab.applyEmulation({ device: "iPhone 15" })).rejects.toThrow();
    expect(h.tab.emulation).toMatchObject({ width: 1000, height: 700 });
    expect(h.info().fitScale).toBe(0.6);
    expect(await h.wireOf("Input.dispatchMouseEvent", { type: "mousePressed", x: 100, y: 100 })).toMatchObject({ x: 60, y: 60 });
    delete h.failMethods["Emulation.setDeviceMetricsOverride"];
  });

  it("debugger 断开又重连：按状态重放，重放的 override 带当前槽位算出的 scale；补偿恢复", async () => {
    const h = await scaled();
    h.detach();
    // 断开的瞬间覆盖没了：补偿也停（页面这时是 1:1）
    expect(await h.wireOf("Input.dispatchMouseEvent", { type: "mousePressed", x: 100, y: 100 })).toMatchObject({ x: 100, y: 100 });
    h.sent.length = 0;
    await h.tab.ensureCdp();
    expect(h.lastOverride()).toMatchObject({ width: 1000, height: 700, scale: 0.6, dontSetVisibleSize: true });
    expect(await h.wireOf("Input.dispatchMouseEvent", { type: "mousePressed", x: 100, y: 100 })).toMatchObject({ x: 60, y: 60 });
    expect(h.lastBounds()).toEqual({ x: 0, y: 0, width: 600, height: 420 });
  });

  it("停车场往返：停车场里沿用比例（不为看不见的视图改 CDP）；回到面板时按新槽位重算", async () => {
    const h = await scaled();
    h.tab.moveToParking(h.parking as never);
    expect(h.lastBounds()).toEqual({ ...PARKING_BOUNDS });
    expect("viewFit" in h.info()).toBe(false);
    h.sent.length = 0;
    await h.flush();
    expect(h.overrides()).toHaveLength(0);
    // 停车场里 AI 仍可操作：补偿沿用 0.6，与页面实际一致
    expect(await h.wireOf("Input.dispatchMouseEvent", { type: "mousePressed", x: 100, y: 100 })).toMatchObject({ x: 60, y: 60 });

    h.tab.moveToMain(h.main as never, { x: 0, y: 0, width: 1000, height: 700 });
    await h.flush();
    expect(h.lastOverride()).toEqual({ width: 1000, height: 700, deviceScaleFactor: 0, mobile: false }); // 槽位够大，回到 1
    expect(await h.wireOf("Input.dispatchMouseEvent", { type: "mousePressed", x: 100, y: 100 })).toMatchObject({ x: 100, y: 100 });
  });

  it("没有缩放（槽位够大）时输入原样，不付任何成本", async () => {
    const h = makeTab();
    await h.tab.ready;
    h.tab.moveToMain(h.main as never, { x: 0, y: 0, width: 2000, height: 1000 });
    await h.tab.applyEmulation({ width: 1000, height: 700 });
    const p = { type: "mousePressed", x: 123, y: 45 };
    const before = h.sent.length;
    await h.tab.send("Input.dispatchMouseEvent", p);
    expect(h.sent[before]?.params).toBe(p); // 同一个对象，没拷贝
  });
});

// ───────────────────────── 截图与设备模拟 / 视图矩形互斥 ─────────────────────────
//
// 用户记录的 bug：面板上写着「适应 79%」，原生视图里的画面却是没缩放的 1440 宽、越出面板。真 Electron 里复现并定位到：
// Chromium 处理 Page.captureScreenshot 时临时改模拟参数 / 视图尺寸、截完写回「开始时记下的值」，
// 并发的截图 / 视口覆盖 / 视图矩形变化插进来，写回的就是过期值（真 Chromium 才复现得出来，见 scripts/browser-e2e/capture-emulation-race.cjs）。
// 这里钉死 Tab 这一侧的契约：截图与它们在 CDP 层互斥、视图矩形在截图期间推迟、截完补摆。
//
// 这组用例的假 CDP（makeTab 里的 sendCommand）只做「按调用顺序记命令、按 gates / failMethods 挂起或失败、其余立刻应答」，**不**模拟：
//   · Chromium 处理截图时的临时改参 / 截完写回旧值（只有真 Chromium 才有，见 capture-emulation-race.cjs）；
//   · 页面卡死后命令「晚到」生效、以及同一会话按序派发——代码里「超时后仍补发还原」靠的是这条推断（没有在真页面卡死时实测）。
//     「第十二轮 P3-9：页面卡死后恢复」那条用例用一个小模型（gates 挂起的命令恢复后按挂起先后依次生效）把这条推断写成可执行的假设，
//     它证明的是「我们发出去的命令序列在按序派发的前提下最终背景是默认的」，不证明真 CDP 真的按序派发；
//   · 「设」与「还原」是同一个方法名：gates / failMethods 按方法名挂，要区分两者得像那几条用例一样包一层 sendCommand 按参数是否为空分。
// 假 wc 的 isDestroyed() 由 destroyWc() 翻（缺这个方法时 wcGone() 永远判成没销毁，标签页在命令之间被销毁的路径测不到）。

describe("BrowserTab：截图与设备模拟 / 视图矩形互斥（并发截图曾把画面留在未缩放状态）", () => {
  const CAP = "Page.captureScreenshot";
  const METRICS = "Emulation.setDeviceMetricsOverride";

  /** 600×420 的槽位 + 1000×700 的模拟 → 缩放 0.6（与「AI 输入坐标补偿」那组同一个起点），并给 CDP 插桩记在飞数 / 交叉 */
  const scaledWithProbe = async () => {
    const h = makeTab();
    await h.tab.ready;
    h.tab.moveToMain(h.main as never, { x: 0, y: 0, width: 600, height: 420 });
    await h.tab.applyEmulation({ width: 1000, height: 700 });
    expect(h.info().fitScale).toBe(0.6);
    const dbg = (h.tab as unknown as { wc: { debugger: { sendCommand: (m: string, p?: Record<string, unknown>) => Promise<unknown> } } }).wc.debugger;
    const inner = dbg.sendCommand;
    const inflight: Record<string, number> = {};
    const stats = { maxCapture: 0, crossed: 0 };
    dbg.sendCommand = async (method: string, params?: Record<string, unknown>) => {
      inflight[method] = (inflight[method] ?? 0) + 1;
      if (method === CAP) stats.maxCapture = Math.max(stats.maxCapture, inflight[CAP]);
      // 截图与视口覆盖 / 清除同时在飞 = 交叉
      if ((method === CAP && (inflight[METRICS] ?? 0) > 0) || (method === METRICS && (inflight[CAP] ?? 0) > 0)) stats.crossed++;
      try {
        return await inner(method, params);
      } finally {
        inflight[method]--;
      }
    };
    h.sent.length = 0;
    return { ...h, stats };
  };
  const capturesIn = (sent: Sent[]) => sent.filter((s) => s.method === CAP);
  const holdCapture = (h: { gates: Record<string, Promise<void> | undefined> }) => {
    let release: () => void = () => {};
    h.gates[CAP] = new Promise<void>((r) => {
      release = r;
    });
    return () => {
      release();
      delete h.gates[CAP];
    };
  };

  it("两条并发的截图在 CDP 层串行：第一条应答前第二条不发出，任何时刻最多一条在飞", async () => {
    const h = await scaledWithProbe();
    const release = holdCapture(h);
    const p1 = h.tab.send(CAP, { format: "png", n: 1 });
    const p2 = h.tab.send(CAP, { format: "png", n: 2 });
    const p3 = h.tab.send(CAP, { format: "png", n: 3 });
    await h.flush();
    expect(capturesIn(h.sent)).toHaveLength(1);
    expect(capturesIn(h.sent)[0]!.params).toMatchObject({ n: 1 });
    release();
    await Promise.all([p1, p2, p3]);
    expect(capturesIn(h.sent).map((s) => s.params.n)).toEqual([1, 2, 3]); // 按调用顺序
    expect(h.stats.maxCapture).toBe(1);
  });

  it("截图在飞时的 emulate：视口覆盖排在截图之后才发（不被截图结束时写回的旧参数盖掉）", async () => {
    const h = await scaledWithProbe();
    const release = holdCapture(h);
    const shot = h.tab.send(CAP, { format: "png" });
    await h.flush();
    const emulating = h.tab.applyEmulation({ width: 500, height: 350 });
    await h.flush();
    expect(capturesIn(h.sent)).toHaveLength(1);
    expect(h.overrides()).toHaveLength(0); // 截图还没应答：一条视口覆盖都不能发
    release();
    await Promise.all([shot, emulating]);
    expect(h.overrides()).toHaveLength(1);
    expect(h.overrides()[0]).toMatchObject({ width: 500, height: 350 });
    const order = h.sent.map((s) => s.method).filter((m) => m === CAP || m === METRICS);
    expect(order).toEqual([CAP, METRICS]);
    expect(h.stats.crossed).toBe(0);
  });

  it("截图在飞时拖面板：缩放重算（视口覆盖）与视图矩形都等截图结束后才落地，且只补最新一次", async () => {
    const h = await scaledWithProbe();
    const boundsBefore = h.lastBounds();
    const callsBefore = h.setBounds.mock.calls.length;
    const release = holdCapture(h);
    const shot = h.tab.send(CAP, { format: "png" });
    await h.flush();
    // 连着拖几帧：0.6 → 0.5 → 0.3（槽位 300×210）
    h.tab.setBounds({ x: 0, y: 0, width: 500, height: 350 });
    h.tab.setBounds({ x: 0, y: 0, width: 400, height: 280 });
    h.tab.setBounds({ x: 0, y: 0, width: 300, height: 210 });
    await h.flush();
    expect(h.overrides()).toHaveLength(0); // 没有视口覆盖与截图交叉
    expect(h.setBounds.mock.calls.length).toBe(callsBefore); // 视图矩形也没动：截图结束时 Chromium 会把「开始时的视图尺寸」写回去
    expect(h.lastBounds()).toEqual(boundsBefore);
    release();
    await shot;
    await h.flush();
    expect(h.overrides()).toHaveLength(1); // 合并成一条，按最新槽位
    expect(h.lastOverride()).toMatchObject({ width: 1000, height: 700, scale: 0.3, dontSetVisibleSize: true });
    expect(h.info().fitScale).toBe(0.3);
    expect(h.lastBounds()).toEqual({ x: 0, y: 0, width: 300, height: 210 });
    expect(h.stats.crossed).toBe(0);
  });

  it("截图在飞时只有视图矩形变了（比例不变、没有视口覆盖跟着发）：截图结束后补摆一次，不丢", async () => {
    const h = makeTab();
    await h.tab.ready;
    h.tab.moveToMain(h.main as never, { x: 0, y: 0, width: 600, height: 420 }); // 没有任何模拟
    h.sent.length = 0;
    const release = holdCapture(h);
    const shot = h.tab.send(CAP, { format: "png" });
    await h.flush();
    h.tab.setBounds({ x: 10, y: 20, width: 500, height: 300 });
    await h.flush();
    expect(h.lastBounds()).toEqual({ x: 0, y: 0, width: 600, height: 420 }); // 推迟
    release();
    await shot;
    expect(h.lastBounds()).toEqual({ x: 10, y: 20, width: 500, height: 300 }); // 补摆（同步完成，不依赖再来一次 setBounds）
    expect(h.overrides()).toHaveLength(0);
  });

  it("没有被推迟的摆放就不补摆：截图前后 view.setBounds 的调用次数不变（不制造多余的原生视图重排）", async () => {
    const h = await scaledWithProbe();
    await h.flush();
    const before = h.setBounds.mock.calls.length;
    await h.tab.send(CAP, { format: "png" });
    await h.flush();
    expect(h.setBounds.mock.calls.length).toBe(before);
    expect(capturesIn(h.sent)).toHaveLength(1);
  });

  it("截图失败（CDP 报错）：不堵队列、不留「截图中」状态——被推迟的矩形仍然补摆，随后的 setBounds 立即落地、emulate 照常", async () => {
    const h = await scaledWithProbe();
    const release = holdCapture(h);
    h.failMethods[CAP] = "Cannot take screenshot with 0 width.";
    const shot = h.tab.send(CAP, { format: "png" });
    const settled = shot.then(
      () => "ok",
      (e: Error) => e.message,
    );
    await h.flush();
    h.tab.setBounds({ x: 0, y: 0, width: 300, height: 210 }); // 截图期间：推迟
    await h.flush();
    expect(h.lastBounds()).toEqual({ x: 0, y: 0, width: 600, height: 420 });
    release();
    expect(await settled).toMatch(/0 width/);
    await h.flush();
    expect(h.lastBounds().width).toBeLessThanOrEqual(300); // 失败路径也补摆
    expect(h.lastOverride()).toMatchObject({ scale: 0.3 }); // 排在后面的缩放重算没被堵
    delete h.failMethods[CAP];
    // 之后一切照常：矩形立即落地（#capturing 已复位）、emulate 能完成
    const callsBefore = h.setBounds.mock.calls.length;
    h.tab.setBounds({ x: 0, y: 0, width: 600, height: 420 });
    expect(h.setBounds.mock.calls.length).toBe(callsBefore + 1);
    await expect(h.tab.applyEmulation({ width: 800, height: 560 })).resolves.toBeTruthy();
  });

  it("只有截图排队：输入 / 求值 / 布局等其它 CDP 命令不被在飞的截图堵住（用户的真实操作不能等截图）", async () => {
    const h = await scaledWithProbe();
    const release = holdCapture(h);
    const shot = h.tab.send(CAP, { format: "png" });
    await h.flush();
    await h.tab.send("Runtime.evaluate", { expression: "1" });
    await h.tab.send("Input.dispatchKeyEvent", { type: "keyDown", key: "a" });
    const wire = await h.wireOf("Input.dispatchMouseEvent", { type: "mousePressed", x: 100, y: 100 });
    expect(wire).toMatchObject({ x: 60, y: 60 }); // 输入坐标补偿照旧（#sendNow 仍是唯一出口）
    expect(h.sent.some((s) => s.method === "Runtime.evaluate")).toBe(true);
    release();
    await shot;
  });

  it("标签页已关闭：队列里排着的截图以 TAB_NOT_FOUND 失败、不再发 CDP，队列不会留成永远挂起", async () => {
    const h = await scaledWithProbe();
    const release = holdCapture(h);
    const p1 = h.tab.send(CAP, { format: "png", n: 1 });
    const p2 = h.tab.send(CAP, { format: "png", n: 2 });
    const r2 = p2.then(
      () => "ok",
      (e: { code?: string }) => e.code,
    );
    await h.flush();
    h.tab.destroy();
    release();
    await p1.catch(() => {});
    expect(await r2).toBe("TAB_NOT_FOUND");
    expect(capturesIn(h.sent)).toHaveLength(1); // 第二条没有发出去
    await expect(h.tab.send(CAP, { format: "png" })).rejects.toMatchObject({ code: "TAB_NOT_FOUND" }); // 之后的也直接失败，不排队
  });

  // ───────── 第九轮评审：视图在父窗口之间搬动 × 截图在飞（B1 / P3-4）、收尾不抛（P3-5）、排队放弃（P3-3）、超时（P3-6）─────────

  /** 记「视图矩形 / 可见性」调用发生的顺序（断言「先补摆、后显示」） */
  const traceView = (h: ReturnType<typeof makeTab>) => {
    const log: string[] = [];
    h.setBounds.mockImplementation((b: Rect) => {
      log.push(`bounds:${b.width}x${b.height}`);
    });
    h.setVisible.mockImplementation((v: boolean) => {
      log.push(`visible:${v}`);
    });
    return log;
  };
  const PARK = `bounds:${PARKING_BOUNDS.width}x${PARKING_BOUNDS.height}`;
  const SLOT_LOG = `bounds:${SLOT.width}x${SLOT.height}`;
  /** 视图在停车场（矩形 = PARKING_BOUNDS）+ 一条被扣在 CDP 上的截图（在飞），之后的矩形 / 可见性调用记进 log */
  const parkedWithHeldShot = async () => {
    const h = makeTab();
    await h.tab.ready;
    const release = holdCapture(h);
    const shot = h.tab.send(CAP, { format: "png" });
    await h.flush();
    return { ...h, release, shot, log: traceView(h) };
  };

  it("第九轮 B1：截图在飞时视图从停车场搬进主窗口（面板打开 / 切标签页都走 moveToMain）：先藏着，不以停车场的 1280×800 可见地盖在主窗口上；截完先补摆槽位矩形、之后才显示", async () => {
    const h = await parkedWithHeldShot();
    h.tab.moveToMain(h.main as never, SLOT);
    expect(h.main.contentView.addChildView).toHaveBeenCalledTimes(1); // 已经挂进主窗口
    expect(h.log).toEqual(["visible:false"]); // 矩形不动（截完 Chromium 会把旧尺寸写回去）、视图藏着
    await h.flush();
    expect(h.log).toEqual(["visible:false"]);
    h.release();
    await h.shot;
    expect(h.log).toEqual(["visible:false", SLOT_LOG, "visible:true"]); // 先补摆、后显示
    expect(h.lastBounds()).toEqual(SLOT);
  });

  it("第九轮 B1 对照：没有截图在飞时 moveToMain 立刻摆矩形并显示（不多扣）", async () => {
    const h = makeTab();
    await h.tab.ready;
    const log = traceView(h);
    h.tab.moveToMain(h.main as never, SLOT);
    expect(log).toEqual([SLOT_LOG, "visible:true"]);
  });

  it("第九轮 B1：被遮盖（visible=false）的挂载本来就不显示，截完只补摆矩形，不会冒出来", async () => {
    const h = await parkedWithHeldShot();
    h.tab.moveToMain(h.main as never, SLOT, false);
    expect(h.log).toEqual(["visible:false"]);
    h.release();
    await h.shot;
    expect(h.log).toEqual(["visible:false", SLOT_LOG]);
  });

  it("第九轮 B1：被扣住期间弹层打开（setVisible(false)）→ 截完不显示；被遮盖挂载期间弹层关闭（setVisible(true)）→ 矩形仍是停车场尺寸就继续扣、截完补摆后显示", async () => {
    const a = await parkedWithHeldShot();
    a.tab.moveToMain(a.main as never, SLOT);
    a.tab.setVisible(false); // 弹层打开：撤销被扣住的显示
    a.release();
    await a.shot;
    expect(a.log).toEqual(["visible:false", "visible:false", SLOT_LOG]); // 没有 visible:true

    const b = await parkedWithHeldShot();
    b.tab.moveToMain(b.main as never, SLOT, false);
    b.tab.setVisible(true); // 弹层关闭：矩形还是停车场尺寸、截图还在飞 → 继续扣
    expect(b.log).toEqual(["visible:false", "visible:false"]);
    b.release();
    await b.shot;
    expect(b.log).toEqual(["visible:false", "visible:false", SLOT_LOG, "visible:true"]);
  });

  it("第九轮 B1：矩形已经是槽位矩形（面板开着时切标签页 / 重挂载）时不扣——立刻显示，最多偏一点，不会有大视图盖界面", async () => {
    const h = makeTab();
    await h.tab.ready;
    h.tab.moveToMain(h.main as never, SLOT); // 矩形 = 槽位
    const release = holdCapture(h);
    const shot = h.tab.send(CAP, { format: "png" });
    await h.flush();
    const log = traceView(h);
    h.tab.moveToMain(h.main as never, { ...SLOT, width: 1500 }); // 截图在飞时重挂：矩形推迟、可见性照常
    expect(log).toEqual(["visible:true"]);
    release();
    await shot;
    expect(log).toEqual(["visible:true", `bounds:1500x${SLOT.height}`]);
  });

  it("第九轮 B1：被扣住时又被停回停车场——不留尾巴：截完既不按槽位补摆、也不再显示", async () => {
    const h = await parkedWithHeldShot();
    h.tab.moveToMain(h.main as never, SLOT);
    h.tab.moveToParking(h.parking as never);
    const after = [...h.log];
    expect(after).toEqual(["visible:false", PARK, "visible:true"]);
    h.release();
    await h.shot;
    expect(h.log).toEqual(after); // 截完没有任何多余的矩形 / 可见性调用
  });

  it("第九轮 P3-4：截图在飞时停进停车场——停车场矩形等截完才摆（此刻改，截完 Chromium 写回的是旧尺寸：真 Electron 实测页面视口停在面板槽位的大小）", async () => {
    const h = makeTab();
    await h.tab.ready;
    h.tab.moveToMain(h.main as never, SLOT); // 矩形 = 槽位（截图开始时 Chromium 记下的就是它）
    const release = holdCapture(h);
    const shot = h.tab.send(CAP, { format: "png" });
    await h.flush();
    const log = traceView(h);
    h.tab.moveToParking(h.parking as never);
    expect(h.parking.contentView.addChildView).toHaveBeenCalledTimes(2); // 构造时一次 + 这次：已经搬走
    expect(log).toEqual(["visible:true"]); // 矩形没动
    release();
    await shot;
    expect(log).toEqual(["visible:true", PARK]); // 截完才摆
    expect(h.lastBounds()).toEqual(PARKING_BOUNDS);
  });

  it("第九轮 P3-4 对照：没有截图在飞时停车——立刻摆停车场矩形", async () => {
    const h = makeTab();
    await h.tab.ready;
    h.tab.moveToMain(h.main as never, SLOT);
    const log = traceView(h);
    h.tab.moveToParking(h.parking as never);
    expect(log).toEqual([PARK, "visible:true"]);
  });

  it("第九轮 P3-4：截图在飞时停进停车场、又被搬回主窗口——只按最新槽位补摆一次，不会再摆成停车场矩形", async () => {
    const h = makeTab();
    await h.tab.ready;
    h.tab.moveToMain(h.main as never, SLOT);
    const release = holdCapture(h);
    const shot = h.tab.send(CAP, { format: "png" });
    await h.flush();
    const log = traceView(h);
    h.tab.moveToParking(h.parking as never);
    h.tab.moveToMain(h.main as never, { ...SLOT, width: 1400 });
    release();
    await shot;
    expect(log.filter((x) => x.startsWith("bounds:"))).toEqual([`bounds:1400x${SLOT.height}`]);
    expect(h.lastBounds()).toEqual({ ...SLOT, width: 1400 });
  });

  it("第九轮 P3-5 / 第十轮 B-1：收尾补摆抛错不盖掉截图结果；矩形没摆成就继续藏着（不以停车场的 1280×800 可见地盖住主窗口），下一次摆放成功才显示（第十轮评审 B-1）", async () => {
    const h = await parkedWithHeldShot();
    h.tab.moveToMain(h.main as never, SLOT);
    h.setBounds.mockImplementationOnce(() => {
      throw new Error("Object has been destroyed");
    });
    h.release();
    await expect(h.shot).resolves.toBeTruthy(); // 截图结果还在
    // 补摆那次 setBounds 抛了、矩形还是停车场尺寸：不能把视图显示出来（这就是 B1 的 1280×800 盖住主窗口），一条 visible:true 都没有
    expect(h.log).toEqual(["visible:false"]);
    // 下一次摆放成功（拖面板 / 重挂载 / 切标签页都经 #applySlot）：矩形换成槽位矩形，随即放开被扣住的显示——不会一直藏着
    h.tab.setBounds({ ...SLOT, width: 500 });
    expect(h.log).toEqual(["visible:false", `bounds:500x${SLOT.height}`, "visible:true"]);
    // 放开之后恢复常态：再来的摆放不再多发一次 setVisible
    h.tab.setBounds({ ...SLOT, width: 600 });
    expect(h.log).toEqual(["visible:false", `bounds:500x${SLOT.height}`, "visible:true", `bounds:600x${SLOT.height}`]);
  });

  it("第十轮 B-1 对照：视图在停车场里（没有槽位，矩形本来就是停车场尺寸）时被扣住的显示照常放开——新规则只拦「有槽位、矩形却没摆成」", async () => {
    const h = await parkedWithHeldShot();
    h.tab.setVisible(true); // 视图在停车场（矩形 = PARKING_BOUNDS）、截图在飞：显示被扣住
    expect(h.log).toEqual(["visible:false"]);
    h.release();
    await h.shot;
    expect(h.log).toEqual(["visible:false", "visible:true"]);
  });

  // ───────── 第十一轮评审 P3-2：收尾补摆失败之后的 setVisible(true) 旁路 + 兜底重摆 ─────────

  /** 同 parkedWithHeldShot，但换成假定时器（兜底重摆是 300 ms 的定时器）：调用方负责 `vi.useRealTimers()` */
  const parkedWithHeldShotFake = async () => {
    const h = makeTab();
    await h.tab.ready;
    const release = holdCapture(h);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const shot = h.tab.send(CAP, { format: "png" });
    await vi.advanceTimersByTimeAsync(0);
    expect(capturesIn(h.sent)).toHaveLength(1);
    return { ...h, release, shot, log: traceView(h) };
  };
  const throwOnce = (h: { setBounds: ReturnType<typeof vi.fn> }) =>
    h.setBounds.mockImplementationOnce(() => {
      throw new Error("Object has been destroyed");
    });

  it("第十一轮 P3-2 / 第十轮 B-1 旁路：收尾补摆失败后（截图已结束、视图藏着、矩形还是停车场尺寸），弹层放开的 setVisible(true) 不能直接把视图显示出来——仍扣住，下一次摆放成功才显示", async () => {
    const h = await parkedWithHeldShot();
    h.tab.moveToMain(h.main as never, SLOT);
    throwOnce(h);
    h.release();
    await h.shot;
    expect(h.log).toEqual(["visible:false"]); // 补摆那次抛了
    h.tab.setVisible(true); // 截图早结束了：以前要求「截图在飞」才扣，这一下会直接显示出一块 1280×800 的视图
    expect(h.log).toEqual(["visible:false", "visible:false"]);
    h.tab.setVisible(false); // 弹层又打开：撤销扣住，照常藏着
    h.tab.setVisible(true); // 又关：矩形仍是停车场尺寸 → 再扣
    expect(h.log).toEqual(["visible:false", "visible:false", "visible:false", "visible:false"]);
    h.tab.setBounds({ ...SLOT, width: 500 }); // 下一次摆放成功：矩形换成槽位矩形，随即放开
    expect(h.log).toEqual(["visible:false", "visible:false", "visible:false", "visible:false", `bounds:500x${SLOT.height}`, "visible:true"]);
  });

  it("第十一轮 P3-2：收尾补摆失败后兜底重摆一次——重摆成功就放开显示（面板不会一直空白到下一次拖动 / 切换）；放开之后不再有多余调用", async () => {
    const h = await parkedWithHeldShotFake();
    try {
      h.tab.moveToMain(h.main as never, SLOT);
      throwOnce(h);
      h.release();
      await h.shot;
      expect(h.log).toEqual(["visible:false"]);
      await vi.advanceTimersByTimeAsync(299);
      expect(h.log).toEqual(["visible:false"]); // 还没到点
      await vi.advanceTimersByTimeAsync(2);
      expect(h.log).toEqual(["visible:false", SLOT_LOG, "visible:true"]); // 先补摆、后显示
      expect(h.lastBounds()).toEqual(SLOT);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(h.log).toEqual(["visible:false", SLOT_LOG, "visible:true"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("第十一轮 P3-2：兜底重摆排着时下一次布局先摆成功了（显示已放开）——到点不再多摆一次", async () => {
    const h = await parkedWithHeldShotFake();
    try {
      h.tab.moveToMain(h.main as never, SLOT);
      throwOnce(h);
      h.release();
      await h.shot;
      h.tab.setBounds({ ...SLOT, width: 500 }); // 拖面板：摆成功，随即放开显示
      expect(h.log).toEqual(["visible:false", `bounds:500x${SLOT.height}`, "visible:true"]);
      const n = h.setBounds.mock.calls.length;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(h.setBounds.mock.calls.length).toBe(n); // 兜底重摆到点：已经放开，什么都不做
      expect(h.log).toEqual(["visible:false", `bounds:500x${SLOT.height}`, "visible:true"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("第十一轮 P3-2：兜底重摆排着时又来一条截图并同样补摆失败——不叠第二个定时器（同一时刻最多一个）", async () => {
    const h = await parkedWithHeldShotFake();
    try {
      h.tab.moveToMain(h.main as never, SLOT);
      h.setBounds.mockImplementation(() => {
        throw new Error("persistent");
      });
      h.release();
      await h.shot;
      const timers = vi.getTimerCount(); // 含第一个兜底重摆
      const release2 = holdCapture(h);
      const shot2 = h.tab.send(CAP, { format: "png" });
      await vi.advanceTimersByTimeAsync(0);
      release2();
      await shot2; // 第二条截图的收尾又补摆失败、又走到「排兜底重摆」
      expect(vi.getTimerCount()).toBe(timers);
    } finally {
      vi.useRealTimers();
    }
  });

  it("第十一轮 P3-2：兜底重摆也失败——停手（只试一次、不循环）、仍藏着；之后一次成功的摆放照常放开", async () => {
    const h = await parkedWithHeldShotFake();
    try {
      h.tab.moveToMain(h.main as never, SLOT);
      const base = h.setBounds.mock.calls.length;
      h.setBounds.mockImplementation(() => {
        throw new Error("persistent");
      });
      h.release();
      await h.shot;
      expect(h.setBounds.mock.calls.length).toBe(base + 1); // 收尾补摆（抛）
      await vi.advanceTimersByTimeAsync(300);
      expect(h.setBounds.mock.calls.length).toBe(base + 2); // 兜底重摆（又抛）
      await vi.advanceTimersByTimeAsync(60_000);
      expect(h.setBounds.mock.calls.length).toBe(base + 2); // 不再试
      expect(h.log).toEqual(["visible:false"]);
      h.setBounds.mockImplementation((b: Rect) => {
        h.log.push(`bounds:${b.width}x${b.height}`);
      });
      h.tab.setBounds({ ...SLOT, width: 500 });
      expect(h.log).toEqual(["visible:false", `bounds:500x${SLOT.height}`, "visible:true"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("第十一轮 P3-2：兜底重摆到点时又有一条截图在飞——不动矩形（#applySlot 自己推迟）；那条截图一结束就补摆并放开显示，不必再等一轮定时器", async () => {
    const h = await parkedWithHeldShotFake();
    try {
      h.tab.moveToMain(h.main as never, SLOT);
      throwOnce(h);
      h.release();
      await h.shot;
      expect(h.log).toEqual(["visible:false"]);
      const release2 = holdCapture(h);
      const shot2 = h.tab.send(CAP, { format: "png" });
      await vi.advanceTimersByTimeAsync(0);
      expect(capturesIn(h.sent)).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(400); // 兜底重摆到点：截图在飞，矩形不动（重摆被推迟到那条截图的收尾）
      expect(h.log).toEqual(["visible:false"]);
      release2();
      await shot2; // 没有再推进定时器：收尾（#afterCapture）立刻补摆、显示
      expect(h.log).toEqual(["visible:false", SLOT_LOG, "visible:true"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("第十一轮 P3-2：兜底重摆排着时视图被停回停车场 / 被销毁——到点什么都不做；销毁还会清掉定时器", async () => {
    const a = await parkedWithHeldShotFake();
    try {
      a.tab.moveToMain(a.main as never, SLOT);
      throwOnce(a);
      a.release();
      await a.shot;
      a.tab.moveToParking(a.parking as never); // #park：摆停车场矩形、放开扣住（视图在停车场里就是该显示）
      const after = [...a.log];
      await vi.advanceTimersByTimeAsync(5_000);
      expect(a.log).toEqual(after); // 兜底重摆到点：#showHeld 已经是 false，没有任何多余调用
    } finally {
      vi.useRealTimers();
    }
    const b = await parkedWithHeldShotFake();
    try {
      b.tab.moveToMain(b.main as never, SLOT);
      throwOnce(b);
      b.release();
      await b.shot;
      const timers = vi.getTimerCount();
      b.tab.destroy();
      expect(vi.getTimerCount()).toBe(timers - 1); // 兜底重摆的定时器被清掉
      const n = b.log.length;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(b.log).toHaveLength(n);
    } finally {
      vi.useRealTimers();
    }
  });

  // ───────── 第十二轮评审 P3-5：不在截图中进入「扣住」时也排兜底重摆（原先只有 #afterCapture 排，遮盖正开着时补摆失败就没人排）─────────

  it("第十二轮 P3-5：补摆失败时遮盖正开着（#showHeld 为假、收尾不排重试）——之后遮盖放开的 setVisible(true) 才第一次扣住，就地排一次兜底重摆，成功就放开显示（面板不会空白到下一次布局）", async () => {
    const h = await parkedWithHeldShotFake();
    try {
      const base = vi.getTimerCount(); // 含那条在飞截图的 20 秒命令超时
      h.tab.moveToMain(h.main as never, SLOT, false); // 遮盖开着：visible=false，矩形被推迟到截图结束
      throwOnce(h); // 收尾补摆那次 setBounds 抛
      h.release();
      await h.shot;
      expect(h.log).toEqual(["visible:false"]); // 补摆抛了、矩形仍是停车场尺寸
      expect(vi.getTimerCount()).toBe(base - 1); // 命令超时已清；#showHeld 为假 → 收尾没排兜底重摆
      h.tab.setVisible(true); // 遮盖放开：有槽位 + 矩形仍是停车场尺寸 → 扣住（这一下以前没人排重试）
      expect(h.log).toEqual(["visible:false", "visible:false"]);
      expect(vi.getTimerCount()).toBe(base); // 就地排了一个兜底重摆
      await vi.advanceTimersByTimeAsync(299);
      expect(h.log).toEqual(["visible:false", "visible:false"]); // 还没到点
      await vi.advanceTimersByTimeAsync(2);
      expect(h.log).toEqual(["visible:false", "visible:false", SLOT_LOG, "visible:true"]); // 先补摆、后显示
      expect(h.lastBounds()).toEqual(SLOT);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(h.log).toEqual(["visible:false", "visible:false", SLOT_LOG, "visible:true"]); // 放开之后没有多余调用
    } finally {
      vi.useRealTimers();
    }
  });

  it("第十二轮 P3-5：遮盖反复开关也不叠定时器（同一时刻最多一个）；兜底重摆也失败就停手，之后一次成功的摆放照常放开", async () => {
    const h = await parkedWithHeldShotFake();
    try {
      h.tab.moveToMain(h.main as never, SLOT, false);
      h.setBounds.mockImplementation(() => {
        throw new Error("persistent"); // 补摆、兜底重摆都抛
      });
      h.release();
      await h.shot;
      const idle = vi.getTimerCount();
      h.tab.setVisible(true);
      h.tab.setVisible(false);
      h.tab.setVisible(true);
      h.tab.setVisible(true);
      expect(vi.getTimerCount()).toBe(idle + 1); // 扣住了三次、只排一个
      const before = h.setBounds.mock.calls.length;
      await vi.advanceTimersByTimeAsync(300);
      expect(h.setBounds.mock.calls.length).toBe(before + 1); // 兜底重摆试了一次（又抛）
      expect(vi.getTimerCount()).toBe(idle); // 停手：没有再排
      await vi.advanceTimersByTimeAsync(60_000);
      expect(h.setBounds.mock.calls.length).toBe(before + 1);
      // 之后遮盖再开关一次：又是一次新的扣住，再给一次兜底机会（用户的操作触发、不是无限循环）
      h.setBounds.mockImplementation((b: Rect) => {
        h.log.push(`bounds:${b.width}x${b.height}`);
      });
      h.tab.setVisible(false);
      h.tab.setVisible(true);
      expect(vi.getTimerCount()).toBe(idle + 1);
      await vi.advanceTimersByTimeAsync(300);
      expect(h.log.slice(-2)).toEqual([SLOT_LOG, "visible:true"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("第十二轮 P3-5：截图在飞时的扣住不在这里排定时器（留给 #afterCapture：它在补摆之后才知道摆没摆成）；视图在停车场（没有槽位）时 setVisible(true) 照常显示、不排", async () => {
    const h = await parkedWithHeldShotFake();
    try {
      const base = vi.getTimerCount();
      h.tab.moveToMain(h.main as never, SLOT); // 截图在飞：扣住
      expect(h.log).toEqual(["visible:false"]);
      expect(vi.getTimerCount()).toBe(base); // 没有定时器
      h.release();
      await h.shot;
      expect(h.log).toEqual(["visible:false", SLOT_LOG, "visible:true"]);
    } finally {
      vi.useRealTimers();
    }
    const p = makeTab();
    await p.tab.ready;
    const log = traceView(p);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const base = vi.getTimerCount();
      p.tab.setVisible(true); // 在停车场里、没有槽位、没有截图：矩形本来就是停车场尺寸，照常显示
      expect(log).toEqual(["visible:true"]);
      expect(vi.getTimerCount()).toBe(base);
    } finally {
      vi.useRealTimers();
    }
  });

  // 以下到「第十轮评审」分节之前：标了「第十二轮」「第十一轮」的归各自那一轮，其余（收尾不抛 P3-5 / 排队放弃 P3-3 / 超时 P3-6）都是第九轮评审的用例，
  // 与上面那个「第十二轮评审 P3-5」分节无关（同名的 P3-5 / P3-6 标签在第九、十一、十二轮各有一批，标题里都带了轮次）。

  it("第九轮 P3-5：截图本身失败时，抛给调用方的是截图的错，不是收尾补摆的错", async () => {
    const h = await parkedWithHeldShot();
    h.tab.moveToMain(h.main as never, SLOT);
    h.failMethods[CAP] = "Cannot take screenshot with 0 width.";
    h.setBounds.mockImplementationOnce(() => {
      throw new Error("Object has been destroyed");
    });
    h.release();
    await expect(h.shot).rejects.toThrow(/0 width/);
  });

  it("第九轮 P3-3：排队中的截图在调用方放弃（signal 已 abort）后，出队时不再发 CDP、以 signal.reason 失败，后面的照常发——不白占队列", async () => {
    const h = await scaledWithProbe();
    const release = holdCapture(h);
    const ac = new AbortController();
    const p1 = h.tab.send(CAP, { format: "png", n: 1 });
    const p2 = h.tab.send(CAP, { format: "png", n: 2 }, null, undefined, { signal: ac.signal });
    const p3 = h.tab.send(CAP, { format: "png", n: 3 });
    const r2 = p2.then(
      () => "ok",
      (e: unknown) => e,
    );
    await h.flush();
    expect(capturesIn(h.sent)).toHaveLength(1); // 只有第一条在飞，另两条排着
    const reason = new Error("op 超时");
    ac.abort(reason);
    release();
    await Promise.all([p1, p3]);
    expect(await r2).toBe(reason);
    expect(capturesIn(h.sent).map((s) => s.params.n)).toEqual([1, 3]); // 第二条没发出去
    expect(h.stats.maxCapture).toBe(1);
  });

  it("第九轮 P3-3：signal 在发送前就已 abort——直接失败、不发 CDP、不置「截图中」（随后的槽位变化立即落地）", async () => {
    const h = await scaledWithProbe();
    const ac = new AbortController();
    ac.abort(new Error("已停止"));
    await expect(h.tab.send(CAP, { format: "png" }, null, undefined, { signal: ac.signal })).rejects.toThrow("已停止");
    expect(capturesIn(h.sent)).toHaveLength(0);
    const before = h.setBounds.mock.calls.length;
    h.tab.setBounds({ x: 0, y: 0, width: 590, height: 400 });
    expect(h.setBounds.mock.calls.length).toBe(before + 1);
  });

  it("第九轮 P3-6：截图在飞时页面卡死（CDP 一直不应答）：20 秒超时放掉互斥——普通截图卡死最长堵 20 秒、不是永久；被推迟的矩形随后落地，排在后面的 emulate 继续", async () => {
    const h = await scaledWithProbe();
    holdCapture(h); // 永不放行：页面卡死
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const shot = h.tab.send(CAP, { format: "png" });
      const settled = shot.then(
        () => "ok",
        (e: { code?: string }) => e.code,
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(capturesIn(h.sent)).toHaveLength(1);
      h.tab.setBounds({ x: 0, y: 0, width: 300, height: 210 }); // 推迟
      const emulating = h.tab.applyEmulation({ width: 500, height: 350 }); // 排在截图后面
      await vi.advanceTimersByTimeAsync(19_000);
      expect(h.overrides()).toHaveLength(0); // 19 秒：还在等，emulate 没发
      expect(h.lastBounds()).toEqual({ x: 0, y: 0, width: 600, height: 420 }); // 矩形仍推迟
      await vi.advanceTimersByTimeAsync(1_500); // 过 20 秒
      expect(await settled).toBe("TIMEOUT");
      await emulating; // 队列放开了：先是被推迟的缩放重算（拖面板排的，按最新槽位 300×210 → 0.3），再是这条 emulate
      expect(h.overrides()).toHaveLength(2);
      expect(h.overrides()[0]).toMatchObject({ width: 1000, height: 700, scale: 0.3 });
      expect(h.overrides()[1]).toMatchObject({ width: 500, height: 350 });
      const n = h.setBounds.mock.calls.length;
      h.tab.setBounds({ x: 0, y: 0, width: 400, height: 280 });
      expect(h.setBounds.mock.calls.length).toBe(n + 1); // #capturing 已复位：矩形立即落地
    } finally {
      vi.useRealTimers();
    }
  });

  it("第九轮 P3-6：截图失败时被推迟的矩形只能靠收尾补摆（没有任何模拟 → 不会排缩放重算来帮忙）——失败路径也补", async () => {
    const h = makeTab();
    await h.tab.ready;
    h.tab.moveToMain(h.main as never, { x: 0, y: 0, width: 600, height: 420 }); // 没有模拟
    const release = holdCapture(h);
    h.failMethods[CAP] = "Cannot take screenshot with 0 width.";
    const shot = h.tab.send(CAP, { format: "png" });
    const settled = shot.then(
      () => "ok",
      (e: Error) => e.message,
    );
    await h.flush();
    h.tab.setBounds({ x: 10, y: 20, width: 500, height: 300 }); // 推迟
    await h.flush();
    expect(h.lastBounds()).toEqual({ x: 0, y: 0, width: 600, height: 420 });
    release();
    expect(await settled).toMatch(/0 width/);
    expect(h.lastBounds()).toEqual({ x: 10, y: 20, width: 500, height: 300 }); // 同步完成：只能是 finally 补的
    expect(h.overrides()).toHaveLength(0);
  });

  // ───────── 第十轮评审：自愈重放（B-2）/ 透明背景截图的临界区（B-3）/ 收尾路径与别的交叉组合（测试缺口）─────────

  it("B-2：debugger 断开后 ensureCdp 自愈，里面的模拟重放排进模拟队列——在飞的截图结束后才发，不与截图交叉（否则被截图结束时写回的旧参数盖掉）", async () => {
    const h = await scaledWithProbe();
    const release = holdCapture(h);
    const shot = h.tab.send(CAP, { format: "png" });
    await h.flush();
    expect(capturesIn(h.sent)).toHaveLength(1);
    h.detach(); // 渲染进程崩溃重载之类：debugger 掉了，cdpReady = false、缩放比例归 1
    const healing = h.tab.ensureCdp();
    await h.flush();
    expect(h.sent.some((s) => s.method === "Page.enable")).toBe(true); // 自愈确实已经开始（重新 attach、初始化会话）
    expect(h.overrides()).toHaveLength(0); // 但重放（视口覆盖）排在截图后面：此刻一条都不能发
    release();
    await Promise.all([shot, healing]);
    expect(h.overrides()).toHaveLength(1);
    expect(h.lastOverride()).toMatchObject({ width: 1000, height: 700, scale: 0.6, dontSetVisibleSize: true });
    expect(h.stats.crossed).toBe(0);
    expect(h.info().fitScale).toBe(0.6);
  });

  it("B-2 对照：已经在模拟队列里的 emulate 遇到 debugger 断开——自愈的重放直接发、不再排队（排进自己所在的队列 = 等自己，死锁），emulate 照常完成", async () => {
    const h = await scaledWithProbe();
    h.detach();
    const outcome = await Promise.race([h.tab.applyEmulation({ width: 500, height: 350 }).then(() => "done"), new Promise<string>((r) => setTimeout(() => r("DEADLOCK"), 1500))]);
    expect(outcome).toBe("done");
    // 先按旧状态重放（1000×700 缩放到槽位），再套新的（500×350，槽位放得下、不缩放）
    expect(h.overrides().map((o) => `${o.width}x${o.height}`)).toEqual(["1000x700", "500x350"]);
  });

  it("第十一轮 P3-4：自愈（attach）里输入锁与主 frame 同步排在模拟重放之前——重放还在排队等在飞的截图时，AI 驱动期间的输入锁已经上了（用户输入不会在这段等待里漏进页面）", async () => {
    const h = await scaledWithProbe();
    const release = holdCapture(h);
    const shot = h.tab.send(CAP, { format: "png" });
    await h.flush();
    h.detach();
    await h.tab.setInputIgnored(true); // 断开期间 AI 开始驱动：cdpReady = false，只记下期望，不发命令
    h.sent.length = 0;
    const healing = h.tab.ensureCdp();
    await h.flush();
    expect(h.sent.some((s) => s.method === "Page.enable")).toBe(true); // 自愈已经开始
    expect(h.overrides()).toHaveLength(0); // 重放（视口覆盖）还卡在截图后面
    // ……但锁与主 frame 同步已经发在它前面了。
    // 一次自愈要发两条 Page.getFrameTree：装页内脚本（#installPageScripts）一条、同步主 frame（#syncMainFrameId）一条——只断言「有一条」，
    // 把主 frame 同步挪到重放之后也能过（装脚本那条就够）；所以数条数：重放还卡着时两条都已经发出，且第二条（主 frame 同步）排在输入锁之前
    const pre = h.sent.map((s) => s.method);
    const frameTrees = pre.flatMap((m, i) => (m === "Page.getFrameTree" ? [i] : []));
    expect(frameTrees).toHaveLength(2);
    expect(frameTrees[1]).toBeLessThan(pre.indexOf("Input.setIgnoreInputEvents"));
    expect(h.sent.find((s) => s.method === "Input.setIgnoreInputEvents")?.params).toEqual({ ignore: true });
    release();
    await Promise.all([shot, healing]);
    const names = h.sent.map((s) => s.method);
    expect(names.indexOf("Input.setIgnoreInputEvents")).toBeGreaterThan(-1);
    expect(names.indexOf("Input.setIgnoreInputEvents")).toBeLessThan(names.indexOf("Emulation.setDeviceMetricsOverride"));
    expect(h.lastOverride()).toMatchObject({ width: 1000, height: 700, scale: 0.6 }); // 重放照常完成
  });

  /** 背景覆盖命令与截图命令在 CDP 上的先后（设 / 还原按参数区分；截图记格式） */
  const BG = "Emulation.setDefaultBackgroundColorOverride";
  const bgAndCaps = (sent: Sent[]) =>
    sent.filter((s) => s.method === BG || s.method === CAP).map((s) => (s.method === CAP ? `cap:${String(s.params.format)}` : Object.keys(s.params).length > 0 ? "bg:set" : "bg:restore"));

  it("第十轮 B-3：omit_background 的「设透明背景 → 截 → 还原」在同一排他段里——两条并发的透明截图依次整套发完，不交错（交错会让第二张在背景已被还原后才截、不透明）", async () => {
    const h = await scaledWithProbe();
    const release = holdCapture(h);
    const p1 = h.tab.screenshot({ format: "png", omitBackground: true });
    const p2 = h.tab.screenshot({ format: "png", omitBackground: true });
    await h.flush();
    // 第一条占着排他段（它的截图被扣住）：第二条的「设背景」不能抢先发出去
    expect(bgAndCaps(h.sent)).toEqual(["bg:set", "cap:png"]);
    release();
    await Promise.all([p1, p2]);
    expect(bgAndCaps(h.sent)).toEqual(["bg:set", "cap:png", "bg:restore", "bg:set", "cap:png", "bg:restore"]);
    expect(h.stats.maxCapture).toBe(1);
    // 设置的是全透明、还原发的是空参数
    const bgs = h.sent.filter((s) => s.method === BG).map((s) => s.params);
    expect(bgs[0]).toEqual({ color: { r: 0, g: 0, b: 0, a: 0 } });
    expect(bgs[1]).toEqual({});
  });

  it("第十轮 B-3：透明截图与一条普通截图并发——普通截图不会夹在「设透明背景」与「还原」之间（不会被截成透明底）", async () => {
    const h = await scaledWithProbe();
    const p1 = h.tab.screenshot({ format: "png", omitBackground: true });
    const p2 = h.tab.screenshot({ format: "jpeg" });
    await Promise.all([p1, p2]);
    expect(bgAndCaps(h.sent)).toEqual(["bg:set", "cap:png", "bg:restore", "cap:jpeg"]);
  });

  it("第十轮 B-3：透明截图本身失败——背景照样还原，抛出的是截图的错，后面的截图照常（普通截图不带任何背景命令）", async () => {
    const h = await scaledWithProbe();
    h.failMethods[CAP] = "Cannot take screenshot with 0 width.";
    await expect(h.tab.screenshot({ format: "png", omitBackground: true })).rejects.toThrow(/0 width/);
    expect(bgAndCaps(h.sent)).toEqual(["bg:set", "cap:png", "bg:restore"]);
    delete h.failMethods[CAP];
    h.sent.length = 0;
    await h.tab.screenshot({ format: "jpeg" });
    expect(bgAndCaps(h.sent)).toEqual(["cap:jpeg"]);
  });

  it("测试缺口（第十一轮评审 P3-6）：透明截图排队期间调用方已放弃（signal abort）——出队时不发「设 / 截 / 还原」任何一条、以 signal.reason 失败，后面的照常", async () => {
    const h = await scaledWithProbe();
    const release = holdCapture(h);
    const ac = new AbortController();
    const p1 = h.tab.send(CAP, { format: "png", n: 1 });
    const p2 = h.tab.send(CAP, { format: "png", n: 2 }, null, undefined, { transparentBackground: true, signal: ac.signal });
    const p3 = h.tab.send(CAP, { format: "jpeg", n: 3 });
    const r2 = p2.then(
      () => "ok",
      (e: unknown) => e,
    );
    await h.flush();
    const reason = new Error("op 超时");
    ac.abort(reason);
    release();
    await Promise.all([p1, p3]);
    expect(await r2).toBe(reason);
    expect(bgAndCaps(h.sent)).toEqual(["cap:png", "cap:jpeg"]); // 被放弃的那条没有发任何背景命令，也没有截图
  });

  it("测试缺口（第十一轮评审 P3-6）：透明截图已经出队开始后调用方才放弃——整套照常发完（设 → 截 → 还原），不在中途把页面丢在透明底上", async () => {
    const h = await scaledWithProbe();
    const release = holdCapture(h);
    const ac = new AbortController();
    const p = h.tab.send(CAP, { format: "png" }, null, undefined, { transparentBackground: true, signal: ac.signal });
    await h.flush();
    expect(bgAndCaps(h.sent)).toEqual(["bg:set", "cap:png"]);
    ac.abort(new Error("op 超时"));
    release();
    await expect(p).resolves.toBeTruthy();
    expect(bgAndCaps(h.sent)).toEqual(["bg:set", "cap:png", "bg:restore"]);
  });

  it("第十一轮 P3-5：「设透明背景」那条本身失败——不发截图，但仍补发还原（「设」在 try 里：设超时 / 抛错后命令可能在页面恢复时才生效，不还原会把页面留成透明底），抛出的是「设」的错", async () => {
    const h = await scaledWithProbe();
    h.failMethods[BG] = "boom";
    await expect(h.tab.send(CAP, { format: "png" }, null, undefined, { transparentBackground: true })).rejects.toThrow(/boom/);
    expect(bgAndCaps(h.sent)).toEqual(["bg:set", "bg:restore"]); // 没有截图，但有还原
    delete h.failMethods[BG];
    h.sent.length = 0;
    await h.tab.screenshot({ format: "jpeg" }); // 后面的截图照常——但「设」与「还原」是同一个方法、failMethods 按名失败，这次的还原也被拒了 → 记欠：这条的排他段开头补发一次还原（第十三轮评审 P3-7）
    expect(bgAndCaps(h.sent)).toEqual(["bg:restore", "cap:jpeg"]);
    h.sent.length = 0;
    await h.tab.screenshot({ format: "jpeg" }); // 补成了：不再欠
    expect(bgAndCaps(h.sent)).toEqual(["cap:jpeg"]);
  });

  it("第十一轮 P3-5：「设透明背景」超时（页面整套卡死）——超时后照样补发还原；还原只等 5 秒、不是满 20 秒（整套卡死 = 设 20 + 还原 5 = 25 秒、不截图；45 秒是「设」差一点超时才应答、截图又卡住的理论上限，这里没有构造，见「第十二轮 P3-7」那条）", async () => {
    const h = await scaledWithProbe();
    h.gates[BG] = new Promise<void>(() => {}); // 页面卡死：背景命令（设 / 还原同一个方法）都不应答
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const shot = h.tab.send(CAP, { format: "png" }, null, undefined, { transparentBackground: true });
      let outcome = "pending";
      void shot.then(
        () => (outcome = "ok"),
        (e: { code?: string }) => (outcome = e.code ?? "ERR"),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(bgAndCaps(h.sent)).toEqual(["bg:set"]);
      await vi.advanceTimersByTimeAsync(19_900);
      expect(bgAndCaps(h.sent)).toEqual(["bg:set"]); // 设还在等
      await vi.advanceTimersByTimeAsync(200); // 20 秒到：设超时 → 不截图，直接补发还原
      expect(bgAndCaps(h.sent)).toEqual(["bg:set", "bg:restore"]);
      expect(outcome).toBe("pending"); // 还在等还原
      await vi.advanceTimersByTimeAsync(4_700); // 距还原发出 4.8 秒
      expect(outcome).toBe("pending");
      await vi.advanceTimersByTimeAsync(300); // 5 秒到：还原超时被吞，抛出的是「设」的超时
      expect(outcome).toBe("TIMEOUT");
      // 被吞的还原超时留一行日志（第十二轮评审 P3-6）：事后能知道这张截图之后页面可能留着透明底；「设」自己的超时是抛出去的那个，不重复记
      expect(h.logs.filter((l) => /透明截图后还原默认背景失败/.test(l))).toHaveLength(1);
      expect(h.logs.find((l) => /透明截图后还原默认背景失败/.test(l))).toMatch(/5000ms/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("第十一轮 P3-5：截图成功但「还原」那条卡住——只等 5 秒就放掉排他段，截图结果照常返回（不再白占满 20 秒的队列）", async () => {
    const h = await scaledWithProbe();
    const dbg = (h.tab as unknown as { wc: { debugger: { sendCommand: (m: string, p?: Record<string, unknown>) => Promise<unknown> } } }).wc.debugger;
    const inner = dbg.sendCommand;
    dbg.sendCommand = (method: string, params?: Record<string, unknown>) => {
      const p = inner(method, params); // 照常记进 h.sent
      return method === BG && Object.keys(params ?? {}).length === 0 ? new Promise<never>(() => {}) : p; // 还原永不应答
    };
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const shot = h.tab.send(CAP, { format: "png" }, null, undefined, { transparentBackground: true });
      let done = false;
      void shot.then(
        () => (done = true),
        () => (done = true),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(bgAndCaps(h.sent)).toEqual(["bg:set", "cap:png", "bg:restore"]);
      await vi.advanceTimersByTimeAsync(4_900);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(200); // 5 秒到
      expect(done).toBe(true);
      await expect(shot).resolves.toBeTruthy(); // 截图结果还在
      expect(h.logs.filter((l) => /透明截图后还原默认背景失败/.test(l))).toHaveLength(1); // 还原超时被吞、但留了日志（第十二轮评审 P3-6）
    } finally {
      vi.useRealTimers();
    }
  });

  it("第十二轮 P3-6：还原抛错（CDP 报错，不是超时）——截图结果照常返回，日志里留一行带原因的话；成功的还原不记日志", async () => {
    const ok = await scaledWithProbe();
    await ok.tab.send(CAP, { format: "png" }, null, undefined, { transparentBackground: true });
    expect(bgAndCaps(ok.sent)).toEqual(["bg:set", "cap:png", "bg:restore"]);
    expect(ok.logs.filter((l) => /还原默认背景/.test(l))).toEqual([]); // 一切顺利：不留日志

    const h = await scaledWithProbe();
    const dbg = (h.tab as unknown as { wc: { debugger: { sendCommand: (m: string, p?: Record<string, unknown>) => Promise<unknown> } } }).wc.debugger;
    const inner = dbg.sendCommand;
    dbg.sendCommand = (method: string, params?: Record<string, unknown>) => {
      const p = inner(method, params); // 照常记进 h.sent
      return method === BG && Object.keys(params ?? {}).length === 0 ? p.then(() => Promise.reject(new Error("Session with given id not found"))) : p;
    };
    await expect(h.tab.send(CAP, { format: "png" }, null, undefined, { transparentBackground: true })).resolves.toBeTruthy();
    expect(bgAndCaps(h.sent)).toEqual(["bg:set", "cap:png", "bg:restore"]);
    const lines = h.logs.filter((l) => /透明截图后还原默认背景失败/.test(l));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/Session with given id not found/);
    expect(lines[0]).toContain("[browser:t1]");
  });

  it("第十二轮 P3-6 / P3-9：标签页在截图期间销毁（wc.isDestroyed 为真）——还原直接得到 TAB_NOT_FOUND、不发 CDP、不记日志（没有东西可还原），截图结果不被盖掉", async () => {
    const h = await scaledWithProbe();
    const release = holdCapture(h);
    const shot = h.tab.send(CAP, { format: "png" }, null, undefined, { transparentBackground: true });
    await h.flush();
    expect(bgAndCaps(h.sent)).toEqual(["bg:set", "cap:png"]);
    h.destroyWc(); // 假 wc 现在会如实回答 isDestroyed()（以前缺这个方法、wcGone() 永远判成没销毁）
    release();
    await expect(shot).resolves.toBeTruthy(); // 已经截下来的那张照常返回
    expect(bgAndCaps(h.sent)).toEqual(["bg:set", "cap:png"]); // 还原没发
    expect(h.logs.filter((l) => /还原默认背景/.test(l))).toEqual([]);
    await expect(h.tab.send(CAP, { format: "png" })).rejects.toMatchObject({ code: "TAB_NOT_FOUND" }); // 之后的命令一律 TAB_NOT_FOUND
  });

  it("第十二轮 P3-7：透明截图占队列的上限 45 秒——「设」差一点超时才应答（19.9 秒）、截图卡满 20 秒、还原卡满 5 秒；整套卡死是 25 秒（见上面「第十一轮 P3-5：「设透明背景」超时」那条），不是 45 秒", async () => {
    const h = await scaledWithProbe();
    const dbg = (h.tab as unknown as { wc: { debugger: { sendCommand: (m: string, p?: Record<string, unknown>) => Promise<unknown> } } }).wc.debugger;
    const inner = dbg.sendCommand;
    let answerSet: () => void = () => {};
    const setGate = new Promise<void>((r) => {
      answerSet = r;
    });
    dbg.sendCommand = (method: string, params?: Record<string, unknown>) => {
      const p = inner(method, params); // 照常记进 h.sent
      if (method === BG && Object.keys(params ?? {}).length > 0) return setGate.then(() => p); // 「设」：测试放行才应答
      if (method === CAP || method === BG) return new Promise<never>(() => {}); // 截图、还原：永不应答
      return p;
    };
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const shot = h.tab.send(CAP, { format: "png" }, null, undefined, { transparentBackground: true });
      let outcome = "pending";
      void shot.then(
        () => (outcome = "ok"),
        (e: { code?: string }) => (outcome = e.code ?? "ERR"),
      );
      await vi.advanceTimersByTimeAsync(19_900);
      expect(bgAndCaps(h.sent)).toEqual(["bg:set"]);
      answerSet(); // 19.9 秒：「设」刚好没超时
      await vi.advanceTimersByTimeAsync(0);
      expect(bgAndCaps(h.sent)).toEqual(["bg:set", "cap:png"]);
      await vi.advanceTimersByTimeAsync(20_000); // 39.9 秒：截图超时 → 补发还原
      expect(bgAndCaps(h.sent)).toEqual(["bg:set", "cap:png", "bg:restore"]);
      expect(outcome).toBe("pending");
      await vi.advanceTimersByTimeAsync(4_900); // 44.8 秒：还原还在等
      expect(outcome).toBe("pending");
      await vi.advanceTimersByTimeAsync(200); // 45.0 秒：整套结束（抛的是截图的超时）
      expect(outcome).toBe("TIMEOUT");
    } finally {
      vi.useRealTimers();
    }
  });

  it("第十二轮 P3-9：页面卡死后恢复——按「同一会话按序派发」的模型，晚到的「设」先生效、随后的「还原」盖住它，最终背景是默认的（模型来自对 CDP 的推断，没有在真页面卡死时实测）", async () => {
    const h = await scaledWithProbe();
    const dbg = (h.tab as unknown as { wc: { debugger: { sendCommand: (m: string, p?: Record<string, unknown>) => Promise<unknown> } } }).wc.debugger;
    const inner = dbg.sendCommand;
    // 页面背景状态按「命令实际生效」的先后更新：卡死期间挂在 gates[BG] 上的命令，页面恢复（放行）后按挂起的先后顺序继续、依次生效
    let background: "default" | "transparent" = "default";
    const applied: string[] = [];
    dbg.sendCommand = async (method: string, params?: Record<string, unknown>) => {
      const r = await inner(method, params);
      if (method === BG) {
        background = Object.keys(params ?? {}).length > 0 ? "transparent" : "default";
        applied.push(background);
      }
      return r;
    };
    let resume: () => void = () => {};
    h.gates[BG] = new Promise<void>((r) => {
      resume = r;
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const shot = h.tab.send(CAP, { format: "png" }, null, undefined, { transparentBackground: true });
      let outcome = "pending";
      void shot.then(
        () => (outcome = "ok"),
        (e: { code?: string }) => (outcome = e.code ?? "ERR"),
      );
      await vi.advanceTimersByTimeAsync(25_100); // 设超时（20 秒）→ 补发还原 → 还原超时（5 秒）：我们这一侧已经放弃等待
      expect(outcome).toBe("TIMEOUT");
      expect(bgAndCaps(h.sent)).toEqual(["bg:set", "bg:restore"]); // 没有截图
      expect(applied).toEqual([]); // 页面还卡着：两条都没生效
      resume(); // 页面恢复
      await vi.advanceTimersByTimeAsync(0);
      expect(applied).toEqual(["transparent", "default"]); // 按发出的顺序：先设后还原
      expect(background).toBe("default"); // 页面最终没有留着透明底
    } finally {
      vi.useRealTimers();
    }
  });

  // ───────── 第十三轮评审：P3-6 兜底重摆的定时器走注入版 / P3-4 浏览器侧测试缺口 / P3-7 透明截图「还原」失败后的欠账补发 ─────────

  /**
   * 手动假时钟（只交给 Tab 的 setTimeoutFn / clearTimeoutFn）：记下「谁排了什么、多久后」，由用例手动到点、看清掉了谁。
   * 与全局定时器无关——不受 vi.useFakeTimers 影响，真时间过去多久都不会触发。
   */
  const manualTimers = () => {
    const pending = new Map<number, { fn: () => void; ms: number }>();
    const cleared: number[] = [];
    let seq = 0;
    return {
      pending,
      cleared,
      setTimeoutFn: ((fn: () => void, ms: number) => {
        const id = ++seq;
        pending.set(id, { fn, ms });
        return id;
      }) as never,
      clearTimeoutFn: ((id: number) => {
        cleared.push(id);
        pending.delete(id);
      }) as never,
      /** 到点：先摘掉再触发（与真定时器一致：触发时它已经不在待触发里） */
      fire: (id: number) => {
        const t = pending.get(id);
        pending.delete(id);
        t?.fn();
      },
    };
  };

  it("第十三轮 P3-6：兜底重摆的定时器走注入的 setTimeoutFn / clearTimeoutFn——真时间过去也不触发、手动到点才补摆并放开显示；销毁时清的也是注入的那个（原先直接用全局 setTimeout / clearTimeout，注入假时钟的调用方管不到）", async () => {
    const t = manualTimers();
    const h = makeTab({ timers: t });
    await h.tab.ready;
    const release = holdCapture(h);
    const shot = h.tab.send(CAP, { format: "png" });
    await h.flush();
    const log = traceView(h);
    h.tab.moveToMain(h.main as never, SLOT);
    throwOnce(h);
    release();
    await shot;
    expect(log).toEqual(["visible:false"]); // 补摆抛了、继续藏着
    expect([...t.pending.values()].map((x) => x.ms)).toEqual([300]); // 注入的 setTimeoutFn 上排了一个 HELD_SHOW_RETRY_MS 的兜底重摆
    await new Promise((r) => setTimeout(r, 450)); // 真时间超过 300 ms：与注入的时钟无关，不触发
    expect(log).toEqual(["visible:false"]);
    t.fire([...t.pending.keys()][0]!);
    expect(log).toEqual(["visible:false", SLOT_LOG, "visible:true"]); // 手动到点：先补摆、后显示

    // 销毁：清的是注入的那个
    const t2 = manualTimers();
    const g = makeTab({ timers: t2 });
    await g.tab.ready;
    const release2 = holdCapture(g);
    const shot2 = g.tab.send(CAP, { format: "png" });
    await g.flush();
    g.tab.moveToMain(g.main as never, SLOT);
    throwOnce(g);
    release2();
    await shot2;
    const id = [...t2.pending.keys()][0]!;
    expect(t2.pending.size).toBe(1);
    g.tab.destroy();
    expect(t2.cleared).toEqual([id]);
    expect(t2.pending.size).toBe(0);
  });

  it("第十三轮 P3-4：#applyVisible 路径下遮盖反复开关、最终想显示（setVisible(true) 收尾）——重试到点前视图一次真正的 visible:true 都没有（落到视图上的最后一次一直是 setVisible(false)），到点补摆成功才显示", async () => {
    const h = await parkedWithHeldShotFake();
    try {
      h.tab.moveToMain(h.main as never, SLOT, false); // 遮盖开着
      throwOnce(h); // 收尾补摆抛
      h.release();
      await h.shot;
      h.tab.setVisible(true);
      h.tab.setVisible(false);
      h.tab.setVisible(true);
      h.tab.setVisible(true); // 最后想要的是「显示」
      expect(h.log.every((x) => x === "visible:false")).toBe(true); // 到点前没有任何 visible:true、没有任何 bounds
      expect(h.log.at(-1)).toBe("visible:false");
      await vi.advanceTimersByTimeAsync(299);
      expect(h.log.every((x) => x === "visible:false")).toBe(true);
      await vi.advanceTimersByTimeAsync(2);
      expect(h.log.slice(-2)).toEqual([SLOT_LOG, "visible:true"]); // 到点补摆成功才显示
    } finally {
      vi.useRealTimers();
    }
  });

  it("第十三轮 P3-4：扣住之后最终想要的是不显示（setVisible(false) 收尾）——兜底重摆到点什么都不做：视图保持隐藏、矩形不动", async () => {
    const h = await parkedWithHeldShotFake();
    try {
      h.tab.moveToMain(h.main as never, SLOT, false);
      throwOnce(h);
      h.release();
      await h.shot;
      h.tab.setVisible(true); // 扣住，排一个兜底重摆
      h.tab.setVisible(false); // 弹层又打开：撤销扣住（#showHeld 复位），定时器还排着
      expect(h.log.at(-1)).toBe("visible:false");
      const n = h.log.length;
      const calls = h.setBounds.mock.calls.length;
      await vi.advanceTimersByTimeAsync(5_000); // 到点
      expect(h.log).toHaveLength(n); // 没有 bounds、没有 visible
      expect(h.setBounds.mock.calls.length).toBe(calls);
    } finally {
      vi.useRealTimers();
    }
  });

  it("第十三轮 P3-4：透明截图整套卡死（设 20 秒超时 + 还原 5 秒 = 25 秒）期间面板打开——扣住的视图一直藏着、矩形不动（不以停车场的 1280×800 可见地盖住主窗口），25 秒整套结束后才补摆并显示", async () => {
    const h = makeTab();
    await h.tab.ready;
    h.gates[BG] = new Promise<void>(() => {}); // 页面卡死：背景命令（设 / 还原同一个方法）都不应答
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const shot = h.tab.send(CAP, { format: "png" }, null, undefined, { transparentBackground: true });
      let outcome = "pending";
      void shot.then(
        () => (outcome = "ok"),
        (e: { code?: string }) => (outcome = e.code ?? "ERR"),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(bgAndCaps(h.sent)).toEqual(["bg:set"]);
      const log = traceView(h);
      h.tab.moveToMain(h.main as never, SLOT); // 面板打开：视图从停车场搬进主窗口
      expect(log).toEqual(["visible:false"]); // 扣住：矩形不动
      await vi.advanceTimersByTimeAsync(24_900);
      expect(outcome).toBe("pending");
      expect(log).toEqual(["visible:false"]); // 卡死的整个期间：视图一直藏着、矩形不动
      await vi.advanceTimersByTimeAsync(200); // 25 秒：设超时 → 不截图 → 还原超时，整套结束
      expect(outcome).toBe("TIMEOUT");
      expect(log).toEqual(["visible:false", SLOT_LOG, "visible:true"]); // 收尾：先补摆、后显示
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * 「还原」（BG 且参数为空）的行为开关：ok = 照常；fast = 应答后抛 CDP 错误（页面活着、命令被拒）；hang = 永不应答（页面卡死）；
   * failN > 0 = 接下来的 failN 条「还原」按 fast 失败、之后回到 v（用来造「补发失败、随后自己的还原成功」）。
   * 包在 sendCommand 外面，照常把命令记进 h.sent；子会话 id 原样往里传。
   */
  const restoreMode = (h: { tab: unknown }) => {
    const dbg = (h.tab as { wc: { debugger: { sendCommand: (m: string, p?: Record<string, unknown>, s?: string) => Promise<unknown> } } }).wc.debugger;
    const inner = dbg.sendCommand;
    const mode = { v: "ok" as "ok" | "fast" | "hang", failN: 0 };
    dbg.sendCommand = (method: string, params?: Record<string, unknown>, sessionId?: string) => {
      const p = inner(method, params, sessionId);
      if (method === BG && Object.keys(params ?? {}).length === 0) {
        if (mode.failN > 0) {
          mode.failN--;
          return p.then(() => Promise.reject(new Error("Session with given id not found")));
        }
        if (mode.v === "fast") return p.then(() => Promise.reject(new Error("Session with given id not found")));
        if (mode.v === "hang") return new Promise<never>(() => {});
      }
      return p;
    };
    return mode;
  };
  const TRANSPARENT = { transparentBackground: true } as const;
  const OWED = /补发上一条透明截图欠下的/;

  it("第十三轮 P3-7：透明截图的「还原」快速失败（页面活着、CDP 报错）→ 记欠；下一条截图的排他段开头补发一次 {}，补成了就不再欠", async () => {
    const h = await scaledWithProbe();
    const mode = restoreMode(h);
    mode.v = "fast";
    await expect(h.tab.send(CAP, { format: "png" }, null, undefined, TRANSPARENT)).resolves.toBeTruthy(); // 截图结果照常
    expect(bgAndCaps(h.sent)).toEqual(["bg:set", "cap:png", "bg:restore"]);
    mode.v = "ok";
    h.sent.length = 0;
    await h.tab.screenshot({ format: "jpeg" }); // 普通截图：开头先补发欠下的还原，再截
    expect(bgAndCaps(h.sent)).toEqual(["bg:restore", "cap:jpeg"]);
    expect(h.sent.filter((s) => s.method === BG).map((s) => s.params)).toEqual([{}]); // 补发的是「还原」（空参数）
    h.sent.length = 0;
    await h.tab.screenshot({ format: "jpeg" }); // 补成了：不再欠、不再多发
    expect(bgAndCaps(h.sent)).toEqual(["cap:jpeg"]);
  });

  it("第十三轮 P3-7：补发仍失败——这条截图照常、日志留一行、继续欠着（下一条再补）；补发成功后才不再欠", async () => {
    const h = await scaledWithProbe();
    const mode = restoreMode(h);
    mode.v = "fast";
    await h.tab.send(CAP, { format: "png" }, null, undefined, TRANSPARENT);
    h.sent.length = 0;
    await expect(h.tab.screenshot({ format: "jpeg" })).resolves.toBeTruthy(); // 补发也失败（还原仍被拒）：不挡这条截图
    expect(bgAndCaps(h.sent)).toEqual(["bg:restore", "cap:jpeg"]);
    expect(h.logs.filter((l) => OWED.test(l))).toHaveLength(1);
    expect(h.logs.find((l) => OWED.test(l))).toMatch(/继续欠着.*Session with given id not found/);
    h.sent.length = 0;
    await h.tab.screenshot({ format: "jpeg" }); // 仍欠着：再补一次
    expect(bgAndCaps(h.sent)).toEqual(["bg:restore", "cap:jpeg"]);
    mode.v = "ok";
    h.sent.length = 0;
    await h.tab.screenshot({ format: "jpeg" }); // 这次补成了
    expect(bgAndCaps(h.sent)).toEqual(["bg:restore", "cap:jpeg"]);
    h.sent.length = 0;
    await h.tab.screenshot({ format: "jpeg" });
    expect(bgAndCaps(h.sent)).toEqual(["cap:jpeg"]); // 不再欠
  });

  it("第十三轮 P3-7：「还原」超时（页面卡死）也记欠——页面恢复后的下一条截图先补发再截", async () => {
    const h = await scaledWithProbe();
    const mode = restoreMode(h);
    mode.v = "hang";
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const shot = h.tab.send(CAP, { format: "png" }, null, undefined, TRANSPARENT);
      await vi.advanceTimersByTimeAsync(5_100); // 截图成功；还原等满 5 秒放掉（被吞，记欠）
      await expect(shot).resolves.toBeTruthy();
      expect(h.logs.filter((l) => /透明截图后还原默认背景失败/.test(l))).toHaveLength(1);
      mode.v = "ok"; // 页面恢复
      h.sent.length = 0;
      await h.tab.screenshot({ format: "jpeg" });
      expect(bgAndCaps(h.sent)).toEqual(["bg:restore", "cap:jpeg"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("第十三轮 P3-7：欠着时下一条是透明截图——先补发、再设 / 截 / 还原；整套成功后不再欠", async () => {
    const h = await scaledWithProbe();
    const mode = restoreMode(h);
    mode.v = "fast";
    await h.tab.send(CAP, { format: "png" }, null, undefined, TRANSPARENT);
    mode.v = "ok";
    h.sent.length = 0;
    await h.tab.send(CAP, { format: "png" }, null, undefined, TRANSPARENT);
    expect(bgAndCaps(h.sent)).toEqual(["bg:restore", "bg:set", "cap:png", "bg:restore"]);
    h.sent.length = 0;
    await h.tab.screenshot({ format: "jpeg" });
    expect(bgAndCaps(h.sent)).toEqual(["cap:jpeg"]);
  });

  it("第十三轮 P3-7：欠着时排队期间被放弃的截图什么都不发（补发放在 signal 检查之后），欠账留给下一条没被放弃的截图", async () => {
    const h = await scaledWithProbe();
    const mode = restoreMode(h);
    mode.v = "fast";
    await h.tab.send(CAP, { format: "png" }, null, undefined, TRANSPARENT);
    mode.v = "ok";
    h.sent.length = 0;
    const ac = new AbortController();
    ac.abort(new Error("op 超时"));
    await expect(h.tab.send(CAP, { format: "png" }, null, undefined, { signal: ac.signal })).rejects.toThrow(/op 超时/);
    expect(bgAndCaps(h.sent)).toEqual([]); // 被放弃的截图：补发也没发
    await h.tab.screenshot({ format: "jpeg" });
    expect(bgAndCaps(h.sent)).toEqual(["bg:restore", "cap:jpeg"]); // 欠账还在，留给了这一条
  });

  it("第十四轮 P3-4 ①：补发（页面卡死时最多等 5 秒）期间调用方放弃了——补发之后不再发这条截图、以 signal.reason 失败；欠账不动，留给下一条没被放弃的截图", async () => {
    const h = await scaledWithProbe();
    const mode = restoreMode(h);
    mode.v = "fast";
    await h.tab.send(CAP, { format: "png" }, null, undefined, TRANSPARENT); // 记欠
    mode.v = "hang"; // 页面卡死：补发发出去、不应答
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      h.sent.length = 0;
      const ac = new AbortController();
      const shot = h.tab.send(CAP, { format: "png" }, null, undefined, { signal: ac.signal });
      const outcome = shot.then(
        () => "ok",
        (e: Error) => e.message,
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(bgAndCaps(h.sent)).toEqual(["bg:restore"]); // 出队：先补发（卡住）
      ac.abort(new Error("op 超时")); // 补发等待期间，op 超时 / 用户点了停止
      await vi.advanceTimersByTimeAsync(5_100); // 补发等满 5 秒放掉
      expect(await outcome).toBe("op 超时");
      expect(bgAndCaps(h.sent), "补发之后不该再发已被放弃的那条截图").toEqual(["bg:restore"]);
      mode.v = "ok"; // 页面恢复
      h.sent.length = 0;
      await h.tab.screenshot({ format: "jpeg" });
      expect(bgAndCaps(h.sent)).toEqual(["bg:restore", "cap:jpeg"]); // 欠账还在，留给了下一条
    } finally {
      vi.useRealTimers();
    }
  });

  it("第十五轮评审 P3-4（①b）：补发期间调用方放弃——排他段照常放掉：#capturing 复位、补发期间被推迟的矩形与被扣住的显示由 #afterCapture 补上（不带模拟的标签：有模拟时每次槽位变化都排缩放重算、它自己会顺带摆矩形，盖住「#afterCapture 没跑」这种回归）", async () => {
    const h = makeTab();
    await h.tab.ready;
    const mode = restoreMode(h);
    mode.v = "fast";
    await h.tab.send(CAP, { format: "png" }, null, undefined, TRANSPARENT); // 记欠
    mode.v = "hang"; // 页面卡死：补发发出去、不应答
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      h.sent.length = 0;
      const log = traceView(h);
      const ac = new AbortController();
      const shot = h.tab.send(CAP, { format: "png" }, null, undefined, { signal: ac.signal });
      const outcome = shot.then(
        () => "ok",
        (e: Error) => e.message,
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(bgAndCaps(h.sent)).toEqual(["bg:restore"]); // 出队：先补发（卡住），此刻排他段已经占着（#capturing 为真）
      h.tab.moveToMain(h.main as never, SLOT); // 补发等待期间面板打开：矩形推迟、显示扣住
      expect(log).toEqual(["visible:false"]);
      ac.abort(new Error("op 超时"));
      await vi.advanceTimersByTimeAsync(5_100); // 补发等满 5 秒放掉 → 抛 abandoned → finally 复位 #capturing、跑 #afterCapture
      expect(await outcome).toBe("op 超时");
      expect(bgAndCaps(h.sent), "补发之后不该再发已被放弃的那条截图").toEqual(["bg:restore"]);
      expect(log, "#afterCapture：先补摆槽位矩形、后显示").toEqual(["visible:false", SLOT_LOG, "visible:true"]);
      h.tab.setBounds({ ...SLOT, x: SLOT.x + 10 });
      expect(log.at(-1), "#capturing 已复位：之后的槽位变化立即落地").toBe(SLOT_LOG);
      expect(log).toHaveLength(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("第十四轮 P3-4 ⑥：补发自己的上限是 5 秒——页面卡死时补发等满 5 秒就放掉、截图照发（不是等满 CDP 的 20 秒）；仍卡着就继续欠着、留一行日志", async () => {
    const h = await scaledWithProbe();
    const mode = restoreMode(h);
    mode.v = "fast";
    await h.tab.send(CAP, { format: "png" }, null, undefined, TRANSPARENT); // 记欠
    mode.v = "hang";
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      h.sent.length = 0;
      const shot = h.tab.send(CAP, { format: "png" });
      await vi.advanceTimersByTimeAsync(4_900);
      expect(bgAndCaps(h.sent)).toEqual(["bg:restore"]); // 5 秒之内：还在等补发，截图没发
      await vi.advanceTimersByTimeAsync(200); // 5.1 秒
      expect(bgAndCaps(h.sent), "补发应在 5 秒放掉、截图随后照发——不是等满 20 秒").toEqual(["bg:restore", "cap:png"]);
      await expect(shot).resolves.toBeTruthy();
      expect(h.logs.filter((l) => OWED.test(l))).toHaveLength(1);
      expect(h.logs.find((l) => OWED.test(l))).toMatch(/继续欠着/);
      mode.v = "ok"; // 页面恢复：主会话继续欠着，这一条补成
      h.sent.length = 0;
      await h.tab.screenshot({ format: "jpeg" });
      expect(bgAndCaps(h.sent)).toEqual(["bg:restore", "cap:jpeg"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("第十四轮 P3-4 ⑦：注入的假时钟在 setTimeoutFn 里同步触发回调——兜底重摆的句柄不残留（回调里先置 null、返回后再赋值，会把一个已触发的句柄留下，挡掉之后所有的兜底重摆；销毁时还会去清它）；第十五轮评审 P3-4：必须再来第二轮同样的失败——残留的句柄只挡「之后」的排期，只测一轮看不出", async () => {
    // 真定时器做不到「返回之前就触发」；注入的假时钟（测试 / 调用方自己的调度器）可以
    const calls: number[] = [];
    const cleared: unknown[] = [];
    let seq = 0;
    const t = {
      setTimeoutFn: ((fn: () => void, ms: number) => {
        calls.push(ms);
        fn();
        return ++seq;
      }) as never,
      clearTimeoutFn: ((id: unknown) => {
        cleared.push(id);
      }) as never,
    };
    const h = makeTab({ timers: t });
    await h.tab.ready;
    const release = holdCapture(h);
    const shot = h.tab.send(CAP, { format: "png" });
    await h.flush();
    const log = traceView(h);
    h.tab.moveToMain(h.main as never, SLOT);
    throwOnce(h);
    release();
    await shot;
    expect(calls).toEqual([300]); // 排了一次兜底重摆
    expect(log).toEqual(["visible:false", SLOT_LOG, "visible:true"]); // 同步到点：补摆成功、放开显示

    // 第二轮：回停车场、再来一条在飞的截图、搬进主窗口、补摆再抛一次——必须还能再排一次兜底重摆、再放开显示。
    // 句柄残留的话，这里被「已经排着」挡掉：calls 停在 [300]、视图一直藏着（销毁时还会去清一个早已触发的句柄）
    h.tab.moveToParking(h.parking as never);
    log.length = 0;
    const release2 = holdCapture(h);
    const shot2 = h.tab.send(CAP, { format: "png" });
    await h.flush();
    h.tab.moveToMain(h.main as never, SLOT);
    throwOnce(h);
    release2();
    await shot2;
    expect(calls, "第二轮失败后同样排了一次兜底重摆（没有被上一轮残留的句柄挡掉）").toEqual([300, 300]);
    expect(log, "第二轮：先藏着、补摆抛了、同步到点补摆成功、再显示").toEqual(["visible:false", SLOT_LOG, "visible:true"]);
    h.tab.destroy();
    expect(cleared, "同步触发过的句柄不该残留：销毁时没有东西可清").toEqual([]);
  });

  it("第十五轮评审 P3-4：注入的假时钟返回 falsy 句柄（0）——「已经排着」看包装对象在不在、不看句柄真假：同一时刻只排一个，销毁时清的就是那个 0（原先直接判句柄，0 会被当成没排、叠出第二个、销毁时也不清）", async () => {
    const calls: number[] = [];
    const cleared: unknown[] = [];
    const t = {
      setTimeoutFn: ((_fn: () => void, ms: number) => {
        calls.push(ms);
        return 0; // 假时钟的句柄是 0：falsy，但确实排着
      }) as never,
      clearTimeoutFn: ((id: unknown) => {
        cleared.push(id);
      }) as never,
    };
    const h = makeTab({ timers: t });
    await h.tab.ready;
    const release = holdCapture(h);
    const shot = h.tab.send(CAP, { format: "png" });
    await h.flush();
    const log = traceView(h);
    h.tab.moveToMain(h.main as never, SLOT);
    throwOnce(h);
    release();
    await shot;
    expect(calls).toEqual([300]); // 补摆抛了：排了一次
    expect(log).toEqual(["visible:false"]);
    // 排着时遮盖开了又关：setVisible(true) 走到「扣住」分支、想再排一个——已经排着，不能叠
    h.tab.setVisible(false);
    h.tab.setVisible(true);
    expect(calls, "句柄是 0 也算已经排着：不叠第二个").toEqual([300]);
    h.tab.destroy();
    expect(cleared, "销毁时清的是那个 0").toEqual([0]);
  });

  it("测试缺口（第十四轮评审 P3-4 ⑦ 的对照，不是 ⑦ 修复的回归——修复前后都绿）：什么都不注入（生产路径：Tab 自己回退到全局 setTimeout / clearTimeout）——兜底重摆照样排、真时间到点补摆并放开显示；销毁时清掉没到点的那个", async () => {
    // 别的用例都通过 makeTab 注入了定时器，Tab 里 `deps.setTimeoutFn ?? setTimeout` 的回退分支 vitest 里从没走到过（生产里只走它）
    const h = makeTab({ timers: "default" });
    await h.tab.ready;
    const release = holdCapture(h);
    const shot = h.tab.send(CAP, { format: "png" });
    await h.flush();
    const log = traceView(h);
    h.tab.moveToMain(h.main as never, SLOT);
    throwOnce(h);
    release();
    await shot;
    expect(log).toEqual(["visible:false"]); // 补摆抛了、继续藏着，排了真的兜底重摆
    await vi.waitFor(() => expect(log).toEqual(["visible:false", SLOT_LOG, "visible:true"]), { timeout: 3_000, interval: 25 }); // 真 300 ms 到点：补摆成功才显示

    // 销毁：没到点的真定时器被清掉——到点后什么都不会再发生
    const g = makeTab({ timers: "default" });
    await g.tab.ready;
    const release2 = holdCapture(g);
    const shot2 = g.tab.send(CAP, { format: "png" });
    await g.flush();
    const log2 = traceView(g);
    g.tab.moveToMain(g.main as never, SLOT);
    throwOnce(g);
    release2();
    await shot2;
    expect(log2).toEqual(["visible:false"]);
    g.tab.destroy();
    await new Promise((r) => setTimeout(r, 450)); // 真时间超过 300 ms：已被清掉，不会再补摆
    expect(log2).toEqual(["visible:false"]);
  });

  it("第十三轮 P3-7：补发失败、但同一条透明截图自己的还原成功了——不再欠（成功分支也清欠账）", async () => {
    const h = await scaledWithProbe();
    const mode = restoreMode(h);
    mode.v = "fast";
    await h.tab.send(CAP, { format: "png" }, null, undefined, TRANSPARENT); // 记欠
    mode.v = "ok";
    mode.failN = 1; // 只让接下来的第一条「还原」失败：补发失败、本条自己的还原成功
    h.sent.length = 0;
    await h.tab.send(CAP, { format: "png" }, null, undefined, TRANSPARENT);
    expect(bgAndCaps(h.sent)).toEqual(["bg:restore", "bg:set", "cap:png", "bg:restore"]);
    expect(h.logs.filter((l) => OWED.test(l))).toHaveLength(1); // 补发那一次失败留了日志
    h.sent.length = 0;
    await h.tab.screenshot({ format: "jpeg" });
    expect(bgAndCaps(h.sent)).toEqual(["cap:jpeg"]); // 自己的还原成功 = 页面已是默认背景，不再欠
  });

  it("第十三轮 P3-7：欠着时排队的截图遇到标签页已关——补发直接得到 TAB_NOT_FOUND：不再记「仍失败」、不发任何命令，截图以 TAB_NOT_FOUND 失败", async () => {
    const h = await scaledWithProbe();
    const mode = restoreMode(h);
    mode.v = "fast";
    await h.tab.send(CAP, { format: "png" }, null, undefined, TRANSPARENT); // 记欠
    const release = holdCapture(h);
    const pA = h.tab.send(CAP, { format: "png", n: 1 }); // 出队：补发仍失败（继续欠着、记一行日志），然后截图被扣在 CDP 上
    const pB = h.tab.send(CAP, { format: "png", n: 2 }); // 排在后面
    const rB = pB.then(
      () => "ok",
      (e: { code?: string }) => e.code,
    );
    await h.flush();
    expect(h.logs.filter((l) => OWED.test(l))).toHaveLength(1);
    h.destroyWc(); // 标签页关了
    h.sent.length = 0;
    release();
    await pA; // 在飞的那条照常返回
    expect(await rB).toBe("TAB_NOT_FOUND");
    expect(h.sent).toEqual([]); // pB 出队后的补发与截图都没有发出任何命令
    expect(h.logs.filter((l) => OWED.test(l))).toHaveLength(1); // 没有第二行「仍失败」：标签页已关不是补发失败
  });

  it("第十三轮 P3-7：子会话（iframe）上的透明截图还原失败——补发发到同一个子会话、补不上就丢（不无限欠）；正常路径没有任何多余命令", async () => {
    const h = makeTab();
    await h.tab.ready;
    const mode = restoreMode(h);
    mode.v = "fast";
    await h.tab.send(CAP, { format: "png" }, "S1" as never, undefined, TRANSPARENT); // send 的 JSDoc 把 sessionId 推成 null，子会话 id 在这里强转
    mode.v = "fast"; // 补发仍失败
    h.sent.length = 0;
    await h.tab.send(CAP, { format: "png" }); // 主会话的普通截图：开头先给 S1 补发一次
    expect(h.sent.filter((s) => s.method === BG).map((s) => s.sessionId)).toEqual(["S1"]);
    expect(h.logs.filter((l) => OWED.test(l))).toHaveLength(1);
    expect(h.logs.find((l) => OWED.test(l))).toMatch(/子会话不再重试/);
    mode.v = "ok";
    h.sent.length = 0;
    await h.tab.send(CAP, { format: "png" }); // 子会话的账已经丢了：不再发
    expect(h.sent.filter((s) => s.method === BG)).toEqual([]);
    // 从没欠过账的 tab：普通截图只有截图一条命令
    const clean = makeTab();
    await clean.tab.ready;
    clean.sent.length = 0;
    await clean.tab.send(CAP, { format: "png" });
    expect(clean.sent.map((s) => s.method)).toEqual([CAP]);
  });

  it("第十八轮 B5：欠着「还原默认背景」时 debugger 掉线、ensureCdp 重新 attach（真新会话——真 Chromium 实测覆盖归零）：欠账作废，下一条截图不再补发 {}、也不记「仍失败」的日志", async () => {
    const h = makeTab();
    await h.tab.ready;
    const mode = restoreMode(h);
    mode.v = "fast";
    await h.tab.send(CAP, { format: "png" }, null, undefined, TRANSPARENT); // 透明截图的「还原」被拒 → 记欠
    expect(h.logs.filter((l) => /透明截图后还原默认背景失败/.test(l))).toHaveLength(1);
    h.detach(); // debugger 掉线：假 debugger 变成未 attach
    await h.tab.ensureCdp(); // 自愈：isAttached() 为假 → 真的新 attach → 欠账作废
    mode.v = "ok";
    h.sent.length = 0;
    await h.tab.send(CAP, { format: "png" });
    expect(bgAndCaps(h.sent), "全新会话里覆盖已经归零：没有东西可还原，不再补发").toEqual(["cap:png"]);
    expect(h.logs.filter((l) => OWED.test(l))).toEqual([]);
  });

  it("第十八轮 B5 对照：渲染进程崩溃重载而 debugger 没掉线（render-process-gone 只置 cdpReady = false、isAttached() 仍为真）——会话与覆盖都还在（真 Chromium 实测）：欠账必须留着，下一条截图照常先补发 {}", async () => {
    const h = makeTab();
    await h.tab.ready;
    const mode = restoreMode(h);
    mode.v = "fast";
    await h.tab.send(CAP, { format: "png" }, null, undefined, TRANSPARENT); // 记欠
    const onCalls = (h.tab as unknown as { wc: { on: { mock: { calls: unknown[][] } } } }).wc.on.mock.calls;
    const gone = onCalls.find((c) => c[0] === "render-process-gone")?.[1] as ((e: unknown, d: unknown) => void) | undefined;
    expect(gone, "前置：Tab 订阅了 render-process-gone").toBeTypeOf("function");
    gone!({}, { reason: "killed" }); // 只置 cdpReady = false；假 debugger 仍是 attached
    await h.tab.ensureCdp(); // 走同一个自愈入口，但这不是新 attach
    mode.v = "ok";
    h.sent.length = 0;
    await h.tab.send(CAP, { format: "png" });
    expect(bgAndCaps(h.sent), "覆盖还在：先还原、再截").toEqual(["bg:restore", "cap:png"]);
  });

  it("第十八轮 R19-13 B5：重新 attach 本身**抛错**（`dbg.attach` 失败）——欠账不清（没有新会话），错误照常传出；之后真 attach 成功才作废", async () => {
    const h = makeTab();
    await h.tab.ready;
    const mode = restoreMode(h);
    mode.v = "fast";
    await h.tab.send(CAP, { format: "png" }, null, undefined, TRANSPARENT); // 记欠
    const dbg = (h.tab as unknown as { wc: { debugger: { attach: (v: string) => void } } }).wc.debugger;
    const realAttach = dbg.attach;
    dbg.attach = () => {
      throw new Error("Another debugger is already attached");
    };
    h.detach(); // 掉线：isAttached() 为假
    await expect(h.tab.ensureCdp(), "attach 的错误原样传出（不被吞、不被改写）").rejects.toThrow("Another debugger is already attached");
    // 没有新会话：欠账还在。tab.send 不经 ensureCdp，直接看排他段开头会不会补发 {}
    mode.v = "ok";
    h.sent.length = 0;
    await h.tab.send(CAP, { format: "png" });
    expect(bgAndCaps(h.sent), "attach 抛错：欠账必须保留，下一条截图照常先补发 {}").toEqual(["bg:restore", "cap:png"]);
    // 恢复后真 attach 成功 → 这时才作废（再欠一笔以便观察）
    mode.v = "fast";
    await h.tab.send(CAP, { format: "png" }, null, undefined, TRANSPARENT);
    dbg.attach = realAttach;
    await h.tab.ensureCdp(); // 真的新 attach
    mode.v = "ok";
    h.sent.length = 0;
    await h.tab.send(CAP, { format: "png" });
    expect(bgAndCaps(h.sent), "attach 成功之后才清").toEqual(["cap:png"]);
  });

  it("第十八轮 R19-13 B5：debugger 已经 detach 之后、在途的「还原」才失败——欠账是 detach **之后**才记上的，下一次真新 attach 仍把它清掉（「清账挪进 detach 事件处理器」会漏掉它）", async () => {
    const h = makeTab();
    await h.tab.ready;
    const dbg = (h.tab as unknown as { wc: { debugger: { sendCommand: (m: string, p?: Record<string, unknown>, s?: string) => Promise<unknown> } } }).wc.debugger;
    const inner = dbg.sendCommand;
    let failRestore: () => void = () => {};
    // 「还原」（BG 且参数为空）发出去之后一直挂着，直到手动让它失败；其余命令照常
    dbg.sendCommand = (method: string, params?: Record<string, unknown>, sessionId?: string) => {
      const p = inner(method, params, sessionId);
      if (method === BG && Object.keys(params ?? {}).length === 0) {
        return new Promise<never>((_resolve, reject) => {
          failRestore = () => reject(new Error("Session with given id not found"));
        });
      }
      return p;
    };
    const shot = h.tab.send(CAP, { format: "png" }, null, undefined, TRANSPARENT);
    await h.flush();
    expect(bgAndCaps(h.sent), "前置：设 / 截都发完了，「还原」在途").toEqual(["bg:set", "cap:png", "bg:restore"]);
    h.detach(); // 在「还原」应答之前 debugger 掉线（detach 事件处理器此刻跑完）
    failRestore(); // 在途的「还原」此时才失败 → 欠账在 detach 之后才被记上
    await shot;
    dbg.sendCommand = inner; // 插桩用完：之后的「还原」照常应答（变异时补发才不会挂满 5 秒超时）
    expect(h.logs.filter((l) => /透明截图后还原默认背景失败/.test(l))).toHaveLength(1); // 前置：确实记了欠
    await h.tab.ensureCdp(); // 真的新 attach：欠账作废
    h.sent.length = 0;
    await h.tab.send(CAP, { format: "png" });
    expect(bgAndCaps(h.sent), "detach 之后才记的欠账，新 attach 也要清掉：不再补发 {}").toEqual(["cap:png"]);
    expect(h.logs.filter((l) => OWED.test(l))).toEqual([]);
  });

  it("第十八轮 R19-13 B5：子会话（sessionId 非 null）上的欠账也被新 attach 一并清掉（旧会话整体作废，不只主会话那一条）", async () => {
    const h = makeTab();
    await h.tab.ready;
    const mode = restoreMode(h);
    mode.v = "fast";
    await h.tab.send(CAP, { format: "png" }, null, undefined, TRANSPARENT); // 主会话记欠
    await h.tab.send(CAP, { format: "png" }, "S1" as never, undefined, TRANSPARENT); // 子会话 S1 记欠（send 的 JSDoc 把 sessionId 推成 null，这里强转）
    h.detach();
    await h.tab.ensureCdp(); // 真的新 attach
    mode.v = "ok";
    h.sent.length = 0;
    h.logs.length = 0; // 记欠阶段（S1 那条截图开头补发主会话的账又失败了一次）留下的「仍失败」日志不算这次的
    await h.tab.send(CAP, { format: "png" });
    expect(h.sent.filter((s) => s.method === BG), "主会话与子会话的欠账都已作废：一条 {} 都不补发（子会话的补发会带 sessionId）").toEqual([]);
    expect(h.logs.filter((l) => OWED.test(l))).toEqual([]);
  });

  it("第十轮 B-3：透明截图占着排他段期间同样推迟视图矩形（#capturing 覆盖设 / 截 / 还原全程），整套结束后才补摆", async () => {
    const h = await scaledWithProbe();
    const callsBefore = h.setBounds.mock.calls.length;
    const release = holdCapture(h);
    const shot = h.tab.screenshot({ format: "png", omitBackground: true });
    await h.flush();
    h.tab.setBounds({ x: 0, y: 0, width: 500, height: 350 });
    await h.flush();
    expect(h.setBounds.mock.calls.length).toBe(callsBefore); // 截图（透明）在飞：矩形没动
    release();
    await shot;
    expect(h.lastBounds().width).toBeLessThanOrEqual(500); // 补摆
    expect(bgAndCaps(h.sent).at(-1)).toBe("bg:restore"); // 还原发在补摆之前的排他段里
  });

  it("测试缺口：destroy 落在「截图在飞 + 显示被扣住」期间——截完不再碰已销毁的视图（不 setBounds / 不 setVisible），截图 promise 照常收尾、不挂起", async () => {
    const h = await parkedWithHeldShot();
    h.tab.moveToMain(h.main as never, SLOT); // 显示被扣住、槽位矩形被推迟
    expect(h.log).toEqual(["visible:false"]);
    h.tab.destroy();
    h.release();
    const settled = await Promise.race([h.shot.then(() => "settled", () => "settled"), new Promise<string>((r) => setTimeout(() => r("HANG"), 1500))]);
    expect(settled).toBe("settled");
    expect(h.log).toEqual(["visible:false"]); // 收尾没有任何新的 setBounds / setVisible
  });

  it("测试缺口（第十一轮评审 P3-6）：显示被扣住期间又排进第二条截图——第一条一结束就补摆并显示（第二条随后在补摆后的矩形上截），第二条结束后没有任何多余的矩形 / 可见性调用", async () => {
    const h = await parkedWithHeldShot();
    h.tab.moveToMain(h.main as never, SLOT); // 显示被扣住、槽位矩形被推迟
    const shot2 = h.tab.send(CAP, { format: "png", n: 2 }); // 排在第一条后面
    await h.flush();
    expect(capturesIn(h.sent)).toHaveLength(1);
    expect(h.log).toEqual(["visible:false"]);
    h.release(); // 第一条结束
    const release2 = holdCapture(h); // 第二条要扣住（第一条已经越过旧的 gate）
    await h.shot;
    await h.flush();
    expect(h.log).toEqual(["visible:false", SLOT_LOG, "visible:true"]); // 第一条的收尾：先补摆、后显示（第二条出队前）
    expect(capturesIn(h.sent)).toHaveLength(2); // 第二条随后才发
    release2();
    await shot2;
    expect(h.log).toEqual(["visible:false", SLOT_LOG, "visible:true"]); // 第二条结束：没有多余调用
  });

  it("测试缺口（第十一轮评审 P3-6）：webContents 被页面 / 引擎销毁（destroyed 事件，不经 Tab.destroy）落在「截图在飞 + 显示被扣住」期间——截图 promise 不挂起，收尾不再碰视图", async () => {
    const h = await parkedWithHeldShot();
    h.tab.moveToMain(h.main as never, SLOT); // 显示被扣住、槽位矩形被推迟
    expect(h.log).toEqual(["visible:false"]);
    const wcOn = (h.tab as unknown as { wc: { on: ReturnType<typeof vi.fn> } }).wc.on;
    const onDestroyed = wcOn.mock.calls.find(([ev]) => ev === "destroyed")?.[1] as (() => void) | undefined;
    expect(onDestroyed).toBeTypeOf("function");
    onDestroyed!();
    expect(h.tab.destroyed).toBe(true);
    h.release();
    const settled = await Promise.race([h.shot.then(() => "settled", () => "settled"), new Promise<string>((r) => setTimeout(() => r("HANG"), 1500))]);
    expect(settled).toBe("settled");
    expect(h.log).toEqual(["visible:false"]); // 收尾没有任何新的 setBounds / setVisible
  });

  it("测试缺口：moveToParking(null)（应用退出、没有停车场窗口）落在截图在飞的推迟期间——视图已摘下，截完不再补摆停车场矩形、不抛", async () => {
    const h = makeTab();
    await h.tab.ready;
    h.tab.moveToMain(h.main as never, SLOT);
    const release = holdCapture(h);
    const shot = h.tab.send(CAP, { format: "png" });
    await h.flush();
    const log = traceView(h);
    h.tab.moveToParking(h.parking as never); // 停车场矩形被推迟
    h.tab.moveToParking(null); // 应用退出：视图从当前父窗口摘下，没有任何窗口了
    expect(log).toEqual(["visible:true"]);
    release();
    await expect(shot).resolves.toBeTruthy();
    expect(log).toEqual(["visible:true"]); // 截完没有补摆停车场矩形
    expect(h.main.contentView.removeChildView).not.toHaveBeenCalled(); // 它停在停车场窗口里被摘的，不是主窗口
  });

  it("测试缺口：截图在飞时 park → main → park——只按最后的落脚点收尾：停车场矩形摆一次，没有槽位补摆残留", async () => {
    const h = makeTab();
    await h.tab.ready;
    h.tab.moveToMain(h.main as never, SLOT);
    const release = holdCapture(h);
    const shot = h.tab.send(CAP, { format: "png" });
    await h.flush();
    const log = traceView(h);
    h.tab.moveToParking(h.parking as never);
    h.tab.moveToMain(h.main as never, { ...SLOT, width: 1400 });
    h.tab.moveToParking(h.parking as never);
    expect(log.filter((x) => x.startsWith("bounds:"))).toEqual([]); // 截图期间一次矩形都没动
    release();
    await shot;
    expect(log.filter((x) => x.startsWith("bounds:"))).toEqual([PARK]); // 只摆一次停车场矩形
    expect(h.lastBounds()).toEqual(PARKING_BOUNDS);
  });

  it("测试缺口：显示被扣住 + 截图 20 秒超时——互斥放掉后先补摆槽位矩形、再显示（不会因为超时一直藏着）", async () => {
    const h = makeTab();
    await h.tab.ready;
    holdCapture(h); // 永不放行：页面卡死
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const shot = h.tab.send(CAP, { format: "png" });
      const settled = shot.then(
        () => "ok",
        (e: { code?: string }) => e.code,
      );
      await vi.advanceTimersByTimeAsync(0);
      const log = traceView(h);
      h.tab.moveToMain(h.main as never, SLOT); // 视图在停车场、截图在飞：显示被扣住
      expect(log).toEqual(["visible:false"]);
      await vi.advanceTimersByTimeAsync(19_000);
      expect(log).toEqual(["visible:false"]); // 19 秒：还在等
      await vi.advanceTimersByTimeAsync(1_500);
      expect(await settled).toBe("TIMEOUT");
      expect(log).toEqual(["visible:false", SLOT_LOG, "visible:true"]);
    } finally {
      vi.useRealTimers();
    }
  });

  /** 真 BrowserSession + 真 BrowserTab（假 CDP / 假视图）：t1 / t2 共用同一对假窗口，session 经 host.createTab 造 Tab、用它自己的 hooks */
  const makeRealSession = async () => {
    const windows = { main: makeWin(), parking: makeWin() };
    const harnesses = new Map<string, ReturnType<typeof makeTab>>();
    const host = {
      createTab: ({ id, hooks }: { id: string; hooks: Record<string, unknown> }) => {
        const h = makeTab({ id, hooks, windows });
        harnesses.set(id, h);
        return h.tab;
      },
      getMainWindow: () => windows.main,
      getParkingWindow: () => windows.parking,
      onChange: vi.fn(),
      emitEvent: vi.fn(),
      emitPicked: vi.fn(),
      startPicker: vi.fn(),
    };
    const session = new BrowserSession({ taskId: "task1", host: host as never, activityLog: createActivityLog(), graceMs: 8_000 });
    await session.openTab({ activate: true });
    await session.openTab({ activate: false });
    const t1 = harnesses.get("t1")!;
    const t2 = harnesses.get("t2")!;
    await Promise.all([t1.tab.ready, t2.tab.ready]);
    return { session, windows, t1, t2 };
  };

  it("测试缺口（session 层 × 截图在飞）：切标签页——旧标签页的停车场矩形等截完才摆，新标签页立刻按槽位摆好并显示、不被牵连", async () => {
    const { session, t1, t2 } = await makeRealSession();
    session.attach(SLOT); // t1 是激活 tab：moveToMain(SLOT)
    expect(t1.lastBounds()).toEqual(SLOT);
    const release = holdCapture(t1);
    const shot = t1.tab.send(CAP, { format: "png" });
    await t1.flush();
    const log1 = traceView(t1);
    const log2 = traceView(t2);
    session.selectTab("t2"); // t1 → 停车场（截图在飞：矩形推迟）、t2 → 主窗口
    expect(log1).toEqual(["visible:true"]); // t1：只有 #park 的 setVisible(true)，矩形没动
    expect(log2).toEqual([SLOT_LOG, "visible:true"]); // t2：没有截图在飞，立刻摆好并显示
    release();
    await shot;
    expect(log1).toEqual(["visible:true", PARK]); // t1 截完才摆停车场矩形
    expect(log2).toEqual([SLOT_LOG, "visible:true"]);
    expect(t1.lastBounds()).toEqual(PARKING_BOUNDS);
  });

  it("测试缺口（session 层 × 截图在飞）：面板关闭（detach）又重新打开（attach）——只按最新槽位补摆一次，不会摆成停车场矩形", async () => {
    const { session, t1 } = await makeRealSession();
    session.attach(SLOT);
    const release = holdCapture(t1);
    const shot = t1.tab.send(CAP, { format: "png" });
    await t1.flush();
    const log = traceView(t1);
    session.detach(); // 所有 tab 回停车场：t1 截图在飞 → 停车场矩形推迟
    session.attach({ ...SLOT, width: 1400 }); // 面板又开了：矩形还是槽位矩形、不扣显示
    expect(log).toEqual(["visible:true", "visible:true"]);
    release();
    await shot;
    expect(log.filter((x) => x.startsWith("bounds:"))).toEqual([`bounds:1400x${SLOT.height}`]);
    expect(t1.lastBounds()).toEqual({ ...SLOT, width: 1400 });
  });

  it("源码契约：send 只把 Page.captureScreenshot 送进 #captureExclusive；它走模拟队列、出队先查 signal、期间置 #capturing，#applySlot 据此推迟、结束后由 #afterCapture 补摆（不抛）", () => {
    // 读剥掉注释的源码（第十六轮评审 P3-B3：此前只有 e2e 半边统一成 readSource，这里读原文，注释里照抄一遍被检查的那句 toMatch 照样过）
    const src = readSource("electron-app/browser/tab.mjs");
    expect(src).toMatch(
      /send\(method, params = \{\}, sessionId = null, timeoutMs = CDP_TIMEOUT_MS, opts = \{\}\) \{[\s\S]*?if \(method === "Page\.captureScreenshot"\) \{\s+const job = opts\?\.transparentBackground === true \? \(\) => this\.#sendTransparent\(method, params, sessionId, timeoutMs\) : \(\) => this\.#sendNow\(method, params, sessionId, timeoutMs\);\s+return this\.#captureExclusive\(job, opts\?\.signal\);/,
    );
    const excl = src.slice(src.indexOf("#captureExclusive(job, signal) {"), src.indexOf("#afterCapture() {"));
    expect(excl).toContain("this.#enqueueEmulation(");
    // 出队先查 signal（排队期间调用方已放弃就不发、也不置 #capturing），再置位；finally 里复位并交给 #afterCapture 收尾
    expect(excl).toMatch(/if \(signal\?\.aborted\) throw[\s\S]*?this\.#capturing = true;[\s\S]*?finally \{[\s\S]*?this\.#capturing = false;[\s\S]*?this\.#afterCapture\(\);/);
    // 收尾三步（补摆槽位矩形 / 摆停车场矩形 / 显示被扣住的视图）各自 try、都不抛：finally 里抛错会盖掉截图结果，前一步失败也不能让后一步不来
    const after = src.slice(src.indexOf("#afterCapture() {"), src.indexOf("#sendNow(method, params, sessionId, timeoutMs) {"));
    expect(after).toMatch(/if \(this\.#slotDeferred\) \{[\s\S]*?this\.#slotDeferred = false;[\s\S]*?this\.#applySlot\(\)/);
    expect(after).toMatch(/if \(this\.#parkDeferred\) \{[\s\S]*?this\.#parkDeferred = false;[\s\S]*?this\.view\.setBounds\(\{ \.\.\.PARKING_BOUNDS \}\)/);
    // 第三步放开被扣住的显示，但「有槽位、矩形却还是停车场尺寸」（第一步 setBounds 抛了）时不放、改排一次兜底重摆（第十轮评审 B-1 / 第十一轮评审 P3-2）
    expect(after).toMatch(/if \(this\.#showHeld\) \{\s+if \(this\.#slot && this\.#atParkingBounds\) this\.#scheduleHeldShowRetry\(\);\s+else this\.#releaseShowHeld\(\);\s+\}/);
    expect(after.match(/\btry \{/g)?.length).toBe(3);
    expect(after.match(/\} catch \(err\) \{/g)?.length).toBe(3);
    // #applySlot 摆成功（setBounds 没抛）之后才放开被扣住的显示：补摆失败后的下一次摆放成功也会放开
    expect(src).toMatch(
      /#applySlot\(\) \{[\s\S]*?if \(this\.#capturing\) this\.#slotDeferred = true;\s+else \{\s+this\.view\.setBounds\(bounds\);\s+this\.#atParkingBounds = false;\s+this\.#releaseShowHeld\(\);[^\n]*\n\s+\}/,
    );
    expect(src).toMatch(/#releaseShowHeld\(\) \{\s+if \(!this\.#showHeld\) return;\s+this\.#showHeld = false;\s+if \(!this\.destroyed\) this\.view\.setVisible\(this\.#wantVisible\);/);
    // #applyVisible 的扣住条件（第十一轮评审 P3-2）：矩形仍是停车场尺寸，且「截图在飞 或 视图有槽位」——收尾补摆失败之后的 setVisible(true) 也不能直接显示；
    // 扣住时若不在截图中（只剩「有槽位 + 矩形仍是停车场尺寸」），就地排一次兜底重摆（第十二轮评审 P3-5：这一路没有 #afterCapture 来排）
    expect(src).toMatch(
      /#applyVisible\(visible\) \{\s+this\.#wantVisible = visible;\s+if \(visible && this\.#atParkingBounds && \(this\.#capturing \|\| this\.#slot\)\) \{\s+this\.#showHeld = true;\s+this\.view\.setVisible\(false\);[\s\S]*?if \(!this\.#capturing\) this\.#scheduleHeldShowRetry\(\);\s+return;/,
    );
    // 兜底重摆：只在两处排——#afterCapture（截图刚结束、补摆失败）与 #applyVisible 的扣住分支（不在截图中）；同一时刻最多一个、到点先查「已放开 / 已销毁」（又有截图在飞由 #applySlot 自己推迟）、销毁时清掉定时器
    expect(src.match(/this\.#scheduleHeldShowRetry\(\)/g)?.length).toBe(2);
    // 「有没有排着」看 `#heldShowRetry` 这个包装对象在不在、不看句柄本身的真假（第十五轮评审 P3-4：注入的假时钟可能返回 0 / undefined 这类 falsy 句柄，
    // 直接判句柄会被绕过、同一时刻排出多个）；句柄只有销毁时清定时器那一处读
    expect(src).toMatch(/#scheduleHeldShowRetry\(\) \{\s+if \(this\.#heldShowRetry \|\| this\.destroyed\) return;/);
    expect(src).toMatch(/if \(this\.destroyed \|\| !this\.#showHeld\) return;\s+this\.#applySlot\(\);/);
    expect(src).toMatch(/#teardown\(\{ closeWc \}\) \{[\s\S]*?if \(this\.#heldShowRetry\) \{\s+this\.clearTimeoutFn\(this\.#heldShowRetry\.handle\);\s+this\.#heldShowRetry = null;\s+\}/);
    expect(src.match(/this\.#heldShowRetry\.handle/g)?.length, "句柄只在销毁时读一次；别处判 .handle 的真假会让 falsy 句柄绕过「同一时刻最多一个」").toBe(1);
    // 兜底重摆的定时器走注入的 setTimeoutFn / clearTimeoutFn（第十三轮评审 P3-6）：不得再直接用全局 setTimeout / clearTimeout
    const retryFn = src.slice(src.indexOf("#scheduleHeldShowRetry() {"), src.indexOf("#applyVisible(visible) {"));
    // 句柄只在回调没有同步跑过时才记（第十四轮评审 P3-4 ⑦：注入的假时钟可能在 setTimeoutFn 返回前就触发回调，先置 null 再赋值会残留一个已触发的句柄）
    expect(retryFn).toMatch(/let fired = false;\s+const handle = this\.setTimeoutFn\(\(\) => \{\s+fired = true;\s+this\.#heldShowRetry = null;/);
    expect(retryFn).toMatch(/\}, HELD_SHOW_RETRY_MS\);\s+if \(fired\) return;\s+handle\?\.unref\?\.\(\);\s+this\.#heldShowRetry = \{ handle \};/);
    expect(retryFn).not.toMatch(/(?<![.\w])setTimeout\(/);
    expect(src).not.toMatch(/(?<![.\w])clearTimeout\(this\.#heldShowRetry/);
    // 视图的可见性：moveToMain / setVisible 只经 #applyVisible；直接 view.setVisible 只剩 #park / #applyVisible（两处）/ #releaseShowHeld 共 4 个调用点
    expect(src).toMatch(/moveToMain\(mainWindow, bounds, visible = true\) \{[\s\S]*?this\.#applyVisible\(visible\);/);
    expect(src).toMatch(/\n  setVisible\(visible\) \{\s+if \(!this\.destroyed\) this\.#applyVisible\(visible\);/);
    expect(src.match(/this\.view\.setVisible\(/g)?.length).toBe(4);
    // #park：截图在飞且矩形不是停车场尺寸时推迟、否则立刻摆
    expect(src).toMatch(/#park\(parkingWindow\) \{[\s\S]*?if \(this\.#capturing && !this\.#atParkingBounds\) \{[\s\S]*?this\.#parkDeferred = true;[\s\S]*?\} else \{[\s\S]*?this\.view\.setBounds\(\{ \.\.\.PARKING_BOUNDS \}\);/);
    // 截图命令只有 send 这一个入口（#captureExclusive 里不直接发 CDP，所有 CDP 仍只经 #sendNow）
    expect(excl).not.toContain("sendCommand(");
    // omit_background（第十轮评审 B-3）：「设透明背景 → 截 → 还原」只在 #sendTransparent 里发、都经 #sendNow、还原在 finally；
    // screenshot() 不再自己单发背景命令（全文件只有 #sendTransparent 里的这两处：设 + 还原）
    // 全文件三处：#sendTransparent 里的设 + 还原，加 #restoreDirtyBackground 里补发的那一条（第十三轮评审 P3-7）
    expect(src.match(/Emulation\.setDefaultBackgroundColorOverride/g)?.length).toBe(3);
    const transparent = src.slice(src.indexOf("async #sendTransparent("), src.indexOf("async #restoreDirtyBackground() {"));
    expect(transparent.match(/Emulation\.setDefaultBackgroundColorOverride/g)?.length).toBe(2);
    // 「设」也在 try 里（第十一轮评审 P3-5：设超时 / 抛错也要还原）；还原在 finally、超时取 min(timeoutMs, TRANSPARENT_RESTORE_TIMEOUT_MS)、自己失败不抛但留日志
    // （第十二轮评审 P3-6：原先 .catch(() => {}) 一点痕迹都没有；标签页已关 TAB_NOT_FOUND 时没有东西可还原、不记）
    expect(transparent).toMatch(
      /try \{\s+await this\.#sendNow\("Emulation\.setDefaultBackgroundColorOverride", \{ color: \{ r: 0, g: 0, b: 0, a: 0 \} \}, sessionId, timeoutMs\);\s+return await this\.#sendNow\(method, params, sessionId, timeoutMs\);\s+\} finally \{\s+await this\.#sendNow\("Emulation\.setDefaultBackgroundColorOverride", \{\}, sessionId, Math\.min\(timeoutMs, TRANSPARENT_RESTORE_TIMEOUT_MS\)\)\.then\(\s+\(\) => \{\s+this\.#bgDirty\.delete\(sessionId \?\? null\);\s+\},\s+\(err\) => \{\s+if \(err\?\.code === "TAB_NOT_FOUND"\) return;\s+this\.#bgDirty\.add\(sessionId \?\? null\);\s+this\.log\(`\[browser:\$\{this\.id\}\] 透明截图后还原默认背景失败 \/ 超时/,
    );
    // 还原没成功就记欠（#bgDirty，第十三轮评审 P3-7）：成功清、失败（非 TAB_NOT_FOUND）记；下一条截图的排他段开头（signal 检查之后、job 之前）补发，永不抛
    // 补发之后、job 之前再查一次 signal（第十四轮评审 P3-4 ①：补发最多占 5 秒，期间调用方可能已放弃；两处检查共用 abandoned()，抛的是同一个 reason）
    expect(excl).toMatch(/if \(signal\?\.aborted\) throw abandoned\(\);\s+this\.#capturing = true;\s+try \{[\s\S]*?await this\.#restoreDirtyBackground\(\);[\s\S]*?if \(signal\?\.aborted\) throw abandoned\(\);\s+return await job\(\);/);
    expect(excl.match(/if \(signal\?\.aborted\) throw abandoned\(\);/g)?.length).toBe(2);
    expect(src).toMatch(
      /async #restoreDirtyBackground\(\) \{\s+if \(this\.#bgDirty\.size === 0\) return;\s+for \(const sessionId of \[\.\.\.this\.#bgDirty\]\) \{\s+try \{\s+await this\.#sendNow\("Emulation\.setDefaultBackgroundColorOverride", \{\}, sessionId, TRANSPARENT_RESTORE_TIMEOUT_MS\);\s+this\.#bgDirty\.delete\(sessionId\);\s+\} catch \(err\) \{\s+if \(err\?\.code === "TAB_NOT_FOUND"\) \{\s+this\.#bgDirty\.clear\(\);\s+return;\s+\}\s+if \(sessionId !== null\) this\.#bgDirty\.delete\(sessionId\);/,
    );
    expect(src).toMatch(/const TRANSPARENT_RESTORE_TIMEOUT_MS = 5_000;/);
    // 自愈里的模拟重放（第十轮评审 B-2）：队列外的调用方（ensureCdp）排队，已在队列里的（#applyEmulationNow）直接发，不然等自己
    expect(src).toMatch(/\n  ensureCdp\(\) \{\s+return this\.#ensureCdp\(false\);/);
    // 队列内（模拟应用里发现 CDP 没就绪）：自己愈合、重放直接发（queueReplay false），不等队列外那一次（它的重放要排进此刻被占着的队列，等它就是等自己）；
    // 队列外的调用共用同一次自愈（单飞，第二十四轮 P3-2）、重放排进队列（queueReplay true）。行为测试在 browser-tab-eval-in-frames.test.ts 的「tab.ensureCdp 自愈单飞」
    expect(src).toMatch(/if \(inQueue\) \{\s*(?:\/\/[^\n]*\n\s*)*this\.children\.clear\(\);\s*this\.isoContexts\.clear\(\);\s*await this\.#attachDebugger\(\{ queueReplay: false \}\);\s*return;\s*\}/);
    expect(src).toMatch(/if \(this\.#healFlight === null\) \{[\s\S]*?await this\.#attachDebugger\(\{ queueReplay: true \}\);[\s\S]*?await this\.#healFlight\.promise;/);
    expect(src).toMatch(/async #applyEmulationNow\(patch\) \{\s+await this\.#ensureCdp\(true\);/);
    expect(src).toMatch(/async #replayEmulation\(queued = false\) \{[\s\S]*?if \(queued\) await this\.#enqueueEmulation\(replay\);\s+else await replay\(\);/);
    expect(src).toContain("await this.#replayEmulation(queueReplay);");
    // 第十八轮 B5：只在「真的新 attach」那一支清欠账（紧跟 attach、同步、无 await）；全文件只有两处 #bgDirty.clear()——补发时标签页已关那一处 + 这一处
    expect(src).toMatch(/async #attachDebugger\(\{ queueReplay = false \} = \{\}\) \{\s+const dbg = this\.wc\.debugger;\s+if \(!dbg\.isAttached\(\)\) \{\s+dbg\.attach\("1\.3"\);\s+this\.#bgDirty\.clear\(\);\s+\}/);
    expect(src.match(/#bgDirty\.clear\(\)/g)?.length).toBe(2);
    // attach 的顺序（第十一轮评审 P3-4）：主 frame 同步与输入锁在模拟重放（自愈时要排队等在飞的截图）之前
    expect(src).toMatch(/await this\.#syncMainFrameId\(\);\s+if \(this\.desiredIgnore\) await this\.#applyIgnore\(true\);[\s\S]*?await this\.#replayEmulation\(queueReplay\);/);
  });

  it("第九轮 P3-3 接线：op 的 signal 一路传到出队检查——opScreenshot / save 把 signal 交给 tab.screenshot，screenshot 把它交给 send", () => {
    // 三处都读剥掉注释的源码（第十六轮评审 P3-B3：「统一口径」此前只做了 e2e 脚本那一半）
    const idx = readSource("electron-app/browser/index.mjs");
    const op = idx.slice(idx.indexOf("const opScreenshot = async"), idx.indexOf("const waitForCondition"));
    expect(op).toMatch(/tab\.screenshot\(\{[\s\S]*?\n\s+signal,[^\n]*\n\s+\}\)/);
    expect(readSource("electron-app/browser/ops/read.mjs")).toContain('maxWidth: 100_000, signal })');
    const tabSrc = readSource("electron-app/browser/tab.mjs");
    const shotFn = tabSrc.slice(tabSrc.indexOf("async screenshot({"), tabSrc.indexOf("let r = await capture(clip);"));
    expect(shotFn).toMatch(/annotate = false, signal \} = \{\}\)/);
    expect(shotFn).toMatch(/\{ signal(,| \})/); // 第十轮评审 B-3 之后 signal 旁边还带 transparentBackground 选项
    expect(shotFn).toContain("transparentBackground: true");
  });

  it("真 Electron 回归脚本在位，并写进了契约文档（改这块逻辑要重跑它）；启动命令里的 --timeout 脚本头与文档一致", () => {
    const e2eRaw = read("scripts/browser-e2e/capture-emulation-race.cjs");
    // 结构断言读剥掉注释的版本（第十五轮评审 P3-4：注释里照抄一遍被检查的那句，toMatch 照样过；也不必再用 `[^}]*` 去跳过注释里的花括号）
    const e2e = readSource("scripts/browser-e2e/capture-emulation-race.cjs");
    expect(e2e).toContain("Page.captureScreenshot");
    expect(e2e).toContain("Emulation.setDeviceMetricsOverride");
    for (const id of ["cx-08", "cx-09"]) expect(e2e).toContain(id); // 视图在父窗口之间搬动（第九轮评审 B1 / P3-4）
    expect(e2e).toContain("cx-10"); // 截图在飞时缩放（第十轮评审 B-4：实测一致，缩放路径不进队列）
    expect(e2e).toContain("wc().setZoomLevel(1)");
    // cx-10b 的有效性（第十一轮评审 P3-6）：每个用例交叉不上就重试、仍不上是 FAIL 而不是 SKIP（SKIP 不影响退出码，cx-10 会在「缩放根本没落在截图期间」时空转报绿）；
    // 汇总行列出被 SKIP 的 id，免得「N/N passed」被读成全交叉都测到了
    expect(e2e).toMatch(/const ZOOM_MAX_ATTEMPTS = 4;/);
    expect(e2e).toMatch(/for \(let attempt = 0; attempt < ZOOM_MAX_ATTEMPTS && zCrossed\[key\] === 0; attempt\+\+\)/);
    // 重试的方向（第十三轮评审 P3-2）：不是换成更短的延迟（`sleep(0)` 与「截图命令在飞」判据反方向——延迟越短越早、截图命令越没发出去，只会更交叉不上），
    // 而是轮询插桩的 spans 等到有 Page.captureScreenshot 在飞，再**同步**判 + 调 setZoomLevel（中间不能有 await）。上面那条只钉了尝试次数 / zUncrossed，改回 sleep(0) 也过
    expect(e2e).not.toMatch(/sleep\(attempt === 0 \? d : 0\)/);
    expect(e2e).toMatch(/const inFlightCapture = \(\) => spans\.find\(\(sp\) => sp\.m === "Page\.captureScreenshot" && sp\.t1 === null\);/);
    expect(e2e).toMatch(/const captureInFlight = \(\) => inFlightCapture\(\) !== undefined;/);
    // 轮询的截止时间必须是「现在 + timeoutMs」（第十四轮评审 P3-4 ⑤：只钉 while 行时，把 deadline 改成 performance.now() 仍全绿——轮询一次都不转）
    expect(e2e).toMatch(/const waitCaptureInFlight = async \(timeoutMs\) => \{\s*const deadline = performance\.now\(\) \+ timeoutMs;\s*while \(performance\.now\(\) < deadline && !captureInFlight\(\)\) await new Promise\(\(r\) => setImmediate\(r\)\);\s*\};/);
    // 重试分支（第十五轮评审 P3-4 收紧：此前 `[1-9]\d*` 让 `waitCaptureInFlight(1)` 也过——1 ms 等于没等；`[^}]*` 对注释里的花括号很脆）：
    // 首次保留各用例自己的延迟 d；重试先等命令在飞（超时钉死 5000）、再等偏移 d，**最后一次放弃偏移**（命令一在飞就缩放，交叉上比落在第几毫秒更要紧）
    expect(e2e).toMatch(/if \(attempt === 0\) \{\s*await sleep\(d\);\s*\} else \{\s*await waitCaptureInFlight\(5000\);\s*if \(attempt < ZOOM_MAX_ATTEMPTS - 1\) await sleep\(d\);\s*\}/);
    // 「判交叉」到 setZoomLevel 之间是同一个同步步骤，记下来的是**实测**相位（缩放那一刻距这条截图命令发出多少毫秒），不是代码里的名义偏移；
    // 名义偏移 / 是否靠最后一次放弃偏移才交叉上的也一并记，汇总进 cx-10b 的 detail（只记 0 / 1 看不出是首次还是重试，只记名义偏移又与实际相位对不上）
    // 第十六轮评审 P3-B4：fallbackOffset0 只有 d > 0 的用例才可能为 true（d 本来就是 0 的用例，最后一次没「放弃」任何偏移）；
    // 另有逐次记账 zTrace（crossed / late / not_yet_sent / never_sent，外加 waitedMs / captureCount / lateByMs）——zWhere 只在交叉成功时才写，失败时分不清「命令从未发出」还是「每次都太晚」。记账同步、无 await（下面的 slice 断言兜住）
    // 第十七轮评审 B-4：attempt 0 没等满 5 秒就没命令叫 not_yet_sent（不是 never_sent）；late 取**最后**一条截图命令（评审当时说 saveFull 会连发多条；第十八轮 R-3 核实 capture-emulation-race.cjs 的 saveFull 是 png、只发一条，取最后一条是防御性的——连发第二条只发生在 webp 缩小分支）并记缩放距应答多久；起点 waitFrom 在 `mk()` 之后、等待之前量起
    expect(e2e).toMatch(/zCrossed\[key\] = 0;\s*zTrace\[key\] = \[\];\s*for \(let attempt/);
    expect(e2e).toMatch(
      /const flying = inFlightCapture\(\);\s*if \(flying\) \{\s*zCrossed\[key\]\+\+;\s*zWhere\[key\] = \{\s*attempt,\s*anchor: attempt === 0 \? "op 开始后的名义偏移" : "命令在飞后的名义偏移",\s*nominalOffsetMs: attempt === ZOOM_MAX_ATTEMPTS - 1 \? 0 : d,\s*fallbackOffset0: attempt === ZOOM_MAX_ATTEMPTS - 1 && d > 0,\s*afterCommandMs: Math\.round\(performance\.now\(\) - flying\.t0\),\s*\};\s*\}\s*const captures = spans\.filter\(\(sp\) => sp\.m === "Page\.captureScreenshot"\);\s*const seen = flying \?\? captures\[captures\.length - 1\];\s*zTrace\[key\]\.push\(\{\s*attempt,\s*nominalOffsetMs: attempt === ZOOM_MAX_ATTEMPTS - 1 \? 0 : d,\s*result: flying \? "crossed" : seen \? "late" : attempt === 0 \? "not_yet_sent" : "never_sent",\s*waitedMs: Math\.round\(performance\.now\(\) - waitFrom\),\s*captureCount: captures\.length,\s*\.\.\.\(!flying && seen \? \{ commandRoundTripMs: Math\.round\(seen\.t1 - seen\.t0\), lateByMs: Math\.round\(performance\.now\(\) - seen\.t1\) \} : \{\}\),\s*\}\);\s*wc\(\)\.setZoomLevel\(1\);/,
    );
    expect(e2e).toMatch(/const p = mk\(\);\s*const waitFrom = performance\.now\(\);[^\n]*\n\s*if \(attempt === 0\) \{/);
    expect(e2e).toMatch(/\{ crossed: zCrossed, crossedAt: zWhere, uncrossed: zUncrossed, uncrossedTrace: Object\.fromEntries\(zUncrossed\.map\(\(k\) => \[k, zTrace\[k\]\]\)\) \}/);
    const crossedAt = e2e.indexOf("const flying = inFlightCapture();");
    const zoomAt = e2e.indexOf("wc().setZoomLevel(1);", crossedAt);
    expect(crossedAt, "找得到「判交叉」那一行").toBeGreaterThan(-1);
    expect(zoomAt, "找得到「缩放」那一行").toBeGreaterThan(crossedAt);
    expect(e2e.slice(crossedAt, zoomAt), "判交叉与调 setZoomLevel 之间不能有 await（应答是宏任务，一让出就可能把「在飞」变成「已结束」）").not.toMatch(/\bawait\b/);
    expect(e2e).toMatch(/check\("cx-10b", [^\n]*zUncrossed\.length === 0/);
    expect(e2e).not.toMatch(/skip\("cx-10b"/);
    expect(e2e).toContain("SKIPPED(");
    // 收尾清理（第十五轮评审 P3-4）：先销毁剩下的窗口，rmSync 带重试，清不掉要告警——不能再 `catch {}` 吞掉
    const cleanupAt = e2e.indexOf("const cleanupTmp = () => {");
    expect(cleanupAt, "找得到 cleanupTmp").toBeGreaterThan(-1);
    const cleanup = e2e.slice(cleanupAt, e2e.indexOf("\nmain()", cleanupAt));
    expect(cleanup).toMatch(/BrowserWindow\.getAllWindows\(\)/);
    expect(cleanup).toMatch(/maxRetries: 5, retryDelay: 200/);
    expect(cleanup).toMatch(/console\.warn\(/);
    const doc = read("docs/BROWSER-AUTOMATION.md");
    expect(doc).toContain("capture-emulation-race.cjs");
    // 脚本头与文档写的 --timeout 曾经一个 240 一个 300（第九轮评审 P3-7）。脚本头是注释，所以这一条读原文
    const timeoutOf = (text: string) => text.match(/capture-emulation-race\.cjs --timeout (\d+)/)?.[1];
    expect(timeoutOf(e2eRaw)).toBeDefined();
    expect(timeoutOf(doc)).toBe(timeoutOf(e2eRaw));
  });

  // ── e2e 脚本收尾清理的扫描器（第十七轮评审 B-3：此前按「上一行必须是 try {」「之后第一个 catch」匹配，既有绕过也有误伤）──
  // 结构判断全部在 maskLiterals 之后的文本上做：字符串里的 `console.warn(` / `throw` / `fs.rmSync(` 不算代码；
  // 用括号配平代替按行匹配，所以 try 与 rmSync 之间有注释、参数拆成多行、warn 文案里带 throw 字样都不会误红；配对的 catch 取「try 块后面紧跟的那个」，不是「之后第一个出现的」。
  const matchParen = (masked: string, openIdx: number): number => {
    const open = masked[openIdx];
    const close = open === "(" ? ")" : open === "[" ? "]" : "}";
    let depth = 0;
    for (let i = openIdx; i < masked.length; i++) {
      if (masked[i] === open) depth++;
      else if (masked[i] === close && --depth === 0) return i;
    }
    return -1;
  };
  /** 在遮罩文本里把每个 `fs.rmSync(...)` 调用整段删掉，用来判断 try 块里是不是「只有清理调用」 */
  const dropRmSyncCalls = (masked: string): string => {
    let s = masked;
    for (;;) {
      const m = /\bfs\.rmSync\s*\(/.exec(s);
      if (!m) return s;
      const close = matchParen(s, m.index + m[0].length - 1);
      if (close < 0) return s;
      s = s.slice(0, m.index) + s.slice(close + 1);
    }
  };
  /**
   * 扫一份脚本源码（传入的必须已剥注释，即 readSource / stripComments 的结果）里的每处 `fs.rmSync(` 调用点：
   * ① 参数带 `recursive: true` + `maxRetries: 5` + `retryDelay: 200`（fs.rmSync 文档：后两项在非 recursive 时被忽略——第十七轮评审 B-1：r7 曾因此「补了重试」其实是空操作）；
   * ② 最内层包着它的 try 块里只有 `fs.rmSync(...)` 调用（否则 catch 会把别的错误也一并吞成告警）；
   * ③ try 块后面紧跟的是 catch，里面有 `console.warn(`、没有 `throw`、没有 `exit(`（清不掉只告警，不改退出码）；
   * ④ 不许有 `fs.rmSync` 以外的删除写法（`fs.rm` / `unlinkSync` / 裸 `rmSync` 等）——扫描器只认标准形态，别的写法会绕过上面三条。
   */
  const scanRmSyncSites = (code: string): { sites: number; bad: string[] } => {
    const masked = maskLiterals(code);
    const bad: string[] = [];
    let sites = 0;
    const hint = (at: number) => code.slice(at, at + 90).replace(/\s+/g, " ").trim();
    for (const m of masked.matchAll(/\bfs\.rmSync\s*\(/g)) {
      sites++;
      const at = m.index ?? 0;
      const open = at + m[0].length - 1;
      const close = matchParen(masked, open);
      if (close < 0) {
        bad.push(`括号没配上 → ${hint(at)}`);
        continue;
      }
      const args = code.slice(open + 1, close).replace(/\s+/g, " ");
      if (!/\brecursive: true\b/.test(args)) bad.push(`没带 recursive: true（maxRetries / retryDelay 在非 recursive 时被 Node 忽略，重试是空操作）→ ${hint(at)}`);
      if (!/\bmaxRetries: 5\b/.test(args) || !/\bretryDelay: 200\b/.test(args)) bad.push(`没带 maxRetries: 5 / retryDelay: 200 → ${hint(at)}`);
      // 最内层包着它的 try：matchAll 按位置递增，最后一个「开在它前面、关在它后面」的就是最内层
      let tryOpen = -1;
      let tryClose = -1;
      for (const t of masked.matchAll(/\btry\s*\{/g)) {
        const o = (t.index ?? 0) + t[0].length - 1;
        if (o > at) break;
        const c = matchParen(masked, o);
        if (c > close) {
          tryOpen = o;
          tryClose = c;
        }
      }
      if (tryOpen < 0) {
        bad.push(`不在 try 里 → ${hint(at)}`);
        continue;
      }
      if (dropRmSyncCalls(masked.slice(tryOpen + 1, tryClose)).replace(/[\s;]/g, "") !== "") bad.push(`try 块里除了 fs.rmSync(...) 还有别的语句（catch 会把它们的错误也吞成告警）→ ${hint(at)}`);
      const caught = /^\s*catch\s*(?:\([^)]*\))?\s*\{/.exec(masked.slice(tryClose + 1));
      if (!caught) {
        bad.push(`try 块后面紧跟的不是 catch（没有 catch / 只有 finally，清不掉会抛出去）→ ${hint(at)}`);
        continue;
      }
      const cOpen = tryClose + caught[0].length;
      const block = masked.slice(cOpen, matchParen(masked, cOpen) + 1);
      if (!/\bconsole\.warn\s*\(/.test(block)) bad.push(`catch 里没有 console.warn（等于静默吞掉）→ ${hint(at)}`);
      if (/\bthrow\b/.test(block)) bad.push(`catch 里又抛了 → ${hint(at)}`);
      if (/\bexit\s*\(/.test(block)) bad.push(`catch 里调了 exit（会改退出码）→ ${hint(at)}`);
    }
    for (const o of masked.matchAll(/(?<![.\w])(?:rmSync|rmdirSync|unlinkSync)\s*\(|\b(?:fs|fsp|promises)\.(?:rm|rmdir|rmdirSync|unlink|unlinkSync)\s*\(/g)) {
      bad.push(`用了 fs.rmSync 以外的删除写法（扫描器只认标准形态，会被绕过）→ ${hint(o.index ?? 0)}`);
    }
    return { sites, bad };
  };

  it("扫描器自检（第十七轮评审 B-3）：标准写法放行；缺 recursive、字符串里的 console.warn(、配错 catch、catch 里 exit、try 里夹别的语句、别的删除写法都要报，注释 / 多行参数 / warn 文案里的 throw 字样不误报", () => {
    const std = "{ recursive: true, force: true, maxRetries: 5, retryDelay: 200 }";
    const good = (body: string) => scanRmSyncSites(stripComments(body));
    // 放行
    expect(good(`try {\n  fs.rmSync(TMP, ${std});\n} catch (err) {\n  console.warn("SMOKE WARN", err);\n}`)).toEqual({ sites: 1, bad: [] });
    expect(good(`try {\n  // 注释夹在 try 与 rmSync 之间\n  fs.rmSync(\n    f,\n    ${std},\n  );\n} catch {\n  console.warn("清不掉");\n}`).bad, "注释 / 多行参数不该误红").toEqual([]);
    expect(good(`try { fs.rmSync(a, ${std}); fs.rmSync(b, ${std}); } catch (e) { console.warn("will throw soon", e); }`).bad, "warn 文案里的 throw 字样、同一个 try 里连删两个，不该误红").toEqual([]);
    expect(good(`const s = "fs.rmSync(x)"; // 字符串里提到不算调用点`), "字符串里的 fs.rmSync( 不是调用点").toEqual({ sites: 0, bad: [] });
    // 必须报
    const flagged = (body: string, needle: RegExp) => expect(good(body).bad.join("\n"), body).toMatch(needle);
    flagged(`try {\n  fs.rmSync(f, { force: true, maxRetries: 5, retryDelay: 200 });\n} catch (e) {\n  console.warn("x");\n}`, /没带 recursive: true/);
    flagged(`try {\n  fs.rmSync(f, { recursive: true, force: true });\n} catch (e) {\n  console.warn("x");\n}`, /没带 maxRetries/);
    flagged(`fs.rmSync(f, ${std});`, /不在 try 里/);
    flagged(`try {\n  fs.rmSync(f, ${std});\n} catch (e) {\n  const s = "console.warn(";\n}`, /catch 里没有 console\.warn/);
    flagged(`try {\n  fs.rmSync(f, ${std});\n} finally {\n  x();\n}\ntry {\n  y();\n} catch (e) {\n  console.warn("别的 try 的 catch");\n}`, /紧跟的不是 catch/);
    flagged(`try {\n  fs.rmSync(f, ${std});\n} catch (e) {\n  console.warn("x");\n  throw e;\n}`, /catch 里又抛了/);
    flagged(`try {\n  fs.rmSync(f, ${std});\n} catch (e) {\n  console.warn("x");\n  app.exit(1);\n}`, /调了 exit/);
    flagged(`try {\n  doOther();\n  fs.rmSync(f, ${std});\n} catch (e) {\n  console.warn("x");\n}`, /还有别的语句/);
    flagged(`fs.unlinkSync(f);`, /以外的删除写法/);
    flagged(`const { rmSync } = require("node:fs");\nrmSync(f);`, /以外的删除写法/);
  });

  // ── 第十八轮评审 R-2：契约的三处加固（helper 必须有调用点 / 白名单过期做成纯函数 / FATAL 出口也要清）──
  const escapeRe = (s: string) => s.replace(/[$.*+?^()|[\]{}\\]/g, "\\$&");
  /** 遮罩文本里的具名函数：`const x = (…) => { … }` / `function x(…) { … }`（含 async），带函数体花括号的范围 */
  const findNamedFunctions = (masked: string): { name: string; open: number; close: number }[] => {
    const out: { name: string; open: number; close: number }[] = [];
    for (const m of masked.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/g)) {
      const pClose = matchParen(masked, (m.index ?? 0) + m[0].length - 1);
      if (pClose < 0) continue;
      const arrow = /^\s*=>\s*\{/.exec(masked.slice(pClose + 1));
      if (!arrow) continue;
      const open = pClose + arrow[0].length;
      const close = matchParen(masked, open);
      if (close > 0) out.push({ name: m[1]!, open, close });
    }
    for (const m of masked.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g)) {
      const pClose = matchParen(masked, (m.index ?? 0) + m[0].length - 1);
      if (pClose < 0) continue;
      const body = /^\s*\{/.exec(masked.slice(pClose + 1));
      if (!body) continue;
      const open = pClose + body[0].length;
      const close = matchParen(masked, open);
      if (close > 0) out.push({ name: m[1]!, open, close });
    }
    return out;
  };
  /** 文件里 `fs.rmSync(` 站点所在的**最内层具名函数**的名字（去重）；站点在顶层 / 匿名回调里的不算。传入的必须已剥注释 */
  const rmSyncHelperNames = (code: string): string[] => {
    const masked = maskLiterals(code);
    const fns = findNamedFunctions(masked);
    const names = new Set<string>();
    for (const m of masked.matchAll(/\bfs\.rmSync\s*\(/g)) {
      const at = m.index ?? 0;
      const inner = fns.filter((f) => f.open < at && at < f.close).sort((a, b) => b.open - a.open)[0];
      if (inner) names.add(inner.name);
    }
    return [...names];
  };
  /**
   * helper 名在文件里除「定义本身」以外至少出现一次（调用 `name(`，或当引用传出去 `.then(name)`）。传入的必须已剥注释；字符串 / 注释里提到不算。
   * 只防「只定义、从不调用」的死代码绕过 scanRmSyncSites（第十八轮评审 R-2a：r14-mock-fulfill-probe 删掉两处 cleanupTmp() 调用，契约仍绿）；
   * 不证明调用点本身可达（比如只被另一个死函数调用）——那要真跑脚本才知道。
   */
  const helperHasCallSite = (code: string, name: string): boolean => {
    const masked = maskLiterals(code);
    for (const m of masked.matchAll(new RegExp(`(?<![.\\w$])${escapeRe(name)}(?![\\w$])`, "g"))) {
      const before = masked.slice(0, m.index ?? 0).replace(/\s+$/, "");
      if (/(?:\bconst|\blet|\bvar|\bfunction)$/.test(before)) continue; // 定义本身
      return true;
    }
    return false;
  };
  /** 白名单过期检查（纯函数）：条目对应的豁免已经不再需要（stillNeeded 为假）就是过期，返回这些条目名 */
  const staleAllowlistEntries = (entries: string[], stillNeeded: (entry: string) => boolean): string[] => entries.filter((e) => !stillNeeded(e));
  /** FATAL 出口：`.catch(<函数>)` 里调了 exit( / finish( 的那些参数块（脚本主流程抛错时的退出点）。传入遮罩文本 */
  const fatalCatchBlocks = (masked: string): string[] => {
    const blocks: string[] = [];
    for (const m of masked.matchAll(/\.catch\s*\(/g)) {
      const open = (m.index ?? 0) + m[0].length - 1;
      const close = matchParen(masked, open);
      if (close < 0) continue;
      const args = masked.slice(open + 1, close);
      if (/=>|\bfunction\b/.test(args) && /\b(?:app|process)\.exit\s*\(|\bfinish\s*\(/.test(args)) blocks.push(args);
    }
    return blocks;
  };
  /**
   * FATAL 路径体检：每个 FATAL 出口里都要在 exit 之前调到清理（具名 helper 的调用，或直接 fs.rmSync(）；返回问题描述，没问题返回 null。传入的必须已剥注释。
   * 边界：只看「.catch(函数) 里调 exit / finish」这一种出口——watchdog 定时器、脚本中途的早退 return 各有各的写法，机器认不全，由 manager-pick-e2e / page-scripts 那两条专门的钉子单独管；
   * 也不证明清理在真 Electron 里清得掉（Windows 下窗口 / manager 没销毁可能 EBUSY，只残留）。
   */
  const fatalPathProblem = (code: string): string | null => {
    const masked = maskLiterals(code);
    const blocks = fatalCatchBlocks(masked);
    if (blocks.length === 0) return "找不到 FATAL 出口（.catch(<函数>) 里调 exit( / finish( 的那种），没法确认抛错路径会清理";
    const helpers = rmSyncHelperNames(code);
    const cleanRes = [/\bfs\.rmSync\s*\(/, ...helpers.map((h) => new RegExp(`(?<![.\\w$])${escapeRe(h)}\\s*\\(`))];
    const problems = blocks.filter((b) => {
      const exitAt = b.search(/\b(?:app|process)\.exit\s*\(|\bfinish\s*\(/);
      const cleanAt = Math.min(...cleanRes.map((re) => (b.search(re) < 0 ? Infinity : b.search(re))));
      return !(cleanAt !== Infinity && cleanAt < exitAt); // 没清理，或清理排在 exit 之后（exit 之后的代码跑不到）
    });
    return problems.length ? `${problems.length}/${blocks.length} 个 FATAL 出口里没有在 exit 之前调清理（helper 调用 / fs.rmSync(）` : null;
  };

  // ── 第二十轮评审 R20-19：契约要核对「清理的就是 mkdtemp 建出来的那个目录」──
  // 之前的扫描只证明「有 fs.rmSync(、写法标准」，不证明它清的是 mkdtemp 的那个变量：脚本把 TMP 改了名、rmSync 还清旧名字 / 别的路径，
  // 契约照绿、临时目录照漏。
  /** 每个 `mkdtempSync(` 调用点赋给的具名变量（同一条语句里最近的 `const|let|var NAME =`）；没赋给具名变量的（内联传参）计入 unnamed。传入必须已剥注释 */
  const mkdtempVarNames = (code: string): { named: string[]; unnamed: number } => {
    const masked = maskLiterals(code);
    const named: string[] = [];
    let unnamed = 0;
    for (const m of masked.matchAll(/\bmkdtempSync\s*\(/g)) {
      const at = m.index ?? 0;
      const stmtStart = Math.max(masked.lastIndexOf(";", at), masked.lastIndexOf("}", at), masked.lastIndexOf("{", at));
      const decl = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/.exec(masked.slice(stmtStart + 1, at));
      if (decl) named.push(decl[1]!);
      else unnamed++;
    }
    return { named, unnamed };
  };
  /** 每处 `fs.rmSync(` 的第一个实参原文（第一个顶层逗号之前，空白折叠）。传入必须已剥注释 */
  const rmSyncFirstArgs = (code: string): string[] => {
    const masked = maskLiterals(code);
    const out: string[] = [];
    for (const m of masked.matchAll(/\bfs\.rmSync\s*\(/g)) {
      const open = (m.index ?? 0) + m[0].length - 1;
      const close = matchParen(masked, open);
      if (close < 0) continue;
      let depth = 0;
      let end = close;
      for (let i = open + 1; i < close; i++) {
        const ch = masked[i];
        if (ch === "(" || ch === "[" || ch === "{") depth++;
        else if (ch === ")" || ch === "]" || ch === "}") depth--;
        else if (ch === "," && depth === 0) {
          end = i;
          break;
        }
      }
      out.push(code.slice(open + 1, end).replace(/\s+/g, " ").trim());
    }
    return out;
  };
  /**
   * 用了 mkdtempSync 的脚本：每个 mkdtemp 变量都必须是某处 `fs.rmSync(` 的**第一个实参**（原样的变量名，`path.join(TMP, …)` 之类不算——那是清子路径、不是清目录本身）；
   * mkdtempSync 的结果不能内联传参（没有变量名就没法核对）。没问题返回 null。传入必须已剥注释。
   * 边界：只做名字层面的核对，不证明 rmSync 那一处在运行时可达、也不证明变量没被中途重新赋值。
   */
  const mkdtempCleanupProblem = (code: string): string | null => {
    const { named, unnamed } = mkdtempVarNames(code);
    if (unnamed > 0) return `有 ${unnamed} 处 mkdtempSync( 的结果没有赋给具名变量（内联传参），没法核对清理的是不是它`;
    if (named.length === 0) return null; // 没用 mkdtempSync：不归这条管
    const args = rmSyncFirstArgs(code);
    const missing = named.filter((n) => !args.includes(n));
    return missing.length ? `mkdtempSync 建出来的变量 ${missing.join(" / ")} 没有被任何 fs.rmSync( 当第一个实参清理（现有 rmSync 的第一个实参：${args.join(" | ") || "无"}）——临时目录会漏` : null;
  };

  it("R20-19 mkdtemp 变量与 rmSync 第一个实参的核对自检：同名放行；改名漏清 / 清子路径 / 内联传参 / 多个目录漏一个都要报；注释 / 字符串里的不算", () => {
    const std = "{ recursive: true, force: true, maxRetries: 5, retryDelay: 200 }";
    const probe = (s: string) => mkdtempCleanupProblem(stripComments(s));
    // 放行
    expect(probe(`const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "x-"));\ntry {\n  fs.rmSync(TMP, ${std});\n} catch (e) {\n  console.warn("w");\n}`)).toBeNull();
    expect(probe(`const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "x-")));\nfs.rmSync(TMP, ${std});`), "嵌在 realpathSync 里也认赋值的变量").toBeNull();
    expect(probe(`const A = fs.mkdtempSync("a-");\nconst B = fs.mkdtempSync("b-");\nfs.rmSync(A, ${std});\nfs.rmSync(\n  B,\n  ${std},\n);`), "两个目录都清（多行参数）").toBeNull();
    expect(probe(`const x = 1;`), "没用 mkdtempSync 的不归这条管").toBeNull();
    // 必须报
    expect(probe(`const TMP = fs.mkdtempSync("x-");\nfs.rmSync(OTHER, ${std});`), "清的是别的变量").toMatch(/TMP 没有被任何 fs\.rmSync\( 当第一个实参清理/);
    expect(probe(`const TMP = fs.mkdtempSync("x-");\nfs.rmSync(path.join(TMP, "sub"), ${std});`), "只清了子路径").toMatch(/TMP 没有被任何/);
    expect(probe(`const TMP = fs.mkdtempSync("x-");\nfs.rmSync(os.tmpdir(), ${std});`), "清了系统临时目录（更糟）").toMatch(/TMP 没有被任何/);
    expect(probe(`app.setPath("userData", fs.mkdtempSync("x-"));\nfs.rmSync(TMP, ${std});`), "内联传参没有变量名").toMatch(/没有赋给具名变量/);
    expect(probe(`const A = fs.mkdtempSync("a-");\nconst B = fs.mkdtempSync("b-");\nfs.rmSync(A, ${std});`), "两个目录漏清一个").toMatch(/B 没有被任何/);
    expect(probe(`const TMP = fs.mkdtempSync("x-");\n// fs.rmSync(TMP, ${std});\nconst s = "fs.rmSync(TMP, x)";`), "注释 / 字符串里提到清理不算").toMatch(/TMP 没有被任何/);
    expect(probe(`const TMP = fs.mkdtempSync("x-");`), "完全没清").toMatch(/现有 rmSync 的第一个实参：无/);
  });

  it("R-2 辅助函数自检（第十八轮评审 R-2）：helper 有调用点放行、只定义不调用要报（注释 / 字符串里的调用不算）；白名单过期；FATAL 出口要在 exit 之前清理", () => {
    const std = "{ recursive: true, force: true, maxRetries: 5, retryDelay: 200 }";
    const body = `try {\n    fs.rmSync(TMP, ${std});\n  } catch (err) {\n    console.warn("w", err);\n  }`;
    const src = (s: string) => stripComments(s);
    // ① helper 调用点
    const withCall = `const cleanupTmp = () => {\n  ${body}\n};\nmain().then(() => {\n  cleanupTmp();\n});`;
    const defOnly = `const cleanupTmp = () => {\n  ${body}\n};\nmain().then(() => {\n  app.exit(0);\n});`;
    expect(rmSyncHelperNames(src(withCall))).toEqual(["cleanupTmp"]);
    expect(helperHasCallSite(src(withCall), "cleanupTmp"), "有调用 → 过").toBe(true);
    expect(helperHasCallSite(src(defOnly), "cleanupTmp"), "只定义不调用 → 报").toBe(false);
    expect(helperHasCallSite(src(`${defOnly}\n// cleanupTmp();\nconst s = "cleanupTmp()";`), "cleanupTmp"), "注释 / 字符串里提到不算调用点").toBe(false);
    expect(helperHasCallSite(src(`async function cleanupTmp() {\n  ${body}\n}`), "cleanupTmp"), "function 声明写法：只定义也报").toBe(false);
    const viaRef = `const run = async () => {\n  ${body}\n};\napp.whenReady().then(run);`;
    expect(rmSyncHelperNames(src(viaRef))).toEqual(["run"]);
    expect(helperHasCallSite(src(viaRef), "run"), "当引用传出去（.then(run)）算用到").toBe(true);
    expect(rmSyncHelperNames(src(`app.whenReady().then(async () => {\n  ${body}\n});`)), "站点在匿名回调里：不是具名 helper").toEqual([]);
    expect(rmSyncHelperNames(src(`const outer = async () => {\n  const inner = () => {\n    ${body}\n  };\n  inner();\n};`)), "嵌套时取最内层").toEqual(["inner"]);
    expect(rmSyncHelperNames(src(`const sleep = (ms) => new Promise((r) => setTimeout(r, ms));\n${withCall}`)), "表达式体箭头函数不是 helper 容器").toEqual(["cleanupTmp"]);
    // ② 白名单过期
    expect(staleAllowlistEntries(["a.cjs", "b.cjs"], (f) => f === "a.cjs"), "豁免已不需要的条目被报").toEqual(["b.cjs"]);
    expect(staleAllowlistEntries(["a.cjs"], () => true), "仍需要的不报").toEqual([]);
    expect(staleAllowlistEntries([], () => false)).toEqual([]);
    // ③ FATAL 出口
    const helperDef = `const cleanupTmp = () => {\n  ${body}\n};\n`;
    const okFatal = `${helperDef}main().catch((e) => {\n  console.error(e);\n  cleanupTmp();\n  app.exit(1);\n});`;
    expect(fatalPathProblem(src(okFatal)), "清理在 exit 之前 → 过").toBeNull();
    expect(fatalPathProblem(src(`${helperDef}main().catch((e) => {\n  console.error(e);\n  app.exit(1);\n});`)), "FATAL 出口里没清").toMatch(/没有在 exit 之前调清理/);
    expect(fatalPathProblem(src(`${helperDef}main().catch((e) => {\n  console.error(e);\n  app.exit(1);\n  cleanupTmp();\n});`)), "清理排在 exit 之后（跑不到）").toMatch(/没有在 exit 之前调清理/);
    expect(fatalPathProblem(src(`${helperDef}main().catch((e) => {\n  // cleanupTmp();\n  const s = "cleanupTmp()";\n  app.exit(1);\n});`)), "注释 / 字符串里提到清理不算").toMatch(/没有在 exit 之前调清理/);
    expect(fatalPathProblem(src(`${helperDef}main().catch(() => {});`)), "没有 exit 的吞错 catch 不是 FATAL 出口 → 找不到出口").toMatch(/找不到 FATAL 出口/);
    expect(fatalPathProblem(src(`${helperDef}main().catch((e) => {\n  cleanupTmp();\n  app.exit(1);\n}).catch((e) => {\n  app.exit(2);\n});`)), "两个出口、其中一个没清").toMatch(/1\/2 个 FATAL 出口/);
    expect(fatalPathProblem(src(`main().catch((e) => {\n  try {\n    fs.rmSync(TMP, ${std});\n  } catch (err) {\n    console.warn("w");\n  }\n  finish(1);\n});`)), "直接内联 fs.rmSync 也算（finish 也是出口）").toBeNull();
  });

  it("真 Electron 脚本收尾清临时文件：每处 fs.rmSync( 都过 scanRmSyncSites（recursive + 重试、try 里只有它、紧跟的 catch 要 console.warn、不得抛 / 退出），且用了 mkdtempSync 的脚本都必须有清理；清理 helper 必须有调用点；FATAL 出口也要在 exit 之前清（第十五轮评审 P3-4：e2-p5a 30/30 通过却因 ENOTEMPTY 抛进 FATAL 分支、exit 1；第十六轮评审 P3-B1/B2/B3；第十七轮评审 B-1/B-2/B-3：r7 的重试是空操作、12 个脚本建了临时目录却从不清、契约只防得了「扫描器写坏」防不了「新脚本忘了清」；第十八轮评审 R-1/R-2：只在正常收尾清、helper 可以是死代码）", () => {
    // 一次性实验脚本（如 r14-experiment-tmp.cjs，永不提交、已在 .git/info/exclude）按 `*-experiment-tmp.cjs` 模式过滤，不靠硬编码文件名
    const files = readdirSync(resolve(root, "scripts/browser-e2e")).filter((f) => f.endsWith(".cjs") && !/-experiment-tmp\.cjs$/.test(f));
    /**
     * 允许建了临时目录而不清的脚本：脚本名 → 理由。目前没有——mkdtempSync 的脚本全部清理；新增条目必须写清为什么不能清。
     * 别把 r14-experiment-tmp.cjs 放进来：它被上面的 `*-experiment-tmp.cjs` 过滤了、不在 mkdtempUsers 里，放进来会被过期检查判红。
     */
    const NO_CLEANUP_ALLOWLIST: Record<string, string> = {};
    /**
     * 「FATAL 出口（.catch 里 exit）也清」这一条的已知例外：脚本名 → 理由。第十八轮评审 R-1 的范围只含下面 12 个脚本（加上本来就三条路径都清的 capture-emulation-race / bg-override-reattach；
     * 第二十轮 R20-19 又补上 r7-local-html——它的 FATAL 出口现在走 cleanupAll：关服务 / destroy manager / 销毁窗口 / 清 TMP）；
     * 其余是第十五 / 十六轮的写法——只在正常收尾清、FATAL 出口不清，这里把它们**登记为已知边界**（不是「已经清了」）。
     * 要补就在 FATAL 出口、exit 之前调同款清理，补完必须同步删掉这里的条目（过期检查会提醒）。
     */
    const NOT_CLEANED_ON_FATAL = "第十八轮 R-1 范围外：只在正常收尾清，FATAL 出口（.catch 里 exit）不清，临时目录会残留";
    const FATAL_NO_CLEANUP_ALLOWLIST: Record<string, string> = Object.fromEntries(
      [
        "actions-smoke.cjs",
        "bridge-peer.cjs",
        "e2-c4c5-clipboard-pdf.cjs",
        "e2-c6-maxtabs.cjs",
        "e2-c7-closed-shadow.cjs",
        "e2-c8-headless.cjs",
        "e2-p1-notif-probe.cjs",
        "e2-p1-permissions-net.cjs",
        "e2-p2-popup-incognito.cjs",
        "e2-p3-storage-evaluate.cjs",
        "e2-p4-net-rules.cjs",
        "e2-p5a-screenshot-scroll.cjs",
        "e2-p6-perf.cjs",
        "e2-p7a-sources.cjs",
        "e2-p7b-inspect.cjs",
        "e2-p8-debug.cjs",
        "e2-p9-record.cjs",
        "lock-display-off.cjs",
        "mermaid-render.cjs",
        "network-completeness.cjs",
        "r1-lifecycle.cjs",
        "r10-emulation-fit.cjs",
        "r11-local-html-file-url.cjs",
        "r12-speaker-select.cjs",
        "r7-image-viewer-copy.cjs",
        "smoke-suite.cjs",
        "v1-smoke.cjs",
        "v2-smoke.cjs",
        "v3-smoke.cjs",
        "v4-smoke.cjs",
        "v5-dialog-probe.cjs",
        "v5-smoke.cjs",
      ].map((f) => [f, NOT_CLEANED_ON_FATAL]),
    );
    /** 第十八轮评审 R-1 点名的 12 个脚本：正常收尾 + FATAL / 早退路径都清 */
    const R1_SCRIPTS = [
      "e2-p5b-emulate-touch.cjs",
      "exit-chain-e2e.cjs",
      "manager-pick-e2e.cjs",
      "page-scripts.cjs",
      "picker-e2e.cjs",
      "r13-panel-layout.cjs",
      "r14-mock-fulfill-probe.cjs",
      "r14-mock-no-fulfill-crash.cjs",
      "r17-task-split-restore.cjs",
      "r8-worker-no-detach.cjs",
      "r9-chat-split-cover.cjs",
      "v4-devtools-probe.cjs",
    ];
    let sites = 0;
    const withSites = new Set<string>();
    const mkdtempUsers = new Set<string>();
    const fatalClean = new Set<string>();
    const bad: string[] = [];
    for (const f of files) {
      const code = readSource(`scripts/browser-e2e/${f}`); // 剥掉注释：注释里提到 fs.rmSync( 不算调用点
      const scanned = scanRmSyncSites(code);
      sites += scanned.sites;
      if (scanned.sites > 0) withSites.add(f);
      for (const b of scanned.bad) bad.push(`${f}：${b}`);
      // 站点在具名 helper 里时，helper 必须有调用点（只定义不调用的死代码不算清理）
      for (const h of rmSyncHelperNames(code)) {
        if (!helperHasCallSite(code, h)) bad.push(`${f}：fs.rmSync( 在具名 helper ${h} 里，但文件里没有任何地方调用它——死代码清理不算清理`);
      }
      const usesMkdtemp = /\bmkdtempSync\s*\(/.test(maskLiterals(code));
      if (usesMkdtemp) mkdtempUsers.add(f);
      if (usesMkdtemp && scanned.sites === 0 && !(f in NO_CLEANUP_ALLOWLIST)) {
        bad.push(`${f}：用了 mkdtempSync 却没有任何 fs.rmSync( 清理——临时目录会越攒越多；补同款清理（见 v5-smoke.cjs 收尾），或写进 NO_CLEANUP_ALLOWLIST 并说明理由`);
      }
      if (usesMkdtemp && !(f in NO_CLEANUP_ALLOWLIST)) {
        // 清理的就是 mkdtemp 建出来的那个目录（R20-19）：没有变量名 / 清的是别的路径都会漏
        const cleanupProblem = mkdtempCleanupProblem(code);
        if (cleanupProblem) bad.push(`${f}：${cleanupProblem}`);
        const problem = fatalPathProblem(code);
        if (problem === null) fatalClean.add(f);
        else if (!(f in FATAL_NO_CLEANUP_ALLOWLIST)) bad.push(`${f}：${problem}——脚本抛错 / 提前失败时临时目录会残留；在 FATAL 出口 exit 之前补清理，或写进 FATAL_NO_CLEANUP_ALLOWLIST 并说明理由`);
      }
    }
    // 白名单过期：豁免对应的脚本现在已经有清理 / 不再建临时目录 / FATAL 出口已经会清，条目必须删
    for (const f of staleAllowlistEntries(Object.keys(NO_CLEANUP_ALLOWLIST), (e) => mkdtempUsers.has(e) && !withSites.has(e))) {
      bad.push(`${f}：NO_CLEANUP_ALLOWLIST 里的条目已过期（它现在有清理，或不再建临时目录）`);
    }
    for (const f of staleAllowlistEntries(Object.keys(FATAL_NO_CLEANUP_ALLOWLIST), (e) => mkdtempUsers.has(e) && !fatalClean.has(e))) {
      bad.push(`${f}：FATAL_NO_CLEANUP_ALLOWLIST 里的条目已过期（FATAL 出口现在会清，或脚本不再建临时目录）——删掉这条`);
    }
    for (const f of R1_SCRIPTS) {
      if (!fatalClean.has(f)) bad.push(`${f}：第十八轮 R-1 点名的脚本，FATAL 出口必须在 exit 之前清理`);
    }
    // 第二十轮 R20-19：这三个脚本的三条退出路径都清，不许退回白名单（白名单过期检查只防「白名单里多了不该有的」，防不了「它们被悄悄加进白名单」）
    for (const f of ["r7-local-html.cjs", "bg-override-reattach.cjs", "capture-emulation-race.cjs"]) {
      if (!fatalClean.has(f)) bad.push(`${f}：第二十轮 R20-19 点名的脚本，FATAL 出口必须在 exit 之前清理（不能登记进 FATAL_NO_CLEANUP_ALLOWLIST）`);
      if (f in FATAL_NO_CLEANUP_ALLOWLIST) bad.push(`${f}：不能在 FATAL_NO_CLEANUP_ALLOWLIST 里`);
    }
    // 第二十一轮：r21-mic-prompt 同样三条退出路径共用 cleanupAll（关 fixture 服务 / destroy manager / 销毁窗口 / 清 TMP），新脚本从一开始就不进白名单
    for (const f of ["r21-mic-prompt.cjs"]) {
      // 第二十二轮 R22-5：先确认文件真的在目录里——它是**未跟踪的新文件**，漏 `git add` 时本机目录里仍有、这条不会红，只有干净检出才红；
      // 到那时首条报错不该是下面的「FATAL 出口必须清理」（读不到文件就扫不出 FATAL 出口），而是「文件不存在」
      if (!files.includes(f)) {
        bad.push(`${f}：脚本文件不存在（新文件要手动 git add——已跟踪的文件引用着它，漏 add 的干净检出会在这里红）`);
        continue;
      }
      if (!fatalClean.has(f)) bad.push(`${f}：第二十一轮新增的脚本，FATAL 出口必须在 exit 之前清理（不能登记进 FATAL_NO_CLEANUP_ALLOWLIST）`);
      if (f in FATAL_NO_CLEANUP_ALLOWLIST) bad.push(`${f}：不能在 FATAL_NO_CLEANUP_ALLOWLIST 里`);
    }
    expect(bad).toEqual([]);
    // 精确对账（第十六轮评审 P3-B3：此前 `>= 30` 容忍丢 4 处）。新增 / 删除脚本或清理点要同步改这几个数；匹配写坏了也会在这里红，而不是「没扫到 = 没问题」
    expect(sites, "e2e 脚本里 fs.rmSync( 的调用点总数（r7-local-html 有 2 处：TMP + 两个小文件的循环；r14-mock-fulfill-probe 的 cleanupTmp 只有 1 处定义、3 处调用（两个正常收尾 + FATAL）；第十八轮 B5 新增 bg-override-reattach 1 处；第十八轮 R-1 给 12 个脚本加 FATAL 清理走各自的 cleanupTmp、没有新增站点；第二十一轮新增 r21-mic-prompt 1 处，在 cleanupAll 里）").toBe(49);
    expect(withSites.size, "含 fs.rmSync( 的脚本数").toBe(48);
    expect(mkdtempUsers.size, "用 mkdtempSync 的脚本数（都在上面的清理名单里）").toBe(48);
    expect(fatalClean.size, "FATAL 出口会在 exit 之前清理的脚本数 = R-1 的 12 个 + capture-emulation-race + bg-override-reattach + r7-local-html（R20-19）+ r21-mic-prompt（第二十一轮，三条退出路径共用 cleanupAll）（其余 32 个登记在 FATAL_NO_CLEANUP_ALLOWLIST）").toBe(16);
    expect(Object.keys(FATAL_NO_CLEANUP_ALLOWLIST).length + fatalClean.size, "FATAL 白名单 + 会清的 = 全部建临时目录的脚本").toBe(mkdtempUsers.size);
    // R-1 的两处不在 `.catch` 里的提前失败出口，机器认不全，单独钉：manager-pick 的「找不到 view」早退、page-scripts 的 watchdog 超时——都要先清再 exit，退出码不变
    const mgrPick = readSource("scripts/browser-e2e/manager-pick-e2e.cjs");
    expect(mgrPick).toMatch(/if \(!wc\) \{\s*server\.close\(\);\s*mgr\.destroy\(\);\s*cleanupTmp\(\);\s*app\.exit\(1\);\s*return;\s*\}/);
    const pageScripts = readSource("scripts/browser-e2e/page-scripts.cjs");
    expect(pageScripts).toMatch(/const watchdog = setTimeout\(\(\) => \{\s*console\.log\("E2E FAIL watchdog 超时"\);\s*cleanupTmp\(\);\s*app\.exit\(2\);\s*\}, 120000\);/);
    // e2-p5a：先放掉浏览器管理器和主窗口再清目录（Chromium 还在往 userData 写缓存时 rmSync 会撞 ENOTEMPTY）
    const p5a = readSource("scripts/browser-e2e/e2-p5a-screenshot-scroll.cjs");
    expect(p5a).toMatch(/server\.close\(\);\s*manager\.destroy\(\);\s*if \(!mainWin\.isDestroyed\(\)\) mainWin\.destroy\(\);[\s\S]*?try \{\s*fs\.rmSync\(TMP, /);
  });

  /**
   * 第二十三轮 R23-7 / R23-8：真 Electron「哨兵」脚本（没有 CI 自动跑，靠人在 Electron 升级 / 改权限闸之后重跑）的可信度约定。
   * 这类脚本最大的风险不是红，而是「悄悄变成绿」：跳过的项被记成通过、检查被删了没人发现、探针没有判别力时「没发现泄露」被当成通过。
   * 钉四件事：① 跳过 = skip()（不计入通过、退出码 4——不用 3：r8 / r9 / r14 / r17 的 3 是「脚本抛错」），不许有第三个参数写死 true 的 check（r12 以前有两处），
   * r12 也不许写死 false（环境限制不是失败：r12 以前在没有音频输出设备的机器上写死 false，整个脚本退出码 1，第二十四轮 P3-8；r21 里有两处有意的必失败分支，不一刀切）；
   * ② r21 的检查清单（删 / 改名 / 新增都要同步这份清单，防哨兵被悄悄删掉）；③ r21 的 ICE「不泄露」断言只经 judgeIce 判定（要等 S5 的对照出来）；
   * ④ r21 的 ICE 对照只是前提（INFO、不记 check），网卡判断排除链路本地地址（第二十四轮 P3-6）。
   */
  describe("真 Electron 哨兵脚本：跳过不算通过（R23-7 / R23-8）", () => {
    /** 脚本里 `check(` 调用的第三个参数（ok）是给定字面量（默认 true / !0 / 1；传 false 的模式查写死失败）的那些调用（取前 90 个字符作线索）。传入已剥注释的源码 */
    const constantOkChecks = (code: string, literal: RegExp): string[] => {
      const masked = maskLiterals(code);
      const hits: string[] = [];
      for (const m of masked.matchAll(/(?<![\w$.])check\(/g)) {
        const open = m.index! + m[0].length - 1;
        let depth = 0;
        let close = -1;
        for (let i = open; i < masked.length; i++) {
          const c = masked[i]!;
          if ("([{".includes(c)) depth++;
          else if (")]}".includes(c) && --depth === 0) {
            close = i;
            break;
          }
        }
        if (close < 0) continue;
        const args: string[] = [];
        let d = 0;
        let from = open + 1;
        for (let i = open + 1; i < close; i++) {
          const c = masked[i]!;
          if ("([{".includes(c)) d++;
          else if (")]}".includes(c)) d--;
          else if (c === "," && d === 0) {
            args.push(masked.slice(from, i));
            from = i + 1;
          }
        }
        args.push(masked.slice(from, close));
        if (args.length >= 3 && literal.test(args[2]!)) hits.push(code.slice(m.index!, m.index! + 90).replace(/\s+/g, " "));
      }
      return hits;
    };
    const constantTrueChecks = (code: string): string[] => constantOkChecks(code, /^\s*(?:true|!0|1)\s*$/);
    const constantFalseChecks = (code: string): string[] => constantOkChecks(code, /^\s*(?:false|!1|0)\s*$/);

    it("探测器自测（防它写坏了变成空转）：认得写死 true / false 的 check，不误伤带条件 / 嵌套调用的", () => {
      expect(constantFalseChecks('check("a", "b", false, "no audiooutput");')).toHaveLength(1);
      expect(constantFalseChecks("check(`a-${t}`, `n ${x}`, !1);")).toHaveLength(1);
      expect(constantFalseChecks('check("a", "b", x === false, 1);')).toHaveLength(0);
      expect(constantFalseChecks('check("a", "b", f(1, false), true);')).toHaveLength(0);
      expect(constantFalseChecks('check("a", "b", true, false);')).toHaveLength(0);
      expect(constantTrueChecks('check("a", "b", true, "skipped");')).toHaveLength(1);
      expect(constantTrueChecks("check(`a-${t}`, `n ${x}`, true);")).toHaveLength(1);
      expect(constantTrueChecks('check("a", "b", !0, 1);')).toHaveLength(1);
      expect(constantTrueChecks('check("a", "b", x === true, 1);')).toHaveLength(0);
      expect(constantTrueChecks('check("a", "b", f(1, true), true ? 1 : 2);')).toHaveLength(0);
      expect(constantTrueChecks('check("a", "b, true, c", ok, d);')).toHaveLength(0);
      expect(constantTrueChecks('const check = (id, name, ok, detail) => { results.push(ok); };')).toHaveLength(0);
    });

    it("r21 / r12：有 skip()、有 skipped 登记、退出码 0 / 1 / 2 / 4 的约定（INCOMPLETE 不占用其它脚本里「脚本抛错」的 3）；没有第三个参数写死 true 的 check（r12 另不许写死 false）", () => {
      for (const f of ["r21-mic-prompt.cjs", "r12-speaker-select.cjs"]) {
        const code = readSource(`scripts/browser-e2e/${f}`);
        expect(code, `${f}：缺 skip()（跳过必须明说 SKIP、记进 skipped，不能记成 PASS）`).toMatch(/const skip = \(id, name, reason\) => \{\s*skipped\.push\(\{ id, name, reason \}\);/);
        expect(code, `${f}：退出码约定 0 全过 / 1 断言失败 / 4 有跳过（INCOMPLETE）`).toContain("app.exit(failed.length ? 1 : skipped.length ? 4 : 0)");
        expect(code, `${f}：INCOMPLETE 不能再用 3（r8 / r9 / r14 / r17 的 3 是脚本抛错；各脚本的退出码各有约定，但新增的用法不该与已有的撞车）`).not.toMatch(/skipped\.length \? 3\b/);
        expect(code, `${f}：脚本抛错路径退出码 2`).toMatch(/\.catch\(\(e\) => \{[\s\S]*?app\.exit\(2\);/);
        expect(constantTrueChecks(code), `${f}：有 check() 的 ok 参数写死 true——环境不满足而没跑的项要用 skip()，不能记一条恒真的 PASS`).toEqual([]);
      }
      // 写死 false 只查 r12（它以前把「没有音频输出设备」这种环境限制记成 false）；r21 里有两处有意的「必失败」分支（judgeIce 见了真实地址、S10 弹窗没开出来），不能一刀切
      expect(constantFalseChecks(readSource("scripts/browser-e2e/r12-speaker-select.cjs")), "r12：环境限制（没音频设备 / 没有具体扬声器……）要用 skip()，不能写死 false 让整个脚本以失败收场").toEqual([]);
      // 其它脚本里 3 仍然是「脚本抛错」：约定变了要同步改这里（防哪天有人把 INCOMPLETE 又改回 3 而没发现冲突）
      for (const f of ["r8-worker-no-detach.cjs", "r9-chat-split-cover.cjs", "r14-mock-no-fulfill-crash.cjs", "r17-task-split-restore.cjs"]) {
        expect(readSource(`scripts/browser-e2e/${f}`), `${f}：退出码 3 = 脚本抛错（FATAL）`).toMatch(/SMOKE FAIL fatal[\s\S]{0,200}app\.exit\(3\)/);
      }
    });

    it("r21 检查清单：每个 id 都在（删 / 改名 / 新增必须同步这份清单——这些检查就是 ICE 泄露、桩形状、取消不进冷却等回归的唯一哨兵）", () => {
      const code = readSource("scripts/browser-e2e/r21-mic-prompt.cjs");
      const ids = new Set<string>();
      for (const m of code.matchAll(/["`](r21-[A-Za-z0-9${}._-]+)["`]/g)) ids.add(m[1]!);
      ids.delete("r21-task"); // 不是检查，是脚本里的任务 id
      expect([...ids].sort()).toEqual(
        [
          // 带 ${tag}（s2 / s3 / s7 的 frameScenario 与 loadFrame）的模板 id
          "r21-${tag}-${suffix}",
          "r21-${tag}-allowed",
          "r21-${tag}-denied",
          "r21-${tag}-frame-ready",
          "r21-${tag}-grant-on-top",
          "r21-${tag}-labels-hidden",
          "r21-${tag}-no-reprompt",
          "r21-${tag}-prompt",
          "r21-${tag}-query-prompt",
          "r21-${tag}-stub-installed",
          // S1 顶层页面（含 ICE 不泄露、冷却态）
          "r21-cooldown-no-reprompt",
          "r21-cooldown-recorded",
          "r21-gum-denied",
          "r21-gum-prompt",
          "r21-ice-no-leak-ask",
          "r21-ice-no-leak-cooldown",
          "r21-labels-hidden-before",
          "r21-no-prompt-from-query",
          "r21-query-in-cooldown",
          "r21-query-prompt",
          "r21-stub-at-start-top",
          "r21-stub-installed",
          "r21-stub-shape",
          // S4 没有 allow
          "r21-s4-denied",
          "r21-s4-no-prompt",
          "r21-s4-query-denied",
          "r21-s4-recorded",
          // S5 AI 授予 / reset（含 ICE 对照）
          "r21-s5-grant",
          "r21-s5-gum-no-prompt",
          "r21-s5-ice-after-reset",
          "r21-s5-ice-control",
          "r21-s5-labels",
          "r21-s5-query",
          "r21-s5-query-after-reset",
          "r21-s5-query-before",
          "r21-s5-reset",
          // S6 allow 的 origin 列表不含该 iframe
          "r21-s6-denied",
          "r21-s6-no-prompt",
          "r21-s6-query-denied",
          "r21-s6-recorded",
          // S8 取消不进冷却 / S9 政策禁用
          "r21-s8-cancelled",
          "r21-s8-no-cooldown",
          "r21-s8-prompt",
          "r21-s9-policy-blocked",
          // S10 window.open 弹窗（被收养成同会话的 tab；R24-1 的哨兵）/ S11 非安全上下文（桩不改读数）
          "r21-s10-denied",
          "r21-s10-gum-prompt",
          "r21-s10-popup-adopted",
          "r21-s10-query-prompt",
          "r21-s10-stub-installed",
          "r21-s11-insecure-denied",
          // S12 文档解析期就请求麦克风（第二十五轮 N-1：`did-navigate` 里的 cancelMine() 不能误取消解析期弹出的提示）：两种页面 × 两种导航
          "r21-s12-query-gum-cross-origin",
          "r21-s12-query-gum-same-origin",
          "r21-s12-sync-gum-cross-origin",
          "r21-s12-sync-gum-same-origin",
        ].sort(),
      );
    });

    it("r21 的 ICE「不泄露」断言只经 judgeIce 判定，且判定排在 S5 对照之后（对照没有判别力 = SKIP；已见真实地址 = 无论对照如何都失败）", () => {
      const code = readSource("scripts/browser-e2e/r21-mic-prompt.cjs");
      // 三条不泄露断言不能直接 check(...)（那样对照失败时它们已经是 PASS 了）
      expect(code).not.toMatch(/\bcheck\(\s*"r21-(?:ice-no-leak-ask|ice-no-leak-cooldown|s5-ice-after-reset)"/);
      const control = code.indexOf("iceControlOk = iceG.real > 0;");
      const judgeDef = code.indexOf("const judgeIce = (id, name, sum) => {");
      const judgeLoop = code.indexOf("for (const e of iceNoLeak) judgeIce(e.id, e.name, e.sum);");
      expect(control, "找不到 S5 对照里的 iceControlOk 赋值").toBeGreaterThan(0);
      expect(judgeDef, "找不到 judgeIce 定义").toBeGreaterThan(control);
      expect(judgeLoop, "S1 采样的两条不泄露断言要在 S5 对照之后统一判").toBeGreaterThan(judgeDef);
      // reset 之后的那条也只经 judgeIce
      expect(code).toContain('judgeIce("r21-s5-ice-after-reset"');
      // 对照是前提（INFO），不再记一条恒真的 check（计进「N/N 通过」只会虚增，P3-6）；对照不成立时只以 skip 记
      expect(code).not.toMatch(/\bcheck\(\s*"r21-s5-ice-control"/);
      expect(code).toMatch(/skip\("r21-s5-ice-control"/);
    });

    it("judgeIce 的判定真值表（把脚本里那段函数源码放进 vm 真跑，不是字符串匹配）：见了真实地址一律失败；对照没判别力一律跳过（含断网时一个候选都没有）；对照成立时「干净且有候选」才通过、一个候选都没有算失败（P3-6）", () => {
      const code = readSource("scripts/browser-e2e/r21-mic-prompt.cjs");
      const body = blockAfter(code, "const judgeIce = (id, name, sum) => {");
      const judge = (iceControlOk: boolean, sum: { total: number; real: number }): string[] => {
        const calls: string[] = [];
        const fn = vm.runInNewContext(`(id, name, sum) => ${body}`, {
          iceControlOk,
          check: (_id: string, _name: string, ok: boolean) => calls.push(ok ? "pass" : "fail"),
          skip: () => calls.push("skip"),
        }) as (id: string, name: string, sum: unknown) => void;
        fn("x", "y", sum);
        return calls;
      };
      // 对照不成立（这台机器上探针看不见真实地址）
      expect(judge(false, { total: 4, real: 0 })).toEqual(["skip"]);
      expect(judge(false, { total: 0, real: 0 })).toEqual(["skip"]); // 断网：没有候选不能判失败
      expect(judge(false, { total: 4, real: 2 })).toEqual(["fail"]); // 但只要看见了真实地址就是泄露
      // 对照成立
      expect(judge(true, { total: 4, real: 0 })).toEqual(["pass"]);
      expect(judge(true, { total: 0, real: 0 })).toEqual(["fail"]); // 对照能看见、这一次却一个候选都没有：探针没跑起来，不能当「没泄露」
      expect(judge(true, { total: 4, real: 1 })).toEqual(["fail"]);
    });

    it("r21 的网卡判断排除链路本地地址（169.254 / fe80::，macOS 的 awdl0 / utun 常驻）：假定它们通常不会出现在 ICE 候选里（作者机器的对照里没见过，不是普适结论），计入会让没网的机器误以为探针有判别力（P3-6）", () => {
      const code = readSource("scripts/browser-e2e/r21-mic-prompt.cjs");
      const decl = /const isLinkLocalAddress = [^\n]+;/.exec(code)?.[0];
      expect(decl, "找不到 isLinkLocalAddress 定义").toBeTruthy();
      const isLinkLocal = vm.runInNewContext(`${decl}; isLinkLocalAddress`) as (a: string) => boolean;
      for (const yes of ["169.254.12.3", "fe80::1", "fe80::1%en0", "FE80::abcd", "febf::1"]) expect(isLinkLocal(yes), yes).toBe(true);
      for (const no of ["192.168.1.5", "10.0.0.1", "169.255.0.1", "2001:db8::1", "fd00::1", "fec0::1", "::1", "127.0.0.1"]) expect(isLinkLocal(no), no).toBe(false);
      // nicInfo 真的用它过滤
      expect(blockAfter(code, "const nicInfo = () => {")).toMatch(/a\.internal \|\| isLinkLocalAddress\(a\.address\)/);
    });
  });

  it("R20-19 r7-local-html：FATAL 出口与正常收尾共用 cleanupAll——先关假 Flowship 服务、destroy manager、销毁窗口、最后清 TMP；服务 / manager 一建好就登记", () => {
    const code = readSource("scripts/browser-e2e/r7-local-html.cjs");
    const cleanup = blockAfter(code, "const cleanupAll = () => {");
    // 顺序：服务 → manager → 窗口 → rmSync(TMP)（Chromium 还抱着 userData 时先清会 ENOTEMPTY）
    const iServer = cleanup.indexOf("live.flowServer?.close()");
    const iManager = cleanup.indexOf("live.manager?.destroy()");
    const iWindows = cleanup.indexOf("BrowserWindow.getAllWindows()");
    const iRm = cleanup.indexOf("fs.rmSync(TMP,");
    expect([iServer, iManager, iWindows, iRm].every((i) => i >= 0), "cleanupAll 里四步都在").toBe(true);
    expect(iServer).toBeLessThan(iManager);
    expect(iManager).toBeLessThan(iWindows);
    expect(iWindows).toBeLessThan(iRm);
    // 登记点：建好立刻登记（登记之前抛错的话没有东西可放，登记之后任何一步抛错都放得掉）
    expect(code).toMatch(/const flow = await startFakeFlowship\(\);\s*live\.flowServer = flow\.server;/);
    expect(code).toMatch(/\}\);\s*live\.manager = manager;\s*manager\.registerIpc\(\);/);
    // 两条退出路径都调：正常收尾（summary 之后、exit 之前）与 .catch
    expect(code).toMatch(/SMOKE SUMMARY \$\{passed\}\/\$\{results\.length\} passed`\);\s*cleanupAll\(\);[^\n]*\n\s*app\.exit\(passed === results\.length \? 0 : 1\);/);
    expect(code).toMatch(/\(FATAL\)`\);\s*cleanupAll\(\);[^\n]*\n\s*app\.exit\(1\);/);
    // TMP 只在 cleanupAll 里清一次（不再有第二处裸清理）；另一处 rmSync 是两个小文件的循环（变量 f）
    expect(rmSyncFirstArgs(code)).toEqual(["TMP", "f"]);
  });

  it("R20-19 bg-override-reattach：会卡住的异步调用都带总超时；三条退出路径共用 cleanupAll（关服务 / destroy manager / 销毁窗口 / 清 TMP）", () => {
    const code = readSource("scripts/browser-e2e/bg-override-reattach.cjs");
    const masked = maskLiterals(code);
    // ① 脚本直发的原始命令（rawSend）带超时，插桩转发走无超时那份（tab 自己的 CDP 调用超时语义归 tab，不能被脚本替它缩短）
    expect(code).toMatch(/const sendUnbounded = dbg\.sendCommand\.bind\(dbg\);/);
    expect(code).toMatch(/const rawSend = \(method, params, sessionId\) => withTimeout\(sendUnbounded\(method, params, sessionId\), 15000, `rawSend\(\$\{method\}\)`\);/);
    expect(blockAfter(code, "dbg.sendCommand = (method, params, sessionId) => {")).toMatch(/return sendUnbounded\(method, params, sessionId\);/);
    // ② 每个 loadURL / manager.dispatch 都在 withTimeout( 里：往前找最近的 withTimeout( 且中间没有语句边界
    const wrapped = (needle: RegExp): void => {
      const hits = [...masked.matchAll(needle)];
      expect(hits.length, `找不到 ${needle}`).toBeGreaterThan(0);
      for (const h of hits) {
        const before = masked.slice(Math.max(0, (h.index ?? 0) - 40), h.index ?? 0);
        expect(before, `${needle} 必须直接写在 withTimeout( 里`).toMatch(/withTimeout\($/);
      }
    };
    wrapped(/\bmainWin\.loadURL\(/g);
    wrapped(/\bwc\(\)\.loadURL\(/g);
    wrapped(/\bmanager\.dispatch\(/g);
    wrapped(/\btab\(\)\.ensureCdp\(/g);
    // tab().send( 的几处（tabShot / transparentShot）同理
    wrapped(/\btab\(\)\.send\(/g);
    // ③ 收尾：顺序 服务 → manager → 窗口 → rmSync；三条路径都调
    const cleanup = blockAfter(code, "const cleanupAll = () => {");
    const order = ["live.server?.close()", "live.manager?.destroy()", "BrowserWindow.getAllWindows()", "fs.rmSync(TMP,"].map((s) => cleanup.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(code).toMatch(/live\.server = server;/);
    expect(code).toMatch(/live\.manager = manager;/);
    const tail = code.slice(code.indexOf("\nmain()"));
    expect(tail).toMatch(/\.then\(\(\) => \{[\s\S]*?cleanupAll\(\);\s*app\.exit\(failed\.length \? 1 : 0\);/);
    expect(tail).toMatch(/\.catch\(\(e\) => \{[\s\S]*?cleanupAll\(\);\s*app\.exit\(2\);/);
    // main 里不再留裸的 server.close() / manager.destroy()（统一在 cleanupAll；留着等于抛错路径又只有一半收尾）
    const mainBody = code.slice(code.indexOf("const main = async () => {"), code.indexOf("const cleanupAll"));
    expect(mainBody).not.toMatch(/\bserver\.close\(\)/);
    expect(mainBody).not.toMatch(/\bmanager\.destroy\(\)/);
  });
});

// ───────────────────────── 渲染端 ─────────────────────────

describe("viewFitCssOf / fitScaleLabelOf", () => {
  it("viewFitCssOf：换成相对占位 div 的百分比（与宿主缩放无关）", () => {
    expect(viewFitCssOf({ left: 0.25, top: 0, width: 0.5, height: 1 })).toEqual({ left: "25%", top: "0%", width: "50%", height: "100%" });
    expect(viewFitCssOf({ left: 130 / 1700, top: 0, width: 1440 / 1700, height: 1 })).toEqual({
      left: "7.647%",
      top: "0%",
      width: "84.706%",
      height: "100%",
    });
  });

  it("居中时 left + width 的浮点误差不致被当成非法", () => {
    const left = 0.1 + 0.2; // 0.30000000000000004
    expect(viewFitCssOf({ left, top: 0, width: 1 - left, height: 1 })).not.toBeNull();
  });

  it("缺省 / 非法 / 越界：返回 null，调用方退回铺满占位 div（宁可拉伸也别把图摆到看不见的地方）", () => {
    for (const bad of [
      undefined,
      null,
      { left: -0.1, top: 0, width: 0.5, height: 1 },
      { left: 0, top: 0, width: 0, height: 1 },
      { left: 0, top: 0, width: 1, height: -1 },
      { left: 0.6, top: 0, width: 0.6, height: 1 },
      { left: 0, top: 0.5, width: 1, height: 0.6 },
      { left: Number.NaN, top: 0, width: 1, height: 1 },
      { left: 0, top: 0, width: Number.POSITIVE_INFINITY, height: 1 },
      { left: "0", top: 0, width: 1, height: 1 },
    ]) {
      expect(viewFitCssOf(bad as never)).toBeNull();
    }
  });

  it("fitScaleLabelOf：只在 0<s<1 时给「适应 xx%」，取整", () => {
    expect(fitScaleLabelOf({ fitScale: 0.722 })).toBe("适应 72%");
    expect(fitScaleLabelOf({ fitScale: 0.6 })).toBe("适应 60%");
    expect(fitScaleLabelOf({ fitScale: 0.1 })).toBe("适应 10%");
    for (const bad of [undefined, null, {}, { fitScale: 1 }, { fitScale: 1.2 }, { fitScale: 0 }, { fitScale: -0.5 }, { fitScale: Number.NaN }, { fitScale: "0.5" }]) {
      expect(fitScaleLabelOf(bad as never)).toBeNull();
    }
  });

  it("R9-07 ①：取整后到 100 的（0.995 ≤ s < 1，实际只缩了不到半个百分点）不显示「适应 100%」——与主进程「100 = 不缩放」同口径", () => {
    expect(fitScaleLabelOf({ fitScale: 0.995 })).toBeNull();
    expect(fitScaleLabelOf({ fitScale: 0.999 })).toBeNull();
    expect(fitScaleLabelOf({ fitScale: 0.994 })).toBe("适应 99%");
    expect(fitScaleLabelOf({ fitScale: 0.99 })).toBe("适应 99%");
    // 极小的比例保底 1%，不会显示「适应 0%」
    expect(fitScaleLabelOf({ fitScale: 0.001 })).toBe("适应 1%");
  });

  it("R9-07 ②：fitScalePercentOf 是数字的唯一出处——标签和 tooltip 共用，不再靠 `fitLabel.replace(\"适应 \", \"\")` 切文案", () => {
    expect(fitScalePercentOf({ fitScale: 0.722 })).toBe(72);
    expect(fitScalePercentOf({ fitScale: 0.6 })).toBe(60);
    expect(fitScalePercentOf({ fitScale: 0.995 })).toBeNull();
    for (const bad of [undefined, null, {}, { fitScale: 1 }, { fitScale: 1.2 }, { fitScale: 0 }, { fitScale: -0.5 }, { fitScale: Number.NaN }, { fitScale: "0.5" }]) {
      expect(fitScalePercentOf(bad as never)).toBeNull();
    }
    // 标签与百分比永远对得上（同一个函数算出来的）
    for (const s of [0.1, 0.333, 0.5, 0.722, 0.9, 0.994]) {
      expect(fitScaleLabelOf({ fitScale: s })).toBe(`适应 ${fitScalePercentOf({ fitScale: s })}%`);
    }
  });
});

describe("store：viewFit / fitScale 变了推送不能被当成「没变」吞掉", () => {
  const mkTab = (extra: Partial<TabInfo> = {}): TabInfo => ({
    id: "t1",
    url: "https://example.com/",
    title: "x",
    favicon: null,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    isActive: true,
    emulation: "Desktop 1440",
    ...extra,
  });
  const mkState = (tab: TabInfo): BrowserState =>
    ({ taskId: "k1", exists: true, controller: "idle", tabs: [tab], activeTabId: tab.id, recent: [] }) as unknown as BrowserState;

  it("sameTab 比 viewFit：同内容的新对象 = 没变（保持引用）；位置变了 / 出现 / 消失 = 变了", () => {
    const store = createBrowserStore(() => undefined);
    store.setState(mkState(mkTab({ viewFit: { left: 0.1, top: 0, width: 0.8, height: 1 } })));
    const first = store.getState("k1")!.tabs[0]!;

    store.setState(mkState(mkTab({ viewFit: { left: 0.1, top: 0, width: 0.8, height: 1 } })));
    expect(store.getState("k1")!.tabs[0]).toBe(first); // 内容一样：不换引用、不唤醒订阅者

    store.setState(mkState(mkTab({ viewFit: { left: 0.2, top: 0, width: 0.6, height: 1 } })));
    expect(store.getState("k1")!.tabs[0]!.viewFit).toEqual({ left: 0.2, top: 0, width: 0.6, height: 1 });

    store.setState(mkState(mkTab()));
    expect(store.getState("k1")!.tabs[0]!.viewFit).toBeUndefined();
  });

  it("sameTab 比 fitScale：变了 / 出现 / 消失都要更新；缺省与 1 等价", () => {
    const store = createBrowserStore(() => undefined);
    store.setState(mkState(mkTab({ fitScale: 0.7 })));
    const first = store.getState("k1")!.tabs[0]!;
    store.setState(mkState(mkTab({ fitScale: 0.7 })));
    expect(store.getState("k1")!.tabs[0]).toBe(first);
    store.setState(mkState(mkTab({ fitScale: 0.5 })));
    expect(store.getState("k1")!.tabs[0]!.fitScale).toBe(0.5);
    store.setState(mkState(mkTab()));
    expect(store.getState("k1")!.tabs[0]!.fitScale).toBeUndefined();
  });
});

describe("源码契约", () => {
  it("BrowserViewport：遮盖图按 viewFit 定位，缺省仍铺满；订阅只取激活 tab 的 viewFit，不订阅整份状态", () => {
    const src = read("src/components/browser/browser-viewport.tsx");
    expect(src).toContain("viewFitCssOf(useActiveViewFit(taskId))");
    expect(src).toContain("style={coverBox ?? undefined}");
    expect(src).toMatch(/!coverBox && "inset-0 size-full"/);
    expect(src).not.toContain("useBrowserSession");
  });

  it("面板：缩放生效时在模拟标签上带「适应 xx%」和解释", () => {
    const src = read("src/components/browser/browser-panel.tsx");
    expect(src).toContain("fitScaleLabelOf(activeTab)");
    expect(src).toContain("页面已整体缩小到");
  });

  it("面板（R9-05 / R9-07 ②）：tooltip 的数字来自 fitScalePercentOf、不再 replace 切文案；模拟标签是工具栏之外的独立一行，「适应」徽标是单独的 shrink-0", () => {
    const src = read("src/components/browser/browser-panel.tsx");
    expect(src).toContain("fitScalePercentOf(activeTab)");
    expect(src).not.toContain('fitLabel.replace("适应 "');
    // 模拟条是自己的 data-slot，在工具栏（data-slot="browser-toolbar"）结束之后才出现——不在工具栏里
    const iToolbar = src.indexOf('data-slot="browser-toolbar"');
    const iEmu = src.indexOf('data-slot="browser-emulation-bar"');
    const iTabStrip = src.indexOf("<TabStrip");
    expect(iToolbar).toBeGreaterThan(0);
    expect(iEmu).toBeGreaterThan(iToolbar);
    expect(iEmu).toBeLessThan(iTabStrip);
    const iEmuOpen = src.lastIndexOf("{emulationLabel &&", iEmu); // 模拟条自己的开头
    expect(iEmuOpen).toBeGreaterThan(iToolbar);
    expect(src.slice(iToolbar, iEmuOpen)).not.toContain("emulationLabel"); // 工具栏的 JSX 里没有模拟标签
    expect(src).toMatch(/\{fitLabel && <span className="shrink-0 tabular-nums">\{fitLabel\}<\/span>\}/);
    // 工具栏：窄面板按自己的宽度（容器查询）让缩放标签让位，内层 overflow-hidden 兜底
    expect(src).toContain("@container min-w-0 shrink-0");
    expect(src).toContain("tabular-nums @max-[360px]:hidden");
    expect(src).toMatch(/data-slot="browser-toolbar"\s+className="[^"]*overflow-hidden[^"]*"/);
  });

  it("分栏抓手（R9-06）：宽度收进分隔条本体，不再用 14px 宽的 GripVertical 图标", () => {
    const src = read("src/components/ui/resizable.tsx");
    expect(src).toContain('data-slot="resize-grip"');
    expect(src).toMatch(/data-slot="resize-grip"\s+className="[^"]*\bw-1\.5\b[^"]*"/);
    expect(src).not.toMatch(/import\s*\{[^}]*GripVertical/); // 注释里提到这个词没关系，别 import 回来
    expect(src).not.toMatch(/<GripVertical/);
    expect(src).not.toMatch(/h-8 w-4\b/);
  });

  it("Tab：视图矩形只经 #applySlot 设置，停车场路径清掉槽位；缩放重算与模拟变化串在同一个队列里", () => {
    const src = readSource("electron-app/browser/tab.mjs"); // 剥注释：注释里提到 view.setBounds( 不该被算进次数
    // 除了停车场固定矩形（#park 立刻摆 / 截图在飞时推迟到 #afterCapture 摆，共两处）外，view.setBounds 只在 #applySlot 里出现一次
    expect(src.match(/this\.view\.setBounds\(/g) ?? []).toHaveLength(3);
    expect(src.match(/this\.view\.setBounds\(\{ \.\.\.PARKING_BOUNDS \}\)/g) ?? []).toHaveLength(2);
    expect(src).toMatch(/#applySlot\(\) \{[\s\S]*?fitBoundsToEmulation\(this\.#slot, this\.emulation, this\.#fitScale\)[\s\S]*?this\.view\.setBounds\(bounds\)/);
    // 成功路径与失败回滚路径都经 #refit 重算缩放并重摆视图
    const apply = src.slice(src.indexOf("async #applyEmulationNow"), src.indexOf("resetEmulation() {"));
    expect(apply.match(/await this\.#refit\(\)/g) ?? []).toHaveLength(2);
    // 视口命令都带上缩放（正常 / 回滚 / 重放）
    expect(apply.match(/withFitScale\(/g) ?? []).toHaveLength(2);
    expect(src).toMatch(/#replayEmulation\(queued = false\) \{[\s\S]*?const commands = withFitScale\(/);
    // 两条离开主窗口的路径都清槽位 / viewFit
    expect(src.match(/this\.#slot = null;\s+this\.viewFit = null;/g) ?? []).toHaveLength(2);
    // 槽位变化只「排」重算任务（合并），不直接发 CDP
    expect(src).toMatch(/setBounds\(bounds\) \{[\s\S]*?this\.#scheduleRefit\(\)/);
    expect(src).toMatch(/#scheduleRefit\(\) \{[\s\S]*?this\.#enqueueEmulation\(/);
  });

  it("Tab.send（实际发送在它调用的 #sendNow）是内置浏览器里唯一碰 debugger.sendCommand 的地方（并在这里补偿输入坐标）；唯一例外是 Mermaid 渲染服务的私有隐藏窗口", () => {
    const dir = resolve(root, "electron-app");
    const hits: string[] = [];
    const walk = (d: string) => {
      for (const n of readdirSync(d)) {
        const f = join(d, n);
        if (statSync(f).isDirectory()) walk(f);
        else if (f.endsWith(".mjs") && /\bsendCommand\(/.test(readFileSync(f, "utf8"))) hits.push(f.slice(root.length + 1));
      }
    };
    walk(dir);
    // 例外：electron-app/mermaid-render.mjs（飞书回复里的 mermaid 出图）在**自己的私有隐藏窗口**里发视口模拟 + 截图，
    // 不碰任何用户 / AI 的标签页、不发输入事件，所以不存在「输入坐标要按缩放补偿」的问题。
    // 下面把它能发的命令钉死：谁往里加 Input.* 之类的命令，这条就红，逼着重新评估是否该走 Tab.send
    expect([...hits].sort()).toEqual(["electron-app/browser/tab.mjs", "electron-app/mermaid-render.mjs"]);
    const mermaidMethods = [...readSource("electron-app/mermaid-render.mjs").matchAll(/sendCommand\(\s*"([A-Za-z.]+)"/g)].map((m) => m[1]);
    expect(new Set(mermaidMethods)).toEqual(
      new Set(["Emulation.setDeviceMetricsOverride", "Page.captureScreenshot", "Emulation.clearDeviceMetricsOverride"]),
    );
    const src = readSource("electron-app/browser/tab.mjs");
    expect(src.match(/dbg\.sendCommand\(/g) ?? []).toHaveLength(2); // 同一行三元表达式里的两个分支
    expect(src).toMatch(/const wire = this\.#inputScale < 1 \? scaleInputParams\(method, params, this\.#inputScale\) : params;/);
  });

  it("契约文档与类型一致：§14.4 记了 viewFit / fitScale / 补偿规则，TabInfo 有这两个字段", () => {
    const doc = read("docs/BROWSER-AUTOMATION.md");
    for (const frag of ["TabInfo.viewFit?", "TabInfo.fitScale?", "fitBoundsToEmulation", "dontSetVisibleSize", "scaleInputParams"]) expect(doc).toContain(frag);
    const types = read("src/lib/browser-bridge-types.ts");
    expect(types).toMatch(/viewFit\?: ViewFit;/);
    expect(types).toMatch(/fitScale\?: number;/);
  });
});
