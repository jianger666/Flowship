"use client";

/**
 * BranchSwitcher：统一的分支指示 + 切换下拉（2026-08，由 ChatBranchPicker /
 * RepoBranchSwitch 合并而来）
 *
 * 两种形态：
 * - variant="select"：chat 输入条上方的下拉按钮（GitBranch 图标 + 当前分支 + 箭头、
 *   边框 select 样式）；仅当工作目录确认是 git 仓才显示
 * - variant="chip"：task 项目卡片内的轻量 chip（图标 + 等宽分支名、无边框）
 *
 * 两种模式：
 * - 不传 repoPath = chat 单仓（repoPaths[0]、无 worktree 概念、非 git 仓隐藏）
 * - 传 repoPath = task 按仓（worktree 感知；worktree 未建好时弹层只提示、禁切）
 *
 * 弹层：可选顶部警告（warning prop）+ 搜索 + 分支列表 + checkout。
 * 约束：running 时禁用（后端也会 409 兜底）；切分支不改 task 字段、只动 git 工作区。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  GitBranch,
  Loader2,
  Search,
} from "lucide-react";
import { toast } from "sonner";

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Tooltip } from "@/components/ui/tooltip";
import { checkoutTaskBranch, fetchTaskBranches } from "@/lib/task-store";
import { isTestingRequirementTask } from "@/lib/testing-task";
import type { GitBranchState, Task } from "@/lib/types";
import { cn } from "@/lib/utils";

interface Props {
  task: Task;
  /** 缺省 = chat 单仓（repoPaths[0]）；传值 = task 按仓切换 */
  repoPath?: string;
  variant: "select" | "chip";
  /** 弹层顶部警告（如「切到非任务相关分支…」）；空 = 不显示 */
  warning?: string;
}

/** 未拉取前先用 task 记录的静态分支兜底（gitBranches 优先、测试任务用 repoFeatureBranches） */
const staticBranchOf = (task: Task, repoPath: string): string | null => {
  const norm = (s: string) => s.replace(/\/+$/, "");
  const git = task.gitBranches?.find(
    (b) => norm(b.repoPath) === norm(repoPath),
  );
  if (git?.name) return git.name;
  if (isTestingRequirementTask(task)) {
    const feature = task.repoFeatureBranches?.[repoPath]?.trim();
    if (feature) return feature;
  }
  return null;
};

export const BranchSwitcher = ({ task, repoPath, variant, warning }: Props) => {
  const [state, setState] = useState<GitBranchState | null>(null);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  const running = task.runStatus === "running";
  // task 隔离 worktree 未建好：只读提示、禁止切换
  const worktreeMissing = state?.worktreeMissing === true;
  // 拉取前 / 拉取失败时的展示兜底（chip 形态用；select 只在确认是 git 仓后显示）
  const fallback = repoPath ? staticBranchOf(task, repoPath) : null;

  useEffect(() => {
    let alive = true;
    setState(null);
    void fetchTaskBranches(task.id, repoPath)
      .then((s) => {
        if (alive) setState(s);
      })
      .catch(() => {
        if (alive) setState(null);
      });
    return () => {
      alive = false;
    };
  }, [task.id, repoPath]);

  const filtered = useMemo(() => {
    const all = state?.branches ?? [];
    const q = query.trim().toLowerCase();
    return q ? all.filter((b) => b.toLowerCase().includes(q)) : all;
  }, [state?.branches, query]);

  // select（chat）：确认是 git 仓才显示；chip（task）：有静态兜底时也显示（如 worktree 未建）
  if (variant === "select" ? !state?.isRepo : state && !state.isRepo && !fallback) {
    return null;
  }

  const label = state?.current ?? fallback ?? "(游离 HEAD)";

  const handleCheckout = async (branch: string) => {
    if (branch === state?.current) {
      setOpen(false);
      return;
    }
    setSaving(true);
    try {
      const next = await checkoutTaskBranch(task.id, branch, repoPath);
      setState(next);
      setOpen(false);
      toast.success(`已切到分支 ${branch}`);
    } catch (err) {
      toast.error(`切分支失败：${(err as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) {
      setQuery("");
      requestAnimationFrame(() => searchRef.current?.focus());
    }
  };

  const tooltip =
    variant === "select"
      ? `当前分支：${label}`
      : running
        ? "agent 运行中、停下才能切分支"
        : label;

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      {/* PopoverTrigger.render 必须是可交互 DOM；Tooltip 包外层 span（同 combobox / 收件箱坑） */}
      <Tooltip content={tooltip}>
        <span className="inline-flex min-w-0">
          <PopoverTrigger
            render={
              <button
                type="button"
                disabled={running || saving}
                className={cn(
                  variant === "select"
                    ? "flex h-7 max-w-56 items-center gap-1.5 rounded-lg border border-input bg-transparent px-2.5 text-xs outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30 dark:hover:bg-input/50"
                    : "inline-flex max-w-36 shrink-0 items-center gap-1 rounded px-1 py-0.5 text-[11px] text-muted-foreground outline-none transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:bg-muted/50 focus-visible:text-foreground disabled:cursor-not-allowed disabled:opacity-50",
                )}
              >
                {saving ? (
                  <Loader2
                    className={cn(
                      "shrink-0 animate-spin",
                      variant === "select" ? "size-3.5" : "size-3",
                    )}
                  />
                ) : (
                  <GitBranch
                    className={cn(
                      "shrink-0 text-muted-foreground",
                      variant === "select" ? "size-3.5" : "size-3",
                    )}
                  />
                )}
                <span
                  className={cn(
                    "min-w-0 truncate font-mono",
                    variant === "select" && "flex-1 text-left",
                  )}
                >
                  {label}
                </span>
                {variant === "select" && (
                  <ChevronDown className="pointer-events-none size-3.5 shrink-0 text-muted-foreground" />
                )}
              </button>
            }
          />
        </span>
      </Tooltip>
      <PopoverContent align="start" sideOffset={6} className="w-80 p-0">
        {worktreeMissing ? (
          <div className="flex items-start gap-1.5 px-2.5 py-3 text-[11px] leading-relaxed text-muted-foreground">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-600" />
            <span>worktree 尚未就绪，暂不能切换分支。</span>
          </div>
        ) : (
          <>
            {/* 切换前警告（可选） */}
            {warning && (
              <div className="flex items-start gap-1.5 border-b border-amber-200 bg-amber-50 px-2.5 py-2 text-[11px] leading-relaxed text-amber-800">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                <span>{warning}</span>
              </div>
            )}
            <div className="flex items-center gap-2 border-b px-2.5 py-2">
              <Search className="size-3.5 shrink-0 text-muted-foreground" />
              <input
                ref={searchRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜索分支…"
                className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
              />
            </div>
            <ul className="max-h-72 overflow-y-auto p-1">
              {filtered.length === 0 ? (
                <li className="px-2 py-6 text-center text-xs text-muted-foreground">
                  没有匹配「{query}」的分支
                </li>
              ) : (
                filtered.map((b) => {
                  const selected = b === state?.current;
                  return (
                    <li key={b}>
                      <button
                        type="button"
                        disabled={saving}
                        onClick={() => void handleCheckout(b)}
                        className={cn(
                          "flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50",
                          selected && "bg-selected text-selected-foreground",
                        )}
                      >
                        <Check
                          className={cn(
                            "mt-0.5 size-3.5 shrink-0",
                            selected ? "opacity-100" : "opacity-0",
                          )}
                        />
                        <span className="min-w-0 flex-1 wrap-anywhere font-mono">
                          {b}
                        </span>
                      </button>
                    </li>
                  );
                })
              )}
            </ul>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
};
