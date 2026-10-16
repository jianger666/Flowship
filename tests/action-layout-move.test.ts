/**
 * S13-21：Action / 分组排序除拖拽外要有键盘可达的上移 / 下移。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { moveKeyBy } from "@/lib/action-layout";

describe("moveKeyBy", () => {
  it("上移 / 下移交换相邻两项", () => {
    expect(moveKeyBy(["a", "b", "c"], "b", -1)).toEqual(["b", "a", "c"]);
    expect(moveKeyBy(["a", "b", "c"], "b", 1)).toEqual(["a", "c", "b"]);
  });

  it("越界 / 不存在 → 返回原引用（调用方据此判断没动）", () => {
    const list = ["a", "b"];
    expect(moveKeyBy(list, "a", -1)).toBe(list);
    expect(moveKeyBy(list, "b", 1)).toBe(list);
    expect(moveKeyBy(list, "x", 1)).toBe(list);
  });

  it("不改入参", () => {
    const list = ["a", "b", "c"];
    moveKeyBy(list, "a", 1);
    expect(list).toEqual(["a", "b", "c"]);
  });
});

describe("action-layout-config 接线契约", () => {
  const src = readFileSync(
    path.resolve(
      import.meta.dirname,
      "../src/components/custom-actions/action-layout-config.tsx",
    ),
    "utf-8",
  );
  it("行内上移 / 下移按钮带 aria-label + 边界禁用", () => {
    expect(src).toContain("aria-label={`上移 ${label}`}");
    expect(src).toContain("aria-label={`下移 ${label}`}");
    expect(src).toContain("disabled={!canMoveUp}");
    expect(src).toContain("disabled={!canMoveDown}");
  });
  it("组头同样有上移 / 下移分组", () => {
    expect(src).toContain("上移分组");
    expect(src).toContain("下移分组");
  });
  it("移动后立即落盘（不等 dragEnd）", () => {
    expect(src).toContain("persist(nextOrder, layout.hidden);");
    expect(src).toContain("persist(nextOrder, layout.hidden, { groupOrder: nextGroups })");
  });
});
