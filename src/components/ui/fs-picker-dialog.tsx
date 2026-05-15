"use client";

/**
 * 服务端文件系统选择对话框
 *
 * 解决问题：浏览器沙箱拿不到绝对路径、osascript 只支持 macOS。
 *   走 /api/fs/list 在 server 端读目录、UI 翻目录后拿到的就是 server 真实的绝对路径。
 *
 * 复用场景：
 *   - 设置页「选仓库」（mode="dir" + 单选）
 *   - chat 输入「附文件 / 附文件夹」（mode="any" + 多选）
 *
 * 设计要点：
 *   - 列表 + 顶部路径栏（Finder 风、用户最熟）、不做树状（大目录会卡）
 *   - 顶部一行 shortcuts chip：主目录 / Documents / Desktop / Downloads / 当前项目
 *   - localStorage 记上次所在目录、下次自动回去（首次走 server 的 home）
 *   - 双击目录进入 / 单击选中（多选时 cmd / ctrl 多选）
 *   - 路径栏可直接编辑（粘贴绝对路径、回车跳转）
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUp,
  ChevronRight,
  File as FileIcon,
  Folder,
  Home,
  Loader2,
  RotateCcw,
} from "lucide-react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { FsEntry, FsListResponse } from "@/app/api/fs/list/route";
import type { FsHomeResponse, FsHomeShortcut } from "@/app/api/fs/home/route";

// localStorage 键：记上次浏览到哪、下次打开自动回去
// 用 mode 分键、避免 chat 附文件 / 设置选仓库互相干扰
const lastPathKey = (mode: PickerMode): string =>
  `fe-ai-flow:fs-picker:last-path:${mode}`;

type PickerMode = "dir" | "file" | "any";

interface FsPickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // 选什么：dir = 仅目录、file = 仅文件、any = 都可以
  mode: PickerMode;
  // 是否允许多选（默认 false）
  multiple?: boolean;
  title?: string;
  description?: string;
  // 起始路径（外部强制指定）；不传则用 localStorage 上次 / home
  initialPath?: string;
  // 用户点「确认」时回调、传选中的绝对路径列表（即使单选也是数组、统一接口）
  onConfirm: (paths: string[]) => void;
}

// 把 size bytes 格式化成人类可读
const formatSize = (bytes?: number): string => {
  if (bytes == null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
};

// 把绝对路径切成面包屑段
// /Users/foo/bar → [{name: "/", path: "/"}, {name: "Users", path: "/Users"}, ...]
const splitBreadcrumb = (
  abs: string,
): Array<{ name: string; path: string }> => {
  if (!abs || abs === "/") return [{ name: "/", path: "/" }];
  const segs = abs.split("/").filter(Boolean);
  const out: Array<{ name: string; path: string }> = [
    { name: "/", path: "/" },
  ];
  let cur = "";
  for (const s of segs) {
    cur += `/${s}`;
    out.push({ name: s, path: cur });
  }
  return out;
};

export const FsPickerDialog = ({
  open,
  onOpenChange,
  mode,
  multiple = false,
  title,
  description,
  initialPath,
  onConfirm,
}: FsPickerDialogProps) => {
  // 当前所在目录的绝对路径
  const [currentPath, setCurrentPath] = useState<string>("");
  // 当前目录下的 entries（已按目录优先 + 字母序）
  const [entries, setEntries] = useState<FsEntry[]>([]);
  // 选中的项（绝对路径集合）；单选模式只会有 0/1 项
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // 是否显示隐藏文件
  const [showHidden, setShowHidden] = useState(false);
  // server 端 home / shortcuts、一次性 load
  const [homeInfo, setHomeInfo] = useState<FsHomeResponse | null>(null);
  // 路径输入框的草稿值（用户可手动改、回车跳转）
  const [pathDraft, setPathDraft] = useState<string>("");
  // 加载状态
  const [loading, setLoading] = useState(false);
  // 错误消息（路径不存在 / 无权限等、列表区直接展示）
  const [errorMsg, setErrorMsg] = useState<string>("");

  // 滚动容器、切目录时滚到顶
  const listRef = useRef<HTMLDivElement | null>(null);

  // 切换目录：list API + 更新 currentPath + 清选中 + 记 localStorage
  // 不依赖 React state 顺序、传 path 进来直接用
  const navigate = useCallback(
    async (target: string, opts?: { keepSelection?: boolean }) => {
      setLoading(true);
      setErrorMsg("");
      try {
        const url = `/api/fs/list?path=${encodeURIComponent(target)}&showHidden=${showHidden}`;
        const res = await fetch(url);
        const json = (await res.json()) as FsListResponse | { error?: string };
        if (!res.ok) {
          const msg = (json as { error?: string }).error || `读取失败 (${res.status})`;
          setErrorMsg(msg);
          // 即便失败也不动 currentPath、让用户改路径栏重试
          return;
        }
        const ok = json as FsListResponse;
        setCurrentPath(ok.path);
        setEntries(ok.entries);
        setPathDraft(ok.path);
        if (!opts?.keepSelection) setSelected(new Set());
        // 记上次目录
        try {
          window.localStorage.setItem(lastPathKey(mode), ok.path);
        } catch {
          // localStorage 满 / 禁用、忽略
        }
        // 滚到顶
        if (listRef.current) listRef.current.scrollTop = 0;
      } catch (err) {
        setErrorMsg(
          `网络错误：${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        setLoading(false);
      }
    },
    [showHidden, mode],
  );

  // 首次 open 时、load home info + 决定起始路径
  // 优先级：props.initialPath > localStorage > home
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/fs/home");
        const json = (await res.json()) as FsHomeResponse;
        if (cancelled) return;
        setHomeInfo(json);
        let start = initialPath;
        if (!start) {
          try {
            start = window.localStorage.getItem(lastPathKey(mode)) ?? undefined;
          } catch {
            // ignore
          }
        }
        if (!start) start = json.home;
        await navigate(start);
      } catch (err) {
        if (!cancelled) {
          toast.error(
            `无法加载文件系统信息：${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // initialPath 变了一般是新一次 open、重置；navigate / mode 也参与
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // 切换 showHidden 时重新拉当前目录（保持选中、避免一切换就清）
  useEffect(() => {
    if (!open || !currentPath) return;
    void navigate(currentPath, { keepSelection: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showHidden]);

  // 关闭时重置选中、避免下次开还残留
  // currentPath / showHidden 不重置（用户希望「回到上次」、跨 open 保留）
  useEffect(() => {
    if (!open) setSelected(new Set());
  }, [open]);

  // 哪些 entry 可被点中选中（结合 mode）
  // - dir 模式：只能选目录
  // - file 模式：只能选文件
  // - any 模式：都行
  const canSelect = useCallback(
    (e: FsEntry): boolean => {
      if (mode === "dir") return e.isDir;
      if (mode === "file") return !e.isDir;
      return true;
    },
    [mode],
  );

  // 单击行：可选项 → 选 / 取消选；双击在 onDoubleClick 处理
  const handleRowClick = (
    e: FsEntry,
    ev: React.MouseEvent<HTMLDivElement>,
  ) => {
    if (!canSelect(e)) return;
    const next = new Set(selected);
    if (multiple && (ev.metaKey || ev.ctrlKey)) {
      // 多选 + cmd/ctrl：toggle
      if (next.has(e.absPath)) next.delete(e.absPath);
      else next.add(e.absPath);
    } else if (multiple) {
      // 多选无修饰键：单选这一个、清其它（更符合用户预期、不会误加）
      next.clear();
      next.add(e.absPath);
    } else {
      // 单选：清掉旧的、加新的
      next.clear();
      next.add(e.absPath);
    }
    setSelected(next);
  };

  // 双击：目录就进入、文件就直接确认（如果该模式下可选）
  const handleRowDoubleClick = (e: FsEntry) => {
    if (e.isDir) {
      void navigate(e.absPath);
      return;
    }
    if (!canSelect(e)) return;
    // 双击文件 = 直接确认（单选模式更顺手）
    onConfirm([e.absPath]);
    onOpenChange(false);
  };

  // 路径栏回车跳转
  const handlePathInputKey = (ev: React.KeyboardEvent<HTMLInputElement>) => {
    if (ev.key === "Enter") {
      const v = pathDraft.trim();
      if (v) void navigate(v);
    }
  };

  // 「上级目录」按钮
  const handleGoUp = () => {
    if (!currentPath) return;
    const idx = currentPath.lastIndexOf("/");
    if (idx <= 0) {
      void navigate("/");
    } else {
      void navigate(currentPath.slice(0, idx));
    }
  };

  // 「确认」：根据 mode 决定 selectedList 来源
  // - dir 单选：如果用户没选具体子目录、把 currentPath 当作选中目录（最常见操作：进到目标目录就点确认）
  // - 其它模式：必须有选中项才能确认
  const handleConfirm = () => {
    const arr = Array.from(selected);
    if (arr.length === 0 && mode === "dir" && !multiple && currentPath) {
      onConfirm([currentPath]);
      onOpenChange(false);
      return;
    }
    if (arr.length === 0) {
      toast.error(
        mode === "dir"
          ? "请选择一个目录"
          : mode === "file"
            ? "请选择至少一个文件"
            : "请选择至少一个文件或目录",
      );
      return;
    }
    onConfirm(arr);
    onOpenChange(false);
  };

  const breadcrumbs = useMemo(
    () => splitBreadcrumb(currentPath),
    [currentPath],
  );

  const finalTitle =
    title ??
    (mode === "dir"
      ? "选择目录"
      : mode === "file"
        ? "选择文件"
        : "选择文件 / 目录");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-3xl"
        // Dialog 默认 max-w-sm 太窄、file picker 至少要 600~800 宽
      >
        <DialogHeader>
          <DialogTitle>{finalTitle}</DialogTitle>
          {description ? (
            <DialogDescription>{description}</DialogDescription>
          ) : null}
        </DialogHeader>

        {/* 顶部工具栏：上级 / 路径输入 / 刷新 */}
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={handleGoUp}
            disabled={!currentPath || loading}
            title="上级目录"
          >
            <ArrowUp />
          </Button>
          <Input
            value={pathDraft}
            onChange={(e) => setPathDraft(e.target.value)}
            onKeyDown={handlePathInputKey}
            placeholder="绝对路径、回车跳转"
            className="flex-1 font-mono text-xs"
            spellCheck={false}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={() => currentPath && void navigate(currentPath, { keepSelection: true })}
            disabled={loading}
            title="刷新"
          >
            {loading ? <Loader2 className="animate-spin" /> : <RotateCcw />}
          </Button>
        </div>

        {/* 快捷入口 chips */}
        {homeInfo && (
          <div className="flex flex-wrap gap-1.5">
            {homeInfo.shortcuts.map((sc: FsHomeShortcut) => (
              <Button
                key={sc.path}
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void navigate(sc.path)}
                className="h-7 gap-1 px-2 text-xs"
              >
                {sc.label === "主目录" ? <Home className="size-3" /> : null}
                {sc.label}
              </Button>
            ))}
          </div>
        )}

        {/* 面包屑 */}
        <div className="flex min-h-5 flex-wrap items-center gap-0.5 text-xs text-muted-foreground">
          {breadcrumbs.map((bc, i) => (
            <span key={bc.path} className="flex items-center gap-0.5">
              {i > 0 && <ChevronRight className="size-3" />}
              <button
                type="button"
                onClick={() => void navigate(bc.path)}
                className="rounded px-1 hover:bg-muted hover:text-foreground"
              >
                {bc.name}
              </button>
            </span>
          ))}
        </div>

        {/* 列表区 */}
        <div
          ref={listRef}
          className="h-[360px] overflow-y-auto rounded-md border bg-card/30"
        >
          {errorMsg ? (
            <div className="p-4 text-xs text-destructive">{errorMsg}</div>
          ) : entries.length === 0 && !loading ? (
            <div className="p-4 text-xs text-muted-foreground">
              （空目录）
            </div>
          ) : (
            <div className="flex flex-col">
              {entries.map((e) => {
                const isSel = selected.has(e.absPath);
                const selectable = canSelect(e);
                return (
                  <div
                    key={e.absPath}
                    role="button"
                    tabIndex={0}
                    onClick={(ev) => handleRowClick(e, ev)}
                    onDoubleClick={() => handleRowDoubleClick(e)}
                    className={cn(
                      "flex cursor-pointer items-center gap-2 border-b px-3 py-1.5 text-xs",
                      "hover:bg-muted/50",
                      isSel && "bg-primary/10 hover:bg-primary/15",
                      !selectable && "opacity-60",
                    )}
                    title={e.absPath}
                  >
                    {e.isDir ? (
                      <Folder className="size-4 shrink-0 text-amber-500" />
                    ) : (
                      <FileIcon className="size-4 shrink-0 text-muted-foreground" />
                    )}
                    <span className="min-w-0 flex-1 truncate">{e.name}</span>
                    <span className="shrink-0 text-muted-foreground/70">
                      {e.isDir ? "" : formatSize(e.sizeBytes)}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* 底部：show hidden + 已选 + 操作 */}
        <DialogFooter className="flex-row items-center justify-between gap-2 sm:justify-between">
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={showHidden}
                onChange={(e) => setShowHidden(e.target.checked)}
                className="size-3"
              />
              显示隐藏
            </label>
            <span>
              已选 {selected.size}
              {multiple ? "" : " / 1"} 项
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
            >
              取消
            </Button>
            <Button type="button" onClick={handleConfirm}>
              确认
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
