/**
 * Streamdown 在 prose / 全局样式里的 CSS 契约（2026-10-20 第二轮 review：V13-07 / V15-04 / V13-01）。
 *
 * ⚠ 弱保护：vitest 没有布局引擎 / 选择器匹配引擎，这里只能断言「关键规则还在、作用域没跑偏」，
 * 并用 renderToStaticMarkup 钉住这些规则所依赖的上游 DOM 前提（锚点属性 / 结构）——
 * 上游升级改了 DOM，前提测试先红，比样式悄悄失效更早发现。
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

const REPO = path.resolve(import.meta.dirname, "..");
const css = fs.readFileSync(path.join(REPO, "src/app/globals.css"), "utf-8");

/** 去掉 CSS 注释（注释里会写「原来的 outline-ring/50」之类的字样，不该参与断言） */
const stripComments = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, "");
const code = stripComments(css);

interface Rule {
  selectors: string[];
  body: string;
}
/** 最内层 `选择器 { 声明 }`（够用：globals.css 里没有嵌套选择器，@layer / @media 只是外壳） */
const rules: Rule[] = [...code.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
  selectors: m[1]!
    .split(",")
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean),
  body: m[2]!.replace(/\s+/g, " ").trim(),
}));
const rulesMatching = (re: RegExp): Rule[] =>
  rules.filter((r) => r.selectors.some((s) => re.test(s)));

const renderMd = (text: string): string =>
  renderToStaticMarkup(
    createElement(
      Streamdown,
      {
        mode: "static",
        rehypePlugins: [
          defaultRehypePlugins.raw,
          defaultRehypePlugins.sanitize,
          defaultRehypePlugins.harden,
        ],
        remarkPlugins: [...Object.values(defaultRemarkPlugins)],
        controls: { table: false },
      } as never,
      text,
    ),
  );

describe("V13-07 焦点环：全局 outline 取色不透明", () => {
  it("globals.css 的全局 `*` 用 outline-ring（不再是 outline-ring/50）", () => {
    const star = rules.find((r) => r.selectors.length === 1 && r.selectors[0] === "*");
    expect(star, "找不到全局 * 规则").toBeDefined();
    expect(star!.body).toMatch(/@apply border-border outline-ring;/);
    // 任何位置都不许再出现带透明度的 outline-ring（半透明叠在页面底上只有 ~1.8:1）
    expect(code).not.toMatch(/outline-ring\/\d+/);
  });
});

describe("V15-04 松散列表项里的多个段落不再被拼成一行", () => {
  const LOOSE = "1. **标题一**\n\n   说明一\n\n2. **标题二**\n\n   说明二\n";

  it("【上游前提】松散列表的 li 带 data-streamdown=list-item 锚点、[&>p]:inline、里面有两个 <p>；紧凑列表没有 <p>", () => {
    const html = renderMd(LOOSE);
    const items = html.match(/<li\b[\s\S]*?<\/li>/g) ?? [];
    expect(items).toHaveLength(2);
    for (const li of items) {
      expect(li).toContain('data-streamdown="list-item"');
      expect(li).toContain("[&amp;&gt;p]:inline"); // 上游写死的 inline：多段落被拼成一行的根因
      expect(li.match(/<p>/g)).toHaveLength(2);
    }
    const tight = renderMd("- 一\n- 二\n");
    expect(tight).toContain('data-streamdown="list-item"');
    expect(tight).not.toContain("<p>");
  });

  it("globals.css：只有 `li > p ~ p`（前面已经有段落的段落）恢复 display:block", () => {
    const hits = rulesMatching(/\[data-streamdown="list-item"\]/);
    expect(hits.length).toBeGreaterThan(0);
    const block = hits.filter((r) => /display: block/.test(r.body));
    expect(block).toHaveLength(1);
    expect(block[0]!.selectors).toEqual([
      '.prose [data-streamdown="list-item"] > p ~ p',
    ]);
  });

  it("第一段保持 inline：不许有规则把 li 的第一个 <p> 也改成块级——list-inside 的序号 / 圆点要跟它同一行，否则序号单独占一行", () => {
    for (const r of rulesMatching(/\[data-streamdown="list-item"\]/)) {
      for (const s of r.selectors) {
        if (/display: block/.test(r.body)) {
          expect(s, "块级只能落在 `p ~ p` 上").toMatch(/> p ~ p$/);
        }
      }
    }
    // 上游的 list-inside 前提：ol / ul 是 list-inside（序号在内容流里）
    expect(renderMd(LOOSE)).toContain("list-inside");
  });
});

describe("V13-01 事件流窄栏：表格单元格只对虚拟滚动的事件流收紧", () => {
  const CELL_SELECTORS = [
    '[data-streamdown="table-header-cell"]',
    '[data-streamdown="table-cell"]',
  ];

  it("【上游前提】单元格带 data-streamdown 锚点、默认 px-4（左右各 16px），表壳自带 overflow-x-auto（放不下可横向滚动）", () => {
    const html = renderMd("| a | b | c | d |\n|---|---|---|---|\n| 1 | 2 | 3 | 4 |\n");
    expect(html).toMatch(/<th[^>]*px-4[^>]*data-streamdown="table-header-cell"/);
    expect(html).toMatch(/<td[^>]*px-4[^>]*data-streamdown="table-cell"/);
    expect(html).toContain("overflow-x-auto");
  });

  it("事件流收紧规则：作用域在 [data-virtuoso-scroller] .prose 内，两种单元格都覆盖，内衬 .25rem .5rem、列宽下限 4em + 1rem（内容区 ≥ 4 个汉字）", () => {
    const tight = rules.filter(
      (r) =>
        r.selectors.length > 0 &&
        r.selectors.every((s) => s.startsWith("[data-virtuoso-scroller] .prose ")) &&
        /padding: 0\.25rem 0\.5rem/.test(r.body),
    );
    expect(tight).toHaveLength(1);
    const [rule] = tight;
    expect(rule!.selectors).toEqual(
      CELL_SELECTORS.map((s) => `[data-virtuoso-scroller] .prose ${s}`),
    );
    expect(rule!.body).toMatch(/min-width: calc\(4em \+ 1rem\)/);
  });

  it("不影响文档面：没有任何不带 [data-virtuoso-scroller] 作用域的规则给表格单元格设 padding / min-width", () => {
    for (const r of rulesMatching(/data-streamdown="table-(header-)?cell"|\b(td|th)\b/)) {
      const cellSelectors = r.selectors.filter((s) =>
        /data-streamdown="table-(header-)?cell"|\b(td|th)\b/.test(s),
      );
      if (cellSelectors.some((s) => !s.startsWith("[data-virtuoso-scroller] "))) {
        expect(r.body, r.selectors.join(", ")).not.toMatch(/(^|[ ;])(padding|min-width)\b/);
      }
    }
  });

  it("文档面的 overflow-wrap: anywhere 规则原样保留（用户在 700px 容器里调优过的，不动）", () => {
    const doc = rules.filter(
      (r) =>
        r.selectors.length === 2 &&
        r.selectors[0] === '.prose [data-streamdown="table-header-cell"]' &&
        r.selectors[1] === '.prose [data-streamdown="table-cell"]',
    );
    expect(doc).toHaveLength(1);
    expect(doc[0]!.body).toBe("overflow-wrap: anywhere; white-space: normal;");
  });
});
