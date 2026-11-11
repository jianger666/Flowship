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
import { BrowserTab, PARKING_BOUNDS } from "../electron-app/browser/tab.mjs";
import { createBrowserStore } from "@/components/browser/browser-state-store";
import { fitScaleLabelOf, fitScalePercentOf, viewFitCssOf } from "@/components/browser/browser-user-logic";
import type { BrowserState, TabInfo } from "@/lib/browser-bridge-types";

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
}

const makeTab = () => {
  const sent: Sent[] = [];
  const failMethods: Record<string, string> = {};
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
    sendCommand: vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
      sent.push({ method, params });
      const gate = gates[method];
      if (gate) await gate;
      const fail = failMethods[method];
      if (fail) throw new Error(fail);
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "F1" } } };
      if (method === "Page.addScriptToEvaluateOnNewDocument") return { identifier: "s1" };
      if (method === "Page.createIsolatedWorld") return { executionContextId: 7 };
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
  const hooks = {
    onChange: vi.fn(),
    onLoaded: vi.fn(),
    onNewTab: vi.fn(),
    onRecorder: vi.fn(),
    onBlocked: vi.fn(),
    onDialog: vi.fn(),
    onNeedLockSync: vi.fn(),
    onCrashed: vi.fn(),
  };
  const parking = { contentView: { addChildView: vi.fn(), removeChildView: vi.fn() } };
  const main = { contentView: { addChildView: vi.fn(), removeChildView: vi.fn() } };
  const tab = new BrowserTab({
    id: "t1",
    WebContentsView: FakeView as never,
    parkingWindow: parking,
    pageScripts: { PAGE_WORLD_NAME: "flowship", RECORDER_BINDING: "__rec", buildPageScript: () => "//" } as never,
    isAppUrl: () => false,
    hooks,
    log: () => {},
  } as never);
  const setBounds = (tab.view as unknown as { setBounds: ReturnType<typeof vi.fn> }).setBounds;
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
    lastBounds,
    info,
    overrides,
    lastOverride,
    flush,
    wireOf,
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
    const src = read("electron-app/browser/tab.mjs");
    // 除了停车场固定矩形外，view.setBounds 只在 #applySlot 里出现一次
    expect(src.match(/this\.view\.setBounds\(/g) ?? []).toHaveLength(2);
    expect(src).toContain("this.view.setBounds({ ...PARKING_BOUNDS })");
    expect(src).toMatch(/#applySlot\(\) \{[\s\S]*?fitBoundsToEmulation\(this\.#slot, this\.emulation, this\.#fitScale\)[\s\S]*?this\.view\.setBounds\(bounds\)/);
    // 成功路径与失败回滚路径都经 #refit 重算缩放并重摆视图
    const apply = src.slice(src.indexOf("async #applyEmulationNow"), src.indexOf("resetEmulation() {"));
    expect(apply.match(/await this\.#refit\(\)/g) ?? []).toHaveLength(2);
    // 视口命令都带上缩放（正常 / 回滚 / 重放）
    expect(apply.match(/withFitScale\(/g) ?? []).toHaveLength(2);
    expect(src).toMatch(/#replayEmulation\(\) \{\s+const commands = withFitScale\(/);
    // 两条离开主窗口的路径都清槽位 / viewFit
    expect(src.match(/this\.#slot = null;\s+this\.viewFit = null;/g) ?? []).toHaveLength(2);
    // 槽位变化只「排」重算任务（合并），不直接发 CDP
    expect(src).toMatch(/setBounds\(bounds\) \{[\s\S]*?this\.#scheduleRefit\(\)/);
    expect(src).toMatch(/#scheduleRefit\(\) \{[\s\S]*?this\.#enqueueEmulation\(/);
  });

  it("Tab.send 是全仓唯一碰 debugger.sendCommand 的地方，并在这里补偿输入坐标", () => {
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
    expect(hits).toEqual(["electron-app/browser/tab.mjs"]);
    const src = read("electron-app/browser/tab.mjs");
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
