/**
 * 压缩包目录树 / 图片缩放数学 / 展示格式化
 */
import { describe, expect, it } from "vitest";

import { buildArchiveTree, flattenArchive } from "@/lib/preview/archive-tree";
import { formatBytes, formatCount, formatModified } from "@/lib/preview/format";
import { clampScale, fitScale, MAX_SCALE, MIN_SCALE, rotateBy, wheelFactor, zoomAt } from "@/lib/preview/zoom";
import type { ArchiveEntryInfo } from "@/lib/preview/types";

const e = (name: string, size = 10, dir = false): ArchiveEntryInfo => ({
  name,
  size,
  compressedSize: Math.floor(size / 2),
  isDir: dir || name.endsWith("/"),
});

describe("buildArchiveTree", () => {
  it("补全缺失的中间目录；目录在前文件在后；自然排序", () => {
    const root = buildArchiveTree([e("b.txt"), e("src/z.ts"), e("src/a/deep/x.ts"), e("a10.txt"), e("a2.txt"), e("src/")]);
    expect(root.children.map((c) => c.name)).toEqual(["src", "a2.txt", "a10.txt", "b.txt"]);
    const src = root.children[0]!;
    expect(src.isDir).toBe(true);
    expect(src.children.map((c) => c.name)).toEqual(["a", "z.ts"]);
    expect(src.children[0]!.children[0]!.name).toBe("deep");
  });

  it("目录聚合子孙文件数与大小", () => {
    const root = buildArchiveTree([e("d/a", 100), e("d/sub/b", 50), e("c", 1)]);
    const d = root.children.find((c) => c.name === "d")!;
    expect(d.fileCount).toBe(2);
    expect(d.size).toBe(150);
    expect(root.fileCount).toBe(3);
    expect(root.size).toBe(151);
  });

  it("路径规整：./ 前缀 / 前导斜杠 / 反斜杠 / 空名都不产生奇怪节点", () => {
    const root = buildArchiveTree([e("./a/b.txt"), e("/c.txt"), e("w\\x\\y.txt"), e("")]);
    expect(root.children.map((c) => c.name)).toEqual(["a", "w", "c.txt"]);
    expect(root.children.find((c) => c.name === "w")!.children[0]!.name).toBe("x");
  });

  it("只有目录条目的包 / 空包不崩", () => {
    expect(buildArchiveTree([]).children).toEqual([]);
    expect(buildArchiveTree([e("only/", 0)]).children[0]!.isDir).toBe(true);
  });
});

describe("flattenArchive", () => {
  const root = buildArchiveTree([e("src/a.ts"), e("src/lib/b.ts"), e("README.md"), e("docs/guide.md")]);

  it("折叠时只显示顶层；展开后按深度摊平", () => {
    expect(flattenArchive(root, new Set(), "").map((r) => r.node.name)).toEqual(["docs", "src", "README.md"]);
    const rows = flattenArchive(root, new Set(["src/"]), "");
    expect(rows.map((r) => `${r.depth}:${r.node.name}`)).toEqual(["0:docs", "0:src", "1:lib", "1:a.ts", "0:README.md"]);
  });

  it("过滤：忽略展开状态，只留命中文件及其祖先目录并全部展开", () => {
    const rows = flattenArchive(root, new Set(), "b.ts");
    expect(rows.map((r) => r.node.path)).toEqual(["src/", "src/lib/", "src/lib/b.ts"]);
    expect(flattenArchive(root, new Set(), "zzz")).toEqual([]);
  });

  it("过滤按完整路径匹配、不区分大小写", () => {
    expect(flattenArchive(root, new Set(), "DOCS/").map((r) => r.node.path)).toEqual(["docs/", "docs/guide.md"]);
  });
});

describe("zoom 数学", () => {
  it("clampScale 限幅", () => {
    expect(clampScale(0)).toBe(MIN_SCALE);
    expect(clampScale(1000)).toBe(MAX_SCALE);
    expect(clampScale(2)).toBe(2);
  });

  it("fitScale：大图缩小、小图不放大（默认 maxFit=1）、旋转 90° 交换宽高", () => {
    expect(fitScale({ w: 2000, h: 1000 }, { w: 1000, h: 1000 }, 0)).toBe(0.5);
    expect(fitScale({ w: 100, h: 50 }, { w: 1000, h: 1000 }, 0)).toBe(1);
    expect(fitScale({ w: 2000, h: 1000 }, { w: 1000, h: 1000 }, 90)).toBe(0.5);
    expect(fitScale({ w: 1000, h: 4000 }, { w: 1000, h: 1000 }, 90)).toBe(0.25);
    expect(fitScale({ w: 0, h: 0 }, { w: 100, h: 100 }, 0)).toBe(1);
  });

  it("zoomAt：指针下的图像点缩放前后位置不变", () => {
    const view = { scale: 1, x: 30, y: -20 };
    const px = 100;
    const py = 50;
    const imgPoint = { x: (px - view.x) / view.scale, y: (py - view.y) / view.scale };
    const next = zoomAt(view, 2.5, px, py);
    expect(next.scale).toBe(2.5);
    expect(next.x + imgPoint.x * next.scale).toBeCloseTo(px, 9);
    expect(next.y + imgPoint.y * next.scale).toBeCloseTo(py, 9);
  });

  it("zoomAt：超出范围按限幅后的比例算，锚点同样不动", () => {
    const next = zoomAt({ scale: 16, x: 0, y: 0 }, 1000, 10, 10);
    expect(next.scale).toBe(MAX_SCALE);
    expect(next.x + (10 / 16) * next.scale).toBeCloseTo(10, 9);
  });

  it("wheelFactor：向上滚放大、向下滚缩小、0 不变", () => {
    expect(wheelFactor(-100)).toBeGreaterThan(1);
    expect(wheelFactor(100)).toBeLessThan(1);
    expect(wheelFactor(0)).toBe(1);
  });

  it("rotateBy：90° 步进并落在 [0,360)", () => {
    expect(rotateBy(0, 90)).toBe(90);
    expect(rotateBy(270, 90)).toBe(0);
    expect(rotateBy(0, -90)).toBe(270);
    expect(rotateBy(90, -90)).toBe(0);
  });
});

describe("format", () => {
  it("formatBytes：量级与小数位", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1024)).toBe("1.00 KB");
    expect(formatBytes(1536)).toBe("1.50 KB");
    expect(formatBytes(10 * 1024 * 1024)).toBe("10.0 MB");
    expect(formatBytes(500 * 1024 * 1024)).toBe("500 MB");
    expect(formatBytes(-1)).toBe("—");
    expect(formatBytes(NaN)).toBe("—");
  });

  it("formatModified：今年省略年份、往年带年份、非法值给占位", () => {
    const now = new Date(2026, 10, 6, 12, 0, 0);
    expect(formatModified(new Date(2026, 10, 6, 9, 5).getTime(), now)).toBe("11-06 09:05");
    expect(formatModified(new Date(2025, 0, 2, 23, 59).getTime(), now)).toBe("2025-01-02 23:59");
    expect(formatModified(0, now)).toBe("—");
    expect(formatModified(NaN, now)).toBe("—");
  });

  it("formatCount：千分位", () => {
    expect(formatCount(1234567)).toBe("1,234,567");
  });
});
