"use client";

/**
 * ChatWorkdirPicker：chat 自由对话「选工作目录」入口（V0.8）
 *
 * 放输入框下方 footer 左侧、跟 ChatModelPicker 并列。对齐 codex / Cursor Agent Window 的体验：
 * 不进设置页配仓库、直接用原生 picker 选一个文件夹当 agent 的 cwd。
 *
 * 硬约束（同切模型、用户拍板语义）：cwd 在 SDK run 启动时绑死——
 * - runStatus=running 时禁用：当前轮换不了、禁用避免误导
 * - 改了不重启：用户下条消息起的新 run 才用新目录
 *
 * 语义：
 * - task.repoPaths 为空 → 不绑、agent 起在 ai-flow 项目本身（getEffectiveCwd fallback）、显示「项目本身」
 * - 选了文件夹 → repoPaths=[该路径]、显示其末段名（hover trigger 看完整路径）
 *
 * 视觉：trigger 复用 ModelSelect compact 同款（边框 + h-7 + text-xs）、跟旁边的模型选择器并排齐平。
 */

import { useState } from "react";
import { ChevronDown, Folder, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useHomeDir } from "@/hooks/use-home-dir";
import { pickNativePaths } from "@/lib/native-picker";
import { setTaskRepoPaths } from "@/lib/task-store";
import type { Task } from "@/lib/types";
import { cn } from "@/lib/utils";

interface Props {
  task: Task;
  onTaskUpdate: (next: Task) => void;
}

// 路径取末段做展示名（去尾部斜杠）、空段兜底原值
const basename = (p: string): string => {
  const clean = p.replace(/\/+$/, "");
  const idx = clean.lastIndexOf("/");
  return idx >= 0 ? clean.slice(idx + 1) || clean : clean;
};

export const ChatWorkdirPicker = ({ task, onTaskUpdate }: Props) => {
  // popover 开关（受控）
  const [open, setOpen] = useState(false);
  // 持久化飞行中：PATCH 期间禁用、防连点
  const [saving, setSaving] = useState(false);

  // 主目录真实路径（os.homedir()、未绑目录时展示给用户看 agent 落在哪）
  const home = useHomeDir();
  // 当前工作目录（chat 只绑单个；空 = 未绑、agent 起在主目录）
  const current = task.repoPaths[0] ?? "";
  // 未绑 → 显示「~」（紧凑）、hover / popover 给完整真实路径
  const label = current ? basename(current) : "~";
  const running = task.runStatus === "running";

  // 替换工作目录（空数组 = 改回项目本身），成功后关 popover
  const apply = async (paths: string[]) => {
    setSaving(true);
    try {
      const latest = await setTaskRepoPaths(task.id, paths);
      onTaskUpdate(latest);
      setOpen(false);
    } catch (err) {
      toast.error(`设置工作目录失败：${(err as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  // 选文件夹：先关 popover、再弹原生对话框（避免遮挡）；取消则不动
  const handlePick = async () => {
    setOpen(false);
    const picked = await pickNativePaths({
      mode: "folder",
      prompt: "选作对话的工作目录",
    });
    if (picked && picked.length > 0) await apply([picked[0]]);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            disabled={running || saving}
            title={
              current ||
              (home
                ? `未指定工作目录、agent 在主目录运行：${home}`
                : "未指定工作目录、agent 在主目录运行")
            }
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
      <PopoverContent align="start" sideOffset={6} className="w-72 p-2">
        <div className="px-1 pb-1.5 pt-0.5">
          <div className="text-xs font-medium">工作目录</div>
          <div className="mt-1 text-xs text-muted-foreground wrap-anywhere">
            {current ||
              (home
                ? `未指定——agent 在主目录运行：${home}`
                : "未指定——agent 在主目录运行")}
          </div>
        </div>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="w-full justify-start gap-2"
          disabled={saving}
          onClick={handlePick}
        >
          <Folder className="size-4" />
          选择文件夹…
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
      </PopoverContent>
    </Popover>
  );
};
