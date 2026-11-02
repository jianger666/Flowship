/**
 * 选区浮动按钮定位（评审：长选区顶边滚出视口时按钮落在视口之外够不着；
 * 选区拖到容器外松手时按钮不出现）。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  SELECTION_FLOAT_MIN_EDGE,
  SELECTION_FLOAT_MIN_VIEWPORT_TOP,
  computeSelectionFloatPosition,
} from "@/components/ui/selection-float";

const container = { top: -300, left: 100, width: 600 };

describe("computeSelectionFloatPosition", () => {
  it("选区顶边在视口内：贴选区顶边、水平居中（行为不变）", () => {
    const pos = computeSelectionFloatPosition(
      { top: 200, bottom: 230, left: 300, width: 100 },
      container,
    );
    expect(pos).toEqual({ top: 200 - container.top, left: 300 - container.left + 50 });
  });

  it("长选区顶边已滚出视口：锚点夹到视口顶部以下（相对容器换算），不再落在视口外", () => {
    const pos = computeSelectionFloatPosition(
      { top: -500, bottom: 400, left: 300, width: 100 },
      container,
    );
    // 视口 y = MIN_VIEWPORT_TOP → 相对容器 = MIN_VIEWPORT_TOP - container.top
    expect(pos.top).toBe(SELECTION_FLOAT_MIN_VIEWPORT_TOP - container.top);
  });

  it("夹取不越过选区底边（选区很矮且贴着视口顶：按钮仍跟着选区、不飘到别处）", () => {
    const pos = computeSelectionFloatPosition(
      { top: 10, bottom: 30, left: 300, width: 100 },
      container,
    );
    expect(pos.top).toBe(30 - container.top);
  });

  it("水平夹在容器左右边内：选区靠最左 / 最右时按钮不会被容器裁掉一半", () => {
    const leftEdge = computeSelectionFloatPosition(
      { top: 200, bottom: 230, left: 100, width: 10 },
      container,
    );
    expect(leftEdge.left).toBe(SELECTION_FLOAT_MIN_EDGE);
    const rightEdge = computeSelectionFloatPosition(
      { top: 200, bottom: 230, left: 690, width: 10 },
      container,
    );
    expect(rightEdge.left).toBe(container.width - SELECTION_FLOAT_MIN_EDGE);
  });

  it("容器窄到两侧留白放不下时放中间（不抛、不出现负宽区间）", () => {
    const pos = computeSelectionFloatPosition(
      { top: 200, bottom: 230, left: 105, width: 10 },
      { top: 0, left: 100, width: 60 },
    );
    expect(pos.left).toBe(30);
  });
});

describe("接线（源码）", () => {
  const src = readFileSync(
    path.join(process.cwd(), "src/components/ui/selection-float.tsx"),
    "utf8",
  );
  it("document 上兜 mouseup：选区拖到容器外松手也能出按钮；容器内的交给容器自己（不重复触发）", () => {
    expect(src).toContain('document.addEventListener("mouseup", onDocumentMouseUp)');
    expect(src).toContain('document.removeEventListener("mouseup", onDocumentMouseUp)');
    expect(src).toMatch(/container\.contains\(e\.target\)\) return;\s*handleMouseUp\(\);/);
  });
  it("定位走 computeSelectionFloatPosition，不再内联 rect.top - containerRect.top", () => {
    expect(src).toContain("computeSelectionFloatPosition(rect, containerRect)");
    expect(src).not.toContain("top: rect.top - containerRect.top");
  });
});
