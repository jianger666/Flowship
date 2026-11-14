/**
 * 音视频播放器悬浮窗 × 内置浏览器的层级：播放器必须被浮层遮盖机制识别。
 *
 * 现象（用户截图）：播放器是 fixed z-40 的 DOM 浮窗，内置浏览器是原生 WebContentsView、永远压在 HTML 之上，
 * 两者在屏幕上相交时浏览器页面把播放器的一块（含进度条 / 控制条）盖住。
 * 修法 = 让 use-overlay-cover 认得播放器（相交时把浏览器换成截图占位），并在播放器开合 / 挪位 / 改尺寸时主动通知评估
 * （播放器挂在应用根部、位置靠 style，MutationObserver 看不到）。
 *
 * 仓库没有 jsdom：行为面用纯函数 + 假 window 测，接线面用「去注释后的源码契约」钉住（同 browser-r1-renderer）。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HARD_OVERLAY_SELECTOR, classifyCover } from "@/components/browser/overlay-cover-logic";
import { OVERLAY_LAYOUT_EVENT, notifyOverlayLayoutChanged } from "@/lib/overlay-layout-event";

const ROOT = resolve(__dirname, "..");
const read = (p: string): string => readFileSync(resolve(ROOT, p), "utf8");

/** 去掉块注释与整行 // 注释（注释里的代码样字符串不该参与断言） */
const stripComments = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n");

describe("遮盖判定认得播放器", () => {
  it("HARD_OVERLAY_SELECTOR 含 [data-media-dock]（常驻浮层、不是瞬时的）", () => {
    expect(HARD_OVERLAY_SELECTOR.split(",")).toContain("[data-media-dock]");
  });

  it("播放器窗体矩形与浏览器视口相交 → 必须立刻遮盖（hard）；不相交 → 不遮盖（浏览器保持可操作）", () => {
    // 数值取自用户截图（CSS 像素）：浏览器视口 x 88–770，播放器 x 733–937
    const viewport = { left: 88, top: 198, right: 770, bottom: 545 };
    const dockOverlapping = { rect: { left: 733, top: 80, right: 937, bottom: 495 }, transient: false };
    const dockAway = { rect: { left: 780, top: 80, right: 937, bottom: 495 }, transient: false };
    expect(classifyCover([dockOverlapping], viewport)).toBe("hard");
    expect(classifyCover([dockAway], viewport)).toBe("none");
  });
});

describe("notifyOverlayLayoutChanged", () => {
  const g = globalThis as unknown as { window?: unknown };
  const original = g.window;
  afterEach(() => {
    if (original === undefined) delete g.window;
    else g.window = original;
  });

  it("无 window（SSR / node）静默跳过、不抛", () => {
    delete g.window;
    expect(() => notifyOverlayLayoutChanged()).not.toThrow();
  });

  it("有 window：派发 OVERLAY_LAYOUT_EVENT（use-overlay-cover 监听同名事件）", () => {
    const dispatchEvent = vi.fn();
    g.window = { dispatchEvent };
    notifyOverlayLayoutChanged();
    expect(dispatchEvent).toHaveBeenCalledTimes(1);
    const ev = dispatchEvent.mock.calls[0]![0] as Event;
    expect(ev.type).toBe(OVERLAY_LAYOUT_EVENT);
  });
});

describe("接线契约（源码）", () => {
  const dock = stripComments(read("src/components/media/media-player-dock.tsx"));
  const cover = stripComments(read("src/components/browser/use-overlay-cover.ts"));

  it("播放器根节点带 data-media-dock、且是 fixed 浮窗（选择器命中的就是窗体本身）", () => {
    expect(dock).toContain('data-media-dock=""');
    // 同一个根 div 上：fixed 定位 + style 里的 rect（getBoundingClientRect 读到的是窗体真实矩形）
    const rootStart = dock.indexOf('data-media-dock=""');
    const rootTag = dock.slice(rootStart, dock.indexOf("<div", rootStart + 1));
    expect(rootTag).toContain('"fixed z-40');
    expect(rootTag).toContain("left: rect.x, top: rect.y, width: rect.w, height: rect.h");
  });

  it("播放器在 rect / 全屏变化时通知（含首次挂载），关闭（卸载）时再通知一次", () => {
    expect(dock).toContain('from "@/lib/overlay-layout-event"');
    // 位置 / 尺寸 / 全屏变化：layout effect + 完整依赖
    expect(dock).toMatch(
      /useLayoutEffect\(\(\) => \{\s*notifyOverlayLayoutChanged\(\);\s*\}, \[rect\.x, rect\.y, rect\.w, rect\.h, isFullscreen\]\)/,
    );
    // 卸载：effect 的 cleanup 里通知（浏览器才能从截图占位恢复）
    expect(dock).toMatch(
      /useEffect\(\s*\(\) => \(\) => \{\s*notifyOverlayLayoutChanged\(\);\s*\},\s*\[\],?\s*\)/,
    );
  });

  it("use-overlay-cover 监听该事件触发评估，并在卸载时摘掉监听", () => {
    expect(cover).toContain("window.addEventListener(OVERLAY_LAYOUT_EVENT, schedule)");
    expect(cover).toContain("window.removeEventListener(OVERLAY_LAYOUT_EVENT, schedule)");
  });
});
