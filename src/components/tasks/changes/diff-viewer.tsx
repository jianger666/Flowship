"use client";

/**
 * 单文件 diff 查看器（改动面板右侧）：头部（路径 / 统计 / 复制 / 已查看）、导航条（文件 / 改动块）、
 * 选区条（引用到对话 / 复制 / 在 IDE 打开）、diff 表格 + 变更块小地图。
 *
 * 数据：useFileDiff 先拉 -U3 的 diff 首屏渲染；用户第一次点「展开上下文」才拉整文件 diff，
 * 拿到后展开 / 收起全在本地（lib/diff/model 的 buildDiffRows）。拉的过程中记着用户点的是哪个 gap 的哪个方向（pending），
 * 到手后按原意图展开——用户不用再点第二次。
 *
 * 视图：unified / split 由偏好决定；容器窄于 SPLIT_MIN_WIDTH 时 split 自动降级（左右各剩不到一半宽，折行没法看）。
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
import {
  ChevronDown,
  ChevronsDownUp,
  ChevronsUpDown,
  ChevronUp,
  Circle,
  CircleCheck,
  Copy,
  MessageSquareQuote,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { DiffMinimap } from "@/components/tasks/changes/diff-minimap";
import { DiffTable, SPLIT_MIN_WIDTH } from "@/components/tasks/changes/diff-table";
import {
  CopyIconButton,
  LineStat,
  StatusBadge,
  ToolbarButton,
} from "@/components/tasks/changes/shared";
import { Button } from "@/components/ui/button";
import { EmptyHint } from "@/components/ui/empty-hint";
import { IdePathLink, useIdePathLinker } from "@/components/ui/ide-path-link";
import { LoadingState } from "@/components/ui/loading-state";
import { Tooltip } from "@/components/ui/tooltip";
import { useFileDiff } from "@/hooks/use-file-diff";
import type { ChangeEntry } from "@/lib/changes/entries";
import type { DiffPrefs } from "@/lib/changes/prefs";
import { changesQueryKey, type ChangesQuery } from "@/lib/changes/scope";
import { insertIntoComposer } from "@/lib/composer-insert-bridge";
import { diffLanguageFromPath } from "@/lib/diff-syntax";
import {
  buildDiffRows,
  EMPTY_EXPANSION,
  expandAllGaps,
  expandGap,
  findChangeBlocks,
  totalHiddenLines,
  type DiffGap,
  type ExpansionMap,
} from "@/lib/diff/model";
import {
  describeSelection,
  formatSelectionQuote,
  makeSelection,
  selectionLines,
  type LineSelection,
} from "@/lib/diff/quote";
import { cn } from "@/lib/utils";

/** 「全部展开」一次最多露出多少隐藏行（再多 DOM 太重，让用户逐段展开） */
const MAX_EXPAND_TOTAL_LINES = 4000;

/** 快捷键 n / p / e 要调到查看器内部能力：Sheet 通过这个句柄调用 */
export interface DiffViewerHandle {
  nextChange: () => void;
  prevChange: () => void;
  toggleExpandAll: () => void;
}

/** 用户点了展开、但整文件还没到：先记着，到手后按原意图展开 */
interface PendingExpand {
  key: number | "all";
  dir: "up" | "down" | "all";
}

interface DiffViewerProps {
  taskId: string;
  entry: ChangeEntry;
  query: ChangesQuery;
  prefs: DiffPrefs;
  /** Sheet 是否打开（关着不拉） */
  open: boolean;
  running: boolean;
  /** 清单最近一次刷新的戳（运行中据此静默重拉 diff） */
  updatedAt: number;
  /** 手动刷新计数：变了就丢缓存重拉当前文件 */
  refreshKey: number;
  viewed: boolean;
  /** 看过之后这个文件又变了 */
  viewedStale: boolean;
  onToggleViewed: () => void;
  /** 「只有空白改动」时给用户一个出口：关掉「忽略空白」 */
  onShowWhitespace: () => void;
  selection: LineSelection | null;
  onSelectionChange: (sel: LineSelection | null) => void;
  /** 当前文件在可见文件序列里的位置；null = 不显示 */
  position: { index: number; total: number } | null;
  onPrev: (() => void) | null;
  onNext: (() => void) | null;
  handleRef: MutableRefObject<DiffViewerHandle | null>;
}

export const DiffViewer = ({
  taskId,
  entry,
  query,
  prefs,
  open,
  running,
  updatedAt,
  refreshKey,
  viewed,
  viewedStale,
  onToggleViewed,
  onShowWhitespace,
  selection,
  onSelectionChange,
  position,
  onPrev,
  onNext,
  handleRef,
}: DiffViewerProps) => {
  const { file } = entry;
  const linker = useIdePathLinker();
  const scrollRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<{ side: "old" | "new"; n: number } | null>(null);

  const diff = useFileDiff({
    taskId,
    target: { repoPath: entry.repoPath, path: file.path, oldPath: file.oldPath },
    signature: entry.signature,
    query,
    // 嵌套仓库没有 diff 可拉（接口也不会读它里面的东西）：不发请求，直接给说明
    active: open && !file.nestedRepo,
    running,
    updatedAt,
    refreshKey,
  });

  // ---------- 展开 / 变更块 / 宽度 ----------
  // 文件 + 范围：换了就是「另一个视图」（回到顶部、清选区锚点）
  const fileKey = `${entry.key}\u0000${changesQueryKey(query)}`;
  // 内容身份（含文件级指纹）：同一个文件的内容变了（agent 又改了 / 切了分支 / 外部编辑），
  // 折叠区的行号已经对不上，展开状态必须丢——沿用会展开到错位的位置。
  // 单独一个键：内容刷新（运行中轮询）只复位展开、不能把用户滚回顶部
  const contentKey = `${entry.signature}\u0000${changesQueryKey(query)}`;
  const [expansion, setExpansion] = useState<ExpansionMap>(EMPTY_EXPANSION);
  const [pending, setPending] = useState<PendingExpand | null>(null);
  const [activeBlock, setActiveBlock] = useState<number | null>(null);
  const [width, setWidth] = useState<number | null>(null);
  // 切文件 / 切范围 / 内容变了：展开状态、待办、当前块全部复位
  const [prevContentKey, setPrevContentKey] = useState(contentKey);
  if (prevContentKey !== contentKey) {
    setPrevContentKey(contentKey);
    setExpansion(EMPTY_EXPANSION);
    setPending(null);
    setActiveBlock(null);
  }

  // retry / loadFull 引用稳定；diff 对象本身每次渲染都是新的，不能进回调依赖（否则 DiffTable 的 memo 失效）
  const { retry, loadFull } = diff;
  const baseSlot = diff.base;
  const baseData = baseSlot?.status === "ok" ? baseSlot.data : null;
  const fullSlot = diff.full;
  const fullData =
    fullSlot?.status === "ok" &&
    !fullSlot.data.truncated &&
    !fullSlot.data.tooLarge &&
    !fullSlot.data.binary &&
    fullSlot.data.diff
      ? fullSlot.data
      : null;
  const baseDiff = baseData?.diff ?? "";
  const fullDiff = fullData?.diff ?? null;

  const { rows, complete } = useMemo(
    () => buildDiffRows({ base: baseDiff, full: fullDiff, expansion }),
    [baseDiff, fullDiff, expansion],
  );
  const hasHunk = useMemo(() => /^@@/m.test(baseDiff), [baseDiff]);
  const blockCount = useMemo(() => findChangeBlocks(rows).length, [rows]);
  const activeSafe = activeBlock !== null && activeBlock < blockCount ? activeBlock : null;
  const gapCount = useMemo(() => rows.filter((r) => r.type === "gap").length, [rows]);

  // 整文件拿到了、却不能用（被截断 / 过大 / 结构异常）：gap 不再给展开按钮
  const fullUnusable = fullSlot?.status === "ok" && (fullData === null || !complete);
  const canExpand = !!baseData && !baseData.truncated && !fullUnusable;
  const language = useMemo(() => diffLanguageFromPath(file.path), [file.path]);

  const effectiveView =
    prefs.view === "split" && (width === null || width >= SPLIT_MIN_WIDTH) ? "split" : "unified";
  const splitFellBack = prefs.view === "split" && effectiveView === "unified";

  // 容器宽度（split 降级判断）
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w !== undefined) setWidth(Math.round(w));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 切文件回到顶部、清掉选区锚点
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0, left: 0 });
    anchorRef.current = null;
  }, [fileKey]);

  // 整文件拉失败 / 不可用：撤销待办并告诉用户
  const fullStatus = fullSlot?.status;
  useEffect(() => {
    if (!pending) return;
    if (fullStatus === "error") {
      setPending(null);
      toast.error("加载完整文件失败，点一下展开可以重试");
    } else if (fullUnusable) {
      setPending(null);
      toast.error("这个文件太大，没法展开上下文");
    }
  }, [pending, fullStatus, fullUnusable]);

  // 整文件到手：按用户当初点的意图展开
  useEffect(() => {
    if (!pending || !complete) return;
    if (pending.key === "all") {
      if (totalHiddenLines(rows) > MAX_EXPAND_TOTAL_LINES) {
        toast.info(
          `折叠的未改动行共 ${totalHiddenLines(rows)} 行，一次展开太多了，请在需要的位置逐段展开`,
        );
      } else {
        setExpansion((m) => expandAllGaps(m, rows));
      }
    } else {
      const { key, dir } = pending;
      setExpansion((m) => expandGap(m, key, dir));
    }
    setPending(null);
  }, [pending, complete, rows]);

  const handleExpand = useCallback(
    (gap: DiffGap, dir: "up" | "down" | "all") => {
      if (complete) {
        setExpansion((m) => expandGap(m, gap.key, dir));
        return;
      }
      setPending({ key: gap.key, dir });
      // 上一次拉取失败：丢缓存重拉；否则（幂等）要整文件
      if (fullStatus === "error") retry();
      else loadFull();
    },
    [complete, fullStatus, retry, loadFull],
  );

  const toggleExpandAll = useCallback(() => {
    if (!baseData) return;
    if (!complete) {
      if (gapCount === 0 || baseData.truncated) return;
      setPending({ key: "all", dir: "all" });
      if (fullStatus === "error") retry();
      else loadFull();
      return;
    }
    if (gapCount > 0) {
      if (totalHiddenLines(rows) > MAX_EXPAND_TOTAL_LINES) {
        toast.info(
          `折叠的未改动行共 ${totalHiddenLines(rows)} 行，一次展开太多了，请在需要的位置逐段展开`,
        );
        return;
      }
      setExpansion((m) => expandAllGaps(m, rows));
    } else {
      setExpansion(EMPTY_EXPANSION);
    }
  }, [baseData, complete, gapCount, fullStatus, retry, loadFull, rows]);

  const jumpToBlock = useCallback((index: number) => {
    setActiveBlock(index);
    requestAnimationFrame(() => {
      scrollRef.current
        ?.querySelector<HTMLElement>(`[data-block="${index}"]`)
        ?.scrollIntoView({ block: "center" });
    });
  }, []);

  // 把能力交给 Sheet（n / p / e 快捷键）。每次渲染都更新：闭包永远是最新的
  useEffect(() => {
    handleRef.current = {
      nextChange: () => {
        if (blockCount === 0) return;
        jumpToBlock(activeSafe === null ? 0 : Math.min(activeSafe + 1, blockCount - 1));
      },
      prevChange: () => {
        if (blockCount === 0) return;
        jumpToBlock(activeSafe === null ? blockCount - 1 : Math.max(activeSafe - 1, 0));
      },
      toggleExpandAll,
    };
    return () => {
      handleRef.current = null;
    };
  });

  // ---------- 选区 ----------
  const handleSelectLine = useCallback(
    (side: "old" | "new", n: number, extend: boolean) => {
      if (!extend) {
        // 再点一次已选中的单行 = 取消选择
        if (
          selection &&
          selection.side === side &&
          selection.from === n &&
          selection.to === n
        ) {
          anchorRef.current = null;
          onSelectionChange(null);
          return;
        }
        anchorRef.current = { side, n };
        onSelectionChange(makeSelection(side, n, n));
        return;
      }
      const anchor = anchorRef.current;
      if (anchor && anchor.side === side) {
        onSelectionChange(makeSelection(side, anchor.n, n));
      } else {
        anchorRef.current = { side, n };
        onSelectionChange(makeSelection(side, n, n));
      }
    },
    [selection, onSelectionChange],
  );

  const selectedLines = useMemo(
    () => (selection ? selectionLines(rows, selection) : []),
    [rows, selection],
  );

  const quoteSelection = () => {
    if (!selection) return;
    if (selectedLines.length === 0) {
      toast.error("选区里没有可引用的代码行");
      return;
    }
    const text = formatSelectionQuote({
      path: file.path,
      sel: selection,
      lines: selectedLines,
      language,
    });
    if (insertIntoComposer(taskId, text)) toast.success("已引用到输入框");
    else toast.error("找不到输入框，没法引用");
  };

  const copySelection = async () => {
    if (selectedLines.length === 0) return;
    try {
      await navigator.clipboard.writeText(
        selectedLines.map((l) => l.text.replace(/\r$/, "")).join("\n"),
      );
      toast.success(`已复制 ${selectedLines.length} 行`);
    } catch {
      toast.error("复制失败");
    }
  };

  // ---------- 内容区 ----------
  const renderBody = () => {
    // 放在最前面：这类条目根本没发请求，baseSlot 永远是「还没有」，往下走会一直转圈
    if (file.nestedRepo) {
      return (
        <EmptyHint variant="dashed" align="center" size="md" className="m-3">
          <p>这是一个嵌套的 git 仓库（目录里自带 .git），它里面的改动不属于当前仓库的 diff。</p>
          <p className="mt-1">要看它的改动，请进到这个目录里单独查看。</p>
        </EmptyHint>
      );
    }
    if (!baseSlot || baseSlot.status === "loading") {
      return (
        <LoadingState variant="inline" label="加载 diff…" className="block py-6 text-center" />
      );
    }
    if (baseSlot.status === "error") {
      return (
        <div className="m-3 flex items-center justify-between gap-2 rounded-md border border-dashed px-3 py-4 text-xs text-muted-foreground">
          <span className="min-w-0">加载 diff 失败：{baseSlot.message}</span>
          <Button type="button" size="xs" variant="outline" onClick={retry}>
            重试
          </Button>
        </div>
      );
    }
    const data = baseSlot.data;
    if (data.binary) {
      return (
        <EmptyHint variant="dashed" align="center" size="md" className="m-3">
          二进制文件，不显示 diff
        </EmptyHint>
      );
    }
    if (data.tooLarge) {
      return (
        <EmptyHint variant="dashed" align="center" size="md" className="m-3">
          改动太大，这里不展示——请点上方文件路径在 IDE 里查看
        </EmptyHint>
      );
    }
    if (!data.diff || !hasHunk) {
      if (file.whitespaceOnly) {
        return (
          <EmptyHint variant="dashed" align="center" size="md" className="m-3">
            <p>这个文件只有空白字符的改动（缩进 / 行尾 / 空行），已按「忽略空白」隐藏。</p>
            <Button
              type="button"
              size="xs"
              variant="outline"
              className="mt-2"
              onClick={onShowWhitespace}
            >
              显示空白改动
            </Button>
          </EmptyHint>
        );
      }
      return (
        <EmptyHint variant="dashed" align="center" size="md" className="m-3">
          {file.untracked ? "新建的空文件" : "没有可显示的文本差异（可能只改了权限或为空文件）"}
        </EmptyHint>
      );
    }
    return (
      <>
        <DiffTable
          rows={rows}
          view={effectiveView}
          language={language}
          selection={selection}
          activeBlock={activeSafe}
          canExpand={canExpand}
          loadingGapKey={
            pending && !complete && typeof pending.key === "number" ? pending.key : null
          }
          onSelectLine={handleSelectLine}
          onExpand={handleExpand}
        />
        {data.truncated && (
          <div className="border-t border-border px-3 py-1.5 text-[11px] text-muted-foreground">
            diff 太长，已截断（只显示了前一部分）——完整内容请点上方文件路径在 IDE 里查看
          </div>
        )}
        {fullUnusable && !data.truncated && (
          <div className="border-t border-border px-3 py-1.5 text-[11px] text-muted-foreground">
            这个文件太大，没法展开上下文
          </div>
        )}
        <div className="h-6" />
      </>
    );
  };

  const canToggleExpand =
    canExpand && (gapCount > 0 || (complete && expansion.size > 0)) && hasHunk;
  const allExpanded = complete && gapCount === 0;
  const selectionSideText = selection?.side === "old" ? "改动前" : "改动后";

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      {/* 头部：路径 / 统计 / 复制 / 展开 / 已查看 */}
      <header className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b px-3 py-1.5 text-xs">
        <StatusBadge status={file.status} />
        <span className="min-w-0 flex-1 basis-40 truncate font-mono">
          {file.status === "deleted" ? (
            file.path
          ) : (
            <IdePathLink linker={linker} path={file.absolutePath}>
              {file.path}
            </IdePathLink>
          )}
          {file.oldPath && <span className="ml-2 text-muted-foreground">← {file.oldPath}</span>}
        </span>
        <LineStat added={file.added} removed={file.removed} />
        <div className="flex shrink-0 items-center gap-0.5">
          <CopyIconButton text={file.path} label="复制路径" />
          {baseDiff && <CopyIconButton text={baseDiff} label="复制 diff（patch 格式）" />}
          {canToggleExpand && (
            <ToolbarButton
              label={allExpanded ? "收起未改动的行" : "展开全部上下文"}
              hotkey="e"
              onClick={toggleExpandAll}
            >
              {allExpanded ? <ChevronsDownUp /> : <ChevronsUpDown />}
            </ToolbarButton>
          )}
          <Tooltip
            content={
              viewedStale
                ? "标记已查看之后，这个文件又有新变化了"
                : viewed
                  ? "取消已查看标记"
                  : "标记为已查看（按 v 标记并跳到下一个没看过的文件）"
            }
          >
            <Button
              type="button"
              size="xs"
              variant={viewed ? "secondary" : "outline"}
              aria-pressed={viewed}
              onClick={onToggleViewed}
              className={cn("ml-1", viewedStale && "text-warning")}
            >
              {viewed ? <CircleCheck className="text-success" /> : <Circle />}
              {viewedStale ? "有新变化" : "已查看"}
            </Button>
          </Tooltip>
        </div>
      </header>

      {/* 导航条：文件 i/N、改动块 x/y */}
      {(position || (baseData && blockCount > 0) || splitFellBack) && (
        <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-0.5 border-b bg-muted/30 px-3 py-0.5 text-[11px] text-muted-foreground">
          {position && (
            <span className="flex items-center gap-0.5">
              文件 <span className="tabular-nums">{position.index + 1}/{position.total}</span>
              <ToolbarButton label="上一个文件" hotkey="k" disabled={!onPrev} onClick={() => onPrev?.()}>
                <ChevronUp />
              </ToolbarButton>
              <ToolbarButton label="下一个文件" hotkey="j" disabled={!onNext} onClick={() => onNext?.()}>
                <ChevronDown />
              </ToolbarButton>
            </span>
          )}
          {baseData && blockCount > 0 && (
            <span className="flex items-center gap-0.5">
              改动{" "}
              <span className="tabular-nums">
                {activeSafe === null ? "–" : activeSafe + 1}/{blockCount}
              </span>
              <ToolbarButton
                label="上一处改动"
                hotkey="p"
                onClick={() => handleRef.current?.prevChange()}
              >
                <ChevronUp />
              </ToolbarButton>
              <ToolbarButton
                label="下一处改动"
                hotkey="n"
                onClick={() => handleRef.current?.nextChange()}
              >
                <ChevronDown />
              </ToolbarButton>
            </span>
          )}
          {splitFellBack && <span>窗口较窄，已改用统一视图</span>}
        </div>
      )}

      {/* 选区条 */}
      {selection && (
        <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b bg-info/10 px-3 py-1 text-xs">
          <span className="tabular-nums">
            已选 {describeSelection(selection)}（{selectionSideText}）· {selectedLines.length} 行
          </span>
          <Button type="button" size="xs" variant="outline" onClick={quoteSelection}>
            <MessageSquareQuote />
            引用到对话
          </Button>
          <Button type="button" size="xs" variant="ghost" onClick={() => void copySelection()}>
            <Copy />
            复制
          </Button>
          {selection.side === "new" && file.status !== "deleted" && (
            <IdePathLink
              linker={linker}
              path={file.absolutePath}
              line={selection.from}
              linkClassName="cursor-pointer bg-transparent p-0 text-xs text-info underline-offset-2 hover:underline"
            >
              在 IDE 打开
            </IdePathLink>
          )}
          <ToolbarButton
            label="取消选择"
            hotkey="Esc"
            onClick={() => onSelectionChange(null)}
            className="ml-auto"
          >
            <X />
          </ToolbarButton>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <div ref={scrollRef} className="min-h-0 min-w-0 flex-1 overflow-auto">
          {renderBody()}
        </div>
        {baseData && hasHunk && (
          <DiffMinimap rows={rows} activeBlock={activeSafe} onJump={jumpToBlock} />
        )}
      </div>
    </section>
  );
};
