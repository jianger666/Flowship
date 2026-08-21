"use client";

/**
 * 本地文件预览弹窗正文（含 MarkdownText → Streamdown / Shiki / Mermaid）
 *
 * 从 Provider 拆出来是为了根布局不要静态引进这棵树：设置页 / 刷新不该
 * 为「还没打开的预览」支付 webpack 编译 200+ 语言高亮。首次 open 才 dynamic 加载。
 */

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { MarkdownText } from "@/components/markdown-text";
import { canPreviewInSheet, type LocalFileKind } from "@/lib/local-file-kind";
import { pathBasename } from "@/lib/path-utils";

export interface LocalFilePreviewPayload {
  kind: LocalFileKind;
  absolutePath: string;
  ext: string;
  size: number;
  text?: string;
  truncated?: boolean;
  language?: string;
  html?: string;
  mediaPath?: string;
  previewable: boolean;
}

export const LocalFilePreviewBody = ({
  data,
  loading,
  error,
}: {
  data: LocalFilePreviewPayload | null;
  loading: boolean;
  error: string | null;
}) => {
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!data || data.kind !== "pdf" || !data.mediaPath) {
      setPdfUrl(null);
      return;
    }
    let revoked: string | null = null;
    void (async () => {
      try {
        const res = await fetch(data.mediaPath!);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        revoked = URL.createObjectURL(blob);
        setPdfUrl(revoked);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "PDF 加载失败");
        setPdfUrl(null);
      }
    })();
    return () => {
      if (revoked) URL.revokeObjectURL(revoked);
    };
  }, [data]);

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        加载中…
      </div>
    );
  }
  if (error) {
    return (
      <p className="py-8 text-center text-sm text-destructive">{error}</p>
    );
  }
  if (!data) return null;

  if (!data.previewable || !canPreviewInSheet(data.kind)) {
    return (
      <div className="flex flex-col items-center gap-2 py-16 text-center text-sm text-muted-foreground">
        <p>无法在此预览此类型文件</p>
        <p className="text-xs">请使用「在文件夹中显示」或「用系统应用打开」</p>
      </div>
    );
  }

  if (data.kind === "image" && data.mediaPath) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={data.mediaPath}
        alt={pathBasename(data.absolutePath)}
        className="mx-auto max-h-[70vh] max-w-full rounded-md border object-contain"
      />
    );
  }

  if (data.kind === "pdf") {
    if (!pdfUrl) {
      return (
        <div className="flex justify-center py-16">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      );
    }
    return (
      <iframe
        src={pdfUrl}
        title={pathBasename(data.absolutePath)}
        className="h-[min(70vh,40rem)] w-full rounded-md border bg-muted/20"
      />
    );
  }

  if ((data.kind === "docx" || data.kind === "xlsx") && data.html) {
    return (
      <div
        className="prose prose-sm dark:prose-invert max-w-none min-w-0 overflow-x-auto"
        // mammoth / sheetjs 输出的是受控 HTML 片段
        dangerouslySetInnerHTML={{ __html: data.html }}
      />
    );
  }

  if (data.kind === "markdown" && data.text != null) {
    return <MarkdownText text={data.text} variant="document" />;
  }

  if ((data.kind === "code" || data.kind === "text") && data.text != null) {
    const lang = data.language ?? "text";
    const fenced = `\`\`\`${lang}\n${data.text}\n\`\`\``;
    return (
      <div className="min-w-0">
        <MarkdownText text={fenced} variant="document" />
        {data.truncated && (
          <p className="mt-3 text-xs text-warning">
            已截断，完整内容请在文件夹中打开查看
          </p>
        )}
      </div>
    );
  }

  return null;
};
