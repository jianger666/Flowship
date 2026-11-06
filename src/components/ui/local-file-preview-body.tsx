"use client";

/**
 * 本地文件预览弹窗正文：按文件类型分发到各 viewer（src/components/preview/*）
 *
 * 从 Provider 拆出来是为了根布局不要静态引进这棵树：设置页 / 刷新不该
 * 为「还没打开的预览」支付 webpack 编译 200+ 语言高亮 + Prism 语法包 + 虚拟列表。首次 open 才 dynamic 加载。
 *
 * 类型 → viewer：
 *   code / text → CodeViewer（行号 / 着色 / 查找 / 编辑）；json → JsonViewer（树 / 源码）
 *   markdown → MarkdownViewer（预览 + 目录 + 查找 / 源码）   csv → CsvViewer（表格 / 源码）
 *   xlsx → TableViewer（多 sheet）   docx → DocumentPane（目录 + 查找）   pptx → SlidesViewer（文字大纲）
 *   image → ImageViewer   svg → SvgViewer（图像 / 源码）   archive → ArchiveViewer   pdf → 浏览器内置 PDF 查看器
 * HTML / HTM 不在这里：一律交给系统浏览器（resolveLocalFileOpenTarget），不自己渲染。
 */

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { ArchiveViewer } from "@/components/preview/archive-viewer";
import { CodeViewer, type CodeViewerProps } from "@/components/preview/code-viewer";
import { CsvViewer } from "@/components/preview/csv-viewer";
import { DocumentPane } from "@/components/preview/document-pane";
import { ImageViewer } from "@/components/preview/image-viewer";
import { JsonViewer } from "@/components/preview/json-viewer";
import { MarkdownViewer } from "@/components/preview/markdown-viewer";
import { SlidesViewer } from "@/components/preview/slides-viewer";
import { SvgViewer } from "@/components/preview/svg-viewer";
import { TableViewer } from "@/components/preview/table-viewer";
import { canPreviewInSheet } from "@/lib/local-file-kind";
import { pathBasename } from "@/lib/path-utils";
import { sanitizePreviewHtml } from "@/lib/preview-html-sanitize";
import type { LocalFilePreviewPayload } from "@/lib/preview/types";

export type { LocalFilePreviewPayload } from "@/lib/preview/types";

export interface LocalFilePreviewBodyProps {
  data: LocalFilePreviewPayload | null;
  loading: boolean;
  error: string | null;
  /** 打开时定位的行（代码 / 文本） */
  line?: number;
  /** 外壳「重新加载」时递增：编辑器据此丢弃草稿 */
  resetKey?: number;
  onDirtyChange?: (dirty: boolean) => void;
  onSaved?: (r: { text: string; mtimeMs: number; size: number }) => void;
  onRequestReload?: () => void;
  /** xlsx 切换工作表 */
  onSelectSheet?: (index: number) => void;
  sheetLoading?: boolean;
}

const noopDirty = () => {};
const noopSaved = () => {};
const noopReload = () => {};

/** 图片通道的缓存键：文件被改写后同一个 URL 也要重新取（本机通道是 no-cache，但 <img> 对同 src 不会重新发起） */
const withVersion = (url: string, mtimeMs: number): string => `${url}${url.includes("?") ? "&" : "?"}v=${Math.round(mtimeMs)}`;

const Centered = ({ children }: { children: ReactNode }) => (
  <div className="flex h-full flex-col items-center justify-center gap-2 px-5 py-16 text-center text-sm text-muted-foreground">{children}</div>
);

export const LocalFilePreviewBody = ({
  data,
  loading,
  error,
  line,
  resetKey = 0,
  onDirtyChange = noopDirty,
  onSaved = noopSaved,
  onRequestReload = noopReload,
  onSelectSheet,
  sheetLoading,
}: LocalFilePreviewBodyProps) => {
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const pdfSource = data?.kind === "pdf" ? data.mediaPath : undefined;
  const pdfVersion = data?.mtimeMs;

  useEffect(() => {
    if (!pdfSource) {
      setPdfUrl(null);
      return;
    }
    let objectUrl: string | null = null;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(pdfSource);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setPdfUrl(objectUrl);
      } catch (e) {
        if (cancelled) return;
        toast.error(e instanceof Error ? e.message : "PDF 加载失败");
        setPdfUrl(null);
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [pdfSource, pdfVersion]);

  // docx 的 HTML 渲染前再净化一次（纵深防御：server 已净化、净化器幂等；
  // 防止别的来源 / 旧缓存 / 以后新增的 html 字段绕过 server 那一层直达 dangerouslySetInnerHTML）
  const safeHtml = useMemo(() => (data?.html ? sanitizePreviewHtml(data.html) : ""), [data?.html]);

  if (loading && !data) {
    return (
      <Centered>
        <Loader2 className="size-4 animate-spin" />
        加载中…
      </Centered>
    );
  }
  if (error && !data) {
    return (
      <Centered>
        <p className="text-destructive">{error}</p>
      </Centered>
    );
  }
  if (!data) return null;

  if (!data.previewable || !canPreviewInSheet(data.kind)) {
    return (
      <Centered>
        <p>{data.reason ?? "无法在此预览此类型文件"}</p>
        <p className="text-xs">请使用「在文件夹中显示」或「用系统应用打开」</p>
      </Centered>
    );
  }

  const codeProps = (d: LocalFilePreviewPayload): CodeViewerProps => ({
    path: d.absolutePath,
    ext: d.ext,
    text: d.text ?? "",
    size: d.size,
    truncated: d.truncated,
    tail: d.tail,
    mtimeMs: d.mtimeMs,
    eol: d.eol ?? "lf",
    bom: d.bom ?? false,
    editable: d.editable ?? false,
    editBlockedReason: d.editBlockedReason,
    line,
    resetKey,
    onDirtyChange,
    onSaved,
    onRequestReload,
  });

  switch (data.kind) {
    case "image":
      if (!data.mediaPath) break;
      return <ImageViewer src={withVersion(data.mediaPath, data.mtimeMs)} alt={pathBasename(data.absolutePath)} size={data.size} />;

    case "pdf":
      if (!pdfUrl) {
        return (
          <Centered>
            <Loader2 className="size-5 animate-spin" />
          </Centered>
        );
      }
      return <iframe src={pdfUrl} title={pathBasename(data.absolutePath)} className="h-full w-full bg-muted/20" />;

    case "docx":
      if (!data.html) break;
      return (
        <DocumentPane contentKey={safeHtml} contentClassName="prose prose-sm dark:prose-invert max-w-none">
          {/* mammoth 输出不保证安全：已过白名单净化器（preview-html-sanitize） */}
          <div dangerouslySetInnerHTML={{ __html: safeHtml }} />
        </DocumentPane>
      );

    case "xlsx":
      if (!data.table) break;
      return (
        <TableViewer
          table={data.table}
          sheetNames={data.sheetNames}
          sheetIndex={data.sheetIndex}
          onSelectSheet={onSelectSheet}
          sheetLoading={sheetLoading}
        />
      );

    case "csv":
      if (data.text == null) break;
      return <CsvViewer {...codeProps(data)} table={data.table} />;

    case "pptx":
      if (!data.slides) break;
      return <SlidesViewer slides={data.slides} slideCount={data.slideCount} />;

    case "archive":
      if (!data.entries) break;
      return <ArchiveViewer entries={data.entries} entryCount={data.entryCount} entriesTruncated={data.entriesTruncated} />;

    case "svg":
      if (data.text == null) break;
      return <SvgViewer {...codeProps(data)} />;

    case "markdown":
      if (data.text == null) break;
      return <MarkdownViewer {...codeProps(data)} />;

    case "code":
    case "text":
      if (data.text == null) break;
      return data.ext === "json" ? <JsonViewer {...codeProps(data)} /> : <CodeViewer {...codeProps(data)} />;

    default:
      break;
  }

  return (
    <Centered>
      <p>无法在此预览此类型文件</p>
      <p className="text-xs">请使用「在文件夹中显示」或「用系统应用打开」</p>
    </Centered>
  );
};
