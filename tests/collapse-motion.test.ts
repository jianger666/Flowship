/**
 * 折叠体动效阶段机（lib/collapse-motion）：首次挂载不播动画、收起先动画后卸载、
 * 收到一半反向、「减少动态效果」直接跳阶段。DOM 接线在 components/tasks/event-stream/collapse.tsx
 * （源码契约见 tests/event-stream-smooth-contract.test.ts）。
 */
import { describe, expect, it } from "vitest";

import {
  COLLAPSE_END_SLACK_MS,
  COLLAPSE_MOTION_MS,
  collapseIsAnimating,
  collapseMounted,
  collapseOnEnd,
  collapseOnFrame,
  collapseRowsExpanded,
  initialCollapsePhase,
  stepCollapse,
  type CollapsePhase,
} from "@/lib/collapse-motion";

const ALL: CollapsePhase[] = [
  "closed",
  "enter-from",
  "entering",
  "open",
  "leaving",
];

describe("initialCollapsePhase：首次挂载不播动画", () => {
  it("已展开的行滚进视口直接是 open、折叠的直接是 closed（Virtuoso 里行会反复挂载）", () => {
    expect(initialCollapsePhase(true)).toBe("open");
    expect(initialCollapsePhase(false)).toBe("closed");
  });
});

describe("stepCollapse：想开 / 想关 → 下一阶段", () => {
  it("展开：closed → enter-from（先画 0fr 起跑线）→ entering → open", () => {
    expect(stepCollapse("closed", true, false)).toBe("enter-from");
    expect(collapseOnFrame("enter-from")).toBe("entering");
    expect(collapseOnEnd("entering")).toBe("open");
  });

  it("收起：open → leaving → closed（先动画、后卸载）", () => {
    expect(stepCollapse("open", false, false)).toBe("leaving");
    expect(collapseOnEnd("leaving")).toBe("closed");
  });

  it("展开到一半被收：entering → leaving；收到一半被展开：leaving → entering（从当前高度反向、不跳）", () => {
    expect(stepCollapse("entering", false, false)).toBe("leaving");
    expect(stepCollapse("leaving", true, false)).toBe("entering");
  });

  it("还没来得及起跑（enter-from）就被收：直接卸载", () => {
    expect(stepCollapse("enter-from", false, false)).toBe("closed");
  });

  it("目标没变时不动（幂等：渲染期每次都会算一遍）", () => {
    for (const p of ALL) {
      const openWant = stepCollapse(p, true, false);
      expect(stepCollapse(openWant, true, false)).toBe(openWant);
      const closeWant = stepCollapse(p, false, false);
      expect(stepCollapse(closeWant, false, false)).toBe(closeWant);
    }
    expect(stepCollapse("open", true, false)).toBe("open");
    expect(stepCollapse("closed", false, false)).toBe("closed");
  });

  it("「减少动态效果」：open ↔ closed 直接跳，永远不进过渡中间态（transitionend 不会来）", () => {
    expect(stepCollapse("closed", true, true)).toBe("open");
    expect(stepCollapse("leaving", true, true)).toBe("open");
    expect(stepCollapse("open", false, true)).toBe("closed");
    expect(stepCollapse("entering", false, true)).toBe("closed");
  });
});

describe("阶段谓词", () => {
  it("只有 closed 不挂子树", () => {
    expect(ALL.filter((p) => !collapseMounted(p))).toEqual(["closed"]);
  });

  it("过渡中 = entering / leaving（要 transition 类、要 overflow:hidden、要 inert）", () => {
    expect(ALL.filter(collapseIsAnimating)).toEqual(["entering", "leaving"]);
  });

  it("目标行高：entering / open = 1fr；enter-from / leaving = 0fr", () => {
    expect(ALL.filter(collapseRowsExpanded)).toEqual(["entering", "open"]);
  });

  it("collapseOnFrame / collapseOnEnd 对其它阶段是空操作", () => {
    for (const p of ALL) {
      if (p !== "enter-from") expect(collapseOnFrame(p)).toBe(p);
      if (p !== "entering" && p !== "leaving") expect(collapseOnEnd(p)).toBe(p);
    }
  });
});

describe("时长常量", () => {
  it("兜底余量为正：transitionend 不来也要收尾", () => {
    expect(COLLAPSE_MOTION_MS).toBeGreaterThan(0);
    expect(COLLAPSE_END_SLACK_MS).toBeGreaterThan(0);
  });
});
