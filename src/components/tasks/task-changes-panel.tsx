"use client";

/**
 * 任务「代码改动」预览（task 模式）：看这个任务到现在改了什么、代码有没有问题，不用再开 IDE。
 *
 * - 入口：task 头部 chip 行里的「改动 N +a −r」小按钮（数字随 agent 运行实时涨）
 * - 面板：右侧非模态 Sheet（边看任务边看 diff），左边按仓分组的文件清单、右边选中文件的 diff
 * - 基线：HEAD 与线上分支的分叉点（见 server/task-changes.ts）；面板里每个仓都标明「相对谁」
 *   非隔离任务（直接在原仓）同理：当前在哪个分支就展示哪个分支的整体改动，不另存快照
 * - 只读预览：不提供暂存 / 提交 / 回滚；想深看点文件路径或新行号跳 IDE
 *
 * 清单（轻）在 useTaskChanges 里轮询；单文件 diff 选中才拉、并缓存。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, FileDiff, Loader2, RefreshCw } from "lucide-react";

import { InlineDiff } from "@/components/tasks/event-stream/tool-block";
import { Button } from "@/components/ui/button";
import { EmptyHint } from "@/components/ui/empty-hint";
import { IdePathLink, useIdePathLinker } from "@/components/ui/ide-path-link";
import { LoadingState } from "@/components/ui/loading-state";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Tooltip } from "@/components/ui/tooltip";
import { useTaskChanges } from "@/hooks/use-task-changes";
import { fetchTaskChangeFileDiff } from "@/lib/task-store";
import type {
  Task,
  TaskChangeFile,
  TaskChangeFileDiff,
  TaskChangeStatus,
  TaskRepoChanges,
  TaskRepoChangesUnavailable,
} from "@/lib/types";
import { cn } from "@/lib/utils";

interface Props {
  task: Task;
}

const STATUS_META: Record<
  TaskChangeStatus,
  { letter: string; label: string; cls: string }
> = {
  added: { letter: "A", label: "新增", cls: "bg-success/15 text-success" },
  modified: { letter: "M", label: "修改", cls: "bg-warning/15 text-warning" },
  deleted: {
    letter: "D",
    label: "删除",
    cls: "bg-destructive/15 text-destructive",
  },
  renamed: { letter: "R", label: "重命名", cls: "bg-info/15 text-info" },
};

const UNAVAILABLE_TEXT: Record<TaskRepoChangesUnavailable, string> = {
  dir_missing: "工作区目录不存在（任务还没启动，或工作区已清理）",
  not_git: "该目录不是 git 仓库",
  no_head: "仓库还没有任何提交",
  git_error: "读取改动失败",
};

/** 一个文件在面板里的唯一标识（跨仓不撞） */
const entryKey = (repoPath: string, filePath: string) =>
  `${repoPath}\u0000${filePath}`;

/** 缓存 / 重拉用的签名：文件的增删统计变了就当作「改过」 */
const diffSignature = (repoPath: string, f: TaskChangeFile) =>
  `${entryKey(repoPath, f.path)}\u0000${f.status}:${f.added}:${f.removed}:${f.untracked ? 1 : 0}`;

const StatusBadge = ({ status }: { status: TaskChangeStatus }) => {
  const meta = STATUS_META[status];
  return (
    <Tooltip content={meta.label}>
      <span
        className={cn(
          "inline-flex size-4 shrink-0 items-center justify-center rounded-sm font-mono text-[11px] leading-none font-medium",
          meta.cls,
        )}
      >
        {meta.letter}
      </span>
    </Tooltip>
  );
};

const LineStat = ({
  added,
  removed,
  className,
}: {
  added: number | null;
  removed: number | null;
  className?: string;
}) => {
  // 二进制 / 过大未统计：没有数字可显示
  if (added == null && removed == null) return null;
  return (
    <span className={cn("shrink-0 tabular-nums", className)}>
      {added != null && added > 0 && <span className="text-success">+{added}</span>}
      {removed != null && removed > 0 && (
        <span className={cn("text-destructive", added ? "ml-1" : "")}>
          −{removed}
        </span>
      )}
    </span>
  );
};

const splitPath = (p: string): { dir: string; name: string } => {
  const idx = p.lastIndexOf("/");
  return idx < 0
    ? { dir: "", name: p }
    : { dir: p.slice(0, idx + 1), name: p.slice(idx + 1) };
};

const FileRow = ({
  file,
  selected,
  onSelect,
}: {
  file: TaskChangeFile;
  selected: boolean;
  onSelect: () => void;
}) => {
  const { dir, name } = splitPath(file.path);
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex w-full min-w-0 cursor-pointer items-center gap-1.5 px-2 py-1 text-left text-xs hover:bg-muted/60",
        selected && "bg-muted",
      )}
    >
      <StatusBadge status={file.status} />
      <span className="flex min-w-0 flex-1 items-baseline">
        <span className="shrink-0 truncate font-mono font-medium text-foreground">
          {name}
        </span>
        {dir && (
          <span className="ml-1.5 min-w-0 truncate font-mono text-[11px] text-muted-foreground">
            {dir}
          </span>
        )}
      </span>
      {file.binary ? (
        <span className="shrink-0 text-[11px] text-muted-foreground">二进制</span>
      ) : (
        <LineStat added={file.added} removed={file.removed} className="text-[11px]" />
      )}
    </button>
  );
};

/**
 * 仓头部补充说明（只在需要解释「这些改动是什么范围」时出现）：
 * - 当前就在线上分支本身：没有分支上的提交可看、只剩未提交 / 未推送的
 * - 非隔离（直接在原仓）+ 找到线上分支：中性说明——看到的是当前分支的整体改动、不只是本任务的增量
 * - 非隔离 + 降级成 HEAD：基线说不清、保留黄色警告（隔离任务的 HEAD 降级已由基线行说明）
 */
const RepoScopeNote = ({ repo }: { repo: TaskRepoChanges }) => {
  if (repo.unavailable || !repo.base) return null;
  if (repo.onBaseBranch) {
    return (
      <div className="mt-0.5 text-[11px] text-muted-foreground">
        当前就在线上分支 {repo.branch} 上，只显示未提交或未推送的改动
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
    <div className="mt-0.5 text-[11px] text-muted-foreground">
      任务直接在原仓库工作：显示{repo.branch ? "当前分支" : "当前检出提交"}
      的整体改动，含任务开始前已有的提交和未提交内容
    </div>
  );
};

const RepoHeader = ({ repo }: { repo: TaskRepoChanges }) => (
  <div className="sticky top-0 z-10 border-b bg-background/95 px-2 py-1.5 backdrop-blur-sm">
    <div className="flex min-w-0 items-center gap-1.5 text-xs">
      <span className="min-w-0 truncate font-medium">{repo.shortName}</span>
      {repo.branch ? (
        <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">
          {repo.branch}
        </span>
      ) : (
        !repo.unavailable && (
          <Tooltip content="当前不在任何分支上（detached HEAD）">
            <span className="shrink-0 text-[11px] text-muted-foreground">
              游离 HEAD
            </span>
          </Tooltip>
        )
      )}
    </div>
    {repo.base && (
      <div className="mt-0.5 text-[11px] text-muted-foreground">
        {repo.base.kind === "merge-base"
          ? `相对 ${repo.base.label} 的分叉点（${repo.base.shortSha}）`
          : "相对 HEAD · 未找到线上分支，只含未提交的改动"}
      </div>
    )}
    <RepoScopeNote repo={repo} />
  </div>
);

type DiffState =
  | { key: string; status: "loading" }
  | { key: string; status: "error"; message: string }
  | { key: string; status: "ok"; data: TaskChangeFileDiff };

const DiffBody = ({
  state,
  file,
}: {
  state: DiffState | null;
  file: TaskChangeFile;
}) => {
  const linker = useIdePathLinker();
  if (!state || state.status === "loading") {
    return <LoadingState variant="inline" label="加载 diff…" className="block py-6 text-center" />;
  }
  if (state.status === "error") {
    return (
      <EmptyHint variant="dashed" align="center" size="md" className="mt-3">
        加载 diff 失败：{state.message}
      </EmptyHint>
    );
  }
  const { data } = state;
  if (data.binary) {
    return (
      <EmptyHint variant="dashed" align="center" size="md" className="mt-3">
        二进制文件，不显示 diff
      </EmptyHint>
    );
  }
  if (data.tooLarge) {
    return (
      <EmptyHint variant="dashed" align="center" size="md" className="mt-3">
        改动太大，这里不展示——请点上方文件路径在 IDE 里查看
      </EmptyHint>
    );
  }
  // 没有任何 hunk：空文件 / 只改了权限等
  if (!data.diff || !/^@@/m.test(data.diff)) {
    return (
      <EmptyHint variant="dashed" align="center" size="md" className="mt-3">
        {file.untracked ? "新建的空文件" : "没有可显示的文本差异（可能只改了权限或为空文件）"}
      </EmptyHint>
    );
  }
  return (
    <InlineDiff
      diff={data.diff}
      truncated={data.truncated}
      linker={linker}
      // 已删除文件不在盘上、新行号跳转必偏 → 不传
      filePath={file.status === "deleted" ? null : file.absolutePath}
      className="mt-0"
      scrollClassName="max-h-none"
    />
  );
};

export const TaskChangesPanel = ({ task }: Props) => {
  const enabled =
    task.mode !== "chat" && !!task.workCwd && task.repoPaths.length > 0;
  const running = task.runStatus === "running";
  const [open, setOpen] = useState(false);
  const { data, error, loading, updatedAt, refresh } = useTaskChanges({
    taskId: task.id,
    enabled,
    running,
    open,
  });
  const linker = useIdePathLinker();

  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [diffState, setDiffState] = useState<DiffState | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  // 浏览过的文件 diff 缓存（key 带增删统计签名）；上限兜底防无限涨
  const cacheRef = useRef(new Map<string, TaskChangeFileDiff>());

  // 平铺全部文件（含所属仓），选中项缺省 / 失效时落到第一个
  const entries = useMemo(
    () =>
      (data?.repos ?? []).flatMap((repo) =>
        repo.unavailable
          ? []
          : repo.files.map((file) => ({
              repoPath: repo.repoPath,
              file,
              key: entryKey(repo.repoPath, file.path),
            })),
      ),
    [data],
  );
  const selected = entries.find((e) => e.key === selectedKey) ?? entries[0] ?? null;

  // 选中文件的原始值（作 effect 依赖、避免对象引用抖动）
  const selSig = selected ? diffSignature(selected.repoPath, selected.file) : null;
  const selRepoPath = selected?.repoPath ?? null;
  const selPath = selected?.file.path ?? null;
  const selOldPath = selected?.file.oldPath ?? null;

  useEffect(() => {
    if (!open || !selSig || !selRepoPath || !selPath) return;
    // 运行中文件可能还在被改：不信缓存、每次清单刷新都静默重拉
    const cached = running ? undefined : cacheRef.current.get(selSig);
    if (cached) {
      setDiffState({ key: selSig, status: "ok", data: cached });
      return;
    }
    let cancelled = false;
    // 已有同一文件的内容时保留旧内容（静默刷新不闪 loading）
    setDiffState((prev) =>
      prev && prev.key === selSig && prev.status === "ok"
        ? prev
        : { key: selSig, status: "loading" },
    );
    fetchTaskChangeFileDiff(task.id, {
      repoPath: selRepoPath,
      path: selPath,
      ...(selOldPath ? { oldPath: selOldPath } : {}),
    })
      .then((fileDiff) => {
        if (cancelled) return;
        if (cacheRef.current.size >= 50) cacheRef.current.clear();
        cacheRef.current.set(selSig, fileDiff);
        setDiffState({ key: selSig, status: "ok", data: fileDiff });
      })
      .catch((err) => {
        if (cancelled) return;
        setDiffState({
          key: selSig,
          status: "error",
          message: err instanceof Error ? err.message : "未知错误",
        });
      });
    return () => {
      cancelled = true;
    };
  }, [open, task.id, selSig, selRepoPath, selPath, selOldPath, running, updatedAt, retryNonce]);

  // 没有可看改动的任务（chat / 未启动 / 全是非 git·只读仓）：不挂入口。
  // 首次数据没回来前也不渲染，避免 chip 闪一下又消失
  if (!enabled || !data || data.repos.length === 0) return null;

  const { totals } = data;
  const handleRefresh = () => {
    cacheRef.current.clear();
    setRetryNonce((n) => n + 1);
    void refresh();
  };
  const currentDiff = diffState && selSig && diffState.key === selSig ? diffState : null;

  return (
    <>
      <Tooltip content="查看本任务相对线上分支的全部代码改动">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setOpen(true)}
        >
          <FileDiff />
          改动
          {totals.files > 0 && (
            <span className="ml-1 inline-flex items-center gap-1.5 rounded-sm bg-muted px-1.5 py-0.5 text-[11px] tabular-nums text-muted-foreground">
              <span>{totals.files}</span>
              <span className="text-success">+{totals.added}</span>
              <span className="text-destructive">−{totals.removed}</span>
            </span>
          )}
        </Button>
      </Tooltip>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent className="w-[min(1040px,88vw)] max-w-none">
          <SheetHeader>
            <SheetTitle>代码改动</SheetTitle>
            <SheetDescription>
              {totals.files > 0
                ? `${totals.files} 个文件 · +${totals.added} −${totals.removed}`
                : "相对基线暂无改动"}
              {running && " · 运行中，自动刷新"}
            </SheetDescription>
          </SheetHeader>

          <div className="flex min-h-0 flex-1">
            {/* 左：按仓分组的文件清单 */}
            <aside className="flex w-72 shrink-0 flex-col border-r">
              <div className="flex shrink-0 items-center justify-between border-b px-2 py-1">
                <span className="text-[11px] text-muted-foreground">文件</span>
                <Tooltip content="刷新">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    onClick={handleRefresh}
                    disabled={loading}
                  >
                    {loading ? (
                      <Loader2 className="animate-spin" />
                    ) : (
                      <RefreshCw />
                    )}
                  </Button>
                </Tooltip>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto">
                {error && (
                  <div className="border-b px-2 py-1.5 text-[11px] text-destructive">
                    刷新失败：{error}
                  </div>
                )}
                {data.repos.map((repo) => (
                  <div key={repo.repoPath}>
                    <RepoHeader repo={repo} />
                    {repo.unavailable ? (
                      <p className="px-2 py-3 text-xs text-muted-foreground">
                        {UNAVAILABLE_TEXT[repo.unavailable]}
                      </p>
                    ) : repo.files.length === 0 ? (
                      <p className="px-2 py-3 text-xs text-muted-foreground">
                        暂无改动
                      </p>
                    ) : (
                      repo.files.map((file) => {
                        const key = entryKey(repo.repoPath, file.path);
                        return (
                          <FileRow
                            key={key}
                            file={file}
                            selected={selected?.key === key}
                            onSelect={() => setSelectedKey(key)}
                          />
                        );
                      })
                    )}
                    {repo.filesTruncated && (
                      <p className="px-2 py-1.5 text-[11px] text-warning">
                        改动文件太多，仅列出前 {repo.files.length} 个（共 {repo.totals.files} 个）
                      </p>
                    )}
                    {repo.untrackedSkipped && (
                      <p className="px-2 py-1.5 text-[11px] text-warning">
                        新建文件清单读取失败，可能没列全
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </aside>

            {/* 右：选中文件的 diff */}
            <section className="flex min-w-0 flex-1 flex-col">
              {selected ? (
                <>
                  <div className="flex shrink-0 items-center gap-2 border-b px-3 py-1.5 text-xs">
                    <StatusBadge status={selected.file.status} />
                    <span className="min-w-0 flex-1 truncate font-mono">
                      {selected.file.status === "deleted" ? (
                        selected.file.path
                      ) : (
                        <IdePathLink
                          linker={linker}
                          path={selected.file.absolutePath}
                        >
                          {selected.file.path}
                        </IdePathLink>
                      )}
                      {selected.file.oldPath && (
                        <span className="ml-2 text-muted-foreground">
                          ← {selected.file.oldPath}
                        </span>
                      )}
                    </span>
                    <LineStat
                      added={selected.file.added}
                      removed={selected.file.removed}
                    />
                  </div>
                  <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3 pt-2">
                    <DiffBody state={currentDiff} file={selected.file} />
                  </div>
                </>
              ) : (
                <div className="flex flex-1 items-center justify-center p-6">
                  <EmptyHint variant="dashed" align="center" size="lg">
                    {totals.files === 0
                      ? "相对基线还没有改动"
                      : "从左侧选一个文件查看 diff"}
                  </EmptyHint>
                </div>
              )}
            </section>
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
};
