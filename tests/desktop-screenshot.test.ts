/**
 * 主显示器截图（electron-app/desktop/screenshot.mjs）——假 desktopCapturer / screen / NativeImage。
 *
 * 钉死的是：
 * - 没有屏幕录制权限就明确报 NEED_PERMISSION，且不去调系统截图（不要触发一次无意义的抓取）
 * - 请求的缩略图尺寸由 fitToWidth 决定；frame 里的像素宽高以**实际拿到的图**为准（坐标映射依赖它）
 * - 选对主显示器（display_id 匹配；Windows 上 display_id 为空时按下标）
 * - 体积控制：先降质量再缩小，frame 的宽高随缩小同步更新
 * - overlayRatio / blackRatio / sig：画面里有多少像素像遮罩底色 / 近乎纯黑，以及一份颜色指纹（capture-guard 据此判断遮罩有没有影响截图——
 *   macOS 27 上遮罩会把整个屏幕截成一片黑），量原始位图、量不出就是 null
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { OVERLAY_RGB } from "../electron-app/desktop/overlay.mjs";
import { measureImage } from "../electron-app/desktop/image-stats.mjs";
import { createScreenshotter, GET_SOURCES_TIMEOUT_MS, OVERLAY_COLOR_TOLERANCE } from "../electron-app/desktop/screenshot.mjs";

/** 画面里和遮罩底色接近的像素占比（0~1）；读不到像素 = null。只有测试用这个视角，生产代码直接读 measureImage 的整份统计 */
const measureOverlayRatio = (img: Parameters<typeof measureImage>[0]) => measureImage(img)?.overlayRatio ?? null;

type FakeImg = {
  isEmpty: () => boolean;
  getSize: () => { width: number; height: number };
  toJPEG: (q: number) => Buffer;
  resize: (o: { width: number }) => FakeImg;
};

/** bytesAt：质量 → 体积 */
const makeImg = (width: number, height: number, bytesAt: (q: number, w: number) => number = () => 1000, empty = false): FakeImg => ({
  isEmpty: () => empty,
  getSize: () => ({ width, height }),
  toJPEG: (q) => Buffer.alloc(bytesAt(q, width), 1),
  resize: ({ width: w }) => makeImg(w, Math.round((height * w) / width), bytesAt, empty),
});

const RECT = { x: 0, y: 0, width: 1512, height: 982 };

const make = (
  opts: {
    sources?: Array<{ display_id?: string; thumbnail: FakeImg }>;
    permission?: string;
    platform?: string;
    primaryId?: number;
    allDisplayIds?: number[];
    getSourcesThrows?: boolean;
    maxBytes?: number;
    getSourcesTimeoutMs?: number;
    /** 自定义 getSources 的行为（参数 = 第几次调用，从 1 开始）：用来模拟挂住不返回 / 迟到才失败 */
    getSourcesImpl?: (call: number) => Promise<unknown[]>;
  } = {},
) => {
  let calls = 0;
  const logs: string[] = [];
  const getSources = vi.fn<(o: unknown) => Promise<unknown[]>>(async () => {
    calls += 1;
    if (opts.getSourcesImpl) return opts.getSourcesImpl(calls);
    if (opts.getSourcesThrows) throw new Error("native crash: secret-internal-detail");
    return opts.sources ?? [{ display_id: "1", thumbnail: makeImg(1280, 831) }];
  });
  const getMediaAccessStatus = vi.fn(() => opts.permission ?? "granted");
  const shot = createScreenshotter({
    desktopCapturer: { getSources },
    screen: {
      getPrimaryDisplay: () => ({ id: opts.primaryId ?? 1 }),
      getAllDisplays: () => (opts.allDisplayIds ?? [1]).map((id) => ({ id })),
    },
    systemPreferences: { getMediaAccessStatus },
    driver: { getPrimaryDisplay: () => RECT } as never,
    platform: opts.platform ?? "darwin",
    maxBytes: opts.maxBytes,
    getSourcesTimeoutMs: opts.getSourcesTimeoutMs,
    log: (m: string) => logs.push(m),
  });
  return { shot, getSources, getMediaAccessStatus, logs };
};

describe("权限", () => {
  it.each(["denied", "not-determined", "restricted", "unknown"])("macOS 屏幕录制 %s：NEED_PERMISSION，不调用系统截图", async (perm) => {
    const { shot, getSources } = make({ permission: perm });
    await expect(shot.capture()).rejects.toMatchObject({ code: "NEED_PERMISSION" });
    expect(getSources).not.toHaveBeenCalled();
  });

  it("Windows 没有这个权限：恒 granted，也不去问系统", async () => {
    const { shot, getMediaAccessStatus } = make({ platform: "win32", permission: "denied" });
    expect(shot.screenPermission()).toBe("granted");
    await expect(shot.capture()).resolves.toBeDefined();
    expect(getMediaAccessStatus).not.toHaveBeenCalled();
  });
});

describe("截图结果", () => {
  it("请求的缩略图尺寸 = 最宽 1280 等比缩小；frame 带上输入坐标系的 rect", async () => {
    const { shot, getSources } = make();
    const r = await shot.capture();
    expect(getSources).toHaveBeenCalledWith(expect.objectContaining({ types: ["screen"], thumbnailSize: { width: 1280, height: 831 } }));
    expect(r.frame).toEqual({ imageWidth: 1280, imageHeight: 831, rect: RECT });
    expect(Buffer.isBuffer(r.jpeg)).toBe(true);
  });

  it("frame 的宽高以实际拿到的图为准（系统给的尺寸可能与请求略有出入）", async () => {
    const { shot } = make({ sources: [{ display_id: "1", thumbnail: makeImg(1279, 830) }] });
    const r = await shot.capture();
    expect(r.frame.imageWidth).toBe(1279);
    expect(r.frame.imageHeight).toBe(830);
  });

  it("多显示器：按 display_id 选主屏", async () => {
    const primary = makeImg(1280, 831);
    const other = makeImg(800, 600);
    const { shot } = make({
      primaryId: 2,
      allDisplayIds: [1, 2],
      sources: [
        { display_id: "1", thumbnail: other },
        { display_id: "2", thumbnail: primary },
      ],
    });
    expect((await shot.capture()).frame.imageWidth).toBe(1280);
  });

  it("display_id 为空（Windows 常见）：按主屏在显示器列表里的下标取", async () => {
    const primary = makeImg(1280, 831);
    const other = makeImg(800, 600);
    const { shot } = make({
      primaryId: 20,
      allDisplayIds: [10, 20],
      sources: [
        { display_id: "", thumbnail: other },
        { display_id: "", thumbnail: primary },
      ],
    });
    expect((await shot.capture()).frame.imageWidth).toBe(1280);
  });

  it("完全对不上：退回第一块，不抛", async () => {
    const only = makeImg(1280, 831);
    const { shot } = make({ primaryId: 99, allDisplayIds: [1], sources: [{ display_id: "7", thumbnail: only }] });
    await expect(shot.capture()).resolves.toBeDefined();
  });
});

describe("失败", () => {
  it("空画面：INTERNAL，文案让模型重试", async () => {
    const { shot } = make({ sources: [{ display_id: "1", thumbnail: makeImg(10, 10, () => 1, true) }] });
    const err = await shot.capture().catch((e: Error & { code?: string }) => e);
    expect(err).toMatchObject({ code: "INTERNAL" });
    expect((err as Error).message).toContain("重试");
  });

  it("没有任何画面源：同样报 INTERNAL，不抛 TypeError", async () => {
    const { shot } = make({ sources: [] });
    await expect(shot.capture()).rejects.toMatchObject({ code: "INTERNAL" });
  });

  it("系统截图调用抛错：中文提示，不把底层异常原文带出去", async () => {
    const { shot } = make({ getSourcesThrows: true });
    const err = await shot.capture().catch((e: Error) => e);
    expect(err).toMatchObject({ code: "INTERNAL" });
    expect((err as Error).message).not.toContain("secret-internal-detail");
  });
});

/**
 * manager 的桌面请求是一条串行队列：一次挂住的截图会让之后所有桌面请求都排在它后面等下去（server 的 90 秒超时只让那一次工具调用失败，
 * 队列本身不松开），直到重启 Flowship。所以 getSources 必须有等待上限，到点放弃、把队列让出来。
 */
describe("getSources 挂住不返回：必须有上限", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const never = () => new Promise<unknown[]>(() => {});

  it("默认上限 12 秒：没到点还在等；到点放弃并报 TIMEOUT（文案带秒数、可重试、仍失败让用户重启）；日志记一笔；不留计时器", async () => {
    vi.useFakeTimers();
    expect(GET_SOURCES_TIMEOUT_MS).toBe(12_000);
    const { shot, logs } = make({ getSourcesImpl: never });
    let outcome: unknown = "pending";
    const done = shot.capture().then(
      (v) => (outcome = v),
      (e: unknown) => (outcome = e),
    );
    await vi.advanceTimersByTimeAsync(GET_SOURCES_TIMEOUT_MS - 1);
    expect(outcome).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(outcome).toMatchObject({ code: "TIMEOUT" });
    const message = (outcome as Error).message;
    expect(message).toContain("12 秒");
    expect(message).toContain("重试");
    expect(message).toContain("重启 Flowship");
    expect(logs.join("\n")).toContain("getSources 超过 12000ms");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("上限可配置；不合法的值（0 / 负数 / NaN / 非数字）退回默认，不会变成「立刻超时」", async () => {
    vi.useFakeTimers();
    const custom = make({ getSourcesImpl: never, getSourcesTimeoutMs: 2000 });
    const customDone = custom.shot.capture().catch((e: Error & { code?: string }) => e);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await customDone).toMatchObject({ code: "TIMEOUT" });
    expect(custom.logs.join("\n")).toContain("getSources 超过 2000ms");

    for (const bad of [0, -5, Number.NaN, "3000" as unknown as number]) {
      const m = make({ getSourcesImpl: never, getSourcesTimeoutMs: bad });
      let settled = false;
      const p = m.shot.capture().catch(() => undefined);
      void p.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(GET_SOURCES_TIMEOUT_MS - 1);
      expect(settled, String(bad)).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await p;
      expect(settled, String(bad)).toBe(true);
    }
  });

  it("挂住的调用事后才失败 / 才返回：没人理会、不崩；而下一次截图照常——队列没有被它占着", async () => {
    vi.useFakeTimers();
    let rejectLate: (e: Error) => void = () => {};
    let resolveLate: (v: unknown[]) => void = () => {};
    const { shot, getSources } = make({
      getSourcesTimeoutMs: 1000,
      getSourcesImpl: (call) =>
        call === 1
          ? new Promise<unknown[]>((_, reject) => {
              rejectLate = reject;
            })
          : call === 2
            ? new Promise<unknown[]>((resolve) => {
                resolveLate = resolve;
              })
            : Promise.resolve([{ display_id: "1", thumbnail: makeImg(1280, 831) }]),
    });
    const first = shot.capture().catch((e: Error & { code?: string }) => e);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await first).toMatchObject({ code: "TIMEOUT" });
    rejectLate(new Error("迟到的失败"));
    await vi.advanceTimersByTimeAsync(0);

    const second = shot.capture().catch((e: Error & { code?: string }) => e);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await second).toMatchObject({ code: "TIMEOUT" });
    resolveLate([{ display_id: "1", thumbnail: makeImg(1280, 831) }]); // 迟到的成功结果也不能被拿去用
    await vi.advanceTimersByTimeAsync(0);

    const third = await shot.capture();
    expect(third.frame.imageWidth).toBe(1280);
    expect(getSources).toHaveBeenCalledTimes(3);
  });

  it("正常返回 / 抛错：都不留计时器；抛错仍是 INTERNAL（不是 TIMEOUT）", async () => {
    vi.useFakeTimers();
    const ok = make();
    await expect(ok.shot.capture()).resolves.toBeDefined();
    expect(vi.getTimerCount()).toBe(0);
    const bad = make({ getSourcesThrows: true });
    await expect(bad.shot.capture()).rejects.toMatchObject({ code: "INTERNAL" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("没有屏幕录制权限时根本不会去调 getSources，也就不会起计时器", async () => {
    vi.useFakeTimers();
    const { shot, getSources } = make({ permission: "denied" });
    await expect(shot.capture()).rejects.toMatchObject({ code: "NEED_PERMISSION" });
    expect(getSources).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("体积控制", () => {
  it("超过上限：先降质量，够了就停（frame 尺寸不变）", async () => {
    // 质量 70 → 2MB，55 → 1.1MB（< 1.2MB）
    const bytesAt = (q: number) => (q >= 70 ? 2_000_000 : q >= 55 ? 1_100_000 : 500_000);
    const { shot } = make({ sources: [{ display_id: "1", thumbnail: makeImg(1280, 831, bytesAt) }] });
    const r = await shot.capture();
    expect(r.jpeg.length).toBe(1_100_000);
    expect(r.frame.imageWidth).toBe(1280);
  });

  it("降质量也不够：缩小到 75%，frame 的宽高同步更新", async () => {
    const bytesAt = (_q: number, w: number) => (w >= 1280 ? 3_000_000 : 900_000);
    const { shot } = make({ sources: [{ display_id: "1", thumbnail: makeImg(1280, 831, bytesAt) }] });
    const r = await shot.capture();
    expect(r.frame.imageWidth).toBe(960);
    expect(r.frame.imageHeight).toBe(Math.round((831 * 960) / 1280));
    expect(r.jpeg.length).toBe(900_000);
    // 缩小后映射仍然成立：frame.rect 不变，坐标换算按新的宽高比例走
    expect(r.frame.rect).toEqual(RECT);
  });
});

/**
 * 带像素的假图：fill(x, y) 给出 [r, g, b]；toBitmap 按平台字节序返回（macOS 是 BGRA，也测一下 RGBA）。
 * 尺寸取 160×100 以内，抽样步长恒为 1（逐像素量，结果精确）。
 */
const makePixelImg = (
  width: number,
  height: number,
  fill: (x: number, y: number) => [number, number, number],
  order: "bgra" | "rgba" = "bgra",
): FakeImg & { toBitmap: () => Buffer } => {
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
  return { ...makeImg(width, height), toBitmap: () => buf };
};

const [OR, OG, OB] = OVERLAY_RGB as unknown as [number, number, number];
const OVERLAY_PX = (): [number, number, number] => [OR, OG, OB];

describe("overlayRatio：画面里有多少像素像遮罩底色", () => {
  it("整张都是遮罩底色 = 1；一点都没有 = 0；一半一半 = 0.5", () => {
    expect(measureOverlayRatio(makePixelImg(160, 100, OVERLAY_PX))).toBe(1);
    expect(measureOverlayRatio(makePixelImg(160, 100, () => [255, 255, 255]))).toBe(0);
    expect(measureOverlayRatio(makePixelImg(160, 100, (x) => (x < 80 ? OVERLAY_PX() : [240, 240, 240])))).toBe(0.5);
  });

  it("字节序不影响：BGRA（macOS）和 RGBA 的遮罩底色都量得出来", () => {
    expect(measureOverlayRatio(makePixelImg(160, 100, OVERLAY_PX, "bgra"))).toBe(1);
    expect(measureOverlayRatio(makePixelImg(160, 100, OVERLAY_PX, "rgba"))).toBe(1);
  });

  it("容差：每个通道恰好差 12 算像、差 13 不算——红 / 绿 / 蓝逐个卡边界，两种字节序各测一遍（互相不能靠对方的读法蒙混过关）", () => {
    expect(OVERLAY_COLOR_TOLERANCE).toBe(12);
    // [通道, 在遮罩底色上的偏移]：每一项里另一种字节序的读法都会差出 20 以上，所以结果只取决于被卡的这个通道
    const cases: Array<[string, number, number, number]> = [
      ["红 +", 1, 0, 0],
      ["绿 +", 0, 1, 0],
      ["绿 −", 0, -1, 0],
      ["蓝 +", 0, 0, 1],
      ["蓝 −", 0, 0, -1],
    ];
    for (const order of ["bgra", "rgba"] as const) {
      const at = (dr: number, dg: number, db: number) => measureOverlayRatio(makePixelImg(160, 100, () => [OR + dr, OG + dg, OB + db], order));
      for (const [name, r, g, b] of cases) {
        expect(at(r * 12, g * 12, b * 12), `${order} ${name}12`).toBe(1);
        expect(at(r * 13, g * 13, b * 13), `${order} ${name}13`).toBe(0);
      }
    }
  });

  it("深色界面不会被误认成遮罩：深灰 #1e1e1e、纯黑、纯白都是 0", () => {
    expect(measureOverlayRatio(makePixelImg(160, 100, () => [30, 30, 30]))).toBe(0);
    expect(measureOverlayRatio(makePixelImg(160, 100, () => [0, 0, 0]))).toBe(0);
    expect(measureOverlayRatio(makePixelImg(160, 100, () => [255, 255, 255]))).toBe(0);
  });

  it("大图抽样：整张都是遮罩底色照样得 1，整张都不是照样得 0", () => {
    expect(measureOverlayRatio(makePixelImg(1000, 800, OVERLAY_PX))).toBe(1);
    expect(measureOverlayRatio(makePixelImg(1000, 800, () => [200, 120, 40]))).toBe(0);
  });

  it("读不出像素：返回 null（调用方按「无法判断」处理，不当成 0）", () => {
    const base = makeImg(160, 100);
    expect(measureOverlayRatio(base)).toBeNull(); // 没有 toBitmap
    expect(measureOverlayRatio({ toBitmap: () => Buffer.alloc(160 * 100 * 4) } as never)).toBeNull(); // 没有 getSize
    expect(measureOverlayRatio({ ...base, toBitmap: () => { throw new Error("native"); } })).toBeNull();
    expect(measureOverlayRatio({ ...base, getSize: () => { throw new Error("native"); }, toBitmap: () => Buffer.alloc(64000) })).toBeNull();
    expect(measureOverlayRatio({ ...base, toBitmap: () => Buffer.alloc(100) })).toBeNull(); // 位图比尺寸声称的短
    expect(measureOverlayRatio({ ...base, getSize: () => ({ width: 0, height: 0 }), toBitmap: () => Buffer.alloc(0) })).toBeNull();
    expect(measureOverlayRatio({ ...base, toBitmap: () => undefined as never })).toBeNull();
    expect(measureOverlayRatio(null)).toBeNull();
    expect(measureOverlayRatio(undefined)).toBeNull();
  });

  it("capture 把它带出来：量的是压缩 / 缩小之前的原始位图（缩小后的图没有像素也不影响）", async () => {
    // 体积压不下去 → 触发缩小；resize 之后的图是没有 toBitmap 的假图
    const img = { ...makePixelImg(160, 100, OVERLAY_PX), toJPEG: () => Buffer.alloc(3_000_000, 1) };
    const { shot } = make({ sources: [{ display_id: "1", thumbnail: img }], maxBytes: 1000 });
    const r = await shot.capture();
    expect(r.frame.imageWidth).toBe(320); // 确实走了缩小这条路径（缩小有 320 宽的下限；假图本身只有 160 宽）
    expect(r.overlayRatio).toBe(1);
  });

  it("capture：正常屏幕 = 0；图里读不出像素 = null", async () => {
    const normal = make({ sources: [{ display_id: "1", thumbnail: makePixelImg(160, 100, () => [250, 250, 250]) }] });
    expect((await normal.shot.capture()).overlayRatio).toBe(0);
    const unknown = make();
    expect((await unknown.shot.capture()).overlayRatio).toBeNull();
  });
});

describe("blackRatio / sig：macOS 27 上遮罩把屏幕截成一片黑，靠它们认出来", () => {
  it("capture 带出 blackRatio 和 sig：整张纯黑 → blackRatio 1、遮罩色占比 0、指纹全 0", async () => {
    const { shot } = make({ sources: [{ display_id: "1", thumbnail: makePixelImg(160, 100, () => [0, 0, 0]) }] });
    const r = await shot.capture();
    expect(r.blackRatio).toBe(1);
    expect(r.overlayRatio).toBe(0);
    expect(r.sig).toBeInstanceOf(Uint8Array);
    expect(r.sig).toHaveLength(48 * 27 * 3);
    expect(Array.from(r.sig!).every((v) => v === 0)).toBe(true);
  });

  it("capture：正常屏幕 → blackRatio 0、指纹是真实颜色；遮罩色整页 → overlayRatio 1、blackRatio 0", async () => {
    const normal = make({ sources: [{ display_id: "1", thumbnail: makePixelImg(160, 100, () => [250, 120, 40]) }] });
    const n = await normal.shot.capture();
    expect(n.blackRatio).toBe(0);
    expect(Array.from(n.sig!.slice(0, 3))).toEqual([250, 120, 40]);

    const navy = make({ sources: [{ display_id: "1", thumbnail: makePixelImg(160, 100, OVERLAY_PX) }] });
    const v = await navy.shot.capture();
    expect(v.overlayRatio).toBe(1);
    expect(v.blackRatio).toBe(0);
  });

  it("图里读不出像素：overlayRatio / blackRatio / sig 都是 null（不当成 0，守卫按「无法判断」处理）", async () => {
    const r = await make().shot.capture();
    expect(r.overlayRatio).toBeNull();
    expect(r.blackRatio).toBeNull();
    expect(r.sig).toBeNull();
  });

  it("量的是压缩 / 缩小之前的原始位图：体积压不下去触发缩小之后，blackRatio / sig 照样是原图的", async () => {
    const img = { ...makePixelImg(160, 100, () => [0, 0, 0]), toJPEG: () => Buffer.alloc(3_000_000, 1) };
    const { shot } = make({ sources: [{ display_id: "1", thumbnail: img }], maxBytes: 1000 });
    const r = await shot.capture();
    expect(r.frame.imageWidth).toBe(320); // 确实走了缩小这条路径
    expect(r.blackRatio).toBe(1);
    expect(r.sig).toHaveLength(48 * 27 * 3);
  });

  it("这些统计字段只给 capture-guard 用：jpeg 和 frame 不受影响", async () => {
    const { shot } = make({ sources: [{ display_id: "1", thumbnail: makePixelImg(160, 100, () => [0, 0, 0]) }] });
    const r = await shot.capture();
    expect(r.jpeg.length).toBe(1000);
    expect(r.frame).toEqual({ imageWidth: 160, imageHeight: 100, rect: RECT });
  });
});
