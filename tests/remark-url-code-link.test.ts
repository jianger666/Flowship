/**
 * R11-01：内容恰好是一个 http(s) 网址的围栏代码块 / 行内代码 → 渲染成可点链接。
 *
 * 三层：
 * 1. 插件纯函数（unified + remark-parse + gfm，带原文 file）：正例 / 反例 / 没有原文时 fail closed；
 * 2. 真 Streamdown 服务端渲染（生产同款：remend 配置 + rehype 链 + 同序的 remark 链）：
 *    定稿后围栏 / 行内代码都变成可点链接、没有代码块外壳；**对文档的每一个字符前缀（流式帧）渲染，
 *    出现的所有 `<a href>` 只能是完整网址，绝不出现真前缀**（Q7b-01 同款性质）；
 * 3. 注册契约：四处 remark 链（对话正文 / 产物栏 / 修订视图 / 搜索可见文本）都挂了，且排在 remarkTrimAutolinkCjk 之后。
 */
import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { Streamdown, defaultRemarkPlugins } from "streamdown";
import { unified } from "unified";
import { describe, expect, it } from "vitest";

import { collectMarkdownVisibleTextSegments, markdownToMdast } from "@/lib/markdown-visible-search";
import { remarkCodeReference } from "@/lib/remark-code-reference";
import { remarkKeepTrailingUnderscore } from "@/lib/remark-keep-trailing-underscore";
import { remarkTrimAutolinkCjk } from "@/lib/remark-trim-autolink-cjk";
import { URL_ONLY_RE, remarkUrlCodeLink, stripTrailingUnclosedUrlCode } from "@/lib/remark-url-code-link";
import { createRevisionRemarkPlugins } from "@/lib/revision-render-chain";
import {
  STREAMDOWN_REHYPE_PLUGINS,
  STREAMDOWN_REMEND_OPTIONS,
  parseMarkdownIntoBlocksKeepReferencesStreaming,
  resolveStreamdownMode,
} from "@/lib/streamdown-options";

const REPO = path.resolve(import.meta.dirname, "..");
const read = (rel: string): string => fs.readFileSync(path.join(REPO, rel), "utf-8");

// ---------------------------------------------------------------------------
// 1. 插件纯函数
// ---------------------------------------------------------------------------

interface Node {
  type: string;
  url?: string;
  value?: string;
  lang?: string | null;
  children?: Node[];
}

/** 跑 parse → gfm → 插件；`withSource=false` 模拟调用方没传原文（runSync 不带 file） */
const run = (md: string, withSource = true): Node => {
  const processor = unified().use(remarkParse).use(remarkGfm).use(remarkUrlCodeLink);
  const tree = processor.parse(md);
  return (withSource ? processor.runSync(tree, md) : processor.runSync(tree)) as unknown as Node;
};
const collect = (node: Node, type: string, acc: Node[] = []): Node[] => {
  if (node.type === type) acc.push(node);
  node.children?.forEach((c) => collect(c, type, acc));
  return acc;
};
const links = (md: string, withSource = true): Node[] => collect(run(md, withSource), "link");
const URL1 = "https://pay.example.com/checkout?token=abc%3A123&redirect=https%3A%2F%2Fa.example.com%2Fdone";

describe("remarkUrlCodeLink：正例（单个 http(s) 网址）", () => {
  it("围栏块（无语言）→ 一个链接，链接文字 = 网址本身，代码块没了、换成只含链接的段落", () => {
    const tree = run(`支付链接：\n\n\`\`\`\n${URL1}\n\`\`\`\n\n请尽快完成。`);
    expect(collect(tree, "code")).toHaveLength(0);
    const ls = collect(tree, "link");
    expect(ls).toHaveLength(1);
    expect(ls[0]).toMatchObject({ url: URL1, title: null });
    expect(ls[0]!.children).toEqual([{ type: "text", value: URL1 }]);
    // 块数不变：段落 + 链接段落 + 段落
    expect(tree.children!.map((c) => c.type)).toEqual(["paragraph", "paragraph", "paragraph"]);
    expect(tree.children![1]!.children).toHaveLength(1);
  });

  it.each(["text", "txt", "plain", "plaintext", "url", "TEXT"])("围栏语言 %s 也算纯文本", (lang) => {
    expect(links(`\`\`\`${lang}\n${URL1}\n\`\`\``).map((l) => l.url)).toEqual([URL1]);
  });

  it("波浪线围栏、四反引号围栏、首尾有空行 / 空白，都照换（值取去首尾空白后的网址）", () => {
    expect(links(`~~~\n${URL1}\n~~~`).map((l) => l.url)).toEqual([URL1]);
    expect(links(`\`\`\`\`\n${URL1}\n\`\`\`\``).map((l) => l.url)).toEqual([URL1]);
    expect(links(`\`\`\`\n\n  ${URL1}  \n\n\`\`\``).map((l) => l.url)).toEqual([URL1]);
  });

  it("行内代码 → 链接（原位替换，周围文字不动）", () => {
    const tree = run(`请打开 \`${URL1}\` 完成支付。`);
    expect(collect(tree, "inlineCode")).toHaveLength(0);
    const p = tree.children![0]!;
    expect(p.children!.map((c) => c.type)).toEqual(["text", "link", "text"]);
    expect(p.children![1]).toMatchObject({ url: URL1 });
    expect(p.children![0]!.value).toBe("请打开 ");
    expect(p.children![2]!.value).toBe(" 完成支付。");
  });

  it("嵌在列表 / 引用里的围栏（闭合行带前缀）也认", () => {
    expect(links(`- 支付：\n\n  \`\`\`\n  ${URL1}\n  \`\`\`\n`).map((l) => l.url)).toEqual([URL1]);
    expect(links(`> \`\`\`\n> ${URL1}\n> \`\`\`\n`).map((l) => l.url)).toEqual([URL1]);
  });

  it("带 CJK 的网址整块保留（不被 remarkTrimAutolinkCjk 切——本插件排在它之后）", () => {
    const cjkUrl = "https://zh.wikipedia.org/wiki/中文";
    expect(links(`\`${cjkUrl}\``).map((l) => l.url)).toEqual([cjkUrl]);
  });

  it("现有行为不变：[文字](网址) 与裸网址原样（本插件不碰已有的 link）", () => {
    const tree = run(`[点这里](${URL1}) 和 https://example.com/x`);
    const ls = collect(tree, "link");
    expect(ls.map((l) => l.url)).toEqual([URL1, "https://example.com/x"]);
    expect(ls[0]!.children![0]!.value).toBe("点这里");
  });
});

describe("remarkUrlCodeLink：反例（一个都不能换）", () => {
  const NO: Array<[string, string]> = [
    ["多行（两个网址）", `\`\`\`\n${URL1}\nhttps://b.example.com\n\`\`\``],
    ["网址 + 别的文字", `\`\`\`\n${URL1}\n这是支付链接\n\`\`\``],
    ["夹带命令（curl https://…）", "```\ncurl https://example.com/a\n```"],
    ["行内夹带命令", "`curl https://example.com/a`"],
    ["bash 围栏", `\`\`\`bash\n${URL1}\n\`\`\``],
    ["js 围栏", `\`\`\`js\n${URL1}\n\`\`\``],
    ["json 围栏", `\`\`\`json\n${URL1}\n\`\`\``],
    ["围栏带 meta（text title=x）", `\`\`\`text title=x\n${URL1}\n\`\`\``],
    ["占位符 {id}（围栏）", "```\nhttps://example.com/users/{id}\n```"],
    ["占位符 {id}（行内）", "`https://example.com/users/{id}`"],
    ["占位符 <id>", "`https://example.com/users/<id>`"],
    ["网址里有空白", "`https://example.com/a b`"],
    ["网址里有双引号", '`https://example.com/a"b`'],
    ["file://", "`file:///etc/passwd`"],
    ["javascript:", "```\njavascript:alert(1)\n```"],
    ["ftp://", "`ftp://example.com/a`"],
    ["相对路径 / 无协议", "`/api/v1/users`"],
    ["只有协议头", "`https://`"],
    ["空围栏", "```\n```"],
    ["全空白围栏", "```\n   \n```"],
    ["缩进式代码块（没有围栏）", `    ${URL1}\n`],
    ["双反引号行内代码", `\`\`${URL1}\`\``],
    ["普通行内代码（不是网址）", "`const a = 1`"],
    ["网址里混入修订视图的私有区哨兵字符", `\`https://example.com/a\uE000b\``],
  ];
  it.each(NO)("%s", (_name, md) => {
    expect(links(md)).toHaveLength(0);
  });

  it("已经在 link 里面的行内代码不动（[`网址`](网址) 不会变成链接套链接）", () => {
    const tree = run(`[\`${URL1}\`](${URL1})`);
    expect(collect(tree, "inlineCode")).toHaveLength(1);
    expect(collect(tree, "link")).toHaveLength(1);
  });

  it("没有原文（调用方没传 file）→ 一律不换（fail closed）", () => {
    expect(links(`\`\`\`\n${URL1}\n\`\`\``, false)).toHaveLength(0);
    expect(links(`\`${URL1}\``, false)).toHaveLength(0);
  });

  it("未闭合的围栏不换（流式中围栏还没写完 = 网址可能还没写完）；闭合后才换", () => {
    expect(links(`\`\`\`\n${URL1}`)).toHaveLength(0);
    expect(links(`\`\`\`\n${URL1}\n`)).toHaveLength(0);
    expect(links(`\`\`\`\n${URL1}\n\`\``)).toHaveLength(0); // 闭合行写到一半
    expect(links(`\`\`\`\n${URL1}\n\`\`\``)).toHaveLength(1);
    // 闭合围栏必须不短于开头围栏
    expect(links(`\`\`\`\`\n${URL1}\n\`\`\``)).toHaveLength(0);
  });
});

describe("URL_ONLY_RE（判定口径）", () => {
  it("只认 http(s) 开头、之后无空白 / <>{} / 引号 / 反引号 / 私有区字符的整串", () => {
    for (const ok of ["http://a.b", "https://a.b/c?d=1&e=%E4%B8%AD#f", "https://[::1]:8080/x", "https://x.com/a,b;c"]) {
      expect(URL_ONLY_RE.test(ok), ok).toBe(true);
    }
    for (const bad of ["", "https://", "ftp://a.b", "xhttps://a.b", "https://a b", "https://a/{x}", "https://a/<x>", "https://a/'x", "https://a/`x", " https://a.b", "https://a.b\n"]) {
      expect(URL_ONLY_RE.test(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("stripTrailingUnclosedUrlCode（流式前置：藏起尾部没写完的 `https://…）", () => {
  it("末尾开着的单反引号 + http(s):// 开头 → 从那个反引号起整段藏掉", () => {
    expect(stripTrailingUnclosedUrlCode("请打开 `https://example.com/a?b=")).toBe("请打开 ");
    expect(stripTrailingUnclosedUrlCode("`https://")).toBe("");
    expect(stripTrailingUnclosedUrlCode("`http://e")).toBe("");
    expect(stripTrailingUnclosedUrlCode("先 `a` 再 `https://example.com")).toBe("先 `a` 再 ");
  });

  it("不动：已闭合 / 不是网址开头 / 围栏里 / 双反引号 / 反引号个数是奇数（这个是闭合反引号）/ 中间有空白", () => {
    for (const keep of [
      "请打开 `https://example.com/a`", // 已闭合
      "请打开 `https://example.com/a` 再 `h", // 尾部 `h 不是网址开头（remend 照常补全成行内代码）
      "`const a = 1", // 不是网址
      "```\n`https://example.com/a", // 围栏里
      "``https://example.com/a", // 双反引号
      "```https://example.com/a", // 围栏开头行（信息串恰好是网址）：不是行内代码，别藏
      "文字\n\n````https://example.com/a",
      "没有反引号 https://example.com/a",
      "`https://example.com/a b",
      "",
    ]) {
      expect(stripTrailingUnclosedUrlCode(keep), JSON.stringify(keep)).toBe(keep);
    }
    // 奇数个：前面有一个没闭合的行内反引号，这个反引号是它的闭合 → 不是「开」，不动
    expect(stripTrailingUnclosedUrlCode("`abc`https://example.com/a")).toBe("`abc`https://example.com/a");
    expect(stripTrailingUnclosedUrlCode("`abc https://example.com/a`https://example.com/b")).toBe(
      "`abc https://example.com/a`https://example.com/b",
    );
  });

  it("围栏闭合之后再出现的 `https://… 仍然要藏（围栏状态要扫对）", () => {
    expect(stripTrailingUnclosedUrlCode("```\ncode `x\n```\n再 `https://example.com/a")).toBe("```\ncode `x\n```\n再 ");
  });
});

// ---------------------------------------------------------------------------
// 2. 真 Streamdown 渲染（生产同款配置）
// ---------------------------------------------------------------------------

// 与 markdown-text.tsx 的 REMARK_PLUGINS 同序（tsx 测试里 import 不了，由第 3 节的源码契约钉住两边一致）
const REMARK = [
  ...Object.values(defaultRemarkPlugins),
  remarkCodeReference,
  remarkKeepTrailingUnderscore,
  remarkTrimAutolinkCjk,
  remarkUrlCodeLink,
];
// 把链接画成朴素 <a href>，静态 HTML 里才看得见目标地址
const components = {
  a: ({ href, children }: { href?: string; children?: unknown }) => createElement("a", { href }, children as never),
};

const render = (text: string, streaming: boolean, remend: unknown = STREAMDOWN_REMEND_OPTIONS): string => {
  const m = resolveStreamdownMode(streaming, true);
  return renderToStaticMarkup(
    createElement(
      Streamdown,
      {
        mode: m.mode,
        isAnimating: streaming,
        parseIncompleteMarkdown: m.parseIncompleteMarkdown,
        remend,
        parseMarkdownIntoBlocksFn: parseMarkdownIntoBlocksKeepReferencesStreaming,
        rehypePlugins: STREAMDOWN_REHYPE_PLUGINS,
        remarkPlugins: REMARK,
        controls: { code: { copy: true, download: false }, table: false },
        components,
      } as never,
      text,
    ),
  );
};
const hrefs = (html: string): string[] => [...html.matchAll(/<a href="([^"]*)"/g)].map((m) => m[1]!.replace(/&amp;/g, "&"));
const hasCodeBlock = (html: string): boolean => html.includes('data-streamdown="code-block"');

const PAY = "https://pay.example.com/checkout?token=abc%3A123&sig=xyz";
const FENCE_DOC = `支付链接：\n\n\`\`\`\n${PAY}\n\`\`\`\n\n请尽快完成。`;
const FENCE_TAIL_DOC = `支付链接：\n\n\`\`\`\n${PAY}\n\`\`\``; // 围栏在文末（流式最危险的位置）
const INLINE_DOC = `请打开 \`${PAY}\` 完成支付。`;
const INLINE_TAIL_DOC = `请打开 \`${PAY}\``; // 行内代码在文末
const TWO_DOC = `甲 \`${PAY}\`\n\n\`\`\`text\nhttps://b.example.com/two\n\`\`\`\n\n乙 \`https://c.example.com/three\``;

describe("真 Streamdown 渲染：定稿后", () => {
  it("围栏块：变成指向完整网址的链接，没有代码块外壳 / 复制按钮", () => {
    // 定稿（isAnimating=false）与「流式中但整篇已写完」两种都要换
    for (const streaming of [false, true]) {
      const html = render(FENCE_DOC, streaming);
      expect(hrefs(html), String(streaming)).toEqual([PAY]);
      expect(hasCodeBlock(html)).toBe(false);
      expect(html).toContain(">" + PAY.replace(/&/g, "&amp;") + "</a>");
      expect(html).not.toContain("<pre");
    }
  });

  it("行内代码：变成链接，文字 = 网址", () => {
    const html = render(INLINE_DOC, false);
    expect(hrefs(html)).toEqual([PAY]);
    expect(html).not.toContain("<code");
  });

  it("反例在真渲染里同样不换：多行 / 其它语言 / 占位符仍是代码块或行内代码", () => {
    const multi = render(`\`\`\`\n${PAY}\nhttps://b.example.com\n\`\`\``, false);
    expect(hrefs(multi)).toEqual([]);
    expect(hasCodeBlock(multi)).toBe(true);
    const bash = render(`\`\`\`bash\n${PAY}\n\`\`\``, false);
    expect(hrefs(bash)).toEqual([]);
    expect(hasCodeBlock(bash)).toBe(true);
    const ph = render("`https://example.com/users/{id}`", false);
    expect(hrefs(ph)).toEqual([]);
    expect(ph).toContain("<code");
  });

  it("普通代码块（非网址）的外壳 / 复制按钮保持原样", () => {
    const html = render("```js\nconst a = 1;\n```", false);
    expect(hasCodeBlock(html)).toBe(true);
  });

  it("同一篇里多处各自处理（一个行内、一个围栏、一个行内）", () => {
    const html = render(TWO_DOC, false);
    expect(hrefs(html)).toEqual([PAY, "https://b.example.com/two", "https://c.example.com/three"]);
    expect(hasCodeBlock(html)).toBe(false);
  });
});

describe("真 Streamdown 渲染：流式每个字符前缀里都不出现网址的真前缀", () => {
  const cases: Array<[string, string, string[]]> = [
    ["围栏 + 后文", FENCE_DOC, [PAY]],
    ["围栏在文末", FENCE_TAIL_DOC, [PAY]],
    ["行内代码 + 后文", INLINE_DOC, [PAY]],
    ["行内代码在文末", INLINE_TAIL_DOC, [PAY]],
    ["多处混合", TWO_DOC, [PAY, "https://b.example.com/two", "https://c.example.com/three"]],
  ];
  for (const [name, doc, finalHrefs] of cases) {
    it(`${name}（${doc.length} 个前缀）：href 只会是完整网址，且写完整篇后全部生效`, () => {
      const allowed = new Set(finalHrefs);
      const bad: string[] = [];
      for (let n = 1; n <= doc.length; n++) {
        for (const h of hrefs(render(doc.slice(0, n), true))) if (!allowed.has(h)) bad.push(`${n}:${h}`);
      }
      expect(bad).toEqual([]);
      // 流式写完整篇（isAnimating 仍为 true）后，闭合了的都已经是链接
      expect(hrefs(render(doc, true))).toEqual(finalHrefs);
      expect(hrefs(render(doc, false))).toEqual(finalHrefs);
    });
  }

  it("对照（性质测试有牙）：行内代码不挂 remend 前置 handler 时，补全会让半截网址变成链接", () => {
    const noHandler = { linkMode: "text-only" as const };
    const bad: string[] = [];
    for (let n = 1; n <= INLINE_TAIL_DOC.length; n++) {
      for (const h of hrefs(render(INLINE_TAIL_DOC.slice(0, n), true, noHandler))) if (h !== PAY) bad.push(`${n}:${h}`);
    }
    expect(bad.length).toBeGreaterThan(0);
  });

  it("写到一半的尾部不会把已经写完的前文弄丢（只藏那一小段）", () => {
    const html = render("请打开 `https://example.com/a?b", true);
    expect(html).toContain("请打开");
    expect(hrefs(html)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. 注册契约
// ---------------------------------------------------------------------------

describe("四处 remark 链都挂了本插件，且排在 remarkTrimAutolinkCjk 之后", () => {
  const afterTrim = (src: string, listName: string): void => {
    const i = src.indexOf(listName);
    expect(i, `${listName} 存在`).toBeGreaterThan(-1);
    const body = src.slice(i, src.indexOf("];", i));
    const a = body.indexOf("remarkTrimAutolinkCjk");
    const b = body.indexOf("remarkUrlCodeLink");
    expect(a, `${listName} 里有 remarkTrimAutolinkCjk`).toBeGreaterThan(-1);
    expect(b, `${listName} 里有 remarkUrlCodeLink`).toBeGreaterThan(a);
  };

  it("对话正文（markdown-text.tsx）/ 产物栏（artifact-panel.tsx）", () => {
    afterTrim(read("src/components/markdown-text.tsx"), "const REMARK_PLUGINS");
    afterTrim(read("src/components/tasks/artifact-panel.tsx"), "const ARTIFACT_REMARK_PLUGINS");
  });

  it("修订视图的渲染链（createRevisionRemarkPlugins）：有、且在 remarkTrimAutolinkCjk 之后", () => {
    const list = createRevisionRemarkPlugins([]) as unknown[];
    expect(list).toContain(remarkUrlCodeLink);
    expect(list.indexOf(remarkUrlCodeLink)).toBeGreaterThan(list.indexOf(remarkTrimAutolinkCjk));
    // 与 sentinels 开关无关
    expect(createRevisionRemarkPlugins([], { sentinels: false }) as unknown[]).toContain(remarkUrlCodeLink);
  });

  it("修订视图 parse 侧（revision-syntax-plugins）刻意不挂：它只 parse、不跑 transformer", () => {
    expect(read("src/lib/revision-syntax-plugins.ts")).not.toContain("remarkUrlCodeLink");
  });

  it("搜索可见文本（markdown-visible-search）：同一条链，模型里围栏 / 行内都按链接文字计，与渲染一致", () => {
    // 插件确实跑在这条链里：闭合的围栏 / 行内代码在模型里已经是 link 节点（没传原文就不会换，见上面的 fail-closed 用例）
    expect(JSON.stringify(markdownToMdast(FENCE_DOC))).toContain('"type":"link"');
    expect(JSON.stringify(markdownToMdast(INLINE_DOC))).toContain('"type":"link"');
    // 围栏换成链接后，可见文本片段 = 网址（与 DOM 里链接的文字一致）；没换的（多行）仍按代码值计
    expect(collectMarkdownVisibleTextSegments(markdownToMdast(FENCE_DOC))).toEqual(["支付链接：", PAY, "请尽快完成。"]);
    expect(collectMarkdownVisibleTextSegments(markdownToMdast(INLINE_DOC))).toEqual(["请打开 ", PAY, " 完成支付。"]);
    expect(collectMarkdownVisibleTextSegments(markdownToMdast(`\`\`\`\n${PAY}\nx\n\`\`\``))).toEqual([`${PAY}\nx`]);
    // 未闭合的围栏（流式中）：渲染侧不换、模型里也不换——两边口径一致（片段文字相同）
    expect(collectMarkdownVisibleTextSegments(markdownToMdast(`\`\`\`\n${PAY}`))).toEqual([PAY]);
    const tree = markdownToMdast(`\`\`\`\n${PAY}`);
    expect(JSON.stringify(tree)).not.toContain('"type":"link"');
  });
});
