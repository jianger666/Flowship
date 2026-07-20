"use client";

/**
 * 命令面板（C 批次、grok P1）：Cmd/Ctrl+K 唤起
 *
 * 条目：新建对话 / 切换到某对话（chat 任务、搜标题）/ 打开设置 /
 * 工作台 / 对话 tab / 键盘快捷键表。选中即执行（路由跳转 / 打开弹窗）。
 * 项目 shadcn 体系是 base-ui（无 cmdk command 组件）——Dialog + 输入 + 列表自拼。
 * 唤起注册在 global-shortcuts.tsx（统一 keydown 入口）、本组件只管受控展示。
 */

import {
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
  MessageSquareText,
  Plus,
  Settings,
} from "lucide-react";

import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { EmptyHint } from "@/components/ui/empty-hint";
import { useNewChat } from "@/hooks/use-new-chat";
import { useTaskList } from "@/hooks/use-task-list";

/** 无搜索词时对话列表最多显示条数（有搜索词时放宽到全量匹配） */
const RECENT_CHAT_LIMIT = 20;

interface PaletteEntry {
  key: string;
  label: string;
  icon: ReactNode;
  /** 右侧小注（如「操作」/ 相对时间）；可省 */
  hint?: string;
  run: () => void;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 「键盘快捷键」条目选中回调（global-shortcuts 打开快捷键表弹窗） */
  onShowShortcuts: () => void;
}

export const CommandPalette = ({ open, onOpenChange, onShowShortcuts }: Props) => {
  const router = useRouter();
  const { tasks, upsertTask } = useTaskList();
  // 搜索词（每次打开清空、从头搜）
  const [query, setQuery] = useState("");
  // 键盘高亮索引（↑↓ 移动、Enter 执行）
  const [activeIndex, setActiveIndex] = useState(0);
  // 列表容器：高亮项滚进视口用
  const listRef = useRef<HTMLDivElement | null>(null);

  // 新建对话：与侧栏同一 hook（插列表 + 跳详情）
  const { createChat } = useNewChat((task) => {
    upsertTask(task);
    router.push(`/tasks/${task.id}`);
  });

  // 打开时重置搜索与高亮
  useEffect(() => {
    if (open) {
      setQuery("");
      setActiveIndex(0);
    }
  }, [open]);

  const close = () => onOpenChange(false);

  // 每渲染直接重算（不 useMemo）：条目构造 O(任务数)、很便宜，
  // 且 run 闭包里 close / createChat / router 都是每渲染新引用、memo 化反而要 disable 依赖检查
  const buildEntries = (): PaletteEntry[] => {
    const q = query.trim().toLowerCase();
    const matches = (label: string) => !q || label.toLowerCase().includes(q);

    const actions: PaletteEntry[] = [
      {
        key: "__new_chat__",
        label: "新建对话",
        icon: <Plus className="size-4" />,
        hint: "操作",
        run: () => {
          close();
          void createChat();
        },
      },
      {
        key: "__settings__",
        label: "打开设置",
        icon: <Settings className="size-4" />,
        hint: "操作",
        run: () => {
          close();
          router.push("/settings");
        },
      },
      {
        key: "__work_tab__",
        label: "打开工作台",
        icon: <LayoutDashboard className="size-4" />,
        hint: "操作",
        run: () => {
          close();
          router.push("/");
        },
      },
      {
        key: "__chat_tab__",
        label: "打开对话列表",
        icon: <MessageSquare className="size-4" />,
        hint: "操作",
        run: () => {
          close();
          router.push("/chats");
        },
      },
      {
        key: "__shortcuts__",
        label: "键盘快捷键",
        icon: <Keyboard className="size-4" />,
        hint: "操作",
        run: () => {
          close();
          onShowShortcuts();
        },
      },
    ].filter((a) => matches(a.label));

    // chat 对话：搜标题、按最近更新排；无搜索词时截断到最近 N 条
    const chats = tasks
      .filter((t) => t.mode === "chat" && matches(t.title))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, q ? 100 : RECENT_CHAT_LIMIT)
      .map(
        (t): PaletteEntry => ({
          key: t.id,
          label: t.title || "未命名对话",
          icon: <MessageSquareText className="size-4" />,
          hint: "对话",
          run: () => {
            close();
            router.push(`/tasks/${t.id}`);
          },
        }),
      );

    return [...actions, ...chats];
  };
  const entries = buildEntries();

  // 搜索词变化后高亮回到第一条（entries 长度可能缩短）
  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  const runActive = () => {
    const entry = entries[activeIndex];
    if (entry) entry.run();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => (entries.length ? (i + 1) % entries.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) =>
        entries.length ? (i - 1 + entries.length) % entries.length : 0,
      );
    } else if (e.key === "Enter") {
      e.preventDefault();
      runActive();
    }
  };

  // 高亮项滚进视口（键盘连按 ↓ 超出可视区时）
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-palette-index="${activeIndex}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="gap-0 p-0 sm:max-w-lg"
        onKeyDown={onKeyDown}
      >
        <DialogTitle className="sr-only">命令面板</DialogTitle>
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
          {entries.length === 0 ? (
            <EmptyHint size="sm" align="center">
              没有匹配的对话或命令
            </EmptyHint>
          ) : (
            entries.map((entry, i) => (
              <button
                key={entry.key}
                type="button"
                data-palette-index={i}
                onClick={entry.run}
                onMouseEnter={() => setActiveIndex(i)}
                className={cn(
                  "flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm",
                  // 键盘高亮是瞬时态、走 accent（选中态规范只管持久选中）
                  i === activeIndex && "bg-accent text-accent-foreground",
                )}
              >
                <span className="shrink-0 text-muted-foreground">
                  {entry.icon}
                </span>
                <span className="min-w-0 flex-1 truncate">{entry.label}</span>
                {entry.hint && (
                  <span className="shrink-0 text-[10px] text-muted-foreground/70">
                    {entry.hint}
                  </span>
                )}
              </button>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
};
