/**
 * diff 渲染模型（hunk 解析 / 折叠与展开上下文 / 分栏配对 / 变更块）。
 *
 * 核心性质：「整文件 diff 折叠出来的初始视图」必须与「-U3 diff」逐行一致，否则用户点开第一个 gap、
 * 整文件到手的那一瞬间视图会跳。这里用真 git（`git diff --no-index`）生成两份 diff，
 * 对固定边界场景 + 一批确定性随机场景逐例比对。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  buildBaseRows,
  buildDiffRows,
  buildFullRows,
  buildSplitRows,
  DIFF_CONTEXT_LINES,
  DIFF_EXPAND_STEP,
  EMPTY_EXPANSION,
  expandAllGaps,
  expandGap,
  findChangeBlocks,
  isNoNewlineMarker,
  lineSourceText,
  splitHunks,
  toViewLines,
  totalHiddenLines,
  type DiffGap,
  type DiffRow,
} from "@/lib/diff/model";
import { parseUnifiedDiff, type DiffViewLine } from "@/lib/tool-display";

// ---------- 小工具 ----------

const gapsOf = (rows: readonly DiffRow[]): DiffGap[] =>
  rows.flatMap((r) => (r.type === "gap" ? [r.gap] : []));
const linesOf = (rows: readonly DiffRow[]): DiffViewLine[] =>
  rows.flatMap((r) => (r.type === "line" ? [r.line] : []));

const row = (
  kind: "add" | "del" | "context",
  text: string,
  oldLine?: number,
  newLine?: number,
): DiffRow => ({
  type: "line",
  line: {
    kind,
    text,
    ...(oldLine !== undefined ? { oldLine } : {}),
    ...(newLine !== undefined ? { newLine } : {}),
  },
});
const marker = (): DiffRow => row("context", "\\ No newline at end of file");
const gapRow = (key: number, hidden: number | null = 5): DiffRow => ({
  type: "gap",
  gap: { key, hidden, position: "middle" },
});

const sig = (rows: readonly DiffRow[]): string[] =>
  rows.map((r) =>
    r.type === "line"
      ? `${r.line.kind}|${r.line.oldLine ?? ""}|${r.line.newLine ?? ""}|${r.line.text}`
      : `gap|${r.gap.key}|${r.gap.position}|${r.gap.hidden ?? "?"}`,
  );

// ---------- 真 git 生成 diff ----------

let TMP = "";
beforeAll(() => {
  TMP = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "flowship-diff-model-")));
});
afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

const gitDiff = (oldLines: string[], newLines: string[], ctx: number): string => {
  const pa = path.join(TMP, "a.txt");
  const pb = path.join(TMP, "b.txt");
  const toText = (ls: string[]) => ls.map((l) => `${l}\n`).join("");
  fs.writeFileSync(pa, toText(oldLines));
  fs.writeFileSync(pb, toText(newLines));
  const r = spawnSync(
    "git",
    ["--no-pager", "diff", "--no-index", "--no-color", `-U${ctx}`, "--", pa, pb],
    { encoding: "utf8", env: { ...process.env, GIT_PAGER: "cat" } },
  );
  return r.stdout;
};

const FULL_CTX = 1_000_000;

/** 对同一对文件：base（-U3）初始视图 == full 折叠后的初始视图（末尾 gap 的行数 base 不知道，单独放宽） */
const expectBaseEqualsFull = (oldLines: string[], newLines: string[], label: string) => {
  const u3 = gitDiff(oldLines, newLines, DIFF_CONTEXT_LINES);
  const full = gitDiff(oldLines, newLines, FULL_CTX);
  if (!u3) return false; // 没有差异
  const base = buildBaseRows(u3).rows;
  const folded = buildFullRows(full, EMPTY_EXPANSION, buildBaseRows(u3).headingByKey);
  expect(folded, label).not.toBeNull();
  if (!folded) return true;

  const isBottomAny = (s: string) => s.startsWith("gap|") && s.includes("|bottom|");
  const baseSig = sig(base);
  const fullSig = sig(folded);

  // 除末尾 gap 外必须逐行一致（含 key、位置、隐藏行数）
  expect(fullSig.filter((s) => !isBottomAny(s)), label).toEqual(baseSig.filter((s) => !isBottomAny(s)));
  // 末尾 gap：full 有 → base 必须也有（同一个 key、行数未知）；base 多出一个（恰好凑满 3 行上下文又刚到文件末尾）是允许的
  const fullBottom = fullSig.find(isBottomAny);
  const baseBottom = baseSig.find(isBottomAny);
  if (fullBottom) {
    expect(baseBottom, label).toBeDefined();
    expect(baseBottom?.split("|")[1], label).toBe(fullBottom.split("|")[1]);
    expect(baseBottom?.endsWith("|?"), label).toBe(true);
  }
  return true;
};

// ---------- 确定性伪随机 ----------

const makeRng = (seed: number) => () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 4294967296;
};

const randomCase = (rng: () => number) => {
  const n = 1 + Math.floor(rng() * 70);
  const oldLines = Array.from({ length: n }, (_, i) => `line ${i + 1}`);
  const p = 0.03 + rng() * 0.14;
  const newLines: string[] = [];
  for (const l of oldLines) {
    const r = rng();
    if (r < p * 0.35) continue; // 删
    if (r < p * 0.7) newLines.push(`${l} changed`); // 改
    else if (r < p) newLines.push(l, `inserted after ${l}`); // 插
    else newLines.push(l);
  }
  return { oldLines, newLines };
};

// ======================================================================

describe("splitHunks", () => {
  const MULTI = [
    "diff --git a/f.ts b/f.ts",
    "index 1111111..2222222 100644",
    "--- a/f.ts",
    "+++ b/f.ts",
    "@@ -3,3 +3,4 @@ function foo() {",
    " ctx-a",
    "-old",
    "+new1",
    "+new2",
    " ctx-b",
    "@@ -40 +41,2 @@ class Bar {",
    " keep",
    "+added",
    "",
  ].join("\n");

  it("多个 hunk：行号 / 行数（省略 = 1）/ 函数上下文都解析出来，文件头被剥掉", () => {
    const hunks = splitHunks(MULTI);
    expect(hunks).toHaveLength(2);
    expect(hunks[0]).toMatchObject({
      oldStart: 3,
      oldCount: 3,
      newStart: 3,
      newCount: 4,
      heading: "function foo() {",
      malformed: false,
    });
    expect(hunks[0].lines.map((l) => l.kind)).toEqual(["context", "del", "add", "add", "context"]);
    expect(hunks[0].lines[1]).toMatchObject({ kind: "del", oldLine: 4, text: "old" });
    expect(hunks[0].lines[2]).toMatchObject({ kind: "add", newLine: 4, text: "new1" });
    expect(hunks[1]).toMatchObject({
      oldStart: 40,
      oldCount: 1,
      newStart: 41,
      newCount: 2,
      heading: "class Bar {",
    });
  });

  it("没有函数上下文 / CRLF / 超长函数上下文", () => {
    expect(splitHunks("@@ -1,2 +1,2 @@\n a\n-b\n+c\n")[0].heading).toBe("");
    expect(splitHunks("@@ -1,2 +1,2 @@ fn\r\n a\r\n-b\r\n+c\r\n")[0].heading).toBe("fn");
    expect(splitHunks(`@@ -1 +1 @@ ${"x".repeat(300)}\n-a\n+b\n`)[0].heading).toHaveLength(120);
  });

  it("空输入、没有 @@ 头的内容（截断 / 非标准）：不抛、标残缺", () => {
    expect(splitHunks("")).toEqual([]);
    const h = splitHunks(" a\n+b\n");
    expect(h).toHaveLength(1);
    expect(h[0].malformed).toBe(true);
    expect(h[0].lines.map((l) => l.kind)).toEqual(["context", "add"]);
  });

  it("头部残缺（被截断）：标 malformed、行内容照常保留", () => {
    const h = splitHunks("@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n@@ -9,3 +9\n x\n");
    expect(h.map((x) => x.malformed)).toEqual([false, true]);
    expect(h[1].lines).toHaveLength(1);
  });

  it("新增 / 删除整个文件的头：-0,0 / +0,0", () => {
    const added = splitHunks("@@ -0,0 +1,3 @@\n+a\n+b\n+c\n");
    expect(added[0]).toMatchObject({ oldStart: 0, oldCount: 0, newStart: 1, newCount: 3 });
    const removed = splitHunks("@@ -1,2 +0,0 @@\n-a\n-b\n");
    expect(removed[0]).toMatchObject({ newStart: 0, newCount: 0 });
  });
});

describe("buildBaseRows：-U3 视图里的 gap", () => {
  const hunk = (start: number, heading: string): string[] => {
    const n = (k: number) => `l${start + k}`;
    return [
      `@@ -${start},7 +${start},7 @@ ${heading}`,
      ` ${n(0)}`,
      ` ${n(1)}`,
      ` ${n(2)}`,
      `-x${start + 3}`,
      `+y${start + 3}`,
      ` ${n(4)}`,
      ` ${n(5)}`,
      ` ${n(6)}`,
    ];
  };

  it("开头 / 中间 / 末尾：行数由 hunk 头算出（末尾未知）、函数上下文挂在它下面那个 hunk 上", () => {
    const diff = [...hunk(10, "fn a"), ...hunk(30, "fn b"), ""].join("\n");
    const { rows, headingByKey } = buildBaseRows(diff);
    expect(gapsOf(rows)).toEqual([
      { key: 1, hidden: 9, position: "top", startNew: 1, heading: "fn a" },
      { key: 17, hidden: 13, position: "middle", startNew: 17, heading: "fn b" },
      { key: 37, hidden: null, position: "bottom", startNew: 37 },
    ]);
    expect(rows).toHaveLength(1 + 8 + 1 + 8 + 1);
    expect(rows[0].type).toBe("gap");
    expect(rows[rows.length - 1].type).toBe("gap");
    expect([...headingByKey.entries()]).toEqual([
      [1, "fn a"],
      [17, "fn b"],
    ]);
  });

  it("文件从第 1 行就有改动：没有开头 gap", () => {
    const diff = ["@@ -1,3 +1,3 @@", " a", "-b", "+B", " c", ""].join("\n");
    expect(gapsOf(buildBaseRows(diff).rows)).toEqual([]);
  });

  it("末尾上下文不满 3 行 = 已经到文件末尾：没有末尾 gap", () => {
    const diff = [
      "@@ -10,6 +10,6 @@",
      " l10",
      " l11",
      " l12",
      "-x13",
      "+y13",
      " l14",
      " l15",
      "",
    ].join("\n");
    expect(gapsOf(buildBaseRows(diff).rows).map((g) => g.position)).toEqual(["top"]);
  });

  it("末尾是「无结尾换行」标记：到文件末尾了、没有末尾 gap", () => {
    const diff = [
      "@@ -1,2 +1,2 @@",
      " a",
      "-b",
      "\\ No newline at end of file",
      "+c",
      "\\ No newline at end of file",
      "",
    ].join("\n");
    expect(gapsOf(buildBaseRows(diff).rows)).toEqual([]);
  });

  it("新增整个文件：没有任何 gap", () => {
    expect(gapsOf(buildBaseRows("@@ -0,0 +1,3 @@\n+a\n+b\n+c\n").rows)).toEqual([]);
  });

  it("纯删除 hunk（新侧 0 行）：隐藏行数按「前一行」口径算", () => {
    const diff = [
      "@@ -1,3 +1,3 @@",
      " a",
      "-b",
      "+B",
      " c",
      "@@ -20,3 +19,2 @@",
      " x",
      "-y",
      " z",
      "@@ -30,2 +28,0 @@",
      "-p",
      "-q",
      "",
    ].join("\n");
    expect(gapsOf(buildBaseRows(diff).rows)).toEqual([
      { key: 4, hidden: 15, position: "middle", startNew: 4 },
      { key: 21, hidden: 8, position: "middle", startNew: 21 },
    ]);
  });

  it("头部残缺：中间的 gap 行数未知、键为负数（不会与真实行号冲突）", () => {
    const diff = "@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n@@ -9,3 +9\n x\n";
    expect(gapsOf(buildBaseRows(diff).rows)).toEqual([
      { key: -1, hidden: null, position: "middle" },
    ]);
  });
});

describe("buildFullRows：整文件 diff 折叠 / 展开", () => {
  const hundred = Array.from({ length: 100 }, (_, i) => `l${i + 1}`);
  const withChange = (changed: number[]) =>
    hundred.map((l, i) => (changed.includes(i + 1) ? `${l} CHANGED` : l));

  it("改第 50 行：开头隐藏 46 行、末尾隐藏 47 行，改动前后各 3 行上下文", () => {
    const rows = buildFullRows(gitDiff(hundred, withChange([50]), FULL_CTX)) ?? [];
    expect(gapsOf(rows)).toEqual([
      { key: 1, hidden: 46, position: "top", startNew: 1 },
      { key: 54, hidden: 47, position: "bottom", startNew: 54 },
    ]);
    expect(linesOf(rows).map((l) => l.text)).toEqual([
      "l47", "l48", "l49", "l50", "l50 CHANGED", "l51", "l52", "l53",
    ]);
  });

  it("展开：开头只能向上露出、末尾只能向下露出，每次 20 行；全部展开后 gap 消失", () => {
    const full = gitDiff(hundred, withChange([50]), FULL_CTX);
    let exp = expandGap(EMPTY_EXPANSION, 1, "up");
    let gaps = gapsOf(buildFullRows(full, exp) ?? []);
    expect(gaps[0]).toMatchObject({ key: 1, hidden: 46 - DIFF_EXPAND_STEP, position: "top" });
    // 开头 gap 向「下」展开没意义（上面没有 hunk 可往下延伸）：不该有任何效果
    exp = expandGap(EMPTY_EXPANSION, 1, "down");
    expect(gapsOf(buildFullRows(full, exp) ?? [])[0].hidden).toBe(46);

    exp = expandGap(EMPTY_EXPANSION, 54, "down");
    gaps = gapsOf(buildFullRows(full, exp) ?? []);
    expect(gaps[1]).toMatchObject({ key: 54, hidden: 47 - DIFF_EXPAND_STEP, position: "bottom", startNew: 54 + DIFF_EXPAND_STEP });

    exp = expandGap(expandGap(EMPTY_EXPANSION, 1, "all"), 54, "all");
    const all = buildFullRows(full, exp) ?? [];
    expect(gapsOf(all)).toEqual([]);
    expect(linesOf(all)).toHaveLength(101); // 99 行不变 + 1 删 + 1 增
  });

  it("夹在两处改动之间：两边各自向中间展开，露满后合并消失", () => {
    const full = gitDiff(hundred, withChange([10, 60]), FULL_CTX);
    const rows0 = buildFullRows(full) ?? [];
    expect(gapsOf(rows0).find((g) => g.position === "middle")).toMatchObject({
      key: 14,
      hidden: 43,
      startNew: 14,
    });

    let exp = expandGap(EMPTY_EXPANSION, 14, "down");
    expect(gapsOf(buildFullRows(full, exp) ?? []).find((g) => g.key === 14)).toMatchObject({
      hidden: 23,
      startNew: 14 + DIFF_EXPAND_STEP,
    });
    exp = expandGap(exp, 14, "up");
    expect(gapsOf(buildFullRows(full, exp) ?? []).find((g) => g.key === 14)).toMatchObject({
      hidden: 3,
    });
    exp = expandGap(exp, 14, "down");
    expect(gapsOf(buildFullRows(full, exp) ?? []).find((g) => g.key === 14)).toBeUndefined();
  });

  it("展开不改入参、键稳定（展开过程中同一个 gap 的 key 不变）", () => {
    const m1 = expandGap(EMPTY_EXPANSION, 14, "down");
    const m2 = expandGap(m1, 14, "down");
    expect(EMPTY_EXPANSION.size).toBe(0);
    expect(m1.get(14)).toEqual({ top: DIFF_EXPAND_STEP, bottom: 0 });
    expect(m2.get(14)).toEqual({ top: DIFF_EXPAND_STEP * 2, bottom: 0 });
  });

  it("间距恰好 6 行（git 会合并成一个 hunk）没有 gap，7 行才有", () => {
    for (const [gapLines, expected] of [
      [5, 0],
      [6, 0],
      [7, 1],
      [8, 1],
    ] as const) {
      const old = Array.from({ length: 40 }, (_, i) => `l${i + 1}`);
      const changed = [10, 10 + gapLines + 1];
      const next = old.map((l, i) => (changed.includes(i + 1) ? `${l}!` : l));
      const rows = buildFullRows(gitDiff(old, next, FULL_CTX)) ?? [];
      expect(gapsOf(rows).filter((g) => g.position === "middle"), `间距 ${gapLines}`).toHaveLength(expected);
    }
  });

  it("多个 hunk / 头部残缺的「整文件」diff：放弃折叠（返回 null），调用方退回 base", () => {
    expect(buildFullRows("@@ -1 +1 @@\n-a\n+b\n@@ -9 +9 @@\n-c\n+d\n")).toBeNull();
    expect(buildFullRows("@@ -1 +1\n-a\n+b\n")).toBeNull();
  });

  it("没有任何改动行 / 空输入：不折叠、不抛", () => {
    expect(buildFullRows("")).toEqual([]);
    const rows = buildFullRows("@@ -1,3 +1,3 @@\n a\n b\n c\n") ?? [];
    expect(gapsOf(rows)).toEqual([]);
    expect(linesOf(rows)).toHaveLength(3);
  });

  it("「无结尾换行」标记跟着它所属的那一行：折叠 / 展开时不会被单独丢掉", () => {
    const rows =
      buildFullRows(
        [
          "@@ -1,9 +1,9 @@",
          " a1",
          " a2",
          " a3",
          " a4",
          " a5",
          " a6",
          "-old",
          "\\ No newline at end of file",
          "+new",
          "\\ No newline at end of file",
          "",
        ].join("\n"),
      ) ?? [];
    expect(linesOf(rows).map((l) => l.text)).toEqual([
      "a4", "a5", "a6", "old", "\\ No newline at end of file", "new", "\\ No newline at end of file",
    ]);
    expect(gapsOf(rows)).toEqual([{ key: 1, hidden: 3, position: "top", startNew: 1 }]);
  });
});

describe("base 与 full 的初始视图必须一致（真 git）", () => {
  it("固定边界：改动间距 0~12 行、首行 / 末行 / 单行 / 空 ↔ 非空", () => {
    let compared = 0;
    for (let g = 0; g <= 12; g++) {
      const old = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`);
      const changed = [12, 12 + g + 1];
      const next = old.map((l, i) => (changed.includes(i + 1) ? `${l}!` : l));
      if (expectBaseEqualsFull(old, next, `间距 ${g}`)) compared += 1;
    }
    const mk = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`);
    const cases: Array<[string, string[], string[]]> = [
      ["首行改", mk(30), ["line 1!", ...mk(30).slice(1)]],
      ["末行改", mk(30), [...mk(30).slice(0, 29), "line 30!"]],
      ["首尾都改", mk(30), ["line 1!", ...mk(30).slice(1, 29), "line 30!"]],
      ["单行文件", ["only"], ["only!"]],
      ["全部替换", mk(12), mk(12).map((l) => `${l}!`)],
      ["空 → 非空", [], mk(5)],
      ["非空 → 空", mk(5), []],
      ["末尾追加", mk(20), [...mk(20), "tail"]],
      ["开头插入", mk(20), ["head", ...mk(20)]],
      ["只删中间一行", mk(30), mk(30).filter((_, i) => i !== 14)],
    ];
    for (const [label, a, b] of cases) {
      if (expectBaseEqualsFull(a, b, label)) compared += 1;
    }
    expect(compared).toBe(13 + cases.length);
  });

  it("120 组确定性随机改动（删 / 改 / 插混合、稀疏到密集）", () => {
    const rng = makeRng(20261023);
    let compared = 0;
    for (let k = 0; k < 120; k++) {
      const { oldLines, newLines } = randomCase(rng);
      if (expectBaseEqualsFull(oldLines, newLines, `随机 #${k}`)) compared += 1;
    }
    // 绝大多数组合都会产生差异；全部被跳过说明生成器坏了
    expect(compared).toBeGreaterThan(90);
  }, 60_000); // 每组都要起真 git（gitDiff）：本机并发下已是秒级，CI 的 2 核机器更慢，别靠默认 5s 碰运气

  it("沿用 base 里的函数上下文：full 折叠出的 gap 带同样的 heading", () => {
    const old = Array.from({ length: 80 }, (_, i) => `line ${i + 1}`);
    const next = old.map((l, i) => (i + 1 === 20 || i + 1 === 60 ? `${l}!` : l));
    const u3 = gitDiff(old, next, DIFF_CONTEXT_LINES);
    const full = gitDiff(old, next, FULL_CTX);
    const baseGap = gapsOf(buildBaseRows(u3).rows).find((g) => g.position === "middle");
    const out = buildDiffRows({ base: u3, full });
    const fullGap = gapsOf(out.rows).find((g) => g.position === "middle");
    expect(out.complete).toBe(true);
    // git 默认规则会挑出「最近一个以字母开头的行」当函数上下文
    expect(baseGap?.heading).toBeTruthy();
    expect(fullGap?.heading).toBe(baseGap?.heading);
  });

  it("展开所有 gap 后，行序列 == 整文件 diff 的全部行（不丢行、不重复、顺序不变）", () => {
    const rng = makeRng(77);
    for (let k = 0; k < 40; k++) {
      const { oldLines, newLines } = randomCase(rng);
      const full = gitDiff(oldLines, newLines, FULL_CTX);
      if (!full) continue;
      let exp = EMPTY_EXPANSION;
      for (const g of gapsOf(buildFullRows(full) ?? [])) exp = expandGap(exp, g.key, "all");
      const rows = buildFullRows(full, exp) ?? [];
      expect(gapsOf(rows), `#${k}`).toEqual([]);
      // 期望 = 直接用 parseUnifiedDiff 解析（独立于 model 的折叠逻辑）；git 输出末尾的换行是行终止符、不算一行
      expect(sig(rows), `#${k}`).toEqual(
        sig(
          parseUnifiedDiff(full.replace(/\n$/, ""))
            .filter((l) => l.kind !== "hunk")
            .map((line) => ({ type: "line", line })),
        ),
      );
    }
  });
});

describe("buildDiffRows", () => {
  const u3 = [
    "@@ -10,7 +10,7 @@ fn a",
    " l10", " l11", " l12", "-x13", "+y13", " l14", " l15", " l16",
    "",
  ].join("\n");

  it("没有整文件：用 base、complete=false（点 gap 前得先拉整文件）", () => {
    for (const full of [undefined, null, ""]) {
      const r = buildDiffRows({ base: u3, full });
      expect(r.complete).toBe(false);
      expect(gapsOf(r.rows)[0]).toMatchObject({ key: 1, hidden: 9, position: "top" });
    }
  });

  it("整文件放弃折叠（多 hunk）：退回 base、不崩", () => {
    const r = buildDiffRows({ base: u3, full: "@@ -1 +1 @@\n-a\n+b\n@@ -9 +9 @@\n-c\n+d\n" });
    expect(r.complete).toBe(false);
    expect(sig(r.rows)).toEqual(sig(buildBaseRows(u3).rows));
  });

  it("空 diff：没有行", () => {
    expect(buildDiffRows({ base: "" })).toEqual({ rows: [], complete: false });
  });
});

describe("toViewLines / lineSourceText / isNoNewlineMarker", () => {
  it("gap 变成 hunk 标记（语法高亮据此把前后两段源码隔开），长度与 rows 一一对应", () => {
    const rows: DiffRow[] = [row("context", "a", 1, 1), gapRow(5), row("add", "b", undefined, 9)];
    const v = toViewLines(rows);
    expect(v.map((l) => l.kind)).toEqual(["context", "hunk", "add"]);
    expect(v[1].text).toBe("");
  });

  it("CRLF：去掉行尾 \\r；标记行只认「反斜杠 + 空格」开头且没有行号", () => {
    expect(lineSourceText({ kind: "add", text: "abc\r" })).toBe("abc");
    expect(lineSourceText({ kind: "add", text: "a\rb" })).toBe("a\rb");
    expect(isNoNewlineMarker({ kind: "context", text: "\\ No newline at end of file" })).toBe(true);
    expect(isNoNewlineMarker({ kind: "context", text: "\\ 文件末尾没有换行符" })).toBe(true);
    expect(isNoNewlineMarker({ kind: "context", text: "\\ x", newLine: 3 })).toBe(false);
    expect(isNoNewlineMarker({ kind: "add", text: "\\ x" })).toBe(false);
  });
});

describe("findChangeBlocks", () => {
  it("连续的增 / 删（含删增交错）是一块；上下文和 gap 把块切开；统计增删数", () => {
    const rows: DiffRow[] = [
      row("context", "c", 1, 1), // 0
      row("del", "a", 2), // 1
      row("add", "b", undefined, 2), // 2
      row("context", "c", 3, 3), // 3
      gapRow(10), // 4
      row("add", "x", undefined, 20), // 5
      row("del", "y", 20), // 6
      row("add", "z", undefined, 21), // 7
      row("context", "c", 21, 22), // 8
    ];
    expect(findChangeBlocks(rows)).toEqual([
      { start: 1, end: 3, adds: 1, dels: 1 },
      { start: 5, end: 8, adds: 2, dels: 1 },
    ]);
    expect(findChangeBlocks([])).toEqual([]);
    expect(findChangeBlocks([row("context", "c", 1, 1)])).toEqual([]);
    // 变更行在序列末尾也要收尾
    expect(findChangeBlocks([row("add", "x", undefined, 1)])).toEqual([{ start: 0, end: 1, adds: 1, dels: 0 }]);
  });

  it("紧跟增 / 删行的「无结尾换行」标记算块内：「最后一行被改 + 无结尾换行」是一处改动，不是两处", () => {
    // 两侧都没有结尾换行：删 → 标记 → 增 → 标记
    expect(
      findChangeBlocks([
        row("context", "c", 1, 1),
        row("del", "a", 2),
        marker(),
        row("add", "b", undefined, 2),
        marker(),
      ]),
    ).toEqual([{ start: 1, end: 5, adds: 1, dels: 1 }]);
    // 只有旧侧 / 只有新侧没有结尾换行
    expect(findChangeBlocks([row("del", "a", 1), marker(), row("add", "b", undefined, 1)])).toEqual([
      { start: 0, end: 3, adds: 1, dels: 1 },
    ]);
    expect(findChangeBlocks([row("del", "a", 1), row("add", "b", undefined, 1), marker()])).toEqual([
      { start: 0, end: 3, adds: 1, dels: 1 },
    ]);
    // 纯删除最后一行：标记仍在块内（end 含它），统计不把标记算成改动行
    expect(findChangeBlocks([row("context", "c", 1, 1), row("del", "a", 2), marker()])).toEqual([
      { start: 1, end: 3, adds: 0, dels: 1 },
    ]);
  });

  it("前面不是增 / 删行的标记（跟在上下文行后面）不属于任何块", () => {
    expect(findChangeBlocks([row("context", "c", 1, 1), marker(), row("add", "b", undefined, 2)])).toEqual([
      { start: 2, end: 3, adds: 1, dels: 0 },
    ]);
    expect(findChangeBlocks([row("context", "c", 1, 1), marker()])).toEqual([]);
  });

  it("只有标记被放行：上下文行 / gap 照样把块切开", () => {
    expect(
      findChangeBlocks([row("del", "a", 1), marker(), row("context", "c", 2, 1), row("add", "b", undefined, 2)]),
    ).toHaveLength(2);
    expect(
      findChangeBlocks([row("del", "a", 1), marker(), gapRow(5), row("add", "b", undefined, 9)]),
    ).toHaveLength(2);
  });
});

describe("buildSplitRows", () => {
  const texts = (rows: ReturnType<typeof buildSplitRows>) =>
    rows.map((r) => (r.type === "pair" ? [r.left?.line.text ?? null, r.right?.line.text ?? null] : "gap"));

  it("上下文行两侧是同一行；等长的删 / 增块一一对应", () => {
    const rows: DiffRow[] = [
      row("context", "c1", 1, 1),
      row("del", "aaa", 2),
      row("del", "bbb", 3),
      row("add", "xxx", undefined, 2),
      row("add", "yyy", undefined, 3),
      row("context", "c2", 4, 4),
    ];
    const out = buildSplitRows(rows);
    expect(texts(out)).toEqual([["c1", "c1"], ["aaa", "xxx"], ["bbb", "yyy"], ["c2", "c2"]]);
    expect(out[0].type === "pair" && out[0].block).toBeUndefined();
    expect(out[1].type === "pair" && out[1].block).toBe(0);
  });

  it("不等长块：相似的行对齐，其余并排摆、多出的一侧留空", () => {
    const rows: DiffRow[] = [
      row("del", "foo(a, b)", 1),
      row("add", "// new", undefined, 1),
      row("add", "foo(a, b, c)", undefined, 2),
      row("add", "// end", undefined, 3),
    ];
    expect(texts(buildSplitRows(rows))).toEqual([
      [null, "// new"],
      ["foo(a, b)", "foo(a, b, c)"],
      [null, "// end"],
    ]);
  });

  it("纯新增 / 纯删除：另一侧整列留空", () => {
    expect(texts(buildSplitRows([row("add", "a", undefined, 1), row("add", "b", undefined, 2)]))).toEqual([
      [null, "a"],
      [null, "b"],
    ]);
    expect(texts(buildSplitRows([row("del", "a", 1), row("del", "b", 2)]))).toEqual([
      ["a", null],
      ["b", null],
    ]);
  });

  it("gap 原样透传并带上 rows 下标", () => {
    const out = buildSplitRows([row("context", "a", 1, 1), gapRow(7, 12), row("add", "b", undefined, 20)]);
    expect(out[1]).toMatchObject({ type: "gap", rowIndex: 1, gap: { key: 7, hidden: 12 } });
  });

  it("块编号与 findChangeBlocks 一致，包括「删增删增」交错的连续变更", () => {
    const rows: DiffRow[] = [
      row("context", "c", 1, 1),
      row("del", "a", 2),
      row("add", "b", undefined, 2),
      row("del", "c", 3),
      row("add", "d", undefined, 3),
      row("context", "c", 4, 4),
      row("add", "e", undefined, 5),
    ];
    const blocks = findChangeBlocks(rows);
    expect(blocks).toHaveLength(2);
    const nums = buildSplitRows(rows).flatMap((r) => (r.type === "pair" && r.block !== undefined ? [r.block] : []));
    expect(nums).toEqual([0, 0, 1]);
  });

  describe("「无结尾换行」标记属于它前面那一行", () => {
    const MARK = "\\ No newline at end of file";
    const blockNos = (rows: DiffRow[]) =>
      buildSplitRows(rows).flatMap((r) => (r.type === "pair" && r.block !== undefined ? [r.block] : []));

    it("两侧都没有结尾换行：删增并排成一行，两个标记各在自己那一侧、并排放在下面", () => {
      const out = buildSplitRows([row("del", "a", 1), marker(), row("add", "b", undefined, 1), marker()]);
      expect(texts(out)).toEqual([
        ["a", "b"],
        [MARK, MARK],
      ]);
      // 标记带所属块号（与 unified 里一样随块一起高亮）
      expect(out.map((r) => (r.type === "pair" ? r.block : "gap"))).toEqual([0, 0]);
      // 左右是各自的标记行（rowIndex 不同），不是同一格
      const m = out[1];
      expect(m.type === "pair" ? [m.left?.rowIndex, m.right?.rowIndex] : null).toEqual([1, 3]);
    });

    it("只有旧侧没有结尾换行（新侧补上了）：标记只在左", () => {
      expect(texts(buildSplitRows([row("del", "a", 1), marker(), row("add", "b", undefined, 1)]))).toEqual([
        ["a", "b"],
        [MARK, null],
      ]);
    });

    it("只有新侧没有结尾换行（旧侧原本有）：标记只在右", () => {
      expect(texts(buildSplitRows([row("del", "a", 1), row("add", "b", undefined, 1), marker()]))).toEqual([
        ["a", "b"],
        [null, MARK],
      ]);
    });

    it("纯删除 / 纯新增最后一行：标记跟着那一侧", () => {
      expect(texts(buildSplitRows([row("del", "a", 1), marker()]))).toEqual([
        ["a", null],
        [MARK, null],
      ]);
      expect(texts(buildSplitRows([row("add", "a", undefined, 1), marker()]))).toEqual([
        [null, "a"],
        [null, MARK],
      ]);
    });

    it("多行块：标记放在这个子块最后一行的下面，不夹在中间", () => {
      const out = buildSplitRows([
        row("del", "a", 1),
        row("del", "b", 2),
        marker(),
        row("add", "c", undefined, 1),
        row("add", "d", undefined, 2),
        row("add", "e", undefined, 3),
        marker(),
      ]);
      expect(texts(out)).toEqual([
        ["a", "c"],
        ["b", "d"],
        [null, "e"],
        [MARK, MARK],
      ]);
    });

    it("跟在上下文行后面的标记属于那一行：两侧都放同一格、不带块号", () => {
      const out = buildSplitRows([row("context", "z", 1, 1), marker()]);
      expect(texts(out)).toEqual([
        ["z", "z"],
        [MARK, MARK],
      ]);
      expect(out.every((r) => r.type === "pair" && r.block === undefined)).toBe(true);
      const m = out[1];
      expect(m.type === "pair" ? m.left?.rowIndex === m.right?.rowIndex : null).toBe(true);
    });

    it("标记不能越过上下文行去和后面的增行并块", () => {
      const rows = [row("del", "a", 1), marker(), row("context", "c", 2, 1), row("add", "b", undefined, 2)];
      expect(findChangeBlocks(rows)).toEqual([
        { start: 0, end: 2, adds: 0, dels: 1 },
        { start: 3, end: 4, adds: 1, dels: 0 },
      ]);
      expect(blockNos(rows)).toEqual([0, 0, 1]);
    });

    it("连着交错的变更（删增删增）+ 标记：仍是一块，块号与 findChangeBlocks 一致", () => {
      const rows = [
        row("del", "a", 1),
        marker(),
        row("add", "b", undefined, 1),
        row("del", "c", 2),
        row("add", "d", undefined, 2),
        marker(),
      ];
      expect(findChangeBlocks(rows)).toEqual([{ start: 0, end: 6, adds: 2, dels: 2 }]);
      expect(new Set(blockNos(rows))).toEqual(new Set([0]));
    });

    it("畸形输入（连着两条标记）：不死循环，块号与 findChangeBlocks 仍一致", () => {
      const rows = [row("del", "a", 1), marker(), marker(), row("add", "b", undefined, 1)];
      expect(findChangeBlocks(rows)).toHaveLength(2);
      expect([...new Set(blockNos(rows))]).toEqual([0, 1]);
    });
  });

  it("性质：每个 line 行至少出现在一个格子里（不丢行），随机 diff 也成立", () => {
    const rng = makeRng(4242);
    for (let k = 0; k < 40; k++) {
      const { oldLines, newLines } = randomCase(rng);
      const full = gitDiff(oldLines, newLines, DIFF_CONTEXT_LINES);
      if (!full) continue;
      const rows = buildBaseRows(full).rows;
      const seen = new Set<number>();
      for (const r of buildSplitRows(rows)) {
        if (r.type !== "pair") continue;
        if (r.left) seen.add(r.left.rowIndex);
        if (r.right) seen.add(r.right.rowIndex);
      }
      rows.forEach((r, idx) => {
        if (r.type === "line") expect(seen.has(idx), `#${k} 行 ${idx}`).toBe(true);
      });
      // 删除行只会出现在左侧、新增行只会出现在右侧
      for (const r of buildSplitRows(rows)) {
        if (r.type !== "pair") continue;
        if (r.left) expect(r.left.line.kind).not.toBe("add");
        if (r.right) expect(r.right.line.kind).not.toBe("del");
      }
    }
  });
});

describe("totalHiddenLines / expandAllGaps", () => {
  it("totalHiddenLines：累加所有 gap 的 hidden，未知（null）不计", () => {
    expect(
      totalHiddenLines([gapRow(1, 10), row("add", "x", undefined, 1), gapRow(2, 5), gapRow(3, null)]),
    ).toBe(15);
    expect(totalHiddenLines([])).toBe(0);
    expect(totalHiddenLines([row("context", "a", 1, 1)])).toBe(0);
  });

  it("expandAllGaps：每个 gap 都设成全部展开，不改入参，非 gap 行不受影响", () => {
    const rows = [gapRow(3, 10), row("add", "x", undefined, 13), gapRow(40, 5)];
    const before = new Map([[3, { top: 20, bottom: 0 }]]);
    const out = expandAllGaps(before, rows);
    expect(out.get(3)?.top).toBeGreaterThan(1_000_000);
    expect(out.get(3)?.bottom).toBeGreaterThan(1_000_000);
    expect(out.get(40)?.top).toBeGreaterThan(1_000_000);
    expect(out.size).toBe(2);
    // 入参没被改
    expect(before.get(3)).toEqual({ top: 20, bottom: 0 });
    expect(before.size).toBe(1);
  });

  it("没有 gap 的行：原样返回等价的 Map", () => {
    const out = expandAllGaps(EMPTY_EXPANSION, [row("context", "a", 1, 1)]);
    expect(out.size).toBe(0);
  });

  it("真 git 的整文件 diff 上：expandAllGaps 之后一个 gap 都不剩，文件每一行都在", () => {
    const oldLines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`);
    const newLines = [...oldLines];
    newLines[19] = "changed 20";
    newLines[79] = "changed 80";
    const full = gitDiff(oldLines, newLines, 1_000_000);
    const folded = buildFullRows(full, EMPTY_EXPANSION);
    expect(folded).not.toBeNull();
    expect(gapsOf(folded!).length).toBeGreaterThan(0);
    // 两个改动各露出「前 3 + 改动 + 后 3」= 7 行新侧内容，其余 86 行折叠
    expect(totalHiddenLines(folded!)).toBe(86);

    const expanded = buildFullRows(full, expandAllGaps(EMPTY_EXPANSION, folded!));
    expect(expanded).not.toBeNull();
    expect(gapsOf(expanded!)).toHaveLength(0);
    expect(totalHiddenLines(expanded!)).toBe(0);
    const newSide = linesOf(expanded!)
      .filter((l) => l.newLine !== undefined)
      .map((l) => l.newLine);
    expect(newSide).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
  });
});
