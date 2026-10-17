/**
 * 吐字截取终点别劈开代理对（emoji / 生僻字）：按 UTF-16 码元硬切会让上屏那一帧出现半个字符（�）。
 */
import { describe, expect, it } from "vitest";

import { safeSliceEnd } from "@/components/tasks/use-smooth-streaming";

describe("safeSliceEnd", () => {
  it("普通字符原样", () => {
    expect(safeSliceEnd("hello world", 5)).toBe(5);
    expect(safeSliceEnd("你好世界", 2)).toBe(2);
  });

  it("终点落在 emoji 中间 → 多带一个码元、整个字符一起上屏", () => {
    const text = "ab😀cd"; // 😀 占 index 2、3
    expect(safeSliceEnd(text, 3)).toBe(4);
    expect(text.slice(0, safeSliceEnd(text, 3))).toBe("ab😀");
    // 终点本来就在 emoji 之后 / 之前：不动
    expect(safeSliceEnd(text, 4)).toBe(4);
    expect(safeSliceEnd(text, 2)).toBe(2);
  });

  it("边界：0 / 到末尾 / 越界不动", () => {
    expect(safeSliceEnd("😀", 0)).toBe(0);
    expect(safeSliceEnd("ab", 2)).toBe(2);
    expect(safeSliceEnd("ab", 5)).toBe(5);
  });
});
