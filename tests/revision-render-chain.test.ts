/**
 * 修订视图「真跑渲染链路」测试（不是字符串断言）：
 * buildRevisionView → Streamdown(static, SSR) + 与 artifact-revision-view.tsx 同序的 remark 插件 + 修订视图的 rehype 表。
 *
 * 为什么要真跑：哨兵是否被渲染端消费、块级属性能不能活过 sanitize，只看 mergedMd / mdast 看不出来——
 * R1-18（整项新增 / 删除丢 ins/del 样式）和「modified 块下一处改动够不到」都是在这一层才暴露的。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Streamdown, defaultRemarkPlugins } from "streamdown";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  auditRevisionMergedMd,
  buildRevisionView,
  guardRevisionView,
  type RevisionView,
} from "../src/lib/md-revision";
import { remarkCodeReference } from "../src/lib/remark-code-reference";
import { createRevisionRemarkPlugins } from "../src/lib/revision-render-chain";
import {
  REVISION_ALLOWED_ATTRIBUTES,
  REVISION_BLOCK_INDEX_RE,
  REVISION_REHYPE_PLUGINS,
  RevisionDel,
  RevisionIns,
} from "../src/lib/revision-rehype-plugins";
import { REVISION_SYNTAX_PLUGINS } from "../src/lib/revision-syntax-plugins";
import { STREAMDOWN_REHYPE_PLUGINS } from "../src/lib/streamdown-options";

const SENTINEL_CHARS = /[\uE000-\uE004]/;

const count = (s: string, re: RegExp): number => (s.match(re) ?? []).length;

/**
 * 与 ArtifactRevisionView 生产组合一致（不再是精简版）：
 * plugins = 共用的 REVISION_SYNTAX_PLUGINS（cjk + math；code / mermaid 只影响高亮，这里省掉）；
 * remark = createRevisionRemarkPlugins（视图与测试共用同一份顺序）；rehype 用修订视图那张表；
 * components 用生产的 ins / del。
 * 之前的 harness 缺 cjk / math 与业务插件，parse 侧与 render 侧插件集不一致的问题在这里根本暴露不出来。
 */
const renderView = (
  view: RevisionView,
  rehypePlugins: unknown = REVISION_REHYPE_PLUGINS,
) =>
  renderToStaticMarkup(
    createElement(
      Streamdown,
      {
        mode: "static",
        plugins: REVISION_SYNTAX_PLUGINS,
        remarkPlugins: createRevisionRemarkPlugins(view.blockMarks, {
          sentinels: view.stats.leakFallback !== true,
        }),
        rehypePlugins,
        components: { ins: RevisionIns, del: RevisionDel },
      } as never,
      view.mergedMd,
    ),
  );

const renderRevision = (
  oldMd: string,
  newMd: string,
  rehypePlugins: unknown = REVISION_REHYPE_PLUGINS,
) => {
  const view = buildRevisionView(oldMd, newMd);
  return { view, html: renderView(view, rehypePlugins) };
};

/**
 * 不变量：合并 md 里每一对哨兵都必须在渲染结果里变成一个真实的 <ins>/<del>，
 * 渲染端把哨兵「静默吃掉」= 用户看到的是没有任何新增 / 删除样式的正文（R1-18）。
 * 同时渲染结果里不能出现字面哨兵。
 */
const expectNoStyleLost = (oldMd: string, newMd: string) => {
  const out = renderRevision(oldMd, newMd);
  // guard 降级后合并串 / 渲染结果里的哨兵数都是 0，下面的等式照样成立——必须先确认没走降级，否则断言被兜底遮蔽
  expect(out.view.stats.leakFallback, "不能被 guard 降级兜底遮蔽").toBeUndefined();
  expect(count(out.html, /<ins[\s>]/g)).toBe(count(out.view.mergedMd, /\uE000/g));
  expect(count(out.html, /<del[\s>]/g)).toBe(count(out.view.mergedMd, /\uE002/g));
  expect(out.html).not.toMatch(SENTINEL_CHARS);
  return out;
};

describe("R1-18：整个列表项 / 引用段落被新增或删除时，ins/del 样式不能静默丢失（真跑渲染链路）", () => {
  const cases: Array<[string, string, string]> = [
    [
      "列表末尾新增整项",
      "- alpha one\n- beta two",
      "- alpha one\n- beta two\n- gamma three new item",
    ],
    [
      "列表中间新增整项",
      "- alpha one\n- gamma three",
      "- alpha one\n- beta two inserted\n- gamma three",
    ],
    [
      "列表新增嵌套子项",
      "- alpha one\n- beta two",
      "- alpha one\n  - child item new\n- beta two",
    ],
    [
      "引用里新增整段",
      "> alpha one text",
      "> alpha one text\n>\n> beta two new para",
    ],
    [
      "列表删除整项",
      "- alpha one\n- beta two\n- gamma three",
      "- alpha one\n- gamma three",
    ],
    [
      "有序列表新增整项",
      "1. alpha one\n2. beta two",
      "1. alpha one\n2. beta two\n3. gamma three",
    ],
    [
      "较长列表里新增整项",
      "- 第一条：准备环境并安装依赖\n- 第二条：运行构建脚本\n- 第三条：执行回归测试\n- 第四条：发布到预发环境",
      "- 第一条：准备环境并安装依赖\n- 第二条：运行构建脚本\n- 新增一条：补充数据库迁移检查\n- 第三条：执行回归测试\n- 第四条：发布到预发环境",
    ],
  ];

  it.each(cases)("%s：每个哨兵都落成 ins/del 或整块回退，不静默丢样式", (_name, oldMd, newMd) => {
    expectNoStyleLost(oldMd, newMd);
  });

  it("列表末尾新增整项：整块标 modified（旧原文在 oldSource）、新项内容完整渲染、不泄漏哨兵", () => {
    const { view, html } = expectNoStyleLost(
      "- alpha one\n- beta two",
      "- alpha one\n- beta two\n- gamma three new item",
    );
    expect(view.blockMarks).toEqual([
      expect.objectContaining({
        index: 0,
        status: "modified",
        oldSource: "- alpha one\n- beta two",
      }),
    ]);
    expect(view.mergedMd).not.toMatch(SENTINEL_CHARS);
    expect(html).toContain("gamma three new item");
  });

  it("不过度回退：单个列表项内的改词仍然是词级 ins/del", () => {
    const { html } = expectNoStyleLost(
      "- alpha one\n- beta two",
      "- alpha one\n- beta twelve",
    );
    expect(count(html, /<ins[\s>]/g)).toBe(1);
    expect(count(html, /<del[\s>]/g)).toBe(1);
  });

  it("不过度回退：加粗内部新增文字（哨兵成对落在同一个 text 节点）仍是词级 ins", () => {
    const { html } = expectNoStyleLost(
      "alpha **one** end",
      "alpha **one two** end",
    );
    expect(count(html, /<ins[\s>]/g)).toBe(1);
  });
});

describe("GFM 表格：修订视图要按 GFM 解析（渲染端本来就是 GFM）", () => {
  const table = (rows: string[]) => rows.join("\n");

  it("新增一列：仍渲染成表格，不是带字面 `|` 的段落；整块标 modified、不插哨兵", () => {
    const oldMd = table(["| A | B |", "| - | - |", "| 1 | 2 |"]);
    const newMd = table(["| A | B | C |", "| - | - | - |", "| 1 | 2 | 3 |"]);
    const { view, html } = expectNoStyleLost(oldMd, newMd);
    // 修复前：哨兵落进分隔行 → 解析不出表格，整张表变成一个带 `| - |` 字面量的段落
    expect(html).toContain("<table");
    expect(html.replace(/<[^>]+>/g, "")).not.toMatch(/\|\s*-/);
    expect(view.mergedMd).not.toMatch(SENTINEL_CHARS);
    expect(view.blockMarks).toEqual([
      expect.objectContaining({ index: 0, status: "modified", oldSource: oldMd }),
    ]);
  });

  it("新增一行：整块标 modified、渲染成表格、不泄漏哨兵", () => {
    const oldMd = table(["| A | B |", "| - | - |", "| 1 | 2 |"]);
    const newMd = table(["| A | B |", "| - | - |", "| 1 | 2 |", "| 3 | 4 |"]);
    const { view, html } = expectNoStyleLost(oldMd, newMd);
    expect(html).toContain("<table");
    expect(view.mergedMd).toBe(newMd);
    expect(view.blockMarks).toEqual([
      expect.objectContaining({ index: 0, status: "modified" }),
    ]);
  });

  it("表格在前时，后面段落的块下标仍对齐（解析口径与渲染一致）", () => {
    const oldMd = `${table(["| A | B |", "| - | - |", "| 1 | 2 |"])}\n\n今天天气很好。`;
    const newMd = `${table(["| A | B |", "| - | - |", "| 1 | 9 |"])}\n\n今天天气不错。`;
    const { view, html } = expectNoStyleLost(oldMd, newMd);
    expect(html).toContain("<table");
    expect(view.blockMarks.map((m) => [m.index, m.status])).toEqual([
      [0, "modified"],
      [1, "modified"],
    ]);
    // 段落里的词级修订仍然在
    expect(count(html, /<ins[\s>]/g)).toBe(1);
  });
});

describe("下一处改动导航：modified 块（没有 ins/del）也要有 data-revision-hit", () => {
  const hits = (html: string, kind: string): number =>
    count(html, new RegExp(`data-revision-hit="${kind}"`, "g"));

  it("sanitize 不放行 data-*：共用的 STREAMDOWN_REHYPE_PLUGINS 会把块上的 hit 剥掉（所以修订视图用自己的表）", () => {
    const shared = renderRevision("旧段落内容", "旧段落内容\n\n新增段落内容", STREAMDOWN_REHYPE_PLUGINS);
    expect(shared.view.blockMarks.some((m) => m.status === "added")).toBe(true);
    expect(shared.html).not.toContain("data-revision-hit");
    const own = renderRevision("旧段落内容", "旧段落内容\n\n新增段落内容");
    expect(hits(own.html, "added")).toBe(1);
  });

  it("只改了格式（文字没变、没有 ins/del）的段落：块上带 hit，能被下一处改动命中", () => {
    const { view, html } = renderRevision("alpha one end", "alpha **one** end");
    expect(view.blockMarks).toEqual([
      expect.objectContaining({ index: 0, status: "modified" }),
    ]);
    expect(count(html, /<ins[\s>]|<del[\s>]/g)).toBe(0);
    expect(hits(html, "modified")).toBe(1);
  });

  it("整块代码被修改：块上带 hit", () => {
    const { html } = renderRevision(
      "```js\nconst a = 1;\n```",
      "```js\nconst a = 2;\n```",
    );
    expect(hits(html, "modified")).toBe(1);
  });

  it("代码块（含 mermaid、新增 / 删除）：Streamdown 的 code-block 组件不转发属性，靠外包的 div 承载 hit，代码块本体照常渲染", () => {
    const code = "```js\nconst a = 1;\n```";
    const added = renderRevision("正文保持不变。", `正文保持不变。\n\n${code}`);
    expect(hits(added.html, "added")).toBe(1);
    expect(added.html).toContain('data-streamdown="code-block"');
    const removed = renderRevision(`正文保持不变。\n\n${code}`, "正文保持不变。");
    expect(hits(removed.html, "removed")).toBe(1);
    expect(removed.html).toContain('data-streamdown="code-block"');
    const mermaid = renderRevision(
      "```mermaid\ngraph TD; A-->B;\n```",
      "```mermaid\ngraph TD; A-->C;\n```",
    );
    expect(hits(mermaid.html, "modified")).toBe(1);
  });

  it("没有 hit 的代码块不包 div：渲染结果与不带插件时一致", () => {
    const md = "```js\nconst a = 1;\n```\n\n正文";
    const { html } = renderRevision(md, md);
    expect(html).not.toContain("data-revision-hit");
    expect(html).not.toContain("<div><div"); // 没有多余的包装层
  });

  it("表格被修改：块上带 hit", () => {
    const { html } = renderRevision(
      "| A | B |\n| - | - |\n| 1 | 2 |",
      "| A | B |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |",
    );
    expect(hits(html, "modified")).toBe(1);
  });

  it("列表整项新增（按块回退）：块上带 hit", () => {
    const { html } = renderRevision(
      "- alpha one\n- beta two",
      "- alpha one\n- beta two\n- gamma three new item",
    );
    expect(hits(html, "modified")).toBe(1);
  });

  it("有词级 ins/del 的 modified 块：只靠 ins/del 命中，块上不再重复打 hit（避免一处改动命中两次）", () => {
    const { html } = renderRevision("今天天气很好。", "今天天气不错。");
    expect(count(html, /<ins[\s>]/g)).toBe(1);
    expect(count(html, /<del[\s>]/g)).toBe(1);
    expect(hits(html, "modified")).toBe(0);
    // ins/del 自己的 hit 来自 hProperties，经 sanitize 后同样要在
    expect(hits(html, "ins")).toBe(1);
    expect(hits(html, "del")).toBe(1);
  });

  it("added / removed 整块仍然带各自的 hit", () => {
    const added = renderRevision("第一段内容保持不变。", "第一段内容保持不变。\n\n全新的第二段内容。");
    expect(hits(added.html, "added")).toBe(1);
    const removed = renderRevision("第一段内容保持不变。\n\n将被删除的第二段内容。", "第一段内容保持不变。");
    expect(hits(removed.html, "removed")).toBe(1);
  });

  it("没有任何改动：没有任何 hit", () => {
    const { html } = renderRevision("同样的内容。", "同样的内容。");
    expect(html).not.toContain("data-revision-hit");
  });
});

describe("修订视图的 rehype 表只多放行三个修订标记属性（带值域），sanitize 的其它过滤不变", () => {
  it("脚本 / 事件属性 / javascript: 链接仍被剥掉", () => {
    const md =
      '<p onclick="steal()">正文</p>\n\n<script>alert(1)</script>\n\n[点我](javascript:alert(1))';
    const html = renderToStaticMarkup(
      createElement(
        Streamdown,
        {
          mode: "static",
          remarkPlugins: [...Object.values(defaultRemarkPlugins)],
          rehypePlugins: REVISION_REHYPE_PLUGINS,
        } as never,
        md,
      ),
    );
    expect(html).not.toMatch(/onclick/i);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/href="javascript:/i);
  });

  it("data-block-index / data-revision-status 现在放行了（原先被剥掉 = 左边条 / 角标在生产里整套不出现）；共用表仍然剥掉", () => {
    const own = renderRevision("旧段落内容", "旧段落内容\n\n新增段落内容");
    expect(own.html).toContain('data-block-index="1"');
    expect(own.html).toContain('data-revision-status="added"');
    // 共用的 STREAMDOWN_REHYPE_PLUGINS（正文渲染用）没被放宽
    const shared = renderRevision(
      "旧段落内容",
      "旧段落内容\n\n新增段落内容",
      STREAMDOWN_REHYPE_PLUGINS,
    );
    expect(shared.html).not.toContain("data-block-index");
    expect(shared.html).not.toContain("data-revision-status");
  });
});

// ---------- 第 4 轮 ----------

describe("parse 侧与 render 侧插件集一致：math 公式不能被当成普通文本塞哨兵", () => {
  const KATEX_ERROR = /katex-error|ParseError/;

  it("真实链路含 math：行内 / 块级公式的修改都不泄漏哨兵、不触发 KaTeX 报错", () => {
    const cases: Array<[string, string, string]> = [
      ["行内公式改值", "质能 $$E = mc^2$$ 成立", "质能 $$E = mc^3$$ 成立"],
      ["行内公式整体新增", "质能成立", "质能 $$E = mc^2$$ 成立"],
      ["块级公式改值", "前言\n\n$$\na^2 + b^2 = c^2\n$$\n\n结语", "前言\n\n$$\na^2 + b^2 = d^2\n$$\n\n结语"],
    ];
    for (const [, oldMd, newMd] of cases) {
      const { view, html } = renderRevision(oldMd, newMd);
      expect(view.mergedMd, "合并串里的哨兵不能进公式源码").not.toMatch(
        /\$\$[^$]*[\uE000-\uE004][^$]*\$\$/,
      );
      expect(html).not.toMatch(SENTINEL_CHARS);
      expect(html).not.toMatch(KATEX_ERROR);
      expect(view.stats.leakFallback).toBeUndefined();
    }
  });

  it("行内公式改值 → 走块级（旧块 removed + 新块 added），合并串里没有任何哨兵，新旧公式都完整渲染", () => {
    // 这个用例原先断言「ins / del 数量等于哨兵数」，但公式改动实际走块级、哨兵数是 0，两边都是 0 的 0 === 0 恒成立。
    // 现在直接钉住真实行为：块级标记 + 没有行内哨兵 + 没有降级 + 没有 KaTeX 报错。
    const { view, html } = renderRevision(
      "质能 $$E = mc^2$$ 成立",
      "质能 $$E = mc^3$$ 成立",
    );
    expect(view.blockMarks.map((b) => b.status)).toEqual(["removed", "added"]);
    expect(count(view.mergedMd, /[\uE000-\uE004]/g)).toBe(0);
    expect(view.stats.leakFallback).toBeUndefined();
    expect(html).not.toMatch(KATEX_ERROR);
    expect(count(html, /class="katex"/g)).toBe(2); // 旧公式 + 新公式各渲染一次
    // 块级增删靠 data-revision-hit 让「下一处改动」够得着（data-revision-status 也已放行，见下方「块级状态」用例）
    expect(count(html, /data-revision-hit="removed"/g)).toBe(1);
    expect(count(html, /data-revision-hit="added"/g)).toBe(1);
  });

  it("CJK 标点贴着强调：真实链路下哨兵仍成对落成 ins / del（cjk 与否不改变配对）", () => {
    const { html } = expectNoStyleLost(
      "这是**重点**内容，请注意。",
      "这是**重点内容**，请务必注意。",
    );
    expect(html).toContain('data-streamdown="strong"');
  });
});

describe("导航只认修订渲染链打的标记：正文原生 ~~删除线~~ / <del> 不算「下一处改动」", () => {
  const hitCount = (html: string) => count(html, /data-revision-hit=/g);

  it("正文里自带 ~~x~~ 且无任何改动：hit 为 0、没有修订样式", () => {
    const md = "保留 ~~原生删除线~~ 不动。";
    const { view, html } = renderRevision(md, md);
    expect(view.blockMarks).toEqual([]);
    expect(html).toMatch(/<del[\s>]/);
    expect(hitCount(html)).toBe(0);
    expect(html).not.toContain("line-through decoration-destructive");
  });

  it("原生删除线 + 一处真实改动：hit 只数真实修订（ins 1 + del 1），原生 <del> 不计入", () => {
    const { view, html } = renderRevision(
      "保留 ~~原生删除线~~ 不动，价格 100 元。",
      "保留 ~~原生删除线~~ 不动，价格 200 元。",
    );
    const mergedHits =
      count(view.mergedMd, /\uE000/g) + count(view.mergedMd, /\uE002/g);
    expect(mergedHits).toBe(2);
    expect(count(html, /<del[\s>]/g)).toBe(2); // 1 个原生 + 1 个修订删除
    expect(hitCount(html)).toBe(mergedHits);
    expect(html).toContain('data-revision-hit="ins"');
    expect(html).toContain('data-revision-hit="del"');
  });

  it("修订自己的 ins / del 仍带 hit 与修订样式（不误伤）", () => {
    const { html } = renderRevision("价格 100 元", "价格 200 元");
    expect(html).toMatch(/<ins[^>]*data-revision-hit="ins"[^>]*text-success/);
    expect(html).toMatch(/<del[^>]*data-revision-hit="del"[^>]*line-through/);
    // hast node 不能被展开到 DOM 属性上
    expect(html).not.toContain("[object Object]");
  });
});

describe("最终运行时兜底 guardRevisionView：哨兵残留 / 不成对绝不泄漏给用户", () => {
  afterEach(() => vi.restoreAllMocks());

  const fakeView = (mergedMd: string): RevisionView => ({
    mergedMd,
    blockMarks: [{ index: 0, status: "modified", oldSource: "old" }],
    stats: { ins: 1, del: 0 },
  });

  it("干净的视图原样返回（同一对象），也不 warn", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const view = buildRevisionView("价格 100 元", "价格 200 元");
    expect(guardRevisionView(view, "价格 200 元")).toBe(view);
    expect(auditRevisionMergedMd("没有哨兵的正文")).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it("合并串里孤儿哨兵（未配对）：降级为无标记纯渲染 + 标 leakFallback", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const view = fakeView("正文 \uE000孤儿 没有闭合");
    const out = guardRevisionView(view, "新版全文");
    expect(out.mergedMd).toBe("新版全文");
    expect(out.blockMarks).toEqual([]);
    expect(out.stats).toEqual({ ins: 0, del: 0, leakFallback: true });
    const html = renderView(out);
    expect(html).not.toMatch(SENTINEL_CHARS);
    expect(html).not.toMatch(/<ins[\s>]|<del[\s>]|data-revision-hit/);
    expect(html).toContain("新版全文");
  });

  it("哨兵落进消费不了的字段（链接 url / 行内 html）：同样降级", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const merged of [
      "看 [文档](https://a.com/\uE000x\uE001) 这里",
      "行内 <span title=\"\uE000\uE001\">x</span> html",
    ]) {
      expect(auditRevisionMergedMd(merged)).toBe(false);
      const out = guardRevisionView(fakeView(merged), "新版");
      expect(out.mergedMd).toBe("新版");
      expect(out.stats.leakFallback).toBe(true);
    }
  });

  it("console.warn 只发一次（多次触发、多个视图都不重复刷）", async () => {
    vi.resetModules();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mod = await import("../src/lib/md-revision");
    for (let i = 0; i < 3; i++) {
      mod.guardRevisionView(fakeView(`坏 \uE002${i}`), "新");
    }
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("正常 diff（含 replace / 块级回退）都过复验，不会被误降级", () => {
    const pairs: Array<[string, string]> = [
      ["alpha **one** end", "alpha **one two** end"],
      ["- a\n- b", "- a\n- b\n- c"],
      ["| a | b |\n| - | - |\n| 1 | 2 |", "| a | b |\n| - | - |\n| 1 | 3 |"],
      ["质能 $$E = mc^2$$ 成立", "质能 $$E = mc^3$$ 成立"],
      ["看 [文档](https://a.com/x) 这里", "看 [文档](https://a.com/y) 这里"],
    ];
    for (const [o, n] of pairs) {
      expect(buildRevisionView(o, n).stats.leakFallback).toBeUndefined();
    }
  });
});

// ---------- 第 5 轮 ----------

describe("R4-4：expectNoStyleLost 不能被 guard 降级遮蔽", () => {
  it("降级后合并串 / 渲染结果的哨兵数都是 0——这就是 expectNoStyleLost 要先断言 leakFallback 的原因", () => {
    // 字面哨兵码位 → 入口直接降级：mergedMd 里没有哨兵、html 里也没有 ins/del，等式 0 === 0 天然成立
    const out = renderRevision("原文 \uE000 字符", "新文 \uE000 字符");
    expect(out.view.stats.leakFallback).toBe(true);
    expect(count(out.view.mergedMd, /\uE000/g)).toBe(1); // 字面那一个，不是哨兵
    expect(count(out.html, /<ins[\s>]/g)).toBe(0);
    expect(count(out.html, /<del[\s>]/g)).toBe(0);
  });
});

describe("引用 / 脚注定义块：逐块验收带上定义上下文，不再让 guard 误把整篇降级", () => {
  const DEF = "\n\n[1]: https://a.com/doc";

  it("新增 `[1]`（整篇里是 linkReference）：不整篇降级，该块按块 modified，其余块的标记保留", () => {
    const oldMd = `# 标题\n\n见文。${DEF}`;
    const newMd = `# 标题\n\n见 [1] 文。${DEF}`;
    const { view, html } = renderRevision(oldMd, newMd);
    expect(view.stats.leakFallback).toBeUndefined();
    expect(view.blockMarks).toEqual([
      expect.objectContaining({ index: 1, status: "modified" }),
    ]);
    expect(html).not.toMatch(SENTINEL_CHARS);
    // 定义被消费：`[1]` 渲染成链接（Streamdown 的链接是带安全确认的 button）
    expect(html).toContain('data-streamdown="link"');
    // 放行 data-block-index / data-revision-status 之后块上不止一个 data-*，不能再钉整段开标签字面量
    expect(html).toMatch(
      /<p [^>]*data-block-index="1"[^>]*data-revision-status="modified"[^>]*data-revision-hit="modified"[^>]*>/,
    );
  });

  it("新增完整引用 `[文档][1]`：同样不降级", () => {
    const { view } = renderRevision(`见文。${DEF}`, `见 [文档][1] 文。${DEF}`);
    expect(view.stats.leakFallback).toBeUndefined();
    expect(view.blockMarks.map((m) => m.status)).toEqual(["modified"]);
  });

  it("已有引用旁边改字：仍是词级 ins/del（不因带上定义而过度回退）", () => {
    const { view, html } = renderRevision(
      `见 [1] 文。${DEF}`,
      `见 [1] 两文。${DEF}`,
    );
    expect(view.stats.leakFallback).toBeUndefined();
    expect(count(html, /<ins[\s>]/g)).toBe(1); // 「两」是纯新增
    expect(count(html, /<del[\s>]/g)).toBe(0);
  });

  it("脚注定义：新增 `[^1]` 引用不降级", () => {
    const { view, html } = renderRevision(
      "正文。\n\n[^1]: 脚注内容",
      "正文[^1]。\n\n[^1]: 脚注内容",
    );
    expect(view.stats.leakFallback).toBeUndefined();
    expect(html).not.toMatch(SENTINEL_CHARS);
  });

  it("guard 本身没放宽：孤儿哨兵仍然会被拦下降级（定义上下文只修验收口径）", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = guardRevisionView(
      {
        mergedMd: "见 \uE000[1] \uE001文。\n\n[1]: https://a.com/doc",
        blockMarks: [],
        stats: { ins: 1, del: 0 },
      },
      "新版",
    );
    expect(out.stats.leakFallback).toBe(true);
    vi.restoreAllMocks();
  });
});

describe("guardRevisionView / buildRevisionView 的异常兜底（复验或核心抛错）", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock("../src/lib/revision-syntax-plugins");
    vi.resetModules();
  });

  /** 让 parse 侧的 parser 在遇到含哨兵码位的文档时抛错（模拟解析器对极端输入崩溃） */
  const loadWithThrowingParser = async () => {
    vi.resetModules();
    vi.doMock("../src/lib/revision-syntax-plugins", async (importOriginal) => {
      const orig =
        await importOriginal<typeof import("../src/lib/revision-syntax-plugins")>();
      function throwOnSentinel(this: { parser: (doc: string, file: unknown) => unknown }) {
        const base = this.parser;
        this.parser = (doc: string, file: unknown) => {
          if (/[\uE000-\uE003]/.test(doc)) throw new Error("boom: parser crashed");
          return base(doc, file);
        };
      }
      return {
        ...orig,
        REVISION_PARSE_REMARK_PLUGINS: [
          ...orig.REVISION_PARSE_REMARK_PLUGINS,
          throwOnSentinel,
        ],
      };
    });
    return import("../src/lib/md-revision");
  };

  it("复验自身抛错：guardRevisionView 不外抛，降级为无标记全文 + leakFallback，warn 只一次", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mod = await loadWithThrowingParser();
    const view = {
      mergedMd: "有哨兵 \uE000x\uE001 的合并串",
      blockMarks: [{ index: 0, status: "modified" as const }],
      stats: { ins: 1, del: 0 },
    };
    for (let i = 0; i < 3; i++) {
      const out = mod.guardRevisionView(view, "新版全文");
      expect(out.mergedMd).toBe("新版全文");
      expect(out.blockMarks).toEqual([]);
      expect(out.stats).toEqual({ ins: 0, del: 0, leakFallback: true });
    }
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain("复验自身抛错");
  });

  it("核心实现抛错：buildRevisionView 不外抛，降级为无标记全文，warn 只一次", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mod = await loadWithThrowingParser();
    // 正常词级改动会把带哨兵的合并串交给逐块验收 → 注入的 parser 在那里抛错
    for (let i = 0; i < 3; i++) {
      const out = mod.buildRevisionView("价格 100 元", "价格 200 元");
      expect(out.mergedMd).toBe("价格 200 元");
      expect(out.stats.leakFallback).toBe(true);
    }
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("原文含字面哨兵码位（U+E000–E003）：入口直接降级，不走逐块再让 guard 兜底", () => {
  afterEach(() => vi.restoreAllMocks());

  const LITERAL: Array<[string, string, string]> = [
    ["新旧都含 U+E000", "原文 \uE000 字符", "新文 \uE000 字符"],
    ["只有旧版含成对 U+E002/E003", "含 \uE002x\uE003 的原文", "含 的新文"],
    ["只有新版含 U+E001", "纯文本", "纯文本 \uE001"],
    ["含 U+E003（关闭哨兵）", "a \uE003 b", "a \uE003 c"],
  ];

  it.each(LITERAL)("%s：无标记全文 + leakFallback，且 warn 恰好一次", async (_n, oldMd, newMd) => {
    // 「只 warn 一次」的标志是模块级的：静态 import 的 buildRevisionView 在前面的用例里可能已经 warn 过，
    // 这里每个用例重置模块、动态 import 一份全新的，才能断言「恰好 1 次」（<=1 对 0 次也成立，等于没断言）
    vi.resetModules();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { buildRevisionView: freshBuild } = await import("../src/lib/md-revision");
    const view = freshBuild(oldMd, newMd);
    expect(view.mergedMd).toBe(newMd);
    expect(view.blockMarks).toEqual([]);
    expect(view.stats).toEqual({ ins: 0, del: 0, leakFallback: true });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("降级后的渲染是真正的纯渲染：字面字符不被当哨兵消费（不变假 ins/del、不被静默吃掉）", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { view, html } = renderRevision("a \uE002x\uE003 b", "新 \uE002x\uE003 文");
    expect(view.stats.leakFallback).toBe(true);
    expect(html).not.toMatch(/<ins[\s>]|<del[\s>]|data-revision-hit/);
    expect(count(html, /\uE002/g)).toBe(1);
    expect(count(html, /\uE003/g)).toBe(1);
  });

  it("正常文本不受影响（入口检测只看哨兵码位）", () => {
    const view = buildRevisionView("价格 100 元", "价格 200 元");
    expect(view.stats.leakFallback).toBeUndefined();
    expect(view.mergedMd).toMatch(/\uE000/);
  });
});

describe("remark-code-reference 在顶层插入出处段落：不能让其后块的标注错位一格", () => {
  const FENCE = "```12:34:src/a.ts\nconst a = 1;\n```";
  const modifiedHit = (html: string) =>
    [...html.matchAll(/<(\w+)[^>]*data-revision-hit="modified"[^>]*>/g)].map(
      (m) => m[0],
    );

  it("代码引用围栏之后的块被改（纯格式改动 → 整块 modified）：hit 落在被改的段落上，不落在代码块上", () => {
    const oldMd = `前言\n\n${FENCE}\n\n结尾段落内容`;
    const newMd = `前言\n\n${FENCE}\n\n**结尾段落内容**`;
    const { view, html } = renderRevision(oldMd, newMd);
    // index 是 parse 侧的顶层块序（前言 0 / 围栏 1 / 结尾段落 2）；出处段落是渲染时才插进去的
    expect(view.blockMarks).toEqual([
      expect.objectContaining({ index: 2, status: "modified" }),
    ]);
    const hits = modifiedHit(html);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatch(/^<p[\s>]/);
    // 代码引用的出处段落仍然被插入（功能不丢）
    expect(html).toContain("src/a.ts · L12-34");
  });

  it("代码引用围栏自己被改：hit 落在代码块上，其后块不受影响", () => {
    const oldMd = `前言\n\n${FENCE}\n\n结尾段落内容`;
    const newMd = `前言\n\n\`\`\`12:34:src/a.ts\nconst a = 2;\n\`\`\`\n\n结尾段落内容`;
    const { view, html } = renderRevision(oldMd, newMd);
    expect(view.blockMarks.map((m) => m.index)).toEqual([1]);
    const hits = modifiedHit(html);
    expect(hits).toHaveLength(1);
    expect(hits[0]).not.toMatch(/^<p[\s>]/);
    expect(html).toContain("结尾段落内容");
  });

  it("插件顺序契约：哨兵转换 → 块标注 → 代码引用（标注必须先于会插入顶层节点的插件）", () => {
    const plugins = createRevisionRemarkPlugins([]);
    const nameOf = (p: unknown): string => {
      const fn = Array.isArray(p) ? p[0] : p;
      return (fn as { name?: string }).name ?? "";
    };
    const names = plugins.map(nameOf);
    const iSentinel = names.indexOf("remarkSentinelToRevision");
    const iAnnotate = names.indexOf("remarkAnnotateRevisionBlocksPlugin");
    const iCodeRef = plugins.indexOf(remarkCodeReference);
    expect(iSentinel).toBeGreaterThanOrEqual(0);
    expect(iAnnotate).toBeGreaterThan(iSentinel);
    expect(iCodeRef).toBeGreaterThan(iAnnotate);
    // 降级为无标记纯渲染时不挂哨兵插件
    const plain = createRevisionRemarkPlugins([], { sentinels: false }).map(nameOf);
    expect(plain).not.toContain("remarkSentinelToRevision");
  });
});

// ---------- 任务 A：放行 data-block-index / data-revision-status（块左边条 / 角标 / 旧文弹窗首次在生产生效）----------

interface BlockTag {
  tag: string;
  index: number;
  status: string | null;
  hit: string | null;
  /** 从这个块的开标签到下一个带 data-block-index 的标签之间的可见文本 */
  text: string;
}

const attrOf = (open: string, name: string): string | null =>
  new RegExp(`\\s${name}="([^"]*)"`).exec(open)?.[1] ?? null;

/** 把 SSR 结果里所有带 data-block-index 的元素按文档序解析出来（即角标 measure 里 querySelector 会碰到的那批元素） */
const blockTags = (html: string): BlockTag[] => {
  const found = [
    ...html.matchAll(/<([a-zA-Z][\w-]*)\b[^>]*\sdata-block-index="[^"]*"[^>]*>/g),
  ];
  return found.map((m, k) => {
    const open = m[0];
    const end = k + 1 < found.length ? found[k + 1]!.index! : html.length;
    return {
      tag: m[1]!,
      index: Number(attrOf(open, "data-block-index")),
      status: attrOf(open, "data-revision-status"),
      hit: attrOf(open, "data-revision-hit"),
      text: html.slice(m.index! + open.length, end).replace(/<[^>]+>/g, ""),
    };
  });
};

/** 角标 measure 的 DOM 查询（`[data-block-index="N"][data-revision-status="modified"]`）在 SSR 结果里命中几个元素 */
const badgeMatches = (html: string, index: number): number =>
  blockTags(html).filter((b) => b.index === index && b.status === "modified").length;

describe("任务 A：块级状态（data-block-index / data-revision-status）放行后，左边条 / 角标 / 旧文弹窗依赖的 DOM 真实存在", () => {
  it("added / removed / 整块 modified / 词级 modified 各自带正确的 status、index、tag；未改动块只有 index、没有 status", () => {
    const added = blockTags(renderRevision("第一段保持。", "第一段保持。\n\n新增段落内容。").html);
    expect(added).toEqual([
      expect.objectContaining({ tag: "p", index: 0, status: null, hit: null }),
      expect.objectContaining({ tag: "p", index: 1, status: "added", hit: "added" }),
    ]);

    const removed = blockTags(renderRevision("第一段保持。\n\n被删除的段落。", "第一段保持。").html);
    expect(removed).toEqual([
      expect.objectContaining({ tag: "p", index: 0, status: null }),
      expect.objectContaining({ tag: "p", index: 1, status: "removed", hit: "removed" }),
    ]);

    // 只改了格式 → 整块 modified、块上带 hit
    const fmt = blockTags(renderRevision("alpha one end", "alpha **one** end").html);
    expect(fmt).toEqual([
      expect.objectContaining({ tag: "p", index: 0, status: "modified", hit: "modified" }),
    ]);

    // 词级 modified：有 status、块上不重复打 hit（避免一处改动命中两次）
    const word = blockTags(renderRevision("今天天气很好。", "今天天气不错。").html);
    expect(word).toEqual([
      expect.objectContaining({ tag: "p", index: 0, status: "modified", hit: null }),
    ]);
  });

  it("共用的 STREAMDOWN_REHYPE_PLUGINS 仍剥掉这两个属性（放行只发生在修订视图自己的表里，没改共享表）", () => {
    const { html } = renderRevision(
      "旧段落内容",
      "旧段落内容\n\n新增段落内容",
      STREAMDOWN_REHYPE_PLUGINS,
    );
    expect(html).not.toMatch(/data-block-index|data-revision-status/);
  });

  // 各块类型：每种顶层块的 status 都要落到 DOM 上（Streamdown 对 code-block / 公式有自己的渲染，不一定转发 hast 属性）
  const LONG_LIST = [
    "- 第一条：准备环境并安装依赖",
    "- 第二条：运行构建脚本",
    "- 第三条：执行回归测试",
    "- 第四条：发布到预发环境",
  ];
  const TABLE = ["| A | B |", "| - | - |", "| 1 | 2 |"];
  const typeCases: Array<[string, string, string, string, "added" | "removed" | "modified"]> = [
    ["标题新增", "前言保持不变。", "前言保持不变。\n\n## 新增标题", "h2", "added"],
    ["段落整段删除", "前言保持不变。\n\n被删除的整段内容。", "前言保持不变。", "p", "removed"],
    [
      "无序列表整项新增（按块回退）",
      LONG_LIST.join("\n"),
      [...LONG_LIST.slice(0, 2), "- 新增一条：补充数据库迁移检查", ...LONG_LIST.slice(2)].join("\n"),
      "ul",
      "modified",
    ],
    [
      "无序列表整项删除（按块回退）",
      LONG_LIST.join("\n"),
      [LONG_LIST[0], LONG_LIST[1], LONG_LIST[3]].join("\n"),
      "ul",
      "modified",
    ],
    [
      "有序列表整项新增",
      "1. 第一条：准备环境并安装依赖\n2. 第二条：运行构建脚本\n3. 第三条：执行回归测试",
      "1. 第一条：准备环境并安装依赖\n2. 第二条：运行构建脚本\n3. 新增一条：补充数据库迁移检查\n4. 第三条：执行回归测试",
      "ol",
      "modified",
    ],
    ["引用整段新增", "> alpha one text", "> alpha one text\n>\n> beta two new para", "blockquote", "modified"],
    ["表格新增一行（按块回退）", TABLE.join("\n"), [...TABLE, "| 3 | 4 |"].join("\n"), "table", "modified"],
    ["表格新增一列（按块回退）", TABLE.join("\n"), "| A | B | C |\n| - | - | - |\n| 1 | 2 | 3 |", "table", "modified"],
    ["整张表格新增", "前言保持不变。", `前言保持不变。\n\n${TABLE.join("\n")}`, "table", "added"],
    ["分隔线新增", "上文保持不变。", "上文保持不变。\n\n---", "hr", "added"],
    ["围栏代码修改（Streamdown 的 code-block 不转发属性，靠外包 div）", "```js\nconst a = 1;\n```", "```js\nconst a = 2;\n```", "div", "modified"],
    ["mermaid 修改（同上）", "```mermaid\ngraph TD; A-->B;\n```", "```mermaid\ngraph TD; A-->C;\n```", "div", "modified"],
    ["围栏代码整块新增", "前言保持不变。", "前言保持不变。\n\n```js\nconst a = 1;\n```", "div", "added"],
    [
      "块级公式修改（rehype-katex 会替换掉 pre，属性靠外包 div）",
      "前言保持不变。\n\n$$\na^2 = b\n$$",
      "前言保持不变。\n\n$$\na^2 = c\n$$",
      "div",
      "modified",
    ],
    ["块级公式新增", "前言保持不变。", "前言保持不变。\n\n$$\na^2 = c\n$$", "div", "added"],
  ];

  it.each(typeCases)("%s：恰有一个对应 tag 的块带正确的 data-revision-status，index 与 blockMarks 对齐", (_name, oldMd, newMd, tag, status) => {
    const { view, html } = renderRevision(oldMd, newMd);
    expect(view.stats.leakFallback).toBeUndefined();
    expect(view.blockMarks.some((m) => m.status === status)).toBe(true);
    const mark = view.blockMarks.find((m) => m.status === status)!;
    const hits = blockTags(html).filter((b) => b.status === status && b.index === mark.index);
    expect(hits, `DOM 上应有一个 index=${mark.index} status=${status} 的块`).toHaveLength(1);
    expect(hits[0]!.tag).toBe(tag);
    // 不能凭空多出别的 status：DOM 上带 status 的块恰好对应 blockMarks
    const statusBlocks = blockTags(html).filter((b) => b.status !== null);
    expect(statusBlocks.map((b) => [b.index, b.status]).sort()).toEqual(
      view.blockMarks.map((m) => [m.index, m.status]).sort(),
    );
    if (status === "modified") expect(badgeMatches(html, mark.index)).toBe(1);
  });

  it("没有任何改动：没有任何 status（块上只有无害的 data-block-index）", () => {
    const { html } = renderRevision("同样的内容。\n\n第二段。", "同样的内容。\n\n第二段。");
    expect(html).not.toContain("data-revision-status");
    expect(blockTags(html).every((b) => b.status === null)).toBe(true);
  });

  it("下标对齐：代码引用围栏（渲染时才插入出处段落）与相邻列表的注释分隔都不让 status 错位", () => {
    const FENCE = "```12:34:src/a.ts\nconst a = 1;\n```";
    // 前言 0 / 围栏 1 / 结尾段落 2：结尾段落被改格式
    const a = renderRevision(`前言\n\n${FENCE}\n\n结尾段落内容`, `前言\n\n${FENCE}\n\n**结尾段落内容**`);
    const aTags = blockTags(a.html);
    expect(aTags.find((b) => b.status === "modified")).toEqual(
      expect.objectContaining({ tag: "p", index: 2 }),
    );
    expect(a.html).toContain("src/a.ts · L12-34"); // 出处段落仍插入

    // 两个相邻列表（merge 时在中间插 HTML 注释占一个顶层块序）：改第二个列表
    const l1 = "- 苹果香蕉\n- 橙子葡萄";
    const a2 = renderRevision(
      `${l1}\n\n<!--sep-->\n\n- 甲乙丙丁\n- 戊己庚辛`,
      `${l1}\n\n<!--sep-->\n\n- 甲乙丙丁\n- 戊己庚辛\n- 壬癸子丑`,
    );
    const modified = a2.view.blockMarks.filter((m) => m.status === "modified");
    expect(modified.length).toBeGreaterThan(0);
    for (const m of modified) {
      expect(blockTags(a2.html).filter((b) => b.index === m.index && b.status === "modified")).toHaveLength(1);
    }
  });

  it("旧文弹窗取旧文：modified 的 oldSource 是旧版对应块的原文，DOM 上同 index 的块渲染的是新版（旧文没被错放到新文位置）", () => {
    const oldMd = "第一段保持不变。\n\n旧版独有的蓝色大象在这里。\n\n第三段保持不变。";
    const newMd = "第一段保持不变。\n\n**新版独有的**红色长颈鹿在这里。\n\n第三段保持不变。";
    const { view, html } = renderRevision(oldMd, newMd);
    const mark = view.blockMarks.find((m) => m.status === "modified")!;
    expect(mark).toBeDefined();
    // 弹窗内容 = 旧块原文（来自 blockMarks，不读 DOM）
    expect(mark.oldSource).toBe("旧版独有的蓝色大象在这里。");
    // 同 index 的 DOM 块是新版内容，不含旧文独有的词
    const block = blockTags(html).find((b) => b.index === mark.index)!;
    expect(block.status).toBe("modified");
    expect(block.text).toContain("红色长颈鹿");
    expect(block.text).not.toContain("蓝色大象");
    // 相邻未改块不受影响
    expect(blockTags(html).find((b) => b.index === 0)!.text).toContain("第一段保持不变");
    expect(blockTags(html).find((b) => b.index === 2)!.text).toContain("第三段保持不变");
  });

  it("removed 块：DOM 上的是旧版原文（红条标出被删内容），oldSource 与之相同", () => {
    const { view, html } = renderRevision("保持不变的第一段。\n\n被删除的整段内容。", "保持不变的第一段。");
    const mark = view.blockMarks.find((m) => m.status === "removed")!;
    expect(mark.oldSource).toBe("被删除的整段内容。");
    const block = blockTags(html).find((b) => b.index === mark.index)!;
    expect(block.status).toBe("removed");
    expect(block.text).toContain("被删除的整段内容");
  });

  it("边界输入不崩：空旧文 / 空新文 / 全删 / 全增 / 只有代码块 / 只有公式", () => {
    const inputs: Array<[string, string]> = [
      ["", ""],
      ["", "全新的内容。"],
      ["全被删掉的内容。", ""],
      ["", "```js\nconst a = 1;\n```"],
      ["```js\nconst a = 1;\n```", ""],
      ["", "$$\na^2\n$$"],
      ["$$\na^2\n$$", "$$\na^3\n$$"],
      ["# 标题", "# 标题\n\n- a\n- b"],
    ];
    for (const [o, n] of inputs) {
      const { view, html } = renderRevision(o, n);
      expect(view.stats.leakFallback).toBeUndefined();
      expect(html).not.toMatch(SENTINEL_CHARS);
      // 所有 DOM 上的 status 都能在 blockMarks 里找到对应项
      for (const b of blockTags(html).filter((x) => x.status !== null)) {
        expect(view.blockMarks.some((m) => m.index === b.index && m.status === b.status)).toBe(true);
      }
    }
  });
});

describe("任务 A 安全面：放行的属性都带值域校验，原始 HTML 伪造不出值域之外的东西", () => {
  const forged = (attrs: string) =>
    renderRevision("正文保持不变。", `<div ${attrs}>伪造块</div>\n\n正文保持不变。`).html;

  it("REVISION_ALLOWED_ATTRIBUTES 三项都带值域（不是裸属性名 = 任意值放行）", () => {
    const byName = new Map(
      REVISION_ALLOWED_ATTRIBUTES.map((d) => [d[0], d.slice(1)] as const),
    );
    expect([...byName.keys()].sort()).toEqual(["dataBlockIndex", "dataRevisionHit", "dataRevisionStatus"]);
    expect(byName.get("dataRevisionStatus")).toEqual(["added", "removed", "modified"]);
    expect(byName.get("dataRevisionHit")).toEqual(["ins", "del", "added", "removed", "modified"]);
    expect(byName.get("dataBlockIndex")).toEqual([REVISION_BLOCK_INDEX_RE]);
  });

  it("block-index 值域：只认非负整数（≤9 位、无前导零、无空白 / 符号 / 科学计数 / 全角数字）", () => {
    for (const ok of ["0", "7", "42", "123456789"]) expect(REVISION_BLOCK_INDEX_RE.test(ok), ok).toBe(true);
    for (const bad of ["", "-1", "01", "1e3", "0x1", "1.5", " 1", "1 ", "1\n", "１２", "1234567890", "a", "1\"]"]) {
      expect(REVISION_BLOCK_INDEX_RE.test(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it("非法值整个属性被剥掉：status 越界 / 带引号与选择器片段 / 非整数 index / 越界 hit 都进不了 DOM", () => {
    const html = forged(
      `data-revision-status='added"] , body { x' data-block-index="1e3" data-revision-hit="evil"`,
    );
    expect(html).toContain("伪造块");
    expect(html).not.toMatch(/data-revision-status|data-revision-hit/);
    expect(html).not.toMatch(/data-block-index="1e3"/);
    expect(html).not.toContain("body {");

    for (const bad of ["x", "ADDED", "added modified", "unchanged", ""]) {
      expect(forged(`data-revision-status="${bad}"`), JSON.stringify(bad)).not.toContain(
        "data-revision-status",
      );
    }
    for (const bad of ["-1", "01", "1.5", "99999999999", "abc"]) {
      const out = forged(`data-block-index="${bad}"`);
      // 真实块自己也带合法的 data-block-index（"1"），伪造的那个值不能出现
      expect(out, JSON.stringify(bad)).not.toContain(`data-block-index="${bad}"`);
    }
  });

  it("合法值的伪造（已知后果，写明）：raw HTML 能带出一条左边条 / hit，但只是样式 + 导航落点——不影响 blockMarks，也读不到别的旧文", () => {
    const html = forged(`data-revision-status="added" data-block-index="0"`);
    // 伪造成功：不可信 markdown 的 raw HTML 与插件产出的节点在 rehype-raw 之后无法区分，值域内的值放得进来
    expect(html).toMatch(/<div data-revision-status="added" data-block-index="0">伪造块<\/div>/);
    // 但值只会落在枚举里：DOM 上所有 status 都在三值之内
    for (const m of html.matchAll(/data-revision-status="([^"]*)"/g)) {
      expect(["added", "removed", "modified"]).toContain(m[1]);
    }
    // 弹窗内容取自 buildRevisionView 的 blockMarks（不读 DOM）：伪造不会改变它
    const view = buildRevisionView("正文保持不变。", `<div data-revision-status="modified" data-block-index="0">伪造块</div>\n\n正文保持不变。`);
    for (const m of view.blockMarks) {
      expect(m.oldSource === undefined || "正文保持不变。".includes(m.oldSource)).toBe(true);
    }
  });

  it("sanitize 的其它过滤不变：放行三项之后，on* / script / javascript: 仍被剥", () => {
    const md =
      '<p onclick="steal()" data-revision-status="added">正文</p>\n\n<script>alert(1)</script>\n\n[点我](javascript:alert(1))';
    const html = renderToStaticMarkup(
      createElement(
        Streamdown,
        {
          mode: "static",
          remarkPlugins: [...Object.values(defaultRemarkPlugins)],
          rehypePlugins: REVISION_REHYPE_PLUGINS,
        } as never,
        md,
      ),
    );
    expect(html).toContain('data-revision-status="added"');
    expect(html).not.toMatch(/onclick/i);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/href="javascript:/i);
  });
});

describe("任务 A 契约：artifact-revision-view.tsx 的 CSS 选择器 / 角标查询 与 sanitize 值域对得上", () => {
  const view = readFileSync(
    resolve(__dirname, "..", "src/components/tasks/artifact-revision-view.tsx"),
    "utf8",
  );

  it("CSS 里的 [data-revision-status=X] 取值全集 = sanitize 放行的 status 枚举（不会有放行了却没样式、或样式匹配不到的值）", () => {
    const cssValues = new Set(
      [...view.matchAll(/\[data-revision-status=(\w+)\]/g)].map((m) => m[1]),
    );
    const allowed = REVISION_ALLOWED_ATTRIBUTES.find((d) => d[0] === "dataRevisionStatus")!.slice(1);
    expect([...cssValues].sort()).toEqual([...allowed].sort());
  });

  it("<hr>（0 高度，背景 / 左边条不可见）有单独的边框上色规则，三种状态各一条", () => {
    for (const [status, token] of [
      ["added", "success"],
      ["removed", "destructive"],
      ["modified", "warning"],
    ] as const) {
      expect(view).toContain(
        `[&_hr[data-revision-status=${status}]]:border-${token}`,
      );
    }
    // SSR：新增分隔线真的是带 status 的 <hr>，上面的选择器能命中
    const { html } = renderRevision("上文保持不变。", "上文保持不变。\n\n---");
    expect(html).toMatch(/<hr [^>]*data-revision-status="added"/);
  });

  it("角标查询用 data-block-index + data-revision-status=modified 精确定位，并盯 ResizeObserver 重测", () => {
    expect(view).toContain('`[data-block-index="${mark.index}"][data-revision-status="modified"]`');
    expect(view).toMatch(/new ResizeObserver\(/);
    expect(view).toMatch(/ro\.disconnect\(\)/);
  });
});
