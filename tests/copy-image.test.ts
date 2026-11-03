/**
 * 复制图片到剪贴板（lib/copy-image）：<img> 加载 → canvas 重编码 PNG → clipboard.write。
 *
 * 本仓 vitest 是 node 环境（没有 DOM / 剪贴板），用最小的假 Image / canvas / clipboard 桩把整条链路真跑一遍。
 * 重点是几条失败路径都得抛「带中文文案的 Error」（灯箱直接拿它 toast），而且失败时不能碰剪贴板。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { canCopyImage, copyImageToClipboard } from "@/lib/copy-image";

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
