"use client";

/**
 * 搜索 + 命令面板（Cmd/Ctrl+K 单一入口、cmdk 风格）
 *
 * - 无搜索词：命令条目（新建对话 / 设置 / 工作台 / 对话列表 / 快捷键表）
 * - 有搜索词：全文搜索（GET /api/search、标题 + 对话内容）+ 命中的命令
 * - 侧栏放大镜按钮打开；本组件自挂 Cmd/Ctrl+K keydown
 * - 原独立 CommandPalette 已并入本组件退役（2026-07-21、避免双 Cmd+K 心智）
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import {
  Keyboard,
  LayoutDashboard,
  MessageSquare,
  Plus,
  Search,
  Settings,
} from "lucide-react";

import { KeyboardShortcutsDialog } from "@/components/keyboard-shortcuts-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyHint } from "@/components/ui/empty-hint";
import { Input } from "@/components/ui/input";
import { LoadingState } from "@/components/ui/loading-state";
import { useNewChat } from "@/hooks/use-new-chat";
import { useTaskList } from "@/hooks/use-task-list";
import { isModCombo } from "@/lib/keyboard-shortcuts";
import type { TaskMode } from "@/lib/types";
import { cn } from "@/lib/utils";

const DEBOUNCE_MS = 300;

/** 与 /api/search 返回条目对齐（客户端自持、避免 import server 模块） */
type SearchHit = {
  taskId: string;
  title: string;
  mode: TaskMode;
  snippet?: string;
  matchedIn: "title" | "content";
  ts: number;
};

type SearchApiResponse = {
  ok: boolean;
  results?: SearchHit[];
  error?: string;
};

/** 命令条目（原命令面板 actions 并入） */
type CommandEntry = {
  key: string;
  label: string;
  icon: ReactNode;
  run: () => void;
};

/** 混合列表项：命令在前、搜索结果在后（键盘索引统一编号） */
type ListItem =
  | { kind: "command"; entry: CommandEntry }
  | { kind: "hit"; hit: SearchHit };

/** mode 徽章文案 */
const modeLabel = (mode: TaskMode): string =>
  mode === "chat" ? "对话" : "任务";

/**
 * 把 snippet / 标题里命中的 query 用 <mark> 高亮（大小写不敏感、逐段切）。
 */
const highlightMatch = (text: string, query: string): ReactNode => {
  const q = query.trim();
  if (!q || !text) return text;
  const lower = text.toLowerCase();
  const needle = q.toLowerCase();
  const parts: ReactNode[] = [];
  let cursor = 0;
  let i = 0;
  while (cursor < text.length) {
    const found = lower.indexOf(needle, cursor);
    if (found < 0) {
      parts.push(text.slice(cursor));
      break;
    }
    if (found > cursor) parts.push(text.slice(cursor, found));
    parts.push(
      <mark
        key={`m-${i++}`}
        className="rounded-sm bg-primary/20 px-0.5 text-primary"
      >
        {text.slice(found, found + q.length)}
      </mark>,
    );
    cursor = found + q.length;
  }
  return parts.length === 1 ? parts[0] : parts;
};

export const SearchDialog = () => {
  const router = useRouter();
  const { upsertTask } = useTaskList();
  // 面板开关
  const [open, setOpen] = useState(false);
  // 快捷键表弹窗（命令条目唤起、原 global-shortcuts 持有的状态并入）
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  // 搜索框文案
  const [query, setQuery] = useState("");
  // debounce 后真正用来请求的词
  const [debouncedQuery, setDebouncedQuery] = useState("");
  // 结果列表
  const [results, setResults] = useState<SearchHit[]>([]);
  // 请求中
  const [loading, setLoading] = useState(false);
  // 键盘高亮索引
  const [activeIndex, setActiveIndex] = useState(0);
  // 列表容器：高亮项滚进视口
  const listRef = useRef<HTMLDivElement | null>(null);
  // 最新请求序号：丢弃过期响应
  const reqSeqRef = useRef(0);

  // 新建对话：与侧栏同一 hook（插列表 + 跳详情）
  const { createChat } = useNewChat((task) => {
    upsertTask(task);
    router.push(`/tasks/${task.id}`);
  });

  // Cmd/Ctrl+K 全局唤起（mounted 期间生效）
  useEffect(() => {
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (!isModCombo(e, "k")) return;
      e.preventDefault();
      setOpen((v) => !v);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // 打开时清空状态
  useEffect(() => {
    if (open) {
      setQuery("");
      setDebouncedQuery("");
      setResults([]);
      setLoading(false);
      setActiveIndex(0);
    }
  }, [open]);

  // 输入 debounce
  useEffect(() => {
    const t = window.setTimeout(() => {
      setDebouncedQuery(query);
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [query]);

  // 调搜索 API
  useEffect(() => {
    const q = debouncedQuery.trim();
    if (!open) return;
    if (!q) {
      setResults([]);
      setLoading(false);
      return;
    }

    const seq = ++reqSeqRef.current;
    setLoading(true);
    const ac = new AbortController();

    void (async () => {
      try {
        const res = await fetch(
          `/api/search?q=${encodeURIComponent(q)}`,
          { signal: ac.signal },
        );
        const data = (await res.json()) as SearchApiResponse;
        if (seq !== reqSeqRef.current) return;
        setResults(data.ok && Array.isArray(data.results) ? data.results : []);
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        if (seq !== reqSeqRef.current) return;
        setResults([]);
      } finally {
        if (seq === reqSeqRef.current) setLoading(false);
      }
    })();

    return () => ac.abort();
  }, [debouncedQuery, open]);

  const close = useCallback(() => setOpen(false), []);

  const goTo = useCallback(
    (taskId: string) => {
      close();
      router.push(`/tasks/${taskId}`);
    },
    [close, router],
  );

  // 命令条目：每渲染重算（O(常数)、run 闭包引用每渲染都新、memo 反而要 disable 依赖）
  const buildCommands = (): CommandEntry[] => {
    const q = query.trim().toLowerCase();
    const all: CommandEntry[] = [
      {
        key: "__new_chat__",
        label: "新建对话",
        icon: <Plus className="size-4" />,
        run: () => {
          close();
          void createChat();
        },
      },
      {
        key: "__settings__",
        label: "打开设置",
        icon: <Settings className="size-4" />,
        run: () => {
          close();
          router.push("/settings");
        },
      },
      {
        key: "__work_tab__",
        label: "打开工作台",
        icon: <LayoutDashboard className="size-4" />,
        run: () => {
          close();
          router.push("/");
        },
      },
      {
        key: "__chat_tab__",
        label: "打开对话列表",
        icon: <MessageSquare className="size-4" />,
        run: () => {
          close();
          router.push("/chats");
        },
      },
      {
        key: "__shortcuts__",
        label: "键盘快捷键",
        icon: <Keyboard className="size-4" />,
        run: () => {
          close();
          setShortcutsOpen(true);
        },
      },
    ];
    return q ? all.filter((a) => a.label.toLowerCase().includes(q)) : all;
  };

  const trimmed = query.trim();
  const commands = buildCommands();
  // 混合列表：命令在前、搜索结果在后（键盘索引统一编号）
  const items: ListItem[] = [
    ...commands.map((entry): ListItem => ({ kind: "command", entry })),
    ...results.map((hit): ListItem => ({ kind: "hit", hit })),
  ];

  // 列表内容变化时高亮回到第一条
  useEffect(() => {
    setActiveIndex(0);
  }, [results, debouncedQuery]);

  const runActive = () => {
    const item = items[activeIndex];
    if (!item) return;
    if (item.kind === "command") item.entry.run();
    else goTo(item.hit.taskId);
  };

  const onListKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => (items.length ? (i + 1) % items.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) =>
        items.length ? (i - 1 + items.length) % items.length : 0,
      );
    } else if (e.key === "Enter") {
      e.preventDefault();
      runActive();
    }
  };

  // 高亮项滚进视口
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-search-index="${activeIndex}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const showEmpty = !loading && trimmed.length > 0 && items.length === 0;

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label="搜索对话"
        onClick={() => setOpen(true)}
        className="shrink-0"
      >
        <Search className="size-4" />
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          showCloseButton={false}
          className="gap-0 p-0 sm:max-w-lg"
          onKeyDown={onListKeyDown}
        >
          <DialogTitle className="sr-only">搜索对话</DialogTitle>
          <div className="border-b p-2">
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索对话或命令…"
              autoFocus
              className="h-8 border-none shadow-none focus-visible:ring-0 dark:bg-transparent"
            />
          </div>
          <div ref={listRef} className="max-h-80 overflow-y-auto p-1.5">
            {showEmpty ? (
              <EmptyHint size="sm" align="center">
                没有匹配结果
              </EmptyHint>
            ) : (
              <>
                {items.map((item, i) =>
                  item.kind === "command" ? (
                    <button
                      key={item.entry.key}
                      type="button"
                      data-search-index={i}
                      onClick={item.entry.run}
                      onMouseEnter={() => setActiveIndex(i)}
                      className={cn(
                        "flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm",
                        // 键盘高亮是瞬时态、走 accent（选中态规范只管持久选中）
                        i === activeIndex && "bg-accent text-accent-foreground",
                      )}
                    >
                      <span className="shrink-0 text-muted-foreground">
                        {item.entry.icon}
                      </span>
                      <span className="min-w-0 flex-1 truncate">
                        {highlightMatch(item.entry.label, trimmed)}
                      </span>
                      <span className="shrink-0 text-[10px] text-muted-foreground/70">
                        操作
                      </span>
                    </button>
                  ) : (
                    <button
                      key={item.hit.taskId}
                      type="button"
                      data-search-index={i}
                      onClick={() => goTo(item.hit.taskId)}
                      onMouseEnter={() => setActiveIndex(i)}
                      className={cn(
                        "flex w-full cursor-pointer flex-col gap-0.5 rounded-md px-2.5 py-2 text-left",
                        i === activeIndex && "bg-accent text-accent-foreground",
                      )}
                    >
                      <div className="flex items-center gap-2">
                        <span className="min-w-0 flex-1 truncate text-sm">
                          {highlightMatch(item.hit.title || "未命名", trimmed)}
                        </span>
                        <Badge
                          variant="secondary"
                          className="shrink-0 text-[10px]"
                        >
                          {modeLabel(item.hit.mode)}
                        </Badge>
                      </div>
                      {item.hit.snippet ? (
                        <span className="line-clamp-2 text-xs text-muted-foreground">
                          {highlightMatch(item.hit.snippet, trimmed)}
                        </span>
                      ) : null}
                    </button>
                  ),
                )}
                {loading && (
                  <LoadingState variant="inline" className="block px-3 py-2" />
                )}
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <KeyboardShortcutsDialog
        open={shortcutsOpen}
        onOpenChange={setShortcutsOpen}
      />
    </>
  );
};
