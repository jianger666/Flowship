import { describe, expect, it } from "vitest";
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
