"use client";

/**
 * 本地文件预览：全局 Provider + 右侧非模态侧栏（文档检视）
 *
 * 2026-11-14 起从「居中弹窗」改成右侧侧栏（用户拍板：所有预览统一成侧面展开）：
 *   读产物时要对着聊天，居中弹窗的蒙层把对话盖住了；侧栏非模态，左边仍可点，连点不同文件链接只是换内容。
 *   与代码改动面板 / 子代理抽屉共用「右侧只有一条位」（lib/right-dock）：后开的替换先开的。
 *   例外（不进侧栏）：音视频走全局播放器；聊天里点图片的全屏灯箱（image-preview）保留，看大图要尽量多的像素。
 *
 * 设计口径（frontend-design + ui-ux-pro-max）：
 * - 受众 = 工程师扫 harness 产物；单职 = 看清文件，不是「营销纸面」
 * - 密度优先（data-dense）：正文全宽，禁止 inset 卡片两侧大留白
 * - 签名元素 = 扩展名徽章 + 可点路径复制；文件动作与关分层
 *
 * 正文（Markdown / Shiki）在 local-file-preview-body，首次打开才加载——
 * 避免根布局 Providers 把 Streamdown 整树编进每个页面（dev:web webpack 曾因此占 10GB+）。
 */

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ExternalLink,
  FolderOpen,
  Loader2,
  Maximize2,
  Minimize2,
  SquareCode,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@/components/ui/sheet";
import { Tooltip } from "@/components/ui/tooltip";
import { getIdeAnchorProps } from "@/lib/ide-open";
import { canOpenInIde, type LocalFileKind } from "@/lib/local-file-kind";
import { formatBytes, formatModified } from "@/lib/preview/format";
import { detectMediaKind } from "@/lib/media/media-kind";
import { openMedia } from "@/lib/media/player-store";
import {
  pathBasename,
  pathDisplayLabel,
  resolveIdeTarget,
  shortenHomePathDisplay,
} from "@/lib/path-utils";
import { JUMP_IDE_LABEL } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useDialog } from "@/hooks/use-dialog";
import { useRightDockSlot } from "@/hooks/use-right-dock-slot";
import { useJumpIde } from "@/hooks/use-settings";
import {
  LocalFilePreviewContext,
  type OpenLocalFileOptions,
} from "@/components/ui/local-file-preview-context";
import type { LocalFilePreviewPayload } from "@/components/ui/local-file-preview-body";

export type { OpenLocalFileOptions } from "@/components/ui/local-file-preview-context";
export type { LocalFilePreviewPayload } from "@/components/ui/local-file-preview-body";
export {
  resolveLocalFileAbsolute,
  useLocalFilePreview,
} from "@/components/ui/local-file-preview-context";

const LocalFilePreviewBody = dynamic(
  () =>
    import("@/components/ui/local-file-preview-body").then(
      (m) => m.LocalFilePreviewBody,
    ),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        加载中…
      </div>
    ),
  },
);

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

const WIDE_KEY = "flowship.preview.wide";
/** 磁盘上的文件有没有变：轮询间隔（只在侧栏开着、标签页可见时跑，一次一个很小的 stat） */
const STAT_POLL_MS = 2500;

export const LocalFilePreviewProvider = ({ children }: { children: ReactNode }) => {
  const ide = useJumpIde();
  const { confirm } = useDialog();
  const confirmRef = useRef(confirm);
  confirmRef.current = confirm;

  // open 与 state 拆开：关栏先 open=false 走 SheetContent 滑出动画，再清 state
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<PreviewState | null>(null);
  const [payload, setPayload] = useState<LocalFilePreviewPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // xlsx 工作表序号：切换时只重新请求那一张（服务端只解析选中的 sheet）
  const [sheetIndex, setSheetIndex] = useState(0);
  const [switchingSheet, setSwitchingSheet] = useState(false);
  // reloadNonce：不换文件、只重新读一遍（保存后 / 磁盘变化 / 手动重新加载），静默进行、不闪「加载中」
  const [reloadNonce, setReloadNonce] = useState(0);
  // resetKey：用户明确选择「丢弃未保存的修改并重新加载」时递增，编辑器据此重置草稿
  const [resetKey, setResetKey] = useState(0);
  const [stale, setStale] = useState<"changed" | "missing" | null>(null);
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  const inflightRef = useRef(false);
  const loadedPathRef = useRef<string | null>(null);
  const shownPathRef = useRef<string | null>(null);
  const [wide, setWide] = useState(false);

  // 放大 / 标准偏好：SSR 阶段没有 localStorage，挂载后再读（Provider 在根布局里会被服务端渲染，不能首帧就读）
  useEffect(() => {
    try {
      setWide(window.localStorage.getItem(WIDE_KEY) === "1");
    } catch {
      // 读不到就用默认
    }
  }, []);
  const toggleWide = () => {
    setWide((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(WIDE_KEY, next ? "1" : "0");
      } catch {
        // 存不下不影响本次
      }
      return next;
    });
  };

  const handleDirtyChange = useCallback((next: boolean) => {
    dirtyRef.current = next;
    setDirty(next);
  }, []);

  const clearPreviewData = useCallback(() => {
    setState(null);
    setPayload(null);
    setError(null);
    setLoading(false);
    setSheetIndex(0);
    setSwitchingSheet(false);
    setStale(null);
    setDirty(false);
    dirtyRef.current = false;
    loadedPathRef.current = null;
    shownPathRef.current = null;
  }, []);

  const openPreview = useCallback((pathLike: string, opts?: OpenLocalFileOptions) => {
    // pathLike 可带 :line 后缀；resolveIdeTarget 与 IDE 跳转共用解析
    const target = resolveIdeTarget(pathLike, opts?.baseDir);
    if (!target) return;
    // 音视频不进文档预览窗：统一进全局播放器（任何走 open() 的入口——产物栏 / 文件列表 / 搜索——都自动获得播放）
    if (detectMediaKind(target.absolute)) {
      openMedia([{ path: target.absolute }]);
      return;
    }
    const next: PreviewState = {
      pathLike,
      absolutePath: target.absolute,
      baseDir: opts?.baseDir,
      line: opts?.line ?? target.line,
    };
    void (async () => {
      // 正在编辑且有未保存修改时，从别处点开另一个文件：不能悄悄把草稿换掉
      if (dirtyRef.current) {
        const ok = await confirmRef.current({
          title: "放弃未保存的修改？",
          description: "当前文件有未保存的修改，打开另一个文件会丢失它们。",
          confirmLabel: "放弃修改并打开",
          destructive: true,
          defaultFocus: "cancel",
        });
        if (!ok) return;
        dirtyRef.current = false;
        setDirty(false);
      }
      // 换了文件：工作表序号 / 过期提示都属于上一个文件，清掉
      if (shownPathRef.current && shownPathRef.current !== next.absolutePath) {
        setSheetIndex(0);
        setStale(null);
      }
      setState(next);
      setOpen(true);
    })();
  }, []);
  const previewContext = useMemo(
    () => ({ open: openPreview, ide }),
    [openPreview, ide],
  );

  // 关栏动画结束后再卸内容（SheetContent duration-200 滑出，留一点余量；早了会在滑出途中闪成空白）
  useEffect(() => {
    if (open) return;
    const t = window.setTimeout(clearPreviewData, 260);
    return () => window.clearTimeout(t);
  }, [open, clearPreviewData]);

  const absolutePath = state?.absolutePath ?? null;
  shownPathRef.current = absolutePath;
  useEffect(() => {
    if (!absolutePath) return;
    let cancelled = false;
    // 换了文件 → 完整加载（清空旧内容、显示加载中）；同一文件的重新读取（保存后 / 磁盘变化 / 切 sheet）→ 静默，旧内容保留到新内容到位
    const fresh = loadedPathRef.current !== absolutePath;
    inflightRef.current = true;
    if (fresh) {
      setLoading(true);
      setError(null);
      setPayload(null);
    }
    void (async () => {
      try {
        const url =
          `/api/system/read-local-file?path=${encodeURIComponent(absolutePath)}` +
          (sheetIndex > 0 ? `&sheet=${sheetIndex}` : "");
        const res = await fetch(url);
        const json = (await res.json()) as LocalFilePreviewPayload & { error?: string };
        if (cancelled) return;
        if (!res.ok) {
          // 静默刷新失败（例如 agent 正在写文件，读到半截）：保留旧内容，下一轮轮询会再试
          if (fresh) setError(json.error ?? `加载失败（HTTP ${res.status}）`);
          return;
        }
        loadedPathRef.current = absolutePath;
        setPayload(json);
        setError(null);
      } catch (e) {
        if (!cancelled && fresh) {
          setError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        if (!cancelled) {
          inflightRef.current = false;
          setLoading(false);
          setSwitchingSheet(false);
        }
      }
    })();
    return () => {
      cancelled = true;
      inflightRef.current = false;
    };
  }, [absolutePath, sheetIndex, reloadNonce]);

  // 轮询磁盘修改时间：没有未保存修改 → 静默刷新（agent 正在改的文件会实时跟上）；有 → 只提示，不替用户做决定
  const loadedMtime = payload?.mtimeMs ?? null;
  useEffect(() => {
    if (!open || !absolutePath || loadedMtime === null) return;
    let cancelled = false;
    let timer: number | undefined;
    const tick = async () => {
      if (document.visibilityState === "visible" && !inflightRef.current) {
        try {
          const res = await fetch(`/api/system/local-file-stat?path=${encodeURIComponent(absolutePath)}`);
          if (!cancelled && res.ok) {
            const st = (await res.json()) as { exists: boolean; mtimeMs: number };
            if (!cancelled) {
              if (!st.exists) setStale("missing");
              else if (st.mtimeMs !== loadedMtime) {
                if (dirtyRef.current) setStale("changed");
                else {
                  setStale(null);
                  setReloadNonce((n) => n + 1);
                }
              } else {
                setStale(null);
              }
            }
          }
        } catch {
          // 网络抖动：下一轮再看
        }
      }
      if (!cancelled) timer = window.setTimeout(() => void tick(), STAT_POLL_MS);
    };
    timer = window.setTimeout(() => void tick(), STAT_POLL_MS);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [open, absolutePath, loadedMtime]);

  /** 编辑器保存成功：原子地更新 text / mtime / size（轮询据此不把自己的写入当成外部修改），再静默刷新衍生数据（表格 / 树 / 预览） */
  const handleSaved = useCallback((r: { text: string; mtimeMs: number; size: number }) => {
    setPayload((p) => (p ? { ...p, text: r.text, mtimeMs: r.mtimeMs, size: r.size, truncated: false } : p));
    setStale(null);
    setReloadNonce((n) => n + 1);
  }, []);

  /** 丢弃草稿、重新读盘（冲突条里「放弃我的修改并重新加载」；调用方已经让用户明确选择过了） */
  const reloadDiscarding = useCallback(() => {
    setResetKey((k) => k + 1);
    setReloadNonce((n) => n + 1);
    setStale(null);
  }, []);

  const handleReloadClick = async () => {
    if (dirtyRef.current) {
      const ok = await confirm({
        title: "放弃未保存的修改？",
        description: "重新加载会用磁盘上的最新内容替换编辑区。",
        confirmLabel: "放弃修改并重新加载",
        destructive: true,
        defaultFocus: "cancel",
      });
      if (!ok) return;
    }
    reloadDiscarding();
  };

  /** 关窗：有未保存修改先问一句（Esc / 点遮罩 / 右上角 X 都走这里） */
  const requestClose = useCallback(() => {
    if (!dirtyRef.current) {
      setOpen(false);
      return;
    }
    void (async () => {
      const ok = await confirmRef.current({
        title: "放弃未保存的修改？",
        description: "关闭预览后，没保存的修改会丢失。",
        confirmLabel: "放弃修改并关闭",
        destructive: true,
        defaultFocus: "cancel",
      });
      if (ok) {
        dirtyRef.current = false;
        setDirty(false);
        setOpen(false);
      }
    })();
  }, []);

  // 右侧只有一条位：代码改动面板 / 子代理抽屉打开时让位（后开的替换先开的）。
  // 走 requestClose：有未保存修改会先确认；用户取消确认 = 没关成，两条栏暂时叠着，由用户自己决定
  useRightDockSlot("file-preview", open, requestClose);

  const handleSelectSheet = useCallback((index: number) => {
    setSwitchingSheet(true);
    setSheetIndex(index);
  }, []);

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
    <LocalFilePreviewContext.Provider value={previewContext}>
      {children}
      {/*
        与代码改动面板 / 子代理抽屉同一套 Sheet + SheetContent：右侧非模态（不渲染蒙层、左边照常可点）、
        同一组开关动画、左上角 Close（Windows 右上角被系统窗口按钮占着，见 sheet.tsx）。
        禁止再手写 Portal/Popup，否则关栏会瞬间卸 DOM、退场动画跑不起来。
        Sheet 默认 disablePointerDismissal：连点不同文件链接只是换内容，点外面不会误关；Esc / 左上角 X 仍可关。
      */}
      <Sheet
        open={open}
        onOpenChange={(next) => {
          if (!next) requestClose();
        }}
      >
        <SheetContent
          className={cn(
            // bg-background：跟产物栏同一纸面色；别用默认的浅色弹层底，
            // 否则 Streamdown 表格 bg-background / 表头叠色会跟外面漂开。
            // 高度 = 视口高度（SheetContent 基类 inset-y-0，不随内容伸缩）：虚拟列表 / 编辑器 / 图片查看器都需要一个确定高度的容器，
            // 也避免加载前后栏的大小跳动。
            // 宽度两档，与代码改动面板同口径：标准 min(760px,70vw)；加宽留出左边 6rem（左上角有关闭键、macOS 窗口左上还有红绿灯）。
            "max-w-none gap-0 overflow-hidden bg-background p-0 text-foreground",
            wide ? "w-[calc(100vw-6rem)]" : "w-[min(760px,70vw)]",
          )}
        >
          {state ? (
            <>
              {/*
                顶栏：左身份；路径用 Tooltip（与文件夹/IDE 同套，不用原生 title）；
                文件动作一簇；关按钮走 SheetContent 内置（absolute top-1 left-2，故顶栏 pl-11 给它让位，
                垂直方向与第一行标题大致对齐）。
              */}
              <div className="flex shrink-0 items-center gap-2.5 border-b border-border/80 bg-muted/25 py-2.5 pr-3 pl-11">
                <Tooltip content={`.${extLabel}`}>
                  <span className="inline-flex h-6 shrink-0 items-center rounded-sm bg-info/10 px-1.5 font-mono text-[11px] font-medium uppercase tracking-wide text-info">
                    .{extLabel}
                  </span>
                </Tooltip>
                <div className="min-w-0 flex-1">
                  <SheetTitle className="truncate text-sm font-medium tracking-tight">
                    <Tooltip content={state.absolutePath}>
                      <span className="block truncate">{displayLabel}</span>
                    </Tooltip>
                    {dirty && <span className="ml-1.5 text-xs font-normal text-warning">● 未保存</span>}
                  </SheetTitle>
                  <SheetDescription className="sr-only">
                    {state.absolutePath}
                  </SheetDescription>
                  <div className="mt-0.5 flex min-w-0 items-center gap-2 text-[11px] text-muted-foreground">
                    <Tooltip content="点击复制路径">
                      <button
                        type="button"
                        onClick={() => void handleCopyPath()}
                        className="min-w-0 truncate text-left font-mono underline-offset-2 transition-colors hover:text-foreground hover:underline"
                      >
                        {pathShown}
                      </button>
                    </Tooltip>
                    {payload && (
                      <span className="shrink-0 tabular-nums">
                        {formatBytes(payload.size)} · {formatModified(payload.mtimeMs)}
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex shrink-0 items-center rounded-md border border-border/70 bg-background p-0.5">
                  <Tooltip content={wide ? "收窄预览" : "加宽预览"}>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      aria-label={wide ? "收窄预览" : "加宽预览"}
                      className="size-7 text-muted-foreground"
                      onClick={toggleWide}
                    >
                      {wide ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
                    </Button>
                  </Tooltip>
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
              {stale && (
                <div role="status" className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-warning/40 bg-warning/10 px-3 py-1.5 text-xs text-foreground">
                  <span>
                    {stale === "missing"
                      ? "这个文件已被删除或移走，下面显示的是之前载入的内容。"
                      : "文件在磁盘上被修改了，而你有未保存的修改，所以没有自动刷新。"}
                  </span>
                  {stale === "changed" && (
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      className="ml-auto h-6 px-2"
                      onClick={() => void handleReloadClick()}
                    >
                      放弃我的修改并重新加载
                    </Button>
                  )}
                </div>
              )}
              <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
                <LocalFilePreviewBody
                  data={payload}
                  loading={loading}
                  error={error}
                  line={state.line}
                  resetKey={resetKey}
                  onDirtyChange={handleDirtyChange}
                  onSaved={handleSaved}
                  onRequestReload={reloadDiscarding}
                  onSelectSheet={handleSelectSheet}
                  sheetLoading={switchingSheet}
                />
              </div>
            </>
          ) : null}
        </SheetContent>
      </Sheet>
    </LocalFilePreviewContext.Provider>
  );
};
