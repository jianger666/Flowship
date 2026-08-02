import { describe, expect, it } from "vitest";

import {
  ownerOccurrenceIndexAt,
} from "@/lib/dom-text-search";

describe("DOM 栏内搜索导航", () => {
  it("把全局命中换算为 owner 内命中序号", () => {
    const occurrences = [
      { ownerId: "a" },
      { ownerId: "a" },
      { ownerId: "b" },
      { ownerId: "a" },
    ];
    expect(ownerOccurrenceIndexAt(occurrences, 0)).toBe(0);
    expect(ownerOccurrenceIndexAt(occurrences, 1)).toBe(1);
    expect(ownerOccurrenceIndexAt(occurrences, 2)).toBe(0);
    expect(ownerOccurrenceIndexAt(occurrences, 3)).toBe(2);
    expect(ownerOccurrenceIndexAt(occurrences, -1)).toBe(-1);
  });
});
