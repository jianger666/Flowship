/**
 * S13-22：甘特今天线过零点自动更新——零点计算纯函数 + 接线契约。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { msUntilNextLocalMidnight, startOfLocalDay } from "@/lib/day-boundary";

describe("day-boundary", () => {
  it("startOfLocalDay：同一天任意时刻 → 同一个 0 点", () => {
    const noon = new Date(2026, 9, 13, 12, 30).getTime();
    const late = new Date(2026, 9, 13, 23, 59, 59).getTime();
    expect(startOfLocalDay(noon)).toBe(new Date(2026, 9, 13).getTime());
    expect(startOfLocalDay(late)).toBe(startOfLocalDay(noon));
  });

  it("msUntilNextLocalMidnight：到下个零点（+少量余量）", () => {
    const now = new Date(2026, 9, 13, 23, 59, 0).getTime();
    const ms = msUntilNextLocalMidnight(now);
    expect(ms).toBeGreaterThanOrEqual(60_000);
    expect(ms).toBeLessThanOrEqual(60_000 + 100);
    // 定时器到点后算出的 0 点必须是新的一天
    expect(startOfLocalDay(now + ms)).toBe(new Date(2026, 9, 14).getTime());
  });

  it("恰在零点：等满一天而不是 0（防空转）", () => {
    const now = new Date(2026, 9, 14, 0, 0, 0).getTime();
    expect(msUntilNextLocalMidnight(now)).toBeGreaterThan(20 * 3600 * 1000);
  });
});

describe("接线契约", () => {
  const read = (p: string) =>
    readFileSync(path.resolve(import.meta.dirname, "..", p), "utf-8");
  it("甘特用 useTodayStart，不再 useMemo([]) 冻结今天", () => {
    const src = read("src/components/feishu/board-timeline.tsx");
    expect(src).toContain("useTodayStart()");
    expect(src).not.toMatch(/today0 = useMemo/);
  });
  it("hook 卸载清理定时器与监听", () => {
    const src = read("src/hooks/use-today-start.ts");
    expect(src).toContain("clearTimeout(timer)");
    expect(src).toContain('removeEventListener("visibilitychange"');
  });
});
