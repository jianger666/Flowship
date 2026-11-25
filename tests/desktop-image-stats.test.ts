/**
 * 截图像素统计（electron-app/desktop/image-stats.mjs）——假位图。
 *
 * 钉死的是 capture-guard 判断「遮罩有没有影响截图」用的三样东西：
 * - overlayRatio：像遮罩底色的像素占比（容差 12，两种字节序都量）
 * - blackRatio：  近乎纯黑的像素占比（每个通道 ≤ 8）。macOS 27.2 + Electron 42 实测：带 setContentProtection 的遮罩盖着时，
 *                整个屏幕被截成一片黑（只剩 Dock 的图标），遮罩色占比是 0%——只量遮罩色就会把它当成「正常画面」放行，
 *                AI 拿到的全是黑图，什么也干不了（真实任务里就因此没能给微信联系人发出消息）
 * - sig：         48×27 个采样点的颜色指纹；signatureDistance / isSameScreen 用它比「带遮罩截的」和「撤了遮罩截的」是不是同一个屏幕
 * 读不出像素一律 null：「不知道」不能当成「没问题」。
 */
import { describe, expect, it } from "vitest";

import {
  BLACK_MAX_CHANNEL,
  isSameScreen,
  measureImage,
  OVERLAY_COLOR_TOLERANCE,
  SIG_BIG_DIFF,
  SIG_COLS,
  SIG_ROWS,
  SIG_SAME_FRAC_BIG,
  SIG_SAME_MEAN_ABS,
  signatureDistance,
} from "../electron-app/desktop/image-stats.mjs";
import { OVERLAY_RGB } from "../electron-app/desktop/overlay.mjs";

type Img = { getSize: () => { width: number; height: number }; toBitmap: () => Buffer };

/**
 * 带像素的假图：fill(x, y) 给出 [r, g, b]；toBitmap 按平台字节序返回（macOS 是 BGRA，也测一下 RGBA）。
 * 尺寸取 160×100 以内时抽样步长恒为 1（逐像素量，结果精确）。
 */
const makeImg = (
  width: number,
  height: number,
  fill: (x: number, y: number) => [number, number, number],
  order: "bgra" | "rgba" = "bgra",
): Img => {
  const buf = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = fill(x, y);
      const i = (y * width + x) * 4;
      if (order === "bgra") {
        buf[i] = b;
        buf[i + 1] = g;
        buf[i + 2] = r;
      } else {
        buf[i] = r;
        buf[i + 1] = g;
        buf[i + 2] = b;
      }
      buf[i + 3] = 255;
    }
  }
  return { getSize: () => ({ width, height }), toBitmap: () => buf };
};

const [OR, OG, OB] = OVERLAY_RGB as unknown as [number, number, number];
const NAVY = (): [number, number, number] => [OR, OG, OB];
const BLACK = (): [number, number, number] => [0, 0, 0];

describe("常量（改之前先想清楚：守卫的判断全靠它们）", () => {
  it("黑色每通道 ≤ 8；遮罩色容差 12；指纹 48×27；差得明显 > 40；同一个屏幕 = 平均差 ≤ 5 且明显差异的点 ≤ 4%", () => {
    expect(BLACK_MAX_CHANNEL).toBe(8);
    expect(OVERLAY_COLOR_TOLERANCE).toBe(12);
    expect(SIG_COLS).toBe(48);
    expect(SIG_ROWS).toBe(27);
    expect(SIG_BIG_DIFF).toBe(40);
    expect(SIG_SAME_MEAN_ABS).toBe(5);
    expect(SIG_SAME_FRAC_BIG).toBe(0.04);
  });
});

describe("blackRatio：画面里有多少像素近乎纯黑", () => {
  it("整张纯黑 = 1（遮罩色占比 0）；整张纯白 = 0；一半一半 = 0.5", () => {
    const black = measureImage(makeImg(160, 100, BLACK));
    expect(black?.blackRatio).toBe(1);
    expect(black?.overlayRatio).toBe(0);
    expect(measureImage(makeImg(160, 100, () => [255, 255, 255]))?.blackRatio).toBe(0);
    expect(measureImage(makeImg(160, 100, (x) => (x < 80 ? BLACK() : [240, 240, 240])))?.blackRatio).toBe(0.5);
  });

  it("macOS 27 实测的样子：一片黑，只有左边 Dock 的几个图标亮着（2 列像素）——黑色占比仍然 ≥ 0.85", () => {
    const r = measureImage(makeImg(160, 100, (x) => (x < 2 ? [200, 200, 200] : BLACK())));
    expect(r?.blackRatio).toBe(158 / 160);
    expect(r!.blackRatio).toBeGreaterThanOrEqual(0.85);
  });

  it("容差：每个通道恰好 8 算黑、9 不算——红 / 绿 / 蓝逐个卡边界，两种字节序各测一遍", () => {
    for (const order of ["bgra", "rgba"] as const) {
      const at = (r: number, g: number, b: number) => measureImage(makeImg(160, 100, () => [r, g, b], order))?.blackRatio;
      expect(at(8, 8, 8), `${order} 8,8,8`).toBe(1);
      expect(at(9, 0, 0), `${order} 红 9`).toBe(0);
      expect(at(0, 9, 0), `${order} 绿 9`).toBe(0);
      expect(at(0, 0, 9), `${order} 蓝 9`).toBe(0);
      expect(at(8, 0, 0), `${order} 红 8`).toBe(1);
      expect(at(0, 8, 0), `${order} 绿 8`).toBe(1);
      expect(at(0, 0, 8), `${order} 蓝 8`).toBe(1);
    }
  });

  it("遮罩色不算黑、黑不算遮罩色：整页遮罩底色 → overlayRatio 1、blackRatio 0；深灰 #1e1e1e 两个都是 0", () => {
    const navy = measureImage(makeImg(160, 100, NAVY));
    expect(navy?.overlayRatio).toBe(1);
    expect(navy?.blackRatio).toBe(0);
    const gray = measureImage(makeImg(160, 100, () => [30, 30, 30]));
    expect(gray?.overlayRatio).toBe(0);
    expect(gray?.blackRatio).toBe(0);
  });

  it("字节序不影响遮罩色：BGRA（macOS）和 RGBA 的遮罩底色都量得出来", () => {
    expect(measureImage(makeImg(160, 100, NAVY, "bgra"))?.overlayRatio).toBe(1);
    expect(measureImage(makeImg(160, 100, NAVY, "rgba"))?.overlayRatio).toBe(1);
  });

  it("大图抽样（1000×800）：整张纯黑照样得 1、整张都不黑照样得 0", () => {
    expect(measureImage(makeImg(1000, 800, BLACK))?.blackRatio).toBe(1);
    expect(measureImage(makeImg(1000, 800, () => [200, 120, 40]))?.blackRatio).toBe(0);
  });
});

describe("sig：颜色指纹", () => {
  it("48×27 个采样点、每点 R G B 三个字节", () => {
    const r = measureImage(makeImg(160, 100, () => [10, 20, 30]));
    expect(r!.sig).toBeInstanceOf(Uint8Array);
    expect(r!.sig.length).toBe(48 * 27 * 3);
  });

  it("按格子取点：左半边红、右半边蓝 → 第一列是红、最后一列是蓝；上半绿、下半黄 → 第一行 / 最后一行同理（BGRA 字节序，输出统一成 R G B）", () => {
    const lr = measureImage(makeImg(160, 100, (x) => (x < 80 ? [255, 0, 0] : [0, 0, 255])))!;
    const px = (row: number, col: number) => Array.from(lr.sig.slice((row * 48 + col) * 3, (row * 48 + col) * 3 + 3));
    expect(px(0, 0)).toEqual([255, 0, 0]);
    expect(px(26, 0)).toEqual([255, 0, 0]);
    expect(px(0, 23)).toEqual([255, 0, 0]);
    expect(px(0, 24)).toEqual([0, 0, 255]);
    expect(px(13, 47)).toEqual([0, 0, 255]);

    const tb = measureImage(makeImg(160, 100, (_x, y) => (y < 50 ? [0, 255, 0] : [255, 255, 0])))!;
    const py = (row: number, col: number) => Array.from(tb.sig.slice((row * 48 + col) * 3, (row * 48 + col) * 3 + 3));
    expect(py(0, 5)).toEqual([0, 255, 0]);
    expect(py(12, 5)).toEqual([0, 255, 0]); // 第 12 行的中心取在 y=46（高 100 分 27 格，(12+0.5)×100/27）
    expect(py(13, 5)).toEqual([255, 255, 0]); // 第 13 行的中心取在 y=50，已经是下半
    expect(py(26, 40)).toEqual([255, 255, 0]);
  });

  it("RGBA 字节序的位图：红蓝互换（指纹只用来比较，两张图用同一种读法就行）", () => {
    const r = measureImage(makeImg(160, 100, () => [255, 0, 0], "rgba"))!;
    expect(Array.from(r.sig.slice(0, 3))).toEqual([0, 0, 255]);
  });

  it("比宽高都小于网格的小图：不越界，照样出指纹", () => {
    const r = measureImage(makeImg(10, 5, (x) => [x * 20, 0, 0]));
    expect(r!.sig.length).toBe(48 * 27 * 3);
    expect(r!.blackRatio).toBeGreaterThanOrEqual(0);
  });

  it("读不出像素：整体返回 null（没有 toBitmap / 没有 getSize / 抛错 / 位图比声称的短 / 尺寸为 0 / 位图是 undefined / 入参是 null）", () => {
    const base = makeImg(160, 100, BLACK);
    expect(measureImage({ getSize: base.getSize } as never)).toBeNull();
    expect(measureImage({ toBitmap: base.toBitmap } as never)).toBeNull();
    expect(measureImage({ ...base, toBitmap: () => { throw new Error("native"); } })).toBeNull();
    expect(measureImage({ ...base, getSize: () => { throw new Error("native"); } })).toBeNull();
    expect(measureImage({ ...base, toBitmap: () => Buffer.alloc(100) })).toBeNull();
    expect(measureImage({ getSize: () => ({ width: 0, height: 0 }), toBitmap: () => Buffer.alloc(0) })).toBeNull();
    expect(measureImage({ ...base, toBitmap: () => undefined as never })).toBeNull();
    expect(measureImage(null)).toBeNull();
    expect(measureImage(undefined)).toBeNull();
  });
});

const LEN = 48 * 27 * 3;
const zeros = () => new Uint8Array(LEN);

describe("signatureDistance / isSameScreen：两张图是不是同一个屏幕", () => {
  it("一模一样 → 差异 0；同一个屏幕", () => {
    const a = Uint8Array.from({ length: LEN }, (_, i) => (i * 7) % 251);
    const d = signatureDistance(a, a);
    expect(d).toEqual({ meanAbs: 0, fracBig: 0 });
    expect(isSameScreen(d)).toBe(true);
  });

  it("比不了就是 null：缺一份 / 空 / 长度不一致 / 长度不是 3 的倍数 / 不是数组；isSameScreen(null) 为 false（比不了不能当成「一样」）", () => {
    const a = zeros();
    expect(signatureDistance(a, null)).toBeNull();
    expect(signatureDistance(undefined, a)).toBeNull();
    expect(signatureDistance(new Uint8Array(0), new Uint8Array(0))).toBeNull();
    expect(signatureDistance(a, new Uint8Array(LEN - 3))).toBeNull();
    expect(signatureDistance(new Uint8Array(10), new Uint8Array(10))).toBeNull();
    expect(signatureDistance({} as never, a)).toBeNull();
    expect(isSameScreen(null)).toBe(false);
    expect(isSameScreen(undefined)).toBe(false);
  });

  it("也认普通数组", () => {
    expect(signatureDistance([1, 2, 3, 4, 5, 6], [1, 2, 3, 4, 5, 6])).toEqual({ meanAbs: 0, fracBig: 0 });
    expect(signatureDistance([0, 0, 0, 0, 0, 0], [30, 0, 0, 0, 0, 0])).toEqual({ meanAbs: 5, fracBig: 0 });
  });

  it("平均差的边界：恰好 5 算同一个屏幕，比 5 多一点点就不算（每个点只差 30，不算「差得明显」，所以只有平均差在起作用）", () => {
    const at = (k: number) => {
      const b = zeros();
      for (let i = 0; i < k; i += 1) b[i * 3] = 30; // k 个采样点的红通道差 30
      return signatureDistance(zeros(), b);
    };
    expect(at(648)).toEqual({ meanAbs: 5, fracBig: 0 }); // 30×648 / 3888 = 5
    expect(isSameScreen(at(648))).toBe(true);
    expect(at(649)!.meanAbs).toBeGreaterThan(5);
    expect(isSameScreen(at(649))).toBe(false);
  });

  it("「差得明显」的边界：某个通道差 40 不算、差 41 算", () => {
    const at = (diff: number, k: number) => {
      const b = zeros();
      for (let i = 0; i < k; i += 1) b[i * 3 + 1] = diff; // k 个采样点的绿通道差 diff
      return signatureDistance(zeros(), b);
    };
    expect(at(40, 200)!.fracBig).toBe(0);
    expect(isSameScreen(at(40, 200))).toBe(true); // 平均差 = 40×200/3888 ≈ 2.06
    expect(at(41, 200)!.fracBig).toBeCloseTo(200 / 1296, 10);
    expect(isSameScreen(at(41, 200))).toBe(false);
  });

  it("明显差异的点占比的边界：4% 以内算同一个屏幕（时钟 / 光标 / 一小块动画），超过就不算", () => {
    const at = (k: number) => {
      const b = zeros();
      for (let i = 0; i < k; i += 1) b[i * 3 + 2] = 41; // k 个采样点的蓝通道差 41（平均差很小）
      return signatureDistance(zeros(), b);
    };
    expect(isSameScreen(at(51))).toBe(true); // 51/1296 ≈ 3.94%
    expect(isSameScreen(at(52))).toBe(false); // 52/1296 ≈ 4.01%
  });

  it("isSameScreen 的两道门槛都含等号：平均差恰好 5、明显差异占比恰好 4%（用手写的差异值，不受指纹格数限制）算同一个屏幕，多一点点就不算", () => {
    expect(isSameScreen({ meanAbs: 5, fracBig: 0 })).toBe(true);
    expect(isSameScreen({ meanAbs: 5.0001, fracBig: 0 })).toBe(false);
    expect(isSameScreen({ meanAbs: 0, fracBig: 0.04 })).toBe(true);
    expect(isSameScreen({ meanAbs: 0, fracBig: 0.0401 })).toBe(false);
    expect(isSameScreen({ meanAbs: 5, fracBig: 0.04 })).toBe(true);
    expect(isSameScreen({ meanAbs: 6, fracBig: 0 })).toBe(false);
    expect(isSameScreen({ meanAbs: 0, fracBig: 0.5 })).toBe(false);
  });

  it("三个通道取最大的那个来判断「差得明显」；平均差三个通道一起算", () => {
    const a = zeros();
    const b = zeros();
    b[0] = 20;
    b[1] = 41;
    b[2] = 10;
    const d = signatureDistance(a, b)!;
    expect(d.fracBig).toBeCloseTo(1 / 1296, 10);
    expect(d.meanAbs).toBeCloseTo((20 + 41 + 10) / LEN, 10);
  });

  it("真实情形：一片黑 vs 真实桌面 → 完全不同；整页深蓝 vs 真实桌面 → 完全不同；真实桌面 vs 自己加一点点抖动 → 同一个屏幕", () => {
    const real = Uint8Array.from({ length: LEN }, (_, i) => 40 + ((i * 37 + Math.floor(i / 7) * 11) % 180));
    const black = Uint8Array.from({ length: LEN }, (_, i) => (i % 144 < 6 ? 90 : 0));
    const navy = Uint8Array.from({ length: LEN }, (_, i) => [OR, OG, OB][i % 3]);
    const jitter = real.map((v, i) => (i % 97 === 0 ? v + 10 : v));
    expect(isSameScreen(signatureDistance(real, black))).toBe(false);
    expect(isSameScreen(signatureDistance(real, navy))).toBe(false);
    expect(isSameScreen(signatureDistance(real, jitter))).toBe(true);
  });
});
