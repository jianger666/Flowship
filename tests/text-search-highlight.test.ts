/**
 * 栏内搜索 occurrence 纯函数单测（行内 <mark> 高亮管线已在 D3-07 清掉，高亮走 DOM CSS Highlight）
 */
import { describe, expect, it } from "vitest";

import {
  findOccurrenceRanges,
  findOccurrencesInFields,
  normalizePaneSearchQuery,
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
