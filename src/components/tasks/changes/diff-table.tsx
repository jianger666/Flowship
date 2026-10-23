"use client";

/**
 * diff 表格渲染：unified（统一）/ split（左右分栏）两种视图共用同一份 rows（lib/diff/model）。
 *
 * - 语法高亮：useDiffSyntaxTokens（Shiki 双主题，与聊天代码块同一套）；
 * - 词级高亮：lib/diff/intraline——删 / 增配对行里真正变了的那几个词再加深一档底色；
 * - 折叠的未改动行 = gap 行：点按钮向上 / 向下 / 全部展开（需要整文件时由外层先拉）；
 * - 行选区：点行号选一行、shift+点行号选一段（只在单侧行号上选，用于「引用到对话」等）；
 * - split 视图是单个 CSS grid（左行号 / 左代码 / 右行号 / 右代码），代码折行而不是横滚——
 *   左右两栏滚动不用同步；`data-select-side` 让拖选文本时只选一侧（不会把另一栏也复制进去）。
 *
 * 行号 / 加减号 / gap 行全部 select-none，复制出来的只有代码本身。
 * 点行号用事件委托（容器上一个 onClick），不给每一行绑函数——几千行时 memo 才有意义。
 */

import {
  memo,
  useCallback,
  useMemo,
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
} from "react";
import { ChevronDown, ChevronsUpDown, ChevronUp, Loader2 } from "lucide-react";

import { Tooltip } from "@/components/ui/tooltip";
import { useDiffSyntaxTokens } from "@/hooks/use-diff-syntax-tokens";
import type { DiffSyntaxToken } from "@/lib/diff-syntax";
import {
  buildSplitRows,
  DIFF_EXPAND_STEP,
  findChangeBlocks,
  isNoNewlineMarker,
  lineSourceText,
  toViewLines,
  type DiffGap,
  type DiffRow,
} from "@/lib/diff/model";
import {
  computeIntralineRanges,
  overlayRanges,
  type InlineRange,
  type OverlaySegment,
} from "@/lib/diff/intraline";
import { lineInSelection, type LineSelection } from "@/lib/diff/quote";
import type { DiffViewLine } from "@/lib/tool-display";
import { cn } from "@/lib/utils";

/** 容器窄于这个宽度，split 自动降级成 unified（左右各剩不到 350px，代码折得没法看） */
export const SPLIT_MIN_WIDTH = 760;
/** 一次「全部展开」最多展开多少隐藏行（再多 DOM 会很重，让用户逐段展开） */
export const MAX_EXPAND_ALL_LINES = 1500;

const NO_NEWLINE_TEXT = "文件末尾无换行符";

/**
 * 语法色 token 的颜色：浅色走 `--sdm-c`，深色走 `--shiki-dark`（Shiki 双主题）。
 * class 串与聊天代码块 / tool-block 里的完全一致——那组 class 已被 Tailwind 生成过、两种主题下实测可用。
 */
const DIFF_TOKEN_CLASS =
  "text-[var(--sdm-c,inherit)] dark:text-[var(--shiki-dark,var(--sdm-c,inherit))]";

const MARK_ADD = "rounded-[2px] bg-success/30";
const MARK_DEL = "rounded-[2px] bg-destructive/30";

const GUTTER = "select-none px-1.5 text-right tabular-nums text-muted-foreground";

const SIGN: Record<DiffViewLine["kind"], string> = {
  add: "+",
  del: "−",
  context: " ",
  hunk: "",
};

/** 行的背景 / 文字色：有语法色时文字交给 token、增删只靠底色；没有就整行红绿字 */
const lineTone = (kind: DiffViewLine["kind"], highlighted: boolean, selected: boolean): string => {
  const text = highlighted
    ? ""
    : kind === "add"
      ? "text-success"
      : kind === "del"
        ? "text-destructive"
        : "text-muted-foreground";
  const bg = selected
    ? "bg-info/20"
    : kind === "add"
      ? highlighted
        ? "bg-success/15"
        : "bg-success/10"
      : kind === "del"
        ? highlighted
          ? "bg-destructive/15"
          : "bg-destructive/10"
        : "";
  return cn(bg, text);
};

const segmentStyle = (s: OverlaySegment): CSSProperties | undefined => {
  if (!s.light && !s.dark && !s.italic && !s.bold) return undefined;
  return {
    "--sdm-c": s.light,
    "--shiki-dark": s.dark,
    ...(s.italic ? { fontStyle: "italic" } : {}),
    ...(s.bold ? { fontWeight: 600 } : {}),
  } as CSSProperties;
};

/** 一行代码：语法色 + 词级底色叠加；都没有就直接吐纯文本（最省 DOM） */
const CodeSpans = ({
  line,
  tokens,
  ranges,
}: {
  line: DiffViewLine;
  tokens: DiffSyntaxToken[] | null | undefined;
  ranges: InlineRange[] | undefined;
}) => {
  // 传去掉尾 \r 的文本：语法 token / 词级 range 的下标都以它为准，带着 \r 会与 token 对不上而退化无色
  const text = lineSourceText(line);
  if (text === "") return <>{" "}</>;
  if (!tokens && !ranges) return <>{text}</>;
  const segments = overlayRanges(text, tokens, ranges);
  const markClass = line.kind === "add" ? MARK_ADD : MARK_DEL;
  return (
    <>
      {segments.map((s, i) => (
        <span
          key={i}
          className={cn(DIFF_TOKEN_CLASS, s.mark && markClass)}
          style={segmentStyle(s)}
        >
          {s.content}
        </span>
      ))}
    </>
  );
};

// ---------------------------------------------------------------------
// gap（折叠的未改动行）
// ---------------------------------------------------------------------

const GapButton = ({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) => (
  <Tooltip content={label}>
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="inline-flex size-5 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
    >
      {children}
    </button>
  </Tooltip>
);

interface GapRowProps {
  gap: DiffGap;
  canExpand: boolean;
  loading: boolean;
  onExpand: (gap: DiffGap, dir: "up" | "down" | "all") => void;
}

const GapRow = memo(function GapRow({ gap, canExpand, loading, onExpand }: GapRowProps) {
  const { hidden, position, heading, startNew } = gap;
  const known = hidden !== null;
  const label = known
    ? startNew !== undefined
      ? `第 ${startNew}–${startNew + hidden - 1} 行 · ${hidden} 行未改动`
      : `${hidden} 行未改动`
    : "后面还有未改动的行";
  const small = known && hidden <= DIFF_EXPAND_STEP;
  const tooMany = known && hidden > MAX_EXPAND_ALL_LINES;

  return (
    <div
      data-gap={gap.key}
      className="border-y border-border bg-muted/50 font-sans text-[11px] leading-5 select-none"
    >
      {/* 内层 sticky：横向滚动时按钮和说明始终停在视口左侧 */}
      <div className="sticky left-0 flex w-fit max-w-[48rem] items-center gap-2 px-2 py-0.5 text-muted-foreground">
        {canExpand && (
          <span className="flex shrink-0 items-center gap-0.5">
            {!known ? (
              <GapButton label="展开更多" disabled={loading} onClick={() => onExpand(gap, "down")}>
                <ChevronDown className="size-3.5" />
              </GapButton>
            ) : small ? (
              <GapButton
                label={`展开这 ${hidden} 行`}
                disabled={loading}
                onClick={() => onExpand(gap, "all")}
              >
                <ChevronsUpDown className="size-3.5" />
              </GapButton>
            ) : (
              <>
                {position !== "top" && (
                  <GapButton
                    label={`向下展开 ${DIFF_EXPAND_STEP} 行`}
                    disabled={loading}
                    onClick={() => onExpand(gap, "down")}
                  >
                    <ChevronDown className="size-3.5" />
                  </GapButton>
                )}
                {position !== "bottom" && (
                  <GapButton
                    label={`向上展开 ${DIFF_EXPAND_STEP} 行`}
                    disabled={loading}
                    onClick={() => onExpand(gap, "up")}
                  >
                    <ChevronUp className="size-3.5" />
                  </GapButton>
                )}
                <GapButton
                  label={tooMany ? `隐藏了 ${hidden} 行，太多了，请逐段展开` : `展开全部 ${hidden} 行`}
                  disabled={loading || tooMany}
                  onClick={() => onExpand(gap, "all")}
                >
                  <ChevronsUpDown className="size-3.5" />
                </GapButton>
              </>
            )}
            {/* 正在拉整文件：所有按钮禁用、旁边转圈（不区分点的是哪个按钮——拉回来就按原意图展开） */}
            {loading && (
              <Loader2 className="ml-1 size-3 animate-spin motion-reduce:animate-none" />
            )}
          </span>
        )}
        <span className="shrink-0 tabular-nums">{label}</span>
        {heading && (
          <span className="min-w-0 truncate font-mono text-muted-foreground">{heading}</span>
        )}
      </div>
    </div>
  );
});

// ---------------------------------------------------------------------
// unified 行
// ---------------------------------------------------------------------

const Gutter = ({
  side,
  n,
  selected,
  className,
}: {
  side: "old" | "new";
  n: number | undefined;
  selected?: boolean;
  className?: string;
}) =>
  n === undefined ? (
    <span aria-hidden className={cn(GUTTER, className)} />
  ) : (
    <span
      data-gutter={side}
      data-n={n}
      className={cn(
        GUTTER,
        "cursor-pointer hover:text-foreground",
        selected && "text-foreground",
        className,
      )}
    >
      {n}
    </span>
  );

interface UnifiedRowProps {
  line: DiffViewLine;
  tokens: DiffSyntaxToken[] | null | undefined;
  ranges: InlineRange[] | undefined;
  selected: boolean;
  /** 这一行属于当前高亮的变更块（n / p 导航落在的那一块） */
  active: boolean;
  /** 本行是变更块的第一行 → 块序号；否则 -1（滚动定位用） */
  blockStart: number;
}

const UnifiedRow = memo(function UnifiedRow({
  line,
  tokens,
  ranges,
  selected,
  active,
  blockStart,
}: UnifiedRowProps) {
  const edge = cn("border-l-2", active ? "border-info" : "border-transparent");
  if (isNoNewlineMarker(line)) {
    return (
      <div className={cn("flex text-[11px] leading-5 text-muted-foreground italic select-none", edge)}>
        <span className={cn(GUTTER, "w-11 shrink-0")} />
        <span className={cn(GUTTER, "w-11 shrink-0")} />
        <span className="w-4 shrink-0" />
        <span className="pr-3">{NO_NEWLINE_TEXT}</span>
      </div>
    );
  }
  const highlighted = tokens != null;
  return (
    <div
      data-block={blockStart >= 0 ? blockStart : undefined}
      className={cn("flex leading-5", edge, lineTone(line.kind, highlighted, selected))}
    >
      <Gutter side="old" n={line.oldLine} selected={selected} className="w-11 shrink-0" />
      <Gutter side="new" n={line.newLine} selected={selected} className="w-11 shrink-0" />
      <span aria-hidden className="w-4 shrink-0 text-center text-muted-foreground select-none">
        {SIGN[line.kind]}
      </span>
      {/* whitespace-pre + 外层横滚：unified 不折行，行号列才能和代码行一一对齐 */}
      <span className="min-w-0 flex-1 pr-3 whitespace-pre">
        <CodeSpans line={line} tokens={tokens} ranges={ranges} />
      </span>
    </div>
  );
});

// ---------------------------------------------------------------------
// split 行
// ---------------------------------------------------------------------

interface SplitSideData {
  line: DiffViewLine | null;
  tokens: DiffSyntaxToken[] | null | undefined;
  ranges: InlineRange[] | undefined;
  selected: boolean;
}

/**
 * 一整行（左右两侧）。props 全部是基本类型 / 稳定引用（line 来自 rows、ranges 来自 Map），
 * 这样 memo 的浅比较才有效——选区变化时只有选中状态变了的行会重渲染。
 */
interface SplitPairRowProps {
  leftLine: DiffViewLine | null;
  leftTokens: DiffSyntaxToken[] | null | undefined;
  leftRanges: InlineRange[] | undefined;
  leftSelected: boolean;
  rightLine: DiffViewLine | null;
  rightTokens: DiffSyntaxToken[] | null | undefined;
  rightRanges: InlineRange[] | undefined;
  rightSelected: boolean;
  active: boolean;
  blockStart: number;
}

/** 一侧（行号格 + 代码格）。空侧用淡底占位，让左右对齐 */
const SplitSide = ({
  side,
  cell,
  active,
  blockStart,
}: {
  side: "left" | "right";
  cell: SplitSideData;
  active?: boolean;
  blockStart?: number;
}) => {
  const gutterSide = side === "left" ? "old" : "new";
  const { line, tokens, ranges, selected } = cell;
  const edge = side === "left" ? cn("border-l-2", active ? "border-info" : "border-transparent") : "";
  if (!line) {
    return (
      <>
        <div
          data-block={blockStart !== undefined && blockStart >= 0 ? blockStart : undefined}
          className={cn("bg-muted/30", edge)}
        />
        <div data-side={side} className="bg-muted/30" />
      </>
    );
  }
  if (isNoNewlineMarker(line)) {
    return (
      <>
        <div className={cn(edge)} />
        <div
          data-side={side}
          className="px-2 text-[11px] text-muted-foreground italic select-none"
        >
          {NO_NEWLINE_TEXT}
        </div>
      </>
    );
  }
  const highlighted = tokens != null;
  const tone = lineTone(line.kind, highlighted, selected);
  const n = gutterSide === "old" ? line.oldLine : line.newLine;
  return (
    <>
      <div
        data-block={blockStart !== undefined && blockStart >= 0 ? blockStart : undefined}
        {...(n !== undefined ? { "data-gutter": gutterSide, "data-n": n } : {})}
        className={cn(
          GUTTER,
          n !== undefined && "cursor-pointer hover:text-foreground",
          selected && "text-foreground",
          tone,
          edge,
        )}
      >
        {n}
      </div>
      <div
        data-side={side}
        className={cn("min-w-0 px-2 whitespace-pre-wrap [overflow-wrap:anywhere]", tone)}
      >
        <CodeSpans line={line} tokens={tokens} ranges={ranges} />
      </div>
    </>
  );
};

const SplitPairRow = memo(function SplitPairRow(p: SplitPairRowProps) {
  return (
    <>
      <SplitSide
        side="left"
        cell={{
          line: p.leftLine,
          tokens: p.leftTokens,
          ranges: p.leftRanges,
          selected: p.leftSelected,
        }}
        active={p.active}
        blockStart={p.blockStart}
      />
      <SplitSide
        side="right"
        cell={{
          line: p.rightLine,
          tokens: p.rightTokens,
          ranges: p.rightRanges,
          selected: p.rightSelected,
        }}
      />
    </>
  );
});

// ---------------------------------------------------------------------
// 表格
// ---------------------------------------------------------------------

export interface DiffTableProps {
  rows: readonly DiffRow[];
  view: "unified" | "split";
  /** Shiki 语言 id；null = 不上色 */
  language: string | null;
  selection: LineSelection | null;
  /** 当前高亮的变更块序号（n / p 导航落在的那块）；null = 无 */
  activeBlock: number | null;
  /** 允许展开（整文件可得）；false = 被截断 / 过大，gap 只显示说明、不给按钮 */
  canExpand: boolean;
  /** 正在为哪个 gap 拉整文件（对应按钮转圈） */
  loadingGapKey: number | null;
  /** 点行号：shift = 扩展选区 */
  onSelectLine: (side: "old" | "new", n: number, extend: boolean) => void;
  onExpand: (gap: DiffGap, dir: "up" | "down" | "all") => void;
}

export const DiffTable = memo(function DiffTable({
  rows,
  view,
  language,
  selection,
  activeBlock,
  canExpand,
  loadingGapKey,
  onSelectLine,
  onExpand,
}: DiffTableProps) {
  const viewLines = useMemo(() => toViewLines(rows), [rows]);
  const tokenLines = useDiffSyntaxTokens(viewLines, language);
  const ranges = useMemo(() => computeIntralineRanges(viewLines), [viewLines]);

  // 每一行属于第几个变更块；块的第一行（滚动定位 / n·p 导航用）
  const { blockOfRow, blockStartRow } = useMemo(() => {
    const blocks = findChangeBlocks(rows);
    const of = new Array<number>(rows.length).fill(-1);
    const starts = new Array<number>(rows.length).fill(-1);
    blocks.forEach((b, bi) => {
      starts[b.start] = bi;
      for (let k = b.start; k < b.end; k++) of[k] = bi;
    });
    return { blockOfRow: of, blockStartRow: starts };
  }, [rows]);

  const split = useMemo(() => (view === "split" ? buildSplitRows(rows) : null), [rows, view]);
  // split 里每个块的第一个 pair 行
  const splitBlockStart = useMemo(() => {
    const starts = new Map<number, number>();
    const seen = new Set<number>();
    split?.forEach((r, i) => {
      if (r.type === "pair" && r.block !== undefined && !seen.has(r.block)) {
        seen.add(r.block);
        starts.set(i, r.block);
      }
    });
    return starts;
  }, [split]);

  const handleClick = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      const gutter = (e.target as HTMLElement).closest<HTMLElement>("[data-gutter]");
      if (!gutter) return;
      const side = gutter.dataset.gutter === "old" ? "old" : "new";
      const n = Number(gutter.dataset.n);
      if (!Number.isFinite(n) || n <= 0) return;
      e.preventDefault();
      onSelectLine(side, n, e.shiftKey);
    },
    [onSelectLine],
  );

  // split：在哪一栏按下鼠标，就只允许选哪一栏的文字
  const handleMouseDown = useCallback((e: MouseEvent<HTMLDivElement>) => {
    const cell = (e.target as HTMLElement).closest<HTMLElement>("[data-side]");
    e.currentTarget.dataset.selectSide = cell?.dataset.side ?? "";
  }, []);

  if (split) {
    return (
      <div
        role="region"
        aria-label="代码差异（分栏）"
        data-diff-view="split"
        onClick={handleClick}
        onMouseDown={handleMouseDown}
        style={{ gridTemplateColumns: "2.75rem minmax(0,1fr) 2.75rem minmax(0,1fr)" }}
        className="grid font-mono text-[12px] leading-5 [&[data-select-side=left]_[data-side=right]]:select-none [&[data-select-side=right]_[data-side=left]]:select-none"
      >
        {split.map((r, i) => {
          if (r.type === "gap") {
            return (
              <div key={i} className="col-span-4">
                <GapRow
                  gap={r.gap}
                  canExpand={canExpand}
                  loading={loadingGapKey === r.gap.key}
                  onExpand={onExpand}
                />
              </div>
            );
          }
          const { left, right } = r;
          return (
            <SplitPairRow
              key={i}
              leftLine={left?.line ?? null}
              leftTokens={left ? tokenLines?.[left.rowIndex] : null}
              leftRanges={left ? ranges.get(left.rowIndex) : undefined}
              // 选区按单侧行号：旧侧选区只点亮左栏、新侧选区只点亮右栏
              leftSelected={!!left && selection?.side === "old" && lineInSelection(left.line, selection)}
              rightLine={right?.line ?? null}
              rightTokens={right ? tokenLines?.[right.rowIndex] : null}
              rightRanges={right ? ranges.get(right.rowIndex) : undefined}
              rightSelected={!!right && selection?.side === "new" && lineInSelection(right.line, selection)}
              active={r.block !== undefined && r.block === activeBlock}
              blockStart={splitBlockStart.get(i) ?? -1}
            />
          );
        })}
      </div>
    );
  }

  return (
    <div
      role="region"
      aria-label="代码差异"
      data-diff-view="unified"
      onClick={handleClick}
      // min-w-max：横滚内容宽 = 最长行，整行底色才铺满（否则背景只到容器宽、右侧无底色）
      className="min-w-max font-mono text-[12px]"
    >
      {rows.map((row, i) =>
        row.type === "gap" ? (
          <GapRow
            key={i}
            gap={row.gap}
            canExpand={canExpand}
            loading={loadingGapKey === row.gap.key}
            onExpand={onExpand}
          />
        ) : (
          <UnifiedRow
            key={i}
            line={row.line}
            tokens={tokenLines?.[i]}
            ranges={ranges.get(i)}
            selected={lineInSelection(row.line, selection)}
            active={activeBlock !== null && blockOfRow[i] === activeBlock}
            blockStart={blockStartRow[i]}
          />
        ),
      )}
    </div>
  );
});
