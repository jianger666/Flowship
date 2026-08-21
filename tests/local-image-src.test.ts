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
});

describe("toLoadableImageSrc", () => {
  it("本地绝对路径转 /api/local-image", () => {
    expect(toLoadableImageSrc(QR_PATH)).toBe(
      `/api/local-image?path=${encodeURIComponent(QR_PATH)}`,
    );
  });
});
