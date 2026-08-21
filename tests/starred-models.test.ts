import { describe, expect, it } from "vitest";

import {
  parseStarredModels,
  starredIdsForProvider,
  toggleStarredModelId,
} from "@/lib/starred-models";

describe("starred-models", () => {
  it("每个提供方最多两个、去重保序", () => {
    expect(
      starredIdsForProvider(
        { cursor: ["a", "a", "b", "c"], cp_1: ["x"] },
        "cursor",
      ),
    ).toEqual(["a", "b"]);
    expect(parseStarredModels({ cursor: ["a", 1, "b"] })).toEqual({
      cursor: ["a", "b"],
    });
  });

  it("点星钉住、再点取消；满两个再钉新的不动", () => {
    const one = toggleStarredModelId({}, "cursor", "composer-2.5");
    expect(one.starred).toBe(true);
    expect(one.next.cursor).toEqual(["composer-2.5"]);

    const two = toggleStarredModelId(one.next, "cursor", "grok-4.5");
    expect(two.next.cursor).toEqual(["composer-2.5", "grok-4.5"]);

    const full = toggleStarredModelId(two.next, "cursor", "opus");
    expect(full.full).toBe(true);
    expect(full.next.cursor).toEqual(["composer-2.5", "grok-4.5"]);

    const off = toggleStarredModelId(two.next, "cursor", "composer-2.5");
    expect(off.starred).toBe(false);
    expect(off.next.cursor).toEqual(["grok-4.5"]);
  });

  it("不同提供方各记各的两个", () => {
    const a = toggleStarredModelId({}, "cursor", "composer-2.5");
    const b = toggleStarredModelId(a.next, "cp_1", "qwen3.7-plus");
    expect(b.next.cursor).toEqual(["composer-2.5"]);
    expect(b.next.cp_1).toEqual(["qwen3.7-plus"]);
  });
});
