/**
 * 存储降级红条 StorageDegradedBar 的 SSR 渲染（R14 B2-2 / Q9-01 = Q15-02）：
 * src/components/tasks/storage-degraded-bar.tsx
 *
 * 事件写盘失败期间，事件流顶部常驻这条红条（AI 的新输出只显示在当前页面、没落盘，用户必须一直知道）。
 * 项目里没有 DOM 测试环境，所以走 renderToStaticMarkup 的 SSR 冒烟（手法同 task-mr-links.test.ts），
 * 守的是「组件把 state.code 接到了 describeStorageDegraded」和「渲染结果符合 ui-conventions」：
 *   ① 结构：role="alert" 的单个警示容器；标题与 detail 各占一个元素、标题在前；三档按 code 分档；图标对读屏隐藏；
 *   ② 文案面向用户：渲染出来的文字里没有 errno 码；
 *   ③ 样式：颜色走语义 token（destructive），没有裸色号 / 十六进制 / 内联 style；红条静止（无 animate-* / blur / 整块 opacity）；
 *   ④ className 透传：追加在基类之后、优先级高于基类。
 * 文案本身逐字钉在 storage-degraded.test.ts，这里的期望值一律取自 describeStorageDegraded，不再重复写一遍字面量。
 *
 * 样式只看「渲染出来的 class」、不读源码：cn() 合并后的结果才是用户拿到的；读源码文本怕换行 / 抽常量。
 * 源码文本层面的扫描（原生 title= / backdrop-blur / animate-ping / 裸调色板）由 ui-convention-scan.test.ts 的 FIXED_FILES 守，
 * 这里补它不覆盖的：整块 opacity、animate-*、十六进制色、内联 style。
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StorageDegradedBar } from "@/components/tasks/storage-degraded-bar";
import { describeStorageDegraded } from "@/lib/storage-degraded";

const render = (code: string, className?: string): string =>
  renderToStaticMarkup(createElement(StorageDegradedBar, { state: { code }, className }));

/** 根元素（红条的外层 div）的 class 属性值 */
const rootClass = (html: string): string => /^<div\b[^>]*\bclass="([^"]*)"/.exec(html)?.[1] ?? "";
/** 去掉标签，只剩用户看得到的文字 */
const textOf = (html: string): string => html.replace(/<[^>]*>/g, "");

// 与 ui-convention-scan.test.ts / event-stream-v2-contract.test.ts 同款的裸色规则
// （不能 import 它们：import 一个测试文件会把它的 describe 一并注册进来）
const RAW_PALETTE =
  /\b(?:bg|text|border(?:-[xytblrse])?|ring|fill|stroke|from|via|to|outline|divide|shadow|decoration|accent|caret)-(?:red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone)-\d{2,3}\b/;
const RAW_WHITE_BLACK = /\b(?:bg|text|border|ring|fill|stroke)-(?:white|black)\b/;
// 20~99 的整块 opacity（opacity-0 / opacity-100 是显隐、允许）；颜色的 alpha 写法（border-destructive/30）不是它
const MID_OPACITY = /(?<![\w/-])(?:[\w/-]+:)*opacity-(?:[2-9]\d)\b/;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("StorageDegradedBar · 结构与分档", () => {
  it('根节点是 role="alert" 的警示容器，整条只有这一个 alert', () => {
    const html = render("ENOSPC");
    expect(html).toMatch(/^<div\b[^>]*\brole="alert"/);
    expect(html.match(/role="alert"/g)).toHaveLength(1);
  });

  it.each([
    { code: "ENOSPC", tier: "磁盘空间档" },
    { code: "EDQUOT", tier: "磁盘空间档" },
    { code: "EROFS", tier: "只读档" },
    { code: "EIO", tier: "写入失败档" },
    { code: "", tier: "写入失败档（帧里没带 code）" },
  ])("code=$code（$tier）：标题与 detail 来自 describeStorageDegraded，各占一个元素、标题在前", ({ code }) => {
    const { title, detail } = describeStorageDegraded(code);
    const html = render(code);
    // `>…<` 夹住 = 整段文字独占一个元素，没有被拼进同一段文本
    expect(html).toContain(`>${title}<`);
    expect(html).toContain(`>${detail}<`);
    expect(html.indexOf(`>${title}<`)).toBeLessThan(html.indexOf(`>${detail}<`));
  });

  it("EDQUOT 与 ENOSPC 同档：渲染结果完全相同", () => {
    expect(render("EDQUOT")).toBe(render("ENOSPC"));
  });

  it("三档渲染互不相同：组件确实按 state.code 分档，没有写死某一档", () => {
    const variants = new Set([render("ENOSPC"), render("EROFS"), render("EIO")]);
    expect(variants.size).toBe(3);
  });

  it("警示图标是装饰性的：带 aria-hidden，读屏只读标题与说明、不多播一遍图标", () => {
    const svg = /<svg\b[^>]*>/.exec(render("ENOSPC"))?.[0];
    expect(svg).toBeDefined();
    expect(svg).toContain('aria-hidden="true"');
  });

  it("渲染没有 React 开发期警告（console.error 未被调用）", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    render("ENOSPC", "mt-3");
    render("");
    expect(err).not.toHaveBeenCalled();
  });
});

describe("StorageDegradedBar · 文案面向用户：不带 errno 码", () => {
  it.each(["ENOSPC", "EDQUOT", "EROFS", "EIO", "EACCES", "EPERM", "EBUSY", "EWEIRD"])(
    "code=%s：渲染出的文字里没有这个码，也没有三个以上连续大写字母",
    (code) => {
      const text = textOf(render(code));
      // 码只进服务端日志；组件不能把 state.code 回显到界面
      expect(text).not.toContain(code);
      expect(text).not.toMatch(/[A-Z]{3,}/);
    },
  );
});

describe("StorageDegradedBar · 样式契约（只看渲染出来的 class）", () => {
  it("颜色走语义 token：含 destructive；没有裸调色板色 / text-white / 十六进制色 / 内联 style", () => {
    for (const code of ["ENOSPC", "EROFS", "EIO"]) {
      const html = render(code);
      expect(html, code).toMatch(/\bdestructive\b/);
      expect(html, code).not.toMatch(RAW_PALETTE);
      expect(html, code).not.toMatch(RAW_WHITE_BLACK);
      expect(html, code).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(html, code).not.toMatch(/\bstyle=/);
    }
  });

  it("红条是静止的：没有 animate-pulse / ping / spin / bounce、没有 backdrop-blur、没有 20–99 的整块 opacity", () => {
    // ui-conventions「事件流 v2」：同屏主动效只留状态行 shimmer；浮在内容上的面要实心；层级不靠整块 opacity
    const html = render("ENOSPC", "mt-3");
    expect(html).not.toMatch(/\banimate-(?:pulse|ping|spin|bounce)\b/);
    expect(html).not.toContain("backdrop-blur");
    expect(html).not.toMatch(MID_OPACITY);
  });

  it("自检：整块 opacity 的检测对违规写法真会报，对颜色 alpha 与显隐不误报", () => {
    expect(MID_OPACITY.test('class="a opacity-60"')).toBe(true);
    expect(MID_OPACITY.test('class="dark:opacity-70"')).toBe(true);
    expect(MID_OPACITY.test('class="border-destructive/30 bg-destructive/10 opacity-0 opacity-100"')).toBe(false);
  });
});

describe("StorageDegradedBar · className 透传", () => {
  it("追加在基类之后、不吞基类", () => {
    const base = rootClass(render("ENOSPC"));
    expect(base).not.toBe("");
    expect(rootClass(render("ENOSPC", "mt-3 custom-x"))).toBe(`${base} mt-3 custom-x`);
  });

  it("优先级高于基类：与基类冲突的 padding 以传入的为准（className 放在 cn 的最后）", () => {
    const cls = rootClass(render("ENOSPC", "px-6")).split(/\s+/);
    expect(cls).toContain("px-6");
    expect(cls).not.toContain("px-4");
  });

  it("不传 className：根 class 里没有 undefined / null，也没有多余空格", () => {
    const cls = rootClass(render("ENOSPC"));
    expect(cls).not.toMatch(/undefined|null/);
    expect(cls).toBe(cls.trim().replace(/\s+/g, " "));
  });
});
