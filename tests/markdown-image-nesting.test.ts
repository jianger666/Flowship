/**
 * 链接里套图（`[![alt](img)](href)`——徽章 / 二维码的常见写法）不能渲染出嵌套的交互元素（R14 B6-4 审查补洞）。
 *
 * Q19-02 把 MarkdownImage 从 `<img onClick>` 改成了 `<button><img/></button>`（让键盘 / 读屏可达）；而 MarkdownLink 把
 * http(s) 链接渲染成 `<a>`、本地图片链接渲染成 `<button>`。两者叠在一起就成了 a 套 button / button 套 button：
 * 无效 HTML（React 开发态报 validateDOMNesting）、多一个 Tab 停靠点，焦点在内层按钮上按 Enter 会同时触发灯箱和链接。
 *
 * 做法：与 tests/streamdown-options.test.ts 同款管线（raw → sanitize → harden；remark 带 gfm）+ 真实的 MarkdownLink /
 * MarkdownImage，在 ImagePreviewProvider 里 renderToStaticMarkup，再用标签栈扫产出的 HTML：
 * 任何 a / button 的后代里又出现 a / button 就算违规。
 * 局限：只验静态 HTML 结构；点击后的行为（灯箱是否打开、链接是否跳转）、真机布局无法在这里验证。
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Streamdown, defaultRehypePlugins, defaultRemarkPlugins } from "streamdown";
import { afterEach, describe, expect, it } from "vitest";

import { MarkdownLink } from "@/components/markdown-link";
import { ImagePreviewProvider, MarkdownImage } from "@/components/ui/image-preview";
import { markRemoteImageLoaded, resetRemoteImageLoadedForTests } from "@/lib/remote-image-gate";

const REHYPE = [defaultRehypePlugins.raw, defaultRehypePlugins.sanitize, defaultRehypePlugins.harden];
const REMARK = [...Object.values(defaultRemarkPlugins)];
const CONTROLS = { code: { copy: true, download: false }, table: false };

/** 与 markdown-text.tsx 同款接线：a → MarkdownLink、img → MarkdownImage，外面是 ImagePreviewProvider */
const render = (md: string): string =>
  renderToStaticMarkup(
    createElement(
      ImagePreviewProvider,
      null,
      createElement(
        Streamdown,
        {
          rehypePlugins: REHYPE,
          remarkPlugins: REMARK,
          controls: CONTROLS,
          components: { a: MarkdownLink, img: MarkdownImage },
        } as never,
        md,
      ),
    ),
  );

const INTERACTIVE = new Set(["a", "button"]);
const VOID = new Set(["img", "br", "hr", "input", "meta", "link"]);

/** 标签栈扫 HTML：返回每一处「交互元素里又套了交互元素」，如 ["button in a"] */
const nestedInteractive = (html: string): string[] => {
  const found: string[] = [];
  const stack: string[] = [];
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b[^>]*?(\/?)>/g;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const closing = m[1] === "/";
    const tag = m[2].toLowerCase();
    if (VOID.has(tag) || m[3] === "/") continue;
    if (closing) {
      const at = stack.lastIndexOf(tag);
      if (at >= 0) stack.length = at;
      continue;
    }
    if (INTERACTIVE.has(tag)) {
      const outer = [...stack].reverse().find((t) => INTERACTIVE.has(t));
      if (outer) found.push(`${tag} in ${outer}`);
    }
    stack.push(tag);
  }
  return found;
};

const count = (html: string, re: RegExp): number => (html.match(re) ?? []).length;

// 远程图默认只有占位（前端安全硬化：不发请求、点击才加载）。要测「图真的渲染出来以后」的嵌套结构，
// 先把这几张图标成「已点击加载」；每条用例后清掉，免得串到别的用例
const REMOTE_BADGE = "https://img.example.com/badge.svg";
const REMOTE_A = "https://img.example.com/a.png";
afterEach(() => resetRemoteImageLoadedForTests());

describe("扫描器自检：认得出嵌套、也不乱报（防这条契约悄悄哑掉）", () => {
  it("a 套 button / button 套 button → 违规；并排的、img 套在 a 里 → 放过", () => {
    expect(nestedInteractive('<p><a href="x"><button type="button">y</button></a></p>')).toEqual(["button in a"]);
    expect(nestedInteractive("<button><button>y</button></button>")).toEqual(["button in button"]);
    expect(nestedInteractive("<button><span><button>y</button></span></button>")).toEqual(["button in button"]);
    expect(nestedInteractive('<a href="x">1</a><button>2</button><a href="y"><img src="z"/></a>')).toEqual([]);
  });
});

describe("链接里套图：不渲染嵌套的交互元素（Q19-02 × MarkdownLink）", () => {
  it("http(s) 链接里套远程图（徽章）：图默认被拦成文本占位——没有 img、没有按钮、没有图 URL；链接还在", () => {
    const html = render("[![构建状态](https://img.example.com/badge.svg)](https://github.com/x/y)");
    expect(html).toContain('href="https://github.com/x/y"');
    expect(html).not.toContain("https://img.example.com/badge.svg");
    expect(html).not.toMatch(/<img\b/);
    expect(html).toContain("[远程图片：构建状态（img.example.com）]");
    expect(nestedInteractive(html)).toEqual([]);
    expect(count(html, /<button\b/g)).toBe(0);
  });

  it("http(s) 链接里套图（徽章），图已被点击加载过：a 里直接是 img，没有 button；图和链接都还在", () => {
    markRemoteImageLoaded(REMOTE_BADGE);
    const html = render("[![构建状态](https://img.example.com/badge.svg)](https://github.com/x/y)");
    expect(html).toContain('href="https://github.com/x/y"');
    expect(html).toContain("https://img.example.com/badge.svg");
    expect(nestedInteractive(html)).toEqual([]);
    expect(count(html, /<button\b/g)).toBe(0);
  });

  it("本地图片链接里套图（二维码）：只有 MarkdownLink 的那一个 button，里面不再套 button", () => {
    const html = render("[![二维码](/Users/x/qr.png)](/Users/x/qr.png)");
    expect(html).toContain("/api/local-image?path=");
    expect(nestedInteractive(html)).toEqual([]);
    expect(count(html, /<button\b/g)).toBe(1);
  });

  it("文字和图混排的链接：远程图默认是文本占位（无 img），不嵌套", () => {
    const html = render("[看 ![图](https://img.example.com/a.png) 这里](https://example.com/doc)");
    expect(html).toContain('href="https://example.com/doc"');
    expect(html).not.toContain("https://img.example.com/a.png");
    expect(html).not.toMatch(/<img\b/);
    expect(nestedInteractive(html)).toEqual([]);
  });

  it("文字和图混排的链接，图已加载过：渲染出 img，同样不嵌套", () => {
    markRemoteImageLoaded(REMOTE_A);
    const html = render("[看 ![图](https://img.example.com/a.png) 这里](https://example.com/doc)");
    expect(html).toContain('href="https://example.com/doc"');
    expect(html).toContain("https://img.example.com/a.png");
    expect(nestedInteractive(html)).toEqual([]);
  });

  it("对照：不在链接里的本地图仍是一个带名字的 button（Q19-02 不被修坏）", () => {
    const html = render("![示意图](/api/tasks/t1/uploads/a.png)");
    expect(html).toContain('aria-label="查看大图:示意图"');
    expect(count(html, /<button\b/g)).toBe(1);
    expect(nestedInteractive(html)).toEqual([]);
  });

  it("对照：不在链接里的远程图是一个占位 button（没点之前没有 img）；点过之后才是「查看大图」button", () => {
    const md = "![示意图](https://img.example.com/a.png)";
    const placeholder = render(md);
    expect(placeholder).toContain('aria-label="加载远程图片（img.example.com）：示意图"');
    expect(placeholder).not.toMatch(/<img\b/);
    expect(count(placeholder, /<button\b/g)).toBe(1);
    markRemoteImageLoaded(REMOTE_A);
    const loaded = render(md);
    expect(loaded).toContain('aria-label="查看大图:示意图"');
    expect(count(loaded, /<button\b/g)).toBe(1);
    expect(nestedInteractive(loaded)).toEqual([]);
  });
});
