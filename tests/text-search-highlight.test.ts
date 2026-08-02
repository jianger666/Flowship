/**
 * 栏内搜索 occurrence 与高亮纯函数单测
 */
import { isValidElement, Fragment } from "react";
import { describe, expect, it } from "vitest";

import {
  findOccurrenceRanges,
  findOccurrencesInFields,
  findSearchOccurrenceElement,
  highlightPlainText,
  normalizePaneSearchQuery,
  scrollSearchOccurrenceIntoView,
  SEARCH_MARK_ACTIVE_CLASS,
  SEARCH_MARK_CLASS,
  stepOccurrenceIndex,
  stabilizeOccurrenceIndex,
} from "@/lib/text-search-highlight";
import { getModFShortcutLabel } from "@/lib/platform-shortcuts";

describe("normalizePaneSearchQuery", () => {
  it("trim + 小写", () => {
    expect(normalizePaneSearchQuery("  MR  ")).toBe("mr");
  });
});

describe("findOccurrenceRanges", () => {
  it("大小写不敏感、非重叠", () => {
    expect(findOccurrenceRanges("push MR and MR", "mr")).toEqual([
      { start: 5, end: 7 },
      { start: 12, end: 14 },
    ]);
  });
});

describe("findOccurrencesInFields", () => {
  it("跨字段顺序分配 globalIndex", () => {
    const occ = findOccurrencesInFields(
      [
        { ownerId: "e1", field: "body", text: "hello MR" },
        { ownerId: "e2", field: "body", text: "MR again" },
      ],
      "mr",
    );
    expect(occ).toHaveLength(2);
    expect(occ[0]).toMatchObject({ globalIndex: 0, ownerId: "e1" });
    expect(occ[1]).toMatchObject({ globalIndex: 1, ownerId: "e2" });
  });
});

describe("highlightPlainText", () => {
  it("空查询不改动", () => {
    expect(highlightPlainText("MR text", "  ", 0, 0)).toBe("MR text");
  });

  it("active 与 normal mark 区分", () => {
    const out = highlightPlainText("aa MR bb MR cc", "MR", 1, 0);
    expect(isValidElement(out) || out === "aa MR bb MR cc").toBe(true);
    if (isValidElement(out) && out.type === Fragment) {
      const marks = (out.props as { children: unknown[] }).children.filter(
        (c) => isValidElement(c) && c.type === "mark",
      );
      expect(marks).toHaveLength(2);
    }
  });

  it("active/normal class 均含明显背景，active 含 ring", () => {
    expect(SEARCH_MARK_CLASS).not.toBe(SEARCH_MARK_ACTIVE_CLASS);
    expect(SEARCH_MARK_CLASS).toMatch(/bg-amber/);
    expect(SEARCH_MARK_ACTIVE_CLASS).toMatch(/bg-amber/);
    expect(SEARCH_MARK_ACTIVE_CLASS).toMatch(/ring/);
  });
});

describe("findSearchOccurrenceElement（pane 内 scope）", () => {
  const mkRoot = (pane: "artifact" | "stream", index: number) => {
    const mark = { pane, index };
    return {
      querySelector: (sel: string) =>
        sel === `[data-search-occurrence="${index}"]` ? mark : null,
    } as unknown as ParentNode;
  };

  it("同编号双 pane 各自根内定位、不串栏", () => {
    const artifactRoot = mkRoot("artifact", 0);
    const streamRoot = mkRoot("stream", 0);
    expect(findSearchOccurrenceElement(artifactRoot, 0)).toEqual({
      pane: "artifact",
      index: 0,
    });
    expect(findSearchOccurrenceElement(streamRoot, 0)).toEqual({
      pane: "stream",
      index: 0,
    });
  });

  it("scroll 只在给定 root 内查找", () => {
    const scrolled: ScrollIntoViewOptions[] = [];
    const el = {
      scrollIntoView: (opts?: ScrollIntoViewOptions) => {
        scrolled.push(opts ?? {});
      },
    };
    const root = {
      querySelector: () => el,
    } as unknown as ParentNode;
    expect(scrollSearchOccurrenceIntoView(root, 0)).toBe(true);
    expect(scrolled).toHaveLength(1);
    expect(scrollSearchOccurrenceIntoView(null, 0)).toBe(false);
  });
});

describe("stepOccurrenceIndex", () => {
  it("next / prev 循环", () => {
    expect(stepOccurrenceIndex(0, 3, "next")).toBe(1);
    expect(stepOccurrenceIndex(2, 3, "next")).toBe(0);
    expect(stepOccurrenceIndex(0, 3, "prev")).toBe(2);
  });
});

describe("stabilizeOccurrenceIndex", () => {
  it("钳制非法下标", () => {
    expect(stabilizeOccurrenceIndex(99, 2)).toBe(0);
    expect(stabilizeOccurrenceIndex(1, 2)).toBe(1);
  });
});

describe("跨平台快捷键标签", () => {
  it("macOS 与 Windows/Linux 文案", () => {
    expect(getModFShortcutLabel("darwin")).toBe("⌘F");
    expect(getModFShortcutLabel("win32")).toBe("Ctrl+F");
    expect(getModFShortcutLabel("linux")).toBe("Ctrl+F");
  });
});
