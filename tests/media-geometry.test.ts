/**
 * 悬浮窗几何（media-geometry）：夹进视口 / 默认外框 / 拖动 / 缩放
 */
import { describe, expect, it } from "vitest";

import type { DockGeometry } from "@/lib/media/media-memory";
import {
  DOCK_MARGIN,
  DOCK_MIN_H,
  DOCK_MIN_W,
  clampGeometry,
  defaultGeometry,
  moveGeometry,
  resizeGeometry,
  type ResizeEdge,
  type Viewport,
} from "@/lib/media/media-geometry";

const VP: Viewport = { width: 1280, height: 800 };
const M = DOCK_MARGIN;

const right = (g: DockGeometry) => g.x + g.w;
const bottom = (g: DockGeometry) => g.y + g.h;
const insideViewport = (g: DockGeometry, vp: Viewport) =>
  g.x >= M && g.y >= M && right(g) <= vp.width - M && bottom(g) <= vp.height - M;

describe("clampGeometry", () => {
  it("已经在视口内：原样返回", () => {
    const g = { x: 100, y: 100, w: 400, h: 300 };
    expect(clampGeometry(g, VP)).toEqual(g);
  });

  it("位置越界：夹回四边各留 16px", () => {
    expect(clampGeometry({ x: -50, y: -50, w: 400, h: 300 }, VP)).toEqual({ x: M, y: M, w: 400, h: 300 });
    expect(clampGeometry({ x: 5000, y: 5000, w: 400, h: 300 }, VP)).toEqual({
      x: VP.width - 400 - M,
      y: VP.height - 300 - M,
      w: 400,
      h: 300,
    });
  });

  it("贴边的边界值本身有效（x = 16、右边 = 视口宽 - 16）", () => {
    const g = { x: M, y: M, w: VP.width - 2 * M, h: VP.height - 2 * M };
    expect(clampGeometry(g, VP)).toEqual(g);
  });

  it("尺寸太小：抬到最小 300×200", () => {
    expect(clampGeometry({ x: 100, y: 100, w: 10, h: 10 }, VP)).toEqual({
      x: 100,
      y: 100,
      w: DOCK_MIN_W,
      h: DOCK_MIN_H,
    });
  });

  it("尺寸太大：压到视口减两侧边距", () => {
    const out = clampGeometry({ x: 0, y: 0, w: 9999, h: 9999 }, VP);
    expect(out).toEqual({ x: M, y: M, w: VP.width - 2 * M, h: VP.height - 2 * M });
  });

  it("尺寸变化后位置按新尺寸再夹（右下角不会冒出视口）", () => {
    const out = clampGeometry({ x: 1000, y: 700, w: 600, h: 400 }, VP);
    expect(out.w).toBe(600);
    expect(out.h).toBe(400);
    expect(right(out)).toBe(VP.width - M);
    expect(bottom(out)).toBe(VP.height - M);
  });

  it("视口比最小尺寸还小：以视口为准，不再硬撑 300×200", () => {
    const small: Viewport = { width: 200, height: 150 };
    const out = clampGeometry({ x: 0, y: 0, w: 500, h: 500 }, small);
    expect(out.w).toBe(small.width - 2 * M);
    expect(out.h).toBe(small.height - 2 * M);
    expect(out.x).toBe(M);
    expect(out.y).toBe(M);
  });

  it("NaN 坐标 / 尺寸不会传染：落到边距与最小尺寸", () => {
    const out = clampGeometry({ x: Number.NaN, y: Number.NaN, w: Number.NaN, h: Number.NaN }, VP);
    expect(out).toEqual({ x: M, y: M, w: DOCK_MIN_W, h: DOCK_MIN_H });
  });

  it("不改动入参", () => {
    const g = { x: -10, y: -10, w: 10, h: 10 };
    clampGeometry(g, VP);
    expect(g).toEqual({ x: -10, y: -10, w: 10, h: 10 });
  });
});

describe("defaultGeometry", () => {
  it("音频：固定 440×330，贴右下角", () => {
    expect(defaultGeometry("audio", null, VP)).toEqual({
      x: VP.width - 440 - M,
      y: VP.height - 330 - M,
      w: 440,
      h: 330,
    });
  });

  it("音频的比例参数被忽略", () => {
    expect(defaultGeometry("audio", 0.5, VP)).toEqual(defaultGeometry("audio", 2, VP));
  });

  it("横屏视频（16:9）：宽 560，高 = 画面高 + 200 的顶栏 / 控制区，贴右下", () => {
    const g = defaultGeometry("video", 16 / 9, VP);
    expect(g.w).toBe(560);
    expect(g.h).toBe(Math.round(560 / (16 / 9)) + 200);
    expect(g.h).toBe(515);
    expect(g.x).toBe(VP.width - g.w - M);
    expect(g.y).toBe(VP.height - g.h - M);
  });

  it("更宽的横屏（21:9）更矮；方形视频（1:1）归入横屏分支", () => {
    const wide = defaultGeometry("video", 21 / 9, VP);
    expect(wide.w).toBe(560);
    expect(wide.h).toBe(Math.round(560 / (21 / 9)) + 200);
    const square = defaultGeometry("video", 1, VP);
    expect(square.w).toBe(560);
    expect(square.h).toBe(560 + 200);
    expect(square.h).toBeGreaterThan(wide.h);
  });

  it("竖屏视频（9:16）：窄而高；高 720，宽不小于最小宽度", () => {
    const g = defaultGeometry("video", 9 / 16, VP);
    expect(g.h).toBe(720);
    expect(g.w).toBe(DOCK_MIN_W);
    expect(g.x).toBe(VP.width - g.w - M);
    expect(g.y).toBe(VP.height - g.h - M);
  });

  it("竖屏但没那么窄（3:4）：宽按 (高 - 200) × 比例", () => {
    const g = defaultGeometry("video", 3 / 4, VP);
    expect(g.h).toBe(720);
    expect(g.w).toBe(Math.round((720 - 200) * 0.75));
    expect(g.w).toBe(390);
  });

  it("竖屏在矮视口里：高度压到视口减边距", () => {
    const g = defaultGeometry("video", 9 / 16, { width: 1280, height: 500 });
    expect(g.h).toBe(500 - 2 * M);
    expect(g.y).toBe(M);
  });

  it("比例未知（null / NaN / 0 / 负数 / Infinity）→ 按 16:9", () => {
    const expected = defaultGeometry("video", 16 / 9, VP);
    expect(defaultGeometry("video", null, VP)).toEqual(expected);
    expect(defaultGeometry("video", Number.NaN, VP)).toEqual(expected);
    expect(defaultGeometry("video", 0, VP)).toEqual(expected);
    expect(defaultGeometry("video", -1, VP)).toEqual(expected);
    expect(defaultGeometry("video", Number.POSITIVE_INFINITY, VP)).toEqual(expected);
  });

  it("小视口：宽度随视口收，结果仍在视口内", () => {
    const small: Viewport = { width: 400, height: 500 };
    const g = defaultGeometry("video", 16 / 9, small);
    expect(g.w).toBe(small.width - 2 * M);
    expect(insideViewport(g, small)).toBe(true);
    const a = defaultGeometry("audio", null, { width: 400, height: 300 });
    expect(a).toEqual({ x: M, y: M, w: 400 - 2 * M, h: 300 - 2 * M });
  });

  it("各种视口 × 比例 × 类型：默认外框都在视口内、不小于最小尺寸（视口够大时）", () => {
    for (const vp of [
      { width: 1280, height: 800 },
      { width: 1920, height: 1080 },
      { width: 800, height: 600 },
      { width: 420, height: 700 },
    ]) {
      for (const aspect of [null, 0.4, 9 / 16, 3 / 4, 1, 4 / 3, 16 / 9, 21 / 9, 3]) {
        for (const kind of ["video", "audio"] as const) {
          const g = defaultGeometry(kind, aspect, vp);
          expect(insideViewport(g, vp), `${kind} ${aspect} ${vp.width}x${vp.height}`).toBe(true);
          expect(g.w).toBeGreaterThanOrEqual(Math.min(DOCK_MIN_W, vp.width - 2 * M));
          expect(g.h).toBeGreaterThanOrEqual(Math.min(DOCK_MIN_H, vp.height - 2 * M));
        }
      }
    }
  });
});

describe("moveGeometry", () => {
  const g = { x: 200, y: 150, w: 400, h: 300 };

  it("整体平移，尺寸不变", () => {
    expect(moveGeometry(g, 30, -20, VP)).toEqual({ x: 230, y: 130, w: 400, h: 300 });
    expect(moveGeometry(g, 0, 0, VP)).toEqual(g);
  });

  it("拖出左 / 上边：停在 16px 边距", () => {
    expect(moveGeometry(g, -1000, -1000, VP)).toEqual({ x: M, y: M, w: 400, h: 300 });
  });

  it("拖出右 / 下边：停在「右边 / 下边离视口 16px」", () => {
    const out = moveGeometry(g, 5000, 5000, VP);
    expect(out).toEqual({ x: VP.width - 400 - M, y: VP.height - 300 - M, w: 400, h: 300 });
  });

  it("只越一个方向时另一个方向不受影响", () => {
    const out = moveGeometry(g, -1000, 20, VP);
    expect(out).toEqual({ x: M, y: 170, w: 400, h: 300 });
  });

  it("不改动入参", () => {
    const copy = { ...g };
    moveGeometry(g, 10, 10, VP);
    expect(g).toEqual(copy);
  });
});

describe("resizeGeometry：每个边 / 角", () => {
  const g = { x: 200, y: 150, w: 400, h: 300 }; // 右边 600，下边 450

  it("right：只改宽，左上角不动", () => {
    expect(resizeGeometry(g, "right", 50, 999, VP)).toEqual({ x: 200, y: 150, w: 450, h: 300 });
    expect(resizeGeometry(g, "right", -50, 0, VP)).toEqual({ x: 200, y: 150, w: 350, h: 300 });
  });

  it("bottom：只改高，左上角不动", () => {
    expect(resizeGeometry(g, "bottom", 999, 40, VP)).toEqual({ x: 200, y: 150, w: 400, h: 340 });
    expect(resizeGeometry(g, "bottom", 0, -40, VP)).toEqual({ x: 200, y: 150, w: 400, h: 260 });
  });

  it("corner（右下角）：同时改宽高，左上角不动", () => {
    expect(resizeGeometry(g, "corner", 50, 40, VP)).toEqual({ x: 200, y: 150, w: 450, h: 340 });
  });

  it("left：向左拖变宽，同时左移 —— 右边缘不动", () => {
    const out = resizeGeometry(g, "left", -50, 999, VP);
    expect(out).toEqual({ x: 150, y: 150, w: 450, h: 300 });
    expect(right(out)).toBe(right(g));
    const shrink = resizeGeometry(g, "left", 50, 0, VP);
    expect(shrink).toEqual({ x: 250, y: 150, w: 350, h: 300 });
    expect(right(shrink)).toBe(right(g));
  });

  it("top：向上拖变高，同时上移 —— 下边缘不动", () => {
    const out = resizeGeometry(g, "top", 999, -30, VP);
    expect(out).toEqual({ x: 200, y: 120, w: 400, h: 330 });
    expect(bottom(out)).toBe(bottom(g));
    const shrink = resizeGeometry(g, "top", 0, 30, VP);
    expect(shrink).toEqual({ x: 200, y: 180, w: 400, h: 270 });
    expect(bottom(shrink)).toBe(bottom(g));
  });

  it("tl（左上角）：宽高都改，右下角不动", () => {
    const out = resizeGeometry(g, "tl", -20, -10, VP);
    expect(out).toEqual({ x: 180, y: 140, w: 420, h: 310 });
    expect([right(out), bottom(out)]).toEqual([right(g), bottom(g)]);
  });

  it("tr（右上角）：宽按右边、高按上边，左下角不动", () => {
    const out = resizeGeometry(g, "tr", 30, -10, VP);
    expect(out).toEqual({ x: 200, y: 140, w: 430, h: 310 });
    expect([out.x, bottom(out)]).toEqual([g.x, bottom(g)]);
  });

  it("bl（左下角）：宽按左边、高按下边，右上角不动", () => {
    const out = resizeGeometry(g, "bl", -20, 25, VP);
    expect(out).toEqual({ x: 180, y: 150, w: 420, h: 325 });
    expect([right(out), out.y]).toEqual([right(g), g.y]);
  });

  it("dx / dy 为 0：原样返回", () => {
    for (const edge of ["right", "bottom", "corner", "left", "top", "tl", "tr", "bl"] as const) {
      expect(resizeGeometry(g, edge, 0, 0, VP), edge).toEqual(g);
    }
  });
});

describe("resizeGeometry：最小尺寸", () => {
  const g = { x: 200, y: 150, w: 400, h: 300 };

  it("往里缩到最小 300×200 就停", () => {
    expect(resizeGeometry(g, "right", -1000, 0, VP)).toEqual({ x: 200, y: 150, w: DOCK_MIN_W, h: 300 });
    expect(resizeGeometry(g, "bottom", 0, -1000, VP)).toEqual({ x: 200, y: 150, w: 400, h: DOCK_MIN_H });
    expect(resizeGeometry(g, "corner", -1000, -1000, VP)).toEqual({ x: 200, y: 150, w: DOCK_MIN_W, h: DOCK_MIN_H });
  });

  it("left 缩到最小：宽停在 300，右边缘仍不动（x 随之右移）", () => {
    const out = resizeGeometry(g, "left", 1000, 0, VP);
    expect(out.w).toBe(DOCK_MIN_W);
    expect(out.x).toBe(right(g) - DOCK_MIN_W);
    expect(right(out)).toBe(right(g));
  });

  it("top 缩到最小：高停在 200，下边缘仍不动", () => {
    const out = resizeGeometry(g, "top", 0, 1000, VP);
    expect(out.h).toBe(DOCK_MIN_H);
    expect(out.y).toBe(bottom(g) - DOCK_MIN_H);
    expect(bottom(out)).toBe(bottom(g));
  });

  it("tl 缩到最小：右下角不动", () => {
    const out = resizeGeometry(g, "tl", 1000, 1000, VP);
    expect([out.w, out.h]).toEqual([DOCK_MIN_W, DOCK_MIN_H]);
    expect([right(out), bottom(out)]).toEqual([right(g), bottom(g)]);
  });

  it("视口比最小尺寸小：最小尺寸跟着视口收", () => {
    const small: Viewport = { width: 250, height: 180 };
    const tiny = { x: M, y: M, w: 218, h: 148 };
    const out = resizeGeometry(tiny, "corner", -500, -500, small);
    expect(out.w).toBe(small.width - 2 * M);
    expect(out.h).toBe(small.height - 2 * M);
  });
});

describe("resizeGeometry：夹进视口", () => {
  const g = { x: 200, y: 150, w: 400, h: 300 };

  it("向右拖出视口：宽停在视口右边距，左边缘不动（不能把窗口整体推向左）", () => {
    const out = resizeGeometry(g, "right", 5000, 0, VP);
    expect(out.x).toBe(g.x);
    expect(right(out)).toBe(VP.width - M);
  });

  it("向下拖出视口：高停在视口下边距，上边缘不动", () => {
    const out = resizeGeometry(g, "bottom", 0, 5000, VP);
    expect(out.y).toBe(g.y);
    expect(bottom(out)).toBe(VP.height - M);
  });

  it("向左拖出视口：停在左边距，右边缘不动（不能让右边缘向右跑）", () => {
    const out = resizeGeometry(g, "left", -5000, 0, VP);
    expect(out.x).toBe(M);
    expect(right(out)).toBe(right(g));
  });

  it("向上拖出视口：停在上边距，下边缘不动", () => {
    const out = resizeGeometry(g, "top", 0, -5000, VP);
    expect(out.y).toBe(M);
    expect(bottom(out)).toBe(bottom(g));
  });

  it("只越界一点点（几个像素）也不漂移", () => {
    // 左边缘离视口左边距 16 只差 10px，再拖 20px：应停在 16
    const near = { x: 26, y: 100, w: 400, h: 300 };
    const out = resizeGeometry(near, "left", -20, 0, VP);
    expect(out.x).toBe(M);
    expect(right(out)).toBe(right(near));
  });

  it("窗口贴在右下角时向右 / 向下拖：不动（默认位置就是贴右下，最常见的操作）", () => {
    const docked = defaultGeometry("video", 16 / 9, VP);
    expect(resizeGeometry(docked, "right", 80, 0, VP)).toEqual(docked);
    expect(resizeGeometry(docked, "bottom", 0, 80, VP)).toEqual(docked);
    expect(resizeGeometry(docked, "corner", 80, 80, VP)).toEqual(docked);
  });

  it("窗口贴在右下角时向左 / 向上拖：右下角固定，宽高增长", () => {
    const docked = defaultGeometry("video", 16 / 9, VP);
    const out = resizeGeometry(docked, "tl", -100, -60, VP);
    expect(out.w).toBe(docked.w + 100);
    expect(out.h).toBe(docked.h + 60);
    expect([right(out), bottom(out)]).toEqual([right(docked), bottom(docked)]);
  });

  it("所有边 / 角 × 各种拖法：结果都在视口内，且对边（固定侧）不动", () => {
    const fixed: Record<ResizeEdge, (a: DockGeometry, b: DockGeometry) => boolean> = {
      right: (a, b) => a.x === b.x && a.y === b.y && a.h === b.h,
      bottom: (a, b) => a.x === b.x && a.y === b.y && a.w === b.w,
      corner: (a, b) => a.x === b.x && a.y === b.y,
      left: (a, b) => right(a) === right(b) && a.y === b.y && a.h === b.h,
      top: (a, b) => bottom(a) === bottom(b) && a.x === b.x && a.w === b.w,
      tl: (a, b) => right(a) === right(b) && bottom(a) === bottom(b),
      tr: (a, b) => a.x === b.x && bottom(a) === bottom(b),
      bl: (a, b) => right(a) === right(b) && a.y === b.y,
    };
    const starts: DockGeometry[] = [
      { x: 200, y: 150, w: 400, h: 300 },
      { x: M, y: M, w: 300, h: 200 },
      defaultGeometry("video", 16 / 9, VP),
      defaultGeometry("audio", null, VP),
    ];
    const deltas = [-5000, -300, -50, -7, 0, 7, 50, 300, 5000];
    for (const start of starts) {
      for (const edge of Object.keys(fixed) as ResizeEdge[]) {
        for (const dx of deltas) {
          for (const dy of deltas) {
            const out = resizeGeometry(start, edge, dx, dy, VP);
            const label = `${edge} start=${JSON.stringify(start)} dx=${dx} dy=${dy} → ${JSON.stringify(out)}`;
            expect(insideViewport(out, VP), label).toBe(true);
            expect(out.w, label).toBeGreaterThanOrEqual(DOCK_MIN_W);
            expect(out.h, label).toBeGreaterThanOrEqual(DOCK_MIN_H);
            expect(fixed[edge](out, start), label).toBe(true);
          }
        }
      }
    }
  });

  it("不改动入参", () => {
    const copy = { ...g };
    resizeGeometry(g, "tl", -30, -30, VP);
    expect(g).toEqual(copy);
  });
});
