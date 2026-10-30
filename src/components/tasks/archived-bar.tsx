"use client";

import { Archive, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useRestoreArchived } from "@/hooks/use-restore-archived";
import type { Task } from "@/lib/types";
import { cn } from "@/lib/utils";

interface BarProps {
  /** 点「恢复归档」 */
  onRestore: () => void;
  /** 恢复请求在途：按钮禁用并转圈（真正的防重入在 useRestoreArchived 的 ref 里） */
  restoring?: boolean;
  className?: string;
}

/**
 * 「这个会话已归档」灰条（R14 B6-3 / Q3-03）：详情页原来完全不认 task.archived——
 * 从 Cmd+K 搜索 / 系统通知 / 定时管理页进到已归档会话，页面和正常会话一模一样，
 * 用户接着聊却不知道它在侧栏里已经看不见了。
 *
 * 它是信息提示 + 一键恢复、不是告警：中性灰底，role="note"（不打断读屏），语义 token，没有整块 opacity。
 * 文案只说「已归档、侧栏里不显示」：页面读不到「有没有被取消的定时」，所以不写「N 个定时已取消」，
 * 恢复后恢复了几个定时由 toast 说（取服务端回报）。
 * 在已归档会话里继续发消息 / 推进**不会**隐式取消归档（归档的对话后台继续跑本来就是既定语义），要恢复请点按钮。
 */
export const ArchivedBar = ({
  onRestore,
  restoring = false,
  className,
}: BarProps) => (
  <div
    role="note"
    className={cn(
      "flex shrink-0 items-center gap-2 border-b border-border bg-muted px-4 py-2 text-xs text-muted-foreground",
      className,
    )}
  >
    <Archive className="size-3.5 shrink-0" aria-hidden="true" />
    <p className="min-w-0 flex-1">这个会话已归档，侧栏里不显示。</p>
    <Button
      type="button"
      variant="outline"
      size="xs"
      disabled={restoring}
      onClick={onRestore}
    >
      {restoring ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
      恢复归档
    </Button>
  </div>
);

interface NoticeProps {
  task: Pick<Task, "id" | "title" | "pinned" | "archived">;
  /** 恢复成功后拿到服务端回报的任务（页面把本地 task 换成它） */
  onTaskUpdate: (updated: Task) => void;
}

/**
 * 自带恢复动作并决定画不画的容器——详情页（task / chat 两种形态）各放一行 `<ArchivedNotice … />` 即可。
 * hook 必须放在「没归档就不画」之前：archived 会在恢复成功那一刻从 true 变 false，
 * hook 的个数不能跟着变（React 会报「渲染的 hook 比上次少」）。
 */
export const ArchivedNotice = ({ task, onTaskUpdate }: NoticeProps) => {
  const { restore, restoring } = useRestoreArchived(task, onTaskUpdate);
  if (!task.archived) return null;
  return <ArchivedBar onRestore={() => void restore()} restoring={restoring} />;
};
