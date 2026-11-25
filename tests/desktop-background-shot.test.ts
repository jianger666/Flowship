/**
 * 锁屏后台档的截图封装（electron-app/desktop/background-shot.mjs）：BGRA 位图 → JPEG + 坐标映射。
 *
 * 钉死两件事：
 * - 输出形状和 screenshot.mjs 完全一致（{ jpeg, frame: { imageWidth, imageHeight, rect } }）——manager 的坐标换算、
 *   截图世代校验、server 展示逻辑对「真实屏幕」和「后台合成」两种来源是同一套；
 * - 窗口摘要里的位置是「截图里的像素位置」（不是屏幕物理像素），并裁在截图范围内——AI 直接拿它对照画面。
 * nativeImage 用假对象（Mac 上没有 Windows 的位图，也不需要真 Electron）。
 */
import { describe, expect, it, vi } from "vitest";

import { createBackgroundShotter, mapWindowsToImage } from "../electron-app/desktop/background-shot.mjs";
import { DesktopError } from "../electron-app/desktop/types.mjs";

type Rect = { x: number; y: number; width: number; height: number };

const makeImages = (opts: { empty?: boolean; jpegSizes?: number[]; createThrows?: boolean; resizeThrows?: boolean } = {}) => {
  const resizes: Array<{ width?: number; height?: number; quality?: string }> = [];
  const qualities: number[] = [];
  const created: Array<{ buf: Buffer; width: number; height: number }> = [];
  const sizes = opts.jpegSizes ?? [1000];

  const makeImage = (width: number, height: number): Record<string, unknown> => ({
    isEmpty: () => opts.empty === true,
    getSize: () => ({ width, height }),
    resize: (o: { width?: number; height?: number; quality?: string }) => {
      resizes.push(o);
      if (opts.resizeThrows) throw new Error("resize 失败");
      const w = o.width ?? width;
      const h = o.height ?? Math.max(1, Math.round((height * w) / width));
      return makeImage(w, h);
    },
    toJPEG: (q: number) => {
      qualities.push(q);
      const size = sizes[Math.min(qualities.length - 1, sizes.length - 1)]!;
      return Buffer.alloc(size, 7);
    },
  });

  const api = {
    createFromBitmap: vi.fn((buf: Buffer, o: { width: number; height: number }) => {
      if (opts.createThrows) throw new Error("bitmap 转换失败");
      created.push({ buf, width: o.width, height: o.height });
      return makeImage(o.width, o.height);
    }),
  };
  return { api, resizes, qualities, created };
};

const raw = (width: number, height: number, windows: Array<Record<string, unknown>> = []) => ({
  width,
  height,
  bgra: Buffer.alloc(width * height * 4, 9),
  elapsedMs: 12,
  windows,
});

const make = (
  r: ReturnType<typeof raw> | Error | (() => Promise<unknown>),
  over: { rect?: Rect; images?: ReturnType<typeof makeImages>; maxWidth?: number; maxBytes?: number; quality?: number } = {},
) => {
  const images = over.images ?? makeImages();
  const rect = over.rect ?? { x: 0, y: 0, width: 2000, height: 1000 };
  const logs: string[] = [];
  const background = {
    capture: vi.fn(async () => {
      if (r instanceof Error) throw r;
      if (typeof r === "function") return r();
      return r;
    }),
  };
  const shotter = createBackgroundShotter({
    background: background as never,
    driver: { getPrimaryDisplay: () => rect },
    nativeImage: images.api as never,
    ...(over.maxWidth !== undefined ? { maxWidth: over.maxWidth } : {}),
    ...(over.maxBytes !== undefined ? { maxBytes: over.maxBytes } : {}),
    ...(over.quality !== undefined ? { quality: over.quality } : {}),
    log: (m: string) => logs.push(m),
  });
  return { shotter, background, images, logs, rect };
};

const codeOf = async (p: Promise<unknown>): Promise<string | undefined> => {
  try {
    await p;
  } catch (err) {
    return (err as { code?: string }).code;
  }
  return undefined;
};

describe("形状：和真实屏幕截图一致", () => {
  it("宽屏缩到 1280：位图原样交给 nativeImage，frame 是缩放后的像素尺寸 + 主屏矩形，JPEG 质量 70", async () => {
    const shot = raw(2000, 1000);
    const fx = make(shot);
    const r = await fx.shotter.capture();
    expect(fx.images.created).toHaveLength(1);
    expect(fx.images.created[0]!.buf).toBe(shot.bgra);
    expect(fx.images.created[0]).toMatchObject({ width: 2000, height: 1000 });
    expect(fx.images.resizes).toEqual([{ width: 1280, height: 640, quality: "good" }]);
    expect(fx.images.qualities).toEqual([70]);
    expect(r.jpeg).toBeInstanceOf(Buffer);
    expect(r.frame).toEqual({ imageWidth: 1280, imageHeight: 640, rect: { x: 0, y: 0, width: 2000, height: 1000 } });
    expect(r.windows).toEqual([]);
  });

  it("本来就不宽（≤ maxWidth）：不缩放", async () => {
    const fx = make(raw(800, 600), { rect: { x: 0, y: 0, width: 800, height: 600 } });
    const r = await fx.shotter.capture();
    expect(fx.images.resizes).toEqual([]);
    expect(r.frame).toEqual({ imageWidth: 800, imageHeight: 600, rect: { x: 0, y: 0, width: 800, height: 600 } });
  });

  it("主屏不在原点（副屏在左边）：rect 如实带上负坐标，窗口位置按主屏左上角起算", async () => {
    const rect = { x: -1920, y: 0, width: 1920, height: 1080 };
    const fx = make(
      raw(1920, 1080, [{ className: "Notepad", processName: "notepad.exe", x: -1820, y: 100, width: 960, height: 540, status: "ok" }]),
      { rect, maxWidth: 960 },
    );
    const r = await fx.shotter.capture();
    expect(r.frame.rect).toEqual(rect);
    expect(r.frame).toMatchObject({ imageWidth: 960, imageHeight: 540 });
    expect(r.windows).toEqual([{ className: "Notepad", processName: "notepad.exe", x: 50, y: 50, width: 480, height: 270, status: "ok" }]);
  });

  it("自定义 maxWidth / quality 生效", async () => {
    const fx = make(raw(2000, 1000), { maxWidth: 1000, quality: 55 });
    const r = await fx.shotter.capture();
    expect(fx.images.resizes).toEqual([{ width: 1000, height: 500, quality: "good" }]);
    expect(fx.images.qualities).toEqual([55]);
    expect(r.frame).toMatchObject({ imageWidth: 1000, imageHeight: 500 });
  });
});

describe("体积控制：超过 maxBytes 先降质量、再缩小", () => {
  it("降质量就够了：70 → 55 → 40，停在第一个够小的", async () => {
    const images = makeImages({ jpegSizes: [2_000_000, 1_500_000, 900_000] });
    const fx = make(raw(2000, 1000), { images });
    const r = await fx.shotter.capture();
    expect(images.qualities).toEqual([70, 55, 40]);
    expect(r.jpeg.length).toBe(900_000);
    expect(r.frame.imageWidth).toBe(1280);
  });

  it("降到最低质量还是太大：再缩小到 75% 宽，质量 50", async () => {
    const images = makeImages({ jpegSizes: [2_000_000, 2_000_000, 2_000_000, 500_000] });
    const fx = make(raw(2000, 1000), { images });
    const r = await fx.shotter.capture();
    expect(images.qualities).toEqual([70, 55, 40, 50]);
    expect(images.resizes.at(-1)).toEqual({ width: 960 });
    expect(r.frame).toMatchObject({ imageWidth: 960, imageHeight: 480 });
    expect(r.jpeg.length).toBe(500_000);
  });

  it("缩小的下限是 320 宽（极窄屏不会缩成一条线）", async () => {
    const images = makeImages({ jpegSizes: [2_000_000, 2_000_000, 2_000_000, 100] });
    const fx = make(raw(400, 300), { images, rect: { x: 0, y: 0, width: 400, height: 300 } });
    await fx.shotter.capture();
    expect(images.resizes.at(-1)).toEqual({ width: 320 });
  });
});

describe("窗口摘要换成截图像素坐标", () => {
  const rect: Rect = { x: 0, y: 0, width: 2000, height: 1000 };

  it("按缩放比例换算；保留进程名 / 状态等其它字段", () => {
    const out = mapWindowsToImage(
      [{ className: "Chrome_WidgetWin_1", processName: "chrome.exe", x: 200, y: 100, width: 1000, height: 500, status: "blank" }],
      rect,
      1000,
      500,
    );
    expect(out).toEqual([{ className: "Chrome_WidgetWin_1", processName: "chrome.exe", x: 100, y: 50, width: 500, height: 250, status: "blank" }]);
  });

  it("超出屏幕的部分裁掉（左 / 上 / 右 / 下）", () => {
    const out = mapWindowsToImage(
      [
        { x: -100, y: -50, width: 400, height: 300, status: "ok" },
        { x: 1800, y: 900, width: 400, height: 300, status: "ok" },
      ],
      rect,
      1000,
      500,
    );
    expect(out).toEqual([
      { x: 0, y: 0, width: 150, height: 125, status: "ok" },
      { x: 900, y: 450, width: 100, height: 50, status: "ok" },
    ]);
  });

  it("裁完没有面积 / 完全在屏幕外的丢掉；顺序（Z 序）保持", () => {
    const out = mapWindowsToImage(
      [
        { x: 3000, y: 0, width: 100, height: 100, status: "ok", n: 1 },
        { x: 0, y: 0, width: 200, height: 200, status: "ok", n: 2 },
        { x: -500, y: -500, width: 100, height: 100, status: "ok", n: 3 },
        { x: 400, y: 400, width: 0, height: 100, status: "ok", n: 4 },
        { x: 400, y: 400, width: 200, height: 200, status: "failed", n: 5 },
      ],
      rect,
      1000,
      500,
    );
    expect(out.map((w) => w.n)).toEqual([2, 5]);
  });

  it("不是数组 / 矩形没有面积：空数组，不抛", () => {
    expect(mapWindowsToImage(undefined as never, rect, 1000, 500)).toEqual([]);
    expect(mapWindowsToImage([{ x: 0, y: 0, width: 1, height: 1 }], { x: 0, y: 0, width: 0, height: 0 }, 1000, 500)).toEqual([]);
  });

  it("不修改传入的窗口对象", () => {
    const win = { x: 200, y: 100, width: 1000, height: 500, status: "ok" };
    mapWindowsToImage([win], rect, 1000, 500);
    expect(win).toEqual({ x: 200, y: 100, width: 1000, height: 500, status: "ok" });
  });
});

describe("出错：一律是带中文说明的 DesktopError，不带像素 / 底层细节", () => {
  it("驱动抛普通错误：INTERNAL，说明里有原因和下一步", async () => {
    const fx = make(new Error("PrintWindow 全部失败"));
    const err = await fx.shotter.capture().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DesktopError);
    expect((err as DesktopError).code).toBe("INTERNAL");
    expect((err as Error).message).toContain("锁屏后台截图失败");
    expect((err as Error).message).toContain("PrintWindow 全部失败");
    expect((err as Error).message).toContain("测试后台操作");
    expect(fx.logs.join("\n")).toContain("合成截图失败");
  });

  it("驱动抛的就是 DesktopError：原样透传（保留它的错误码）", async () => {
    const original = new DesktopError("UNSUPPORTED", "后台组件没就绪");
    const fx = make(original);
    const err = await fx.shotter.capture().catch((e: unknown) => e);
    expect(err).toBe(original);
  });

  it("截图期间屏幕尺寸变了：INTERNAL，提示重试", async () => {
    const fx = make(raw(1920, 1080), { rect: { x: 0, y: 0, width: 2560, height: 1440 } });
    expect(await codeOf(fx.shotter.capture())).toBe("INTERNAL");
    const err = await fx.shotter.capture().catch((e: Error) => e);
    expect((err as Error).message).toContain("屏幕尺寸在截图过程中变了");
    expect(fx.images.api.createFromBitmap).not.toHaveBeenCalled();
  });

  it("位图不完整（长度不够）/ 驱动没返回东西：同样拒绝，不把半张图交给 nativeImage", async () => {
    const short = { width: 2000, height: 1000, bgra: Buffer.alloc(100), windows: [] };
    const fx = make(short as never);
    expect(await codeOf(fx.shotter.capture())).toBe("INTERNAL");
    expect(fx.images.api.createFromBitmap).not.toHaveBeenCalled();

    const nothing = make((async () => undefined) as never);
    expect(await codeOf(nothing.shotter.capture())).toBe("INTERNAL");
  });

  it("nativeImage 给出空画面 / 转换抛错 / 缩放抛错：INTERNAL（位图转图片出错），日志里记原因", async () => {
    for (const images of [makeImages({ empty: true }), makeImages({ createThrows: true }), makeImages({ resizeThrows: true })]) {
      const fx = make(raw(2000, 1000), { images });
      const err = await fx.shotter.capture().catch((e: unknown) => e);
      expect((err as DesktopError).code).toBe("INTERNAL");
      expect((err as Error).message).toContain("位图转图片出错");
      expect(fx.logs.join("\n")).toContain("位图转图片失败");
    }
  });

  it("错误信息和日志里没有位图内容", async () => {
    const fx = make(new Error("boom"));
    const err = (await fx.shotter.capture().catch((e: unknown) => e)) as Error;
    expect(err.message).not.toMatch(/\b9{4,}\b/);
    expect(fx.logs.join("\n")).not.toContain("<Buffer");
  });
});
