/**
 * diff 渲染模型的随机回归（真 git）。
 *
 * 来源：审查 R11 时审查 AI 写的 fuzz。这里固定种子、缩小规模并入仓库当回归（约几秒）。
 * 用真 git `diff --no-index` 生成随机「旧 / 新」文件对（行数 0~400、LF / CRLF / 混合行尾、有无末尾换行、
 * 重复行、移动 / 复制 / 整体换行尾 / 清空 / 重写、内容行里带 `--- x` `+++ y` `@@ ... @@` `diff --git` `\ No newline…`、
 * 中文 / emoji / tab / 行尾空白；四种 diff 算法；25% 带 `-w`），检验 `lib/diff/model.ts` 的不变量：
 *  - I1 全部展开后能重建出原文件，行号 1..N 连续；
 *  - I2 `-U3` 的折叠视图与整文件（-U1000000）折叠后的初始视图逐行一致；
 *  - I3 逐步展开守恒：可见 + 隐藏 = 总行数；每步多露出 min(20, hidden) 行；可见行是全量序列的子序列；
 *  - I4 并排视图：左右栏 rowIndex 严格递增、覆盖与 rows 一致、块编号与 findChangeBlocks 一致、块的格子范围一致；
 *  - I6 词级 range 升序 / 不重叠 / 非空 / 不越界；
 *  - I7 变更块数 / 增删行数与「忽略无结尾换行标记」的独立 oracle 一致（标记属于它前面那一行，
 *    不能把「删 → 标记 → 增」切成两块——I4 只钉分栏与 findChangeBlocks 彼此一致，旧实现也满足，抓不住这类回退）；
 * 以及 `lib/diff/intraline.ts` 的 pairChangeBlock / diffLineWords 的结构性质。
 *
 * 加大力度（失败时断言消息里有 seed / 序号 / 旧新文本，直接复现）：
 *   FUZZ_N=3000 FUZZ_SEED=<n> pnpm exec vitest run tests/diff-model-fuzz.test.ts
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  computeIntralineRanges,
  diffLineWords,
  pairChangeBlock,
  PAIR_MAX_CELLS,
} from "@/lib/diff/intraline";
import {
  EMPTY_EXPANSION,
  buildBaseRows,
  buildFullRows,
  buildSplitRows,
  expandAllGaps,
  expandGap,
  findChangeBlocks,
  isNoNewlineMarker,
  lineSourceText,
  toViewLines,
  type DiffRow,
  type ExpansionMap,
} from "@/lib/diff/model";

/** 默认规模：固定种子、约几秒。环境变量可加大 */
const DEFAULT_N = 200;
const N = Number(process.env.FUZZ_N ?? DEFAULT_N);
const SEED = Number(process.env.FUZZ_SEED ?? 20261023);
/** 有效用例（git 认为有差异的）至少占多少——防止生成器坏了、全被跳过而「零失败」的假绿 */
const MIN_CHECKED_RATIO = 0.8;

// ---------------------------------------------------------------- 随机
const rngOf = (seed: number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};
const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
const int = (r: () => number, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));

const VOCAB = [
  "a",
  "b",
  "c",
  "{",
  "}",
  "",
  "  ",
  "return x;",
  "  // comment",
  "x = 1",
  "x = 2",
  "--- x",
  "+++ y",
  "-- sql comment",
  "++i;",
  "@@ -1,2 +3,4 @@",
  "diff --git a/x b/x",
  "index abc..def 100644",
  "\\ No newline at end of file",
  "中文行 测试",
  "emoji 😀 line",
  "\tTab\tindent",
  "trailing ws   ",
  "    nested(a, b, c);",
  "const veryLongIdentifierName = someFunction(argumentOne, argumentTwo);",
];

// ---------------------------------------------------------------- 文件规格
interface Ln {
  c: string;
  eol: "\n" | "\r\n";
}
interface Spec {
  lines: Ln[];
  /** 末尾是否有换行 */
  tnl: boolean;
}

/** 让「独一无二的行」编号：每轮 fuzz 开头清零，保证同一个种子永远生成同样的文件 */
let uniq = 0;
const genLine = (r: () => number, eol: Ln["eol"]): Ln => ({
  c: r() < 0.55 ? pick(r, VOCAB) : `u${uniq++} ${pick(r, VOCAB)}`,
  eol,
});

const normalize = (s: Spec): Spec => {
  if (s.lines.length === 0) return { lines: [], tnl: true };
  const last = s.lines[s.lines.length - 1] as Ln;
  // 「最后一行内容为空且无换行」在文件文本上等价于没有这一行，规格里不允许
  if (!s.tnl && last.c === "") return { ...s, tnl: true };
  return s;
};

const render = (s: Spec): string =>
  s.lines.length === 0
    ? ""
    : s.lines.map((l, i) => l.c + (i === s.lines.length - 1 && !s.tnl ? "" : l.eol)).join("");

/** diff 里每一行的文本（CRLF 的 \r 留在行尾） */
const lineTexts = (s: Spec): string[] =>
  s.lines.map(
    (l, i) => l.c + (l.eol === "\r\n" && (i < s.lines.length - 1 || s.tnl) ? "\r" : ""),
  );

const genFile = (r: () => number): Spec => {
  const x = r();
  const n =
    x < 0.05
      ? 0
      : x < 0.1
        ? 1
        : x < 0.3
          ? int(r, 2, 6)
          : x < 0.7
            ? int(r, 7, 30)
            : x < 0.95
              ? int(r, 31, 120)
              : int(r, 121, 400);
  const mode = pick(r, ["lf", "lf", "lf", "crlf", "mixed"] as const);
  const lines = Array.from({ length: n }, () =>
    genLine(r, mode === "lf" ? "\n" : mode === "crlf" ? "\r\n" : r() < 0.25 ? "\r\n" : "\n"),
  );
  return normalize({ lines, tnl: r() < 0.85 });
};

const mutate = (r: () => number, f: Spec): Spec => {
  let lines = f.lines.map((l) => ({ ...l }));
  const mainEol: Ln["eol"] = lines[0]?.eol ?? "\n";
  const x = r();
  if (x < 0.04) return normalize({ lines: [], tnl: true }); // 清空
  if (x < 0.08) {
    // 整体换行尾：每行内容不变、只是 LF <-> CRLF
    lines = lines.map((l) => ({ ...l, eol: l.eol === "\n" ? "\r\n" : "\n" }));
    return normalize({ lines, tnl: f.tnl });
  }
  if (x < 0.12) {
    // 完全重写
    const n = int(r, 0, 40);
    lines = Array.from({ length: n }, () => genLine(r, mainEol));
    return normalize({ lines, tnl: r() < 0.85 });
  }
  const k = int(r, 1, 7);
  for (let t = 0; t < k; t++) {
    const op = r();
    const pos = int(r, 0, lines.length);
    const len = int(r, 1, Math.min(10, Math.max(1, lines.length)));
    if (op < 0.22) {
      lines.splice(pos, len); // 删
    } else if (op < 0.45) {
      lines.splice(pos, 0, ...Array.from({ length: len }, () => genLine(r, mainEol))); // 插
    } else if (op < 0.72) {
      for (let i = pos; i < Math.min(lines.length, pos + len); i++) {
        const l = lines[i] as Ln;
        lines[i] = r() < 0.5 ? { ...l, c: `${l.c} mod${int(r, 0, 3)}` } : genLine(r, l.eol); // 改
      }
    } else if (op < 0.86) {
      const seg = lines.slice(pos, pos + len).map((l) => ({ ...l })); // 复制一段
      lines.splice(pos + len, 0, ...seg);
    } else {
      const seg = lines.splice(pos, len); // 移动
      lines.splice(int(r, 0, lines.length), 0, ...seg);
    }
  }
  return normalize({ lines, tnl: r() < 0.88 ? f.tnl : !f.tnl });
};

// ---------------------------------------------------------------- git
/** 在 git hook 里跑测试时这些变量会指向「外层仓」；用户的全局 / 系统配置也不能影响输出格式 */
const GIT_ENV = ((): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    LC_ALL: "C",
  };
  for (const k of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_PREFIX",
    "GIT_COMMON_DIR",
    "GIT_OBJECT_DIRECTORY",
  ]) {
    delete env[k];
  }
  return env;
})();
const ALGOS = ["myers", "minimal", "patience", "histogram"] as const;

const gitDiff = (dir: string, ctx: number, algo: string, ws: boolean): string => {
  const r = spawnSync(
    "git",
    [
      "diff",
      "--no-index",
      "--no-color",
      "--no-ext-diff",
      `--diff-algorithm=${algo}`,
      `-U${ctx}`,
      ...(ws ? ["-w"] : []),
      "--",
      "old",
      "new",
    ],
    { cwd: dir, encoding: "utf8", env: GIT_ENV, maxBuffer: 1 << 28 },
  );
  // --no-index：有差异时退出码是 1
  if (r.status !== 0 && r.status !== 1) throw new Error(`git exit ${r.status}: ${r.stderr}`);
  return r.stdout;
};

// ---------------------------------------------------------------- 检查
type LineRow = Extract<DiffRow, { type: "line" }>;
type GapRow = Extract<DiffRow, { type: "gap" }>;
const isLineRow = (r: DiffRow): r is LineRow => r.type === "line";
const isGapRow = (r: DiffRow): r is GapRow => r.type === "gap";
const visibleItems = (rs: readonly DiffRow[]): number =>
  rs.filter((r) => isLineRow(r) && !isNoNewlineMarker(r.line)).length;
const hiddenSum = (rs: readonly DiffRow[]): number =>
  rs.reduce((n, r) => (r.type === "gap" ? n + (r.gap.hidden ?? 0) : n), 0);
const strictlyInc = (xs: readonly number[]): boolean =>
  xs.every((x, i) => i === 0 || x > (xs[i - 1] as number));

type Fail = (m: string) => void;

const checkSplit = (rows: readonly DiffRow[], tag: string, fail: Fail): void => {
  const split = buildSplitRows(rows);
  const blocks = findChangeBlocks(rows);
  const leftIdx: number[] = [];
  const rightIdx: number[] = [];
  const blockSeq: number[] = [];
  const blockCells = new Map<number, number[]>();
  for (const s of split) {
    if (s.type === "gap") {
      if (rows[s.rowIndex]?.type !== "gap") fail(`${tag}: split gap rowIndex 不是 gap`);
      continue;
    }
    for (const c of [s.left, s.right]) {
      if (!c) continue;
      const src = rows[c.rowIndex];
      if (!src || src.type !== "line" || src.line !== c.line) {
        fail(`${tag}: cell 与 rows[rowIndex] 对不上`);
      }
    }
    if (s.left) leftIdx.push(s.left.rowIndex);
    if (s.right) rightIdx.push(s.right.rowIndex);
    if (s.left?.line.kind === "add") fail(`${tag}: 新增行出现在左栏`);
    if (s.right?.line.kind === "del") fail(`${tag}: 删除行出现在右栏`);
    if (s.block !== undefined) {
      blockSeq.push(s.block);
      const cells = blockCells.get(s.block) ?? [];
      if (s.left) cells.push(s.left.rowIndex);
      if (s.right) cells.push(s.right.rowIndex);
      blockCells.set(s.block, cells);
    } else {
      for (const c of [s.left, s.right]) {
        if (c && (c.line.kind === "add" || c.line.kind === "del")) {
          fail(`${tag}: 变更行没有 block 号`);
        }
      }
      if (s.left && s.right && s.left.rowIndex !== s.right.rowIndex) {
        fail(`${tag}: 上下文行左右不是同一格`);
      }
    }
  }
  if (!strictlyInc(leftIdx)) fail(`${tag}: 左栏 rowIndex 不是严格递增`);
  if (!strictlyInc(rightIdx)) fail(`${tag}: 右栏 rowIndex 不是严格递增`);

  const isMarkerAt = (i: number): boolean => {
    const r = rows[i];
    return !!r && r.type === "line" && isNoNewlineMarker(r.line);
  };
  const expectLeft: number[] = [];
  const expectRight: number[] = [];
  rows.forEach((r, i) => {
    if (r.type !== "line" || isNoNewlineMarker(r.line)) return;
    if (r.line.kind === "context" || r.line.kind === "del") expectLeft.push(i);
    if (r.line.kind === "context" || r.line.kind === "add") expectRight.push(i);
  });
  if (JSON.stringify(expectLeft) !== JSON.stringify(leftIdx.filter((i) => !isMarkerAt(i)))) {
    fail(`${tag}: 左栏覆盖的行与 rows 里的 旧侧行 不一致`);
  }
  if (JSON.stringify(expectRight) !== JSON.stringify(rightIdx.filter((i) => !isMarkerAt(i)))) {
    fail(`${tag}: 右栏覆盖的行与 rows 里的 新侧行 不一致`);
  }
  const seen = new Set<number>([...leftIdx, ...rightIdx]);
  rows.forEach((r, i) => {
    if (r.type === "line" && isNoNewlineMarker(r.line) && !seen.has(i)) {
      fail(`${tag}: 无结尾换行标记 ${i} 丢了`);
    }
  });

  const distinct = [...new Set(blockSeq)];
  if (distinct.length !== blocks.length) {
    fail(`${tag}: block 数 ${distinct.length} != findChangeBlocks ${blocks.length}`);
  }
  if (!blockSeq.every((b, i) => i === 0 || b >= (blockSeq[i - 1] as number))) {
    fail(`${tag}: block 号不单调`);
  }
  distinct.forEach((b, i) => {
    if (b !== i) fail(`${tag}: block 号不连续（${distinct.join(",")}）`);
  });
  blocks.forEach((blk, bi) => {
    const cells = [...new Set(blockCells.get(bi) ?? [])].sort((x, y) => x - y);
    const want = Array.from({ length: blk.end - blk.start }, (_, k) => blk.start + k);
    if (JSON.stringify(cells) !== JSON.stringify(want)) {
      fail(`${tag}: block ${bi} 的格子范围与 findChangeBlocks 不一致`);
    }
  });
};

const checkRanges = (rows: readonly DiffRow[], tag: string, fail: Fail): void => {
  const view = toViewLines(rows);
  const ranges = computeIntralineRanges(view);
  for (const [idx, list] of ranges) {
    const line = view[idx];
    if (!line || (line.kind !== "add" && line.kind !== "del")) {
      fail(`${tag}: range 挂在非增删行 ${idx}`);
      continue;
    }
    const len = lineSourceText(line).length;
    let prevEnd = 0;
    for (const rg of list) {
      if (!(rg.start >= prevEnd && rg.end > rg.start && rg.end <= len)) {
        fail(`${tag}: range 非法 idx=${idx} [${rg.start},${rg.end}) len=${len} prevEnd=${prevEnd}`);
      }
      prevEnd = rg.end;
    }
  }
};

/**
 * I7：变更块数 / 增删行数与一个跟实现无关的 oracle 一致——把所有「无结尾换行」标记行忽略掉，
 * 连续的增 / 删行就是一块（上下文行 / gap 仍然切开）。
 * 「最后一行被改 + 文件无结尾换行」时 git 会输出「删 → 标记 → 增 → 标记」，它必须是一处改动、不是两处。
 */
const checkBlocks = (rows: readonly DiffRow[], tag: string, fail: Fail): void => {
  let want = 0;
  let inRun = false;
  let adds = 0;
  let dels = 0;
  for (const r of rows) {
    if (r.type === "line" && isNoNewlineMarker(r.line)) continue;
    const kind = r.type === "line" ? r.line.kind : null;
    const change = kind === "add" || kind === "del";
    if (change && !inRun) want += 1;
    if (kind === "add") adds += 1;
    if (kind === "del") dels += 1;
    inRun = change;
  }
  const blocks = findChangeBlocks(rows);
  if (blocks.length !== want) fail(`${tag}: 变更块数 ${blocks.length}，忽略标记后的口径应为 ${want}`);
  if (blocks.reduce((n, b) => n + b.adds, 0) !== adds) fail(`${tag}: 块内新增行数合计与实际不符`);
  if (blocks.reduce((n, b) => n + b.dels, 0) !== dels) fail(`${tag}: 块内删除行数合计与实际不符`);
  // 紧跟增 / 删行的标记，必须和那一行在同一块里
  rows.forEach((r, i) => {
    if (r.type !== "line" || !isNoNewlineMarker(r.line)) return;
    const prev = rows[i - 1];
    if (!prev || prev.type !== "line") return;
    if (prev.line.kind !== "add" && prev.line.kind !== "del") return;
    const blk = blocks.find((b) => b.start <= i - 1 && i - 1 < b.end);
    if (!blk || i >= blk.end) fail(`${tag}: 标记 ${i} 没有和它前面的改动行在同一块`);
  });
  // 每块都从增 / 删行开始（标记只会出现在块尾 / 块中，不会当块头）
  blocks.forEach((b, bi) => {
    const first = rows[b.start];
    if (first?.type !== "line" || (first.line.kind !== "add" && first.line.kind !== "del")) {
      fail(`${tag}: 块 ${bi} 的第一行不是增 / 删行`);
    }
  });
};

type Verdict = "skip" | string[];

const checkCase = (
  dir: string,
  oldS: Spec,
  newS: Spec,
  algo: string,
  ws: boolean,
  seed: number,
): Verdict => {
  const base = gitDiff(dir, 3, algo, ws);
  if (!base) return "skip";
  const full = gitDiff(dir, 1_000_000, algo, ws);
  const fails: string[] = [];
  const fail: Fail = (m) => fails.push(m);

  const baseModel = buildBaseRows(base);
  const rows0 = buildFullRows(full);
  if (!rows0) {
    fail("buildFullRows 对单文件整文件 diff 返回 null");
    return fails;
  }

  // I1：全部展开后能重建出原文件、行号 1..N 连续
  const all = buildFullRows(full, expandAllGaps(EMPTY_EXPANSION, rows0)) as DiffRow[];
  if (all.some((r) => r.type === "gap")) fail("I1: 全部展开后仍有 gap");
  const norm = (s: string) => (ws ? s.replace(/\s+/g, "") : s);
  const lines = all.filter(isLineRow).map((r) => r.line);
  const oldSide = lines.filter(
    (l) => (l.kind === "context" || l.kind === "del") && !isNoNewlineMarker(l),
  );
  const newSide = lines.filter(
    (l) => (l.kind === "context" || l.kind === "add") && !isNoNewlineMarker(l),
  );
  const oldT = lineTexts(oldS);
  const newT = lineTexts(newS);
  if (oldSide.length !== oldT.length) {
    fail(`I1: 旧侧行数 ${oldSide.length} != 实际 ${oldT.length}`);
  } else {
    oldSide.forEach((l, i) => {
      if (l.oldLine !== i + 1) fail(`I1: 旧侧第 ${i + 1} 行行号是 ${String(l.oldLine)}`);
      if (norm(l.text) !== norm(oldT[i] as string)) fail(`I1: 旧侧第 ${i + 1} 行文本不一致`);
    });
  }
  if (newSide.length !== newT.length) {
    fail(`I1: 新侧行数 ${newSide.length} != 实际 ${newT.length}`);
  } else {
    newSide.forEach((l, i) => {
      if (l.newLine !== i + 1) fail(`I1: 新侧第 ${i + 1} 行行号是 ${String(l.newLine)}`);
      if (norm(l.text) !== norm(newT[i] as string)) fail(`I1: 新侧第 ${i + 1} 行文本不一致`);
    });
  }

  // I2：base 与 full 的初始视图一致（base 末尾可多一个 hidden=null 的 bottom gap）
  const sig = (r: DiffRow): string =>
    r.type === "line"
      ? `L|${r.line.kind}|${r.line.oldLine ?? ""}|${r.line.newLine ?? ""}|${r.line.text}`
      : `G|${r.gap.key}|${r.gap.position}|${r.gap.startNew ?? ""}|${r.gap.position === "bottom" ? "*" : String(r.gap.hidden)}`;
  let b = baseModel.rows;
  const lastB = b[b.length - 1];
  const lastF = rows0[rows0.length - 1];
  if (
    lastB?.type === "gap" &&
    lastB.gap.position === "bottom" &&
    !(lastF?.type === "gap" && lastF.gap.position === "bottom")
  ) {
    b = b.slice(0, -1);
  }
  const bs = b.map(sig);
  const fs = rows0.map(sig);
  if (bs.join("\n") !== fs.join("\n")) {
    const at = bs.findIndex((x, i) => x !== fs[i]);
    fail(
      `I2: base 与 full 初始视图不一致（首个差异下标 ${at}；base=${bs[at] ?? "∅"}；full=${fs[at] ?? "∅"}）`,
    );
  }

  // I3：逐步展开守恒
  const total = visibleItems(all);
  if (visibleItems(rows0) + hiddenSum(rows0) !== total) fail("I3: 初始 可见+隐藏 != 总行数");
  const r = rngOf(seed ^ (oldT.length * 7919 + newT.length * 104729));
  let map: ExpansionMap = EMPTY_EXPANSION;
  let rows: DiffRow[] = rows0;
  const allSigs = all
    .filter(isLineRow)
    .map((x) => `${x.line.kind}|${x.line.oldLine ?? ""}|${x.line.newLine ?? ""}`);
  for (let step = 0; step < 10; step++) {
    const gaps = rows.filter(isGapRow);
    if (gaps.length === 0) break;
    const g = pick(r, gaps).gap;
    const dir =
      g.position === "top"
        ? pick(r, ["up", "all"] as const)
        : g.position === "bottom"
          ? pick(r, ["down", "all"] as const)
          : pick(r, ["up", "down", "all"] as const);
    const before = visibleItems(rows);
    map = expandGap(map, g.key, dir);
    const next = buildFullRows(full, map);
    if (!next) {
      fail("I3: 展开后 buildFullRows 返回 null");
      break;
    }
    const gained = visibleItems(next) - before;
    const want = dir === "all" ? (g.hidden as number) : Math.min(20, g.hidden as number);
    if (gained !== want) {
      fail(
        `I3: 展开 ${dir} gap(key=${g.key},pos=${g.position},hidden=${String(g.hidden)}) 多露出 ${gained} 行，期望 ${want}`,
      );
    }
    if (visibleItems(next) + hiddenSum(next) !== total) fail("I3: 展开后 可见+隐藏 != 总行数");
    // 可见行序列是全量序列的子序列
    const sigs = next
      .filter(isLineRow)
      .map((x) => `${x.line.kind}|${x.line.oldLine ?? ""}|${x.line.newLine ?? ""}`);
    let p = 0;
    for (const s of sigs) {
      while (p < allSigs.length && allSigs[p] !== s) p += 1;
      if (p === allSigs.length) {
        fail(`I3: 展开后的可见行不是全量序列的子序列（${s}）`);
        break;
      }
      p += 1;
    }
    rows = next;
    if (step < 3) {
      checkSplit(rows, `I4(step${step})`, fail);
      checkBlocks(rows, `I7(step${step})`, fail);
    }
  }

  // I4：split 性质
  checkSplit(baseModel.rows, "I4(base)", fail);
  checkSplit(rows0, "I4(full0)", fail);
  checkSplit(all, "I4(all)", fail);
  // I7：变更块与「忽略标记」的 oracle 一致
  checkBlocks(baseModel.rows, "I7(base)", fail);
  checkBlocks(rows0, "I7(full0)", fail);
  checkBlocks(all, "I7(all)", fail);
  // I6：词级 range 合法
  checkRanges(rows0, "I6(full0)", fail);
  checkRanges(all, "I6(all)", fail);
  return fails;
};

interface FuzzFailure {
  i: number;
  algo: string;
  ws: boolean;
  fails: string[];
  oldText: string;
  newText: string;
}

const runModelFuzz = (seed: number, n: number): { checked: number; failures: FuzzFailure[] } => {
  uniq = 0;
  const dir = mkdtempSync(path.join(tmpdir(), "flowship-diff-fuzz-"));
  const r = rngOf(seed);
  const failures: FuzzFailure[] = [];
  let checked = 0;
  try {
    for (let i = 0; i < n; i++) {
      const oldS = genFile(r);
      const newS = mutate(r, oldS);
      const algo = pick(r, ALGOS);
      const ws = r() < 0.25;
      writeFileSync(path.join(dir, "old"), render(oldS));
      writeFileSync(path.join(dir, "new"), render(newS));
      let v: Verdict;
      try {
        v = checkCase(dir, oldS, newS, algo, ws, seed);
      } catch (e) {
        v = [`抛异常：${(e as Error).stack ?? String(e)}`];
      }
      if (v === "skip") continue;
      checked += 1;
      if (v.length > 0) {
        failures.push({ i, algo, ws, fails: v, oldText: render(oldS), newText: render(newS) });
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return { checked, failures };
};

/** 失败时的报告：序号 / 算法 / 前几条违反的不变量 / 旧新文本（截断）——够复现 */
const report = (seed: number, failures: readonly FuzzFailure[]): string =>
  failures
    .slice(0, 5)
    .map(
      (f) =>
        `seed=${seed} case#${f.i} algo=${f.algo} ws=${f.ws}\n  - ${f.fails.slice(0, 4).join("\n  - ")}\n` +
        `  old=${JSON.stringify(f.oldText).slice(0, 240)}\n  new=${JSON.stringify(f.newText).slice(0, 240)}`,
    )
    .join("\n");

// `git diff --no-index` 与 /dev/null 作全局配置在 Windows 上不可靠：跳过（开发 / CI 都是类 Unix）
describe.skipIf(process.platform === "win32")("diff 渲染模型随机回归（真 git）", () => {
  it(
    `随机文件对 × 四种 diff 算法 × -w：重建 / 展开守恒 / 并排对齐 / 词级 range（N=${N}, seed=${SEED}）`,
    () => {
      const { checked, failures } = runModelFuzz(SEED, N);
      expect(failures.length, report(SEED, failures)).toBe(0);
      // 零失败不等于测过了：有效用例必须占绝大多数（git 认为有差异的）
      expect(checked, `有效用例只有 ${checked}/${N}`).toBeGreaterThanOrEqual(
        Math.floor(N * MIN_CHECKED_RATIO),
      );
    },
    120_000,
  );

  it(
    "换一个种子再来一轮（不同的文件形态）",
    () => {
      const seed = SEED + 777;
      const n = Math.max(50, Math.floor(N / 2));
      const { checked, failures } = runModelFuzz(seed, n);
      expect(failures.length, report(seed, failures)).toBe(0);
      expect(checked, `有效用例只有 ${checked}/${n}`).toBeGreaterThanOrEqual(
        Math.floor(n * MIN_CHECKED_RATIO),
      );
    },
    120_000,
  );
});

// ---------------------------------------------------------------- intraline
const randWordLine = (r: () => number): string => {
  const n = int(r, 0, 14);
  const words = Array.from({ length: n }, () =>
    pick(r, [
      "foo",
      "bar",
      "baz",
      "x",
      "y1",
      "(",
      ")",
      ",",
      ";",
      " ",
      "  ",
      "中",
      "文",
      "😀",
      "=>",
      "{",
      "}",
      "const",
      "let",
      "\t",
      "é",
      "e\u0301",
    ]),
  );
  return words.join(r() < 0.5 ? "" : " ") + (r() < 0.2 ? "\r" : "");
};

const mutLine = (r: () => number, s: string): string => {
  const x = r();
  if (x < 0.15) return s;
  if (x < 0.3) return randWordLine(r);
  const chars = Array.from(s);
  const k = int(r, 1, 3);
  for (let t = 0; t < k; t++) {
    const op = r();
    const pos = int(r, 0, chars.length);
    if (op < 0.4) chars.splice(pos, int(r, 1, 3));
    else if (op < 0.7) chars.splice(pos, 0, ...Array.from(randWordLine(r)).slice(0, 4));
    else chars.splice(pos, 1, ...Array.from(randWordLine(r)).slice(0, 2));
  }
  return chars.join("");
};

describe("词级高亮随机回归", () => {
  it("pairChangeBlock：下标严格递增且合法；等长一一对应；超规模 / 空侧不配对", () => {
    const r = rngOf(SEED + 1);
    for (let t = 0; t < 5000; t++) {
      const m = r() < 0.1 ? 0 : int(r, 1, r() < 0.2 ? 60 : 12);
      const n = r() < 0.1 ? 0 : int(r, 1, r() < 0.2 ? 60 : 12);
      const pool = Array.from({ length: 6 }, () => randWordLine(r));
      const dels = Array.from({ length: m }, () => mutLine(r, pick(r, pool)));
      const adds = Array.from({ length: n }, () => mutLine(r, pick(r, pool)));
      const pairs = pairChangeBlock(dels, adds);
      const ctx = `第 ${t} 组 m=${m} n=${n}`;
      expect(
        pairs.every((p) => p.del >= 0 && p.del < m && p.add >= 0 && p.add < n),
        ctx,
      ).toBe(true);
      expect(strictlyInc(pairs.map((p) => p.del)), ctx).toBe(true);
      expect(strictlyInc(pairs.map((p) => p.add)), ctx).toBe(true);
      if (m === 0 || n === 0) expect(pairs, ctx).toEqual([]);
      else if (m === n) expect(pairs, ctx).toEqual(dels.map((_, i) => ({ del: i, add: i })));
      else if (m * n > PAIR_MAX_CELLS) expect(pairs, ctx).toEqual([]);
    }
  }, 60_000); // 纯 CPU 的随机回归：本机并发下已是秒级，CI 的 2 核机器更慢，别靠默认 5s 碰运气

  it("diffLineWords：range 升序 / 不重叠 / 非空 / end ≤ 去掉尾部 \\r 后的长度", () => {
    const r = rngOf(SEED + 2);
    let nonNull = 0;
    for (let t = 0; t < 8000; t++) {
      const a = randWordLine(r);
      const b = mutLine(r, a);
      const d = diffLineWords(a, b);
      if (!d) continue;
      nonNull += 1;
      for (const [side, text] of [
        [d.old, a.replace(/\r+$/, "")],
        [d.new, b.replace(/\r+$/, "")],
      ] as const) {
        let prevEnd = 0;
        for (const rg of side) {
          expect(rg.start, `第 ${t} 组`).toBeGreaterThanOrEqual(prevEnd);
          expect(rg.end, `第 ${t} 组`).toBeGreaterThan(rg.start);
          expect(rg.end, `第 ${t} 组`).toBeLessThanOrEqual(text.length);
          prevEnd = rg.end;
        }
      }
    }
    // 生成器要真产出可比的行对：全 null 说明被预检 / 相似度挡光了、这条就成了空测。
    // 种子固定、实测约 4000 / 8000（审查 AI 那边 4020），下限取一半：预检过严也能被抓到
    expect(nonNull, `nonNull=${nonNull}`).toBeGreaterThan(2000);
  }, 60_000); // 同上：纯 CPU 随机回归，别靠默认 5s 碰运气
});
