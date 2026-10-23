"use client";

/**
 * 代码改动面板主体（右侧非模态 Sheet）：工具条 + 左侧文件列表 + 右侧单文件 diff。
 *
 * 这一层只做编排：选中 / 导航 / 已查看 / 快捷键 / 选区 / 搜索 / 目录折叠这些「面板内状态」；
 * 取数（清单 hook）、范围与偏好的持有在入口 task-changes-panel.tsx（chip 要用 totals，且 query 驱动取数）。
 *
 * 快捷键作用域：Sheet 是非模态的（左边任务页仍可点），所以只在「焦点在面板内 / 页面空白处」时响应，
 * 焦点在页面别处的按钮或输入框上时 j / k 不会被抢；输入框里打字永远不触发（resolveChangesHotkey 已排除）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { DiffViewer, type DiffViewerHandle } from "@/components/tasks/changes/diff-viewer";
import { dirCollapseKey, FileList } from "@/components/tasks/changes/file-list";
import { ScopeToolbar } from "@/components/tasks/changes/scope-toolbar";
import { EmptyHint } from "@/components/ui/empty-hint";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  entryKey,
  flattenEntries,
  nextUnviewed,
  orderedEntries,
  stepEntry,
  viewedProgress,
  type ChangeEntry,
} from "@/lib/changes/entries";
import { parseFileQuery } from "@/lib/changes/file-filter";
import { ancestorDirIds, buildFileTree } from "@/lib/changes/file-tree";
import { resolveChangesHotkey, type ChangesHotkey } from "@/lib/changes/hotkeys";
import type { DiffPrefs } from "@/lib/changes/prefs";
import { changesQueryKey, type ChangesQuery } from "@/lib/changes/scope";
import {
  getBrowserStorage,
  isViewed,
  isViewedStale,
  loadViewed,
  markViewed,
  saveViewed,
  unmarkViewed,
  viewedNamespace,
  type ViewedMap,
} from "@/lib/changes/viewed-store";
import type { LineSelection } from "@/lib/diff/quote";
import type { TaskChangeScope, TaskChanges } from "@/lib/types";
import { cn } from "@/lib/utils";

const EMPTY_TEXT: Record<TaskChangeScope["kind"], string> = {
  branch: "相对基线还没有改动",
  uncommitted: "没有未提交的改动",
  commit: "这个提交没有文件改动",
};

interface ChangesSheetProps {
  taskId: string;
  /** chat 模式：文案措辞不同 */
  chat: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  data: TaskChanges;
  /** 手里的数据不是当前 query 拉的（正在换范围 / 基线） */
  stale: boolean;
  error: string | null;
  loading: boolean;
  updatedAt: number;
  running: boolean;
  query: ChangesQuery;
  onScopeChange: (scope: TaskChangeScope) => void;
  onBaseRefChange: (baseRef: string | null) => void;
  prefs: DiffPrefs;
  onPrefsChange: (patch: Partial<DiffPrefs>) => void;
  /** 手动刷新：清单 + 当前文件 diff 都重拉 */
  onRefresh: () => void;
  /** 手动刷新计数（给 diff 重拉用） */
  refreshKey: number;
}

export const ChangesSheet = ({
  taskId,
  chat,
  open,
  onOpenChange,
  data,
  stale,
  error,
  loading,
  updatedAt,
  running,
  query,
  onScopeChange,
  onBaseRefChange,
  prefs,
  onPrefsChange,
  onRefresh,
  refreshKey,
}: ChangesSheetProps) => {
  const repos = data.repos;
  const [search, setSearch] = useState("");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [selection, setSelection] = useState<LineSelection | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const viewerRef = useRef<DiffViewerHandle | null>(null);

  // ---------- 已查看（按「任务 + 比较口径」持久化到 localStorage） ----------
  // 口径（范围 / 手动基线）一变，同一个文件的 diff 就是另一份：在「整条分支」里标过的，
  // 切到「仅未提交」不能显示成「看过之后又变了」，反过来也不能互相覆盖——各存各的
  const viewedNs = viewedNamespace(taskId, query.scope, query.baseRef);
  const [viewedNsState, setViewedNsState] = useState(viewedNs);
  const [viewed, setViewed] = useState<ViewedMap>(() => loadViewed(getBrowserStorage(), viewedNs));
  if (viewedNsState !== viewedNs) {
    setViewedNsState(viewedNs);
    setViewed(loadViewed(getBrowserStorage(), viewedNs));
  }
  const commitViewed = (next: ViewedMap) => {
    setViewed(next);
    saveViewed(getBrowserStorage(), viewedNs, next);
  };

  // ---------- 条目 / 顺序 / 选中 ----------
  const terms = useMemo(() => parseFileQuery(search), [search]);
  const allEntries = useMemo(() => flattenEntries(repos), [repos]);
  const order = useMemo(
    () => orderedEntries(repos, { treeMode: prefs.treeMode, terms }),
    [repos, prefs.treeMode, terms],
  );
  // 选中项被过滤出列表也保持显示；真的不存在了（清单刷新后没了 / 换范围）才回落到第一个可见的
  const selected =
    allEntries.find((e) => e.key === selectedKey) ?? order[0] ?? allEntries[0] ?? null;
  const selectedNow = selected?.key ?? null;
  const queryKey = changesQueryKey(query);

  // 换文件 / 换范围：行号选区作废
  const selectionScope = `${selectedNow}|${queryKey}`;
  const [prevSelectionScope, setPrevSelectionScope] = useState(selectionScope);
  if (prevSelectionScope !== selectionScope) {
    setPrevSelectionScope(selectionScope);
    setSelection(null);
  }

  const progress = useMemo(() => viewedProgress(allEntries, viewed), [allEntries, viewed]);

  const orderIndex = selected ? order.findIndex((e) => e.key === selected.key) : -1;
  const position = orderIndex >= 0 ? { index: orderIndex, total: order.length } : null;

  /** 跳到某个文件（目录折叠着的话把祖先展开，否则列表里看不见选中项） */
  const goTo = useCallback(
    (entry: ChangeEntry | null) => {
      if (!entry) return;
      setSelectedKey(entry.key);
      if (prefs.treeMode !== "tree" || terms.length > 0) return;
      const repo = repos.find((r) => r.repoPath === entry.repoPath);
      if (!repo || repo.unavailable) return;
      const tree = buildFileTree(
        repo.files.map((f) => ({
          key: entryKey(repo.repoPath, f.path),
          path: f.path,
          added: f.added,
          removed: f.removed,
          data: f,
        })),
      );
      const ids = ancestorDirIds(tree, entry.key).map((id) => dirCollapseKey(repo.repoPath, id));
      if (ids.some((id) => collapsed.has(id))) {
        setCollapsed((prev) => {
          const next = new Set(prev);
          for (const id of ids) next.delete(id);
          return next;
        });
      }
    },
    [prefs.treeMode, terms.length, repos, collapsed],
  );

  const viewedOfSelected = selected ? isViewed(viewed, selected.key, selected.viewedSig) : false;
  const staleOfSelected = selected ? isViewedStale(viewed, selected.key, selected.viewedSig) : false;

  const toggleViewed = () => {
    // 数据还是上一个口径的（正在换范围 / 基线）：现在标记会把旧口径的签名写进新口径的命名空间
    if (!selected || stale) return;
    commitViewed(
      viewedOfSelected
        ? unmarkViewed(viewed, selected.key)
        : markViewed(viewed, selected.key, selected.viewedSig),
    );
  };

  /** 标记当前已查看并跳到下一个没看过的（走到末尾回绕；都看完了给个提示） */
  const markAndNext = () => {
    if (!selected || stale) return;
    const next = viewedOfSelected ? viewed : markViewed(viewed, selected.key, selected.viewedSig);
    if (next !== viewed) commitViewed(next);
    const target = nextUnviewed(order, selected.key, next);
    if (target) goTo(target);
    else toast.success("当前列表里的文件都看完了");
  };

  const focusSearch = () => {
    if (prefs.treeHidden) onPrefsChange({ treeHidden: false });
    // 文件栏刚显示出来时输入框还没挂上，下一帧再聚焦
    requestAnimationFrame(() => searchRef.current?.focus());
  };

  const runHotkey = (action: ChangesHotkey) => {
    switch (action) {
      case "nextFile":
        goTo(stepEntry(order, selected?.key ?? null, 1));
        break;
      case "prevFile":
        goTo(stepEntry(order, selected?.key ?? null, -1));
        break;
      case "nextChange":
        viewerRef.current?.nextChange();
        break;
      case "prevChange":
        viewerRef.current?.prevChange();
        break;
      case "viewedAndNext":
        markAndNext();
        break;
      case "toggleViewed":
        toggleViewed();
        break;
      case "toggleSplit":
        onPrefsChange({ view: prefs.view === "split" ? "unified" : "split" });
        break;
      case "toggleIgnoreWs":
        onPrefsChange({ ignoreWs: !prefs.ignoreWs });
        break;
      case "toggleExpandAll":
        viewerRef.current?.toggleExpandAll();
        break;
      case "focusSearch":
        focusSearch();
        break;
      case "toggleWide":
        onPrefsChange({ wide: !prefs.wide });
        break;
      case "toggleTree":
        onPrefsChange({ treeHidden: !prefs.treeHidden });
        break;
      case "help":
        setHelpOpen((o) => !o);
        break;
    }
  };

  // 键盘监听只绑一次，读「最新一次渲染」的函数（省得每次状态变化都解绑重绑）
  const latestRef = useRef({
    runHotkey,
    hasSelection: false,
    clearSelection: () => {},
  });
  useEffect(() => {
    latestRef.current = {
      runHotkey,
      hasSelection: selection !== null,
      clearSelection: () => setSelection(null),
    };
  });

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const active = document.activeElement;
      // 弹层（提交 / 基线 / 帮助）里的按键归弹层自己，不当快捷键
      if (active?.closest?.('[data-slot="popover-content"]')) return;
      const inSheet = !!active?.closest?.("[data-changes-sheet]");
      const onBody = !active || active === document.body;
      // 焦点在页面别处（左侧任务页的按钮 / 输入框）：不抢
      if (!inSheet && !onBody) return;
      const latest = latestRef.current;
      if (e.key === "Escape") {
        // 有行选区时 Esc 先取消选区，不关面板（捕获阶段拦下，面板自己的 Esc 关闭收不到）
        if (latest.hasSelection) {
          e.preventDefault();
          e.stopPropagation();
          latest.clearSelection();
        }
        return;
      }
      const action = resolveChangesHotkey({
        key: e.key,
        shiftKey: e.shiftKey,
        altKey: e.altKey,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
        isComposing: e.isComposing,
        keyCode: e.keyCode,
        repeat: e.repeat,
        // 键盘事件的 target 是 EventTarget；元素才有 tagName / isContentEditable（判断是不是在打字）
        target: e.target instanceof HTMLElement ? e.target : null,
      });
      if (!action) return;
      e.preventDefault();
      latest.runHotkey(action);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [open]);

  // ---------- 渲染 ----------
  const { totals } = data;
  const singleBranch = repos.length === 1 ? repos[0]?.branch : null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        data-changes-sheet=""
        className={cn(
          "max-w-none",
          // 加宽也要给左侧留位置：左上角有关闭键，macOS 窗口左上还有红绿灯，不能盖住
          prefs.wide ? "w-[calc(100vw-6rem)]" : "w-[min(1040px,88vw)]",
        )}
      >
        <SheetHeader>
          <SheetTitle>{chat ? "当前分支的代码改动" : "代码改动"}</SheetTitle>
          <SheetDescription>
            {totals.files > 0
              ? `${totals.files} 个文件 · +${totals.added} −${totals.removed}`
              : EMPTY_TEXT[query.scope.kind]}
            {chat && singleBranch ? ` · ${singleBranch}` : ""}
            {running && " · 运行中，自动刷新"}
          </SheetDescription>
        </SheetHeader>

        <ScopeToolbar
          taskId={taskId}
          chat={chat}
          repos={repos}
          query={query}
          onScopeChange={onScopeChange}
          onBaseRefChange={onBaseRefChange}
          prefs={prefs}
          onPrefsChange={onPrefsChange}
          loading={loading}
          onRefresh={onRefresh}
          helpOpen={helpOpen}
          onHelpOpenChange={setHelpOpen}
        />
        {/* 换范围 / 基线时的细进度条（静默轮询不显示，不闪） */}
        {(loading || stale) && (
          <div className="h-0.5 shrink-0 animate-pulse bg-info motion-reduce:animate-none" />
        )}

        <div className="flex min-h-0 flex-1">
          {!prefs.treeHidden && (
            <aside className="flex w-72 shrink-0 flex-col border-r">
              <FileList
                repos={repos}
                scopeKind={query.scope.kind}
                chat={chat}
                treeMode={prefs.treeMode}
                search={search}
                onSearchChange={setSearch}
                searchRef={searchRef}
                selectedKey={selectedNow}
                onSelect={setSelectedKey}
                viewed={viewed}
                collapsed={collapsed}
                onCollapsedChange={setCollapsed}
                progress={progress}
                error={error}
              />
            </aside>
          )}
          {selected ? (
            <DiffViewer
              taskId={taskId}
              entry={selected}
              query={query}
              prefs={prefs}
              // 手里是旧范围的数据时别拉（文件签名对不上新范围）
              open={open && !stale}
              running={running}
              updatedAt={updatedAt}
              refreshKey={refreshKey}
              viewed={viewedOfSelected}
              viewedStale={staleOfSelected}
              onToggleViewed={toggleViewed}
              onShowWhitespace={() => onPrefsChange({ ignoreWs: false })}
              selection={selection}
              onSelectionChange={setSelection}
              position={position}
              onPrev={
                orderIndex > 0 ? () => goTo(stepEntry(order, selectedNow, -1)) : null
              }
              onNext={
                orderIndex >= 0 && orderIndex < order.length - 1
                  ? () => goTo(stepEntry(order, selectedNow, 1))
                  : null
              }
              handleRef={viewerRef}
            />
          ) : (
            <div className="flex min-w-0 flex-1 items-center justify-center p-6">
              {/* selected 为空 ⇔ 清单里一个文件都没有（有文件时总会回落到第一个） */}
              <EmptyHint variant="dashed" align="center" size="lg">
                {EMPTY_TEXT[query.scope.kind]}
              </EmptyHint>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
};
