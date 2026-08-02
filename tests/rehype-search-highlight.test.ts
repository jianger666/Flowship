/**
 * rehype 搜索高亮行为单测（直接断言 HAST 输出）
 */
import { describe, expect, it } from "vitest";

import {
  applyRehypeSearchHighlightToTree,
  type HastNode,
} from "@/lib/rehype-search-highlight";
import {
  SEARCH_MARK_ACTIVE_CLASS,
  SEARCH_MARK_CLASS,
} from "@/lib/text-search-highlight";
import {
  collectMarkdownVisibleTextSegments,
  markdownToMdast,
  searchMarkdownVisibleContent,
} from "@/lib/markdown-visible-search";
import { findOccurrencesInFields } from "@/lib/text-search-highlight";

const p = (text: string): HastNode => ({
  type: "element",
  tagName: "p",
  children: [{ type: "text", value: text }],
});

const collectMarks = (node: HastNode): HastNode[] => {
  const marks: HastNode[] = [];
  const walk = (n: HastNode): void => {
    if (n.tagName === "mark") marks.push(n);
    n.children?.forEach(walk);
  };
  walk(node);
  return marks;
};

describe("applyRehypeSearchHighlightToTree", () => {
  it("空查询不插入 mark", () => {
    const tree = p("hello MR");
    applyRehypeSearchHighlightToTree(tree, {
      query: "  ",
      activeGlobalIndex: 0,
      globalOffset: 0,
    });
    expect(collectMarks(tree)).toHaveLength(0);
  });

  it("命中插入 mark、active/normal class 与 data-search-occurrence", () => {
    const tree: HastNode = {
      type: "root",
      children: [p("aa MR bb MR cc")],
    };
    applyRehypeSearchHighlightToTree(tree, {
      query: "MR",
      activeGlobalIndex: 1,
      globalOffset: 0,
    });
    const marks = collectMarks(tree);
    expect(marks).toHaveLength(2);
    expect(marks[0]?.properties?.className).toBe(SEARCH_MARK_CLASS);
    expect(marks[0]?.properties?.dataSearchOccurrence).toBe("0");
    expect(marks[1]?.properties?.className).toBe(SEARCH_MARK_ACTIVE_CLASS);
    expect(marks[1]?.properties?.dataSearchOccurrence).toBe("1");
  });

  it("关闭搜索（空 query）后树无 mark", () => {
    const tree = p("MR only");
    applyRehypeSearchHighlightToTree(tree, {
      query: "",
      activeGlobalIndex: -1,
      globalOffset: 0,
    });
    expect(collectMarks(tree)).toHaveLength(0);
  });
});

describe("markdown visible search 与 HAST 高亮对齐", () => {
  it("链接 URL 含 MR、可见标题不含 → 0 结果", () => {
    const md = "[标题](https://hidden.example/MR)";
    expect(searchMarkdownVisibleContent(md, "MR")).toHaveLength(0);
  });

  it("可见标题含 MR → 计数与 rehype mark 一致", () => {
    const md = "段落 MR\n\n[标题 MR](https://hidden.example/nope)";
    const occ = searchMarkdownVisibleContent(md, "MR");
    expect(occ).toHaveLength(2);

    const segments = collectMarkdownVisibleTextSegments(markdownToMdast(md));
    const tree: HastNode = {
      type: "root",
      children: segments.map((value) => ({
        type: "element",
        tagName: "p",
        children: [{ type: "text", value }],
      })),
    };
    const highlighted = applyRehypeSearchHighlightToTree(tree, {
      query: "MR",
      activeGlobalIndex: 1,
      globalOffset: 0,
    });
    expect(collectMarks(highlighted)).toHaveLength(2);
    expect(
      findOccurrencesInFields(
        segments.map((text) => ({ ownerId: "a", field: "body", text })),
        "MR",
      ),
    ).toHaveLength(2);
  });

  it("覆盖标题/列表/表格/inline code", () => {
    const md = [
      "# Head MR",
      "",
      "- list MR",
      "",
      "inline `code MR`",
      "",
      "| col |",
      "| --- |",
      "| cell MR |",
    ].join("\n");
    const occ = searchMarkdownVisibleContent(md, "MR");
    expect(occ.length).toBeGreaterThanOrEqual(4);
  });
});
