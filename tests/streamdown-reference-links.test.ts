/**
 * R8-01：「恒 streaming 模式」后，流式过的消息定稿时引用式链接 `[文档][1]` 永久失效。
 *
 * 根因：Streamdown 的 streaming 分支用 `parseMarkdownIntoBlocks` 把全文按块拆开、**逐块**用 remark 解析，
 * 引用定义 `[1]: https://…` 在另一个块里，块与块之间不共享定义 → 定稿后屏幕上是字面量 `[文档][1]`，
 * 定义行也被吃掉；同一条消息刷新页面（或被虚拟列表卸载再挂回来，走 static）又是正常链接。
 * 旧版定稿切 static 会「自愈」，这是「定稿不换 mode」引入的回归。
 *
 * 修法：给 Streamdown 传 `parseMarkdownIntoBlocksFn`——文本里有引用定义就整篇当一个块（与上游对脚注的处理同构），
 * 否则照旧走上游逐块解析（性能不变）。
 */
import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  Streamdown,
  defaultRehypePlugins,
  defaultRemarkPlugins,
} from "streamdown";
import { describe, expect, it } from "vitest";

import {
  STREAMDOWN_REMEND_OPTIONS,
  parseMarkdownIntoBlocksKeepReferences,
  resolveStreamdownMode,
} from "@/lib/streamdown-options";

const REPO = path.resolve(import.meta.dirname, "..");
const read = (rel: string): string => fs.readFileSync(path.join(REPO, rel), "utf-8");

const REHYPE = [
  defaultRehypePlugins.raw,
  defaultRehypePlugins.sanitize,
  defaultRehypePlugins.harden,
];
const REMARK = [...Object.values(defaultRemarkPlugins)];
const CONTROLS = { code: { copy: true, download: false }, table: false };

const render = (text: string, props: Record<string, unknown> = {}): string =>
  renderToStaticMarkup(
    createElement(
      Streamdown,
      { rehypePlugins: REHYPE, remarkPlugins: REMARK, controls: CONTROLS, ...props } as never,
      text,
    ),
  );
const norm = (html: string): string => html.replace(/>\s+</g, "><");

/** MarkdownText 在「流式过 → 定稿」那一刻传给 Streamdown 的 props（与 markdown-text.tsx 同源） */
const finalizedProps = (withParser: boolean): Record<string, unknown> => {
  const m = resolveStreamdownMode(false, true);
  return {
    mode: m.mode,
    isAnimating: false,
    parseIncompleteMarkdown: m.parseIncompleteMarkdown,
    remend: STREAMDOWN_REMEND_OPTIONS,
    ...(withParser ? { parseMarkdownIntoBlocksFn: parseMarkdownIntoBlocksKeepReferences } : {}),
  };
};
const streamingProps = (withParser: boolean): Record<string, unknown> => {
  const m = resolveStreamdownMode(true, true);
  return {
    mode: m.mode,
    isAnimating: true,
    parseIncompleteMarkdown: m.parseIncompleteMarkdown,
    remend: STREAMDOWN_REMEND_OPTIONS,
    ...(withParser ? { parseMarkdownIntoBlocksFn: parseMarkdownIntoBlocksKeepReferences } : {}),
  };
};

const LINK_BUTTON = (text: string): RegExp =>
  new RegExp(`<button[^>]*data-streamdown="link"[^>]*>${text}</button>`);

const LINKED = "看 [文档][1] 和 [另一个][ref]\n\n[1]: https://example.com\n[ref]: https://example.org/x \"标题\"\n";

describe("R8-01 引用式链接：流式过 → 定稿", () => {
  it("【根因】不带块解析函数：定稿后是字面量 `[文档][1]`、没有链接（上游按块解析；上游升级改了行为会在这里报警）", () => {
    const html = norm(render(LINKED, finalizedProps(false)));
    expect(html).toContain("[文档][1]");
    expect(html).not.toContain('data-streamdown="link"');
  });

  it("带 parseMarkdownIntoBlocksKeepReferences：定稿后是正常链接，定义行不外露", () => {
    const html = norm(render(LINKED, finalizedProps(true)));
    // 这里没传自定义 components，Streamdown 默认把外链渲染成带确认的 <button data-streamdown="link">（不含 href）
    expect(html).toMatch(LINK_BUTTON("文档"));
    expect(html).toMatch(LINK_BUTTON("另一个"));
    expect(html).not.toContain("[文档][1]");
    expect(html).not.toContain("[1]:");
  });

  it("流式中（定义行还没到 / 到了之后）也一致：定义行到达的那一帧起链接生效", () => {
    // 定义行还没写出来：只能是字面量（没有定义可引用）
    const before = norm(render("看 [文档][1]", streamingProps(true)));
    expect(before).not.toContain('data-streamdown="link"');
    // 定义行到了：整篇一个块，链接生效
    const after = norm(render("看 [文档][1]\n\n[1]: https://example.com", streamingProps(true)));
    expect(after).toMatch(LINK_BUTTON("文档"));
  });

  const DOCS: Record<string, string> = {
    "行内多个引用 + 带标题的定义": LINKED,
    "快捷引用 [Example]（标签大小写不敏感）": "参见 [Example]\n\n[example]: https://example.com\n",
    "折叠引用 [Example][]": "参见 [Example][]\n\n[Example]: https://example.com\n",
    "定义夹在中间、后面还有段落": "看 [a][1]\n\n[1]: https://a.example\n\n后面还有一段 [b][2]\n\n[2]: https://b.example\n",
    "定义的地址写在下一行": "看 [a][1]\n\n[1]:\n    https://a.example\n",
    "代码块里有形似定义的行 + 真实定义": "[文档][1]\n\n```\n[x]: y\n```\n\n[1]: https://example.com\n",
    "引用 + 脚注并存": "链接 [a][1]，脚注[^1]\n\n[1]: https://a.example\n\n[^1]: 脚注内容\n",
    "引用 + 列表 + 表格": "- 项目 [a][1]\n- 项目二\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n[1]: https://a.example\n",
  };

  for (const [name, doc] of Object.entries(DOCS)) {
    it(`${name}：定稿标记 = static 标记`, () => {
      expect(norm(render(doc, finalizedProps(true)))).toBe(norm(render(doc, { mode: "static" })));
    });
  }

  it("引用地址危险（javascript:）：定稿与 static 一样被拦，没有可点的 javascript: 链接", () => {
    const doc = "[点我][evil]\n\n[evil]: javascript:alert(1)\n";
    const fin = norm(render(doc, finalizedProps(true)));
    expect(fin).not.toMatch(/href="javascript:/i);
    expect(fin).toBe(norm(render(doc, { mode: "static" })));
  });

  it("没有引用定义的文档：块解析函数等价于上游（逐块、数量一致），不白白把长文合并成一块", async () => {
    const { parseMarkdownIntoBlocks } = await import("streamdown");
    const docs = [
      "# 标题\n\n段落一\n\n段落二\n\n- 列表\n- 列表二\n",
      "前言\n\n```js\nconst a = 1;\n```\n\n后记\n",
      "| a | b |\n|---|---|\n| 1 | 2 |\n",
      "没有任何定义，只有 [普通](https://x.example) 链接和 [括号] 文字：冒号后面有字\n\n另一段\n",
      "- [ ] 任务 [x]: 不是定义\n",
      "",
    ];
    for (const d of docs) {
      expect(parseMarkdownIntoBlocksKeepReferences(d), JSON.stringify(d)).toEqual(
        parseMarkdownIntoBlocks(d),
      );
    }
    expect(parseMarkdownIntoBlocksKeepReferences("段一\n\n段二\n\n段三").length).toBeGreaterThan(1);
  });

  it("有引用定义：整篇一个块（含缩进 ≤3 的定义、定义在文末无换行）", () => {
    for (const d of [
      "a [1]\n\n[1]: https://x.example",
      "a [1]\n\n   [1]: https://x.example\n",
      "a [1]\n\n[Foo Bar]: <https://x.example> 'T'\n",
    ]) {
      expect(parseMarkdownIntoBlocksKeepReferences(d), JSON.stringify(d)).toEqual([d]);
    }
    // 4 空格缩进是代码块、不是定义；脚注定义由上游自己整篇处理
    expect(parseMarkdownIntoBlocksKeepReferences("段一\n\n    [1]: https://x.example\n\n段三").length).toBeGreaterThan(1);
  });

  it("接线：MarkdownText 把它传给 Streamdown，且修正了「输出与 static 等价」的错误注释", () => {
    const src = read("src/components/markdown-text.tsx");
    // Q7b-01：流式中用「裁掉末行未写完定义」的版本、定稿用不裁的版本（行为见 streamdown-reference-stream-prefix.test.ts）
    expect(src).toMatch(
      /parseMarkdownIntoBlocksFn=\{\s*streaming\s*\?\s*parseMarkdownIntoBlocksKeepReferencesStreaming\s*:\s*parseMarkdownIntoBlocksKeepReferences\s*\}/,
    );
    expect(src).toMatch(/parseMarkdownIntoBlocksKeepReferences,?\s*\n?[^]*from "@\/lib\/streamdown-options"/);
    // 旧注释把「多留在 streaming 模式」说成「输出与 static 等价」——引用式链接就不等价（R8-01）
    expect(src).not.toContain("输出与 static 等价");
    const opts = read("src/lib/streamdown-options.ts");
    expect(opts).toMatch(/引用式链接|引用定义/);
  });
});
