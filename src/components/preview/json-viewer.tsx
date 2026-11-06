"use client";

/**
 * JSON 查看器：树 / 源码两个视图
 *
 * 树：只把「当前可见」的节点摊平成行进虚拟列表（折叠子树不展开）；键 / 字符串 / 数字 / 布尔 / null 复用 Prism 的 token 配色；
 * 搜索（键名 + 值）命中处自动展开祖先并滚到位，Enter / Shift+Enter 在命中间跳；
 * 悬停一行出「复制路径 / 复制值」。源码视图就是 CodeViewer（含编辑）。
 * 解析失败（语法错误 / 文件被截断）→ 只剩源码视图并说明原因。
 *
 * 树里的数字是 JS 解析后的值：超过 2^53 的整数会丢精度；要看原样请切到源码。
 */

import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import {
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Copy as CopyIcon,
  Link2,
  Search as SearchIcon,
} from "lucide-react";

import { CodeViewer, type CodeViewerProps } from "@/components/preview/code-viewer";
import { FindBar, PreviewToolbar, SegmentedTabs, ToolButton, useCopyText } from "@/components/preview/preview-ui";
import { useGuardedTab } from "@/components/preview/use-guarded-tab";
import { useShellPlatform } from "@/hooks/use-shell-platform";
import { getModShortcutLabel, isModCombo } from "@/lib/keyboard-shortcuts";
import {
  allContainerPaths,
  defaultExpandedPaths,
  flattenJson,
  searchJson,
  type JsonRow,
} from "@/lib/preview/json-tree";
import { formatBytes, formatCount } from "@/lib/preview/format";
import { cn } from "@/lib/utils";

const INDENT_PX = 16;

type ParseResult = { ok: true; value: unknown } | { ok: false; error: string };

const tryParse = (text: string, truncated: boolean | undefined): ParseResult => {
  if (truncated) return { ok: false, error: "文件较大，只载入了前面一部分，无法解析成树" };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "JSON 解析失败" };
  }
};

const valueClass = (kind: JsonRow["kind"]): string => {
  switch (kind) {
    case "string":
      return "token string";
    case "number":
      return "token number";
    case "boolean":
      return "token boolean";
    case "null":
      return "token keyword";
    default:
      return "text-muted-foreground";
  }
};

const TreeRow = memo(function TreeRow({
  row,
  hit,
  active,
  onToggle,
  onCopyPath,
  onCopyValue,
}: {
  row: JsonRow;
  hit: boolean;
  active: boolean;
  onToggle: (path: string) => void;
  onCopyPath: (path: string) => void;
  onCopyValue: (row: JsonRow) => void;
}) {
  return (
    <div
      className={cn(
        "group/row flex min-h-5 items-center gap-1 font-mono text-xs leading-5 hover:bg-accent/60",
        hit && "bg-warning/10",
        active && "bg-warning/25",
      )}
      style={{ paddingLeft: 12 + row.depth * INDENT_PX }}
    >
      {row.expandable ? (
        <button
          type="button"
          aria-label={row.expanded ? "折叠" : "展开"}
          aria-expanded={row.expanded}
          onClick={() => onToggle(row.path)}
          className="inline-flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          {row.expanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        </button>
      ) : (
        <span aria-hidden className="inline-block size-4 shrink-0" />
      )}
      {row.key !== null && (
        <>
          <span className="token property whitespace-pre">{JSON.stringify(row.key)}</span>
          <span className="token punctuation">:</span>
        </>
      )}
      {row.arrayIndex !== null && <span className="text-muted-foreground tabular-nums">{row.arrayIndex}</span>}
      {row.arrayIndex !== null && <span className="token punctuation">:</span>}
      <span
        className={cn("min-w-0 break-all whitespace-pre-wrap", valueClass(row.kind), row.expandable && "cursor-pointer")}
        onClick={row.expandable ? () => onToggle(row.path) : undefined}
      >
        {row.display}
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-0.5 pr-3 opacity-0 transition-opacity group-hover/row:opacity-100 focus-within:opacity-100">
        <ToolButton label="复制路径" onClick={() => onCopyPath(row.path)}>
          <Link2 />
        </ToolButton>
        <ToolButton label="复制值" onClick={() => onCopyValue(row)}>
          <CopyIcon />
        </ToolButton>
      </span>
    </div>
  );
});

const JsonTree = ({ root, size, leading }: { root: unknown; size: number; leading: React.ReactNode }) => {
  const copyText = useCopyText();
  const platform = useShellPlatform();
  const listRef = useRef<VirtuosoHandle>(null);
  const findInputRef = useRef<HTMLInputElement>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => defaultExpandedPaths(root, 2));
  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [active, setActive] = useState(0);

  const flat = useMemo(() => flattenJson(root, expanded), [root, expanded]);
  const search = useMemo(() => searchJson(root, deferredQuery), [root, deferredQuery]);
  const hitSet = useMemo(() => new Set(search.matches), [search.matches]);
  const activeIdx = search.matches.length === 0 ? 0 : Math.min(active, search.matches.length - 1);
  const activePath = search.matches[activeIdx] ?? null;

  // 搜索命中：把祖先并进展开集合，命中处才可见
  useEffect(() => {
    if (search.ancestors.size === 0) return;
    setExpanded((prev) => {
      let changed = false;
      for (const a of search.ancestors) if (!prev.has(a)) changed = true;
      if (!changed) return prev;
      const next = new Set(prev);
      for (const a of search.ancestors) next.add(a);
      return next;
    });
  }, [search]);

  useEffect(() => setActive(0), [deferredQuery]);

  // 展开后行表变了，再滚到当前命中
  useEffect(() => {
    if (!activePath) return;
    const idx = flat.rows.findIndex((r) => r.path === activePath);
    if (idx >= 0) listRef.current?.scrollToIndex({ index: idx, align: "center" });
  }, [activePath, flat.rows]);

  const toggle = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const copyPath = useCallback((p: string) => void copyText(p, "路径"), [copyText]);
  const copyValue = useCallback(
    (row: JsonRow) => {
      const v = row.raw;
      void copyText(typeof v === "string" ? v : JSON.stringify(v, null, 2), "值");
    },
    [copyText],
  );

  const step = (delta: 1 | -1) => {
    const n = search.matches.length;
    if (n === 0) return;
    setActive((a) => (Math.min(a, n - 1) + delta + n) % n);
  };

  const openFind = () => {
    setFindOpen(true);
    requestAnimationFrame(() => findInputRef.current?.focus());
  };

  return (
    <div
      className="flex h-full min-h-0 flex-col outline-none"
      tabIndex={-1}
      onKeyDown={(e) => {
        if (isModCombo(e, "f")) {
          e.preventDefault();
          openFind();
        }
      }}
    >
      <PreviewToolbar
        left={
          <>
            {leading}
            <span className="tabular-nums">{formatCount(flat.rows.length)} 个可见节点</span>
            <span>{formatBytes(size)}</span>
          </>
        }
        right={
          <>
            <ToolButton label="查找（键名 / 值）" shortcut={getModShortcutLabel(platform, "F")} onClick={openFind} active={findOpen}>
              <SearchIcon />
            </ToolButton>
            <ToolButton label="展开全部" onClick={() => setExpanded(allContainerPaths(root))}>
              <ChevronsUpDown />
            </ToolButton>
            <ToolButton label="折叠到第一层" onClick={() => setExpanded(defaultExpandedPaths(root, 1))}>
              <ChevronsDownUp />
            </ToolButton>
            <ToolButton label="复制整份 JSON（格式化）" onClick={() => void copyText(JSON.stringify(root, null, 2), "整份 JSON")}>
              <CopyIcon />
            </ToolButton>
          </>
        }
      />
      {findOpen && (
        <FindBar
          value={query}
          onChange={setQuery}
          inputRef={findInputRef}
          placeholder="查找键名或值"
          current={activeIdx + 1}
          total={search.matches.length}
          capped={search.capped}
          onNext={() => step(1)}
          onPrev={() => step(-1)}
          onClose={() => {
            setFindOpen(false);
            setQuery("");
          }}
        />
      )}
      <div className="min-h-0 flex-1">
        <Virtuoso
          ref={listRef}
          style={{ height: "100%" }}
          totalCount={flat.rows.length}
          increaseViewportBy={{ top: 200, bottom: 400 }}
          itemContent={(i) => {
            const row = flat.rows[i]!;
            return (
              <TreeRow
                row={row}
                hit={hitSet.has(row.path)}
                active={row.path === activePath}
                onToggle={toggle}
                onCopyPath={copyPath}
                onCopyValue={copyValue}
              />
            );
          }}
        />
      </div>
      {flat.capped && (
        <p className="shrink-0 border-t border-border/70 bg-muted/20 px-3 py-1.5 text-xs text-warning">
          节点太多，只显示了前面的部分；折叠一些层级，或切到「源码」查看全部
        </p>
      )}
    </div>
  );
};

export const JsonViewer = (props: CodeViewerProps) => {
  const { text, truncated, size, onDirtyChange } = props;
  const parsed = useMemo(() => tryParse(text, truncated), [text, truncated]);
  const { tab, switchTab, handleDirty } = useGuardedTab<"tree" | "source">(parsed.ok ? "tree" : "source", onDirtyChange);

  // 保存后内容变成了合法 JSON（或反过来）：树页签不可用时强制回源码
  const effectiveTab = parsed.ok ? tab : "source";

  const tabs = parsed.ok ? (
    <SegmentedTabs
      tabs={[
        { id: "tree" as const, label: "树" },
        { id: "source" as const, label: "源码" },
      ]}
      value={effectiveTab}
      onChange={switchTab}
    />
  ) : (
    <span className="text-warning">无法解析为树：{parsed.error}</span>
  );

  if (effectiveTab === "tree" && parsed.ok) {
    return <JsonTree root={parsed.value} size={size} leading={tabs} />;
  }
  return <CodeViewer {...props} onDirtyChange={handleDirty} leading={tabs} />;
};
