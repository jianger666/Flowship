"use client";

/**
 * 工具块 UI（Phase 1）：running→completed 合并渲染 + GB 折叠规则 + inline diff
 *
 * 视觉：图标 + 名称 + 摘要一行；展开区缩进 + 左边线；token 用 muted/border。
 * Chat 打磨：shell 默认折叠、摘要绝不 dump args JSON；运行中直播输出、完成后收起。
 */

import { memo, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronRight,
  Copy,
  FileCode2,
  Loader2,
  Terminal,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import {
  countDiffStats,
  toolBlockDefaultCollapsed,
  toolBlockDetailLine,
  toolBlockSummary,
  verbGroupLabel,
  type ToolBlock,
  type ToolVerbGroup,
} from "@/lib/tool-display";
import { formatTs } from "./utils";

// ---------- 轻量 unified diff（不引新依赖；±3 上下文由 SDK diffString 自带）----------

const DiffLine = ({ line }: { line: string }) => {
  const isAdd = line.startsWith("+") && !line.startsWith("+++");
  const isDel = line.startsWith("-") && !line.startsWith("---");
  const isHunk = line.startsWith("@@");
  return (
    <div
      className={cn(
        "whitespace-pre-wrap break-all px-2 py-px font-mono text-[11px] leading-relaxed",
        isAdd && "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
        isDel && "bg-red-500/10 text-red-700 dark:text-red-400",
        isHunk && "bg-muted/50 text-muted-foreground",
        !isAdd && !isDel && !isHunk && "text-muted-foreground",
      )}
    >
      {line || " "}
    </div>
  );
};

const InlineDiff = ({
  diff,
  truncated,
}: {
  diff: string;
  truncated?: boolean;
}) => {
  const lines = useMemo(() => diff.split("\n"), [diff]);
  return (
    <div className="mt-1.5 max-h-64 overflow-y-auto rounded-md border border-border/60 bg-muted/20">
      {lines.map((line, i) => (
        <DiffLine key={i} line={line} />
      ))}
      {truncated && (
        <div className="border-t border-border/50 px-2 py-1 text-[10px] text-muted-foreground">
          diff 已截断
        </div>
      )}
    </div>
  );
};

// ---------- 完整输出 Dialog ----------

const FullOutputDialog = ({
  open,
  onOpenChange,
  taskId,
  callId,
  title,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  taskId: string;
  callId: string;
  title: string;
}) => {
  // loading / 正文 / 错误——Dialog 打开才拉
  const [loading, setLoading] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setText("");
    void (async () => {
      try {
        const res = await fetch(
          `/api/tasks/${encodeURIComponent(taskId)}/tool-output/${encodeURIComponent(callId)}`,
        );
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          const msg =
            typeof body === "object" && body && "error" in body
              ? String((body as { error: unknown }).error)
              : `HTTP ${res.status}`;
          throw new Error(msg === "not_found" ? "完整输出不存在" : msg);
        }
        const body = await res.text();
        if (!cancelled) setText(body);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, taskId, callId]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success("已复制");
    } catch {
      toast.error("复制失败");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="min-w-0 truncate font-mono text-sm">
            {title}
          </DialogTitle>
        </DialogHeader>
        <div className="max-h-[60vh] min-h-[8rem] overflow-y-auto rounded-md border bg-muted/30 p-3">
          {loading ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              加载中…
            </div>
          ) : error ? (
            <div className="text-xs text-destructive">{error}</div>
          ) : (
            <pre className="whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-foreground">
              {text || "（空）"}
            </pre>
          )}
        </div>
        <DialogFooter className="mx-0 mb-0 gap-2 sm:justify-end">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!text || loading}
            onClick={() => void handleCopy()}
          >
            <Copy className="size-3.5" />
            复制
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onOpenChange(false)}
          >
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

// ---------- chevron：统一旋转动效 ----------

const CollapseChevron = ({ open }: { open: boolean }) => (
  <ChevronRight
    className={cn(
      "size-3 shrink-0 opacity-50 transition-transform duration-150",
      open && "rotate-90",
    )}
  />
);

// ---------- 单工具块 ----------

const ToolBlockIcon = ({
  block,
}: {
  block: ToolBlock;
}) => {
  if (block.status === "running") {
    return <Loader2 className="size-3.5 shrink-0 animate-spin text-blue-500" />;
  }
  if (block.status === "error") {
    return <X className="size-3.5 shrink-0 text-destructive" />;
  }
  if (block.name.toLowerCase() === "shell") {
    return <Terminal className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />;
  }
  if (
    block.name.toLowerCase() === "edit" ||
    block.name.toLowerCase() === "write"
  ) {
    return <FileCode2 className="size-3.5 shrink-0 text-amber-600 dark:text-amber-400" />;
  }
  return <Check className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />;
};

const formatDuration = (ms?: number): string | null => {
  if (ms == null || !Number.isFinite(ms)) return null;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
};

interface ToolBlockRowProps {
  block: ToolBlock;
  taskId: string;
  /** shell 流式实时输出（仅 running；完成后被 result.output 替换） */
  liveOutput?: string;
  /** verb group 内成员：强制更紧凑、默认折叠 */
  nested?: boolean;
}

const ToolBlockRowImpl = ({
  block,
  taskId,
  liveOutput,
  nested = false,
}: ToolBlockRowProps) => {
  // GB：读/搜/shell 默认折叠；edit/write 默认展开看 diff
  const [collapsed, setCollapsed] = useState(() =>
    toolBlockDefaultCollapsed(block.name, nested),
  );
  // 第二层：完整 output（默认折叠；展开一层只看摘要/命令）
  const [outputOpen, setOutputOpen] = useState(false);
  // edit diff：默认展开（collapsed_edit_blocks=OFF）
  const [diffCollapsed, setDiffCollapsed] = useState(false);
  const [fullOpen, setFullOpen] = useState(false);

  // 原「运行中自动展开、完成自动收起」已删（2026-07-20 用户实测「图标像反了」）：
  // running 强制展开（v）但 task 子代理等工具展开区无内容、空撑一块；完成行反而
  // 折叠（>）带摘要——观感颠倒。折叠行内 liveTail 实时滚动已够看，想看全点开即可。

  const summary = toolBlockSummary(block);
  const detailLine = toolBlockDetailLine(block);
  const diff = block.result?.diff;
  const diffStats = useMemo(
    () => (diff ? countDiffStats(diff) : null),
    [diff],
  );

  const statusBits: string[] = [];
  if (block.status === "success") statusBits.push("✓");
  if (block.status === "error") statusBits.push("✗");
  if (block.result?.exitCode != null) {
    statusBits.push(`exit ${block.result.exitCode}`);
  }
  const dur = formatDuration(block.result?.executionTime);
  if (dur) statusBits.push(dur);

  const displayOutput =
    block.status === "running" && liveOutput
      ? liveOutput
      : block.result?.output;

  // 折叠态仍可瞥一眼 shell 直播尾行（一行）
  const liveTail =
    collapsed &&
    block.status === "running" &&
    liveOutput
      ? liveOutput.trim().split("\n").filter(Boolean).slice(-1)[0]
      : null;

  return (
    <div className={cn("group/tool", nested && "pl-0")}>
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        className="flex w-full cursor-pointer items-center gap-1.5 rounded px-1 py-0.5 text-left text-xs text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
      >
        <CollapseChevron open={!collapsed} />
        <ToolBlockIcon block={block} />
        <span className="shrink-0 font-medium text-[11px] text-foreground/80">
          {block.name}
        </span>
        {statusBits.length > 0 && block.status !== "running" && (
          <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/80">
            {statusBits.join(" · ")}
          </span>
        )}
        {collapsed && (liveTail || summary) && (
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-[11px] opacity-80",
              // shell 命令 / 路径用 mono，一眼可辨
              (block.name.toLowerCase() === "shell" ||
                block.name.toLowerCase() === "edit" ||
                block.name.toLowerCase() === "write" ||
                block.name.toLowerCase() === "read") &&
                "font-mono",
            )}
          >
            {liveTail ?? summary}
          </span>
        )}
        {!collapsed && block.result?.filePath && !diff && (
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] opacity-80">
            {block.result.filePath}
          </span>
        )}
        <span className="ml-auto shrink-0 text-[10px] opacity-0 transition-opacity group-hover/tool:opacity-60">
          {formatTs(block.ts)}
        </span>
      </button>

      {!collapsed && (
        <div className="ml-5 mt-1 space-y-1.5 border-l border-border/50 pl-3">
          {/* 一层：可读命令 / 路径（绝不 dump args JSON） */}
          {detailLine && (
            <div className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">
              {detailLine}
            </div>
          )}

          {/* edit diff */}
          {diff && (
            <div>
              <button
                type="button"
                onClick={() => setDiffCollapsed((c) => !c)}
                className="flex cursor-pointer items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
              >
                <CollapseChevron open={!diffCollapsed} />
                <span className="min-w-0 truncate font-mono">
                  {block.result?.filePath ?? "diff"}
                  {diffStats && (
                    <span className="ml-1 tabular-nums">
                      +{diffStats.added}/−{diffStats.removed}
                    </span>
                  )}
                </span>
                {block.result?.diffTruncated && (
                  <span className="text-[10px] text-amber-600 dark:text-amber-400">
                    已截断
                  </span>
                )}
              </button>
              {!diffCollapsed && (
                <InlineDiff
                  diff={diff}
                  truncated={block.result?.diffTruncated}
                />
              )}
            </div>
          )}

          {/* 输出：running 直播 / completed 可再展开 */}
          {displayOutput && (
            <div>
              {block.status !== "running" && (
                <button
                  type="button"
                  onClick={() => setOutputOpen((o) => !o)}
                  className="flex cursor-pointer items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
                >
                  <CollapseChevron open={outputOpen} />
                  输出
                </button>
              )}
              {(block.status === "running" || outputOpen) && (
                <pre className="mt-1 max-h-48 overflow-y-auto whitespace-pre-wrap break-all rounded-md border border-border/50 bg-muted/30 p-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
                  {displayOutput}
                </pre>
              )}
              {/* 仅 truncated+fullPath 都有才出按钮；写盘失败只有 truncated、点开会 404 */}
              {block.result?.truncated && block.result?.fullPath && (
                <button
                  type="button"
                  onClick={() => setFullOpen(true)}
                  className="mt-1 cursor-pointer text-[11px] text-primary hover:underline"
                >
                  已截断 · 查看完整输出
                </button>
              )}
            </div>
          )}
        </div>
      )}

      <FullOutputDialog
        open={fullOpen}
        onOpenChange={setFullOpen}
        taskId={taskId}
        callId={block.callId}
        title={`${block.name} · ${block.callId}`}
      />
    </div>
  );
};

export const ToolBlockRow = memo(ToolBlockRowImpl);

// ---------- verb group ----------

const ToolVerbGroupRowImpl = ({
  group,
  taskId,
}: {
  group: ToolVerbGroup;
  taskId: string;
}) => {
  // 默认折叠成一行（GB group_tool_verbs）
  const [collapsed, setCollapsed] = useState(true);
  return (
    <div className="group/verb">
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        className="flex w-full cursor-pointer items-center gap-1.5 rounded px-1 py-0.5 text-left text-xs text-muted-foreground/70 transition-colors hover:bg-muted/40 hover:text-muted-foreground"
      >
        <CollapseChevron open={!collapsed} />
        <Check className="size-3.5 shrink-0 text-emerald-600/80 dark:text-emerald-400/80" />
        <span className="min-w-0 flex-1 truncate text-[11px]">
          {verbGroupLabel(group)}
        </span>
        <span className="ml-auto shrink-0 text-[10px] opacity-0 transition-opacity group-hover/verb:opacity-60">
          {formatTs(group.ts)}
        </span>
      </button>
      {!collapsed && (
        <div className="ml-5 mt-0.5 space-y-0.5 border-l border-border/40 pl-2">
          {group.members.map((m) => (
            <ToolBlockRow
              key={m.id}
              block={m}
              taskId={taskId}
              nested
            />
          ))}
        </div>
      )}
    </div>
  );
};

export const ToolVerbGroupRow = memo(ToolVerbGroupRowImpl);
