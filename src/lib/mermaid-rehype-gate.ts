/**
 * rehype：含外部资源引用的 ```mermaid 代码块**不交给 mermaid 渲染**，退回「显示源码 + 一行提示」。
 *
 * 为什么放在 rehype 层：Streamdown 的 mermaid 块一旦挂载就会 `getMermaid().render(源码)`，而 mermaid 对标签里的 `<img>` /
 * classDef 里的 `url()` 不拦（见 lib/mermaid-source-gate 的头注释）；SVG 进 DOM 的瞬间浏览器就发请求。
 * 在 AST 上把 `language-mermaid` 改成 `language-text`，Streamdown 就按普通代码块渲染（带复制按钮、源码可读），
 * mermaid 压根不会被调用——用户看得见原因，也不会看到「过期的半截图」。
 *
 * 三处 Streamdown 入口（对话 MarkdownText / 产物栏 / 修订视图）共用同一张 rehype 表，放进表里就自动继承；
 * 插件层的 `createGatedMermaidPlugin` 是不依赖本插件的第二道闸（见同一个头注释）。
 *
 * 流式：Streamdown 按块把**当前已收到的文本**交给这条链，半截源码同样先过预扫；命中后随文本增长一直保持命中
 * （危险片段不会因为后面又多写了字而消失），不会出现「先渲染成图、后来才发现」的反复。
 *
 * 位置：sanitize 之后（`language-*` class 已经过 sanitize 校验）、harden 之前。
 */

import type { Plugin } from "unified";

import { mermaidBlockedNotice, scanMermaidSource } from "@/lib/mermaid-source-gate";

type HastNode = {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};

const MERMAID_CLASS_RE = /^language-mermaid$/i;
/** 退回成普通代码块用的语言：Shiki 的纯文本，不触发任何图表渲染器 */
const FALLBACK_CLASS = "language-text";

const isElement = (n: HastNode | undefined, tag: string): n is HastNode =>
  !!n && n.type === "element" && n.tagName?.toLowerCase() === tag;

const classList = (n: HastNode): string[] => {
  const c = n.properties?.className;
  if (Array.isArray(c)) return c.map(String);
  if (typeof c === "string") return c.split(/\s+/).filter(Boolean);
  return [];
};

const textOf = (n: HastNode): string => {
  if (n.type === "text") return n.value ?? "";
  return (n.children ?? []).map(textOf).join("");
};

/** `pre` 里所有的 code 元素（递归找后代，但不进入 code 内部；`pre > span > code` 这种被包一层的也算） */
const codesOf = (pre: HastNode): HastNode[] => {
  const out: HastNode[] = [];
  const visit = (n: HastNode): void => {
    for (const c of n.children ?? []) {
      if (isElement(c, "code")) out.push(c);
      else visit(c);
    }
  };
  visit(pre);
  return out;
};

/**
 * `<pre>` 里带 `language-mermaid` 的所有 code（R8-7：原先只看第一个 code，第一个不是 mermaid、第二个才是时整块漏扫）。
 * 不是 mermaid 围栏返回空数组。上游 Streamdown 具体取 pre 里的哪个 code 渲染不去猜——有任何一个 mermaid code 就当它是 mermaid 块处理。
 */
const mermaidCodesOf = (pre: HastNode): HastNode[] =>
  codesOf(pre).filter((code) => classList(code).some((c) => MERMAID_CLASS_RE.test(c)));

/**
 * 提示 `<p>`：
 *  - `dataMermaidGated`：SSR / 测试用来识别；
 *  - `dataPaneSearchIgnore`：栏内搜索（lib/dom-text-search 的 `[data-pane-search-ignore]`）不计这行文字。模型侧
 *    （lib/markdown-visible-search 按 mdast 数命中）里根本没有这行提示，DOM 侧多出来的文字会让「第 k 个命中对第 k 个 Range」整体错位（D3-02）。
 *    位置在 sanitize 之后、harden 之前：hast 属性 `dataPaneSearchIgnore` 渲染为 `data-pane-search-ignore`，harden 只处理链接 / 图片，不动 `<p>` 的属性。
 */
const makeNotice = (text: string): HastNode => ({
  type: "element",
  tagName: "p",
  properties: {
    className: ["text-muted-foreground", "text-xs"],
    dataMermaidGated: "true",
    dataPaneSearchIgnore: "true",
  },
  children: [{ type: "text", value: `⚠ ${text}` }],
});

const walk = (node: HastNode): void => {
  const kids = node.children;
  if (!Array.isArray(kids)) return;
  const next: HastNode[] = [];
  for (const child of kids) {
    if (isElement(child, "pre")) {
      const mermaidCodes = mermaidCodesOf(child);
      if (mermaidCodes.length > 0) {
        // 扫整个 pre 的文本（含非 mermaid 的兄弟 code）：上游取哪个 code 渲染不确定，宁可多扫
        const verdict = scanMermaidSource(textOf(child));
        if (verdict.blocked) {
          for (const code of mermaidCodes) {
            code.properties = {
              ...code.properties,
              className: [...classList(code).filter((c) => !MERMAID_CLASS_RE.test(c)), FALLBACK_CLASS],
            };
          }
          next.push(makeNotice(mermaidBlockedNotice(verdict.reasons)), child);
          continue;
        }
      }
    }
    walk(child);
    next.push(child);
  }
  node.children = next;
};

export const rehypeGateMermaidBlocks: Plugin = () => {
  return (tree: unknown) => {
    walk(tree as HastNode);
  };
};
