/**
 * rehype：本地绝对路径 / file:// 图片 src 在 sanitize 前改写到 /api/local-image
 *
 * Streamdown 默认 rehype 链含 rehype-sanitize——`file://` 协议不在 src 白名单、
 * 会把 img.src 整段剥掉；组件层 MarkdownImage 再也拿不到路径。必须插在 sanitize
 * 之前跑。`/Users/...` 这类 path-absolute 虽能过 sanitize，一并改写可让
 * Streamdown 内置 img 与 MarkdownImage 都直接吃可加载 URL。
 */

import type { Plugin } from "unified";

import { toLoadableImageSrc } from "@/lib/local-image-src";

type HastNode = {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};

const walk = (node: HastNode): void => {
  if (node.type === "element" && node.tagName === "img" && node.properties) {
    const src = node.properties.src;
    if (typeof src === "string" && src.length > 0) {
      node.properties.src = toLoadableImageSrc(src);
    }
  }
  if (Array.isArray(node.children)) {
    for (const child of node.children) walk(child);
  }
};

export const rehypeRewriteLocalImages: Plugin = () => {
  return (tree: unknown) => {
    walk(tree as HastNode);
  };
};
