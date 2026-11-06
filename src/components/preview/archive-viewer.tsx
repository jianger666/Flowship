"use client";

/**
 * 压缩包查看器：只列目录，不解压
 *
 * 条目来自 zip 中央目录（server 侧有条目数 / 体积 / zip 炸弹护栏），这里把扁平路径补成目录树：
 * 目录在前文件在后、目录聚合子孙文件数与大小、按文件名过滤（命中时自动展开祖先）。
 */

import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, File, Folder, FolderOpen, Search } from "lucide-react";
import { Virtuoso } from "react-virtuoso";

import { Dot, PreviewToolbar, ToolButton } from "@/components/preview/preview-ui";
import { Input } from "@/components/ui/input";
import { buildArchiveTree, flattenArchive, type ArchiveNode } from "@/lib/preview/archive-tree";
import { formatBytes, formatCount } from "@/lib/preview/format";
import type { ArchiveEntryInfo } from "@/lib/preview/types";

const allDirPaths = (root: ArchiveNode): Set<string> => {
  const out = new Set<string>();
  const walk = (n: ArchiveNode) => {
    for (const c of n.children) {
      if (c.isDir) {
        out.add(c.path);
        walk(c);
      }
    }
  };
  walk(root);
  return out;
};

const INITIAL_EXPAND_ALL_LIMIT = 200;

export const ArchiveViewer = ({
  entries,
  entryCount,
  entriesTruncated,
}: {
  entries: ArchiveEntryInfo[];
  entryCount?: number;
  entriesTruncated?: boolean;
}) => {
  const tree = useMemo(() => buildArchiveTree(entries), [entries]);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => {
    // 小包全展开；大包只展开第一层目录
    if (entries.length <= INITIAL_EXPAND_ALL_LIMIT) return allDirPaths(tree);
    return new Set(tree.children.filter((c) => c.isDir).map((c) => c.path));
  });
  const [filter, setFilter] = useState("");
  const rows = useMemo(() => flattenArchive(tree, expanded, filter), [tree, expanded, filter]);

  const toggle = (path: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const ratio = tree.size > 0 ? Math.round((1 - tree.compressedSize / tree.size) * 100) : 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PreviewToolbar
        left={
          <>
            <span className="tabular-nums">{formatCount(tree.fileCount)} 个文件</span>
            <Dot />
            <span>解压后 {formatBytes(tree.size)}</span>
            <Dot />
            <span>压缩后 {formatBytes(tree.compressedSize)}{tree.size > 0 && ratio > 0 ? `（省 ${ratio}%）` : ""}</span>
          </>
        }
        right={
          <>
            <div className="relative">
              <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2 size-3 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="按路径过滤"
                aria-label="按路径过滤"
                className="h-6 w-44 pl-6 text-xs md:text-xs"
              />
            </div>
            <ToolButton label="展开全部" onClick={() => setExpanded(allDirPaths(tree))}>
              <ChevronsUpDown />
            </ToolButton>
            <ToolButton label="折叠全部" onClick={() => setExpanded(new Set())}>
              <ChevronsDownUp />
            </ToolButton>
          </>
        }
      />
      <div className="grid shrink-0 grid-cols-[minmax(0,1fr)_6rem_6rem] gap-2 border-b border-border/70 bg-muted/30 px-3 py-1 text-[11px] font-medium text-muted-foreground">
        <span>名称</span>
        <span className="text-right">大小</span>
        <span className="text-right">压缩后</span>
      </div>
      <div className="min-h-0 flex-1">
        {rows.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">{filter.trim() ? "没有匹配的条目" : "压缩包是空的"}</p>
        ) : (
          <Virtuoso
            style={{ height: "100%" }}
            totalCount={rows.length}
            fixedItemHeight={24}
            itemContent={(i) => {
              const { node, depth } = rows[i]!;
              const isOpen = node.isDir && (filter.trim() !== "" || expanded.has(node.path));
              return (
                <div
                  className="grid h-6 grid-cols-[minmax(0,1fr)_6rem_6rem] items-center gap-2 px-3 text-xs hover:bg-accent/60"
                  style={{ cursor: node.isDir ? "pointer" : "default" }}
                  onClick={node.isDir ? () => toggle(node.path) : undefined}
                >
                  <span className="flex min-w-0 items-center gap-1" style={{ paddingLeft: depth * 16 }}>
                    {node.isDir ? (
                      <>
                        {isOpen ? <ChevronDown className="size-3 shrink-0 text-muted-foreground" /> : <ChevronRight className="size-3 shrink-0 text-muted-foreground" />}
                        {isOpen ? <FolderOpen className="size-3.5 shrink-0 text-info" /> : <Folder className="size-3.5 shrink-0 text-info" />}
                      </>
                    ) : (
                      <>
                        <span aria-hidden className="inline-block size-3 shrink-0" />
                        <File className="size-3.5 shrink-0 text-muted-foreground" />
                      </>
                    )}
                    <span className="min-w-0 truncate font-mono">{node.name}</span>
                    {node.isDir && <span className="shrink-0 text-muted-foreground tabular-nums">({formatCount(node.fileCount)})</span>}
                  </span>
                  <span className="text-right tabular-nums text-muted-foreground">{formatBytes(node.size)}</span>
                  <span className="text-right tabular-nums text-muted-foreground">{formatBytes(node.compressedSize)}</span>
                </div>
              );
            }}
          />
        )}
      </div>
      {entriesTruncated && (
        <p className="shrink-0 border-t border-border/70 bg-muted/20 px-3 py-1.5 text-xs text-warning">
          条目太多，只列出了前 {formatCount(entries.length)} 个{entryCount != null ? `（共 ${formatCount(entryCount)} 个）` : ""}
        </p>
      )}
    </div>
  );
};
