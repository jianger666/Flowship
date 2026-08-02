"use client";

/**
 * 本地文件预览：全局 Provider + 居中文档检视窗
 *
 * 设计口径（frontend-design + ui-ux-pro-max）：
 * - 受众 = 工程师扫 harness 产物；单职 = 看清文件，不是「营销纸面」
 * - 密度优先（data-dense）：正文全宽，禁止 inset 卡片两侧大留白
 * - 签名元素 = 扩展名徽章 + 可点路径复制；文件动作与关分层
 */

import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  ExternalLink,
  FolderOpen,
  Loader2,
  SquareCode,
} from "lucide-react";
import { toast } from "sonner";

import { MarkdownText } from "@/components/markdown-text";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tooltip } from "@/components/ui/tooltip";
import { getIdeAnchorProps } from "@/lib/ide-open";
import {
  canOpenInIde,
  canPreviewInSheet,
  type LocalFileKind,
} from "@/lib/local-file-kind";
import {
  pathBasename,
  pathDisplayLabel,
  resolveIdeTarget,
  shortenHomePathDisplay,
} from "@/lib/path-utils";
import { JUMP_IDE_LABEL } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useJumpIde } from "@/hooks/use-settings";
import {
  LocalFilePreviewContext,
  type OpenLocalFileOptions,
} from "@/components/ui/local-file-preview-context";

export type { OpenLocalFileOptions } from "@/components/ui/local-file-preview-context";
export {
  resolveLocalFileAbsolute,
  useLocalFilePreview,
} from "@/components/ui/local-file-preview-context";

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

interface PreviewState extends OpenLocalFileOptions {
  pathLike: string;
  absolutePath: string;
}

const postJson = async (
  url: string,
  body: Record<string, string>,
): Promise<boolean> => {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      toast.error(data?.error ?? "操作失败");
      return false;
    }
    return true;
  } catch (err) {
    toast.error(err instanceof Error ? err.message : String(err));
    return false;
  }
};

const extBadgeLabel = (absolutePath: string, kind?: LocalFileKind | null): string => {
  const base = pathBasename(absolutePath);
  const dot = base.lastIndexOf(".");
  if (dot > 0 && dot < base.length - 1) return base.slice(dot + 1).toLowerCase();
  if (kind === "markdown") return "md";
  if (kind === "code" || kind === "text") return "txt";
  return kind ?? "file";
};

const PreviewBody = ({
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

export const LocalFilePreviewProvider = ({ children }: { children: ReactNode }) => {
  const ide = useJumpIde();
  // open 与 state 拆开：关窗先 open=false 走 DialogContent 退场动画，再清 state
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<PreviewState | null>(null);
  const [payload, setPayload] = useState<LocalFilePreviewPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const clearPreviewData = useCallback(() => {
    setState(null);
    setPayload(null);
    setError(null);
    setLoading(false);
  }, []);

  const openPreview = useCallback((pathLike: string, opts?: OpenLocalFileOptions) => {
    // pathLike 可带 :line 后缀；resolveIdeTarget 与 IDE 跳转共用解析
    const target = resolveIdeTarget(pathLike, opts?.baseDir);
    if (!target) return;
    setState({
      pathLike,
      absolutePath: target.absolute,
      baseDir: opts?.baseDir,
      line: opts?.line ?? target.line,
    });
    setOpen(true);
  }, []);

  // 关窗动画结束后再卸内容（DialogContent duration-100，留一点余量）
  useEffect(() => {
    if (open) return;
    const t = window.setTimeout(clearPreviewData, 160);
    return () => window.clearTimeout(t);
  }, [open, clearPreviewData]);

  useEffect(() => {
    if (!state) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setPayload(null);
    void (async () => {
      try {
        const res = await fetch(
          `/api/system/read-local-file?path=${encodeURIComponent(state.absolutePath)}`,
        );
        const json = (await res.json()) as LocalFilePreviewPayload & { error?: string };
        if (cancelled) return;
        if (!res.ok) {
          setError(json.error ?? `加载失败（HTTP ${res.status}）`);
          return;
        }
        setPayload(json);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [state]);

  const handleReveal = () => {
    if (!state) return;
    void postJson("/api/system/reveal-in-folder", { path: state.absolutePath });
  };

  const handleSystemOpen = () => {
    if (!state) return;
    void postJson("/api/system/open-path", { path: state.absolutePath });
  };

  const handleIdeOpen = () => {
    if (!state || !payload || !canOpenInIde(payload.kind)) return;
    const pathForIde =
      state.line != null && !state.pathLike.includes(":")
        ? `${state.pathLike}:${state.line}`
        : state.pathLike;
    const anchor = getIdeAnchorProps(pathForIde, state.baseDir, ide);
    if (!anchor) {
      toast.error("无法解析 IDE 跳转目标");
      return;
    }
    if (anchor.onClick) {
      anchor.onClick({ preventDefault: () => {} } as React.MouseEvent);
    } else if (anchor.href && anchor.href !== "#") {
      window.location.assign(anchor.href);
    }
  };

  /** 点路径复制绝对路径——意图贴在路径上，不进文件动作簇 */
  const handleCopyPath = async () => {
    if (!state) return;
    try {
      await navigator.clipboard.writeText(state.absolutePath);
      toast.success("已复制路径");
    } catch {
      toast.error("复制失败");
    }
  };

  const displayLabel = state ? pathDisplayLabel(state.absolutePath) : "";
  const pathShown = state ? shortenHomePathDisplay(state.absolutePath) : "";
  const extLabel = state
    ? extBadgeLabel(state.absolutePath, payload?.kind)
    : "";

  return (
    <LocalFilePreviewContext.Provider value={{ open: openPreview }}>
      {children}
      {/*
        与推进弹窗同一套 Dialog + DialogContent：共享蒙层、开关动画、右上角 Close。
        禁止再手写 Portal/Popup，否则关窗会瞬间卸 DOM、退场动画跑不起来。
      */}
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next) setOpen(false);
        }}
      >
        <DialogContent
          className={cn(
            // bg-background：跟产物栏同一纸面色；别用 Dialog 默认 bg-popover（浅色更白），
            // 否则 Streamdown 表格 bg-background / 表头叠色会跟外面漂开。
            "flex max-h-[min(90vh,calc(100vh-48px))] w-full flex-col gap-0 overflow-hidden bg-background p-0 text-foreground",
            "sm:max-w-[min(960px,80vw,calc(100vw-48px))]",
          )}
        >
          {state ? (
            <>
              {/*
                顶栏：左身份；路径用 Tooltip（与文件夹/IDE 同套，不用原生 title）；
                文件动作一簇；关按钮走 DialogContent 内置（absolute top-2 right-2）。
              */}
              <div className="flex shrink-0 items-center gap-2.5 border-b border-border/80 bg-muted/25 py-2.5 pr-12 pl-3">
                <Tooltip content={`.${extLabel}`}>
                  <span className="inline-flex h-6 shrink-0 items-center rounded-sm bg-info/10 px-1.5 font-mono text-[11px] font-medium uppercase tracking-wide text-info">
                    .{extLabel}
                  </span>
                </Tooltip>
                <div className="min-w-0 flex-1">
                  <DialogTitle className="truncate text-sm font-medium tracking-tight">
                    <Tooltip content={state.absolutePath}>
                      <span className="block truncate">{displayLabel}</span>
                    </Tooltip>
                  </DialogTitle>
                  <DialogDescription className="sr-only">
                    {state.absolutePath}
                  </DialogDescription>
                  <Tooltip content="点击复制路径">
                    <button
                      type="button"
                      onClick={() => void handleCopyPath()}
                      className="mt-0.5 block max-w-full truncate text-left font-mono text-[11px] text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
                    >
                      {pathShown}
                    </button>
                  </Tooltip>
                </div>
                <div className="flex shrink-0 items-center rounded-md border border-border/70 bg-background p-0.5">
                  <Tooltip content="在文件夹中显示">
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      className="inline-flex h-7 items-center gap-1 px-2 text-muted-foreground"
                      onClick={handleReveal}
                    >
                      <FolderOpen className="size-3.5" />
                      文件夹
                    </Button>
                  </Tooltip>
                  {payload && canOpenInIde(payload.kind) && (
                    <Tooltip
                      content={`在 ${JUMP_IDE_LABEL[ide]} 打开${state.line != null ? `（第 ${state.line} 行）` : ""}`}
                    >
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        className="inline-flex h-7 items-center gap-1 px-2 text-muted-foreground"
                        onClick={handleIdeOpen}
                      >
                        <SquareCode className="size-3.5" />
                        IDE
                      </Button>
                    </Tooltip>
                  )}
                  {payload && !canOpenInIde(payload.kind) && (
                    <Tooltip content="用系统应用打开">
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        className="inline-flex h-7 items-center gap-1 px-2 text-muted-foreground"
                        onClick={handleSystemOpen}
                      >
                        <ExternalLink className="size-3.5" />
                        打开
                      </Button>
                    </Tooltip>
                  )}
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-5 py-4">
                <PreviewBody data={payload} loading={loading} error={error} />
              </div>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </LocalFilePreviewContext.Provider>
  );
};
