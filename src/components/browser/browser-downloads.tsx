"use client";

/**
 * 下载 UI（契约 §14.3）：工具栏下载按钮（有下载才出现，进行中显示进度）+ 弹层列表。
 *
 * 数据来自 `state.downloads`（V3 在主进程生产，最近 10 条；老壳缺省按空处理）。
 * 行内「在文件夹中显示」「打开」只传会话内的下载 id，**路径永远由主进程从登记表取**；
 * 「打开」按扩展名**白名单**才显示（R1-23，见 browser-user-logic 的 canOpenDownload；主进程再校验一次），其余一律只给「显示」。
 * 弹层是 base-ui Popover（data-slot="popover-content"），use-overlay-cover 能识别并在盖住视口时遮盖。
 */
import { memo } from "react";
import { Download, ExternalLink, FileDown, FolderOpen } from "lucide-react";
import { toast } from "sonner";

import { buttonVariants } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip } from "@/components/ui/tooltip";
import type { DownloadActionResult, DownloadInfo } from "@/lib/browser-bridge-types";
import { cn } from "@/lib/utils";
import { BrowserIconButton } from "./browser-icon-button";
import { displayFileName } from "./browser-status";
import {
  canOpenDownload,
  canRevealDownload,
  describeDownloadMeta,
  downloadPercent,
  summarizeDownloads,
} from "./browser-user-logic";

const reportResult = (p: Promise<DownloadActionResult> | undefined, fallback: string) => {
  if (!p) {
    toast.error(fallback);
    return;
  }
  p.then((r) => {
    if (!r?.ok) toast.error(r?.error ?? fallback);
  }).catch((err) => toast.error(`${fallback}：${err instanceof Error ? err.message : String(err)}`));
};

/**
 * 一行下载的进度条：只在总大小已知时画（确定进度）。
 * 总大小未知时不画——以前画一条 animate-pulse 的「不确定」条，与 ui-conventions「同屏只留一处主动效」冲突（R2-14 ⑤）；
 * 那种情况下行内文案本来就写着「下载中 · 已接收 N MB」（describeDownloadMeta），信息没有丢。
 */
const RowProgress = ({ d }: { d: DownloadInfo }) => {
  const pct = downloadPercent(d);
  if (pct === null) return null;
  return (
    <div
      role="progressbar"
      aria-label={`${displayFileName(d.fileName)} 下载进度`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      className="mt-1 h-1 overflow-hidden rounded-full bg-muted"
    >
      <div className="h-full rounded-full bg-info" style={{ width: `${pct}%` }} />
    </div>
  );
};

/** 下载列表（弹层内容）；单独导出，SSR 测试不必打开弹层就能断言行内容 */
export const DownloadList = memo(function DownloadList({
  taskId,
  downloads,
}: {
  taskId: string;
  downloads: readonly DownloadInfo[];
}) {
  if (downloads.length === 0) {
    return <div className="px-3 py-4 text-center text-xs text-muted-foreground">还没有下载</div>;
  }
  // 最新在上
  const rows = [...downloads].sort((a, b) => b.startedAt - a.startedAt);
  return (
    <ul aria-label="下载列表" className="max-h-72 divide-y overflow-y-auto">
      {rows.map((d) => (
        <li key={d.id} className="flex items-start gap-2 px-2 py-2">
          <FileDown className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
          <div className="min-w-0 flex-1">
            {/* 文件名是服务器 / 页面给的：展示前剥格式字符（U+202E 会把 report.exe 反向显示成别的样子），R1-37 */}
            <div className="line-clamp-2 break-all text-xs font-medium">{displayFileName(d.fileName)}</div>
            <div
              className={cn(
                "mt-0.5 text-[11px]",
                d.state === "interrupted" ? "text-destructive" : "text-muted-foreground",
              )}
            >
              {describeDownloadMeta(d)}
            </div>
            {d.state === "progressing" && <RowProgress d={d} />}
          </div>
          <div className="flex shrink-0 items-center">
            {canRevealDownload(d) && (
              <BrowserIconButton
                label={`在文件夹中显示 ${displayFileName(d.fileName)}`}
                onClick={() =>
                  reportResult(window.__browser?.revealDownload?.(taskId, d.id), "无法在文件夹中显示")
                }
              >
                <FolderOpen />
              </BrowserIconButton>
            )}
            {canOpenDownload(d) && (
              <BrowserIconButton
                label={`打开 ${displayFileName(d.fileName)}`}
                onClick={() => reportResult(window.__browser?.openDownload?.(taskId, d.id), "无法打开文件")}
              >
                <ExternalLink />
              </BrowserIconButton>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
});

/** 工具栏下载按钮：没有下载时整个不渲染；进行中在按钮底部画合并进度条 */
export const BrowserDownloads = memo(function BrowserDownloads({
  taskId,
  downloads,
}: {
  taskId: string;
  downloads: readonly DownloadInfo[];
}) {
  const summary = summarizeDownloads(downloads);
  if (summary.total === 0) return null;
  const label =
    summary.active > 0
      ? `下载（${summary.active} 个进行中${summary.percent === null ? "" : `，${summary.percent}%`}）`
      : `下载（${summary.total}）`;
  return (
    <Popover>
      <Tooltip content={label} side="top">
        <PopoverTrigger
          aria-label={label}
          className={cn(buttonVariants({ variant: "ghost", size: "icon-sm" }), "relative shrink-0")}
        >
          <Download className={cn(summary.active > 0 && "text-info")} />
          {/* 合并进度条只在有确定百分比时画：全部总大小未知时没有可画的值，
              图标已是 text-info、tooltip / aria-label 写着「N 个进行中」，不再用 animate-pulse 凑一条假的（R2-14 ⑤） */}
          {summary.active > 0 && summary.percent !== null && (
            <span
              aria-hidden
              className="absolute inset-x-1.5 bottom-0.5 h-0.5 overflow-hidden rounded-full bg-muted"
            >
              <span
                className="block h-full rounded-full bg-info"
                style={{ width: `${summary.percent}%` }}
              />
            </span>
          )}
        </PopoverTrigger>
      </Tooltip>
      <PopoverContent align="end" side="bottom" className="w-80 p-0">
        <DownloadList taskId={taskId} downloads={downloads} />
      </PopoverContent>
    </Popover>
  );
});
