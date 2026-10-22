/**
 * 第三轮 review D3-01 / D3-02 / D3-03 / D3-07：事件流搜索的命中身份、模型/DOM 口径、解析缓存。
 *
 * 全部走真实管线：`searchEventStreamRenderOccurrences`（真实 mdast 解析 + 分段）+
 * `stabilizeOccurrenceSelection`（页面里「新事件到达后找回选中项」用的同一个函数）。
 */
import { describe, expect, it } from "vitest";

import {
  searchEventStreamRenderOccurrences,
  stabilizeOccurrenceSelection,
  type EventStreamSearchRenderItem,
} from "@/lib/event-stream-search";
import { DOM_SEARCH_IGNORE_SELECTOR } from "@/lib/dom-text-search";
import {
  markdownToSearchableFields,
  markdownVisibleSegmentsCacheStats,
} from "@/lib/markdown-visible-search";
import { searchOccurrenceIdentity } from "@/lib/text-search-highlight";

const asst = (id: string, text: string): EventStreamSearchRenderItem => ({
  id,
  kind: "assistant_message",
  text,
});
const info = (id: string): EventStreamSearchRenderItem => ({
  id,
  kind: "info",
  text: "无关事件",
});

// 3 个列表项 + 表格：每个文本节点里各有一个「测试」，第一个命中的段内偏移都是 0 或相同值
const MULTI_SEGMENT = [
  "- 测试一",
  "- 测试二",
  "- 测试三",
  "",
  "| 列 | 值 |",
  "| --- | --- |",
  "| 测试 | 测试 |",
].join("\n");

describe("D3-01：多段回复的命中身份唯一，追加无关事件后选中项不被拽回 #1", () => {
  it("一条回复 5 个命中 → 5 个互不相同的身份（旧实现全是 a1|body|0）", () => {
    const occ = searchEventStreamRenderOccurrences([asst("a1", MULTI_SEGMENT)], "测试");
    expect(occ.length).toBe(5);
    const ids = occ.map(searchOccurrenceIdentity);
    expect(new Set(ids).size).toBe(5);
  });

  it("用户停在 #2~#5 → 追加无关事件 / 新回复后重算：选中的仍是同一处（不是 #1）", () => {
    const before = [asst("a1", MULTI_SEGMENT)];
    const prev = searchEventStreamRenderOccurrences(before, "测试");
    for (let k = 0; k < prev.length; k++) {
      const after = [...before, info("e2"), asst("a2", "又一条，没有关键字")];
      const next = searchEventStreamRenderOccurrences(after, "测试");
      expect(stabilizeOccurrenceSelection(prev, k, next)).toBe(k);
    }
  });

  it("性质：200 个随机多条回复 × 每个选中位置，追加事件（含在选中项**之前**插入一条有命中的回复）后身份找回正确", () => {
    let seed = 12345;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0x100000000;
    };
    const piece = () => {
      const r = rnd();
      if (r < 0.3) return "- 测试项";
      if (r < 0.5) return "普通段落带 **测试** 加粗";
      if (r < 0.7) return "`测试` 行内代码";
      return "没有命中的一段";
    };
    for (let round = 0; round < 200; round++) {
      const nMsgs = 1 + Math.floor(rnd() * 4);
      const items: EventStreamSearchRenderItem[] = [];
      for (let m = 0; m < nMsgs; m++) {
        const nPieces = 1 + Math.floor(rnd() * 5);
        const body = Array.from({ length: nPieces }, piece).join("\n\n");
        items.push(asst(`a${m}`, body));
      }
      const prev = searchEventStreamRenderOccurrences(items, "测试");
      if (prev.length === 0) continue;
      // 身份在同一次结果里唯一
      expect(new Set(prev.map(searchOccurrenceIdentity)).size).toBe(prev.length);
      const extra = [...items, info("x"), asst("tail", "- 测试尾")];
      const next = searchEventStreamRenderOccurrences(extra, "测试");
      for (let k = 0; k < prev.length; k++) {
        const idx = stabilizeOccurrenceSelection(prev, k, next);
        expect(searchOccurrenceIdentity(next[idx]!)).toBe(searchOccurrenceIdentity(prev[k]!));
      }
    }
  });

  it("单段纯文本字段（无 segment）的身份行为不变：同 (owner, field, start) 才算同一处", () => {
    const prev = [
      { globalIndex: 0, ownerId: "a", field: "body", start: 0, end: 1 },
      { globalIndex: 1, ownerId: "a", field: "body", start: 5, end: 6 },
    ];
    const next = [
      { globalIndex: 0, ownerId: "z", field: "body", start: 0, end: 1 },
      ...prev.map((o) => ({ ...o, globalIndex: o.globalIndex + 1 })),
    ];
    expect(stabilizeOccurrenceSelection(prev, 1, next)).toBe(2);
  });
});

describe("D3-02：模型不计 DOM 永远搜不到的东西（image alt / mermaid 围栏），代码块语言标签不进模型", () => {
  const fieldsText = (md: string): string[] =>
    markdownToSearchableFields(md, "a", "body").map((f) => f.text);

  it("图片 alt 不计（DOM 里只有 <img alt>，没有文本节点）", () => {
    expect(fieldsText("![图里有 foo](x.png) 正文")).toEqual([" 正文"]);
    expect(searchEventStreamRenderOccurrences([asst("a", "![foo](x.png)")], "foo")).toEqual([]);
  });

  it("mermaid 围栏不计（渲染成 svg 图；DOM 侧整块忽略），普通 / 无语言围栏照计", () => {
    const md = "```mermaid\ngraph TD; foo-->bar\n```\n\n```ts\nconst foo = 1\n```\n\n```\nfoo plain\n```";
    expect(fieldsText(md)).toEqual(["const foo = 1", "foo plain"]);
  });

  it("语言标签不是模型字段：围栏的 lang（ts / js / json / bash）不会被计数", () => {
    const occ = searchEventStreamRenderOccurrences(
      [asst("a", "```ts\nconst x = 1\n```")],
      "ts",
    );
    expect(occ).toEqual([]);
  });

  it("DOM 侧忽略 Streamdown 的代码块头 / mermaid 块 / KaTeX 的 MathML 副本；原有忽略项不回归", () => {
    for (const sel of [
      '[data-streamdown="code-block-header"]',
      '[data-streamdown="mermaid-block"]',
      ".katex-mathml",
      "[data-pane-search-ignore]",
      "script",
      '[aria-hidden="true"]',
    ]) {
      expect(DOM_SEARCH_IGNORE_SELECTOR.split(",")).toContain(sel);
    }
  });
});

describe("D3-03：搜索开着时敲查询词 / 吐字帧不再重解析全部已载入回复", () => {
  it("N 条回复：第一次搜解析 N 次；换 5 个查询词再搜 → 解析次数不增", () => {
    const items = Array.from({ length: 40 }, (_, i) =>
      asst(`cache${i}`, `# 标题 ${i}\n\n- 缓存测试条目 ${i} alpha\n- beta ${i}`),
    );
    const s0 = markdownVisibleSegmentsCacheStats();
    searchEventStreamRenderOccurrences(items, "alpha");
    const s1 = markdownVisibleSegmentsCacheStats();
    expect(s1.parses - s0.parses).toBe(40);
    for (const q of ["beta", "标题", "缓存", "zzz", "alpha 1"]) {
      searchEventStreamRenderOccurrences(items, q);
    }
    const s2 = markdownVisibleSegmentsCacheStats();
    expect(s2.parses).toBe(s1.parses);
  });

  it("流式吐字：只有正在流的那一条每帧重解析，其余 N-1 条命中缓存", () => {
    const base = Array.from({ length: 30 }, (_, i) => asst(`s${i}`, `稳定回复 ${i} 内容 gamma`));
    searchEventStreamRenderOccurrences(base, "gamma");
    const before = markdownVisibleSegmentsCacheStats().parses;
    let streamText = "";
    for (let frame = 0; frame < 10; frame++) {
      streamText += `字${frame}`;
      searchEventStreamRenderOccurrences(
        [...base, { id: "__streaming__", kind: "__streaming__", text: streamText }],
        "gamma",
      );
    }
    expect(markdownVisibleSegmentsCacheStats().parses - before).toBe(10);
  });

  it("缓存有界：灌入超过上限的不同文本，规模不超过 limit", () => {
    const lim = markdownVisibleSegmentsCacheStats().limit;
    for (let i = 0; i < lim + 50; i++) {
      markdownToSearchableFields(`bounded-${i}`, "o", "body");
    }
    expect(markdownVisibleSegmentsCacheStats().size).toBeLessThanOrEqual(lim);
  });

  it("缓存不串 owner：同一文本换 ownerId / field，结果带各自的 owner", () => {
    const a = markdownToSearchableFields("相同文本 foo", "owner1", "body");
    const b = markdownToSearchableFields("相同文本 foo", "owner2", "extra0");
    expect(a[0]?.ownerId).toBe("owner1");
    expect(b[0]?.ownerId).toBe("owner2");
    expect(b[0]?.field).toBe("extra0");
    expect(a[0]?.text).toBe(b[0]?.text);
  });
});
