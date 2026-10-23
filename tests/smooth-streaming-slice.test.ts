/**
 * 吐字截取终点别劈开代理对（emoji / 生僻字）：按 UTF-16 码元硬切会让上屏那一帧出现半个字符（�）。
 */
import { describe, expect, it } from "vitest";

import { readFileSync } from "node:fs";
import path from "node:path";

import {
  planForegroundCatchUp,
  safeSliceEnd,
} from "@/components/tasks/use-smooth-streaming";

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

describe("planForegroundCatchUp（回到前台直接追平，评审 N6）", () => {
  it("后台期间攒了字（目标串 + 合帧队列）→ 并起来、标记需要跳到末尾", () => {
    expect(planForegroundCatchUp("hello", " world", 5)).toEqual({
      target: "hello world",
      changed: true,
    });
    expect(planForegroundCatchUp("hello world", "", 5)).toEqual({
      target: "hello world",
      changed: true,
    });
  });

  it("本来就追平 / 什么都没有 → 不需要动（不 setState）", () => {
    expect(planForegroundCatchUp("hello", "", 5).changed).toBe(false);
    expect(planForegroundCatchUp("", "", 0).changed).toBe(false);
  });

  it("契约：hook 监听 document 的 visibilitychange、卸载时摘同一个处理函数、只在可见时处理", () => {
    const src = readFileSync(
      path.resolve(
        import.meta.dirname,
        "..",
        "src/components/tasks/use-smooth-streaming.ts",
      ),
      "utf-8",
    );
    expect(src).toContain(
      'document.addEventListener("visibilitychange", onVisibilityChange);',
    );
    expect(src).toContain(
      'document.removeEventListener("visibilitychange", onVisibilityChange)',
    );
    expect(src).toContain('if (document.visibilityState !== "visible") return;');
    expect(src).toContain("planForegroundCatchUp(");
  });
});
