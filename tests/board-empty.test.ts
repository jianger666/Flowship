/**
 * Q9-05：空看板刷新期间不得显示「这个时间段没有排期」。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { boardEmptyKind } from "@/lib/board-empty";

describe("boardEmptyKind", () => {
  it("空看板 + 正在刷新 → loading（旧：立刻画「没有排期」）", () => {
    expect(boardEmptyKind({ rowCount: 0, refreshing: true })).toBe("loading");
  });
  it("空看板 + 刷新结束仍为空 → 才下「没有排期」的结论", () => {
    expect(boardEmptyKind({ rowCount: 0, refreshing: false })).toBe("empty");
  });
  it("反例（旧行为保留）：有数据时不论是否刷新都照画旧数据，不换成加载态", () => {
    expect(boardEmptyKind({ rowCount: 3, refreshing: true })).toBe("none");
    expect(boardEmptyKind({ rowCount: 3, refreshing: false })).toBe("none");
  });
  it("接线（补充）：feishu-board 把 refreshing 传给 BoardTimeline，空态分支走 boardEmptyKind", () => {
    const root = process.cwd();
    const board = readFileSync(path.join(root, "src/components/feishu/feishu-board.tsx"), "utf8");
    const tl = readFileSync(path.join(root, "src/components/feishu/board-timeline.tsx"), "utf8");
    expect(board).toMatch(/<BoardTimeline[\s\S]{0,200}refreshing=\{refreshing\}/);
    expect(tl).toContain("boardEmptyKind(");
    expect(tl).toContain("正在查询排期");
  });
});
