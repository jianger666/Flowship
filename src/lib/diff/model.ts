/**
 * 代码改动面板的 diff 渲染模型（纯函数、无 React，可脱离 DOM 单测）。
 *
 * 职责：把服务端给的 unified diff 变成「一排可渲染的行」——
 *  - 行：增 / 删 / 上下文（沿用 `parseUnifiedDiff` 的 `DiffViewLine`，行号口径一致）；
 *  - gap：被折叠的一段未改动行（点开可展开上下文）；
 *  - 分栏视图的行配对、变更块索引（n / p 跳转、右缘 minimap 用）。
 *
 * 展开上下文的两级数据：
 *  - base：`-U3` 的 diff（首屏、很轻）。每个 hunk 之间天然有 gap，隐藏行数由 hunk 头算出来；
 *    文件末尾那个 gap 的行数 base 不知道（hidden = null），点开才知道。
 *  - full：整文件 diff（`-U1000000`），第一次点 gap 时才按需拉。有了它，展开 / 收起全在本地。
 *  两级共用同一套 gap 键（= 无展开时首个隐藏行的新文件行号），所以 base 里点的那个 gap，
 *  full 到手后能原地接着展开。**初始（没展开任何东西）时 full 折叠出来的行序列必须与 base 完全一致**
 *  ——否则 full 到手的一瞬间视图会跳，测试里用真 git 逐例验证了这一点。
 */

import { pairChangeBlock } from "@/lib/diff/intraline";
import { isNoNewlineMarker } from "@/lib/diff/marker";
import { parseUnifiedDiff, type DiffViewLine } from "@/lib/tool-display";

/** 改动行前后各保留几行上下文（与 git 默认的 -U3 一致） */
export const DIFF_CONTEXT_LINES = 3;
/** 点一次「展开」多露出几行 */
export const DIFF_EXPAND_STEP = 20;
/** hunk 头里函数上下文的显示上限（超长截断） */
const MAX_HEADING_CHARS = 120;
/** 「全部展开」用的足够大的行数 */
const EXPAND_ALL = 1_000_000_000;

// ======================================================================
// hunk 解析
// ======================================================================

const HUNK_HEAD_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

export interface ParsedHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  /** `@@ … @@` 之后的函数上下文（git 按文件类型挑的「所在函数 / 类」行），可能为空 */
  heading: string;
  /** 本 hunk 的行（不含 hunk 标记行）；`\ No newline at end of file` 标记是 context 且无行号 */
  lines: DiffViewLine[];
  /** 头部残缺（被截断的 diff）：行号 / 行数不可信 */
  malformed: boolean;
}

// 判定本身在 marker.ts（intraline / diff-syntax 也要用，放这里会成环）；对外出口保持不变
export { isNoNewlineMarker };

/**
 * 按 hunk 拆开 diff。
 * 以 `@@` 开头的行一定是 hunk 头（内容行永远带 `+` / `-` / 空格前缀），而 `parseUnifiedDiff`
 * 对每个这样的行恰好产出一个 hunk 标记——所以按出现顺序一一对应，就能拿到它丢掉的函数上下文。
 */
export const splitHunks = (rawDiff: string): ParsedHunk[] => {
  // git 输出以换行结尾——那是最后一行的终止符、不是一行空内容；
  // 不剥掉的话 parseUnifiedDiff 会把它当成「被编辑器剥了尾空格的空上下文行」多出一个无行号的幽灵行
  const diff = rawDiff.endsWith("\n") ? rawDiff.slice(0, -1) : rawDiff;
  if (!diff) return [];
  const headers = diff.split("\n").filter((l) => l.startsWith("@@"));
  const hunks: ParsedHunk[] = [];
  let cur: ParsedHunk | null = null;
  let headerIdx = 0;

  const open = (raw: string | undefined): ParsedHunk => {
    const m = raw === undefined ? null : HUNK_HEAD_RE.exec(raw.replace(/\r$/, ""));
    const hunk: ParsedHunk = m
      ? {
          oldStart: Number(m[1]),
          oldCount: m[2] === undefined ? 1 : Number(m[2]),
          newStart: Number(m[3]),
          newCount: m[4] === undefined ? 1 : Number(m[4]),
          heading: (m[5] ?? "").trim().slice(0, MAX_HEADING_CHARS),
          lines: [],
          malformed: false,
        }
      : {
          oldStart: 0,
          oldCount: 0,
          newStart: 0,
          newCount: 0,
          heading: "",
          lines: [],
          malformed: true,
        };
    hunks.push(hunk);
    return hunk;
  };

  for (const line of parseUnifiedDiff(diff)) {
    if (line.kind === "hunk") {
      cur = open(headers[headerIdx++]);
      continue;
    }
    // 没有 @@ 头就出现的内容行（截断 / 非标准输入）：归到一个隐式 hunk、标残缺
    cur ??= open(undefined);
    cur.lines.push(line);
  }
  return hunks;
};

/** 该 hunk 覆盖的第一个新文件行号（count=0 的纯删除 hunk，start 指「前一行」） */
const hunkFirstNew = (h: ParsedHunk): number =>
  h.newCount === 0 ? h.newStart + 1 : h.newStart;
/** 该 hunk 覆盖到的新文件行号之后的第一行（不含） */
const hunkEndNew = (h: ParsedHunk): number => hunkFirstNew(h) + h.newCount;

// ======================================================================
// 行 / gap
// ======================================================================

/** 折叠起来的一段未改动行 */
export interface DiffGap {
  /**
   * 稳定键 = 「没展开任何东西时」首个隐藏行的新文件行号。
   * 展开状态按它记，展开过程中不会变（真实的当前起点见 startNew）。
   */
  key: number;
  /** 当前还隐藏多少行；null = 未知（base 里的末尾 gap，拉到整文件才知道） */
  hidden: number | null;
  /** 在文件里的位置：top 只能「向上」露出、bottom 只能「向下」露出、middle 两个方向都行 */
  position: "top" | "middle" | "bottom";
  /** 这段隐藏内容之后那个 hunk 的函数上下文（base 里的 `@@` 头带的），用来告诉人「下面是哪个函数」 */
  heading?: string;
  /** 当前隐藏区第一行的新文件行号（用来显示「第 48–112 行」）；未知时缺省 */
  startNew?: number;
}

export type DiffRow =
  | { type: "line"; line: DiffViewLine }
  | { type: "gap"; gap: DiffGap };

/** 每个 gap 已经展开了多少：top = 自上边缘向下露出的行数、bottom = 自下边缘向上露出的行数 */
export interface GapExpansion {
  top: number;
  bottom: number;
}
export type ExpansionMap = ReadonlyMap<number, GapExpansion>;
export const EMPTY_EXPANSION: ExpansionMap = new Map();

/** 展开一个 gap（返回新 Map，不改入参）。hidden = null / all 都按「全部」处理 */
export const expandGap = (
  map: ExpansionMap,
  key: number,
  dir: "up" | "down" | "all",
  step: number = DIFF_EXPAND_STEP,
): ExpansionMap => {
  const prev = map.get(key) ?? { top: 0, bottom: 0 };
  const next: GapExpansion =
    dir === "all"
      ? // top 段只认 bottom、bottom 段只认 top、middle 两个都认——两边都给满才对所有位置都生效
        { top: EXPAND_ALL, bottom: EXPAND_ALL }
      : dir === "down"
        ? { top: prev.top + step, bottom: prev.bottom }
        : { top: prev.top, bottom: prev.bottom + step };
  return new Map(map).set(key, next);
};

/** 把整张展开表收回去（「全部折叠」） */
export const collapseAllGaps = (): ExpansionMap => EMPTY_EXPANSION;

// ======================================================================
// base（-U3）→ 行 + gap
// ======================================================================

export interface BaseModel {
  rows: DiffRow[];
  /** gap 键 → 它之后那个 hunk 的函数上下文；full 到手后沿用 */
  headingByKey: Map<number, string>;
}

/** 末尾连续的真实上下文行数；最后一行是「无结尾换行」标记 = 已经到文件末尾，返回 -1 */
const trailingContext = (lines: readonly DiffViewLine[]): number => {
  const last = lines[lines.length - 1];
  if (last && isNoNewlineMarker(last)) return -1;
  let n = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].kind !== "context") break;
    n += 1;
  }
  return n;
};

/**
 * 把 -U3 的 diff 摆成「行 + gap」。
 * hunk 之间、第一个 hunk 之前的 gap 行数由 hunk 头精确算出；
 * 最后一个 hunk 之后能不能还有内容 base 看不出来（要知道文件总行数），保守地：
 * 末尾上下文凑满 3 行就放一个 hidden=null 的 gap（点开拉整文件后若其实没有更多，它自然消失）。
 */
export const buildBaseRows = (diff: string): BaseModel => {
  const hunks = splitHunks(diff);
  const rows: DiffRow[] = [];
  const headingByKey = new Map<number, string>();

  const pushGap = (gap: DiffGap) => {
    rows.push({ type: "gap", gap });
    if (gap.heading) headingByKey.set(gap.key, gap.heading);
  };

  hunks.forEach((h, idx) => {
    if (idx === 0) {
      if (!h.malformed && hunkFirstNew(h) > 1) {
        pushGap({
          key: 1,
          hidden: hunkFirstNew(h) - 1,
          position: "top",
          startNew: 1,
          ...(h.heading ? { heading: h.heading } : {}),
        });
      }
    } else {
      const prev = hunks[idx - 1];
      if (prev.malformed || h.malformed) {
        // 头残缺 = 不知道中间隔了多少、也展开不了（key 用负数避免与真实行号冲突）
        pushGap({ key: -idx, hidden: null, position: "middle" });
      } else {
        const hidden = hunkFirstNew(h) - hunkEndNew(prev);
        if (hidden > 0) {
          pushGap({
            key: hunkEndNew(prev),
            hidden,
            position: "middle",
            startNew: hunkEndNew(prev),
            ...(h.heading ? { heading: h.heading } : {}),
          });
        }
      }
    }
    for (const line of h.lines) rows.push({ type: "line", line });
  });

  const last = hunks[hunks.length - 1];
  if (last && !last.malformed && trailingContext(last.lines) >= DIFF_CONTEXT_LINES) {
    pushGap({
      key: hunkEndNew(last),
      hidden: null,
      position: "bottom",
      startNew: hunkEndNew(last),
    });
  }
  return { rows, headingByKey };
};

// ======================================================================
// full（整文件 diff）→ 折叠后的行 + gap
// ======================================================================

/** 一个「可见单位」：一行 + 紧跟它的 `\ No newline` 标记（标记属于上一行、不能单独折叠） */
interface Item {
  line: DiffViewLine;
  markers: DiffViewLine[];
}

const toItems = (lines: readonly DiffViewLine[]): Item[] => {
  const items: Item[] = [];
  for (const line of lines) {
    if (isNoNewlineMarker(line) && items.length > 0) {
      items[items.length - 1].markers.push(line);
    } else {
      items.push({ line, markers: [] });
    }
  }
  return items;
};

const pushItem = (rows: DiffRow[], item: Item) => {
  rows.push({ type: "line", line: item.line });
  for (const m of item.markers) rows.push({ type: "line", line: m });
};

/**
 * 整文件 diff 按「上下文 3 行 + 已展开量」折叠。
 * 整文件 diff 理论上只有一个 hunk；出现多个（文件大到变更相隔超百万行，实际不会）就放弃，返回 null 让调用方退回 base。
 *
 * 一段连续的未改动行（seg，长度 L）怎么折：
 *  - 夹在两处改动之间（middle）：头部可见 3+top 行、尾部可见 3+bottom 行，两边加起来够了就整段可见；
 *  - 在文件开头（top）：没有「上边」可往下露，只看尾部 3+bottom 行；
 *  - 在文件末尾（bottom）：只看头部 3+top 行。
 *  L ≤ 6 时 middle 整段可见——与 git 把间距 ≤ 6 的两个 hunk 合并的规则一致。
 */
export const buildFullRows = (
  fullDiff: string,
  expansion: ExpansionMap = EMPTY_EXPANSION,
  headingByKey?: ReadonlyMap<number, string>,
): DiffRow[] | null => {
  const hunks = splitHunks(fullDiff);
  if (hunks.length > 1 || hunks.some((h) => h.malformed)) return null;
  const items = toItems(hunks[0]?.lines ?? []);
  const rows: DiffRow[] = [];

  let i = 0;
  while (i < items.length) {
    if (items[i].line.kind !== "context") {
      pushItem(rows, items[i]);
      i += 1;
      continue;
    }
    // 一段连续的未改动行 [i, j)
    let j = i;
    while (j < items.length && items[j].line.kind === "context") j += 1;
    const seg = items.slice(i, j);
    const len = seg.length;
    const isTop = i === 0;
    const isBottom = j === items.length;
    i = j;

    // 整个文件没有任何改动行：不折叠
    if (isTop && isBottom) {
      for (const it of seg) pushItem(rows, it);
      continue;
    }

    const ctx = DIFF_CONTEXT_LINES;
    // 无展开时的首个隐藏行 = 稳定键（top 段从头隐藏、其余从第 ctx+1 行起）
    const keyIdx = isTop ? 0 : Math.min(ctx, len - 1);
    const key = seg[keyIdx]?.line.newLine ?? -(rows.length + 1);
    const exp = expansion.get(key) ?? { top: 0, bottom: 0 };
    const headCount = isTop ? 0 : Math.min(len, ctx + exp.top);
    const tailCount = isBottom ? 0 : Math.min(len, ctx + exp.bottom);

    if (headCount + tailCount >= len) {
      for (const it of seg) pushItem(rows, it);
      continue;
    }

    for (const it of seg.slice(0, headCount)) pushItem(rows, it);
    const hidden = len - headCount - tailCount;
    const heading = headingByKey?.get(key);
    rows.push({
      type: "gap",
      gap: {
        key,
        hidden,
        position: isTop ? "top" : isBottom ? "bottom" : "middle",
        ...(seg[headCount]?.line.newLine !== undefined
          ? { startNew: seg[headCount].line.newLine }
          : {}),
        ...(heading ? { heading } : {}),
      },
    });
    for (const it of seg.slice(len - tailCount)) pushItem(rows, it);
  }
  return rows;
};

// ======================================================================
// 统一入口
// ======================================================================

export interface DiffRowsInput {
  /** -U3 的 diff（首屏用） */
  base: string;
  /** 整文件 diff（-U1000000）；还没拉 / 拉失败 / 被截断就不给 */
  full?: string | null;
  expansion?: ExpansionMap;
}

export interface DiffRowsResult {
  rows: DiffRow[];
  /** true = 已经有整文件：展开 / 收起全在本地；false = 点 gap 之前得先拉整文件 */
  complete: boolean;
}

export const buildDiffRows = (input: DiffRowsInput): DiffRowsResult => {
  const base = buildBaseRows(input.base);
  if (input.full) {
    const rows = buildFullRows(input.full, input.expansion ?? EMPTY_EXPANSION, base.headingByKey);
    if (rows) return { rows, complete: true };
  }
  return { rows: base.rows, complete: false };
};

// ======================================================================
// 与语法高亮 / 词级高亮对接
// ======================================================================

/**
 * rows → `useDiffSyntaxTokens` / `computeIntralineRanges` 吃的行序列（与 rows 下标一一对应）。
 * gap 变成 hunk 标记：隐藏行把前后两段源码隔开，高亮时不能让文法状态跨过去。
 */
export const toViewLines = (rows: readonly DiffRow[]): DiffViewLine[] =>
  rows.map((r) => (r.type === "line" ? r.line : { kind: "hunk", text: "" }));

/** 去掉行尾 `\r`（CRLF 文件）——语法 token / 词级 range 的下标都以去掉后的文本为准 */
export const lineSourceText = (line: DiffViewLine): string => line.text.replace(/\r$/, "");

// ======================================================================
// 变更块
// ======================================================================

export interface ChangeBlock {
  /** rows 下标，[start, end)；末尾含紧跟增 / 删行的「无结尾换行」标记（它属于前一行） */
  start: number;
  end: number;
  adds: number;
  dels: number;
}

const rowKind = (rows: readonly DiffRow[], i: number): DiffViewLine["kind"] | null => {
  const r = rows[i];
  return r?.type === "line" ? r.line.kind : null;
};

const isMarkerRow = (rows: readonly DiffRow[], i: number): boolean => {
  const r = rows[i];
  return r?.type === "line" && isNoNewlineMarker(r.line);
};

/**
 * 一个「变更子块」：连续的删行 + 紧随其后的连续增行；删行、增行后面各可以挂一条 `\ No newline` 标记。
 *
 * 标记属于它前面那一行（那一侧的最后一行没有结尾换行），不能当成「上下文」把「删 → 增」切成两块——
 * 否则「最后一行被改 + 文件无结尾换行」（`.env`、配置、脚本里很常见）会显示成两处改动：
 * n / p 要按两次、小地图出现两块、分栏里删增上下错开、词级高亮也配不上对。
 *
 * findChangeBlocks 与 buildSplitRows 必须用**同一份**扫描，块编号才不会漂移。
 */
interface ChangeRun {
  /** 删行 [delStart, delEnd) */
  delStart: number;
  delEnd: number;
  /** 紧跟删行的标记行下标；没有 = -1 */
  delMarker: number;
  /** 增行 [addStart, addEnd) */
  addStart: number;
  addEnd: number;
  /** 紧跟增行的标记行下标；没有 = -1 */
  addMarker: number;
  /** 第一个没被这个子块消费的下标 */
  next: number;
}

/** 从 start（必须是增 / 删行）开始扫一个变更子块；至少消费 start 这一行 */
const scanChangeRun = (rows: readonly DiffRow[], start: number): ChangeRun => {
  let i = start;
  const delStart = i;
  while (rowKind(rows, i) === "del") i += 1;
  const delEnd = i;
  let delMarker = -1;
  if (delEnd > delStart && isMarkerRow(rows, i)) {
    delMarker = i;
    i += 1;
  }
  const addStart = i;
  while (rowKind(rows, i) === "add") i += 1;
  const addEnd = i;
  let addMarker = -1;
  if (addEnd > addStart && isMarkerRow(rows, i)) {
    addMarker = i;
    i += 1;
  }
  return { delStart, delEnd, delMarker, addStart, addEnd, addMarker, next: i };
};

/** 连续的增 / 删行 = 一个变更块（紧跟它们的「无结尾换行」标记算块内）；上下文行与 gap 会把它切开 */
export const findChangeBlocks = (rows: readonly DiffRow[]): ChangeBlock[] => {
  const blocks: ChangeBlock[] = [];
  let cur: ChangeBlock | null = null;
  let i = 0;
  while (i < rows.length) {
    const kind = rowKind(rows, i);
    if (kind === "add" || kind === "del") {
      const run = scanChangeRun(rows, i);
      cur ??= { start: i, end: i, adds: 0, dels: 0 };
      cur.end = run.next;
      cur.dels += run.delEnd - run.delStart;
      cur.adds += run.addEnd - run.addStart;
      i = run.next;
    } else {
      if (cur) {
        blocks.push(cur);
        cur = null;
      }
      i += 1;
    }
  }
  if (cur) blocks.push(cur);
  return blocks;
};

// ======================================================================
// 分栏（split）视图
// ======================================================================

export interface SplitCell {
  /** 在 rows / toViewLines 里的下标：取语法 token、词级 range 都靠它 */
  rowIndex: number;
  line: DiffViewLine;
}

export type SplitRow =
  | {
      type: "pair";
      /** 旧侧（左）：上下文 / 删除；null = 这一行旧侧没有 */
      left: SplitCell | null;
      /** 新侧（右）：上下文 / 新增；null = 这一行新侧没有 */
      right: SplitCell | null;
      /** 所属变更块在 findChangeBlocks 结果里的序号；上下文行没有 */
      block?: number;
    }
  | { type: "gap"; rowIndex: number; gap: DiffGap };

/**
 * 一个变更块（先删后增）怎么摆成左右两栏：
 * 等长块一一对应；不等长块借 `pairChangeBlock` 把相似的行对齐（与词级高亮用同一套配对，视觉才一致），
 * 两个配对之间没配上的删 / 增行就并排摆（左删右增、多出的一侧留空）。
 */
const layoutChangeBlock = (
  dels: readonly SplitCell[],
  adds: readonly SplitCell[],
  block: number,
): SplitRow[] => {
  const pairs = pairChangeBlock(
    dels.map((c) => lineSourceText(c.line)),
    adds.map((c) => lineSourceText(c.line)),
  );
  const out: SplitRow[] = [];
  let di = 0;
  let ai = 0;
  const flush = (dEnd: number, aEnd: number) => {
    const n = Math.max(dEnd - di, aEnd - ai);
    for (let k = 0; k < n; k++) {
      out.push({
        type: "pair",
        left: di + k < dEnd ? dels[di + k] : null,
        right: ai + k < aEnd ? adds[ai + k] : null,
        block,
      });
    }
    di = dEnd;
    ai = aEnd;
  };
  for (const p of pairs) {
    flush(p.del, p.add);
    out.push({ type: "pair", left: dels[p.del], right: adds[p.add], block });
    di = p.del + 1;
    ai = p.add + 1;
  }
  flush(dels.length, adds.length);
  return out;
};

const cellAt = (rows: readonly DiffRow[], i: number): SplitCell | null => {
  const r = rows[i];
  return r?.type === "line" ? { rowIndex: i, line: r.line } : null;
};

export const buildSplitRows = (rows: readonly DiffRow[]): SplitRow[] => {
  const out: SplitRow[] = [];
  // 块编号必须与 findChangeBlocks 一致：连续的增 / 删行是同一块（即使里面是「删增删增」交错）
  let blockNo = -1;
  let prevWasChange = false;
  let i = 0;
  while (i < rows.length) {
    const row = rows[i];
    if (row.type === "gap") {
      out.push({ type: "gap", rowIndex: i, gap: row.gap });
      prevWasChange = false;
      i += 1;
      continue;
    }
    const kind = row.line.kind;
    // 非增非删（上下文；hunk 标记理论上不会出现在 rows 里，兜底当上下文、保证每轮都前进）
    if (kind !== "add" && kind !== "del") {
      prevWasChange = false;
      const cell: SplitCell = { rowIndex: i, line: row.line };
      // 紧跟删 / 增行的「无结尾换行」标记已经随变更子块摆好了（见下）；走到这里的是跟在上下文行
      // 后面的标记（那一行两侧都有）或孤立的标记，两侧都放
      out.push({ type: "pair", left: cell, right: cell });
      i += 1;
      continue;
    }
    // 变更子块：连续的删 + 随后连续的增，各自带可选的「无结尾换行」标记（见 scanChangeRun）
    if (!prevWasChange) blockNo += 1;
    prevWasChange = true;
    const run = scanChangeRun(rows, i);
    const cellsOf = (from: number, to: number): SplitCell[] => {
      const cells: SplitCell[] = [];
      for (let k = from; k < to; k++) {
        const c = cellAt(rows, k);
        if (c) cells.push(c);
      }
      return cells;
    };
    out.push(
      ...layoutChangeBlock(
        cellsOf(run.delStart, run.delEnd),
        cellsOf(run.addStart, run.addEnd),
        blockNo,
      ),
    );
    // 标记各自挂在自己那一侧、并排放在这个子块最后一行的下面：旧侧没换行 → 只在左，新侧没换行 → 只在右
    const delMarker = run.delMarker >= 0 ? cellAt(rows, run.delMarker) : null;
    const addMarker = run.addMarker >= 0 ? cellAt(rows, run.addMarker) : null;
    if (delMarker || addMarker) {
      out.push({ type: "pair", left: delMarker, right: addMarker, block: blockNo });
    }
    i = run.next;
  }
  return out;
};

// ======================================================================
// 全部展开
// ======================================================================

/** 当前所有 gap 一共还隐藏多少行（未知的末尾 gap 不计）——「全部展开」前用它判断会不会撑爆 DOM */
export const totalHiddenLines = (rows: readonly DiffRow[]): number =>
  rows.reduce((n, r) => (r.type === "gap" ? n + (r.gap.hidden ?? 0) : n), 0);

/** 把当前所有 gap 全部展开（返回新 Map，不改入参；已有的展开量会被「全部」覆盖） */
export const expandAllGaps = (map: ExpansionMap, rows: readonly DiffRow[]): ExpansionMap => {
  let next = map;
  for (const r of rows) {
    if (r.type === "gap") next = expandGap(next, r.gap.key, "all");
  }
  return next;
};
