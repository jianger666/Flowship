/**
 * 本地 markdown 图：mac 数据目录路径带空格时 CommonMark 会截断 destination。
 * wrap 成 `<>` 后再 parse，img.url 才是完整绝对路径。
 */
import { describe, expect, it } from "vitest";
import { unified } from "unified";
import remarkParse from "remark-parse";

import {
  toLoadableImageSrc,
  wrapLocalMarkdownImageDestinations,
} from "@/lib/local-image-src";

interface MdNode {
  type?: string;
  url?: string;
  children?: MdNode[];
}

const collectImageUrls = (md: string): string[] => {
  const tree = unified().use(remarkParse).parse(md) as MdNode;
  const urls: string[] = [];
  const walk = (n: MdNode) => {
    if (n.type === "image" && n.url) urls.push(n.url);
    for (const c of n.children ?? []) walk(c);
  };
  walk(tree);
  return urls;
};

const QR_PATH =
  "/Users/chenlujiang/Library/Application Support/fe-ai-flow/data/tasks/t_1/workspace/lark-sheets-auth-qrcode.png";
const QR_MD = `![Sheet 读取权限授权二维码](${QR_PATH})`;

describe("wrapLocalMarkdownImageDestinations", () => {
  it("裸 parse 不成 image（整段当文本，事件流里看到原文）", () => {
    expect(collectImageUrls(QR_MD)).toEqual([]);
  });

  it("包 <> 后 parse 出完整本地路径", () => {
    const wrapped = wrapLocalMarkdownImageDestinations(QR_MD);
    expect(wrapped).toBe(`![Sheet 读取权限授权二维码](<${QR_PATH}>)`);
    expect(collectImageUrls(wrapped)[0]).toBe(QR_PATH);
  });

  it("已包 <> / 无空格 / 非本地图 不动", () => {
    expect(wrapLocalMarkdownImageDestinations(`![a](<${QR_PATH}>)`)).toBe(
      `![a](<${QR_PATH}>)`,
    );
    expect(wrapLocalMarkdownImageDestinations("![a](/tmp/qr.png)")).toBe(
      "![a](/tmp/qr.png)",
    );
    expect(
      wrapLocalMarkdownImageDestinations("![a](https://example.com/a b.png)"),
    ).toBe("![a](https://example.com/a b.png)");
  });

  it("alt 含转义 `\\]` / 多个转义对仍能匹配并改写", () => {
    const md = `![a\\]b \\\\ c](${QR_PATH})`;
    expect(wrapLocalMarkdownImageDestinations(md)).toBe(
      `![a\\]b \\\\ c](<${QR_PATH}>)`,
    );
  });
});

// ReDoS：旧正则 `((?:\\.|[^\]])*)` 两个分支在反斜杠上重叠，`![` + N 个 `\` 回溯指数增长
// （N=42 约 0.8s、N≈60 约一小时，渲染线程卡死且重开仍冻）。新正则任何输入都应在毫秒级返回。
describe("wrapLocalMarkdownImageDestinations 不得 ReDoS", () => {
  const timed = (md: string): number => {
    const t0 = performance.now();
    wrapLocalMarkdownImageDestinations(md);
    return performance.now() - t0;
  };

  it("`![` + 大量反斜杠（旧正则指数爆炸的输入）", () => {
    expect(timed("![" + "\\".repeat(60))).toBeLessThan(200);
    expect(timed("![" + "\\".repeat(5000))).toBeLessThan(500);
  });

  it("反斜杠后接 `]` 但缺 `(`、无结尾 `)` 的变体", () => {
    expect(timed("![" + "\\".repeat(60) + "]")).toBeLessThan(200);
    expect(timed("![" + "\\]".repeat(60) + "(")).toBeLessThan(200);
    expect(timed("![a](" + "x".repeat(100_000))).toBeLessThan(500);
  });

  it("大量未闭合的 `![a](`（二次方风险）", () => {
    expect(timed("![a](".repeat(20_000))).toBeLessThan(2000);
  });

  it("没有 `![` 的文本直接原样返回（快速路径，同一个字符串）", () => {
    const md = "普通文本 [link](/Users/x/a b.png) ".repeat(50_000);
    expect(wrapLocalMarkdownImageDestinations(md)).toBe(md);
    expect(timed(md)).toBeLessThan(50);
  });

  it("超大文本（>20 万字符）不改写：带空格的本地图片路径保持原样，且不会拖住主线程", () => {
    const big = `![a](${QR_PATH}) ` + "![a](".repeat(60_000);
    expect(big.length).toBeGreaterThan(200_000);
    expect(wrapLocalMarkdownImageDestinations(big)).toBe(big);
    expect(timed(big)).toBeLessThan(50);
    // 对照：同样的图在正常大小的文本里照常改写
    expect(wrapLocalMarkdownImageDestinations(`![a](${QR_PATH})`)).toBe(`![a](<${QR_PATH}>)`);
  });

  it("超长 alt（>1000）/ 超长 dest（>2048）不再改写、原样返回", () => {
    const longAlt = `![${"x".repeat(1500)}](${QR_PATH})`;
    expect(wrapLocalMarkdownImageDestinations(longAlt)).toBe(longAlt);
    const longDest = `![a](/${"d d/".repeat(2000)}qr.png)`;
    expect(wrapLocalMarkdownImageDestinations(longDest)).toBe(longDest);
  });
});

describe("toLoadableImageSrc", () => {
  it("本地绝对路径转 /api/local-image", () => {
    expect(toLoadableImageSrc(QR_PATH)).toBe(
      `/api/local-image?path=${encodeURIComponent(QR_PATH)}`,
    );
  });
});
