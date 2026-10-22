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
import { isUncLikePath } from "@/lib/unc-path";

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

// ───────── UNC / 网络共享引用：渲染前拦下（Q4-06） ─────────

/** 图片被拦下时的中文占位（文本节点；后面的 sanitize 不会再动它） */
export const UNC_IMAGE_PLACEHOLDER = "[图片：网络路径不支持预览]";
/** 链接被拦下时附在链接文字后面的说明 */
export const UNC_LINK_PLACEHOLDER = "（网络路径不支持打开）";

const safeDecode = (s: string): string => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/**
 * hast 上的 href / src 是不是「网络共享」形态。**必须在 harden 之前判**：Streamdown / harden 会把
 * `//attacker.example/x/a.png` 改成 `/x/a.png`（host 被吞），之后任何 `isUncLikePath(href)` 都看不到 UNC。
 *
 * 在 {@link isUncLikePath}（`//h/s`、`\\h\s`、`file:////h/s`、`file://h/s`）之外补三类 markdown 解析后的变形：
 * - 百分号编码：`%2F%2Fhost`、markdown 把 `\\host\share` 的 `\\` 折成 `\` 再由 normalizeUri 编码成 `%5Chost%5Cshare`；
 * - 以单个反斜杠起头（`\host\share`）：站内 / 本机引用不可能这样写；
 * - 浏览器 URL 解析会忽略的控制字符 / 空白穿插（`/\t/host`）。
 */
export const isUncLikeReference = (ref: unknown): boolean => {
  if (typeof ref !== "string" || ref.length === 0) return false;
  if (isUncLikePath(ref)) return true;
  const decoded = safeDecode(ref);
  const squeezed = decoded.replace(/[\u0000-\u0020]/g, "");
  return isUncLikePath(decoded) || isUncLikePath(squeezed) || /^\\/.test(squeezed);
};

const textNode = (value: string): HastNode & { value: string } => ({ type: "text", value });

const blockUncWalk = (node: HastNode): void => {
  if (!Array.isArray(node.children)) return;
  node.children = node.children.map((child) => {
    if (child.type === "element" && child.properties) {
      if (child.tagName === "img" && isUncLikeReference(child.properties.src)) {
        return textNode(UNC_IMAGE_PLACEHOLDER);
      }
      if (child.tagName === "a" && isUncLikeReference(child.properties.href)) {
        const span: HastNode = {
          type: "element",
          tagName: "span",
          properties: {},
          children: [...(child.children ?? []), textNode(UNC_LINK_PLACEHOLDER)],
        };
        blockUncWalk(span);
        return span;
      }
    }
    blockUncWalk(child);
    return child;
  });
};

/**
 * rehype：UNC / 网络共享形态的图片与链接，在 sanitize / harden **之前**换成中文占位（Q4-06）。
 * 图片 → 文本 `[图片：网络路径不支持预览]`；链接 → 去掉链接、保留链接文字并附「（网络路径不支持打开）」。
 * 之前只在 `MarkdownImage` / `MarkdownLink` 组件层判，真实管线里它们收到的已经是被改写过的 `/x/a.png`，永远不触发。
 */
export const rehypeBlockUncReferences: Plugin = () => {
  return (tree: unknown) => {
    blockUncWalk(tree as HastNode);
  };
};
