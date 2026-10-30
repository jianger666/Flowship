/**
 * 低磁盘红条 LowDiskBar / LowDiskBanner 的 SSR 渲染（R14 B2-4c / Q15-10 页面部分）：
 * src/components/tasks/low-disk-bar.tsx
 *
 * 剩余空间 < 500MB 时事件流顶部常驻一条红条（壳侧的系统通知会被关 / 被勿扰吞掉，页面上这条不依赖它）。
 * 项目里没有 DOM 测试环境，走 renderToStaticMarkup 的 SSR 冒烟（手法同 storage-degraded-bar.test.ts）：
 *   ① LowDiskBar 结构：role="alert" 单个警示容器；标题与 detail 各占一个元素、标题在前；只有「严重」才画；图标对读屏隐藏；
 *   ② 文案面向用户：没有 errno / 路径 / 英文大写缩写堆；数字跟着读数走、没有写死；
 *   ③ 样式：颜色走语义 token（destructive）；红条静止（无 animate-* / blur / 整块 opacity）；与存储降级红条外观一致；
 *   ④ className 透传；
 *   ⑤ LowDiskBanner（取数 hook 用 mock 顶替）：严重且没被压制才画；被存储降级红条压制时不画；首帧（还没取到读数）不画。
 * 文案本身逐字钉在 low-disk.test.ts，这里的期望值一律取自 describeLowDisk，不再重复写一遍字面量。
 *
 * ⚠ 只做了 SSR 渲染检查：没有在真实浏览器 / Electron 窗口里看过红条的实际观感；轮询 + 状态更新的联动靠 low-disk-poller 的假时钟测试。
 */
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DiskReading } from "@/lib/low-disk";

const hookState = vi.hoisted(() => ({ reading: null as DiskReading | null }));
vi.mock("@/hooks/use-low-disk", () => ({ useLowDisk: () => hookState.reading }));

import { LowDiskBanner, LowDiskBar } from "@/components/tasks/low-disk-bar";
import { StorageDegradedBar } from "@/components/tasks/storage-degraded-bar";
import { describeLowDisk } from "@/lib/low-disk";

const critical = (freeMB: number): DiskReading => ({ level: "critical", freeMB });

const render = (reading: DiskReading | null, className?: string): string =>
  renderToStaticMarkup(createElement(LowDiskBar, { reading, className }));

const renderBanner = (reading: DiskReading | null, suppressed?: boolean): string => {
  hookState.reading = reading;
  return renderToStaticMarkup(createElement(LowDiskBanner, suppressed === undefined ? {} : { suppressed }));
};

/** 根元素（红条的外层 div）的 class 属性值 */
const rootClass = (html: string): string => /^<div\b[^>]*\bclass="([^"]*)"/.exec(html)?.[1] ?? "";
/** 去掉标签，只剩用户看得到的文字 */
const textOf = (html: string): string => html.replace(/<[^>]*>/g, "");

// 与 ui-convention-scan.test.ts / storage-degraded-bar.test.ts 同款的裸色规则
// （不能 import 它们：import 一个测试文件会把它的 describe 一并注册进来）
const RAW_PALETTE =
  /\b(?:bg|text|border(?:-[xytblrse])?|ring|fill|stroke|from|via|to|outline|divide|shadow|decoration|accent|caret)-(?:red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone)-\d{2,3}\b/;
const RAW_WHITE_BLACK = /\b(?:bg|text|border|ring|fill|stroke)-(?:white|black)\b/;
// 20~99 的整块 opacity（opacity-0 / opacity-100 是显隐、允许）；颜色的 alpha 写法（border-destructive/30）不是它
const MID_OPACITY = /(?<![\w/-])(?:[\w/-]+:)*opacity-(?:[2-9]\d)\b/;

afterEach(() => {
  hookState.reading = null;
  vi.restoreAllMocks();
});

describe("LowDiskBar · 结构", () => {
  it('根节点是 role="alert" 的警示容器，整条只有这一个 alert', () => {
    const html = render(critical(300));
    expect(html).toMatch(/^<div\b[^>]*\brole="alert"/);
    expect(html.match(/role="alert"/g)).toHaveLength(1);
  });

  it.each([300, 1, 0, 499])("剩 %s MB：标题与 detail 来自 describeLowDisk，各占一个元素、标题在前", (mb) => {
    const reading = critical(mb);
    const copy = describeLowDisk(reading)!;
    const html = render(reading);
    // `>…<` 夹住 = 整段文字独占一个元素，没有被拼进同一段文本
    expect(html).toContain(`>${copy.title}<`);
    expect(html).toContain(`>${copy.detail}<`);
    expect(html.indexOf(`>${copy.title}<`)).toBeLessThan(html.indexOf(`>${copy.detail}<`));
  });

  it("标题里的数字跟着读数走（没有写死某个值）", () => {
    expect(render(critical(300))).not.toBe(render(critical(120)));
    expect(textOf(render(critical(120)))).toContain("120");
  });

  it.each<[string, DiskReading | null]>([
    ["null（还没取到过读数）", null],
    ["ok", { level: "ok", freeMB: 50_000 }],
    ["low（偏低只走壳侧通知，页面不画红条）", { level: "low", freeMB: 1200 }],
    ["unknown", { level: "unknown", freeMB: null }],
    ["critical 但没有数值", { level: "critical", freeMB: null }],
  ])("%s：什么都不画（空字符串）", (_name, reading) => {
    expect(render(reading)).toBe("");
  });

  it("警示图标是装饰性的：带 aria-hidden，读屏只读标题与说明、不多播一遍图标", () => {
    const svg = /<svg\b[^>]*>/.exec(render(critical(300)))?.[0];
    expect(svg).toBeDefined();
    expect(svg).toContain('aria-hidden="true"');
  });

  it("渲染没有 React 开发期警告（console.error 未被调用）", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    render(critical(300), "mt-3");
    render(null);
    renderBanner(critical(300));
    expect(err).not.toHaveBeenCalled();
  });
});

describe("LowDiskBar · 文案面向用户", () => {
  it.each([0, 1, 300, 499])("剩 %s MB：渲染出的文字里没有 errno 码 / 路径 / 三个以上连续大写字母", (mb) => {
    const text = textOf(render(critical(mb)));
    expect(text).not.toMatch(/\bE[A-Z]{3,}\b/); // ENOSPC / EDQUOT / EROFS …
    expect(text).not.toMatch(/[A-Z]{3,}/);
    expect(text).not.toMatch(/[\\/][\w.-]+[\\/]/); // 路径
    expect(text).not.toMatch(/undefined|null|NaN/);
  });
});

describe("LowDiskBar · 样式契约（只看渲染出来的 class）", () => {
  it("颜色走语义 token：含 destructive；没有裸调色板色 / text-white / 十六进制色 / 内联 style", () => {
    const html = render(critical(300));
    expect(html).toMatch(/\bdestructive\b/);
    expect(html).not.toMatch(RAW_PALETTE);
    expect(html).not.toMatch(RAW_WHITE_BLACK);
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(html).not.toMatch(/\bstyle=/);
  });

  it("红条是静止的：没有 animate-pulse / ping / spin / bounce、没有 backdrop-blur、没有 20–99 的整块 opacity", () => {
    // ui-conventions「事件流 v2」：同屏主动效只留状态行 shimmer；浮在内容上的面要实心；层级不靠整块 opacity
    const html = render(critical(300), "mt-3");
    expect(html).not.toMatch(/\banimate-(?:pulse|ping|spin|bounce)\b/);
    expect(html).not.toContain("backdrop-blur");
    expect(html).not.toMatch(MID_OPACITY);
  });

  it("自检：整块 opacity 的检测对违规写法真会报，对颜色 alpha 与显隐不误报", () => {
    expect(MID_OPACITY.test('class="a opacity-60"')).toBe(true);
    expect(MID_OPACITY.test('class="dark:opacity-70"')).toBe(true);
    expect(MID_OPACITY.test('class="border-destructive/30 bg-destructive/10 opacity-0 opacity-100"')).toBe(false);
  });

  it("与存储降级红条外观一致：两条红条先后出现时视觉基调相同（同一套外层 class）", () => {
    const storage = rootClass(renderToStaticMarkup(createElement(StorageDegradedBar, { state: { code: "ENOSPC" } })));
    expect(storage).not.toBe("");
    expect(rootClass(render(critical(300)))).toBe(storage);
  });
});

describe("LowDiskBar · className 透传", () => {
  it("追加在基类之后、不吞基类", () => {
    const base = rootClass(render(critical(300)));
    expect(base).not.toBe("");
    expect(rootClass(render(critical(300), "mt-3 custom-x"))).toBe(`${base} mt-3 custom-x`);
  });

  it("优先级高于基类：与基类冲突的 padding 以传入的为准（className 放在 cn 的最后）", () => {
    const cls = rootClass(render(critical(300), "px-6")).split(/\s+/);
    expect(cls).toContain("px-6");
    expect(cls).not.toContain("px-4");
  });

  it("不传 className：根 class 里没有 undefined / null，也没有多余空格", () => {
    const cls = rootClass(render(critical(300)));
    expect(cls).not.toMatch(/undefined|null/);
    expect(cls).toBe(cls.trim().replace(/\s+/g, " "));
  });
});

describe("LowDiskBanner · 画不画的决定", () => {
  it("严重且没被压制：画红条，内容与直接渲染 LowDiskBar 完全一致", () => {
    const html = renderBanner(critical(300), false);
    expect(html).not.toBe("");
    expect(html).toBe(render(critical(300)));
  });

  it("不传 suppressed 等同 false（默认要画）", () => {
    expect(renderBanner(critical(300))).toBe(render(critical(300)));
  });

  it("被存储降级红条压制（suppressed）时不画：两条红的说同一件事只留更紧急的那条", () => {
    expect(renderBanner(critical(300), true)).toBe("");
  });

  it.each<[string, DiskReading | null]>([
    ["null（还没取到）", null],
    ["ok", { level: "ok", freeMB: 50_000 }],
    ["low", { level: "low", freeMB: 1200 }],
    ["unknown", { level: "unknown", freeMB: null }],
  ])("读数是 %s：不画", (_name, reading) => {
    expect(renderBanner(reading, false)).toBe("");
  });

  it("真实 hook 的首帧是 null（挂载前不画条；SSR 不跑 effect、不会发请求）", async () => {
    const actual = await vi.importActual<typeof import("@/hooks/use-low-disk")>("@/hooks/use-low-disk");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("SSR 里不该取数"));
    const Probe: ComponentType = () => createElement("span", null, String(actual.useLowDisk()));
    expect(renderToStaticMarkup(createElement(Probe))).toBe("<span>null</span>");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
