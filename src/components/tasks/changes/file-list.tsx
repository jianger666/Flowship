"use client";

/**
 * 改动面板左侧：文件搜索 + 已查看进度 + 按仓分组的文件列表（目录树 / 平铺）。
 *
 * - 搜索：空格分词、全部命中才留（lib/changes/file-filter），命中片段高亮；搜索中树自动全部展开；
 * - 树：目录在前、单链压缩、子树汇总（lib/changes/file-tree）；折叠状态由外层持有（导航跳进折叠目录时要展开）；
 * - 已查看：看过的文件变灰 + 打勾；看过之后又改了（统计变了）显示警示图标，需要重新看；
 * - 每个仓一个粘性头：仓名 / 分支 / 基线（含领先落后）/ 范围说明。
 *
 * 显示顺序与 j/k 导航顺序同源（lib/changes/entries.orderedEntries）。
 */

import { memo, useEffect, useMemo, useRef, type ReactNode, type RefObject } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  FoldVertical,
  Search,
  UnfoldVertical,
  X,
} from "lucide-react";

import {
  LineStat,
  StatusBadge,
  ToolbarButton,
  UNAVAILABLE_TEXT,
} from "@/components/tasks/changes/shared";
import { Input } from "@/components/ui/input";
import { Tooltip } from "@/components/ui/tooltip";
import { entryKey, splitPath, viewedSignature } from "@/lib/changes/entries";
import { matchesFileQuery, matchRanges, parseFileQuery } from "@/lib/changes/file-filter";
import {
  allDirIds,
  buildFileTree,
  flattenFileTree,
  type FlatTreeRow,
} from "@/lib/changes/file-tree";
import { isViewed, isViewedStale, type ViewedMap } from "@/lib/changes/viewed-store";
import type { TaskChangeFile, TaskChangeScope, TaskRepoChanges } from "@/lib/types";
import { cn } from "@/lib/utils";

/** 目录折叠状态的 key：跨仓不撞（不同仓可能有同名目录） */
export const dirCollapseKey = (repoPath: string, dirId: string): string =>
  `${repoPath}\u0000${dirId}`;

type ScopeKind = TaskChangeScope["kind"];

// ---------------------------------------------------------------------
// 搜索命中高亮
// ---------------------------------------------------------------------

/** ranges 是相对完整 path 的偏移；text 是 path 里从 offset 起的一段 */
const HighlightedText = ({
  text,
  ranges,
  offset,
}: {
  text: string;
  ranges: ReadonlyArray<readonly [number, number]>;
  offset: number;
}) => {
  if (ranges.length === 0) return <>{text}</>;
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const [s, e] of ranges) {
    const start = Math.max(s - offset, cursor);
    const end = Math.min(e - offset, text.length);
    // 与这段文字没有交集
    if (end <= start) continue;
    if (start > cursor) parts.push(text.slice(cursor, start));
    parts.push(
      <mark key={start} className="rounded-[2px] bg-warning/30 text-inherit">
        {text.slice(start, end)}
      </mark>,
    );
    cursor = end;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
};

// ---------------------------------------------------------------------
// 仓头部
// ---------------------------------------------------------------------

/** 基线说明（「相对谁」） */
const baseLine = (repo: TaskRepoChanges, scopeKind: ScopeKind): string | null => {
  const b = repo.base;
  if (!b) return null;
  if (b.kind === "merge-base") return `相对 ${b.label} 的分叉点（${b.shortSha}）`;
  if (b.kind === "commit-parent") return `相对 ${b.label}（${b.shortSha}）`;
  if (b.kind === "empty-tree") return "仓库还没有任何提交 · 列出目前写入的全部文件";
  return scopeKind === "uncommitted"
    ? "相对 HEAD · 只含未提交的改动"
    : "相对 HEAD · 未找到线上分支，只含未提交的改动";
};

/**
 * 仓头部补充说明（只在需要解释「这些改动是什么范围」时出现）。
 * - 看单个提交 / 只看未提交：直接说清范围；
 * - 当前就在线上分支本身：没有分支上的提交可看、只剩未提交 / 未推送的；
 * - chat：当前分支相对线上分支的全部改动；找不到线上分支就降级、并提示可手动选基线；
 * - task 非隔离（直接在原仓）：中性说明——看到的是当前分支的整体改动、不只是本任务的增量；降级 HEAD 时黄色警告。
 */
const RepoScopeNote = ({
  repo,
  scopeKind,
  chat,
}: {
  repo: TaskRepoChanges;
  scopeKind: ScopeKind;
  chat: boolean;
}) => {
  if (repo.unavailable || !repo.base) return null;
  const note = "mt-0.5 text-[11px] text-muted-foreground";
  // 空仓（还没有任何提交）：没有基线可比，不论什么范围 / 形态都只说这一句——
  // 否则会落到下面「相对线上分支」「相对 HEAD」之类不适用的文案
  if (repo.base.kind === "empty-tree") {
    return (
      <div className={note}>
        还没有提交，没有基线可对比——列出的是目前写入的全部文件（含新建文件，不含被 .gitignore 忽略的）
      </div>
    );
  }
  if (scopeKind === "commit") {
    return <div className={note}>只显示这个提交自己的改动（相对它的上一个提交）</div>;
  }
  if (scopeKind === "uncommitted") {
    return <div className={note}>只显示还没提交的改动（含新建文件）</div>;
  }
  if (repo.onBaseBranch) {
    return (
      <div className={note}>当前就在线上分支 {repo.branch} 上，只显示未提交或未推送的改动</div>
    );
  }
  if (chat) {
    return repo.base.kind === "head" ? (
      <div className={note}>
        没找到可对比的线上分支，只显示未提交的改动——可以在工具栏的「对比」里手动选一个基线
      </div>
    ) : (
      <div className={note}>
        当前{repo.branch ? "分支" : "检出提交"}相对线上分支的全部改动（已提交 + 未提交）
      </div>
    );
  }
  if (repo.isolated) return null;
  if (repo.base.kind === "head") {
    return (
      <div className="mt-0.5 flex items-start gap-1 text-[11px] text-warning">
        <AlertTriangle className="mt-px size-3 shrink-0" />
        <span>任务直接在原仓库工作，改动可能混有你本地原有的未提交内容</span>
      </div>
    );
  }
  return (
    <div className={note}>
      任务直接在原仓库工作：显示{repo.branch ? "当前分支" : "当前检出提交"}
      的整体改动，含任务开始前已有的提交和未提交内容
    </div>
  );
};

const RepoHeader = ({
  repo,
  scopeKind,
  chat,
}: {
  repo: TaskRepoChanges;
  scopeKind: ScopeKind;
  chat: boolean;
}) => {
  const ahead = repo.aheadOfBase ?? 0;
  const behind = repo.behindBase ?? 0;
  const base = baseLine(repo, scopeKind);
  return (
    <div className="sticky top-0 z-10 border-b bg-background px-2 py-1.5">
      <div className="flex min-w-0 items-center gap-1.5 text-xs">
        <span className="min-w-0 truncate font-medium">{repo.shortName}</span>
        {repo.branch ? (
          <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">
            {repo.branch}
          </span>
        ) : (
          // 空仓读不出分支名（HEAD 还不指向任何提交），但那不是「游离 HEAD」
          !repo.unavailable &&
          repo.base?.kind !== "empty-tree" && (
            <Tooltip content="当前不在任何分支上（detached HEAD）">
              <span className="shrink-0 text-[11px] text-muted-foreground">游离 HEAD</span>
            </Tooltip>
          )
        )}
      </div>
      {base && (
        <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[11px] text-muted-foreground">
          <span>{base}</span>
          {ahead > 0 && <span className="tabular-nums">· 领先 {ahead}</span>}
          {behind > 0 && (
            <Tooltip content="线上分支比分叉点多了这些提交——你的分支还没合并它们，上面的改动不含它们">
              <span className="tabular-nums text-warning">· 落后 {behind}</span>
            </Tooltip>
          )}
        </div>
      )}
      {repo.baseOverride && !repo.baseOverride.applied && (
        <div className="mt-0.5 flex items-start gap-1 text-[11px] text-warning">
          <AlertTriangle className="mt-px size-3 shrink-0" />
          <span>
            手动选的基线 {repo.baseOverride.requested} 不可用（不存在或与当前提交没有共同历史），已回落成自动探测
          </span>
        </div>
      )}
      <RepoScopeNote repo={repo} scopeKind={scopeKind} chat={chat} />
    </div>
  );
};

// ---------------------------------------------------------------------
// 行
// ---------------------------------------------------------------------

type ViewedState = "no" | "yes" | "stale";

interface FileRowProps {
  repoPath: string;
  file: TaskChangeFile;
  depth: number;
  /** 平铺：文件名后面带目录；树：只显示文件名 */
  showDir: boolean;
  selected: boolean;
  viewedState: ViewedState;
  terms: readonly string[];
  onSelect: (key: string) => void;
}

const FileRow = memo(function FileRow({
  repoPath,
  file,
  depth,
  showDir,
  selected,
  viewedState,
  terms,
  onSelect,
}: FileRowProps) {
  const { dir, name } = splitPath(file.path);
  const ranges = useMemo(() => matchRanges(file.path, terms), [file.path, terms]);
  const key = entryKey(repoPath, file.path);
  return (
    // 整行挂 Tooltip 看完整路径（行里的文件名 / 目录窄了会被省略）。内容恒非空（路径永远有）——
    // 刻意不做「没被截断才不挂」：Tooltip 在「content 为空 → 直接返回 children」与「非空 → 包 Provider」
    // 之间切换会改变元素树形状、行按钮被卸载重挂，键盘焦点会丢（同 tool-path-display 的结论）
    <Tooltip
      side="right"
      content={
        <span className="font-mono">
          {file.path}
          {file.oldPath ? <span className="block">← {file.oldPath}</span> : null}
          {file.nestedRepo ? (
            <span className="block font-sans">嵌套的 git 仓库：它里面的改动不在这里统计</span>
          ) : null}
          {viewedState === "stale" ? (
            <span className="block font-sans text-warning">标记已查看之后，这个文件又有新变化</span>
          ) : null}
        </span>
      }
    >
      <button
        type="button"
        onClick={() => onSelect(key)}
        data-selected={selected ? "" : undefined}
        aria-current={selected ? "true" : undefined}
        style={{ paddingLeft: 8 + depth * 12 }}
        className={cn(
          "flex w-full min-w-0 cursor-pointer items-center gap-1.5 py-1 pr-2 text-left text-xs hover:bg-muted/60",
          selected && "bg-muted",
        )}
      >
        <StatusBadge status={file.status} />
        {/* 窄了先省略目录、再省略文件名（目录 shrink 权重远大于文件名 → 先缩到 0，文件名才开始被截），
            +/− 统计始终 shrink-0 钉右、不被文件名盖住 */}
        <span className="flex min-w-0 flex-1 items-baseline">
          <span
            className={cn(
              "min-w-0 truncate font-mono font-medium",
              viewedState === "yes" ? "text-muted-foreground" : "text-foreground",
            )}
          >
            <HighlightedText text={name} ranges={ranges} offset={dir.length} />
          </span>
          {showDir && dir && (
            <span className="ml-1.5 min-w-0 shrink-[100] truncate font-mono text-[11px] text-muted-foreground">
              <HighlightedText text={dir} ranges={ranges} offset={0} />
            </span>
          )}
        </span>
        {viewedState === "yes" && <CircleCheck className="size-3 shrink-0 text-success" />}
        {viewedState === "stale" && <CircleAlert className="size-3 shrink-0 text-warning" />}
        {file.nestedRepo ? (
          <span className="shrink-0 text-[11px] text-muted-foreground">嵌套仓库</span>
        ) : file.whitespaceOnly ? (
          <span className="shrink-0 text-[11px] text-muted-foreground">仅空白</span>
        ) : file.binary ? (
          <span className="shrink-0 text-[11px] text-muted-foreground">二进制</span>
        ) : (
          <LineStat added={file.added} removed={file.removed} className="text-[11px]" />
        )}
      </button>
    </Tooltip>
  );
});

const DirRow = memo(function DirRow({
  dirId,
  name,
  depth,
  collapsed,
  fileCount,
  added,
  removed,
  onToggle,
}: {
  dirId: string;
  name: string;
  depth: number;
  collapsed: boolean;
  fileCount: number;
  added: number;
  removed: number;
  onToggle: (dirId: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onToggle(dirId)}
      aria-expanded={!collapsed}
      style={{ paddingLeft: 8 + depth * 12 }}
      className="flex w-full min-w-0 cursor-pointer items-center gap-1 py-1 pr-2 text-left text-xs text-muted-foreground hover:bg-muted/60"
    >
      {collapsed ? (
        <ChevronRight className="size-3.5 shrink-0" />
      ) : (
        <ChevronDown className="size-3.5 shrink-0" />
      )}
      <span className="min-w-0 flex-1 truncate font-mono">{name}</span>
      <span className="shrink-0 text-[11px] tabular-nums">{fileCount}</span>
      <LineStat added={added} removed={removed} className="text-[11px]" />
    </button>
  );
});

// ---------------------------------------------------------------------
// 一个仓
// ---------------------------------------------------------------------

interface RepoSectionProps {
  repo: TaskRepoChanges;
  scopeKind: ScopeKind;
  chat: boolean;
  treeMode: "tree" | "flat";
  terms: readonly string[];
  selectedKey: string | null;
  onSelect: (key: string) => void;
  viewed: ViewedMap;
  collapsed: ReadonlySet<string>;
  onToggleDir: (repoPath: string, dirId: string) => void;
}

const viewedStateOf = (viewed: ViewedMap, key: string, file: TaskChangeFile): ViewedState => {
  const sig = viewedSignature(file);
  if (isViewed(viewed, key, sig)) return "yes";
  return isViewedStale(viewed, key, sig) ? "stale" : "no";
};

const RepoSection = ({
  repo,
  scopeKind,
  chat,
  treeMode,
  terms,
  selectedKey,
  onSelect,
  viewed,
  collapsed,
  onToggleDir,
}: RepoSectionProps) => {
  const searching = terms.length > 0;
  const files = useMemo(
    () => repo.files.filter((f) => matchesFileQuery(f.path, terms)),
    [repo.files, terms],
  );
  const tree = useMemo(
    () =>
      treeMode === "tree"
        ? buildFileTree(
            files.map((f) => ({
              key: entryKey(repo.repoPath, f.path),
              path: f.path,
              added: f.added,
              removed: f.removed,
              data: f,
            })),
          )
        : null,
    [files, treeMode, repo.repoPath],
  );
  // 搜索中全部展开（折叠着的目录里藏着命中项会让人以为「没搜到」）
  const rows = useMemo<FlatTreeRow<TaskChangeFile>[] | null>(() => {
    if (!tree) return null;
    const closed = new Set<string>();
    if (!searching) {
      for (const id of allDirIds(tree)) {
        if (collapsed.has(dirCollapseKey(repo.repoPath, id))) closed.add(id);
      }
    }
    return flattenFileTree(tree, closed);
  }, [tree, collapsed, searching, repo.repoPath]);

  const toggleDir = (dirId: string) => onToggleDir(repo.repoPath, dirId);

  const renderFile = (file: TaskChangeFile, depth: number, showDir: boolean) => {
    const key = entryKey(repo.repoPath, file.path);
    return (
      <FileRow
        key={key}
        repoPath={repo.repoPath}
        file={file}
        depth={depth}
        showDir={showDir}
        selected={selectedKey === key}
        viewedState={viewedStateOf(viewed, key, file)}
        terms={terms}
        onSelect={onSelect}
      />
    );
  };

  return (
    <div>
      <RepoHeader repo={repo} scopeKind={scopeKind} chat={chat} />
      {repo.unavailable ? (
        <p className="px-2 py-3 text-xs text-muted-foreground">{UNAVAILABLE_TEXT[repo.unavailable]}</p>
      ) : repo.files.length === 0 ? (
        <p className="px-2 py-3 text-xs text-muted-foreground">暂无改动</p>
      ) : files.length === 0 ? (
        <p className="px-2 py-3 text-xs text-muted-foreground">没有匹配的文件</p>
      ) : rows ? (
        rows.map(({ node, depth }) =>
          node.type === "dir" ? (
            <DirRow
              key={`d:${node.id}`}
              dirId={node.id}
              name={node.name}
              depth={depth}
              collapsed={!searching && collapsed.has(dirCollapseKey(repo.repoPath, node.id))}
              fileCount={node.fileCount}
              added={node.added}
              removed={node.removed}
              onToggle={toggleDir}
            />
          ) : (
            renderFile(node.item.data, depth, false)
          ),
        )
      ) : (
        files.map((f) => renderFile(f, 0, true))
      )}
      {repo.filesTruncated && (
        <p className="px-2 py-1.5 text-[11px] text-warning">
          改动文件太多，仅列出前 {repo.files.length} 个（共 {repo.totals.files} 个）
        </p>
      )}
      {repo.untrackedSkipped && (
        <p className="px-2 py-1.5 text-[11px] text-warning">新建文件清单读取失败，可能没列全</p>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------
// 列表
// ---------------------------------------------------------------------

export interface FileListProps {
  repos: readonly TaskRepoChanges[];
  scopeKind: ScopeKind;
  /** chat 模式：范围说明的措辞不同 */
  chat: boolean;
  treeMode: "tree" | "flat";
  search: string;
  onSearchChange: (value: string) => void;
  searchRef: RefObject<HTMLInputElement | null>;
  selectedKey: string | null;
  onSelect: (key: string) => void;
  viewed: ViewedMap;
  collapsed: ReadonlySet<string>;
  onCollapsedChange: (next: Set<string>) => void;
  progress: { viewed: number; total: number };
  error: string | null;
}

export const FileList = ({
  repos,
  scopeKind,
  chat,
  treeMode,
  search,
  onSearchChange,
  searchRef,
  selectedKey,
  onSelect,
  viewed,
  collapsed,
  onCollapsedChange,
  progress,
  error,
}: FileListProps) => {
  const listRef = useRef<HTMLDivElement>(null);
  const terms = useMemo(() => parseFileQuery(search), [search]);

  // 选中项变了（点击 / j·k 导航）：滚进可视区
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>("[data-selected]")?.scrollIntoView({
      block: "nearest",
    });
  }, [selectedKey]);

  const toggleDir = (repoPath: string, dirId: string) => {
    const key = dirCollapseKey(repoPath, dirId);
    const next = new Set(collapsed);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    onCollapsedChange(next);
  };

  const collapseAll = () => {
    const next = new Set<string>();
    for (const repo of repos) {
      if (repo.unavailable) continue;
      const tree = buildFileTree(
        repo.files.map((f) => ({
          key: entryKey(repo.repoPath, f.path),
          path: f.path,
          added: f.added,
          removed: f.removed,
          data: f,
        })),
      );
      for (const id of allDirIds(tree)) next.add(dirCollapseKey(repo.repoPath, id));
    }
    onCollapsedChange(next);
  };

  const percent = progress.total > 0 ? Math.round((progress.viewed / progress.total) * 100) : 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 space-y-1.5 border-b p-1.5">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={searchRef}
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="筛选文件（空格分词，按 / 聚焦）"
            aria-label="筛选文件"
            className="h-7 pr-7 pl-7 text-xs md:text-xs"
          />
          {search && (
            <button
              type="button"
              aria-label="清空筛选"
              onClick={() => onSearchChange("")}
              className="absolute top-1/2 right-1.5 flex size-4 -translate-y-1/2 cursor-pointer items-center justify-center rounded text-muted-foreground hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
        <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
          <span className="tabular-nums">
            已查看 {progress.viewed}/{progress.total}
          </span>
          {treeMode === "tree" && (
            <span className="flex items-center gap-0.5">
              <ToolbarButton label="展开全部目录" onClick={() => onCollapsedChange(new Set())}>
                <UnfoldVertical />
              </ToolbarButton>
              <ToolbarButton label="折叠全部目录" onClick={collapseAll}>
                <FoldVertical />
              </ToolbarButton>
            </span>
          )}
        </div>
        {progress.total > 0 && (
          <div
            role="progressbar"
            aria-label="已查看进度"
            aria-valuemin={0}
            aria-valuemax={progress.total}
            aria-valuenow={progress.viewed}
            className="h-1 overflow-hidden rounded-full bg-muted"
          >
            <div className="h-full rounded-full bg-success" style={{ width: `${percent}%` }} />
          </div>
        )}
      </div>
      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto">
        {error && (
          <div className="border-b px-2 py-1.5 text-[11px] text-destructive">刷新失败：{error}</div>
        )}
        {repos.map((repo) => (
          <RepoSection
            key={repo.repoPath}
            repo={repo}
            scopeKind={scopeKind}
            chat={chat}
            treeMode={treeMode}
            terms={terms}
            selectedKey={selectedKey}
            onSelect={onSelect}
            viewed={viewed}
            collapsed={collapsed}
            onToggleDir={toggleDir}
          />
        ))}
      </div>
    </div>
  );
};
