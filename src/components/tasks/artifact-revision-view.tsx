"use client";

/**
 * Artifact 修订视图：Streamdown 渲染合并 md + 块级左边条 + 「已修改」角标看旧文
 *
 * buildRevisionView 在本组件内 useMemo 计算（panel 只传 oldMd/newMd，不拉 md-revision chunk）
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import {
  Streamdown,
  defaultRemarkPlugins,
  type Components,
  type ThemeInput,
} from "streamdown";
import { code as streamdownCode } from "@streamdown/code";
import { mermaid as streamdownMermaid } from "@streamdown/mermaid";
import { math as streamdownMath } from "@streamdown/math";
import { cjk as streamdownCjk } from "@streamdown/cjk";

import { STREAMDOWN_CONTROLS } from "@/components/markdown-text";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  buildRevisionView,
  remarkSentinelToRevision,
  type BlockMark,
  type RevisionStats,
} from "@/lib/md-revision";
import { remarkAnnotateRevisionBlocks } from "@/lib/remark-annotate-revision-blocks";
import { remarkCodeReference } from "@/lib/remark-code-reference";
import { remarkKeepTrailingUnderscore } from "@/lib/remark-keep-trailing-underscore";
import { remarkTrimAutolinkCjk } from "@/lib/remark-trim-autolink-cjk";
import { cn } from "@/lib/utils";

const PLUGINS = {
  code: streamdownCode,
  mermaid: streamdownMermaid,
  math: streamdownMath,
  cjk: streamdownCjk,
};
const SHIKI_THEME: [ThemeInput, ThemeInput] = ["github-light", "github-dark"];

/** 新增：浅绿底；删除：浅红底+删除线——浅深两主题都保对比度 */
const REVISION_INS_CLASS =
  "rounded-[2px] bg-green-100 px-0.5 text-green-900 no-underline dark:bg-green-900/55 dark:text-green-50";
const REVISION_DEL_CLASS =
  "rounded-[2px] bg-red-100 px-0.5 text-red-900 line-through decoration-red-700/80 dark:bg-red-900/50 dark:text-red-100 dark:decoration-red-300/70";

interface Props {
  oldMd: string;
  newMd: string;
  /** 与正文共用的 a/img/inlineCode 映射 */
  baseComponents: Components;
  /** 算出修订视图后回传 stats（toolbar +/− 用） */
  onStatsChange?: (stats: RevisionStats | null) => void;
  className?: string;
}

export const ArtifactRevisionView = ({
  oldMd,
  newMd,
  baseComponents,
  onStatsChange,
  className,
}: Props) => {
  // 滚动 / 定位容器（角标 absolute 相对它）
  const rootRef = useRef<HTMLDivElement>(null);
  // 点「已修改」后弹出的旧版块原文；null = 关闭
  const [oldPreview, setOldPreview] = useState<string | null>(null);

  const revisionView = useMemo(
    () => buildRevisionView(oldMd, newMd),
    [oldMd, newMd],
  );

  useEffect(() => {
    onStatsChange?.(revisionView.stats);
    return () => onStatsChange?.(null);
  }, [revisionView.stats, onStatsChange]);

  const { mergedMd, blockMarks } = revisionView;

  const remarkPlugins = useMemo(
    () => [
      ...Object.values(defaultRemarkPlugins),
      remarkCodeReference,
      remarkKeepTrailingUnderscore,
      remarkTrimAutolinkCjk,
      remarkSentinelToRevision,
      remarkAnnotateRevisionBlocks(blockMarks),
    ],
    [blockMarks],
  );

  const components = useMemo((): Components => {
    const Ins = ({
      children,
      ...rest
    }: {
      children?: ReactNode;
      [key: string]: unknown;
    }) => (
      <ins data-revision-hit="ins" className={REVISION_INS_CLASS} {...rest}>
        {children}
      </ins>
    );
    const Del = ({
      children,
      ...rest
    }: {
      children?: ReactNode;
      [key: string]: unknown;
    }) => (
      <del data-revision-hit="del" className={REVISION_DEL_CLASS} {...rest}>
        {children}
      </del>
    );
    return {
      ...baseComponents,
      ins: Ins,
      del: Del,
    } as unknown as Components;
  }, [baseComponents]);

  return (
    <>
      {revisionView.stats.degraded && (
        <div className="mb-3 rounded-md border border-dashed bg-muted/20 px-3 py-1.5 text-xs text-muted-foreground">
          文档过大、已简化为块级修订
        </div>
      )}
      <div
        ref={rootRef}
        className={cn(
          "relative",
          // 块级左边条
          "[&_[data-revision-status]]:relative [&_[data-revision-status]]:pl-3",
          "[&_[data-revision-status=added]]:border-l-[3px] [&_[data-revision-status=added]]:border-green-500 [&_[data-revision-status=added]]:bg-green-50/40 dark:[&_[data-revision-status=added]]:bg-green-950/25",
          "[&_[data-revision-status=removed]]:border-l-[3px] [&_[data-revision-status=removed]]:border-red-500 [&_[data-revision-status=removed]]:bg-red-50/40 [&_[data-revision-status=removed]]:opacity-80 dark:[&_[data-revision-status=removed]]:bg-red-950/30",
          "[&_[data-revision-status=modified]]:border-l-[3px] [&_[data-revision-status=modified]]:border-amber-500 [&_[data-revision-status=modified]]:bg-amber-50/30 dark:[&_[data-revision-status=modified]]:border-sky-400 dark:[&_[data-revision-status=modified]]:bg-sky-950/20",
          className,
        )}
      >
        <div className="prose prose-sm dark:prose-invert max-w-none prose-headings:scroll-mt-4 prose-code:before:content-none prose-code:after:content-none">
          <Streamdown
            mode="static"
            shikiTheme={SHIKI_THEME}
            plugins={PLUGINS}
            remarkPlugins={remarkPlugins}
            components={components}
            controls={STREAMDOWN_CONTROLS}
          >
            {mergedMd}
          </Streamdown>
        </div>
        <RevisionModifiedBadges
          rootRef={rootRef}
          mergedMd={mergedMd}
          blockMarks={blockMarks}
          onOpenOld={setOldPreview}
        />
      </div>

      <Dialog
        open={oldPreview != null}
        onOpenChange={(open) => {
          if (!open) setOldPreview(null);
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>旧版该块原文</DialogTitle>
          </DialogHeader>
          <pre className="max-h-[60vh] overflow-auto wrap-anywhere rounded-md border bg-muted/40 p-3 font-mono text-xs leading-relaxed">
            {oldPreview}
          </pre>
          <div className="flex justify-end">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setOldPreview(null)}
            >
              关闭
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
};

interface BadgePos {
  index: number;
  top: number;
  right: number;
  oldSource: string;
}

/** 在 modified 块右上角挂「已修改」按钮（测量 DOM 后绝对定位） */
const RevisionModifiedBadges = ({
  rootRef,
  mergedMd,
  blockMarks,
  onOpenOld,
}: {
  rootRef: RefObject<HTMLDivElement | null>;
  mergedMd: string;
  blockMarks: BlockMark[];
  onOpenOld: (src: string) => void;
}) => {
  // 角标屏幕坐标（相对 root）
  const [badges, setBadges] = useState<BadgePos[]>([]);

  const measure = useCallback(() => {
    const root = rootRef.current;
    if (!root) {
      setBadges([]);
      return;
    }
    const rootBox = root.getBoundingClientRect();
    const next: BadgePos[] = [];
    for (const mark of blockMarks) {
      if (mark.status !== "modified" || !mark.oldSource) continue;
      const el = root.querySelector(
        `[data-block-index="${mark.index}"][data-revision-status="modified"]`,
      ) as HTMLElement | null;
      if (!el) continue;
      const box = el.getBoundingClientRect();
      next.push({
        index: mark.index,
        top: box.top - rootBox.top + root.scrollTop,
        right: Math.max(rootBox.right - box.right, 4),
        oldSource: mark.oldSource,
      });
    }
    setBadges(next);
  }, [blockMarks, rootRef]);

  useEffect(() => {
    // Streamdown / Shiki 可能晚一帧才出 DOM，双 rAF + 短延迟再测一次
    let cancelled = false;
    let t2: ReturnType<typeof setTimeout> | null = null;
    const id = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (cancelled) return;
        measure();
        t2 = setTimeout(() => {
          if (!cancelled) measure();
        }, 120);
      });
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(id);
      if (t2) clearTimeout(t2);
    };
  }, [measure, mergedMd, blockMarks]);

  if (badges.length === 0) return null;
  return (
    <div className="pointer-events-none absolute inset-0 z-10">
      {badges.map((b) => (
        <button
          key={b.index}
          type="button"
          data-revision-badge=""
          className="pointer-events-auto absolute rounded border border-amber-500/50 bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-900 shadow-sm hover:bg-amber-200 dark:border-sky-400/50 dark:bg-sky-950 dark:text-sky-100 dark:hover:bg-sky-900"
          style={{ top: b.top + 4, right: b.right }}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onOpenOld(b.oldSource);
          }}
        >
          已修改
        </button>
      ))}
    </div>
  );
};
