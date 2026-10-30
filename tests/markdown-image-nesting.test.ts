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
import { describe, expect, it } from "vitest";

import { MarkdownLink } from "@/components/markdown-link";
import { ImagePreviewProvider, MarkdownImage } from "@/components/ui/image-preview";

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

describe("扫描器自检：认得出嵌套、也不乱报（防这条契约悄悄哑掉）", () => {
  it("a 套 button / button 套 button → 违规；并排的、img 套在 a 里 → 放过", () => {
    expect(nestedInteractive('<p><a href="x"><button type="button">y</button></a></p>')).toEqual(["button in a"]);
    expect(nestedInteractive("<button><button>y</button></button>")).toEqual(["button in button"]);
    expect(nestedInteractive("<button><span><button>y</button></span></button>")).toEqual(["button in button"]);
    expect(nestedInteractive('<a href="x">1</a><button>2</button><a href="y"><img src="z"/></a>')).toEqual([]);
  });
});

describe("链接里套图：不渲染嵌套的交互元素（Q19-02 × MarkdownLink）", () => {
  it("http(s) 链接里套图（徽章）：a 里直接是 img，没有 button；图和链接都还在", () => {
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

  it("文字和图混排的链接：同样不嵌套", () => {
    const html = render("[看 ![图](https://img.example.com/a.png) 这里](https://example.com/doc)");
    expect(html).toContain('href="https://example.com/doc"');
    expect(html).toContain("https://img.example.com/a.png");
    expect(nestedInteractive(html)).toEqual([]);
  });

  it("对照：不在链接里的图仍是一个带名字的 button（Q19-02 不被修坏）", () => {
    const html = render("![示意图](https://img.example.com/a.png)");
    expect(html).toContain('aria-label="查看大图:示意图"');
    expect(count(html, /<button\b/g)).toBe(1);
    expect(nestedInteractive(html)).toEqual([]);
  });
});
