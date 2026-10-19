"use client";

/**
 * 一条定时的操作按钮组（会话内定时条的弹层 / 定时任务管理页共用）。
 *
 * 按状态给不同的按钮——不给「做不了」的操作留灰按钮：
 * - 进行中：立即触发 · 暂停 · 取消
 * - 已暂停：立即触发 · 恢复 · 取消
 * - 已错过（一次性没触发成）：立即触发 · 删除记录
 * - 已完成 / 已取消：删除记录
 *
 * 操作都走服务端、成功后通知父组件重新拉列表（本组件不持有列表）。
 *
 * - **busy 一直撑到列表刷新回来**：操作成功后列表还是旧的（按钮还在）——这时清 busy 的话，
 *   用户在刷新返回前再点一次「立即触发」就会连发两条消息；所以 `onChanged` 返回 Promise 时要等它落定。
 * - **破坏性操作（取消 / 删除记录）两步确认**：第一下只是「上膛」（按钮变成「确认取消 / 确认删除」，3 秒内再点才真做，
 *   失焦 / 超时自动撤回）。不用弹窗：这组按钮常在 Popover 里，再叠一层弹窗要处理两层浮层的外点关闭。
 *   上膛前后是同一个按钮元素（换 props、不换元素树）——焦点就留在刚点的那个按钮上，不用 autoFocus。
 */

import { useEffect, useState } from "react";
import { Loader2, Pause, Play, Trash2, X, Zap } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { runScheduleAction, type ScheduleAction } from "@/lib/schedule-client";
import { availableScheduleActions, type ScheduleRecord } from "@/lib/schedule";

interface ButtonSpec {
  action: ScheduleAction;
  label: string;
  icon: typeof Zap;
  destructive?: boolean;
}

/** 破坏性操作「上膛」后等第二下确认的时间窗 */
export const CONFIRM_WINDOW_MS = 3000;

/** 哪些状态出哪些按钮由 `availableScheduleActions`（纯函数、有单测）决定，这里只管长相 */
const SPECS: Record<ScheduleAction, ButtonSpec> = {
  fire: { action: "fire", label: "立即触发", icon: Zap },
  pause: { action: "pause", label: "暂停", icon: Pause },
  resume: { action: "resume", label: "恢复", icon: Play },
  cancel: { action: "cancel", label: "取消", icon: X, destructive: true },
  remove: { action: "remove", label: "删除记录", icon: Trash2, destructive: true },
};

export const ScheduleActions = ({
  record,
  onChanged,
}: {
  record: ScheduleRecord;
  /** 操作成功后调：父组件据此重新拉列表。返回 Promise 的话本组件会等它落定再放开按钮 */
  onChanged: () => void | Promise<void>;
}) => {
  const [busy, setBusy] = useState<ScheduleAction | null>(null);
  // 已「上膛」等第二下确认的破坏性操作
  const [armed, setArmed] = useState<ScheduleAction | null>(null);

  useEffect(() => {
    if (!armed) return;
    const id = window.setTimeout(() => setArmed(null), CONFIRM_WINDOW_MS);
    return () => window.clearTimeout(id);
  }, [armed]);

  const run = async (spec: ButtonSpec): Promise<void> => {
    if (busy) return;
    if (spec.destructive && armed !== spec.action) {
      setArmed(spec.action);
      return;
    }
    setArmed(null);
    setBusy(spec.action);
    try {
      try {
        const r = await runScheduleAction(record.taskId, record.id, spec.action);
        if (spec.action === "fire") {
          if (r.outcome === "delivered") toast.success("已送进会话");
          else if (r.outcome === "retry") toast("会话这会儿接不了，空出来后会自动送达");
          else toast.error("没能送进会话，详情见会话里的提示");
        }
      } catch (err) {
        toast.error(`${spec.label}失败：${(err as Error).message}`);
      }
      // 成败都刷新（失败时状态可能已被别处改过，如刚好到点触发了）；等它落定再放开按钮，
      // 刷新本身出错不算操作失败、也不再打扰（下次轮询会校正）
      try {
        await onChanged();
      } catch {
        /* ignore */
      }
    } finally {
      setBusy(null);
    }
  };

  return (
    <span className="flex shrink-0 items-center gap-0.5">
      {availableScheduleActions(record.status).map((name) => {
        const spec = SPECS[name];
        const Icon = spec.icon;
        const isArmed = armed === spec.action;
        // 上膛前后是**同一个** Tooltip + Button 元素（只换 props / 内容）：焦点留在刚点的那个按钮上，
        // 不靠自动聚焦属性、也不会因为换了一棵元素树而在 Popover 里把焦点丢到 body（那会被 Popover 的 focus-out 逻辑当成「焦点出去了」）
        return (
          <Tooltip key={spec.action} content={isArmed ? `再点一次确认${spec.label}` : spec.label}>
            <Button
              variant="ghost"
              size={isArmed ? "sm" : "icon-sm"}
              className={
                isArmed
                  ? "h-7 px-2 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive"
                  : spec.destructive
                    ? "size-7 text-muted-foreground hover:text-destructive"
                    : "size-7 text-muted-foreground hover:text-foreground"
              }
              disabled={busy !== null}
              aria-label={isArmed ? `确认${spec.label}：${record.title}` : `${spec.label}：${record.title}`}
              // 失焦 = 去点别处了：撤回上膛（没拿到焦点的环境下由 CONFIRM_WINDOW_MS 超时兜底）
              onBlur={isArmed ? () => setArmed(null) : undefined}
              onClick={() => void run(spec)}
            >
              {isArmed ? (
                `确认${spec.label}`
              ) : busy === spec.action ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Icon className="size-3.5" />
              )}
            </Button>
          </Tooltip>
        );
      })}
    </span>
  );
};
