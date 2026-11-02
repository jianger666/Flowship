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

describe("findOccurrenceRanges：toLowerCase 改变长度时偏移要映射回原文", () => {
  // "İ".toLowerCase() === "i̇"（2 个码元），整串小写后下标会比原文靠后
  const I_DOT = "\u0130";

  it("İ 在命中前：命中区间按原文偏移、能切回原词", () => {
    const text = `${I_DOT}${I_DOT}abc`;
    const ranges = findOccurrenceRanges(text, "abc");
    expect(ranges).toEqual([{ start: 2, end: 5 }]);
    expect(text.slice(ranges[0].start, ranges[0].end)).toBe("abc");
  });

  it("命中本身包含 İ：区间覆盖整个原字符", () => {
    const text = `x${I_DOT}y`;
    const ranges = findOccurrenceRanges(text, `${I_DOT}y`);
    expect(ranges.length).toBe(1);
    expect(text.slice(ranges[0].start, ranges[0].end)).toBe(`${I_DOT}y`);
  });

  it("查询词带 İ 时区间长度按原文计，不是小写后的 q.length", () => {
    const text = `a${I_DOT}b`;
    const ranges = findOccurrenceRanges(text, I_DOT);
    expect(ranges).toEqual([{ start: 1, end: 2 }]);
  });

  it("多处命中、中间夹 İ：每处都对得上原文", () => {
    const text = `foo ${I_DOT} foo ${I_DOT}${I_DOT} FOO`;
    const ranges = findOccurrenceRanges(text, "foo");
    expect(ranges.map((r) => text.slice(r.start, r.end))).toEqual(["foo", "foo", "FOO"]);
  });

  it("区间不越界、不重叠、严格递增", () => {
    const text = `${I_DOT}i${I_DOT}i${I_DOT}`;
    const ranges = findOccurrenceRanges(text, "i");
    let prevEnd = 0;
    for (const r of ranges) {
      expect(r.start).toBeGreaterThanOrEqual(prevEnd);
      expect(r.end).toBeGreaterThan(r.start);
      expect(r.end).toBeLessThanOrEqual(text.length);
      prevEnd = r.end;
    }
  });

  it("长度不变的普通文本（含中文 / emoji）行为不变", () => {
    expect(findOccurrenceRanges("你好 Hello 😀 hello", "hello")).toEqual([
      { start: 3, end: 8 },
      { start: 12, end: 17 },
    ]);
  });
});
