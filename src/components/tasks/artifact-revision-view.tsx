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
  type RefObject,
} from "react";
import {
  Streamdown,
  type Components,
  type ThemeInput,
} from "streamdown";
import { code as streamdownCode } from "@streamdown/code";

import { GATED_MERMAID, STREAMDOWN_CONTROLS } from "@/components/markdown-text";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  buildRevisionView,
  type BlockMark,
  type RevisionStats,
} from "@/lib/md-revision";
import { createRevisionRemarkPlugins } from "@/lib/revision-render-chain";
import {
  REVISION_REHYPE_PLUGINS,
  RevisionDel,
  RevisionIns,
} from "@/lib/revision-rehype-plugins";
import { REVISION_SYNTAX_PLUGINS } from "@/lib/revision-syntax-plugins";
import { cn } from "@/lib/utils";

// math / cjk 与 md-revision 的 parse 侧共用同一份常量（revision-syntax-plugins.ts），不各写各的
const PLUGINS = {
  code: streamdownCode,
  // 带外部资源预扫闸的 mermaid（不能用上游单例：标签里的 <img> / url() 渲染即发请求，R7-1），与对话 / 产物栏共用同一份
  mermaid: GATED_MERMAID,
  ...REVISION_SYNTAX_PLUGINS,
};
const SHIKI_THEME: [ThemeInput, ThemeInput] = ["github-light", "github-dark"];

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

  // 插件表（含顺序约束）与测试共用 createRevisionRemarkPlugins；降级为无标记纯渲染时不再消费哨兵码位
  const leakFallback = revisionView.stats.leakFallback === true;
  const remarkPlugins = useMemo(
    () => createRevisionRemarkPlugins(blockMarks, { sentinels: !leakFallback }),
    [blockMarks, leakFallback],
  );

  // ins / del 只对修订渲染链打了标记的元素套修订样式 + hit（正文原生的 ~~删除线~~ / <del> 不算改动，见 RevisionDel）
  const components = useMemo(
    (): Components =>
      ({
        ...baseComponents,
        ins: RevisionIns,
        del: RevisionDel,
      }) as unknown as Components,
    [baseComponents],
  );

  return (
    <>
      {revisionView.stats.degraded && (
        <div className="mb-3 rounded-md border border-dashed bg-muted/20 px-3 py-1.5 text-xs text-muted-foreground">
          文档过大、已简化为块级修订
        </div>
      )}
      {revisionView.stats.leakFallback && (
        <div className="mb-3 rounded-md border border-dashed bg-muted/20 px-3 py-1.5 text-xs text-muted-foreground">
          修订标记渲染异常，已显示无标记的最新版本
        </div>
      )}
      <div
        ref={rootRef}
        className={cn(
          "relative",
          // 块级左边条
          "[&_[data-revision-status]]:relative [&_[data-revision-status]]:pl-3",
          "[&_[data-revision-status=added]]:border-l-[3px] [&_[data-revision-status=added]]:border-success [&_[data-revision-status=added]]:bg-success/5",
          "[&_[data-revision-status=removed]]:border-l-[3px] [&_[data-revision-status=removed]]:border-destructive [&_[data-revision-status=removed]]:bg-destructive/5 [&_[data-revision-status=removed]]:opacity-80",
          "[&_[data-revision-status=modified]]:border-l-[3px] [&_[data-revision-status=modified]]:border-warning [&_[data-revision-status=modified]]:bg-warning/5",
          // <hr> 是 0 高度元素：背景 / pl-3 都不可见，左边条只剩 3px 的角；改成直接给分隔线本身上色，否则新增 / 删除的分隔线看不出状态
          "[&_hr[data-revision-status=added]]:border-success [&_hr[data-revision-status=removed]]:border-destructive [&_hr[data-revision-status=modified]]:border-warning",
          className,
        )}
      >
        <div className="prose prose-sm dark:prose-invert max-w-none prose-headings:scroll-mt-4 prose-code:before:content-none prose-code:after:content-none">
          <Streamdown
            mode="static"
            shikiTheme={SHIKI_THEME}
            plugins={PLUGINS}
            remarkPlugins={remarkPlugins}
            // 共用表基础上多放行块级 data-revision-hit（否则被 sanitize 剥掉，「下一处改动」够不到整块增删 / 只改格式的块）
            rehypePlugins={REVISION_REHYPE_PLUGINS}
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

  // 角标是绝对定位的：窗口 / 侧栏缩放、Shiki / 图片晚到导致块高度变化时，只测一次的坐标会错位——
  // 盯住 root 的尺寸变化重测（rAF 合并，避免同帧多次 setState）
  useEffect(() => {
    const root = rootRef.current;
    if (!root || typeof ResizeObserver === "undefined") return;
    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(measure);
    });
    ro.observe(root);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [measure, rootRef]);

  if (badges.length === 0) return null;
  return (
    <div className="pointer-events-none absolute inset-0 z-10">
      {badges.map((b) => (
        <button
          key={b.index}
          type="button"
          data-revision-badge=""
          className="pointer-events-auto absolute rounded border border-warning/50 bg-warning/15 px-1.5 py-0.5 text-[11px] font-medium text-warning shadow-sm transition-colors hover:bg-warning/25"
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
