"use client";

/**
 * ChatWorkdirPicker：chat 自由对话「选工作目录」入口（V0.8）
 *
 * 放输入框下方 footer 左侧、跟 ChatModelPicker 并列。对齐 codex / Cursor Agents / VS Code
 * 的「Open Recent」模式：点开下拉 = 最近用过的目录一键切换 +「浏览…」选新目录 +
 *「改用主目录」重置。比每次弹原生对话框找路径快（高频在几个项目间来回切）。
 *
 * 硬约束（同切模型、用户拍板语义）：cwd 在 SDK run 启动时绑死——
 * - runStatus=running 时禁用：当前轮换不了、禁用避免误导
 * - 改了不重启：用户下条消息起的新 run 才用新目录
 *
 * 语义：
 * - task.repoPaths 为空 → 不绑、agent 起在主目录（getEffectiveCwd fallback）、显示「~」
 * - 选了文件夹 → repoPaths=[该路径]、显示其末段名（hover / 下拉里看完整路径）
 *
 * 最近目录：localStorage MRU（src/lib/recent-workdirs.ts、去重 + 上限 5）、纯本地便利、
 *   丢了重新积累即可、不进 config.json。
 *
 * 视觉：trigger 复用 ModelSelect compact 同款（边框 + h-7 + text-xs）、跟旁边模型选择器并排齐平。
 */

import {
  forwardRef,
  useImperativeHandle,
  useState,
} from "react";
import { ChevronDown, Folder, FolderOpen, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useHomeDir } from "@/hooks/use-home-dir";
import { pickNativePaths } from "@/lib/native-picker";
import { getRecentWorkdirs, pushRecentWorkdir } from "@/lib/recent-workdirs";
import { setTaskRepoPaths } from "@/lib/task-store";
import type { Task } from "@/lib/types";
import { cn } from "@/lib/utils";

interface Props {
  task: Task;
  onTaskUpdate: (next: Task) => void;
}

/** 警示条「绑定」等外部入口：打开下拉（最近 + 浏览） */
export interface ChatWorkdirPickerHandle {
  open: () => void;
}

// 路径取末段做展示名（去尾部斜杠）、空段兜底原值
const basename = (p: string): string => {
  const clean = p.replace(/\/+$/, "");
  const idx = clean.lastIndexOf("/");
  return idx >= 0 ? clean.slice(idx + 1) || clean : clean;
};

export const ChatWorkdirPicker = forwardRef<ChatWorkdirPickerHandle, Props>(
  ({ task, onTaskUpdate }, ref) => {
  // popover 开关（受控）
  const [open, setOpen] = useState(false);
  // 持久化飞行中：PATCH 期间禁用、防连点
  const [saving, setSaving] = useState(false);
  // 最近用过的工作目录（MRU）：打开 popover 时从 localStorage 刷新
  const [recent, setRecent] = useState<string[]>([]);

  // 主目录真实路径（os.homedir()、未绑目录时展示给用户看 agent 落在哪）
  const home = useHomeDir();
  // 当前工作目录（chat 只绑单个；空 = 未绑、agent 起在主目录）
  const current = task.repoPaths[0] ?? "";
  // 未绑 → 显示「~」（紧凑）、hover / popover 给完整真实路径
  const label = current ? basename(current) : "~";
  const running = task.runStatus === "running";
  // 最近列表排除「当前已绑」那个（顶部已单独展示、避免重复）
  const recentOthers = recent.filter((p) => p && p !== current);

  // 未指定工作目录时、给用户看 agent 落在哪的说明文案
  const unsetHint = home
    ? `未指定——agent 在主目录运行：${home}`
    : "未指定——agent 在主目录运行";

  useImperativeHandle(ref, () => ({
    open: () => {
      setRecent(getRecentWorkdirs());
      setOpen(true);
    },
  }));

  // 替换工作目录（空数组 = 改回主目录）、成功后记最近 + 关 popover
  const apply = async (paths: string[]) => {
    setSaving(true);
    try {
      const latest = await setTaskRepoPaths(task.id, paths);
      onTaskUpdate(latest);
      // 选了具体目录才进「最近」（空数组 = 改回主目录、不记）
      if (paths[0]) setRecent(pushRecentWorkdir(paths[0]));
      setOpen(false);
    } catch (err) {
      toast.error(`设置工作目录失败：${(err as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  // 浏览选新目录：先关 popover、再弹原生对话框（避免遮挡）；取消则不动
  const handleBrowse = async () => {
    setOpen(false);
    const picked = await pickNativePaths({
      mode: "folder",
      prompt: "选作对话的工作目录",
    });
    if (picked && picked.length > 0) await apply([picked[0]]);
  };

  // 打开时从 localStorage 拉最新「最近列表」（每次打开拿最新、不靠首渲染）
  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) setRecent(getRecentWorkdirs());
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger
        render={
          <button
            type="button"
            disabled={running || saving}
            title={current || unsetHint}
            // 视觉对齐 ModelSelect compact（src/components/ui/model-select.tsx）、并排齐平
            className={cn(
              "flex h-7 max-w-44 items-center gap-1.5 rounded-lg border border-input bg-transparent px-2.5 text-xs outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30 dark:hover:bg-input/50",
            )}
          >
            {saving ? (
              <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
            ) : (
              <Folder className="size-3.5 shrink-0 text-muted-foreground" />
            )}
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-left",
                !current && "text-muted-foreground",
              )}
            >
              {label}
            </span>
            <ChevronDown className="pointer-events-none size-3.5 shrink-0 text-muted-foreground" />
          </button>
        }
      />
      <PopoverContent align="start" sideOffset={6} className="w-80 p-0">
        {/* 顶部：当前工作目录 + 完整路径（不截断、避免「路径看不清」的痛点） */}
        <div className="border-b px-3 py-2">
          <div className="text-xs font-medium">工作目录</div>
          <div className="mt-0.5 text-xs text-muted-foreground wrap-anywhere">
            {current || unsetHint}
          </div>
        </div>

        {/* 最近用过的目录：一键切换（Open Recent 模式） */}
        {recentOthers.length > 0 && (
          <div className="border-b p-1">
            <div className="px-2 py-1 text-[11px] text-muted-foreground">
              最近
            </div>
            <ul className="max-h-52 overflow-y-auto">
              {recentOthers.map((p) => (
                <li key={p}>
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => void apply([p])}
                    className="flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent disabled:opacity-50"
                  >
                    <span className="flex items-center gap-1.5 text-sm">
                      <Folder className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 truncate">{basename(p)}</span>
                    </span>
                    <span
                      className="w-full truncate pl-5 font-mono text-[11px] text-muted-foreground"
                      title={p}
                    >
                      {p}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* 操作区：浏览选新目录 + 改回主目录 */}
        <div className="p-1">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="w-full justify-start gap-2"
            disabled={saving}
            onClick={handleBrowse}
          >
            <FolderOpen className="size-4" />
            浏览…
          </Button>
          {current && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="mt-1 w-full justify-start gap-2 text-muted-foreground"
              disabled={saving}
              onClick={() => void apply([])}
            >
              改用主目录
            </Button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
},
);

ChatWorkdirPicker.displayName = "ChatWorkdirPicker";
