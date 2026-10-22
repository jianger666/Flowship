/**
 * Q7b-01：引用定义行逐字到达时，`[文档][1]` 不能先指向被截断的 URL。
 *
 * R8-01 让「有引用定义的文本整篇一个块」，副作用是 `[1]: https://e`（定义行刚写了几个字）一出现，
 * remark 立刻把 `https://e` 当目的地——每一帧 href 依次是 https://e/、https://ex/ …（报告里整篇 29 个不同 href）。
 * 性质：对文档的**每个字符前缀**（流式帧）渲染，出现的所有 `<a href>` 要么没有、要么是文档里某个完整定义的目标，
 * 绝不出现被截断的 URL；写完 / 定稿后链接照常生效（第三轮 streamdown-reference-links 同时仍通过）。
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Streamdown, defaultRehypePlugins, defaultRemarkPlugins } from "streamdown";
import { describe, expect, it } from "vitest";

import {
  STREAMDOWN_REMEND_OPTIONS,
  parseMarkdownIntoBlocksKeepReferences,
  parseMarkdownIntoBlocksKeepReferencesStreaming,
  resolveStreamdownMode,
  stripTrailingDefinitionLine,
} from "@/lib/streamdown-options";

const REHYPE = [defaultRehypePlugins.raw, defaultRehypePlugins.sanitize, defaultRehypePlugins.harden];
const REMARK = [...Object.values(defaultRemarkPlugins)];
// 把链接画成朴素 <a href>，静态 HTML 里才看得见目标地址
const components = {
  a: ({ href, children }: { href?: string; children?: unknown }) =>
    createElement("a", { href }, children as never),
};

const render = (text: string, streaming: boolean, fnStreaming: boolean): string => {
  const m = resolveStreamdownMode(streaming, true);
  return renderToStaticMarkup(
    createElement(
      Streamdown,
      {
        mode: m.mode,
        isAnimating: streaming,
        parseIncompleteMarkdown: m.parseIncompleteMarkdown,
        remend: STREAMDOWN_REMEND_OPTIONS,
        parseMarkdownIntoBlocksFn: fnStreaming
          ? parseMarkdownIntoBlocksKeepReferencesStreaming
          : parseMarkdownIntoBlocksKeepReferences,
        rehypePlugins: REHYPE,
        remarkPlugins: REMARK,
        components,
      } as never,
      text,
    ),
  );
};
const hrefs = (html: string): string[] => [...html.matchAll(/<a href="([^"]*)"/g)].map((m) => m[1]!);

const DOCS = [
  "见 [文档][1] 与 [另一个][ref]\n\n[1]: https://example.com/docs/start\n[ref]: https://example.org/x/y \"标题\"",
  "先说结论 [文档][1]。\n\n[1]: https://example.com/docs/start",
  "见 [文档][1]。\n\n[1]: https://example.com/docs/start\n\n后面还有一段正文。",
  "正文 [甲][a] 中间 [乙][b] 结尾\n\n[a]: https://a.example.com/path/one\n\n中间一段\n\n[b]: https://b.example.com/path/two?x=1&y=2",
  "图 ![图][i] 与 [链][l]\n\n[i]: https://img.example.com/a/b.png\n[l]: https://l.example.com/with-path/deep",
];

describe("Q7b-01：每个流式前缀里，引用目标要么未解析、要么是完整定义", () => {
  for (const [i, doc] of DOCS.entries()) {
    const allowed = new Set(hrefs(render(doc, false, false)));
    // 图片引用式在 <img src> 里，a 的 href 集合可以为空（文档 5 的链接是 l）
    it(`文档 ${i + 1}（${doc.length} 个前缀）：流式裁剪版绝不出现截断 URL`, () => {
      expect(allowed.size).toBeGreaterThan(0);
      const bad: string[] = [];
      for (let n = 1; n <= doc.length; n++) {
        for (const h of hrefs(render(doc.slice(0, n), true, true))) {
          if (!allowed.has(h)) bad.push(`${n}:${h}`);
        }
      }
      expect(bad).toEqual([]);
    });

    it(`文档 ${i + 1}（对照）：不裁剪的版本确实会出现截断 URL（证明这条性质测试有牙）`, () => {
      const bad: string[] = [];
      for (let n = 1; n <= doc.length; n++) {
        for (const h of hrefs(render(doc.slice(0, n), true, false))) {
          if (!allowed.has(h)) bad.push(`${n}:${h}`);
        }
      }
      // 每篇文档里「引用在前、定义行后到」，定义行逐字到达的那些帧必然出现截断 URL
      expect(bad.length).toBeGreaterThan(0);
    });

    it(`文档 ${i + 1}：定稿（不裁）后链接齐全，与 static 一致`, () => {
      expect(new Set(hrefs(render(doc, false, false)))).toEqual(allowed);
      expect(hrefs(render(doc, false, false)).length).toBeGreaterThan(0);
    });
  }

  it("定义行写完（换行收尾）后，流式中链接立刻生效", () => {
    const html = render("见 [文档][1]\n\n[1]: https://example.com/docs/start\n", true, true);
    expect(hrefs(html)).toEqual(["https://example.com/docs/start"]);
    const mid = render("见 [文档][1]\n\n[1]: https://example.com/docs/st", true, true);
    expect(hrefs(mid)).toEqual([]);
    expect(mid).toContain("[文档][1]");
  });

  it("多条定义：前面已写完的定义流式中就生效，只有末行正在写的那条暂缓", () => {
    const html = render(
      "[甲][a] [乙][b]\n\n[a]: https://a.example.com/one\n[b]: https://b.exa",
      true,
      true,
    );
    expect(hrefs(html)).toEqual(["https://a.example.com/one"]);
  });
});

describe("stripTrailingDefinitionLine（纯函数）", () => {
  it("裁掉末行的半截 / 完整但未换行的定义；有换行收尾 / 非定义行 / 脚注 / 缩进过深都不动", () => {
    expect(stripTrailingDefinitionLine("正文\n\n[1]: https://e")).toBe("正文\n\n");
    expect(stripTrailingDefinitionLine("[1]: h")).toBe("");
    expect(stripTrailingDefinitionLine("正文\n[1]:")).toBe("正文\n");
    expect(stripTrailingDefinitionLine("正文\n  [ref]: https://a.example.com \"标题")).toBe("正文\n  [ref]: https://a.example.com \"标题");
    expect(stripTrailingDefinitionLine("正文\n[1]: https://e\n")).toBe("正文\n[1]: https://e\n");
    expect(stripTrailingDefinitionLine("正文 [1]: 不是行首")).toBe("正文 [1]: 不是行首");
    expect(stripTrailingDefinitionLine("正文\n[^1]: 脚注")).toBe("正文\n[^1]: 脚注");
    expect(stripTrailingDefinitionLine("正文\n    [1]: https://e")).toBe("正文\n    [1]: https://e");
    expect(stripTrailingDefinitionLine("")).toBe("");
  });

  it("没有引用定义的文本：流式版与定稿版的分块结果完全一致（性能与行为不变）", () => {
    for (const t of ["", "普通段落", "# 标题\n\n段落\n\n```js\nconst a = 1;\n```\n", "- a\n- b\n\n[链接](https://example.com)"]) {
      expect(parseMarkdownIntoBlocksKeepReferencesStreaming(t)).toEqual(parseMarkdownIntoBlocksKeepReferences(t));
    }
  });
});
