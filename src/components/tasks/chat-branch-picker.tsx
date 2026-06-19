"use client";

/**
 * ChatBranchPicker：chat 工作目录是 git 仓时的「切分支」入口（V0.8）
 *
 * 放 textarea 上方一行、跟工作目录选择器并排。仅当工作目录（task.repoPaths[0]）是 git 仓时才显示——
 * 拉本地分支列表、点选即 git checkout。对齐 codex / Cursor：cwd + branch 两个独立指示器。
 *
 * 分支多 / 名字长（V0.8.x 用户反馈）：popover 顶部带搜索框过滤、列表项完整显示不截断（长名换行）。
 *
 * 硬约束：running 时禁用（agent 正用这个 cwd 跑、切分支扰乱工作区、后端也会 409 兜底）。
 * 切分支不改 task 字段、只动 git 工作区、组件内部维护当前分支 state。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, GitBranch, Loader2, Search } from "lucide-react";
import { toast } from "sonner";

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { checkoutTaskBranch, fetchTaskBranches } from "@/lib/task-store";
import type { GitBranchState, Task } from "@/lib/types";
import { cn } from "@/lib/utils";

interface Props {
  task: Task;
}

export const ChatBranchPicker = ({ task }: Props) => {
  // 工作目录的 git 分支状态（null = 还没拉 / 无目录 / 拉失败）
  const [state, setState] = useState<GitBranchState | null>(null);
  // popover 开关
  const [open, setOpen] = useState(false);
  // checkout 飞行中：防连点
  const [saving, setSaving] = useState(false);
  // 分支搜索词（分支多时过滤）
  const [query, setQuery] = useState("");
  // 搜索框 ref：popover 打开时自动聚焦、可直接敲字过滤
  const searchRef = useRef<HTMLInputElement>(null);

  // chat 工作目录（只绑单个；空 = 没绑、没分支概念）
  const dir = task.repoPaths[0] ?? "";
  const running = task.runStatus === "running";

  // 工作目录变化时重新拉分支状态（best-effort、失败静默置空 = 不显示选择器）
  useEffect(() => {
    let alive = true;
    if (!dir) {
      setState(null);
      return;
    }
    void fetchTaskBranches(task.id)
      .then((s) => {
        if (alive) setState(s);
      })
      .catch(() => {
        if (alive) setState(null);
      });
    return () => {
      alive = false;
    };
  }, [task.id, dir]);

  // 按搜索词过滤分支（大小写不敏感）；hook 必须在 early-return 前调用、故 state 用可选链兜底
  const filtered = useMemo(() => {
    const all = state?.branches ?? [];
    const q = query.trim().toLowerCase();
    return q ? all.filter((b) => b.toLowerCase().includes(q)) : all;
  }, [state?.branches, query]);

  // 切分支：checkout → 用返回的最新状态刷新（current 变）
  const handleCheckout = async (branch: string) => {
    if (branch === state?.current) {
      setOpen(false);
      return;
    }
    setSaving(true);
    try {
      const next = await checkoutTaskBranch(task.id, branch);
      setState(next);
      setOpen(false);
      toast.success(`已切到分支 ${branch}`);
    } catch (err) {
      toast.error(`切分支失败：${(err as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  // 打开时清空搜索 + 聚焦搜索框（portal 渲染后下一帧再 focus、直接 focus 拿不到节点）
  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) {
      setQuery("");
      requestAnimationFrame(() => searchRef.current?.focus());
    }
  };

  // 非 git 仓 / 没拉到 → 不显示（cwd 不是仓库时本来就没分支概念）
  if (!state?.isRepo) return null;

  const label = state.current ?? "(游离 HEAD)";

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger
        render={
          <button
            type="button"
            disabled={running || saving}
            title={`当前分支：${label}`}
            // 视觉对齐 ModelSelect compact / 工作目录选择器、三者并排齐平
            className={cn(
              "flex h-7 max-w-56 items-center gap-1.5 rounded-lg border border-input bg-transparent px-2.5 text-xs outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30 dark:hover:bg-input/50",
            )}
          >
            {saving ? (
              <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
            ) : (
              <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
            )}
            <span className="min-w-0 flex-1 truncate text-left">{label}</span>
            <ChevronDown className="pointer-events-none size-3.5 shrink-0 text-muted-foreground" />
          </button>
        }
      />
      <PopoverContent align="start" sideOffset={6} className="w-80 p-0">
        {/* 搜索框：分支多时实时过滤 */}
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
        <div className="px-2.5 pb-0.5 pt-1.5 text-[11px] text-muted-foreground">
          切换分支（git checkout）
        </div>
        <ul className="max-h-72 overflow-y-auto p-1">
          {filtered.length === 0 ? (
            <li className="px-2 py-6 text-center text-xs text-muted-foreground">
              没有匹配「{query}」的分支
            </li>
          ) : (
            filtered.map((b) => {
              const selected = b === state.current;
              return (
                <li key={b}>
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => void handleCheckout(b)}
                    className={cn(
                      "flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50",
                      selected && "bg-accent/40",
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
      </PopoverContent>
    </Popover>
  );
};
