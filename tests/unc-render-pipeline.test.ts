/**
 * Q4-06 / Q4-04：UNC 与回环同源 URL 在**真实 Streamdown 渲染链**里被拦下。
 *
 * 第四轮报告批评 R12-03「只在组件层判 UNC、测试只 grep 源码」：真实链路里 Streamdown 的 harden 先把
 * `//attacker.example/x/a.png` 改成 `/x/a.png`，组件层永远看不到 UNC。这里拿真实的
 * `STREAMDOWN_REHYPE_PLUGINS`（与 MarkdownText / 产物栏 / 修订视图共用的同一份）+ 真实 `Streamdown`
 * + `renderToStaticMarkup` 跑，断言最终 HTML。组件（MarkdownImage / MarkdownLink）是 .tsx、不在这里 import，
 * 所以看到的是插件层的结果——这正是「组件层之前」要拦住的那一层。
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Streamdown, defaultRemarkPlugins } from "streamdown";

import { STREAMDOWN_REHYPE_PLUGINS } from "@/lib/streamdown-options";
import {
  UNC_IMAGE_PLACEHOLDER,
  UNC_LINK_PLACEHOLDER,
  isUncLikeReference,
} from "@/lib/rehype-rewrite-local-images";
import { loopbackSiteRelativeUrl, toLoadableImageSrc } from "@/lib/local-image-src";

const render = (md: string): string =>
  renderToStaticMarkup(
    createElement(
      Streamdown,
      {
        mode: "static",
        remarkPlugins: Object.values(defaultRemarkPlugins),
        rehypePlugins: STREAMDOWN_REHYPE_PLUGINS,
      } as never,
      md,
    ),
  );

/** 渲染结果里任何会发请求 / 可点击的东西 */
const hasRequestingNode = (html: string): boolean => /<img\b|<a\b|<button\b/i.test(html);

const UNC_IMAGES = [
  "![x](//attacker.example/share/a.png)",
  "![x](///attacker.example/share/a.png)",
  "![x](file:////attacker.example/share/a.png)",
  "![x](file://attacker.example/share/a.png)",
  "![x](\\\\attacker.example\\share\\a.png)",
  "![x](/\\attacker.example/share/a.png)",
  "![x](%2F%2Fattacker.example%2Fshare%2Fa.png)",
  '<img src="//attacker.example/share/a.png" alt="x">',
  '<img src="\\\\attacker.example\\share\\a.png" alt="x">',
  "正文 ![x](//h/s/a.png) 后文",
];

const UNC_LINKS = [
  "[点我](//attacker.example/share/a.png)",
  "[点我](file:////attacker.example/share/a.png)",
  "[点我](file://attacker.example/share/a.png)",
  "[点我](\\\\attacker.example\\share\\a.png)",
  "[点我](//attacker.example/x)",
  "[点我](%2F%2Fattacker.example%2Fx)",
  '<a href="//attacker.example/x">点我</a>',
];

describe("Q4-06：UNC 图片在真实渲染链里变成中文占位（不再是英文 [Image blocked]，也不再是 <img>）", () => {
  it.each(UNC_IMAGES)("%s", (md) => {
    const html = render(md);
    expect(hasRequestingNode(html), html).toBe(false);
    expect(html).toContain(UNC_IMAGE_PLACEHOLDER);
    expect(html).not.toMatch(/blocked/i);
    // host 不能漏进 HTML 的任何属性
    expect(html).not.toContain("attacker.example");
  });

  it("占位前后的正文照常渲染", () => {
    const html = render("正文 ![x](//h/s/a.png) 后文");
    expect(html).toContain("正文");
    expect(html).toContain("后文");
  });
});

describe("Q4-06：UNC 链接在真实渲染链里去掉链接、保留文字并说明", () => {
  it.each(UNC_LINKS)("%s", (md) => {
    const html = render(md);
    expect(hasRequestingNode(html), html).toBe(false);
    expect(html).toContain("点我");
    expect(html).toContain(UNC_LINK_PLACEHOLDER);
    expect(html).not.toContain("attacker.example");
  });

  it("链接里嵌的 UNC 图片同样被拦", () => {
    const html = render("[![x](//h/s/a.png)](https://example.com)");
    expect(html).not.toContain("<img");
    expect(html).toContain(UNC_IMAGE_PLACEHOLDER);
  });
});

describe("旧树能用的情形仍能用（回归保护）", () => {
  it("http(s) 图 / 链接照常渲染", () => {
    const img = render("![x](https://example.com/a.png)");
    expect(img).toContain("<img");
    expect(img).toContain("https://example.com/a.png");
    const link = render("[文档](https://example.com/docs)");
    // 真实 Streamdown 的默认链接组件把外链画成 data-streamdown="link" 的按钮（点了走外链确认）
    expect(link).toContain('data-streamdown="link"');
    expect(link).toContain("文档");
    expect(link).not.toContain(UNC_LINK_PLACEHOLDER);
  });

  it("本地绝对路径图（mac / Windows 盘符 / file:///）照旧改写到 local-image 通道，不出占位", () => {
    for (const md of [
      "![x](/Users/me/a.png)",
      "![x](C:/Users/me/a.png)",
      "![x](file:///Users/me/a.png)",
      "![x](file:///C:/Users/me/a.png)",
    ]) {
      const html = render(md);
      expect(html, md).toContain("/api/local-image?path=");
      expect(html, md).not.toContain(UNC_IMAGE_PLACEHOLDER);
    }
  });

  it("站内相对链接 / 锚点 / 带 // 的普通路径中段不误伤", () => {
    expect(render("[a](/docs/a//b)")).not.toContain(UNC_LINK_PLACEHOLDER);
    expect(render("[a](#sec)")).not.toContain(UNC_LINK_PLACEHOLDER);
    expect(render("[a](https://example.com//a)")).not.toContain(UNC_LINK_PLACEHOLDER);
  });
});

describe("isUncLikeReference：识别口径", () => {
  it("命中：双斜杠 / 反斜杠 / file://host / 编码 / 单反斜杠起头 / 控制字符穿插", () => {
    for (const r of [
      "//h/s",
      "\\\\h\\s",
      "\\h\\s",
      "/\\h/s",
      "file:////h/s",
      "file://h/s",
      "FILE://h/s",
      "%2F%2Fh%2Fs",
      "%5Ch%5Cs",
      "/\t/h/s",
      " //h/s",
    ]) {
      expect(isUncLikeReference(r), JSON.stringify(r)).toBe(true);
    }
  });

  it("不命中：盘符 / posix 绝对 / file:///x / file://localhost/x / file://C:/x / http(s) / 相对 / 锚点 / 空", () => {
    for (const r of [
      "C:\\x\\a.png",
      "C:/x/a.png",
      "/Users/me/a.png",
      "file:///Users/me/a.png",
      "file:///C:/a.png",
      "file://localhost/Users/a.png",
      "file://C:/a.png",
      "https://example.com//a",
      "a/b.png",
      "#top",
      "",
    ]) {
      expect(isUncLikeReference(r), JSON.stringify(r)).toBe(false);
    }
    expect(isUncLikeReference(undefined)).toBe(false);
  });
});

describe("Q4-04：回环同源绝对 URL 图片与相对 /api/* 同口径（不再出同源 <img>）", () => {
  const LOOPBACK = [
    "http://127.0.0.1:8876/api/repo-branches?path=/Users/x/app&refresh=1",
    "http://127.0.0.1:8876/api/system/storage",
    "http://127.1:8876/api/system/storage",
    "http://2130706433:8876/api/system/storage",
    "http://0x7f.1:8876/api/system/storage",
    "http://0.0.0.0:8876/api/system/storage",
    "http://localhost:8876/api/system/storage",
    "http://[::1]:8876/api/system/storage",
    "http://127.0.0.1:8876/_next/static/x.js",
  ];

  it.each(LOOPBACK)("%s 不再原样出 <img src=回环 URL>", (u) => {
    const html = render(`![x](${u})`);
    // 不得有指向 /api/* 或 /_next/* 的同源 <img src>（local-image 通道是例外：它自带服务端守卫）
    const srcs = [...html.matchAll(/<img[^>]*\ssrc="([^"]*)"/g)].map((m) => m[1].replace(/&amp;/g, "&"));
    for (const s of srcs) {
      expect(s.startsWith("/api/local-image?path="), s).toBe(true);
      expect(s).not.toMatch(/^https?:/);
    }
  });

  it("纯函数口径：回环 + /api|/_next 才折回站内路径；与相对形态等价", () => {
    expect(loopbackSiteRelativeUrl("http://127.0.0.1:8876/api/a?b=1#c")).toBe("/api/a?b=1#c");
    expect(loopbackSiteRelativeUrl("http://127.1/api/a")).toBe("/api/a");
    expect(loopbackSiteRelativeUrl("http://2130706433/api/a")).toBe("/api/a");
    expect(toLoadableImageSrc("http://127.0.0.1:8876/api/repo-branches?path=/x")).toBe(
      toLoadableImageSrc("/api/repo-branches?path=/x"),
    );
    // 受信站内图片通道仍可用
    expect(toLoadableImageSrc("http://127.0.0.1:8876/api/local-image?path=%2Fa.png")).toBe(
      "/api/local-image?path=%2Fa.png",
    );
  });

  it("回归：外网图 / 别的本机服务的普通图 / 回环但非 /api 路径，原样不动", () => {
    for (const u of [
      "https://example.com/api/a.png",
      "http://localhost:3000/avatar.png",
      "http://127.0.0.1:3000/static/a.png",
      "http://127.0.0.1.evil.example/api/a.png",
    ]) {
      expect(loopbackSiteRelativeUrl(u), u).toBeNull();
      expect(toLoadableImageSrc(u), u).toBe(u);
    }
    expect(render("![x](https://example.com/api/a.png)")).toContain("https://example.com/api/a.png");
  });
});
