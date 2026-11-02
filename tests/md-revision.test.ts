import { describe, expect, it, vi } from "vitest";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

import {
  buildRevisionView,
  collectRevisionNodes,
  DEL_CLOSE,
  DEL_OPEN,
  INS_CLOSE,
  INS_OPEN,
  parseMergedWithRevisionPlugin,
  stripRevisionSentinels,
  treeHasSentinelLeak,
} from "../src/lib/md-revision";

/** 数合并 md 顶层块（与 blockMarks.index 对齐口径） */
const countTopBlocks = (md: string): number => {
  const tree = unified().use(remarkParse).parse(md) as {
    children?: unknown[];
  };
  return tree.children?.length ?? 0;
};

describe("buildRevisionView", () => {
  it("两版完全相同 → 零标记、零统计", () => {
    const md = "## 标题\n\n一段正文。\n\n- a\n- b\n";
    const view = buildRevisionView(md, md);
    expect(view.blockMarks).toEqual([]);
    expect(view.stats).toEqual({ ins: 0, del: 0 });
    expect(view.mergedMd.replace(/\s+/g, " ").trim()).toBe(
      md.replace(/\s+/g, " ").trim(),
    );
  });

  it("中文段落词级增删", () => {
    const oldMd = "今天天气很好，适合出门。";
    const newMd = "今天天气不错，适合跑步出门。";
    const view = buildRevisionView(oldMd, newMd);
    expect(view.stats.ins).toBeGreaterThan(0);
    expect(view.stats.del).toBeGreaterThan(0);
    expect(view.mergedMd).toContain(INS_OPEN);
    expect(view.mergedMd).toContain(DEL_OPEN);
    // 公共字还在
    expect(stripRevisionSentinels(view.mergedMd)).toContain("今天天气");
    expect(stripRevisionSentinels(view.mergedMd)).toContain("出门");
  });

  it("短段整段替换 → remove+add（禁用 charOverlap 误配对）", () => {
    const view = buildRevisionView("今天天气很好。", "明天会议取消。");
    expect(view.blockMarks.some((m) => m.status === "removed")).toBe(true);
    expect(view.blockMarks.some((m) => m.status === "added")).toBe(true);
    // 整段替换不应词级乱炖
    expect(view.mergedMd).not.toContain(INS_OPEN);
    expect(view.mergedMd).not.toContain(DEL_OPEN);
    expect(stripRevisionSentinels(view.mergedMd)).toContain("今天天气很好");
    expect(stripRevisionSentinels(view.mergedMd)).toContain("明天会议取消");
  });

  it("短段同句小改 → modified 词级内联", () => {
    const view = buildRevisionView("今天天气很好。", "今天天气不错。");
    expect(view.mergedMd).toContain(DEL_OPEN);
    expect(view.mergedMd).toContain(INS_OPEN);
    expect(view.blockMarks.some((m) => m.status === "removed")).toBe(false);
    expect(view.blockMarks.some((m) => m.status === "added")).toBe(false);
    expect(stripRevisionSentinels(view.mergedMd)).toContain("今天天气");
  });

  it("标题改动 → 有修订信号", () => {
    const view = buildRevisionView("# 方案规划", "# 方案修订");
    expect(view.mergedMd.startsWith("#")).toBe(true);
    const hasInline =
      view.mergedMd.includes(DEL_OPEN) || view.mergedMd.includes(INS_OPEN);
    const hasBlock = view.blockMarks.length > 0;
    expect(hasInline || hasBlock).toBe(true);
    expect(stripRevisionSentinels(view.mergedMd)).toMatch(/方案/);
  });

  it("列表项增删", () => {
    const oldMd = "- 苹果\n- 香蕉\n- 橙子";
    const newMd = "- 苹果\n- 葡萄\n- 橙子";
    const view = buildRevisionView(oldMd, newMd);
    // 同一 list 块配对为 modified、词级内联
    expect(view.stats.del).toBeGreaterThan(0);
    expect(view.stats.ins).toBeGreaterThan(0);
    const plain = stripRevisionSentinels(view.mergedMd);
    expect(plain).toContain("苹果");
    expect(plain).toContain("橙子");
  });

  it("代码块修改 → 整块 modified、不掺哨兵进围栏", () => {
    const oldMd = "前文\n\n```js\nconst a = 1;\n```\n";
    const newMd = "前文\n\n```js\nconst a = 2;\n```\n";
    const view = buildRevisionView(oldMd, newMd);
    const codeMark = view.blockMarks.find((m) => m.status === "modified");
    expect(codeMark).toBeTruthy();
    expect(codeMark!.oldSource).toContain("const a = 1");
    // 合并 md 里的 code 围栏本体不应含哨兵
    const fence = view.mergedMd.match(/```js[\s\S]*?```/);
    expect(fence).toBeTruthy();
    expect(fence![0]).not.toContain(INS_OPEN);
    expect(fence![0]).not.toContain(DEL_OPEN);
    expect(fence![0]).toContain("const a = 2");
  });

  it("表格修改 → 整块标记", () => {
    const oldMd = "| A | B |\n| - | - |\n| 1 | 2 |\n";
    const newMd = "| A | B |\n| - | - |\n| 1 | 9 |\n";
    const view = buildRevisionView(oldMd, newMd);
    // remark-parse 无 gfm 时 table 可能是 paragraph；有 gfm 才是 table。
    // 本库只用 remark-parse：表格会当普通段落词级 diff——仍应有增删统计。
    // 若未来接 gfm，则走 blockMarks modified。两种都接受「有 diff 信号」。
    const hasSignal =
      view.blockMarks.some((m) => m.status === "modified") ||
      view.stats.ins + view.stats.del > 0;
    expect(hasSignal).toBe(true);
    expect(stripRevisionSentinels(view.mergedMd)).toMatch(/9|2/);
  });

  it("含链接与加粗的段落改动保留结构", () => {
    const oldMd = "请看 **重要** [文档](https://example.com/a) 了解详情。";
    const newMd = "请阅读 **重要** [文档](https://example.com/a) 了解更多。";
    const view = buildRevisionView(oldMd, newMd);
    const stripped = stripRevisionSentinels(view.mergedMd);
    expect(stripped).toContain("**重要**");
    expect(stripped).toContain("[文档](https://example.com/a)");
    expect(view.stats.ins + view.stats.del).toBeGreaterThan(0);
  });

  it("纯新增块", () => {
    const oldMd = "第一段。";
    const newMd = "第一段。\n\n第二段新增。";
    const view = buildRevisionView(oldMd, newMd);
    expect(view.blockMarks.some((m) => m.status === "added")).toBe(true);
    expect(view.stats.ins).toBeGreaterThan(0);
    expect(stripRevisionSentinels(view.mergedMd)).toContain("第二段新增");
  });

  it("纯删除块", () => {
    const oldMd = "保留。\n\n将被删除。";
    const newMd = "保留。";
    const view = buildRevisionView(oldMd, newMd);
    expect(view.blockMarks.some((m) => m.status === "removed")).toBe(true);
    expect(view.stats.del).toBeGreaterThan(0);
    expect(stripRevisionSentinels(view.mergedMd)).toContain("将被删除");
  });

  it("mermaid 围栏修改 → 复杂块标记、围栏无哨兵", () => {
    const oldMd = "```mermaid\ngraph LR\nA-->B\n```";
    const newMd = "```mermaid\ngraph LR\nA-->C\n```";
    const view = buildRevisionView(oldMd, newMd);
    expect(view.blockMarks).toEqual([
      expect.objectContaining({
        status: "modified",
        oldSource: expect.stringContaining("A-->B"),
      }),
    ]);
    expect(view.mergedMd).toContain("A-->C");
    expect(view.mergedMd).not.toContain(INS_OPEN);
  });

  it("math 块（$$）修改走复杂或内联均可，但要有变更信号", () => {
    // remark-parse 默认把 $$ 当 paragraph；仍应检出文本差
    const oldMd = "$$\na + b\n$$";
    const newMd = "$$\na + c\n$$";
    const view = buildRevisionView(oldMd, newMd);
    expect(view.stats.ins + view.stats.del > 0 || view.blockMarks.length > 0).toBe(
      true,
    );
  });

  it("段落改成段落+列表 → blockMarks index 与顶层块对齐", () => {
    const oldMd = "请注意以下事项：苹果和香蕉都要准备齐全。";
    const newMd = "请注意以下事项：\n\n- 苹果\n- 香蕉";
    const view = buildRevisionView(oldMd, newMd);
    const top = countTopBlocks(view.mergedMd);
    expect(top).toBeGreaterThanOrEqual(2);
    const indices = view.blockMarks.map((m) => m.index);
    expect(indices.length).toBeGreaterThan(0);
    for (const idx of indices) {
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(top);
    }
    // 每个 mark 对应唯一块下标，避免哨兵多块拆分导致错位复用
    expect(new Set(indices).size).toBe(indices.length);
  });

  it("词级内联成功的 modified 也写 blockMarks（角标 / 左边条）", () => {
    const view = buildRevisionView("今天天气很好。", "今天天气不错。");
    expect(view.mergedMd).toContain(DEL_OPEN);
    expect(view.mergedMd).toContain(INS_OPEN);
    const mod = view.blockMarks.find((m) => m.status === "modified");
    expect(mod).toBeTruthy();
    expect(mod!.oldSource).toContain("很好");
    expect(mod!.index).toBe(0);
    expect(countTopBlocks(view.mergedMd)).toBe(1);
  });

  it("fingerprint 区分链接 url / 标题层级 / list 有序性", () => {
    const linkDiff = buildRevisionView(
      "[x](https://a.com)",
      "[x](https://b.com)",
    );
    expect(linkDiff.blockMarks.length).toBeGreaterThan(0);
    expect(linkDiff.stats.ins + linkDiff.stats.del).toBeGreaterThan(0);

    const headingDiff = buildRevisionView("# 标题", "## 标题");
    expect(headingDiff.blockMarks.length).toBeGreaterThan(0);

    const listDiff = buildRevisionView("- 苹果\n- 香蕉", "1. 苹果\n2. 香蕉");
    expect(listDiff.blockMarks.length).toBeGreaterThan(0);
  });

  it("相邻 list remove+add：blockMarks 与渲染顶层块数一致", () => {
    const oldMd = "- 苹果\n- 香蕉";
    const newMd = "- 葡萄\n- 西瓜";
    const view = buildRevisionView(oldMd, newMd);
    const top = countTopBlocks(view.mergedMd);
    // 旧实现 \n\n 拼接两段 list → CommonMark 合成 1 块、marks 却占 2 个 index
    expect(top).toBeGreaterThanOrEqual(2);
    expect(view.blockMarks.length).toBeGreaterThanOrEqual(2);
    for (const m of view.blockMarks) {
      expect(m.index).toBeGreaterThanOrEqual(0);
      expect(m.index).toBeLessThan(top);
    }
    expect(new Set(view.blockMarks.map((m) => m.index)).size).toBe(
      view.blockMarks.length,
    );
    expect(view.blockMarks.some((m) => m.status === "removed")).toBe(true);
    expect(view.blockMarks.some((m) => m.status === "added")).toBe(true);
    const plain = stripRevisionSentinels(view.mergedMd);
    expect(plain).toContain("葡萄");
    expect(plain).toContain("西瓜");
    expect(plain).toContain("苹果");
  });

  it("超大文档 → degraded 块级修订、无词级哨兵", () => {
    // 少块 + 大体积：避免数千块 DP 把单测拖慢，只触发长度闸
    const chunk = `${"占位".repeat(40_000)}\n\n`;
    const oldMd = chunk.repeat(2);
    const newMd = `${chunk.repeat(2)}额外新增一段。\n\n`;
    expect(oldMd.length + newMd.length).toBeGreaterThan(200_000);
    const view = buildRevisionView(oldMd, newMd);
    expect(view.stats.degraded).toBe(true);
    expect(view.mergedMd).not.toContain(INS_OPEN);
    expect(view.mergedMd).not.toContain(DEL_OPEN);
    expect(view.blockMarks.some((m) => m.status === "added")).toBe(true);
  });
});

// ---------- 修订视图评审 P1 回归（块指纹 / 哨兵污染 / 标题深度 / 对齐性能） ----------

type TestNode = {
  type: string;
  value?: string;
  depth?: number;
  ordered?: boolean | null;
  url?: string;
  title?: string | null;
  alt?: string | null;
  lang?: string | null;
  meta?: string | null;
  children?: TestNode[];
};

const SENTINEL_CHARS = /[\uE000-\uE004]/;

const parseTree = (md: string): TestNode =>
  unified().use(remarkParse).parse(md) as unknown as TestNode;

/** 深度遍历收集满足条件的节点 */
const collectNodes = (
  tree: TestNode,
  pred: (n: TestNode) => boolean,
  acc: TestNode[] = [],
): TestNode[] => {
  if (pred(tree)) acc.push(tree);
  tree.children?.forEach((c) => collectNodes(c, pred, acc));
  return acc;
};

/** 合并 md 里所有围栏代码块的 value（带哨兵原样返回，用来断言有没有泄漏） */
const codeValues = (mergedMd: string): string[] =>
  collectNodes(parseTree(mergedMd), (n) => n.type === "code").map(
    (n) => n.value ?? "",
  );

describe("块指纹：纳入行内格式 / 嵌套深度 / 围栏语言（原先判 equal 的改动现在要有标记）", () => {
  const expectModified = (oldMd: string, newMd: string) => {
    const view = buildRevisionView(oldMd, newMd);
    expect(view.blockMarks.some((m) => m.status === "modified")).toBe(true);
    // 工具栏 +/− 不能是 0/0（块已标 modified）
    expect(view.stats.ins + view.stats.del).toBeGreaterThan(0);
    // 合并 md 里不残留哨兵（纯格式改动按块标记、不插词级哨兵）
    expect(view.mergedMd).not.toMatch(SENTINEL_CHARS);
    return view;
  };

  it("强调标记变化：`**关键**` → 关键", () => {
    const view = expectModified("这是**关键**步骤", "这是关键步骤");
    // 渲染的是新版原文，旧版原文在 oldSource 里
    expect(view.mergedMd).toContain("这是关键步骤");
    expect(view.blockMarks[0]!.oldSource).toBe("这是**关键**步骤");
  });

  it("强调种类变化：*斜体* → **加粗**、行内代码去掉反引号", () => {
    expectModified("请先执行 *build* 再发布", "请先执行 **build** 再发布");
    expectModified("请先执行 `build` 再发布", "请先执行 build 再发布");
  });

  it("链接目标变化（文字不变）→ 保持新版链接结构、不被压成纯文本", () => {
    const view = expectModified(
      "详见 [文档](https://a.example.com/doc) 说明",
      "详见 [文档](https://b.example.com/doc) 说明",
    );
    const links = collectNodes(
      parseMergedWithRevisionPlugin(view.mergedMd),
      (n) => n.type === "link",
    );
    expect(links.length).toBe(1);
  });

  it("列表缩进变子项（嵌套深度变化）", () => {
    const view = expectModified("- a\n- b\n- c", "- a\n  - b\n- c");
    // 渲染的是新版结构：确实有嵌套 list
    const lists = collectNodes(parseTree(view.mergedMd), (n) => n.type === "list");
    expect(lists.length).toBe(2);
  });

  it("嵌套子列表有序性变化", () => {
    expectModified("- a\n  - b\n  - c", "- a\n  1. b\n  2. c");
  });

  it("代码围栏语言 js → ts（代码本体不变）", () => {
    const view = expectModified(
      "```js\nconst a = 1;\n```",
      "```ts\nconst a = 1;\n```",
    );
    expect(view.blockMarks[0]!.oldSource).toContain("```js");
    expect(view.mergedMd).toContain("```ts");
  });

  it("代码缩进变化也算改动（Python / YAML 缩进有语义）", () => {
    expectModified(
      "```python\nif x:\n    run()\n```",
      "```python\nif x:\n  run()\n```",
    );
  });

  it("标题层级变化（文字不变）→ 渲染为新层级标题、不带字面 #", () => {
    const view = expectModified("# 标题", "## 标题");
    const tree = parseTree(view.mergedMd);
    expect(tree.children!.map((c) => `${c.type}${c.depth ?? ""}`)).toEqual([
      "heading2",
    ]);
  });

  it("纯写法差异（渲染结果相同）仍判 equal、不误标", () => {
    // 斜体 * / _、加粗 ** / __、无序列表 - / *、ATX / setext 标题
    // （`_` 强调不能紧贴 CJK 字符，否则是字面下划线，所以两侧留空格）
    for (const [o, n] of [
      ["这是 *重点* 内容", "这是 _重点_ 内容"],
      ["这是 **重点** 内容", "这是 __重点__ 内容"],
      ["* 苹果\n* 香蕉", "- 苹果\n- 香蕉"],
      ["标题\n====", "# 标题"],
    ] as const) {
      const view = buildRevisionView(o, n);
      expect(view.blockMarks, `${o} → ${n}`).toEqual([]);
      expect(view.stats).toEqual({ ins: 0, del: 0 });
    }
  });
});

describe("嵌套在列表 / 引用里的围栏代码不被词级哨兵污染", () => {
  const listWithCode = (cmd: string, tail = "启动服务") =>
    `1. 安装依赖：\n\n   \`\`\`bash\n   ${cmd}\n   \`\`\`\n\n2. ${tail}`;

  it("列表内代码块被修改 → 围栏里没有哨兵，代码是新版原文", () => {
    const view = buildRevisionView(
      listWithCode("pnpm install"),
      listWithCode("pnpm add foo"),
    );
    const values = codeValues(view.mergedMd);
    expect(values).toEqual(["pnpm add foo"]);
    for (const v of values) expect(v).not.toMatch(SENTINEL_CHARS);
    // 过一遍渲染插件后（渲染 / 复制命令的数据源）同样干净
    const rendered = collectNodes(
      parseMergedWithRevisionPlugin(view.mergedMd),
      (n) => n.type === "code",
    );
    expect(rendered.map((n) => n.value)).toEqual(["pnpm add foo"]);
    // 这块仍要有修订标记（整块 modified，旧版原文可看）
    const mod = view.blockMarks.find((m) => m.status === "modified");
    expect(mod?.oldSource).toContain("pnpm install");
    expect(view.stats.ins + view.stats.del).toBeGreaterThan(0);
  });

  it("引用内代码块被修改 → 同样无哨兵", () => {
    const quote = (cmd: string) => `> 注意：\n>\n> \`\`\`sh\n> ${cmd}\n> \`\`\`\n`;
    const view = buildRevisionView(quote("rm -rf build"), quote("rm -rf dist"));
    const values = codeValues(view.mergedMd);
    expect(values).toEqual(["rm -rf dist"]);
    expect(view.mergedMd).not.toMatch(SENTINEL_CHARS);
  });

  it("列表内代码块没变、只改了文字 → 仍保留词级内联，代码块完好", () => {
    const view = buildRevisionView(
      listWithCode("pnpm install", "启动服务"),
      listWithCode("pnpm install", "重启服务"),
    );
    // 词级哨兵只落在文字上
    expect(view.mergedMd).toContain(INS_OPEN);
    expect(view.mergedMd).toContain(DEL_OPEN);
    expect(codeValues(view.mergedMd)).toEqual(["pnpm install"]);
    expect(view.blockMarks.some((m) => m.status === "modified")).toBe(true);
  });

  it("列表内代码块整个被删掉 → 无哨兵泄漏进任何代码块", () => {
    const view = buildRevisionView(
      listWithCode("pnpm install"),
      "1. 安装依赖：\n\n2. 启动服务",
    );
    for (const v of codeValues(view.mergedMd)) {
      expect(v).not.toMatch(SENTINEL_CHARS);
    }
    const rendered = collectNodes(
      parseMergedWithRevisionPlugin(view.mergedMd),
      (n) => n.type === "code",
    );
    for (const n of rendered) expect(n.value).not.toMatch(SENTINEL_CHARS);
  });
});

describe("词级合并后首块类型 / 深度校验（不通过退回整块替换）", () => {
  /** 过插件后顶层块的「类型+层级」序列 */
  const topShape = (mergedMd: string) =>
    parseMergedWithRevisionPlugin(mergedMd).children!.map(
      (c) => `${c.type}${c.depth ?? ""}`,
    );

  it("`# 标题` 改成 `## 标题`（文字也有改动）→ 不出现带字面 # 的普通段落", () => {
    const view = buildRevisionView(
      "# Quarterly sales review plan",
      "## Quarterly sales review summary",
    );
    const tree = parseMergedWithRevisionPlugin(view.mergedMd);
    const paragraphs = collectNodes(tree, (n) => n.type === "paragraph");
    expect(paragraphs).toEqual([]);
    // 整块替换：旧标题 removed + 新标题 added，层级各自正确
    expect(topShape(view.mergedMd)).toEqual(["heading1", "heading2"]);
    expect(view.blockMarks.map((m) => m.status)).toEqual(["removed", "added"]);
    expect(view.mergedMd).not.toMatch(SENTINEL_CHARS);
  });

  it("无序列表改有序列表（文字也有改动）→ 仍是 list、无字面 `1.` 段落", () => {
    const view = buildRevisionView(
      "- apple pie recipe with cream\n- banana bread recipe with nuts",
      "1. apple pie recipe with cream\n2. banana bread guide with nuts",
    );
    const tree = parseMergedWithRevisionPlugin(view.mergedMd);
    // 顶层不能出现普通段落（list item 里的 paragraph 是正常的，所以只看顶层）
    expect(tree.children!.filter((c) => c.type === "paragraph")).toEqual([]);
    // 整块替换：旧 list（removed）+ 相邻 list 分隔注释（html）+ 新有序 list（added）
    expect(topShape(view.mergedMd)).toEqual(["list", "html", "list"]);
    expect(view.blockMarks.map((m) => m.status)).toEqual(["removed", "added"]);
    const lists = tree.children!.filter((c) => c.type === "list");
    expect(lists.map((l) => l.ordered)).toEqual([false, true]);
    // 字面 `1.` / `-` 不能漏进任何文本节点
    const literalMarkers = collectNodes(
      tree,
      (n) => n.type === "text" && /^\s*(1\.|-)\s/.test(n.value ?? ""),
    );
    expect(literalMarkers).toEqual([]);
    expect(view.mergedMd).not.toMatch(SENTINEL_CHARS);
  });

  it("同层级标题只改文字 → 仍走词级内联（不退化）", () => {
    const view = buildRevisionView(
      "## Quarterly sales review plan",
      "## Quarterly sales review summary",
    );
    expect(view.mergedMd).toContain(INS_OPEN);
    expect(view.mergedMd).toContain(DEL_OPEN);
    expect(topShape(view.mergedMd)).toEqual(["heading2"]);
    expect(view.blockMarks).toEqual([
      expect.objectContaining({ index: 0, status: "modified" }),
    ]);
  });
});

describe("对齐性能与降级", () => {
  const para = (i: number, tag: string) =>
    `第${i}段${tag}：这是一段用于性能回归的较长中文文本，包含 several English words 和标点，编号 ${i * 7919}。`;
  const doc = (tag: string, n: number) =>
    Array.from({ length: n }, (_, i) => para(i, tag)).join("\n\n");

  it("300 段稿子只改一处：裁掉公共前后缀后只剩 1 块参与对齐、结果正确", () => {
    const oldMd = doc("甲", 300);
    const newMd = oldMd.replace("第150段甲", "第150段乙");
    const t0 = performance.now();
    const view = buildRevisionView(oldMd, newMd);
    const cost = performance.now() - t0;
    expect(view.blockMarks).toEqual([
      expect.objectContaining({ index: 150, status: "modified" }),
    ]);
    // 修复前同输入约 6~7s（逐对相似度 + 每次 new Intl.Segmenter）；放宽到 3s 防 CI 抖动
    expect(cost).toBeLessThan(3000);
  });

  it("300 段整体改写（同类型指纹全不同）也在可接受时间内、index 对齐", () => {
    const oldMd = doc("甲", 300);
    const newMd = doc("丙", 300);
    const t0 = performance.now();
    const view = buildRevisionView(oldMd, newMd);
    const cost = performance.now() - t0;
    expect(cost).toBeLessThan(3000);
    const top = countTopBlocks(view.mergedMd);
    for (const m of view.blockMarks) expect(m.index).toBeLessThan(top);
    expect(new Set(view.blockMarks.map((m) => m.index)).size).toBe(
      view.blockMarks.length,
    );
  });

  it("多块超大文档：degraded 在对齐之前判定，不进相似度 DP（秒级完成）", () => {
    // 2000 块 × ~150 字 ≈ 30 万字符 > DEGRADE_CHAR_LIMIT；整体改写时二次方 DP 要跑数分钟
    const oldMd = doc("甲", 2000);
    const newMd = doc("丙", 2000);
    expect(oldMd.length + newMd.length).toBeGreaterThan(200_000);
    const t0 = performance.now();
    const view = buildRevisionView(oldMd, newMd);
    const cost = performance.now() - t0;
    expect(view.stats.degraded).toBe(true);
    expect(view.mergedMd).not.toMatch(SENTINEL_CHARS);
    expect(view.blockMarks.length).toBeGreaterThan(0);
    expect(cost).toBeLessThan(15_000);
  }, 60_000);

  it("Intl.Segmenter 模块级单例：多次分词只 new 一次", async () => {
    const RealSegmenter = Intl.Segmenter;
    let created = 0;
    class CountingSegmenter extends RealSegmenter {
      constructor(...args: ConstructorParameters<typeof Intl.Segmenter>) {
        super(...args);
        created += 1;
      }
    }
    vi.resetModules();
    (Intl as { Segmenter: typeof Intl.Segmenter }).Segmenter =
      CountingSegmenter as unknown as typeof Intl.Segmenter;
    try {
      const fresh = await import("../src/lib/md-revision");
      fresh.buildRevisionView(doc("甲", 40), doc("丙", 40));
      fresh.buildRevisionView(doc("丙", 20), doc("丁", 20));
      expect(created).toBeLessThanOrEqual(1);
    } finally {
      (Intl as { Segmenter: typeof Intl.Segmenter }).Segmenter = RealSegmenter;
      vi.resetModules();
    }
  });
});

describe("remarkSentinelToRevision", () => {
  it("哨兵全部被插件消费、不泄漏到文本节点", () => {
    // 用同段小改（Jaccard 高）确保走词级哨兵路径
    const oldMd = "今天天气很好。";
    const newMd = "今天天气不错。";
    const view = buildRevisionView(oldMd, newMd);
    expect(view.mergedMd).toMatch(new RegExp(`[${INS_OPEN}${DEL_OPEN}]`));
    const tree = parseMergedWithRevisionPlugin(view.mergedMd);
    expect(treeHasSentinelLeak(tree)).toBe(false);
    const nodes = collectRevisionNodes(tree);
    expect(nodes.some((n) => n.kind === "ins")).toBe(true);
    expect(nodes.some((n) => n.kind === "del")).toBe(true);
    // 字面量哨兵字符不应出现在 toString 汇总里（ins/del 内容已是净文本）
    const allText = JSON.stringify(tree);
    expect(allText).not.toContain(INS_OPEN);
    expect(allText).not.toContain(DEL_OPEN);
    expect(allText).not.toContain(INS_CLOSE);
    expect(allText).not.toContain(DEL_CLOSE);
  });

  it("链接旁的词级修订不破坏链接节点", () => {
    const oldMd = "见 [文档](https://ex.com) 旧述";
    const newMd = "见 [文档](https://ex.com) 新述";
    const view = buildRevisionView(oldMd, newMd);
    const tree = parseMergedWithRevisionPlugin(view.mergedMd);
    expect(treeHasSentinelLeak(tree)).toBe(false);
    // 应仍能找到 link
    const links: unknown[] = [];
    const walk = (n: { type: string; children?: unknown[]; url?: string }) => {
      if (n.type === "link") links.push(n);
      n.children?.forEach((c) => walk(c as typeof n));
    };
    walk(tree as never);
    expect(links.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------- 第二轮 review：哨兵配对 / 非 text 字段泄漏 / GFM / spread / 预算 / Segmenter 回退 ----------

/** 与渲染端口径一致（Streamdown defaultRemarkPlugins 含 gfm）的解析 */
const parseGfmTree = (md: string): TestNode =>
  unified().use(remarkParse).use(remarkGfm).parse(md) as unknown as TestNode;

/** 一段文本里的哨兵是否「开…闭」同类成对、不嵌套、无孤儿（独立于实现的另一份写法） */
const isPaired = (value: string): boolean => {
  let expectClose: string | null = null;
  for (const ch of value) {
    if (ch === INS_OPEN || ch === DEL_OPEN) {
      if (expectClose) return false;
      expectClose = ch === INS_OPEN ? INS_CLOSE : DEL_CLOSE;
    } else if (ch === INS_CLOSE || ch === DEL_CLOSE) {
      if (expectClose !== ch) return false;
      expectClose = null;
    }
  }
  return expectClose === null;
};

/** 合并 md（GFM 解析）里每个含哨兵的 text / inlineCode 节点是否都自己成对——跨节点的哨兵渲染端会静默吞掉 */
const textNodesBalanced = (mergedMd: string): boolean =>
  collectNodes(
    parseGfmTree(mergedMd),
    (n) =>
      (n.type === "text" || n.type === "inlineCode") &&
      SENTINEL_CHARS.test(n.value ?? ""),
  ).every((n) => isPaired(n.value ?? ""));

/** 合并 md（GFM 解析）里「插件不会消费」的字段（非 text / inlineCode 的 value，以及 url / title / alt / lang / meta）含哨兵的节点 */
const nonTextSentinelNodes = (mergedMd: string): TestNode[] =>
  collectNodes(parseGfmTree(mergedMd), (n) => {
    const rec = n as unknown as Record<string, unknown>;
    const fields = ["url", "title", "alt", "lang", "meta"].map((k) => rec[k]);
    if (n.type !== "text" && n.type !== "inlineCode") fields.push(n.value);
    return fields.some((v) => typeof v === "string" && SENTINEL_CHARS.test(v));
  });

const wordList = (n: number, seed: string): string[] =>
  Array.from(
    { length: n },
    (_, i) => `${seed}${((i * 2654435761) % 100003).toString(36)}`,
  );

describe("R1-18：哨兵必须成对落在同一个 text 节点（整项新增 / 删除不能让哨兵跨节点）", () => {
  const cases: Array<[string, string, string]> = [
    ["列表末尾新增整项", "- alpha one\n- beta two", "- alpha one\n- beta two\n- gamma three new item"],
    ["列表中间新增整项", "- alpha one\n- gamma three", "- alpha one\n- beta two inserted\n- gamma three"],
    ["列表新增嵌套子项", "- alpha one\n- beta two", "- alpha one\n  - child item new\n- beta two"],
    ["引用里新增整段", "> alpha one text", "> alpha one text\n>\n> beta two new para"],
    ["列表删除整项", "- alpha one\n- beta two\n- gamma three", "- alpha one\n- gamma three"],
    ["有序列表新增整项", "1. alpha one\n2. beta two", "1. alpha one\n2. beta two\n3. gamma three"],
  ];

  it.each(cases)("%s：合并 md 里没有跨 text 节点的哨兵", (_n, oldMd, newMd) => {
    const view = buildRevisionView(oldMd, newMd);
    expect(textNodesBalanced(view.mergedMd)).toBe(true);
    expect(view.blockMarks.length).toBeGreaterThan(0);
  });

  it("列表末尾新增整项：按块 modified（出新版原文、不插哨兵），+/− 统计不为 0", () => {
    const newMd = "- alpha one\n- beta two\n- gamma three new item";
    const view = buildRevisionView("- alpha one\n- beta two", newMd);
    expect(view.mergedMd).toBe(newMd);
    expect(view.blockMarks).toEqual([
      expect.objectContaining({
        index: 0,
        status: "modified",
        oldSource: "- alpha one\n- beta two",
      }),
    ]);
    expect(view.stats.ins).toBeGreaterThan(0);
  });

  it("不过度回退：单个列表项内改词 / 加粗内加字（哨兵成对在同一 text 节点）仍是词级内联", () => {
    const item = buildRevisionView("- alpha one\n- beta two", "- alpha one\n- beta twelve");
    expect(item.mergedMd).toContain(INS_OPEN);
    expect(item.mergedMd).toContain(DEL_OPEN);
    expect(textNodesBalanced(item.mergedMd)).toBe(true);
    const bold = buildRevisionView("alpha **one** end", "alpha **one two** end");
    expect(bold.mergedMd).toContain(INS_OPEN);
    expect(textNodesBalanced(bold.mergedMd)).toBe(true);
  });
});

describe("非 text 字段（code.value / html.value / link.title / image.alt·title / 自动链接 url）里的哨兵：检测得到，生产端整块回退、不擦哨兵", () => {
  const leak = (node: TestNode) =>
    treeHasSentinelLeak({ type: "root", children: [node] } as never);

  it("treeHasSentinelLeak 看得见 code.value / html.value / link.title / image.alt / image.title / lang / meta", () => {
    const dirty = `x${INS_OPEN}y${INS_CLOSE}`;
    expect(leak({ type: "code", value: dirty })).toBe(true);
    expect(leak({ type: "html", value: `<b title="${dirty}">` })).toBe(true);
    expect(leak({ type: "link", url: "https://a.com", title: dirty, children: [] })).toBe(true);
    expect(leak({ type: "image", url: "u.png", alt: dirty })).toBe(true);
    expect(leak({ type: "image", url: "u.png", alt: "a", title: dirty })).toBe(true);
    expect(leak({ type: "code", value: "ok", lang: dirty })).toBe(true);
    expect(leak({ type: "code", value: "ok", meta: dirty })).toBe(true);
    // 干净的节点不误报
    expect(leak({ type: "code", value: "ok", lang: "js", meta: "x" })).toBe(false);
    expect(leak({ type: "link", url: "https://a.com", title: "标题", children: [] })).toBe(false);
  });

  it("link.title 被词级 diff 碰到：整块替换（旧块 removed + 新块 added），两块各自完整、无哨兵", () => {
    const oldMd = '见 [文档](https://a.com "旧标题") 旧述';
    const newMd = '见 [文档](https://a.com "新标题") 新述';
    const view = buildRevisionView(oldMd, newMd);
    expect(view.mergedMd).not.toMatch(SENTINEL_CHARS);
    expect(view.blockMarks.map((m) => [m.index, m.status])).toEqual([
      [0, "removed"],
      [1, "added"],
    ]);
    const titles = collectNodes(parseGfmTree(view.mergedMd), (n) => n.type === "link").map((n) => n.title);
    expect(titles).toEqual(["旧标题", "新标题"]);
  });

  it("image.alt / image.title 被碰到：整块替换，图片节点完整保留、无哨兵", () => {
    const oldMd = '![旧图](u.png "旧标题") 旧述';
    const newMd = '![新图](u.png "新标题") 新述';
    const view = buildRevisionView(oldMd, newMd);
    expect(view.mergedMd).not.toMatch(SENTINEL_CHARS);
    expect(view.blockMarks.map((m) => m.status)).toEqual(["removed", "added"]);
    const images = collectNodes(parseGfmTree(view.mergedMd), (n) => n.type === "image");
    expect(images.map((n) => [n.alt, n.title])).toEqual([
      ["旧图", "旧标题"],
      ["新图", "新标题"],
    ]);
  });

  it("GFM 自动链接的 url 被碰到：整块替换，不让哨兵进 url、也不把链接静默拍平", () => {
    const oldMd = "详见 https://example.com/docs/old-page 这一页的旧述";
    const newMd = "详见 https://example.com/docs/new-page 这一页的新述";
    const view = buildRevisionView(oldMd, newMd);
    expect(nonTextSentinelNodes(view.mergedMd)).toEqual([]);
    expect(view.mergedMd).not.toMatch(SENTINEL_CHARS);
    const urls = collectNodes(parseGfmTree(view.mergedMd), (n) => n.type === "link").map((n) => n.url);
    expect(urls).toEqual([
      "https://example.com/docs/old-page",
      "https://example.com/docs/new-page",
    ]);
  });

  it("行内 html 属性被碰到：按块 modified（出新版原文），不是整块替换、无哨兵", () => {
    const newMd = '说明 <span title="新">文字</span> 新述';
    const view = buildRevisionView('说明 <span title="旧">文字</span> 旧述', newMd);
    expect(view.mergedMd).toBe(newMd);
    expect(view.blockMarks).toEqual([expect.objectContaining({ index: 0, status: "modified" })]);
  });
});

describe("SIGNATURE_FIELDS 含 spread：松散 / 紧凑列表是渲染差异", () => {
  it("紧凑 → 松散（文字不变）：标 modified、不插哨兵、统计不为 0", () => {
    const view = buildRevisionView("- a\n- b", "- a\n\n- b");
    expect(view.blockMarks).toEqual([expect.objectContaining({ index: 0, status: "modified" })]);
    expect(view.mergedMd).not.toMatch(SENTINEL_CHARS);
    expect(view.stats.ins + view.stats.del).toBeGreaterThan(0);
  });

  it("嵌套项的松散度变化（listItem.spread）也算改动", () => {
    const view = buildRevisionView("- a\n  - b\n- c", "- a\n\n  - b\n- c");
    expect(view.blockMarks.some((m) => m.status === "modified")).toBe(true);
  });

  it("纯写法差异（`-` vs `*` 标记）仍不误标", () => {
    const view = buildRevisionView("- a\n- b", "* a\n* b");
    expect(view.blockMarks).toEqual([]);
  });
});

describe("GFM 解析：表格不再被当成段落", () => {
  const table3 = ["| A | B |", "| - | - |", "| 1 | 2 |"].join("\n");

  it("表格新增一列：按块 modified、合并 md 与新版逐字相同（不再把哨兵塞进分隔行）", () => {
    const newMd = ["| A | B | C |", "| - | - | - |", "| 1 | 2 | 3 |"].join("\n");
    const view = buildRevisionView(table3, newMd);
    expect(view.mergedMd).toBe(newMd);
    expect(view.blockMarks).toEqual([
      expect.objectContaining({ index: 0, status: "modified", oldSource: table3 }),
    ]);
    expect(parseGfmTree(view.mergedMd).children?.map((n) => n.type)).toEqual(["table"]);
  });

  it("表格新增一行：按块 modified、无哨兵", () => {
    const newMd = `${table3}\n| 3 | 4 |`;
    const view = buildRevisionView(table3, newMd);
    expect(view.mergedMd).toBe(newMd);
    expect(view.blockMarks.map((m) => m.status)).toEqual(["modified"]);
  });

  it("表格在前：后面块的 blockMarks.index 与 GFM 顶层块序一致", () => {
    const view = buildRevisionView(
      `${table3}\n\n今天天气很好。`,
      `${table3.replace("| 1 | 2 |", "| 1 | 9 |")}\n\n今天天气不错。`,
    );
    expect(view.blockMarks.map((m) => [m.index, m.status])).toEqual([
      [0, "modified"],
      [1, "modified"],
    ]);
    expect(parseGfmTree(view.mergedMd).children).toHaveLength(2);
  });

  it("任务列表勾选变化（checked 在 GFM 下才解析出来）：标 modified、不插哨兵", () => {
    const view = buildRevisionView("- [ ] 写文档\n- [ ] 补测试", "- [ ] 写文档\n- [x] 补测试");
    expect(view.blockMarks.map((m) => m.status)).toEqual(["modified"]);
    expect(view.mergedMd).not.toMatch(SENTINEL_CHARS);
  });
});

describe("diffArrays 预算（maxEditLength）：最坏情况不能把主线程卡死", () => {
  const countBlocks = (md: string) => parseGfmTree(md).children?.length ?? 0;

  it("单个超长段落整体改写（≈6 万字符）：秒内出结果、降级为按块 modified、无哨兵、标记自洽", () => {
    // 修复前同输入约 5~6s（词级 Myers 的 D≈N，O(N·D)）；13 万字符实测 44s
    const oldMd = wordList(5000, "p").join(" ");
    const newMd = wordList(5000, "q").join(" ");
    const t0 = performance.now();
    const view = buildRevisionView(oldMd, newMd);
    const cost = performance.now() - t0;
    expect(cost).toBeLessThan(2500);
    expect(view.mergedMd).not.toMatch(SENTINEL_CHARS);
    expect(view.blockMarks).toEqual([expect.objectContaining({ index: 0, status: "modified" })]);
    expect(view.stats.degraded).toBe(true);
    expect(countBlocks(view.mergedMd)).toBe(1);
  }, 60_000);

  it("多个超长段落都被整体改写：预算按整次视图累计，总耗时仍有界", () => {
    // 6 段 × 2200 词：每段单独都超单次上限；没有累计预算时按段线性叠加（修复前 ≈8s）
    const para = (seed: string, k: number) =>
      wordList(2200, `${seed}${k}`).join(" ");
    const oldMd = Array.from({ length: 6 }, (_, k) => para("p", k)).join("\n\n");
    const newMd = Array.from({ length: 6 }, (_, k) => para("q", k)).join("\n\n");
    expect(oldMd.length + newMd.length).toBeLessThan(200_000);
    const t0 = performance.now();
    const view = buildRevisionView(oldMd, newMd);
    const cost = performance.now() - t0;
    expect(cost).toBeLessThan(3000);
    expect(view.stats.degraded).toBe(true);
    expect(view.mergedMd).not.toMatch(SENTINEL_CHARS);
    const top = countBlocks(view.mergedMd);
    expect(new Set(view.blockMarks.map((m) => m.index)).size).toBe(view.blockMarks.length);
    for (const m of view.blockMarks) expect(m.index).toBeLessThan(top);
  }, 60_000);

  it("大量小段整体改写（未触发 degraded、指纹 LCS 的编辑距离巨大）：不二次方、index 对齐", () => {
    // 6000 段：D≈12000，修复前指纹 Myers 约 5~10s（8000 段 8s+，随机器负载浮动）。
    // 修复后的固有开销（GFM 解析新旧各一遍 + 合并串硬校验再解析一遍 + 统计分词）约 2~3s，
    // 墙钟阈值放宽到 6s 只做回归兜底；「每次 diff 都带上限」由下一条确定性用例钉死
    const oldMd = wordList(6000, "p").join("\n\n");
    const newMd = wordList(6000, "q").join("\n\n");
    expect(oldMd.length + newMd.length).toBeLessThan(200_000);
    const t0 = performance.now();
    const view = buildRevisionView(oldMd, newMd);
    const cost = performance.now() - t0;
    expect(cost).toBeLessThan(6000);
    expect(view.mergedMd).not.toMatch(SENTINEL_CHARS);
    const top = countBlocks(view.mergedMd);
    expect(new Set(view.blockMarks.map((m) => m.index)).size).toBe(view.blockMarks.length);
    for (const m of view.blockMarks) expect(m.index).toBeLessThan(top);
    // 全部旧块 removed、全部新块 added（无一被误配成 modified）
    expect(view.blockMarks.filter((m) => m.status === "removed")).toHaveLength(6000);
    expect(view.blockMarks.filter((m) => m.status === "added")).toHaveLength(6000);
  }, 60_000);

  it("确定性：词级 diff 与指纹 LCS 两处的每一次 diffArrays 调用都带有限的 maxEditLength（不靠墙钟）", async () => {
    const calls: Array<number | undefined> = [];
    vi.resetModules();
    vi.doMock("diff", async () => {
      const real = await vi.importActual<typeof import("diff")>("diff");
      return {
        ...real,
        diffArrays: (
          a: unknown[],
          b: unknown[],
          opts?: { maxEditLength?: number },
        ) => {
          calls.push(opts?.maxEditLength);
          return real.diffArrays(a, b, opts as never);
        },
      };
    });
    try {
      const fresh = await import("../src/lib/md-revision");
      // 词级：同段小改
      fresh.buildRevisionView("今天天气很好。", "今天天气不错。");
      const callsAfterWord = calls.length;
      expect(callsAfterWord).toBeGreaterThan(0);
      // 指纹 LCS：裁掉公共前后缀后 450×450 = 20 万格 > 相似度 DP 上限（16 万）
      const para = (i: number, tag: string) =>
        `第${i}段${tag}：这是一段用于预算回归的较长中文文本，编号 ${i * 7919}。`;
      const doc = (tag: string) =>
        Array.from({ length: 450 }, (_, i) => para(i, tag)).join("\n\n");
      fresh.buildRevisionView(doc("甲"), doc("丙"));
      expect(calls.length).toBeGreaterThan(callsAfterWord);
      for (const c of calls) {
        expect(typeof c).toBe("number");
        expect(c).toBeGreaterThan(0);
        expect(c).toBeLessThanOrEqual(3000);
      }
    } finally {
      vi.doUnmock("diff");
      vi.resetModules();
    }
  }, 60_000);

  it("预算内的正常改动不受影响：超长段落只改几个词仍是词级内联、不降级", () => {
    const words = wordList(800, "w");
    const oldMd = words.join(" ");
    const edited = [...words];
    edited[100] = "改一";
    edited[400] = "改二";
    edited[700] = "改三";
    const view = buildRevisionView(oldMd, edited.join(" "));
    expect(view.mergedMd).toContain(INS_OPEN);
    expect(view.mergedMd).toContain(DEL_OPEN);
    expect(textNodesBalanced(view.mergedMd)).toBe(true);
    expect(view.stats.degraded).toBeUndefined();
    // 3 处改词：分词器可能把一个词切成多个 token，不钉具体个数，只确认是「几处」而不是整段
    expect(view.stats.ins).toBeGreaterThanOrEqual(3);
    expect(view.stats.ins).toBeLessThanOrEqual(12);
    expect(view.stats.del).toBeGreaterThanOrEqual(3);
    expect(view.stats.del).toBeLessThanOrEqual(12);
  });
});

describe("Intl.Segmenter 不可用时的回退（SSR / 极老环境）", () => {
  it("无 Segmenter：正则分词回退仍产出词级修订，且「不可用」只探测一次（单例缓存 null）", async () => {
    const original = Object.getOwnPropertyDescriptor(Intl, "Segmenter");
    let reads = 0;
    Object.defineProperty(Intl, "Segmenter", {
      configurable: true,
      get() {
        reads += 1;
        return undefined;
      },
    });
    vi.resetModules();
    try {
      const fresh = await import("../src/lib/md-revision");
      const zh = fresh.buildRevisionView("今天天气很好。", "今天天气不错。");
      // 回退切法：连续 CJK 逐字、其余按空白 / 非空白串
      expect(zh.mergedMd).toContain(`${fresh.DEL_OPEN}很好${fresh.DEL_CLOSE}`);
      expect(zh.mergedMd).toContain(`${fresh.INS_OPEN}不错${fresh.INS_CLOSE}`);
      expect(zh.stats).toEqual({ ins: 2, del: 2 });
      const en = fresh.buildRevisionView("hello world foo", "hello brave world foo");
      expect(en.mergedMd).toContain(`${fresh.INS_OPEN}brave `);
      // 多次构建、多次分词，只探测一次
      fresh.buildRevisionView("第一段内容。\n\n第二段内容。", "第一段内容。\n\n第二段新内容。");
      expect(reads).toBeLessThanOrEqual(1);
    } finally {
      if (original) Object.defineProperty(Intl, "Segmenter", original);
      vi.resetModules();
    }
  });
});