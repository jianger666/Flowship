"use client";

/**
 * 改动面板工具条：范围（整条分支 / 仅未提交 / 单个提交）、对比基线、显示偏好、刷新、快捷键帮助。
 *
 * 范围与基线都是「换一批数据」的选择（会重新拉清单）；忽略空白也是（git -w 才能给出对的统计）。
 * 统一 / 分栏、树 / 平铺、文件栏显隐、加宽面板只是显示偏好（存 localStorage，全局共享）。
 */

import { useEffect, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  ChevronDown,
  Columns2,
  GitBranch,
  GitCommitHorizontal,
  Keyboard,
  List,
  ListTree,
  Loader2,
  Maximize2,
  Minimize2,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  Rows2,
  Space,
} from "lucide-react";

import { Kbd, ToolbarButton } from "@/components/tasks/changes/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip } from "@/components/ui/tooltip";
import { useRepoBranches } from "@/hooks/use-repo-branches";
import { CHANGES_HOTKEY_HELP } from "@/lib/changes/hotkeys";
import type { DiffPrefs } from "@/lib/changes/prefs";
import type { ChangesQuery } from "@/lib/changes/scope";
import { formatRelative } from "@/lib/task-display";
import { fetchTaskChangeCommits } from "@/lib/task-store";
import type { TaskChangeScope, TaskRepoChanges, TaskRepoCommitList } from "@/lib/types";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------
// 分段按钮
// ---------------------------------------------------------------------

const SEGMENT_BASE =
  "inline-flex h-5 cursor-pointer items-center gap-1 rounded px-2 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50";

const segmentClass = (active: boolean) =>
  cn(
    SEGMENT_BASE,
    active
      ? "bg-background text-foreground shadow-xs"
      : "text-muted-foreground hover:text-foreground",
  );

const Segmented = ({ children }: { children: ReactNode }) => (
  <div className="inline-flex items-center gap-0.5 rounded-md border bg-muted/40 p-0.5">{children}</div>
);

// ---------------------------------------------------------------------
// 提交选择器
// ---------------------------------------------------------------------

type CommitsState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ok"; repos: TaskRepoCommitList[] };

const CommitPicker = ({
  taskId,
  baseRef,
  scope,
  onSelect,
}: {
  taskId: string;
  baseRef: string | null;
  scope: TaskChangeScope;
  onSelect: (sha: string) => void;
}) => {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<CommitsState>({ status: "loading" });
  const active = scope.kind === "commit";
  const currentSha = scope.kind === "commit" ? scope.sha : null;

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) setState({ status: "loading" });
  };

  // 每次打开都重拉：用户可能刚在终端里提交过
  useEffect(() => {
    if (!open) return;
    const ctl = new AbortController();
    fetchTaskChangeCommits(taskId, { baseRef }, ctl.signal)
      .then((data) => {
        if (!ctl.signal.aborted) setState({ status: "ok", repos: data.repos });
      })
      .catch((err: unknown) => {
        if (ctl.signal.aborted) return;
        setState({ status: "error", message: err instanceof Error ? err.message : "未知错误" });
      });
    return () => ctl.abort();
  }, [open, taskId, baseRef]);

  const multiRepo = state.status === "ok" && state.repos.length > 1;

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <Tooltip content="挑分支上的某一个提交，单独看它改了什么">
        <span className="inline-flex">
          <PopoverTrigger
            render={
              <button type="button" className={segmentClass(active)}>
                <GitCommitHorizontal className="size-3" />
                {currentSha ? (
                  <span className="font-mono">{currentSha.slice(0, 7)}</span>
                ) : (
                  "单个提交"
                )}
                <ChevronDown className="size-3" />
              </button>
            }
          />
        </span>
      </Tooltip>
      <PopoverContent align="start" className="w-[28rem] p-1">
        <div className="max-h-80 overflow-y-auto">
          {state.status === "loading" ? (
            <p className="px-2 py-3 text-xs text-muted-foreground">加载提交列表…</p>
          ) : state.status === "error" ? (
            <p className="px-2 py-3 text-xs text-destructive">加载失败：{state.message}</p>
          ) : (
            state.repos.map((repo) => (
              <div key={repo.repoPath}>
                {multiRepo && (
                  <div className="px-2 py-1 text-[11px] font-medium text-muted-foreground">
                    {repo.shortName}
                  </div>
                )}
                {repo.unavailable ? (
                  <p className="px-2 py-2 text-xs text-muted-foreground">
                    {repo.unavailable === "no_base"
                      ? "没找到可对比的线上分支，列不出分支上的提交"
                      : "这个仓读不到提交"}
                  </p>
                ) : repo.commits.length === 0 ? (
                  <p className="px-2 py-2 text-xs text-muted-foreground">
                    分支上还没有新提交（当前就在线上分支，或改动都还没提交）
                  </p>
                ) : (
                  repo.commits.map((c) => (
                    <button
                      key={c.sha}
                      type="button"
                      onClick={() => {
                        onSelect(c.sha);
                        setOpen(false);
                      }}
                      className={cn(
                        "flex w-full cursor-pointer items-baseline gap-2 rounded px-2 py-1 text-left text-xs hover:bg-muted",
                        c.sha === currentSha && "bg-muted",
                      )}
                    >
                      <span className="shrink-0 font-mono text-[11px] text-info">{c.shortSha}</span>
                      <span className="min-w-0 flex-1 truncate">{c.subject}</span>
                      {c.isMerge && (
                        <Tooltip content="合并提交：这里看到的是它相对第一个父提交的改动，可能包含整条被合进来的分支，不一定是这次合并自己做的事">
                          <span className="shrink-0 rounded border px-1 text-[11px] leading-4 text-muted-foreground">
                            合并
                          </span>
                        </Tooltip>
                      )}
                      <span className="shrink-0 text-[11px] text-muted-foreground">
                        {c.author} · {formatRelative(c.ts * 1000)}
                      </span>
                    </button>
                  ))
                )}
                {repo.truncated && (
                  <p className="px-2 py-1 text-[11px] text-muted-foreground">只列出了最近的一部分提交</p>
                )}
              </div>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
};

// ---------------------------------------------------------------------
// 基线选择器（单仓时）
// ---------------------------------------------------------------------

const MAX_BASE_OPTIONS = 100;

const BasePicker = ({
  repo,
  chat,
  baseRef,
  onChange,
}: {
  repo: TaskRepoChanges;
  /** chat 会话没有「任务配置的线上分支」、会多一层常见分支名的兜底探测，文案要分开 */
  chat: boolean;
  baseRef: string | null;
  onChange: (baseRef: string | null) => void;
}) => {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  // 仅弹层打开时才去拉分支列表
  const branchMap = useRepoBranches(open ? [repo.repoPath] : []);
  const list = branchMap[repo.repoPath];

  const effective = baseRef ?? (repo.base?.kind === "merge-base" ? repo.base.label : null);
  const overrideFailed = !!repo.baseOverride && !repo.baseOverride.applied;
  const options = (list?.branches ?? [])
    .filter((b) => b.toLowerCase().includes(filter.trim().toLowerCase()))
    .slice(0, MAX_BASE_OPTIONS);

  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[11px] text-muted-foreground">对比</span>
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (next) setFilter("");
        }}
      >
        <Tooltip content="选一个分支作为对比基线（改动 = 当前提交相对它的分叉点）">
          <span className="inline-flex">
            <PopoverTrigger
              render={
                <button
                  type="button"
                  className="inline-flex h-6 max-w-56 cursor-pointer items-center gap-1 rounded-md border bg-muted/40 px-2 text-xs outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50"
                >
                  <GitBranch className="size-3 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 truncate font-mono">{effective ?? "自动"}</span>
                  {overrideFailed && <AlertTriangle className="size-3 shrink-0 text-warning" />}
                  <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
                </button>
              }
            />
          </span>
        </Tooltip>
        <PopoverContent align="start" className="w-72 p-2">
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="搜索分支"
            aria-label="搜索分支"
            className="h-7 text-xs md:text-xs"
          />
          <div className="mt-1.5 max-h-64 overflow-y-auto">
            <button
              type="button"
              onClick={() => {
                onChange(null);
                setOpen(false);
              }}
              className={cn(
                "flex w-full cursor-pointer flex-col rounded px-2 py-1 text-left text-xs hover:bg-muted",
                baseRef === null && "bg-muted",
              )}
            >
              <span>自动（推荐）</span>
              <span className="text-[11px] text-muted-foreground">
                {chat
                  ? "优先用已配置的线上分支，其次 origin/HEAD，都没有再试 main / master / develop 等常见分支"
                  : "优先用任务里配置的线上分支，其次 origin/HEAD"}
              </span>
            </button>
            {!list ? (
              <p className="px-2 py-2 text-xs text-muted-foreground">加载分支…</p>
            ) : !list.isRepo ? (
              <p className="px-2 py-2 text-xs text-muted-foreground">读不到分支列表</p>
            ) : options.length === 0 ? (
              <p className="px-2 py-2 text-xs text-muted-foreground">没有匹配的分支</p>
            ) : (
              options.map((b) => (
                <button
                  key={b}
                  type="button"
                  onClick={() => {
                    onChange(b);
                    setOpen(false);
                  }}
                  className={cn(
                    "flex w-full cursor-pointer items-center rounded px-2 py-1 text-left font-mono text-xs hover:bg-muted",
                    baseRef === b && "bg-muted",
                  )}
                >
                  <span className="min-w-0 truncate">{b}</span>
                </button>
              ))
            )}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
};

// ---------------------------------------------------------------------
// 快捷键帮助
// ---------------------------------------------------------------------

const HotkeyHelp = ({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) => (
  <Popover open={open} onOpenChange={onOpenChange}>
    <Tooltip
      content={
        <span className="flex items-center gap-1.5">
          快捷键
          <Kbd>?</Kbd>
        </span>
      }
    >
      <span className="inline-flex">
        <PopoverTrigger
          render={<Button type="button" variant="ghost" size="icon-xs" aria-label="快捷键" />}
        >
          <Keyboard />
        </PopoverTrigger>
      </span>
    </Tooltip>
    <PopoverContent align="end" className="w-80">
      <div className="mb-1.5 text-xs font-medium">快捷键</div>
      <ul className="space-y-1">
        {CHANGES_HOTKEY_HELP.map((row) => (
          <li key={row.label} className="flex items-center justify-between gap-3 text-xs">
            <span className="min-w-0 text-muted-foreground">{row.label}</span>
            <span className="flex shrink-0 items-center gap-1">
              {row.keys.map((k) => (
                <Kbd key={k}>{k}</Kbd>
              ))}
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-[11px] text-muted-foreground">
        点行号选一行、Shift+点行号选一段，可以直接引用到对话。焦点在输入框里时快捷键不生效。
      </p>
    </PopoverContent>
  </Popover>
);

// ---------------------------------------------------------------------
// 工具条
// ---------------------------------------------------------------------

export interface ScopeToolbarProps {
  taskId: string;
  /** chat 模式：基线探测链与 task 不同（见 BasePicker） */
  chat: boolean;
  repos: readonly TaskRepoChanges[];
  query: ChangesQuery;
  onScopeChange: (scope: TaskChangeScope) => void;
  onBaseRefChange: (baseRef: string | null) => void;
  prefs: DiffPrefs;
  onPrefsChange: (patch: Partial<DiffPrefs>) => void;
  loading: boolean;
  onRefresh: () => void;
  helpOpen: boolean;
  onHelpOpenChange: (open: boolean) => void;
}

export const ScopeToolbar = ({
  taskId,
  chat,
  repos,
  query,
  onScopeChange,
  onBaseRefChange,
  prefs,
  onPrefsChange,
  loading,
  onRefresh,
  helpOpen,
  onHelpOpenChange,
}: ScopeToolbarProps) => {
  const { scope } = query;
  // 手动基线只在「整条分支」范围、且只有一个仓时提供（多仓各自的线上分支名不一定相同）
  const baseRepo = scope.kind === "branch" && repos.length === 1 ? repos[0] : null;

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b px-3 py-1.5">
      <div className="flex items-center gap-1.5">
        <span className="text-[11px] text-muted-foreground">范围</span>
        <Segmented>
          <Tooltip content="相对线上分支分叉点的全部改动（已提交 + 未提交 + 新建文件）">
            <button
              type="button"
              aria-pressed={scope.kind === "branch"}
              onClick={() => onScopeChange({ kind: "branch" })}
              className={segmentClass(scope.kind === "branch")}
            >
              整条分支
            </button>
          </Tooltip>
          <Tooltip content="只看还没提交的改动（相对 HEAD，含新建文件）——刚改的这一点">
            <button
              type="button"
              aria-pressed={scope.kind === "uncommitted"}
              onClick={() => onScopeChange({ kind: "uncommitted" })}
              className={segmentClass(scope.kind === "uncommitted")}
            >
              仅未提交
            </button>
          </Tooltip>
          <CommitPicker
            taskId={taskId}
            baseRef={query.baseRef}
            scope={scope}
            onSelect={(sha) => onScopeChange({ kind: "commit", sha })}
          />
        </Segmented>
      </div>

      {baseRepo && (
        <BasePicker repo={baseRepo} chat={chat} baseRef={query.baseRef} onChange={onBaseRefChange} />
      )}

      <div className="ml-auto flex items-center gap-0.5">
        <ToolbarButton
          label="忽略空白差异"
          hotkey="w"
          active={prefs.ignoreWs}
          onClick={() => onPrefsChange({ ignoreWs: !prefs.ignoreWs })}
        >
          <Space />
        </ToolbarButton>
        <Segmented>
          <ToolbarButton
            label="统一视图"
            hotkey="s"
            active={prefs.view === "unified"}
            onClick={() => onPrefsChange({ view: "unified" })}
          >
            <Rows2 />
          </ToolbarButton>
          <ToolbarButton
            label="分栏视图（窗口太窄会自动用统一视图）"
            hotkey="s"
            active={prefs.view === "split"}
            onClick={() => onPrefsChange({ view: "split" })}
          >
            <Columns2 />
          </ToolbarButton>
        </Segmented>
        <Segmented>
          <ToolbarButton
            label="目录树"
            active={prefs.treeMode === "tree"}
            onClick={() => onPrefsChange({ treeMode: "tree" })}
          >
            <ListTree />
          </ToolbarButton>
          <ToolbarButton
            label="平铺列表"
            active={prefs.treeMode === "flat"}
            onClick={() => onPrefsChange({ treeMode: "flat" })}
          >
            <List />
          </ToolbarButton>
        </Segmented>
        <ToolbarButton
          label={prefs.treeHidden ? "显示文件栏" : "隐藏文件栏"}
          hotkey="t"
          onClick={() => onPrefsChange({ treeHidden: !prefs.treeHidden })}
        >
          {prefs.treeHidden ? <PanelLeftOpen /> : <PanelLeftClose />}
        </ToolbarButton>
        <ToolbarButton
          label={prefs.wide ? "还原面板宽度" : "加宽面板"}
          hotkey="f"
          onClick={() => onPrefsChange({ wide: !prefs.wide })}
        >
          {prefs.wide ? <Minimize2 /> : <Maximize2 />}
        </ToolbarButton>
        <HotkeyHelp open={helpOpen} onOpenChange={onHelpOpenChange} />
        <ToolbarButton label="刷新" disabled={loading} onClick={onRefresh}>
          {loading ? <Loader2 className="animate-spin motion-reduce:animate-none" /> : <RefreshCw />}
        </ToolbarButton>
      </div>
    </div>
  );
};
