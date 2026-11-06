"use client";

/**
 * 表格查看器（xlsx 当前 sheet / csv / tsv）
 *
 * 虚拟滚动（TableVirtuoso，几万行也只渲染可见的）、粘性表头 + 行号列、点表头排序（升 → 降 → 复位，
 * 数字按数值比、空值永远排最后）、全表过滤、「首行表头」开关、点单元格看完整内容并复制、
 * xlsx 多 sheet 页签（切换时才去服务端解析那一张）。
 * 数据全是展示用字符串（公式只显示结果）；这里不改数据，排序 / 过滤只改「显示哪些行、什么顺序」。
 */

import { useDeferredValue, useMemo, useState, type ReactNode } from "react";
import { TableVirtuoso, type TableComponents } from "react-virtuoso";
import { ArrowDown, ArrowUp, ClipboardCopy, Copy, Search, TableProperties } from "lucide-react";

import { Dot, PreviewToolbar, ToolButton, useCopyText } from "@/components/preview/preview-ui";
import { Input } from "@/components/ui/input";
import { formatCount } from "@/lib/preview/format";
import {
  buildTableView,
  columnLabel,
  estimateColumnWidths,
  nextSort,
  parseNumericCell,
  type SortState,
} from "@/lib/preview/table-model";
import type { PreviewTable } from "@/lib/preview/types";
import { cn } from "@/lib/utils";

const ROW_NUM_WIDTH_CH = 6;

export interface TableViewerProps {
  table: PreviewTable;
  /** xlsx：全部 sheet 名 + 当前序号；切换由外壳重新请求 */
  sheetNames?: string[];
  sheetIndex?: number;
  onSelectSheet?: (index: number) => void;
  /** 切换 sheet 时正在加载（保留旧表格不闪） */
  sheetLoading?: boolean;
  /** 工具栏最左侧（csv 的「表格 / 源码」页签） */
  leading?: ReactNode;
}

const tsvEscape = (cell: string): string => (/[\t\n\r"]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell);

export const TableViewer = ({
  table,
  sheetNames,
  sheetIndex = 0,
  onSelectSheet,
  sheetLoading,
  leading,
}: TableViewerProps) => {
  const copyText = useCopyText();
  const [hasHeader, setHasHeader] = useState(true);
  const [filterInput, setFilterInput] = useState("");
  const filter = useDeferredValue(filterInput);
  const [sort, setSort] = useState<SortState | null>(null);
  const [selected, setSelected] = useState<{ row: number; col: number } | null>(null);

  const { rows } = table;
  const colCount = useMemo(() => {
    let n = 0;
    for (const r of rows) if (r.length > n) n = r.length;
    return n;
  }, [rows]);

  const view = useMemo(
    () => buildTableView(rows, { hasHeader, filter, sort: sort && sort.col < colCount ? sort : null }),
    [rows, hasHeader, filter, sort, colCount],
  );
  const widths = useMemo(() => estimateColumnWidths(rows, colCount), [rows, colCount]);
  const totalWidthCh = ROW_NUM_WIDTH_CH + widths.reduce((a, b) => a + b, 0);
  const cols = useMemo(() => Array.from({ length: colCount }, (_, i) => i), [colCount]);
  // components 必须引用稳定：每次渲染都新建一个 Table 组件类型，React 会把整张表卸载重挂（滚动位置丢、闪烁）
  const tableComponents = useMemo<TableComponents>(
    () => ({
      Table: ({ style, children, ...props }) => (
        <table
          {...props}
          style={{ ...style, width: `${totalWidthCh}ch`, tableLayout: "fixed" }}
          className="border-separate border-spacing-0 text-xs"
        >
          <colgroup>
            <col style={{ width: `${ROW_NUM_WIDTH_CH}ch` }} />
            {widths.map((w, i) => (
              <col key={i} style={{ width: `${w}ch` }} />
            ))}
          </colgroup>
          {children}
        </table>
      ),
    }),
    [widths, totalWidthCh],
  );

  const selectedValue = selected ? (rows[selected.row]?.[selected.col] ?? "") : null;
  const selectedLabel = selected ? `${columnLabel(selected.col)}${selected.row + 1}` : "";

  const copyView = () => {
    const lines: string[] = [];
    if (view.header) lines.push(view.header.map(tsvEscape).join("\t"));
    for (const i of view.order) {
      const r = rows[view.bodyOffset + i]!;
      lines.push(cols.map((c) => tsvEscape(r[c] ?? "")).join("\t"));
    }
    void copyText(lines.join("\n"), `${formatCount(view.order.length)} 行（TSV，可直接粘进 Excel）`);
  };

  const truncatedNote = [
    table.truncatedRows ? `仅显示前 ${formatCount(rows.length)} 行（共 ${formatCount(table.totalRows)} 行）` : null,
    table.truncatedCols ? `仅显示前 ${formatCount(colCount)} 列（共 ${formatCount(table.totalCols)} 列）` : null,
  ].filter(Boolean);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PreviewToolbar
        left={
          <>
            {leading}
            <span className="tabular-nums">
              {filter.trim()
                ? `${formatCount(view.order.length)} / ${formatCount(view.bodyCount)} 行`
                : `${formatCount(view.bodyCount)} 行`}
              {" × "}
              {formatCount(colCount)} 列
            </span>
            {sheetLoading && <span className="text-info">切换中…</span>}
            {table.delimiter && (
              <>
                <Dot />
                <span>分隔符 {table.delimiter === "\t" ? "Tab" : table.delimiter}</span>
              </>
            )}
          </>
        }
        right={
          <>
            <div className="relative">
              <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2 size-3 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={filterInput}
                onChange={(e) => setFilterInput(e.target.value)}
                placeholder="过滤行"
                aria-label="过滤行"
                className="h-6 w-40 pl-6 text-xs md:text-xs"
              />
            </div>
            <ToolButton label={hasHeader ? "首行当作表头（点击取消）" : "首行当作表头"} onClick={() => setHasHeader((v) => !v)} active={hasHeader}>
              <TableProperties />
            </ToolButton>
            <ToolButton label="复制当前视图（TSV）" onClick={copyView}>
              <Copy />
            </ToolButton>
          </>
        }
      />

      <div aria-busy={sheetLoading || undefined} className={cn("min-h-0 flex-1", sheetLoading && "pointer-events-none")}>
        {colCount === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">这张表是空的</p>
        ) : view.order.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">没有匹配「{filter.trim()}」的行</p>
        ) : (
          <TableVirtuoso
            style={{ height: "100%" }}
            totalCount={view.order.length}
            increaseViewportBy={{ top: 200, bottom: 400 }}
            components={tableComponents}
            fixedHeaderContent={() => (
              <tr>
                <th className="sticky left-0 z-[3] border-r border-b border-border/70 bg-muted px-2 py-1 text-right font-normal text-muted-foreground">
                  #
                </th>
                {cols.map((c) => {
                  const active = sort?.col === c;
                  return (
                    <th
                      key={c}
                      aria-sort={active ? (sort!.dir === "asc" ? "ascending" : "descending") : "none"}
                      className="border-r border-b border-border/70 bg-muted p-0 text-left font-medium"
                    >
                      <button
                        type="button"
                        onClick={() => setSort((s) => nextSort(s, c))}
                        className="flex h-full w-full items-center gap-1 px-2 py-1 text-left hover:bg-accent"
                      >
                        <span className="min-w-0 flex-1 truncate">
                          {view.header ? view.header[c] || columnLabel(c) : columnLabel(c)}
                        </span>
                        {active && (sort!.dir === "asc" ? <ArrowUp className="size-3 shrink-0" /> : <ArrowDown className="size-3 shrink-0" />)}
                      </button>
                    </th>
                  );
                })}
              </tr>
            )}
            itemContent={(i) => {
              const rowIdx = view.bodyOffset + view.order[i]!;
              const row = rows[rowIdx]!;
              return (
                <>
                  <td className="sticky left-0 z-[1] border-r border-b border-border/50 bg-muted px-2 py-0.5 text-right tabular-nums text-muted-foreground">
                    {rowIdx + 1}
                  </td>
                  {cols.map((c) => {
                    const cell = row[c] ?? "";
                    const isSel = selected?.row === rowIdx && selected.col === c;
                    return (
                      <td
                        key={c}
                        onClick={() => setSelected({ row: rowIdx, col: c })}
                        className={cn(
                          "cursor-default truncate border-r border-b border-border/50 px-2 py-0.5 whitespace-pre",
                          parseNumericCell(cell) !== null && "text-right tabular-nums",
                          isSel && "bg-info/10 outline outline-1 -outline-offset-1 outline-info",
                        )}
                      >
                        {cell}
                      </td>
                    );
                  })}
                </>
              );
            }}
          />
        )}
      </div>

      {selected && selectedValue !== null && (
        <div className="flex shrink-0 items-start gap-2 border-t border-border/70 bg-muted/20 px-3 py-1.5 text-xs">
          <span className="shrink-0 font-mono text-muted-foreground">{selectedLabel}</span>
          <pre className="max-h-24 min-w-0 flex-1 overflow-auto font-mono break-words whitespace-pre-wrap">{selectedValue || "（空）"}</pre>
          <ToolButton label="复制单元格内容" onClick={() => void copyText(selectedValue, "单元格内容")}>
            <ClipboardCopy />
          </ToolButton>
        </div>
      )}

      {truncatedNote.length > 0 && (
        <p className="shrink-0 border-t border-border/70 bg-muted/20 px-3 py-1.5 text-xs text-warning">
          {truncatedNote.join("；")}。完整数据请用 Excel / 系统应用打开
        </p>
      )}

      {sheetNames && sheetNames.length > 1 && (
        <div role="tablist" aria-label="工作表" className="flex shrink-0 gap-0.5 overflow-x-auto border-t border-border/70 bg-muted/30 px-2 py-1">
          {sheetNames.map((name, i) => (
            <button
              key={`${i}:${name}`}
              type="button"
              role="tab"
              aria-selected={i === sheetIndex}
              onClick={() => i !== sheetIndex && onSelectSheet?.(i)}
              className={cn(
                "max-w-48 shrink-0 truncate rounded-sm px-2.5 py-1 text-xs transition-colors",
                i === sheetIndex ? "bg-background font-medium text-foreground shadow-xs" : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              {name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
