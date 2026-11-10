/**
 * 复制图片到剪贴板（lib/copy-image）：<img> 加载 → canvas 重编码 PNG → clipboard.write。
 *
 * 本仓 vitest 是 node 环境（没有 DOM / 剪贴板），用最小的假 Image / canvas / clipboard 桩把整条链路真跑一遍。
 * 重点是几条失败路径都得抛「带中文文案的 Error」（灯箱直接拿它 toast），而且失败时不能碰剪贴板。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  VECTOR_MAX_LONG_EDGE,
  VECTOR_MIN_LONG_EDGE,
  canCopyImage,
  copyImageToClipboard,
  resolveRasterSize,
} from "@/lib/copy-image";

interface ImageBehavior {
  fail?: boolean;
  width?: number;
  height?: number;
}

/** 装一套假的浏览器环境，返回各个探针 */
const installEnv = (
  opts: {
    image?: ImageBehavior;
    toBlob?: "ok" | "null" | "throw";
    clipboardRejects?: boolean;
    withClipboardItem?: boolean;
  } = {},
) => {
  const loaded: Array<{ src: string; crossOrigin: string }> = [];
  const pngBlob = { size: 3, type: "image/png" } as unknown as Blob;

  class FakeImage {
    crossOrigin = "";
    naturalWidth = opts.image?.width ?? 640;
    naturalHeight = opts.image?.height ?? 480;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    set src(value: string) {
      loaded.push({ src: value, crossOrigin: this.crossOrigin });
      queueMicrotask(() => (opts.image?.fail ? this.onerror?.() : this.onload?.()));
    }
  }

  const drawImage = vi.fn();
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({ drawImage }),
    toBlob: (cb: (b: Blob | null) => void, type?: string) => {
      expect(type).toBe("image/png");
      if (opts.toBlob === "throw") throw new Error("SecurityError");
      cb(opts.toBlob === "null" ? null : pngBlob);
    },
  };
  const write = vi.fn(() =>
    opts.clipboardRejects ? Promise.reject(new Error("NotAllowedError")) : Promise.resolve(),
  );

  vi.stubGlobal("Image", FakeImage);
  vi.stubGlobal("document", { createElement: () => canvas });
  vi.stubGlobal("navigator", { clipboard: { write } });
  if (opts.withClipboardItem !== false) {
    vi.stubGlobal(
      "ClipboardItem",
      class {
        constructor(public items: Record<string, Blob>) {}
      },
    );
  }
  return { loaded, canvas, drawImage, write, pngBlob };
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("canCopyImage", () => {
  it("有 ClipboardItem 和 clipboard.write 才算支持", () => {
    installEnv();
    expect(canCopyImage()).toBe(true);
  });

  it("没有 ClipboardItem（老环境）→ 不支持", () => {
    installEnv({ withClipboardItem: false });
    vi.stubGlobal("ClipboardItem", undefined);
    expect(canCopyImage()).toBe(false);
  });

  it("没有 clipboard.write → 不支持", () => {
    installEnv();
    vi.stubGlobal("navigator", { clipboard: {} });
    expect(canCopyImage()).toBe(false);
    vi.stubGlobal("navigator", {});
    expect(canCopyImage()).toBe(false);
  });
});

describe("copyImageToClipboard：成功路径", () => {
  it("加载原图 → 按原始像素尺寸画到 canvas → 以 image/png 写进剪贴板", async () => {
    const env = installEnv({ image: { width: 1280, height: 720 } });
    await copyImageToClipboard("data:image/jpeg;base64,AAAA");

    expect(env.loaded).toHaveLength(1);
    expect(env.loaded[0]!.src).toBe("data:image/jpeg;base64,AAAA");
    expect(env.canvas.width).toBe(1280);
    expect(env.canvas.height).toBe(720);
    expect(env.drawImage).toHaveBeenCalledTimes(1);
    expect(env.write).toHaveBeenCalledTimes(1);
    const item = (env.write.mock.calls[0] as unknown as [Array<{ items: Record<string, Blob> }>])[0][0]!;
    expect(Object.keys(item.items)).toEqual(["image/png"]);
    expect(item.items["image/png"]).toBe(env.pngBlob);
  });

  it("加载时带 crossOrigin=anonymous（外站图有 CORS 头才读得了像素；同源 / data 不受影响）", async () => {
    const env = installEnv();
    await copyImageToClipboard("/api/local-image?path=/a.png");
    expect(env.loaded[0]!.crossOrigin).toBe("anonymous");
  });
});

describe("copyImageToClipboard：失败路径都抛中文文案，且失败时不碰剪贴板", () => {
  it("环境不支持：直接抛，连图都不加载", async () => {
    const env = installEnv({ withClipboardItem: false });
    vi.stubGlobal("ClipboardItem", undefined);
    await expect(copyImageToClipboard("/a.png")).rejects.toThrow("当前环境不支持复制图片");
    expect(env.loaded).toHaveLength(0);
    expect(env.write).not.toHaveBeenCalled();
  });

  it("图片加载失败（外站图无 CORS / 地址失效）", async () => {
    const env = installEnv({ image: { fail: true } });
    await expect(copyImageToClipboard("https://example.com/a.png")).rejects.toThrow(/没能加载出来/);
    expect(env.write).not.toHaveBeenCalled();
  });

  it("读不到尺寸（0×0，如无固有尺寸的 SVG）", async () => {
    const env = installEnv({ image: { width: 0, height: 0 } });
    await expect(copyImageToClipboard("/a.svg")).rejects.toThrow("读不到图片尺寸，复制失败");
    expect(env.write).not.toHaveBeenCalled();
  });

  it("画布被污染：toBlob 同步抛 SecurityError → 文案点明是外部站点", async () => {
    const env = installEnv({ toBlob: "throw" });
    await expect(copyImageToClipboard("https://example.com/a.png")).rejects.toThrow(/外部站点/);
    expect(env.write).not.toHaveBeenCalled();
  });

  it("toBlob 回调 null（编码失败）", async () => {
    const env = installEnv({ toBlob: "null" });
    await expect(copyImageToClipboard("/a.png")).rejects.toThrow("图片转换失败，复制失败");
    expect(env.write).not.toHaveBeenCalled();
  });

  it("clipboard.write 被拒（没权限 / 页面没焦点）", async () => {
    const env = installEnv({ clipboardRejects: true });
    await expect(copyImageToClipboard("/a.png")).rejects.toThrow(/写入剪贴板失败/);
    expect(env.write).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------- R7-10：fallbackSize / vector（图片查看器的 SVG 复制）

describe("resolveRasterSize：canvas 尺寸的决定规则（纯函数）", () => {
  it("位图：有固有尺寸就原样（不放大、不缩小、不看 fallbackSize）", () => {
    expect(resolveRasterSize({ w: 2250, h: 1494 })).toEqual({ w: 2250, h: 1494 });
    expect(resolveRasterSize({ w: 24, h: 24 })).toEqual({ w: 24, h: 24 }); // 小位图不放大（放大只会糊）
    expect(resolveRasterSize({ w: 12000, h: 8000 })).toEqual({ w: 12000, h: 8000 }); // 大位图不缩（行为与以前一致）
    expect(resolveRasterSize({ w: 640, h: 480 }, { fallbackSize: { w: 300, h: 150 } })).toEqual({ w: 640, h: 480 });
  });

  it("没有固有尺寸（0×0）：用 fallbackSize；没有 fallbackSize / fallbackSize 不可用 → null", () => {
    expect(resolveRasterSize({ w: 0, h: 0 }, { fallbackSize: { w: 300, h: 150 } })).toEqual({ w: 300, h: 150 });
    expect(resolveRasterSize({ w: 0, h: 10 }, { fallbackSize: { w: 300, h: 150 } })).toEqual({ w: 300, h: 150 }); // 只有一边为 0 也算没有
    expect(resolveRasterSize({ w: 0, h: 0 })).toBeNull();
    for (const bad of [
      { w: 0, h: 150 },
      { w: 300, h: 0 },
      { w: -1, h: 150 },
      { w: Number.NaN, h: 150 },
      { w: 300, h: Number.POSITIVE_INFINITY },
    ]) {
      expect(resolveRasterSize({ w: 0, h: 0 }, { fallbackSize: bad }), JSON.stringify(bad)).toBeNull();
    }
  });

  it("vector：长边不足 1024 → 等比放大到 1024（24×24 图标不再糊成一个点）", () => {
    expect(resolveRasterSize({ w: 24, h: 24 }, { vector: true })).toEqual({ w: 1024, h: 1024 });
    expect(resolveRasterSize({ w: 24, h: 12 }, { vector: true })).toEqual({ w: 1024, h: 512 });
    expect(resolveRasterSize({ w: 12, h: 24 }, { vector: true })).toEqual({ w: 512, h: 1024 });
    expect(resolveRasterSize({ w: 1000, h: 500 }, { vector: true })).toEqual({ w: 1024, h: 512 });
    expect(resolveRasterSize({ w: 3, h: 7 }, { vector: true })).toEqual({ w: 439, h: 1024 }); // 取整：3 × 146.29 = 438.86
  });

  it("vector：长边在 [1024, 4096] 内原样；超过 4096 → 等比缩到 4096（不撑爆 canvas）", () => {
    expect(VECTOR_MIN_LONG_EDGE).toBe(1024);
    expect(VECTOR_MAX_LONG_EDGE).toBe(4096);
    expect(resolveRasterSize({ w: 1024, h: 768 }, { vector: true })).toEqual({ w: 1024, h: 768 });
    expect(resolveRasterSize({ w: 4096, h: 1000 }, { vector: true })).toEqual({ w: 4096, h: 1000 });
    expect(resolveRasterSize({ w: 2000, h: 3000 }, { vector: true })).toEqual({ w: 2000, h: 3000 });
    expect(resolveRasterSize({ w: 8192, h: 4096 }, { vector: true })).toEqual({ w: 4096, h: 2048 });
    expect(resolveRasterSize({ w: 4097, h: 4097 }, { vector: true })).toEqual({ w: 4096, h: 4096 });
    expect(resolveRasterSize({ w: 20000, h: 10000 }, { vector: true })).toEqual({ w: 4096, h: 2048 });
  });

  it("vector + 无固有尺寸：兜底尺寸同样适用放大规则（300×150 → 1024×512）", () => {
    expect(resolveRasterSize({ w: 0, h: 0 }, { vector: true, fallbackSize: { w: 300, h: 150 } })).toEqual({ w: 1024, h: 512 });
    expect(resolveRasterSize({ w: 0, h: 0 }, { vector: true })).toBeNull(); // 没有兜底仍是 null，不凭空编尺寸
  });

  it("极端长宽比：每边至少 1px（不会出现 0 宽 / 0 高的 canvas）", () => {
    expect(resolveRasterSize({ w: 100000, h: 1 }, { vector: true })).toEqual({ w: 4096, h: 1 });
    expect(resolveRasterSize({ w: 1, h: 100000 }, { vector: true })).toEqual({ w: 1, h: 4096 });
  });
});

describe("copyImageToClipboard：fallbackSize / vector 接进整条链路", () => {
  it("位图不变：不传选项 → canvas 就是原尺寸，drawImage(img, 0, 0, w, h)", async () => {
    const env = installEnv({ image: { width: 2250, height: 1494 } });
    await copyImageToClipboard("/api/local-image?path=/a.jpg");
    expect(env.canvas.width).toBe(2250);
    expect(env.canvas.height).toBe(1494);
    expect(env.drawImage.mock.calls[0]!.slice(1)).toEqual([0, 0, 2250, 1494]);
    expect(env.write).toHaveBeenCalledTimes(1);
  });

  it("位图不变：传了 fallbackSize 也不起作用（固有尺寸优先）；小位图不放大（没传 vector）", async () => {
    const env = installEnv({ image: { width: 24, height: 24 } });
    await copyImageToClipboard("/a.png", { fallbackSize: { w: 300, h: 150 } });
    expect(env.canvas.width).toBe(24);
    expect(env.canvas.height).toBe(24);
    expect(env.drawImage.mock.calls[0]!.slice(1)).toEqual([0, 0, 24, 24]);
  });

  it("无固有尺寸（0×0）+ 有 fallbackSize → 按兜底尺寸栅格化并成功（不再报「读不到图片尺寸」）", async () => {
    const env = installEnv({ image: { width: 0, height: 0 } });
    await copyImageToClipboard("blob:http://localhost/x", { fallbackSize: { w: 300, h: 150 } });
    expect(env.canvas.width).toBe(300);
    expect(env.canvas.height).toBe(150);
    expect(env.drawImage.mock.calls[0]!.slice(1)).toEqual([0, 0, 300, 150]);
    expect(env.write).toHaveBeenCalledTimes(1);
  });

  it("无固有尺寸 + 没有 fallbackSize → 仍是原来的失败文案，且不碰剪贴板（既有行为不变）", async () => {
    const env = installEnv({ image: { width: 0, height: 0 } });
    await expect(copyImageToClipboard("/a.svg", { vector: true })).rejects.toThrow("读不到图片尺寸，复制失败");
    expect(env.write).not.toHaveBeenCalled();
  });

  it("vector：24×24 的图标放大到 1024×1024 再画", async () => {
    const env = installEnv({ image: { width: 24, height: 24 } });
    await copyImageToClipboard("blob:http://localhost/icon", { vector: true, fallbackSize: { w: 24, h: 24 } });
    expect(env.canvas.width).toBe(1024);
    expect(env.canvas.height).toBe(1024);
    expect(env.drawImage.mock.calls[0]!.slice(1)).toEqual([0, 0, 1024, 1024]);
  });

  it("vector + 无固有尺寸：300×150 的兜底放大成 1024×512", async () => {
    const env = installEnv({ image: { width: 0, height: 0 } });
    await copyImageToClipboard("blob:http://localhost/nosize", { vector: true, fallbackSize: { w: 300, h: 150 } });
    expect(env.canvas.width).toBe(1024);
    expect(env.canvas.height).toBe(512);
  });

  it("vector：超大 SVG 长边封顶 4096", async () => {
    const env = installEnv({ image: { width: 10000, height: 5000 } });
    await copyImageToClipboard("blob:http://localhost/huge", { vector: true });
    expect(env.canvas.width).toBe(4096);
    expect(env.canvas.height).toBe(2048);
  });

  it("带选项时失败路径与文案不变：加载失败 / toBlob 失败 / 写剪贴板被拒", async () => {
    const opts = { vector: true, fallbackSize: { w: 300, h: 150 } };
    let env = installEnv({ image: { fail: true } });
    await expect(copyImageToClipboard("/a.svg", opts)).rejects.toThrow(/没能加载出来/);
    expect(env.write).not.toHaveBeenCalled();
    env = installEnv({ toBlob: "null" });
    await expect(copyImageToClipboard("/a.svg", opts)).rejects.toThrow("图片转换失败，复制失败");
    env = installEnv({ clipboardRejects: true });
    await expect(copyImageToClipboard("/a.svg", opts)).rejects.toThrow(/写入剪贴板失败/);
  });
});
