/**
 * 日期范围选择器：第一下只记锚点、第二下才提交（评审：点第一下就提交并关闭，选不了单日）。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { resolveRangeClick } from "@/lib/date-range-click";

const D = (n: number) => new Date(2026, 10, n).getTime();

describe("resolveRangeClick", () => {
  it("没有锚点：第一下只记锚点，不提交", () => {
    expect(resolveRangeClick(null, D(5))).toEqual({ kind: "anchor", anchor: D(5) });
  });
  it("第二下在锚点之后 → from=锚点、to=点击日", () => {
    expect(resolveRangeClick(D(5), D(9))).toEqual({ kind: "commit", from: D(5), to: D(9) });
  });
  it("第二下在锚点之前 → 自动交换，不出现 from > to", () => {
    expect(resolveRangeClick(D(9), D(5))).toEqual({ kind: "commit", from: D(5), to: D(9) });
  });
  it("两下点同一天 = 单日区间（旧实现选不了单日）", () => {
    expect(resolveRangeClick(D(7), D(7))).toEqual({ kind: "commit", from: D(7), to: D(7) });
  });
});

describe("DateRangePicker 接线（源码）", () => {
  const src = readFileSync(
    path.join(process.cwd(), "src/components/ui/date-range-picker.tsx"),
    "utf8",
  );
  it("提交走 onDayClick + resolveRangeClick；不再用库的 onSelect 提交（第一下就会提交）", () => {
    expect(src).toContain("onDayClick={(day) => {");
    expect(src).toContain("resolveRangeClick(anchor, day0(day))");
    expect(src).not.toContain("onSelect=");
  });
  it("弹层关闭 / 提交时清掉锚点与半选态，下次打开从头选", () => {
    expect(src.match(/setAnchor\(null\)/g)?.length).toBeGreaterThanOrEqual(2);
  });
});
